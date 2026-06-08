'use strict';
(function () {
  var t = document.getElementById('menu-toggle');
  var n = document.getElementById('nav');
  if (t && n) t.addEventListener('click', function () { n.classList.toggle('open'); });
  var y = document.getElementById('year');
  if (y) {
    // Avoid hard-coding the year where a real date is acceptable on the client.
    try { y.textContent = String(new Date().getFullYear()); } catch (e) { /* keep fallback */ }
  }
})();
