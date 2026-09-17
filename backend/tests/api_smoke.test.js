'use strict';

const assert = require('assert');
const http = require('http');

async function smokeTest() {
    console.log('=== Running Live API Endpoint Smoke Tests ===');

    // Spawn server or test with supertest / native http against index.js
    // We can require backend/index.js if we set PORT to an ephemeral port
    process.env.PORT = '4099';
    // Suppress heavy logs during test
    process.env.NODE_ENV = 'test';

    const serverModule = require('../index.js');

    // Give express a moment to bind
    await new Promise((r) => setTimeout(r, 1200));

    function getJson(path) {
        return new Promise((resolve, reject) => {
            http.get(`http://127.0.0.1:4099${path}`, (res) => {
                let data = '';
                res.on('data', (c) => data += c);
                res.on('end', () => {
                    try {
                        resolve({ status: res.statusCode, body: JSON.parse(data) });
                    } catch (e) {
                        resolve({ status: res.statusCode, body: data });
                    }
                });
            }).on('error', reject);
        });
    }

    // 1. Test /api/remote/info
    console.log('Checking GET /api/remote/info...');
    const remoteInfo = await getJson('/api/remote/info');
    assert.strictEqual(remoteInfo.status, 200);
    assert(Array.isArray(remoteInfo.body.ips));
    assert.strictEqual(typeof remoteInfo.body.unifiedUrl, 'string');
    console.log('✓ /api/remote/info responded 200 with unifiedUrl:', remoteInfo.body.unifiedUrl);

    // 2. Test /api/remote/qr
    console.log('Checking GET /api/remote/qr...');
    const qrRes = await getJson('/api/remote/qr');
    assert.strictEqual(qrRes.status, 200);
    assert(qrRes.body.dataUrl.startsWith('data:image/png;base64,'));
    console.log('✓ /api/remote/qr generated valid QR code for:', qrRes.body.url);

    // 3. Test /api/firmware/info
    console.log('Checking GET /api/firmware/info...');
    const fwInfo = await getJson('/api/firmware/info');
    assert.strictEqual(fwInfo.status, 200);
    assert.strictEqual(fwInfo.body.board, 'STM32H723 (fw_m3)');
    assert.strictEqual(typeof fwInfo.body.latestVersion, 'string');
    assert(Array.isArray(fwInfo.body.changelog));
    console.log(`✓ /api/firmware/info responded 200: Latest v${fwInfo.body.latestVersion} (${fwInfo.body.board})`);

    console.log('All API Smoke Tests Passed!');
    process.exit(0);
}

smokeTest().catch((err) => {
    console.error('Smoke test failed:', err);
    process.exit(1);
});

// tests/run-all.js treats a run as finished only when it prints this line.
// These suites came from the remote-access branch, which ran them directly;
// they signal failure with a non-zero exit, so a clean exit means pass.
process.on('exit', (code) => { if (code === 0) console.log('ALL TESTS PASSED SUCCESSFULLY!'); });
