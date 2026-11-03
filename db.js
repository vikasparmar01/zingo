const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'zingo.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    email TEXT UNIQUE,         -- lowercase
    phone TEXT UNIQUE,         -- E.164, e.g. +447400123456
    password_hash TEXT,        -- scrypt, see auth.js
    birthdate TEXT,            -- YYYY-MM-DD, set once and never changed
    gender TEXT,
    country TEXT,              -- ISO 3166 alpha-2
    blocked_reason TEXT,       -- 'underage' | 'age_review'; blocks the account until cleared by a person
    banned_until INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    CHECK (email IS NOT NULL OR phone IS NOT NULL)
  );

  -- One active code per email or phone number and purpose. Only a hash of the code is stored.
  CREATE TABLE IF NOT EXISTS verification_codes (
    identifier TEXT NOT NULL,
    purpose TEXT NOT NULL,     -- 'signup' | 'reset'
    code_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    sent_at INTEGER NOT NULL,
    PRIMARY KEY (identifier, purpose)
  );

  -- Only a hash of the session token is stored, so a leaked database can't be used to sign in.
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );

  -- Each person can report another person once, so one angry user can't get someone banned alone.
  CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY,
    reporter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reported_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reason TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (reporter_id, reported_id)
  );

  CREATE TABLE IF NOT EXISTS creator_applications (
    id INTEGER PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    platform TEXT NOT NULL,
    handle TEXT NOT NULL,
    audience TEXT NOT NULL,
    country TEXT NOT NULL,
    pitch TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS suggestions (
    id INTEGER PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    kind TEXT NOT NULL,        -- 'idea' | 'recommendation' | 'problem' | 'safety'
    message TEXT NOT NULL,
    contact TEXT,              -- optional email from signed-out visitors
    created_at INTEGER NOT NULL
  );
`);

// Columns added after the first release. Each is added once to databases that predate it.
function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
ensureColumn('users', 'is_admin', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('creator_applications', 'status', "TEXT NOT NULL DEFAULT 'new'"); // new | contacted | partnered | declined
ensureColumn('suggestions', 'status', "TEXT NOT NULL DEFAULT 'new'"); // new | reviewed | archived

const q = {
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),
  userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  userByPhone: db.prepare('SELECT * FROM users WHERE phone = ?'),
  insertUser: db.prepare('INSERT INTO users (email, phone, password_hash, created_at) VALUES (?, ?, ?, ?)'),
  setPassword: db.prepare('UPDATE users SET password_hash = ? WHERE id = ?'),
  setProfile: db.prepare('UPDATE users SET birthdate = ?, gender = ?, country = ? WHERE id = ?'),
  blockUser: db.prepare('UPDATE users SET blocked_reason = ? WHERE id = ?'),
  banUntil: db.prepare('UPDATE users SET banned_until = ? WHERE id = ?'),

  getCode: db.prepare('SELECT * FROM verification_codes WHERE identifier = ? AND purpose = ?'),
  saveCode: db.prepare(
    `INSERT INTO verification_codes (identifier, purpose, code_hash, expires_at, attempts, sent_at)
     VALUES (?, ?, ?, ?, 0, ?)
     ON CONFLICT (identifier, purpose) DO UPDATE SET code_hash = excluded.code_hash,
       expires_at = excluded.expires_at, attempts = 0, sent_at = excluded.sent_at`,
  ),
  bumpCode: db.prepare('UPDATE verification_codes SET attempts = attempts + 1 WHERE identifier = ? AND purpose = ?'),
  deleteCode: db.prepare('DELETE FROM verification_codes WHERE identifier = ? AND purpose = ?'),

  insertSession: db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)'),
  sessionUser: db.prepare(
    'SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id WHERE token_hash = ? AND expires_at > ?',
  ),
  deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
  deleteUserSessions: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
  pruneSessions: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),

  insertReport: db.prepare(
    'INSERT OR IGNORE INTO reports (reporter_id, reported_id, reason, created_at) VALUES (?, ?, ?, ?)',
  ),
  reportersSince: db.prepare(
    'SELECT COUNT(DISTINCT reporter_id) AS n FROM reports WHERE reported_id = ? AND created_at > ?',
  ),
  reportersForReason: db.prepare(
    'SELECT COUNT(DISTINCT reporter_id) AS n FROM reports WHERE reported_id = ? AND reason = ?',
  ),

  insertCreatorApplication: db.prepare(
    `INSERT INTO creator_applications (user_id, name, email, platform, handle, audience, country, pitch, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ),
  insertSuggestion: db.prepare(
    'INSERT INTO suggestions (user_id, kind, message, contact, created_at) VALUES (?, ?, ?, ?, ?)',
  ),

  setAdmin: db.prepare('UPDATE users SET is_admin = ? WHERE id = ?'),
  listCreatorApplications: db.prepare(
    `SELECT id, name, email, platform, handle, audience, country, pitch, status, created_at,
       user_id IS NOT NULL AS has_account
     FROM creator_applications WHERE (? IS NULL OR status = ?) ORDER BY created_at DESC LIMIT 200`,
  ),
  creatorStatusCounts: db.prepare('SELECT status, COUNT(*) AS n FROM creator_applications GROUP BY status'),
  setCreatorStatus: db.prepare('UPDATE creator_applications SET status = ? WHERE id = ?'),
  // Safety concerns come first: they may need action today.
  listSuggestions: db.prepare(
    `SELECT s.id, s.kind, s.message, s.contact, s.status, s.created_at, u.email AS account_email, u.phone AS account_phone
     FROM suggestions s LEFT JOIN users u ON u.id = s.user_id
     WHERE (? IS NULL OR s.status = ?) AND (? IS NULL OR s.kind = ?)
     ORDER BY s.kind = 'safety' DESC, s.created_at DESC LIMIT 200`,
  ),
  suggestionStatusCounts: db.prepare('SELECT status, COUNT(*) AS n FROM suggestions GROUP BY status'),
  setSuggestionStatus: db.prepare('UPDATE suggestions SET status = ? WHERE id = ?'),
};

