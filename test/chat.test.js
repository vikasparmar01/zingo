const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

before(h.start);
after(h.stop);

// Every socket a test opens is closed afterwards, so nobody is left in the queue for the next test.
const open = [];
afterEach(() => {
  for (const socket of open.splice(0)) socket.close();
});

async function person(profile = {}) {
  const client = await h.signUp(undefined, { profile: { ...h.ADULT_PROFILE, ...profile } });
  const socket = await h.connect(client);
  open.push(socket);
  return { client, socket };
}

function find(socket, options = {}) {
  socket.emit('find', { interests: [], mode: 'text', filters: { gender: 'any', country: 'any' }, ...options });
}

async function match(a, b, options = {}) {
  const matchedA = h.next(a.socket, 'matched');
  const matchedB = h.next(b.socket, 'matched');
  find(a.socket, options);
  find(b.socket, options);
  return Promise.all([matchedA, matchedB]);
}

test('you must be signed in, with a finished profile, to join the chat', async () => {
  await assert.rejects(h.connect(new h.Client()), { message: 'unauthorized' });
  const noProfile = await h.signUp(undefined, { profile: null });
  await assert.rejects(h.connect(noProfile), { message: 'profile_incomplete' });
});

test('connections from other websites are refused', async () => {
  const client = await h.signUp();
  await assert.rejects(h.connect(client, { origin: 'https://evil.example' }), { message: 'bad_origin' });
});

test('two people are matched and see only each other’s gender and country', async () => {
  const asha = await person({ gender: 'woman', country: 'IN' });
  const ben = await person({ gender: 'man', country: 'GB' });
  const [forAsha, forBen] = await match(asha, ben);

  assert.deepEqual(forAsha.partner, { gender: 'man', country: 'GB' });
  assert.deepEqual(forBen.partner, { gender: 'woman', country: 'IN' });
  assert.equal(forAsha.icebreaker, forBen.icebreaker);
  assert.notEqual(forAsha.initiator, forBen.initiator, 'exactly one side starts the video call');
});

test('"prefer not to say" is never shown to the other person', async () => {
  const a = await person({ gender: 'unspecified' });
  const b = await person();
  const [, forB] = await match(a, b);
  assert.equal(forB.partner.gender, null);
});

test('messages arrive with emails, phone numbers and links hidden', async () => {
  const a = await person();
  const b = await person();
  await match(a, b);

  const echo = h.next(a.socket, 'message');
  const received = h.next(b.socket, 'message');
  a.socket.emit('message', 'hi! mail me at me@example.test, call +44 7911 123456 or see https://example.test/me');
  const [mine, theirs] = await Promise.all([echo, received]);

  assert.equal(mine.from, 'you');
  assert.equal(theirs.from, 'stranger');
  assert.equal(theirs.text, 'hi! mail me at [email hidden], call [number hidden] or see [link hidden]');
});

test('Skip ends the chat for both people straight away', async () => {
  const a = await person();
  const b = await person();
  await match(a, b);

  const left = h.next(b.socket, 'partner_left');
  find(a.socket); // what the Skip button sends
  await left;
  const stillTalking = h.arrives(b.socket, 'message', 400);
  a.socket.emit('message', 'are you there?');
  assert.equal(await stillTalking, false, 'messages must not reach someone after a skip');
});

test('filters work both ways: a women-only search never gets a man', async () => {
  const her = await person({ gender: 'woman' });
  const him = await person({ gender: 'man' });
  find(her.socket, { filters: { gender: 'woman', country: 'any' } });
  find(him.socket);
  assert.equal(await h.arrives(her.socket, 'matched', 1500), false);

  const another = await person({ gender: 'woman' });
  const matched = h.next(her.socket, 'matched');
  find(another.socket);
  assert.equal((await matched).partner.gender, 'woman');
});

