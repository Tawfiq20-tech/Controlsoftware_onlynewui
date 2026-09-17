'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { runTests, tmpDir, removeDir, startRelay, stopRelay, userWithSession, request } = require('./helpers/harness');
const { pairDevice, connectDevice } = require('./helpers/peers');
const { openDatabase, backupDatabase } = require('../server/store/db');
const { migrate, SCHEMA_VERSION } = require('../server/store/migrations');
const { Audit } = require('../server/audit');
const { silentLogger } = require('../server/log');

const TABLES = ['users', 'sessions', 'invites', 'session_revocations', 'devices', 'revoked_credentials', 'grants', 'pairings', 'transfers', 'audit'];

function seedDevice(db) {
    const now = Date.now();
    db.run("INSERT INTO users(id, email, display_name, password_hash, created_at) VALUES ('u_aaaaaaaaaaaa','a@example.com','A','x',?)", now);
    db.run("INSERT INTO devices(id, name, hardware_id, status, credential_hash, cred_created_at, paired_at) VALUES ('d_aaaaaaaaaaaa','M','3f9a1c07b2e4','active',?,?,?)", 'a'.repeat(64), now, now);
    db.run("INSERT INTO grants(user_id, device_id, role, created_at) VALUES ('u_aaaaaaaaaaaa','d_aaaaaaaaaaaa','owner',?)", now);
    db.run("INSERT INTO transfers(id, device_id, user_id, name, size, sha256, status, created_at, updated_at) VALUES ('x_aaaaaaaaaaaa','d_aaaaaaaaaaaa','u_aaaaaaaaaaaa','a.nc',1,?, 'pending',?,?)", 'b'.repeat(64), now, now);
}

