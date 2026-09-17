'use strict';

const assert = require('assert');
const { runTests, startRelay, stopRelay, userWithSession, sleep, withTimeout } = require('./helpers/harness');
const { createFakeClock } = require('./helpers/fakeClock');
const { pairDevice, connectDevice, connectClient, openWs, wsUrl, deviceReport, autoAck } = require('./helpers/peers');
const { envelope } = require('../server/protocol/envelope');

async function setup(opts = {}) {
    const relay = await startRelay(opts);
    const owner = await userWithSession(relay, { name: 'Sam' });
    const dev = await pairDevice(relay, owner);
    const { peer: device } = await connectDevice(relay, dev.credential);
    const { peer: client } = await connectClient(relay, owner);
    await client.subscribe([dev.deviceId]);
    return { relay, owner, dev, device, client, id: dev.deviceId };
}

async function teardown(ctx) {
    for (const p of [ctx.client, ctx.device]) if (p && !p.closeInfo) p.terminate();
    await stopRelay(ctx.relay);
}

function forwarded(device, env, ms = 1000) {
    return device.waitFor((m) => m.t === 'cmd' && m.id === env.id, ms, 'forward of ' + env.id);
}

function machineAck(device, deviceId, fwd, status = 'accepted', code = 'OK') {
    device.send('cmd.ack', { refId: fwd.id, idem: fwd.body.idem, type: fwd.body.type, status, code, message: null, duplicate: false, at: Date.now() }, { topic: `device/${deviceId}/report` });
}

