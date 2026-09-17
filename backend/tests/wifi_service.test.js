'use strict';

/**
 * WifiService: nmcli parsing, and the promise that the Wi-Fi password never
 * reaches a command line.
 *
 * nmcli is stubbed, so this runs on any machine (including the Windows dev PC)
 * without touching real networking.
 */
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';

const assert = require('assert');
const { EventEmitter } = require('events');
const { WifiService, splitTerse, explain } = require('../services/network/WifiService');

const quiet = { info() {}, warn() {}, error() {} };

/** execFile stub: answers from a map of "joined args" -> stdout. */
function fakeExecFile(replies) {
    const calls = [];
    const fn = (cmd, args, opts, cb) => {
        calls.push({ cmd, args });
        const key = args.join(' ');
        const reply = replies[key];
        if (reply === undefined) return process.nextTick(() => cb(new Error(`unexpected: ${key}`), '', 'not found'));
        if (reply instanceof Error) return process.nextTick(() => cb(reply, '', reply.message));
        process.nextTick(() => cb(null, reply, ''));
    };
    fn.calls = calls;
    return fn;
}

/** spawn stub: records argv and whatever was written to stdin. */
function fakeSpawn({ code = 0, stderr = '' } = {}) {
    const calls = [];
    const fn = (cmd, args) => {
        const child = new EventEmitter();
        const call = { cmd, args, stdin: '' };
        calls.push(call);
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.stdin = { end(data) { call.stdin += data === undefined ? '' : String(data); } };
        child.kill = () => {};
        process.nextTick(() => {
            if (stderr) child.stderr.emit('data', stderr);
            child.emit('close', code);
        });
        return child;
    };
    fn.calls = calls;
    return fn;
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('splitTerse unescapes nmcli -t fields, including SSIDs containing a colon', () => {
    assert.deepStrictEqual(splitTerse('wlan0:wifi:connected:Shop'), ['wlan0', 'wifi', 'connected', 'Shop']);
    assert.deepStrictEqual(splitTerse('*:Shop\\:5G:71:WPA2'), ['*', 'Shop:5G', '71', 'WPA2']);
    assert.deepStrictEqual(splitTerse('a\\\\b:c'), ['a\\b', 'c']);
});

test('getStatus reports the joined network, the radio and the ethernet fallback', async () => {
    const svc = new WifiService({
        logger: quiet,
        platform: 'linux',
        execFile: fakeExecFile({
            '-t -f DEVICE,TYPE,STATE,CONNECTION device status':
                'wlan0:wifi:connected:Shop\neth0:ethernet:connected:Wired connection 1\nlo:loopback:unmanaged:\n',
            '-t radio wifi': 'enabled\n',
            '-t -f IN-USE,SIGNAL,SECURITY device wifi list': '*:71:WPA2\n :44:WPA2\n',
            '-t -f IP4.ADDRESS device show': 'IP4.ADDRESS[1]:192.168.1.24/24\nIP4.ADDRESS[1]:10.0.0.5/24\n',
        }),
    });

    const status = await svc.getStatus();
    assert.strictEqual(status.supported, true);
    assert.strictEqual(status.radioOn, true);
    assert.strictEqual(status.device, 'wlan0');
    assert.deepStrictEqual(status.connected, { ssid: 'Shop', signal: 71, security: 'WPA2' });
    assert.deepStrictEqual(status.ethernet, { connected: true, name: 'Wired connection 1' });
    assert.deepStrictEqual(status.addresses, ['192.168.1.24', '10.0.0.5']);
});

test('getStatus is a plain "not here" when nmcli is missing or the OS owns Wi-Fi', async () => {
    const enoent = new Error('spawn nmcli ENOENT');
    enoent.code = 'ENOENT';
    const linux = new WifiService({
        logger: quiet,
        platform: 'linux',
        execFile: fakeExecFile({ '-t -f DEVICE,TYPE,STATE,CONNECTION device status': enoent }),
    });
    const missing = await linux.getStatus();
    assert.strictEqual(missing.supported, false);
    assert.match(missing.reason, /nmcli/i);

    const windows = new WifiService({ logger: quiet, platform: 'win32', execFile: fakeExecFile({}) });
    const unsupported = await windows.getStatus();
    assert.strictEqual(unsupported.supported, false);
    assert.match(unsupported.reason, /operating system/i);
});

test('scan collapses one SSID per network, keeps the strongest, marks saved and in-use', async () => {
    const svc = new WifiService({
        logger: quiet,
        platform: 'linux',
        execFile: fakeExecFile({
            '-t -f IN-USE,SSID,SIGNAL,SECURITY device wifi list --rescan yes':
                // Shop appears twice (2.4 + 5 GHz); the blank SSID is a hidden AP.
                '*:Shop:52:WPA2\n :Shop:78:WPA2\n :Cafe:64:\n :Old:20:WPA1 WPA2\n ::30:WPA2\n',
            '-t -f NAME,TYPE connection show':
                'Shop:802-11-wireless\nOld:802-11-wireless\nWired connection 1:802-3-ethernet\n',
        }),
    });

    const { ok, networks } = await svc.scan();
    assert.strictEqual(ok, true);
    assert.deepStrictEqual(networks.map((n) => n.ssid), ['Shop', 'Cafe', 'Old']);

    const shop = networks[0];
    assert.strictEqual(shop.signal, 78, 'keeps the strongest of the two bands');
    assert.strictEqual(shop.inUse, true, 'in-use survives the merge even on the weaker row');
    assert.strictEqual(shop.saved, true);

    const cafe = networks.find((n) => n.ssid === 'Cafe');
    assert.strictEqual(cafe.open, true);
    assert.strictEqual(cafe.security, 'Open');
    assert.strictEqual(cafe.saved, false);
});

test('connect sends the password on stdin and never puts it in argv', async () => {
    const spawn = fakeSpawn({ code: 0 });
    const svc = new WifiService({ logger: quiet, platform: 'linux', execFile: fakeExecFile({}), spawn });

    const result = await svc.connect({ ssid: 'Shop', password: 'hunter2-secret' });
    assert.deepStrictEqual(result, { ok: true, ssid: 'Shop' });

    const call = spawn.calls[0];
    assert.ok(!call.args.includes('hunter2-secret'), 'password must not be an argv entry');
    assert.ok(
        !call.args.join(' ').includes('hunter2-secret'),
        'password must not appear anywhere on the command line',
    );
    assert.ok(call.args.includes('--ask'), 'nmcli must be told to prompt so stdin is read');
    assert.strictEqual(call.stdin, 'hunter2-secret\n');
    assert.ok(call.args.includes('Shop'));
});

test('a saved network reconnects with no password and no stdin prompt', async () => {
    const spawn = fakeSpawn({ code: 0 });
    const svc = new WifiService({ logger: quiet, platform: 'linux', execFile: fakeExecFile({}), spawn });

    assert.deepStrictEqual(await svc.connect({ ssid: 'Shop' }), { ok: true, ssid: 'Shop' });
    assert.ok(!spawn.calls[0].args.includes('--ask'));
    assert.strictEqual(spawn.calls[0].stdin, '');
});

test('hidden networks pass "hidden yes"', async () => {
    const spawn = fakeSpawn({ code: 0 });
    const svc = new WifiService({ logger: quiet, platform: 'linux', execFile: fakeExecFile({}), spawn });
    await svc.connect({ ssid: 'Backroom', password: 'longenough', hidden: true });
    const args = spawn.calls[0].args.join(' ');
    assert.ok(/hidden yes/.test(args), args);
});

test('a bad password, a denied policy and a short password each explain themselves', async () => {
    const wrong = new WifiService({
        logger: quiet, platform: 'linux', execFile: fakeExecFile({}),
        spawn: fakeSpawn({ code: 4, stderr: 'Error: Connection activation failed: Secrets were required.' }),
    });
    const badPw = await wrong.connect({ ssid: 'Shop', password: 'totally-wrong' });
    assert.strictEqual(badPw.ok, false);
    assert.match(badPw.error, /password/i);

    const denied = new WifiService({
        logger: quiet, platform: 'linux', execFile: fakeExecFile({}),
        spawn: fakeSpawn({ code: 4, stderr: 'Error: Not authorized to control networking.' }),
    });
    const noPolkit = await denied.connect({ ssid: 'Shop', password: 'longenough' });
    assert.strictEqual(noPolkit.ok, false);
    assert.match(noPolkit.error, /not allowed|permission rule/i);

    // Caught locally: a sub-8-character WPA key can never work.
    const svc = new WifiService({ logger: quiet, platform: 'linux', execFile: fakeExecFile({}), spawn: fakeSpawn() });
    const short = await svc.connect({ ssid: 'Shop', password: 'abc' });
    assert.strictEqual(short.ok, false);
    assert.match(short.error, /8 characters/);

    const blank = await svc.connect({ ssid: '   ' });
    assert.strictEqual(blank.ok, false);
});

test('connect never hangs: a silent nmcli is killed and reported', async () => {
    const stuck = () => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.stdin = { end() {} };
        let killed = false;
        child.kill = () => { killed = true; child.emit('close', 143); };
        child.wasKilled = () => killed;
        return child;
    };
    const svc = new WifiService({ logger: quiet, platform: 'linux', execFile: fakeExecFile({}), spawn: stuck });
    svc._run = ((orig) => (args, stdin) => orig.call(svc, args, stdin, 40))(svc._run);

    const result = await svc.connect({ ssid: 'Shop', password: 'longenough' });
    assert.strictEqual(result.ok, false);
    assert.ok(result.error, 'a timeout still produces an operator-facing message');
});

