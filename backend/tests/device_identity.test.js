'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DeviceIdentity, isTrivialCode } = require('../services/remoteAccess/DeviceIdentity');
const { RemoteAccessService } = require('../services/remoteAccess/RemoteAccessService');

class MockConfigStore {
    constructor() { this.store = {}; }
    get(key, def) { return this.store[key] !== undefined ? this.store[key] : def; }
    set(key, value) { this.store[key] = value; }
    delete(key) { delete this.store[key]; }
}

function spyLogger() {
    const lines = [];
    const log = (level) => (msg) => lines.push(`${level}: ${msg}`);
    return { lines, debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') };
}

/** Real RemoteAccessService with a setPin call counter. */
function spyRas() {
    const ras = new RemoteAccessService({ configStore: new MockConfigStore(), port: 4000 });
    ras.setPinCalls = [];
    const realSetPin = ras.setPin.bind(ras);
    ras.setPin = (pin, opts) => {
        ras.setPinCalls.push({ pin, opts });
        return realSetPin(pin, opts);
    };
    return ras;
}

let tick = 1789500000000;
const now = () => ++tick;

async function runTests() {
    console.log('=== DeviceIdentity Tests ===');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'device-identity-'));
    let n = 0;
    const freshFile = () => path.join(root, `case${++n}`, 'device-identity.json');
    try {
        // First run
        {
            const file = freshFile();
            const logger = spyLogger();
            const id = new DeviceIdentity({ file, logger, now }).load();
            assert(fs.existsSync(file), 'file created on first run');
            assert(/^[0-9a-f]{12}$/.test(id.getDeviceId()), '12 lowercase hex id');
            assert.strictEqual(id.getShortId(), id.getDeviceId().slice(0, 6));
            assert(/^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/.test(id.getDisplayId()));
            assert.strictEqual(id.getDisplayId().replace(/-/g, '').toLowerCase(), id.getDeviceId());
            assert.strictEqual(id.getName(), `Onefinity ${id.getDisplayId().slice(0, 4)}`);
            assert.strictEqual(id.mdnsHostname(), `onefinity-${id.getShortId()}.local`);
            assert(/^\d{8}$/.test(id.getAccessCode()), '8 digit access code');
            assert(!isTrivialCode(id.getAccessCode()));
            assert.strictEqual(id.isLanOnly(), false);
            assert.strictEqual(id.wasCorruptRecovered(), false);
            const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
            assert.strictEqual(saved.version, 1);
            assert.strictEqual(saved.deviceId, id.getDeviceId());
            assert.strictEqual(saved.accessCode, id.getAccessCode());
            assert.strictEqual(typeof saved.createdAt, 'number');
            assert.strictEqual(typeof saved.accessCodeCreatedAt, 'number');
            assert(!logger.lines.some((l) => l.includes(id.getAccessCode())), 'access code never logged');

            // No PIN → the access code becomes the PIN.
            const ras = spyRas();
            assert.strictEqual(id.syncPin(ras), true);
            assert.strictEqual(id.isAccessCodeActive(), true, 'no PIN → accessCodeActive');
            assert.strictEqual(ras.setPinCalls.length, 1);
            assert.deepStrictEqual(ras.setPinCalls[0].opts, { source: 'access-code' });
            assert.strictEqual(ras.verifyPinRaw(id.getAccessCode()), true);
            assert.strictEqual(ras.getPinSource(), 'access-code');
            // Code already verifies → no second setPin (sessions survive boot).
            const tokenBefore = ras.issueToken('192.168.1.9');
            const again = new DeviceIdentity({ file, now }).load();
            assert.strictEqual(again.syncPin(ras), false);
            assert.strictEqual(ras.setPinCalls.length, 1, 'syncPin calls setPin only when the code does not verify');
            assert.strictEqual(ras.verifyToken(tokenBefore), true);
        }
        console.log('✓ first run creates id, code and applies the no-PIN rule');

        // First run with an existing custom PIN keeps it.
        {
            const file = freshFile();
            const ras = spyRas();
            ras.setPin('999111');
            ras.setPinCalls.length = 0;
            const id = new DeviceIdentity({ file, now }).load();
            assert.strictEqual(id.syncPin(ras), false);
            assert.strictEqual(id.isAccessCodeActive(), false, 'existing PIN → accessCodeActive false');
            assert.strictEqual(ras.setPinCalls.length, 0, 'custom PIN untouched');
            assert.strictEqual(ras.verifyPinRaw('999111'), true);
            const reloaded = new DeviceIdentity({ file, now }).load();
            assert.strictEqual(reloaded.isAccessCodeActive(), false, 'first-run decision persisted');
            // Later boots do not re-apply the first-run rule.
            ras.clearPin();
            reloaded.syncPin(ras);
            assert.strictEqual(ras.setPinCalls.length, 0, 'inactive code never set as PIN');
        }
        console.log('✓ first run with a custom PIN keeps it');

        // Crash between load() and syncPin(): the persisted marker still applies the rule.
        {
            const file = freshFile();
            const first = new DeviceIdentity({ file, now }).load();
            assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).firstRunPending, true, 'pending decision persisted');
            assert(!('firstRunPending' in first.getPublicView()));
            // Process dies here; next boot builds a new instance.
            const ras = spyRas();
            const reboot = new DeviceIdentity({ file, now }).load();
            assert.strictEqual(reboot.syncPin(ras), true);
            assert.strictEqual(ras.setPinCalls.length, 1, 'no PIN after a crash → access code becomes the PIN');
            assert.deepStrictEqual(ras.setPinCalls[0].opts, { source: 'access-code' });
            assert.strictEqual(reboot.isAccessCodeActive(), true);
            assert(!('firstRunPending' in JSON.parse(fs.readFileSync(file, 'utf8'))), 'marker cleared once applied');
            assert.strictEqual(new DeviceIdentity({ file, now }).load().isAccessCodeActive(), true);

            // Same crash with a custom PIN: still protected.
            const file2 = freshFile();
            new DeviceIdentity({ file: file2, now }).load();
            const custom = spyRas();
            custom.setPin('999111');
            custom.setPinCalls.length = 0;
            const reboot2 = new DeviceIdentity({ file: file2, now }).load();
            assert.strictEqual(reboot2.syncPin(custom), false);
            assert.strictEqual(custom.setPinCalls.length, 0, 'custom PIN survives a crashed first run');
            assert.strictEqual(reboot2.isAccessCodeActive(), false);
            const saved2 = JSON.parse(fs.readFileSync(file2, 'utf8'));
            assert.strictEqual(saved2.accessCodeActive, false);
            assert(!('firstRunPending' in saved2));
        }
        console.log('✓ first-run decision survives a crash before syncPin');

        // Stable across reloads; regenerate changes only the code.
        {
            const file = freshFile();
            const changes = [];
            const a = new DeviceIdentity({ file, now }).load();
            a.on('change', (v) => changes.push(v));
            const ras = spyRas();
            a.syncPin(ras);
            const b = new DeviceIdentity({ file, now }).load();
            assert.strictEqual(b.getDeviceId(), a.getDeviceId(), 'id stable across reloads');
            assert.strictEqual(b.getAccessCode(), a.getAccessCode());
            assert.strictEqual(b.getName(), a.getName());
            const before = JSON.parse(fs.readFileSync(file, 'utf8'));
            const oldCode = a.getAccessCode();
            a.setAccessCodeActive(false);
            const code = a.regenerateAccessCode();
            assert(/^\d{8}$/.test(code));
            assert.notStrictEqual(code, oldCode, 'regenerate changes the code');
            assert.strictEqual(a.isAccessCodeActive(), true, 'regenerate sets active');
            const after = JSON.parse(fs.readFileSync(file, 'utf8'));
            assert.strictEqual(after.accessCode, code);
            for (const key of ['deviceId', 'name', 'createdAt', 'lanOnly', 'version']) {
                assert.deepStrictEqual(after[key], before[key], `regenerate leaves ${key} unchanged`);
            }
            assert(after.accessCodeCreatedAt > before.accessCodeCreatedAt);
            // Caller then syncs the PIN.
            ras.setPin(code, { source: 'access-code' });
            assert.strictEqual(ras.verifyPinRaw(code), true);
            assert(changes.length >= 1);
            assert(changes.every((v) => !JSON.stringify(v).includes(code) && !JSON.stringify(v).includes(oldCode)), 'change events carry no code');

            a.setName('  Shop CNC  ');
            assert.strictEqual(a.getName(), 'Shop CNC');
            assert.throws(() => a.setName(''), /invalid_name/);
            assert.throws(() => a.setName('x'.repeat(61)), /invalid_name/);
            assert.throws(() => a.setName(42), /invalid_name/);
            assert.strictEqual(new DeviceIdentity({ file, now }).load().getName(), 'Shop CNC');
        }
        console.log('✓ id stable across reloads; regenerate changes the code only');

        // Trivial codes are skipped.
        {
            const seq = [0, 11111111, 12345678, 87654321, 99999999, 4817362];
            const id = new DeviceIdentity({ file: freshFile(), now, randomInt: () => seq.shift() }).load();
            assert.strictEqual(id.getAccessCode(), '04817362', 'padded, trivial values rejected');
            assert.strictEqual(isTrivialCode('00000000'), true);
            assert.strictEqual(isTrivialCode('12345678'), true);
            assert.strictEqual(isTrivialCode('87654321'), true);
            assert.strictEqual(isTrivialCode('04817362'), false);
            // Regenerate never returns the same code.
            const seq2 = [4817362, 4817362, 5550123];
            const r = new DeviceIdentity({ file: freshFile(), now, randomInt: () => (seq2.length ? seq2.shift() : 1234567) });
            r.load();
            assert.strictEqual(r.getAccessCode(), '04817362');
            assert.strictEqual(r.regenerateAccessCode(), '05550123');
            // Deterministic id from injected randomBytes.
            const fixed = new DeviceIdentity({ file: freshFile(), now, randomBytes: () => Buffer.from('3f9a1c07b2e4', 'hex') }).load();
            assert.strictEqual(fixed.getDeviceId(), '3f9a1c07b2e4');
            assert.strictEqual(fixed.getDisplayId(), '3F9A-1C07-B2E4');
            assert.strictEqual(fixed.getName(), 'Onefinity 3F9A');
            assert.strictEqual(fixed.mdnsHostname(), 'onefinity-3f9a1c.local');
        }
        console.log('✓ access code generation skips trivial codes');

        // Atomic write: a leftover .tmp is ignored.
        {
            const file = freshFile();
            const a = new DeviceIdentity({ file, now }).load();
            assert(!fs.existsSync(`${file}.tmp`), 'no tmp left after a write');
            assert(fs.existsSync(`${file}.bak`), '.bak written');
            fs.writeFileSync(`${file}.tmp`, '{"version":1,"deviceId":"000000000000","accessCode":"1234');
            const b = new DeviceIdentity({ file, now }).load();
            assert.strictEqual(b.getDeviceId(), a.getDeviceId(), 'crash leftover .tmp is ignored');
            // Crash between .bak copy and rename: main missing, .bak holds the new state.
            const c = new DeviceIdentity({ file, now }).load();
            c.setLanOnly(true);
            fs.unlinkSync(file);
            const d = new DeviceIdentity({ file, now }).load();
            assert.strictEqual(d.getDeviceId(), a.getDeviceId(), 'main missing + good .bak → restored');
            assert.strictEqual(d.isLanOnly(), true);
            assert(fs.existsSync(file), 'main rewritten from .bak');
            assert.strictEqual(d.wasCorruptRecovered(), false);
        }
        console.log('✓ atomic write (leftover .tmp ignored)');

        // Corrupt main + good .bak → recovers.
        {
            const file = freshFile();
            const a = new DeviceIdentity({ file, now }).load();
            fs.writeFileSync(file, '{ not json');
            const logger = spyLogger();
            const b = new DeviceIdentity({ file, logger, now }).load();
            assert.strictEqual(b.getDeviceId(), a.getDeviceId(), 'recovered from .bak');
            assert.strictEqual(b.wasCorruptRecovered(), true);
            assert.strictEqual(b.getPublicView().corruptRecovered, true);
            const dir = fs.readdirSync(path.dirname(file));
            assert(dir.some((f) => /^device-identity\.json\.corrupt-\d+$/.test(f)), 'corrupt main renamed aside');
            assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).deviceId, a.getDeviceId(), 'main rewritten');
            // Structurally invalid JSON counts as corrupt too.
            fs.writeFileSync(file, JSON.stringify({ version: 1, deviceId: 'XYZ', accessCode: '1' }));
            assert.strictEqual(new DeviceIdentity({ file, now }).load().getDeviceId(), a.getDeviceId());
        }
        console.log('✓ corrupt main + good .bak recovers');

        // Both corrupt → throws, renames both; second load creates fresh.
        {
            const file = freshFile();
            const a = new DeviceIdentity({ file, now }).load();
            fs.writeFileSync(file, 'garbage');
            fs.writeFileSync(`${file}.bak`, 'garbage too');
            const id = new DeviceIdentity({ file, now });
            assert.throws(() => id.load(), (err) => err.message === 'device_identity_corrupt');
            const dir = fs.readdirSync(path.dirname(file));
            assert(!dir.includes('device-identity.json'), 'main renamed');
            assert(!dir.includes('device-identity.json.bak'), '.bak renamed');
            assert(dir.some((f) => /^device-identity\.json\.corrupt-\d+$/.test(f)));
            assert(dir.some((f) => /^device-identity\.json\.bak\.corrupt-\d+$/.test(f)));
            assert.doesNotThrow(() => id.load(), 'second load does not throw');
            assert(/^[0-9a-f]{12}$/.test(id.getDeviceId()));
            assert.notStrictEqual(id.getDeviceId(), a.getDeviceId(), 'fresh identity');
            assert.strictEqual(id.wasCorruptRecovered(), true);
            assert(fs.existsSync(file));
        }
        console.log('✓ both corrupt → throws device_identity_corrupt, retry creates a fresh identity');

        // Main missing + corrupt .bak → fresh identity.
        {
            const file = freshFile();
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(`${file}.bak`, ' ');
            const id = new DeviceIdentity({ file, now }).load();
            assert(/^[0-9a-f]{12}$/.test(id.getDeviceId()));
            assert.strictEqual(id.wasCorruptRecovered(), true);
            assert(fs.readdirSync(path.dirname(file)).some((f) => /^device-identity\.json\.bak\.corrupt-\d+$/.test(f)));
        }
        console.log('✓ main missing + corrupt .bak → fresh identity');

        // Retry on a NEW instance (or after a restart) still reports the recovery.
        {
            const file = freshFile();
            new DeviceIdentity({ file, now }).load();
            fs.writeFileSync(file, 'garbage');
            fs.writeFileSync(`${file}.bak`, 'garbage too');
            assert.throws(() => new DeviceIdentity({ file, now }).load(), /device_identity_corrupt/);
            const retry = new DeviceIdentity({ file, now }).load();
            assert.strictEqual(retry.wasCorruptRecovered(), true, 'quarantined files mark the fresh identity as recovered');
            assert.strictEqual(retry.getPublicView().corruptRecovered, true);
        }
        console.log('✓ corruptRecovered survives a retry on another instance');

        // I/O failures are not corruption: nothing is renamed, deleted or replaced.
        {
            const realRead = fs.readFileSync;
            const realRename = fs.renameSync;
            const realOpen = fs.openSync;
            const lockError = (code) => Object.assign(new Error(code), { code });
            try {
                // Locked main file (persistent) → device_identity_unreadable, files untouched.
                const file = freshFile();
                const a = new DeviceIdentity({ file, now }).load();
                const before = fs.readFileSync(file, 'utf8');
                fs.readFileSync = function (p, ...rest) {
                    if (p === file) throw lockError('EBUSY');
                    return realRead.call(fs, p, ...rest);
                };
                assert.throws(() => new DeviceIdentity({ file, now }).load(), (err) => err.message === 'device_identity_unreadable' && err.code === 'EBUSY');
                fs.readFileSync = realRead;
                assert.strictEqual(fs.readFileSync(file, 'utf8'), before, 'locked valid file left intact');
                assert(!fs.readdirSync(path.dirname(file)).some((f) => f.includes('.corrupt-')), 'nothing quarantined');

                // Transient lock → retried and loaded.
                let failures = 1;
                fs.readFileSync = function (p, ...rest) {
                    if (p === file && failures-- > 0) throw lockError('EPERM');
                    return realRead.call(fs, p, ...rest);
                };
                assert.strictEqual(new DeviceIdentity({ file, now }).load().getDeviceId(), a.getDeviceId(), 'transient lock retried');
                fs.readFileSync = realRead;

                // Corrupt main + good .bak, but the rename is blocked → loads from .bak, main not overwritten.
                fs.writeFileSync(file, '{ corrupt');
                fs.renameSync = function (from, to) {
                    if (String(to).includes('.corrupt-')) throw lockError('EACCES');
                    return realRename.call(fs, from, to);
                };
                const fromBak = new DeviceIdentity({ file, now }).load();
                assert.strictEqual(fromBak.getDeviceId(), a.getDeviceId());
                assert.strictEqual(fs.readFileSync(file, 'utf8'), '{ corrupt', 'corrupt main neither deleted nor overwritten');

                // Both corrupt and the rename is blocked → unreadable, both files kept.
                fs.writeFileSync(`${file}.bak`, 'garbage');
                assert.throws(() => new DeviceIdentity({ file, now }).load(), /device_identity_unreadable/);
                assert(fs.existsSync(file) && fs.existsSync(`${file}.bak`), 'no delete when rename fails');
                fs.renameSync = realRename;

                // Main missing + valid .bak, write fails → load() still succeeds from .bak.
                const file2 = freshFile();
                const b = new DeviceIdentity({ file: file2, now }).load();
                fs.unlinkSync(file2);
                fs.openSync = function (p, ...rest) {
                    if (String(p).startsWith(file2)) throw lockError('EROFS');
                    return realOpen.call(fs, p, ...rest);
                };
                const logger = spyLogger();
                const restored = new DeviceIdentity({ file: file2, logger, now });
                assert.doesNotThrow(() => restored.load(), 'restore write failure does not fail boot');
                assert.strictEqual(restored.getDeviceId(), b.getDeviceId());
                assert(logger.lines.some((l) => l.startsWith('error') && l.includes('EROFS')));
            } finally {
                fs.readFileSync = realRead;
                fs.renameSync = realRename;
                fs.openSync = realOpen;
            }
        }
        console.log('✓ I/O errors are not treated as corruption');

        // Public view never includes the code.
        {
            const id = new DeviceIdentity({ file: freshFile(), now }).load();
            const view = id.getPublicView();
            assert.deepStrictEqual(Object.keys(view).sort(), ['accessCodeActive', 'deviceId', 'displayId', 'lanOnly', 'mdnsHostname', 'name']);
            assert(!JSON.stringify(view).includes(id.getAccessCode()), 'no code in public view');
            assert.throws(() => new DeviceIdentity({ file: freshFile() }).getDeviceId(), /not_loaded/);
        }
        console.log('✓ getPublicView has no code');

        // syncPin: code active but PIN changed elsewhere → setPin once; inactive → nothing.
        {
            const id = new DeviceIdentity({ file: freshFile(), now }).load();
            const ras = spyRas();
            id.syncPin(ras);
            assert.strictEqual(ras.setPinCalls.length, 1);
            id.syncPin(ras);
            id.syncPin(ras);
            assert.strictEqual(ras.setPinCalls.length, 1, 'verifying code → no setPin');
            ras.config.set('remoteAccess.pinHash', 'deadbeef:cafe');
            assert.strictEqual(id.syncPin(ras), true);
            assert.strictEqual(ras.setPinCalls.length, 2, 'non-verifying code → setPin');
            id.setAccessCodeActive(false);
            ras.config.set('remoteAccess.pinHash', 'deadbeef:cafe');
            assert.strictEqual(id.syncPin(ras), false);
            assert.strictEqual(ras.setPinCalls.length, 2, 'inactive → no setPin');
            // Use access code again.
            id.setAccessCodeActive(true);
            id.syncPin(ras);
            assert.strictEqual(ras.setPinCalls.length, 3);
            assert.strictEqual(ras.verifyPinRaw(id.getAccessCode()), true);

            // Identity lost while the PIN was an old access code → the new code replaces it.
            const lost = spyRas();
            lost.setPin('55501234', { source: 'access-code' });
            lost.setPinCalls.length = 0;
            const fresh = new DeviceIdentity({ file: freshFile(), now }).load();
            fresh.syncPin(lost);
            assert.strictEqual(fresh.isAccessCodeActive(), true);
            assert.strictEqual(lost.setPinCalls.length, 1);
        }
        console.log('✓ syncPin calls setPin only when the code does not verify');

        // LAN-only persists and emits change.
        {
            const file = freshFile();
            const id = new DeviceIdentity({ file, now }).load();
            const events = [];
            id.on('change', (v) => events.push(v));
            id.setLanOnly(true);
            assert.strictEqual(id.isLanOnly(), true);
            assert.strictEqual(events.length, 1, 'change emitted');
            assert.strictEqual(events[0].lanOnly, true);
            assert.strictEqual(events[0].deviceId, id.getDeviceId());
            assert(!('accessCode' in events[0]));
            id.setLanOnly(true);
            assert.strictEqual(events.length, 1, 'no event when unchanged');
            assert.strictEqual(new DeviceIdentity({ file, now }).load().isLanOnly(), true, 'LAN-only persisted');
            id.setLanOnly(false);
            assert.strictEqual(events.length, 2);
            assert.strictEqual(new DeviceIdentity({ file, now }).load().isLanOnly(), false);
        }
        console.log('✓ LAN-only persists and emits change');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
    console.log('All DeviceIdentity tests passed');
}

const timeout = setTimeout(() => {
    console.error('Test timed out');
    process.exit(1);
}, 30000);
timeout.unref();

runTests().then(() => process.exit(0)).catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
});

// tests/run-all.js treats a run as finished only when it prints this line.
// These suites came from the remote-access branch, which ran them directly;
// they signal failure with a non-zero exit, so a clean exit means pass.
process.on('exit', (code) => { if (code === 0) console.log('ALL TESTS PASSED SUCCESSFULLY!'); });
