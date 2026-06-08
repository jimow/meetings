'use strict';

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');

const config = require('./src/config');
require('./src/db'); // initialize schema
const auth = require('./src/auth');

const app = express();

// Behind a reverse proxy (nginx, cloud LB) this makes req.ip / req.secure honor
// X-Forwarded-* headers. Keep it at 1 hop; do not set to true blindly.
app.set('trust proxy', 1);
app.disable('x-powered-by');

// --- Security headers ----------------------------------------------------
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"], // inline styles in our static pages
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  })
);

// --- Body parsing + cookies ---------------------------------------------
app.use(express.json({ limit: '64kb' }));
app.use(express.urlencoded({ extended: false, limit: '64kb' }));
app.use(cookieParser());

// Global, coarse rate limit as a backstop (per-route limiters are stricter).
app.use(
  '/api',
  rateLimit({ windowMs: 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false, message: { error: 'too_many_requests' } })
);

// Attach session/admin context to every request.
app.use(auth.loadSession);

// --- API routes ----------------------------------------------------------
app.use('/api/auth', require('./src/routes/auth'));
app.use('/api/branding', require('./src/routes/branding').router);
app.use('/api/meetings', require('./src/routes/meetings'));
app.use('/api/public', require('./src/routes/signin'));

app.get('/api/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

// --- Static assets -------------------------------------------------------
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use('/static', express.static(path.join(PUBLIC_DIR, 'static'), { maxAge: '1h' }));

// Public sign-in page (shareable link target). The slug is read client-side.
app.get('/m/:slug', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'signin', 'index.html'));
});

// Admin SPA (login + dashboard live in one shell).
app.get(['/admin', '/admin/*'], (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'admin', 'index.html'));
});

// Root redirects to admin.
app.get('/', (req, res) => res.redirect('/admin'));

// --- 404 + error handling ------------------------------------------------
app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'not_found' });
  res.status(404).sendFile(path.join(PUBLIC_DIR, 'static', '404.html'));
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'payload_too_large' });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid_json' });
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'internal_error' });
});

// --- Background housekeeping ---------------------------------------------
setInterval(() => {
  try { auth.cleanupExpiredSessions(); } catch (e) { console.error('session cleanup failed', e); }
}, 60 * 60 * 1000).unref();

const server = app.listen(config.port, () => {
  console.log(`\n  Meeting Signs running`);
  console.log(`  Admin:   ${config.baseUrl}/admin`);
  console.log(`  Health:  ${config.baseUrl}/api/health`);
  if (!config.isProd) console.log(`  (dev mode — set NODE_ENV=production and BASE_URL for deployment)\n`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));

module.exports = app;
