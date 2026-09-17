'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { FakeEngine, silentLogger } = require('./helpers/fakeEngine');
const { FileIngest } = require('../services/cloudLink/FileIngest');
const { RemoteCommandGate, createAtomicJsonStore } = require('../services/cloudLink');
const { HostLoadMonitor } = require('../services/cloudLink/HostLoadMonitor');
const { LibraryService } = require('../services/library/LibraryService');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-files-'));
const CREDENTIAL = 'odc_test-credential-value';
let transferCounter = 0;

function transferId() {
    transferCounter += 1;
    return 'x_' + String(transferCounter).padStart(12, '0');
}

function sha(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
}

function startServer(handler) {
    return new Promise((resolve) => {
        const s = { requests: [], handler };
        s.server = http.createServer((req, res) => {
            s.requests.push({ method: req.method, url: req.url, headers: req.headers });
            s.handler(req, res, s.requests.length);
        });
        s.server.listen(0, '127.0.0.1', () => {
            s.url = `http://127.0.0.1:${s.server.address().port}`;
            s.close = () => new Promise((r) => { s.server.closeAllConnections(); s.server.close(() => r()); });
            resolve(s);
        });
    });
}

function serveBody(body) {
    return (req, res) => {
        const range = req.headers.range && /^bytes=(\d+)-$/.exec(req.headers.range);
        if (range) {
            const start = Number(range[1]);
            res.writeHead(206, { 'Content-Length': body.length - start, 'Content-Range': `bytes ${start}-${body.length - 1}/${body.length}` });
            res.end(body.subarray(start));
            return;
        }
        res.writeHead(200, { 'Content-Length': body.length });
        res.end(body);
    };
}

function makeHarness(server, { tier = 'job', statfs = null, store = null, library = null, retryDelaysMs = [10, 10, 10, 10, 10] } = {}) {
    const dir = fs.mkdtempSync(path.join(tmpRoot, 'h-'));
    const s = store || createAtomicJsonStore(path.join(dir, 'cloud-link.json'), {});
    const engine = new FakeEngine({ controllerType: 'Grbl' });
    const gate = new RemoteCommandGate({
        store: s,
        logger: silentLogger(),
        getEngine: () => engine,
        auditFile: path.join(dir, 'remote-audit.jsonl'),
        hostLoadMonitor: new HostLoadMonitor(),
    });
    gate.attachEngine(engine);
    engine.setStatus({ activeState: 'Idle' });
    if (tier !== 'monitor') gate.setJobControl('cloud', true, { kind: 'operator' });
    const emitted = [];
    const lib = library || new LibraryService({ dataDir: dir, io: { emit: (ev, m) => emitted.push([ev, m]) }, logger: silentLogger() });
    const realUpsert = lib.upsert.bind(lib);
    const spy = { upsert: 0, upsertFromFile: [] };
    lib.upsert = () => { spy.upsert += 1; throw new Error('upsert with a body must not be used for cloud files'); };
    if (lib.upsertFromFile) {
        const real = lib.upsertFromFile.bind(lib);
        lib.upsertFromFile = (args) => { spy.upsertFromFile.push(JSON.parse(JSON.stringify(args))); return real(args); };
    }
    const results = [];
    const h = { dir, store: s, engine, gate, lib, spy, results, emitted, realUpsert, lanOnly: false };
    h.ingest = new FileIngest({
        dataDir: dir,
        store: s,
        logger: silentLogger(),
        gate,
        libraryService: lib,
        getRelayUrl: () => server.url,
        getCredential: () => CREDENTIAL,
        isLanOnly: () => h.lanOnly,
        sendResult: (b) => { results.push(b); return true; },
        statfs: statfs || (() => ({ bavail: 1e9, bsize: 4096 })),
        retryDelaysMs,
    });
    h.ingest.init();
    h.inbox = path.join(dir, 'cloud-inbox');
    h.dispose = () => gate.dispose();
    return h;
}

