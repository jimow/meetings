'use strict';

// Supabase (Postgres) is the only backend. SQLite has been removed.
// Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (see .env / README).

// Ensure .env is loaded before the store reads any configuration.
require('../config');

// DB_BACKEND is accepted for compatibility but only Supabase is supported now.
const raw = (process.env.DB_BACKEND || 'supabase').trim().toLowerCase();
if (['sqlite', 'local', 'file'].includes(raw)) {
  console.warn(`\n  ⚠  DB_BACKEND="${process.env.DB_BACKEND}" is no longer supported — this build uses Supabase only.\n`);
}

module.exports = require('./supabase');
