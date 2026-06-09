'use strict';

const express = require('express');
const QRCode = require('qrcode');
const bcrypt = require('bcryptjs');
const store = require('../store');
const config = require('../config');
const auth = require('../auth');
const { randomId, uniqueSlug, clientIp, audit, publicBaseUrl, isAdmin } = require('../util');
const { normalizeFields, asString } = require('../validate');
const { isValidLatLng } = require('../geo');
const { generatePdf, generateDocx } = require('../docgen');

const router = express.Router();
router.use(auth.requireAdmin);

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function meetingUrl(slug, baseUrl) { return `${baseUrl}/m/${slug}`; }

// Fetch a meeting the actor is allowed to act on: admins → any; users → own.
async function getMeetingForActor(id, actor) {
  const m = await store.getMeetingById(id);
  if (!m) return null;
  if (isAdmin(actor) || m.owner_id === actor.id) return m;
  return null;
}

function publicShape(m, baseUrl) {
  return {
    id: m.id,
    slug: m.slug,
    ownerId: m.owner_id,
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
    notifyAttendeeEmail: !!m.notify_attendee_email,
    notifyAttendeeSms: !!m.notify_attendee_sms,
    notifyOwnerEmail: !!m.notify_owner_email,
    notifyOwnerSms: !!m.notify_owner_sms,
    ownerNotifyEmail: m.owner_notify_email || '',
    ownerNotifyPhone: m.owner_notify_phone || '',
    fields: JSON.parse(m.fields_json),
    status: m.status,
    shareUrl: meetingUrl(m.slug, baseUrl),
    createdAt: m.created_at,
    updatedAt: m.updated_at,
  };
}

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
  if (out.geofence_enabled && !isValidLatLng(lat, lng)) return { error: 'valid_location_required_for_geofence' };
  out.latitude = lat;
  out.longitude = lng;

  let radius = parseInt(body.radiusMeters, 10);
  if (!Number.isFinite(radius)) radius = existing?.radius_meters ?? 150;
  out.radius_meters = Math.max(10, Math.min(config.maxRadiusMeters, radius));

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

  // Notifications
  out.notify_attendee_email = body.notifyAttendeeEmail ? 1 : 0;
  out.notify_attendee_sms = body.notifyAttendeeSms ? 1 : 0;
  out.notify_owner_email = body.notifyOwnerEmail ? 1 : 0;
  out.notify_owner_sms = body.notifyOwnerSms ? 1 : 0;
  out.owner_notify_email = asString(body.ownerNotifyEmail, 200).trim();
  out.owner_notify_phone = asString(body.ownerNotifyPhone, 40).trim();

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

  if (body.status && ['active', 'closed', 'archived'].includes(body.status)) out.status = body.status;

  return { value: out };
}

// --- List ----------------------------------------------------------------
router.get('/', wrap(async (req, res) => {
  const baseUrl = publicBaseUrl(req);
  const admin = isAdmin(req.admin);

  const rows = admin ? await store.listAllMeetings() : await store.listMeetingsByOwner(req.admin.id);

  // For admins, attach each meeting's host (owner) name/email.
  let ownerMap = {};
  if (admin) {
    for (const a of await store.listAdmins()) ownerMap[a.id] = a;
  }

  const withCounts = [];
  for (const m of rows) {
    const shape = { ...publicShape(m, baseUrl), signinCount: await store.countSignins(m.id) };
    if (admin) {
      const o = ownerMap[m.owner_id];
      shape.ownerName = o ? (o.name || o.email) : '(unknown)';
      shape.ownerEmail = o ? o.email : '';
      shape.isOwn = m.owner_id === req.admin.id;
    }
    withCounts.push(shape);
  }
  res.json({ meetings: withCounts, scope: admin ? 'all' : 'own', role: admin ? 'admin' : 'user' });
}));

// --- Create --------------------------------------------------------------
router.post('/', auth.requireCsrf, wrap(async (req, res) => {
  const parsed = await parseMeetingInput(req.body || {}, null);
  if (parsed.error) return res.status(400).json({ error: parsed.error });

  const v = parsed.value;
  const id = randomId();
  const slug = await uniqueSlug();
  const now = Date.now();
  await store.createMeeting({
    id, slug, owner_id: req.admin.id,
    passcode_hash: v.passcode_hash ?? null,
    status: v.status || 'active',
    created_at: now, updated_at: now,
    ...v,
  });
  audit('meeting.create', { actor: req.admin.id, target: id, ip: clientIp(req) });
  res.status(201).json({ meeting: publicShape(await store.getMeetingById(id), publicBaseUrl(req)) });
}));

// --- Read ----------------------------------------------------------------
router.get('/:id', wrap(async (req, res) => {
  const m = await getMeetingForActor(req.params.id, req.admin);
  if (!m) return res.status(404).json({ error: 'not_found' });
  res.json({ meeting: publicShape(m, publicBaseUrl(req)) });
}));

