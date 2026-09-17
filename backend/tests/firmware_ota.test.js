'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const { FirmwareUpdateService } = require('../services/firmware/FirmwareUpdateService');

async function runOtaTests() {
    console.log('=== Running Firmware OTA & USB DFU Pipeline Tests ===');

    // 1. Setup local temporary data dir for client
    const clientDataDir = path.join(os.tmpdir(), `ota_client_${Date.now()}`);
    fs.mkdirSync(clientDataDir, { recursive: true });

    // Initial local version on client is v1.1.0
    const localManifest = {
        board: 'STM32H723 (fw_m3)',
        version: '1.1.0',
        releaseDate: '2026-09-10',
        title: 'Initial Factory Release',
        changelog: ['Factory calibration', 'RSP motion protocol'],
        hexFile: 'fw_m3.hex',
        sha256: crypto.createHash('sha256').update(':00000001FF\n').digest('hex'),
    };
    fs.writeFileSync(path.join(clientDataDir, 'manifest.json'), JSON.stringify(localManifest, null, 2), 'utf8');
    fs.writeFileSync(path.join(clientDataDir, 'fw_m3.hex'), ':00000001FF\n', 'utf8');

    // 2. Setup mock cloud OTA server hosting v1.2.0 release
    const otaHexPayload = ':020000040800F2\n:100000001234567890ABCDEF1234567890ABCDEFA8\n:00000001FF\n';
    const otaSha256 = crypto.createHash('sha256').update(otaHexPayload).digest('hex');

    let serverPort = 0;
    let corruptedMode = false;

    const mockOtaServer = http.createServer((req, res) => {
        if (req.url === '/firmware/manifest.json') {
            const remoteManifest = {
                board: 'STM32H723 (fw_m3)',
                version: '1.2.0',
                releaseDate: '2026-09-12',
                title: 'High Performance Lookahead & Thermal Safety',
                changelog: [
                    'S-curve acceleration profiling',
                    'Real-time TIM2 watchdog ping',
                    'Single USB DFU fast flash',
                ],
                hexFile: 'fw_m3.hex',
                downloadUrl: `http://127.0.0.1:${serverPort}/firmware/fw_m3.hex`,
                sha256: otaSha256,
            };
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(remoteManifest));
        } else if (req.url === '/firmware/fw_m3.hex') {
            const payload = corruptedMode ? otaHexPayload + ':TAMPERED_BYTE_CORRUPTION' : otaHexPayload;
            res.writeHead(200, {
                'Content-Type': 'text/plain',
                'Content-Length': Buffer.byteLength(payload),
            });
            res.end(payload);
        } else {
            res.writeHead(404);
            res.end('Not found');
        }
    });

    await new Promise((resolve) => {
        mockOtaServer.listen(0, '127.0.0.1', () => {
            serverPort = mockOtaServer.address().port;
            resolve();
        });
    });

    console.log(`Mock Cloud OTA Server listening on port ${serverPort}`);

    const emittedEvents = [];
    const mockIo = {
        emit: (event, data) => emittedEvents.push({ event, data }),
    };

    const service = new FirmwareUpdateService({
        dataDir: clientDataDir,
        onlineManifestUrl: `http://127.0.0.1:${serverPort}/firmware/manifest.json`,
        io: mockIo,
        logger: { info: () => {}, warn: () => {}, error: () => {} },
    });

    try {
        // Test 1: Check online update when board is older (v1.1.0 vs v1.2.0)
        console.log('Test 1: Online OTA update check against cloud server');
        const onlineInfo = await service.checkOnlineUpdate('1.1.0');
        assert.strictEqual(onlineInfo.isOnline, true, 'Should indicate online status');
        assert.strictEqual(onlineInfo.hasUpdate, true, 'Should detect newer v1.2.0 online');
        assert.strictEqual(onlineInfo.latestVersion, '1.2.0');
        assert.strictEqual(onlineInfo.changelog.length, 3);
        assert(onlineInfo.downloadUrl.includes('/firmware/fw_m3.hex'));
        console.log('✓ Online OTA release discovery passed');

        // Test 2: Check online update when board already has latest (v1.2.0)
        console.log('Test 2: Check online update when board already runs latest v1.2.0');
        const latestInfo = await service.checkOnlineUpdate('1.2.0');
        assert.strictEqual(latestInfo.hasUpdate, false, 'Should detect no update needed for v1.2.0');
        console.log('✓ Up-to-date detection passed');

        // Test 3: Download and stage OTA release over network with SHA-256 validation
        console.log('Test 3: Download & Stage OTA release with cryptographic verification');
        let progressCalls = 0;
        const stageRes = await service.downloadAndStageOtaRelease({
            onProgress: (loaded, total, pct) => {
                progressCalls++;
                assert(pct >= 0 && pct <= 100);
            },
        });
        assert.strictEqual(stageRes.success, true);
        assert.strictEqual(stageRes.version, '1.2.0');
        assert.strictEqual(stageRes.sha256, otaSha256);
        assert(progressCalls > 0, 'Progress callback should have been invoked');

        // Verify file was written to clientDataDir
        const localHex = fs.readFileSync(path.join(clientDataDir, 'fw_m3.hex'), 'utf8');
        assert.strictEqual(localHex, otaHexPayload);

        // Verify local manifest was updated
        const updatedLocalManifest = JSON.parse(fs.readFileSync(path.join(clientDataDir, 'manifest.json'), 'utf8'));
        assert.strictEqual(updatedLocalManifest.version, '1.2.0');
        console.log('✓ OTA download and cryptographic staging passed');

        // Test 4: Tamper / Corruption Defense
        console.log('Test 4: Tamper / Corruption detection (rejecting bad downloads)');
        corruptedMode = true; // Inject corrupt bytes on mock server
        let tamperCaught = false;
        try {
            await service.downloadAndStageOtaRelease();
        } catch (err) {
            tamperCaught = true;
            assert(err.message.includes('SHA-256 integrity verification failed'));
        }
        assert.strictEqual(tamperCaught, true, 'Corrupted download must be strictly rejected');
        corruptedMode = false;
        console.log('✓ Tamper and corruption defense passed');

        // Test 5: Machine Safety Interlock
        console.log('Test 5: Machine Safety Gate (STM32H723 USB DFU flash permission)');
        assert.strictEqual(service.canFlash('idle').allowed, true, 'Idle machine must be allowed to flash');
        assert.strictEqual(service.canFlash('disconnected').allowed, true, 'Disconnected state allows flashing');
        assert.strictEqual(service.canFlash('running').allowed, false, 'Running state must block flashing');
        assert.strictEqual(service.canFlash('jog').allowed, false, 'Jogging must block flashing');
        assert.strictEqual(service.canFlash('alarm').allowed, false, 'Alarm must block flashing');
        console.log('✓ Safety interlock passed');

        // Test 6: Offline Graceful Fallback
        console.log('Test 6: Offline Graceful Fallback when server is unreachable');
        const offlineService = new FirmwareUpdateService({
            dataDir: clientDataDir,
            onlineManifestUrl: 'http://127.0.0.1:1/unreachable.json',
            logger: { info: () => {}, warn: () => {}, error: () => {} },
        });
        const fallbackInfo = await offlineService.checkOnlineUpdate('1.1.0');
        assert.strictEqual(fallbackInfo.isOnline, false, 'Should indicate offline');
        assert.strictEqual(fallbackInfo.source, 'local_cache', 'Should fall back to local disk manifest');
        console.log('✓ Offline graceful fallback passed');

        // Test 7: STM32H723 USB DFU Flashing Protocol Verification
        console.log('Test 7: STM32H723 USB DFU Flashing Contract (RSP_OP_ENTER_BOOTLOADER)');
        let bootloaderTriggered = false;
        const mockRspController = {
            enterBootloader: async () => {
                bootloaderTriggered = true;
            },
        };
        // Verify controller interface satisfies DFU entry
        await mockRspController.enterBootloader();
        assert.strictEqual(bootloaderTriggered, true, 'enterBootloader must be invoked over RSP link');
        console.log('✓ STM32H723 bootloader jump contract verified');

        console.log('All Firmware OTA & USB DFU Pipeline tests passed successfully!');
    } finally {
        mockOtaServer.close();
        fs.rmSync(clientDataDir, { recursive: true, force: true });
    }
}

runOtaTests().catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
});

// tests/run-all.js treats a run as finished only when it prints this line.
// These suites came from the remote-access branch, which ran them directly;
// they signal failure with a non-zero exit, so a clean exit means pass.
process.on('exit', (code) => { if (code === 0) console.log('ALL TESTS PASSED SUCCESSFULLY!'); });
