'use strict';

/**
 * Loading a large design must not need gigabytes of memory.
 *
 * 2026-09-17 audit: loading Santa3D finishing (32.8 MB, 1.1M lines) peaked at
 * 1.6 GB of process memory (main thread + compile worker), SHIP FINISHING at
 * 1.35 GB. The product also runs on a Raspberry Pi kiosk, where that is the
 * whole board. The compiler kept an object per line of the file, the text was
 * copied into and out of the worker as strings, and compiled lines were built
 * as ropes of small string pieces.
 *
 * This loads a synthetic 3D-relief program (21 MB, 1M lines, arcs, spindle
 * start, a G53 retract) through the real worker path with the production
 * compile options, and fails if the process grows by more than the budget
 * while it compiles. The same load grew the process by ~1200 MB on the old
 * pipeline and ~705 MB now; most of the rest is the feed limiter's per-line
 * bookkeeping (lib/firmwareMotionLimit.js).
 */

process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';

const assert = require('assert');
const { prepareProgramAsync } = require('../lib/prepareProgram');

const BUDGET_MB = 900;
const OPTIONS = {
    rapidFeed: 3000,
    maxRate: { x: 5000, y: 5000, z: 3000 },
    zHeadroom: null,
    safeHeight: 10,
    honorProgramPauses: false,
    motionLimit: { enabled: true },
};

/** 3D relief finishing: raster rows of short X steps with Z following the surface. */
function reliefProgram(rows, perRow) {
    const out = ['(synthetic relief finishing)', 'G21', 'G90', 'T1 (MSG, Insert Tool 1)', 'G0 Z5', 'G0 X0 Y0 M3 S18000'];
    for (let r = 0; r < rows; r++) {
        const y = (r * 0.3).toFixed(3);
        out.push(`G0 X0 Y${y}`, 'G1 Z-1 F600');
        for (let i = 1; i <= perRow; i++) {
            const x = ((r % 2 ? perRow - i : i) * 0.25).toFixed(3);
            out.push(`X${x} Z${(-1 - Math.sin((i + r) / 7) * 2).toFixed(3)} F2400`);
        }
        if (r % 20 === 0) out.push(`G2 X${((r % 2 ? 0 : perRow * 0.25) + 5).toFixed(3)} Y${y} I2.5 J0`);
        out.push('G0 Z5');
    }
    out.push('G53 G0 Z0', 'M5', 'M30');
    return out.join('\n');
}

(async function main() {
    console.log('Testing peak memory of a large file load...');
    let text = reliefProgram(1000, 1000);
    const mb = text.length / 1048576;
    if (global.gc) global.gc();
    await new Promise((r) => setTimeout(r, 50));
    const base = process.memoryUsage().rss;
    let peak = base;
    const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 5);
    const t0 = Date.now();
    let result;
    try {
        result = await prepareProgramAsync(text, 0, OPTIONS);
    } finally {
        clearInterval(timer);
    }
    peak = Math.max(peak, process.memoryUsage().rss);
    text = null;
    const meta = result.compiled.meta;
    assert.strictEqual(meta.errorCount, 0, JSON.stringify(meta.errors));
    assert.ok(result.compiled.lines.length > 1000000, `fixture is large (${result.compiled.lines.length} lines)`);
    assert.ok(meta.motionLimitedCount > 0, 'fixture exercises the motion limit');
    const grewMb = (peak - base) / 1048576;
    console.log(`  ${mb.toFixed(1)} MB, ${result.compiled.lines.length} lines in ${Date.now() - t0} ms: process grew ${grewMb.toFixed(0)} MB (budget ${BUDGET_MB} MB)`);
    assert.ok(grewMb <= BUDGET_MB, `loading a ${mb.toFixed(1)} MB file grew the process by ${grewMb.toFixed(0)} MB (budget ${BUDGET_MB} MB)`);
    console.log('  ok  a large file loads within the memory budget');
    console.log('ALL TESTS PASSED SUCCESSFULLY!');
    process.exit(0);
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
