'use strict';

// SQLite implementation of the data store. Methods are synchronous internally
// but the contract is async-compatible (callers always `await`), so this and the
// Supabase backend are drop-in interchangeable.

const db = require('../db');

// Columns that make up a meeting row (for inserts/updates).
const MEETING_COLS = [
  'title', 'description', 'location_name', 'venue', 'latitude', 'longitude', 'radius_meters',
  'geofence_enabled', 'max_accuracy_meters', 'starts_at', 'ends_at', 'is_open', 'passcode_hash',
  'require_unique_email', 'limit_one_per_device', 'collect_ip',
  'notify_attendee_email', 'notify_attendee_sms', 'notify_owner_email', 'notify_owner_sms',
  'owner_notify_email', 'owner_notify_phone', 'fields_json', 'status',
];

module.exports = {
  backend: 'sqlite',
  async init() { /* schema is created on require('../db') */ },

  // --- Admins ---
  async countAdmins() { return db.prepare('SELECT COUNT(*) AS n FROM admins').get().n; },
  async getAdminByEmail(email) { return db.prepare('SELECT * FROM admins WHERE email = ?').get(email) || null; },
  async getAdminById(id) { return db.prepare('SELECT id, email, name, role FROM admins WHERE id = ?').get(id) || null; },
  async createAdmin(a) {
    db.prepare('INSERT INTO admins (id, email, password_hash, name, role, created_at) VALUES (?,?,?,?,?,?)')
      .run(a.id, a.email, a.password_hash, a.name, a.role, a.created_at);
  },
  async setAdminLock(id, failedLogins, lockedUntil) {
    db.prepare('UPDATE admins SET failed_logins = ?, locked_until = ? WHERE id = ?').run(failedLogins, lockedUntil, id);
  },
  async resetAdminLock(id) {
    db.prepare('UPDATE admins SET failed_logins = 0, locked_until = NULL WHERE id = ?').run(id);
  },

  // --- Sessions ---
  async createSession(s) {
    db.prepare('INSERT INTO sessions (id, admin_id, csrf_token, expires_at, created_at, ip, user_agent) VALUES (?,?,?,?,?,?,?)')
      .run(s.id, s.admin_id, s.csrf_token, s.expires_at, s.created_at, s.ip, s.user_agent);
  },
  async getSession(id) { return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) || null; },
  async deleteSession(id) { db.prepare('DELETE FROM sessions WHERE id = ?').run(id); },
  async deleteExpiredSessions(now) { db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now); },
  async listSessions(adminId) {
    return db.prepare('SELECT id, created_at, expires_at, ip, user_agent FROM sessions WHERE admin_id = ? ORDER BY created_at DESC').all(adminId);
  },
  async getSessionForAdmin(id, adminId) {
    return db.prepare('SELECT id FROM sessions WHERE id = ? AND admin_id = ?').get(id, adminId) || null;
  },

  // --- Meetings ---
  async slugExists(slug) { return !!db.prepare('SELECT 1 FROM meetings WHERE slug = ?').get(slug); },
  async createMeeting(m) {
    const cols = ['id', 'slug', 'owner_id', ...MEETING_COLS, 'created_at', 'updated_at'];
    const placeholders = cols.map(() => '?').join(',');
    db.prepare(`INSERT INTO meetings (${cols.join(',')}) VALUES (${placeholders})`)
      .run(...cols.map((c) => m[c]));
  },
  async getMeetingById(id) { return db.prepare('SELECT * FROM meetings WHERE id = ?').get(id) || null; },
  async getOwnedMeeting(id, ownerId) { return db.prepare('SELECT * FROM meetings WHERE id = ? AND owner_id = ?').get(id, ownerId) || null; },
  async getMeetingBySlug(slug) { return db.prepare('SELECT * FROM meetings WHERE slug = ?').get(slug) || null; },
  async listMeetingsByOwner(ownerId) { return db.prepare('SELECT * FROM meetings WHERE owner_id = ? ORDER BY created_at DESC').all(ownerId); },
  async countSignins(meetingId) { return db.prepare('SELECT COUNT(*) AS c FROM signins WHERE meeting_id = ?').get(meetingId).c; },
  async updateMeeting(id, fields) {
    const sets = MEETING_COLS.filter((c) => c in fields);
    sets.push('updated_at');
    const clause = sets.map((c) => `${c} = ?`).join(', ');
    db.prepare(`UPDATE meetings SET ${clause} WHERE id = ?`).run(...sets.map((c) => fields[c]), id);
  },
  async setMeetingOpen(id, isOpen, updatedAt) { db.prepare('UPDATE meetings SET is_open = ?, updated_at = ? WHERE id = ?').run(isOpen, updatedAt, id); },
  async deleteMeeting(id) { db.prepare('DELETE FROM meetings WHERE id = ?').run(id); },

  // --- Sign-ins ---
  async createSignin(s) {
    db.prepare(`INSERT INTO signins
      (id, meeting_id, data_json, email, latitude, longitude, accuracy, distance_meters,
       within_geofence, ip, user_agent, device_hash, flagged, flag_reason, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      s.id, s.meeting_id, s.data_json, s.email, s.latitude, s.longitude, s.accuracy, s.distance_meters,
      s.within_geofence, s.ip, s.user_agent, s.device_hash, s.flagged, s.flag_reason, s.created_at);
  },
  async listSignins(meetingId) { return db.prepare('SELECT * FROM signins WHERE meeting_id = ? ORDER BY created_at DESC').all(meetingId); },
  async listSigninsAsc(meetingId) { return db.prepare('SELECT * FROM signins WHERE meeting_id = ? ORDER BY created_at ASC').all(meetingId); },
  async signinExistsByEmail(meetingId, email) { return !!db.prepare('SELECT 1 FROM signins WHERE meeting_id = ? AND email = ?').get(meetingId, email); },
  async signinExistsByDevice(meetingId, deviceHash) { return !!db.prepare('SELECT 1 FROM signins WHERE meeting_id = ? AND device_hash = ?').get(meetingId, deviceHash); },
  async deleteSignin(id, meetingId) { db.prepare('DELETE FROM signins WHERE id = ? AND meeting_id = ?').run(id, meetingId); },

  // --- Branding ---
  async getBranding(ownerId) {
    const b = db.prepare('SELECT * FROM org_settings WHERE owner_id = ?').get(ownerId);
    if (b && b.logo_data && !Buffer.isBuffer(b.logo_data)) b.logo_data = Buffer.from(b.logo_data);
    return b || null;
  },
  async upsertBrandingText(ownerId, t) {
    const exists = db.prepare('SELECT 1 FROM org_settings WHERE owner_id = ?').get(ownerId);
    if (exists) {
      db.prepare('UPDATE org_settings SET org_name=?, address=?, contact=?, footer_text=?, updated_at=? WHERE owner_id=?')
        .run(t.org_name, t.address, t.contact, t.footer_text, t.updated_at, ownerId);
    } else {
      db.prepare('INSERT INTO org_settings (owner_id, org_name, address, contact, footer_text, updated_at) VALUES (?,?,?,?,?,?)')
        .run(ownerId, t.org_name, t.address, t.contact, t.footer_text, t.updated_at);
    }
  },
  async upsertBrandingLogo(ownerId, l) {
    const exists = db.prepare('SELECT 1 FROM org_settings WHERE owner_id = ?').get(ownerId);
    if (exists) {
      db.prepare('UPDATE org_settings SET logo_data=?, logo_mime=?, logo_w=?, logo_h=?, updated_at=? WHERE owner_id=?')
        .run(l.logo_data, l.logo_mime, l.logo_w, l.logo_h, l.updated_at, ownerId);
    } else {
      db.prepare('INSERT INTO org_settings (owner_id, logo_data, logo_mime, logo_w, logo_h, updated_at) VALUES (?,?,?,?,?,?)')
        .run(ownerId, l.logo_data, l.logo_mime, l.logo_w, l.logo_h, l.updated_at);
    }
  },
  async clearBrandingLogo(ownerId) {
    db.prepare('UPDATE org_settings SET logo_data=NULL, logo_mime=NULL, logo_w=NULL, logo_h=NULL WHERE owner_id=?').run(ownerId);
  },

  // --- Contact + audit ---
  async createContactMessage(c) {
    db.prepare('INSERT INTO contact_messages (id, name, email, phone, subject, message, ip, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(c.id, c.name, c.email, c.phone, c.subject, c.message, c.ip, c.created_at);
  },
  async insertAudit(a) {
    db.prepare('INSERT INTO audit_log (id, actor, action, target, detail, ip, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(a.id, a.actor, a.action, a.target, a.detail, a.ip, a.created_at);
  },
};
