const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

before(h.start);
after(h.stop);

const APPLICATION = {
  name: 'Priya Nair',
  email: 'priya@example.test',
  platform: 'youtube',
  handle: '@priyatalks',
  audience: '10k-50k',
  country: 'IN',
  pitch: 'A monthly live where my viewers practise talking to new people.',
};

async function makeAdmin() {
  const admin = await h.signUp();
  h.db.setAdmin(admin.account.id, true);
  return admin;
}

test('creator applications are checked field by field', async () => {
  const visitor = new h.Client();
  const cases = [
    [{ name: '' }, /name/],
    [{ email: 'nope' }, /email/],
    [{ platform: 'myspace' }, /platform/],
    [{ handle: '' }, /handle/],
    [{ audience: 'loads' }, /audience/],
    [{ country: 'XX' }, /country/],
    [{ pitch: 'too short' }, /more about your idea/],
  ];
  for (const [change, message] of cases) {
    const res = await visitor.post('/creators', { ...APPLICATION, ...change });
    assert.equal(res.status, 400, JSON.stringify(change));
    assert.match(res.error, message);
  }
  assert.equal((await visitor.post('/creators', APPLICATION)).status, 200);
});

test('suggestions are checked and an optional reply email must be valid', async () => {
  const visitor = new h.Client();
  assert.equal((await visitor.post('/suggestions', { kind: 'spam', message: 'hello there' })).status, 400);
  assert.equal((await visitor.post('/suggestions', { kind: 'idea', message: 'hi' })).status, 400);
  assert.equal((await visitor.post('/suggestions', { kind: 'idea', message: 'Add dark mode', contact: 'bad' })).status, 400);
  assert.equal((await visitor.post('/suggestions', { kind: 'idea', message: 'Add a voice-only mode' })).status, 200);
});

test('the admin inbox is closed to visitors and to ordinary accounts', async () => {
  const visitor = new h.Client();
  assert.equal((await visitor.get('/admin/creators')).status, 401);
  assert.equal((await visitor.get('/admin/suggestions')).status, 401);

  const member = await h.signUp();
  assert.equal((await member.get('/admin/creators')).status, 403);
  assert.equal((await member.get('/admin/suggestions')).status, 403);
  assert.equal((await member.post('/admin/creators/1', { status: 'declined' })).status, 403);
  assert.equal((await member.post('/admin/suggestions/1', { status: 'archived' })).status, 403);
});

test('admins see applications and move them through statuses', async () => {
  const admin = await makeAdmin();
  assert.equal((await admin.get('/me')).user.isAdmin, true);
  await new h.Client().post('/creators', { ...APPLICATION, name: 'Mira Shah', handle: '@mira.talks' });

  let res = await admin.get('/admin/creators?status=new');
  const mira = res.items.find((item) => item.name === 'Mira Shah');
  assert.ok(mira, 'new application should be listed');
  assert.equal(mira.status, 'new');
  assert.equal(mira.email, APPLICATION.email);
  const newBefore = res.counts.new;

  res = await admin.post(`/admin/creators/${mira.id}`, { status: 'contacted' });
  assert.equal(res.status, 200);
  assert.equal(res.counts.new, newBefore - 1);
  assert.equal(res.counts.contacted, 1);

  res = await admin.get('/admin/creators?status=new');
  assert.ok(!res.items.some((item) => item.id === mira.id), 'contacted application leaves the New list');
  res = await admin.get('/admin/creators?status=contacted');
  assert.ok(res.items.some((item) => item.id === mira.id));

  assert.equal((await admin.post(`/admin/creators/${mira.id}`, { status: 'deleted' })).status, 400);
  assert.equal((await admin.post('/admin/creators/999999', { status: 'declined' })).status, 404);
});

test('safety concerns are listed first, and signed-in senders are identified', async () => {
  const admin = await makeAdmin();
  const member = await h.signUp();
  await member.post('/suggestions', { kind: 'idea', message: 'Let me save a good chat partner' });
  await new h.Client().post('/suggestions', { kind: 'safety', message: 'Someone in video said they were 15' });

  const res = await admin.get('/admin/suggestions?status=new');
  assert.equal(res.items[0].kind, 'safety');
  const fromMember = res.items.find((item) => item.message === 'Let me save a good chat partner');
  assert.equal(fromMember.account_email, member.identifier.email);

  const ideas = await admin.get('/admin/suggestions?kind=idea');
  assert.ok(ideas.items.every((item) => item.kind === 'idea'));

  const update = await admin.post(`/admin/suggestions/${fromMember.id}`, { status: 'reviewed' });
  assert.equal(update.status, 200);
  assert.equal(update.counts.reviewed, 1);
});

test('submitted text is stored exactly as typed, for the inbox to show as plain text', async () => {
  const admin = await makeAdmin();
  const message = '<img src=x onerror="alert(1)"> <script>alert(2)</script>';
  await new h.Client().post('/suggestions', { kind: 'problem', message });
  const res = await admin.get('/admin/suggestions?kind=problem');
  assert.ok(res.items.some((item) => item.message === message));
});

test('removing admin rights closes the inbox straight away', async () => {
  const admin = await makeAdmin();
  assert.equal((await admin.get('/admin/creators')).status, 200);
  h.db.setAdmin(admin.account.id, false);
  assert.equal((await admin.get('/admin/creators')).status, 403);
});
