'use strict';

// Outbound notifications: email via Resend, SMS via Africa's Talking.
// Both use the global fetch (Node 18+) — no SDKs required. All sends are
// best-effort: failures are logged but never block a sign-in.

const config = require('./config');

const RESEND_API = 'https://api.resend.com/emails';

function emailEnabled() { return !!process.env.RESEND_API_KEY && !!process.env.RESEND_FROM; }
function smsEnabled() { return !!process.env.AT_API_KEY && !!process.env.AT_USERNAME; }

function atEndpoint() {
  return (process.env.AT_USERNAME === 'sandbox')
    ? 'https://api.sandbox.africastalking.com/version1/messaging'
    : 'https://api.africastalking.com/version1/messaging';
}

// Normalize a Kenyan phone number to E.164 (+2547XXXXXXXX). Returns null if implausible.
function normalizeKenyanPhone(raw) {
  if (!raw) return null;
  let s = String(raw).replace(/[^\d+]/g, '');
  if (s.startsWith('+')) return /^\+\d{9,15}$/.test(s) ? s : null;
  if (s.startsWith('254')) s = '+' + s;
  else if (s.startsWith('0')) s = '+254' + s.slice(1);
  else if (s.startsWith('7') || s.startsWith('1')) s = '+254' + s; // bare 7.../1... mobile
  else return null;
  return /^\+254\d{9}$/.test(s) ? s : null;
}

async function sendEmail({ to, subject, html, text }) {
  if (!emailEnabled()) return { skipped: 'email_not_configured' };
  if (!to) return { skipped: 'no_recipient' };
  try {
    const res = await fetch(RESEND_API, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: process.env.RESEND_FROM, to: [to], subject, html, text }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error('Resend send failed', res.status, body.slice(0, 300));
      return { ok: false, status: res.status };
    }
    return { ok: true };
  } catch (e) {
    console.error('Resend error', e.message);
    return { ok: false, error: e.message };
  }
}

async function sendSms({ to, message }) {
  if (!smsEnabled()) return { skipped: 'sms_not_configured' };
  const phone = normalizeKenyanPhone(to);
  if (!phone) return { skipped: 'invalid_phone' };
  try {
    const form = new URLSearchParams();
    form.set('username', process.env.AT_USERNAME);
    form.set('to', phone);
    form.set('message', message);
    if (process.env.AT_SENDER_ID) form.set('from', process.env.AT_SENDER_ID);
    const res = await fetch(atEndpoint(), {
      method: 'POST',
      headers: { apiKey: process.env.AT_API_KEY, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: form.toString(),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error('Africa\'s Talking send failed', res.status, body.slice(0, 300));
      return { ok: false, status: res.status };
    }
    return { ok: true };
  } catch (e) {
    console.error('Africa\'s Talking error', e.message);
    return { ok: false, error: e.message };
  }
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// Pull the attendee's email + phone out of the submitted data using the field defs.
function extractContact(fields, data) {
  let email = null;
  let phone = null;
  for (const f of fields) {
    const v = data[f.key];
    if (!v) continue;
    if (f.type === 'email' && !email) email = String(v);
    if (f.type === 'tel' && !phone) phone = String(v);
  }
  return { email, phone };
}

function attendeeName(fields, data) {
  // Prefer a field whose key/label looks like a name.
  for (const f of fields) {
    if (/name/i.test(f.key) || /name/i.test(f.label)) {
      if (data[f.key]) return String(data[f.key]);
    }
  }
  return 'there';
}

/**
 * Orchestrate notifications for a successful sign-in. Best-effort, non-blocking.
 * `owner` = { email, name } of the meeting owner.
 */
async function handleSignin({ meeting, fields, data, branding, owner }) {
  const org = (branding && branding.org_name) || 'Meeting Signs';
  const { email: attendeeEmail, phone: attendeePhone } = extractContact(fields, data);
  const name = attendeeName(fields, data);
  const when = new Date().toLocaleString();
  const tasks = [];

  // --- Attendee confirmation: email ---
  if (meeting.notify_attendee_email && attendeeEmail) {
    tasks.push(sendEmail({
      to: attendeeEmail,
      subject: `Sign-in confirmed: ${meeting.title}`,
      text: `Hi ${name},\n\nYour attendance at "${meeting.title}" has been recorded on ${when}.\n\n${org}`,
      html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto">
        <h2 style="color:#0b6b3a">Attendance confirmed</h2>
        <p>Hi ${esc(name)},</p>
        <p>Your attendance at <strong>${esc(meeting.title)}</strong> has been recorded on <strong>${esc(when)}</strong>.</p>
        ${meeting.venue ? `<p>Venue: ${esc(meeting.venue)}</p>` : ''}
        <p style="color:#64748b;font-size:13px;margin-top:24px">${esc(org)}</p>
      </div>`,
    }));
  }

  // --- Attendee confirmation: SMS ---
  if (meeting.notify_attendee_sms && attendeePhone) {
    tasks.push(sendSms({
      to: attendeePhone,
      message: `${org}: Your attendance at "${meeting.title}" is confirmed (${when}).`,
    }));
  }

  // --- Owner alert: email ---
  const ownerEmail = meeting.owner_notify_email || owner?.email;
  if (meeting.notify_owner_email && ownerEmail) {
    tasks.push(sendEmail({
      to: ownerEmail,
      subject: `New sign-in: ${meeting.title}`,
      text: `${name} (${attendeeEmail || 'no email'}) just signed in to "${meeting.title}" at ${when}.`,
      html: `<div style="font-family:Arial,sans-serif">
        <p><strong>${esc(name)}</strong> just signed in to <strong>${esc(meeting.title)}</strong>.</p>
        <p>Time: ${esc(when)}<br>Email: ${esc(attendeeEmail || '—')}<br>Phone: ${esc(attendeePhone || '—')}</p>
      </div>`,
    }));
  }

  // --- Owner alert: SMS ---
  if (meeting.notify_owner_sms && meeting.owner_notify_phone) {
    tasks.push(sendSms({
      to: meeting.owner_notify_phone,
      message: `${org}: ${name} signed in to "${meeting.title}" (${when}).`,
    }));
  }

  const results = await Promise.allSettled(tasks);
  return results;
}

module.exports = { sendEmail, sendSms, handleSignin, normalizeKenyanPhone, emailEnabled, smsEnabled, extractContact };
