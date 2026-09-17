'use strict';

/**
 * Remote access integration (spec 10.6): the real backend/index.js wiring
 * (RemoteAccessService + OperatorToken + DeviceIdentity + LAN allowlist +
 * RemoteCommandGate) against a fake engine and a stub CloudLinkService, on an
 * ephemeral port. No outbound connections: the cloud link is a stub, mDNS is
 * never started, and the diag mirror is a private blocked instance.
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

const { createBackend, loadDeviceIdentity, redactUrl, redactCloudStatus } = require('../index');
const policy = require('../services/remoteAccess/policy');
const { ConfigStore } = require('../services/ConfigStore');
const { WatchDirService } = require('../services/watchdir/WatchDirService');
const { FakeEngine } = require('./helpers/fakeEngine');
const mirrorSingleton = require('../services/RemoteDiagMirror');

const BACKEND_DATA_DIR = path.resolve(__dirname, '..', 'data');

let passed = 0;
async function test(name, fn) {
    await fn();
    passed += 1;
    console.log(`  ok - ${name}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate, timeoutMs, what) {
    const until = Date.now() + timeoutMs;
    for (;;) {
        if (predicate()) return;
        if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
        await sleep(20);
    }
}

// ─── HTTP helper ──────────────────────────────────────────────────────

let PORT = 0;

function request(method, urlPath, { headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
        const req = http.request({
            host: '127.0.0.1',
            port: PORT,
            method,
            path: urlPath,
            headers: {
                ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
                ...headers,
            },
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

// ─── Minimal Socket.IO v4 client over ws (no socket.io-client in backend) ──

function connectSocket(headers = {}) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${PORT}/socket.io/?EIO=4&transport=websocket`, { headers });
        const client = {
            ws,
            events: [],
            acks: new Map(),
            nextAck: 1,
            connected: false,
            closed: false,
            emit(event, ...args) {
                ws.send(`42${JSON.stringify([event, ...args])}`);
            },
            emitWithAck(event, ...args) {
                const id = client.nextAck++;
                return new Promise((res) => {
                    client.acks.set(id, res);
                    ws.send(`42${id}${JSON.stringify([event, ...args])}`);
                });
            },
            received(name) {
                return client.events.filter((e) => e.name === name).map((e) => e.args[0]);
            },
            last(name) {
                const all = client.received(name);
                return all[all.length - 1];
            },
            clear() {
                client.events.length = 0;
            },
            close() {
                try { ws.close(); } catch (_) { /* already closed */ }
            },
        };
        ws.on('message', (data) => {
            const msg = data.toString();
            if (msg[0] === '0') {
                ws.send('40');
            } else if (msg === '2') {
                ws.send('3');
            } else if (msg.startsWith('40')) {
                client.connected = true;
                resolve(client);
            } else if (msg.startsWith('44')) {
                reject(new Error(`socket refused: ${msg.slice(2)}`));
            } else if (msg.startsWith('42')) {
                const parsed = JSON.parse(msg.slice(2));
                client.events.push({ name: parsed[0], args: parsed.slice(1) });
            } else if (msg.startsWith('43')) {
                const m = /^43(\d+)(.*)$/.exec(msg);
                const res = client.acks.get(Number(m[1]));
                if (res) {
                    client.acks.delete(Number(m[1]));
                    res(JSON.parse(m[2])[0]);
                }
            }
        });
        ws.on('close', () => { client.closed = true; });
        ws.on('error', reject);
    });
}

// ─── Fixture ──────────────────────────────────────────────────────────

function makeCloudLinkStub(deps) {
    const calls = { applyLanOnly: [], init: 0, stop: 0 };
    const status = {
        enabled: true, lanOnly: false, relayUrl: 'https://relay.example.com/base', paired: true,
        relayDeviceId: 'd_abc', accountLabel: 's***@example.com', pairedAt: 1789500000000,
        state: 'online', since: 1789500000000, rttMs: 40, viewers: 1, nextRetryAt: null,
        lastError: 'relay said something private',
    };
    return {
        deps,
        calls,
        init() { calls.init += 1; },
        getStatus() { return { ...status, lanOnly: deps.isLanOnly() }; },
        getPairing() { return null; },
        setRelayUrl(url) { if (typeof url !== 'string') throw new Error('invalid_url'); return this.getStatus(); },
        setEnabled() { return this.getStatus(); },
        setLimits() { return this.getStatus(); },
        startPairing: async () => { throw new Error('already_paired'); },
        confirmPairing: async () => { throw new Error('not_claimed'); },
        rejectPairing: async () => { throw new Error('not_claimed'); },
        cancelPairing() {},
        unpair: async () => {},
        applyLanOnly(on) { calls.applyLanOnly.push(on); },
        stop: async () => { calls.stop += 1; },
    };
}

function spyOn(obj, method) {
    const original = obj[method];
    const spy = { calls: [] };
    obj[method] = function spied(...args) {
        spy.calls.push(args);
        return original.apply(this, args);
    };
    spy.restore = () => { obj[method] = original; };
    return spy;
}

