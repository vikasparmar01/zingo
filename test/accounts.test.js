const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

before(h.start);
after(h.stop);

test('sign up with email, set up a profile, and stay signed in', async () => {
  const email = h.uniqueEmail();
  const client = await h.signUp({ email }, { profile: null });
  let me = await client.get('/me');
  assert.equal(me.user.email, email);
  assert.equal(me.user.profileComplete, false);

  assert.equal((await client.post('/profile', h.ADULT_PROFILE)).status, 200);
  me = await client.get('/me');
  assert.equal(me.user.profileComplete, true);
  assert.equal(me.user.isAdmin, false);
  assert.equal(me.user.blocked, null);
});

test('the session cookie cannot be read by page scripts or sent cross-site', async () => {
  const client = await h.signUp();
  await client.post('/auth/signin', { ...client.identifier, password: h.PASSWORD });
  const cookie = client.setCookieHeaders.find((c) => c.startsWith('zingo_session='));
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Lax/i);
});

test('sign up with a phone number and sign in with it typed differently', async () => {
  const client = await h.signUp({ phone: { country: 'IN', number: '98765 43210' } });
  assert.equal((await client.get('/me')).user.phone, '+919876543210');

  const other = new h.Client();
  const res = await other.post('/auth/signin', {
    phone: { country: 'GB', number: '+91 98765-43210' },
    password: h.PASSWORD,
  });
  assert.equal(res.status, 200);
  assert.equal(res.user.phone, '+919876543210');
});

test('invalid emails and phone numbers are rejected', async () => {
  const client = new h.Client();
  for (const body of [
    { email: 'not-an-email' },
    { phone: { country: 'GB', number: '123' } },
    { phone: { country: 'ZZ', number: '07911 123456' } },
    {},
  ]) {
    const res = await client.post('/auth/signup/start', body);
    assert.equal(res.status, 400, JSON.stringify(body));
  }
});

test('passwords must be at least 8 characters', async () => {
  const identifier = { email: h.uniqueEmail() };
  const client = new h.Client();
  await client.post('/auth/signup/start', identifier);
  const res = await client.post('/auth/signup/finish', { ...identifier, code: h.codeFor(identifier), password: 'short' });
  assert.equal(res.status, 400);
  assert.match(res.error, /at least 8/);
});

test('a code stops working after 5 wrong guesses', async () => {
  const identifier = { email: h.uniqueEmail() };
  const client = new h.Client();
  await client.post('/auth/signup/start', identifier);
  const realCode = h.codeFor(identifier);
  const wrong = realCode === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) {
    const res = await client.post('/auth/signup/finish', { ...identifier, code: wrong, password: h.PASSWORD });
    assert.equal(res.status, 400);
  }
  const res = await client.post('/auth/signup/finish', { ...identifier, code: realCode, password: h.PASSWORD });
  assert.equal(res.status, 400);
  assert.match(res.error, /Too many wrong tries/);
});

test('asking for a second code straight away is refused', async () => {
  const identifier = { email: h.uniqueEmail() };
  const client = new h.Client();
  assert.equal((await client.post('/auth/signup/start', identifier)).status, 200);
  const again = await client.post('/auth/signup/start', identifier);
  assert.equal(again.status, 429);
});

test('one network can request at most 20 codes an hour', async () => {
  const client = new h.Client();
  for (let i = 0; i < 20; i++) {
    const res = await client.post('/auth/signup/start', { email: h.uniqueEmail('flood') });
    assert.equal(res.status, 200, `request ${i + 1}`);
  }
  const res = await client.post('/auth/signup/start', { email: h.uniqueEmail('flood') });
  assert.equal(res.status, 429);
});

test('a wrong password and an unknown account get the same answer', async () => {
  const client = await h.signUp();
  const stranger = new h.Client();
  const wrongPassword = await stranger.post('/auth/signin', { ...client.identifier, password: 'not-the-password' });
  const unknown = await stranger.post('/auth/signin', { email: h.uniqueEmail('ghost'), password: 'whatever-123' });
  assert.equal(wrongPassword.status, 401);
  assert.equal(unknown.status, 401);
  assert.equal(wrongPassword.error, unknown.error);
});

