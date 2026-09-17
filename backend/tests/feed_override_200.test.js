'use strict';

/**
 * Feed override (10-200%), host-applied.
 *
 * The firmware accepts OP_SET_FEED_OVERRIDE and stores it, but never applies
 * it to a move (easycnc_protocol.c: rsp_feed_override_pct is written and never
 * read), so the buttons used to change nothing on the machine. Every compiled
 * cutting line carries an explicit F, so the host scales that F on the lines
 * it has not streamed yet, re-clamped to the machine's per-axis rates.
 */

process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';

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

function feedsOf(received, re = /^G21 G90 G1 /) {
    return received.filter((r) => re.test(r.text)).map((r) => parseFloat(/F(\d+(?:\.\d)?)/.exec(r.text)[1]));
}

function testClamping() {
    const ctrl = new RSPController();
    ctrl.bind({ isOpen: true, write: () => {}, on: () => {}, removeAllListeners: () => {}, emitToSockets: () => {}, writeRaw: () => {} });
    ctrl.command('feedOverride:reset');
    assert.strictEqual(ctrl._feedOverridePct, 100, 'reset sets 100%');
    ctrl._setFeedOverride(180);
    assert.strictEqual(ctrl._feedOverridePct, 180);
    ctrl._setFeedOverride(250);
    assert.strictEqual(ctrl._feedOverridePct, 200, 'clamps 250% down to 200%');
    ctrl._setFeedOverride(5);
    assert.strictEqual(ctrl._feedOverridePct, 10, 'clamps 5% up to 10%');
    ctrl.command('feedOverride:reset');
    for (let i = 0; i < 10; i++) ctrl.command('feedOverride:coarsePlus');
    assert.strictEqual(ctrl._feedOverridePct, 200, 'repeated +10% reaches exactly 200%');
    ctrl.command('feedOverride:fineMinus');
    assert.strictEqual(ctrl._feedOverridePct, 199);
    ctrl.unbind();
    console.log('  ok  override clamps to 10-200% and steps by 1% / 10%');
}

async function testAppliedToTheMachine() {
    const fw = new FakeFirmware({ legTimeScale: 0.2 });
    const conn = new FakeConnection(fw);
    const ctrl = new RSPController();
    ctrl.on('console', () => {});
    ctrl.on('error', () => {});
    ctrl.bind(conn);

    const lines = ['G21', 'G90', 'G0 Z5', 'G0 X0 Y0'];
    for (let i = 1; i <= 120; i++) lines.push(`G1 X${(i * 0.5).toFixed(3)} Y0 Z-1 F1000`);
    lines.push('G0 Z5', 'M2');
    ctrl.command('gcode:load', 'feed.nc', lines.join('\n'), 0, { maxRate: { x: 1500, y: 1500, z: 1000 }, maxFeed: 10000 });
    assert.ok(ctrl.lastLoadResult.ok);
    await advance(50);
    ctrl.command('gcode:start');
    await until(() => fw.executed.length >= 10, 60000, 'first moves');
    assert.deepStrictEqual([...new Set(feedsOf(fw.received))], [1000], 'streams the programmed feed at 100%');

    // slow down mid-job
    ctrl._setFeedOverride(50);
    const atChange = fw.received.length;
    await until(() => fw.executed.length >= 40, 60000, 'more moves');
    const after = feedsOf(fw.received.slice(atChange));
    assert.ok(after.length > 0);
    assert.deepStrictEqual([...new Set(after)], [500], 'cutting moves stream at half feed');

    // speed up past what the axis can do: clamped to the axis maximum (1500)
    ctrl._setFeedOverride(200);
    const atFast = fw.received.length;
    await until(() => fw.executed.length >= 80, 60000, 'faster moves');
    const fast = feedsOf(fw.received.slice(atFast));
    assert.deepStrictEqual([...new Set(fast)], [1500], '200% is capped at the X axis maximum rate, not 2000');

    // rapids are streamed exactly as compiled, whatever the override
    const compiled = new Set(ctrl._loadedLines.filter((l) => l.startsWith('G21 G90 G0 ')));
    const rapids = fw.received.filter((r) => r.text.startsWith('G21 G90 G0 '));
    assert.ok(rapids.length > 0);
    assert.ok(rapids.every((r) => compiled.has(r.text)), 'G0 rapids are not scaled by the feed override');

    await until(() => !ctrl.job.active && fw.state === defs.ST_IDLE, 300000, 'job end');
    ctrl.unbind();
    fw.destroy();
    console.log('  ok  50% halves the feed mid-job, 200% is capped by the axis rate, rapids untouched');
}