test('forget and radio pass the right nmcli verbs', async () => {
    const execFile = fakeExecFile({
        'connection delete id Shop': '',
        'radio wifi off': '',
        'radio wifi on': '',
    });
    const svc = new WifiService({ logger: quiet, platform: 'linux', execFile });

    assert.deepStrictEqual(await svc.forget('Shop'), { ok: true });
    assert.deepStrictEqual(await svc.setRadio(false), { ok: true, radioOn: false });
    assert.deepStrictEqual(await svc.setRadio(true), { ok: true, radioOn: true });
});

test('explain() falls back to the caller message for anything unrecognised', () => {
    assert.strictEqual(explain('some novel failure', 'fallback text'), 'fallback text');
    assert.match(explain('No network with SSID "x" found', 'fallback'), /no longer in range/i);
});

async function main() {
    let failed = 0;
    for (const t of tests) {
        try {
            await t.fn();
            console.log(`  ok  ${t.name}`);
        } catch (err) {
            failed += 1;
            console.log(`  FAIL  ${t.name}`);
            console.log(err && err.stack ? err.stack : err);
        }
    }
    if (failed) {
        console.error(`\n${failed} of ${tests.length} failed`);
        process.exit(1);
    }
    console.log('ALL TESTS PASSED SUCCESSFULLY!');
}

main();
