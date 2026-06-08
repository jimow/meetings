'use strict';

const express = require('express');
const QRCode = require('qrcode');
const bcrypt = require('bcryptjs');
const db = require('../db');
const config = require('../config');
const auth = require('../auth');
const { randomId, uniqueSlug, clientIp, audit } = require('../util');
const { normalizeFields, asString } = require('../validate');
const { isValidLatLng } = require('../geo');
const { generatePdf, generateDocx } = require('../docgen');
const { getBranding } = require('./branding');

const router = express.Router();

// All meeting routes require an authenticated admin.
router.use(auth.requireAdmin);

function meetingUrl(slug) {
  return `${config.baseUrl}/m/${slug}`;
}

function getOwnedMeeting(id, adminId) {
  return db.prepare('SELECT * FROM meetings WHERE id = ? AND owner_id = ?').get(id, adminId);
}

function publicShape(m) {
  return {
    id: m.id,
    slug: m.slug,
    title: m.title,
    description: m.description,
    locationName: m.location_name,
    venue: m.venue || '',
    latitude: m.latitude,
    longitude: m.longitude,
    radiusMeters: m.radius_meters,
    geofenceEnabled: !!m.geofence_enabled,
    maxAccuracyMeters: m.max_accuracy_meters,
    startsAt: m.starts_at,
    endsAt: m.ends_at,
    isOpen: !!m.is_open,
    hasPasscode: !!m.passcode_hash,
    requireUniqueEmail: !!m.require_unique_email,
    limitOnePerDevice: !!m.limit_one_per_device,
    collectIp: !!m.collect_ip,
    fields: JSON.parse(m.fields_json),
    status: m.status,
    shareUrl: meetingUrl(m.slug),
    createdAt: m.created_at,
    updatedAt: m.updated_at,
  };
}

// Parse + validate the mutable meeting fields from the request body.
async function parseMeetingInput(body, existing) {
  const out = {};
  out.title = asString(body.title, 200).trim();
  if (!out.title) return { error: 'title_required' };

  out.description = asString(body.description, 4000);
  out.location_name = asString(body.locationName, 200);
  out.venue = asString(body.venue, 200);

  // Geofence
  out.geofence_enabled = body.geofenceEnabled === false ? 0 : 1;
  const lat = body.latitude === '' || body.latitude == null ? null : Number(body.latitude);
  const lng = body.longitude === '' || body.longitude == null ? null : Number(body.longitude);
  if (out.geofence_enabled) {
    if (!isValidLatLng(lat, lng)) return { error: 'valid_location_required_for_geofence' };
  }
  out.latitude = lat;
  out.longitude = lng;

  let radius = parseInt(body.radiusMeters, 10);
  if (!Number.isFinite(radius)) radius = existing?.radius_meters ?? 150;
  radius = Math.max(10, Math.min(config.maxRadiusMeters, radius));
  out.radius_meters = radius;

  let maxAcc = parseInt(body.maxAccuracyMeters, 10);
  if (!Number.isFinite(maxAcc)) maxAcc = existing?.max_accuracy_meters ?? config.defaultMaxAccuracyMeters;
  out.max_accuracy_meters = Math.max(5, Math.min(5000, maxAcc));

  // Window
  out.starts_at = body.startsAt ? Number(body.startsAt) : null;
  out.ends_at = body.endsAt ? Number(body.endsAt) : null;
  if (out.starts_at && out.ends_at && out.ends_at <= out.starts_at) return { error: 'end_before_start' };

  // Toggles
  out.is_open = body.isOpen === false ? 0 : 1;
  out.require_unique_email = body.requireUniqueEmail === false ? 0 : 1;
  out.limit_one_per_device = body.limitOnePerDevice === false ? 0 : 1;
  out.collect_ip = body.collectIp === false ? 0 : 1;

  // Passcode (optional). '' clears, undefined keeps existing.
  if (body.passcode !== undefined) {
    const pc = asString(body.passcode, 100);
    if (pc === '') out.passcode_hash = null;
    else if (pc.length < 4) return { error: 'passcode_too_short' };
    else out.passcode_hash = await bcrypt.hash(pc, 10);
  }

  // Fields
  const fieldsRes = normalizeFields(body.fields ?? (existing ? JSON.parse(existing.fields_json) : []));
  if (!fieldsRes.ok) return { error: fieldsRes.error };
  if (fieldsRes.fields.length === 0) return { error: 'at_least_one_field_required' };
  out.fields_json = JSON.stringify(fieldsRes.fields);

  // Status
  if (body.status && ['active', 'closed', 'archived'].includes(body.status)) out.status = body.status;

  return { value: out };
}

