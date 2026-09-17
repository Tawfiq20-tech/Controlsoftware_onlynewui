'use strict';

/**
 * QA-1 corpus load gate: every reference file must compile to wire lines the
 * running firmware executes exactly as the file means.
 *
 * Checks per file:
 *  - arcs converted (expected arc counts) and no G2/G3 survives
 *  - zero compile errors
 *  - every wire line <= 63 bytes, no "0x"/"0X" (hex-float) pattern
 *  - every motion line has an explicit F and absolute G21 G90
 *  - every coordinate is on the 0.005 mm step grid
 *  - geometry equals an independent interpreter of the ORIGINAL file, file
 *    line by file line (meta.sourceLines): straight moves exactly, arc chords
 *    on the file's own circle and ending on its end point. (This used to read
 *    the arc-converted text, so a mis-converted arc agreed with itself.)
 *  - replaying the firmware's float32 leg math (stepper.c jogeng_begin_leg)
 *    gives 0 steps of drift after every line
 *
 * Corpus location: $EASYCNC_CORPUS or the owner's reference folder. The test
 * is skipped (not failed) when the folder is absent, e.g. on another PC.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { compileWire } = require('../lib/wireCompiler');

const CORPUS = process.env.EASYCNC_CORPUS || 'C:/Users/Tawfiq/Downloads/gcode_test_file/file_finity';
const EXPECTED_ARCS = {
    'Redline_Batman Tray Handle 0.125 em Redline.nc': 1365,
    'Redline_Bluey-Bingo Ice Cream - FINAL_1-V-Carve 1.ngc': 163,
    'Redline_Bluey-Bingo Ice Cream - FINAL_2-Profile 1.ngc': 55,
    'Redline_Textured Clock Number Pockets Redline.nc': 2710,
};

const f32 = Math.fround;

/** Firmware leg math replay (fw 0.1.x stepper.c + parse_gcode_text). */
function replayDrift(wireLines) {
    const planned = { x: f32(0), y: f32(0), z: f32(0) };
    const steps = { x: 0, y: 0, z: 0 };
    let worst = 0;
    let worstLine = 0;
    for (let i = 0; i < wireLines.length; i++) {
        const l = wireLines[i];
        if (!/^G21 G90 G[01] /.test(l)) continue;
        const target = { ...planned };
        for (const k of ['x', 'y', 'z']) {
            const m = new RegExp(`${k.toUpperCase()}(-?\\d+\\.\\d+)`).exec(l);
            if (m) target[k] = f32(parseFloat(m[1]) * 1.0); // strtof * unit_scale(1.0f)
        }
        for (const k of ['x', 'y', 'z']) {
            const dmm = f32(target[k] - planned[k]);
            const scaled = f32(f32(dmm * 200) + (dmm >= 0 ? 0.5 : -0.5));
            steps[k] += Math.trunc(scaled);
            planned[k] = target[k]; // jog_pos_* <- target on completion
            const drift = Math.abs(steps[k] - Math.round(target[k] * 200));
            if (drift > worst) { worst = drift; worstLine = i + 1; }
        }
    }
    return { worst, worstLine };
}

/**
 * Independent interpreter of the ORIGINAL file (mm, unrounded). Returns a map
 * file line -> { kind: 'move'|'arc'|'retract', end, arc? }.
 * G53 Z / G28 / G30 lines are the one intentional rewrite: they retract to
 * retractZ in work coordinates, X/Y held, and later XY-only moves stay at that
 * height. Arcs: XY plane, I/J relative to the start (all this corpus uses).
 */
