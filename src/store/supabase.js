'use strict';

// Supabase (Postgres) implementation of the data store. Selected when
// DB_BACKEND=supabase and SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are set.
// Uses the service-role key on the server side (never exposed to the browser).
//
// Run supabase/schema.sql in your Supabase project's SQL editor first.

const { createClient } = require('@supabase/supabase-js');

let sb = null;
function client() {
  if (sb) return sb;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('DB_BACKEND=supabase requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment.');
  }
  sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return sb;
}

function must(res) {
  if (res.error) throw new Error('Supabase error: ' + res.error.message);
  return res.data;
}

const MEETING_COLS = [
  'title', 'description', 'location_name', 'venue', 'latitude', 'longitude', 'radius_meters',
  'geofence_enabled', 'max_accuracy_meters', 'starts_at', 'ends_at', 'is_open', 'passcode_hash',
  'require_unique_email', 'limit_one_per_device', 'collect_ip',
  'notify_attendee_email', 'notify_attendee_sms', 'notify_owner_email', 'notify_owner_sms',
  'owner_notify_email', 'owner_notify_phone', 'fields_json', 'status',
];

module.exports = {
  backend: 'supabase',
  async init() {
    // Validate connectivity early so misconfiguration fails fast at startup.
    const res = await client().from('admins').select('id', { count: 'exact', head: true });
    if (res.error) throw new Error('Cannot reach Supabase (did you run schema.sql?): ' + res.error.message);
  },

  // --- Admins ---
  async countAdmins() {
    const res = await client().from('admins').select('id', { count: 'exact', head: true });
    if (res.error) throw new Error(res.error.message);
    return res.count || 0;
  },
  async getAdminByEmail(email) {
    return must(await client().from('admins').select('*').eq('email', email).maybeSingle());
  },
  async getAdminById(id) {
    return must(await client().from('admins').select('id, email, name, role').eq('id', id).maybeSingle());
  },
  async createAdmin(a) { must(await client().from('admins').insert(a)); },
  async setAdminLock(id, failedLogins, lockedUntil) {
    must(await client().from('admins').update({ failed_logins: failedLogins, locked_until: lockedUntil }).eq('id', id));
  },
  async resetAdminLock(id) {
    must(await client().from('admins').update({ failed_logins: 0, locked_until: null }).eq('id', id));
  },

  // --- Sessions ---
  async createSession(s) { must(await client().from('sessions').insert(s)); },
  async getSession(id) { return must(await client().from('sessions').select('*').eq('id', id).maybeSingle()); },
  async deleteSession(id) { must(await client().from('sessions').delete().eq('id', id)); },
  async deleteExpiredSessions(now) { must(await client().from('sessions').delete().lt('expires_at', now)); },
  async listSessions(adminId) {
    return must(await client().from('sessions').select('id, created_at, expires_at, ip, user_agent')
      .eq('admin_id', adminId).order('created_at', { ascending: false }));
  },
  async getSessionForAdmin(id, adminId) {
    return must(await client().from('sessions').select('id').eq('id', id).eq('admin_id', adminId).maybeSingle());
  },

  // --- Meetings ---
  async slugExists(slug) {
    const res = await client().from('meetings').select('id', { count: 'exact', head: true }).eq('slug', slug);
    if (res.error) throw new Error(res.error.message);
    return (res.count || 0) > 0;
  },
  async createMeeting(m) {
    const row = {};
    for (const c of ['id', 'slug', 'owner_id', ...MEETING_COLS, 'created_at', 'updated_at']) row[c] = m[c];
    must(await client().from('meetings').insert(row));
  },
  async getMeetingById(id) { return must(await client().from('meetings').select('*').eq('id', id).maybeSingle()); },
  async getOwnedMeeting(id, ownerId) {
    return must(await client().from('meetings').select('*').eq('id', id).eq('owner_id', ownerId).maybeSingle());
  },
  async getMeetingBySlug(slug) { return must(await client().from('meetings').select('*').eq('slug', slug).maybeSingle()); },
  async listMeetingsByOwner(ownerId) {
    return must(await client().from('meetings').select('*').eq('owner_id', ownerId).order('created_at', { ascending: false }));
  },
  async countSignins(meetingId) {
    const res = await client().from('signins').select('id', { count: 'exact', head: true }).eq('meeting_id', meetingId);
    if (res.error) throw new Error(res.error.message);
    return res.count || 0;
  },
  async updateMeeting(id, fields) {
    const upd = {};
    for (const c of MEETING_COLS) if (c in fields) upd[c] = fields[c];
    upd.updated_at = fields.updated_at;
    must(await client().from('meetings').update(upd).eq('id', id));
  },
  async setMeetingOpen(id, isOpen, updatedAt) {
    must(await client().from('meetings').update({ is_open: isOpen, updated_at: updatedAt }).eq('id', id));
  },
  async deleteMeeting(id) { must(await client().from('meetings').delete().eq('id', id)); },

  // --- Sign-ins ---
  async createSignin(s) { must(await client().from('signins').insert(s)); },
  async listSignins(meetingId) {
    return must(await client().from('signins').select('*').eq('meeting_id', meetingId).order('created_at', { ascending: false }));
  },
  async listSigninsAsc(meetingId) {
    return must(await client().from('signins').select('*').eq('meeting_id', meetingId).order('created_at', { ascending: true }));
  },
  async signinExistsByEmail(meetingId, email) {
    const res = await client().from('signins').select('id', { count: 'exact', head: true }).eq('meeting_id', meetingId).eq('email', email);
    if (res.error) throw new Error(res.error.message);
    return (res.count || 0) > 0;
  },
  async signinExistsByDevice(meetingId, deviceHash) {
    const res = await client().from('signins').select('id', { count: 'exact', head: true }).eq('meeting_id', meetingId).eq('device_hash', deviceHash);
    if (res.error) throw new Error(res.error.message);
    return (res.count || 0) > 0;
  },
  async deleteSignin(id, meetingId) { must(await client().from('signins').delete().eq('id', id).eq('meeting_id', meetingId)); },

  // --- Branding (logo stored as base64 text in logo_b64) ---
  async getBranding(ownerId) {
    const b = must(await client().from('org_settings').select('*').eq('owner_id', ownerId).maybeSingle());
    if (!b) return null;
    b.logo_data = b.logo_b64 ? Buffer.from(b.logo_b64, 'base64') : null;
    return b;
  },
  async upsertBrandingText(ownerId, t) {
    must(await client().from('org_settings').upsert(
      { owner_id: ownerId, org_name: t.org_name, address: t.address, contact: t.contact, footer_text: t.footer_text, updated_at: t.updated_at },
      { onConflict: 'owner_id' }));
  },
  async upsertBrandingLogo(ownerId, l) {
    must(await client().from('org_settings').upsert(
      { owner_id: ownerId, logo_b64: l.logo_data ? Buffer.from(l.logo_data).toString('base64') : null, logo_mime: l.logo_mime, logo_w: l.logo_w, logo_h: l.logo_h, updated_at: l.updated_at },
      { onConflict: 'owner_id' }));
  },
  async clearBrandingLogo(ownerId) {
    must(await client().from('org_settings').update({ logo_b64: null, logo_mime: null, logo_w: null, logo_h: null }).eq('owner_id', ownerId));
  },

  // --- Contact + audit ---
  async createContactMessage(c) { must(await client().from('contact_messages').insert(c)); },
  async insertAudit(a) {
    const res = await client().from('audit_log').insert(a);
    if (res.error) { /* auditing must never break a request */ }
  },
};
