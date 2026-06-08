'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('./db');
const config = require('./config');
const { randomId, safeEqual, clientIp } = require('./util');

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

function createSession(adminId, req) {
  const sid = randomId(24);
  const csrf = randomId(24);
  const now = Date.now();
  db.prepare(
    'INSERT INTO sessions (id, admin_id, csrf_token, expires_at, created_at, ip, user_agent) VALUES (?,?,?,?,?,?,?)'
  ).run(sid, adminId, csrf, now + config.sessionTtlMs, now, clientIp(req), (req.get('user-agent') || '').slice(0, 300));
  return { sid, csrf };
}

function destroySession(sid) {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sid);
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
function loadSession(req, res, next) {
  req.admin = null;
  req.session = null;
  const signed = req.cookies?.[COOKIE_NAME];
  const sid = unsignSid(signed);
  if (!sid) return next();

  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sid);
  if (!session) return next();
  if (session.expires_at < Date.now()) {
    destroySession(sid);
    return next();
  }
  const admin = db.prepare('SELECT id, email, name, role FROM admins WHERE id = ?').get(session.admin_id);
  if (!admin) return next();

  req.admin = admin;
  req.session = session;
  next();
}

function requireAdmin(req, res, next) {
  if (!req.admin) return res.status(401).json({ error: 'authentication_required' });
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

function cleanupExpiredSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
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
  requireCsrf,
  cleanupExpiredSessions,
};
