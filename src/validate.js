'use strict';

const FIELD_TYPES = ['text', 'email', 'tel', 'number', 'textarea', 'select', 'checkbox', 'date'];
const KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function asString(v, max = 2000) {
  if (v === null || v === undefined) return '';
  return String(v).slice(0, max);
}

function isEmail(v) {
  return EMAIL_RE.test(String(v || '').trim());
}

/**
 * Validate & normalize an admin-supplied field definition list.
 * Returns { ok, fields, error }.
 */
function normalizeFields(raw) {
  if (!Array.isArray(raw)) return { ok: false, error: 'fields_must_be_array' };
  if (raw.length > 30) return { ok: false, error: 'too_many_fields' };

  const seen = new Set();
  const fields = [];
  for (const f of raw) {
    if (!f || typeof f !== 'object') return { ok: false, error: 'invalid_field' };
    const key = asString(f.key, 40).trim();
    const label = asString(f.label, 120).trim();
    const type = asString(f.type, 20).trim();

    if (!KEY_RE.test(key)) return { ok: false, error: `invalid_field_key:${key}` };
    if (seen.has(key)) return { ok: false, error: `duplicate_field_key:${key}` };
    seen.add(key);
    if (!label) return { ok: false, error: `field_label_required:${key}` };
    if (!FIELD_TYPES.includes(type)) return { ok: false, error: `invalid_field_type:${type}` };

    const field = {
      key,
      label,
      type,
      required: !!f.required,
      placeholder: asString(f.placeholder, 120),
    };
    if (type === 'select') {
      const options = Array.isArray(f.options)
        ? f.options.map((o) => asString(o, 120).trim()).filter(Boolean).slice(0, 50)
        : [];
      if (options.length === 0) return { ok: false, error: `select_needs_options:${key}` };
      field.options = options;
    }
    fields.push(field);
  }
  return { ok: true, fields };
}

/**
 * Validate a public submission against the meeting's field definitions.
 * Returns { ok, data, email, error }.
 */
function validateSubmission(fields, body) {
  const data = {};
  let email = null;
  const input = body && typeof body === 'object' ? body : {};

  for (const f of fields) {
    let value = input[f.key];

    if (f.type === 'checkbox') {
      value = value === true || value === 'true' || value === 'on' || value === 1 || value === '1';
      if (f.required && !value) return { ok: false, error: `required:${f.key}` };
      data[f.key] = value;
      continue;
    }

    value = asString(value, f.type === 'textarea' ? 4000 : 500).trim();

    if (!value) {
      if (f.required) return { ok: false, error: `required:${f.key}` };
      data[f.key] = '';
      continue;
    }

    switch (f.type) {
      case 'email':
        if (!isEmail(value)) return { ok: false, error: `invalid_email:${f.key}` };
        if (!email) email = value.toLowerCase();
        break;
      case 'number':
        if (!/^-?\d+(\.\d+)?$/.test(value)) return { ok: false, error: `invalid_number:${f.key}` };
        break;
      case 'tel':
        if (!/^[+()\-\s\d]{4,20}$/.test(value)) return { ok: false, error: `invalid_tel:${f.key}` };
        break;
      case 'date':
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return { ok: false, error: `invalid_date:${f.key}` };
        break;
      case 'select':
        if (!f.options.includes(value)) return { ok: false, error: `invalid_option:${f.key}` };
        break;
      default:
        break; // text / textarea
    }
    data[f.key] = value;
  }

  // Fallback: if no explicit email field, look for one to support unique-email enforcement.
  if (!email) {
    for (const f of fields) {
      if (f.type === 'email' && data[f.key]) { email = String(data[f.key]).toLowerCase(); break; }
    }
  }
  return { ok: true, data, email };
}

module.exports = { FIELD_TYPES, normalizeFields, validateSubmission, isEmail, asString };