function interpret(text, retractZ) {
    let scale = 1;
    let abs = true;
    let motion = null;
    const pos = { x: null, y: null, z: null };
    const res = new Map();
    const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/);
    for (let li = 0; li < lines.length; li++) {
        let s = lines[li];
        // comments: nested parentheses, then ';'
        let prev;
        do { prev = s; s = s.replace(/\([^()]*\)/g, ' '); } while (s !== prev);
        s = s.replace(/\(.*$/, ' ').replace(/;.*$/, '').trim();
        if (!s || s.startsWith('%')) continue;
        const words = [...s.toUpperCase().matchAll(/([A-Z])\s*([-+]?(?:\d+\.?\d*|\.\d+))/g)].map((m) => [m[1], parseFloat(m[2])]);
        const get = (L) => { const w = words.find(([k]) => k === L); return w ? w[1] : undefined; };
        let retract = false;
        let dwell = false;
        for (const [L, v] of words) {
            if (L !== 'G') continue;
            if (v === 20) scale = 25.4;
            else if (v === 21) scale = 1;
            else if (v === 90) abs = true;
            else if (v === 91) abs = false;
            else if (v === 53 || v === 28 || v === 30) retract = v === 53 ? get('Z') !== undefined : true;
            else if (v === 4) dwell = true;
            else if (v >= 0 && v <= 3 && Number.isInteger(v)) motion = v;
            else if (v === 18 || v === 19 || v === 90.1) throw new Error(`reference interpreter does not handle G${v} (file line ${li + 1})`);
        }
        if (dwell) continue;
        if (words.some(([L, v]) => L === 'G' && (v === 53 || v === 28 || v === 30))) {
            if (retract) { pos.z = retractZ; res.set(li + 1, { kind: 'retract', end: { ...pos } }); }
            continue;
        }
        const has = (L) => get(L) !== undefined;
        if (!has('X') && !has('Y') && !has('Z') && !has('I') && !has('J')) continue;
        const target = { ...pos };
        for (const L of ['X', 'Y', 'Z']) {
            if (!has(L)) continue;
            const k = L.toLowerCase();
            target[k] = abs ? get(L) * scale : pos[k] + get(L) * scale;
        }
        if (motion === 2 || motion === 3) {
            if (has('R')) throw new Error(`reference interpreter does not handle R arcs (file line ${li + 1})`);
            const c = { x: pos.x + (get('I') || 0) * scale, y: pos.y + (get('J') || 0) * scale };
            const full = Math.abs(target.x - pos.x) < 1e-9 && Math.abs(target.y - pos.y) < 1e-9;
            res.set(li + 1, { kind: 'arc', end: { ...target }, arc: { c, r: Math.hypot(pos.x - c.x, pos.y - c.y), rEnd: Math.hypot(target.x - c.x, target.y - c.y), cw: motion === 2, from: { ...pos }, full, scale } });
        } else {
            res.set(li + 1, { kind: 'move', end: { ...target } });
        }
        Object.assign(pos, target);
    }
    return res;
}

