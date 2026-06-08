'use strict';

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');

const config = require('./src/config');
const store = require('./src/store');
const auth = require('./src/auth');

const app = express();

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
        styleSrc: ["'self'", "'unsafe-inline'"],
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

app.use(express.json({ limit: '64kb' }));
app.use(express.urlencoded({ extended: false, limit: '64kb' }));
app.use(cookieParser());

app.use('/api', rateLimit({ windowMs: 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false, message: { error: 'too_many_requests' } }));

app.use(auth.loadSession);

// --- API routes ----------------------------------------------------------
app.use('/api/auth', require('./src/routes/auth'));
app.use('/api/branding', require('./src/routes/branding').router);
app.use('/api/meetings', require('./src/routes/meetings'));
app.use('/api/public', require('./src/routes/signin'));
app.use('/api/contact', require('./src/routes/contact'));

app.get('/api/health', (req, res) => res.json({ ok: true, backend: store.backend, ts: Date.now() }));

// --- Static assets -------------------------------------------------------
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use('/static', express.static(path.join(PUBLIC_DIR, 'static'), { maxAge: '1h' }));

// --- Public website (County Government of Mandera) -----------------------
const sitePage = (name) => (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'site', name));
app.get('/', sitePage('index.html'));
app.get('/about', sitePage('about.html'));
app.get('/contact', sitePage('contact.html'));
app.get('/privacy', sitePage('privacy.html'));

// Public sign-in page (shareable link target).
app.get('/m/:slug', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'signin', 'index.html')));

// Admin SPA.
app.get(['/admin', '/admin/*'], (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'admin', 'index.html')));

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
  if (res.headersSent) return;
  res.status(500).json({ error: 'internal_error' });
});

// --- Background housekeeping ---------------------------------------------
setInterval(() => {
  Promise.resolve(auth.cleanupExpiredSessions()).catch((e) => console.error('session cleanup failed', e));
}, 60 * 60 * 1000).unref();

// --- Startup -------------------------------------------------------------
(async () => {
  try {
    await store.init();
  } catch (e) {
    console.error('\n  FATAL: data backend failed to initialize.');
    console.error('  ' + e.message + '\n');
    process.exit(1);
  }

  const server = app.listen(config.port, () => {
    console.log(`\n  Meeting Signs running`);
    console.log(`  ───────────────────────────────────────────`);
    console.log(`  DATA BACKEND: ${store.backend.toUpperCase()}${store.backend === 'supabase' ? '  ✓ (registrations save to Supabase)' : ''}`);
    if (store.backend === 'sqlite') {
      console.log(`  ⚠  Using LOCAL SQLite (data/meeting-signs.db).`);
      console.log(`     Registrations are NOT in Supabase. To use Supabase, set in .env:`);
      console.log(`       DB_BACKEND=supabase`);
      console.log(`       SUPABASE_URL=...   SUPABASE_SERVICE_ROLE_KEY=...`);
      console.log(`     then run supabase/schema.sql and restart.`);
    }
    console.log(`  ───────────────────────────────────────────`);
    console.log(`  Website: ${config.baseUrl}/`);
    console.log(`  Admin:   ${config.baseUrl}/admin`);
    console.log(`  Health:  ${config.baseUrl}/api/health`);
    if (!config.isProd) console.log(`  (dev mode — set NODE_ENV=production and BASE_URL for deployment)\n`);
  });

  process.on('SIGTERM', () => server.close(() => process.exit(0)));
  process.on('SIGINT', () => server.close(() => process.exit(0)));
})();

module.exports = app;
