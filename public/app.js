// Connects only after sign-in; the server rejects sockets without a valid session.
const socket = io({ autoConnect: false });
const $ = (id) => document.getElementById(id);

const SUGGESTED = ['music', 'movies', 'gaming', 'books', 'travel', 'study', 'fitness', 'art', 'tech', 'just listening'];
const MOOD_MESSAGES = {
  1: "That took courage. Not every conversation clicks, and that's okay.",
  2: 'Every conversation is practice. You showed up, and that counts.',
  3: 'Nice! You made a real connection with a stranger.',
  4: 'That is wonderful. Hold on to that feeling.',
};
// Public STUN server so browsers can find a direct route to each other.
// Production also needs a TURN server for people behind strict networks.
const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

// --- Local storage (per-device, never sent to the server) ---
function load(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem('zingo:' + key)) ?? fallback;
  } catch {
    return fallback;
  }
}
function save(key, value) {
  try {
    localStorage.setItem('zingo:' + key, JSON.stringify(value));
  } catch {}
}
const stats = () => load('stats', { chats: 0, seconds: 0, good: 0 });

// --- Account ---
let user = null;
const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
const countryName = (code) => regionNames.of(code) ?? code;
const flag = (code) => String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));

async function api(path, body) {
  const options =
    body === undefined
      ? {}
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  try {
    const res = await fetch('/api' + path, options);
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, ...data };
  } catch {
    return { ok: false, error: "Can't reach Zingo. Check your connection." };
  }
}

function blockedMessage({ reason, until }) {
  if (reason === 'underage') return "Zingo is only for adults aged 18 and over, so this account can't be used.";
  if (reason === 'age_review') return 'Your account is paused while we review reports about your age.';
  if (reason === 'suspended') {
    return `Your account is paused until ${new Date(until).toLocaleString()} because several people reported you.`;
  }
  return "This account can't be used right now.";
}

const GENERIC_ERROR = 'Something went wrong. Please try again.';
const localeCountry = (navigator.language.split('-')[1] || '').toUpperCase();

