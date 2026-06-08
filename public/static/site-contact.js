'use strict';
(function () {
  var form = document.getElementById('contact-form');
  if (!form) return;
  var banner = document.getElementById('contact-banner');
  var btn = document.getElementById('c-submit');

  function show(msg, kind) {
    banner.textContent = msg;
    banner.className = 'banner ' + kind;
  }

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    banner.className = 'banner hidden';
    btn.disabled = true;
    var orig = btn.textContent;
    btn.textContent = 'Sending…';

    var payload = {
      name: document.getElementById('c-name').value,
      email: document.getElementById('c-email').value,
      phone: document.getElementById('c-phone').value,
      subject: document.getElementById('c-subject').value,
      message: document.getElementById('c-message').value,
      website: document.getElementById('c-website').value, // honeypot
    };

    try {
      var res = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      var json = await res.json().catch(function () { return {}; });
      if (res.ok) {
        form.reset();
        show('Thank you — your message has been sent. We will get back to you.', 'ok');
      } else {
        var msgs = {
          name_required: 'Please enter your name.',
          invalid_email: 'Please enter a valid email address.',
          message_required: 'Please enter a message.',
          too_many_requests: 'Too many messages sent. Please try again later.',
        };
        show(msgs[json.error] || 'Could not send your message. Please try again.', 'err');
      }
    } catch (err) {
      show('Network error. Please try again.', 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = orig;
    }
  });
})();
