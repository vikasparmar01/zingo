// One load-generator process. It opens many simulated people, each of whom joins the queue,
// chats for a few messages, then skips to someone new — like a real user, only tireless.
const { io } = require('socket.io-client');

const MESSAGES_PER_CHAT = 5;
const MESSAGE_INTERVAL_MS = 4000;

let config;
const stats = { connected: 0, connectErrors: 0, disconnects: 0, sent: 0, received: 0, matchTimes: [], latencies: [], errorReasons: {} };

// Timestamps are sent as letters, because the server hides long digit runs as phone numbers.
const encode = (n) => String(n).replace(/\d/g, (d) => 'abcdefghij'[d]);
const decode = (s) => Number(s.replace(/[a-j]/g, (c) => c.charCodeAt(0) - 97));

function person(token, picky) {
  const socket = io(config.url, {
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
    timeout: 20000,
    extraHeaders: { cookie: `zingo_session=${token}` },
  });
  let findAt = 0;
  let timer = null;
  let sentThisChat = 0;

  const find = () => {
    clearInterval(timer);
    findAt = Date.now();
    // Picky people pick a topic nobody else has, so they wait in the queue before being paired.
    socket.emit('find', {
      mode: 'text',
      interests: picky ? [`topic-${Math.random().toString(36).slice(2, 8)}`] : [],
      filters: { gender: 'any', country: 'any' },
    });
  };

  socket.on('connect', () => {
    stats.connected++;
    setTimeout(find, Math.random() * 1000);
  });
  socket.on('connect_error', (err) => {
    stats.connectErrors++;
    const reason = `${err.message}${err.description ? ` (${err.description.message || err.description})` : ''}`;
    stats.errorReasons[reason] = (stats.errorReasons[reason] || 0) + 1;
  });
  socket.on('disconnect', () => {
    stats.disconnects++;
    clearInterval(timer);
  });
  socket.on('matched', () => {
    stats.matchTimes.push(Date.now() - findAt);
    sentThisChat = 0;
    clearInterval(timer);
    const send = () => {
      if (sentThisChat >= MESSAGES_PER_CHAT) return find(); // skip to someone new
      sentThisChat++;
      stats.sent++;
      socket.emit('message', `hello ${encode(Date.now())}`);
    };
    setTimeout(() => {
      send();
      timer = setInterval(send, MESSAGE_INTERVAL_MS);
    }, Math.random() * MESSAGE_INTERVAL_MS);
  });
  socket.on('message', ({ from, text }) => {
    if (from !== 'stranger') return;
    stats.received++;
    stats.latencies.push(Date.now() - decode(text.split(' ')[1]));
  });
  socket.on('partner_left', () => find());
  return socket;
}

const sockets = [];
process.on('message', async (msg) => {
  if (msg.type === 'config') config = msg.config;
  if (msg.type === 'add') {
    // Open connections gradually, as real people arrive, rather than all in the same millisecond.
    for (const { token, picky } of msg.people) {
      sockets.push(person(token, picky));
      await new Promise((r) => setTimeout(r, msg.gapMs));
    }
  }
  if (msg.type === 'stop') {
    for (const s of sockets) s.close();
    process.exit(0);
  }
});

setInterval(() => {
  process.send({ type: 'stats', stats: { ...stats } });
  stats.matchTimes = [];
  stats.latencies = [];
}, 1000);