// --- Pages ---
const PAGES = ['creators', 'suggestions', 'admin'];
function currentPage() {
  const page = location.hash.replace(/^#\/?/, '');
  return PAGES.includes(page) ? page : 'app';
}

// Shows the right screen for the page in the address bar and the account's state.
function render() {
  const page = currentPage();
  for (const link of document.querySelectorAll('.topnav a')) {
    if (link.dataset.page === page) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  if (page !== 'app') {
    if (state === 'chatting' || state === 'waiting') {
      socket.emit('leave');
      closeChat();
      setState('idle');
    }
    if (page === 'admin') {
      if (!user) return show('login');
      if (!user.isAdmin) return (location.hash = '#/');
      loadAdmin();
    }
    $('contact-field').hidden = Boolean(user);
    if (user?.email && !$('creator-email').value) $('creator-email').value = user.email;
    return show(page);
  }
  if (!user) return show('login');
  if (user.blocked) {
    $('blocked-msg').textContent = blockedMessage(user.blocked);
    return show('blocked');
  }
  if (!user.profileComplete) return show('profile');
  $('filter-country-same').textContent = `Only ${countryName(user.country)}`;
  if (!$('chat').classList.contains('active')) show('home');
}
window.addEventListener('hashchange', render);

function route(nextUser) {
  user = nextUser;
  $('admin-link').hidden = !user?.isAdmin;
  $('logout-btn').hidden = !user;
  if (!user || user.blocked || !user.profileComplete) socket.disconnect();
  else if (!socket.connected) socket.connect();
  render();
}

async function boot() {
  const res = await api('/me');
  route(res.ok ? res.user : null);
}

// --- Sign in, sign up and forgot password ---
const AUTH_COPY = {
  signin: { title: 'Welcome back', sub: 'Sign in with your email or phone number.', submit: 'Sign in' },
  signup: { title: 'Join Zingo', sub: "We'll send you a code to check it's really you.", submit: 'Send me a code' },
  forgot: { title: 'Reset your password', sub: "We'll send a code to your email or phone.", submit: 'Send reset code' },
};
let authMode = 'signin';
let pending = null; // { body, label, country, purpose } while waiting for a code
let dialCodes = new Map(); // country code -> calling code

function setAuthMessage(text, ok = false) {
  $('auth-error').textContent = text;
  $('auth-error').classList.toggle('ok', ok);
}

function setAuthMode(next) {
  authMode = next;
  pending = null;
  const copy = AUTH_COPY[next];
  $('auth-title').textContent = copy.title;
  $('auth-sub').textContent = copy.sub;
  $('auth-submit').textContent = copy.submit;
  $('password-field').hidden = next !== 'signin';
  $('forgot-link').hidden = next !== 'signin';
  $('back-signin').hidden = next !== 'forgot';
  $('auth-tabs').hidden = next === 'forgot';
  for (const tab of $('auth-tabs').children) tab.setAttribute('aria-selected', tab.dataset.mode === next);
  $('auth-form').hidden = false;
  $('code-form').hidden = true;
  setAuthMessage('');
}
for (const tab of $('auth-tabs').children) tab.onclick = () => setAuthMode(tab.dataset.mode);
$('forgot-link').onclick = () => setAuthMode('forgot');
$('back-signin').onclick = () => setAuthMode('signin');

const method = () => document.querySelector('input[name=method]:checked').value;
function renderMethod() {
  $('email-field').hidden = method() !== 'email';
  $('phone-field').hidden = method() !== 'phone';
}
for (const input of document.querySelectorAll('input[name=method]')) {
  input.checked = input.value === load('method', 'email');
  input.onchange = () => {
    save('method', method());
    renderMethod();
  };
}

// What the person typed, in the shape the server expects, plus how to show it back to them.
function readIdentifier() {
  if (method() === 'email') {
    const email = $('email').value.trim();
    return { body: { email }, label: email };
  }
  const country = $('dial').value;
  const number = $('phone').value.trim();
  return { body: { phone: { country, number } }, label: `+${dialCodes.get(country)} ${number}`, country };
}

async function fillDialCodes() {
  const res = await api('/countries');
  if (!res.ok) return;
  dialCodes = new Map(res.countries.map((c) => [c.code, c.dial]));
  const sorted = res.countries
    .map((c) => ({ ...c, name: countryName(c.code) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  $('dial').replaceChildren(
    ...sorted.map((c) => new Option(`${c.name} +${c.dial}`, c.code, false, c.code === localeCountry)),
  );
}

for (const toggle of document.querySelectorAll('.pw-toggle')) {
  toggle.setAttribute('aria-label', 'Show password');
  toggle.onclick = () => {
    const input = $(toggle.dataset.for);
    const reveal = input.type === 'password';
    input.type = reveal ? 'text' : 'password';
    toggle.textContent = reveal ? 'Hide' : 'Show';
    toggle.setAttribute('aria-label', reveal ? 'Hide password' : 'Show password');
  };
}

$('auth-form').onsubmit = async (e) => {
  e.preventDefault();
  const id = readIdentifier();
  const button = $('auth-submit');
  button.disabled = true;
  setAuthMessage('');

  if (authMode === 'signin') {
    const res = await api('/auth/signin', { ...id.body, password: $('password').value });
    button.disabled = false;
    if (!res.ok) return setAuthMessage(res.error || GENERIC_ERROR);
    $('password').value = '';
    return route(res.user);
  }

  const purpose = authMode === 'signup' ? 'signup' : 'forgot';
  const res = await api(`/auth/${purpose}/start`, id.body);
  button.disabled = false;
  if (!res.ok) return setAuthMessage(res.error || GENERIC_ERROR);
  pending = { ...id, purpose };
  showTestCode(res.testCode);
  const signup = purpose === 'signup';
  $('code-label').textContent = signup
    ? `Enter the code we sent to ${id.label}`
    : `If ${id.label} has an account, we've sent it a code`;
  $('new-password-label').textContent = signup ? 'Create a password' : 'New password';
  $('code-submit').textContent = signup ? 'Create account' : 'Reset password';
  $('code').value = '';
  $('new-password').value = '';
  $('auth-form').hidden = true;
  $('auth-tabs').hidden = true;
  $('code-form').hidden = false;
  $('code').focus();
};

$('code-form').onsubmit = async (e) => {
  e.preventDefault();
  const button = $('code-submit');
  button.disabled = true;
  setAuthMessage('');
  const res = await api(`/auth/${pending.purpose}/finish`, {
    ...pending.body,
    code: $('code').value.trim(),
    password: $('new-password').value,
  });
  button.disabled = false;
  if (!res.ok) return setAuthMessage(res.error || GENERIC_ERROR);
  // Someone who signed up with a phone number most likely lives in that number's country.
  if (pending.country && COUNTRY_CODES.includes(pending.country)) $('country').value = pending.country;
  setAuthMode('signin');
  route(res.user);
};

// Only a server started in test mode sends the code back; then it is shown here instead of emailed or texted.
function showTestCode(code) {
  $('test-code').hidden = !code;
  $('test-code').textContent = code ? `Test mode: your code is ${code}` : '';
}

$('change-identifier').onclick = () => setAuthMode(pending?.purpose === 'forgot' ? 'forgot' : 'signup');
$('resend-code').onclick = async () => {
  const res = await api(`/auth/${pending.purpose}/start`, pending.body);
  if (res.ok) {
    setAuthMessage('A new code is on its way.', true);
    showTestCode(res.testCode);
  }
  else setAuthMessage(res.error || GENERIC_ERROR);
};

function fillCountries() {
  const sorted = COUNTRY_CODES.map((code) => [code, countryName(code)]).sort((a, b) => a[1].localeCompare(b[1]));
  for (const select of [$('country'), $('creator-country')]) {
    const placeholder = new Option('Choose your country', '', true, !COUNTRY_CODES.includes(localeCountry));
    placeholder.disabled = true;
    select.replaceChildren(
      placeholder,
      ...sorted.map(([code, name]) => new Option(`${flag(code)} ${name}`, code, false, code === localeCountry)),
    );
  }
}

// --- Creators and suggestions ---
async function submitForm(form, path, body, doneId) {
  const error = form.querySelector('.form-error');
  const button = form.querySelector('button.big');
  error.textContent = '';
  button.disabled = true;
  const res = await api(path, body);
  button.disabled = false;
  if (!res.ok) return (error.textContent = res.error || GENERIC_ERROR);
  form.hidden = true;
  $(doneId).hidden = false;
}

$('creator-form').onsubmit = (e) => {
  e.preventDefault();
  submitForm(
    e.target,
    '/creators',
    {
      name: $('creator-name').value,
      email: $('creator-email').value,
      platform: $('creator-platform').value,
      handle: $('creator-handle').value,
      audience: $('creator-audience').value,
      country: $('creator-country').value,
      pitch: $('creator-pitch').value,
    },
    'creator-done',
  );
};
$('creator-again').onclick = () => {
  $('creator-form').reset();
  $('creator-done').hidden = true;
  $('creator-form').hidden = false;
};

const suggestionKind = () => document.querySelector('input[name=kind]:checked').value;
for (const input of document.querySelectorAll('input[name=kind]')) {
  input.onchange = () => ($('safety-note').hidden = suggestionKind() !== 'safety');
}
$('suggestion-form').onsubmit = (e) => {
  e.preventDefault();
  submitForm(
    e.target,
    '/suggestions',
    {
      kind: suggestionKind(),
      message: $('suggestion-message').value,
      contact: user ? undefined : $('suggestion-contact').value.trim() || undefined,
    },
    'suggestion-done',
  );
};
$('suggestion-again').onclick = () => {
  $('suggestion-form').reset();
  $('safety-note').hidden = true;
  $('suggestion-done').hidden = true;
  $('suggestion-form').hidden = false;
};

$('share-btn').onclick = async () => {
  const share = { title: 'Zingo', text: 'Random one-on-one chats with real people. Give Zingo a try:', url: location.origin };
  if (navigator.share) {
    try {
      await navigator.share(share);
      return;
    } catch (err) {
      if (err.name === 'AbortError') return;
    }
  }
  try {
    await navigator.clipboard.writeText(`${share.text} ${share.url}`);
    $('share-note').textContent = 'Link copied. Paste it to a friend.';
  } catch {
    $('share-note').textContent = `Send them this link: ${share.url}`;
  }
};
$('birthdate').max = new Date().toISOString().slice(0, 10);

$('profile-form').onsubmit = async (e) => {
  e.preventDefault();
  $('profile-error').textContent = '';
  const res = await api('/profile', {
    birthdate: $('birthdate').value,
    gender: $('gender').value,
    country: $('country').value,
  });
  if (!res.user) return ($('profile-error').textContent = res.error || 'Something went wrong. Please try again.');
  route(res.user);
};

async function logout() {
  if (socket.connected) socket.emit('leave');
  closeChat();
  setState('idle');
  await api('/auth/logout', {});
  route(null);
}
$('logout-btn').onclick = logout;
$('blocked-logout').onclick = logout;

// --- Home screen ---
const selected = new Set(load('interests', []));
let mode = load('mode', 'text');
let blurNewVideo = load('blur', true);
const filters = load('filters', { gender: 'any', country: 'any' });

for (const key of ['gender', 'country']) {
  $('filter-' + key).value = filters[key];
  $('filter-' + key).onchange = (e) => {
    filters[key] = e.target.value;
    save('filters', filters);
  };
}

function describePartner({ gender, country }) {
  const who = { woman: 'a woman', man: 'a man', nonbinary: 'a non-binary person' }[gender] ?? 'someone';
  return `${who} from ${countryName(country)}`;
}

function renderChips() {
  const all = [...new Set([...SUGGESTED, ...selected])];
  $('chips').replaceChildren(
    ...all.map((name) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip' + (selected.has(name) ? ' on' : '');
      chip.textContent = name;
      chip.setAttribute('aria-pressed', selected.has(name));
      chip.onclick = () => {
        selected.has(name) ? selected.delete(name) : selected.add(name);
        save('interests', [...selected]);
        renderChips();
      };
      return chip;
    }),
  );
}

function renderStats() {
  const s = stats();
  $('stat-chats').textContent = s.chats;
  $('stat-minutes').textContent = Math.round(s.seconds / 60);
  $('stat-good').textContent = s.good;
}

function renderMode() {
  for (const input of document.querySelectorAll('input[name=mode]')) input.checked = input.value === mode;
  $('blur-option').hidden = mode !== 'video';
  $('blur').checked = blurNewVideo;
}

function show(screen) {
  for (const el of document.querySelectorAll('.screen')) el.classList.toggle('active', el.id === screen);
  $('chat').classList.toggle('video-mode', mode === 'video');
  if (screen !== 'chat') stopCamera();
  if (screen === 'home') renderStats();
}

for (const input of document.querySelectorAll('input[name=mode]')) {
  input.onchange = () => {
    mode = input.value;
    save('mode', mode);
    renderMode();
  };
}
$('blur').onchange = (e) => {
  blurNewVideo = e.target.checked;
  save('blur', blurNewVideo);
};

$('interest-input').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const value = e.target.value.trim().toLowerCase().slice(0, 24);
  if (value && selected.size < 8) {
    selected.add(value);
    save('interests', [...selected]);
    renderChips();
  }
  e.target.value = '';
});

$('agree').checked = load('agreed', false);
$('start').disabled = !$('agree').checked;
$('agree').onchange = (e) => {
  $('start').disabled = !e.target.checked;
  save('agreed', e.target.checked);
};

async function startChatting() {
  if (mode === 'video' && !(await startCamera())) return;
  show('chat');
  find();
}
$('start').onclick = startChatting;

// --- Chat ---
let state = 'idle'; // idle | waiting | chatting | ended
let chat = null; // { startedAt, sent, received } for the current conversation

function setState(next) {
  state = next;
  const chatting = next === 'chatting';
  $('msg').disabled = !chatting;
  $('send').disabled = !chatting;
  $('icebreaker-btn').disabled = !chatting;
  $('report-btn').disabled = !chatting;
  $('video-report-btn').disabled = !chatting;
  $('next-btn').disabled = next === 'waiting';
  $('video-skip-btn').disabled = next === 'waiting';
  $('typing').hidden = true;
  resetNextConfirm();
  $('next-label').textContent = next === 'ended' ? 'New chat' : 'Skip';
  $('video-skip-btn').textContent = next === 'ended' ? 'New chat' : 'Skip';

  const labels = {
    waiting: 'Looking for someone to talk to…',
    chatting: 'Connected with a stranger',
    ended: 'Chat ended',
    idle: '',
  };
  $('status').className = 'status ' + next;
  $('status-text').textContent = labels[next];

  if (!chatting) closePeer();
  renderRemote();
}

function addMessage(kind, text) {
  const el = document.createElement('div');
  el.className = 'msg ' + kind;
  el.textContent = text;
  $('messages').append(el);
  $('messages').scrollTop = $('messages').scrollHeight;
}

// Records the conversation in local stats. Returns true if both people actually talked.
function closeChat() {
  if (!chat) return false;
  const real = chat.sent > 0 && chat.received > 0;
  if (real) {
    const s = stats();
    s.chats += 1;
    s.seconds += (Date.now() - chat.startedAt) / 1000;
    save('stats', s);
  }
  chat = null;
  return real;
}

function find() {
  closeChat();
  $('messages').replaceChildren();
  setState('waiting');
  socket.emit('find', { interests: [...selected], mode, filters });
}

// The Skip buttons move on straight away, so anyone uncomfortable can leave in one tap.
function skip() {
  if (state === 'waiting') return;
  find();
}

// The Esc key takes two presses, because a key is easy to hit by accident.
let confirmTimer = null;
function resetNextConfirm() {
  clearTimeout(confirmTimer);
  confirmTimer = null;
  $('next-label').textContent = state === 'ended' ? 'New chat' : 'Skip';
}
function skipFromKeyboard() {
  if (state !== 'chatting') return skip();
  if (!confirmTimer) {
    $('next-label').textContent = 'Esc again';
    confirmTimer = setTimeout(resetNextConfirm, 2500);
    return;
  }
  skip();
}

$('next-btn').onclick = skip;
$('video-skip-btn').onclick = skip;
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('chat').classList.contains('active') && !document.querySelector('dialog[open]')) {
    e.preventDefault();
    skipFromKeyboard();
  }
});

