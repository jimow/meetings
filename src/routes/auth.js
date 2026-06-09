'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const store = require('../store');
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

// Wrap async handlers so rejections hit the Express error handler.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// --- Registration --------------------------------------------------------
router.post('/register', loginLimiter, wrap(async (req, res) => {
  const adminCount = await store.countAdmins();
  const hasAdmins = adminCount > 0;
  if (hasAdmins && !config.allowOpenRegistration && !req.admin) {
    return res.status(403).json({ error: 'registration_closed' });
  }

  const email = asString(req.body?.email, 200).trim().toLowerCase();
  const name = asString(req.body?.name, 120).trim();
  const password = asString(req.body?.password, 200);

  if (!isEmail(email)) return res.status(400).json({ error: 'invalid_email' });
  if (password.length < 10) return res.status(400).json({ error: 'weak_password', detail: 'Use at least 10 characters.' });

  if (await store.getAdminByEmail(email)) return res.status(409).json({ error: 'email_in_use' });

  const id = randomId();
  const passwordHash = await auth.hashPassword(password);
  // First account ever = super-admin (sees all). Everyone else = standard user.
  const role = hasAdmins ? 'user' : 'admin';
  await store.createAdmin({ id, email, password_hash: passwordHash, name, role, created_at: Date.now() });

  // Seed every new account with the County's default header/branding so their
  // sign-in sheets carry the official letterhead by default (they can edit it).
  try {
    await store.upsertBrandingText(id, {
      org_name: process.env.ORG_NAME || 'County Government of Mandera',
      address: process.env.ORG_ADDRESS || 'P.O. Box 13-70300, Mandera, Kenya',
      contact: process.env.ORG_CONTACT || 'info@mandera.go.ke',
      footer_text: process.env.ORG_FOOTER || 'County Government of Mandera · Official attendance record',
      updated_at: Date.now(),
    });
  } catch { /* non-fatal */ }

  audit('admin.register', { actor: req.admin?.id || id, target: id, ip: clientIp(req), detail: { email, role } });

  if (!hasAdmins) {
    const { sid, csrf } = await auth.createSession(id, req);
    auth.setSessionCookie(res, req, sid);
    return res.status(201).json({ admin: { id, email, name, role }, csrfToken: csrf });
  }
  res.status(201).json({ admin: { id, email, name, role } });
}));

// --- Login ---------------------------------------------------------------
router.post('/login', loginLimiter, wrap(async (req, res) => {
  const email = asString(req.body?.email, 200).trim().toLowerCase();
  const password = asString(req.body?.password, 200);

  const admin = await store.getAdminByEmail(email);
  const hash = admin?.password_hash || '$2a$12$0000000000000000000000000000000000000000000000000000a';

  if (admin && admin.locked_until && admin.locked_until > Date.now()) {
    return res.status(429).json({ error: 'account_locked', detail: 'Too many failed attempts. Try again later.' });
  }

  const ok = await auth.verifyPassword(password, hash);
  if (!admin || !ok) {
    if (admin) {
      const failed = admin.failed_logins + 1;
      const lockedUntil = failed >= LOCK_THRESHOLD ? Date.now() + LOCK_MS : null;
      await store.setAdminLock(admin.id, failed >= LOCK_THRESHOLD ? 0 : failed, lockedUntil);
    }
    audit('admin.login_failed', { target: email, ip: clientIp(req) });
    return res.status(401).json({ error: 'invalid_credentials' });
  }

  await store.resetAdminLock(admin.id);
  const { sid, csrf } = await auth.createSession(admin.id, req);
  auth.setSessionCookie(res, req, sid);
  audit('admin.login', { actor: admin.id, ip: clientIp(req) });
  res.json({ admin: { id: admin.id, email: admin.email, name: admin.name, role: admin.role }, csrfToken: csrf });
}));

// --- Logout --------------------------------------------------------------
router.post('/logout', wrap(async (req, res) => {
  if (req.session) {
    await auth.destroySession(req.session.id);
    audit('admin.logout', { actor: req.admin?.id, ip: clientIp(req) });
  }
  auth.clearSessionCookie(res);
  res.json({ ok: true });
}));

// --- Current user + CSRF token + bootstrap state ------------------------
router.get('/me', wrap(async (req, res) => {
  if (!req.admin) {
    return res.json({
      admin: null,
      needsBootstrap: (await store.countAdmins()) === 0,
      openRegistration: config.allowOpenRegistration,
    });
  }
  res.json({ admin: req.admin, csrfToken: req.session.csrf_token });
}));

// --- Active sessions management (security feature) -----------------------
router.get('/sessions', auth.requireAdmin, wrap(async (req, res) => {
  const rows = await store.listSessions(req.admin.id);
  res.json({ sessions: rows.map((r) => ({ ...r, current: r.id === req.session.id })) });
}));

router.delete('/sessions/:id', auth.requireAdmin, auth.requireCsrf, wrap(async (req, res) => {
  const row = await store.getSessionForAdmin(req.params.id, req.admin.id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  await auth.destroySession(row.id);
  res.json({ ok: true });
}));

module.exports = router;
