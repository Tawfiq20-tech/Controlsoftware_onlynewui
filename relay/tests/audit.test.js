'use strict';

const assert = require('assert');
const { runTests, startRelay, stopRelay, request, userWithSession, login, sleep, waitUntil } = require('./helpers/harness');
const { createFakeClock } = require('./helpers/fakeClock');
const { pairDevice, connectDevice, connectClient, genCredential, sha256 } = require('./helpers/peers');

const ALL_ACTIONS = [
    'auth.register', 'auth.login', 'auth.login_failed', 'auth.logout', 'auth.password_change', 'auth.session_revoke',
    'device.claim', 'device.confirm', 'device.claim_rejected', 'device.claim_expired', 'device.unpair', 'device.rename',
    'device.rotate', 'device.online', 'device.offline', 'grant.add', 'grant.remove', 'file.upload', 'file.result', 'file.delete',
    'cmd', 'admin.invite', 'admin.user_disable',
];

runTests('Relay Audit', [
    ['every §4.8 action is written, keepalives are not, and no secret ever reaches the audit table or logs', async () => {
        const clock = createFakeClock();
        const relay = await startRelay({ clock, signup: 'open' });
        const secrets = [];
        try {
            const reg = await request(relay, 'POST', '/api/auth/register', { json: { email: 'reg@example.com', password: 'register-password-1', displayName: 'Reg' } });
            assert.strictEqual(reg.status, 201);
            secrets.push('register-password-1');
            const admin = await userWithSession(relay, { admin: true, password: 'admin-password-1' });
            const owner = await userWithSession(relay, { email: 'owner@example.com', password: 'owner-password-1' });
            const friend = await userWithSession(relay, { email: 'friend@example.com', password: 'friend-password-1' });
            secrets.push('admin-password-1', 'owner-password-1', 'friend-password-1', admin.token, owner.token, friend.token);
            await request(relay, 'POST', '/api/auth/login', { json: { email: 'owner@example.com', password: 'wrong-password-9' } });
            secrets.push('wrong-password-9');

            const dev = await pairDevice(relay, owner);
            secrets.push(dev.credential, dev.pollSecret, dev.code, dev.code.replace('-', ''));
            const rejected = await pairDevice(relay, owner, { confirm: false });
            secrets.push(rejected.credential, rejected.pollSecret, rejected.code);
            await request(relay, 'POST', `/api/device/pairing/${rejected.pairingId}/reject`, { bearer: rejected.pollSecret, json: {} });
            const stale = await pairDevice(relay, owner, { confirm: false });
            secrets.push(stale.credential, stale.pollSecret, stale.code);

            await request(relay, 'POST', `/api/devices/${dev.deviceId}/rename`, { session: owner, json: { name: 'Big router' } });
            await request(relay, 'POST', `/api/devices/${dev.deviceId}/grants`, { session: owner, json: { email: 'friend@example.com', role: 'operator' } });
            const { peer: device } = await connectDevice(relay, dev.credential);
            await request(relay, 'POST', `/api/devices/${dev.deviceId}/rotate`, { session: owner, json: {} });
            const rot = await device.waitFor('cred.rotate');
            const next = genCredential();
            secrets.push(next);
            device.send('cred.rotated', { rotateId: rot.body.rotateId, newCredentialHash: sha256(next) });
            await device.waitFor('cred.commit');

            const { peer: client } = await connectClient(relay, friend);
            await client.subscribe([dev.deviceId]);
            const cmd = client.cmd(dev.deviceId, 'job.pause', {}, { issuedAt: clock.now() });
            const fwd = await device.waitFor((m) => m.t === 'cmd' && m.id === cmd.id);
            client.cmd(dev.deviceId, 'jog.cont.keepalive', { jogId: 'j_abcdefg' }, { issuedAt: clock.now() });
            await device.waitFor((m) => m.t === 'cmd' && m.body.type === 'jog.cont.keepalive');
            device.send('cmd.ack', { refId: fwd.id, idem: fwd.body.idem, type: 'job.pause', status: 'rejected', code: 'TIER_REQUIRED', message: 'job', duplicate: false, at: clock.now() });
            await client.ack(cmd.id);

            const up = await request(relay, 'PUT', `/api/devices/${dev.deviceId}/files?name=part.nc`, { session: friend, body: 'G0 X1\n' });
            const up2 = await request(relay, 'PUT', `/api/devices/${dev.deviceId}/files?name=part2.nc`, { session: friend, body: 'G0 X2\n' });
            await device.waitFor('file.offer');
            device.send('file.result', { transferId: up.json.transfer.transferId, status: 'stored', libraryId: 'l-1789500005000-ab12cd', code: 'OK' });
            await client.waitFor((m) => m.t === 'file.status' && m.body.status === 'stored');
            await request(relay, 'DELETE', `/api/devices/${dev.deviceId}/files/${up2.json.transfer.transferId}`, { session: friend });

            const second = await login(relay, owner.userRecord);
            secrets.push(second.token);
            const sessions = await request(relay, 'GET', '/api/auth/sessions', { session: owner });
            await request(relay, 'DELETE', `/api/auth/sessions/${sessions.json.find((s) => !s.current).id}`, { session: owner });
            await request(relay, 'POST', '/api/auth/password', { session: friend, json: { currentPassword: 'friend-password-1', newPassword: 'friend-password-2' } });
            secrets.push('friend-password-2');
            const inv = await request(relay, 'POST', '/api/admin/invites', { session: admin, json: { count: 1, expiresInDays: 1 } });
            secrets.push(...inv.json.codes);
            await request(relay, 'DELETE', `/api/devices/${dev.deviceId}/grants/${friend.userId}`, { session: owner });
            await request(relay, 'POST', `/api/admin/users/${friend.userId}/disable`, { session: admin, json: { disabled: true } });
            await request(relay, 'POST', '/api/auth/logout', { session: admin, json: {} });

            await device.close();
            await waitUntil(() => relay.db.get("SELECT COUNT(*) AS n FROM audit WHERE action = 'device.offline'").n > 0, 1000, 'offline audit');
            await request(relay, 'DELETE', `/api/devices/${dev.deviceId}`, { session: owner });
            clock.advance(16 * 60000);
            await relay.__test.runSweeps(['minute']);
            relay.app.audit.flush();

            const rows = relay.db.all('SELECT * FROM audit');
            const actions = new Set(rows.map((r) => r.action));
            for (const a of ALL_ACTIONS) assert.ok(actions.has(a), `missing audit action ${a}`);
            const cmdRows = rows.filter((r) => r.action === 'cmd');
            assert.strictEqual(cmdRows.length, 1, 'keepalive not audited');
            const detail = JSON.parse(cmdRows[0].detail);
            assert.deepStrictEqual([detail.type, detail.cls, detail.status, detail.code], ['job.pause', 'job', 'rejected', 'TIER_REQUIRED']);
            assert.ok(rows.every((r) => !r.detail || Buffer.byteLength(r.detail) <= 2048));

            const haystack = JSON.stringify(rows) + '\n' + relay.logs.join('\n');
            for (const token of ['ors_', 'odc_', 'ops_']) assert.ok(!haystack.includes(token), `${token} leaked`);
            for (const s of secrets) assert.ok(s && !haystack.includes(s), `secret leaked: ${String(s).slice(0, 6)}...`);
            await client.close();
        } finally {
            await stopRelay(relay);
        }
    }],
    ['viewer filter and email visibility; /api/audit/me; pagination with before', async () => {
        const relay = await startRelay();
        try {
            const owner = await userWithSession(relay, { email: 'o@example.com' });
            const viewer = await userWithSession(relay, { email: 'v@example.com' });
            const dev = await pairDevice(relay, owner);
            await request(relay, 'POST', `/api/devices/${dev.deviceId}/grants`, { session: owner, json: { email: 'v@example.com', role: 'viewer' } });
            const { peer: device } = await connectDevice(relay, dev.credential);
            const { peer: client } = await connectClient(relay, viewer);
            const stop = client.cmd(dev.deviceId, 'job.stop', {});
            await device.waitFor((m) => m.t === 'cmd' && m.id === stop.id);
            await sleep(300);
            const vr = (await request(relay, 'GET', `/api/devices/${dev.deviceId}/audit`, { session: viewer })).json;
            assert.ok(vr.length >= 1 && vr.every((r) => r.userId === viewer.userId));
            const or = (await request(relay, 'GET', `/api/devices/${dev.deviceId}/audit?limit=500`, { session: owner })).json;
            assert.ok(or.some((r) => r.userId === owner.userId) && or.some((r) => r.userId === viewer.userId));
            assert.ok(or.length <= 200);
            assert.ok(or.filter((r) => r.userId === viewer.userId).every((r) => r.userEmail === 'v@example.com'), 'owner sees emails');
            const page = (await request(relay, 'GET', `/api/devices/${dev.deviceId}/audit?limit=1&before=${or[0].ts + 1}`, { session: owner })).json;
            assert.strictEqual(page.length, 1);
            const me = (await request(relay, 'GET', '/api/audit/me', { session: viewer })).json;
            assert.ok(me.every((r) => r.userId === viewer.userId));
            await client.close();
            await device.close();
        } finally {
            await stopRelay(relay);
        }
    }],
    ['pagination with a (before, beforeId) cursor never skips rows that share one millisecond', async () => {
        const clock = createFakeClock();
        const relay = await startRelay({ clock });
        try {
            const user = await userWithSession(relay, { email: 'page@example.com' });
            for (let n = 0; n < 7; n++) relay.app.audit.write({ userId: user.userId, action: 'device.rename', detail: { n } });
            relay.app.audit.flush();
            const sameMs = clock.now() - 1000;
            relay.db.run("UPDATE audit SET ts = ? WHERE action = 'device.rename'", sameMs);
            const seen = [];
            let cursor = '';
            for (let guard = 0; guard < 10; guard++) {
                const page = (await request(relay, 'GET', `/api/audit/me?limit=3${cursor}`, { session: user })).json;
                if (!page.length) break;
                seen.push(...page.filter((r) => r.action === 'device.rename').map((r) => r.detail.n));
                const last = page[page.length - 1];
                cursor = `&before=${last.ts}&beforeId=${last.id}`;
            }
            assert.deepStrictEqual(seen.slice().sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6]);
            assert.strictEqual(new Set(seen).size, 7, 'no row repeated');
            // Without beforeId, `before` keeps its exclusive-timestamp meaning.
            const tsOnly = (await request(relay, 'GET', `/api/audit/me?limit=200&before=${sameMs}`, { session: user })).json;
            assert.strictEqual(tsOnly.filter((r) => r.action === 'device.rename').length, 0);
        } finally {
            await stopRelay(relay);
        }
    }],
    ['retention: rows older than RELAY_AUDIT_RETENTION_DAYS are removed by the daily sweep', async () => {
        const clock = createFakeClock();
        const relay = await startRelay({ clock, limits: { auditRetentionDays: 180 } });
        try {
            relay.app.audit.write({ action: 'auth.login', detail: { n: 1 } });
            clock.advance(170 * 86400000);
            relay.app.audit.write({ action: 'auth.login', detail: { n: 2 } });
            clock.advance(11 * 86400000);
            await relay.__test.runSweeps(['daily']);
            const left = relay.db.all("SELECT detail FROM audit WHERE action = 'auth.login'").map((r) => JSON.parse(r.detail).n);
            assert.deepStrictEqual(left, [2]);
        } finally {
            await stopRelay(relay);
        }
    }],
]);
