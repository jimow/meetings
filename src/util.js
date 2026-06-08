'use strict';

const crypto = require('crypto');
const db = require('./db');

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

// URL-safe random id (default 16 chars ~ 95 bits of entropy).
function randomId(len = 16) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

// Shorter, lowercase, less-ambiguous slug for shareable links.
const SLUG_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';
function randomSlug(len = 7) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += SLUG_ALPHABET[bytes[i] % SLUG_ALPHABET.length];
  return out;
}

function uniqueSlug() {
  for (let i = 0; i < 10; i++) {
    const slug = randomSlug();
    const exists = db.prepare('SELECT 1 FROM meetings WHERE slug = ?').get(slug);
    if (!exists) return slug;
  }
  // Fall back to longer slug on the astronomically unlikely repeated collision.
  return randomSlug(12);
}

// Constant-time string comparison.
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function clientIp(req) {
  // Trust X-Forwarded-For only when behind a known proxy (app.set('trust proxy')).
  return req.ip || req.connection?.remoteAddress || null;
}

function audit(action, { actor = null, target = null, detail = null, ip = null } = {}) {
  try {
    db.prepare(
      'INSERT INTO audit_log (id, actor, action, target, detail, ip, created_at) VALUES (?,?,?,?,?,?,?)'
    ).run(randomId(), actor, action, target, typeof detail === 'string' ? detail : JSON.stringify(detail), ip, Date.now());
  } catch { /* never let auditing break a request */ }
}

module.exports = { randomId, randomSlug, uniqueSlug, safeEqual, clientIp, audit };
