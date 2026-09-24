'use strict';

/**
 * Regression tests for the ship-blocking defects found in the pre-release
 * review. Each one asserts the behaviour the fix introduced, not the shape of
 * the fix, so a future refactor that reintroduces the fault fails here.
 *
 * Grouped by what the fault could do on a real machine:
 *   1. unexpected motion / a start that silently did not happen
 *   2. silent loss of the machine's configuration
 *   3. a headless kiosk with no way for the operator to recover
 */
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const results = [];
function test(name, fn) { results.push({ name, fn }); }

// ───────────────────────────────────────────────────────────────────────────
// 1. Motion: a remote start that reported success and never ran
// ───────────────────────────────────────────────────────────────────────────

const MachineAdapter = require('../services/cloudLink/MachineAdapter');

test('remote job.start on RSP plans gcode:startFresh, not the impossible line 0', () => {
    const steps = MachineAdapter.plan('RSP', 'job.start', {}, { content: undefined });
    assert.deepStrictEqual(
        steps.map((s) => [s.cmd, ...s.args]),
        [['gcode:startFresh']],
        'line 0 is outside every file: buildResumeProgram() rejected it and nothing ever started',
    );
    // Still on the run-time allowlist, or run() would refuse the step it just planned.
    assert.ok(MachineAdapter.ALLOWED_CMDS.includes('gcode:startFresh'));
});

test('remote job.start on Grbl is unchanged', () => {
    const steps = MachineAdapter.plan('Grbl', 'job.start', {}, { content: undefined });
    assert.deepStrictEqual(steps.map((s) => [s.cmd, ...s.args]), [['gcode:start']]);
});

test('MachineAdapter.run reports a refused start as an error, not ok', () => {
    const { EventEmitter } = require('events');
    const controller = new EventEmitter();
    const engine = {
        controller,
        _handleCommand(_sock, _id, cmd) {
            if (cmd === 'gcode:startFresh') {
                // What RSPController._refuse() does.
                controller.emit('error', { code: 'refused', message: 'Nothing was started: no file is loaded.', silent: true });
            }
        },
        _handleFileLoad() {},
    };
    const out = MachineAdapter.run(engine, { connId: 'test' }, MachineAdapter.plan('RSP', 'job.start', {}, {}));
    assert.strictEqual(out.ok, false, 'a start the controller refused must not be reported as accepted');
    assert.match(out.error, /no file is loaded/);
});

test('MachineAdapter.run still reports a start that was accepted', () => {
    const { EventEmitter } = require('events');
    const controller = new EventEmitter();
    let sent = null;
    const engine = {
        controller,
        _handleCommand(_sock, _id, cmd) { sent = cmd; },
        _handleFileLoad() {},
    };
    const out = MachineAdapter.run(engine, { connId: 'test' }, MachineAdapter.plan('RSP', 'job.start', {}, {}));
    assert.deepStrictEqual([out.ok, sent], [true, 'gcode:startFresh']);
});

// ───────────────────────────────────────────────────────────────────────────
// 2. Configuration: prototype pollution, and a power cut mid-write
// ───────────────────────────────────────────────────────────────────────────

const { ConfigStore } = require('../services/ConfigStore');

function tmpConfig() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));
    return { dir, file: path.join(dir, 'config.json') };
}

test('config.set cannot reach Object.prototype', () => {
    const { file } = tmpConfig();
    const store = new ConfigStore(file);
    store.set('__proto__.remoteDiagEnabled', true);
    store.set('preferences.__proto__.pwned', true);
    store.set('constructor.prototype.pwned', true);
    assert.strictEqual({}.remoteDiagEnabled, undefined, 'Object.prototype was written through a dotted key');
    assert.strictEqual({}.pwned, undefined);
    // And the poisoned read path: an inherited value must never be served as a setting.
    assert.strictEqual(store.get('preferences.remoteDiagEnabled', 'unset'), 'unset');
    assert.strictEqual(store.get('anything.toString', 'unset'), 'unset', 'get() must use own properties only');
    store.flush();
});

