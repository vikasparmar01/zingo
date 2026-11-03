const crypto = require('crypto');
const { promisify } = require('util');
const express = require('express');
const { parsePhoneNumberFromString, getCountries, getCountryCallingCode } = require('libphonenumber-js');
const db = require('./db');
const COUNTRY_CODES = require('./public/countries.js');
const { sendEmail } = require('./mailer');
const { sendSms } = require('./sms');

const SESSION_COOKIE = 'zingo_session';
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const CODE_MS = 10 * 60 * 1000;
const CODE_RESEND_MS = 30 * 1000;
const MAX_CODE_ATTEMPTS = 5;
const MAX_CODES_PER_IDENTIFIER_PER_HOUR = 5;
const MAX_CODES_PER_IP_PER_HOUR = 20;
const MAX_SIGNIN_FAILURES = 10; // per account, within SIGNIN_WINDOW_MS
const MAX_SIGNIN_FAILURES_PER_IP = 50; // higher, so one person can't lock out a whole school or office network
const SIGNIN_WINDOW_MS = 15 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const MIN_AGE = 18;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 128;

const GENDERS = ['woman', 'man', 'nonbinary', 'unspecified'];
const COUNTRIES = new Set(COUNTRY_CODES);
// Countries we can take phone numbers from, with their calling codes, for the sign-up form.
const DIAL_CODES = getCountries().map((code) => ({ code, dial: getCountryCallingCode(code) }));

const scrypt = promisify(crypto.scrypt);
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function checkPassword(password, stored) {
  const [, salt, key] = stored.split('$');
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), 64);
  return crypto.timingSafeEqual(actual, Buffer.from(key, 'base64'));
}

// Checked against when the account doesn't exist, so a wrong email takes as long as a wrong password.
const DUMMY_HASH_PROMISE = hashPassword(crypto.randomBytes(16).toString('hex'));

function normalizeEmail(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) ? email : null;
}

// Reads { email } or { phone: { country, number } } from a request body.
function parseIdentifier(body) {
  if (typeof body?.email === 'string') {
    const email = normalizeEmail(body.email);
    return email && { kind: 'email', value: email };
  }
  const { country, number } = body?.phone || {};
  if (typeof country !== 'string' || typeof number !== 'string' || number.length > 32) return null;
  try {
    const phone = parsePhoneNumberFromString(number, country.toUpperCase());
    return phone?.isValid() ? { kind: 'phone', value: phone.number } : null;
  } catch {
    return null;
  }
}

