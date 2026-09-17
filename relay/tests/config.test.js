'use strict';

const assert = require('assert');
const { runTests, tmpDir, removeDir } = require('./helpers/harness');
const { parseConfig, DEFAULT_SIGNUP } = require('../server/config');
const { createRelay } = require('../server/relay');
const { silentLogger } = require('../server/log');

const base = { RELAY_PUBLIC_URL: 'https://relay.example.com' };

runTests('Relay Config', [
    ['RELAY_PUBLIC_URL is required', () => {
        const r = parseConfig({});
        assert.strictEqual(r.ok, false);
        assert.ok(r.errors.some((e) => /RELAY_PUBLIC_URL is required/.test(e)));
    }],
    ['defaults are applied', () => {
        const r = parseConfig(base, { cwd: '/srv/relay' });
        assert.strictEqual(r.ok, true, r.errors.join('\n'));
        const c = r.config;
        assert.strictEqual(c.host, '127.0.0.1');
        assert.strictEqual(c.port, 8787);
        assert.strictEqual(c.trustProxy, false);
        assert.strictEqual(c.allowInsecure, false);
        assert.strictEqual(c.limits.maxUploadMb, 25);
        assert.strictEqual(c.limits.userQuotaMb, 1024);
        assert.strictEqual(c.limits.totalStorageMb, 5120);
        assert.strictEqual(c.limits.minFreeDiskMb, 1024);
        assert.strictEqual(c.limits.maxDevicesPerUser, 10);
        assert.strictEqual(c.limits.maxLivePairings, 1000);
        assert.strictEqual(c.limits.fileTtlDays, 7);
        assert.strictEqual(c.limits.snapshotMaxFps, 2);
        assert.strictEqual(c.limits.snapshotMaxKb, 300);
        assert.strictEqual(c.limits.auditRetentionDays, 180);
        assert.strictEqual(c.limits.credRotateDays, 90);
        assert.strictEqual(c.logLevel, 'info');
    }],
    ['default signup is invite-only (Decision D5)', () => {
        assert.strictEqual(DEFAULT_SIGNUP, 'invite');
        assert.strictEqual(parseConfig(base).config.signup, 'invite');
        assert.strictEqual(parseConfig(Object.assign({}, base, { RELAY_SIGNUP: 'open' })).config.signup, 'open');
        assert.strictEqual(parseConfig(Object.assign({}, base, { RELAY_SIGNUP: 'bogus' })).ok, false);
    }],
    ['public URL must be https unless loopback + insecure', () => {
        assert.strictEqual(parseConfig({ RELAY_PUBLIC_URL: 'http://relay.example.com' }).ok, false);
        assert.strictEqual(parseConfig({ RELAY_PUBLIC_URL: 'http://127.0.0.1:8787' }).ok, false);
        assert.strictEqual(parseConfig({ RELAY_PUBLIC_URL: 'http://127.0.0.1:8787', RELAY_ALLOW_INSECURE: '1' }).ok, true);
        assert.strictEqual(parseConfig({ RELAY_PUBLIC_URL: 'http://localhost:8787', RELAY_ALLOW_INSECURE: '1' }).ok, true);
        assert.strictEqual(parseConfig({ RELAY_PUBLIC_URL: 'http://relay.example.com', RELAY_ALLOW_INSECURE: '1' }).ok, false);
        assert.strictEqual(parseConfig({ RELAY_PUBLIC_URL: 'ftp://relay.example.com' }).ok, false);
        assert.strictEqual(parseConfig({ RELAY_PUBLIC_URL: 'not a url' }).ok, false);
    }],
    ['insecure mode is refused on a non-loopback bind address', () => {
        const r = parseConfig({ RELAY_PUBLIC_URL: 'http://127.0.0.1:8787', RELAY_ALLOW_INSECURE: '1', RELAY_HOST: '0.0.0.0' });
        assert.strictEqual(r.ok, false);
        assert.ok(r.errors.some((e) => /loopback/.test(e)));
    }],
    ['numeric bounds are enforced', () => {
        const bad = {
            RELAY_MAX_UPLOAD_MB: '0', RELAY_SNAPSHOT_MAX_FPS: '3', RELAY_SNAPSHOT_MAX_KB: '49', RELAY_MAX_DEVICES_PER_USER: '101',
            RELAY_PORT: '70000',
        };
        for (const [k, v] of Object.entries(bad)) {
            const r = parseConfig(Object.assign({}, base, { [k]: v }));
            assert.strictEqual(r.ok, false, `${k}=${v} should be rejected`);
            assert.ok(r.errors.some((e) => e.includes(k)), `error mentions ${k}`);
        }
        assert.strictEqual(parseConfig(Object.assign({}, base, { RELAY_MAX_UPLOAD_MB: '100', RELAY_SNAPSHOT_MAX_KB: '500' })).ok, true);
        assert.strictEqual(parseConfig(Object.assign({}, base, { RELAY_MAX_UPLOAD_MB: 'abc' })).ok, false);
        const tooSmall = parseConfig(Object.assign({}, base, { RELAY_MAX_UPLOAD_MB: '50', RELAY_TOTAL_STORAGE_MB: '40' }));
        assert.strictEqual(tooSmall.ok, false);
        assert.strictEqual(parseConfig(Object.assign({}, base, { RELAY_CRED_ROTATE_DAYS: '0' })).config.limits.credRotateDays, 0);
    }],
    ['every invalid entry is reported, one per error', () => {
        const r = parseConfig({ RELAY_MAX_UPLOAD_MB: '0', RELAY_SIGNUP: 'x' });
        assert.ok(r.errors.length >= 3);
    }],
    ['createRelay refuses insecure non-loopback and missing publicUrl', async () => {
        const dir = tmpDir();
        try {
            await assert.rejects(createRelay({ host: '0.0.0.0', port: 0, dataDir: dir, allowInsecure: true, log: silentLogger }), /loopback/);
            await assert.rejects(createRelay({ port: 0, dataDir: dir, log: silentLogger }), /publicUrl/);
            await assert.rejects(createRelay({ port: 0, dataDir: dir, publicUrl: 'http://example.com', log: silentLogger }), /https/);
        } finally {
            removeDir(dir);
        }
    }],
    ['server/index.js exits 1 on invalid config', async () => {
        const { spawnSync } = require('child_process');
        const path = require('path');
        const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server', 'index.js')], {
            env: Object.assign({}, process.env, { RELAY_PUBLIC_URL: '', RELAY_PORT: '0' }), encoding: 'utf8', timeout: 10000,
        });
        assert.strictEqual(r.status, 1);
        assert.ok(/RELAY_PUBLIC_URL is required/.test(r.stderr));
    }],
]);