$('end-btn').onclick = () => {
  socket.emit('leave');
  const real = closeChat();
  setState('idle');
  if (real) openReflection();
  else show('home');
};

$('composer').onsubmit = (e) => {
  e.preventDefault();
  const text = $('msg').value.trim();
  if (!text || state !== 'chatting') return;
  socket.emit('message', text);
  $('msg').value = '';
  setTyping(false);
};

let typingSent = false;
let typingTimer = null;
function setTyping(on) {
  clearTimeout(typingTimer);
  if (typingSent !== on) socket.emit('typing', on);
  typingSent = on;
}
$('msg').addEventListener('input', () => {
  setTyping(true);
  typingTimer = setTimeout(() => setTyping(false), 1500);
});

$('icebreaker-btn').onclick = () => socket.emit('icebreaker');

// --- Video ---
let localStream = null;
let pc = null;
let signalChain = Promise.resolve();
let remoteState = 'waiting'; // waiting | live | camera-off
let revealed = false;

async function startCamera() {
  if (localStream) return true;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 } },
      audio: { echoCancellation: true, noiseSuppression: true },
    });
  } catch (err) {
    console.warn('Camera unavailable', err);
    alert(
      "Zingo couldn't use your camera or microphone. Allow access in your browser's site settings, or choose Text instead.",
    );
    return false;
  }
  $('local-video').srcObject = localStream;
  renderMediaButtons();
  return true;
}

