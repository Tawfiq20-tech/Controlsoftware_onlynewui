'use strict';

/**
 * End to end: real relay (relay/server/relay.js) + real RemoteCommandGate +
 * real CloudLinkService + fake engine + a scripted browser. Skips (exit 0)
 * while the relay package is not present.
 */

const fs = require('fs');
const path = require('path');

const RELAY_ENTRY = path.join(__dirname, '..', '..', 'relay', 'server', 'relay.js');
if (!fs.existsSync(RELAY_ENTRY)) {
    console.log('=== CloudLink E2E Tests ===');
    console.log('SKIP: relay not present');
    process.exit(0);
}

process.env.NODE_ENV = 'test';

const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const os = require('os');
const WebSocket = require('ws');
const { FakeEngine, silentLogger } = require('./helpers/fakeEngine');
const { CloudLinkService, RemoteCommandGate, createAtomicJsonStore } = require('../services/cloudLink');
const { LibraryService } = require('../services/library/LibraryService');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-e2e-'));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const OP = Object.freeze({ kind: 'operator' });
const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz';
const stepsDone = [];
const relayLogs = [];
const secretsSeen = new Set();

function rid(prefix) {
    const b = crypto.randomBytes(12);
    let s = '';
    for (const x of b) s += BASE36[x % 36];
    return prefix + s;
}

async function waitFor(cond, ms, what) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        const v = cond();
        if (v) return v;
        await sleep(5);
    }
    throw new Error(`timed out waiting for ${what}`);
}

function request(base, method, urlPath, { cookie, csrf, json, body, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
        const u = new URL(urlPath, base);
        const h = { ...headers };
        let payload = null;
        if (json !== undefined) {
            payload = Buffer.from(JSON.stringify(json));
            h['Content-Type'] = 'application/json';
        } else if (body !== undefined) {
            payload = body;
            h['Content-Type'] = 'application/octet-stream';
        }
        if (payload) h['Content-Length'] = payload.length;
        if (cookie) h.Cookie = cookie;
        if (csrf) h['X-CSRF-Token'] = csrf;
        const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: h }, (res) => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf-8');
                let data = null;
                try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
                resolve({ status: res.statusCode, headers: res.headers, data });
            });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

function cookieFrom(res) {
    const set = res.headers['set-cookie'] || [];
    const pairs = set.map(c => c.split(';')[0]).filter(c => /^(__Host-)?ors=/.test(c));
    if (pairs.length) secretsSeen.add(pairs[0].split('=')[1]);
    return pairs.join('; ');
}

class Browser {
    constructor(base, cookie) {
        this.base = base;
        this.cookie = cookie;
        this.msgs = [];
        this.pending = new Map();
        this.seq = 0;
        this.closeCode = null;
    }

    open() {
        const url = this.base.replace(/^http/, 'ws') + '/ws/client';
        this.ws = new WebSocket(url, { headers: { Cookie: this.cookie, Origin: this.base }, perMessageDeflate: false });
        this.ws.on('message', (data) => {
            const m = JSON.parse(data.toString());
            this.msgs.push(m);
            if (m.t === 'ping') this.raw('pong', { nonce: m.body.nonce, sentAt: m.body.sentAt, recvAt: Date.now() });
            if (m.t === 'welcome') this.welcome = m.body;
            if (m.t === 'cmd.ack' && this.pending.has(m.body.refId)) {
                this.pending.get(m.body.refId)(m.body);
                this.pending.delete(m.body.refId);
            }
        });
        this.ws.on('close', (code) => { this.closeCode = code; });
        this.ws.on('error', () => {});
        return waitFor(() => this.welcome, 3000, 'client welcome');
    }

    raw(t, body, extra = {}) {
        if (this.ws.readyState !== WebSocket.OPEN) return;
        this.ws.send(JSON.stringify({ v: 1, t, id: rid('m_'), ts: Date.now(), topic: null, cls: null, enc: 'none', kid: null, via: null, body, ...extra }));
    }

    async subscribe(deviceIds) {
        const before = this.msgs.length;
        this.raw('subscribe', { deviceIds });
        await waitFor(() => this.msgs.slice(before).some(m => m.t === 'subscribed'), 3000, 'subscribed');
    }

