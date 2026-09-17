'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { WebSocketServer } = require('ws');
const { FakeEngine, createFakeClock, silentLogger } = require('./helpers/fakeEngine');
const { CloudLinkService, RemoteCommandGate, createAtomicJsonStore } = require('../services/cloudLink');
const { normalizeRelayUrl } = require('../services/cloudLink/CloudLinkService');
const { HostLoadMonitor } = require('../services/cloudLink/HostLoadMonitor');
const { LibraryService } = require('../services/library/LibraryService');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-service-'));
const OP = Object.freeze({ kind: 'operator' });
const CRED = 'odc_current-credential-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const allLogs = [];

async function waitFor(cond, ms = 2000, what = 'condition') {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (cond()) return;
        await sleep(5);
    }
    throw new Error(`timed out waiting for ${what}`);
}

function env(t, body, extra = {}) {
    return JSON.stringify({ v: 1, t, id: extra.id || `m_${crypto.randomBytes(6).toString('hex')}`, ts: Date.now(), topic: null, cls: null, enc: 'none', kid: null, via: null, body, ...extra });
}

async function startRelay() {
    const r = { upgrades: [], http: [], sockets: [], respond: null, httpHandler: null, autoWelcome: true, autoPong: true, limits: {}, onMessage: null };
    r.server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf-8');
            const entry = { method: req.method, url: req.url, headers: req.headers, body: text ? JSON.parse(text) : null };
            r.http.push(entry);
            if (r.httpHandler) return r.httpHandler(entry, res);
            res.writeHead(404); res.end();
        });
    });
    r.wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
    r.server.on('upgrade', (req, socket, head) => {
        r.upgrades.push({ url: req.url, headers: req.headers });
        const resp = r.respond && r.respond(req, r.upgrades.length);
        if (resp) {
            const body = JSON.stringify(resp.body || {});
            const extra = Object.entries(resp.headers || {}).map(([k, v]) => `${k}: ${v}\r\n`).join('');
            socket.end(`HTTP/1.1 ${resp.status} X\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n${extra}Connection: close\r\n\r\n${body}`);
            return;
        }
        r.wss.handleUpgrade(req, socket, head, (ws) => {
            ws.msgs = [];
            ws.binary = [];
            ws.authorization = req.headers.authorization;
            r.sockets.push(ws);
            ws.on('message', (data, isBinary) => {
                if (isBinary) { ws.binary.push(Buffer.from(data)); return; }
                const m = JSON.parse(data.toString());
                ws.msgs.push(m);
                if (r.onMessage) r.onMessage(ws, m);
                if (m.t === 'hello' && r.autoWelcome) {
                    ws.send(env('welcome', { serverTime: Date.now(), connId: 'k_machine00001', deviceId: 'd_4q9w7e1r2t3y', heartbeatMs: 5000, limits: r.limits, user: null }));
                }
                if (m.t === 'ping' && r.autoPong) {
                    ws.send(env('pong', { nonce: m.body.nonce, sentAt: m.body.sentAt, recvAt: m.body.sentAt + 5 }));
                }
            });
        });
    });
    await new Promise(res => r.server.listen(0, '127.0.0.1', res));
    r.url = `http://127.0.0.1:${r.server.address().port}`;
    r.last = () => r.sockets[r.sockets.length - 1];
    r.close = async () => {
        for (const ws of r.wss.clients) ws.terminate();
        r.server.closeAllConnections();
        await new Promise(res => r.server.close(res));
    };
    return r;
}

