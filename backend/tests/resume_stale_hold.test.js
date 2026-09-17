'use strict';

/**
 * A HOLD status frame built by the firmware before it applied OP_RESUME, but
 * delivered after the host cleared job.paused, must not re-pause the job
 * (Phase 1 D6-1 / D1-F5: "The machine is on feed hold. Press Resume" right
 * after Resume, the machine sitting still until Resume was pressed again).
 * A hold reported after the firmware answered OP_RESUME still pauses.
 */

process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';
process.env.NO_BROWSER = '1';

const { mock } = require('node:test');
mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 1_700_000_000_000 });

const assert = require('assert');
const defs = require('../services/rsp/defs');
const { RSPController } = require('../services/controllers/RSPController');
const { FakeFirmware, FakeConnection } = require('./helpers/fakeFirmware');

const flush = () => new Promise((r) => setImmediate(r));
async function advance(ms, step = 5) {
    for (let t = 0; t < ms; t += step) { mock.timers.tick(step); await flush(); }
}
async function until(pred, maxMs, what, step = 5) {
    for (let t = 0; t <= maxMs; t += step) {
        if (pred()) return t;
        mock.timers.tick(step);
        await flush();
    }
    throw new Error(`timed out waiting for: ${what}`);
}

function program(n) {
    const out = ['G21', 'G90', 'G0 Z5', 'G0 X0 Y0', 'G1 Z-1 F600'];
    for (let i = 1; i <= n; i++) out.push(`G1 X${(i % 2 ? 40 : 0)} Y${(i * 0.5).toFixed(3)} F1000`);
    out.push('G0 Z5', 'M2');
    return out.join('\n');
}

async function testStaleHoldAfterResume() {
    const fw = new FakeFirmware({ legTimeScale: 0.05 });
    const conn = new FakeConnection(fw);
    const ctrl = new RSPController();
    ctrl.on('error', () => {});
    const consoleLines = [];
    ctrl.on('console', (m) => consoleLines.push(m));
    ctrl.bind(conn);
    let lastHold = null;
    ctrl.stream.on('status', (d) => { if (d.state === defs.ST_HOLD) lastHold = { ...d }; });
    await advance(300);
    ctrl.command('gcode:load', 'a.nc', program(120));
    ctrl.command('gcode:start');
    await until(() => ctrl.job.active && ctrl.job.nextLineToRun() > 20, 600000, 'job underway');
    ctrl.command('gcode:pause');
    await until(() => lastHold && fw.state === defs.ST_HOLD, 60000, 'firmware holding');

    // Hold the OP_RESUME reply back, as USB round-trip latency does.
    const realSend = ctrl.stream.sendCommand.bind(ctrl.stream);
    let releaseResume = null;
    ctrl.stream.sendCommand = (op, payload, opts) => {
        if (op !== defs.OP_RESUME) return realSend(op, payload, opts);
        return new Promise((resolve, reject) => {
            releaseResume = () => realSend(op, payload, opts).then(resolve, reject);
        });
    };
    ctrl.command('gcode:resume');
    assert.strictEqual(ctrl.job.paused, false, 'Resume clears the host pause');
    assert.ok(releaseResume, 'OP_RESUME was sent');
    // The status frame the firmware built before it saw OP_RESUME.
    ctrl._onTelemetry({ ...lastHold });
    assert.strictEqual(ctrl.job.paused, false, 'a stale HOLD frame does not re-pause the job');
    assert.ok(!consoleLines.some((m) => /on feed hold/.test(m)), 'no "machine is on feed hold" message');
    ctrl.stream.sendCommand = realSend;
    releaseResume();
    await until(() => !ctrl.job.active && fw.state === defs.ST_IDLE, 600000, 'job finished after one Resume');

    // A hold that comes after the resume was answered still pauses the job.
    ctrl.command('gcode:load', 'a.nc', program(120));
    ctrl.command('gcode:start');
    await until(() => ctrl.job.active && ctrl.job.nextLineToRun() > 20, 600000, 'second job underway');
    ctrl._onTelemetry({ ...lastHold });
    assert.strictEqual(ctrl.job.paused, true, 'a real hold reported by the firmware still pauses the job');
    conn.isOpen = false; ctrl.unbind(); fw.destroy();
    console.log('  ok  stale HOLD telemetry right after Resume does not re-pause; a later hold still does');
}

(async () => {
    console.log('Testing stale HOLD telemetry after Resume...');
    await testStaleHoldAfterResume();
    console.log('ALL TESTS PASSED SUCCESSFULLY!');
    process.exit(0);
})().catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
});