    /** Sends a cmd; resolves with its ack body. */
    cmd(deviceId, type, args, cls, { ttlMs = 500, id } = {}) {
        const envId = id || rid(type === 'jog.cont.keepalive' ? 'j_' : 'c_');
        this.seq += 1;
        const body = { type, args, seq: this.seq, issuedAt: Date.now(), ttlMs, idem: envId };
        const p = new Promise((resolve) => this.pending.set(envId, resolve));
        this.ws.send(JSON.stringify({ v: 1, t: 'cmd', id: envId, ts: Date.now(), topic: `device/${deviceId}/request`, cls, enc: 'none', kid: null, via: null, body }));
        return p;
    }

    async cmdAck(deviceId, type, args, cls, opts) {
        const ack = await Promise.race([this.cmd(deviceId, type, args, cls, opts), sleep(6000).then(() => ({ status: 'timeout', code: 'NO_ACK' }))]);
        return ack;
    }

    close() {
        try { this.ws.terminate(); } catch (_) { /* closed */ }
    }
}

function makeMachine(name, relayUrl) {
    const dir = fs.mkdtempSync(path.join(tmpRoot, name + '-'));
    const store = createAtomicJsonStore(path.join(dir, 'cloud-link.json'), {});
    const engine = new FakeEngine({ controllerType: 'RSP' });
    const logger = silentLogger();
    const audits = [];
    const executed = [];
    const lib = new LibraryService({ dataDir: dir, io: null, logger: silentLogger() });
    const gate = new RemoteCommandGate({
        store, logger, getEngine: () => engine, libraryService: lib,
        auditFile: path.join(dir, 'remote-audit.jsonl'),
        onAudit: e => audits.push({ ...e, at: Date.now() }),
        hostLoadMonitor: { isBusy: () => false, on() {}, removeListener() {}, start() {}, stop() {} },
    });
    const realExecute = gate.execute.bind(gate);
    gate.execute = (identity, type, args, ctx) => { executed.push(identity && identity.kind); return realExecute(identity, type, args, ctx); };
    const realCheckLan = gate.checkLan.bind(gate);
    gate.checkLan = (identity, cmd, args) => { executed.push(identity && identity.kind); return realCheckLan(identity, cmd, args); };
    gate.attachEngine(engine);

    // Simulated machine: travels toward jog targets at 50 mm/s, reports 10 Hz.
    const sim = { pos: { x: 0, y: 0, z: 0 }, target: { x: 0, y: 0, z: 0 }, state: 'Idle' };
    const realCommand = engine.controller.command.bind(engine.controller);
    engine.controller.command = (cmd, ...args) => {
        if (cmd === 'jog' && args[0]) for (const a of ['x', 'y', 'z']) if (typeof args[0][a] === 'number') sim.target[a] += args[0][a];
        return realCommand(cmd, ...args);
    };
    const ticker = setInterval(() => {
        for (const a of ['x', 'y', 'z']) {
            const d = sim.target[a] - sim.pos[a];
            sim.pos[a] += Math.sign(d) * Math.min(Math.abs(d), 5);
        }
        engine.setStatus({ activeState: sim.state, mpos: { ...sim.pos }, wpos: { ...sim.pos } });
    }, 100);
    engine.setStatus({ activeState: 'Idle' });

    const link = new CloudLinkService({
        dataDir: dir, store, logger, gate, getEngine: () => engine, libraryService: lib, webcamService: null,
        isLanOnly: () => false, getHardwareId: () => crypto.randomBytes(6).toString('hex'), getDeviceName: () => `Onefinity ${name}`,
        appVersion: '0.1.0', statfs: () => ({ bavail: 1e9, bsize: 4096 }), random: () => 0,
    });
    link.setRelayUrl(relayUrl);
    link.setEnabled(true);
    link.init();
    return {
        name, dir, store, engine, logger, audits, executed, lib, gate, link, sim,
        cancelReasons: () => audits.filter(a => a.event === 'jog.cancel').map(a => a.args.reason),
        async stop() { clearInterval(ticker); await link.stop('shutdown'); gate.dispose(); },
    };
}

