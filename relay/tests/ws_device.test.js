'use strict';

const assert = require('assert');
const { runTests, startRelay, stopRelay, request, userWithSession, waitUntil, withTimeout } = require('./helpers/harness');
const { createFakeClock } = require('./helpers/fakeClock');
const {
    pairDevice, connectDevice, connectClient, deviceReport, openWs, wsUrl, genCredential, sha256,
} = require('./helpers/peers');
const { buildSnapshotFrame } = require('../server/protocol/envelope');

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7), Buffer.from([0xff, 0xd9])]);

function closedWith(peer, ms = 3000) {
    return withTimeout(peer.closed, ms, 'socket close');
}

runTests('Relay Device WS', [
    ['upgrade refusals: no/bad bearer 401 invalid, revoked 401 revoked, missing protocol 426', async () => {
        const relay = await startRelay();
        try {
            const owner = await userWithSession(relay);
            const dev = await pairDevice(relay, owner);
            let r = await openWs(wsUrl(relay, '/ws/device'), { 'X-Onefinity-Protocol': '1' });
            assert.deepStrictEqual([r.status, r.body], [401, { error: 'invalid' }]);
            assert.strictEqual(r.peer, undefined);
            r = await connectDevice(relay, genCredential());
            assert.deepStrictEqual([r.status, r.body], [401, { error: 'invalid' }]);
            r = await openWs(wsUrl(relay, '/ws/device'), { Authorization: 'Bearer ' + dev.credential });
            assert.deepStrictEqual([r.status, r.body], [426, { error: 'protocol', supported: [1] }]);
            r = await openWs(wsUrl(relay, '/ws/device'), { Authorization: 'Bearer ' + dev.credential, 'X-Onefinity-Protocol': '2' });
            assert.strictEqual(r.status, 426);
            assert.strictEqual((await request(relay, 'DELETE', `/api/devices/${dev.deviceId}`, { session: owner })).status, 204);
            r = await connectDevice(relay, dev.credential);
            assert.deepStrictEqual([r.status, r.body], [401, { error: 'revoked' }]);
        } finally {
            await stopRelay(relay);
        }
    }],
    ['failed upgrade auths are rate limited per IP (429 + Retry-After 60)', async () => {
        const relay = await startRelay({ limits: { wsFailedAuthPerIpPerMin: 3 } });
        try {
            for (let i = 0; i < 3; i++) assert.strictEqual((await connectDevice(relay, genCredential())).status, 401);
            const r = await connectDevice(relay, genCredential());
            assert.strictEqual(r.status, 429);
            assert.strictEqual(r.headers['retry-after'], '60');
        } finally {
            await stopRelay(relay);
        }
    }],
    ['welcome contents; hello timeout -> 4408', async () => {
        const clock = createFakeClock();
        const relay = await startRelay({ clock });
        try {
            const owner = await userWithSession(relay);
            const dev = await pairDevice(relay, owner);
            const { peer } = await connectDevice(relay, dev.credential);
            const w = peer.welcome.body;
            assert.strictEqual(w.deviceId, dev.deviceId);
            assert.ok(/^k_[a-z0-9]{12}$/.test(w.connId));
            assert.strictEqual(w.heartbeatMs, 5000);
            assert.deepStrictEqual(w.limits, {
                textMaxBytes: 65536, binaryMaxBytes: 524288, cmdPerSec: 10, reportPerSec: 10, snapshotMaxBytes: 307200,
                snapshotMaxFps: 2, maxUploadBytes: 26214400,
            });
            assert.strictEqual(w.user, null);
            await peer.close();
            const silent = await connectDevice(relay, dev.credential, { hello: false });
            clock.advance(10001);
            const info = await closedWith(silent.peer);
            assert.strictEqual(info.code, 4408);
        } finally {
            await stopRelay(relay);
        }
    }],
    ['second connection replaces the first (4409); presence online/offline reaches subscribers; cached reports replayed', async () => {
        const relay = await startRelay();
        try {
            const owner = await userWithSession(relay);
            const dev = await pairDevice(relay, owner);
            const { peer: client } = await connectClient(relay, owner);
            await client.subscribe([dev.deviceId]);
            const offline = await client.waitFor('presence');
            assert.strictEqual(offline.body.online, false);

            const { peer: d1 } = await connectDevice(relay, dev.credential, { controllerType: 'Grbl' });
            const online = await client.waitFor((m) => m.t === 'presence' && m.body.online);
            assert.strictEqual(online.topic, `device/${dev.deviceId}/report`);
            assert.strictEqual(online.body.controllerType, 'Grbl');
            assert.deepStrictEqual(online.body.cameras, [{ id: 'cam1', name: 'USB camera' }]);

            deviceReport(d1, dev.deviceId, 'report.state', { seq: 7, machine: { state: 'idle' } });
            d1.send('report.tier', { tier: 'job', locks: [] });
            await client.waitFor((m) => m.t === 'report.state' && m.body.seq === 7);
            await client.waitFor((m) => m.t === 'report.tier' && m.body.tier === 'job');

            const { peer: late } = await connectClient(relay, owner);
            late.send('subscribe', { deviceIds: [dev.deviceId] });
            await late.waitFor('subscribed');
            const order = [];
            for (let i = 0; i < 3; i++) {
                const m = await late.waitFor((x) => ['presence', 'report.state', 'report.tier'].includes(x.t));
                order.push(m.t);
            }
            assert.deepStrictEqual(order, ['presence', 'report.state', 'report.tier']);

            const { peer: d2 } = await connectDevice(relay, dev.credential);
            const info = await closedWith(d1);
            assert.strictEqual(info.code, 4409);
            await client.waitFor((m) => m.t === 'presence' && m.body.online, 2000);
            await d2.close();
            const off = await client.waitFor((m) => m.t === 'presence' && !m.body.online);
            assert.strictEqual(off.body.online, false);
            await client.close();
            await late.close();
        } finally {
            await stopRelay(relay);
        }
    }],
    ['oversize text -> 4400; bad version -> 4400; unknown/reserved type -> UNKNOWN_COMMAND', async () => {
        const relay = await startRelay();
        try {
            const owner = await userWithSession(relay);
            const dev = await pairDevice(relay, owner);
            let { peer } = await connectDevice(relay, dev.credential);
            peer.send('rtc.offer', {});
            const err = await peer.waitFor('error');
            assert.strictEqual(err.body.code, 'UNKNOWN_COMMAND');
            peer.send('report.state', { pad: 'x'.repeat(70 * 1024) });
            assert.strictEqual((await closedWith(peer)).code, 4400);
            ({ peer } = await connectDevice(relay, dev.credential));
            peer.sendRaw(JSON.stringify({ v: 2, t: 'ping', id: 'p_1', body: {} }));
            const e2 = await peer.waitFor('error');
            assert.strictEqual(e2.body.code, 'BAD_VERSION');
            assert.strictEqual((await closedWith(peer)).code, 4400);
        } finally {
            await stopRelay(relay);
        }
    }],
    ['binary snapshots: accepted, and rejected on deviceId mismatch, size and fps', async () => {
        const relay = await startRelay({ limits: { snapshotMaxKb: 50, snapshotMaxFps: 2 } });
        try {
            const owner = await userWithSession(relay);
            const dev = await pairDevice(relay, owner);
            let { peer } = await connectDevice(relay, dev.credential);
            const hdr = (seq, extra = {}) => Object.assign({ v: 1, deviceId: dev.deviceId, cameraId: 'cam1', ts: Date.now(), seq, enc: 'none' }, extra);
            peer.sendRaw(buildSnapshotFrame(hdr(1), JPEG), { binary: true });
            await waitUntil(() => relay.app.snapshots.latest(dev.deviceId, 'cam1'), 1000, 'frame stored');
            assert.strictEqual(relay.app.snapshots.latest(dev.deviceId, 'cam1').seq, 1);
            const cam = await request(relay, 'GET', `/api/devices/${dev.deviceId}/camera/cam1/latest.jpg`, { session: owner });
            assert.strictEqual(cam.status, 200);
            assert.ok(cam.body.equals(JPEG));

            peer.sendRaw(buildSnapshotFrame(hdr(2, { deviceId: 'd_000000000000' }), JPEG), { binary: true });
            const e1 = await peer.waitFor('error');
            assert.strictEqual(e1.body.code, 'SNAPSHOT_REJECTED');
            assert.strictEqual(relay.app.snapshots.latest(dev.deviceId, 'cam1').seq, 1);
            await peer.close();

            ({ peer } = await connectDevice(relay, dev.credential));
            peer.sendRaw(buildSnapshotFrame(hdr(3), Buffer.concat([JPEG, Buffer.alloc(60 * 1024)])), { binary: true });
            assert.strictEqual((await peer.waitFor('error')).body.code, 'SNAPSHOT_REJECTED');
            assert.strictEqual(relay.app.snapshots.latest(dev.deviceId, 'cam1'), null, 'frames die with the link and the oversize frame was dropped');
            await peer.close();

            ({ peer } = await connectDevice(relay, dev.credential));
            for (let s = 10; s < 14; s++) peer.sendRaw(buildSnapshotFrame(hdr(s, { cameraId: 'cam2' }), JPEG), { binary: true });
            assert.strictEqual((await peer.waitFor('error')).body.code, 'SNAPSHOT_REJECTED');
            assert.strictEqual(relay.app.snapshots.latest(dev.deviceId, 'cam2').seq, 11, 'frames above the fps cap dropped');
            await peer.close();
        } finally {
            await stopRelay(relay);
        }
    }],
    ['client.gone is sent when a commanding client closes', async () => {
        const relay = await startRelay();
        try {
            const owner = await userWithSession(relay);
            const dev = await pairDevice(relay, owner);
            const { peer: device } = await connectDevice(relay, dev.credential);
            const { peer: watcher } = await connectClient(relay, owner);
            await watcher.subscribe([dev.deviceId]);
            const { peer: client } = await connectClient(relay, owner);
            await client.subscribe([dev.deviceId]);
            const cmd = client.cmd(dev.deviceId, 'job.stop', {});
            await device.waitFor((m) => m.t === 'cmd' && m.id === cmd.id);
            await client.close();
            const gone = await device.waitFor('client.gone');
            assert.deepStrictEqual(gone.body, { connId: client.welcome.body.connId, userId: owner.userId, reason: 'closed' });
            await watcher.close();
            await device.expectNone('client.gone', 200);
            await device.close();
        } finally {
            await stopRelay(relay);
        }
    }],
    ['binding: a device can never speak for, ack for, or settle files of another device', async () => {
        const relay = await startRelay();
        try {
            const owner = await userWithSession(relay);
            const a = await pairDevice(relay, owner);
            const b = await pairDevice(relay, owner);
            const { peer: devA } = await connectDevice(relay, a.credential);
            let { peer: devB } = await connectDevice(relay, b.credential);
            const { peer: client } = await connectClient(relay, owner);
            await client.subscribe([a.deviceId, b.deviceId]);
            deviceReport(devA, a.deviceId, 'report.state', { seq: 1, owner: 'A' });
            await client.waitFor((m) => m.t === 'report.state' && m.body.owner === 'A');

            deviceReport(devB, a.deviceId, 'report.state', { seq: 99, owner: 'B' });
            const err = await devB.waitFor('error');
            assert.strictEqual(err.body.code, 'BAD_ARGS');
            assert.strictEqual((await closedWith(devB)).code, 4400);
            assert.strictEqual(relay.app.hubs.device.cached(a.deviceId).state.body.owner, 'A');
            ({ peer: devB } = await connectDevice(relay, b.credential));
            deviceReport(devB, a.deviceId, 'report.tier', { tier: 'motion' });
            assert.strictEqual((await closedWith(devB)).code, 4400);
            assert.strictEqual(relay.app.hubs.device.cached(a.deviceId).tier, null);
            await client.expectNone((m) => m.body && (m.body.owner === 'B' || m.body.tier === 'motion'), 200);

            ({ peer: devB } = await connectDevice(relay, b.credential));
            const cmd = client.cmd(a.deviceId, 'job.pause', {});
            await devA.waitFor((m) => m.t === 'cmd' && m.id === cmd.id);
            devB.send('cmd.ack', { refId: cmd.id, idem: cmd.body.idem, type: 'job.pause', status: 'rejected', code: 'TIER_REQUIRED', message: 'forged', duplicate: false, at: Date.now() });
            await client.expectNone((m) => m.t === 'cmd.ack' && m.body.refId === cmd.id, 200);
            devA.send('cmd.ack', { refId: cmd.id, idem: cmd.body.idem, type: 'job.pause', status: 'accepted', code: 'OK', message: null, duplicate: false, at: Date.now() }, { topic: `device/${a.deviceId}/report` });
            const ack = await client.ack(cmd.id);
            assert.strictEqual(ack.body.status, 'accepted');
            assert.strictEqual(ack.body.message, null);

            const up = await request(relay, 'PUT', `/api/devices/${a.deviceId}/files?name=part.nc`, { session: owner, body: 'G0 X1\n' });
            assert.strictEqual(up.status, 201);
            const tid = up.json.transfer.transferId;
            const before = relay.db.get('SELECT status, code, library_id FROM transfers WHERE id = ?', tid);
            devB.send('file.result', { transferId: tid, status: 'stored', libraryId: 'l-1789500005000-ab12cd', sha256: up.json.transfer.sha256, code: 'OK', message: null });
            await new Promise((r) => setTimeout(r, 200));
            assert.deepStrictEqual(relay.db.get('SELECT status, code, library_id FROM transfers WHERE id = ?', tid), before);
            const dl = await request(relay, 'GET', `/api/device/files/${tid}`, { bearer: b.credential });
            assert.strictEqual(dl.status, 404);
            await devA.close();
            await devB.close();
            await client.close();
        } finally {
            await stopRelay(relay);
        }
    }],
    ['liveness: 15 s of silence terminates, marks offline, fails pending cmds, returns offers to pending; 4 s in motion', async () => {
        const clock = createFakeClock();
        const relay = await startRelay({ clock });
        try {
            const owner = await userWithSession(relay);
            const dev = await pairDevice(relay, owner);
            let { peer: device } = await connectDevice(relay, dev.credential);
            const { peer: client } = await connectClient(relay, owner);
            await client.subscribe([dev.deviceId]);
            const up = await request(relay, 'PUT', `/api/devices/${dev.deviceId}/files?name=part.nc`, { session: owner, body: 'G0 X1\n' });
            await device.waitFor('file.offer');
            assert.strictEqual(relay.db.get('SELECT status FROM transfers WHERE id = ?', up.json.transfer.transferId).status, 'offered');
            const rx = relay.hubs.device.__lastRxForTest(dev.deviceId);
            assert.ok(typeof rx === 'number');
            clock.advance(14000);
            await new Promise((r) => setTimeout(r, 400));
            assert.ok(relay.app.hubs.device.isOnline(dev.deviceId), 'still online within 15 s');
            const cmd = client.cmd(dev.deviceId, 'job.pause', {}, { issuedAt: clock.now() });
            await device.waitFor((m) => m.t === 'cmd' && m.id === cmd.id);
            clock.advance(1500);
            const ack = await client.ack(cmd.id, 2000);
            assert.deepStrictEqual([ack.body.status, ack.body.code], ['failed', 'DEVICE_OFFLINE']);
            await client.waitFor((m) => m.t === 'presence' && !m.body.online);
            await closedWith(device);
            assert.strictEqual(relay.db.get('SELECT status FROM transfers WHERE id = ?', up.json.transfer.transferId).status, 'pending');

            ({ peer: device } = await connectDevice(relay, dev.credential));
            const reoffer = await device.waitFor('file.offer');
            assert.strictEqual(reoffer.body.transferId, up.json.transfer.transferId);
            assert.strictEqual(reoffer.body.downloadPath, undefined);
            deviceReport(device, dev.deviceId, 'report.tier', { tier: 'motion', activeJog: null });
            await client.waitFor((m) => m.t === 'report.tier' && m.body.tier === 'motion');
            clock.advance(3500);
            await new Promise((r) => setTimeout(r, 400));
            assert.ok(relay.app.hubs.device.isOnline(dev.deviceId));
            clock.advance(1000);
            await closedWith(device);
            assert.ok(!relay.app.hubs.device.isOnline(dev.deviceId));
            await client.close();
        } finally {
            await stopRelay(relay);
        }
    }],
    ['send-side liveness: a device that pings but never drains is terminated after 10 s over 1 MiB, or at once over 8 MiB', async () => {
        const clock = createFakeClock();
        const relay = await startRelay({ clock });
        try {
            const owner = await userWithSession(relay);
            const dev = await pairDevice(relay, owner);
            let { peer: device } = await connectDevice(relay, dev.credential);
            const { peer: client } = await connectClient(relay, owner);
            await client.subscribe([dev.deviceId]);
            const hub = relay.app.hubs.device;
            let fake = 2 * 1024 * 1024;
            Object.defineProperty(hub.conns.get(dev.deviceId).ws, 'bufferedAmount', { configurable: true, get: () => fake });
            const pingAndAdvance = async (nonce, ms) => {
                device.send('ping', { nonce, sentAt: clock.now() });
                await device.waitFor((m) => m.t === 'pong' && m.body.nonce === nonce, 1000);
                relay.__test.tick();
                clock.advance(ms);
                relay.__test.tick();
            };
            // Keeps lastRxAt fresh the whole time (the attacker's "ping but never read").
            for (let i = 0; i < 4; i++) {
                await pingAndAdvance('p_bp' + i, 2000);
                assert.ok(hub.isOnline(dev.deviceId), 'still online before 10 s of backpressure (' + i + ')');
            }
            await pingAndAdvance('p_bp_last', 2500);
            await closedWith(device);
            assert.ok(!hub.isOnline(dev.deviceId));
            await client.waitFor((m) => m.t === 'presence' && !m.body.online, 2000);

            // A draining device recovers from a transient high buffer without being closed.
            ({ peer: device } = await connectDevice(relay, dev.credential));
            await client.waitFor((m) => m.t === 'presence' && m.body.online, 2000);
            fake = 2 * 1024 * 1024;
            const conn2 = hub.conns.get(dev.deviceId);
            Object.defineProperty(conn2.ws, 'bufferedAmount', { configurable: true, get: () => fake });
            await pingAndAdvance('p_t1', 9000);
            fake = 0;
            await pingAndAdvance('p_t2', 2000);
            fake = 2 * 1024 * 1024;
            await pingAndAdvance('p_t3', 2000);
            assert.ok(hub.isOnline(dev.deviceId), 'the high-water timer resets once the buffer drains');

            // Over the hard cap: a tracked stop is not queued; it fails DEVICE_OFFLINE exactly once
            // and the link is terminated immediately.
            fake = 9 * 1024 * 1024;
            const stop = client.cmd(dev.deviceId, 'job.stop', {}, { issuedAt: clock.now() });
            const ack = await client.ack(stop.id, 2000);
            assert.deepStrictEqual([ack.body.status, ack.body.code], ['failed', 'DEVICE_OFFLINE']);
            await closedWith(device);
            assert.ok(!hub.isOnline(dev.deviceId));
            await new Promise((r) => setTimeout(r, 200));
            assert.strictEqual(client.all((m) => m.t === 'cmd.ack' && m.body.refId === stop.id).length, 1, 'exactly one ack');
            assert.strictEqual(relay.app.hubs.client.pending.size, 0);
            await client.close();
        } finally {
            await stopRelay(relay);
        }
    }],
    ['credential rotation: rotate -> rotated -> commit; old hash dies once the new one is used', async () => {
        const relay = await startRelay();
        try {
            const owner = await userWithSession(relay);
            const dev = await pairDevice(relay, owner);
            const { peer } = await connectDevice(relay, dev.credential);
            assert.strictEqual((await request(relay, 'POST', `/api/devices/${dev.deviceId}/rotate`, { session: owner, json: {} })).status, 202);
            const rot = await peer.waitFor('cred.rotate');
            assert.ok(/^r_[a-z0-9]{12}$/.test(rot.body.rotateId));
            const next = genCredential();
            peer.send('cred.rotated', { rotateId: 'r_000000000000', newCredentialHash: sha256(next) });
            assert.strictEqual((await peer.waitFor('error')).body.code, 'BAD_ARGS');
            peer.send('cred.rotated', { rotateId: rot.body.rotateId, newCredentialHash: sha256(next) });
            const commit = await peer.waitFor('cred.commit');
            assert.strictEqual(commit.body.rotateId, rot.body.rotateId);
            await peer.close();

            // Commit lost: the machine still holds nextCredential, which is now current.
            let r = await connectDevice(relay, next);
            assert.ok(r.peer, 'nextCredential authenticates');
            await r.peer.close();
            r = await connectDevice(relay, dev.credential);
            assert.deepStrictEqual([r.status, r.body], [401, { error: 'invalid' }], 'old credential dies after the new one was used');
        } finally {
            await stopRelay(relay);
        }
    }],
    ['credential rotation: before the new hash is used both authenticate; old use swaps back', async () => {
        const relay = await startRelay();
        try {
            const owner = await userWithSession(relay);
            const dev = await pairDevice(relay, owner);
            const { peer } = await connectDevice(relay, dev.credential);
            relay.app.hubs.device.requestRotation(dev.deviceId);
            const rot = await peer.waitFor('cred.rotate');
            const next = genCredential();
            peer.send('cred.rotated', { rotateId: rot.body.rotateId, newCredentialHash: sha256(next) });
            await peer.waitFor('cred.commit');
            await peer.close();
            const row = relay.db.get('SELECT credential_hash, previous_credential_hash FROM devices WHERE id = ?', dev.deviceId);
            assert.deepStrictEqual([row.credential_hash, row.previous_credential_hash], [sha256(next), sha256(dev.credential)]);
            const old = await connectDevice(relay, dev.credential);
            assert.ok(old.peer, 'old credential still accepted before the new one is proven');
            await old.peer.close();
            const swapped = relay.db.get('SELECT credential_hash, previous_credential_hash FROM devices WHERE id = ?', dev.deviceId);
            assert.deepStrictEqual([swapped.credential_hash, swapped.previous_credential_hash], [sha256(dev.credential), null]);
            const n = await connectDevice(relay, next);
            assert.strictEqual(n.status, 401);
        } finally {
            await stopRelay(relay);
        }
    }],
    ['credential rotation: no cred.rotated -> nothing changes and the pending id is swept after 5 min; age-based trigger', async () => {
        const clock = createFakeClock();
        const relay = await startRelay({ clock, limits: { credRotateDays: 90 } });
        try {
            const owner = await userWithSession(relay);
            const dev = await pairDevice(relay, owner);
            relay.db.run('UPDATE devices SET cred_created_at = ? WHERE id = ?', clock.now() - 91 * 86400000, dev.deviceId);
            const { peer } = await connectDevice(relay, dev.credential);
            const rot = await peer.waitFor('cred.rotate', 2000);
            assert.ok(rot.body.rotateId);
            const before = relay.db.get('SELECT credential_hash, previous_credential_hash, pending_rotate_id FROM devices WHERE id = ?', dev.deviceId);
            assert.strictEqual(before.pending_rotate_id, rot.body.rotateId);
            peer.send('ping', { nonce: 'p_keepalive', sentAt: clock.now() });
            await peer.waitFor('pong');
            clock.advance(5 * 60000 + 1000);
            await relay.__test.runSweeps(['minute']);
            const after = relay.db.get('SELECT credential_hash, previous_credential_hash, pending_rotate_id FROM devices WHERE id = ?', dev.deviceId);
            assert.deepStrictEqual(after, Object.assign({}, before, { pending_rotate_id: null }));
            peer.terminate();
        } finally {
            await stopRelay(relay);
        }
    }],
]);
