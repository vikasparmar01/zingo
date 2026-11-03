const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const db = require('./db');
const auth = require('./auth');
const forms = require('./forms');
const admin = require('./admin');

const PORT = process.env.PORT || 3000;
const MAX_MESSAGE_LENGTH = 1000;
const MIN_MESSAGE_GAP_MS = 300;
const INTEREST_WAIT_MS = 6000; // after this long, ignore interests (filters still apply)
const REPORTERS_TO_SUSPEND = 3; // distinct people within REPORT_WINDOW_MS
const REPORT_WINDOW_MS = 24 * 60 * 60 * 1000;
const SUSPEND_MS = 24 * 60 * 60 * 1000;
const MINOR_REPORTERS_TO_BLOCK = 2; // distinct people reporting "seems under 18"
const REPORT_REASONS = ['harassment', 'sexual', 'hate', 'minor', 'spam'];

const ICEBREAKERS = [
  "What's something small that made you smile this week?",
  'If you could live anywhere for a year, where would it be?',
  "What's a song you've had on repeat lately?",
  "What's a skill you'd love to learn?",
  'What does a perfect lazy day look like for you?',
  "What's the best piece of advice you've ever been given?",
  'Is there a movie or show you could rewatch forever?',
  "What's something you're looking forward to?",
  "What's a food that reminds you of home?",
  'If you had a free afternoon tomorrow, how would you spend it?',
  "What's something you're proud of that most people don't know?",
  'Cats, dogs, or neither?',
  "What's a place that instantly makes you feel calm?",
  'What were you really into as a kid?',
];

const app = express();
// TRUST_PROXY is the number of proxies in front of Zingo (1 for a tunnel or load balancer), so req.ip is the visitor's.
app.set('trust proxy', Number(process.env.TRUST_PROXY) || false);
app.use('/api', auth.router);
app.use('/api', forms.router);
app.use('/api', admin.router);
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
// Video call setup messages (SDP) can be several KB, so allow up to 100 KB per packet.
const io = new Server(server, { maxHttpBufferSize: 1e5 });

// People waiting for a match, indexed so a newcomer is only checked against people they could
// actually be paired with, instead of everyone against everyone (which stalled the server under load).
const queue = {
  all: new Map(), // socket.id -> socket, in the order people joined (oldest first)
  open: new Set(), // ids of people who picked no topics
  byTopic: new Map(), // topic -> Set of ids
  add(socket) {
    this.all.set(socket.id, socket);
    if (!socket.data.interests.length) this.open.add(socket.id);
    for (const topic of socket.data.interests) {
      if (!this.byTopic.has(topic)) this.byTopic.set(topic, new Set());
      this.byTopic.get(topic).add(socket.id);
    }
  },
  remove(socket) {
    if (!this.all.delete(socket.id)) return;
    this.open.delete(socket.id);
    for (const topic of socket.data.interests) {
      const ids = this.byTopic.get(topic);
      ids?.delete(socket.id);
      if (ids && !ids.size) this.byTopic.delete(topic);
    }
  },
};
const MAX_SWEEP_CHECKS = 50000; // caps the once-a-second pass so it can never block the server for long

function randomIcebreaker() {
  return ICEBREAKERS[Math.floor(Math.random() * ICEBREAKERS.length)];
}

function cleanInterests(list) {
  if (!Array.isArray(list)) return [];
  const cleaned = list
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim().toLowerCase().slice(0, 24))
    .filter(Boolean);
  return [...new Set(cleaned)].slice(0, 8);
}

function cleanFilters(filters = {}) {
  return {
    gender: ['woman', 'man'].includes(filters.gender) ? filters.gender : 'any',
    country: filters.country === 'same' ? 'same' : 'any',
  };
}

// Hide contact details so strangers can't pull each other off the platform.
function sanitize(text) {
  return text
    .replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, '[email hidden]')
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, '[link hidden]')
    .replace(/(?:\+?\d[\s().-]?){7,}\d/g, '[number hidden]');
}

function partnerOf(socket) {
  const id = socket.data.partnerId;
  return id ? io.sockets.sockets.get(id) : null;
}

function endChat(socket, reason) {
  const partner = partnerOf(socket);
  socket.data.partnerId = null;
  if (!partner) return;
  partner.data.partnerId = null;
  partner.data.lastPartnerId = socket.id;
  socket.data.lastPartnerId = partner.id;
  partner.emit('partner_left', { reason });
}