function stopCamera() {
  if (!localStream) return;
  for (const track of localStream.getTracks()) track.stop();
  localStream = null;
  $('local-video').srcObject = null;
}

function startPeer(initiator) {
  closePeer();
  const peer = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  pc = peer;
  for (const track of localStream.getTracks()) peer.addTrack(track, localStream);

  peer.ontrack = (e) => {
    if ($('remote-video').srcObject !== e.streams[0]) $('remote-video').srcObject = e.streams[0];
    if (remoteState === 'waiting') remoteState = 'live';
    renderRemote();
  };
  peer.onicecandidate = (e) => {
    if (e.candidate) socket.emit('signal', { candidate: e.candidate });
  };
  peer.onconnectionstatechange = () => {
    if (peer === pc && peer.connectionState === 'failed') {
      addMessage('system', "Video couldn't connect. You can keep chatting here by text.");
    }
  };

  if (initiator) {
    peer
      .createOffer()
      .then((offer) => peer.setLocalDescription(offer))
      .then(() => socket.emit('signal', { description: peer.localDescription }))
      .catch((err) => console.warn('Offer failed', err));
  }
}

function closePeer() {
  if (pc) pc.close();
  pc = null;
  $('remote-video').srcObject = null;
  remoteState = 'waiting';
}

function renderRemote() {
  const live = remoteState === 'live';
  const video = $('remote-video');
  video.classList.toggle('blurred', live && !revealed);
  video.style.visibility = live ? 'visible' : 'hidden';
  $('remote-overlay').hidden = live && revealed;
  $('reveal-btn').hidden = !(live && !revealed);
  $('remote-note').textContent = {
    waiting: {
      chatting: 'Connecting video…',
      ended: 'Press New chat to meet someone new.',
    }[state] ?? 'Looking for someone to talk to…',
    'camera-off': 'The stranger turned their camera off.',
    live: 'Their video is blurred until you choose to see it.',
  }[remoteState];
  $('blur-btn').textContent = revealed ? 'Blur' : 'Unblur';
  $('blur-btn').disabled = !live;
}