function offerFor(body, over = {}) {
    return {
        transferId: transferId(),
        name: 'sign_v2.nc',
        size: body.length,
        sha256: sha(body),
        uploadedBy: { userId: 'u_aaaaaaaaaaaa', userLabel: 'Sam' },
        createdAt: 1789500004000,
        ...over,
    };
}

const BODY = Buffer.from('G21\nG0 X0 Y0\nG1 X10 F500\n'.repeat(4000));

test('stored path: streamed to disk, upsertFromFile once with provenance, never upsert/load/start', async () => {
    const server = await startServer(serveBody(BODY));
    const h = makeHarness(server);
    const offer = offerFor(BODY);
    await h.ingest.handleOffer(offer);
    assert.strictEqual(h.results.length, 1);
    const r = h.results[0];
    assert.deepStrictEqual({ ...r, libraryId: typeof r.libraryId }, {
        transferId: offer.transferId, status: 'stored', libraryId: 'string', sha256: offer.sha256, code: 'OK', message: null,
    });
    assert.strictEqual(server.requests.length, 1);
    assert.strictEqual(server.requests[0].url, `/api/device/files/${offer.transferId}`);
    assert.strictEqual(server.requests[0].headers.authorization, `Bearer ${CREDENTIAL}`);
    assert.strictEqual(h.spy.upsert, 0);
    assert.strictEqual(h.spy.upsertFromFile.length, 1);
    const call = h.spy.upsertFromFile[0];
    assert.strictEqual(call.name, 'sign_v2');
    assert.strictEqual(call.fileName, 'sign_v2.nc');
    assert.deepStrictEqual({ ...call.provenance, receivedAt: typeof call.provenance.receivedAt }, {
        origin: 'cloud', uploadedBy: 'Sam', uploadedByUserId: 'u_aaaaaaaaaaaa', transferId: offer.transferId,
        sha256: offer.sha256, receivedAt: 'number', reviewed: false,
    });
    const meta = h.lib.list().find(m => m.id === r.libraryId);
    assert.strictEqual(meta.size, BODY.length);
    assert.strictEqual(meta.provenance.origin, 'cloud');
    assert.strictEqual(h.lib.getBody(r.libraryId), BODY.toString());
    assert.strictEqual(h.lib.cloudUsageBytes(), BODY.length);
    assert.ok(h.emitted.some(([ev]) => ev === 'library:added'));
    assert.deepStrictEqual(fs.readdirSync(h.inbox).filter(n => n.endsWith('.part') || n.endsWith('.ready')), []);
    assert.deepStrictEqual(h.engine.calls, []);
    assert.deepStrictEqual(h.engine.fileLoads, []);
    const reviewed = h.lib.markReviewed(r.libraryId);
    assert.strictEqual(reviewed.provenance.reviewed, true);

    // idempotency: a re-offer answers at once with the same libraryId, no download
    await h.ingest.handleOffer(offer);
    assert.strictEqual(server.requests.length, 1);
    assert.deepStrictEqual([h.results[1].status, h.results[1].libraryId], ['stored', r.libraryId]);
    h.dispose();
    await server.close();
});

