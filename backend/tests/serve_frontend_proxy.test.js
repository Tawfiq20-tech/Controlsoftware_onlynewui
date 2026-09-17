'use strict';

/**
 * scripts/serve-frontend.js (kiosk on :3000/:3001) must reach the backend:
 * /api and /socket.io are proxied to it on loopback, so the ?op= operator
 * claim works from the RUN_FRONTEND_* kiosk. The proxy must never widen trust:
 * no forwarding headers are added, non-loopback clients are refused, and static
 * serving cannot escape frontend/dist. Ephemeral ports only.
 */

process.env.NODE_ENV = 'test';
process.env.CNC_BACKEND_NO_AUTOSTART = '1';
process.env.NO_BROWSER = '1';
process.env.NO_MDNS = '1';
if (!process.env.LOG_LEVEL) process.env.LOG_LEVEL = 'error';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const { createFrontendServer, isLoopbackAddress } = require('../../scripts/serve-frontend');
const { createBackend } = require('../index');
const { ConfigStore } = require('../services/ConfigStore');
const { FakeEngine } = require('./helpers/fakeEngine');
const mirrorSingleton = require('../services/RemoteDiagMirror');

let passed = 0;
async function test(name, fn) {
    await fn();
    passed += 1;
    console.log(`  ok - ${name}`);
}

function request(host, port, method, urlPath, { headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
        const req = http.request({
            host, port, method, path: urlPath,
            headers: { ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}), ...headers },
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let json = null;
                try { json = JSON.parse(text); } catch (_) { /* not JSON */ }
                resolve({ status: res.statusCode, headers: res.headers, text, body: json });
            });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

function listen(server, host) {
    return new Promise((resolve) => server.listen(0, host, () => resolve(server.address().port)));
}

function startFrontend(backendPort, host) {
    return new Promise((resolve) => {
        const log = console.log;
        console.log = () => {};
        const server = createFrontendServer(0, 'horizontal', {
            backendPort,
            host,
            onListening: (p) => { console.log = log; resolve({ server, port: p }); },
        });
    });
}

function lanAddress() {
    for (const list of Object.values(os.networkInterfaces())) {
        for (const a of list || []) {
            if (a.family === 'IPv4' && !a.internal) return a.address;
        }
    }
    return null;
}

