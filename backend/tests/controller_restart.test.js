'use strict';

/**
 * A controller board that rebooted must never run a job from the accidental
 * zero it rebooted into.
 *
 * 2026-09-16: the board rebooted mid-job (12:10, 22:37, 23:20). A reboot sets
 * X/Y/Z to 0 wherever the tool is and USB reconnects a few seconds later;
 * nothing told the operator the zero was gone. services/ControllerRestartMonitor
 * spots the reboot (step-timer count went backwards across the reconnect) and
 * RSPController blocks Start / Start From Line / Resume until X, Y and Z are
 * zeroed again or the machine is homed.
 */

process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ControllerRestartMonitor } = require('../services/ControllerRestartMonitor');
const { RSPController } = require('../services/controllers/RSPController');

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'restart-')), 'last_seen.json');
const status = (isr, x = 0, y = 0, z = 0) => ({ dbgTim2IsrCount: isr, wpos: { x, y, z } });

function testDetectsRebootAcrossReconnect() {
    const file = tmpFile();
    const m = new ControllerRestartMonitor(file);
    m.onBind();
    assert.strictEqual(m.onStatus(status(1000, 58.8, 1.9, -3.1)), null, 'first connection ever: nothing to compare');
    assert.strictEqual(m.onStatus(status(130634, 58.8, 1.9, -3.1)), null);
    m.onConnectionLost({ name: 'Buildbotics_DRAGON ROUGH.ngc', line: 45, at: Date.now() });

    // USB-only drop: the board kept counting
    m.onBind();
    assert.strictEqual(m.onStatus(status(140000, 58.8, 1.9, -3.1)), null, 'USB drop without reboot is not a restart');

    // reboot: count starts again from 0
    m.onConnectionLost({ name: 'Buildbotics_DRAGON ROUGH.ngc', line: 8779, at: Date.now() });
    m.onBind();
    const r = m.onStatus(status(0));
    assert.ok(r, 'reboot detected');
    assert.strictEqual(r.lostJob.line, 8779);
    assert.strictEqual(m.onStatus(status(5)), null, 'reported once per connection');

    // remembered across a backend restart
    m.onBind();
    m.onStatus(status(90000));
    m.onConnectionLost(null);
    const fresh = new ControllerRestartMonitor(file);
    fresh.onBind();
    const r2 = fresh.onStatus(status(12));
    assert.ok(r2 && r2.lostJob === null, 'a board power-cycled while the sender was closed is detected too');
    console.log('  ok  a reboot is detected across reconnects and backend restarts; a USB-only drop is not');
}

function newController() {
    const ctrl = new RSPController();
    const out = { console: [], restarted: [], cleared: [] };
    ctrl.on('console', (m) => out.console.push(m));
    ctrl.on('error', () => {});
    ctrl.on('controller:restarted', (d) => out.restarted.push(d));
    ctrl.on('controller:restartCleared', (d) => out.cleared.push(d));
    ctrl.bind({ isOpen: true, write: () => {}, on: () => {}, removeAllListeners: () => {}, emitToSockets: () => {}, writeRaw: () => {} });
    ctrl.command('gcode:load', 'job.nc', 'G21\nG90\nG0 X10 Y10\nG1 Z-1 F300\nG1 X20 F600\nG0 Z5\nM2', 0, {});
    assert.ok(ctrl.lastLoadResult.ok);
    let starts = 0;
    ctrl._startJob = () => { starts += 1; };
    // Home and Zero now clear the position warning only when the FIRMWARE has
    // acknowledged the op (before, a NAK'd or never-answered OP_HOME still
    // unblocked Resume on a machine whose position was never re-established).
    // The fake connection below never replies, so stand in for the device and
    // let each test choose what it answers.
    const acks = { ok: true, error: 'ST_ERR_STATE' };
    ctrl._sendAcked = () => Promise.resolve(acks.ok ? { ok: true } : { ok: false, error: acks.error });
    return { ctrl, out, acks, starts: () => starts };
}

