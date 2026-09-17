'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { runTests, startRelay, request, userWithSession, removeDir, withTimeout } = require('./helpers/harness');
const { pairDevice, connectDevice, connectClient } = require('./helpers/peers');
const { openDatabase } = require('../server/store/db');

runTests('Relay Shutdown', [
    ['close() sends 1001 to devices and clients, flushes audit, checkpoints and closes the DB', async () => {
        const relay = await startRelay();
        let removed = false;
        try {
            const owner = await userWithSession(relay);
            const dev = await pairDevice(relay, owner);
            const { peer: device } = await connectDevice(relay, dev.credential);
            const { peer: client } = await connectClient(relay, owner);
            await client.subscribe([dev.deviceId]);
            const cmd = client.cmd(dev.deviceId, 'job.stop', {});
            await device.waitFor((m) => m.t === 'cmd' && m.id === cmd.id);

            await withTimeout(relay.close(), 5000, 'relay.close');
            const d = await withTimeout(device.closed, 2000, 'device close');
            const c = await withTimeout(client.closed, 2000, 'client close');
            assert.strictEqual(d.code, 1001);
            assert.strictEqual(d.reason, 'relay restarting');
            assert.strictEqual(c.code, 1001);
            assert.strictEqual(relay.db.open, false);
            assert.throws(() => relay.db.get('SELECT 1'));
            await assert.doesNotReject(relay.close(), 'close is idempotent');

            const wal = path.join(relay.dataDir, 'relay.db-wal');
            assert.ok(!fs.existsSync(wal) || fs.statSync(wal).size === 0, 'WAL checkpointed');
            const db = openDatabase(path.join(relay.dataDir, 'relay.db'));
            assert.ok(db.get("SELECT COUNT(*) AS n FROM audit WHERE action = 'cmd'").n >= 1, 'queued audit rows flushed');
            db.close();

            const refused = await request(relay, 'GET', '/api/health').catch((e) => e);
            assert.ok(refused instanceof Error, 'no longer accepting connections');
            removeDir(relay.dataDir);
            removed = true;
        } finally {
            if (!removed) {
                await relay.close();
                removeDir(relay.dataDir);
            }
        }
    }],
    ['close() waits for an in-flight download before closing the DB', async () => {
        const relay = await startRelay();
        try {
            const owner = await userWithSession(relay);
            const dev = await pairDevice(relay, owner);
            const body = Buffer.alloc(4 * 1024 * 1024, 0x47);
            const up = await request(relay, 'PUT', `/api/devices/${dev.deviceId}/files?name=big.nc`, { session: owner, body });
            assert.strictEqual(up.status, 201);
            const download = request(relay, 'GET', `/api/device/files/${up.json.transfer.transferId}`, { bearer: dev.credential });
            await new Promise((r) => setTimeout(r, 20));
            const closing = relay.close();
            const res = await download;
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.length, body.length);
            await closing;
        } finally {
            await relay.close();
            removeDir(relay.dataDir);
        }
    }],
]);