test('config.json survives a power cut: the write is atomic and the last good file is kept', () => {
    const { file } = tmpConfig();
    const store = new ConfigStore(file);
    store.set('probeSettings.blockThickness', 15);
    store.flush();
    store.set('probeSettings.blockThickness', 22);
    store.flush();

    assert.ok(fs.existsSync(`${file}.bak`), 'a backup of the previous good file is kept');
    assert.strictEqual(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf-8')).probeSettings.blockThickness, 15);
    assert.ok(!fs.existsSync(`${file}.tmp`), 'the temp file is renamed, never left behind');
});

test('a truncated config.json is recovered from the backup, not silently reset to defaults', () => {
    const { file } = tmpConfig();
    const first = new ConfigStore(file);
    first.set('probeSettings.blockThickness', 17);
    first.flush();
    first.set('preferences.safeHeight', 42);
    first.flush();                       // config.json now holds 17/42, .bak holds 17

    // What a power cut during the old in-place writeFileSync left behind.
    fs.writeFileSync(file, '{"probeSettings": {"blockThi');

    const second = new ConfigStore(file);
    assert.strictEqual(second.get('probeSettings.blockThickness'), 17, 'the operator probe geometry came back');
    const damaged = fs.readdirSync(path.dirname(file)).filter((f) => f.includes('.damaged-'));
    assert.strictEqual(damaged.length, 1, 'the damaged file is kept aside, never overwritten');
});

test('a config.json with __proto__ in it cannot poison the merge', () => {
    const { file } = tmpConfig();
    fs.writeFileSync(file, JSON.stringify({ __proto__: { pwned: true }, preferences: { units: 'in' } }));
    const store = new ConfigStore(file);
    assert.strictEqual({}.pwned, undefined);
    assert.strictEqual(store.get('preferences.units'), 'in', 'the rest of the file still loads');
    store.flush();
});

test('first boot seeds from the scrubbed factory file when one is there', () => {
    const { dir, file } = tmpConfig();
    fs.writeFileSync(
        path.join(dir, 'config.default.json'),
        JSON.stringify({ preferences: { safeHeight: 12, remoteDiagToken: '' } }),
    );
    const store = new ConfigStore(file);
    assert.strictEqual(store.get('preferences.safeHeight'), 12);
    assert.strictEqual(store.get('preferences.remoteDiagToken'), '');
    store.flush();
});

// ───────────────────────────────────────────────────────────────────────────
// 3. Kiosk: Wi-Fi dead ends on a machine with no terminal
// ───────────────────────────────────────────────────────────────────────────

const { WifiService } = require('../services/network/WifiService');
const quiet = { info() {}, warn() {}, error() {} };

function nmcliStub(replies) {
    return (cmd, args, opts, cb) => {
        const key = args.join(' ');
        const reply = replies[key];
        if (reply instanceof Error) return process.nextTick(() => cb(reply, '', reply.message));
        if (reply === undefined) return process.nextTick(() => cb(new Error('unexpected'), '', 'unexpected'));
        process.nextTick(() => cb(null, reply, ''));
    };
}

test('NetworkManager stopped is said so, not reported as a missing adapter', async () => {
    const down = new Error('Command failed');
    down.code = 8;
    down.message = 'Error: NetworkManager is not running.';
    const svc = new WifiService({
        logger: quiet,
        platform: 'linux',
        execFile: nmcliStub({ '-t -f DEVICE,TYPE,STATE,CONNECTION device status': down }),
    });
    const status = await svc.getStatus();
    assert.strictEqual(status.supported, false, 'was reported as supported with hasAdapter false -- a dead end');
    assert.match(status.reason, /NetworkManager is not running/i);
    assert.match(status.reason, /Restart the machine/i, 'the operator is told what to do next');
});

test('the in-use flag survives dedup when nmcli lists the stronger radio first', async () => {
    const svc = new WifiService({
        logger: quiet,
        platform: 'linux',
        execFile: nmcliStub({
            // nmcli's real ordering: strongest first. The in-use row is the weaker band.
            '-t -f IN-USE,SSID,SIGNAL,SECURITY device wifi list --rescan yes': ' :Shop:78:WPA2\n*:Shop:52:WPA2\n',
            '-t -f NAME,TYPE connection show': 'Shop:802-11-wireless\n',
        }),
    });
    const { networks } = await svc.scan();
    assert.strictEqual(networks.length, 1);
    assert.strictEqual(networks[0].signal, 78);
    assert.strictEqual(networks[0].inUse, true, 'the screen showed Connect for the network it was already on');
    assert.strictEqual(networks[0].saved, true);
});

test('loopback and link-local are not advertised as addresses the machine is reachable at', async () => {
    const svc = new WifiService({
        logger: quiet,
        platform: 'linux',
        execFile: nmcliStub({
            '-t -f IP4.ADDRESS device show':
                'IP4.ADDRESS[1]:127.0.0.1/8\nIP4.ADDRESS[1]:169.254.8.31/16\nIP4.ADDRESS[1]:192.168.1.40/24\n',
        }),
    });
    assert.deepStrictEqual(await svc._addresses(), ['192.168.1.40']);
});

test('a typed password is offered to nmcli even for a network it already has a profile for', async () => {
    const { EventEmitter } = require('events');
    const calls = [];
    const spawn = (cmd, args) => {
        const child = new EventEmitter();
        const call = { args, stdin: '' };
        calls.push(call);
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.stdin = { end(data) { call.stdin += data === undefined ? '' : String(data); } };
        child.kill = () => {};
        process.nextTick(() => child.emit('close', 0));
        return child;
    };
    const svc = new WifiService({ logger: quiet, platform: 'linux', spawn });
    await svc.connect({ ssid: 'Shop', password: 'newpassword' });
    assert.ok(calls[0].args.includes('--ask'), 'without --ask nmcli reuses the stale PSK for ever');
    assert.ok(!calls[0].args.includes('newpassword'), 'the password must never reach argv');
    assert.strictEqual(calls[0].stdin, 'newpassword\n');
});

// ───────────────────────────────────────────────────────────────────────────
// 4. Whole-class guard: every event the backend sends on connect must have a
//    matching socket.on in the frontend's controller bridge.
// ───────────────────────────────────────────────────────────────────────────

test('every event backendConnection listens for is bridged by controller.ts', () => {
    const dir = path.join(__dirname, '..', '..', 'frontend', 'src', 'utils');
    if (!fs.existsSync(dir)) return;   // backend-only checkout
    const bridge = fs.readFileSync(path.join(dir, 'controller.ts'), 'utf-8');
    const wiring = fs.readFileSync(path.join(dir, 'backendConnection.ts'), 'utf-8');

    // controller.on() takes `ControllerEventName | string`, so a handler for an
    // event controller.ts never subscribes to on the socket type-checks, runs,
    // and is simply never called -- health:power died exactly this way and the
    // under-voltage banner could not appear at all, on any machine.
    const wanted = new Set();
    for (const m of wiring.matchAll(/controller\.on\(\s*'([a-zA-Z0-9:_-]+)'/g)) wanted.add(m[1]);
    assert.ok(wanted.has('health:power'), 'sanity check: the scan found the handlers');

    const bridged = new Set();
    for (const m of bridge.matchAll(/this\.socket\.on\(\s*'([a-zA-Z0-9:_-]+)'/g)) bridged.add(m[1]);
    // Some are forwarded by the REMOTE_EVENTS / generic loops instead.
    for (const m of bridge.matchAll(/^\s*'([a-zA-Z0-9:_-]+)',\s*$/gm)) bridged.add(m[1]);
    // Emitted by the Controller itself, not relayed from the socket.
    const selfEmitted = new Set(['connect', 'disconnect', 'connect_error', 'error']);

    const missing = [...wanted].filter((ev) => !bridged.has(ev) && !selfEmitted.has(ev));
    assert.deepStrictEqual(
        missing, [],
        `nothing on the socket ever reaches these handlers, so the feature is inert: ${missing.join(', ')}`,
    );
});

// ───────────────────────────────────────────────────────────────────────────

(async () => {
    console.log('Product hardening regressions...');
    for (const { name, fn } of results) {
        await fn();
        console.log(`  ok  ${name}`);
    }
    console.log('ALL TESTS PASSED SUCCESSFULLY!');
    process.exit(0);
})().catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
});