test('hash mismatch, bad extension, machine caps, low disk and oversize stream', async () => {
    const server = await startServer(serveBody(BODY));
    let h = makeHarness(server);
    await h.ingest.handleOffer(offerFor(BODY, { sha256: sha(Buffer.from('other')) }));
    assert.deepStrictEqual([h.results[0].status, h.results[0].code], ['rejected', 'HASH_MISMATCH']);
    await h.ingest.handleOffer(offerFor(BODY, { name: 'evil.exe' }));
    assert.deepStrictEqual([h.results[1].status, h.results[1].code], ['rejected', 'BAD_TYPE']);
    h.store.update((d) => { d.maxFileMb = 1; });
    await h.ingest.handleOffer(offerFor(BODY, { size: 2 * 1024 * 1024 }));
    assert.deepStrictEqual([h.results[2].status, h.results[2].code], ['rejected', 'TOO_LARGE']);
    h.store.update((d) => { d.maxFileMb = 25; d.cloudLibraryCapMb = 50; });
    h.lib.cloudUsageBytes = () => 50 * 1024 * 1024 - 10;
    await h.ingest.handleOffer(offerFor(BODY));
    assert.deepStrictEqual([h.results[3].code, h.results[3].message], ['TOO_LARGE', 'cloud library full']);
    const requestsSoFar = server.requests.length;
    assert.strictEqual(requestsSoFar, 1, 'only the hash-mismatch offer downloaded');
    h.dispose();

    h = makeHarness(server, { statfs: () => ({ bavail: 100, bsize: 1024 * 1024 }) });
    await h.ingest.handleOffer(offerFor(BODY));
    assert.deepStrictEqual([h.results[0].status, h.results[0].code], ['rejected', 'NO_SPACE']);
    h.dispose();

    h = makeHarness(server);
    const small = BODY.subarray(0, 1000);
    await h.ingest.handleOffer(offerFor(small, { sha256: sha(BODY) }));
    assert.deepStrictEqual([h.results[0].status, h.results[0].code], ['rejected', 'TOO_LARGE'], 'stream aborted past offer.size');
    assert.deepStrictEqual(fs.readdirSync(h.inbox).filter(n => n.endsWith('.part')), []);
    h.dispose();
    await server.close();
});

test('non-UTF-8 detected incrementally (invalid byte in the last chunk)', async () => {
    const good = Buffer.from('G0 X1\n'.repeat(20000));
    const bad = Buffer.concat([good, Buffer.from([0x47, 0xff, 0x0a])]);
    const server = await startServer((req, res) => {
        res.writeHead(200, { 'Content-Length': bad.length });
        res.write(good);
        setTimeout(() => res.end(bad.subarray(good.length)), 30);
    });
    const h = makeHarness(server);
    await h.ingest.handleOffer(offerFor(bad));
    assert.deepStrictEqual([h.results[0].status, h.results[0].code], ['rejected', 'NOT_UTF8']);
    assert.strictEqual(h.spy.upsertFromFile.length, 0);
    h.dispose();
    await server.close();
});

test('deferrals: tier monitor, job active, jog active, LAN-only', async () => {
    const server = await startServer(serveBody(BODY));
    let h = makeHarness(server, { tier: 'monitor' });
    await h.ingest.handleOffer(offerFor(BODY));
    assert.deepStrictEqual([h.results[0].status, h.results[0].code], ['deferred', 'TIER_REQUIRED']);
    h.dispose();

    h = makeHarness(server);
    h.engine.startJob();
    await h.ingest.handleOffer(offerFor(BODY));
    assert.deepStrictEqual([h.results[0].status, h.results[0].code], ['deferred', 'BUSY']);
    h.engine.endJob();
    h.gate.grantMotion(5, { kind: 'operator' }, { channel: 'cloud' });
    h.gate.deadman.lease = { jogId: 'j_x', identity: {} };
    await h.ingest.handleOffer(offerFor(BODY));
    assert.deepStrictEqual([h.results[1].status, h.results[1].code], ['deferred', 'BUSY']);
    h.gate.deadman.lease = null;
    h.lanOnly = true;
    await h.ingest.handleOffer(offerFor(BODY));
    assert.deepStrictEqual([h.results[2].status, h.results[2].code], ['deferred', 'LAN_ONLY']);
    assert.strictEqual(server.requests.length, 0);
    h.dispose();
    await server.close();
});

test('a job that starts during the download holds the reply until idle, then stores', async () => {
    let h;
    const server = await startServer((req, res) => {
        res.writeHead(200, { 'Content-Length': BODY.length });
        res.write(BODY.subarray(0, 1000));
        h.engine.startJob();
        setTimeout(() => res.end(BODY.subarray(1000)), 30);
    });
    h = makeHarness(server);
    const offer = offerFor(BODY);
    await h.ingest.handleOffer(offer);
    assert.strictEqual(h.results.length, 0, 'no reply while busy');
    assert.ok(fs.existsSync(path.join(h.inbox, `${offer.transferId}.ready`)));
    assert.ok(h.ingest.hasPendingReady());
    h.engine.endJob();
    h.ingest.retryReady();
    for (let i = 0; i < 50 && !h.results.length; i++) await new Promise(r => setTimeout(r, 10));
    assert.deepStrictEqual([h.results[0].status, h.results[0].code], ['stored', 'OK']);
    assert.ok(!fs.existsSync(path.join(h.inbox, `${offer.transferId}.ready`)));
    h.dispose();
    await server.close();
});

