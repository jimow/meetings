'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const config = require('../config');
const auth = require('../auth');
const { randomId, clientIp, audit } = require('../util');
const { isEmail, asString } = require('../validate');

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_attempts' },
});

const LOCK_THRESHOLD = 8;
const LOCK_MS = 15 * 60 * 1000;

function adminCount() {
  return db.prepare('SELECT COUNT(*) AS n FROM admins').get().n;
}

// --- Registration --------------------------------------------------------
// First admin can self-register (bootstrap). After that, only an authenticated
// admin may create more (unless ALLOW_OPEN_REGISTRATION=true).
router.post('/register', loginLimiter, async (req, res) => {
  const hasAdmins = adminCount() > 0;
  if (hasAdmins && !config.allowOpenRegistration && !req.admin) {
    return res.status(403).json({ error: 'registration_closed' });
  }

  const email = asString(req.body?.email, 200).trim().toLowerCase();
  const name = asString(req.body?.name, 120).trim();
  const password = asString(req.body?.password, 200);

  if (!isEmail(email)) return res.status(400).json({ error: 'invalid_email' });
  if (password.length < 10) return res.status(400).json({ error: 'weak_password', detail: 'Use at least 10 characters.' });

  const exists = db.prepare('SELECT 1 FROM admins WHERE email = ?').get(email);
  if (exists) return res.status(409).json({ error: 'email_in_use' });

  const id = randomId();
  const passwordHash = await auth.hashPassword(password);
  const role = hasAdmins ? 'admin' : 'owner';
  db.prepare(
    'INSERT INTO admins (id, email, password_hash, name, role, created_at) VALUES (?,?,?,?,?,?)'
  ).run(id, email, passwordHash, name, role, Date.now());

  audit('admin.register', { actor: req.admin?.id || id, target: id, ip: clientIp(req), detail: { email, role } });

  // Auto-login the bootstrap admin.
  if (!hasAdmins) {
    const { sid, csrf } = auth.createSession(id, req);
    auth.setSessionCookie(res, req, sid);
    return res.status(201).json({ admin: { id, email, name, role }, csrfToken: csrf });
  }
  res.status(201).json({ admin: { id, email, name, role } });
});

// --- Login ---------------------------------------------------------------
router.post('/login', loginLimiter, async (req, res) => {
  const email = asString(req.body?.email, 200).trim().toLowerCase();
  const password = asString(req.body?.password, 200);

  const admin = db.prepare('SELECT * FROM admins WHERE email = ?').get(email);

  // Always run a hash comparison to reduce user-enumeration timing signal.
  const hash = admin?.password_hash || '$2a$12$0000000000000000000000000000000000000000000000000000a';

  if (admin && admin.locked_until && admin.locked_until > Date.now()) {
    return res.status(429).json({ error: 'account_locked', detail: 'Too many failed attempts. Try again later.' });
  }

  const ok = await auth.verifyPassword(password, hash);
  if (!admin || !ok) {
    if (admin) {
      const failed = admin.failed_logins + 1;
      const lockedUntil = failed >= LOCK_THRESHOLD ? Date.now() + LOCK_MS : null;
      db.prepare('UPDATE admins SET failed_logins = ?, locked_until = ? WHERE id = ?')
        .run(failed >= LOCK_THRESHOLD ? 0 : failed, lockedUntil, admin.id);
    }
    audit('admin.login_failed', { target: email, ip: clientIp(req) });
    return res.status(401).json({ error: 'invalid_credentials' });
  }

  db.prepare('UPDATE admins SET failed_logins = 0, locked_until = NULL WHERE id = ?').run(admin.id);
  const { sid, csrf } = auth.createSession(admin.id, req);
  auth.setSessionCookie(res, req, sid);
  audit('admin.login', { actor: admin.id, ip: clientIp(req) });
  res.json({ admin: { id: admin.id, email: admin.email, name: admin.name, role: admin.role }, csrfToken: csrf });
});

// --- Logout --------------------------------------------------------------
router.post('/logout', (req, res) => {
  if (req.session) {
    auth.destroySession(req.session.id);
    audit('admin.logout', { actor: req.admin?.id, ip: clientIp(req) });
  }
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});

// --- Current user + CSRF token + bootstrap state ------------------------
router.get('/me', (req, res) => {
  if (!req.admin) {
    return res.json({ admin: null, needsBootstrap: adminCount() === 0 });
  }
  res.json({ admin: req.admin, csrfToken: req.session.csrf_token });
});

// --- Active sessions management (security feature) -----------------------
router.get('/sessions', auth.requireAdmin, (req, res) => {
  const rows = db.prepare(
    'SELECT id, created_at, expires_at, ip, user_agent FROM sessions WHERE admin_id = ? ORDER BY created_at DESC'
  ).all(req.admin.id);
  res.json({ sessions: rows.map((r) => ({ ...r, current: r.id === req.session.id })) });
});

router.delete('/sessions/:id', auth.requireAdmin, auth.requireCsrf, (req, res) => {
  const row = db.prepare('SELECT id FROM sessions WHERE id = ? AND admin_id = ?').get(req.params.id, req.admin.id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  auth.destroySession(row.id);
  res.json({ ok: true });
});

module.exports = router;
