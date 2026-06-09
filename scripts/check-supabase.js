'use strict';

// Verifies the Supabase backend is reachable and writable.
// Usage:  node scripts/check-supabase.js
// Reads SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY from .env (or the environment).

require('../src/config'); // loads .env
require('../src/ws-polyfill'); // global WebSocket on Node < 22

const { createClient } = require('@supabase/supabase-js');

(async () => {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  console.log('\n  Supabase connectivity check');
  console.log('  ─────────────────────────────');
  console.log('  SUPABASE_URL        :', url ? url : 'MISSING ✗');
  console.log('  SERVICE_ROLE_KEY    :', key ? key.slice(0, 6) + '…' + key.slice(-4) : 'MISSING ✗');

  if (!url || !key) {
    console.log('\n  ✗ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Add them to .env.\n');
    process.exit(1);
  }

  const sb = createClient(url, key, { auth: { persistSession: false } });

  // 1) Can we read the admins table? (schema present?)
  const countRes = await sb.from('admins').select('id', { count: 'exact', head: true });
  if (countRes.error) {
    console.log('\n  ✗ Could not query the "admins" table:', countRes.error.message);
    console.log('    → Did you run supabase/schema.sql in the SQL editor?\n');
    process.exit(1);
  }
  console.log('\n  ✓ Connected. admins table reachable. Current admin rows:', countRes.count);

  // 2) Round-trip write/read/delete to prove inserts work with the service key.
  const testId = 'healthcheck_' + Math.random().toString(36).slice(2, 10);
  const ins = await sb.from('admins').insert({
    id: testId, email: `${testId}@example.invalid`, password_hash: 'x',
    name: 'healthcheck', role: 'admin', created_at: 1,
  });
  if (ins.error) {
    console.log('  ✗ Insert failed:', ins.error.message);
    console.log('    → The service-role key should bypass RLS. Check the key and schema.\n');
    process.exit(1);
  }
  const read = await sb.from('admins').select('id').eq('id', testId).maybeSingle();
  await sb.from('admins').delete().eq('id', testId); // clean up
  if (read.error || !read.data) {
    console.log('  ✗ Insert did not persist / could not read it back.\n');
    process.exit(1);
  }

  console.log('  ✓ Insert + read + delete round-trip succeeded.');
  console.log('\n  RESULT: Supabase is correctly configured and ready.\n');
  process.exit(0);
})().catch((e) => {
  console.error('\n  ✗ Unexpected error:', e.message, '\n');
  process.exit(1);
});