test('URL safety: offer paths and ids never steer the request; redirects are not followed', async () => {
    const attacker = await startServer(serveBody(BODY));
    const relay = await startServer(serveBody(BODY));
    let h = makeHarness(relay);
    for (const downloadPath of ['@attacker.example/x', '.attacker.example/x', `//127.0.0.1:${attacker.server.address().port}/x`]) {
        await h.ingest.handleOffer({ ...offerFor(BODY), downloadPath, url: attacker.url });
    }
    assert.ok(relay.requests.every(r => /^\/api\/device\/files\/x_[a-z0-9]{12}$/.test(r.url)));
    await h.ingest.handleOffer({ ...offerFor(BODY), transferId: 'x_../../x' });
    assert.deepStrictEqual([h.results[h.results.length - 1].status, h.results[h.results.length - 1].code], ['rejected', 'INTERNAL']);
    await h.ingest.handleOffer({ ...offerFor(BODY), transferId: 'x_../../../api' });
    assert.strictEqual(relay.requests.length, 3);
    h.dispose();

    relay.handler = (req, res) => {
        res.writeHead(302, { Location: `${attacker.url}/steal` });
        res.end();
    };
    h = makeHarness(relay);
    await h.ingest.handleOffer(offerFor(BODY));
    assert.deepStrictEqual([h.results[0].status, h.results[0].code], ['deferred', 'DOWNLOAD_FAILED']);
    assert.strictEqual(attacker.requests.length, 0, 'attacker server never contacted');
    h.dispose();
    await relay.close();
    await attacker.close();
});

test('resume: dropped connection -> next request uses Range and the final hash matches', async () => {
    const server = await startServer((req, res, n) => {
        if (n === 1) {
            res.writeHead(200, { 'Content-Length': BODY.length });
            res.write(BODY.subarray(0, 40000));
            setTimeout(() => res.socket.destroy(), 30);
            return;
        }
        serveBody(BODY)(req, res);
    });
    const h = makeHarness(server);
    await h.ingest.handleOffer(offerFor(BODY));
    assert.strictEqual(server.requests.length, 2);
    const range = server.requests[1].headers.range;
    assert.ok(/^bytes=\d+-$/.test(range), `range header ${range}`);
    assert.ok(Number(/\d+/.exec(range)[0]) > 0);
    assert.deepStrictEqual([h.results[0].status, h.results[0].code], ['stored', 'OK']);
    assert.strictEqual(h.lib.getBody(h.results[0].libraryId), BODY.toString());
    h.dispose();
    await server.close();
});

test('5 failed retries -> deferred DOWNLOAD_FAILED and the .part is removed', async () => {
    const server = await startServer((req, res) => { res.writeHead(503); res.end(); });
    const h = makeHarness(server);
    await h.ingest.handleOffer(offerFor(BODY));
    assert.strictEqual(server.requests.length, 6, 'first attempt plus 5 retries');
    assert.deepStrictEqual([h.results[0].status, h.results[0].code], ['deferred', 'DOWNLOAD_FAILED']);
    assert.deepStrictEqual(fs.readdirSync(h.inbox).filter(n => n.endsWith('.part')), []);
    h.dispose();
    await server.close();
});

test('abortAll during a retry backoff settles handleOffer without replying', async () => {
    const server = await startServer((req, res) => { res.writeHead(503); res.end(); });
    const h = makeHarness(server, { retryDelaysMs: [60000, 60000, 60000, 60000, 60000] });
    let settled = false;
    const pending = h.ingest.handleOffer(offerFor(BODY)).then(() => { settled = true; });
    for (let i = 0; i < 100 && server.requests.length < 1; i++) await new Promise(r => setTimeout(r, 10));
    await new Promise(r => setTimeout(r, 30));
    assert.strictEqual(server.requests.length, 1, 'first attempt failed, now sleeping in backoff');
    assert.strictEqual(settled, false);
    h.ingest.abortAll('lan_only');
    await Promise.race([pending, new Promise(r => setTimeout(r, 500))]);
    assert.strictEqual(settled, true, 'handleOffer settled after abortAll');
    assert.strictEqual(server.requests.length, 1, 'no retry after abort');
    assert.strictEqual(h.results.length, 0, 'abort sends nothing');
    h.dispose();
    await server.close();
});