function makeLink(relay, opts = {}) {
    const dir = fs.mkdtempSync(path.join(tmpRoot, 'l-'));
    const clock = opts.realTimers ? null : createFakeClock();
    const timers = clock
        ? { setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout, setIntervalFn: clock.setInterval, clearIntervalFn: clock.clearInterval }
        : {};
    const store = createAtomicJsonStore(path.join(dir, 'cloud-link.json'), {});
    store.update((d) => {
        d.enabled = opts.enabled !== undefined ? opts.enabled : true;
        d.relayUrl = opts.relayUrl !== undefined ? opts.relayUrl : relay.url;
        d.credential = opts.credential !== undefined ? opts.credential : CRED;
        d.nextCredential = opts.nextCredential || null;
        d.relayDeviceId = 'd_4q9w7e1r2t3y';
    });
    const engine = new FakeEngine({ controllerType: 'Grbl' });
    const logger = silentLogger();
    allLogs.push(logger);
    const gate = new RemoteCommandGate({
        store, logger, getEngine: () => engine, auditFile: path.join(dir, 'remote-audit.jsonl'),
        ...(clock ? { clock } : {}), ...timers,
        hostLoadMonitor: new HostLoadMonitor(clock ? { clock, setIntervalFn: clock.setInterval, clearIntervalFn: clock.clearInterval } : {}),
    });
    gate.attachEngine(engine);
    engine.setStatus({ activeState: 'Idle' });
    const linkDowns = [];
    const realLinkDown = gate.onLinkDown.bind(gate);
    gate.onLinkDown = (kind, reason) => { linkDowns.push(reason || 'link-down'); return realLinkDown(kind, reason); };
    const h = { dir, clock, store, engine, gate, logger, linkDowns, lanOnly: false, statuses: [], pairings: [], demands: [] };
    h.webcam = {
        frames: { cam1: null },
        list: () => [{ id: 'cam1', name: 'USB camera' }],
        snapshot: (id) => h.webcam.frames[id] || null,
    };
    h.lib = new LibraryService({ dataDir: dir, io: null, logger: silentLogger() });
    h.link = new CloudLinkService({
        dataDir: dir, store, logger, gate, getEngine: () => engine, libraryService: h.lib, webcamService: h.webcam,
        isLanOnly: () => h.lanOnly, getHardwareId: () => '3f9a1c07b2e4', getDeviceName: () => 'Onefinity 3F9A', appVersion: '0.1.0',
        onStatus: s => h.statuses.push(s), onPairing: p => h.pairings.push(p), onCameraDemand: d => h.demands.push(d),
        ...(clock ? { clock, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout } : {}),
        random: opts.random || (() => 1),
        retryDelaysMs: [10, 10, 10, 10, 10],
    });
    h.state = () => h.link.getStatus().state;
    h.delay = () => (h.link._nextRetryAt === null ? null : h.link._nextRetryAt - (clock ? clock.wall() : Date.now()));
    h.stop = async () => { await h.link.stop('shutdown'); h.gate.dispose(); };
    return h;
}

async function online(relay, h) {
    h.link.init();
    await waitFor(() => h.state() === 'online', 2000, 'online');
    return relay.last();
}

// ─── connect ──────────────────────────────────────────────────────────

test('connect: headers, hello contents, welcome -> online, 3 warm-up pings 200 ms apart', async () => {
    const relay = await startRelay();
    const h = makeLink(relay);
    const ws = await online(relay, h);
    const up = relay.upgrades[0];
    assert.strictEqual(up.url, '/ws/device');
    assert.strictEqual(up.headers.authorization, `Bearer ${CRED}`);
    assert.strictEqual(up.headers['x-onefinity-protocol'], '1');
    const hello = ws.msgs[0];
    assert.strictEqual(hello.t, 'hello');
    assert.strictEqual(hello.v, 1);
    assert.deepStrictEqual(hello.body, {
        protocol: { min: 1, max: 1 }, hardwareId: '3f9a1c07b2e4', appVersion: '0.1.0', controllerType: 'Grbl',
        capabilities: { snapshot: true, webrtc: false, e2e: false, files: true }, cameras: [{ id: 'cam1', name: 'USB camera' }],
    });
    await waitFor(() => ws.msgs.some(m => m.t === 'report.state') && ws.msgs.some(m => m.t === 'report.tier'), 1000, 'reports');
    const firstState = ws.msgs.find(m => m.t === 'report.state');
    assert.strictEqual(firstState.topic, 'device/d_4q9w7e1r2t3y/report');
    h.clock.advance(400);
    await waitFor(() => ws.msgs.filter(m => m.t === 'ping').length === 3, 1000, 'warm-up pings');
    const pings = ws.msgs.filter(m => m.t === 'ping');
    assert.deepStrictEqual(pings.map(p => p.body.sentAt - pings[0].body.sentAt), [0, 200, 400]);
    await waitFor(() => h.link.getStatus().rttMs !== null, 1000, 'rtt');
    assert.ok(Number.isInteger(h.link.getStatus().rttMs));
    await h.stop();
    await relay.close();
});

test('reconnect backoff with random=1: 1 s, 2 s, 4 s ... capped at 60 s', async () => {
    const relay = await startRelay();
    relay.respond = () => ({ status: 502, body: {} });
    const h = makeLink(relay);
    h.link.init();
    const expected = [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000];
    for (let i = 0; i < expected.length; i++) {
        await waitFor(() => relay.upgrades.length === i + 1 && h.delay() !== null, 2000, `attempt ${i + 1}`);
        assert.strictEqual(h.delay(), expected[i], `delay ${i}`);
        assert.strictEqual(h.state(), 'backoff');
        h.clock.advance(expected[i] - 1);
        await sleep(20);
        assert.strictEqual(relay.upgrades.length, i + 1, 'not before the delay');
        h.clock.advance(1);
    }
    await h.stop();
    await relay.close();
});

