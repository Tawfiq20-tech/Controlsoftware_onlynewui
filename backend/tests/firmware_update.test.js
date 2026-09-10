'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { FirmwareUpdateService } = require('../services/firmware/FirmwareUpdateService');

async function runTests() {
    console.log('--- Running FirmwareUpdateService Tests ---');

    // Setup temporary test directory
    const testDir = path.join(os.tmpdir(), `fw_test_${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });

    const sampleHex = ':020000040800F2\n:1000000000000220010100080501000807010008A8\n:00000001FF\n';
    const sampleHexPath = path.join(testDir, 'fw_m3.hex');
    fs.writeFileSync(sampleHexPath, sampleHex, 'utf8');

    const crypto = require('crypto');
    const validSha = crypto.createHash('sha256').update(sampleHex).digest('hex');

    const sampleManifest = {
        board: 'STM32H723 (fw_m3)',
        version: '1.1.0',
        releaseDate: '2026-09-10',
        title: 'Safety Hardening & Async Motion Release',
        changelog: [
            'Hardware IWDG Watchdog enabled',
            'Async TIM2/TIM5 motion engine',
        ],
        hexFile: 'fw_m3.hex',
        sha256: validSha,
    };
    fs.writeFileSync(path.join(testDir, 'manifest.json'), JSON.stringify(sampleManifest, null, 2), 'utf8');

    const service = new FirmwareUpdateService({
        dataDir: testDir,
        logger: { info: () => {}, error: () => {} },
    });

    // Test 1: Version comparison
    console.log('Test 1: Version parsing & comparison');
    assert.strictEqual(service.compareVersions('1.1.0', '1.0.4'), 1, '1.1.0 should be > 1.0.4');
    assert.strictEqual(service.compareVersions('v1.0.4', '1.1.0'), -1, '1.0.4 should be < 1.1.0');
    assert.strictEqual(service.compareVersions('1.1.0', '1.1.0'), 0, '1.1.0 should be === 1.1.0');
    assert.strictEqual(service.compareVersions('1.2.0', '1.1.9'), 1, '1.2.0 should be > 1.1.9');
    console.log('✓ Version comparison passed');

    // Test 2: getFirmwareInfo with update available
    console.log('Test 2: getFirmwareInfo checks');
    const infoWithOlder = service.getFirmwareInfo('1.0.4');
    assert.strictEqual(infoWithOlder.hasUpdate, true, 'Should indicate update is available for 1.0.4');
    assert.strictEqual(infoWithOlder.latestVersion, '1.1.0');
    assert.strictEqual(infoWithOlder.changelog.length, 2);

    const infoWithSame = service.getFirmwareInfo('1.1.0');
    assert.strictEqual(infoWithSame.hasUpdate, false, 'Should indicate no update needed for 1.1.0');

    const infoWithNewer = service.getFirmwareInfo('1.2.0');
    assert.strictEqual(infoWithNewer.hasUpdate, false, 'Should indicate no update needed for newer 1.2.0');
    console.log('✓ getFirmwareInfo passed');

    // Test 3: Safety check
    console.log('Test 3: Machine safety gate checks');
    assert.strictEqual(service.canFlash('idle').allowed, true, 'Idle should allow flashing');
    assert.strictEqual(service.canFlash('disconnected').allowed, true, 'Disconnected should allow flashing');
    assert.strictEqual(service.canFlash('running').allowed, false, 'Running job should block flashing');
    assert.strictEqual(service.canFlash('hold').allowed, false, 'Hold state should block flashing');
    assert.strictEqual(service.canFlash('alarm').allowed, false, 'Alarm state should block flashing');
    console.log('✓ Machine safety checks passed');

    // Test 4: Official hex retrieval with valid SHA-256
    console.log('Test 4: In-memory hex retrieval and SHA-256 check');
    const hexData = await service.getOfficialHexData();
    assert.strictEqual(hexData, sampleHex, 'Returned hex should match file content');
    console.log('✓ SHA-256 verification passed');

    // Test 5: Corrupted hex detection
    console.log('Test 5: Detection of tampered / corrupted binary');
    fs.writeFileSync(sampleHexPath, sampleHex + ':0000000000\n', 'utf8'); // Tamper with hex
    let caught = false;
    try {
        await service.getOfficialHexData();
    } catch (e) {
        caught = true;
        assert(e.message.includes('SHA-256 integrity verification failed'), 'Error should indicate SHA-256 mismatch');
    }
    assert.strictEqual(caught, true, 'Corrupted binary must be rejected');
    console.log('✓ Tamper detection passed');

    // Test 6: Developer release deployment
    console.log('Test 6: Developer release deployment (deployRelease)');
    const newManifest = {
        board: 'STM32H723 (fw_m3)',
        version: '1.2.0',
        title: 'High-speed Lookahead Release',
        changelog: ['S-curve acceleration profiles'],
    };
    const newHex = ':020000040800F2\n:10000000FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFA8\n:00000001FF\n';
    service.deployRelease({ manifest: newManifest, hexData: newHex });

    const updatedInfo = service.getFirmwareInfo('1.1.0');
    assert.strictEqual(updatedInfo.latestVersion, '1.2.0', 'Latest version should now be 1.2.0');
    assert.strictEqual(updatedInfo.hasUpdate, true, '1.1.0 board should now have update available');

    const updatedHex = await service.getOfficialHexData();
    assert.strictEqual(updatedHex, newHex, 'Hex data should match deployed new binary');
    console.log('✓ Developer deployment passed');

    // Cleanup
    fs.rmSync(testDir, { recursive: true, force: true });
    console.log('All FirmwareUpdateService tests passed successfully!');
}

runTests().catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
});
