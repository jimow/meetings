'use strict';

// Reset an admin's password from the command line.
// Works against the active backend (DB_BACKEND in .env — sqlite or supabase).
//
//   List admins:   node scripts/reset-password.js
//   Reset:         node scripts/reset-password.js <email> <new-password>
//
// To target the LOCAL SQLite file regardless of .env (e.g. an account created
// before switching to Supabase):
//   DB_BACKEND=sqlite node scripts/reset-password.js <email> <new-password>

require('../src/config'); // loads .env
const store = require('../src/store');
const auth = require('../src/auth');

(async () => {
  await store.init();

  const email = (process.argv[2] || '').trim().toLowerCase();
  const password = process.argv[3];

  console.log(`\n  Backend: ${store.backend.toUpperCase()}`);

  if (!email) {
    const admins = await store.listAdmins();
    if (!admins.length) {
      console.log('  No admin accounts exist on this backend.');
      console.log('  Register the first one at /admin (it becomes the owner).\n');
    } else {
      console.log('  Admin accounts:');
      for (const a of admins) console.log(`   - ${a.email}   (${a.role})`);
      console.log('\n  To reset:  node scripts/reset-password.js <email> <new-password>\n');
    }
    process.exit(0);
  }

  if (!password || password.length < 10) {
    console.error('\n  ✗ Provide a new password of at least 10 characters.\n');
    process.exit(1);
  }

  const hash = await auth.hashPassword(password);
  const ok = await store.setAdminPasswordByEmail(email, hash);

  if (ok) {
    console.log(`\n  ✓ Password reset for ${email}. Any account lock was cleared.`);
    console.log('    You can now log in at /admin with the new password.\n');
    process.exit(0);
  } else {
    console.error(`\n  ✗ No admin found with email "${email}" on the ${store.backend} backend.`);
    console.error('    Run with no arguments to list accounts, or try DB_BACKEND=sqlite.\n');
    process.exit(1);
  }
})().catch((e) => {
  console.error('\n  ✗ Error:', e.message, '\n');
  process.exit(1);
});