test('close 4401 revoked -> credential wiped, unpaired, no reconnect', async () => {
    const relay = await startRelay();
    const h = makeLink(relay);
    const ws = await online(relay, h);
    ws.close(4401, 'revoked');
    await waitFor(() => h.state() === 'unpaired', 2000, 'unpaired');
    assert.strictEqual(h.store.get().credential, null);
    assert.strictEqual(h.delay(), null);
    assert.ok(h.linkDowns.length >= 1);
    h.clock.advance(3600000);
    await sleep(50);
    assert.strictEqual(relay.upgrades.length, 1);
    await h.stop();
    await relay.close();
});

test('upgrade 401 invalid -> auth-failed, retry only after 15 min; 401 revoked -> unpaired', async () => {
    const relay = await startRelay();
    relay.respond = () => ({ status: 401, body: { error: 'invalid' } });
    let h = makeLink(relay);
    h.link.init();
    await waitFor(() => h.state() === 'auth-failed', 2000, 'auth-failed');
    assert.strictEqual(h.delay(), 15 * 60 * 1000);
    assert.ok(/pair again/.test(h.link.getStatus().lastError));
    h.clock.advance(15 * 60 * 1000 - 1);
    await sleep(30);
    assert.strictEqual(relay.upgrades.length, 1);
    h.clock.advance(1);
    await waitFor(() => relay.upgrades.length === 2, 2000, 'retry after 15 min');
    await h.stop();

    relay.upgrades.length = 0;
    relay.respond = () => ({ status: 401, body: { error: 'revoked' } });
    h = makeLink(relay);
    h.link.init();
    await waitFor(() => h.state() === 'unpaired', 2000, 'unpaired');
    assert.strictEqual(h.store.get().credential, null);
    assert.strictEqual(h.delay(), null);
    await h.stop();
    await relay.close();
});

test('upgrade 426 -> auth-failed protocol message; 429 Retry-After 45 -> >= 45 s; 502 -> normal backoff', async () => {
    const relay = await startRelay();
    relay.respond = () => ({ status: 426, body: { error: 'protocol', supported: [1] } });
    let h = makeLink(relay);
    h.link.init();
    await waitFor(() => h.state() === 'auth-failed', 2000, '426');
    assert.strictEqual(h.link.getStatus().lastError, 'Relay protocol mismatch — update the machine or relay');
    assert.strictEqual(h.delay(), 60 * 60 * 1000);
    await h.stop();

    relay.respond = () => ({ status: 429, body: { error: 'rate_limited' }, headers: { 'Retry-After': '45' } });
    h = makeLink(relay);
    h.link.init();
    await waitFor(() => h.delay() !== null, 2000, '429');
    assert.ok(h.delay() >= 45000, `delay ${h.delay()}`);
    await h.stop();

    relay.respond = () => ({ status: 502, body: {} });
    h = makeLink(relay);
    h.link.init();
    await waitFor(() => h.delay() !== null, 2000, '502');
    assert.strictEqual(h.delay(), 1000);
    assert.strictEqual(h.state(), 'backoff');
    await h.stop();
    await relay.close();
});

test('close 4409 (replaced) waits at least 30 s', async () => {
    const relay = await startRelay();
    const h = makeLink(relay);
    const ws = await online(relay, h);
    ws.close(4409, 'replaced');
    await waitFor(() => h.delay() !== null, 2000, 'backoff');
    assert.ok(h.delay() >= 30000);
    await h.stop();
    await relay.close();
});

test('missed pong -> terminate and onLinkDown; jog cancelled', async () => {
    const relay = await startRelay();
    relay.autoPong = false;
    const h = makeLink(relay);
    const ws = await online(relay, h);
    let serverClosed = false;
    ws.on('close', () => { serverClosed = true; });
    h.gate.grantMotion(5, OP, { channel: 'cloud' });
    h.clock.advance(400);
    // Fast cadence (motion) -> deadline max(3 x 1000, 3000) from the oldest unanswered ping.
    h.clock.advance(3000);
    await waitFor(() => h.state() !== 'online', 1000, 'link down');
    assert.ok(h.linkDowns.includes('link-down'));
    await waitFor(() => serverClosed, 2000, 'server saw close');
    await h.stop();
    await relay.close();
});

