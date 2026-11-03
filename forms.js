// Creator partnership applications and suggestions from the community.
// Both work signed in or out; a signed-in person's account is attached.
const express = require('express');
const db = require('./db');
const auth = require('./auth');

const HOUR = 60 * 60 * 1000;
const PLATFORMS = ['tiktok', 'instagram', 'youtube', 'twitch', 'snapchat', 'x', 'other'];
const AUDIENCES = ['under-10k', '10k-50k', '50k-250k', '250k-1m', 'over-1m'];
const SUGGESTION_KINDS = ['idea', 'recommendation', 'problem', 'safety'];

const creatorLimit = auth.limiter(5, HOUR);
const suggestionLimit = auth.limiter(10, HOUR);

const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

const router = express.Router();
router.use(express.json({ limit: '8kb' }));

router.post('/creators', (req, res) => {
  const body = req.body || {};
  const application = {
    name: text(body.name, 80),
    email: auth.normalizeEmail(body.email),
    platform: body.platform,
    handle: text(body.handle, 100),
    audience: body.audience,
    country: body.country,
    pitch: text(body.pitch, 1000),
  };
  if (!application.name) return res.status(400).json({ error: 'Tell us your name.' });
  if (!application.email) return res.status(400).json({ error: 'Enter an email address we can reply to.' });
  if (!PLATFORMS.includes(application.platform)) return res.status(400).json({ error: 'Choose your main platform.' });
  if (!application.handle) return res.status(400).json({ error: 'Add your handle or channel link.' });
  if (!AUDIENCES.includes(application.audience)) return res.status(400).json({ error: 'Choose your audience size.' });
  if (!auth.COUNTRIES.has(application.country)) return res.status(400).json({ error: 'Choose your country.' });
  if (application.pitch.length < 20) {
    return res.status(400).json({ error: 'Tell us a little more about your idea (at least 20 characters).' });
  }
  if (!creatorLimit.allow(req.ip)) return res.status(429).json({ error: 'Too many applications. Try again later.' });

  const user = auth.userFromCookieHeader(req.headers.cookie);
  db.addCreatorApplication({ ...application, userId: user?.id ?? null, now: Date.now() });
  console.log(`[creator] ${application.name} (${application.platform} ${application.handle}, ${application.audience})`);
  res.json({ ok: true });
});

router.post('/suggestions', (req, res) => {
  const body = req.body || {};
  const kind = body.kind;
  const message = text(body.message, 2000);
  const contact = body.contact ? auth.normalizeEmail(body.contact) : null;
  if (!SUGGESTION_KINDS.includes(kind)) return res.status(400).json({ error: 'Choose what kind of message this is.' });
  if (message.length < 5) return res.status(400).json({ error: 'Write a few words so we know what you mean.' });
  if (body.contact && !contact) return res.status(400).json({ error: 'That email address doesn\'t look right.' });
  if (!suggestionLimit.allow(req.ip)) return res.status(429).json({ error: 'Too many messages. Try again later.' });

  const user = auth.userFromCookieHeader(req.headers.cookie);
  db.addSuggestion({ userId: user?.id ?? null, kind, message, contact, now: Date.now() });
  console.log(`[suggestion] ${kind}: ${message.slice(0, 80)}`);
  res.json({ ok: true });
});

module.exports = { router };