// Re-reads the account so bans issued since connecting take effect, and kicks blocked users out.
function refreshUser(socket) {
  const user = db.userById(socket.data.user.id);
  socket.data.user = user;
  const blocked = user && auth.blockStatus(user);
  if (user && !blocked) return true;
  queue.remove(socket);
  endChat(socket, 'left');
  socket.emit('blocked', blocked || { reason: 'deleted' });
  socket.disconnect(true);
  return false;
}

function sharedInterests(a, b) {
  return a.data.interests.filter((interest) => b.data.interests.includes(interest));
}

function accepts(filters, me, them) {
  return (
    (filters.gender === 'any' || them.gender === filters.gender) &&
    (filters.country === 'any' || them.country === me.country)
  );
}

function partnerCard(user) {
  return { gender: user.gender === 'unspecified' ? null : user.gender, country: user.country };
}

function connect(a, b, shared) {
  queue.remove(a);
  queue.remove(b);
  a.data.partnerId = b.id;
  b.data.partnerId = a.id;
  const icebreaker = randomIcebreaker();
  // In video chats the initiator sends the WebRTC offer.
  a.emit('matched', { shared, icebreaker, initiator: true, partner: partnerCard(b.data.user) });
  b.emit('matched', { shared, icebreaker, initiator: false, partner: partnerCard(a.data.user) });
}

// Whether two waiting people may be paired, and the topics they share. People must be in the same
// mode and accepted by each other's filters. They need a shared topic, or both to have picked none;
// once both have waited a while, topics are ignored (filters never are).
function pairable(a, b, now) {
  if (a === b || a.data.mode !== b.data.mode || a.data.user.id === b.data.user.id) return null;
  if (!accepts(a.data.filters, a.data.user, b.data.user) || !accepts(b.data.filters, b.data.user, a.data.user)) return null;
  const patient = now - a.data.waitingSince > INTEREST_WAIT_MS && now - b.data.waitingSince > INTEREST_WAIT_MS;
  const justTalked = a.data.lastPartnerId === b.id || b.data.lastPartnerId === a.id;
  if (justTalked && !patient) return null;
  const shared = sharedInterests(a, b);
  const noPreferences = !a.data.interests.length && !b.data.interests.length;
  if (!shared.length && !noPreferences && !patient) return null;
  return shared;
}

// Tries to pair someone who just joined. Returns true if they were matched.
function matchNewcomer(a) {
  const now = Date.now();
  let best = null;
  let bestShared = [];
  const seen = new Set();
  for (const topic of a.data.interests) {
    for (const id of queue.byTopic.get(topic) || []) {
      if (seen.has(id)) continue;
      seen.add(id);
      const shared = pairable(a, queue.all.get(id), now);
      if (shared && shared.length > bestShared.length) {
        best = queue.all.get(id);
        bestShared = shared;
      }
    }
  }
  if (!best && !a.data.interests.length) {
    for (const id of queue.open) {
      if (pairable(a, queue.all.get(id), now)) {
        best = queue.all.get(id);
        break;
      }
    }
  }
  if (!best) return false;
  connect(a, best, bestShared);
  return true;
}

// Once a second, pair people who have waited long enough for topics to stop mattering.
function sweep() {
  const now = Date.now();
  const patient = [];
  for (const socket of queue.all.values()) {
    if (now - socket.data.waitingSince <= INTEREST_WAIT_MS) break; // the rest joined more recently
    patient.push(socket);
  }
  const paired = new Set();
  let checks = 0;
  for (let i = 0; i < patient.length; i++) {
    const a = patient[i];
    if (paired.has(a.id)) continue;
    for (let j = i + 1; j < patient.length; j++) {
      const b = patient[j];
      if (paired.has(b.id)) continue;
      if (++checks > MAX_SWEEP_CHECKS) return;
      const shared = pairable(a, b, now);
      if (shared) {
        paired.add(a.id);
        paired.add(b.id);
        connect(a, b, shared);
        break;
      }
    }
  }
}

