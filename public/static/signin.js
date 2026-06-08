'use strict';

(function () {
  const slug = location.pathname.split('/').filter(Boolean).pop();
  let meeting = null;
  let position = null; // { lat, lng, accuracy }

  const $ = (id) => document.getElementById(id);
  const show = (id) => $(id).classList.remove('hidden');
  const hide = (id) => $(id).classList.add('hidden');

  function banner(msg, kind = 'err') {
    const b = $('form-banner');
    b.textContent = msg;
    b.className = 'banner ' + kind;
  }
  function clearBanner() {
    const b = $('form-banner');
    b.className = 'banner hidden';
    b.textContent = '';
  }

  // --- Stable-ish device fingerprint (privacy-light, for duplicate detection) ---
  async function deviceHash() {
    const KEY = 'ms_device_id';
    let id = localStorage.getItem(KEY);
    if (!id) {
      id = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2)) + ':' +
        [navigator.userAgent, navigator.language, screen.width + 'x' + screen.height, new Date().getTimezoneOffset()].join('|');
      localStorage.setItem(KEY, id);
    }
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(id));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  function fmtTime(ts) {
    try { return new Date(ts).toLocaleString(); } catch { return ''; }
  }

  // --- Render the dynamic form fields --------------------------------------
  function renderFields(fields) {
    const wrap = $('dynamic-fields');
    wrap.innerHTML = '';
    for (const f of fields) {
      const id = 'f_' + f.key;
      const field = document.createElement('div');
      field.className = 'field';

      if (f.type === 'checkbox') {
        field.className = 'field check';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.id = id; input.dataset.key = f.key;
        const label = document.createElement('label');
        label.htmlFor = id;
        label.textContent = f.label + (f.required ? ' *' : '');
        field.appendChild(input);
        field.appendChild(label);
        wrap.appendChild(field);
        continue;
      }

      const label = document.createElement('label');
      label.htmlFor = id;
      label.textContent = f.label + (f.required ? ' *' : '');
      field.appendChild(label);

      let input;
      if (f.type === 'textarea') {
        input = document.createElement('textarea');
      } else if (f.type === 'select') {
        input = document.createElement('select');
        const blank = document.createElement('option');
        blank.value = ''; blank.textContent = '— select —';
        input.appendChild(blank);
        for (const opt of f.options || []) {
          const o = document.createElement('option');
          o.value = opt; o.textContent = opt;
          input.appendChild(o);
        }
      } else {
        input = document.createElement('input');
        input.type = f.type === 'tel' ? 'tel' : f.type === 'number' ? 'number' : f.type === 'email' ? 'email' : f.type === 'date' ? 'date' : 'text';
      }
      input.id = id;
      input.dataset.key = f.key;
      if (f.required) input.required = true;
      if (f.placeholder) input.placeholder = f.placeholder;
      // Helpful autocomplete hints
      if (f.type === 'email') input.autocomplete = 'email';
      if (f.type === 'tel') input.autocomplete = 'tel';
      field.appendChild(input);
      wrap.appendChild(field);
    }
  }

  function collectFields() {
    const data = {};
    document.querySelectorAll('#dynamic-fields [data-key]').forEach((el) => {
      data[el.dataset.key] = el.type === 'checkbox' ? el.checked : el.value;
    });
    return data;
  }

  // --- Geolocation ---------------------------------------------------------
  function setGeo(state, text) {
    $('geo-dot').className = 'dot ' + (state || '');
    $('geo-text').textContent = text;
  }

  function requestLocation() {
    if (!('geolocation' in navigator)) {
      setGeo('err', 'This device/browser does not support location. You cannot sign in.');
      return;
    }
    setGeo('warn', 'Requesting your location…');
    $('geo-btn').disabled = true;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        position = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
        };
        const acc = Math.round(pos.coords.accuracy);
        if (meeting.maxAccuracyMeters && acc > meeting.maxAccuracyMeters) {
          setGeo('warn', `Location found but accuracy is low (±${acc}m). Move to open sky / enable precise location, then retry.`);
        } else {
          setGeo('ok', `Location captured (±${acc}m). You can sign in.`);
        }
        $('geo-btn').disabled = false;
        $('geo-btn').textContent = 'Update my location';
      },
      (err) => {
        $('geo-btn').disabled = false;
        const map = {
          1: 'Location permission denied. You must allow location to sign in to this meeting.',
          2: 'Location unavailable. Move to an area with better signal and retry.',
          3: 'Location request timed out. Please retry.',
        };
        setGeo('err', map[err.code] || 'Could not get your location.');
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  }

  // --- Load meeting --------------------------------------------------------
  async function load() {
    let res;
    try {
      res = await fetch('/api/public/meetings/' + encodeURIComponent(slug));
    } catch {
      hide('loading'); show('notfound'); return;
    }
    if (res.status === 404) { hide('loading'); show('notfound'); return; }
    const json = await res.json();
    meeting = json.meeting;

    hide('loading');

    if (!json.open) {
      const reasons = {
        meeting_closed: 'This sign-in sheet is currently closed.',
        not_started: 'Sign-in opens at ' + fmtTime(json.startsAt) + '.',
        ended: 'Sign-in closed at ' + fmtTime(json.endsAt) + '.',
      };
      $('closed-msg').textContent = reasons[json.windowReason] || 'This sign-in sheet is not accepting entries right now.';
      show('closed');
      return;
    }

    $('m-title').textContent = meeting.title;
    $('m-location').textContent = meeting.locationName || '';
    $('m-desc').textContent = meeting.description || '';
    renderFields(meeting.fields);

    if (meeting.hasPasscode) show('passcode-block');

    if (meeting.geofenceEnabled) {
      show('geo-block');
      setGeo('', `You must be within ${meeting.radiusMeters}m of the meeting location.`);
    }

    show('meeting');
  }

  // --- Submit --------------------------------------------------------------
  async function submit(e) {
    e.preventDefault();
    clearBanner();

    if (meeting.geofenceEnabled && !position) {
      banner('Please share your location first.', 'warn');
      requestLocation();
      return;
    }

    const btn = $('submit-btn');
    btn.disabled = true;
    const orig = btn.textContent;
    btn.innerHTML = '<span class="spinner"></span> Signing in…';

    const payload = {
      fields: collectFields(),
      passcode: meeting.hasPasscode ? $('passcode').value : undefined,
      deviceHash: await deviceHash(),
    };
    if (position) {
      payload.latitude = position.lat;
      payload.longitude = position.lng;
      payload.accuracy = position.accuracy;
    }

    let res, json;
    try {
      res = await fetch('/api/public/meetings/' + encodeURIComponent(slug) + '/signin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      json = await res.json().catch(() => ({}));
    } catch {
      btn.disabled = false; btn.textContent = orig;
      banner('Network error. Please try again.', 'err');
      return;
    }

    if (res.ok) {
      hide('meeting');
      show('success');
      if (json.flagged) {
        $('success-flag').textContent = 'Note: your entry was recorded but flagged for review due to imprecise location.';
      }
      return;
    }

    btn.disabled = false; btn.textContent = orig;
    const messages = {
      geofence_denied: json.detail || 'You appear to be outside the allowed area for this meeting.',
      already_signed_in: json.detail || 'You have already signed in to this meeting.',
      invalid_passcode: 'Incorrect passcode.',
      validation_failed: 'Please check your entries: ' + (json.detail || '').replace(/_/g, ' '),
      meeting_closed: 'This sign-in sheet is now closed.',
      not_started: 'Sign-in has not opened yet.',
      ended: 'Sign-in has closed.',
      too_many_requests: 'Too many attempts. Please wait a moment and try again.',
    };
    banner(messages[json.error] || json.detail || 'Could not sign you in. Please try again.', 'err');
    // If geofence was denied for accuracy, prompt a refresh of location.
    if (json.error === 'geofence_denied' && (json.reason === 'accuracy_too_low' || json.reason === 'accuracy_required')) {
      requestLocation();
    }
  }

  $('geo-btn').addEventListener('click', requestLocation);
  $('signin-form').addEventListener('submit', submit);
  load();
})();