test('disabled -> no connection; https required for non-loopback URLs', async () => {
    const relay = await startRelay();
    const h = makeLink(relay, { enabled: false });
    h.link.init();
    await sleep(150);
    assert.strictEqual(relay.upgrades.length, 0);
    assert.strictEqual(h.state(), 'disabled');
    assert.throws(() => h.link.setRelayUrl('http://relay.example.com'), /invalid_url/);
    assert.throws(() => h.link.setRelayUrl('ftp://relay.example.com'), /invalid_url/);
    assert.throws(() => h.link.setRelayUrl('https://user:pw@relay.example.com'), /invalid_url/);
    assert.throws(() => h.link.setRelayUrl(42), /invalid_url/);
    assert.strictEqual(normalizeRelayUrl('https://relay.example.com/some/path?q=1'), 'https://relay.example.com');
    assert.strictEqual(normalizeRelayUrl('http://localhost:8080'), 'http://localhost:8080');
    assert.strictEqual(normalizeRelayUrl('http://[::1]:9000/'), 'http://[::1]:9000');
    await h.stop();
    await relay.close();
});

test('LAN-only: closes socket, cancels pairing and download with no HTTP, no reconnect for 2 s', async () => {
    const relay = await startRelay();
    let downloadStarted = false;
    relay.httpHandler = (req, res) => {
        if (req.url === '/api/device/pairing' && req.method === 'POST') {
            res.writeHead(201, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ pairingId: 'pr_abcdefabcdef', code: 'ABCD-EFGH', expiresAt: Date.now() + 600000, pollSecret: 'ops_secret', pollIntervalMs: 1000 }));
            return;
        }
        if (req.url.startsWith('/api/device/pairing/')) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'pending' }));
            return;
        }
        if (req.url.startsWith('/api/device/files/')) {
            downloadStarted = true;
            res.writeHead(200, { 'Content-Length': 100000 });
            res.write(Buffer.alloc(1000, 0x41));
            return;
        }
        res.writeHead(404); res.end();
    };
    const paired = makeLink(relay, { realTimers: true });
    paired.gate.setJobControl('cloud', true, OP);
    paired.link.init();
    await waitFor(() => paired.state() === 'online', 2000, 'online');
    const ws = relay.last();
    let wsClosed = false;
    ws.on('close', () => { wsClosed = true; });
    ws.send(env('file.offer', { transferId: 'x_abcdefabcdef', name: 'a.nc', size: 100000, sha256: 'a'.repeat(64), uploadedBy: { userId: 'u_aaaaaaaaaaaa', userLabel: 'Sam' } }));
    await waitFor(() => downloadStarted, 2000, 'download started');

    const unpaired = makeLink(relay, { realTimers: true, credential: null });
    unpaired.link.init();
    await unpaired.link.startPairing();
    assert.strictEqual(unpaired.state(), 'pairing');

    paired.lanOnly = true;
    unpaired.lanOnly = true;
    paired.link.applyLanOnly(true);
    unpaired.link.applyLanOnly(true);
    assert.strictEqual(paired.state(), 'lan-only');
    assert.ok(paired.linkDowns.includes('lan-only'));
    assert.strictEqual(unpaired.link.getPairing(), null);
    await sleep(100);
    const upgrades = relay.upgrades.length;
    const httpCount = relay.http.length;
    await sleep(2000);
    assert.strictEqual(relay.upgrades.length, upgrades, 'no new connection attempts');
    assert.strictEqual(relay.http.length, httpCount, 'no HTTP requests (no pairing DELETE, no polling, no download retry)');
    assert.ok(!relay.http.some(r => r.method === 'DELETE'));
    assert.ok(wsClosed, 'relay socket closed');
    assert.deepStrictEqual(fs.readdirSync(path.join(paired.dir, 'cloud-inbox')).filter(n => n.endsWith('.part')), []);
    await paired.stop();
    await unpaired.stop();
    await relay.close();
});

