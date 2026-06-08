'use strict';

const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

const db = new DatabaseSync(config.dbPath);

// Pragmas for durability + concurrency.
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS admins (
    id            TEXT PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    name          TEXT NOT NULL DEFAULT '',
    role          TEXT NOT NULL DEFAULT 'admin',
    failed_logins INTEGER NOT NULL DEFAULT 0,
    locked_until  INTEGER,
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id          TEXT PRIMARY KEY,
    admin_id    TEXT NOT NULL,
    csrf_token  TEXT NOT NULL,
    expires_at  INTEGER NOT NULL,
    created_at  INTEGER NOT NULL,
    ip          TEXT,
    user_agent  TEXT,
    FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS meetings (
    id                   TEXT PRIMARY KEY,
    slug                 TEXT NOT NULL UNIQUE,
    owner_id             TEXT NOT NULL,
    title                TEXT NOT NULL,
    description          TEXT NOT NULL DEFAULT '',
    location_name        TEXT NOT NULL DEFAULT '',
    latitude             REAL,
    longitude            REAL,
    radius_meters        INTEGER NOT NULL DEFAULT 150,
    geofence_enabled     INTEGER NOT NULL DEFAULT 1,
    max_accuracy_meters  INTEGER NOT NULL DEFAULT 100,
    starts_at            INTEGER,
    ends_at              INTEGER,
    is_open              INTEGER NOT NULL DEFAULT 1,
    passcode_hash        TEXT,
    require_unique_email INTEGER NOT NULL DEFAULT 1,
    limit_one_per_device INTEGER NOT NULL DEFAULT 1,
    collect_ip           INTEGER NOT NULL DEFAULT 1,
    fields_json          TEXT NOT NULL DEFAULT '[]',
    status               TEXT NOT NULL DEFAULT 'active',
    created_at           INTEGER NOT NULL,
    updated_at           INTEGER NOT NULL,
    FOREIGN KEY (owner_id) REFERENCES admins(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_meetings_owner ON meetings(owner_id);

  CREATE TABLE IF NOT EXISTS signins (
    id               TEXT PRIMARY KEY,
    meeting_id       TEXT NOT NULL,
    data_json        TEXT NOT NULL DEFAULT '{}',
    email            TEXT,
    latitude         REAL,
    longitude        REAL,
    accuracy         REAL,
    distance_meters  REAL,
    within_geofence  INTEGER NOT NULL DEFAULT 0,
    ip               TEXT,
    user_agent       TEXT,
    device_hash      TEXT,
    flagged          INTEGER NOT NULL DEFAULT 0,
    flag_reason      TEXT,
    created_at       INTEGER NOT NULL,
    FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_signins_meeting ON signins(meeting_id);
  CREATE INDEX IF NOT EXISTS idx_signins_email ON signins(meeting_id, email);
  CREATE INDEX IF NOT EXISTS idx_signins_device ON signins(meeting_id, device_hash);

  -- Per-owner organization branding used on PDF / Word exports.
  CREATE TABLE IF NOT EXISTS org_settings (
    owner_id    TEXT PRIMARY KEY,
    org_name    TEXT NOT NULL DEFAULT '',
    address     TEXT NOT NULL DEFAULT '',
    contact     TEXT NOT NULL DEFAULT '',
    footer_text TEXT NOT NULL DEFAULT '',
    logo_data   BLOB,
    logo_mime   TEXT,
    logo_w      INTEGER,
    logo_h      INTEGER,
    updated_at  INTEGER,
    FOREIGN KEY (owner_id) REFERENCES admins(id) ON DELETE CASCADE
  );

  -- Lightweight audit log for security-relevant events.
  CREATE TABLE IF NOT EXISTS audit_log (
    id         TEXT PRIMARY KEY,
    actor      TEXT,
    action     TEXT NOT NULL,
    target     TEXT,
    detail     TEXT,
    ip         TEXT,
    created_at INTEGER NOT NULL
  );
`);

// --- Lightweight migrations for columns added after initial release ------
function columnExists(table, col) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
}
if (!columnExists('meetings', 'venue')) {
  db.exec(`ALTER TABLE meetings ADD COLUMN venue TEXT NOT NULL DEFAULT ''`);
}

module.exports = db;
