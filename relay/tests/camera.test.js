'use strict';

const assert = require('assert');
const { runTests, startRelay, stopRelay, request, userWithSession, login, sleep, waitUntil } = require('./helpers/harness');
const { createFakeClock } = require('./helpers/fakeClock');
const { pairDevice, connectDevice, connectClient } = require('./helpers/peers');
const { buildSnapshotFrame } = require('../server/protocol/envelope');

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1), Buffer.from([0xff, 0xd9])]);

function poll(relay, session, deviceId, query = '') {
    return request(relay, 'GET', `/api/devices/${deviceId}/camera/cam1/latest.jpg${query}`, { session });
}

function sendFrame(device, deviceId, seq) {
    device.sendRaw(buildSnapshotFrame({ v: 1, deviceId, cameraId: 'cam1', ts: 1789500000000 + seq, seq, enc: 'none' }, JPEG), { binary: true });
}

async function setup(opts) {
    const relay = await startRelay(opts);
    const owner = await userWithSession(relay);
    const dev = await pairDevice(relay, owner);
    const { peer: device } = await connectDevice(relay, dev.credential);
    return { relay, owner, dev, device, id: dev.deviceId };
}

runTests('Relay Camera', [
    ['welcome.limits carries snapshotMaxBytes and snapshotMaxFps from config', async () => {
        const ctx = await setup({ limits: { snapshotMaxKb: 120, snapshotMaxFps: 1 } });
        try {
            assert.strictEqual(ctx.device.welcome.body.limits.snapshotMaxBytes, 120 * 1024);
            assert.strictEqual(ctx.device.welcome.body.limits.snapshotMaxFps, 1);
        } finally {
            await ctx.device.close();
            await stopRelay(ctx.relay);
        }
    }],
    ['offline device -> 204 with X-Device-Offline', async () => {
        const ctx = await setup();
        try {
            await ctx.device.close();
            await sleep(100);
            const r = await poll(ctx.relay, ctx.owner, ctx.id);
            assert.strictEqual(r.status, 204);
            assert.strictEqual(r.headers['x-device-offline'], '1');
        } finally {
            await stopRelay(ctx.relay);
        }
    }],
    ['poll creates a demand; fps = max of viewers capped by config; renewal every 5 s; re-demand on change', async () => {
        const clock = createFakeClock();
        const ctx = await setup({ clock });
        const { relay, owner, id, device } = ctx;
        try {
            const second = await login(relay, owner.userRecord);
            let r = await poll(relay, owner, id);
            assert.strictEqual(r.status, 204);
            let d = await device.waitFor('camera.demand');
            assert.deepStrictEqual(d.body, { cameraId: 'cam1', fps: 1, leaseMs: 10000 });
            await sleep(300);
            await poll(relay, owner, id);
            await device.expectNone('camera.demand', 200);
            await sleep(300);
            await poll(relay, second, id, '?fps=2');
            d = await device.waitFor('camera.demand');
            assert.strictEqual(d.body.fps, 2, 'max over viewers');
            clock.advance(5100);
            await poll(relay, owner, id);
            d = await device.waitFor('camera.demand');
            assert.strictEqual(d.body.fps, 1, 'the fps=2 viewer aged out of the 5 s window, and the lease is renewed');
        } finally {
            await device.close();
            await stopRelay(relay);
        }
        const capped = await setup({ limits: { snapshotMaxFps: 1 } });
        try {
            await poll(capped.relay, capped.owner, capped.id, '?fps=2');
            assert.strictEqual((await capped.device.waitFor('camera.demand')).body.fps, 1);
        } finally {
            await capped.device.close();
            await stopRelay(capped.relay);
        }
    }],
    ['frame served with X-Frame-Seq; after=<seq> -> 204; stale after 5 s -> 204', async () => {
        const clock = createFakeClock();
        const ctx = await setup({ clock });
        const { relay, owner, id, device } = ctx;
        try {
            sendFrame(device, id, 41);
            await waitUntil(() => relay.app.snapshots.latest(id, 'cam1'), 1000, 'frame');
            let r = await poll(relay, owner, id);
            assert.strictEqual(r.status, 200);
            assert.strictEqual(r.headers['content-type'], 'image/jpeg');
            assert.strictEqual(r.headers['cache-control'], 'no-store');
            assert.strictEqual(r.headers['x-frame-seq'], '41');
            assert.strictEqual(r.headers['x-frame-ts'], String(1789500000041));
            assert.ok(r.body.equals(JPEG));
            await sleep(260);
            r = await poll(relay, owner, id, '?after=41');
            assert.strictEqual(r.status, 204);
            assert.strictEqual(r.body.length, 0);
            await sleep(260);
            r = await poll(relay, owner, id, '?after=40');
            assert.strictEqual(r.status, 200);
            device.send('ping', { nonce: 'p_x', sentAt: 1 });
            clock.advance(5100);
            await sleep(260);
            r = await poll(relay, owner, id);
            assert.strictEqual(r.status, 204, 'frame older than 5 s is not served');
        } finally {
            await device.close();
            await stopRelay(relay);
        }
    }],
    ['a device inventing camera ids cannot store more than 8 cameras of frames', async () => {
        const ctx = await setup();
        try {
            const { MAX_CAMERAS } = require('../server/snapshots');
            for (let i = 0; i < 40; i++) {
                ctx.device.sendRaw(buildSnapshotFrame({ v: 1, deviceId: ctx.id, cameraId: 'c' + i, ts: 1789500000000 + i, seq: i + 1, enc: 'none' }, JPEG), { binary: true });
            }
            const err = await ctx.device.waitFor((m) => m.t === 'error' && m.body.code === 'SNAPSHOT_REJECTED', 2000, 'rejection');
            assert.ok(['camera', 'fps'].includes(err.body.message), err.body.message);
            ctx.device.send('ping', { nonce: 'p_sync', sentAt: 1 });
            await ctx.device.waitFor('pong', 2000);
            const cams = ctx.relay.app.snapshots.frames.get(ctx.id);
            assert.ok(cams && cams.size === MAX_CAMERAS, `stored cameras ${cams && cams.size}`);
            assert.ok(ctx.relay.app.snapshots.latest(ctx.id, 'c0'), 'the first cameras are kept');
            assert.strictEqual(ctx.relay.app.snapshots.latest(ctx.id, 'c20'), null);
        } finally {
            await ctx.device.close();
            await stopRelay(ctx.relay);
        }
    }],
    ['poll rate limit: 4 per second per session per camera', async () => {
        const ctx = await setup();
        try {
            const statuses = [];
            for (let i = 0; i < 6; i++) statuses.push((await poll(ctx.relay, ctx.owner, ctx.id)).status);
            assert.deepStrictEqual(statuses.slice(0, 4), [204, 204, 204, 204]);
            assert.ok(statuses.slice(4).includes(429), statuses.join(','));
        } finally {
            await ctx.device.close();
            await stopRelay(ctx.relay);
        }
    }],
    ['camera.error is forwarded to subscribers; last subscriber leaving sends fps 0', async () => {
        const ctx = await setup();
        try {
            const { peer: client } = await connectClient(ctx.relay, ctx.owner);
            await client.subscribe([ctx.id]);
            await poll(ctx.relay, ctx.owner, ctx.id);
            await ctx.device.waitFor('camera.demand');
            ctx.device.send('camera.error', { cameraId: 'cam1', code: 'NO_FRAME', message: 'no frame' });
            const e = await client.waitFor('camera.error');
            assert.deepStrictEqual(e.body, { cameraId: 'cam1', code: 'NO_FRAME', message: 'no frame' });
            await client.close();
            const stop = await ctx.device.waitFor((m) => m.t === 'camera.demand' && m.body.fps === 0);
            assert.strictEqual(stop.body.cameraId, 'cam1');
        } finally {
            await ctx.device.close();
            await stopRelay(ctx.relay);
        }
    }],
]);
