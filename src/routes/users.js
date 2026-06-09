'use strict';

// Super-admin user management: create / list / delete the user accounts that
// host meetings. Each user only sees their own meetings; admins see all.

const express = require('express');
const store = require('../store');
const auth = require('../auth');
const { randomId, clientIp, audit, isAdmin } = require('../util');
const { isEmail, asString } = require('../validate');

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.use(auth.requireSuperAdmin);

// --- List users (with meeting counts) ------------------------------------
router.get('/', wrap(async (req, res) => {
  const admins = await store.listAdmins();
  const users = [];
  for (const a of admins) {
    users.push({
      id: a.id,
      email: a.email,
      name: a.name,
      role: isAdmin(a) ? 'admin' : 'user',
      createdAt: a.created_at,
      meetingCount: await store.countMeetingsByOwner(a.id),
      isSelf: a.id === req.admin.id,
    });
  }
  res.json({ users });
}));

// --- Create a user -------------------------------------------------------
router.post('/', auth.requireCsrf, wrap(async (req, res) => {
  const email = asString(req.body?.email, 200).trim().toLowerCase();
  const name = asString(req.body?.name, 120).trim();
  const password = asString(req.body?.password, 200);
  const role = req.body?.role === 'admin' ? 'admin' : 'user';

  if (!isEmail(email)) return res.status(400).json({ error: 'invalid_email' });
  if (password.length < 10) return res.status(400).json({ error: 'weak_password', detail: 'Use at least 10 characters.' });
  if (await store.getAdminByEmail(email)) return res.status(409).json({ error: 'email_in_use' });

  const id = randomId();
  await store.createAdmin({ id, email, password_hash: await auth.hashPassword(password), name, role, created_at: Date.now() });

  // Seed the County default header/branding for the new account.
  try {
    await store.upsertBrandingText(id, {
      org_name: process.env.ORG_NAME || 'County Government of Mandera',
      address: process.env.ORG_ADDRESS || 'P.O. Box 13-70300, Mandera, Kenya',
      contact: process.env.ORG_CONTACT || 'info@mandera.go.ke',
      footer_text: process.env.ORG_FOOTER || 'County Government of Mandera · Official attendance record',
      updated_at: Date.now(),
    });
  } catch { /* non-fatal */ }

  audit('user.create', { actor: req.admin.id, target: id, ip: clientIp(req), detail: { email, role } });
  res.status(201).json({ user: { id, email, name, role } });
}));

// --- Change a user's role ------------------------------------------------
router.patch('/:id/role', auth.requireCsrf, wrap(async (req, res) => {
  const role = req.body?.role === 'admin' ? 'admin' : 'user';
  const target = (await store.listAdmins()).find((a) => a.id === req.params.id);
  if (!target) return res.status(404).json({ error: 'not_found' });
  if (target.id === req.admin.id) return res.status(400).json({ error: 'cannot_change_own_role' });

  // Don't allow removing the last admin.
  if (isAdmin(target) && role === 'user') {
    const admins = await store.countAdminsByRole(['admin', 'owner']);
    if (admins <= 1) return res.status(400).json({ error: 'last_admin' });
  }
  await store.setAdminRole(target.id, role);
  audit('user.role', { actor: req.admin.id, target: target.id, detail: { role } });
  res.json({ ok: true });
}));

// --- Delete a user (cascades their meetings + sign-ins) ------------------
router.delete('/:id', auth.requireCsrf, wrap(async (req, res) => {
  if (req.params.id === req.admin.id) return res.status(400).json({ error: 'cannot_delete_self' });
  const target = (await store.listAdmins()).find((a) => a.id === req.params.id);
  if (!target) return res.status(404).json({ error: 'not_found' });

  if (isAdmin(target)) {
    const admins = await store.countAdminsByRole(['admin', 'owner']);
    if (admins <= 1) return res.status(400).json({ error: 'last_admin' });
  }
  await store.deleteAdmin(target.id);
  audit('user.delete', { actor: req.admin.id, target: target.id, ip: clientIp(req), detail: { email: target.email } });
  res.json({ ok: true });
}));

module.exports = router;
