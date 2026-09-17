'use strict';

/**
 * An E-stop (UI or physical) after a Stop cuts the drivers; the resume point
 * saved by the Stop must become a hard stop so the next resume lifts and
 * travels instead of going down in place (Phase 1 D6-M1, D6-3).
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

async function stopped() {
    const fw = new FakeFirmware({ legTimeScale: 0.05 });
    const conn = new FakeConnection(fw);
    const ctrl = new RSPController();
    ctrl.on('error', () => {});
    ctrl.bind(conn);
    await advance(300);
    ctrl.command('gcode:load', 'a.nc', program(200));
    ctrl.command('gcode:start');
    await until(() => ctrl.job.active && ctrl.job.nextLineToRun() > 40, 600000, 'job underway');
    ctrl.command('gcode:stop');
    await until(() => !ctrl.job.active && fw.state === defs.ST_IDLE, 60000, 'stopped');
    await advance(300);
    assert.ok(ctrl.getResumePoint().line > 40, 'premise: resume point saved');
    assert.strictEqual(ctrl._resumeHardStop, false, 'premise: a plain Stop is not a hard stop');
    return { fw, ctrl, close() { conn.isOpen = false; ctrl.unbind(); fw.destroy(); } };
}

async function testUiEstopAfterStop() {
    const r = await stopped();
    const line = r.ctrl.getResumePoint().line;
    r.ctrl.command('estop');
    await advance(500);
    assert.strictEqual(r.ctrl.getResumePoint().line, line, 'resume point kept');
    assert.strictEqual(r.ctrl._resumeHardStop, true, 'UI E-STOP after Stop marks the resume point as a hard stop');
    r.close();
    console.log('  ok  UI E-STOP after Stop: resume point becomes a hard stop (resume lifts and travels)');
}

async function testPhysicalEstopAfterStop() {
    const r = await stopped();
    r.fw._engageEstop(); // physical button: firmware state only, no EV_ESTOP (0.2.0/0.2.1)
    await advance(500);
    assert.strictEqual(r.ctrl._resumeHardStop, true, 'physical E-stop seen in telemetry after Stop marks a hard stop');
    r.close();
    console.log('  ok  physical E-stop after Stop (telemetry only): resume point becomes a hard stop');
}

(async () => {
    console.log('Testing E-stop after Stop...');
    await testUiEstopAfterStop();
    await testPhysicalEstopAfterStop();
    console.log('ALL TESTS PASSED SUCCESSFULLY!');
    process.exit(0);
})().catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
});