function checkFile(file) {
    const raw = fs.readFileSync(path.join(CORPUS, file), 'utf8');
    const t0 = Date.now();
    const { lines, meta } = compileWire(raw);
    const ms = Date.now() - t0;

    const label = `${file}`;
    assert.strictEqual(meta.arcCount, EXPECTED_ARCS[file] || 0, `${label}: arc count`);
    assert.strictEqual(meta.errorCount, 0, `${label}: compile errors ${JSON.stringify(meta.errors)}`);
    assert.strictEqual(meta.sourceLines.length, lines.length, `${label}: every compiled line has a file line`);

    const ref = interpret(raw, meta.retractZ);
    const AX = ['x', 'y', 'z'];
    const at = { x: null, y: null, z: null };
    let maxLen = 0;
    let worstArc = 0;
    for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        maxLen = Math.max(maxLen, l.length);
        assert.ok(l.length <= 63, `${label} line ${i + 1}: ${l.length} bytes`);
        assert.ok(!/0[xX]/.test(l), `${label} line ${i + 1}: hex pattern "${l}"`);
        assert.ok(!/G0*[23](?![0-9])/.test(l), `${label} line ${i + 1}: arc survived "${l}"`);
        const isMotion = /^G21 G90 G[01] /.test(l);
        if (!isMotion) {
            assert.ok(!/[XYZF]-?\d/.test(l), `${label} line ${i + 1}: axis/feed on a no-motion line "${l}"`);
            assert.ok(!/\bG(?:20|91|53)\b/.test(l), `${label} line ${i + 1}: modal word streamed "${l}"`);
            continue;
        }
        assert.ok(/ F\d+(?:\.\d)?(?: |$)/.test(l), `${label} line ${i + 1}: no explicit F "${l}"`);
        for (const m of l.matchAll(/([XYZ])(-?\d+\.\d{3})/g)) {
            const v = parseFloat(m[2]);
            assert.ok(Math.abs(v * 200 - Math.round(v * 200)) < 1e-6, `${label} line ${i + 1}: off-grid ${m[0]}`);
            at[m[1].toLowerCase()] = v;
        }
        const fileLine = meta.sourceLines[i];
        const r = ref.get(fileLine);
        assert.ok(r, `${label} compiled line ${i + 1} moves, but file line ${fileLine} does not`);
        const lastOfLine = i + 1 === lines.length || meta.sourceLines[i + 1] !== fileLine;
        if (r.kind === 'arc') {
            const d = Math.hypot(at.x - r.arc.c.x, at.y - r.arc.c.y) - r.arc.r;
            worstArc = Math.max(worstArc, Math.abs(d));
            // grid rounding (0.0035) + chord text at 4 decimals in file units + the file's own start/end radius difference
            assert.ok(Math.abs(d) <= 0.0036 + 0.0000708 * r.arc.scale + Math.abs(r.arc.rEnd - r.arc.r), `${label} file line ${fileLine}: chord point ${at.x},${at.y} is ${d.toFixed(5)} mm off the arc`);
        }
        if (lastOfLine) {
            for (const k of AX) {
                if (r.end[k] === null) { assert.strictEqual(at[k], null, `${label} line ${i + 1}: ${k} emitted before known`); continue; }
                assert.ok(at[k] !== null && Math.abs(at[k] - r.end[k]) <= 0.0025 + 1e-9,
                    `${label} file line ${fileLine}: ${k}=${at[k]} but the file means ${r.end[k].toFixed(5)}`);
            }
        } else {
            assert.strictEqual(r.kind, 'arc', `${label} file line ${fileLine} is one move but compiled into several`);
        }
    }
    const drift = replayDrift(lines);
    assert.strictEqual(drift.worst, 0, `${label}: firmware replay drift ${drift.worst} steps at line ${drift.worstLine}`);
    return { file, lines: lines.length, arcs: meta.arcCount, motion: meta.motionCount, clamped: meta.clampedCount, pauses: meta.pauses.length, g53Retract: meta.retractZ, maxLen, warnings: meta.warnings.length, worstArc, ms };
}

