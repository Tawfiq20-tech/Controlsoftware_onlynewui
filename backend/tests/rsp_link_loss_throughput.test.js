'use strict';

/**
 * Lost frames on the USB link must cost a moment, not the rest of the job.
 *
 * The firmware keeps no out-of-order frames: after one lost host->device
 * frame it discards everything behind it (SEQ_GAP) until the lost one comes
 * again. The sender used to resend only that one frame, leave the rest to a
 * 0.75 s timeout that every further NAK re-armed, and keep sending new lines
 * to be discarded -- one lost job line took a fast 3D raster from 63 s to
 * 174 s (Phase 1, D6-2), and 5 % loss to 212 s.
 *
 * Every run must execute each move exactly once, in order, and finish within
 * a small factor of the loss-free run. ReliableStream + JobStream against the
 * fake firmware (0.2.0 and 0.2.1), legs at real duration, virtual time.
 */

process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';

const { mock } = require('node:test');
mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 1_700_000_000_000 });

const assert = require('assert');
const { EventEmitter } = require('events');
const defs = require('../services/rsp/defs');
const { ReliableStream } = require('../services/rsp/stream');
const { JobStream } = require('../services/rsp/job');
const { FrameParser, FT_CMD, FT_NAK } = require('../services/rsp/frame');
const { FakeFirmware, FakeConnection } = require('./helpers/fakeFirmware');

const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const flush = () => new Promise((r) => setImmediate(r));

async function advance(ms, step = 5) {
    for (let t = 0; t < ms; t += step) {
        mock.timers.tick(step);
        await flush();
    }
}

async function until(pred, maxMs, what, step = 5) {
    for (let t = 0; t <= maxMs; t += step) {
        if (pred()) return;
        mock.timers.tick(step);
        await flush();
    }
    throw new Error(`timed out after ${maxMs} ms waiting for: ${what}`);
}

function rng(seed) {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 0x100000000;
    };
}

/**
 * Compiled-style 3D finishing raster: 0.25 mm moves at 1500-1900 mm/min
 * (10 ms legs, ~100 lines/s) in 60 mm rows, a retract and plunge after every
 * 8th row, a few no-motion lines. Long uniform stretches of short moves are
 * where one lost frame used to cost minutes.
 */
function raster(nMoves, seed = 5) {
    const R = rng(seed);
    const out = ['G21', 'G90', 'M3 S16000', 'G21 G90 G1 Z5.000 F3000', 'G21 G90 G1 X0.000 Y0.000 F3000', 'G21 G90 G1 Z-1.000 F600'];
    let x = 0;
    let y = 0;
    let dir = 1;
    let row = 0;
    for (let n = 0; n < nMoves; n++) {
        if (n % 97 === 50) out.push('G17');
        const nx = x + dir * 0.25;
        if (nx > 60 || nx < 0) {
            dir = -dir;
            y += 0.25;
            row += 1;
            if (row % 8 === 0) out.push('G21 G90 G1 Z3.000 F3000', 'G21 G90 G1 Z-1.000 F600');
            out.push(`G21 G90 G1 Y${y.toFixed(3)} F1500`);
            continue;
        }
        x = nx;
        const z = -1 - 0.8 * Math.sin(x / 5) * Math.cos(y / 7) - 0.05 * R();
        out.push(`G21 G90 G1 X${x.toFixed(3)} Z${z.toFixed(3)} F${1500 + Math.round(R() * 4) * 100}`);
    }
    out.push('G21 G90 G1 Z5.000 F3000', 'M5');
    return out;
}

/**
 * The Phase 1 field shape: nothing but 0.24 mm moves at 1200 mm/min (12 ms
 * legs), back and forth, no retracts or long moves to give the stream a
 * breather. One lost line took this from 38 s to 204 s with 2400 NAKs.
 */