// --- List ----------------------------------------------------------------
router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM meetings WHERE owner_id = ? ORDER BY created_at DESC').all(req.admin.id);
  const withCounts = rows.map((m) => {
    const n = db.prepare('SELECT COUNT(*) AS c FROM signins WHERE meeting_id = ?').get(m.id).c;
    return { ...publicShape(m), signinCount: n };
  });
  res.json({ meetings: withCounts });
});

// --- Create --------------------------------------------------------------
router.post('/', auth.requireCsrf, async (req, res) => {
  const parsed = await parseMeetingInput(req.body || {}, null);
  if (parsed.error) return res.status(400).json({ error: parsed.error });

  const v = parsed.value;
  const id = randomId();
  const slug = uniqueSlug();
  const now = Date.now();
  db.prepare(`INSERT INTO meetings
    (id, slug, owner_id, title, description, location_name, venue, latitude, longitude, radius_meters,
     geofence_enabled, max_accuracy_meters, starts_at, ends_at, is_open, passcode_hash,
     require_unique_email, limit_one_per_device, collect_ip, fields_json, status, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, slug, req.admin.id, v.title, v.description, v.location_name, v.venue, v.latitude, v.longitude, v.radius_meters,
    v.geofence_enabled, v.max_accuracy_meters, v.starts_at, v.ends_at, v.is_open, v.passcode_hash ?? null,
    v.require_unique_email, v.limit_one_per_device, v.collect_ip, v.fields_json, v.status || 'active', now, now
  );
  audit('meeting.create', { actor: req.admin.id, target: id, ip: clientIp(req) });
  res.status(201).json({ meeting: publicShape(db.prepare('SELECT * FROM meetings WHERE id = ?').get(id)) });
});

// --- Read ----------------------------------------------------------------
router.get('/:id', (req, res) => {
  const m = getOwnedMeeting(req.params.id, req.admin.id);
  if (!m) return res.status(404).json({ error: 'not_found' });
  res.json({ meeting: publicShape(m) });
});

// --- Update --------------------------------------------------------------
router.put('/:id', auth.requireCsrf, async (req, res) => {
  const m = getOwnedMeeting(req.params.id, req.admin.id);
  if (!m) return res.status(404).json({ error: 'not_found' });

  const parsed = await parseMeetingInput(req.body || {}, m);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const v = parsed.value;
  const passcodeHash = v.passcode_hash !== undefined ? v.passcode_hash : m.passcode_hash;

  db.prepare(`UPDATE meetings SET
    title=?, description=?, location_name=?, venue=?, latitude=?, longitude=?, radius_meters=?,
    geofence_enabled=?, max_accuracy_meters=?, starts_at=?, ends_at=?, is_open=?, passcode_hash=?,
    require_unique_email=?, limit_one_per_device=?, collect_ip=?, fields_json=?, status=?, updated_at=?
    WHERE id=?`).run(
    v.title, v.description, v.location_name, v.venue, v.latitude, v.longitude, v.radius_meters,
    v.geofence_enabled, v.max_accuracy_meters, v.starts_at, v.ends_at, v.is_open, passcodeHash,
    v.require_unique_email, v.limit_one_per_device, v.collect_ip, v.fields_json, v.status || m.status, Date.now(),
    m.id
  );
  audit('meeting.update', { actor: req.admin.id, target: m.id, ip: clientIp(req) });
  res.json({ meeting: publicShape(db.prepare('SELECT * FROM meetings WHERE id = ?').get(m.id)) });
});

// --- Quick open/close toggle --------------------------------------------
router.post('/:id/toggle', auth.requireCsrf, (req, res) => {
  const m = getOwnedMeeting(req.params.id, req.admin.id);
  if (!m) return res.status(404).json({ error: 'not_found' });
  const next = m.is_open ? 0 : 1;
  db.prepare('UPDATE meetings SET is_open=?, updated_at=? WHERE id=?').run(next, Date.now(), m.id);
  audit('meeting.toggle', { actor: req.admin.id, target: m.id, detail: { is_open: next } });
  res.json({ isOpen: !!next });
});

// --- Delete --------------------------------------------------------------
router.delete('/:id', auth.requireCsrf, (req, res) => {
  const m = getOwnedMeeting(req.params.id, req.admin.id);
  if (!m) return res.status(404).json({ error: 'not_found' });
  db.prepare('DELETE FROM meetings WHERE id = ?').run(m.id); // cascades to signins
  audit('meeting.delete', { actor: req.admin.id, target: m.id, ip: clientIp(req) });
  res.json({ ok: true });
});

// --- QR code (PNG) -------------------------------------------------------
router.get('/:id/qr.png', async (req, res) => {
  const m = getOwnedMeeting(req.params.id, req.admin.id);
  if (!m) return res.status(404).json({ error: 'not_found' });
  try {
    const png = await QRCode.toBuffer(meetingUrl(m.slug), {
      errorCorrectionLevel: 'M', margin: 2, width: 512, color: { dark: '#0f172a', light: '#ffffff' },
    });
    res.type('png').set('Cache-Control', 'no-store').send(png);
  } catch {
    res.status(500).json({ error: 'qr_generation_failed' });
  }
});

// --- Sign-ins list -------------------------------------------------------
router.get('/:id/signins', (req, res) => {
  const m = getOwnedMeeting(req.params.id, req.admin.id);
  if (!m) return res.status(404).json({ error: 'not_found' });
  const rows = db.prepare('SELECT * FROM signins WHERE meeting_id = ? ORDER BY created_at DESC').all(m.id);
  const signins = rows.map((r) => ({
    id: r.id,
    data: JSON.parse(r.data_json),
    email: r.email,
    distanceMeters: r.distance_meters,
    accuracy: r.accuracy,
    withinGeofence: !!r.within_geofence,
    ip: m.collect_ip ? r.ip : null,
    flagged: !!r.flagged,
    flagReason: r.flag_reason,
    createdAt: r.created_at,
  }));
  res.json({ meeting: publicShape(m), signins });
});

// --- Delete a single sign-in (e.g. remove a flagged/spam entry) ----------
router.delete('/:id/signins/:signinId', auth.requireCsrf, (req, res) => {
  const m = getOwnedMeeting(req.params.id, req.admin.id);
  if (!m) return res.status(404).json({ error: 'not_found' });
  db.prepare('DELETE FROM signins WHERE id = ? AND meeting_id = ?').run(req.params.signinId, m.id);
  res.json({ ok: true });
});

// --- CSV export ----------------------------------------------------------
function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  // Guard against CSV/formula injection in spreadsheet apps.
  const needsGuard = /^[=+\-@\t\r]/.test(s);
  const safe = needsGuard ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
}

router.get('/:id/export.csv', (req, res) => {
  const m = getOwnedMeeting(req.params.id, req.admin.id);
  if (!m) return res.status(404).json({ error: 'not_found' });
  const fields = JSON.parse(m.fields_json);
  const rows = db.prepare('SELECT * FROM signins WHERE meeting_id = ? ORDER BY created_at ASC').all(m.id);

  const headers = [
    'signed_in_at', ...fields.map((f) => f.label),
    'within_geofence', 'distance_meters', 'gps_accuracy_m', 'flagged', 'flag_reason',
  ];
  if (m.collect_ip) headers.push('ip');

  const lines = [headers.map(csvCell).join(',')];
  for (const r of rows) {
    const data = JSON.parse(r.data_json);
    const cells = [
      new Date(r.created_at).toISOString(),
      ...fields.map((f) => data[f.key]),
      r.within_geofence ? 'yes' : 'no',
      r.distance_meters != null ? Math.round(r.distance_meters) : '',
      r.accuracy != null ? Math.round(r.accuracy) : '',
      r.flagged ? 'yes' : 'no',
      r.flag_reason || '',
    ];
    if (m.collect_ip) cells.push(r.ip || '');
    lines.push(cells.map(csvCell).join(','));
  }
  const safeName = m.title.replace(/[^a-z0-9]+/gi, '_').slice(0, 40) || 'meeting';
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${safeName}_signins.csv"`);
  res.send('﻿' + lines.join('\r\n')); // BOM for Excel
});

