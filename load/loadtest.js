// Load test for Zingo. Starts a fresh server on its own database, then adds simulated people in
// waves and measures how quickly people are matched and how fast messages arrive.
//
//   npm run load                      # default waves: 500, 1000, 2000, 4000, 8000 people
//   npm run load -- --levels 200,400  # custom waves
//   npm run load -- --picky 0.5       # half of everyone picks a topic nobody shares
//
// Each wave stops early if messages slow down past 1 second (p95) or connections start failing.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, fork, execFileSync } = require('child_process');

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const LEVELS = arg('levels', '500,1000,2000,4000,8000').split(',').map(Number);
const PICKY = Number(arg('picky', '0'));
const MEASURE_MS = Number(arg('measure', '20000'));
const WORKERS = Number(arg('workers', String(Math.max(2, os.cpus().length - 2))));
const SIGNUPS = Number(arg('signups', '200'));
const PORT = Number(arg('port', '3456'));
const URL = `http://127.0.0.1:${PORT}`;
const P95_LIMIT_MS = 1000;
const RATE = Number(arg('rate', '400')); // new connections per second

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'zingo-load-'));
process.env.DATA_DIR = DATA_DIR;
const db = require('../db');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};
const ms = (v) => (v == null ? '-' : `${Math.round(v)} ms`);

// Simulated people go straight into the database with a session, so the test measures chatting,
// not the deliberately slow password hashing (which is measured separately below).
function seedPeople(count) {
  const people = [];
  const now = Date.now();
  for (let i = 0; i < count; i++) {
    const user = db.createUser({ kind: 'email', value: `load${i}@example.test` }, 'not-a-real-hash', now);
    db.setProfile(user.id, { birthdate: '1998-01-01', gender: i % 2 ? 'woman' : 'man', country: 'GB' });
    const token = crypto.randomBytes(32).toString('base64url');
    db.createSession(crypto.createHash('sha256').update(token).digest('hex'), user.id, now + 86400000);
    people.push({ token, picky: Math.random() < PICKY });
  }
  return people;
}

// Total CPU seconds the server process has used so far, from `ps`.
function serverCpuSeconds(pid) {
  const time = execFileSync('ps', ['-o', 'time=', '-p', String(pid)]).toString().trim();
  return time.split(':').reduce((total, part) => total * 60 + Number(part), 0);
}
const serverMemoryMb = (pid) => Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)]).toString().trim()) / 1024;

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(URL + '/api/countries')).ok) return;
    } catch {}
    await sleep(100);
  }
  throw new Error('server did not start');
}

async function measureSignups(count, concurrency = 20) {
  const times = [];
  let next = 0;
  let failures = 0;
  const started = Date.now();
  const one = async (i) => {
    const headers = { 'content-type': 'application/json', 'x-forwarded-for': `10.9.${i >> 8}.${i & 255}` };
    const email = `signup${i}@example.test`;
    const t0 = Date.now();
    const start = await (await fetch(URL + '/api/auth/signup/start', { method: 'POST', headers, body: JSON.stringify({ email }) })).json();
    const finish = await fetch(URL + '/api/auth/signup/finish', {
      method: 'POST',
      headers,
      body: JSON.stringify({ email, code: start.testCode, password: 'load-test-pass-1' }),
    });
    if (!finish.ok) failures++;
    times.push(Date.now() - t0);
  };
  await Promise.all(Array.from({ length: concurrency }, async () => { while (next < count) await one(next++); }));
  const seconds = (Date.now() - started) / 1000;
  return { count, failures, perSecond: count / seconds, p50: pct(times, 50), p95: pct(times, 95) };
}

