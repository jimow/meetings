'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const store = require('./store');
const config = require('./config');
const { randomId, safeEqual, clientIp, isAdmin } = require('./util');

const COOKIE_NAME = 'msid';
const BCRYPT_ROUNDS = 12;

function hashPassword(plain) {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}
function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

// HMAC-sign the session id so a stolen DB id alone can't be used as a cookie,
// and tampering is detectable.
function signSid(sid) {
  const mac = crypto.createHmac('sha256', config.sessionSecret).update(sid).digest('base64url');
  return `${sid}.${mac}`;
}
function unsignSid(signed) {
  if (typeof signed !== 'string') return null;
  const dot = signed.lastIndexOf('.');
  if (dot === -1) return null;
  const sid = signed.slice(0, dot);
  const mac = signed.slice(dot + 1);
  const expected = crypto.createHmac('sha256', config.sessionSecret).update(sid).digest('base64url');
  return safeEqual(mac, expected) ? sid : null;
}

async function createSession(adminId, req) {
  const sid = randomId(24);
  const csrf = randomId(24);
  const now = Date.now();
  await store.createSession({
    id: sid, admin_id: adminId, csrf_token: csrf,
    expires_at: now + config.sessionTtlMs, created_at: now,
    ip: clientIp(req), user_agent: (req.get('user-agent') || '').slice(0, 300),
  });
  return { sid, csrf };
}

async function destroySession(sid) {
  await store.deleteSession(sid);
}

function setSessionCookie(res, req, sid) {
  const secure = config.forceSecureCookies || req.secure || req.get('x-forwarded-proto') === 'https';
  res.cookie(COOKIE_NAME, signSid(sid), {
    httpOnly: true,
    secure,
    sameSite: 'strict',
    maxAge: config.sessionTtlMs,
    path: '/',
  });
}
function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

// Populates req.admin + req.session if a valid session cookie is present.
async function loadSession(req, res, next) {
  req.admin = null;
  req.session = null;
  try {
    const signed = req.cookies?.[COOKIE_NAME];
    const sid = unsignSid(signed);
    if (!sid) return next();

    const session = await store.getSession(sid);
    if (!session) return next();
    if (session.expires_at < Date.now()) {
      await destroySession(sid);
      return next();
    }
    const admin = await store.getAdminById(session.admin_id);
    if (!admin) return next();

    req.admin = admin;
    req.session = session;
    next();
  } catch (e) {
    next(e);
  }
}

function requireAdmin(req, res, next) {
  if (!req.admin) return res.status(401).json({ error: 'authentication_required' });
  next();
}

// Super-admin only (role admin/owner) — sees all data + manages users.
function requireSuperAdmin(req, res, next) {
  if (!req.admin) return res.status(401).json({ error: 'authentication_required' });
  if (!isAdmin(req.admin)) return res.status(403).json({ error: 'admin_only' });
  next();
}

// Double-submit CSRF: state-changing admin requests must echo the session's
// CSRF token in the X-CSRF-Token header. The token is only obtainable by the
// authenticated client (via /api/auth/me), and the cookie is SameSite=strict.
function requireCsrf(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (!req.session) return res.status(401).json({ error: 'authentication_required' });
  const token = req.get('x-csrf-token');
  if (!token || !safeEqual(token, req.session.csrf_token)) {
    return res.status(403).json({ error: 'invalid_csrf_token' });
  }
  next();
}

async function cleanupExpiredSessions() {
  await store.deleteExpiredSessions(Date.now());
}

module.exports = {
  COOKIE_NAME,
  hashPassword,
  verifyPassword,
  createSession,
  destroySession,
  setSessionCookie,
  clearSessionCookie,
  loadSession,
  requireAdmin,
  requireSuperAdmin,
  requireCsrf,
  cleanupExpiredSessions,
};