test('name collision gets " (cloud 2)"; abortAll deletes .part; stale .part cleaned at boot', async () => {
    const server = await startServer(serveBody(BODY));
    let h = makeHarness(server);
    h.realUpsert({ name: 'sign_v2', fileName: 'sign_v2.nc', body: 'G0' });
    await h.ingest.handleOffer(offerFor(BODY));
    const meta = h.lib.list().find(m => m.id === h.results[0].libraryId);
    assert.strictEqual(meta.name, 'sign_v2 (cloud 2)');
    assert.strictEqual(h.lib.list().find(m => m.name === 'sign_v2').provenance, null);
    h.dispose();

    let partSeen = null;
    server.handler = (req, res) => {
        res.writeHead(200, { 'Content-Length': BODY.length });
        res.write(BODY.subarray(0, 5000));
        // never finishes
    };
    h = makeHarness(server);
    const offer = offerFor(BODY);
    const pending = h.ingest.handleOffer(offer);
    for (let i = 0; i < 100 && !partSeen; i++) {
        await new Promise(r => setTimeout(r, 10));
        const p = path.join(h.inbox, `${offer.transferId}.part`);
        if (fs.existsSync(p) && fs.statSync(p).size > 0) partSeen = p;
    }
    assert.ok(partSeen, '.part written while downloading');
    h.ingest.abortAll('lan_only');
    await pending;
    await new Promise(r => setTimeout(r, 20));
    assert.ok(!fs.existsSync(partSeen), '.part deleted');
    assert.strictEqual(h.results.length, 0, 'abort sends nothing');
    h.dispose();

    const stale = path.join(h.inbox, 'x_stalepart0001.part');
    fs.writeFileSync(stale, 'junk');
    const again = new FileIngest({
        dataDir: h.dir, store: h.store, logger: silentLogger(), gate: h.gate, libraryService: h.lib,
        getRelayUrl: () => server.url, getCredential: () => CREDENTIAL,
    });
    again.init();
    assert.ok(!fs.existsSync(stale));
    await server.close();
});

