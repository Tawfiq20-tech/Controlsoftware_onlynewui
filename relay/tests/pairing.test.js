'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { runTests, startRelay, stopRelay, request, userWithSession } = require('./helpers/harness');
const { createFakeClock } = require('./helpers/fakeClock');
const { genCredential, sha256, connectDevice, connectClient, pairDevice } = require('./helpers/peers');
const { ALPHABET, normalizeCode, generateCode, formatCode, maskEmail } = require('../server/auth/pairing');

const CODE_RE = new RegExp(`^[${ALPHABET}]{4}-[${ALPHABET}]{4}$`);

function pairingBody(credential, extra = {}) {
    return Object.assign({
        hardwareId: crypto.randomBytes(6).toString('hex'), name: 'Shop machine', appVersion: '0.1.0', controllerType: 'RSP',
        credentialHash: sha256(credential),
    }, extra);
}

async function requestCode(relay, credential = genCredential(), headers = {}) {
    const r = await request(relay, 'POST', '/api/device/pairing', { json: pairingBody(credential), headers });
    return Object.assign({ credential }, r);
}

function poll(relay, p) {
    return request(relay, 'GET', `/api/device/pairing/${p.json.pairingId}`, { bearer: p.json.pollSecret });
}

runTests('Relay Pairing', [
    ['code alphabet, format and normalisation', () => {
        assert.strictEqual(ALPHABET.length, 31);
        for (const ch of '01OIL') assert.ok(!ALPHABET.includes(ch) || ch === 'L', `ambiguous ${ch} excluded`);
        for (let i = 0; i < 500; i++) assert.ok(CODE_RE.test(formatCode(generateCode())));
        assert.strictEqual(normalizeCode('abcd-efgh'), 'ABCDEFGH');
        assert.strictEqual(normalizeCode(' AbCd  eFgH '), 'ABCDEFGH');
        assert.strictEqual(normalizeCode('ABCDEFG1'), null, '1 maps to I, which is not in the alphabet');
        assert.strictEqual(normalizeCode('ABCDEFG0'), null, '0 maps to O, which is not in the alphabet');
        assert.strictEqual(normalizeCode('ABCDEFG'), null);
        assert.strictEqual(maskEmail('sam@example.com'), 's***@example.com');
    }],
    ['request code -> claim -> repeatable claimed polls -> confirm (idempotent) -> WS auth works', async () => {
        const relay = await startRelay();
        try {
            const owner = await userWithSession(relay, { email: 'sam@example.com', name: 'Sam' });
            const p = await requestCode(relay);
            assert.strictEqual(p.status, 201, p.text);
            assert.ok(CODE_RE.test(p.json.code));
            assert.ok(/^pr_[a-z0-9]{12}$/.test(p.json.pairingId));
            assert.ok(p.json.pollSecret.startsWith('ops_'));
            assert.strictEqual(p.json.pollIntervalMs, 3000);
            assert.strictEqual((await poll(relay, p)).json.status, 'pending');
            assert.strictEqual((await request(relay, 'GET', `/api/device/pairing/${p.json.pairingId}`, { bearer: 'ops_wrong' })).status, 404);

            const claim = await request(relay, 'POST', '/api/devices/claim', { session: owner, json: { code: p.json.code.toLowerCase().replace('-', ' - ') } });
            assert.strictEqual(claim.status, 201, claim.text);
            assert.strictEqual(claim.json.device.status, 'pending_confirmation');
            const deviceId = claim.json.device.id;
            const row = relay.db.get('SELECT * FROM devices WHERE id = ?', deviceId);
            assert.strictEqual(row.credential_hash, sha256(p.credential));

            for (let i = 0; i < 2; i++) {
                const r = await poll(relay, p);
                assert.strictEqual(r.json.status, 'claimed');
                assert.strictEqual(r.json.deviceId, deviceId);
                assert.strictEqual(r.json.accountLabel, 's***@example.com');
                assert.strictEqual(r.json.accountDisplayName, 'Sam');
                assert.strictEqual(r.json.relayWsUrl, relay.url.replace('http:', 'ws:') + '/ws/device');
                assert.ok(!r.text.includes('odc_'));
            }
            const early = await connectDevice(relay, p.credential);
            assert.strictEqual(early.status, 403);
            assert.strictEqual(early.body.error, 'unconfirmed');

            const c1 = await request(relay, 'POST', `/api/device/pairing/${p.json.pairingId}/confirm`, { bearer: p.json.pollSecret, json: {} });
            assert.strictEqual(c1.status, 204);
            const c2 = await request(relay, 'POST', `/api/device/pairing/${p.json.pairingId}/confirm`, { bearer: p.json.pollSecret, json: {} });
            assert.strictEqual(c2.status, 204, 'confirm is idempotent');
            const confirmed = await poll(relay, p);
            assert.strictEqual(confirmed.json.status, 'confirmed');
            assert.ok(!confirmed.text.includes('odc_'));
            const { peer } = await connectDevice(relay, p.credential);
            assert.strictEqual(peer.welcome.body.deviceId, deviceId);
            await peer.close();

            const secretRows = JSON.stringify(relay.db.all('SELECT * FROM pairings'));
            assert.ok(!secretRows.includes(p.json.pollSecret));
            assert.ok(!secretRows.includes(p.json.code.replace('-', '')));
            assert.strictEqual(relay.db.get('SELECT code_hash FROM pairings WHERE id = ?', p.json.pairingId).code_hash, sha256(p.json.code.replace('-', '')));
            relay.app.audit.flush();
            const actions = relay.db.all('SELECT action FROM audit WHERE device_id = ?', deviceId).map((r) => r.action);
            assert.ok(actions.includes('device.claim') && actions.includes('device.confirm'));
        } finally {
            await stopRelay(relay);
        }
    }],
    ['a claim is single-use; expired and wrong codes give the same code_invalid', async () => {
        const clock = createFakeClock();
        const relay = await startRelay({ clock });
        try {
            const a = await userWithSession(relay);
            const b = await userWithSession(relay);
            const p = await requestCode(relay);
            assert.strictEqual((await request(relay, 'POST', '/api/devices/claim', { session: a, json: { code: p.json.code } })).status, 201);
            const again = await request(relay, 'POST', '/api/devices/claim', { session: b, json: { code: p.json.code } });
            assert.strictEqual(again.status, 400);
            assert.strictEqual(again.json.error, 'code_invalid');
            const wrong = await request(relay, 'POST', '/api/devices/claim', { session: b, json: { code: 'ZZZZ-ZZZZ' } });
            assert.deepStrictEqual([wrong.status, wrong.json], [400, { error: 'code_invalid' }]);
            const p2 = await requestCode(relay);
            clock.advance(10 * 60000 + 1000);
            const expired = await request(relay, 'POST', '/api/devices/claim', { session: b, json: { code: p2.json.code } });
            assert.deepStrictEqual([expired.status, expired.json], [400, { error: 'code_invalid' }]);
            assert.strictEqual((await poll(relay, p2)).json.status, 'expired');
            const renewed = await request(relay, 'POST', '/api/device/pairing', { json: pairingBody(p2.credential) });
            assert.strictEqual(renewed.status, 201, 'an expired pairing can be renewed with the same pending credential');
        } finally {
            await stopRelay(relay);
        }
    }],
    ['claim rate limit: 10 attempts per user per 15 min', async () => {
        const relay = await startRelay();
        try {
            const u = await userWithSession(relay);
            for (let i = 0; i < 10; i++) {
                const r = await request(relay, 'POST', '/api/devices/claim', { session: u, json: { code: 'ZZZZ-ZZZZ' } });
                assert.strictEqual(r.status, 400);
            }
            const r = await request(relay, 'POST', '/api/devices/claim', { session: u, json: { code: 'ZZZZ-ZZZZ' } });
            assert.strictEqual(r.status, 429);
        } finally {
            await stopRelay(relay);
        }
    }],
    ['pending_confirmation device is invisible to subscribe, commands, uploads and other users', async () => {
        const relay = await startRelay();
        try {
            const owner = await userWithSession(relay);
            const other = await userWithSession(relay);
            const dev = await pairDevice(relay, owner, { confirm: false });
            const list = await request(relay, 'GET', '/api/devices', { session: owner });
            assert.strictEqual(list.json.length, 1);
            assert.strictEqual(list.json[0].status, 'pending_confirmation');
            assert.strictEqual((await request(relay, 'GET', '/api/devices', { session: other })).json.length, 0);
            const { peer } = await connectClient(relay, owner);
            const sub = await peer.subscribe([dev.deviceId]);
            assert.deepStrictEqual(sub.body.denied, [dev.deviceId]);
            const env = peer.cmd(dev.deviceId, 'job.stop', {});
            const ack = await peer.ack(env.id);
            assert.strictEqual(ack.body.code, 'ACL_DENIED');
            const up = await request(relay, 'PUT', `/api/devices/${dev.deviceId}/files?name=a.nc`, { session: owner, body: 'G0 X0\n' });
            assert.strictEqual(up.status, 404);
            const grant = await request(relay, 'POST', `/api/devices/${dev.deviceId}/grants`, { session: owner, json: { email: other.userRecord.email, role: 'viewer' } });
            assert.strictEqual(grant.status, 404);
            const cam = await request(relay, 'GET', `/api/devices/${dev.deviceId}/camera/cam1/latest.jpg`, { session: owner });
            assert.strictEqual(cam.status, 404);
            await peer.close();
        } finally {
            await stopRelay(relay);
        }
    }],
    ['reject deletes the device and grant; the claimer sees it disappear', async () => {
        const relay = await startRelay();
        try {
            const owner = await userWithSession(relay);
            const dev = await pairDevice(relay, owner, { confirm: false });
            const r = await request(relay, 'POST', `/api/device/pairing/${dev.pairingId}/reject`, { bearer: dev.pollSecret, json: {} });
            assert.strictEqual(r.status, 204);
            assert.strictEqual(relay.db.get('SELECT COUNT(*) AS n FROM devices').n, 0);
            assert.strictEqual(relay.db.get('SELECT COUNT(*) AS n FROM grants').n, 0);
            assert.strictEqual((await request(relay, 'GET', '/api/devices', { session: owner })).json.length, 0);
            assert.strictEqual((await request(relay, 'GET', `/api/device/pairing/${dev.pairingId}`, { bearer: dev.pollSecret })).json.status, 'rejected');
            const conf = await request(relay, 'POST', `/api/device/pairing/${dev.pairingId}/confirm`, { bearer: dev.pollSecret, json: {} });
            assert.strictEqual(conf.status, 409);
            relay.app.audit.flush();
            assert.strictEqual(relay.db.get("SELECT COUNT(*) AS n FROM audit WHERE action = 'device.claim_rejected'").n, 1);
        } finally {
            await stopRelay(relay);
        }
    }],
    ['unconfirmed claim is cleaned up after 15 min', async () => {
        const clock = createFakeClock();
        const relay = await startRelay({ clock });
        try {
            const owner = await userWithSession(relay);
            const dev = await pairDevice(relay, owner, { confirm: false });
            clock.advance(14 * 60000);
            await relay.__test.runSweeps(['minute']);
            assert.strictEqual(relay.db.get('SELECT COUNT(*) AS n FROM devices').n, 1);
            clock.advance(60000 + 1000);
            await relay.__test.runSweeps(['minute']);
            assert.strictEqual(relay.db.get('SELECT COUNT(*) AS n FROM devices').n, 0);
            assert.strictEqual(relay.db.get('SELECT COUNT(*) AS n FROM grants').n, 0);
            assert.strictEqual(relay.db.get('SELECT COUNT(*) AS n FROM pairings WHERE id = ?', dev.pairingId).n, 0);
            assert.strictEqual(relay.db.get("SELECT COUNT(*) AS n FROM audit WHERE action = 'device.claim_expired'").n, 1);
        } finally {
            await stopRelay(relay);
        }
    }],
    ['device-per-user limit -> 409; global live-pairing cap -> 503; hash_in_use -> 409', async () => {
        const relay = await startRelay({ limits: { maxDevicesPerUser: 1, maxLivePairings: 3 } });
        try {
            const owner = await userWithSession(relay);
            const first = await pairDevice(relay, owner);
            const p = await requestCode(relay);
            const r = await request(relay, 'POST', '/api/devices/claim', { session: owner, json: { code: p.json.code } });
            assert.strictEqual(r.status, 409);
            assert.strictEqual(r.json.error, 'device_limit');

            const dup = await request(relay, 'POST', '/api/device/pairing', { json: pairingBody(p.credential) });
            assert.strictEqual(dup.status, 409);
            assert.strictEqual(dup.json.error, 'hash_in_use');
            const dupDevice = await request(relay, 'POST', '/api/device/pairing', { json: pairingBody(first.credential) });
            assert.strictEqual(dupDevice.status, 409);

            assert.strictEqual((await requestCode(relay, genCredential(), { })).status, 201);
            assert.strictEqual((await requestCode(relay)).status, 201);
            const capped = await requestCode(relay);
            assert.strictEqual(capped.status, 503);
            assert.strictEqual(capped.json.error, 'pairing_capacity');
        } finally {
            await stopRelay(relay);
        }
    }],
    ['per-IP: the 6th live pairing expires the oldest; 10 requests per hour', async () => {
        const relay = await startRelay({ trustProxy: true });
        try {
            const h = { 'X-Forwarded-For': '10.7.7.7' };
            const codes = [];
            for (let i = 0; i < 6; i++) {
                const p = await requestCode(relay, genCredential(), h);
                assert.strictEqual(p.status, 201);
                codes.push(p);
            }
            assert.strictEqual((await poll(relay, codes[0])).json.status, 'expired');
            assert.strictEqual((await poll(relay, codes[1])).json.status, 'pending');
            for (let i = 0; i < 4; i++) assert.strictEqual((await requestCode(relay, genCredential(), h)).status, 201);
            assert.strictEqual((await requestCode(relay, genCredential(), h)).status, 429);
            const bad = await request(relay, 'POST', '/api/device/pairing', { json: pairingBody(genCredential(), { credentialHash: 'odc_notahash' }) });
            assert.strictEqual(bad.status, 400);
        } finally {
            await stopRelay(relay);
        }
    }],
]);