test('pairing: pendingCredential persisted before POST, hash only, claimed -> confirm -> connect; reject discards', async () => {
    const relay = await startRelay();
    let h;
    let pollStatus = 'pending';
    const observations = {};
    relay.httpHandler = (req, res) => {
        const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(body ? JSON.stringify(body) : ''); };
        if (req.url === '/api/device/pairing' && req.method === 'POST') {
            observations.pendingAtPost = h.store.get().pendingCredential;
            observations.body = req.body;
            return json(201, { pairingId: 'pr_abcdefabcdef', code: 'ABCD-EFGH', expiresAt: Date.now() + 600000, pollSecret: 'ops_pollsecret', pollIntervalMs: 3000 });
        }
        if (req.url === '/api/device/pairing/pr_abcdefabcdef' && req.method === 'GET') {
            observations.pollAuth = req.headers.authorization;
            if (pollStatus === 'claimed') return json(200, { status: 'claimed', deviceId: 'd_4q9w7e1r2t3y', accountLabel: 's***@example.com', accountDisplayName: 'Sam', relayWsUrl: 'ws://evil.example/ws/device' });
            return json(200, { status: 'pending' });
        }
        if (req.url === '/api/device/pairing/pr_abcdefabcdef/confirm' && req.method === 'POST') {
            observations.credentialAtConfirm = h.store.get().credential;
            res.writeHead(204); res.end(); return;
        }
        if (req.url === '/api/device/pairing/pr_abcdefabcdef/reject' && req.method === 'POST') {
            res.writeHead(204); res.end(); return;
        }
        res.writeHead(404); res.end();
    };
    h = makeLink(relay, { credential: null });
    h.gate.setJobControl('cloud', true, OP);
    h.link.init();
    assert.strictEqual(h.state(), 'unpaired');
    await assert.rejects(() => makeLink(relay, { relayUrl: null, credential: null }).link.startPairing(), /no_relay_url/);
    const started = await h.link.startPairing();
    assert.deepStrictEqual({ code: started.code }, { code: 'ABCD-EFGH' });
    assert.ok(/^odc_/.test(observations.pendingAtPost), 'persisted before POST');
    assert.strictEqual(observations.body.credentialHash, sha(observations.pendingAtPost));
    assert.ok(!JSON.stringify(observations.body).includes('odc_'), 'POST carries only the hash');
    assert.deepStrictEqual(h.pairings[h.pairings.length - 1], { state: 'pending', code: 'ABCD-EFGH', expiresAt: h.pairings[h.pairings.length - 1].expiresAt });
    await assert.rejects(() => h.link.confirmPairing(), /not_claimed/);

    pollStatus = 'claimed';
    h.clock.advance(3000);
    await waitFor(() => h.pairings.some(p => p && p.state === 'claimed'), 2000, 'claimed');
    assert.strictEqual(observations.pollAuth, 'Bearer ops_pollsecret');
    assert.deepStrictEqual(h.link.getPairing(), { state: 'claimed', accountLabel: 's***@example.com', accountDisplayName: 'Sam', deviceId: 'd_4q9w7e1r2t3y' });
    assert.strictEqual(h.state(), 'pairing');
    await sleep(50);
    assert.strictEqual(relay.upgrades.length, 0, 'no WS before the operator confirms');

    const pending = h.store.get().pendingCredential;
    await h.link.confirmPairing();
    assert.strictEqual(observations.credentialAtConfirm, null);
    assert.strictEqual(h.store.get().credential, pending);
    assert.strictEqual(h.store.get().pendingCredential, null);
    assert.strictEqual(h.store.get().accountLabel, 's***@example.com');
    assert.strictEqual(h.store.get().tiers.jobControl.cloud, true, 'credential save keeps the gate tiers');
    await waitFor(() => h.state() === 'online', 2000, 'online after confirm');
    assert.strictEqual(relay.upgrades[0].headers.authorization, `Bearer ${pending}`);
    await h.stop();

    pollStatus = 'pending';
    const r = makeLink(relay, { credential: null });
    r.link.init();
    await r.link.startPairing();
    pollStatus = 'claimed';
    r.clock.advance(3000);
    await waitFor(() => r.link.getPairing() && r.link.getPairing().state === 'claimed', 2000, 'claimed 2');
    await r.link.rejectPairing();
    assert.strictEqual(r.store.get().pendingCredential, null);
    assert.strictEqual(r.link.getPairing(), null);
    assert.ok(relay.http.some(x => x.url.endsWith('/reject')));
    assert.strictEqual(r.state(), 'unpaired');
    await r.stop();
    await relay.close();
});

