'use strict';

/**
 * Loading a large file must not stall the backend's event loop.
 *
 * 2026-09-16 19:32:42: loading DRAGON FINISH (14 MB, 328k lines) compiled on
 * the main thread for ~3.7 s. No RSP frame was read or sent meanwhile, the
 * stream declared "heartbeat timeout -- link lost" (3 s), and a stall past the
 * firmware's 5 s host watchdog stops a moving machine. RSPController.loadGcode()
 * now prepares the program on a worker thread.
 */

process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';

const assert = require('assert');
const { RSPController } = require('../services/controllers/RSPController');

const MOTION_LIMIT = { motionLimit: { enabled: true } };

/** 3D-relief-like program: short X steps, Z up and down every step, some arcs and a spindle start. */
function reliefProgram(rows, perRow) {
    const out = ['G20', 'G90', 'T1 (MSG, Insert Tool 1)', 'G0 Z0.25', 'G0 X0 Y0 M3 S18000', 'M0 (MSG, spindle up to speed)'];
    for (let r = 0; r < rows; r++) {
        const y = (r * 0.006).toFixed(3);
        out.push(`G0 X0 Y${y}`, 'G1 Z-0.2 F125');
        for (let i = 1; i <= perRow; i++) {
            const x = ((r % 2 ? perRow - i : i) * 0.02).toFixed(3);
            out.push(`X${x} Z${(-0.2 - ((i * 7 + r) % 5) * 0.01).toFixed(3)}`);
        }
        if (r % 50 === 0) out.push('G2 X0.5 Y' + y + ' I0.25 J0 F125');
        out.push('G0 Z0.15');
    }
    out.push('M05', 'M02');
    return out.join('\n');
}

function newController() {
    const ctrl = new RSPController();
    ctrl.on('console', () => {});
    ctrl.on('error', () => {});
    ctrl.bind({ isOpen: true, write: () => {}, on: () => {}, removeAllListeners: () => {}, emitToSockets: () => {}, writeRaw: () => {} });
    return ctrl;
}

/** Largest gap between 10 ms ticks while `fn` runs. */
async function maxLoopGap(fn) {
    let last = Date.now();
    let maxGap = 0;
    const timer = setInterval(() => {
        const now = Date.now();
        maxGap = Math.max(maxGap, now - last);
        last = now;
    }, 10);
    try {
        await fn();
        await new Promise((r) => setTimeout(r, 30));
    } finally {
        clearInterval(timer);
    }
    return maxGap;
}

async function testSameResultAsSynchronousLoad() {
    const text = reliefProgram(40, 120);
    const sync = newController();
    sync.command('gcode:load', 'relief.nc', text, 2, MOTION_LIMIT);
    const viaWorker = newController();
    const r = await viaWorker.loadGcode('relief.nc', text, 2, MOTION_LIMIT);

    assert.ok(sync.lastLoadResult.ok, JSON.stringify(sync.lastLoadResult.meta && sync.lastLoadResult.meta.errors));
    assert.ok(r && r.ok, 'worker load ok');
    assert.deepStrictEqual(viaWorker._loadedLines, sync._loadedLines, 'identical compiled lines');
    assert.strictEqual(viaWorker._loadedGcode, sync._loadedGcode);
    assert.deepStrictEqual(Array.from(viaWorker._loadedFeedLimited), Array.from(sync._loadedFeedLimited), 'identical motion-limited lines');
    assert.ok(sync._loadedMeta.motionLimitedCount > 0, 'fixture exercises the motion limit');
    assert.deepStrictEqual(viaWorker._loadedMeta, sync._loadedMeta, 'identical compile report');
    assert.strictEqual(viaWorker._loadedName, 'relief.nc');
    console.log(`  ok  worker load gives the same program as the synchronous load (${sync._loadedLines.length} lines, ${sync._loadedMeta.motionLimitedCount} slowed)`);
}

async function testEventLoopStaysResponsive() {
    const text = reliefProgram(600, 250); // ~150k lines, several seconds of compile work
    const blocked = await maxLoopGap(async () => {
        newController().command('gcode:load', 'big.nc', text, 0, MOTION_LIMIT);
    });
    const ctrl = newController();
    let result;
    const gap = await maxLoopGap(async () => {
        result = await ctrl.loadGcode('big.nc', text, 0, MOTION_LIMIT);
    });
    assert.ok(result && result.ok, 'big file loaded');
    assert.ok(blocked > 1000, `fixture must block a synchronous load for over 1 s (blocked ${blocked} ms)`);
    // The RSP link is declared lost after 3 s of silence; stay far below it.
    assert.ok(gap < 700, `event loop stalled ${gap} ms during the worker load`);
    console.log(`  ok  event loop never stalled more than ${gap} ms while ${ctrl._loadedLines.length} lines compiled (synchronous load stalled ${blocked} ms)`);
}

async function testNewerLoadWins() {
    const ctrl = newController();
    const first = ctrl.loadGcode('first.nc', reliefProgram(60, 150), 0, MOTION_LIMIT);
    const second = ctrl.loadGcode('second.nc', 'G21\nG90\nG0 X1 Y1\nG1 X2 F100\nM2', 0, MOTION_LIMIT);
    const [r1, r2] = await Promise.all([first, second]);
    assert.deepStrictEqual(r1, { superseded: true }, 'older load dropped');
    assert.ok(r2.ok);
    assert.strictEqual(ctrl._loadedName, 'second.nc');

    const third = ctrl.loadGcode('third.nc', reliefProgram(20, 50), 0, MOTION_LIMIT);
    ctrl.command('gcode:unload');
    assert.deepStrictEqual(await third, { superseded: true }, 'unload during preparation wins');
    assert.strictEqual(ctrl._loadedLines.length, 0, 'nothing loaded after unload');
    console.log('  ok  a newer load or an unload supersedes a load still being prepared');
}

async function testRefusedWhileJobRuns() {
    const ctrl = newController();
    await ctrl.loadGcode('running.nc', 'G21\nG90\nG0 X1 Y1\nG1 X2 F100\nM2', 0, {});
    ctrl.job = { active: true, firmwareLost: false, abort() { throw new Error('must not abort a running job'); }, resetProgress() {} };
    const r = await ctrl.loadGcode('other.nc', 'G21\nG90\nG0 X5 Y5\nM2', 0, {});
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.busy, true);
    assert.strictEqual(ctrl._loadedName, 'running.nc', 'running program untouched');
    ctrl.job = null;
    console.log('  ok  a load is refused while a job runs');
}

async function testBadFileRejected() {
    const ctrl = newController();
    const r = await ctrl.loadGcode('bad.nc', 'G21\nG90\nG1 X10 Y10\nM2', 0, {});
    assert.strictEqual(r.ok, false, 'cutting move without feed is refused');
    assert.ok(r.meta.errorCount > 0);
    assert.strictEqual(ctrl._loadedLines.length, 0);
    console.log('  ok  a file the machine cannot run is refused with its errors');
}

(async () => {
    console.log('Testing file load off the main thread...');
    await testSameResultAsSynchronousLoad();
    await testNewerLoadWins();
    await testRefusedWhileJobRuns();
    await testBadFileRejected();
    await testEventLoopStaysResponsive();
    console.log('ALL TESTS PASSED SUCCESSFULLY!');
    process.exit(0);
})().catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
});
