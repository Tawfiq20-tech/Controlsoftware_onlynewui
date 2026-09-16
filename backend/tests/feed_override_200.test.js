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
    // longest shapes the compiler can emit, at the byte limit
    const lines = [
        'G21 G90 G1 X-1234.567 Y-1234.567 Z-123.456 F1000 M3 S18000',
        'G21 G90 G1 X-1234.567 Y-1234.567 Z-1234.567 F999.9 M3 S1000',
    ];
    for (const pct of [10, 33, 150, 176.5, 200]) {
        job._active = false;
        job.upload(lines, (pct * 7) & 0xFFFF, { feedOverridePct: pct, feedLimits: limits });
        for (let n = 1; n <= lines.length; n++) {
            const out = job._wireText(n);
            assert.ok(Buffer.byteLength(out, 'utf8') <= 63, `${pct}%: "${out}" is ${out.length} bytes`);
            assert.ok(/ F\d/.test(out), `${pct}%: still has a feed`);
            // the axis words are never touched
            assert.strictEqual(out.replace(/ F[\d.]+/, ''), lines[n - 1].replace(/ F[\d.]+/, ''), `${pct}%: geometry unchanged`);
        }
    }
    console.log('  ok  scaled feeds never push a line past the 63-byte firmware limit');
}

(async () => {
    console.log('Testing feed override (host-applied, 10-200%)...');
    testClamping();
    testNeverOverrunsTheLineLimit();
    await testAppliedToTheMachine();
    console.log('ALL TESTS PASSED SUCCESSFULLY!');
    process.exit(0);
})().catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
});