/**
 * A scaled feed is longer text ("F1000" -> "F1765"), and the firmware's line
 * buffer is 63 bytes. A line pushed over that is TRUNCATED on the wire, which
 * drops an axis word and cuts to the wrong place -- the override must never be
 * able to do that.
 */
function testNeverOverrunsTheLineLimit() {
    const { JobStream } = require('../services/rsp/job');
    const { EventEmitter } = require('events');
    const stream = Object.assign(new EventEmitter(), {
        linkOk: true, available: 16, setHeartbeatPaused() {}, sendNowait() { return 1; },
        sendCommand() { return Promise.resolve({ payload: Buffer.from([0, 0]) }); }, cancelPending() { return 0; },
    });
    const job = new JobStream(stream, { logger: { debug() {}, info() {}, warn() {}, error() {} } });
    const limits = { maxRate: { x: 9000, y: 9000, z: 9000 }, maxFeed: 10000 };
    // longest shapes the compiler can emit, at the byte limit. Z never goes
    // down between them, so above 100% they really are scaled (a move that
    // goes down keeps its programmed feed -- testPlungesKeepTheirFeed).
    const lines = [
        'G21 G90 G0 X0.000 Y0.000 Z-1234.567 F3000',
        'G21 G90 G1 X-1234.567 Y-1234.567 Z-1234.567 F999.9 M3 S1000',
        'G21 G90 G1 X-1234.567 Y-1234.567 Z-123.456 F1000 M3 S18000',
    ];
    for (const pct of [10, 33, 150, 176.5, 200]) {
        job._active = false;
        job.upload(lines, (pct * 7) & 0xFFFF, { feedOverridePct: pct, feedLimits: limits });
        let scaled = 0;
        for (let n = 1; n <= lines.length; n++) {
            const out = job._wireText(n);
            if (out !== lines[n - 1]) scaled++;
            assert.ok(Buffer.byteLength(out, 'utf8') <= 63, `${pct}%: "${out}" is ${out.length} bytes`);
            assert.ok(/ F\d/.test(out), `${pct}%: still has a feed`);
            // the axis words are never touched
            assert.strictEqual(out.replace(/ F[\d.]+/, ''), lines[n - 1].replace(/ F[\d.]+/, ''), `${pct}%: geometry unchanged`);
        }
        assert.ok(scaled > 0, `${pct}%: at least one line was actually rescaled`);
    }
    console.log('  ok  scaled feeds never push a line past the 63-byte firmware limit');
}

function quietJob() {
    const { JobStream } = require('../services/rsp/job');
    const { EventEmitter } = require('events');
    const stream = Object.assign(new EventEmitter(), {
        linkOk: true, available: 16, setHeartbeatPaused() {}, sendNowait() { return 1; },
        sendCommand() { return Promise.resolve({ payload: Buffer.from([0, 0]) }); }, cancelPending() { return 0; },
    });
    return new JobStream(stream, { logger: { debug() {}, info() {}, warn() {}, error() {} } });
}

const feedOf = (text) => parseFloat(/ F(\d+(?:\.\d+)?)/.exec(text)[1]);

/**
 * 2026-09-17, SHIP roughing file at 200%: every Z plunge and descending ramp
 * ran at 1524 instead of the programmed 762 mm/min. Above 100% a move that
 * ends lower in Z than the move before it keeps its programmed feed; slowing
 * down below 100% still applies to it.
 */
