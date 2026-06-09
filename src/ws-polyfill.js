'use strict';

// Node < 22 has no global WebSocket. @supabase/supabase-js creates a realtime
// client (which requires a WebSocket implementation) even when only the database
// API is used, and throws on startup without one. Provide it from the `ws`
// package. On Node 22+ the native global already exists, so this is a no-op.
if (typeof globalThis.WebSocket === 'undefined') {
  try {
    globalThis.WebSocket = require('ws');
  } catch {
    // `ws` not installed — only a problem on Node < 22. Surface a clear hint.
    console.warn('  ⚠  No global WebSocket and "ws" is not installed. On Node < 22 run: npm install ws');
  }
}

module.exports = {};