function passwordProblem(password) {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN) {
    return `Use at least ${PASSWORD_MIN} characters for your password.`;
  }
  if (password.length > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters for your password.`;
  return null;
}

function ageOn(birthdate, now = new Date()) {
  const [year, month, day] = birthdate.split('-').map(Number);
  let age = now.getUTCFullYear() - year;
  const m = now.getUTCMonth() + 1;
  if (m < month || (m === month && now.getUTCDate() < day)) age -= 1;
  return age;
}

function isRealDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00Z');
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

// Why an account can't chat right now, or null if it can.
function blockStatus(user) {
  if (user.blocked_reason) return { reason: user.blocked_reason };
  if (user.banned_until > Date.now()) return { reason: 'suspended', until: user.banned_until };
  return null;
}

function publicUser(user) {
  return {
    email: user.email,
    phone: user.phone,
    profileComplete: Boolean(user.birthdate),
    gender: user.gender,
    country: user.country,
    blocked: blockStatus(user),
    isAdmin: Boolean(user.is_admin),
  };
}

function parseCookies(header = '') {
  const cookies = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) cookies[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return cookies;
}

function userFromCookieHeader(header) {
  const token = parseCookies(header)[SESSION_COOKIE];
  return token ? db.userForSession(sha256(token)) : null;
}

function startSession(res, user) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.createSession(sha256(token), user.id, Date.now() + SESSION_MS);
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_MS,
  });
}

// In-memory limiter: at most `max` hits per key within `windowMs`.
function limiter(max, windowMs) {
  const hits = new Map();
  return {
    allow(key) {
      const now = Date.now();
      const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
      if (recent.length >= max) return false;
      hits.set(key, recent.concat(now));
      return true;
    },
    blocked(key) {
      const now = Date.now();
      return (hits.get(key) || []).filter((t) => now - t < windowMs).length >= max;
    },
    clear: (key) => hits.delete(key),
  };
}
const identifierCodes = limiter(MAX_CODES_PER_IDENTIFIER_PER_HOUR, HOUR);
const ipCodes = limiter(MAX_CODES_PER_IP_PER_HOUR, HOUR);
const signinFailures = limiter(MAX_SIGNIN_FAILURES, SIGNIN_WINDOW_MS);
const ipSigninFailures = limiter(MAX_SIGNIN_FAILURES_PER_IP, SIGNIN_WINDOW_MS);

function deliver(identifier, subject, text) {
  return identifier.kind === 'email' ? sendEmail(identifier.value, subject, text) : sendSms(identifier.value, text);
}

// Test mode, for sharing a test link before email and SMS are connected: the code is also sent back to the
// page. Anyone with the link can then sign up with any email or number, so it is never allowed in production.
const SHOW_CODES = process.env.ZINGO_SHOW_CODES === '1';
if (SHOW_CODES && process.env.NODE_ENV === 'production') {
  throw new Error('ZINGO_SHOW_CODES must not be used in production.');
}
if (SHOW_CODES) console.warn('[test mode] Codes are shown on screen. Only share this link with people you trust.');
const testCode = (code) => (SHOW_CODES && code ? { testCode: code } : {});

// Sends a 6-digit code. Returns { code } on success or { error } with a message for the person.
async function issueCode(identifier, purpose, ip) {
  const existing = db.getCode(identifier.value, purpose);
  if (existing && Date.now() - existing.sent_at < CODE_RESEND_MS) {
    return { error: 'Please wait a few seconds before asking for another code.' };
  }
  if (!ipCodes.allow(ip) || !identifierCodes.allow(identifier.value)) {
    return { error: 'Too many codes requested. Please try again later.' };
  }
  const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
  db.saveCode(identifier.value, purpose, sha256(code), Date.now() + CODE_MS, Date.now());
  const action = purpose === 'reset' ? 'reset your password' : 'finish creating your account';
  await deliver(
    identifier,
    `${code} is your Zingo code`,
    `Your Zingo code is ${code}. Use it to ${action}. It expires in 10 minutes. ` +
      "If you didn't ask for this, you can ignore it.",
  );
  return { code };
}

// Uses up a code if it matches, or returns an error message for the person.
function redeemCode(identifier, purpose, code) {
  const row = db.getCode(identifier.value, purpose);
  if (!row || row.expires_at < Date.now()) return 'That code has expired. Ask for a new one.';
  if (row.attempts >= MAX_CODE_ATTEMPTS) return 'Too many wrong tries. Ask for a new code.';
  const value = String(code ?? '').trim();
  const matches =
    /^\d{6}$/.test(value) && crypto.timingSafeEqual(Buffer.from(sha256(value)), Buffer.from(row.code_hash));
  if (!matches) {
    db.bumpCodeAttempts(identifier.value, purpose);
    return "That code isn't right. Check the message and try again.";
  }
  db.deleteCode(identifier.value, purpose);
  return null;
}

const INVALID_IDENTIFIER = 'Enter a valid email address or phone number.';

// Wraps async handlers so a failure (for example, an email provider being down) returns a clean error.
const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    console.error('[auth]', err);
    res.status(502).json({ error: "Something went wrong sending your code. Please try again." });
  }
};

function requireUser(req, res, next) {
  req.user = userFromCookieHeader(req.headers.cookie);
  if (!req.user) return res.status(401).json({ error: 'Please sign in.' });
  next();
}

const router = express.Router();
router.use(express.json({ limit: '2kb' }));

router.get('/countries', (req, res) => res.json({ countries: DIAL_CODES }));

router.post(
  '/auth/signup/start',
  handle(async (req, res) => {
    const id = parseIdentifier(req.body);
    if (!id) return res.status(400).json({ error: INVALID_IDENTIFIER });

    if (db.userByIdentifier(id)) {
      // Same reply as a new sign-up, so nobody can use this form to find out who has an account.
      // The owner is told by message instead.
      if (ipCodes.allow(req.ip) && identifierCodes.allow(id.value)) {
        await deliver(
          id,
          'You already have a Zingo account',
          'Someone tried to create a Zingo account with this ' +
            (id.kind === 'email' ? 'email address' : 'number') +
            '. You already have one: sign in, or use "Forgot password" if you can\'t remember it.',
        );
      }
      return res.json({ ok: true });
    }

    const issued = await issueCode(id, 'signup', req.ip);
    if (issued.error) return res.status(429).json({ error: issued.error });
    res.json({ ok: true, ...testCode(issued.code) });
  }),
);

router.post(
  '/auth/signup/finish',
  handle(async (req, res) => {
    const id = parseIdentifier(req.body);
    if (!id) return res.status(400).json({ error: INVALID_IDENTIFIER });
    const weak = passwordProblem(req.body.password);
    if (weak) return res.status(400).json({ error: weak });
    const problem = redeemCode(id, 'signup', req.body.code);
    if (problem) return res.status(400).json({ error: problem });
    if (db.userByIdentifier(id)) return res.status(409).json({ error: 'This account already exists. Sign in instead.' });

    const user = db.createUser(id, await hashPassword(req.body.password), Date.now());
    startSession(res, user);
    res.json({ user: publicUser(user) });
  }),
);

router.post(
  '/auth/signin',
  handle(async (req, res) => {
    const id = parseIdentifier(req.body);
    if (!id) return res.status(400).json({ error: INVALID_IDENTIFIER });
    if (signinFailures.blocked(id.value) || ipSigninFailures.blocked(req.ip)) {
      return res.status(429).json({ error: 'Too many tries. Wait 15 minutes, or reset your password.' });
    }

    const user = db.userByIdentifier(id);
    const password = typeof req.body.password === 'string' ? req.body.password.slice(0, PASSWORD_MAX) : '';
    const stored = user?.password_hash || (await DUMMY_HASH_PROMISE);
    const ok = (await checkPassword(password, stored)) && Boolean(user?.password_hash);
    if (!ok) {
      signinFailures.allow(id.value);
      ipSigninFailures.allow(req.ip);
      return res.status(401).json({ error: "That doesn't match an account. Check your details and password." });
    }

    signinFailures.clear(id.value);
    startSession(res, user);
    res.json({ user: publicUser(user) });
  }),
);

router.post(
  '/auth/forgot/start',
  handle(async (req, res) => {
    const id = parseIdentifier(req.body);
    if (!id) return res.status(400).json({ error: INVALID_IDENTIFIER });
    // Always the same reply, whether or not the account exists.
    let issued = {};
    if (db.userByIdentifier(id)) {
      issued = await issueCode(id, 'reset', req.ip);
      if (issued.error) return res.status(429).json({ error: issued.error });
    }
    res.json({ ok: true, ...testCode(issued.code) });
  }),
);

router.post(
  '/auth/forgot/finish',
  handle(async (req, res) => {
    const id = parseIdentifier(req.body);
    if (!id) return res.status(400).json({ error: INVALID_IDENTIFIER });
    const weak = passwordProblem(req.body.password);
    if (weak) return res.status(400).json({ error: weak });
    const problem = redeemCode(id, 'reset', req.body.code);
    if (problem) return res.status(400).json({ error: problem });
    const user = db.userByIdentifier(id);
    if (!user) return res.status(400).json({ error: 'That code has expired. Ask for a new one.' });

    db.setPassword(user.id, await hashPassword(req.body.password));
    // A reset signs the account out everywhere else, in case someone else had access.
    db.deleteUserSessions(user.id);
    signinFailures.clear(id.value);
    startSession(res, user);
    res.json({ user: publicUser(db.userById(user.id)) });
  }),
);

router.post('/auth/logout', (req, res) => {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (token) db.deleteSession(sha256(token));
  res.clearCookie(SESSION_COOKIE);
  res.json({ ok: true });
});

router.get('/me', requireUser, (req, res) => res.json({ user: publicUser(req.user) }));

router.post('/profile', requireUser, (req, res) => {
  const user = req.user;
  if (user.birthdate) return res.status(409).json({ error: 'Your profile is already set up.' });
  if (user.blocked_reason) return res.status(403).json({ user: publicUser(user) });

  const { birthdate, gender, country } = req.body || {};
  if (!isRealDate(birthdate) || ageOn(birthdate) > 120 || ageOn(birthdate) < 0) {
    return res.status(400).json({ error: 'Enter your real date of birth.' });
  }
  if (!GENDERS.includes(gender)) return res.status(400).json({ error: 'Choose a gender option.' });
  if (!COUNTRIES.has(country)) return res.status(400).json({ error: 'Choose your country.' });

  db.setProfile(user.id, { birthdate, gender, country });
  // Under-18s are blocked for good on this account, so they can't simply retry with a different birthday.
  if (ageOn(birthdate) < MIN_AGE) db.blockUser(user.id, 'underage');
  res.json({ user: publicUser(db.userById(user.id)) });
});

setInterval(() => db.pruneSessions(), HOUR).unref();

module.exports = { router, userFromCookieHeader, blockStatus, normalizeEmail, limiter, COUNTRIES };