async function main() {
  const maxPeople = Math.max(...LEVELS);
  console.log(`Seeding ${maxPeople} people into a fresh database…`);
  const people = seedPeople(maxPeople);

  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DATA_DIR, TRUST_PROXY: '1', ZINGO_SHOW_CODES: '1', NODE_ENV: 'development' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  await waitForServer();
  console.log(`Server running (pid ${server.pid}). ${WORKERS} load workers. Picky share: ${PICKY * 100}%.\n`);

  const signups = SIGNUPS ? await measureSignups(SIGNUPS) : null;
  if (signups) {
    console.log(`Sign-ups: ${signups.count} in a row, ${signups.perSecond.toFixed(1)}/s, p50 ${ms(signups.p50)}, p95 ${ms(signups.p95)}, failures ${signups.failures}\n`);
  }

  // Workers report every second; keep the latest counters and pool the samples.
  const workers = Array.from({ length: WORKERS }, () => fork(path.join(__dirname, 'worker.js')));
  const latest = new Map();
  let samples = { latencies: [], matchTimes: [] };
  for (const w of workers) {
    w.send({ type: 'config', config: { url: URL } });
    w.on('message', (m) => {
      if (m.type !== 'stats') return;
      latest.set(w.pid, m.stats);
      samples.latencies.push(...m.stats.latencies);
      samples.matchTimes.push(...m.stats.matchTimes);
    });
  }
  const totals = () => {
    const t = { connected: 0, connectErrors: 0, disconnects: 0, sent: 0, received: 0 };
    for (const s of latest.values()) for (const k of Object.keys(t)) t[k] += s[k];
    return t;
  };

  const results = [];
  let added = 0;
  for (const level of LEVELS) {
    const batch = people.slice(added, level);
    added = level;
    // Spread new arrivals over the workers at about 400 connections a second in total.
    const gapMs = Math.max(1, Math.round((1000 / RATE) * WORKERS));
    workers.forEach((w, i) => w.send({ type: 'add', gapMs, people: batch.filter((_, j) => j % WORKERS === i) }));

    const deadline = Date.now() + 120000;
    while (totals().connected + totals().connectErrors < level && Date.now() < deadline) await sleep(500);
    await sleep(5000); // let the new arrivals settle into chatting

    samples = { latencies: [], matchTimes: [] };
    const before = totals();
    const cpu0 = serverCpuSeconds(server.pid);
    const t0 = Date.now();
    await sleep(MEASURE_MS);
    const seconds = (Date.now() - t0) / 1000;
    const after = totals();
    const row = {
      people: level,
      connected: after.connected - after.disconnects,
      connectErrors: after.connectErrors,
      messagesPerSecond: (after.received - before.received) / seconds,
      matchesPerSecond: samples.matchTimes.length / seconds,
      matchP50: pct(samples.matchTimes, 50),
      matchP95: pct(samples.matchTimes, 95),
      latencyP50: pct(samples.latencies, 50),
      latencyP95: pct(samples.latencies, 95),
      latencyP99: pct(samples.latencies, 99),
      serverCpu: ((serverCpuSeconds(server.pid) - cpu0) / seconds) * 100,
      serverMemoryMb: serverMemoryMb(server.pid),
    };
    results.push(row);
    console.log(
      `${String(level).padStart(6)} people | ${String(row.connected).padStart(6)} connected, ${row.connectErrors} failed | ` +
        `${row.messagesPerSecond.toFixed(0)} msg/s | delivery p50 ${ms(row.latencyP50)}, p95 ${ms(row.latencyP95)}, p99 ${ms(row.latencyP99)} | ` +
        `match p50 ${ms(row.matchP50)}, p95 ${ms(row.matchP95)} | server CPU ${row.serverCpu.toFixed(0)}%, ${row.serverMemoryMb.toFixed(0)} MB`,
    );
    const failing = row.latencyP95 > P95_LIMIT_MS || row.connectErrors > level * 0.01;
    if (row.connectErrors) {
      const reasons = {};
      for (const s of latest.values()) for (const [r, n] of Object.entries(s.errorReasons)) reasons[r] = (reasons[r] || 0) + n;
      console.log('         connection errors:', reasons);
    }
    if (failing) {
      console.log(`\nStopping: past the limit (p95 delivery over ${P95_LIMIT_MS} ms or over 1% failed connections).`);
      break;
    }
  }

  for (const w of workers) w.send({ type: 'stop' });
  server.kill();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  const out = path.join(__dirname, `results-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json`);
  fs.writeFileSync(out, JSON.stringify({ when: new Date().toISOString(), picky: PICKY, workers: WORKERS, signups, results }, null, 2));
  console.log(`\nSaved ${path.relative(process.cwd(), out)}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