test('atomic store: a locked cloud-link.json is not "corrupt" and is never overwritten with defaults', () => {
    const dir = fs.mkdtempSync(path.join(tmpRoot, 'store-'));
    const file = path.join(dir, 'cloud-link.json');
    const real = { version: 1, enabled: true, credential: 'SECRETCRED', relayUrl: 'https://relay.example', tiers: { jobControl: { lan: false, cloud: false } } };
    fs.writeFileSync(file, JSON.stringify(real));
    const defaults = { version: 1, enabled: false, credential: null, tiers: { jobControl: { lan: false, cloud: false } } };
    const origRead = fs.readFileSync;
    const origRename = fs.renameSync;
    let locked = true;
    const errors = [];
    fs.readFileSync = function (p, ...rest) {
        if (locked && path.resolve(String(p)) === path.resolve(file)) {
            const e = new Error('EBUSY: resource busy or locked');
            e.code = 'EBUSY';
            throw e;
        }
        return origRead.call(fs, p, ...rest);
    };
    try {
        const store = createAtomicJsonStore(file, { defaults, logger: { error: m => errors.push(m), warn() {}, info() {} } });
        assert.strictEqual(store.isReadOnly(), true);
        assert.ok(!errors.some(m => /corrupt/.test(m)), errors.join('|'));
        assert.strictEqual(store.get().enabled, false, 'cloud link stays off while unreadable');
        assert.throws(() => store.update((d) => { d.tiers.jobControl.cloud = true; }), /store_unreadable/);
        assert.deepStrictEqual(JSON.parse(origRead.call(fs, file, 'utf-8')), real, 'file untouched');
        assert.deepStrictEqual(fs.readdirSync(dir).filter(n => n.includes('corrupt')), []);
        // Lock clears: the next write adopts the real content first.
        locked = false;
        store.update((d) => { d.tiers.jobControl.cloud = true; });
        const after = JSON.parse(origRead.call(fs, file, 'utf-8'));
        assert.strictEqual(after.credential, 'SECRETCRED');
        assert.strictEqual(after.relayUrl, 'https://relay.example');
        assert.strictEqual(after.tiers.jobControl.cloud, true);
        assert.strictEqual(store.isReadOnly(), false);

        // A transient rename failure (AV scanning the fresh .tmp) is retried.
        let renameFailures = 2;
        fs.renameSync = function (from, to) {
            if (renameFailures > 0 && String(from).endsWith('.tmp')) {
                renameFailures -= 1;
                const e = new Error('EPERM: operation not permitted, rename');
                e.code = 'EPERM';
                throw e;
            }
            return origRename.call(fs, from, to);
        };
        store.update((d) => { d.enabled = false; });
        assert.strictEqual(renameFailures, 0);
        assert.strictEqual(JSON.parse(origRead.call(fs, file, 'utf-8')).enabled, false);

        // Real corruption still falls back to .bak.
        fs.renameSync = origRename;
        fs.writeFileSync(file, '{ torn');
        const again = createAtomicJsonStore(file, { defaults, logger: { error: m => errors.push(m), warn() {}, info() {} } });
        assert.strictEqual(again.isReadOnly(), false);
        assert.strictEqual(again.get().credential, 'SECRETCRED', 'restored from .bak');
        assert.ok(errors.some(m => /corrupt/.test(m)));
    } finally {
        fs.readFileSync = origRead;
        fs.renameSync = origRename;
    }
});

test('atomic store: a persistently locked file never sleeps the event loop in get() or update()', () => {
    const dir = fs.mkdtempSync(path.join(tmpRoot, 'store-stall-'));
    const file = path.join(dir, 'cloud-link.json');
    fs.writeFileSync(file, JSON.stringify({ version: 1, enabled: true }));
    const defaults = { version: 1, enabled: false };
    const origRead = fs.readFileSync;
    const origNow = Date.now;
    let reads = 0;
    fs.readFileSync = function (p, ...rest) {
        if (path.resolve(String(p)) === path.resolve(file)) {
            reads += 1;
            const e = new Error('EPERM: operation not permitted');
            e.code = 'EPERM';
            throw e;
        }
        return origRead.call(fs, p, ...rest);
    };
    let skew = 0;
    Date.now = () => origNow() + skew;
    try {
        const store = createAtomicJsonStore(file, { defaults });   // boot load may retry
        assert.strictEqual(store.isReadOnly(), true);
        // Past the recheck throttle: the lazy re-check in get() is one read, no sleep.
        skew += 6000;
        reads = 0;
        let t0 = process.hrtime.bigint();
        assert.strictEqual(store.get().enabled, false);
        let ms = Number(process.hrtime.bigint() - t0) / 1e6;
        assert.strictEqual(reads, 1, 'get() re-check is a single read');
        assert.ok(ms < 40, `get() blocked ${ms.toFixed(1)} ms`);
        reads = 0;
        store.get();
        assert.strictEqual(reads, 0, 'throttled within 5 s');
        // update() re-checks immediately but also without retries.
        reads = 0;
        t0 = process.hrtime.bigint();
        assert.throws(() => store.update((d) => { d.enabled = true; }), /store_unreadable/);
        ms = Number(process.hrtime.bigint() - t0) / 1e6;
        assert.strictEqual(reads, 1, 'update() re-check is a single read');
        assert.ok(ms < 40, `update() blocked ${ms.toFixed(1)} ms`);
    } finally {
        fs.readFileSync = origRead;
        Date.now = origNow;
    }
});

async function main() {
    console.log('=== CloudLink Files Tests ===');
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