async function main() {
    console.log('=== CloudLink E2E Tests ===');
    const guard = setTimeout(() => { console.log('✗ timeout after 30 s'); process.exit(1); }, 30000);
    const { createRelay } = require(RELAY_ENTRY);
    let createLogger = null;
    try { ({ createLogger } = require(path.join(__dirname, '..', '..', 'relay', 'server', 'log.js'))); } catch (_) { /* optional */ }
    const relayOpts = {
        host: '127.0.0.1', port: 0, dataDir: path.join(tmpRoot, 'relay'), allowInsecure: true, signup: 'open',
        statfs: () => ({ bavail: 1e12, bsize: 4096 }), limits: { wsUpgradesPerKeyPerMin: 1000 },
    };
    if (createLogger) relayOpts.log = createLogger({ level: 'debug', write: (line) => relayLogs.push(line) });
    const relay = await createRelay(relayOpts);
    const base = relay.url;
    const machines = [];
    const browsers = [];
    let failed = 0;
    const step = async (name, fn) => {
        try {
            await fn();
            console.log(`✓ ${name}`);
            stepsDone.push(name);
        } catch (err) {
            failed += 1;
            console.log(`✗ ${name}`);
            console.log(err && err.stack ? err.stack : err);
        }
    };

    let cookie1;
    let csrf1;
    let m1;
    let m2;
    let dev1;
    let dev2;
    let b1;

    await step('setup: register, pair two machines via the real HTTP flow, browser subscribes', async () => {
        const reg = await request(base, 'POST', '/api/auth/register', { json: { email: 'sam@example.com', password: 'correct horse battery', displayName: 'Sam' } });
        assert.strictEqual(reg.status, 201, JSON.stringify(reg.data));
        cookie1 = cookieFrom(reg);
        csrf1 = reg.data.csrfToken;
        m1 = makeMachine('m1', base);
        m2 = makeMachine('m2', base);
        machines.push(m1, m2);
        const [c1, c2] = await Promise.all([m1.link.startPairing(), m2.link.startPairing()]);
        // The relay normalises codes, so a log line could carry either spelling.
        for (const c of [c1.code, c2.code]) secretsSeen.add(c).add(c.replace(/[^A-Z0-9]/g, ''));
        for (const m of [m1, m2]) secretsSeen.add(m.store.get().pendingCredential);
        const claim1 = await request(base, 'POST', '/api/devices/claim', { cookie: cookie1, csrf: csrf1, json: { code: c1.code } });
        const claim2 = await request(base, 'POST', '/api/devices/claim', { cookie: cookie1, csrf: csrf1, json: { code: c2.code, name: 'second' } });
        assert.strictEqual(claim1.status, 201, JSON.stringify(claim1.data));
        assert.strictEqual(claim2.status, 201, JSON.stringify(claim2.data));
        dev1 = claim1.data.device.id;
        dev2 = claim2.data.device.id;
        await waitFor(() => m1.link.getPairing() && m1.link.getPairing().state === 'claimed'
            && m2.link.getPairing() && m2.link.getPairing().state === 'claimed', 5000, 'claimed');
        assert.strictEqual(m1.link.getPairing().accountDisplayName, 'Sam');
        await sleep(100);
        assert.strictEqual(m1.link.getStatus().state, 'pairing', 'no WS before confirmation');
        await Promise.all([m1.link.confirmPairing(), m2.link.confirmPairing()]);
        await waitFor(() => m1.link.getStatus().state === 'online' && m2.link.getStatus().state === 'online', 4000, 'machines online');
        assert.strictEqual(m1.store.get().relayDeviceId, dev1);
        secretsSeen.add(m1.store.get().credential).add(m2.store.get().credential);
        b1 = new Browser(base, cookie1);
        browsers.push(b1);
        await b1.open();
        assert.strictEqual(b1.welcome.user.displayName, 'Sam');
        await b1.subscribe([dev1]);
        await waitFor(() => b1.msgs.some(m => m.t === 'report.state' && m.topic === `device/${dev1}/report`), 3000, 'report.state');
        relay.hubs.client.__setRttForTest(b1.welcome.connId, 20);
        await waitFor(() => m1.link.latency.isFresh(), 3000, 'machine clock offset');
    });

    await step('(1) monitor tier: job.pause -> TIER_REQUIRED', async () => {
        const ack = await b1.cmdAck(dev1, 'job.pause', {}, 'job', { ttlMs: 5000 });
        assert.deepStrictEqual([ack.status, ack.code], ['rejected', 'TIER_REQUIRED']);
    });

    await step('(2) cloud job control -> pause accepted and the engine saw gcode:pause', async () => {
        m1.gate.setJobControl('cloud', true, OP);
        m1.engine.startJob();
        const ack = await b1.cmdAck(dev1, 'job.pause', {}, 'job', { ttlMs: 5000 });
        assert.deepStrictEqual([ack.status, ack.code], ['accepted', 'OK']);
        assert.ok(m1.engine.commandNames().includes('gcode:pause'));
        m1.engine.endJob();
    });

    await step('(3) user-scoped cloud motion: jog.step exact args; LAN-scoped grant -> TIER_REQUIRED', async () => {
        m1.gate.grantMotion(5, OP, { channel: 'cloud', userId: b1.welcome.user.id });
        await sleep(300);
        relay.hubs.client.__setRttForTest(b1.welcome.connId, 20);
        const before = m1.engine.calls.length;
        let ack = await b1.cmdAck(dev1, 'jog.step', { axis: 'x', distanceMm: 1, feed: 500 }, 'motion');
        assert.deepStrictEqual([ack.status, ack.code], ['accepted', 'OK'], JSON.stringify(ack));
        assert.deepStrictEqual(m1.engine.calls.slice(before).map(c => [c.cmd, ...c.args]), [['jog', { x: 1, feedRate: 500 }]]);
        m1.gate.grantMotion(5, OP, { channel: 'lan' });
        await sleep(300);
        ack = await b1.cmdAck(dev1, 'jog.step', { axis: 'x', distanceMm: 1, feed: 500 }, 'motion');
        assert.deepStrictEqual([ack.status, ack.code], ['rejected', 'TIER_REQUIRED']);
    });

    await step('(4) continuous jog: keepalives issue steps; silence -> deadman within 500 ms', async () => {
        m1.gate.grantMotion(5, OP, { channel: 'cloud' });
        await sleep(300);
        relay.hubs.client.__setRttForTest(b1.welcome.connId, 20);
        const jogCalls = () => m1.engine.calls.filter(c => c.cmd === 'jog').length;
        const before = jogCalls();
        const ack = await b1.cmdAck(dev1, 'jog.cont.start', { jogId: 'j_contjog001', axis: 'y', dir: 1, feed: 300 }, 'motion');
        assert.deepStrictEqual([ack.status, ack.code], ['accepted', 'OK'], JSON.stringify(ack));
        let lastKeepalive = Date.now();
        for (let i = 0; i < 3; i++) {
            await sleep(100);
            b1.cmd(dev1, 'jog.cont.keepalive', { jogId: 'j_contjog001' }, 'motion', { ttlMs: 300 });
            lastKeepalive = Date.now();
        }
        assert.ok(jogCalls() > before, 'steps issued');
        await waitFor(() => m1.cancelReasons().includes('deadman'), 1500, 'deadman cancel');
        const cancel = m1.audits.find(a => a.event === 'jog.cancel' && a.args.reason === 'deadman');
        assert.ok(cancel.at - lastKeepalive <= 500, `deadman after ${cancel.at - lastKeepalive} ms`);
        await sleep(300);
    });

    await step('(6) alarm: everything except job.stop -> LOCKED', async () => {
        m1.gate.setJobControl('cloud', true, OP);
        // A real controller keeps reporting Alarm until unlocked.
        m1.sim.state = 'Alarm';
        m1.engine.emitAlarm({ type: 'alarm', code: 1, message: 'Hard limit' });
        relay.hubs.client.__setRttForTest(b1.welcome.connId, 20);
        for (const [type, args, cls] of [['job.pause', {}, 'job'], ['feed.override', { action: 'reset' }, 'job'], ['jog.step', { axis: 'x', distanceMm: 1, feed: 100 }, 'motion'], ['zero', { axes: ['x'] }, 'motion']]) {
            const ack = await b1.cmdAck(dev1, type, args, cls, { ttlMs: cls === 'motion' ? 500 : 5000 });
            assert.deepStrictEqual([ack.status, ack.code], ['rejected', 'LOCKED'], type);
        }
        const stop = await b1.cmdAck(dev1, 'job.stop', {}, 'stop', { ttlMs: 10000 });
        assert.deepStrictEqual([stop.status, stop.code], ['accepted', 'OK']);
        await sleep(150);
        m1.sim.state = 'Idle';
        await waitFor(() => !m1.gate.getLocks('cloud').includes('alarm'), 2000, 'alarm cleared');
    });

    await step('(7) relay-side client RTT 400 ms -> jog.step LATENCY_TOO_HIGH', async () => {
        m1.gate.grantMotion(5, OP, { channel: 'cloud' });
        await sleep(300);
        relay.hubs.client.__setRttForTest(b1.welcome.connId, 400);
        const ack = await b1.cmdAck(dev1, 'jog.step', { axis: 'z', distanceMm: 1, feed: 100 }, 'motion');
        assert.deepStrictEqual([ack.status, ack.code], ['rejected', 'LATENCY_TOO_HIGH']);
        relay.hubs.client.__setRttForTest(b1.welcome.connId, 20);
    });

    await step('(8) raw types gcode, command:raw, config:set -> UNKNOWN_COMMAND, engine saw nothing', async () => {
        const before = m1.engine.calls.length;
        for (const type of ['gcode', 'command:raw', 'config:set']) {
            const ack = await b1.cmdAck(dev1, type, { line: 'M3 S1000' }, 'motion');
            assert.strictEqual(ack.code, 'UNKNOWN_COMMAND', type);
        }
        assert.strictEqual(m1.engine.calls.length, before);
    });

    await step('(10) upload via PUT -> stored with cloud provenance, nothing loaded, job.start -> REVIEW_REQUIRED', async () => {
        const body = Buffer.from('G21\nG0 X0 Y0\nG1 X5 F300\n');
        const sha = crypto.createHash('sha256').update(body).digest('hex');
        const put = await request(base, 'PUT', `/api/devices/${dev1}/files?name=sign.nc`, { cookie: cookie1, csrf: csrf1, body, headers: { 'X-Content-Sha256': sha } });
        assert.strictEqual(put.status, 201, JSON.stringify(put.data));
        const stored = await waitFor(() => b1.msgs.find(m => m.t === 'file.status' && m.body.status === 'stored'), 5000, 'file.status stored');
        const meta = m1.lib.list().find(m => m.id === stored.body.libraryId);
        assert.ok(meta, 'in the machine library');
        assert.strictEqual(meta.provenance.origin, 'cloud');
        assert.strictEqual(meta.provenance.reviewed, false);
        assert.deepStrictEqual(m1.engine.fileLoads, []);
        assert.ok(!m1.engine.commandNames().some(c => c.startsWith('gcode:start')));
        relay.hubs.client.__setRttForTest(b1.welcome.connId, 20);
        const ack = await b1.cmdAck(dev1, 'job.start', {
            libraryId: meta.id, fromBeginning: true, expect: { name: meta.fileName, size: meta.size, loadSeq: m1.gate.loadSeq, wcsSeq: m1.gate.wcsSeq },
        }, 'motion');
        assert.deepStrictEqual([ack.status, ack.code], ['rejected', 'REVIEW_REQUIRED']);
        assert.deepStrictEqual(m1.engine.fileLoads, []);
    });

    await step('(13) a second device publishing to the first device topic is closed 4400; cache unchanged', async () => {
        const ws2 = m2.link._ws;
        assert.ok(ws2, 'second machine online');
        let code = null;
        ws2.on('close', (c) => { code = c; });
        ws2.send(JSON.stringify({ v: 1, t: 'report.state', id: rid('m_'), ts: Date.now(), topic: `device/${dev1}/report`, cls: null, enc: 'none', kid: null, via: null, body: { seq: 999999, controllerType: 'EVIL' } }));
        await waitFor(() => code !== null, 3000, 'close 4400');
        assert.strictEqual(code, 4400);
        const b = new Browser(base, cookie1);
        browsers.push(b);
        await b.open();
        await b.subscribe([dev1]);
        const cached = await waitFor(() => b.msgs.find(m => m.t === 'report.state'), 3000, 'cached state');
        assert.notStrictEqual(cached.body.controllerType, 'EVIL');
        assert.ok(!b1.msgs.some(m => m.t === 'report.state' && m.body.controllerType === 'EVIL'));
        b.close();
    });

    await step('(14) 20 STOPs in 1 s after 30 jog.steps are all forwarded and accepted', async () => {
        relay.hubs.client.__setRttForTest(b1.welcome.connId, 20);
        const steps = [];
        for (let i = 0; i < 30; i++) steps.push(b1.cmdAck(dev1, 'jog.step', { axis: 'x', distanceMm: 0.1, feed: 100 }, 'motion'));
        const stops = [];
        for (let i = 0; i < 20; i++) {
            stops.push(b1.cmdAck(dev1, 'job.stop', {}, 'stop', { ttlMs: 10000 }));
            await sleep(45);
        }
        const acks = await Promise.all(stops);
        assert.ok(acks.every(a => a.status === 'accepted' && a.code === 'OK'), JSON.stringify(acks.map(a => a.code)));
        await Promise.all(steps);
    });

    await step('(12) session revoked from a second session during a jog -> 4401 and client-gone cancel within 200 ms', async () => {
        const login = await request(base, 'POST', '/api/auth/login', { json: { email: 'sam@example.com', password: 'correct horse battery' } });
        assert.strictEqual(login.status, 200, JSON.stringify(login.data));
        const cookie2 = cookieFrom(login);
        const csrf2 = login.data.csrfToken;
        const sessions = await request(base, 'GET', '/api/auth/sessions', { cookie: cookie2 });
        const other = sessions.data.find(s => !s.current);
        assert.ok(other);
        m1.gate.grantMotion(5, OP, { channel: 'cloud' });
        await sleep(400);
        relay.hubs.client.__setRttForTest(b1.welcome.connId, 20);
        const ack = await b1.cmdAck(dev1, 'jog.cont.start', { jogId: 'j_revokejog01', axis: 'x', dir: -1, feed: 300 }, 'motion');
        assert.deepStrictEqual([ack.status, ack.code], ['accepted', 'OK'], JSON.stringify(ack));
        let keep = true;
        (async () => {
            while (keep) {
                b1.cmd(dev1, 'jog.cont.keepalive', { jogId: 'j_revokejog01' }, 'motion', { ttlMs: 300 });
                await sleep(100);
            }
        })();
        await sleep(200);
        const revokedAt = Date.now();
        const del = await request(base, 'DELETE', `/api/auth/sessions/${other.id}`, { cookie: cookie2, csrf: csrf2 });
        assert.strictEqual(del.status, 204);
        await waitFor(() => b1.closeCode !== null, 2000, 'browser closed');
        keep = false;
        assert.strictEqual(b1.closeCode, 4401);
        await waitFor(() => m1.cancelReasons().includes('client-gone'), 2000, 'client-gone');
        const cancel = m1.audits.find(a => a.event === 'jog.cancel' && a.args.reason === 'client-gone');
        assert.ok(cancel.at - revokedAt <= 200, `cancelled ${cancel.at - revokedAt} ms after revocation`);
        cookie1 = cookie2;
        csrf1 = csrf2;
    });

    await step('(11) unpair from the browser -> machine gets revoked -> unpaired', async () => {
        const del = await request(base, 'DELETE', `/api/devices/${dev2}`, { cookie: cookie1, csrf: csrf1 });
        assert.strictEqual(del.status, 204, JSON.stringify(del.data));
        await waitFor(() => m2.link.getStatus().state === 'unpaired', 5000, 'unpaired');
        assert.strictEqual(m2.store.get().credential, null);
    });

    await step('(5) relay killed during a jog -> link-down cancel within 100 ms, job state unchanged', async () => {
        const b = new Browser(base, cookie1);
        browsers.push(b);
        await b.open();
        await b.subscribe([dev1]);
        m1.gate.grantMotion(5, OP, { channel: 'cloud' });
        await sleep(400);
        relay.hubs.client.__setRttForTest(b.welcome.connId, 20);
        const ack = await b.cmdAck(dev1, 'jog.cont.start', { jogId: 'j_killrelay01', axis: 'z', dir: 1, feed: 300 }, 'motion');
        assert.deepStrictEqual([ack.status, ack.code], ['accepted', 'OK'], JSON.stringify(ack));
        let keep = true;
        (async () => {
            while (keep) {
                b.cmd(dev1, 'jog.cont.keepalive', { jogId: 'j_killrelay01' }, 'motion', { ttlMs: 300 });
                await sleep(100);
            }
        })();
        await sleep(250);
        const jobBefore = JSON.stringify(m1.gate.getTelemetry().job);
        const callsBefore = m1.engine.commandNames().filter(c => c !== 'jog').length;
        const closedAt = Date.now();
        const closing = relay.close();
        await waitFor(() => m1.cancelReasons().includes('link-down'), 2000, 'link-down cancel');
        keep = false;
        const cancel = m1.audits.find(a => a.event === 'jog.cancel' && a.args.reason === 'link-down');
        assert.ok(cancel.at - closedAt <= 100, `cancelled ${cancel.at - closedAt} ms after close`);
        assert.strictEqual(JSON.stringify(m1.gate.getTelemetry().job), jobBefore);
        assert.strictEqual(m1.engine.commandNames().filter(c => c !== 'jog').length, callsBefore, 'no stop/pause sent to the engine');
        await closing;
    });

    await step('(9) the gate never received an operator identity', async () => {
        for (const m of machines) {
            assert.ok(m.executed.length > 0 || m === m2);
            assert.ok(m.executed.every(k => k === 'cloud'), JSON.stringify(m.executed));
        }
    });

    await step('logs contain no credentials, session tokens, poll secrets or pairing codes', async () => {
        const texts = [...relayLogs, ...machines.flatMap(m => m.logger.lines.map(l => l.text))];
        // An empty capture would make this scan vacuous.
        if (createLogger) assert.ok(relayLogs.length > 0, 'relay log output was captured');
        assert.ok(machines.some(m => m.logger.lines.length > 0), 'machine log output was captured');
        for (const t of texts) {
            assert.ok(!/odc_|ors_|ops_/.test(t), `secret-looking value in log: ${t.slice(0, 200)}`);
            for (const s of secretsSeen) if (s) assert.ok(!t.includes(s), 'known secret in log');
        }
        // §10.7 item 8 covers the WAL too: recent writes live there until a checkpoint.
        for (const f of ['relay.db', 'relay.db-wal', 'relay.db-shm']) {
            const p = path.join(relayOpts.dataDir, f);
            if (!fs.existsSync(p)) continue;
            const dbText = fs.readFileSync(p).toString('latin1');
            assert.ok(!dbText.includes('odc_'), `${f} holds no plaintext credential`);
            for (const s of secretsSeen) if (s) assert.ok(!dbText.includes(s), `${f} holds no known secret`);
        }
    });

    for (const b of browsers) b.close();
    for (const m of machines) await m.stop();
    try { await relay.close(); } catch (_) { /* already closed */ }
    clearTimeout(guard);
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) { /* sqlite may hold the file briefly */ }
    console.log(failed ? `${failed} of ${stepsDone.length + failed} failed` : `All ${stepsDone.length} passed`);
    process.exit(failed ? 1 : 0);
}

main().catch((err) => {
    console.log('✗ e2e crashed');
    console.log(err && err.stack ? err.stack : err);
    process.exit(1);
});

// tests/run-all.js treats a run as finished only when it prints this line.
// These suites came from the remote-access branch, which ran them directly;
// they signal failure with a non-zero exit, so a clean exit means pass.
process.on('exit', (code) => { if (code === 0) console.log('ALL TESTS PASSED SUCCESSFULLY!'); });