async function main() {
    console.log('=== remote_integration.test.js ===');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cnc-remote-int-'));
    const dataDir = path.join(tmp, 'data');
    fs.mkdirSync(dataDir, { recursive: true });

    const engine = new FakeEngine({ controllerType: 'RSP' });
    engine.config = new ConfigStore(path.join(dataDir, 'config.json'));
    engine.listPorts = async () => [];
    engine.pingNow = async () => ({ ok: true, rttMs: 1 });
    engine._closeConnection = () => {};
    engine._handleOpen = (s, p, o, cb) => cb(null);

    // A private mirror instance: the singleton must not be touched by tests.
    const mirror = new mirrorSingleton.constructor();
    let cloudLinkStub = null;
    let mdnsStarted = 0;

    const backend = createBackend({
        port: 0,
        dataDir,
        isTest: true,
        initServices: false,
        createEngine: () => engine,
        createCloudLink: (deps) => (cloudLinkStub = makeCloudLinkStub(deps)),
        createMdns: () => ({
            start() { mdnsStarted += 1; return this; },
            stop: async () => {},
            getStatus: () => ({ state: 'stopped', hostname: 'onefinity-test.local', addresses: [], error: null }),
        }),
        remoteDiagMirror: mirror,
    });

    // Stand-ins for the handlers CNCEngine registers on a real engine.
    const handled = [];
    backend.io.on('connection', (socket) => {
        const record = (event) => (...args) => {
            handled.push({ event, socketId: socket.id, args: args.filter((a) => typeof a !== 'function') });
            const cb = args[args.length - 1];
            if (typeof cb === 'function') cb({ ok: true, event });
        };
        socket.on('command', (portPath, cmd, ...rest) => {
            handled.push({ event: 'command', cmd, socketId: socket.id, args: rest });
        });
        for (const ev of ['hPing', 'list', 'macro:list', 'trigger:list', 'health:metrics', 'command:raw', 'write',
            'config:set', 'config:get', 'config:getAll', 'tool:list', 'debug:getEntries', 'firmware:flash', 'macro:run',
            'file:load', 'file:unload']) {
            socket.on(ev, record(ev));
        }
    });

    const started = await backend.start({ host: '127.0.0.1', listenPort: 0, exitOnError: false });
    PORT = started.port;
    const sockets = [];

    try {
        engine.setStatus({ activeState: 'Idle' });

        const accessCode = backend.deviceIdentity.getAccessCode();
        const PROXIED = { 'X-Forwarded-For': '192.168.1.77' };

        // ── identities ──────────────────────────────────────────────
        let lanToken;
        let operatorCookie;

        await test('fresh identity makes the access code the LAN PIN; mDNS and cloud link are not started in test mode', async () => {
            assert.strictEqual(backend.remoteAccessService.getPinSource(), 'access-code');
            assert.strictEqual(mdnsStarted, 0);
            assert.strictEqual(cloudLinkStub.calls.init, 0);
        });

        await test('a proxied request without a session is unauthorized; verify-pin issues a LAN session', async () => {
            const r = await request('GET', '/api/state', { headers: PROXIED });
            assert.strictEqual(r.status, 401);
            const v = await request('POST', '/api/remote/verify-pin', { headers: PROXIED, body: { pin: accessCode } });
            assert.strictEqual(v.status, 200);
            lanToken = v.body.token;
            const ok = await request('GET', '/api/state', { headers: { ...PROXIED, 'X-Remote-Token': lanToken } });
            assert.strictEqual(ok.status, 200);
        });

        const LAN = () => ({ ...PROXIED, 'X-Remote-Token': lanToken });

        await test('operator claim: wrong secret and non-loopback refused, right secret sets the HttpOnly cookie', async () => {
            const secret = backend.operatorToken.getLaunchSecret();
            const wrong = await request('POST', '/api/remote/operator/claim', { body: { secret: 'f'.repeat(64) } });
            assert.strictEqual(wrong.status, 403);
            const proxied = await request('POST', '/api/remote/operator/claim', { headers: LAN(), body: { secret } });
            assert.strictEqual(proxied.status, 403);
            const good = await request('POST', '/api/remote/operator/claim', { body: { secret } });
            assert.strictEqual(good.status, 200);
            assert.deepStrictEqual(good.body, { operator: true });
            const setCookie = [].concat(good.headers['set-cookie'] || []).join(';');
            assert(/onefinity_op=/.test(setCookie) && /HttpOnly/i.test(setCookie) && /SameSite=Strict/i.test(setCookie));
            operatorCookie = /onefinity_op=[^;]+/.exec(setCookie)[0];
            assert(!setCookie.includes(secret), 'the cookie is derived, never the secret');
        });

        const OP = () => ({ Cookie: operatorCookie });

        await test('index wiring passes operatorToken: loopback without the cookie is local, not operator', async () => {
            const info = await request('GET', '/api/remote/info');
            assert.strictEqual(info.status, 200);
            assert.strictEqual(info.body.operator, false);
            assert.strictEqual(info.body.identityKind, 'local');
            // The kiosk reads RemoteInfo.identity (frontend api.ts).
            assert.strictEqual(info.body.identity, 'local');
            const opInfo = await request('GET', '/api/remote/info', { headers: OP() });
            assert.strictEqual(opInfo.body.operator, true);
            assert.strictEqual(opInfo.body.identityKind, 'operator');
            assert.strictEqual(opInfo.body.identity, 'operator');
            const proxiedWithCookie = await request('GET', '/api/remote/info', { headers: { ...LAN(), Cookie: operatorCookie } });
            assert.strictEqual(proxiedWithCookie.body.operator, false);
            assert.strictEqual(proxiedWithCookie.body.identityKind, 'lan');
            assert.strictEqual(proxiedWithCookie.body.identity, 'lan');
            const anon = await request('GET', '/api/remote/info', { headers: PROXIED });
            assert.strictEqual(anon.body.identity, undefined, 'unauthorized callers learn nothing about identity');
            // D1: local keeps full local control (not subject to the allowlist).
            const cfg = await request('GET', '/api/config');
            assert.strictEqual(cfg.status, 200);
        });

        // ── operator routes ─────────────────────────────────────────
        const O_ROUTES = [
            ['POST', '/api/remote/device/name', { name: 'Shop CNC' }],
            ['POST', '/api/remote/access-code/use', {}],
            ['POST', '/api/remote/lan-only', { enabled: 'nope' }],
            ['POST', '/api/remote/cloud/config', { relayUrl: 42 }],
            ['POST', '/api/remote/cloud/enabled', { enabled: 'nope' }],
            ['POST', '/api/remote/cloud/pairing', {}],
            ['GET', '/api/remote/cloud/pairing'],
            ['DELETE', '/api/remote/cloud/pairing'],
            ['POST', '/api/remote/cloud/pairing/confirm', {}],
            ['POST', '/api/remote/cloud/pairing/reject', {}],
            ['POST', '/api/remote/cloud/unpair', {}],
            ['POST', '/api/remote/cloud/limits', { maxFileMb: 25, cloudLibraryCapMb: 500 }],
            ['GET', '/api/remote/cloud/recent-users'],
            ['POST', '/api/remote/permissions/job-control', { channel: 'bogus', enabled: true }],
            ['POST', '/api/remote/permissions/motion', { minutes: 7, scope: { channel: 'lan' } }],
            ['GET', '/api/remote/audit?limit=5'],
            ['POST', '/api/library/l-missing/review', {}],
            ['GET', '/api/remote/sessions'],
            ['POST', '/api/remote/firewall/fix', {}],
        ];
        const DESTRUCTIVE_O_ROUTES = [
            ['POST', '/api/remote/access-code/regenerate', {}],
            ['POST', '/api/remote/operator/rotate', {}],
            ['POST', '/api/remote/pin', { pin: '99999999' }],
            ['DELETE', '/api/remote/pin'],
            ['DELETE', '/api/remote/sessions/x'],
            ['POST', '/api/remote/sessions/revoke', {}],
        ];

        await test('every O route is 403 for (a) a proxied request with a valid session and (b) loopback without the cookie', async () => {
            for (const [method, url, body] of [...O_ROUTES, ...DESTRUCTIVE_O_ROUTES]) {
                const a = await request(method, url, { headers: LAN(), body });
                assert.strictEqual(a.status, 403, `${method} ${url} (lan) -> ${a.status}`);
                const b = await request(method, url, { body });
                assert.strictEqual(b.status, 403, `${method} ${url} (local) -> ${b.status}`);
                assert.strictEqual(b.body.error, 'operator_required', `${method} ${url} (local)`);
            }
        });

        await test('with the operator cookie the O routes are allowed', async () => {
            const firewall = spyOn(backend.services.tailscaleService, 'fixFirewall');
            backend.services.tailscaleService.fixFirewall = async () => ({ ok: true });
            try {
                for (const [method, url, body] of O_ROUTES) {
                    const r = await request(method, url, { headers: OP(), body });
                    assert.notStrictEqual(r.status, 403, `${method} ${url} -> 403 ${r.text}`);
                    assert.notStrictEqual(r.status, 401, `${method} ${url} -> 401`);
                }
            } finally {
                firewall.restore();
            }
            const grant = await request('POST', '/api/remote/permissions/motion', { headers: OP(), body: { minutes: 7, scope: { channel: 'lan' } } });
            assert.strictEqual(grant.status, 400);
            const conflict = await request('POST', '/api/remote/cloud/pairing', { headers: OP(), body: {} });
            assert.strictEqual(conflict.status, 409);
            assert.strictEqual(conflict.body.error, 'already_paired');
        });

        // ── route coverage ──────────────────────────────────────────
        await test('route coverage: every registered /api route outside HTTP_ALLOWLIST is 403 operator_only for a LAN identity', async () => {
            const routes = [];
            for (const layer of backend.app._router.stack) {
                if (!layer.route || typeof layer.route.path !== 'string') continue;
                if (!layer.route.path.startsWith('/api/')) continue;
                for (const method of Object.keys(layer.route.methods)) {
                    if (method === '_all') continue;
                    routes.push({ method: method.toUpperCase(), path: layer.route.path });
                }
            }
            assert(routes.length > 60, `expected the full route table, got ${routes.length}`);
            const mustInclude = [
                'GET /api/config', 'POST /api/watchdir/config', 'GET /api/watchdir/file/:name', 'DELETE /api/macros/:id',
                'DELETE /api/library/:id', 'DELETE /api/jobhistory', 'POST /api/link-test',
            ];
            for (const key of mustInclude) {
                assert(routes.some((r) => `${r.method} ${r.path}` === key), `route ${key} registered`);
            }
            let denied = 0;
            for (const route of routes) {
                const concrete = route.path.replace(/:name/g, 'cloud-link.json').replace(/:[A-Za-z]+/g, 'x');
                if (policy.matchHttp(route.method, concrete)) continue;
                const r = await request(route.method, concrete, { headers: LAN(), body: route.method === 'GET' ? undefined : {} });
                assert.strictEqual(r.status, 403, `${route.method} ${concrete} -> ${r.status}`);
                assert.strictEqual(r.body && r.body.error, 'operator_only', `${route.method} ${concrete}`);
                denied += 1;
            }
            assert(denied > 50);
            // Unknown and case-mangled paths are refused too.
            const future = await request('GET', '/api/some/future/route', { headers: LAN() });
            assert.strictEqual(future.status, 403);
            const upper = await request('GET', '/API/CONFIG', { headers: LAN() });
            assert.notStrictEqual(upper.headers['content-type'] || '', 'application/json; charset=utf-8',
                'a case-mangled /API path must not reach the JSON config route');
            assert(!/telegram/.test(upper.text));
        });

        await test('allowlisted LAN routes work and GET /api/config never leaks to LAN', async () => {
            assert.strictEqual((await request('GET', '/api/library', { headers: LAN() })).status, 200);
            assert.strictEqual((await request('GET', '/api/jobhistory/stats', { headers: LAN() })).status, 200);
            const cfg = await request('GET', '/api/config', { headers: LAN() });
            assert.strictEqual(cfg.status, 403);
            assert(!/token/.test(cfg.text));
        });

        // ── redaction ───────────────────────────────────────────────
        await test('/api/remote/device hides the access code from non-operators; /cloud/status is redacted', async () => {
            for (const headers of [LAN(), {}]) {
                const dev = await request('GET', '/api/remote/device', { headers });
                assert.strictEqual(dev.status, 200);
                assert.strictEqual(dev.body.accessCode, undefined);
                assert(!dev.text.includes(backend.deviceIdentity.getAccessCode()));
                assert.strictEqual(dev.body.mdnsHostname, backend.deviceIdentity.mdnsHostname());
            }
            const op = await request('GET', '/api/remote/device', { headers: OP() });
            assert.strictEqual(op.body.accessCode, backend.deviceIdentity.getAccessCode());
            assert.strictEqual(op.body.pinSource, 'access-code');

            const lanStatus = await request('GET', '/api/remote/cloud/status', { headers: LAN() });
            assert.strictEqual(lanStatus.body.relayUrl, 'relay.example.com');
            assert.strictEqual(lanStatus.body.lastError, null);
            const opStatus = await request('GET', '/api/remote/cloud/status', { headers: OP() });
            assert.strictEqual(opStatus.body.relayUrl, 'https://relay.example.com/base');
            assert.strictEqual(redactCloudStatus({ relayUrl: 'not a url', lastError: 'x' }).relayUrl, null);
        });

        await test('/cloud/status limits reach the operator only; a locked cloud-link.json is a retryable 503', async () => {
            // (CloudLinkService itself is covered in cloud_link_service.test.js.)
            const realGetStatus = cloudLinkStub.getStatus;
            const realSetLimits = cloudLinkStub.setLimits;
            cloudLinkStub.getStatus = function () { return { ...realGetStatus.call(this), maxFileMb: 50, cloudLibraryCapMb: 2000 }; };
            try {
                const op = await request('GET', '/api/remote/cloud/status', { headers: OP() });
                assert.deepStrictEqual([op.body.maxFileMb, op.body.cloudLibraryCapMb], [50, 2000]);
                const lan = await request('GET', '/api/remote/cloud/status', { headers: LAN() });
                assert.strictEqual(lan.body.maxFileMb, undefined);
                assert.strictEqual(lan.body.cloudLibraryCapMb, undefined);
            } finally {
                cloudLinkStub.getStatus = realGetStatus;
            }

            // A locked cloud-link.json (STORE_UNREADABLE) is a retryable 503, not a 500.
            const locked = () => { const e = new Error('store unreadable'); e.code = 'STORE_UNREADABLE'; throw e; };
            const realUpdate = backend.cloudStore.update;
            backend.cloudStore.update = locked;
            cloudLinkStub.setLimits = locked;
            try {
                for (const [pathName, body] of [
                    ['/api/remote/cloud/limits', { maxFileMb: 30 }],
                    ['/api/remote/permissions/job-control', { channel: 'lan', enabled: true }],
                ]) {
                    const locked = await request('POST', pathName, { headers: OP(), body });
                    assert.strictEqual(locked.status, 503, `${pathName} ${locked.status} ${JSON.stringify(locked.body)}`);
                    assert.strictEqual(locked.body.error, 'store_unreadable');
                }
            } finally {
                backend.cloudStore.update = realUpdate;
                cloudLinkStub.setLimits = realSetLimits;
            }
        });

        // ── sockets ─────────────────────────────────────────────────
        const lanSocket = await connectSocket({ ...PROXIED, 'X-Remote-Token': lanToken });
        sockets.push(lanSocket);
        const opSocket = await connectSocket({ Cookie: operatorCookie });
        sockets.push(opSocket);
        await waitFor(() => lanSocket.received('remote:permissions').length && opSocket.received('remote:device').length, 2000, 'initial emits');

        await test('connection emits: operator gets device + pairing, LAN gets redacted cloud status and the lan tier view', async () => {
            assert.strictEqual(lanSocket.received('remote:device').length, 0);
            assert.strictEqual(lanSocket.received('remote:cloud:pairing').length, 0);
            assert.strictEqual(lanSocket.last('remote:cloud:status').relayUrl, 'relay.example.com');
            assert.strictEqual(opSocket.last('remote:cloud:status').relayUrl, 'https://relay.example.com/base');
            assert.strictEqual(opSocket.last('remote:device').accessCode, backend.deviceIdentity.getAccessCode());
            assert.strictEqual(opSocket.received('remote:cloud:pairing').length, 1);
            assert.strictEqual(lanSocket.last('remote:permissions').jobControl, undefined, 'LAN view has no per-channel operator fields');
        });

        await test('cloud status broadcast is redacted for non-operator sockets', async () => {
            lanSocket.clear();
            opSocket.clear();
            cloudLinkStub.deps.onStatus(cloudLinkStub.getStatus());
            await waitFor(() => lanSocket.received('remote:cloud:status').length && opSocket.received('remote:cloud:status').length, 2000, 'status');
            assert.strictEqual(lanSocket.last('remote:cloud:status').lastError, null);
            assert.strictEqual(opSocket.last('remote:cloud:status').lastError, 'relay said something private');
        });

        await test('LAN socket filter denies the listed events and command gcode/unlock/homing', async () => {
            lanSocket.clear();
            const before = handled.length;
            const deniedEvents = ['command:raw', 'write', 'config:set', 'config:get', 'config:getAll', 'tool:list',
                'debug:getEntries', 'firmware:flash', 'macro:run', 'gamepad:axes'];
            for (const ev of deniedEvents) lanSocket.emit(ev, 'x');
            for (const cmd of ['gcode', 'unlock', 'homing']) lanSocket.emit('command', '/dev/x', cmd, 'G0 X10');
            await waitFor(() => lanSocket.received('remote:denied').length >= deniedEvents.length + 3, 2000, 'denials');
            const denials = lanSocket.received('remote:denied');
            for (const ev of deniedEvents) assert(denials.some((d) => d.event === ev), `denied ${ev}`);
            for (const cmd of ['gcode', 'unlock', 'homing']) {
                const d = denials.find((x) => x.event === 'command' && x.cmd === cmd);
                assert(d, `denied command ${cmd}`);
                assert.strictEqual(d.code, 'UNKNOWN_COMMAND');
            }
            await sleep(100);
            assert.strictEqual(handled.length, before, 'no denied packet reached a handler');
        });

        await test('LAN socket filter allows macro:list, trigger:list, health:metrics, hPing, list', async () => {
            lanSocket.clear();
            for (const ev of ['macro:list', 'trigger:list', 'health:metrics', 'hPing', 'list']) {
                const ack = await lanSocket.emitWithAck(ev);
                assert.deepStrictEqual(ack, { ok: true, event: ev });
            }
            assert.strictEqual(lanSocket.received('remote:denied').length, 0);
        });

        await test('a denied socket event does not crash the server', async () => {
            lanSocket.clear();
            lanSocket.emit('command:raw', '$$');
            await waitFor(() => lanSocket.received('remote:denied').length === 1, 2000, 'denial');
            assert(!lanSocket.closed);
            const ack = await lanSocket.emitWithAck('hPing');
            assert.strictEqual(ack.ok, true);
            assert.strictEqual((await request('GET', '/api/state', { headers: LAN() })).status, 200);
        });

        async function freshIdle() {
            await waitFor(() => backend.gate.getLocks('lan').length === 0, 5000, 'no locks');
            engine.setStatus({ activeState: 'Idle' });
        }

        async function lanCommand(socket, cmd, params) {
            socket.clear();
            const before = handled.filter((h) => h.cmd === cmd).length;
            socket.emit('command', '/dev/x', cmd, params);
            await waitFor(() => socket.received('remote:denied').length
                || handled.filter((h) => h.cmd === cmd).length > before, 2000, `result of ${cmd}`);
            const denied = socket.last('remote:denied');
            return denied ? { ok: false, code: denied.code } : { ok: true };
        }

        await test('gcode:stop is always allowed for a LAN socket (Monitor tier)', async () => {
            const r = await lanCommand(lanSocket, 'gcode:stop');
            assert.deepStrictEqual(r, { ok: true });
        });

        await test('LAN jog: TIER_REQUIRED without a grant; LAN grant allows a 5 mm single-axis step; 100 mm and diagonal are BAD_ARGS; cloud-only grant is TIER_REQUIRED', async () => {
            await freshIdle();
            let r = await lanCommand(lanSocket, 'jog', { x: 5 });
            assert.deepStrictEqual(r, { ok: false, code: 'TIER_REQUIRED' });

            const grant = await request('POST', '/api/remote/permissions/motion', { headers: OP(), body: { minutes: 5, scope: { channel: 'lan' } } });
            assert.strictEqual(grant.status, 200, grant.text);

            await freshIdle();
            r = await lanCommand(lanSocket, 'jog', { x: 5 });
            assert.deepStrictEqual(r, { ok: true });
            const step = handled.filter((h) => h.cmd === 'jog').pop();
            assert.deepStrictEqual(step.args, [{ x: 5 }]);

            await sleep(300);
            await freshIdle();
            r = await lanCommand(lanSocket, 'jog', { x: 100 });
            assert.deepStrictEqual(r, { ok: false, code: 'BAD_ARGS' });
            r = await lanCommand(lanSocket, 'jog', { x: 5, y: 5 });
            assert.deepStrictEqual(r, { ok: false, code: 'BAD_ARGS' });

            const cloudGrant = await request('POST', '/api/remote/permissions/motion', {
                headers: OP(), body: { minutes: 5, scope: { channel: 'cloud', userId: 'u_9x8c7v6b5n4m' } },
            });
            assert.strictEqual(cloudGrant.status, 200, cloudGrant.text);
            await sleep(300);
            await freshIdle();
            r = await lanCommand(lanSocket, 'jog', { x: 5 });
            assert.deepStrictEqual(r, { ok: false, code: 'TIER_REQUIRED' });
        });

        await test('remote:permissions and remote:activity to a non-operator socket carry no relay userId or userLabel', async () => {
            // The cloud user-scoped grant from the previous test is still active.
            lanSocket.clear();
            opSocket.clear();
            backend.gate._notify();
            await waitFor(() => lanSocket.received('remote:permissions').length && opSocket.received('remote:permissions').length, 2000, 'permissions');
            const lanView = lanSocket.last('remote:permissions');
            assert.strictEqual(lanView.scope.motion.userId, null);
            assert(!JSON.stringify(lanView).includes('u_9x8c7v6b5n4m'));
            assert.strictEqual(opSocket.last('remote:permissions').scope.motion.userId, 'u_9x8c7v6b5n4m');

            backend.gate._onJogActivity({ jogId: 'j_abc', userLabel: 'Sam', userId: 'u_9x8c7v6b5n4m', axis: 'x', dir: 1 });
            await waitFor(() => lanSocket.received('remote:activity').length && opSocket.received('remote:activity').length, 2000, 'activity');
            const lanActivity = lanSocket.last('remote:activity');
            assert.strictEqual(lanActivity.userLabel, null);
            assert.strictEqual(lanActivity.userId, null);
            assert.strictEqual(opSocket.last('remote:activity').userLabel, 'Sam');

            const lanHttp = await request('GET', '/api/remote/permissions', { headers: LAN() });
            assert(!lanHttp.text.includes('u_9x8c7v6b5n4m'));
            const drop = await request('DELETE', '/api/remote/permissions/motion', { headers: LAN() });
            assert.strictEqual(drop.status, 200);
            assert.strictEqual(backend.gate.getState('operator').scope.motion, null);
        });

        await test('LAN HTTP POST /api/command goes through gate.checkLan', async () => {
            const raw = await request('POST', '/api/command', { headers: LAN(), body: { command: 'gcode', args: ['G0 X100'] } });
            assert.strictEqual(raw.status, 403);
            assert.strictEqual(raw.body.error, 'UNKNOWN_COMMAND');
            const stop = await request('POST', '/api/command', { headers: LAN(), body: { command: 'gcode:stop' } });
            assert.strictEqual(stop.status, 200);
            assert(engine.controller.commands.some((c) => c.cmd === 'gcode:stop'));
        });

        await test('LAN HTTP /api/command: a non-string command or non-array args is denied, never passed to the controller', async () => {
            // Grbl/RTS controllers dispatch via this._commands[cmd]; ["gcode"] coerces to "gcode".
            const before = engine.controller.commands.length;
            const bodies = [
                { command: ['gcode'], args: ['G0 X100'] },
                { command: ['homing'] },
                { command: ['gcode:start'] },
                { cmd: ['unlock'] },
                { command: { toString: 'gcode' } },
                { command: 42 },
                { command: 'gcode:stop', args: 'G0 X1' },
                { command: 'gcode:stop', args: { 0: 'G0 X1' } },
            ];
            for (const body of bodies) {
                const r = await request('POST', '/api/command', { headers: LAN(), body });
                assert.strictEqual(r.status, 403, `LAN ${JSON.stringify(body)} -> ${r.status}`);
                assert.strictEqual(r.body.error, 'BAD_ARGS');
            }
            // No-PIN LAN identity is filtered the same way (policy unit, no session needed).
            const filter = policy.createLanHttpFilter({ gate: { checkLan: () => ({ ok: true }) }, libraryService: null });
            let passedThrough = false;
            let status = 0;
            const res = { status(s) { status = s; return this; }, json() { return this; } };
            filter({ path: '/api/command', method: 'POST', body: { command: ['gcode'] }, remoteIdentity: null, ip: '10.0.0.9' },
                res, () => { passedThrough = true; });
            assert.strictEqual(passedThrough, false, 'array command must not reach next()');
            assert.strictEqual(status, 403);
            // Local identities skip the filter; the handler itself refuses too.
            for (const body of [{ command: ['gcode'], args: ['G0 X1'] }, { command: 'feedhold', args: 'x' }]) {
                const local = await request('POST', '/api/command', { body });
                assert.strictEqual(local.status, 400, `local ${JSON.stringify(body)} -> ${local.status}`);
            }
            assert.strictEqual(engine.controller.commands.length, before, 'the controller received nothing');
        });

        await test('operator socket command jog calls gate.onLocalCommand and is never blocked', async () => {
            const spy = spyOn(backend.gate, 'onLocalCommand');
            try {
                opSocket.clear();
                const before = handled.filter((h) => h.cmd === 'jog' && h.socketId).length;
                opSocket.emit('command', '/dev/x', 'jog', { x: 100, y: 100 });
                await waitFor(() => handled.filter((h) => h.cmd === 'jog').length > before, 2000, 'operator jog');
                assert(spy.calls.some(([ev, args]) => ev === 'command' && args[1] === 'jog'));
                assert.strictEqual(opSocket.received('remote:denied').length, 0);
                assert(backend.gate.getLocks('lan').includes('local-activity'));
            } finally {
                spy.restore();
            }
        });

        await test('local socket (loopback, no cookie): full local control through the activity tap, no operator room', async () => {
            const localSocket = await connectSocket({});
            sockets.push(localSocket);
            const spy = spyOn(backend.gate, 'onLocalCommand');
            try {
                await sleep(100);
                assert.strictEqual(localSocket.received('remote:device').length, 0, 'local is not in the operator room');
                assert.strictEqual(localSocket.last('remote:cloud:status').relayUrl, 'relay.example.com');
                const before = handled.filter((h) => h.cmd === 'gcode').length;
                localSocket.emit('command', '/dev/x', 'gcode', 'G0 X1');
                const ack = await localSocket.emitWithAck('config:getAll');
                assert.strictEqual(ack.ok, true);
                await waitFor(() => handled.filter((h) => h.cmd === 'gcode').length > before, 2000, 'local gcode');
                assert.strictEqual(localSocket.received('remote:denied').length, 0);
                assert(spy.calls.some(([ev, args]) => ev === 'command' && args[1] === 'gcode'));
            } finally {
                spy.restore();
            }
        });

        await test('local (loopback, no cookie) HTTP command feeds gate.onLocalCommand; LAN HTTP command does not', async () => {
            const spy = spyOn(backend.gate, 'onLocalCommand');
            try {
                const local = await request('POST', '/api/command', { body: { command: 'feedhold' } });
                assert.strictEqual(local.status, 200);
                assert(spy.calls.some(([ev, body]) => ev === 'http:/api/command' && body.command === 'feedhold'));
                const count = spy.calls.length;
                await request('POST', '/api/command', { headers: LAN(), body: { command: 'gcode:stop' } });
                assert.strictEqual(spy.calls.length, count);
            } finally {
                spy.restore();
            }
        });

        // ── library review gate ─────────────────────────────────────
        await test('LAN GET /api/library/:id/body refuses an unreviewed cloud upload until the operator reviews it', async () => {
            const src = path.join(tmp, 'upload.part');
            fs.writeFileSync(src, 'G0 X1\n');
            const meta = await backend.services.libraryService.upsertFromFile({
                name: 'remote', fileName: 'remote.nc', srcPath: src,
                provenance: { origin: 'cloud', uploadedBy: { userId: 'u_9x8c7v6b5n4m', userLabel: 'Sam' }, reviewed: false },
            });
            const blocked = await request('GET', `/api/library/${meta.id}/body`, { headers: LAN() });
            assert.strictEqual(blocked.status, 403);
            assert.strictEqual(blocked.body.error, 'review_required');
            const review = await request('POST', `/api/library/${meta.id}/review`, { headers: OP(), body: {} });
            assert.strictEqual(review.status, 200);
            assert.strictEqual(review.body.provenance.reviewed, true);
            const ok = await request('GET', `/api/library/${meta.id}/body`, { headers: LAN() });
            assert.strictEqual(ok.status, 200);
            const audit = await request('GET', '/api/remote/audit?limit=500', { headers: OP() });
            assert(audit.body.some((e) => e.event === 'file.reviewed'));
            assert(!JSON.stringify(audit.body).includes(accessCode));
        });

        // ── watch folder ────────────────────────────────────────────
        await test('WatchDirService refuses watch paths inside backend/data and unlisted extensions', async () => {
            const store = { data: {}, get(k) { return this.data[k]; }, set(k, v) { this.data[k] = v; } };
            const svc = new WatchDirService({ configStore: store, io: { emit() {} }, logger: { warn() {} } });
            assert.throws(() => svc.setConfig({ path: BACKEND_DATA_DIR, enabled: false }), /Forbidden watch path/);
            assert.throws(() => svc.setConfig({ path: path.join(BACKEND_DATA_DIR, 'library'), enabled: false }), /Forbidden watch path/);
            if (process.platform === 'win32') {
                assert.throws(() => svc.setConfig({ path: BACKEND_DATA_DIR.toUpperCase(), enabled: false }), /Forbidden watch path/);
            }
            const folder = path.join(tmp, 'watch');
            fs.mkdirSync(folder, { recursive: true });
            fs.writeFileSync(path.join(folder, 'cloud-link.json'), '{"credential":"odc_secret"}');
            fs.writeFileSync(path.join(folder, 'part.nc'), 'G0 X0\n');
            svc.setConfig({ path: folder, enabled: false, extensions: ['.nc'] });
            assert.throws(() => svc.readFile('cloud-link.json'), /Invalid file type/);
            assert.strictEqual(svc.readFile('part.nc'), 'G0 X0\n');
            // A stored config pointing at backend/data is refused on read as well.
            svc.cfg = { ...svc.cfg, path: BACKEND_DATA_DIR, extensions: ['.json'] };
            assert.throws(() => svc.readFile('cloud-link.json'), /Forbidden watch path/);

            const viaRoute = await request('POST', '/api/watchdir/config', { headers: OP(), body: { path: dataDir, enabled: false } });
            assert.strictEqual(viaRoute.status, 400);
            assert.strictEqual(viaRoute.body.error, 'Forbidden watch path');
        });

        // ── LAN-only ────────────────────────────────────────────────
        await test('LAN-only toggle: applyLanOnly, mirror and service setOutboundAllowed(false); mirror.start() is then a no-op; firmware checks 409', async () => {
            const spies = [
                spyOn(mirror, 'setOutboundAllowed'),
                spyOn(backend.services.telegramService, 'setOutboundAllowed'),
                spyOn(backend.services.whatsappService, 'setOutboundAllowed'),
                spyOn(backend.services.chatbotService, 'setOutboundAllowed'),
            ];
            try {
                opSocket.clear();
                const r = await request('POST', '/api/remote/lan-only', { headers: OP(), body: { enabled: true } });
                assert.strictEqual(r.status, 200);
                assert.deepStrictEqual(r.body, { lanOnly: true });
                assert.deepStrictEqual(cloudLinkStub.calls.applyLanOnly, [true]);
                for (const spy of spies) assert.deepStrictEqual(spy.calls, [[false]]);
                assert.strictEqual(backend.deviceIdentity.isLanOnly(), true);

                mirror.start();
                assert.strictEqual(mirror.enabled, false, 'mirror start() must be a no-op while outbound is blocked');
                assert.strictEqual(mirror.ws, null);

                assert.strictEqual(backend.services.chatbotService.outboundAllowed, false);
                await assert.rejects(() => backend.services.telegramService.enable(), /lan_only/);

                const fw = await request('POST', '/api/firmware/check-online', { headers: OP(), body: {} });
                assert.strictEqual(fw.status, 409);
                assert.strictEqual(fw.body.error, 'lan_only');
                const fwInfo = await request('GET', '/api/firmware/info?checkOnline=true', { headers: OP() });
                assert.strictEqual(fwInfo.status, 409);
                await assert.rejects(() => backend.services.firmwareUpdateService.fetchRemoteFile('https://example.invalid/x'), /lan_only/);

                await waitFor(() => opSocket.received('remote:device').length && opSocket.received('remote:cloud:status').length, 2000, 'lan-only emits');
                assert.strictEqual(opSocket.last('remote:device').lanOnly, true);

                const off = await request('POST', '/api/remote/lan-only', { headers: OP(), body: { enabled: false } });
                assert.deepStrictEqual(off.body, { lanOnly: false });
                assert.deepStrictEqual(cloudLinkStub.calls.applyLanOnly, [true, false]);
                assert.deepStrictEqual(spies[0].calls, [[false], [true]]);
                assert.strictEqual(backend.services.chatbotService.outboundAllowed, true);
            } finally {
                for (const spy of spies) spy.restore();
                mirror.setOutboundAllowed(false);
            }
        });

        // ── secrets never reach LAN sockets ─────────────────────────
        await test('camera URLs, the WhatsApp QR and bot config reach only local-control sockets (HTTP and Socket.IO)', async () => {
            const webcamService = backend.services.webcamService;
            const secretUrl = 'rtsp://admin:hunter2@10.0.0.5/live';
            webcamService.cameras.set('c1', { cfg: { id: 'c1', type: 'rtsp', name: 'shop', url: secretUrl }, online: false, lastError: `${secretUrl}: 401 Unauthorized` });
            const opened = [];
            try {
                const lanHttp = await request('GET', '/api/webcam/cameras', { headers: LAN() });
                assert.strictEqual(lanHttp.status, 200);
                assert(!lanHttp.text.includes('hunter2'), lanHttp.text);
                assert.deepStrictEqual(lanHttp.body, [{ id: 'c1', name: 'shop', type: 'rtsp', online: false }]);
                const localHttp = await request('GET', '/api/webcam/cameras');
                assert(localHttp.text.includes('hunter2'), 'the machine itself still sees the full camera config');

                const lanS = await connectSocket({ ...PROXIED, 'X-Remote-Token': lanToken });
                opened.push(lanS);
                const locS = await connectSocket({});
                opened.push(locS);
                await waitFor(() => lanS.received('webcam:cameras').length && locS.received('telegram:config').length, 2000, 'connect emits');
                await sleep(50);
                assert(!JSON.stringify(lanS.events).includes('hunter2'), 'no camera URL on the LAN socket');
                const lanNames = lanS.events.map((e) => e.name);
                assert(!lanNames.some((n) => /^(whatsapp|telegram):/.test(n)), `LAN got ${lanNames.join(',')}`);
                assert(JSON.stringify(locS.received('webcam:cameras')).includes('hunter2'));
                assert.strictEqual(locS.received('whatsapp:config').length, 1);
                assert.strictEqual(locS.received('telegram:config').length, 1);

                lanS.clear();
                locS.clear();
                webcamService._broadcastList();
                backend.services.whatsappService.io.emit('whatsapp:qr', { dataUrl: 'data:image/png;base64,QRSECRET' });
                await waitFor(() => locS.received('whatsapp:qr').length && locS.received('webcam:cameras').length
                    && lanS.received('webcam:cameras').length, 2000, 'broadcasts');
                await sleep(100);
                assert.strictEqual(lanS.received('whatsapp:qr').length, 0, 'the pairing QR never reaches a LAN socket');
                assert(!JSON.stringify(lanS.events).includes('hunter2'));
                assert.deepStrictEqual(lanS.last('webcam:cameras'), [{ id: 'c1', name: 'shop', type: 'rtsp', online: false }]);
            } finally {
                webcamService.cameras.delete('c1');
                for (const s of opened) s.close();
            }
        });

        await test('CNCEngine config pushes: LAN sockets never get telegram.token / RemoteDiag secrets; local cannot set remote-channel keys or enable the mirror', async () => {
            const { CNCEngine } = require('../services/CNCEngine');
            const store = new ConfigStore(path.join(tmp, 'engine-config.json'));
            store.set('telegram', { token: '123456:TG_SECRET', openMode: false });
            store.set('whatsapp', { recipients: ['+15550001111'], botOpenMode: false });
            store.set('webcam', { cameras: [{ id: 'c', url: 'rtsp://admin:camsecret@h/live' }] });
            store.set('preferences', { units: 'mm', remoteDiagEnabled: false, remoteDiagUrl: 'ws://10.1.2.3:18765/mirror', remoteDiagToken: 'DIAG_SECRET_TOKEN', remoteDiagAllowInject: false });
            store.set('machineProfiles', [{ id: 'p1', name: 'Router' }]);
            const broadcasts = [];
            let onConnection = null;
            const fakeIo = {
                on(ev, fn) { if (ev === 'connection') onConnection = fn; },
                emit(event, payload) { broadcasts.push({ scope: 'all', event, payload }); },
                to(room) { return { emit: (event, payload) => broadcasts.push({ scope: `to:${room}`, event, payload }) }; },
                except(room) { return { emit: (event, payload) => broadcasts.push({ scope: `except:${room}`, event, payload }) }; },
            };
            const eng = Object.create(CNCEngine.prototype);
            Object.assign(eng, { io: fakeIo, config: store, controller: null, connection: null, loadedFile: null });
            eng._setupSocketIO();
            const mk = (identity) => {
                const s = {
                    id: `fake-${Math.random()}`, data: identity ? { identity } : {}, handlers: {}, out: [],
                    on(ev, fn) { this.handlers[ev] = fn; },
                    emit(event, payload) { this.out.push({ event, payload }); },
                };
                onConnection(s);
                return s;
            };
            const SECRETS = ['TG_SECRET', 'DIAG_SECRET_TOKEN', '10.1.2.3', '+15550001111', 'camsecret'];
            const lanS = mk({ kind: 'lan', sessionId: 'abc', ip: '192.168.1.5', via: 'lan' });
            const noGate = mk(null);
            const localS = mk({ kind: 'local' });
            const opS = mk({ kind: 'operator' });
            for (const s of [lanS, noGate]) {
                const text = JSON.stringify(s.out);
                for (const secret of SECRETS) assert(!text.includes(secret), `non-local socket received ${secret}`);
                const all = s.out.find((o) => o.event === 'config:all').payload;
                assert.strictEqual(all.preferences.units, 'mm', 'harmless preferences still reach the phone');
                assert.deepStrictEqual(all.machineProfiles, [{ id: 'p1', name: 'Router' }]);
                assert.strictEqual(s.out.find((o) => o.event === 'safety:remoteDiagStatus').payload.url, null);
            }
            assert(JSON.stringify(localS.out.find((o) => o.event === 'config:all').payload).includes('TG_SECRET'), 'local keeps the full config (D1)');

            // config:getAll / config:get for a non-local socket are redacted too.
            let got = null;
            lanS.handlers['config:getAll']((err, v) => { got = v; });
            assert(!JSON.stringify(got).includes('DIAG_SECRET_TOKEN'));
            lanS.handlers['config:get']('telegram.token', (err, v) => { got = v; });
            assert.strictEqual(got, undefined);

            // Local (no operator cookie) cannot write remote-channel keys.
            for (const [key, value] of [
                ['preferences.remoteDiagAllowInject', true], ['preferences.remoteDiagUrl', 'ws://attacker/mirror'],
                ['telegram.openMode', true], ['whatsapp.botOpenMode', true], ['telegram', { openMode: true }],
                ['preferences', { units: 'mm', remoteDiagAllowInject: true }],
            ]) {
                localS.out.length = 0;
                localS.handlers['config:set'](key, value);
                assert(localS.out.some((o) => o.event === 'config:denied'), `local config:set ${key} refused`);
            }
            assert.strictEqual(store.get('preferences.remoteDiagAllowInject'), false);
            assert.strictEqual(store.get('preferences.remoteDiagUrl'), 'ws://10.1.2.3:18765/mirror');
            assert.strictEqual(store.get('telegram.openMode'), false);
            assert.strictEqual(store.get('whatsapp.botOpenMode'), false);
            // LAN / gate-less sockets cannot write anything.
            lanS.handlers['config:set']('preferences.units', 'inch');
            noGate.handlers['config:set']('preferences.units', 'inch');
            assert.strictEqual(store.get('preferences.units'), 'mm');

            // An ordinary local write: full change to the local room, public form to the rest.
            broadcasts.length = 0;
            localS.handlers['config:set']('preferences.units', 'inch');
            assert.strictEqual(store.get('preferences.units'), 'inch');
            assert.deepStrictEqual(broadcasts.map((b) => b.scope), ['to:local', 'except:local']);
            assert(!broadcasts.some((b) => b.scope === 'all'));
            // A secret change is never broadcast outside the local room.
            broadcasts.length = 0;
            opS.handlers['config:set']('preferences.remoteDiagToken', 'NEW_DIAG_SECRET');
            assert.strictEqual(store.get('preferences.remoteDiagToken'), 'NEW_DIAG_SECRET', 'the operator may change it');
            assert.deepStrictEqual(broadcasts.map((b) => b.scope), ['to:local']);

            // safety:remoteDiagToggle: local may not enable or retarget the mirror.
            eng.controller = { command() {} };
            const mirrorStart = spyOn(mirrorSingleton, 'start');
            const mirrorSetUrl = spyOn(mirrorSingleton, 'setUrl');
            try {
                localS.out.length = 0;
                eng._handleCommand(localS, '', 'safety:remoteDiagToggle', { enabled: true, url: 'ws://attacker/mirror' });
                assert.strictEqual(mirrorStart.calls.length, 0);
                assert.strictEqual(mirrorSetUrl.calls.length, 0);
                assert.strictEqual(store.get('preferences.remoteDiagEnabled'), false);
                assert(localS.out.some((o) => o.event === 'remote:denied' && o.payload.code === 'operator_required'));
            } finally {
                mirrorStart.restore();
                mirrorSetUrl.restore();
            }
        });

        await test('local (loopback, no cookie) HTTP cannot open remote control channels; ordinary config writes still work', async () => {
            for (const [key, value] of [
                ['preferences.remoteDiagAllowInject', true], ['preferences.remoteDiagUrl', 'ws://attacker/mirror'],
                ['telegram.openMode', true], ['whatsapp.botOpenMode', true], ['preferences', { remoteDiagAllowInject: true }],
            ]) {
                const r = await request('POST', '/api/config', { body: { key, value } });
                assert.strictEqual(r.status, 403, `local POST /api/config ${key} -> ${r.status}`);
                assert.strictEqual(r.body.error, 'operator_required');
            }
            assert.notStrictEqual(engine.config.get('preferences.remoteDiagAllowInject'), true);
            assert.notStrictEqual(engine.config.get('telegram.openMode'), true);
            assert.strictEqual((await request('POST', '/api/config', { body: { key: 'preferences.units', value: 'mm' } })).status, 200);
            for (const [method, url, body] of [
                ['POST', '/api/telegram/config', { openMode: true }],
                ['POST', '/api/whatsapp/config', { botOpenMode: true }],
                ['DELETE', '/api/whatsapp/recipients/15550001111'],
                ['POST', '/api/whatsapp/recipients', { phone: '+15550002222' }],
                ['POST', '/api/telegram/enable', {}],
            ]) {
                const r = await request(method, url, { body });
                assert.strictEqual(r.status, 403, `local ${method} ${url} -> ${r.status}`);
                assert.strictEqual(r.body.error, 'operator_required');
            }
            assert.notStrictEqual(engine.config.get('telegram.openMode'), true);
            assert.strictEqual((await request('GET', '/api/whatsapp/status')).status, 200, 'local may still read status');
            const op = await request('POST', '/api/config', { headers: OP(), body: { key: 'preferences.remoteDiagEnabled', value: false } });
            assert.strictEqual(op.status, 200);
        });

        // ── revocation reaches live sockets ─────────────────────────
        await test('revoking a LAN session, a stale identity, or changing the PIN closes the live socket; no further command is handled', async () => {
            const jc = await request('POST', '/api/remote/permissions/job-control', { headers: OP(), body: { channel: 'lan', enabled: true } });
            assert.strictEqual(jc.status, 200, jc.text);
            const opened = [];
            const newLanSocket = async () => {
                const v = await request('POST', '/api/remote/verify-pin', { headers: PROXIED, body: { pin: accessCode } });
                assert.strictEqual(v.status, 200, v.text);
                const s = await connectSocket({ ...PROXIED, 'X-Remote-Token': v.body.token });
                opened.push(s);
                return { s, token: v.body.token };
            };
            try {
                // (1) DELETE /api/remote/sessions/:id
                const one = await newLanSocket();
                await freshIdle();
                assert.deepStrictEqual(await lanCommand(one.s, 'feedOverride:reset'), { ok: true }, 'job control is live before revoke');
                const sessions = await request('GET', '/api/remote/sessions', { headers: OP() });
                const id = backend.remoteAccessService.resolveSession(one.token).id;
                assert(sessions.body.sessions.some((x) => x.id === id));
                const del = await request('DELETE', `/api/remote/sessions/${id}`, { headers: OP() });
                assert.strictEqual(del.status, 200);
                await waitFor(() => one.s.closed, 2000, 'revoked socket closed');
                assert.strictEqual((await request('GET', '/api/state', { headers: { ...PROXIED, 'X-Remote-Token': one.token } })).status, 401);

                // (2) Backstop: an identity that went stale without a disconnect is refused per packet.
                const two = await newLanSocket();
                const twoId = backend.remoteAccessService.resolveSession(two.token).id;
                for (const [hash, sess] of backend.remoteAccessService.sessions.entries()) {
                    if (sess.id === twoId) backend.remoteAccessService.sessions.delete(hash);
                }
                const before = handled.length;
                two.s.emit('command', '/dev/x', 'feedOverride:reset');
                await waitFor(() => two.s.closed, 2000, 'stale socket closed');
                assert(two.s.received('remote:denied').some((d) => d.code === 'SESSION_REVOKED'));
                await sleep(100);
                assert.strictEqual(handled.length, before, 'nothing from the stale socket was handled');

                // (3) Changing the PIN closes every LAN socket.
                const three = await newLanSocket();
                const pin = await request('POST', '/api/remote/pin', { headers: OP(), body: { pin: '55667788' } });
                assert.strictEqual(pin.status, 200);
                await waitFor(() => three.s.closed, 2000, 'socket closed after PIN change');
                assert.strictEqual(lanSocket.closed || false, true, 'the earlier LAN socket is closed as well');
                assert.strictEqual(opSocket.closed, false, 'the operator socket stays');
            } finally {
                for (const s of opened) s.close();
                await request('POST', '/api/remote/permissions/job-control', { headers: OP(), body: { channel: 'lan', enabled: false } });
            }
        });

        await test('LAN PIN guesses and remote claims never block the kiosk operator claim', async () => {
            const ras = backend.remoteAccessService;
            const claimToken = ras.issueToken('192.168.7.99');
            for (let i = 0; i < 40; i++) ras.verifyPinWithRateLimit('00000000', `192.168.7.${(i % 10) + 1}`);
            assert(ras.globalCooldownUntil > Date.now(), 'the global PIN cooldown is tripped');
            for (let i = 0; i < 40; i++) {
                // Alternate an unauthenticated remote and a remote with a valid session.
                const headers = i % 2 ? PROXIED : { ...PROXIED, 'X-Remote-Token': claimToken };
                const r = await request('POST', '/api/remote/operator/claim', { headers, body: { secret: 'f'.repeat(64) } });
                assert(r.status === 403 || r.status === 401, `remote claim -> ${r.status}`);
            }
            const good = await request('POST', '/api/remote/operator/claim', { body: { secret: backend.operatorToken.getLaunchSecret() } });
            assert.strictEqual(good.status, 200, 'the kiosk can still claim operator');
            // Loopback brute force is still limited.
            for (let i = 0; i < 25; i++) await request('POST', '/api/remote/operator/claim', { body: { secret: 'e'.repeat(64) } });
            const blocked = await request('POST', '/api/remote/operator/claim', { body: { secret: backend.operatorToken.getLaunchSecret() } });
            assert.strictEqual(blocked.status, 403, 'repeated loopback failures still trigger the claim cooldown');
            ras.claimCooldownUntil = 0;
            ras.claimFailures = [];
        });

        await test('a macro still in the controller Feeder holds local-activity even while Idle (Grbl dwell)', async () => {
            await waitFor(() => !backend.gate.getLocks('lan').includes('local-activity'), 9000, 'local-activity to clear');
            engine.setStatus({ activeState: 'Idle' });
            const ctl = engine.controller;
            try {
                ctl.getFeederStatus = () => ({ size: 0, pending: false, hold: false });
                assert(!backend.gate.getLocks('lan').includes('local-activity'), 'an empty feeder is not busy');
                ctl.getFeederStatus = () => ({ size: 1, pending: true, hold: false });
                assert(backend.gate.getLocks('lan').includes('local-activity'), 'queued macro lines lock remote motion');
                ctl.getFeederStatus = () => ({ size: 0, pending: true, hold: false });
                assert(backend.gate.getLocks('lan').includes('local-activity'), 'an un-acked line (G4 dwell) locks remote motion');
            } finally {
                delete ctl.getFeederStatus;
            }
        });

        // ── access code ─────────────────────────────────────────────
        await test('regenerating the access code revokes LAN sessions and becomes the new PIN', async () => {
            const old = backend.deviceIdentity.getAccessCode();
            const r = await request('POST', '/api/remote/access-code/regenerate', { headers: OP(), body: {} });
            assert.strictEqual(r.status, 200);
            assert.notStrictEqual(r.body.accessCode, old);
            assert.strictEqual((await request('GET', '/api/state', { headers: LAN() })).status, 401);
            assert.strictEqual(backend.remoteAccessService.verifyPinRaw(r.body.accessCode), true);
            assert.strictEqual(backend.remoteAccessService.getPinSource(), 'access-code');
        });

        await test('a custom PIN turns the access code off; operator rotate re-issues the cookie', async () => {
            const pin = await request('POST', '/api/remote/pin', { headers: OP(), body: { pin: '24681357' } });
            assert.strictEqual(pin.status, 200);
            assert.strictEqual(backend.deviceIdentity.isAccessCodeActive(), false);
            assert.strictEqual(backend.remoteAccessService.getPinSource(), 'custom');

            const rotate = await request('POST', '/api/remote/operator/rotate', { headers: OP(), body: {} });
            assert.strictEqual(rotate.status, 200);
            const fresh = /onefinity_op=[^;]+/.exec([].concat(rotate.headers['set-cookie']).join(';'))[0];
            assert.notStrictEqual(fresh, operatorCookie);
            const stale = await request('GET', '/api/remote/info', { headers: OP() });
            assert.strictEqual(stale.body.operator, false);
            const now = await request('GET', '/api/remote/info', { headers: { Cookie: fresh } });
            assert.strictEqual(now.body.operator, true);
            await waitFor(() => opSocket.closed, 2000, 'operator socket admitted with the old cookie is closed');
        });

        await test('request logs never contain the ?op= launch secret', async () => {
            assert.strictEqual(redactUrl('/?op=abcdef0123&x=1'), '/?op=[redacted]&x=1');
            assert.strictEqual(redactUrl('/index.html?layout=v&op=abc'), '/index.html?layout=v&op=[redacted]');
        });

        await test('boot identity: an unreadable file does not stop the backend; identity is fail-closed, left alone, and recovers in the background', async () => {
            const dir = path.join(tmp, 'identity-degraded', 'data');
            const idFile = path.join(dir, 'device-identity.json');
            fs.mkdirSync(idFile, { recursive: true });   // a directory cannot be read as a file (EISDIR)
            const engine2 = new FakeEngine({ controllerType: 'RSP' });
            engine2.config = new ConfigStore(path.join(dir, 'config.json'));
            engine2.setStatus({ activeState: 'Idle' });
            const mirror2 = new mirrorSingleton.constructor();
            const outbound = [];
            const origSet = mirror2.setOutboundAllowed.bind(mirror2);
            mirror2.setOutboundAllowed = (a) => { outbound.push(a); return origSet(a); };
            let stub2 = null;
            const hostnames = [];
            let mdnsStarts = 0;
            let b2;
            assert.doesNotThrow(() => {
                b2 = createBackend({
                    port: 0, dataDir: dir, isTest: true, initServices: false,
                    createEngine: () => engine2,
                    createCloudLink: (deps) => (stub2 = makeCloudLinkStub(deps)),
                    createMdns: (deps) => {
                        hostnames.push(deps.hostname);
                        return {
                            start() { mdnsStarts += 1; return this; },
                            stop: async () => {},
                            setHostname(h) { hostnames.push(h); },
                            getStatus: () => ({ state: 'stopped', hostname: null, addresses: [], error: null }),
                        };
                    },
                    remoteDiagMirror: mirror2,
                    identityRetryMs: 50,
                });
            });
            const savedPort = PORT;
            try {
                PORT = (await b2.start({ host: '127.0.0.1', listenPort: 0, exitOnError: false })).port;
                assert.strictEqual(b2.deviceIdentity.isAvailable(), false);
                assert.strictEqual(b2.deviceIdentity.isLanOnly(), true, 'unknown LAN-only choice fails closed');
                assert.strictEqual(outbound[0], false, 'outbound blocked before the engine starts');
                assert.strictEqual(stub2.deps.isLanOnly(), true);
                assert.strictEqual(hostnames[0], null, 'no mDNS name while unreadable');
                assert.strictEqual(b2.deviceIdentity.getAccessCode(), null);
                // Local machine control works.
                const state = await request('GET', '/api/state');
                assert.strictEqual(state.status, 200);
                const cmd = await request('POST', '/api/command', { body: { command: 'feedhold' } });
                assert.strictEqual(cmd.status, 200);
                assert(engine2.controller.commands.some((c) => c.cmd === 'feedhold'));
                // Operator can see the problem but cannot write the identity.
                const op2 = await request('POST', '/api/remote/operator/claim', { body: { secret: b2.operatorToken.getLaunchSecret() } });
                const cookie2 = /onefinity_op=[^;]+/.exec([].concat(op2.headers['set-cookie']).join(';'))[0];
                const dev = await request('GET', '/api/remote/device', { headers: { Cookie: cookie2 } });
                assert.strictEqual(dev.body.unavailable, true);
                assert.strictEqual(dev.body.lanOnly, true);
                for (const [route, body] of [['/api/remote/lan-only', { enabled: false }], ['/api/remote/device/name', { name: 'X' }],
                    ['/api/remote/access-code/regenerate', {}], ['/api/remote/access-code/use', {}]]) {
                    const r = await request('POST', route, { headers: { Cookie: cookie2 }, body });
                    assert.strictEqual(r.status, 503, `${route} -> ${r.status}`);
                    assert.strictEqual(r.body.error, 'device_identity_unavailable');
                }
                assert.strictEqual(b2.deviceIdentity.isLanOnly(), true);
                assert.ok(fs.statSync(idFile).isDirectory(), 'nothing on disk was replaced');

                // The operator sets a custom PIN during the outage (e.g. the
                // access code leaked). It works now and must survive recovery.
                const customPin = await request('POST', '/api/remote/pin', { headers: { Cookie: cookie2 }, body: { pin: '86427531' } });
                assert.strictEqual(customPin.status, 200);
                assert.strictEqual(b2.remoteAccessService.verifyPinRaw('86427531'), true);
                assert.strictEqual(b2.remoteAccessConfigStore.get('remoteAccess.accessCodeOffPending'), true, 'the access-code-off intent is remembered');

                // The lock clears: a valid, non-LAN-only identity appears, whose
                // file still says the access code is active (no first-run marker).
                const donorDir = path.join(tmp, 'identity-donor');
                fs.mkdirSync(donorDir, { recursive: true });
                const { DeviceIdentity } = require('../services/remoteAccess/DeviceIdentity');
                const donor = new DeviceIdentity({ file: path.join(donorDir, 'device-identity.json') }).load();
                donor.syncPin({ hasPin: () => false, getPinSource: () => null, verifyPinRaw: () => false, setPin() {} });
                assert.strictEqual(donor.isAccessCodeActive(), true);
                fs.rmSync(idFile, { recursive: true, force: true });
                fs.copyFileSync(path.join(donorDir, 'device-identity.json'), idFile);
                await waitFor(() => b2.deviceIdentity.isAvailable(), 3000, 'background identity recovery');
                assert.strictEqual(b2.deviceIdentity.getDeviceId(), donor.getDeviceId(), 'the saved identity is used, not a new one');
                assert.strictEqual(b2.deviceIdentity.isLanOnly(), false);
                assert.strictEqual(outbound[outbound.length - 1], true, 'outbound restored per the saved choice');
                assert.strictEqual(hostnames[hostnames.length - 1], donor.mdnsHostname());
                assert.strictEqual(mdnsStarts, 0, 'test mode never starts mDNS');
                assert.strictEqual(b2.remoteAccessService.verifyPinRaw(donor.getAccessCode()), false, 'the old access code is NOT reinstated');
                assert.strictEqual(b2.remoteAccessService.verifyPinRaw('86427531'), true, 'the PIN set during the outage still works');
                assert.strictEqual(b2.remoteAccessService.getPinSource(), 'custom');
                assert.strictEqual(b2.deviceIdentity.isAccessCodeActive(), false);
                assert.strictEqual(b2.remoteAccessConfigStore.get('remoteAccess.accessCodeOffPending', false), false, 'marker cleared once applied');
                const reread = new DeviceIdentity({ file: idFile }).load();
                assert.strictEqual(reread.isAccessCodeActive(), false, 'accessCodeActive=false was written to the identity file');
                const lan = await request('POST', '/api/remote/lan-only', { headers: { Cookie: cookie2 }, body: { enabled: true } });
                assert.strictEqual(lan.status, 200);
            } finally {
                PORT = savedPort;
                await b2.shutdown();
            }
        });

        await test('boot identity: corrupt main + .bak is retried once into a fresh identity; loadDeviceIdentity never throws for an unreadable file', async () => {
            const dir = path.join(tmp, 'identity-boot');
            fs.mkdirSync(dir, { recursive: true });
            const file = path.join(dir, 'device-identity.json');
            fs.writeFileSync(file, '{not json');
            fs.writeFileSync(`${file}.bak`, 'also not json');
            const identity = loadDeviceIdentity(file);
            assert.match(identity.getDeviceId(), /^[0-9a-f]{12}$/);
            assert.strictEqual(identity.wasCorruptRecovered(), true);
            assert.strictEqual(identity.getPublicView().corruptRecovered, true);

            const lockedDir = path.join(tmp, 'identity-unreadable');
            const lockedFile = path.join(lockedDir, 'device-identity.json');
            fs.mkdirSync(lockedFile, { recursive: true });   // a directory cannot be read as a file
            const degraded = loadDeviceIdentity(lockedFile);
            assert.strictEqual(degraded.isAvailable(), false);
            assert.strictEqual(degraded.isLanOnly(), true);
            assert.strictEqual(degraded.getPublicView().unavailable, true);
            assert.throws(() => degraded.setLanOnly(false), /device_identity_unavailable/);
            assert.throws(() => degraded.regenerateAccessCode(), /device_identity_unavailable/);
            assert.strictEqual(degraded.retryLoad(), false);
            assert.ok(fs.statSync(lockedFile).isDirectory(), 'nothing on disk was replaced');
        });
    } finally {
        for (const s of sockets) s.close();
        await backend.shutdown();
        assert.strictEqual(cloudLinkStub.calls.stop, 1, 'shutdown stops the cloud link');
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* Windows file locks */ }
    }
    console.log(`All ${passed} remote integration tests passed`);
}

main().then(() => process.exit(0)).catch((err) => {
    console.error('remote_integration.test.js FAILED:', err);
    process.exit(1);
});

// tests/run-all.js treats a run as finished only when it prints this line.
// These suites came from the remote-access branch, which ran them directly;
// they signal failure with a non-zero exit, so a clean exit means pass.
process.on('exit', (code) => { if (code === 0) console.log('ALL TESTS PASSED SUCCESSFULLY!'); });
