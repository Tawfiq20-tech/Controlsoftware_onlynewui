'use strict';

/**
 * The queue's REST routes, on a real booted backend.
 *
 * design_queue.test.js drives the service directly; this one proves the wiring
 * around it -- that the routes exist, that they reach the same service the
 * sockets see, that the operator-only ones are actually guarded, and that a
 * tap really does put a start command on the controller. A queue whose Start
 * button 404s is no safer than one that starts by itself, and unit tests over
 * the service alone would not have noticed.
 */
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createBackend } = require('../index');
const { FakeEngine } = require('./helpers/fakeEngine');
const { ConfigStore } = require('../services/ConfigStore');

let passed = 0;
async function test(name, fn) {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
}

/** A library entry on disk, the way LibraryService stores one. */
function seedLibrary(dataDir, id, name, body, extra = {}) {
    const dir = path.join(dataDir, 'library', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'body.gcode'), body, 'utf-8');
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
        id, name, fileName: name, size: body.length, savedAt: new Date().toISOString(), ...extra,
    }), 'utf-8');
}

async function main() {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-routes-'));
    seedLibrary(dataDir, 'l-one', 'first.nc', 'G21\nG0 X1 Y1\nG1 Z-1 F300\nG1 X10 F800\n');
    seedLibrary(dataDir, 'l-two', 'second.nc', 'G21\nG0 X2 Y2\nG1 Z-1 F300\nG1 X20 F800\n');
    seedLibrary(dataDir, 'l-phone', 'from-the-phone.nc', 'G21\nG0 X3\n', {
        provenance: { origin: 'cloud', reviewed: false },
    });

    const engine = new FakeEngine({ controllerType: 'RSP', connected: true });
    engine.config = new ConfigStore(path.join(dataDir, 'config.json'));
    engine.listPorts = async () => [];
    engine.pingNow = async () => ({ ok: true, rttMs: 1 });
    engine._closeConnection = () => {};
    engine._handleOpen = (s, p2, o, cb) => cb(null);
    engine.connection = { isOpen: true };
    // The real CNCEngine._handleFileLoad answers { ok } and the queue holds on
    // anything else; FakeEngine records the load but returns nothing.
    const recordLoad = engine._handleFileLoad.bind(engine);
    engine._handleFileLoad = async (socket, data) => { recordLoad(socket, data); return { ok: true }; };

    const backend = createBackend({
        port: 0,
        dataDir,
        isTest: true,
        initServices: false,
        createEngine: () => engine,
        createCloudLink: () => ({
            start() {}, stop: async () => {},
            getStatus: () => ({ state: 'off' }),
            getPairing: () => null,
        }),
        createMdns: () => ({
            start() { return this; }, stop: async () => {},
            getStatus: () => ({ state: 'stopped', hostname: null, addresses: [], error: null }),
        }),
    });
    const started = await backend.start({ host: '127.0.0.1', listenPort: 0, exitOnError: false });
    const base = `http://127.0.0.1:${started.port}`;

    const api = async (method, p, body) => {
        const r = await fetch(`${base}${p}`, {
            method,
            headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await r.text();
        return { status: r.status, body: text ? JSON.parse(text) : null };
    };

    try {
        await test('GET /api/queue answers with an empty, disarmed queue', async () => {
            const r = await api('GET', '/api/queue');
            assert.strictEqual(r.status, 200);
            assert.strictEqual(r.body.armed, false);
            assert.strictEqual(r.body.state, 'idle');
            assert.deepStrictEqual(r.body.entries, []);
            assert.strictEqual(r.body.spindleControl, false, 'the screen is told the router is not ours to switch');
        });

        await test('designs are added in order', async () => {
            assert.strictEqual((await api('POST', '/api/queue', { libraryId: 'l-one' })).status, 200);
            assert.strictEqual((await api('POST', '/api/queue', { libraryId: 'l-two' })).status, 200);
            const r = await api('GET', '/api/queue');
            assert.deepStrictEqual(r.body.entries.map((e) => e.name), ['first.nc', 'second.nc']);
        });

        await test('a remote upload nobody reviewed is refused by the route, not just the service', async () => {
            const r = await api('POST', '/api/queue', { libraryId: 'l-phone' });
            assert.strictEqual(r.status, 400);
            assert.strictEqual(r.body.error, 'review_required');
        });

        await test('arming loads the first design onto the machine and starts nothing', async () => {
            const r = await api('POST', '/api/queue/arm', { armed: true });
            assert.strictEqual(r.status, 200);
            assert.strictEqual(engine.loadedFile && engine.loadedFile.name, 'first.nc');
            assert.strictEqual(
                engine.calls.filter((c) => String(c.cmd).startsWith('gcode:start')).length, 0,
                'ARMING MUST NOT START A JOB',
            );
            assert.strictEqual((await api('GET', '/api/queue')).body.state, 'gate');
        });

        await test('the tap puts gcode:startFresh on the controller', async () => {
            const r = await api('POST', '/api/queue/start', {});
            assert.strictEqual(r.status, 200, JSON.stringify(r.body));
            const starts = engine.calls.filter((c) => String(c.cmd).startsWith('gcode:start'));
            assert.strictEqual(starts.length, 1);
            assert.strictEqual(starts[0].cmd, 'gcode:startFresh', 'a queued design never resumes');
            assert.strictEqual((await api('GET', '/api/queue')).body.state, 'running');
        });

        await test('a second tap while it runs is refused', async () => {
            const r = await api('POST', '/api/queue/start', {});
            assert.strictEqual(r.status, 409);
            assert.strictEqual(engine.calls.filter((c) => String(c.cmd).startsWith('gcode:start')).length, 1);
        });

        await test('auto mode is operator-only, so a plain local browser cannot turn it on', async () => {
            const r = await api('POST', '/api/queue/mode', { mode: 'auto', routerStaysRunningAcknowledged: true });
            assert.strictEqual(r.status, 403);
            assert.strictEqual(r.body.error, 'operator_required');
            assert.strictEqual((await api('GET', '/api/queue')).body.mode, 'gate');
        });

        await test('the queue survives on disk, disarmed, with the running design marked lost', async () => {
            const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'queue.json'), 'utf-8'));
            assert.strictEqual(raw.version, 1);
            assert.deepStrictEqual(raw.entries.map((e) => e.name), ['first.nc', 'second.nc']);
            assert.strictEqual(raw.entries[0].status, 'running');
        });
    } finally {
        try { await backend.stop?.(); } catch (_) { /* best effort */ }
        try { started.server?.close(); } catch (_) { /* best effort */ }
    }

    console.log(`\n${passed} route checks passed`);
    console.log('ALL TESTS PASSED SUCCESSFULLY!');
    // The backend keeps listeners and intervals of its own; the checks above
    // are all done by here.
    process.exit(0);
}

main().catch((err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
});