function uniformRaster(nMoves) {
    const out = ['G21', 'G90', 'M3 S16000', 'G21 G90 G1 Z-1.000 F1200'];
    let x = 0;
    let dir = 1;
    for (let n = 0; n < nMoves; n++) {
        let nx = x + dir * 0.24;
        if (nx > 50 || nx < 0) {
            dir = -dir;
            nx = x + dir * 0.24;
        }
        x = nx;
        out.push(`G21 G90 G1 X${x.toFixed(3)} F1200`);
    }
    out.push('M5');
    return out;
}

/** Lose the first job line sent once `ready(r)` holds; note when that seq is next put on the wire. */
function loseOneLine(r, ready, onFrame = () => {}) {
    let lostSeq = null;
    r.conn.hostDrop = (buf) => {
        const f = new FrameParser().feed(buf)[0];
        if (!f || f.frameType !== FT_CMD) return false;
        onFrame(f);
        if (lostSeq === null && f.payload[0] === defs.OP_JOB_LINE && ready(r)) {
            lostSeq = f.seq;
            r.lossAt = Date.now();
            return true;
        }
        if (lostSeq !== null && f.seq === lostSeq && r.resendAt === undefined) r.resendAt = Date.now();
        return false;
    };
}

function expectedMoves(lines) {
    const pos = { x: 0, y: 0, z: 0 };
    const moves = [];
    lines.forEach((t, i) => {
        let saw = false;
        for (const k of ['X', 'Y', 'Z']) {
            const m = new RegExp(`${k}(-?\\d+\\.\\d+)`).exec(t);
            if (m) { pos[k.toLowerCase()] = Math.fround(parseFloat(m[1])); saw = true; }
        }
        if (saw) moves.push({ line: i + 1, target: { ...pos } });
    });
    return moves;
}

function assertExactlyOnce(executed, moves, label) {
    assert.strictEqual(executed.length, moves.length, `${label}: ${executed.length} legs executed, program has ${moves.length} moves`);
    for (let i = 0; i < moves.length; i++) {
        const e = executed[i];
        const m = moves[i];
        const near = Math.abs(e.to.x - m.target.x) < 0.0011 && Math.abs(e.to.y - m.target.y) < 0.0011 && Math.abs(e.to.z - m.target.z) < 0.0011;
        if (e.line !== m.line || !near) {
            assert.fail(`${label}: leg ${i} ran line ${e.line} to ${JSON.stringify(e.to)}, expected line ${m.line} to ${JSON.stringify(m.target)}`);
        }
    }
}

/** ReliableStream + JobStream over the fake firmware, wired the way RSPController wires them. */
function rig(fwVersion) {
    const fw = new FakeFirmware({ legTimeScale: 1, fwVersion });
    const conn = new FakeConnection(fw);
    const transport = new EventEmitter();
    transport.send = (buf) => conn.writeRaw(buf);
    const r = {
        fw, conn, seqGapNaks: [],
        rxHoldUntil: 0, // machine -> host frames held (in order) until then
        close() { r.job.destroy(); r.stream.stop(); fw.destroy(); conn.removeAllListeners(); },
    };
    conn.on('rawData', (buf) => {
        const wait = r.rxHoldUntil - Date.now();
        if (wait > 0) setTimeout(() => transport.emit('data', buf), wait);
        else transport.emit('data', buf);
    });
    r.stream = new ReliableStream(transport, { logger: quiet });
    r.job = new JobStream(r.stream, { logger: quiet });
    r.stream.on('status', (dict) => { if (r.job.active) r.job.noteTelemetry(dict); });
    fw.on('tx', (frame) => {
        for (const f of new FrameParser().feed(frame)) {
            if (f.frameType === FT_NAK && f.payload[1] === defs.ST_ERR_SEQ_GAP) r.seqGapNaks.push(Date.now());
        }
    });
    r.stream.start();
    return r;
}