function testPlungesKeepTheirFeed() {
    const job = quietJob();
    const limits = { maxRate: { x: 9000, y: 9000, z: 9000 }, maxFeed: 10000 };
    const lines = [
        'G21 G90 G0 X0.000 Y0.000 Z38.100 F3000',   // 1 clearance
        'G21 G90 G1 X0.000 Y0.000 Z-5.740 F762',    // 2 plunge
        'G21 G90 G1 X10.000 Y0.000 Z-5.740 F1524',  // 3 level cut
        'G21 G90 G1 X20.000 Y0.000 Z-6.350 F1524',  // 4 descending ramp
        'G21 G90 G1 X30.000 Y0.000 Z-5.000 F1524',  // 5 climbing
        'M3 S18000',                                // 6 no motion: does not reset the Z it came from
        'G21 G90 G1 X31.000 Y0.000 Z-5.000 F1524',  // 7 level again
        'G21 G90 G0 X31.000 Y0.000 Z2.540 F3000',   // 8 hop up (rapid)
        'G21 G90 G0 X50.000 Y0.000 Z2.540 F3000',   // 9 hop across
        'G21 G90 G1 X50.000 Y0.000 Z-5.740 F762',   // 10 plunge after a rapid hop
    ];
    const run = (pct) => {
        job._active = false;
        job.upload(lines, pct, { feedOverridePct: pct, feedLimits: limits });
        return lines.map((_, i) => job._wireText(i + 1));
    };

    const fast = run(200);
    for (const n of [2, 4, 10]) assert.strictEqual(fast[n - 1], lines[n - 1], `200%: line ${n} goes down in Z and keeps its programmed feed`);
    for (const n of [3, 5, 7]) assert.strictEqual(feedOf(fast[n - 1]), 3048, `200%: line ${n} (level or climbing) is doubled`);
    assert.strictEqual(fast[0], lines[0], 'rapids untouched');

    const slow = run(50);
    assert.deepStrictEqual([2, 3, 4, 5, 7, 10].map((n) => feedOf(slow[n - 1])), [381, 762, 762, 762, 762, 381], '50% still slows every cutting move, plunges included');

    const as100 = run(100);
    assert.deepStrictEqual(as100, lines, '100% sends the program unchanged');

    // Changing the override mid-job uses the same per-line decision.
    job._active = false;
    job.upload(lines, 7, { feedOverridePct: 100, feedLimits: limits });
    job.setFeedOverride(150);
    assert.strictEqual(job._wireText(2), lines[1]);
    assert.strictEqual(feedOf(job._wireText(3)), 2286);
    console.log('  ok  above 100% plunges and descending ramps keep their feed; level/climbing cuts are scaled');
}

/**
 * Resume / Start From Line upload the preamble and the rest of the file as
 * one program, so the first file line is judged against the preamble's plunge
 * depth -- and a job resumed with resume(fromLine) against the lines before it.
 */
function testResumeProgramsKnowThePreviousZ() {
    const { compileWire } = require('../lib/wireCompiler');
    const { buildResumeProgram } = require('../lib/resumeFromLine');
    const src = ['G21', 'G90', 'G0 Z10', 'G0 X0 Y0', 'G1 Z-3 F300',
        'G1 X10 F1200',            // 6 level
        'G1 X20 Z-4 F1200',        // 7 ramp down
        'G1 X30 F1200',            // 8 level
        'G0 Z10', 'M2'].join('\n');
    const lines = compileWire(src).lines;
    const limits = { maxRate: { x: 9000, y: 9000, z: 9000 }, maxFeed: 10000 };
    const job = quietJob();

    for (const [line, boosted] of [[6, true], [7, false], [8, true]]) {
        const plan = buildResumeProgram(lines, line, { safeZMm: 10 });
        assert.ok(plan.ok, plan.error);
        job._active = false;
        job.upload(plan.program, 100 + line, {
            feedOverridePct: 200, feedLimits: limits, fixedFeedLines: plan.preamble.map((_, i) => i + 1),
        });
        const first = plan.preamble.length + 1;
        assert.strictEqual(job._wireText(first) !== plan.program[first - 1], boosted,
            `Start From Line ${line}: first file line ${boosted ? 'is' : 'is not'} boosted (${job._wireText(first)})`);
        for (let n = 1; n < first; n++) assert.strictEqual(job._wireText(n), plan.program[n - 1], 'preamble feeds are fixed');

        job._active = false;
        job.upload(lines, 200 + line, { feedOverridePct: 200, feedLimits: limits });
        job.resume(line);
        assert.strictEqual(job._wireText(line) !== lines[line - 1], boosted, `resume(${line}) on the whole file agrees`);
    }
    console.log('  ok  resume / Start From Line programs judge the first line against the preamble\'s depth');
}

