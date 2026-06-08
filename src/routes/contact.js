'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const store = require('../store');
const notify = require('../notify');
const { randomId, clientIp, audit } = require('../util');
const { isEmail, asString } = require('../validate');

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const contactLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10, // 10 messages per IP per hour
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_requests' },
});

router.post('/', contactLimiter, wrap(async (req, res) => {
  const body = req.body || {};

  // Honeypot: bots fill hidden fields; humans leave them empty.
  if (asString(body.website, 100).trim() !== '') {
    return res.json({ ok: true }); // silently accept + drop
  }

  const name = asString(body.name, 120).trim();
  const email = asString(body.email, 200).trim().toLowerCase();
  const phone = asString(body.phone, 40).trim();
  const subject = asString(body.subject, 160).trim();
  const message = asString(body.message, 4000).trim();

  if (!name) return res.status(400).json({ error: 'name_required' });
  if (!isEmail(email)) return res.status(400).json({ error: 'invalid_email' });
  if (message.length < 5) return res.status(400).json({ error: 'message_required' });

  const id = randomId();
  await store.createContactMessage({ id, name, email, phone: phone || null, subject: subject || null, message, ip: clientIp(req), created_at: Date.now() });
  audit('contact.message', { target: id, ip: clientIp(req), detail: { email } });

  // Forward to the configured county inbox (best-effort).
  const to = process.env.CONTACT_TO;
  if (to && notify.emailEnabled()) {
    notify.sendEmail({
      to,
      subject: `[Website contact] ${subject || 'New message'} — from ${name}`,
      text: `Name: ${name}\nEmail: ${email}\nPhone: ${phone || '—'}\n\n${message}`,
      html: `<div style="font-family:Arial,sans-serif">
        <p><strong>Name:</strong> ${name}<br><strong>Email:</strong> ${email}<br><strong>Phone:</strong> ${phone || '—'}</p>
        <p><strong>Subject:</strong> ${subject || '—'}</p>
        <p style="white-space:pre-wrap">${message.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</p>
      </div>`,
    }).catch(() => {});
  }

  res.status(201).json({ ok: true });
}));

module.exports = router;
