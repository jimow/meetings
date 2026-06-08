'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const store = require('../store');
const notify = require('../notify');
const { randomId, clientIp, audit } = require('../util');
const { validateSubmission } = require('../validate');
const { evaluateGeofence } = require('../geo');

const router = express.Router();

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const signinLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_requests' },
});

function attendeeShape(m) {
  return {
    slug: m.slug,
    title: m.title,
    description: m.description,
    locationName: m.location_name,
    venue: m.venue || '',
    geofenceEnabled: !!m.geofence_enabled,
    radiusMeters: m.radius_meters,
    maxAccuracyMeters: m.max_accuracy_meters,
    hasPasscode: !!m.passcode_hash,
    requireLocation: !!m.geofence_enabled,
    fields: JSON.parse(m.fields_json),
  };
}

function windowState(m) {
  const now = Date.now();
  if (m.status !== 'active') return { open: false, reason: 'meeting_closed' };
  if (!m.is_open) return { open: false, reason: 'meeting_closed' };
  if (m.starts_at && now < m.starts_at) return { open: false, reason: 'not_started', startsAt: m.starts_at };
  if (m.ends_at && now > m.ends_at) return { open: false, reason: 'ended', endsAt: m.ends_at };
  return { open: true };
}

// --- Public meeting info -------------------------------------------------
router.get('/meetings/:slug', wrap(async (req, res) => {
  const m = await store.getMeetingBySlug(req.params.slug);
  if (!m) return res.status(404).json({ error: 'not_found' });
  const ws = windowState(m);
  res.json({ meeting: attendeeShape(m), open: ws.open, windowReason: ws.reason, startsAt: m.starts_at, endsAt: m.ends_at });
}));

// --- Submit a sign-in ----------------------------------------------------
router.post('/meetings/:slug/signin', signinLimiter, wrap(async (req, res) => {
  const m = await store.getMeetingBySlug(req.params.slug);
  if (!m) return res.status(404).json({ error: 'not_found' });

  const ws = windowState(m);
  if (!ws.open) return res.status(403).json({ error: ws.reason, detail: 'This sign-in sheet is not currently accepting entries.' });

  const body = req.body || {};

  // 1) Passcode gate.
  if (m.passcode_hash) {
    const pc = String(body.passcode || '');
    const ok = pc && (await bcrypt.compare(pc, m.passcode_hash));
    if (!ok) {
      audit('signin.bad_passcode', { target: m.id, ip: clientIp(req) });
      return res.status(401).json({ error: 'invalid_passcode' });
    }
  }

  // 2) Field validation.
  const fields = JSON.parse(m.fields_json);
  const vr = validateSubmission(fields, body.fields);
  if (!vr.ok) return res.status(400).json({ error: 'validation_failed', detail: vr.error });

  // 3) Geofence — authoritative, server-side.
  const point = {
    lat: Number(body.latitude),
    lng: Number(body.longitude),
    accuracy: body.accuracy != null ? Number(body.accuracy) : NaN,
  };
  const geo = evaluateGeofence(m, point);
  if (!geo.allowed) {
    audit('signin.geofence_denied', { target: m.id, ip: clientIp(req), detail: { reason: geo.reason } });
    return res.status(403).json({ error: 'geofence_denied', reason: geo.reason, detail: geo.detail });
  }

  // 4) Duplicate prevention.
  const deviceHash = typeof body.deviceHash === 'string' ? body.deviceHash.slice(0, 128) : null;
  if (m.require_unique_email && vr.email && (await store.signinExistsByEmail(m.id, vr.email))) {
    return res.status(409).json({ error: 'already_signed_in', detail: 'This email has already signed in.' });
  }
  if (m.limit_one_per_device && deviceHash && (await store.signinExistsByDevice(m.id, deviceHash))) {
    return res.status(409).json({ error: 'already_signed_in', detail: 'This device has already signed in.' });
  }

  // 5) Store.
  const id = randomId();
  await store.createSignin({
    id, meeting_id: m.id, data_json: JSON.stringify(vr.data), email: vr.email || null,
    latitude: Number.isFinite(point.lat) ? point.lat : null,
    longitude: Number.isFinite(point.lng) ? point.lng : null,
    accuracy: Number.isFinite(point.accuracy) ? point.accuracy : null,
    distance_meters: geo.distance != null ? geo.distance : null,
    within_geofence: geo.allowed && (m.geofence_enabled ? 1 : 0),
    ip: m.collect_ip ? clientIp(req) : null,
    user_agent: (req.get('user-agent') || '').slice(0, 300),
    device_hash: deviceHash,
    flagged: geo.flagged ? 1 : 0,
    flag_reason: geo.flagReason || null,
    created_at: Date.now(),
  });

  audit('signin.success', { target: m.id, ip: clientIp(req), detail: { flagged: geo.flagged, distance: geo.distance != null ? Math.round(geo.distance) : null } });

  // 6) Fire notifications (best-effort, non-blocking).
  if (m.notify_attendee_email || m.notify_attendee_sms || m.notify_owner_email || m.notify_owner_sms) {
    (async () => {
      try {
        const owner = await store.getAdminById(m.owner_id);
        const branding = await store.getBranding(m.owner_id);
        await notify.handleSignin({ meeting: m, fields, data: vr.data, branding, owner });
      } catch (e) {
        console.error('notification dispatch failed', e.message);
      }
    })();
  }

  res.status(201).json({ ok: true, flagged: geo.flagged });
}));

module.exports = router;
