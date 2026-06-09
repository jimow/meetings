'use strict';

(function () {
  const $ = (id) => document.getElementById(id);
  const show = (id) => $(id).classList.remove('hidden');
  const hide = (id) => $(id).classList.add('hidden');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const state = { admin: null, csrf: null, editingId: null, needsBootstrap: false, currentMeeting: null, branding: null, openRegistration: false, authMode: 'login' };

  async function loadBranding() {
    const { json } = await api('GET', '/branding');
    state.branding = json?.branding || null;
    return state.branding;
  }

  // --- API helper ----------------------------------------------------------
  async function api(method, path, body) {
    const opts = { method, headers: {} };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    if (method !== 'GET' && state.csrf) opts.headers['X-CSRF-Token'] = state.csrf;
    const res = await fetch('/api' + path, opts);
    let json = null;
    try { json = await res.json(); } catch { /* non-json (e.g. csv/png) */ }
    if (res.status === 401 && state.admin) { state.admin = null; renderAuthNav(); showAuth(); }
    return { ok: res.ok, status: res.status, json };
  }

  function fmt(ts) { try { return new Date(ts).toLocaleString(); } catch { return ''; } }
  function fmtLocalInput(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function parseLocalInput(v) { return v ? new Date(v).getTime() : null; }

  // --- View switching ------------------------------------------------------
  function hideAll() { ['view-auth', 'view-list', 'view-editor', 'view-detail', 'view-branding', 'view-users'].forEach(hide); }

  function isAdminRole() { return state.admin && (state.admin.role === 'admin' || state.admin.role === 'owner'); }

  function renderAuthNav() {
    const nav = $('nav-auth');
    if (state.admin) {
      nav.innerHTML = `<span class="small">${esc(state.admin.name || state.admin.email)}</span>
        <button id="logout-btn" class="btn btn-ghost btn-sm">Log out</button>`;
      $('logout-btn').onclick = logout;
    } else {
      nav.innerHTML = '';
    }
  }

  // --- AUTH ----------------------------------------------------------------
  function showAuth() {
    hideAll();
    const isBootstrap = state.needsBootstrap;
    const registering = isBootstrap || state.authMode === 'register';
    $('auth-title').textContent = isBootstrap ? 'Create admin account' : (registering ? 'Create your account' : 'Staff sign in');
    $('auth-sub').textContent = isBootstrap
      ? 'No admin exists yet. Create the first administrator account to get started.'
      : (registering ? 'Register to create and manage your own meetings.' : 'Sign in to manage your meeting sign-in sheets.');
    $('name-field').classList.toggle('hidden', !registering);
    $('pw-hint').textContent = registering ? 'Minimum 10 characters.' : '';
    $('auth-password').autocomplete = registering ? 'new-password' : 'current-password';
    $('auth-submit').textContent = registering ? 'Create account' : 'Sign in';

    // Toggle between sign-in and self-registration (only when open registration is on).
    const toggle = $('auth-toggle');
    if (isBootstrap || !state.openRegistration) {
      toggle.classList.add('hidden');
    } else {
      toggle.classList.remove('hidden');
      toggle.innerHTML = registering
        ? 'Already have an account? <a href="#" id="auth-toggle-link">Sign in</a>'
        : 'Need an account? <a href="#" id="auth-toggle-link">Create one</a>';
      $('auth-toggle-link').onclick = (ev) => { ev.preventDefault(); state.authMode = registering ? 'login' : 'register'; showAuth(); };
    }
    show('view-auth');
  }

  async function handleAuthSubmit(e) {
    e.preventDefault();
    const banner = $('auth-banner');
    banner.className = 'banner hidden';
    const email = $('auth-email').value.trim();
    const password = $('auth-password').value;
    const name = $('auth-name').value.trim();
    const registering = state.needsBootstrap || state.authMode === 'register';
    const path = registering ? '/auth/register' : '/auth/login';
    const payload = registering ? { email, password, name } : { email, password };

    const { ok, json } = await api('POST', path, payload);
    if (!ok) {
      const msgs = {
        invalid_credentials: 'Incorrect email or password.',
        weak_password: json.detail || 'Password too weak.',
        email_in_use: 'That email is already registered.',
        account_locked: json.detail || 'Account temporarily locked.',
        too_many_attempts: 'Too many attempts. Wait a few minutes.',
        registration_closed: 'Registration is closed. Ask an existing admin to add you.',
      };
      banner.textContent = msgs[json?.error] || 'Could not sign in.';
      banner.className = 'banner err';
      return;
    }
    // Self-registration (non-bootstrap) creates the account but does not log in.
    if (registering && !json.csrfToken) {
      state.authMode = 'login';
      showAuth();
      banner.textContent = 'Account created. Please sign in with your new credentials.';
      banner.className = 'banner ok';
      $('auth-email').value = email;
      return;
    }

    state.admin = json.admin;
    state.csrf = json.csrfToken;
    state.needsBootstrap = false;
    renderAuthNav();
    await loadBranding();
    await showList();
  }

  async function logout() {
    await api('POST', '/auth/logout');
    state.admin = null; state.csrf = null;
    renderAuthNav();
    await boot();
  }

  // --- LIST ----------------------------------------------------------------
  async function showList() {
    hideAll();
    const { json } = await api('GET', '/meetings');
    const meetings = json?.meetings || [];
    const admin = isAdminRole();

    $('list-title').textContent = admin ? 'All meetings (admin view)' : 'Your meetings';
    $('users-btn').classList.toggle('hidden', !admin);

    const grid = $('meetings-grid');
    grid.innerHTML = '';
    $('list-empty').classList.toggle('hidden', meetings.length > 0);

    for (const m of meetings) {
      const card = document.createElement('div');
      card.className = 'card';
      const statusBadge = m.isOpen && m.status === 'active'
        ? '<span class="badge ok">● Open</span>'
        : '<span class="badge danger">● Closed</span>';
      const geoBadge = m.geofenceEnabled ? `<span class="badge brand">🛡️ ${m.radiusMeters}m</span>` : '<span class="badge">No geofence</span>';
      const hostLine = admin
        ? `<p class="muted small" style="margin:.25rem 0 0">👤 Host: ${esc(m.ownerName || '')}${m.isOwn ? ' <span class="badge brand">you</span>' : ''}</p>`
        : '';
      card.innerHTML = `
        <div class="spread"><h2 style="margin:0">${esc(m.title)}</h2></div>
        <div class="row" style="margin:.5rem 0">${statusBadge} ${geoBadge} <span class="badge">${m.signinCount} signed in</span></div>
        <p class="muted small" style="margin:0">${esc(m.locationName || '')}</p>
        ${hostLine}
        <div class="row" style="margin-top:.75rem">
          <button class="btn btn-sm" data-open="${m.id}">Open</button>
          <button class="btn btn-ghost btn-sm" data-edit="${m.id}">Edit</button>
        </div>`;
      grid.appendChild(card);
    }
    grid.querySelectorAll('[data-open]').forEach((b) => (b.onclick = () => showDetail(b.dataset.open)));
    grid.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => showEditor(b.dataset.edit)));

    await loadSessions();
    show('view-list');
  }

  // --- USERS (admin only) --------------------------------------------------
  async function showUsers() {
    hideAll();
    $('users-banner').className = 'banner hidden';
    await loadUsers();
    show('view-users');
  }

  function usersBanner(msg, kind) {
    const el = $('users-banner');
    el.textContent = msg; el.className = 'banner ' + kind;
    if (kind === 'ok') setTimeout(() => { el.className = 'banner hidden'; }, 2500);
  }

  async function loadUsers() {
    const { json } = await api('GET', '/users');
    const wrap = $('users-list');
    const users = json?.users || [];
    let html = '<table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Meetings</th><th></th></tr></thead><tbody>';
    for (const u of users) {
      const roleBadge = u.role === 'admin' ? '<span class="badge brand">admin</span>' : '<span class="badge">user</span>';
      html += `<tr>
        <td>${esc(u.name || '—')}${u.isSelf ? ' <span class="badge ok">you</span>' : ''}</td>
        <td class="small">${esc(u.email)}</td>
        <td>${roleBadge}</td>
        <td>${u.meetingCount}</td>
        <td>${u.isSelf ? '' : `
          <button class="btn btn-ghost btn-sm" data-role="${u.id}" data-newrole="${u.role === 'admin' ? 'user' : 'admin'}">Make ${u.role === 'admin' ? 'user' : 'admin'}</button>
          <button class="btn btn-danger btn-sm" data-deluser="${u.id}">Delete</button>`}</td>
      </tr>`;
    }
    html += '</tbody></table>';
    wrap.innerHTML = html;
    wrap.querySelectorAll('[data-deluser]').forEach((b) => (b.onclick = () => deleteUser(b.dataset.deluser)));
    wrap.querySelectorAll('[data-role]').forEach((b) => (b.onclick = () => changeRole(b.dataset.role, b.dataset.newrole)));
  }

  async function addUser(e) {
    e.preventDefault();
    const payload = {
      name: $('nu-name').value.trim(),
      email: $('nu-email').value.trim(),
      password: $('nu-pass').value,
      role: $('nu-role').value,
    };
    const { ok, json } = await api('POST', '/users', payload);
    if (ok) {
      $('user-form').reset();
      usersBanner('User created: ' + json.user.email, 'ok');
      loadUsers();
    } else {
      const msgs = { invalid_email: 'Enter a valid email.', weak_password: 'Password must be at least 10 characters.', email_in_use: 'That email is already registered.' };
      usersBanner(msgs[json?.error] || 'Could not create user.', 'err');
    }
  }

  async function deleteUser(id) {
    if (!confirm('Delete this user and ALL of their meetings and sign-ins? This cannot be undone.')) return;
    const { ok, json } = await api('DELETE', '/users/' + id);
    if (ok) { usersBanner('User deleted.', 'ok'); loadUsers(); }
    else usersBanner(json?.error === 'last_admin' ? 'Cannot delete the last admin.' : 'Could not delete user.', 'err');
  }

  async function changeRole(id, newRole) {
    const { ok, json } = await api('PATCH', '/users/' + id + '/role', { role: newRole });
    if (ok) loadUsers();
    else usersBanner(json?.error === 'last_admin' ? 'Cannot demote the last admin.' : 'Could not change role.', 'err');
  }

  async function loadSessions() {
    const { json } = await api('GET', '/auth/sessions');
    const wrap = $('sessions-list');
    const sessions = json?.sessions || [];
    let html = '<table><thead><tr><th>Started</th><th>IP</th><th>Device</th><th></th></tr></thead><tbody>';
    for (const s of sessions) {
      html += `<tr>
        <td>${fmt(s.created_at)} ${s.current ? '<span class="badge ok">this device</span>' : ''}</td>
        <td class="mono small">${esc(s.ip || '')}</td>
        <td class="small">${esc((s.user_agent || '').slice(0, 40))}</td>
        <td>${s.current ? '' : `<button class="btn btn-danger btn-sm" data-revoke="${s.id}">Revoke</button>`}</td>
      </tr>`;
    }
    html += '</tbody></table>';
    wrap.innerHTML = html;
    wrap.querySelectorAll('[data-revoke]').forEach((b) => (b.onclick = async () => {
      await api('DELETE', '/auth/sessions/' + b.dataset.revoke);
      loadSessions();
    }));
  }

  // --- FIELD BUILDER -------------------------------------------------------
  const FIELD_TYPES = ['text', 'email', 'tel', 'number', 'textarea', 'select', 'checkbox', 'date'];

  function addFieldRow(f) {
    f = f || { key: '', label: '', type: 'text', required: false, options: [], placeholder: '' };
    const list = $('fields-list');
    const row = document.createElement('div');
    row.className = 'field-editor';
    row.innerHTML = `
      <div class="row">
        <div class="grow"><label class="small">Label</label><input type="text" data-f="label" placeholder="Full name" value="${esc(f.label)}" /></div>
        <div class="grow"><label class="small">Key</label><input type="text" data-f="key" placeholder="full_name" value="${esc(f.key)}" /></div>
        <div class="grow"><label class="small">Type</label>
          <select data-f="type">${FIELD_TYPES.map((t) => `<option value="${t}" ${t === f.type ? 'selected' : ''}>${t}</option>`).join('')}</select>
        </div>
      </div>
      <div class="row" style="margin-top:.5rem">
        <div class="grow"><label class="small">Placeholder</label><input type="text" data-f="placeholder" value="${esc(f.placeholder || '')}" /></div>
        <div class="grow opts-wrap ${f.type === 'select' ? '' : 'hidden'}"><label class="small">Options (comma-separated)</label><input type="text" data-f="options" value="${esc((f.options || []).join(', '))}" /></div>
        <div class="check" style="margin-top:1.2rem"><input type="checkbox" data-f="required" ${f.required ? 'checked' : ''} /><label class="small">Required</label></div>
        <button type="button" class="btn btn-danger btn-sm" data-remove style="margin-top:1rem">Remove</button>
      </div>`;
    list.appendChild(row);
    const typeSel = row.querySelector('[data-f="type"]');
    typeSel.onchange = () => row.querySelector('.opts-wrap').classList.toggle('hidden', typeSel.value !== 'select');
    // Auto-generate key from label if key empty
    const labelInput = row.querySelector('[data-f="label"]');
    const keyInput = row.querySelector('[data-f="key"]');
    labelInput.oninput = () => {
      if (!keyInput.dataset.touched) {
        keyInput.value = labelInput.value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'field';
      }
    };
    keyInput.oninput = () => { keyInput.dataset.touched = '1'; };
    row.querySelector('[data-remove]').onclick = () => row.remove();
  }

  function collectFieldRows() {
    const rows = [...document.querySelectorAll('#fields-list .field-editor')];
    return rows.map((r) => {
      const get = (k) => r.querySelector(`[data-f="${k}"]`);
      const type = get('type').value;
      const f = {
        key: get('key').value.trim(),
        label: get('label').value.trim(),
        type,
        required: get('required').checked,
        placeholder: get('placeholder').value.trim(),
      };
      if (type === 'select') f.options = get('options').value.split(',').map((s) => s.trim()).filter(Boolean);
      return f;
    });
  }

  // --- EDITOR --------------------------------------------------------------
  async function showEditor(id) {
    hideAll();
    state.editingId = id || null;
    $('editor-title').textContent = id ? 'Edit meeting' : 'New meeting';
    $('editor-banner').className = 'banner hidden';
    $('fields-list').innerHTML = '';

    if (id) {
      const { json } = await api('GET', '/meetings/' + id);
      const m = json.meeting;
      $('ed-title').value = m.title;
      $('ed-desc').value = m.description;
      $('ed-location-name').value = m.locationName;
      $('ed-venue').value = m.venue || '';
      $('ed-geofence').checked = m.geofenceEnabled;
      $('ed-lat').value = m.latitude ?? '';
      $('ed-lng').value = m.longitude ?? '';
      $('ed-radius').value = m.radiusMeters;
      $('ed-accuracy').value = m.maxAccuracyMeters;
      $('ed-starts').value = fmtLocalInput(m.startsAt);
      $('ed-ends').value = fmtLocalInput(m.endsAt);
      $('ed-passcode').value = '';
      $('passcode-hint').textContent = m.hasPasscode
        ? 'A passcode is set. Leave blank to keep it, or type a new one to change. Type a single space then save to remove.'
        : 'Attendees must enter this to sign in. Leave blank for none.';
      $('ed-open').checked = m.isOpen;
      $('ed-unique-email').checked = m.requireUniqueEmail;
      $('ed-one-device').checked = m.limitOnePerDevice;
      $('ed-collect-ip').checked = m.collectIp;
      $('ed-notify-att-email').checked = m.notifyAttendeeEmail;
      $('ed-notify-att-sms').checked = m.notifyAttendeeSms;
      $('ed-notify-own-email').checked = m.notifyOwnerEmail;
      $('ed-notify-own-sms').checked = m.notifyOwnerSms;
      $('ed-owner-email').value = m.ownerNotifyEmail || '';
      $('ed-owner-phone').value = m.ownerNotifyPhone || '';
      (m.fields || []).forEach(addFieldRow);
    } else {
      $('editor-form').reset();
      $('ed-radius').value = 150; $('ed-accuracy').value = 100;
      $('ed-geofence').checked = true; $('ed-open').checked = true;
      $('ed-unique-email').checked = true; $('ed-one-device').checked = true; $('ed-collect-ip').checked = true;
      $('ed-notify-att-email').checked = false; $('ed-notify-att-sms').checked = false;
      $('ed-notify-own-email').checked = false; $('ed-notify-own-sms').checked = false;
      $('ed-owner-email').value = ''; $('ed-owner-phone').value = '';
      // Sensible default fields
      addFieldRow({ key: 'full_name', label: 'Full name', type: 'text', required: true });
      addFieldRow({ key: 'email', label: 'Email', type: 'email', required: true });
    }
    toggleGeofenceSettings();
    show('view-editor');
  }

  function toggleGeofenceSettings() {
    $('geofence-settings').classList.toggle('hidden', !$('ed-geofence').checked);
  }

  function useCurrentLocation() {
    const status = $('use-location-status');
    if (!navigator.geolocation) { status.textContent = ' Geolocation not supported.'; return; }
    status.textContent = ' Locating…';
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        $('ed-lat').value = pos.coords.latitude.toFixed(6);
        $('ed-lng').value = pos.coords.longitude.toFixed(6);
        status.textContent = ` Set (±${Math.round(pos.coords.accuracy)}m).`;
      },
      () => { status.textContent = ' Could not get location (permission denied?).'; },
      { enableHighAccuracy: true, timeout: 15000 }
    );
  }

  async function saveMeeting(e) {
    e.preventDefault();
    const banner = $('editor-banner');
    banner.className = 'banner hidden';

    const passcodeVal = $('ed-passcode').value;
    const payload = {
      title: $('ed-title').value.trim(),
      description: $('ed-desc').value,
      locationName: $('ed-location-name').value,
      venue: $('ed-venue').value,
      geofenceEnabled: $('ed-geofence').checked,
      latitude: $('ed-lat').value.trim(),
      longitude: $('ed-lng').value.trim(),
      radiusMeters: $('ed-radius').value,
      maxAccuracyMeters: $('ed-accuracy').value,
      startsAt: parseLocalInput($('ed-starts').value),
      endsAt: parseLocalInput($('ed-ends').value),
      isOpen: $('ed-open').checked,
      requireUniqueEmail: $('ed-unique-email').checked,
      limitOnePerDevice: $('ed-one-device').checked,
      collectIp: $('ed-collect-ip').checked,
      notifyAttendeeEmail: $('ed-notify-att-email').checked,
      notifyAttendeeSms: $('ed-notify-att-sms').checked,
      notifyOwnerEmail: $('ed-notify-own-email').checked,
      notifyOwnerSms: $('ed-notify-own-sms').checked,
      ownerNotifyEmail: $('ed-owner-email').value,
      ownerNotifyPhone: $('ed-owner-phone').value,
      fields: collectFieldRows(),
    };
    // Only send passcode if the user typed something (so blank keeps existing on edit).
    if (!state.editingId || passcodeVal !== '') payload.passcode = passcodeVal.trim();

    const { ok, json } = await api(state.editingId ? 'PUT' : 'POST', state.editingId ? '/meetings/' + state.editingId : '/meetings', payload);
    if (!ok) {
      banner.textContent = friendlyError(json?.error);
      banner.className = 'banner err';
      window.scrollTo(0, 0);
      return;
    }
    await showDetail(json.meeting.id);
  }

  function friendlyError(code) {
    const map = {
      title_required: 'Please enter a meeting title.',
      valid_location_required_for_geofence: 'Set a valid latitude/longitude (or disable the geofence).',
      at_least_one_field_required: 'Add at least one field to capture.',
      end_before_start: 'The close time must be after the open time.',
      passcode_too_short: 'Passcode must be at least 4 characters.',
    };
    if (code && code.startsWith('invalid_field_key')) return 'Field keys must be lowercase letters/numbers/underscores: ' + code.split(':')[1];
    if (code && code.startsWith('duplicate_field_key')) return 'Duplicate field key: ' + code.split(':')[1];
    if (code && code.startsWith('field_label_required')) return 'Every field needs a label.';
    if (code && code.startsWith('select_needs_options')) return 'Select fields need at least one option.';
    return map[code] || ('Could not save (' + (code || 'unknown error') + ').');
  }

  // --- BRANDING ------------------------------------------------------------
  function renderLogoPreview() {
    const has = state.branding && state.branding.hasLogo;
    const img = $('branding-logo-preview');
    if (has) {
      img.src = '/api/branding/logo.png?t=' + Date.now();
      img.classList.remove('hidden');
      $('branding-logo-none').classList.add('hidden');
      $('branding-logo-remove').classList.remove('hidden');
    } else {
      img.classList.add('hidden');
      $('branding-logo-none').classList.remove('hidden');
      $('branding-logo-remove').classList.add('hidden');
    }
  }

  async function showBranding() {
    hideAll();
    await loadBranding();
    const b = state.branding || {};
    $('br-org').value = b.orgName || '';
    $('br-address').value = b.address || '';
    $('br-contact').value = b.contact || '';
    $('br-footer').value = b.footerText || '';
    $('branding-banner').className = 'banner hidden';
    renderLogoPreview();
    show('view-branding');
  }

  function brandingBanner(msg, kind) {
    const el = $('branding-banner');
    el.textContent = msg; el.className = 'banner ' + kind;
    setTimeout(() => { if (kind === 'ok') el.className = 'banner hidden'; }, 2500);
  }

  async function saveBranding(e) {
    e.preventDefault();
    const payload = {
      orgName: $('br-org').value, address: $('br-address').value,
      contact: $('br-contact').value, footerText: $('br-footer').value,
    };
    const { ok, json } = await api('PUT', '/branding', payload);
    if (ok) { state.branding = json.branding; brandingBanner('Branding saved.', 'ok'); }
    else brandingBanner('Could not save branding.', 'err');
  }

  function uploadLogo(file) {
    if (!file) return;
    if (file.size > 1024 * 1024) { brandingBanner('Logo must be under 1 MB.', 'err'); return; }
    const reader = new FileReader();
    reader.onload = async () => {
      const { ok, json } = await api('POST', '/branding/logo', { dataUrl: reader.result });
      if (ok) { if (state.branding) state.branding.hasLogo = true; else state.branding = { hasLogo: true }; renderLogoPreview(); brandingBanner('Logo uploaded.', 'ok'); }
      else brandingBanner(json?.detail || 'Logo upload failed.', 'err');
    };
    reader.readAsDataURL(file);
  }

  async function removeLogo() {
    await api('DELETE', '/branding/logo');
    if (state.branding) state.branding.hasLogo = false;
    renderLogoPreview();
  }

  // --- DETAIL --------------------------------------------------------------
  async function showDetail(id) {
    hideAll();
    const { json } = await api('GET', '/meetings/' + id + '/signins');
    if (!json) return showList();
    const m = json.meeting;
    state.currentMeeting = m;
    $('detail-title').textContent = m.title;
    $('detail-qr').src = '/api/meetings/' + id + '/qr.png';
    $('detail-link').value = m.shareUrl;
    $('download-qr').href = '/api/meetings/' + id + '/qr.png';
    $('open-signin').href = m.shareUrl;
    $('export-csv').href = '/api/meetings/' + id + '/export.csv';
    $('export-pdf').href = '/api/meetings/' + id + '/export.pdf';
    $('export-docx').href = '/api/meetings/' + id + '/export.docx';
    $('export-branding-hint').textContent = state.branding && (state.branding.orgName || state.branding.hasLogo)
      ? 'PDF & Word use your saved branding (' + (state.branding.orgName || 'logo only') + ').'
      : 'Tip: set your organization name and logo under Branding to put a header on PDF/Word exports.';

    const toggleBtn = $('detail-toggle');
    toggleBtn.textContent = m.isOpen ? 'Close sign-ins' : 'Open sign-ins';
    toggleBtn.className = 'btn btn-sm ' + (m.isOpen ? 'btn-danger' : '');
    toggleBtn.onclick = async () => { await api('POST', '/meetings/' + id + '/toggle'); showDetail(id); };

    $('detail-edit').onclick = () => showEditor(id);
    $('detail-delete').onclick = async () => {
      if (!confirm('Delete this meeting and all its sign-ins? This cannot be undone.')) return;
      await api('DELETE', '/meetings/' + id);
      showList();
    };

    const meta = [];
    meta.push(m.geofenceEnabled ? `Geofence ON · ${m.radiusMeters}m radius · ${m.maxAccuracyMeters}m max GPS error` : 'Geofence OFF');
    if (m.hasPasscode) meta.push('Passcode required');
    if (m.startsAt) meta.push('Opens ' + fmt(m.startsAt));
    if (m.endsAt) meta.push('Closes ' + fmt(m.endsAt));
    $('detail-meta').innerHTML = meta.map(esc).join(' · ');

    renderSignins(m, json.signins, id);
    show('view-detail');
  }

  function renderSignins(m, signins, meetingId) {
    $('signin-count').textContent = signins.length;
    const wrap = $('signins-wrap');
    if (!signins.length) { wrap.innerHTML = '<p class="muted">No sign-ins yet. Share the QR code or link to collect them.</p>'; return; }

    const cols = m.fields;
    let html = '<table><thead><tr><th>Time</th>';
    cols.forEach((f) => (html += `<th>${esc(f.label)}</th>`));
    html += '<th>Geo</th><th>Dist</th><th></th></tr></thead><tbody>';
    for (const s of signins) {
      html += '<tr>';
      html += `<td class="small">${fmt(s.createdAt)}${s.flagged ? ` <span class="badge warn" title="${esc(s.flagReason || '')}">⚑</span>` : ''}</td>`;
      cols.forEach((f) => {
        let v = s.data[f.key];
        if (typeof v === 'boolean') v = v ? '✓' : '';
        html += `<td>${esc(v)}</td>`;
      });
      html += `<td>${s.withinGeofence ? '<span class="badge ok">✓</span>' : (m.geofenceEnabled ? '<span class="badge danger">✗</span>' : '—')}</td>`;
      html += `<td class="small">${s.distanceMeters != null ? Math.round(s.distanceMeters) + 'm' : '—'}</td>`;
      html += `<td><button class="btn btn-danger btn-sm" data-del="${s.id}">✕</button></td>`;
      html += '</tr>';
    }
    html += '</tbody></table>';
    wrap.innerHTML = html;
    wrap.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => {
      if (!confirm('Remove this sign-in?')) return;
      await api('DELETE', '/meetings/' + meetingId + '/signins/' + b.dataset.del);
      showDetail(meetingId);
    }));
  }

  // --- Wire up + boot ------------------------------------------------------
  function wire() {
    $('auth-form').addEventListener('submit', handleAuthSubmit);
    $('new-meeting-btn').onclick = () => showEditor(null);
    $('new-meeting-btn2').onclick = () => showEditor(null);
    $('branding-btn').onclick = showBranding;
    $('branding-back').onclick = (e) => { e.preventDefault(); showList(); };
    $('users-btn').onclick = showUsers;
    $('users-back').onclick = (e) => { e.preventDefault(); showList(); };
    $('user-form').addEventListener('submit', addUser);
    $('branding-form').addEventListener('submit', saveBranding);
    $('branding-logo-input').addEventListener('change', (e) => uploadLogo(e.target.files[0]));
    $('branding-logo-remove').onclick = removeLogo;
    $('editor-form').addEventListener('submit', saveMeeting);
    $('editor-cancel').onclick = showList;
    $('editor-back').onclick = (e) => { e.preventDefault(); showList(); };
    $('detail-back').onclick = (e) => { e.preventDefault(); showList(); };
    $('add-field-btn').onclick = () => addFieldRow();
    $('ed-geofence').addEventListener('change', toggleGeofenceSettings);
    $('use-location-btn').onclick = useCurrentLocation;
    $('copy-link').onclick = async () => {
      const link = $('detail-link').value;
      try { await navigator.clipboard.writeText(link); $('copy-link').textContent = 'Copied!'; setTimeout(() => ($('copy-link').textContent = 'Copy'), 1500); }
      catch { $('detail-link').select(); }
    };
  }

  async function boot() {
    const { json } = await api('GET', '/auth/me');
    if (json?.admin) {
      state.admin = json.admin;
      state.csrf = json.csrfToken;
      renderAuthNav();
      await loadBranding();
      await showList();
    } else {
      state.needsBootstrap = !!json?.needsBootstrap;
      state.openRegistration = !!json?.openRegistration;
      renderAuthNav();
      showAuth();
    }
  }

  wire();
  boot();
})();