function renderMediaButtons() {
  const mic = localStream?.getAudioTracks()[0];
  const cam = localStream?.getVideoTracks()[0];
  $('mic-btn').textContent = mic?.enabled === false ? 'Unmute' : 'Mute';
  $('mic-btn').classList.toggle('off', mic?.enabled === false);
  $('cam-btn').textContent = cam?.enabled === false ? 'Camera on' : 'Camera off';
  $('cam-btn').classList.toggle('off', cam?.enabled === false);
}

$('mic-btn').onclick = () => {
  const mic = localStream?.getAudioTracks()[0];
  if (!mic) return;
  mic.enabled = !mic.enabled;
  renderMediaButtons();
};
$('cam-btn').onclick = () => {
  const cam = localStream?.getVideoTracks()[0];
  if (!cam) return;
  cam.enabled = !cam.enabled;
  socket.emit('media', { camera: cam.enabled });
  renderMediaButtons();
};
$('reveal-btn').onclick = () => {
  revealed = true;
  renderRemote();
};
$('blur-btn').onclick = () => {
  revealed = !revealed;
  renderRemote();
};

// --- Report ---
$('report-btn').onclick = () => $('report-dialog').showModal();
$('video-report-btn').onclick = () => $('report-dialog').showModal();
$('report-dialog').addEventListener('close', () => {
  if ($('report-dialog').returnValue !== 'report' || state !== 'chatting') return;
  socket.emit('report', new FormData($('report-form')).get('reason'));
  closeChat();
  setState('ended');
  addMessage('system', 'Thanks for telling us. That chat has ended.');
});