function unitTests() {
    const c = (t, o) => compileWire(t, o);
    // hex-float trap: compact G0X keeps X
    let r = c('G21\nG0X15.0000Y2.5');
    assert.strictEqual(r.lines[1], 'G21 G90 G0 X15.000 Y2.500 F3000');
    // inch -> mm on the grid, explicit F carried to modal lines
    r = c('G20 G90\nG1 X1.5 F100\nX2\nY0.001');
    assert.strictEqual(r.lines[1], 'G21 G90 G1 X38.100 F2540');
    assert.strictEqual(r.lines[2], 'G21 G90 G1 X50.800 F2540');
    assert.strictEqual(r.lines[3], 'G21 G90 G1 X50.800 Y0.025 F2540');
    assert.strictEqual(r.lines[0], 'G17', 'units line is host-only');
    // Z-only rapid clamped to Z max rate
    r = c('G21\nG0 Z5', { rapidFeed: 5000, maxRate: { z: 1000 } });
    assert.strictEqual(r.lines[1], 'G21 G90 G0 Z5.000 F1000');
    // G53 retract: to max(file max Z, safe height), and later XY lines carry the retract Z
    r = c('G21\nG0 X0 Y0 Z5\nG1 Z-3 F300\nG53 G0 Z0\nG0 X10 Y10', { safeHeight: 10 });
    assert.strictEqual(r.lines[3], 'G21 G90 G0 X0.000 Y0.000 Z10.000 F3000');
    assert.strictEqual(r.lines[4], 'G21 G90 G0 X10.000 Y10.000 Z10.000 F3000');
    // spindle words stay with a motion line
    r = c('G21\nG0 X1 Y1 M3 S15000');
    assert.strictEqual(r.lines[1], 'G21 G90 G0 X1.000 Y1.000 F3000 M3 S15000');
    // M0 pause recorded with its message and file line
    r = c("G21\nM0 (MSG, Click 'Continue' when ready)\nG0 X1");
    assert.deepStrictEqual(r.meta.pauses, [{ line: 2, fileLine: 2, optional: false, message: "Click 'Continue' when ready", afterCutting: false, toolChange: false }]);
    assert.strictEqual(r.lines[1], 'M0');
    // G4 dwell recorded for the host to wait out; absurd P refused
    r = c('G21\nG0 X1 M3 S12000\nG4 P2.5\nG1 X2 F100');
    assert.deepStrictEqual(r.meta.dwells, [{ line: 3, fileLine: 3, seconds: 2.5 }]);
    assert.strictEqual(r.meta.errorCount, 0);
    r = c('G21\nG0 X1\nG4 P5000');
    assert.ok(r.meta.errors.some((e) => e.line === 3 && /longer than an hour/.test(e.msg)));
    // Fanuc/Haas posts write the dwell time in X. X on a G4 line is TIME, not a
    // position -- reading it as one turned "wait 2.5 s" into a cutting move to
    // X2.5, straight across the workpiece.
    r = c('G21\nG0 X10 Y10\nG1 Z-1 F300\nG4 X2.5\nG1 X20 F300');
    assert.deepStrictEqual(r.meta.dwells, [{ line: 4, fileLine: 4, seconds: 2.5 }]);
    assert.strictEqual(r.lines[3], 'G17', 'a G4 line never moves the machine');
    assert.strictEqual(r.lines[4], 'G21 G90 G1 X20.000 Y10.000 Z-1.000 F300', 'and does not move X for the next line either');
    assert.ok(r.meta.warnings.some((w) => /dwell time on a G4 line, not a position/.test(w.msg)));
    // G4 sharing a line with spindle words keeps them
    r = c('G21\nG0 X1 Y1\nG04 P0.5 M3 S1000\nG1 X2 F100');
    assert.strictEqual(r.lines[2], 'M3 S1000');
    assert.deepStrictEqual(r.meta.dwells, [{ line: 3, fileLine: 3, seconds: 0.5 }]);
    // a dwell with no time at all is ignored, not guessed
    r = c('G21\nG0 X1 Y1\nG4\nG1 X2 F100');
    assert.deepStrictEqual(r.meta.dwells, []);
    assert.strictEqual(r.meta.errorCount, 0);
    // refusals name the line
    // G28/G30 end-of-program retracts: every common form becomes a safe Z lift
    // instead of refusing the file. X/Y are never sent to an unknown "home".
    for (const tail of ['G28 G91 Z0', 'G28 Z0', 'G28', 'G30 X0 Y0 Z0']) {
        r = c(`G21\nG90\nG0 X10 Y10 Z5\nG1 Z-1 F300\nG1 X20\n${tail}\nM30`, { safeHeight: 10 });
        assert.strictEqual(r.meta.errorCount, 0, `${tail}: refused -- ${JSON.stringify(r.meta.errors)}`);
        assert.strictEqual(r.lines[5], 'G21 G90 G0 X20.000 Y10.000 Z10.000 F3000', `${tail}: safe retract, X/Y held`);
        assert.ok(r.meta.warnings.some((w) => /safe height instead of a machine home/.test(w.msg)), `${tail}: says what it did`);
    }
    r = c('G21\nG1 X1');
    assert.ok(r.meta.errors.some((e) => e.line === 2 && /feed/.test(e.msg)));
    r = c('G21\nG0 X0 Y0 Z0\nG1 X1 F100\nT2 M6\nG1 X2');
    assert.ok(r.meta.errors.some((e) => e.line === 4 && /tool change/.test(e.msg)));
    r = c('G21\nG0 X0 A10');
    assert.ok(r.meta.errors.some((e) => /rotary/.test(e.msg)));
    // incremental converted to absolute once position is known
    r = c('G21 G90\nG0 X10 Y10\nG91\nG1 X1 F100\nG90');
    assert.strictEqual(r.lines[3], 'G21 G90 G1 X11.000 Y10.000 F100');
    // headroom block
    r = c('G21\nG0 Z40', { zHeadroom: 30 });
    assert.ok(r.meta.errors.some((e) => /Z travel/.test(e.msg)));

    // arcs in every compact spelling convert
    for (const t of ['G2X1Y1I0.5J0.5', 'G02X1Y1I0.5J0.5', 'g3x1y1i0.5j0.5', 'G17 G2 X1 Y1 I0.5 J0.5', 'G90G3X1Y1I.5J.5']) {
        r = c(`G21\nG0 X0 Y0\n${t} F100`);
        assert.strictEqual(r.meta.errorCount, 0, `${t}: ${JSON.stringify(r.meta.errors)}`);
        assert.strictEqual(r.meta.arcCount, 1, `arc not converted: ${t}`);
        assert.ok(!r.lines.some((l) => /G0*[23](?![0-9])/i.test(l)), `arc survived: ${t}`);
        assert.ok(r.lines[r.lines.length - 1].startsWith('G21 G90 G1 X1.000 Y1.000 '), `${t} ends at its end point`);
    }
    // G20/G21/G28 are not arcs
    assert.strictEqual(c('G20\nG21\nG28 Z0').meta.arcCount, 0);
    // an incremental arc runs from where the tool is
    r = c('G21\nG0 X0 Y0\nG91\nG2 X1 Y1 I1 J0 F100');
    assert.strictEqual(r.meta.errorCount, 0, JSON.stringify(r.meta.errors));
    assert.ok(r.lines[r.lines.length - 1].startsWith('G21 G90 G1 X1.000 Y1.000 '));
    // an arc whose start is unknown is refused with its file line, never guessed
    r = c('G0 X0 Y0\nG18\nG2 X1 Z1 I1 K0 F100');
    assert.ok(r.meta.errors.some((e) => e.line === 3 && /position is known/.test(e.msg)), JSON.stringify(r.meta.errors));
}

(function main() {
    console.log('Testing wire compiler + reference corpus...');
    unitTests();
    console.log('  ok  unit cases');
    if (!fs.existsSync(CORPUS)) {
        console.log(`  SKIP corpus: ${CORPUS} not found`);
        console.log('ALL TESTS PASSED SUCCESSFULLY! (corpus SKIPPED -- unit cases only)');
        return;
    }
    const files = fs.readdirSync(CORPUS).filter((f) => /\.(nc|ngc|gcode|tap|cnc)$/i.test(f)).sort();
    const rows = [];
    for (const f of files) {
        rows.push(checkFile(f));
        const r = rows[rows.length - 1];
        console.log(`  ok  ${r.file}: ${r.lines} lines, ${r.motion} moves, arcs ${r.arcs}${r.arcs ? ` (chords within ${r.worstArc.toFixed(4)} mm of the file's arcs)` : ''}, clamped ${r.clamped}, pauses ${r.pauses}, G53->Z ${r.g53Retract ?? '-'}, max ${r.maxLen} B, ${r.ms} ms`);
    }
    assert.ok(rows.length >= 13, `expected >= 13 corpus files, found ${rows.length}`);
    console.log('ALL TESTS PASSED SUCCESSFULLY!');
})();