runTests('Relay Store', [
    ['migrations run on :memory: and set user_version', () => {
        const db = openDatabase(':memory:');
        assert.strictEqual(migrate(db), SCHEMA_VERSION);
        assert.strictEqual(Number(db.pragma('user_version')), 1);
        const names = db.all("SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => r.name);
        for (const t of TABLES) assert.ok(names.includes(t), `table ${t}`);
        migrate(db);
        assert.strictEqual(Number(db.pragma('user_version')), 1);
        db.close();
    }],
    ['file database uses WAL, foreign keys and survives reopen', () => {
        const dir = tmpDir();
        try {
            const file = path.join(dir, 'relay.db');
            let db = openDatabase(file);
            migrate(db);
            assert.strictEqual(String(db.pragma('journal_mode')).toLowerCase(), 'wal');
            assert.strictEqual(Number(db.pragma('foreign_keys')), 1);
            assert.strictEqual(Number(db.pragma('busy_timeout')), 200);
            seedDevice(db);
            db.close();
            db = openDatabase(file, { busyTimeoutMs: 5000 });
            assert.strictEqual(Number(db.pragma('busy_timeout')), 5000);
            assert.strictEqual(migrate(db), 1);
            assert.strictEqual(db.get('SELECT COUNT(*) AS n FROM devices').n, 1);
            db.close();
        } finally {
            removeDir(dir);
        }
    }],
    ['deleting a device cascades to grants and transfers', () => {
        const db = openDatabase(':memory:');
        migrate(db);
        seedDevice(db);
        db.run("DELETE FROM devices WHERE id = 'd_aaaaaaaaaaaa'");
        assert.strictEqual(db.get('SELECT COUNT(*) AS n FROM grants').n, 0);
        assert.strictEqual(db.get('SELECT COUNT(*) AS n FROM transfers').n, 0);
        db.close();
    }],
    ['transaction rolls back on error', () => {
        const db = openDatabase(':memory:');
        migrate(db);
        assert.throws(() => db.transaction(() => {
            seedDevice(db);
            throw new Error('boom');
        }), /boom/);
        assert.strictEqual(db.get('SELECT COUNT(*) AS n FROM users').n, 0);
        db.close();
    }],
    ['backup() produces a database that opens', async () => {
        const dir = tmpDir();
        try {
            const db = openDatabase(path.join(dir, 'relay.db'));
            migrate(db);
            seedDevice(db);
            const out = path.join(dir, 'backup.db');
            await backupDatabase(db, out, { rate: 100 });
            db.close();
            const copy = openDatabase(out);
            assert.strictEqual(Number(copy.pragma('user_version')), 1);
            assert.strictEqual(copy.get('SELECT COUNT(*) AS n FROM devices').n, 1);
            copy.close();
        } finally {
            removeDir(dir);
        }
    }],
    ['no table, WAL or backup ever contains a plaintext odc_ credential', async () => {
        const relay = await startRelay();
        try {
            const owner = await userWithSession(relay);
            const dev = await pairDevice(relay, owner);
            const { peer } = await connectDevice(relay, dev.credential);
            const rot = await request(relay, 'POST', `/api/devices/${dev.deviceId}/rotate`, { session: owner, json: {} });
            assert.strictEqual(rot.status, 202);
            const msg = await peer.waitFor('cred.rotate');
            const next = require('./helpers/peers').genCredential();
            peer.send('cred.rotated', { rotateId: msg.body.rotateId, newCredentialHash: require('./helpers/peers').sha256(next) });
            await peer.waitFor('cred.commit');
            relay.app.audit.flush();
            for (const t of TABLES) {
                for (const row of relay.db.all(`SELECT * FROM ${t}`)) {
                    for (const v of Object.values(row)) {
                        if (typeof v === 'string') assert.ok(!v.includes('odc_'), `plaintext credential in ${t}`);
                    }
                }
            }
            const row = relay.db.get('SELECT credential_hash, previous_credential_hash FROM devices WHERE id = ?', dev.deviceId);
            assert.strictEqual(row.credential_hash, require('./helpers/peers').sha256(next));
            assert.strictEqual(row.previous_credential_hash, require('./helpers/peers').sha256(dev.credential));
            const backup = path.join(relay.dataDir, 'b.db');
            await backupDatabase(relay.app.db, backup);
            await peer.close();
            for (const f of fs.readdirSync(relay.dataDir)) {
                const full = path.join(relay.dataDir, f);
                if (!fs.statSync(full).isFile()) continue;
                assert.ok(!fs.readFileSync(full).includes(Buffer.from('odc_')), `odc_ found in ${f}`);
            }
        } finally {
            await stopRelay(relay);
        }
    }],
    ['batched retention sweep on 1M audit rows never blocks the loop', async () => {
        const dir = tmpDir();
        const db = openDatabase(path.join(dir, 'relay.db'));
        try {
            migrate(db);
            const old = Date.now() - 400 * 86400000;
            const recent = Date.now();
            const TOTAL = 1000000;
            db.transaction(() => {
                const st = db.raw.prepare('INSERT INTO audit(ts, user_id, device_id, action, detail) VALUES (?, ?, ?, ?, ?)');
                for (let i = 0; i < TOTAL; i++) {
                    st.run(i < TOTAL - 1000 ? old + i : recent, 'u_aaaaaaaaaaaa', 'd_aaaaaaaaaaaa', 'cmd', '{"type":"jog.step"}');
                }
            });
            const clock = { now: () => Date.now(), mono: () => performance.now() };
            const audit = new Audit({ db, clock, logger: silentLogger });
            clearInterval(audit.timer);
            let yields = 0;
            let spinning = true;
            const spin = () => {
                if (!spinning) return;
                yields++;
                setImmediate(spin);
            };
            setImmediate(spin);
            const steps = [];
            const origDelete = db.deleteBatched.bind(db);
            db.deleteBatched = (t, w, p, o) => origDelete(t, w, p, Object.assign({}, o, { onStep: (s) => steps.push(s) }));
            const t0 = Date.now();
            const deleted = await audit.sweep(180);
            spinning = false;
            assert.strictEqual(deleted, TOTAL - 1000);
            assert.strictEqual(db.get('SELECT COUNT(*) AS n FROM audit').n, 1000);
            const sorted = steps.map((s) => s.ms).sort((a, b) => a - b);
            const p99 = sorted[Math.floor(sorted.length * 0.99)];
            assert.ok(steps.length >= 999, `batches: ${steps.length}`);
            assert.ok(p99 <= 50, `p99 batch step ${p99.toFixed(1)} ms`);
            assert.ok(sorted[sorted.length - 1] < 250, `max batch step ${sorted[sorted.length - 1].toFixed(1)} ms`);
            assert.ok(yields >= steps.length / 2, `event loop yielded ${yields} times over ${steps.length} batches`);
            assert.ok(Date.now() - t0 < 20000);
        } finally {
            db.close();
            removeDir(dir);
        }
    }],
    ['sweeps checkpoint in the background: autocheckpoint restored, overlapping sweeps share one checkpointer, WAL bounded', async () => {
        const dir = tmpDir();
        const file = path.join(dir, 'relay.db');
        const db = openDatabase(file);
        try {
            migrate(db);
            const old = Date.now() - 400 * 86400000;
            db.transaction(() => {
                const st = db.raw.prepare('INSERT INTO audit(ts, user_id, device_id, action, detail) VALUES (?, ?, ?, ?, ?)');
                for (let i = 0; i < 300000; i++) st.run(old + i, 'u_aaaaaaaaaaaa', 'd_aaaaaaaaaaaa', 'cmd', '{"type":"jog.step"}');
            });
            db.checkpoint();
            const before = Number(db.pragma('wal_autocheckpoint'));
            let sawOff = false;
            let maxWal = 0;
            const walSize = () => { try { return fs.statSync(`${file}-wal`).size; } catch (_) { return 0; } };
            const onStep = () => {
                if (Number(db.pragma('wal_autocheckpoint')) === 0) sawOff = true;
                maxWal = Math.max(maxWal, walSize());
            };
            // Two overlapping sweeps on different tables: the checkpointer must stay up until both finish.
            const [a, b] = await Promise.all([
                db.deleteBatched('audit', 'ts < ?', [Date.now()], { onStep }),
                db.deleteBatched('revoked_credentials', 'revoked_at <= ?', [Date.now()], { onStep }),
            ]);
            assert.strictEqual(a, 300000);
            assert.strictEqual(b, 0);
            assert.ok(sawOff, 'automatic checkpoints are off while a sweep runs');
            assert.strictEqual(Number(db.pragma('wal_autocheckpoint')), before, 'autocheckpoint restored after the last sweep');
            assert.strictEqual(db._checkpointer, null, 'checkpointer released');
            // Without any checkpoint this sweep leaves a WAL of ~16 MB; the background
            // checkpointer lets SQLite reuse the WAL so it stays well below that.
            assert.ok(maxWal < 12 * 1024 * 1024, `WAL stayed bounded (max ${(maxWal / 1048576).toFixed(1)} MiB)`);
        } finally {
            db.close();
            removeDir(dir);
        }
    }],
]);
