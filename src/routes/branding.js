'use strict';

const express = require('express');
const db = require('../db');
const auth = require('../auth');
const { asString } = require('../validate');
const { imageSize } = require('../imagesize');
const { audit } = require('../util');

const router = express.Router();
router.use(auth.requireAdmin);

function getBranding(ownerId) {
  return db.prepare('SELECT * FROM org_settings WHERE owner_id = ?').get(ownerId);
}
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
router.get('/', (req, res) => {
  res.json({ branding: shape(getBranding(req.admin.id)) });
});

// --- Update text fields --------------------------------------------------
router.put('/', auth.requireCsrf, (req, res) => {
  const orgName = asString(req.body?.orgName, 160).trim();
  const address = asString(req.body?.address, 300).trim();
  const contact = asString(req.body?.contact, 200).trim();
  const footerText = asString(req.body?.footerText, 300).trim();
  const now = Date.now();

  const existing = getBranding(req.admin.id);
  if (existing) {
    db.prepare('UPDATE org_settings SET org_name=?, address=?, contact=?, footer_text=?, updated_at=? WHERE owner_id=?')
      .run(orgName, address, contact, footerText, now, req.admin.id);
  } else {
    db.prepare('INSERT INTO org_settings (owner_id, org_name, address, contact, footer_text, updated_at) VALUES (?,?,?,?,?,?)')
      .run(req.admin.id, orgName, address, contact, footerText, now);
  }
  audit('branding.update', { actor: req.admin.id });
  res.json({ branding: shape(getBranding(req.admin.id)) });
});

// --- Upload logo (base64 data URL; PNG or JPEG, <=1MB) -------------------
const logoParser = express.json({ limit: '2mb' });
router.post('/logo', logoParser, auth.requireCsrf, (req, res) => {
  const m = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)$/.exec(req.body?.dataUrl || '');
  if (!m) return res.status(400).json({ error: 'invalid_image', detail: 'Upload a PNG or JPEG image.' });

  const buf = Buffer.from(m[2], 'base64');
  if (buf.length === 0) return res.status(400).json({ error: 'invalid_image' });
  if (buf.length > 1024 * 1024) return res.status(413).json({ error: 'image_too_large', detail: 'Logo must be under 1 MB.' });

  const size = imageSize(buf);
  if (!size) return res.status(400).json({ error: 'invalid_image', detail: 'Could not read image dimensions.' });

  const now = Date.now();
  const existing = getBranding(req.admin.id);
  if (existing) {
    db.prepare('UPDATE org_settings SET logo_data=?, logo_mime=?, logo_w=?, logo_h=?, updated_at=? WHERE owner_id=?')
      .run(buf, m[1], size.width, size.height, now, req.admin.id);
  } else {
    db.prepare('INSERT INTO org_settings (owner_id, logo_data, logo_mime, logo_w, logo_h, updated_at) VALUES (?,?,?,?,?,?)')
      .run(req.admin.id, buf, m[1], size.width, size.height, now);
  }
  audit('branding.logo_upload', { actor: req.admin.id, detail: { bytes: buf.length } });
  res.json({ ok: true });
});

// --- Remove logo ---------------------------------------------------------
router.delete('/logo', auth.requireCsrf, (req, res) => {
  db.prepare('UPDATE org_settings SET logo_data=NULL, logo_mime=NULL, logo_w=NULL, logo_h=NULL WHERE owner_id=?')
    .run(req.admin.id);
  res.json({ ok: true });
});

// --- Serve logo (admin preview) -----------------------------------------
router.get('/logo.png', (req, res) => {
  const b = getBranding(req.admin.id);
  if (!b || !b.logo_data) return res.status(404).end();
  res.type(b.logo_mime || 'image/png').set('Cache-Control', 'no-store').send(Buffer.from(b.logo_data));
});

module.exports = { router, getBranding };