// --- Reflection ---
function openReflection() {
  for (const b of document.querySelectorAll('.moods button')) b.classList.remove('on');
  $('reflect-msg').textContent = '';
  $('reflect').showModal();
}
for (const button of document.querySelectorAll('.moods button')) {
  button.onclick = () => {
    if (button.classList.contains('on')) return;
    const mood = Number(button.dataset.mood);
    const alreadyRated = document.querySelector('.moods button.on');
    for (const b of document.querySelectorAll('.moods button')) b.classList.toggle('on', b === button);
    $('reflect-msg').textContent = MOOD_MESSAGES[mood];
    if (!alreadyRated && mood >= 3) {
      const s = stats();
      s.good += 1;
      save('stats', s);
    }
  };
}
$('again-btn').onclick = () => {
  $('reflect').close();
  startChatting();
};
$('home-btn').onclick = () => {
  $('reflect').close();
  show('home');
};

// --- Admin inbox ---
const ADMIN = {
  creators: {
    statuses: { new: 'New', contacted: 'Contacted', partnered: 'Partnered', declined: 'Declined' },
    noun: ['application', 'applications'],
  },
  suggestions: {
    statuses: { new: 'New', reviewed: 'Reviewed', archived: 'Archived' },
    noun: ['suggestion', 'suggestions'],
  },
};
const PLATFORM_LABELS = {
  tiktok: 'TikTok',
  instagram: 'Instagram',
  youtube: 'YouTube',
  twitch: 'Twitch',
  snapchat: 'Snapchat',
  x: 'X',
  other: 'Somewhere else',
};
const AUDIENCE_LABELS = {
  'under-10k': 'Under 10k',
  '10k-50k': '10k to 50k',
  '50k-250k': '50k to 250k',
  '250k-1m': '250k to 1M',
  'over-1m': 'Over 1M',
};
const KIND_LABELS = { idea: 'Idea', recommendation: 'Recommendation', problem: "Something's broken", safety: 'Safety concern' };
const adminView = { tab: 'creators', status: 'new', kind: '' };
const adminCounts = { creators: {}, suggestions: {} };

// Builds an element; strings become text nodes, so submitted content can never inject HTML.
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node[key] = value;
    else node.setAttribute(key, value);
  }
  node.append(...children.filter((child) => child != null && child !== false));
  return node;
}

const shortDate = (ms) =>
  new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const plural = (n, [one, many]) => `${n} ${n === 1 ? one : many}`;
const mailto = (email, subject) => `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}`;

