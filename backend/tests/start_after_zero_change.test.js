'use strict';

/**
 * After a Stop, a work-zero change (Zero, Zero All, per-axis zero) must stop
 * a plain START from silently resuming mid-file at the NEW zero
 * (Phase 1 D1-F3, D3-M1, D5-M1, D5-1).
 *
 * Mechanism (RSPController gcode:start): the first START after the zero
 * change clears the resume point, starts nothing and says so, naming
 * Start From Line N; the next START runs the file from line 1.
 * Re-sending the same file after the zero change does not bring the old
 * resume point back for a plain START. Stop -> Start with no zero change still
 * resumes.
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

async function stoppedMidJob(zeroCmds) {
    const fw = new FakeFirmware({ legTimeScale: 0.05 });
    const conn = new FakeConnection(fw);
    const ctrl = new RSPController();
    ctrl.on('error', () => {});
    const consoleLines = [];
    ctrl.on('console', (m) => consoleLines.push(m));
    ctrl.bind(conn);
    await advance(300);
    const text = program(200);
    ctrl.command('gcode:load', 'a.nc', text);
    ctrl.command('gcode:start');
    await until(() => ctrl.job.active && ctrl.job.nextLineToRun() > 40, 600000, 'job underway');
    ctrl.command('gcode:stop');
    await until(() => !ctrl.job.active && fw.state === defs.ST_IDLE, 60000, 'stopped');
    const line = ctrl.getResumePoint().line;
    assert.ok(line > 40, 'premise: a resume point was kept');
    for (const c of zeroCmds) ctrl.command(c);
    await advance(300);
    const idle = () => !ctrl.job.active && fw.state === defs.ST_IDLE;
    return { fw, ctrl, consoleLines, text, line, idle, starts: () => fw.jobStarts || 0, close() { conn.isOpen = false; ctrl.unbind(); fw.destroy(); } };
}

async function testZeroThenStartAsksAgain() {
    for (const zero of [['zero:x'], ['zero:all'], ['zero:z']]) {
        const r = await stoppedMidJob(zero);
        assert.strictEqual(r.ctrl.getResumePoint().originChanged, true, `${zero}: resume point flagged`);
        const s0 = r.starts();
        const recv0 = r.fw.received.length;
        r.ctrl.command('gcode:start');
        await advance(2000);
        assert.strictEqual(r.starts() - s0, 0, `${zero}: the first START after a zero change starts nothing`);
        assert.strictEqual(r.fw.received.length - recv0, 0, `${zero}: no line sent`);
        assert.strictEqual(r.ctrl.getResumePoint().line, 0, `${zero}: resume point cleared`);
        const msg = r.consoleLines.find((m) => /Nothing was started: the work zero was changed/.test(m));
        assert.ok(msg && msg.includes(`Start From Line ${r.line}`) && /press Start again to run the file from line 1/.test(msg), `${zero}: operator told both options: ${msg}`);

        r.ctrl.command('gcode:start');
        await until(() => r.ctrl.job.active, 20000, 'second START runs');
        await advance(500);
        const first = r.fw.received[recv0];
        assert.ok(first && first.line <= 5, `${zero}: second START runs from line 1 (first line ${first && first.line})`);
        r.close();
    }
    console.log('  ok  Stop, then zero (per-axis or all), then START: nothing starts, resume point cleared, next START runs line 1');
}

async function testResendSameFileAfterZero() {
    const r = await stoppedMidJob(['zero:all']);
    r.ctrl.command('gcode:load', 'a.nc', r.text);
    const s0 = r.starts();
    r.ctrl.command('gcode:start');
    await advance(2000);
    assert.strictEqual(r.starts() - s0, 0, 're-sending the same file does not bring the old resume point back for START');
    assert.strictEqual(r.ctrl.getResumePoint().line, 0);
    r.close();
    console.log('  ok  re-sending the same file after a zero change does not resume on START');
}

async function testNoZeroStillResumes() {
    const r = await stoppedMidJob([]);
    const recv0 = r.fw.received.length;
    r.ctrl.command('gcode:start');
    await until(() => r.ctrl.job.active, 20000, 'resumed');
    await advance(2000);
    assert.ok(r.consoleLines.some((m) => m.includes(`Resume from line ${r.line}`) && !/not started|blocked/.test(m)), `Stop then START with no zero change resumes the same job: ${JSON.stringify(r.consoleLines.slice(-4))}`);
    assert.ok(r.fw.received.length > recv0, 'lines were sent');
    r.close();
    console.log('  ok  Stop then START without a zero change still resumes');
}

async function testStartFromLineAfterZero() {
    const r = await stoppedMidJob(['zero:x', 'zero:y', 'zero:z']);
    const recv0 = r.fw.received.length;
    r.ctrl.command('gcode:startFromLine', r.line, {});
    await until(() => r.ctrl.job.active, 20000, 'start from line');
    await advance(2000);
    assert.ok(r.consoleLines.some((m) => m.includes(`Start From Line ${r.line}`) && !/not started|blocked|Nothing was started|only if/.test(m)), `Start From Line N still works after zeroing X, Y and Z: ${JSON.stringify(r.consoleLines.slice(-4))}`);
    assert.ok(r.fw.received.length > recv0, 'lines were sent');
    r.close();
    console.log('  ok  zero X/Y/Z then Start From Line N still works');
}

(async () => {
    console.log('Testing START after a work-zero change...');
    await testZeroThenStartAsksAgain();
    await testResendSameFileAfterZero();
    await testNoZeroStillResumes();
    await testStartFromLineAfterZero();
    console.log('ALL TESTS PASSED SUCCESSFULLY!');
    process.exit(0);
})().catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
});
