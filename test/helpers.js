// Shared set-up for the tests: a fresh database in a temp folder, the server on a free port,
// a cookie-keeping API client, and an outbox that collects the codes Zingo would email or text.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('node:assert/strict');
const { parsePhoneNumberFromString } = require('libphonenumber-js');
const { io: ioClient } = require('socket.io-client');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'zingo-test-'));
process.env.TRUST_PROXY = '1'; // lets each test client act as a different network via X-Forwarded-For

// In development, emails and texts are printed to the console. Collect them instead.
const outbox = [];
const realLog = console.log;
console.log = (...args) => {
  const line = args.join(' ');
  const message = line.match(/^\[dev (?:email|sms)\] To (\S+): ([\s\S]*)$/);
  if (message) outbox.push({ to: message[1], text: message[2] });
  else if (process.env.ZINGO_TEST_VERBOSE) realLog(...args);
};

const { server, io } = require('../server');
const db = require('../db');

let baseUrl;
async function start() {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}
async function stop() {
  await new Promise((resolve) => io.close(resolve));
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
}

let counter = 0;
const uniqueEmail = (name = 'person') => `${name}${++counter}@example.test`;
const nextIp = () => `10.${(counter >> 8) & 255}.${counter & 255}.${(++counter % 250) + 1}`;

class Client {
  constructor(ip = nextIp()) {
    this.ip = ip;
    this.cookie = '';
    this.setCookieHeaders = [];
  }

  async request(method, pathname, body) {
    const res = await fetch(baseUrl + pathname, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': this.ip,
        ...(this.cookie && { cookie: this.cookie }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    this.setCookieHeaders = res.headers.getSetCookie();
    for (const header of this.setCookieHeaders) {
      const pair = header.split(';')[0];
      const [name, value] = pair.split('=');
      if (name === 'zingo_session') this.cookie = value ? pair : '';
    }
    const data = await res.json().catch(() => ({}));
    return { status: res.status, ...data };
  }

  get(pathname) {
    return this.request('GET', '/api' + pathname);
  }
  post(pathname, body = {}) {
    return this.request('POST', '/api' + pathname, body);
  }
}

// Where Zingo sends messages for an identifier: the lowercase email, or the phone number in E.164 form.
function addressOf(identifier) {
  if (identifier.email) return identifier.email.trim().toLowerCase();
  return parsePhoneNumberFromString(identifier.phone.number, identifier.phone.country).number;
}

const messagesTo = (identifier) => outbox.filter((m) => m.to === addressOf(identifier));
function codeFor(identifier) {
  const last = messagesTo(identifier).at(-1);
  const code = last?.text.match(/code is (\d{6})/)?.[1];
  assert.ok(code, `expected a code to have been sent to ${addressOf(identifier)}`);
  return code;
}

const PASSWORD = 'correct-horse-1';
const ADULT_PROFILE = { birthdate: '1998-05-20', gender: 'woman', country: 'GB' };

// Creates an account and (unless profile is null) fills in the profile. Returns a signed-in client.
async function signUp(identifier = { email: uniqueEmail() }, { password = PASSWORD, profile = ADULT_PROFILE } = {}) {
  const client = new Client();
  assert.equal((await client.post('/auth/signup/start', identifier)).status, 200);
  const finish = await client.post('/auth/signup/finish', { ...identifier, code: codeFor(identifier), password });
  assert.equal(finish.status, 200, finish.error);
  if (profile) {
    const res = await client.post('/profile', profile);
    assert.equal(res.status, 200, res.error);
  }
  client.identifier = identifier;
  client.account = db.userByIdentifier({
    kind: identifier.email ? 'email' : 'phone',
    value: addressOf(identifier),
  });
  return client;
}

function connect(client, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const socket = ioClient(baseUrl, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      extraHeaders: { cookie: client.cookie, ...extraHeaders },
    });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', (err) => {
      socket.close();
      reject(err);
    });
  });
}

function next(socket, event, ms = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for "${event}"`)), ms);
    socket.once(event, (data) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

// Resolves true if the event arrives within ms, false if it doesn't.
function arrives(socket, event, ms) {
  return next(socket, event, ms).then(
    () => true,
    () => false,
  );
}

module.exports = {
  start,
  stop,
  db,
  outbox,
  Client,
  uniqueEmail,
  messagesTo,
  codeFor,
  signUp,
  connect,
  next,
  arrives,
  PASSWORD,
  ADULT_PROFILE,
};