function renderAdminCounts() {
  const newCreators = adminCounts.creators.new || 0;
  const newSuggestions = adminCounts.suggestions.new || 0;
  $('count-creators').textContent = newCreators || '';
  $('count-suggestions').textContent = newSuggestions || '';
  $('admin-summary').textContent =
    newCreators || newSuggestions
      ? `${plural(newCreators, ['new creator application', 'new creator applications'])} and ` +
        `${plural(newSuggestions, ['new suggestion', 'new suggestions'])} waiting.`
      : "You're all caught up: nothing new to review.";

  const { statuses } = ADMIN[adminView.tab];
  const counts = adminCounts[adminView.tab];
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  const options = [...Object.entries(statuses), ['all', 'All']];
  $('status-filter').replaceChildren(
    ...options.map(([value, label]) =>
      el(
        'button',
        {
          type: 'button',
          class: 'filter-pill',
          'aria-pressed': String(adminView.status === value),
          onclick: () => {
            adminView.status = value;
            loadAdmin();
          },
        },
        label,
        el('span', { class: 'pill-count' }, String(value === 'all' ? total : counts[value] || 0)),
      ),
    ),
  );
  $('kind-filter').hidden = adminView.tab !== 'suggestions';
  for (const tab of document.querySelectorAll('.admin-tabs [role=tab]')) {
    tab.setAttribute('aria-selected', String(tab.dataset.tab === adminView.tab));
  }
}

function statusSelect(tab, item) {
  return el(
    'label',
    { class: 'status-select' },
    'Status',
    el(
      'select',
      {
        class: 'text-input',
        onchange: async (e) => {
          const res = await api(`/admin/${tab}/${item.id}`, { status: e.target.value });
          if (!res.ok) return alert(res.error || GENERIC_ERROR);
          adminCounts[tab] = res.counts;
          renderAdminCounts();
          // Leave the list as it is, unless the item no longer belongs in the filtered view.
          if (adminView.status !== 'all' && adminView.status !== e.target.value) e.target.closest('article').remove();
          if (!$('admin-list').children.length) renderAdminEmpty();
        },
      },
      ...Object.entries(ADMIN[tab].statuses).map(([value, label]) => {
        const option = el('option', { value }, label);
        option.selected = value === item.status;
        return option;
      }),
    ),
  );
}

function creatorItem(app) {
  const meta = [
    PLATFORM_LABELS[app.platform] ?? app.platform,
    app.handle,
    AUDIENCE_LABELS[app.audience] ?? app.audience,
    countryName(app.country),
    app.has_account ? 'Has a Zingo account' : null,
  ].filter(Boolean);
  return el(
    'article',
    { class: 'inbox-item' },
    el(
      'div',
      { class: 'item-top' },
      el('div', {}, el('h3', {}, app.name), el('p', { class: 'item-meta' }, meta.join(' · '))),
      el('time', { datetime: new Date(app.created_at).toISOString() }, shortDate(app.created_at)),
    ),
    el('p', { class: 'item-body' }, app.pitch),
    el(
      'div',
      { class: 'item-actions' },
      el('a', { class: 'btn primary', href: mailto(app.email, 'Your Zingo creator application') }, `Reply to ${app.email}`),
      statusSelect('creators', app),
    ),
  );
}

function suggestionItem(s) {
  const replyTo = s.contact || s.account_email;
  const from = s.account_email || s.account_phone
    ? `From a Zingo account: ${s.account_email || s.account_phone}`
    : s.contact
      ? `From a visitor: ${s.contact}`
      : 'Anonymous, no way to reply';
  return el(
    'article',
    { class: 'inbox-item' + (s.kind === 'safety' ? ' safety' : '') },
    el(
      'div',
      { class: 'item-top' },
      el('span', { class: `kind-pill kind-${s.kind}` }, KIND_LABELS[s.kind] ?? s.kind),
      el('time', { datetime: new Date(s.created_at).toISOString() }, shortDate(s.created_at)),
    ),
    el('p', { class: 'item-body' }, s.message),
    el('p', { class: 'item-meta' }, from),
    el(
      'div',
      { class: 'item-actions' },
      replyTo && el('a', { class: 'btn primary', href: mailto(replyTo, 'About your Zingo suggestion') }, 'Reply by email'),
      statusSelect('suggestions', s),
    ),
  );
}

function renderAdminEmpty() {
  const { statuses, noun } = ADMIN[adminView.tab];
  const label = adminView.status === 'all' ? '' : `${statuses[adminView.status].toLowerCase()} `;
  $('admin-list').replaceChildren(el('p', { class: 'admin-empty' }, `No ${label}${noun[1]} right now.`));
}