test('rotation: next persisted before cred.rotated; commit promotes; lost commit -> next first, 401 -> credential', async () => {
    const relay = await startRelay();
    const h = makeLink(relay);
    h.gate.setJobControl('cloud', true, OP);
    const seen = [];
    relay.onMessage = (ws, m) => {
        if (m.t === 'cred.rotated') seen.push({ rotateId: m.body.rotateId, hash: m.body.newCredentialHash, persistedNext: h.store.get().nextCredential });
    };
    let ws = await online(relay, h);
    ws.send(env('cred.rotate', { rotateId: 'r_first' }));
    await waitFor(() => seen.length === 1, 2000, 'cred.rotated');
    assert.ok(/^odc_/.test(seen[0].persistedNext));
    assert.strictEqual(seen[0].hash, sha(seen[0].persistedNext));
    ws.send(env('cred.commit', { rotateId: 'r_other' }));
    await sleep(30);
    assert.strictEqual(h.store.get().credential, CRED, 'mismatched rotateId ignored');
    ws.send(env('cred.commit', { rotateId: 'r_first' }));
    await waitFor(() => h.store.get().credential === seen[0].persistedNext, 2000, 'commit');
    assert.strictEqual(h.store.get().nextCredential, null);
    const current = h.store.get().credential;

    ws.send(env('cred.rotate', { rotateId: 'r_second' }));
    await waitFor(() => seen.length === 2, 2000, 'second rotated');
    const next = seen[1].persistedNext;
    relay.respond = (req) => (req.headers.authorization === `Bearer ${next}` ? { status: 401, body: { error: 'invalid' } } : null);
    ws.close(1001, 'going away');
    await waitFor(() => h.delay() !== null, 2000, 'backoff');
    h.clock.advance(h.delay());
    await waitFor(() => relay.upgrades.length === 3, 2000, 'next then fallback');
    assert.deepStrictEqual(relay.upgrades.slice(1).map(u => u.headers.authorization), [`Bearer ${next}`, `Bearer ${current}`]);
    await waitFor(() => h.state() === 'online', 2000, 'online with credential');
    assert.strictEqual(h.store.get().credential, current);
    assert.strictEqual(h.store.get().nextCredential, null);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(h.dir, 'cloud-link.json'), 'utf-8')).tiers.jobControl.cloud, true);
    await h.stop();
    await relay.close();
});

test('camera: frame format, fps cap, maxBytes, same-buffer skip, backpressure halving, jog suspension, lease expiry', async () => {
    const relay = await startRelay();
    relay.limits = { snapshotMaxBytes: 1000, snapshotMaxFps: 1 };
    const h = makeLink(relay);
    const ws = await online(relay, h);
    const jpeg = (n, fill) => Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(n - 2, fill)]);
    h.webcam.frames.cam1 = jpeg(100, 1);
    ws.send(env('camera.demand', { cameraId: 'cam1', fps: 2, leaseMs: 10000 }));
    await waitFor(() => h.demands.some(d => d.cameraId === 'cam1'), 2000, 'demand');
    h.clock.advance(0);
    await waitFor(() => ws.binary.length === 1, 2000, 'first frame');
    assert.deepStrictEqual(h.demands[h.demands.length - 1], { cameraId: 'cam1', fps: 1 }, 'fps capped by welcome.limits');
    const frame = ws.binary[0];
    assert.strictEqual(frame[0], 0x01);
    const hl = frame.readUInt16BE(1);
    const header = JSON.parse(frame.subarray(3, 3 + hl).toString());
    assert.deepStrictEqual({ ...header, ts: typeof header.ts }, { v: 1, deviceId: 'd_4q9w7e1r2t3y', cameraId: 'cam1', ts: 'number', seq: 1, enc: 'none' });
    assert.deepStrictEqual(frame.subarray(3 + hl), h.webcam.frames.cam1);

    h.clock.advance(1000);
    await sleep(30);
    assert.strictEqual(ws.binary.length, 1, 'same Buffer is not re-sent');

    h.webcam.frames.cam1 = jpeg(1500, 2);
    h.clock.advance(1000);
    await waitFor(() => ws.msgs.some(m => m.t === 'camera.error' && m.body.code === 'TOO_LARGE'), 2000, 'TOO_LARGE');
    assert.strictEqual(ws.binary.length, 1);
    assert.deepStrictEqual(h.demands[h.demands.length - 1], { cameraId: 'cam1', fps: 1, maxBytes: 1000 });

    let buffered = 64 * 1024;
    Object.defineProperty(h.link._ws, 'bufferedAmount', { get: () => buffered, configurable: true });
    h.webcam.frames.cam1 = jpeg(200, 3);
    for (let i = 0; i < 4; i++) h.clock.advance(1000);
    await sleep(30);
    assert.strictEqual(ws.binary.length, 1, 'skipped while bufferedAmount >= 32 KiB');
    assert.strictEqual(h.link._cameras.get('cam1').effectiveFps, 0.5, 'halved after 3 s of skips');
    buffered = 0;
    ws.send(env('camera.demand', { cameraId: 'cam1', fps: 1, leaseMs: 10000 }));
    const leaseBefore = h.link._cameras.get('cam1').leaseUntil;
    await waitFor(() => h.link._cameras.get('cam1').leaseUntil > leaseBefore, 2000, 'lease renewed');

    h.gate.deadman.lease = { jogId: 'j_suspend', identity: { kind: 'cloud' } };
    h.clock.advance(2000);
    await sleep(30);
    assert.strictEqual(ws.binary.length, 1, 'suspended during a continuous jog');
    h.gate.deadman.lease = null;
    h.clock.advance(2000);
    await waitFor(() => ws.binary.length === 2, 2000, 'resumed');
    ws.send(env('camera.demand', { cameraId: 'nope', fps: 1, leaseMs: 10000 }));
    await waitFor(() => ws.msgs.some(m => m.t === 'camera.error' && m.body.code === 'NOT_FOUND'), 2000, 'NOT_FOUND');

    h.clock.advance(10000);
    await waitFor(() => h.demands.some(d => d.cameraId === 'cam1' && d.fps === 0), 2000, 'lease expiry');
    const count = ws.binary.length;
    h.webcam.frames.cam1 = jpeg(300, 4);
    h.clock.advance(5000);
    await sleep(30);
    assert.strictEqual(ws.binary.length, count, 'no frames after the lease expired');

    // Demanded again: the frame seq continues instead of restarting at 1, so
    // a phone polling with ?after=<last seq> does not stall.
    const seqOf = (f) => JSON.parse(f.subarray(3, 3 + f.readUInt16BE(1)).toString()).seq;
    const lastSeq = seqOf(ws.binary[count - 1]);
    const demandsBefore = h.demands.length;
    ws.send(env('camera.demand', { cameraId: 'cam1', fps: 1, leaseMs: 10000 }));
    await waitFor(() => h.demands.length > demandsBefore, 2000, 'demand again');
    h.clock.advance(0);
    await waitFor(() => ws.binary.length === count + 1, 2000, 'frame after re-demand');
    assert.strictEqual(seqOf(ws.binary[count]), lastSeq + 1, 'seq monotonic across stop/start');
    await h.stop();
    await relay.close();
});