function handleReport(reporter, reported, reason) {
  const now = Date.now();
  const reportedId = reported.data.user.id;
  db.addReport(reporter.data.user.id, reportedId, reason, now);
  console.log(`[report] ${new Date(now).toISOString()} user=${reportedId} reason=${reason}`);

  if (db.distinctReportersForReason(reportedId, 'minor') >= MINOR_REPORTERS_TO_BLOCK) {
    db.blockUser(reportedId, 'age_review');
  } else if (db.distinctReportersSince(reportedId, now - REPORT_WINDOW_MS) >= REPORTERS_TO_SUSPEND) {
    db.banUntil(reportedId, now + SUSPEND_MS);
  }
  refreshUser(reported);
}

setInterval(sweep, 1000).unref();
setInterval(() => io.emit('online', io.sockets.sockets.size), 5000).unref();

// Only signed-in adults with a finished profile can connect.
io.use((socket, next) => {
  const { origin, host } = socket.handshake.headers;
  if (origin && new URL(origin).host !== host) return next(new Error('bad_origin'));

  const user = auth.userFromCookieHeader(socket.handshake.headers.cookie);
  if (!user) return next(new Error('unauthorized'));
  if (!user.birthdate) return next(new Error('profile_incomplete'));
  if (auth.blockStatus(user)) return next(new Error('blocked'));
  socket.data.user = user;
  next();
});

io.on('connection', (socket) => {
  socket.data.interests = [];
  socket.data.filters = cleanFilters();
  socket.data.lastMessageAt = 0;
  // Only the newcomer gets the count now; everyone else gets it on the 5-second update. Broadcasting on
  // every join sent the count to all N people each time, which choked the server when a crowd arrived.
  socket.emit('online', io.sockets.sockets.size);

  socket.on('find', ({ interests, mode, filters } = {}) => {
    if (!refreshUser(socket)) return;
    endChat(socket, 'skipped');
    queue.remove(socket); // before the topics change, so the index stays correct
    socket.data.interests = cleanInterests(interests);
    socket.data.mode = mode === 'video' ? 'video' : 'text';
    socket.data.filters = cleanFilters(filters);
    socket.data.waitingSince = Date.now();
    socket.emit('waiting');
    if (!matchNewcomer(socket)) queue.add(socket);
  });

  socket.on('message', (raw) => {
    const partner = partnerOf(socket);
    if (!partner || typeof raw !== 'string') return;
    const now = Date.now();
    if (now - socket.data.lastMessageAt < MIN_MESSAGE_GAP_MS) return socket.emit('slow_down');
    socket.data.lastMessageAt = now;

    const text = sanitize(raw.trim().slice(0, MAX_MESSAGE_LENGTH));
    if (!text) return;
    socket.emit('message', { from: 'you', text });
    partner.emit('message', { from: 'stranger', text });
  });

  socket.on('typing', (isTyping) => {
    partnerOf(socket)?.emit('typing', Boolean(isTyping));
  });

  // WebRTC signaling: relay offers, answers and ICE candidates to the current partner only.
  // The video itself flows directly between the two browsers, never through this server.
  socket.on('signal', (data) => {
    if (!data || typeof data !== 'object') return;
    partnerOf(socket)?.emit('signal', { description: data.description, candidate: data.candidate });
  });

  socket.on('media', (media) => {
    partnerOf(socket)?.emit('media', { camera: Boolean(media?.camera) });
  });

  socket.on('icebreaker', () => {
    const partner = partnerOf(socket);
    if (!partner) return;
    const now = Date.now();
    if (now - socket.data.lastMessageAt < MIN_MESSAGE_GAP_MS) return;
    socket.data.lastMessageAt = now;

    const text = randomIcebreaker();
    socket.emit('icebreaker', text);
    partner.emit('icebreaker', text);
  });

  socket.on('leave', () => {
    queue.remove(socket);
    endChat(socket, 'left');
  });

  socket.on('report', (reason) => {
    const partner = partnerOf(socket);
    if (!partner) return;
    endChat(socket, 'left');
    handleReport(socket, partner, REPORT_REASONS.includes(reason) ? reason : 'harassment');
  });

  socket.on('disconnect', () => {
    queue.remove(socket);
    endChat(socket, 'disconnected');
  });
});

// Started directly (npm start) it listens on PORT; the tests import it and pick their own port.
if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Zingo is running at http://localhost:${PORT}`);
  });
}

module.exports = { server, io };
