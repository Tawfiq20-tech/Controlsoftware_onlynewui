'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
    runTests, startRelay, stopRelay, request, rawHttp, userWithSession, sleep, waitUntil, tmpDir,
} = require('./helpers/harness');
const { createFakeClock } = require('./helpers/fakeClock');
const { pairDevice, connectDevice, connectClient, deviceReport } = require('./helpers/peers');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

function upload(relay, session, deviceId, name, body, headers = {}) {
    return request(relay, 'PUT', `/api/devices/${deviceId}/files?name=${encodeURIComponent(name)}`, { session, body, headers });
}

async function setup(opts = {}) {
    const relay = await startRelay(opts);
    const owner = await userWithSession(relay);
    const dev = await pairDevice(relay, owner);
    return { relay, owner, dev, id: dev.deviceId };
}

function blobPath(relay, transferId) {
    return path.join(relay.dataDir, 'blobs', transferId);
}

function tmpParts(relay) {
    return fs.readdirSync(path.join(relay.dataDir, 'blobs', 'tmp'));
}

// Starts a PUT whose body is sent later, so a test can act while the upload is streaming.
function startUpload(relay, session, deviceId, name, length) {
    const net = require('net');
    const u = new URL(relay.url);
    const sock = net.connect(Number(u.port), u.hostname);
    let data = '';
    const response = new Promise((resolve) => {
        sock.on('data', (d) => { data += d.toString(); });
        sock.on('error', () => {});
        sock.on('close', () => {
            const m = /^HTTP\/1\.1 (\d{3})/.exec(data);
            const idx = data.indexOf('\r\n\r\n');
            let json = null;
            try { json = JSON.parse(data.slice(idx + 4)); } catch (_) { /* no body */ }
            resolve({ status: m ? Number(m[1]) : null, json });
        });
    });
    sock.write([
        `PUT /api/devices/${deviceId}/files?name=${encodeURIComponent(name)} HTTP/1.1`, 'Host: x', `Cookie: ${session.cookie}`,
        `X-CSRF-Token: ${session.csrfToken}`, `Content-Length: ${length}`, 'Connection: close', '', '',
    ].join('\r\n'));
    return { write: (b) => sock.write(b), destroy: () => sock.destroy(), response };
}

