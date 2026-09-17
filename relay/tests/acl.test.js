'use strict';

const assert = require('assert');
const { runTests, startRelay, stopRelay, request, userWithSession } = require('./helpers/harness');
const { pairDevice, connectDevice, connectClient, deviceReport } = require('./helpers/peers');

async function setup() {
    const relay = await startRelay();
    const owner = await userWithSession(relay, { name: 'Owner' });
    const operator = await userWithSession(relay, { name: 'Op' });
    const viewer = await userWithSession(relay, { name: 'View' });
    const stranger = await userWithSession(relay, { name: 'Stranger' });
    const admin = await userWithSession(relay, { name: 'Admin', admin: true });
    const dev = await pairDevice(relay, owner);
    for (const [s, role] of [[operator, 'operator'], [viewer, 'viewer']]) {
        const r = await request(relay, 'POST', `/api/devices/${dev.deviceId}/grants`, { session: owner, json: { email: s.userRecord.email, role } });
        assert.strictEqual(r.status, 201, r.text);
    }
    const { peer: device } = await connectDevice(relay, dev.credential);
    return { relay, owner, operator, viewer, stranger, admin, dev, device };
}

function expectStatus(res, expected, label) {
    assert.strictEqual(res.status, expected, `${label}: expected ${expected}, got ${res.status} ${res.text}`);
}