test('signing up again with a taken email does not reveal it, and warns the owner', async () => {
  const client = await h.signUp();
  const before = h.messagesTo(client.identifier).length;
  const res = await new h.Client().post('/auth/signup/start', client.identifier);
  assert.equal(res.status, 200); // same reply as a brand-new sign-up
  const sent = h.messagesTo(client.identifier).slice(before);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /You already have one/);
  assert.doesNotMatch(sent[0].text, /code is/);
});

test('an account locks for 15 minutes after 10 wrong passwords, from any network', async () => {
  const client = await h.signUp();
  for (let i = 0; i < 10; i++) {
    const res = await new h.Client().post('/auth/signin', { ...client.identifier, password: 'wrong-password' });
    assert.equal(res.status, 401);
  }
  const locked = await new h.Client().post('/auth/signin', { ...client.identifier, password: h.PASSWORD });
  assert.equal(locked.status, 429);
});

test('forgot password: reset works, signs out other sessions, and the code works once', async () => {
  const client = await h.signUp();
  const resetter = new h.Client();
  assert.equal((await resetter.post('/auth/forgot/start', client.identifier)).status, 200);
  const code = h.codeFor(client.identifier);

  const reset = await resetter.post('/auth/forgot/finish', { ...client.identifier, code, password: 'brand-new-pass-2' });
  assert.equal(reset.status, 200);
  assert.equal((await resetter.get('/me')).status, 200);

  assert.equal((await client.get('/me')).status, 401, 'old session should be signed out');
  const oldPassword = await new h.Client().post('/auth/signin', { ...client.identifier, password: h.PASSWORD });
  assert.equal(oldPassword.status, 401);
  const newPassword = await new h.Client().post('/auth/signin', { ...client.identifier, password: 'brand-new-pass-2' });
  assert.equal(newPassword.status, 200);

  const reused = await resetter.post('/auth/forgot/finish', { ...client.identifier, code, password: 'another-pass-3' });
  assert.equal(reused.status, 400);
});

test('forgot password for an unknown account sends nothing but answers the same', async () => {
  const identifier = { email: h.uniqueEmail('nobody') };
  const res = await new h.Client().post('/auth/forgot/start', identifier);
  assert.equal(res.status, 200);
  assert.equal(h.messagesTo(identifier).length, 0);
});

test('signing out ends the session', async () => {
  const client = await h.signUp();
  assert.equal((await client.post('/auth/logout')).status, 200);
  assert.equal((await client.get('/me')).status, 401);
});

test('under-18s are blocked for good and cannot change their birthday', async () => {
  const client = await h.signUp(undefined, { profile: null });
  const fifteen = new Date();
  fifteen.setFullYear(fifteen.getFullYear() - 15);
  const res = await client.post('/profile', { ...h.ADULT_PROFILE, birthdate: fifteen.toISOString().slice(0, 10) });
  assert.equal(res.user.blocked.reason, 'underage');

  const retry = await client.post('/profile', h.ADULT_PROFILE);
  assert.equal(retry.status, 409);
  assert.equal((await client.get('/me')).user.blocked.reason, 'underage');
});

test('someone who turns 18 today is allowed in', async () => {
  const client = await h.signUp(undefined, { profile: null });
  const today = new Date();
  const birthday = `${today.getUTCFullYear() - 18}-${String(today.getUTCMonth() + 1).padStart(2, '0')}-${String(
    today.getUTCDate(),
  ).padStart(2, '0')}`;
  const res = await client.post('/profile', { ...h.ADULT_PROFILE, birthdate: birthday });
  assert.equal(res.status, 200);
  assert.equal(res.user.blocked, null);
});

test('profiles reject impossible dates, unknown genders and unknown countries', async () => {
  const client = await h.signUp(undefined, { profile: null });
  for (const change of [{ birthdate: '1999-02-30' }, { birthdate: 'yesterday' }, { gender: 'robot' }, { country: 'XX' }]) {
    const res = await client.post('/profile', { ...h.ADULT_PROFILE, ...change });
    assert.equal(res.status, 400, JSON.stringify(change));
  }
});