runTests('Relay Files', [
    ['server timeouts: requestTimeout 0, keepAliveTimeout 65 s, headersTimeout 66 s', async () => {
        const { relay } = await setup();
        try {
            assert.strictEqual(relay.server.requestTimeout, 0);
            assert.strictEqual(relay.server.keepAliveTimeout, 65000);
            assert.strictEqual(relay.server.headersTimeout, 66000);
        } finally {
            await stopRelay(relay);
        }
    }],
    ['streaming upload: sha256 computed, header match accepted, mismatch -> 400 and blob removed', async () => {
        const { relay, owner, id } = await setup();
        try {
            const body = Buffer.from('G21\nG0 X10 Y10\n'.repeat(5000));
            const r = await upload(relay, owner, id, 'dir/../sign_v2.NC', body, { 'X-Content-Sha256': sha(body).toUpperCase() });
            assert.strictEqual(r.status, 201, r.text);
            const t = r.json.transfer;
            assert.ok(/^x_[a-z0-9]{12}$/.test(t.transferId));
            assert.strictEqual(t.name, 'sign_v2.NC');
            assert.strictEqual(t.size, body.length);
            assert.strictEqual(t.sha256, sha(body));
            assert.strictEqual(t.status, 'pending');
            assert.deepStrictEqual(t.uploadedBy.userId, owner.userId);
            assert.ok(fs.readFileSync(blobPath(relay, t.transferId)).equals(body));
            assert.deepStrictEqual(tmpParts(relay), []);

            const bad = await upload(relay, owner, id, 'x.nc', body, { 'X-Content-Sha256': 'a'.repeat(64) });
            assert.deepStrictEqual([bad.status, bad.json.error], [400, 'hash_mismatch']);
            assert.strictEqual(fs.readdirSync(path.join(relay.dataDir, 'blobs')).filter((f) => f.startsWith('x_')).length, 1);
            assert.strictEqual(relay.db.get('SELECT COUNT(*) AS n FROM transfers').n, 1);
        } finally {
            await stopRelay(relay);
        }
    }],
    ['extension check, size cap 413, missing length 411', async () => {
        const { relay, owner, id } = await setup({ limits: { maxUploadMb: 1 } });
        try {
            for (const name of ['a.exe', 'noext', 'a.nc.js']) {
                const r = await upload(relay, owner, id, name, 'G0\n');
                assert.deepStrictEqual([r.status, r.json.error], [400, 'bad_type'], name);
            }
            for (const ext of ['.nc', '.gcode', '.ngc', '.tap', '.txt', '.cnc']) {
                assert.strictEqual((await upload(relay, owner, id, 'ok' + ext, 'G0\n')).status, 201, ext);
            }
            const big = await rawHttp(relay, `PUT /api/devices/${id}/files?name=big.nc HTTP/1.1\nHost: x\nCookie: ${owner.cookie}\nX-CSRF-Token: ${owner.csrfToken}\nContent-Length: ${2 * 1024 * 1024}`, 'G0');
            assert.strictEqual(big.status, 413);
            const nolen = await rawHttp(relay, `PUT /api/devices/${id}/files?name=a.nc HTTP/1.1\nHost: x\nCookie: ${owner.cookie}\nX-CSRF-Token: ${owner.csrfToken}\nTransfer-Encoding: chunked`, '3\r\nG0\n\r\n0\r\n\r\n');
            assert.strictEqual(nolen.status, 411);
        } finally {
            await stopRelay(relay);
        }
    }],
    ['per-account quota -> 413 quota; total storage cap and min free disk -> 507', async () => {
        const { relay, owner, id } = await setup({ limits: { userQuotaMb: 1 } });
        try {
            const chunk = Buffer.alloc(600 * 1024, 0x47);
            assert.strictEqual((await upload(relay, owner, id, 'a.nc', chunk)).status, 201);
            const q = await upload(relay, owner, id, 'b.nc', chunk);
            assert.deepStrictEqual([q.status, q.json.error], [413, 'quota']);
        } finally {
            await stopRelay(relay);
        }
        const second = await setup({ limits: { totalStorageMb: 1, maxUploadMb: 1 } });
        try {
            const chunk = Buffer.alloc(600 * 1024, 0x47);
            assert.strictEqual((await upload(second.relay, second.owner, second.id, 'a.nc', chunk)).status, 201);
            const r = await upload(second.relay, second.owner, second.id, 'b.nc', chunk);
            assert.deepStrictEqual([r.status, r.json.error], [507, 'insufficient_storage']);
        } finally {
            await stopRelay(second.relay);
        }
        let free = 1500 * 1024 * 1024;
        const third = await setup({ statfs: () => ({ bavail: free / 4096, bsize: 4096 }) });
        try {
            const chunk = Buffer.alloc(100 * 1024, 0x47);
            assert.strictEqual((await upload(third.relay, third.owner, third.id, 'a.nc', chunk)).status, 201);
            free = 1024 * 1024 * 1024 + 50 * 1024;
            const r = await upload(third.relay, third.owner, third.id, 'b.nc', chunk);
            assert.deepStrictEqual([r.status, r.json.error], [507, 'insufficient_storage']);
            free = 1000 * 1024 * 1024;
            await third.relay.__test.runSweeps(['minute']);
            const p = await request(third.relay, 'POST', '/api/device/pairing', {
                json: { hardwareId: 'aabbccddeeff', name: 'M', appVersion: '1', controllerType: 'RSP', credentialHash: 'c'.repeat(64) },
            });
            assert.strictEqual(p.status, 503, 'low disk refuses new pairings');
        } finally {
            await stopRelay(third.relay);
        }
    }],
    ['in-flight uploads count toward quota and storage checks until they finish', async () => {
        const { relay, owner, id } = await setup({ limits: { userQuotaMb: 1 } });
        try {
            const size = 600 * 1024;
            const first = startUpload(relay, owner, id, 'first.nc', size);
            first.write(Buffer.alloc(1024, 0x47));
            await waitUntil(() => tmpParts(relay).length === 1, 2000, 'first upload streaming');
            const q = await upload(relay, owner, id, 'second.nc', Buffer.alloc(size, 0x47));
            assert.deepStrictEqual([q.status, q.json.error], [413, 'quota'], 'parallel upload cannot overshoot the quota');
            first.write(Buffer.alloc(size - 1024, 0x47));
            assert.strictEqual((await first.response).status, 201);
            assert.strictEqual((await upload(relay, owner, id, 'small.nc', Buffer.alloc(100 * 1024, 0x47))).status, 201, 'reservation released');
        } finally {
            await stopRelay(relay);
        }
        const second = await setup({ limits: { totalStorageMb: 1, maxUploadMb: 1 } });
        try {
            const size = 600 * 1024;
            const a = startUpload(second.relay, second.owner, second.id, 'a.nc', size);
            a.write(Buffer.alloc(10, 0x47));
            await waitUntil(() => tmpParts(second.relay).length === 1, 2000, 'upload streaming');
            const r = await upload(second.relay, second.owner, second.id, 'b.nc', Buffer.alloc(size, 0x47));
            assert.deepStrictEqual([r.status, r.json.error], [507, 'insufficient_storage'], 'in-flight bytes count toward the total cap');
            a.destroy();
            await waitUntil(() => tmpParts(second.relay).length === 0, 2000, 'aborted upload discarded');
            await sleep(50);
            assert.strictEqual((await upload(second.relay, second.owner, second.id, 'b.nc', Buffer.alloc(size, 0x47))).status, 201, 'aborted upload released its reservation');
        } finally {
            await stopRelay(second.relay);
        }
    }],
    ['early rejection while the client still streams a large body: JSON error arrives, no reset, nothing stored', async () => {
        const big = Buffer.alloc(6 * 1024 * 1024, 0x47);
        const cases = [
            [{ userQuotaMb: 1, maxUploadMb: 8 }, [413, 'quota']],
            [{ maxUploadMb: 1 }, [413, 'too_large']],
            [{ totalStorageMb: 1, maxUploadMb: 8 }, [507, 'insufficient_storage']],
        ];
        for (const [limits, expected] of cases) {
            const { relay, owner, id } = await setup({ limits });
            try {
                for (let i = 0; i < 5; i++) {
                    const r = await upload(relay, owner, id, 'big.nc', big);
                    assert.deepStrictEqual([r.status, r.json && r.json.error], expected, `${expected[1]} #${i}`);
                    assert.strictEqual(r.headers.connection, 'close');
                }
                assert.deepStrictEqual(tmpParts(relay), []);
                assert.strictEqual(relay.db.get('SELECT COUNT(*) AS n FROM transfers').n, 0);
                assert.strictEqual((await upload(relay, owner, id, 'small.nc', Buffer.alloc(100 * 1024, 0x47))).status, 201, 'nothing reserved or counted');
            } finally {
                await stopRelay(relay);
            }
        }
    }],
    ['early rejection: a client that stalls its body is disconnected after a bounded drain', async () => {
        const { relay, owner, id } = await setup({ limits: { userQuotaMb: 1, transferIdleMs: 300 } });
        try {
            const started = Date.now();
            const up = startUpload(relay, owner, id, 'stall.nc', 5 * 1024 * 1024);
            up.write(Buffer.alloc(1024, 0x47));
            const r = await up.response;
            assert.deepStrictEqual([r.status, r.json && r.json.error], [413, 'quota']);
            assert.ok(Date.now() - started < 3000, 'socket closed by the drain timeout');
            assert.deepStrictEqual(tmpParts(relay), []);
        } finally {
            await stopRelay(relay);
        }
    }],
    ['device unpaired while an upload streams: 404 and no orphan blob left on disk', async () => {
        const { relay, owner, id } = await setup();
        try {
            const up = startUpload(relay, owner, id, 'late.nc', 2000);
            up.write(Buffer.alloc(1000, 0x47));
            await waitUntil(() => tmpParts(relay).length === 1, 2000, 'upload streaming');
            assert.strictEqual((await request(relay, 'DELETE', `/api/devices/${id}`, { session: owner })).status, 204);
            up.write(Buffer.alloc(1000, 0x47));
            const r = await up.response;
            assert.strictEqual(r.status, 404);
            assert.deepStrictEqual(fs.readdirSync(path.join(relay.dataDir, 'blobs')).filter((x) => x.startsWith('x_')), []);
            assert.deepStrictEqual(tmpParts(relay), []);
            assert.strictEqual(relay.db.get('SELECT COUNT(*) AS n FROM transfers').n, 0);
        } finally {
            await stopRelay(relay);
        }
        // The unpair lands between the blob commit and the row insert: the insert's foreign
        // key fails and the committed blob must still be removed.
        const late = await setup();
        try {
            const up = startUpload(late.relay, late.owner, late.id, 'late.nc', 2000);
            up.write(Buffer.alloc(1000, 0x47));
            await waitUntil(() => tmpParts(late.relay).length === 1, 2000, 'upload streaming');
            assert.strictEqual((await request(late.relay, 'DELETE', `/api/devices/${late.id}`, { session: late.owner })).status, 204);
            late.relay.app.acl.role = () => 'owner';
            up.write(Buffer.alloc(1000, 0x47));
            const r = await up.response;
            assert.strictEqual(r.status, 404);
            assert.deepStrictEqual(fs.readdirSync(path.join(late.relay.dataDir, 'blobs')).filter((x) => x.startsWith('x_')), []);
            assert.deepStrictEqual(tmpParts(late.relay), []);
        } finally {
            await stopRelay(late.relay);
        }
    }],
    ['upload idle timeout: stalled body -> 408 and the .part is removed', async () => {
        const { relay, owner, id } = await setup({ limits: { transferIdleMs: 300 } });
        try {
            const r = await rawHttp(relay, `PUT /api/devices/${id}/files?name=slow.nc HTTP/1.1\nHost: x\nCookie: ${owner.cookie}\nX-CSRF-Token: ${owner.csrfToken}\nContent-Length: 1000`, 'G0 X1\n');
            assert.strictEqual(r.status, 408);
            await waitUntil(() => tmpParts(relay).length === 0, 1000, '.part removed');
            assert.strictEqual(relay.db.get('SELECT COUNT(*) AS n FROM transfers').n, 0);
        } finally {
            await stopRelay(relay);
        }
    }],
    ['file.offer on upload and on reconnect, at most 2 outstanding, no downloadPath; results update and broadcast', async () => {
        const { relay, owner, id, dev } = await setup();
        try {
            const { peer: client } = await connectClient(relay, owner);
            await client.subscribe([id]);
            let { peer: device } = await connectDevice(relay, dev.credential);
            const bodies = ['G0 X1\n', 'G0 X2\n', 'G0 X3\n'];
            const ids = [];
            for (let i = 0; i < 3; i++) ids.push((await upload(relay, owner, id, `p${i}.nc`, bodies[i])).json.transfer.transferId);
            const o1 = await device.waitFor('file.offer');
            const o2 = await device.waitFor('file.offer');
            await device.expectNone('file.offer', 300);
            assert.deepStrictEqual([o1.body.transferId, o2.body.transferId], [ids[0], ids[1]]);
            assert.deepStrictEqual(Object.keys(o1.body).sort(), ['createdAt', 'name', 'sha256', 'size', 'transferId', 'uploadedBy']);
            assert.strictEqual(o1.body.sha256, sha(bodies[0]));
            assert.strictEqual(o1.body.uploadedBy.userLabel, 'User');
            await client.waitFor((m) => m.t === 'file.status' && m.body.transferId === ids[0] && m.body.status === 'offered');

            device.send('file.result', { transferId: ids[0], status: 'stored', libraryId: 'l-1789500005000-ab12cd', sha256: sha(bodies[0]), code: 'OK', message: null });
            const st = await client.waitFor((m) => m.t === 'file.status' && m.body.transferId === ids[0] && m.body.status === 'stored');
            assert.strictEqual(st.body.libraryId, 'l-1789500005000-ab12cd');
            const o3 = await device.waitFor('file.offer');
            assert.strictEqual(o3.body.transferId, ids[2]);

            device.send('file.result', { transferId: ids[1], status: 'rejected', code: 'NOT_UTF8', message: 'bad' });
            await client.waitFor((m) => m.t === 'file.status' && m.body.transferId === ids[1] && m.body.status === 'rejected' && m.body.code === 'NOT_UTF8');

            device.send('file.result', { transferId: ids[2], status: 'deferred', code: 'TIER_REQUIRED', message: null });
            await client.waitFor((m) => m.t === 'file.status' && m.body.transferId === ids[2] && m.body.status === 'deferred');
            assert.deepStrictEqual(relay.db.get('SELECT status, code FROM transfers WHERE id = ?', ids[2]), { status: 'pending', code: 'TIER_REQUIRED' });
            await device.expectNone('file.offer', 200);
            deviceReport(device, id, 'report.tier', { tier: 'monitor' });
            await device.expectNone('file.offer', 200);
            deviceReport(device, id, 'report.tier', { tier: 'job' });
            assert.strictEqual((await device.waitFor('file.offer')).body.transferId, ids[2], 'tier rise re-offers');
            assert.strictEqual(relay.db.get('SELECT status FROM transfers WHERE id = ?', ids[2]).status, 'offered');
            await device.close();
            await waitUntil(() => relay.db.get('SELECT status FROM transfers WHERE id = ?', ids[2]).status === 'pending', 1000, 'offered -> pending on disconnect');
            ({ peer: device } = await connectDevice(relay, dev.credential));
            assert.strictEqual((await device.waitFor('file.offer')).body.transferId, ids[2], 're-offer on reconnect');
            device.send('file.result', { transferId: ids[2], status: 'deferred', code: 'BUSY' });
            await client.waitFor((m) => m.t === 'file.status' && m.body.transferId === ids[2] && m.body.status === 'deferred');
            deviceReport(device, id, 'report.state', { seq: 1, job: { active: true } });
            await device.expectNone('file.offer', 200);
            deviceReport(device, id, 'report.state', { seq: 2, job: { active: false } });
            assert.strictEqual((await device.waitFor('file.offer')).body.transferId, ids[2], 'job end re-offers');
            relay.app.audit.flush();
            assert.ok(relay.db.get("SELECT COUNT(*) AS n FROM audit WHERE action = 'file.result'").n >= 3);
            await device.close();
            await client.close();
        } finally {
            await stopRelay(relay);
        }
    }],
    ['device download: own credential only, full and Range: bytes=N- (206), invalid range 416', async () => {
        const { relay, owner, id, dev } = await setup();
        try {
            const other = await pairDevice(relay, owner);
            const body = crypto.randomBytes(100000);
            const t = (await upload(relay, owner, id, 'bin.nc', body)).json.transfer;
            let r = await request(relay, 'GET', `/api/device/files/${t.transferId}`, { bearer: other.credential });
            assert.strictEqual(r.status, 404);
            r = await request(relay, 'GET', `/api/device/files/${t.transferId}`);
            assert.strictEqual(r.status, 401);
            r = await request(relay, 'GET', `/api/device/files/${t.transferId}`, { bearer: dev.credential });
            assert.strictEqual(r.status, 200);
            assert.ok(r.body.equals(body));
            assert.strictEqual(r.headers['accept-ranges'], 'bytes');
            assert.strictEqual(r.headers['x-content-sha256'], sha(body));
            assert.strictEqual(Number(r.headers['content-length']), body.length);
            r = await request(relay, 'GET', `/api/device/files/${t.transferId}`, { bearer: dev.credential, headers: { Range: 'bytes=60000-' } });
            assert.strictEqual(r.status, 206);
            assert.ok(r.body.equals(body.subarray(60000)));
            assert.strictEqual(r.headers['content-range'], `bytes 60000-99999/100000`);
            for (const range of ['bytes=100000-', 'bytes=0-10', 'bytes=-5', 'items=1-']) {
                r = await request(relay, 'GET', `/api/device/files/${t.transferId}`, { bearer: dev.credential, headers: { Range: range } });
                assert.strictEqual(r.status, 416, range);
            }
            r = await request(relay, 'GET', '/api/device/files/x_000000000000', { bearer: dev.credential });
            assert.strictEqual(r.status, 404);
        } finally {
            await stopRelay(relay);
        }
    }],
    ['file.result from another device is ignored', async () => {
        const { relay, owner, id, dev } = await setup();
        try {
            const other = await pairDevice(relay, owner);
            const { peer: devA } = await connectDevice(relay, dev.credential);
            const { peer: devB } = await connectDevice(relay, other.credential);
            const t = (await upload(relay, owner, id, 'a.nc', 'G0\n')).json.transfer;
            await devA.waitFor('file.offer');
            devB.send('file.result', { transferId: t.transferId, status: 'rejected', code: 'INTERNAL' });
            await sleep(200);
            assert.strictEqual(relay.db.get('SELECT status FROM transfers WHERE id = ?', t.transferId).status, 'offered');
            await devA.close();
            await devB.close();
        } finally {
            await stopRelay(relay);
        }
    }],
    ['retention sweep: 7-day TTL, 24 h for never-connected devices, stored blobs after 1 h, rows after 90 d', async () => {
        const clock = createFakeClock();
        const { relay, owner, id, dev } = await setup({ clock });
        try {
            const never = await pairDevice(relay, owner);
            const tNever = (await upload(relay, owner, never.deviceId, 'n.nc', 'G0\n')).json.transfer.transferId;
            const { peer: device } = await connectDevice(relay, dev.credential);
            await device.close();
            const tSeen = (await upload(relay, owner, id, 's.nc', 'G0\n')).json.transfer.transferId;
            const tStored = (await upload(relay, owner, id, 'st.nc', 'G0\n')).json.transfer.transferId;
            relay.db.run("UPDATE transfers SET status = 'stored' WHERE id = ?", tStored);

            clock.advance(2 * 3600000);
            await relay.__test.runSweeps(['files']);
            assert.ok(!fs.existsSync(blobPath(relay, tStored)), 'stored blob deleted after 1 h');
            assert.strictEqual(relay.db.get('SELECT blob_deleted FROM transfers WHERE id = ?', tStored).blob_deleted, 1);
            assert.strictEqual(relay.db.get('SELECT status FROM transfers WHERE id = ?', tNever).status, 'pending');

            clock.advance(23 * 3600000);
            await relay.__test.runSweeps(['files']);
            assert.strictEqual(relay.db.get('SELECT status FROM transfers WHERE id = ?', tNever).status, 'expired');
            assert.ok(!fs.existsSync(blobPath(relay, tNever)));
            assert.strictEqual(relay.db.get('SELECT status FROM transfers WHERE id = ?', tSeen).status, 'pending');

            clock.advance(6 * 86400000);
            await relay.__test.runSweeps(['files']);
            assert.strictEqual(relay.db.get('SELECT status FROM transfers WHERE id = ?', tSeen).status, 'expired');
            assert.ok(!fs.existsSync(blobPath(relay, tSeen)));

            clock.advance(91 * 86400000);
            await relay.__test.runSweeps(['files']);
            assert.strictEqual(relay.db.get('SELECT COUNT(*) AS n FROM transfers').n, 0);
        } finally {
            await stopRelay(relay);
        }
    }],
    ['orphan .part files are deleted at boot', async () => {
        const dataDir = tmpDir();
        fs.mkdirSync(path.join(dataDir, 'blobs', 'tmp'), { recursive: true });
        fs.writeFileSync(path.join(dataDir, 'blobs', 'tmp', 'x_aaaaaaaaaaaa.part'), 'partial');
        const relay = await startRelay({ dataDir });
        try {
            assert.deepStrictEqual(tmpParts(relay), []);
        } finally {
            await stopRelay(relay);
        }
    }],
]);