async function runJob(fwVersion, lines, impair) {
    const r = rig(fwVersion);
    await advance(200); // session PING, first telemetry
    const out = { done: false, failed: null };
    r.job.on('done', () => { out.done = true; });
    r.job.on('failed', (reason) => { out.failed = reason; });
    if (impair) impair(r);
    const t0 = Date.now();
    r.job.upload(lines, null, {});
    r.job.start();
    await until(() => out.done || out.failed, 30 * 60 * 1000, 'job end', 10);
    out.seconds = (Date.now() - t0) / 1000;
    out.executed = r.fw.executed.slice();
    out.seqGapNaks = r.seqGapNaks.length;
    out.lossAt = r.lossAt || null;
    out.resendAt = r.resendAt || null;
    out.lastGapNakAt = r.seqGapNaks.length ? r.seqGapNaks[r.seqGapNaks.length - 1] : null;
    out.leftPending = r.stream._sent.size;
    r.conn.hostDrop = null;
    r.fw.dropOut = null;
    r.close();
    return out;
}

// ---------------------------------------------------------------------------

(async () => {
    console.log('Testing job throughput under frame loss...');
    const t0 = process.hrtime.bigint();
    const lines = raster(2500);
    const moves = expectedMoves(lines);
    const uniform = uniformRaster(2500);
    const uniformMoves = expectedMoves(uniform);

    // 0.2.0 is on the machine today; 0.2.1 is built and waiting
    for (const fwVersion of ['0.2.0', '0.2.1']) {
        const clean = await runJob(fwVersion, lines, null);
        assert.ok(clean.done && !clean.failed, `loss-free run finished: ${clean.failed}`);
        assertExactlyOnce(clean.executed, moves, 'no loss');
        assert.strictEqual(clean.seqGapNaks, 0);
        console.log(`  ok  fw ${fwVersion}: no loss: ${moves.length} moves in ${clean.seconds.toFixed(1)} s`);

        // One job line lost once, mid-raster.
        const one = await runJob(fwVersion, lines, (r) => {
            let lost = false;
            r.conn.hostDrop = (buf) => {
                if (lost || r.fw.executed.length < 300) return false;
                const f = new FrameParser().feed(buf)[0];
                if (f && f.frameType === FT_CMD && f.payload[0] === defs.OP_JOB_LINE) {
                    lost = true;
                    r.lossAt = Date.now();
                    return true;
                }
                return false;
            };
        });
        assert.ok(one.done && !one.failed, `finished: ${one.failed}`);
        assertExactlyOnce(one.executed, moves, 'one lost line');
        const oneFactor = one.seconds / clean.seconds;
        const healedS = (one.lastGapNakAt - one.lossAt) / 1000;
        assert.ok(oneFactor <= 1.05, `one lost line: ${one.seconds.toFixed(1)} s vs ${clean.seconds.toFixed(1)} s (x${oneFactor.toFixed(2)})`);
        assert.ok(one.seqGapNaks < 20, `${one.seqGapNaks} SEQ_GAP NAKs for one lost frame`);
        assert.ok(healedS < 1, `stream back in order ${healedS.toFixed(2)} s after the loss`);
        console.log(`  ok  fw ${fwVersion}: one lost job line: ${one.seconds.toFixed(1)} s (x${oneFactor.toFixed(2)}), ${one.seqGapNaks} SEQ_GAP NAKs, back in order after ${healedS.toFixed(2)} s`);

        // The same on a uniform raster of 12 ms legs, where nothing ever lets
        // the backlog drain on its own.
        const uniClean = await runJob(fwVersion, uniform, null);
        assert.ok(uniClean.done && !uniClean.failed, `uniform raster finished: ${uniClean.failed}`);
        assertExactlyOnce(uniClean.executed, uniformMoves, 'uniform raster, no loss');
        const uniOne = await runJob(fwVersion, uniform, (r) => loseOneLine(r, (rr) => rr.fw.executed.length >= 300));
        assert.ok(uniOne.done && !uniOne.failed, `uniform raster, one lost line: finished (${uniOne.failed})`);
        assertExactlyOnce(uniOne.executed, uniformMoves, 'uniform raster, one lost line');
        const uniFactor = uniOne.seconds / uniClean.seconds;
        assert.ok(uniFactor <= 1.05, `uniform raster, one lost line: ${uniOne.seconds.toFixed(1)} s vs ${uniClean.seconds.toFixed(1)} s (x${uniFactor.toFixed(2)})`);
        assert.ok(uniOne.seqGapNaks < 20, `uniform raster: ${uniOne.seqGapNaks} SEQ_GAP NAKs for one lost frame`);
        console.log(`  ok  fw ${fwVersion}: uniform 12 ms raster, one lost job line: ${uniOne.seconds.toFixed(1)} s vs ${uniClean.seconds.toFixed(1)} s (x${uniFactor.toFixed(2)}), ${uniOne.seqGapNaks} SEQ_GAP NAKs`);

        // ACKs held ~500 ms at the start (0.2.0 settles the drivers in its main
        // loop at the first move while lines still sit in its USB buffer), then
        // a line lost: that busy moment must not slow the resend of the lost line.
        const held = await runJob(fwVersion, uniform, (r) => {
            let first = true;
            loseOneLine(r, (rr) => rr.fw.executed.length >= 20, (f) => {
                if (first && f.payload[0] === defs.OP_JOB_LINE) {
                    first = false;
                    r.rxHoldUntil = Date.now() + 500;
                }
            });
        });
        assert.ok(held.done && !held.failed, `held ACKs, one lost line: finished (${held.failed})`);
        assertExactlyOnce(held.executed, uniformMoves, 'held ACKs, one lost line');
        const resendMs = held.resendAt - held.lossAt;
        assert.ok(held.lossAt && held.resendAt && resendMs <= 100, `lost line resent ${resendMs} ms after the loss (limit 100 ms)`);
        console.log(`  ok  fw ${fwVersion}: ACKs held 500 ms at the start, then a lost line: resent after ${resendMs} ms`);

        const scenarios = [
            { name: '1% host->machine', limit: 1.15, set: (r, R) => { r.conn.hostDrop = () => R() < 0.01; } },
            { name: '5% host->machine', limit: 1.3, set: (r, R) => { r.conn.hostDrop = () => R() < 0.05; } },
            { name: '1% machine->host', limit: 1.15, set: (r, R) => { r.fw.dropOut = () => R() < 0.01; } },
            { name: '5% machine->host', limit: 1.3, set: (r, R) => { r.fw.dropOut = () => R() < 0.05; } },
            { name: '5% both ways', limit: 1.3, set: (r, R) => { const R2 = rng(99); r.conn.hostDrop = () => R() < 0.05; r.fw.dropOut = () => R2() < 0.05; } },
        ];
        for (const sc of scenarios) {
            const R = rng(1234);
            const res = await runJob(fwVersion, lines, (r) => sc.set(r, R));
            assert.ok(res.done && !res.failed, `${sc.name}: finished (${res.failed})`);
            assertExactlyOnce(res.executed, moves, sc.name);
            assert.strictEqual(res.leftPending, 0, `${sc.name}: nothing left pending`);
            const factor = res.seconds / clean.seconds;
            assert.ok(factor <= sc.limit, `${sc.name}: ${res.seconds.toFixed(1)} s vs ${clean.seconds.toFixed(1)} s loss-free (x${factor.toFixed(2)}, limit x${sc.limit})`);
            console.log(`  ok  fw ${fwVersion}: ${sc.name} random frame loss: every move once, in order; ${res.seconds.toFixed(1)} s (x${factor.toFixed(2)}), ${res.seqGapNaks} SEQ_GAP NAKs`);
        }

    }

    console.log(`ALL TESTS PASSED SUCCESSFULLY! (${(Number(process.hrtime.bigint() - t0) / 1e9).toFixed(1)} s)`);
    process.exit(0);
})().catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
});