runTests('Relay ACL', [
    ['role x route matrix', async () => {
        const ctx = await setup();
        const { relay, owner, operator, viewer, stranger, admin, dev } = ctx;
        const id = dev.deviceId;
        try {
            const list = {};
            for (const [name, s] of Object.entries({ owner, operator, viewer, stranger })) {
                list[name] = (await request(relay, 'GET', '/api/devices', { session: s })).json;
            }
            assert.strictEqual(list.owner[0].role, 'owner');
            assert.strictEqual(list.operator[0].role, 'operator');
            assert.strictEqual(list.viewer[0].role, 'viewer');
            assert.strictEqual(list.stranger.length, 0);
            assert.strictEqual(list.owner[0].online, true);

            const matrix = [
                ['POST', `/api/devices/${id}/rename`, { name: 'Renamed' }, { owner: 200, operator: 403, viewer: 403, stranger: 404 }],
                ['GET', `/api/devices/${id}/grants`, undefined, { owner: 200, operator: 403, viewer: 403, stranger: 404 }],
                ['POST', `/api/devices/${id}/rotate`, {}, { owner: 202, operator: 403, viewer: 403, stranger: 404 }],
                ['GET', `/api/devices/${id}/files`, undefined, { owner: 200, operator: 200, viewer: 200, stranger: 404 }],
                ['GET', `/api/devices/${id}/camera/cam1/latest.jpg`, undefined, { owner: 204, operator: 204, viewer: 204, stranger: 404 }],
                ['GET', `/api/devices/${id}/audit`, undefined, { owner: 200, operator: 200, viewer: 200, stranger: 404 }],
                ['DELETE', `/api/devices/${id}`, undefined, { operator: 403, viewer: 403, stranger: 404 }],
                ['POST', `/api/devices/${id}/grants`, { email: stranger.userRecord.email, role: 'viewer' }, { operator: 403, viewer: 403, stranger: 404 }],
                ['DELETE', `/api/devices/${id}/grants/${viewer.userId}`, undefined, { operator: 403, stranger: 404 }],
            ];
            const sessions = { owner, operator, viewer, stranger };
            for (const [method, url, json, expect] of matrix) {
                for (const [who, status] of Object.entries(expect)) {
                    const res = await request(relay, method, url, { session: sessions[who], json });
                    expectStatus(res, status, `${who} ${method} ${url}`);
                }
            }

            for (const [who, status] of Object.entries({ owner: 201, operator: 201, viewer: 403, stranger: 404 })) {
                const res = await request(relay, 'PUT', `/api/devices/${id}/files?name=${who}.nc`, { session: sessions[who], body: 'G0 X1\n' });
                expectStatus(res, status, `${who} upload`);
            }
            const files = (await request(relay, 'GET', `/api/devices/${id}/files`, { session: owner })).json;
            const ownerUpload = files.find((f) => f.name === 'owner.nc');
            const opUpload = files.find((f) => f.name === 'operator.nc');
            expectStatus(await request(relay, 'DELETE', `/api/devices/${id}/files/${ownerUpload.transferId}`, { session: operator }), 403, 'operator deletes owner upload');
            expectStatus(await request(relay, 'DELETE', `/api/devices/${id}/files/${opUpload.transferId}`, { session: viewer }), 403, 'viewer deletes');
            expectStatus(await request(relay, 'DELETE', `/api/devices/${id}/files/${opUpload.transferId}`, { session: stranger }), 404, 'stranger deletes');
            expectStatus(await request(relay, 'DELETE', `/api/devices/${id}/files/${opUpload.transferId}`, { session: operator }), 204, 'uploader deletes');
            expectStatus(await request(relay, 'DELETE', `/api/devices/${id}/files/${ownerUpload.transferId}`, { session: owner }), 204, 'owner deletes');

            for (const s of [owner, operator, viewer]) {
                expectStatus(await request(relay, 'GET', '/api/admin/users', { session: s }), 403, 'non-admin');
            }
            expectStatus(await request(relay, 'GET', '/api/admin/users', { session: admin }), 200, 'admin users');
            const inv = await request(relay, 'POST', '/api/admin/invites', { session: admin, json: { count: 2, expiresInDays: 3 } });
            expectStatus(inv, 200, 'admin invites');
            assert.strictEqual(inv.json.codes.length, 2);

            const viewerAudit = (await request(relay, 'GET', `/api/devices/${id}/audit`, { session: viewer })).json;
            assert.ok(viewerAudit.every((r) => r.userId === viewer.userId), 'viewer sees only own rows');
            const ownerAudit = (await request(relay, 'GET', `/api/devices/${id}/audit`, { session: owner })).json;
            assert.ok(ownerAudit.some((r) => r.userId === operator.userId));
            const opAudit = (await request(relay, 'GET', `/api/devices/${id}/audit`, { session: operator })).json;
            assert.ok(opAudit.filter((r) => r.userId !== operator.userId).every((r) => r.userEmail === undefined), 'operator sees no foreign emails');

            expectStatus(await request(relay, 'DELETE', `/api/devices/${id}/grants/${viewer.userId}`, { session: viewer }), 204, 'self removal');
            expectStatus(await request(relay, 'DELETE', `/api/devices/${id}/grants/${owner.userId}`, { session: owner }), 409, 'owner grant cannot be removed');
            expectStatus(await request(relay, 'DELETE', `/api/devices/${id}`, { session: owner }), 204, 'owner unpair');
            expectStatus(await request(relay, 'GET', `/api/devices/${id}/files`, { session: owner }), 404, 'gone after unpair');
        } finally {
            await ctx.device.close();
            await stopRelay(relay);
        }
    }],
    ['foreign and unknown devices look identical (404 / ACL_DENIED)', async () => {
        const ctx = await setup();
        const { relay, stranger, dev } = ctx;
        try {
            const unknown = 'd_000000000000';
            for (const id of [dev.deviceId, unknown, 'garbage']) {
                const r = await request(relay, 'GET', `/api/devices/${id}/files`, { session: stranger });
                assert.deepStrictEqual([r.status, r.json], [404, { error: 'not_found' }]);
            }
            const { peer } = await connectClient(relay, stranger);
            const sub = await peer.subscribe([dev.deviceId, unknown]);
            assert.deepStrictEqual(sub.body.denied, [dev.deviceId, unknown]);
            const a1 = await peer.ack(peer.cmd(dev.deviceId, 'job.stop', {}).id);
            const a2 = await peer.ack(peer.cmd(unknown, 'job.stop', {}).id);
            assert.strictEqual(a1.body.code, 'ACL_DENIED');
            assert.strictEqual(a2.body.code, 'ACL_DENIED');
            await peer.close();
        } finally {
            await ctx.device.close();
            await stopRelay(relay);
        }
    }],
    ['viewer cmd: job/motion -> ACL_DENIED, stop is forwarded', async () => {
        const ctx = await setup();
        const { relay, viewer, dev, device } = ctx;
        try {
            const { peer } = await connectClient(relay, viewer);
            await peer.subscribe([dev.deviceId]);
            const pause = await peer.ack(peer.cmd(dev.deviceId, 'job.pause', {}).id);
            assert.strictEqual(pause.body.code, 'ACL_DENIED');
            const jog = await peer.ack(peer.cmd(dev.deviceId, 'jog.step', { axis: 'x', distanceMm: 1, feed: 100 }).id);
            assert.strictEqual(jog.body.code, 'ACL_DENIED');
            const mislabelled = await peer.ack(peer.cmd(dev.deviceId, 'jog.step', { axis: 'x', distanceMm: 1, feed: 100 }, { cls: 'stop' }).id);
            assert.strictEqual(mislabelled.body.code, 'BAD_ARGS', 'cls must match the command type');
            const stop = peer.cmd(dev.deviceId, 'job.stop', {});
            const fwd = await device.waitFor((m) => m.t === 'cmd' && m.id === stop.id);
            assert.strictEqual(fwd.via.role, 'viewer');
            assert.strictEqual(fwd.body.type, 'job.stop');
            await peer.close();
        } finally {
            await device.close();
            await stopRelay(relay);
        }
    }],
    ['grant removal immediately unsubscribes and sends device.removed', async () => {
        const ctx = await setup();
        const { relay, owner, operator, dev, device } = ctx;
        try {
            const { peer } = await connectClient(relay, operator);
            await peer.subscribe([dev.deviceId]);
            const cmd = peer.cmd(dev.deviceId, 'job.stop', {});
            await device.waitFor((m) => m.t === 'cmd' && m.id === cmd.id);
            await device.waitFor((m) => m.t === 'viewers' && m.body.count === 1);
            deviceReport(device, dev.deviceId, 'report.state', { seq: 1, connected: true });
            await peer.waitFor((m) => m.t === 'report.state' && m.body.seq === 1);
            const r = await request(relay, 'DELETE', `/api/devices/${dev.deviceId}/grants/${operator.userId}`, { session: owner });
            assert.strictEqual(r.status, 204);
            const removed = await peer.waitFor('device.removed');
            assert.strictEqual(removed.body.deviceId, dev.deviceId);
            const gone = await device.waitFor('client.gone');
            assert.strictEqual(gone.body.reason, 'grant-removed');
            await device.waitFor((m) => m.t === 'viewers' && m.body.count === 0);
            deviceReport(device, dev.deviceId, 'report.state', { seq: 2, connected: true });
            await peer.expectNone((m) => m.t === 'report.state' && m.body.seq === 2, 300);
            const denied = await peer.ack(peer.cmd(dev.deviceId, 'job.stop', {}).id);
            assert.strictEqual(denied.body.code, 'ACL_DENIED');
            await peer.close();
        } finally {
            await device.close();
            await stopRelay(relay);
        }
    }],
]);
