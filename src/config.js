'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// --- Minimal .env loader (no dependency) ---------------------------------
function loadDotEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadDotEnv();

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// --- Persistent secrets (auto-generated on first run) --------------------
// Secrets are persisted so sessions survive restarts. They live outside the
// DB and are gitignored. Override via env in production.
const SECRETS_PATH = path.join(DATA_DIR, 'secrets.json');
function loadOrCreateSecrets() {
  let secrets = {};
  if (fs.existsSync(SECRETS_PATH)) {
    try { secrets = JSON.parse(fs.readFileSync(SECRETS_PATH, 'utf8')); } catch { secrets = {}; }
  }
  let changed = false;
  if (!secrets.sessionSecret) { secrets.sessionSecret = crypto.randomBytes(48).toString('hex'); changed = true; }
  if (changed) fs.writeFileSync(SECRETS_PATH, JSON.stringify(secrets, null, 2), { mode: 0o600 });
  return secrets;
}
const secrets = loadOrCreateSecrets();

const PORT = parseInt(process.env.PORT || '3000', 10);
// An explicit BASE_URL always wins (recommended for production). When it is NOT
// set, share links/QR codes are derived per-request from the actual domain the
// request arrived on — so a deployed instance uses its real domain, not localhost.
const explicitBaseUrl = process.env.BASE_URL ? process.env.BASE_URL.replace(/\/$/, '') : null;

const config = {
  port: PORT,
  // Static fallback used for startup logs and contexts without a request.
  baseUrl: explicitBaseUrl || `http://localhost:${PORT}`,
  // null unless BASE_URL was explicitly provided.
  explicitBaseUrl,
  dataDir: DATA_DIR,
  sessionSecret: process.env.SESSION_SECRET || secrets.sessionSecret,
  // Session lifetime for admins.
  sessionTtlMs: parseInt(process.env.SESSION_TTL_HOURS || '12', 10) * 60 * 60 * 1000,
  // Cookies marked Secure only when served over https. Auto-detected per request,
  // but this forces it on if you terminate TLS upstream.
  forceSecureCookies: process.env.FORCE_SECURE_COOKIES === 'true',
  isProd: process.env.NODE_ENV === 'production',
  // Allow self-registration of the FIRST admin only (bootstrap). After one
  // admin exists, registration requires being logged in as an existing admin.
  // Set ALLOW_OPEN_REGISTRATION=true to always allow (not recommended).
  allowOpenRegistration: process.env.ALLOW_OPEN_REGISTRATION === 'true',
  // Hard ceiling on geofence radius an admin can set (meters).
  maxRadiusMeters: parseInt(process.env.MAX_RADIUS_METERS || '50000', 10),
  // Default rejection threshold for poor GPS accuracy (meters). Per-meeting overridable.
  defaultMaxAccuracyMeters: parseInt(process.env.DEFAULT_MAX_ACCURACY_METERS || '100', 10),
};

module.exports = config;
