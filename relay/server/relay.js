'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const defaultClock = require('./clock');
const { createLogger } = require('./log');
const { DEFAULT_LIMITS, DEFAULT_SIGNUP, validatePublicUrl, isLoopbackHost } = require('./config');
const { openDatabase, isBusyError } = require('./store/db');
const { migrate } = require('./store/migrations');
const { BlobStore } = require('./store/blobs');
const { Audit } = require('./audit');
const { Sessions } = require('./auth/sessions');
const { Pairing } = require('./auth/pairing');
const { sha256hex } = require('./auth/tokens');
const { Acl } = require('./acl');
const { Snapshots } = require('./snapshots');
const { Router, httpError, applySecurityHeaders, sendJson } = require('./http/router');
const { createStaticHandler } = require('./http/static');
const { parseCookies, cookieNames } = require('./http/cookies');
const { DeviceHub } = require('./ws/deviceHub');
const { ClientHub } = require('./ws/clientHub');
const { createUpgradeHandler } = require('./ws/upgrade');
const { CLOSE } = require('./protocol/envelope');

const VERSION = require('../package.json').version;

const TICK_MS = 250;
const REVOCATION_POLL_MS = 2000;
const MINUTE_SWEEP_MS = 60000;
const FILE_SWEEP_MS = 10 * 60000;
const DAILY_SWEEP_MS = 24 * 3600000;
const REVOKED_TOMBSTONE_MS = 30 * 86400000;
const UPLOAD_DRAIN_MS = 10000;

function normalizeIp(addr) {
    if (!addr) return '';
    return String(addr).replace(/^::ffff:/, '');
}

function loadServerSecret(dataDir) {
    const file = path.join(dataDir, 'secret');
    try {
        const buf = fs.readFileSync(file);
        if (buf.length >= 32) return buf;
    } catch (_) { /* first boot */ }
    const secret = crypto.randomBytes(32);
    fs.writeFileSync(file, secret, { mode: 0o600 });
    return secret;
}

function installAuthHooks(router, app) {
    router.before.push(async (ctx) => {
        const { req, route } = ctx;
        const method = req.method;
        const mutating = method !== 'GET' && method !== 'HEAD';
        if (mutating && req.headers.origin !== undefined && req.headers.origin !== app.publicOrigin()) {
            throw httpError(403, 'origin');
        }
        const auth = route.opts.auth || 'none';
        if (auth === 'session' || auth === 'admin') {
            const token = parseCookies(req.headers.cookie)[cookieNames(app.allowInsecure).session];
            const session = token ? app.sessions.resolve(token) : null;
            const user = session ? app.db.get('SELECT * FROM users WHERE id = ?', session.userId) : null;
            if (!session || !user || user.disabled) throw httpError(401, 'unauthorized');
            if (mutating && !app.sessions.checkCsrf(session, req.headers['x-csrf-token'])) throw httpError(403, 'csrf');
            if (auth === 'admin' && !user.is_admin) throw httpError(403, 'forbidden');
            ctx.session = session;
            ctx.user = user;
        } else if (auth === 'device') {
            const m = /^Bearer (odc_[A-Za-z0-9_-]{16,100})$/.exec(String(req.headers.authorization || ''));
            if (!m) throw httpError(401, 'invalid');
            const hash = sha256hex(m[1]);
            const device = app.db.get("SELECT * FROM devices WHERE (credential_hash = ? OR previous_credential_hash = ?) AND status = 'active' AND disabled = 0", hash, hash);
            if (!device) throw httpError(401, 'invalid');
            ctx.device = device;
        }
    });
}