async function testPlungesAgainstTheMachine() {
    const fw = new FakeFirmware({ legTimeScale: 0.05 });
    const conn = new FakeConnection(fw);
    const ctrl = new RSPController();
    const consoleLines = [];
    ctrl.on('console', (m) => consoleLines.push(m));
    ctrl.on('error', () => {});
    ctrl.bind(conn);

    // Z-level roughing shape: hop up, across, plunge, cut a row -- repeated.
    const lines = ['G21', 'G90', 'G0 Z5'];
    for (let row = 0; row < 12; row++) {
        lines.push('G0 Z5', `G0 X0 Y${row}`, 'G1 Z-2 F600', `G1 X4 Y${row} Z-2.5 F1000`);
        for (let i = 1; i <= 6; i++) lines.push(`G1 X${4 + i} Y${row} F1000`);
    }
    lines.push('G0 Z5', 'M2');
    ctrl.command('gcode:load', 'rough.nc', lines.join('\n'), 0, { maxRate: { x: 5000, y: 5000, z: 3000 }, maxFeed: 10000 });
    assert.ok(ctrl.lastLoadResult.ok);
    await advance(50);
    ctrl._setFeedOverride(200);
    assert.ok(consoleLines.some((m) => /Feed override 200%\. Plunges and downward moves keep their programmed speed\./.test(m)), consoleLines.join(' | '));
    ctrl.command('gcode:start');
    await advance(200);
    // no line is streamed between these two calls
    ctrl._setFeedOverride(190);
    ctrl._setFeedOverride(200);
    assert.ok(consoleLines.some((m) => /Feed override 190% — takes effect within the next few moves\. Plunges and downward moves keep their programmed speed\./.test(m)), 'running job: both notes');
    await until(() => !ctrl.job.active && fw.state === defs.ST_IDLE, 300000, 'job end');

    let z = null;
    let plunges = 0;
    let cuts = 0;
    for (const r of fw.received) {
        const m = /Z(-?\d+\.\d+)/.exec(r.text);
        if (!m) continue;
        const to = parseFloat(m[1]);
        if (r.text.startsWith('G21 G90 G1 ')) {
            if (z !== null && to < z - 0.001) {
                plunges++;
                assert.ok([600, 1000].includes(feedOf(r.text)), `a move down keeps its programmed feed: ${r.text}`);
            } else if (z !== null && Math.abs(to - z) < 0.001) {
                cuts++;
                assert.strictEqual(feedOf(r.text), 2000, `a level cut is doubled: ${r.text}`);
            }
        }
        z = to;
    }
    assert.ok(plunges >= 20 && cuts >= 40, `covered ${plunges} plunges/ramps and ${cuts} level cuts`);
    ctrl._setFeedOverride(100);
    assert.ok(/^Feed override 100%$/.test(consoleLines[consoleLines.length - 1]), `at 100% the message is unchanged: ${consoleLines[consoleLines.length - 1]}`);
    ctrl.unbind();
    fw.destroy();
    console.log(`  ok  200% on a hop-and-plunge roughing job: ${plunges} plunges/ramps kept their feed, ${cuts} level cuts doubled`);
}

(async () => {
    console.log('Testing feed override (host-applied, 10-200%)...');
    testClamping();
    testNeverOverrunsTheLineLimit();
    testPlungesKeepTheirFeed();
    testResumeProgramsKnowThePreviousZ();
    await testAppliedToTheMachine();
    await testPlungesAgainstTheMachine();
    console.log('ALL TESTS PASSED SUCCESSFULLY!');
    process.exit(0);
})().catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
});
