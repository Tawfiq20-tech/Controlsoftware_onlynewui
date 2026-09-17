'use strict';

process.env.NODE_ENV = 'test';

const http = require('http');
const path = require('path');
const { createRelay } = require('../../server/relay');
const { createLogger } = require('../../server/log');
const { hashPassword } = require('../../server/auth/passwords');
const { newId } = require('../../server/auth/tokens');
const { tmpDir, removeDir } = require('./tmp');

const BIG_DISK = () => ({ bavail: 1e12, bsize: 4096 });

function withTimeout(promise, ms, label) {
    let t;
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            t = setTimeout(() => reject(new Error(`timeout: ${label}`)), ms);
        }),
    ]).finally(() => clearTimeout(t));
}

async function startRelay(opts = {}) {
    const dataDir = opts.dataDir || tmpDir();
    const logs = [];
    const log = createLogger({ level: 'debug', write: (line) => logs.push(line) });
    const relay = await createRelay(Object.assign({
        host: '127.0.0.1', port: 0, dataDir, allowInsecure: true, signup: 'open', log, statfs: BIG_DISK,
        limits: { wsUpgradesPerKeyPerMin: 1000 },
    }, opts, { limits: Object.assign({ wsUpgradesPerKeyPerMin: 1000 }, opts.limits || {}) }));
    relay.dataDir = dataDir;
    relay.logs = logs;
    relay.app = relay.__test.app;
    return relay;
}

async function stopRelay(relay, { keepDir = false } = {}) {
    if (!relay) return;
    await relay.close();
    if (!keepDir) removeDir(relay.dataDir);
}

function request(relay, method, urlPath, opts = {}) {
    const u = new URL(urlPath, relay.url);
    const headers = Object.assign({}, opts.headers || {});
    let payload = null;
    if (opts.json !== undefined) {
        payload = Buffer.from(JSON.stringify(opts.json));
        headers['Content-Type'] = 'application/json';
    } else if (opts.body !== undefined) {
        payload = Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(String(opts.body));
    }
    if (payload && headers['Content-Length'] === undefined && !opts.noLength) headers['Content-Length'] = payload.length;
    if (opts.session) {
        headers.Cookie = [opts.session.cookie].concat(opts.extraCookies || []).join('; ');
        if (method !== 'GET' && opts.csrf !== false) headers['X-CSRF-Token'] = opts.csrfToken || opts.session.csrfToken;
    } else if (opts.cookie) {
        headers.Cookie = opts.cookie;
    }
    if (opts.bearer) headers.Authorization = 'Bearer ' + opts.bearer;
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: u.hostname, port: u.port, path: opts.rawPath || (u.pathname + u.search), method, headers, agent: false,
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const buf = Buffer.concat(chunks);
                let json = null;
                try { json = JSON.parse(buf.toString('utf8')); } catch (_) { /* not json */ }
                resolve({ status: res.statusCode, headers: res.headers, body: buf, text: buf.toString('utf8'), json });
            });
            res.on('error', reject);
        });
        req.on('error', reject);
        if (opts.onRequest) opts.onRequest(req);
        if (payload && !opts.manualBody) req.end(payload);
        else if (!opts.manualBody) req.end();
    });
}

// Raw socket request for cases http.request refuses to produce (lying Content-Length,
// a body that stalls). Resolves with the parsed status line and body once the server
// answers or closes.
function rawHttp(relay, head, body, { timeoutMs = 3000 } = {}) {
    const net = require('net');
    const u = new URL(relay.url);
    return new Promise((resolve) => {
        const sock = net.connect(Number(u.port), u.hostname);
        let data = '';
        const done = () => {
            const m = /^HTTP\/1\.1 (\d{3})/.exec(data);
            const idx = data.indexOf('\r\n\r\n');
            resolve({ status: m ? Number(m[1]) : null, raw: data, body: idx >= 0 ? data.slice(idx + 4) : '' });
            sock.destroy();
        };
        const timer = setTimeout(done, timeoutMs);
        sock.on('data', (d) => {
            data += d.toString();
            const idx = data.indexOf('\r\n\r\n');
            const len = /content-length: (\d+)/i.exec(data);
            if (idx >= 0 && (!len || data.length - idx - 4 >= Number(len[1]))) {
                clearTimeout(timer);
                done();
            }
        });
        sock.on('error', () => {});
        sock.on('close', () => {
            clearTimeout(timer);
            done();
        });
        sock.write(head.replace(/\n/g, '\r\n') + '\r\n\r\n');
        if (body) sock.write(body);
    });
}

async function createUser(relay, { email, password = 'correct horse battery', name = 'User', admin = false, disabled = false } = {}) {
    const id = newId('u_');
    const e = (email || `${id}@example.com`).toLowerCase();
    relay.db.run('INSERT INTO users(id, email, display_name, password_hash, is_admin, disabled, created_at) VALUES (?,?,?,?,?,?,?)',
        id, e, name, await hashPassword(password), admin ? 1 : 0, disabled ? 1 : 0, Date.now());
    return { id, email: e, password, name };
}

function sessionFromResponse(res, user) {
    const setCookies = [].concat(res.headers['set-cookie'] || []);
    const sc = setCookies.find((c) => /^(__Host-)?ors=/.test(c));
    const kd = setCookies.find((c) => /^(__Host-)?ord=/.test(c));
    return {
        cookie: sc ? sc.split(';')[0] : null,
        knownDeviceCookie: kd ? kd.split(';')[0] : null,
        setCookies,
        csrfToken: res.json && res.json.csrfToken,
        user: (res.json && res.json.user) || user,
        token: sc ? decodeURIComponent(sc.split(';')[0].split('=')[1]) : null,
    };
}

async function login(relay, user, opts = {}) {
    const res = await request(relay, 'POST', '/api/auth/login', { json: { email: user.email, password: user.password }, headers: opts.headers || {} });
    if (res.status !== 200) throw new Error(`login failed ${res.status} ${res.text}`);
    return sessionFromResponse(res, user);
}

async function userWithSession(relay, opts = {}) {
    const user = await createUser(relay, opts);
    const session = await login(relay, user);
    session.userId = user.id;
    session.userRecord = user;
    return session;
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

async function waitUntil(fn, timeoutMs = 2000, label = 'condition') {
    const until = Date.now() + timeoutMs;
    for (;;) {
        const v = await fn();
        if (v) return v;
        if (Date.now() > until) throw new Error(`timeout waiting for ${label}`);
        await sleep(20);
    }
}

// Minimal runner matching §10.1: prints ✓ per test, exits 1 on the first failure.
function runTests(name, tests) {
    console.log(`=== ${name} Tests ===`);
    const hardTimeout = setTimeout(() => {
        console.error(`✗ ${name}: file timed out after 30 s`);
        process.exit(1);
    }, 30000);
    hardTimeout.unref();
    (async () => {
        for (const [title, fn] of tests) {
            try {
                await fn();
                console.log(`✓ ${title}`);
            } catch (err) {
                console.error(`✗ ${title}`);
                console.error(err && err.stack ? err.stack : err);
                process.exit(1);
            }
        }
        console.log(`All ${tests.length} ${name} tests passed`);
        process.exit(0);
    })();
}

module.exports = {
    startRelay, stopRelay, request, rawHttp, createUser, login, userWithSession, sessionFromResponse, sleep, waitUntil, runTests,
    withTimeout, BIG_DISK, tmpDir, removeDir, RELAY_ROOT: path.join(__dirname, '..', '..'),
};