const countsByStatus = (rows) => Object.fromEntries(rows.map((r) => [r.status, r.n]));

// An identifier is { kind: 'email' | 'phone', value } with the value already normalised.
module.exports = {
  userById: (id) => q.userById.get(id),
  userByIdentifier: ({ kind, value }) => (kind === 'email' ? q.userByEmail : q.userByPhone).get(value),
  createUser({ kind, value }, passwordHash, now) {
    const email = kind === 'email' ? value : null;
    const phone = kind === 'phone' ? value : null;
    return q.userById.get(q.insertUser.run(email, phone, passwordHash, now).lastInsertRowid);
  },
  setPassword: (id, passwordHash) => q.setPassword.run(passwordHash, id),
  setProfile: (id, { birthdate, gender, country }) => q.setProfile.run(birthdate, gender, country, id),
  blockUser: (id, reason) => q.blockUser.run(reason, id),
  banUntil: (id, until) => q.banUntil.run(until, id),

  getCode: (identifier, purpose) => q.getCode.get(identifier, purpose),
  saveCode: (identifier, purpose, codeHash, expiresAt, sentAt) =>
    q.saveCode.run(identifier, purpose, codeHash, expiresAt, sentAt),
  bumpCodeAttempts: (identifier, purpose) => q.bumpCode.run(identifier, purpose),
  deleteCode: (identifier, purpose) => q.deleteCode.run(identifier, purpose),

  createSession: (tokenHash, userId, expiresAt) => q.insertSession.run(tokenHash, userId, expiresAt),
  userForSession: (tokenHash) => q.sessionUser.get(tokenHash, Date.now()),
  deleteSession: (tokenHash) => q.deleteSession.run(tokenHash),
  deleteUserSessions: (userId) => q.deleteUserSessions.run(userId),
  pruneSessions: () => q.pruneSessions.run(Date.now()),

  addReport: (reporterId, reportedId, reason, now) => q.insertReport.run(reporterId, reportedId, reason, now),
  distinctReportersSince: (userId, since) => q.reportersSince.get(userId, since).n,
  distinctReportersForReason: (userId, reason) => q.reportersForReason.get(userId, reason).n,

  addCreatorApplication: (a) =>
    q.insertCreatorApplication.run(a.userId, a.name, a.email, a.platform, a.handle, a.audience, a.country, a.pitch, a.now),
  addSuggestion: (s) => q.insertSuggestion.run(s.userId, s.kind, s.message, s.contact, s.now),

  setAdmin: (id, isAdmin) => q.setAdmin.run(isAdmin ? 1 : 0, id),
  listCreatorApplications: (status = null) => q.listCreatorApplications.all(status, status).map((r) => ({ ...r })),
  creatorStatusCounts: () => countsByStatus(q.creatorStatusCounts.all()),
  setCreatorStatus: (id, status) => q.setCreatorStatus.run(status, id).changes,
  listSuggestions: (status = null, kind = null) =>
    q.listSuggestions.all(status, status, kind, kind).map((r) => ({ ...r })),
  suggestionStatusCounts: () => countsByStatus(q.suggestionStatusCounts.all()),
  setSuggestionStatus: (id, status) => q.setSuggestionStatus.run(status, id).changes,
};
