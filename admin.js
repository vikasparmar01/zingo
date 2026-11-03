// Admin inbox for creator applications and suggestions.
// Only accounts with users.is_admin = 1 can use it; grant it with `node scripts/make-admin.js <email or phone>`.
const express = require('express');
const db = require('./db');
const auth = require('./auth');

const CREATOR_STATUSES = ['new', 'contacted', 'partnered', 'declined'];
const SUGGESTION_STATUSES = ['new', 'reviewed', 'archived'];
const SUGGESTION_KINDS = ['idea', 'recommendation', 'problem', 'safety'];

function requireAdmin(req, res, next) {
  const user = auth.userFromCookieHeader(req.headers.cookie);
  if (!user) return res.status(401).json({ error: 'Please sign in.' });
  if (!user.is_admin) return res.status(403).json({ error: 'This page is for Zingo admins only.' });
  req.user = user;
  next();
}

const router = express.Router();
router.use('/admin', express.json({ limit: '1kb' }), requireAdmin);

router.get('/admin/creators', (req, res) => {
  const status = CREATOR_STATUSES.includes(req.query.status) ? req.query.status : null;
  res.json({ items: db.listCreatorApplications(status), counts: db.creatorStatusCounts() });
});

router.post('/admin/creators/:id', (req, res) => {
  const { status } = req.body || {};
  if (!CREATOR_STATUSES.includes(status)) return res.status(400).json({ error: 'Unknown status.' });
  if (!db.setCreatorStatus(Number(req.params.id), status)) return res.status(404).json({ error: 'Not found.' });
  console.log(`[admin] user=${req.user.id} set creator application ${req.params.id} to ${status}`);
  res.json({ ok: true, counts: db.creatorStatusCounts() });
});

router.get('/admin/suggestions', (req, res) => {
  const status = SUGGESTION_STATUSES.includes(req.query.status) ? req.query.status : null;
  const kind = SUGGESTION_KINDS.includes(req.query.kind) ? req.query.kind : null;
  res.json({ items: db.listSuggestions(status, kind), counts: db.suggestionStatusCounts() });
});

router.post('/admin/suggestions/:id', (req, res) => {
  const { status } = req.body || {};
  if (!SUGGESTION_STATUSES.includes(status)) return res.status(400).json({ error: 'Unknown status.' });
  if (!db.setSuggestionStatus(Number(req.params.id), status)) return res.status(404).json({ error: 'Not found.' });
  console.log(`[admin] user=${req.user.id} set suggestion ${req.params.id} to ${status}`);
  res.json({ ok: true, counts: db.suggestionStatusCounts() });
});

module.exports = { router };
