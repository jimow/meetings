'use strict';

const crypto = require('crypto');
const store = require('./store');
const config = require('./config');

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

async function uniqueSlug() {
  for (let i = 0; i < 10; i++) {
    const slug = randomSlug();
    if (!(await store.slugExists(slug))) return slug;
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

// Public origin for share links / QR codes.
//  - If BASE_URL is explicitly configured, always use it (authoritative).
//  - Otherwise derive from the incoming request: real domain + scheme, honoring
//    the reverse proxy (X-Forwarded-Proto/Host via Express 'trust proxy').
// This means a deployed instance produces links on its actual domain, while
// local runs produce localhost links — automatically.
function publicBaseUrl(req) {
  if (config.explicitBaseUrl) return config.explicitBaseUrl;
  if (req) {
    const host = req.get('x-forwarded-host') || req.get('host');
    if (host) {
      const proto = (req.get('x-forwarded-proto') || req.protocol || 'http').split(',')[0].trim();
      return `${proto}://${host}`.replace(/\/$/, '');
    }
  }
  return config.baseUrl;
}

function audit(action, { actor = null, target = null, detail = null, ip = null } = {}) {
  // Fire-and-forget: auditing must never block or break a request.
  Promise.resolve(store.insertAudit({
    id: randomId(), actor, action, target,
    detail: detail == null || typeof detail === 'string' ? detail : JSON.stringify(detail),
    ip, created_at: Date.now(),
  })).catch(() => {});
}

module.exports = { randomId, randomSlug, uniqueSlug, safeEqual, clientIp, publicBaseUrl, audit };
