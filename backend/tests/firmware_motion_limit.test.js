'use strict';

/**
 * Firmware motion limit (lib/firmwareMotionLimit.js).
 *
 * The RSP firmware starts every line at 25% of its feed and ramps inside the
 * line with no look-ahead, so fine 3D detail (short legs, Z reversing every
 * leg) asked the machine for accelerations it cannot follow and the smallest
 * features came out rounded (DRAGON FINISH eyes and teeth, 2026-09-16). The
 * limiter lowers F on exactly those legs, never moves a position, and leaves
 * long moves at their programmed feed.
 */

process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';

const assert = require('assert');
const { EventEmitter } = require('events');
const { limitFeeds, analyze, DEFAULT_LIMITS } = require('../lib/firmwareMotionLimit');
const { compileWire } = require('../lib/wireCompiler');
const { JobStream } = require('../services/rsp/job');

const stripF = (l) => l.replace(/ F[\d.]+/, '');
const feedOf = (l) => parseFloat(/ F([\d.]+)/.exec(l)[1]);

/** Relief-style raster row: short X steps with Z going up and down every step. */
function reliefRow(n, stepMm, ampMm, feed) {
    const lines = ['G21', 'G90', 'G0 Z5', 'G0 X0 Y0', `G1 Z-2 F${feed}`];
    for (let i = 1; i <= n; i++) lines.push(`G1 X${(i * stepMm).toFixed(3)} Z${(-2 - (i % 2) * ampMm).toFixed(3)}`);
    lines.push('G0 Z5', 'M2');
    return lines.join('\n');
}

function testReliefDetailIsSlowedWithinLimits() {
    const compiled = compileWire(reliefRow(400, 0.15, 0.4, 5000), {});
    const before = analyze(compiled.lines);
    assert.ok(before.worst.accel.x > DEFAULT_LIMITS.maxAccel.x * 1.3, `fixture must be violent (X accel ${before.worst.accel.x})`);

    const r = limitFeeds(compiled.lines);
    const after = analyze(r.lines);
    for (const k of ['x', 'y', 'z']) {
        assert.ok(after.worst.accel[k] <= DEFAULT_LIMITS.maxAccel[k] * 1.01, `${k} accel ${after.worst.accel[k]} within limit`);
        assert.ok(after.worst.jump[k] <= DEFAULT_LIMITS.maxJump[k] * 1.01, `${k} jump ${after.worst.jump[k]} within limit`);
    }
    assert.ok(r.limitedCount > 300, `most relief legs slowed (${r.limitedCount})`);
    for (let i = 0; i < r.lines.length; i++) {
        assert.strictEqual(stripF(r.lines[i]), stripF(compiled.lines[i]), `line ${i + 1}: position unchanged`);
        if (r.limited[i]) assert.ok(feedOf(r.lines[i]) < feedOf(compiled.lines[i]), `line ${i + 1}: marked lines are slower`);
        else assert.strictEqual(r.lines[i], compiled.lines[i], `line ${i + 1}: unmarked lines untouched`);
    }
    assert.ok(after.seconds > before.seconds, 'slower job');
    console.log(`  ok  relief detail slowed to the limits (X accel ${before.worst.accel.x.toFixed(0)} -> ${after.worst.accel.x.toFixed(0)} mm/s2), positions unchanged`);
}

function testLongMovesKeepTheirFeed() {
    const text = ['G21', 'G90', 'G0 Z5', 'G0 X0 Y0', 'G1 Z-1 F300', 'G1 X200 F2000', 'G1 Y150', 'G1 X0', 'G0 Z5', 'M2'].join('\n');
    const compiled = compileWire(text, {});
    const r = limitFeeds(compiled.lines);
    const cuts = compiled.lines.map((l, i) => [l, r.lines[i]]).filter(([l]) => / F2000/.test(l));
    assert.strictEqual(cuts.length, 3);
    for (const [orig, out] of cuts) assert.strictEqual(out, orig, `long move keeps F2000: ${out}`);
    console.log('  ok  long cutting moves keep their programmed feed');
}

function testCompilerOption() {
    const text = reliefRow(200, 0.3, 0.5, 4000);
    const off = compileWire(text, {});
    assert.strictEqual(off.feedLimitedLines, null, 'off unless asked');
    assert.strictEqual(off.meta.motionLimitedCount, 0);
    const disabled = compileWire(text, { motionLimit: { enabled: false } });
    assert.deepStrictEqual(disabled.lines, off.lines, 'enabled:false changes nothing');
    const on = compileWire(text, { motionLimit: { enabled: true } });
    assert.strictEqual(on.meta.errorCount, 0);
    assert.ok(on.meta.motionLimitedCount > 150, `limited ${on.meta.motionLimitedCount}`);
    assert.strictEqual(on.feedLimitedLines.length, on.lines.length);
    const looser = compileWire(text, { motionLimit: { enabled: true, maxAccel: { x: 50000, y: 50000, z: 50000 }, maxJump: { x: 100, y: 100, z: 100 } } });
    assert.ok(looser.meta.motionLimitedCount < on.meta.motionLimitedCount, 'machine.motionLimit values are used');
    console.log('  ok  compiler applies the limit only when enabled, with configurable limits');
}

function testOverrideDoesNotBoostLimitedLines() {
    const stream = Object.assign(new EventEmitter(), {
        linkOk: true, available: 16, setHeartbeatPaused() {}, sendNowait() { return 1; },
        sendCommand() { return Promise.resolve({ payload: Buffer.from([0, 0]) }); }, cancelPending() { return 0; },
    });
    const job = new JobStream(stream, { logger: { debug() {}, info() {}, warn() {}, error() {} } });
    const lines = ['G21 G90 G1 X1.000 Y0.000 Z-1.000 F600', 'G21 G90 G1 X2.000 Y0.000 Z-1.000 F600'];
    const noBoost = Uint8Array.from([1, 0]);
    const limits = { maxRate: { x: 9000, y: 9000, z: 9000 }, maxFeed: 10000 };

    job.upload(lines, 11, { feedOverridePct: 200, feedLimits: limits, noBoostLines: noBoost });
    job._trackSentPos('G21 G90 G1 X0.000 Y0.000 Z-1.000');
    assert.strictEqual(job._wireText(1), lines[0], '200% does not speed up a limited line');
    assert.ok(/ F1200$/.test(job._wireText(2)), `200% still applies to other lines: ${job._wireText(2)}`);

    job._active = false;
    job.upload(lines, 12, { feedOverridePct: 50, feedLimits: limits, noBoostLines: noBoost });
    assert.ok(/ F300$/.test(job._wireText(1)), `50% still slows a limited line: ${job._wireText(1)}`);
    console.log('  ok  feed override can slow limited lines but never speed them up');
}

(async () => {
    console.log('Testing firmware motion limit...');
    testReliefDetailIsSlowedWithinLimits();
    testLongMovesKeepTheirFeed();
    testCompilerOption();
    testOverrideDoesNotBoostLimitedLines();
    console.log('ALL TESTS PASSED SUCCESSFULLY!');
    process.exit(0);
})().catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
});