function safeFileName(m) {
  return (m.title.replace(/[^a-z0-9]+/gi, '_').slice(0, 40) || 'meeting') + '_signins';
}

// --- PDF export (branded) ------------------------------------------------
router.get('/:id/export.pdf', (req, res) => {
  const m = getOwnedMeeting(req.params.id, req.admin.id);
  if (!m) return res.status(404).json({ error: 'not_found' });
  const signins = db.prepare('SELECT * FROM signins WHERE meeting_id = ? ORDER BY created_at ASC').all(m.id);
  const branding = getBranding(req.admin.id);
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `attachment; filename="${safeFileName(m)}.pdf"`);
  try {
    generatePdf(m, signins, branding, res);
  } catch (e) {
    console.error('PDF generation failed', e);
    if (!res.headersSent) res.status(500).json({ error: 'pdf_failed' });
  }
});

// --- Word / DOCX export (branded) ---------------------------------------
router.get('/:id/export.docx', async (req, res) => {
  const m = getOwnedMeeting(req.params.id, req.admin.id);
  if (!m) return res.status(404).json({ error: 'not_found' });
  const signins = db.prepare('SELECT * FROM signins WHERE meeting_id = ? ORDER BY created_at ASC').all(m.id);
  const branding = getBranding(req.admin.id);
  try {
    const buf = await generateDocx(m, signins, branding);
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.set('Content-Disposition', `attachment; filename="${safeFileName(m)}.docx"`);
    res.send(buf);
  } catch (e) {
    console.error('DOCX generation failed', e);
    res.status(500).json({ error: 'docx_failed' });
  }
});

module.exports = router;
