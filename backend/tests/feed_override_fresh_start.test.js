'use strict';

/**
 * Feed override resets to 100% when a job starts from line 1 (Phase 1 D1-F1).
 *
 * The override is controller-session state: 200% set during a roughing job
 * carried into the next job (field log: SHIP ROUGHING restarted from line 1,
 * DRAGON FINISH after DRAGON ROUGH). Now a fresh start runs at the programmed
 * feeds, every screen is told (status + sender:status) and the console says
 * so. Resuming the same stopped job keeps the operator's override.
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

function rig() {
    const fw = new FakeFirmware({ legTimeScale: 0.05 });
    const conn = new FakeConnection(fw);
    const ctrl = new RSPController();
    ctrl.on('error', () => {});
    const consoleLines = [];
    const senderStatus = [];
    ctrl.on('console', (m) => consoleLines.push(m));
    ctrl.on('sender:status', (s) => senderStatus.push(s));
    ctrl.bind(conn);
    const idle = () => !ctrl.job.active && fw.state === defs.ST_IDLE;
    return { fw, ctrl, consoleLines, senderStatus, idle, close() { conn.isOpen = false; ctrl.unbind(); fw.destroy(); } };
}

async function testFreshStartResetsOverride() {
    const r = rig();
    await advance(300);
    r.ctrl.command('gcode:load', 'rough.nc', program(40));
    r.ctrl.command('gcode:start');
    await until(() => r.ctrl.job.active, 20000, 'job started');
    for (let i = 0; i < 10; i++) r.ctrl.command('feedOverride:coarsePlus');
    assert.strictEqual(r.ctrl._feedOverridePct, 200, 'premise: override raised to 200%');
    await until(r.idle, 600000, 'job finished');

    r.ctrl.command('gcode:load', 'finish.nc', program(20));
    const mark = r.senderStatus.length;
    r.ctrl.command('gcode:start');
    await until(() => r.ctrl.job.active, 20000, 'second job started');
    assert.strictEqual(r.ctrl._feedOverridePct, 100, 'a job started from line 1 runs at 100%');
    assert.strictEqual(r.ctrl.state.status.feedOverridePct, 100, 'status shows 100%');
    assert.ok(r.senderStatus.slice(mark).some((s) => s.feedOverridePct === 100), 'every screen is told the override is 100%');
    assert.ok(r.consoleLines.some((m) => /Feed override reset to 100% \(was 200%\)/.test(m)), 'the console says so');
    await until(r.idle, 600000, 'second job finished');
    const cuts = r.fw.received.filter((w) => /G1 X/.test(w.text) && / F\d/.test(w.text)).slice(-10);
    assert.ok(cuts.length > 0 && cuts.every((w) => !/F2000/.test(w.text)), `no doubled feeds on the new job: ${JSON.stringify(cuts.map((w) => w.text))}`);
    r.close();
    console.log('  ok  200% set in job A does not carry into the next start from line 1; console and screens updated');
}

async function testResumeKeepsOverride() {
    const r = rig();
    await advance(300);
    r.ctrl.command('gcode:load', 'rough.nc', program(200));
    r.ctrl.command('gcode:start');
    await until(() => r.ctrl.job.active && r.ctrl.job.nextLineToRun() > 40, 600000, 'job underway');
    for (let i = 0; i < 5; i++) r.ctrl.command('feedOverride:coarsePlus');
    assert.strictEqual(r.ctrl._feedOverridePct, 150);
    r.ctrl.command('gcode:stop');
    await until(r.idle, 60000, 'stopped');
    assert.ok(r.ctrl.getResumePoint().line > 1, 'premise: a resume point was kept');
    r.ctrl.command('gcode:start');
    await until(() => r.ctrl.job.active, 60000, 'resumed');
    assert.strictEqual(r.ctrl._feedOverridePct, 150, 'resuming the same stopped job keeps the override');
    assert.ok(!r.consoleLines.some((m) => /Feed override reset/.test(m)));
    r.close();
    console.log('  ok  Stop then Start (resume of the same job) keeps the operator\'s override');
}

(async () => {
    console.log('Testing feed override reset on a fresh start...');
    await testFreshStartResetsOverride();
    await testResumeKeepsOverride();
    console.log('ALL TESTS PASSED SUCCESSFULLY!');
    process.exit(0);
})().catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
});
