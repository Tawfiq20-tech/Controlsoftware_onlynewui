'use strict';

const MIGRATIONS = [
    // 1: §4.9
    `
CREATE TABLE users(
  id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL, is_admin INTEGER NOT NULL DEFAULT 0, disabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL);
CREATE TABLE sessions(
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL, abs_expires_at INTEGER NOT NULL, ip TEXT, user_agent TEXT);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE TABLE invites(
  code_hash TEXT PRIMARY KEY, created_by TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  used_by TEXT, used_at INTEGER);
CREATE TABLE session_revocations(
  id INTEGER PRIMARY KEY AUTOINCREMENT, token_hash TEXT, user_id TEXT, created_at INTEGER NOT NULL);
CREATE TABLE devices(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, hardware_id TEXT NOT NULL, app_version TEXT, controller_type TEXT,
  status TEXT NOT NULL DEFAULT 'pending_confirmation' CHECK(status IN ('pending_confirmation','active')),
  credential_hash TEXT NOT NULL UNIQUE, previous_credential_hash TEXT UNIQUE, pending_rotate_id TEXT, pending_since INTEGER,
  rotated_at INTEGER, cred_created_at INTEGER NOT NULL, paired_at INTEGER NOT NULL, last_seen_at INTEGER,
  disabled INTEGER NOT NULL DEFAULT 0);
CREATE TABLE revoked_credentials(
  credential_hash TEXT PRIMARY KEY, revoked_at INTEGER NOT NULL);
CREATE TABLE grants(
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('owner','operator','viewer')), created_at INTEGER NOT NULL,
  PRIMARY KEY(user_id, device_id));
CREATE INDEX grants_device ON grants(device_id);
CREATE TABLE pairings(
  id TEXT PRIMARY KEY, code_hash TEXT NOT NULL UNIQUE, poll_secret_hash TEXT NOT NULL,
  hardware_id TEXT NOT NULL, name TEXT NOT NULL, app_version TEXT, controller_type TEXT, ip TEXT,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  credential_hash TEXT NOT NULL UNIQUE,
  claimed_at INTEGER, claimed_by TEXT, claimed_device_id TEXT, confirmed_at INTEGER, rejected_at INTEGER);
CREATE TABLE transfers(
  id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL, name TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL,
  status TEXT NOT NULL, code TEXT, library_id TEXT, blob_deleted INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX transfers_device ON transfers(device_id, created_at);
CREATE TABLE audit(
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, user_id TEXT, device_id TEXT, ip TEXT,
  action TEXT NOT NULL, detail TEXT, result TEXT);
CREATE INDEX audit_device_ts ON audit(device_id, ts);
CREATE INDEX audit_user_ts ON audit(user_id, ts);
`,
];

function migrate(db) {
    const current = Number(db.pragma('user_version')) || 0;
    for (let v = current; v < MIGRATIONS.length; v++) {
        db.transaction(() => {
            db.exec(MIGRATIONS[v]);
            db.exec(`PRAGMA user_version = ${v + 1}`);
        });
    }
    return MIGRATIONS.length;
}

module.exports = { migrate, SCHEMA_VERSION: MIGRATIONS.length };
