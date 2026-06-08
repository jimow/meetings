'use strict';

const express = require('express');
const store = require('../store');
const auth = require('../auth');
const { asString } = require('../validate');
const { imageSize } = require('../imagesize');
const { audit } = require('../util');

const router = express.Router();
router.use(auth.requireAdmin);

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function shape(b) {
  return {
    orgName: b?.org_name || '',
    address: b?.address || '',
    contact: b?.contact || '',
    footerText: b?.footer_text || '',
    hasLogo: !!(b && b.logo_data),
  };
}

// --- Read ----------------------------------------------------------------
router.get('/', wrap(async (req, res) => {
  res.json({ branding: shape(await store.getBranding(req.admin.id)) });
}));

// --- Update text fields --------------------------------------------------
router.put('/', auth.requireCsrf, wrap(async (req, res) => {
  await store.upsertBrandingText(req.admin.id, {
    org_name: asString(req.body?.orgName, 160).trim(),
    address: asString(req.body?.address, 300).trim(),
    contact: asString(req.body?.contact, 200).trim(),
    footer_text: asString(req.body?.footerText, 300).trim(),
    updated_at: Date.now(),
  });
  audit('branding.update', { actor: req.admin.id });
  res.json({ branding: shape(await store.getBranding(req.admin.id)) });
}));

// --- Upload logo (base64 data URL; PNG or JPEG, <=1MB) -------------------
const logoParser = express.json({ limit: '2mb' });
router.post('/logo', logoParser, auth.requireCsrf, wrap(async (req, res) => {
  const m = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)$/.exec(req.body?.dataUrl || '');
  if (!m) return res.status(400).json({ error: 'invalid_image', detail: 'Upload a PNG or JPEG image.' });

  const buf = Buffer.from(m[2], 'base64');
  if (buf.length === 0) return res.status(400).json({ error: 'invalid_image' });
  if (buf.length > 1024 * 1024) return res.status(413).json({ error: 'image_too_large', detail: 'Logo must be under 1 MB.' });

  const size = imageSize(buf);
  if (!size) return res.status(400).json({ error: 'invalid_image', detail: 'Could not read image dimensions.' });

  await store.upsertBrandingLogo(req.admin.id, {
    logo_data: buf, logo_mime: m[1], logo_w: size.width, logo_h: size.height, updated_at: Date.now(),
  });
  audit('branding.logo_upload', { actor: req.admin.id, detail: { bytes: buf.length } });
  res.json({ ok: true });
}));

// --- Remove logo ---------------------------------------------------------
router.delete('/logo', auth.requireCsrf, wrap(async (req, res) => {
  await store.clearBrandingLogo(req.admin.id);
  res.json({ ok: true });
}));

// --- Serve logo (admin preview) -----------------------------------------
router.get('/logo.png', wrap(async (req, res) => {
  const b = await store.getBranding(req.admin.id);
  if (!b || !b.logo_data) return res.status(404).end();
  res.type(b.logo_mime || 'image/png').set('Cache-Control', 'no-store').send(Buffer.from(b.logo_data));
}));

module.exports = { router };