async function createRelay(opts = {}) {
    const clock = opts.clock || defaultClock;
    const host = opts.host || '127.0.0.1';
    const port = opts.port == null ? 8787 : opts.port;
    const allowInsecure = !!opts.allowInsecure;
    const trustProxy = !!opts.trustProxy;
    const signup = opts.signup || DEFAULT_SIGNUP;
    if (!['closed', 'invite', 'open'].includes(signup)) throw new Error('invalid signup mode');
    if (allowInsecure && !isLoopbackHost(host)) throw new Error('allowInsecure is refused unless host is loopback');
    if (!opts.dataDir) throw new Error('dataDir is required');
    let publicUrl = opts.publicUrl || null;
    if (publicUrl) {
        const err = validatePublicUrl(publicUrl, allowInsecure);
        if (err) throw new Error(err);
    } else if (!(allowInsecure && isLoopbackHost(host))) {
        throw new Error('publicUrl is required');
    }

    const logger = opts.log || createLogger({ level: 'info', clock });
    const dataDir = path.resolve(opts.dataDir);
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const limits = Object.assign({}, DEFAULT_LIMITS, opts.limits || {});

    const db = openDatabase(opts.dbPath || path.join(dataDir, 'relay.db'), { busyTimeoutMs: 200 });
    migrate(db);

    const app = {
        version: VERSION, clock, logger, db, limits, signup, allowInsecure, trustProxy, dataDir,
        closing: false, inflight: 0, lowDisk: false, isBusyError,
        serverSecret: loadServerSecret(dataDir),
        publicOrigin: () => new URL(publicUrl).origin,
        publicUrl: () => publicUrl,
        clientIp(req) {
            const peer = normalizeIp(req.socket && req.socket.remoteAddress);
            if (trustProxy && (peer === '127.0.0.1' || peer === '::1')) {
                const xff = req.headers['x-forwarded-for'];
                if (typeof xff === 'string' && xff.trim()) {
                    const parts = xff.split(',').map((s) => s.trim()).filter(Boolean);
                    if (parts.length) return normalizeIp(parts[parts.length - 1]);
                }
            }
            return peer;
        },
    };
    app.blobs = new BlobStore({ dir: path.join(dataDir, 'blobs'), statfs: opts.statfs || fs.statfsSync, logger });
    app.blobs.cleanupOrphans();
    app.audit = new Audit({ db, clock, logger });
    app.sessions = new Sessions({ db, clock, logger });
    app.acl = new Acl({ db });
    app.pairing = new Pairing({ db, clock, audit: app.audit, limits, getPublicUrl: () => publicUrl, logger });
    app.snapshots = new Snapshots({ clock, limits });
    const { TransferManager } = require('./http/routes/files');
    app.transfers = new TransferManager(app);
    app.hubs = {};
    app.hubs.device = new DeviceHub(app);
    app.hubs.client = new ClientHub(app);
    app.sessions.onRevoked((hashes, reason) => app.hubs.client.closeTokenHashes(hashes, reason));

    const router = new Router({ logger, allowInsecure });
    installAuthHooks(router, app);
    for (const name of ['auth', 'devices', 'files', 'camera', 'audit', 'admin', 'deviceApi']) {
        require('./http/routes/' + name).register(router, app);
    }
    const serveStatic = createStaticHandler({ webDir: opts.webDir || path.join(__dirname, '..', 'web') });

    const server = http.createServer((req, res) => {
        applySecurityHeaders(res, { allowInsecure });
        if (app.closing) res.setHeader('Connection', 'close');
        router.handle(req, res, app).then((handled) => {
            if (!handled) serveStatic(req, res);
        }).catch((err) => {
            logger.error('request failed', { err });
            sendJson(res, 500, { error: 'internal' });
        });
    });
    server.keepAliveTimeout = 65000;
    server.headersTimeout = 66000;
    server.requestTimeout = 0;

    const upgrade = createUpgradeHandler(app);
    server.on('upgrade', upgrade.onUpgrade);
    server.on('clientError', (err, socket) => {
        if (!socket.destroyed) socket.destroy();
    });

    // Timers: one fast tick; slower sweeps are scheduled from the (injectable) monotonic
    // clock so tests can jump time instead of sleeping.
    const lastRun = { revocations: clock.mono(), minute: clock.mono(), files: clock.mono(), daily: clock.mono() };
    const running = new Set();
    function runAsync(name, fn) {
        if (running.has(name)) return Promise.resolve();
        running.add(name);
        return Promise.resolve().then(fn).catch((err) => {
            if (!app.closing) logger.error('sweep failed', { sweep: name, err });
        }).finally(() => running.delete(name));
    }
    const sweeps = {
        revocations: () => app.sessions.pollRevocations(),
        minute: async () => {
            app.sessions.sweepExpired();
            app.pairing.sweep();
            app.hubs.device.sweepRotations();
            app.snapshots.prune();
            app.lowDisk = app.blobs.freeBytes() < limits.minFreeDiskMb * 1024 * 1024;
            await db.deleteBatched('revoked_credentials', 'revoked_at <= ?', [clock.now() - REVOKED_TOMBSTONE_MS], { mono: clock.mono });
        },
        files: () => app.transfers.sweep(),
        daily: () => app.audit.sweep(limits.auditRetentionDays),
    };
    const periods = { revocations: REVOCATION_POLL_MS, minute: MINUTE_SWEEP_MS, files: FILE_SWEEP_MS, daily: DAILY_SWEEP_MS };
    const ticker = setInterval(() => {
        if (app.closing || !db.open) return;
        try {
            app.hubs.device.tick();
            app.hubs.client.tick();
        } catch (err) {
            logger.error('tick failed', { err });
        }
        const now = clock.mono();
        for (const name of Object.keys(periods)) {
            if (now - lastRun[name] >= periods[name]) {
                lastRun[name] = now;
                runAsync(name, sweeps[name]);
            }
        }
    }, TICK_MS);
    ticker.unref();

    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
            server.removeListener('error', reject);
            resolve();
        });
    });
    const addr = server.address();
    const hostForUrl = addr.family === 'IPv6' ? `[${addr.address}]` : addr.address;
    const url = `http://${hostForUrl}:${addr.port}`;
    if (!publicUrl) publicUrl = url;
    app.lowDisk = app.blobs.freeBytes() < limits.minFreeDiskMb * 1024 * 1024;
    logger.info('relay listening', { url, publicUrl, signup });

    let closePromise = null;
    function close() {
        if (closePromise) return closePromise;
        closePromise = (async () => {
            app.closing = true;
            clearInterval(ticker);
            server.close();
            const sockets = [...app.hubs.device.conns.values(), ...app.hubs.client.conns.values()].map((c) => c.ws);
            app.hubs.device.closeAll(CLOSE.GOING_AWAY, 'relay restarting');
            app.hubs.client.closeAll(CLOSE.GOING_AWAY, 'relay restarting');
            upgrade.close();
            const deadline = Date.now() + UPLOAD_DRAIN_MS;
            while (app.inflight > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
            const wsDeadline = Date.now() + 1000;
            while (sockets.some((ws) => ws.readyState !== 3) && Date.now() < wsDeadline) await new Promise((r) => setTimeout(r, 20));
            for (const ws of sockets) if (ws.readyState !== 3) ws.terminate();
            if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
            for (const name of running) logger.debug('sweep still running at shutdown', { sweep: name });
            app.audit.close();
            db.checkpoint();
            db.close();
            logger.info('relay stopped');
        })();
        return closePromise;
    }

    const hubs = app.hubs;
    if (process.env.NODE_ENV === 'test') {
        hubs.client.__setRttForTest = (connId, ms) => hubs.client.setRtt(connId, ms);
        hubs.client.__connForTest = (connId) => hubs.client.conn(connId);
        hubs.device.__lastRxForTest = (deviceId) => hubs.device.lastRxAt(deviceId);
    }

    const relay = { server, url, db, hubs, close };
    if (process.env.NODE_ENV === 'test') {
        relay.__test = {
            app,
            async runSweeps(names = Object.keys(sweeps)) {
                for (const n of names) await sweeps[n]();
            },
            tick() {
                app.hubs.device.tick();
                app.hubs.client.tick();
            },
        };
    }
    return relay;
}

module.exports = { createRelay };