test('status: operator view carries the stored file limits; a partial setLimits keeps the other', async () => {
    const relay = await startRelay();
    const h = makeLink(relay);
    let st = h.link.getStatus();
    assert.deepStrictEqual([st.maxFileMb, st.cloudLibraryCapMb], [25, 500], 'defaults');
    st = h.link.setLimits({ cloudLibraryCapMb: 2000 });
    assert.deepStrictEqual([st.maxFileMb, st.cloudLibraryCapMb], [25, 2000]);
    st = h.link.setLimits({ maxFileMb: 50 });
    assert.deepStrictEqual([st.maxFileMb, st.cloudLibraryCapMb], [50, 2000], 'partial update keeps cloudLibraryCapMb');
    assert.deepStrictEqual([h.link.getStatus().maxFileMb, h.link.getStatus().cloudLibraryCapMb], [50, 2000]);
    assert.strictEqual(h.statuses[h.statuses.length - 1].maxFileMb, 50, 'emitted status carries it too');
    // Never let requiring index.js start a real backend (port 4000, mDNS, ...).
    process.env.CNC_BACKEND_NO_AUTOSTART = '1';
    const { redactCloudStatus } = require('../index');
    const lan = redactCloudStatus(h.link.getStatus());
    assert.strictEqual(lan.maxFileMb, undefined);
    assert.strictEqual(lan.cloudLibraryCapMb, undefined);
    await h.stop();
    await relay.close();
});