// --- Update --------------------------------------------------------------
router.put('/:id', auth.requireCsrf, wrap(async (req, res) => {
  const m = await getMeetingForActor(req.params.id, req.admin);
  if (!m) return res.status(404).json({ error: 'not_found' });

  const parsed = await parseMeetingInput(req.body || {}, m);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const v = parsed.value;

  const fields = { ...v };
  fields.passcode_hash = v.passcode_hash !== undefined ? v.passcode_hash : m.passcode_hash;
  fields.status = v.status || m.status;
  fields.updated_at = Date.now();

  await store.updateMeeting(m.id, fields);
  audit('meeting.update', { actor: req.admin.id, target: m.id, ip: clientIp(req) });
  res.json({ meeting: publicShape(await store.getMeetingById(m.id), publicBaseUrl(req)) });
}));

// --- Quick open/close toggle --------------------------------------------
router.post('/:id/toggle', auth.requireCsrf, wrap(async (req, res) => {
  const m = await getMeetingForActor(req.params.id, req.admin);
  if (!m) return res.status(404).json({ error: 'not_found' });
  const next = m.is_open ? 0 : 1;
  await store.setMeetingOpen(m.id, next, Date.now());
  audit('meeting.toggle', { actor: req.admin.id, target: m.id, detail: { is_open: next } });
  res.json({ isOpen: !!next });
}));

// --- Delete --------------------------------------------------------------
router.delete('/:id', auth.requireCsrf, wrap(async (req, res) => {
  const m = await getMeetingForActor(req.params.id, req.admin);
  if (!m) return res.status(404).json({ error: 'not_found' });
  await store.deleteMeeting(m.id);
  audit('meeting.delete', { actor: req.admin.id, target: m.id, ip: clientIp(req) });
  res.json({ ok: true });
}));

// --- QR code (PNG) -------------------------------------------------------
router.get('/:id/qr.png', wrap(async (req, res) => {
  const m = await getMeetingForActor(req.params.id, req.admin);
  if (!m) return res.status(404).json({ error: 'not_found' });
  const png = await QRCode.toBuffer(meetingUrl(m.slug, publicBaseUrl(req)), {
    errorCorrectionLevel: 'M', margin: 2, width: 512, color: { dark: '#0f172a', light: '#ffffff' },
  });
  res.type('png').set('Cache-Control', 'no-store').send(png);
}));

// --- Sign-ins list -------------------------------------------------------
router.get('/:id/signins', wrap(async (req, res) => {
  const m = await getMeetingForActor(req.params.id, req.admin);
  if (!m) return res.status(404).json({ error: 'not_found' });
  const rows = await store.listSignins(m.id);
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
  res.json({ meeting: publicShape(m, publicBaseUrl(req)), signins });
}));

// --- Delete a single sign-in --------------------------------------------
router.delete('/:id/signins/:signinId', auth.requireCsrf, wrap(async (req, res) => {
  const m = await getMeetingForActor(req.params.id, req.admin);
  if (!m) return res.status(404).json({ error: 'not_found' });
  await store.deleteSignin(req.params.signinId, m.id);
  res.json({ ok: true });
}));

// --- CSV export ----------------------------------------------------------
function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  const needsGuard = /^[=+\-@\t\r]/.test(s);
  const safe = needsGuard ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
}

router.get('/:id/export.csv', wrap(async (req, res) => {
  const m = await getMeetingForActor(req.params.id, req.admin);
  if (!m) return res.status(404).json({ error: 'not_found' });
  const fields = JSON.parse(m.fields_json);
  const rows = await store.listSigninsAsc(m.id);

  const headers = ['signed_in_at', ...fields.map((f) => f.label), 'within_geofence', 'distance_meters', 'gps_accuracy_m', 'flagged', 'flag_reason'];
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
  res.send('﻿' + lines.join('\r\n'));
}));

function safeFileName(m) {
  return (m.title.replace(/[^a-z0-9]+/gi, '_').slice(0, 40) || 'meeting') + '_signins';
}

// Branding + host details for a meeting's documents: always use the MEETING
// OWNER's letterhead (so a sheet looks the same whether the owner or an admin
// exports it), and include the host's name in the header.
async function documentContext(m) {
  const branding = await store.getBranding(m.owner_id);
  const owner = await store.getAdminById(m.owner_id);
  return { branding, opts: { hostName: owner ? (owner.name || owner.email) : '' } };
}

// --- PDF export (branded) ------------------------------------------------
router.get('/:id/export.pdf', wrap(async (req, res) => {
  const m = await getMeetingForActor(req.params.id, req.admin);
  if (!m) return res.status(404).json({ error: 'not_found' });
  const signins = await store.listSigninsAsc(m.id);
  const { branding, opts } = await documentContext(m);
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `attachment; filename="${safeFileName(m)}.pdf"`);
  generatePdf(m, signins, branding, res, opts);
}));

// --- Word / DOCX export (branded) ---------------------------------------
router.get('/:id/export.docx', wrap(async (req, res) => {
  const m = await getMeetingForActor(req.params.id, req.admin);
  if (!m) return res.status(404).json({ error: 'not_found' });
  const signins = await store.listSigninsAsc(m.id);
  const { branding, opts } = await documentContext(m);
  const buf = await generateDocx(m, signins, branding, opts);
  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.set('Content-Disposition', `attachment; filename="${safeFileName(m)}.docx"`);
  res.send(buf);
}));

module.exports = router;