function testStartBlockedUntilZeroed() {
    const { ctrl, out, starts } = newController();
    ctrl.notifyControllerRestarted({ lostJob: { name: 'job.nc', line: 45 } });
    assert.strictEqual(out.restarted.length, 1);
    assert.strictEqual(out.restarted[0].line, 45);
    assert.ok(out.console.some((m) => /restarted in the middle of the job/.test(m) && /Start From Line 45/.test(m)), 'operator is told what happened and what to do');

    ctrl.command('gcode:start');
    assert.strictEqual(starts(), 0, 'Start refused after a restart');
    assert.ok(out.console.some((m) => /Start blocked/.test(m)));
    ctrl.command('gcode:startFromLine', 3, {});
    assert.strictEqual(starts(), 0, 'Start From Line refused after a restart');

    return { ctrl, out, starts };
}

async function testStartBlockedUntilZeroedTail({ ctrl, out, starts }) {
    ctrl.command('zero:x');
    ctrl.command('zero:y');
    await settle();
    ctrl.command('gcode:start');
    assert.strictEqual(starts(), 0, 'still refused with Z not zeroed');
    ctrl.command('zero:z');
    await settle();
    assert.strictEqual(out.cleared.length, 1, 'zeroing X, Y and Z clears it');
    ctrl.command('gcode:start');
    assert.strictEqual(starts(), 1, 'Start allowed once the zero is set again');
    ctrl.unbind();
    console.log('  ok  Start and Start From Line stay blocked after a restart until X, Y and Z are zeroed');
}

/** Let the ack promise and its .then() run. */
const settle = () => new Promise((r) => setImmediate(r));

async function testHomeOrZeroAllClears() {
    for (const cmd of ['home', 'zero:all']) {
        const { ctrl, out, starts } = newController();
        ctrl.notifyControllerRestarted({ lostJob: null });
        assert.ok(out.console.some((m) => /restarted since it was last connected/.test(m)));
        ctrl.command(cmd);
        await settle();
        assert.strictEqual(out.cleared.length, 1, `${cmd} clears the restart`);
        ctrl.command('gcode:start');
        assert.strictEqual(starts(), 1);
        ctrl.unbind();
    }
    console.log('  ok  Home or Zero All clears it in one step');
}

/**
 * The half that matters on the machine: a Home or Zero the firmware REFUSED
 * (E-stop still latched, alarm not cleared, an axis still moving) must leave
 * the warning in place. This used to clear on dispatch, so Resume and Start
 * From Line were unblocked on a machine that had never been homed -- the
 * resume preamble would then travel and plunge at the wrong place.
 */
async function testRefusedHomeOrZeroDoesNotClear() {
    for (const cmd of ['home', 'zero:all']) {
        const { ctrl, out, acks, starts } = newController();
        acks.ok = false;
        ctrl.notifyControllerRestarted({ lostJob: null });
        ctrl.command(cmd);
        await settle();
        assert.strictEqual(out.cleared.length, 0, `a refused ${cmd} must NOT clear the restart`);
        assert.ok(
            out.console.some((m) => /did not finish|did not accept/.test(m)),
            `a refused ${cmd} says so on the console`,
        );
        ctrl.command('gcode:start');
        assert.strictEqual(starts(), 0, `Start stays blocked after a refused ${cmd}`);
        ctrl.unbind();
    }
    console.log('  ok  A Home or Zero the firmware refused leaves the position warning up');
}

(async () => {
    console.log('Testing controller restart detection...');
    testDetectsRebootAcrossReconnect();
    await testStartBlockedUntilZeroedTail(testStartBlockedUntilZeroed());
    await testHomeOrZeroAllClears();
    await testRefusedHomeOrZeroDoesNotClear();
    console.log('ALL TESTS PASSED SUCCESSFULLY!');
    process.exit(0);
})().catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
});