async function main() {
    console.log('=== serve_frontend_proxy.test.js ===');
    const closers = [];
    try {
        await test('isLoopbackAddress', async () => {
            assert(isLoopbackAddress('127.0.0.1'));
            assert(isLoopbackAddress('::ffff:127.0.0.1'));
            assert(isLoopbackAddress('::1'));
            assert(!isLoopbackAddress('192.168.1.5'));
            assert(!isLoopbackAddress('::ffff:10.0.0.1'));
            assert(!isLoopbackAddress(undefined));
        });

        // Header capture: the proxy adds no forwarding headers.
        const seen = [];
        const capture = http.createServer((req, res) => {
            seen.push({ url: req.url, headers: req.headers, remote: req.socket.remoteAddress });
            res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'x=1; HttpOnly' });
            res.end(JSON.stringify({ echoed: true }));
        });
        const capturePort = await listen(capture, '127.0.0.1');
        closers.push(() => new Promise((r) => capture.close(r)));
        const f1 = await startFrontend(capturePort);
        closers.push(() => new Promise((r) => { f1.server.closeAllConnections?.(); f1.server.close(r); }));

        await test('/api is proxied to the backend on loopback with the client headers unchanged and nothing added', async () => {
            const r = await request('127.0.0.1', f1.port, 'POST', '/api/remote/operator/claim?x=1', {
                headers: { Origin: `http://localhost:${f1.port}`, Cookie: 'onefinity_op=abc' },
                body: { secret: 'abc' },
            });
            assert.strictEqual(r.status, 200);
            assert.deepStrictEqual(r.body, { echoed: true });
            assert.match(String(r.headers['set-cookie']), /x=1/);
            const s = seen[seen.length - 1];
            assert.strictEqual(s.url, '/api/remote/operator/claim?x=1');
            assert(isLoopbackAddress(s.remote));
            assert.strictEqual(s.headers.cookie, 'onefinity_op=abc');
            assert.strictEqual(s.headers.host, `127.0.0.1:${f1.port}`);
            for (const h of ['x-forwarded-for', 'forwarded', 'x-real-ip', 'x-forwarded-host', 'x-forwarded-proto', 'via']) {
                assert.strictEqual(s.headers[h], undefined, `proxy added ${h}`);
            }
        });

        await test('static serving stays inside frontend/dist (no path traversal to backend/data)', async () => {
            const before = seen.length;
            for (const p of ['/../../backend/package.json', '/..%2f..%2fbackend%2fpackage.json', '/..\\..\\backend\\package.json']) {
                const r = await request('127.0.0.1', f1.port, 'GET', p);
                assert(!/"name"\s*:/.test(r.text) || /<html/i.test(r.text), `${p} leaked a file outside dist`);
            }
            assert.strictEqual(seen.length, before, 'static paths are not proxied');
        });

        const lan = lanAddress();
        await test(`non-loopback clients are refused by the proxy (${lan || 'no LAN address, skipped'})`, async () => {
            if (!lan) return;
            const before = seen.length;
            const r = await request(lan, f1.port, 'GET', '/api/state');
            assert.strictEqual(r.status, 403);
            assert.strictEqual(r.body.error, 'backend_proxy_loopback_only');
            assert.strictEqual(seen.length, before, 'nothing reached the backend');
            await new Promise((resolve, reject) => {
                const ws = new WebSocket(`ws://${lan}:${f1.port}/socket.io/?EIO=4&transport=websocket`);
                ws.on('open', () => reject(new Error('LAN websocket must not be proxied')));
                ws.on('error', () => resolve());
                ws.on('unexpected-response', () => resolve());
            });
        });

        // Real backend wiring: the kiosk becomes operator through the proxy.
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cnc-serve-frontend-'));
        const dataDir = path.join(tmp, 'data');
        fs.mkdirSync(dataDir, { recursive: true });
        const engine = new FakeEngine({ controllerType: 'RSP' });
        engine.config = new ConfigStore(path.join(dataDir, 'config.json'));
        engine.setStatus({ activeState: 'Idle' });
        const backend = createBackend({
            port: 0, dataDir, isTest: true, initServices: false,
            createEngine: () => engine,
            createCloudLink: () => ({
                init() {}, stop: async () => {}, applyLanOnly() {}, getStatus: () => ({ lanOnly: false }), getPairing: () => null,
            }),
            createMdns: () => ({ start() { return this; }, stop: async () => {}, setHostname() {}, getStatus: () => ({ state: 'stopped' }) }),
            remoteDiagMirror: new mirrorSingleton.constructor(),
        });
        const bPort = (await backend.start({ host: '127.0.0.1', listenPort: 0, exitOnError: false })).port;
        closers.push(async () => { await backend.shutdown(); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* locks */ } });
        const f2 = await startFrontend(bPort);
        closers.push(() => new Promise((r) => { f2.server.closeAllConnections?.(); f2.server.close(r); }));
        const origin = `http://localhost:${f2.port}`;

        await test('kiosk on the frontend port: operator claim returns JSON and the cookie makes it operator', async () => {
            const secret = backend.operatorToken.getLaunchSecret();
            const bad = await request('127.0.0.1', f2.port, 'POST', '/api/remote/operator/claim', {
                headers: { Origin: origin, Host: `localhost:${f2.port}` }, body: { secret: '0'.repeat(64) },
            });
            assert.strictEqual(bad.status, 403);
            const claim = await request('127.0.0.1', f2.port, 'POST', '/api/remote/operator/claim', {
                headers: { Origin: origin, Host: `localhost:${f2.port}` }, body: { secret },
            });
            assert.strictEqual(claim.status, 200, claim.text.slice(0, 200));
            assert.deepStrictEqual(claim.body, { operator: true });
            const cookie = /onefinity_op=[^;]+/.exec([].concat(claim.headers['set-cookie']).join(';'))[0];
            const info = await request('127.0.0.1', f2.port, 'GET', '/api/remote/info', {
                headers: { Origin: origin, Host: `localhost:${f2.port}`, Cookie: cookie },
            });
            assert.strictEqual(info.body.operator, true);
            assert.strictEqual(info.body.identity, 'operator');
            const local = await request('127.0.0.1', f2.port, 'GET', '/api/remote/info', { headers: { Host: `localhost:${f2.port}` } });
            assert.strictEqual(local.body.identity, 'local', 'no cookie: local, never operator');
        });

        await test('Socket.IO WebSocket upgrades are proxied to the backend', async () => {
            const first = await new Promise((resolve, reject) => {
                const ws = new WebSocket(`ws://127.0.0.1:${f2.port}/socket.io/?EIO=4&transport=websocket`, { headers: { Origin: origin } });
                const timer = setTimeout(() => { ws.terminate(); reject(new Error('no engine.io open packet')); }, 5000);
                ws.on('message', (m) => { clearTimeout(timer); ws.close(); resolve(String(m)); });
                ws.on('error', (e) => { clearTimeout(timer); reject(e); });
            });
            assert.match(first, /^0\{/, 'engine.io open packet');
            const poll = await request('127.0.0.1', f2.port, 'GET', '/socket.io/?EIO=4&transport=polling', { headers: { Origin: origin } });
            assert.strictEqual(poll.status, 200);
            assert.match(poll.text, /^0\{/, 'polling reaches Socket.IO, not index.html');
        });
    } finally {
        for (const close of closers.reverse()) {
            try { await close(); } catch (_) { /* best effort */ }
        }
    }
    console.log(`All ${passed} serve-frontend proxy tests passed`);
}

const timeout = setTimeout(() => { console.error('Test timed out'); process.exit(1); }, 60000);
timeout.unref();

main().then(() => process.exit(0)).catch((err) => {
    console.error('serve_frontend_proxy.test.js FAILED:', err);
    process.exit(1);
});

// tests/run-all.js treats a run as finished only when it prints this line.
// These suites came from the remote-access branch, which ran them directly;
// they signal failure with a non-zero exit, so a clean exit means pass.
process.on('exit', (code) => { if (code === 0) console.log('ALL TESTS PASSED SUCCESSFULLY!'); });