let adminRequest = 0;
async function loadAdmin() {
  const request = ++adminRequest;
  const status = adminView.status === 'all' ? '' : adminView.status;
  const kind = adminView.tab === 'suggestions' ? adminView.kind : '';
  const other = adminView.tab === 'creators' ? 'suggestions' : 'creators';
  const [current, counts] = await Promise.all([
    api(`/admin/${adminView.tab}?status=${status}&kind=${kind}`),
    api(`/admin/${other}?status=new`),
  ]);
  if (request !== adminRequest) return; // a newer load has started
  if (!current.ok) {
    $('admin-list').replaceChildren(el('p', { class: 'admin-empty' }, current.error || GENERIC_ERROR));
    return;
  }
  adminCounts[adminView.tab] = current.counts;
  if (counts.ok) adminCounts[other] = counts.counts;
  renderAdminCounts();
  if (!current.items.length) return renderAdminEmpty();
  const renderItem = adminView.tab === 'creators' ? creatorItem : suggestionItem;
  $('admin-list').replaceChildren(...current.items.map(renderItem));
}

for (const tab of document.querySelectorAll('.admin-tabs [role=tab]')) {
  tab.onclick = () => {
    adminView.tab = tab.dataset.tab;
    adminView.status = 'new';
    loadAdmin();
  };
}
$('kind-filter').onchange = (e) => {
  adminView.kind = e.target.value;
  loadAdmin();
};
$('admin-refresh').onclick = loadAdmin;

// --- Server events ---
socket.on('online', (n) => {
  $('online').textContent = `${n} ${n === 1 ? 'person' : 'people'} here now`;
});
socket.on('waiting', () => setState('waiting'));
socket.on('matched', ({ shared, icebreaker, initiator, partner }) => {
  $('messages').replaceChildren();
  chat = { startedAt: Date.now(), sent: 0, received: 0 };
  revealed = !blurNewVideo;
  setState('chatting');
  $('status-text').textContent = `Talking with ${describePartner(partner)}`;
  if (mode === 'video' && localStream) {
    startPeer(initiator);
    const cam = localStream.getVideoTracks()[0];
    if (cam && !cam.enabled) socket.emit('media', { camera: false });
  }
  addMessage(
    'system',
    shared.length
      ? `You're now talking with a stranger. You both like ${shared.join(', ')}.`
      : "You're now talking with a stranger. Say hi!",
  );
  addMessage('prompt', `Need an opener? ${icebreaker}`);
  if (mode === 'text') $('msg').focus();
});
socket.on('signal', (data) => {
  const peer = pc;
  if (!peer) return;
  // Apply signals strictly in order; each step depends on the previous one.
  signalChain = signalChain
    .then(async () => {
      if (peer !== pc) return;
      if (data.description) {
        await peer.setRemoteDescription(data.description);
        if (data.description.type === 'offer') {
          await peer.setLocalDescription(await peer.createAnswer());
          socket.emit('signal', { description: peer.localDescription });
        }
      } else if (data.candidate) {
        await peer.addIceCandidate(data.candidate);
      }
    })
    .catch((err) => console.warn('Signal failed', err));
});
socket.on('media', ({ camera }) => {
  if (state !== 'chatting') return;
  remoteState = camera ? ($('remote-video').srcObject ? 'live' : 'waiting') : 'camera-off';
  renderRemote();
});
socket.on('message', ({ from, text }) => {
  if (!chat) return;
  if (from === 'you') chat.sent += 1;
  else {
    chat.received += 1;
    $('typing').hidden = true;
  }
  addMessage(from, text);
});
socket.on('typing', (on) => {
  if (state === 'chatting') $('typing').hidden = !on;
});
socket.on('icebreaker', (text) => addMessage('prompt', `Icebreaker: ${text}`));
socket.on('slow_down', () => addMessage('system', 'Slow down a little, there is no rush.'));
socket.on('partner_left', () => {
  if (state !== 'chatting') return;
  const real = closeChat();
  setState('ended');
  addMessage('system', 'The stranger left the chat.');
  if (real) openReflection();
});
socket.on('blocked', (status) => {
  closeChat();
  setState('idle');
  route({ ...user, blocked: status });
});
socket.on('connect_error', (err) => {
  // Account problems are re-checked through the API; other errors retry automatically.
  if (['unauthorized', 'profile_incomplete', 'blocked'].includes(err.message)) boot();
});
socket.on('disconnect', () => {
  if (state !== 'chatting' && state !== 'waiting') return;
  closeChat();
  setState('ended');
  addMessage('system', 'Connection lost. Press New chat to try again.');
});

fillCountries();
fillDialCodes();
renderMethod();
renderChips();
renderStats();
renderMode();
boot();
