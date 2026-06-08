'use strict';

// Selects the data backend at startup based on DB_BACKEND.
//   DB_BACKEND=sqlite   (default) — local file DB, zero config, used for dev/offline
//   DB_BACKEND=supabase           — Supabase Postgres (requires SUPABASE_* env vars)
//
// Both implement the identical async method contract, so the rest of the app
// is backend-agnostic.

// Ensure .env is loaded BEFORE we read DB_BACKEND, regardless of which module
// happens to require the store first. (config.js loads .env on require.)
require('../config');

const raw = (process.env.DB_BACKEND || 'sqlite').trim().toLowerCase();

// Accept common aliases so a value like "Postgres" or "pg" still selects Supabase.
const SUPABASE_ALIASES = ['supabase', 'postgres', 'postgresql', 'pg'];
const SQLITE_ALIASES = ['sqlite', 'local', 'file', ''];

let backend;
if (SUPABASE_ALIASES.includes(raw)) backend = 'supabase';
else if (SQLITE_ALIASES.includes(raw)) backend = 'sqlite';
else {
  // Unknown value: do NOT silently use SQLite — that hides misconfiguration.
  console.warn(`\n  ⚠  Unrecognized DB_BACKEND="${process.env.DB_BACKEND}". ` +
    `Expected one of: supabase, postgres, sqlite. Falling back to sqlite.\n`);
  backend = 'sqlite';
}

const store = backend === 'supabase' ? require('./supabase') : require('./sqlite');

module.exports = store;