test('"Only my country" matches people from the same country', async () => {
  const indian = await person({ country: 'IN' });
  const british = await person({ country: 'GB' });
  find(indian.socket, { filters: { gender: 'any', country: 'same' } });
  find(british.socket);
  assert.equal(await h.arrives(indian.socket, 'matched', 1500), false);

  const alsoIndian = await person({ country: 'IN' });
  const matched = h.next(indian.socket, 'matched');
  find(alsoIndian.socket);
  assert.equal((await matched).partner.country, 'IN');
});

test('text and video chats are kept apart', async () => {
  const texter = await person();
  const videoCaller = await person();
  find(texter.socket, { mode: 'text' });
  find(videoCaller.socket, { mode: 'video' });
  assert.equal(await h.arrives(texter.socket, 'matched', 1500), false);
});

test('people with a shared topic are matched first', async () => {
  const musicFan = await person();
  const noTopic = await person();
  const alsoMusic = await person();
  find(musicFan.socket, { interests: ['music'] });
  find(noTopic.socket);
  const matched = h.next(musicFan.socket, 'matched');
  find(alsoMusic.socket, { interests: ['Music '] });
  assert.deepEqual((await matched).shared, ['music']);
});

test('people with different topics are still matched after waiting about 6 seconds', async () => {
  const hiker = await person();
  const gamer = await person();
  find(hiker.socket, { interests: ['hiking'] });
  find(gamer.socket, { interests: ['gaming'] });
  assert.equal(await h.arrives(hiker.socket, 'matched', 4000), false, 'too early: topics should matter at first');
  const matched = await h.next(hiker.socket, 'matched', 5000);
  assert.deepEqual(matched.shared, []);
});

test('one account open in two tabs is never matched with itself', async () => {
  const client = await h.signUp();
  const tab1 = await h.connect(client);
  const tab2 = await h.connect(client);
  open.push(tab1, tab2);
  find(tab1);
  find(tab2);
  assert.equal(await h.arrives(tab1, 'matched', 1500), false);
});

test('reporting the same person twice only counts once', async () => {
  const reporter = await h.signUp();
  const target = await h.signUp();
  h.db.addReport(reporter.account.id, target.account.id, 'harassment', Date.now());
  h.db.addReport(reporter.account.id, target.account.id, 'hate', Date.now());
  assert.equal(h.db.distinctReportersSince(target.account.id, 0), 1);
});

test('three different reporters suspend someone for 24 hours', async () => {
  const target = await person();
  for (let i = 1; i <= 3; i++) {
    const reporter = await person();
    await match(target, reporter);
    const outcome = i < 3 ? h.next(target.socket, 'partner_left') : h.next(target.socket, 'blocked');
    reporter.socket.emit('report', 'harassment');
    const result = await outcome;
    if (i === 3) assert.equal(result.reason, 'suspended');
  }
  await assert.rejects(h.connect(target.client), { message: 'blocked' });
  assert.equal((await target.client.get('/me')).user.blocked.reason, 'suspended');
});

test('two "seems under 18" reports pause the account for an age review', async () => {
  const target = await person();
  for (let i = 1; i <= 2; i++) {
    const reporter = await person();
    await match(target, reporter);
    const outcome = i < 2 ? h.next(target.socket, 'partner_left') : h.next(target.socket, 'blocked');
    reporter.socket.emit('report', 'minor');
    const result = await outcome;
    if (i === 2) assert.equal(result.reason, 'age_review');
  }
  assert.equal((await target.client.get('/me')).user.blocked.reason, 'age_review');
});

test('video call set-up messages only go to the current partner', async () => {
  const a = await person();
  const b = await person();
  const bystander = await person();
  await match(a, b, { mode: 'video' });
  find(bystander.socket, { mode: 'video' });

  const toPartner = h.next(b.socket, 'signal');
  const leaked = h.arrives(bystander.socket, 'signal', 400);
  a.socket.emit('signal', { description: { type: 'offer', sdp: 'v=0' } });
  assert.deepEqual((await toPartner).description, { type: 'offer', sdp: 'v=0' });
  assert.equal(await leaked, false);
});