test('commands route only through the gate; acks echo refId; keepalive acked only on rejection; unknown t -> error', async () => {
    const relay = await startRelay();
    const h = makeLink(relay);
    const ws = await online(relay, h);
    h.clock.advance(400);
    await waitFor(() => h.link.latency.relayOffsetMs !== null, 2000, 'offset');
    h.gate.grantMotion(5, OP, { channel: 'cloud' });
    const executed = [];
    const realExecute = h.gate.execute.bind(h.gate);
    h.gate.execute = (identity, type, args, ctx) => { executed.push({ identity, type }); return realExecute(identity, type, args, ctx); };
    const via = { userId: 'u_aaaaaaaaaaaa', userLabel: 'Sam', role: 'operator', connId: 'k_browser00001', sessionRef: 's1', relayTs: Date.now(), clientRttMs: 20 };
    ws.send(env('cmd', { type: 'job.stop', args: {}, seq: 1, issuedAt: Date.now(), ttlMs: 10000, idem: 'c_stop00000001' }, { id: 'c_stop00000001', cls: 'stop', topic: 'device/d_4q9w7e1r2t3y/request', via: { ...via, clientSeq: 1, relayTs: h.clock.wall() } }));
    await waitFor(() => ws.msgs.some(m => m.t === 'cmd.ack'), 2000, 'ack');
    const ack = ws.msgs.find(m => m.t === 'cmd.ack');
    assert.deepStrictEqual({ ...ack.body, at: typeof ack.body.at }, {
        refId: 'c_stop00000001', idem: 'c_stop00000001', type: 'job.stop', status: 'accepted', code: 'OK', message: 'nothing-to-stop', duplicate: false, at: 'number',
    });
    assert.strictEqual(executed[0].identity.kind, 'cloud');
    assert.ok(executed.every(e => e.identity.kind !== 'operator'));
    ws.send(env('cmd', { type: 'jog.cont.keepalive', args: { jogId: 'j_nothere' }, seq: 2, ttlMs: 300, idem: 'c_ka' }, { id: 'c_ka0000000001', cls: 'motion', via: { ...via, clientSeq: 2, relayTs: h.clock.wall() } }));
    await waitFor(() => ws.msgs.filter(m => m.t === 'cmd.ack').length === 2, 2000, 'keepalive rejection ack');
    assert.strictEqual(ws.msgs.filter(m => m.t === 'cmd.ack')[1].body.code, 'EXPIRED');
    ws.send(env('cmd', { type: 'gcode', args: { line: 'M3' }, seq: 3, ttlMs: 500, idem: 'c_g' }, { id: 'c_gcode0000001', cls: 'motion', via: { ...via, clientSeq: 3, relayTs: h.clock.wall() } }));
    ws.send(env('rtc.offer', {}, { id: 'm_rtc000000001' }));
    ws.send(env('cmd', { type: 'job.stop', args: {} }, { id: 'c_enc000000001', cls: 'stop', enc: 'e2e-x25519-aesgcm-v1', via }));
    await waitFor(() => ws.msgs.some(m => m.t === 'error' && m.body.refId === 'm_rtc000000001'), 2000, 'unknown t error');
    await waitFor(() => ws.msgs.filter(m => m.t === 'cmd.ack').length === 4, 2000, 'acks');
    const acks = ws.msgs.filter(m => m.t === 'cmd.ack');
    assert.strictEqual(acks[2].body.code, 'UNKNOWN_COMMAND');
    assert.strictEqual(acks[3].body.code, 'ENC_UNSUPPORTED');
    assert.deepStrictEqual(h.engine.calls, []);
    ws.send(env('client.gone', { connId: 'k_browser00001', userId: 'u_aaaaaaaaaaaa', reason: 'closed' }));
    ws.send(env('viewers', { count: 2 }));
    await waitFor(() => h.link.getStatus().viewers === 2, 2000, 'viewers');
    await h.stop();
    await relay.close();
});

test('unpair: DELETE /api/device/self with the credential, wiped locally, socket closed', async () => {
    const relay = await startRelay();
    relay.httpHandler = (req, res) => { res.writeHead(204); res.end(); };
    const h = makeLink(relay);
    await online(relay, h);
    await h.link.unpair();
    const del = relay.http.find(r => r.method === 'DELETE' && r.url === '/api/device/self');
    assert.ok(del);
    assert.strictEqual(del.headers.authorization, `Bearer ${CRED}`);
    assert.strictEqual(h.store.get().credential, null);
    assert.strictEqual(h.state(), 'unpaired');
    assert.ok(h.linkDowns.includes('link-down'));
    await h.stop();
    await relay.close();
});

test('credentials never appear in logs, statuses or getStatus()', async () => {
    const needles = [/odc_/, /ops_/];
    for (const logger of allLogs) {
        for (const line of logger.lines) {
            for (const n of needles) assert.ok(!n.test(line.text), `log leaked: ${line.text}`);
        }
    }
    const relay = await startRelay();
    const h = makeLink(relay);
    await online(relay, h);
    const text = JSON.stringify([h.link.getStatus(), h.statuses]);
    assert.ok(!/odc_/.test(text));
    await h.stop();
    await relay.close();
});

async function main() {
    console.log('=== CloudLink Service Tests ===');
    const guard = setTimeout(() => { console.log('✗ timeout after 30 s'); process.exit(1); }, 30000);
    let failed = 0;
    for (const t of tests) {
        try {
            await t.fn();
            console.log(`✓ ${t.name}`);
        } catch (err) {
            failed += 1;
            console.log(`✗ ${t.name}`);
            console.log(err && err.stack ? err.stack : err);
        }
    }
    clearTimeout(guard);
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) { /* tmp */ }
    console.log(failed ? `${failed} of ${tests.length} failed` : `All ${tests.length} passed`);
    process.exit(failed ? 1 : 0);
}

main();

// tests/run-all.js treats a run as finished only when it prints this line.
// These suites came from the remote-access branch, which ran them directly;
// they signal failure with a non-zero exit, so a clean exit means pass.
process.on('exit', (code) => { if (code === 0) console.log('ALL TESTS PASSED SUCCESSFULLY!'); });