runTests('Relay Client WS', [
    ['cookie auth and Origin check before accept', async () => {
        const ctx = await setup();
        try {
            let r = await openWs(wsUrl(ctx.relay, '/ws/client'), { Origin: ctx.relay.url });
            assert.deepStrictEqual([r.status, r.body], [401, { error: 'invalid' }]);
            r = await openWs(wsUrl(ctx.relay, '/ws/client'), { Cookie: ctx.owner.cookie, Origin: 'https://evil.example' });
            assert.deepStrictEqual([r.status, r.body], [403, { error: 'origin' }]);
            r = await openWs(wsUrl(ctx.relay, '/ws/client'), { Cookie: ctx.owner.cookie });
            assert.strictEqual(r.status, 403);
            const w = ctx.client.welcome.body;
            assert.strictEqual(w.deviceId, null);
            assert.deepStrictEqual(w.user, { id: ctx.owner.userId, displayName: 'Sam', email: ctx.owner.userRecord.email });
            assert.strictEqual(w.limits.snapshotMaxBytes, 307200);
        } finally {
            await teardown(ctx);
        }
    }],
    ['welcome is followed by 3 pings 200 ms apart', async () => {
        const ctx = await setup();
        try {
            await sleep(600);
            const welcomeAt = ctx.client.welcome._rxAt;
            const pings = ctx.client.all((m) => m.t === 'ping').slice(0, 3);
            assert.strictEqual(pings.length, 3);
            assert.ok(pings[0]._rxAt - welcomeAt < 100);
            for (let i = 1; i < 3; i++) {
                const gap = pings[i]._rxAt - pings[i - 1]._rxAt;
                assert.ok(gap >= 150 && gap <= 400, `gap ${gap}`);
            }
        } finally {
            await teardown(ctx);
        }
    }],
    ['subscribe with a denied id; >20 ids rejected', async () => {
        const ctx = await setup();
        try {
            const sub = await ctx.client.subscribe([ctx.id, 'd_zzzzzzzzzzzz']);
            assert.deepStrictEqual(sub.body, { deviceIds: [ctx.id], denied: ['d_zzzzzzzzzzzz'] });
            ctx.client.send('subscribe', { deviceIds: Array.from({ length: 21 }, (_, i) => `d_${String(i).padStart(12, '0')}`) });
            assert.strictEqual((await ctx.client.waitFor('error')).body.code, 'BAD_ARGS');
        } finally {
            await teardown(ctx);
        }
    }],
    ['forward: via overwritten, TTL clamped, ack routed only to the originating connection', async () => {
        const ctx = await setup();
        try {
            const { peer: other } = await connectClient(ctx.relay, ctx.owner);
            await other.subscribe([ctx.id]);
            const env = ctx.client.cmd(ctx.id, 'jog.step', { axis: 'x', distanceMm: 1, feed: 100 }, { ttlMs: 5000, envExtra: { via: { userId: 'u_forgedforged', role: 'owner' } } });
            const fwd = await forwarded(ctx.device, env);
            assert.strictEqual(fwd.body.ttlMs, 500);
            assert.strictEqual(fwd.via.userId, ctx.owner.userId);
            assert.strictEqual(fwd.via.userLabel, 'Sam');
            assert.strictEqual(fwd.via.role, 'owner');
            assert.strictEqual(fwd.via.connId, ctx.client.welcome.body.connId);
            assert.strictEqual(fwd.via.clientSeq, env.body.seq);
            assert.ok(/^s[0-9a-f]{5}$/.test(fwd.via.sessionRef));
            assert.ok(Math.abs(fwd.via.relayTs - Date.now()) < 1000);
            assert.ok(!JSON.stringify(fwd.via).includes('@'), 'no email in via');
            const ka = ctx.client.cmd(ctx.id, 'jog.cont.keepalive', { jogId: 'j_abcdef' }, { ttlMs: 50 });
            assert.strictEqual((await forwarded(ctx.device, ka)).body.ttlMs, 300);
            const stop = ctx.client.cmd(ctx.id, 'job.stop', {}, { ttlMs: 60000 });
            assert.strictEqual((await forwarded(ctx.device, stop)).body.ttlMs, 10000);
            machineAck(ctx.device, ctx.id, fwd);
            const ack = await ctx.client.ack(env.id);
            assert.strictEqual(ack.body.status, 'accepted');
            await other.expectNone('cmd.ack', 300);
            await other.close();
        } finally {
            await teardown(ctx);
        }
    }],
    ['seq replay -> REPLAY; stale issuedAt -> EXPIRED; future issuedAt -> BAD_ARGS; offline -> DEVICE_OFFLINE', async () => {
        const ctx = await setup();
        try {
            const a = ctx.client.cmd(ctx.id, 'job.pause', {}, { seq: 5 });
            await forwarded(ctx.device, a);
            const replay = ctx.client.cmd(ctx.id, 'job.pause', {}, { seq: 5 });
            assert.strictEqual((await ctx.client.ack(replay.id)).body.code, 'REPLAY');
            const stale = ctx.client.cmd(ctx.id, 'job.pause', {}, { issuedAt: Date.now() - 6000 });
            assert.strictEqual((await ctx.client.ack(stale.id)).body.code, 'EXPIRED');
            const future = ctx.client.cmd(ctx.id, 'job.pause', {}, { issuedAt: Date.now() + 5000 });
            assert.strictEqual((await ctx.client.ack(future.id)).body.code, 'BAD_ARGS');
            await ctx.device.close();
            await sleep(100);
            const off = ctx.client.cmd(ctx.id, 'job.pause', {});
            const ack = await ctx.client.ack(off.id);
            assert.deepStrictEqual([ack.body.status, ack.body.code], ['rejected', 'DEVICE_OFFLINE']);
        } finally {
            await teardown(ctx);
        }
    }],
    ['enc != none -> ENC_UNSUPPORTED; reserved rtc.* -> UNKNOWN_COMMAND; unknown command type -> UNKNOWN_COMMAND', async () => {
        const ctx = await setup();
        try {
            const enc = ctx.client.cmd(ctx.id, 'job.pause', {}, { envExtra: { enc: 'e2e-x25519-aesgcm-v1' } });
            assert.strictEqual((await ctx.client.ack(enc.id)).body.code, 'ENC_UNSUPPORTED');
            ctx.client.send('rtc.offer', { sdp: 'x' });
            assert.strictEqual((await ctx.client.waitFor('error')).body.code, 'UNKNOWN_COMMAND');
            const raw = ctx.client.cmd(ctx.id, 'gcode', { line: 'G0 X0' }, { cls: 'motion' });
            assert.strictEqual((await ctx.client.ack(raw.id)).body.code, 'UNKNOWN_COMMAND');
            await ctx.device.expectNone('cmd', 200);
        } finally {
            await teardown(ctx);
        }
    }],
    ['idem: duplicate returns the cached machine ack with the new refId and no second forward', async () => {
        const ctx = await setup();
        try {
            const first = ctx.client.cmd(ctx.id, 'job.pause', {}, { idem: 'c_useraction01' });
            const fwd = await forwarded(ctx.device, first);
            // Retry while still in flight: attached to the original.
            const inflight = ctx.client.cmd(ctx.id, 'job.pause', {}, { idem: 'c_useraction01' });
            await sleep(50);
            machineAck(ctx.device, ctx.id, fwd, 'rejected', 'TIER_REQUIRED');
            const a1 = await ctx.client.ack(first.id);
            assert.deepStrictEqual([a1.body.code, a1.body.duplicate], ['TIER_REQUIRED', false]);
            const a2 = await ctx.client.ack(inflight.id);
            assert.deepStrictEqual([a2.body.code, a2.body.duplicate, a2.body.refId], ['TIER_REQUIRED', true, inflight.id]);
            const later = ctx.client.cmd(ctx.id, 'job.pause', {}, { idem: 'c_useraction01' });
            const a3 = await ctx.client.ack(later.id);
            assert.deepStrictEqual([a3.body.code, a3.body.duplicate, a3.body.refId], ['TIER_REQUIRED', true, later.id]);
            await ctx.device.expectNone((m) => m.t === 'cmd' && m.body.idem === 'c_useraction01', 200);
        } finally {
            await teardown(ctx);
        }
    }],
    ['relay-generated rejections are never cached; job.stop with a repeated idem is forwarded every time', async () => {
        const clock = createFakeClock();
        const ctx = await setup({ clock });
        try {
            const exp = ctx.client.cmd(ctx.id, 'job.pause', {}, { idem: 'c_retry000001', issuedAt: clock.now() - 9000 });
            assert.strictEqual((await ctx.client.ack(exp.id)).body.code, 'EXPIRED');
            const retry1 = ctx.client.cmd(ctx.id, 'job.pause', {}, { idem: 'c_retry000001', issuedAt: clock.now() });
            await forwarded(ctx.device, retry1);

            const noAck = ctx.client.cmd(ctx.id, 'job.pause', {}, { idem: 'c_retry000002', issuedAt: clock.now() });
            await forwarded(ctx.device, noAck);
            clock.advance(5100);
            const synth = await ctx.client.ack(noAck.id, 2000);
            assert.deepStrictEqual([synth.body.status, synth.body.code, synth.body.message], ['failed', 'INTERNAL', 'no ack']);
            const retry2 = ctx.client.cmd(ctx.id, 'job.pause', {}, { idem: 'c_retry000002', issuedAt: clock.now() });
            await forwarded(ctx.device, retry2);

            for (let i = 0; i < 25; i++) ctx.client.cmd(ctx.id, 'job.pause', {}, { issuedAt: clock.now() });
            const limited = ctx.client.cmd(ctx.id, 'job.pause', {}, { idem: 'c_retry000003', issuedAt: clock.now() });
            assert.strictEqual((await ctx.client.ack(limited.id)).body.code, 'RATE_LIMITED');
            await sleep(250);
            const retry3 = ctx.client.cmd(ctx.id, 'job.pause', {}, { idem: 'c_retry000003', issuedAt: clock.now() });
            await forwarded(ctx.device, retry3);

            await ctx.device.close();
            await sleep(50);
            const offline = ctx.client.cmd(ctx.id, 'job.pause', {}, { idem: 'c_retry000004', issuedAt: clock.now() });
            assert.strictEqual((await ctx.client.ack(offline.id)).body.code, 'DEVICE_OFFLINE');
            ctx.device = (await connectDevice(ctx.relay, ctx.dev.credential)).peer;
            const retry4 = ctx.client.cmd(ctx.id, 'job.pause', {}, { idem: 'c_retry000004', issuedAt: clock.now() });
            const f4 = await forwarded(ctx.device, retry4);
            machineAck(ctx.device, ctx.id, f4);
            await ctx.client.ack(retry4.id);

            for (let i = 0; i < 3; i++) {
                const s = ctx.client.cmd(ctx.id, 'job.stop', {}, { idem: 'c_samestop001', issuedAt: clock.now() });
                const f = await forwarded(ctx.device, s);
                machineAck(ctx.device, ctx.id, f);
                const ack = await ctx.client.ack(s.id);
                assert.strictEqual(ack.body.duplicate, false);
            }
        } finally {
            await teardown(ctx);
        }
    }],
    ['rate limits: cmd bucket -> RATE_LIMITED, but job.stop still forwarded after cmd and user buckets are exhausted', async () => {
        const ctx = await setup();
        try {
            const { peer: second } = await connectClient(ctx.relay, ctx.owner);
            await second.subscribe([ctx.id]);
            for (let i = 0; i < 30; i++) ctx.client.cmd(ctx.id, 'jog.step', { axis: 'x', distanceMm: 0.1, feed: 100 });
            for (let i = 0; i < 30; i++) second.cmd(ctx.id, 'jog.step', { axis: 'x', distanceMm: 0.1, feed: 100 });
            await sleep(300);
            const limited = ctx.client.all((m) => m.t === 'cmd.ack' && m.body.code === 'RATE_LIMITED').length
                + second.all((m) => m.t === 'cmd.ack' && m.body.code === 'RATE_LIMITED').length;
            const fwdCount = ctx.device.all((m) => m.t === 'cmd' && m.body.type === 'jog.step').length;
            assert.ok(limited >= 25, `rate limited ${limited}`);
            assert.ok(fwdCount <= 35, `user bucket caps forwards across connections: ${fwdCount}`);
            const stops = [];
            for (let i = 0; i < 20; i++) stops.push((i % 2 ? second : ctx.client).cmd(ctx.id, 'job.stop', {}));
            for (const s of stops) await forwarded(ctx.device, s, 2000);
            await second.close();
        } finally {
            await teardown(ctx);
        }
    }],
    ['unsynced:true on a stale stop is forwarded with a relay-stamped issuedAt; on motion -> BAD_ARGS', async () => {
        const ctx = await setup();
        try {
            const stop = ctx.client.cmd(ctx.id, 'job.stop', {}, { issuedAt: 1000, bodyExtra: { unsynced: true } });
            const fwd = await forwarded(ctx.device, stop);
            assert.ok(Math.abs(fwd.body.issuedAt - Date.now()) < 1000);
            const jog = ctx.client.cmd(ctx.id, 'jog.step', { axis: 'x', distanceMm: 1, feed: 100 }, { issuedAt: Date.now(), bodyExtra: { unsynced: true } });
            assert.strictEqual((await ctx.client.ack(jog.id)).body.code, 'BAD_ARGS');
        } finally {
            await teardown(ctx);
        }
    }],
    ['keepalive rejection ack from the device reaches the originating client; accepted keepalives need no ack', async () => {
        const ctx = await setup();
        try {
            const ka = ctx.client.cmd(ctx.id, 'jog.cont.keepalive', { jogId: 'j_abcdef' });
            const fwd = await forwarded(ctx.device, ka);
            machineAck(ctx.device, ctx.id, fwd, 'rejected', 'EXPIRED');
            const ack = await ctx.client.ack(ka.id);
            assert.deepStrictEqual([ack.body.status, ack.body.code], ['rejected', 'EXPIRED']);
            const ka2 = ctx.client.cmd(ctx.id, 'jog.cont.keepalive', { jogId: 'j_abcdef' });
            await forwarded(ctx.device, ka2);
            await ctx.client.expectNone((m) => m.t === 'cmd.ack' && m.body.refId === ka2.id, 1300);
        } finally {
            await teardown(ctx);
        }
    }],
    ['matched acks are never dropped under a burst of 50 acks/s', async () => {
        const ctx = await setup();
        try {
            const envs = [];
            for (let i = 0; i < 50; i++) envs.push(ctx.client.cmd(ctx.id, 'job.stop', {}, { bodyExtra: { n: i } }));
            const fwds = [];
            for (const e of envs) fwds.push(await forwarded(ctx.device, e, 2000));
            for (const f of fwds) machineAck(ctx.device, ctx.id, f);
            for (const e of envs) assert.strictEqual((await ctx.client.ack(e.id, 2000)).body.status, 'accepted');
        } finally {
            await teardown(ctx);
        }
    }],
    ['client RTT: fresh sample is forwarded; a sample older than 3 s -> via.clientRttMs null and an immediate ping', async () => {
        const clock = createFakeClock();
        const ctx = await setup({ clock });
        try {
            await sleep(500);
            const a = ctx.client.cmd(ctx.id, 'jog.step', { axis: 'x', distanceMm: 1, feed: 100 }, { issuedAt: clock.now() });
            const fa = await forwarded(ctx.device, a);
            assert.strictEqual(typeof fa.via.clientRttMs, 'number');
            const pingsBefore = ctx.client.all((m) => m.t === 'ping').length;
            clock.advance(3500);
            const b = ctx.client.cmd(ctx.id, 'jog.step', { axis: 'x', distanceMm: 1, feed: 100 }, { issuedAt: clock.now() });
            const fb = await forwarded(ctx.device, b);
            assert.strictEqual(fb.via.clientRttMs, null);
            await ctx.client.waitFor((m) => m.t === 'ping' && ctx.client.messages.filter((x) => x.t === 'ping').length > pingsBefore, 500);
            ctx.relay.hubs.client.__setRttForTest(ctx.client.welcome.body.connId, 400);
            clock.advance(4000);
            const c =ctx.client.cmd(ctx.id, 'jog.step', { axis: 'x', distanceMm: 1, feed: 100 }, { issuedAt: clock.now() });
            assert.strictEqual((await forwarded(ctx.device, c)).via.clientRttMs, 400);
            const stop = ctx.client.cmd(ctx.id, 'job.stop', {}, { issuedAt: clock.now() });
            assert.strictEqual(typeof (await forwarded(ctx.device, stop)).via.clientRttMs, 'number');
        } finally {
            await teardown(ctx);
        }
    }],
    ['missing ack -> synthetic failed ack after 5 s', async () => {
        const clock = createFakeClock();
        const ctx = await setup({ clock });
        try {
            const e = ctx.client.cmd(ctx.id, 'job.pause', {}, { issuedAt: clock.now() });
            await forwarded(ctx.device, e);
            await sleep(300);
            assert.ok(!ctx.client.find((m) => m.t === 'cmd.ack' && m.body.refId === e.id));
            clock.advance(5000);
            const ack = await ctx.client.ack(e.id, 1000);
            assert.deepStrictEqual([ack.body.status, ack.body.code, ack.body.message], ['failed', 'INTERNAL', 'no ack']);
            ctx.relay.app.audit.flush();
            const row = ctx.relay.db.get("SELECT result FROM audit WHERE action = 'cmd' ORDER BY id DESC LIMIT 1");
            assert.strictEqual(row.result, 'failed');
        } finally {
            await teardown(ctx);
        }
    }],
    ['relay->client backpressure: reports are latest-only while buffered; acks are never replaced; sustained 1 MiB closes 1001', async () => {
        const clock = createFakeClock();
        const ctx = await setup({ clock });
        try {
            const conn = ctx.relay.hubs.client.__connForTest(ctx.client.welcome.body.connId);
            let fake = 300 * 1024;
            const realWs = conn.ws;
            Object.defineProperty(realWs, 'bufferedAmount', { configurable: true, get: () => fake });
            for (let s = 1; s <= 3; s++) deviceReport(ctx.device, ctx.id, 'report.state', { seq: s });
            deviceReport(ctx.device, ctx.id, 'report.tier', { tier: 'job', n: 1 });
            deviceReport(ctx.device, ctx.id, 'report.tier', { tier: 'job', n: 2 });
            const e = ctx.client.cmd(ctx.id, 'job.pause', {}, { issuedAt: clock.now() });
            const f = await forwarded(ctx.device, e);
            machineAck(ctx.device, ctx.id, f);
            assert.strictEqual((await ctx.client.ack(e.id)).body.status, 'accepted', 'ack delivered while backed up');
            await sleep(100);
            assert.strictEqual(ctx.client.all((m) => m.t === 'report.state').length, 0);
            fake = 0;
            await ctx.client.waitFor((m) => m.t === 'report.state' && m.body.seq === 3, 1000);
            await ctx.client.waitFor((m) => m.t === 'report.tier' && m.body.n === 2, 1000);
            assert.deepStrictEqual(ctx.client.all((m) => m.t === 'report.state').map((m) => m.body.seq), [3]);
            assert.deepStrictEqual(ctx.client.all((m) => m.t === 'report.tier').map((m) => m.body.n), [2]);

            fake = 2 * 1024 * 1024;
            await sleep(400);
            clock.advance(10500);
            const info = await withTimeout(ctx.client.closed, 3000, 'backpressure close');
            assert.strictEqual(info.code, 1001);
        } finally {
            await teardown(ctx);
        }
    }],
    ['backpressure: a newer report sent after draining supersedes the queued older copy', async () => {
        const ctx = await setup();
        try {
            const hub = ctx.relay.hubs.client;
            const conn = hub.__connForTest(ctx.client.welcome.body.connId);
            let fake = 300 * 1024;
            Object.defineProperty(conn.ws, 'bufferedAmount', { configurable: true, get: () => fake });
            deviceReport(ctx.device, ctx.id, 'report.tier', { tier: 'motion', n: 1 });
            const deadline = Date.now() + 1000;
            while (conn.queued.size === 0 && Date.now() < deadline) await sleep(5);
            assert.strictEqual(conn.queued.size, 1, 'older tier queued under backpressure');
            // Synchronous: no hub tick can run between the drain and the newer report.
            fake = 0;
            hub.fanout(ctx.id, envelope('report.tier', { tier: 'monitor', n: 2 }, { topic: `device/${ctx.id}/report`, ts: Date.now() }), { replaceKey: 'report.tier' });
            await ctx.client.waitFor((m) => m.t === 'report.tier' && m.body.n === 2, 1000);
            await sleep(600);
            const tiers = ctx.client.all((m) => m.t === 'report.tier').map((m) => m.body.n);
            assert.deepStrictEqual(tiers, [2]);
        } finally {
            await teardown(ctx);
        }
    }],
    ['client closing with a forwarded cmd in flight: the machine ack still settles the audit row', async () => {
        const ctx = await setup();
        try {
            const e = ctx.client.cmd(ctx.id, 'job.pause', {});
            const f = await forwarded(ctx.device, e);
            await ctx.client.close();
            await ctx.device.waitFor((m) => m.t === 'client.gone', 1000);
            ctx.relay.app.audit.flush();
            let row = ctx.relay.db.get("SELECT result FROM audit WHERE action = 'cmd' ORDER BY id DESC LIMIT 1");
            assert.strictEqual(row.result, 'forwarded', 'not marked failed when the client leaves');
            machineAck(ctx.device, ctx.id, f);
            const until = Date.now() + 2000;
            do {
                await sleep(50);
                ctx.relay.app.audit.flush();
                row = ctx.relay.db.get("SELECT result FROM audit WHERE action = 'cmd' ORDER BY id DESC LIMIT 1");
            } while (row.result !== 'accepted' && Date.now() < until);
            assert.strictEqual(row.result, 'accepted');
        } finally {
            await teardown(ctx);
        }
    }],
    ['stop flood: every distinct stop is forwarded, but pending entries and audit rows stay bounded', async () => {
        const ctx = await setup();
        try {
            const hub = ctx.relay.hubs.client;
            const N = 400;
            const envs = [];
            let maxPending = 0;
            for (let i = 0; i < N; i++) {
                envs.push(ctx.client.cmd(ctx.id, 'jog.cont.stop', { jogId: 'j_flood' + i }));
            }
            // The machine never acks. Every stop still reaches it (§3.7: never refused).
            await ctx.device.waitFor(() => ctx.device.all((m) => m.t === 'cmd').length >= N, 5000, 'all stops forwarded');
            maxPending = hub.pending.size;
            const fwdIds = new Set(ctx.device.all((m) => m.t === 'cmd').map((m) => m.id));
            for (const e of envs) assert.ok(fwdIds.has(e.id), 'forwarded ' + e.id);
            assert.ok(maxPending <= 100, `pending entries bounded, got ${maxPending}`);
            ctx.relay.__test.tick();
            await sleep(1100);
            ctx.relay.__test.tick();
            ctx.relay.app.audit.flush();
            const rows = ctx.relay.db.all("SELECT detail FROM audit WHERE action = 'cmd' AND user_id = ?", ctx.owner.userId);
            assert.ok(rows.length <= 120, `audit rows bounded, got ${rows.length}`);
            let untracked = 0;
            let trackedRows = 0;
            for (const r of rows) {
                const d = JSON.parse(r.detail);
                if (d.untracked) untracked += d.untracked;
                else trackedRows++;
            }
            assert.strictEqual(trackedRows + untracked, N, 'every forwarded stop is accounted for in the audit log');
            // A tracked stop within budget still gets its ack routed back.
            await sleep(1100);
            const ok = ctx.client.cmd(ctx.id, 'job.stop', {});
            const f = await forwarded(ctx.device, ok);
            machineAck(ctx.device, ctx.id, f);
            assert.strictEqual((await ctx.client.ack(ok.id)).body.status, 'accepted');
            // In-memory audit queue is capped; over the cap a command row is dropped, not queued.
            const audit = ctx.relay.app.audit;
            const { QUEUE_MAX } = require('../server/audit');
            const saved = audit.queue;
            audit.queue = new Array(QUEUE_MAX).fill({ kind: 'noop' });
            assert.strictEqual(audit.queueCmd({ userId: ctx.owner.userId, deviceId: ctx.id, ip: null, detail: { type: 'job.stop' } }), null);
            assert.strictEqual(audit.queue.length, QUEUE_MAX);
            audit.queue = saved;
        } finally {
            await teardown(ctx);
        }
    }],
    ['stop flood: forward rate per connection is capped (coalesced per type), and over-budget stops are not queued to a non-draining device', async () => {
        const clock = createFakeClock();
        const ctx = await setup({ clock });
        try {
            const N = 3000;
            for (let i = 0; i < N; i++) ctx.client.cmd(ctx.id, 'jog.cont.stop', { jogId: 'j_cap' + i }, { issuedAt: clock.now() });
            // A different stop type at the end of the burst still reaches the machine.
            const tail = ctx.client.cmd(ctx.id, 'job.stop', {}, { issuedAt: clock.now() });
            await forwarded(ctx.device, tail, 5000);
            await sleep(200);
            const jogStops = ctx.device.all((m) => m.t === 'cmd' && m.body.type === 'jog.cont.stop');
            // 50 stop bucket + 400 overflow burst + 200/s refill + one per 100 ms per type; the rest coalesce.
            assert.ok(jogStops.length >= 450 && jogStops.length <= 1500, `forwarded jog stops capped, got ${jogStops.length}`);
            // After the dedup window the same type goes through again even with the bucket empty.
            clock.advance(150);
            const again = ctx.client.cmd(ctx.id, 'jog.cont.stop', { jogId: 'j_after' }, { issuedAt: clock.now() });
            await forwarded(ctx.device, again, 2000);

            // Device not draining (over 1 MiB): untracked over-budget stops are not queued.
            clock.advance(2000); // refill buckets
            const devConn = ctx.relay.app.hubs.device.conns.get(ctx.id);
            Object.defineProperty(devConn.ws, 'bufferedAmount', { configurable: true, get: () => 2 * 1024 * 1024 });
            for (let i = 0; i < 300; i++) ctx.client.cmd(ctx.id, 'spindle.off', { n: i }, { issuedAt: clock.now() });
            const last = ctx.client.cmd(ctx.id, 'job.pause', {}, { issuedAt: clock.now() });
            await forwarded(ctx.device, last, 3000);
            await sleep(200);
            const sent = ctx.device.all((m) => m.t === 'cmd' && m.body.type === 'spindle.off').length;
            assert.ok(sent >= 50 && sent <= 80, `only budgeted (tracked) stops queued to a backed-up device, got ${sent}`);
            assert.ok(ctx.relay.app.hubs.device.isOnline(ctx.id), 'below the hard cap the device stays online until the sustain timer');
        } finally {
            await teardown(ctx);
        }
    }],
    ['binary frame from a client closes 4400; missed pongs close 1001', async () => {
        const clock = createFakeClock();
        const ctx = await setup({ clock });
        try {
            ctx.client.sendRaw(Buffer.from([1, 2, 3]), { binary: true });
            assert.strictEqual((await withTimeout(ctx.client.closed, 2000, 'close')).code, 4400);
            const { peer } = await connectClient(ctx.relay, ctx.owner);
            peer.autoPong = false;
            await sleep(500);
            clock.advance(15500);
            assert.strictEqual((await withTimeout(peer.closed, 2000, 'pong close')).code, 1001);
        } finally {
            await teardown(ctx);
        }
    }],
]);
