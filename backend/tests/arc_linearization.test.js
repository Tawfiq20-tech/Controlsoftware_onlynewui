'use strict';

/**
 * Arc conversion, checked geometrically against the ORIGINAL files.
 *
 * The firmware cannot cut G2/G3, so the sender replaces every arc with short
 * straight chords before streaming (lib/wireCompiler.js, geometry in
 * lib/linearizeArcs.js). Your files contain thousands of arcs (Textured Clock
 * 2710, Batman 1365), and a mis-converted arc is a silently wrong carve.
 *
 * This compiles each file, walks the original text, and for every arc takes
 * the compiled lines that belong to its file line (meta.sourceLines):
 *   - every chord end lies ON the arc (distance to the centre == radius, to
 *     the 0.005 mm step grid)
 *   - the sweep goes the right way round (G2 clockwise, G3 counter-clockwise)
 *     and covers the whole angle, no more
 *   - it ends exactly at the arc's endpoint
 *   - the chords are short enough that the cut never deviates from the true
 *     arc by more than about a step
 * and every straight move is exactly one compiled move to the same point.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { compileWire } = require('../lib/wireCompiler');

const CORPUS = process.env.EASYCNC_CORPUS || 'C:/Users/Tawfiq/Downloads/gcode_test_file/file_finity';

function strip(line) {
    let s = String(line);
    let prev;
    do { prev = s; s = s.replace(/\([^()]*\)/g, ' '); } while (s !== prev);
    return s.replace(/;.*$/, '').trim();
}

function words(line) {
    const t = {};
    for (const m of line.matchAll(/([A-Za-z])\s*([-+]?(?:\d+\.?\d*|\.\d+))/g)) {
        const L = m[1].toUpperCase();
        if (L === 'G') (t.G || (t.G = [])).push(parseFloat(m[2]));
        else t[L] = parseFloat(m[2]);
    }
    return t;
}

/**
 * Walks the original program (mm), yielding {fileLine, kind:'move'|'arc', ...} in file order.
 * G53 Z / G28 / G30 retract to retractZ (this machine's documented rewrite) and are not yielded.
 */
function* walk(text, retractZ) {
    const pos = { x: null, y: null, z: null };
    let motion = null;
    let scale = 1;
    let abs = true;
    const lines = String(text).replace(/^\uFEFF/, '').split(/\r\n|\r|\n/);
    for (let li = 0; li < lines.length; li++) {
        const line = strip(lines[li]);
        if (!line || line.startsWith('%')) continue;
        const w = words(line);
        let skip = false;
        let retract = false;
        for (const g of w.G || []) {
            if (g === 20) scale = 25.4;
            else if (g === 21) scale = 1;
            else if (g === 90) abs = true;
            else if (g === 91) abs = false;
            else if ([0, 1, 2, 3].includes(g)) motion = g;
            else if (g === 4) skip = true;
            else if (g === 28 || g === 30 || (g === 53 && w.Z !== undefined)) { skip = true; retract = true; } else if (g === 53) skip = true;
        }
        if (retract) pos.z = retractZ;
        if (skip) continue;
        const hasAxis = w.X !== undefined || w.Y !== undefined || w.Z !== undefined;
        const hasIJ = w.I !== undefined || w.J !== undefined;
        if (!hasAxis && !hasIJ) continue;
        const from = { ...pos };
        for (const k of ['X', 'Y', 'Z']) {
            if (w[k] === undefined) continue;
            const kk = k.toLowerCase();
            pos[kk] = abs ? w[k] * scale : pos[kk] + w[k] * scale;
        }
        if ((motion === 2 || motion === 3) && (hasIJ || hasAxis)) {
            yield { fileLine: li + 1, kind: 'arc', cw: motion === 2, from, to: { ...pos }, i: (w.I || 0) * scale, j: (w.J || 0) * scale, scale };
        } else {
            yield { fileLine: li + 1, kind: 'move', from, to: { ...pos } };
        }
    }
}

/** Compiled machine position after each motion line, grouped by file line. */
function compiledByFileLine(lines, sourceLines) {
    const at = { x: null, y: null, z: null };
    const groups = new Map();
    for (let i = 0; i < lines.length; i++) {
        const m = /^G21 G90 G[01]((?: [XYZ]-?\d+\.\d+)+) F/.exec(lines[i]);
        if (!m) continue;
        for (const a of m[1].trim().split(' ')) at[a[0].toLowerCase()] = parseFloat(a.slice(1));
        const f = sourceLines[i];
        if (!groups.has(f)) groups.set(f, []);
        groups.get(f).push({ ...at });
    }
    return groups;
}

function angleOf(p, c) {
    return Math.atan2(p.y - c.y, p.x - c.x);
}

function checkProgram(label, text) {
    const { lines, meta } = compileWire(text);
    assert.strictEqual(meta.errorCount, 0, `${label}: refused ${JSON.stringify(meta.errors)}`);
    const groups = compiledByFileLine(lines, meta.sourceLines);
    let arcs = 0;
    let segments = 0;
    let worstRadial = 0;
    let worstSagitta = 0;
    for (const item of walk(text, meta.retractZ)) {
        const pts = groups.get(item.fileLine) || [];
        if (item.kind === 'move') {
            assert.strictEqual(pts.length, 1, `${label} file line ${item.fileLine}: a straight move compiled into ${pts.length} moves`);
            for (const k of ['x', 'y', 'z']) {
                if (item.to[k] === null) continue;
                assert.ok(Math.abs(pts[0][k] - item.to[k]) <= 0.0025 + 1e-9, `${label} file line ${item.fileLine}: plain move changed ${k} ${item.to[k]} -> ${pts[0][k]}`);
            }
            continue;
        }
        arcs++;
        segments += pts.length;
        assert.ok(pts.length >= 1, `${label} file line ${item.fileLine}: arc produced no chords`);
        const c = { x: item.from.x + item.i, y: item.from.y + item.j };
        const r = Math.hypot(item.from.x - c.x, item.from.y - c.y);
        const rEnd = Math.hypot(item.to.x - c.x, item.to.y - c.y);
        // CAM arcs are consistent to well under a step; if the file itself is
        // inconsistent there is nothing the converter can do about it.
        assert.ok(Math.abs(r - rEnd) < 0.5, `${label}: the FILE's own arc is inconsistent (r ${r} vs ${rEnd})`);

        let a = angleOf(item.from, c);
        let swept = 0;
        // grid rounding of each chord end (<= 0.0036 mm) + chord text at 4 decimals in file units
        const radialLimit = 0.0036 + 0.0000708 * item.scale + Math.abs(r - rEnd);
        for (const p of pts) {
            const rad = Math.hypot(p.x - c.x, p.y - c.y);
            const off = Math.abs(rad - r) - Math.abs(r - rEnd);
            worstRadial = Math.max(worstRadial, Math.abs(rad - r));
            assert.ok(Math.abs(rad - r) <= radialLimit, `${label} file line ${item.fileLine}: chord end ${p.x},${p.y} is ${off.toFixed(5)} mm off the arc`);
            const a2 = angleOf(p, c);
            let d = a2 - a;
            while (d > Math.PI) d -= 2 * Math.PI;
            while (d < -Math.PI) d += 2 * Math.PI;
            if (Math.abs(d) > 0.02 / Math.max(r, 0.05)) {
                assert.ok(item.cw ? d < 0 : d > 0, `${label} file line ${item.fileLine}: arc turns the wrong way (${item.cw ? 'G2' : 'G3'}, step ${d.toFixed(6)} rad)`);
            }
            swept += d;
            worstSagitta = Math.max(worstSagitta, r * (1 - Math.cos(Math.abs(d) / 2)));
            a = a2;
        }
        const last = pts[pts.length - 1];
        assert.ok(Math.hypot(last.x - item.to.x, last.y - item.to.y) <= 0.0036, `${label} file line ${item.fileLine}: arc ends at ${last.x},${last.y}, the file says ${item.to.x},${item.to.y}`);

        // the whole angle, and not a lap more
        let expected = angleOf(item.to, c) - angleOf(item.from, c);
        if (item.cw) { while (expected > 0) expected -= 2 * Math.PI; } else { while (expected < 0) expected += 2 * Math.PI; }
        if (Math.abs(expected) < 1e-9) expected = item.cw ? -2 * Math.PI : 2 * Math.PI; // full circle
        assert.ok(Math.abs(Math.abs(swept) - Math.abs(expected)) <= Math.max(1e-3, 0.01 / Math.max(r, 0.01)),
            `${label} file line ${item.fileLine}: arc swept ${Math.abs(swept).toFixed(6)} rad, the file asks for ${Math.abs(expected).toFixed(6)}`);
    }
    assert.strictEqual(arcs, meta.arcCount, `${label}: counted ${arcs} arcs, compiler reported ${meta.arcCount}`);
    assert.strictEqual(segments, meta.arcSegmentCount, `${label}: chord count`);
    // grid rounding plus one step of chord bow
    assert.ok(worstSagitta <= 0.012, `${label}: chords bow ${worstSagitta} mm from the true arc`);
    return { arcs, segments, worstRadial, worstSagitta, lines, meta };
}

function checkFile(file) {
    const raw = fs.readFileSync(path.join(CORPUS, file), 'utf8');
    const r = checkProgram(file, raw);
    return { file, arcs: r.arcs, segments: r.segments, worstRadial: r.worstRadial, worstSagitta: r.worstSagitta };
}

function unitCases() {
    // quarter circle counter-clockwise, radius 10, centre at origin
    const q = checkProgram('quarter', 'G21\nG90\nG0 X10 Y0\nG3 X0 Y10 I-10 J0 F300');
    // enough chords that the cut never bows more than one step (0.005 mm) off
    // the true arc, and not so many that each is a pointless micro-move
    const chords = q.meta.arcSegmentCount;
    const maxBow = 10 * (1 - Math.cos((Math.PI / 2) / chords / 2));
    assert.ok(maxBow <= 0.005 + 1e-9, `quarter circle of r10 bows ${maxBow} mm with ${chords} chords`);
    assert.ok(chords <= 40, `r10 quarter circle should not need ${chords} chords`);
    assert.ok(q.lines[q.lines.length - 1].startsWith('G21 G90 G1 X0.000 Y10.000 '), 'ends exactly on the arc endpoint');

    // full circle (start == end) must not collapse to nothing
    const full = checkProgram('full circle', 'G21\nG90\nG0 X10 Y0\nG2 X10 Y0 I-10 J0 F300');
    assert.ok(full.meta.arcSegmentCount >= 4 * chords - 2, `a full circle must sweep all the way round, got ${full.meta.arcSegmentCount} chords vs ${chords} for a quarter`);
    assert.ok(full.lines[full.lines.length - 1].startsWith('G21 G90 G1 X10.000 Y0.000 '), 'a full circle returns to its start');

    // Explicit plus signs are legal G-code. They used to make the word vanish:
    // every coordinate read as "unchanged", so the whole arc collapsed onto one
    // point -- a silently wrong cut, no error anywhere.
    const plus = checkProgram('signed', 'G21\nG90\nG0 X0 Y0\nG2 X+10 Y+0 I+5 J0 F300');
    assert.ok(plus.meta.arcSegmentCount > 10, `signed arc became ${plus.meta.arcSegmentCount} chords`);

    // An arc AFTER an incremental section starts where the tool really is.
    checkProgram('after G91', 'G21\nG90\nG0 X0 Y0\nG91\nG1 X10 F300\nG1 Y10\nG90\nG2 X15 Y5 I5 J0');

    // An inch arc is cut to the same shape in millimetres
    checkProgram('inch', 'G20\nG90\nG0 X1 Y0\nG3 X0 Y1 I-1 J0 F20');

    // unsupported or damaged forms are refused with the file line, never silently mis-cut
    let meta = compileWire('G21\nG0 X0 Y0\nG2 X10 Y0 R3 F100').meta;
    assert.ok(meta.errors.some((e) => e.line === 3 && /radius/.test(e.msg)), JSON.stringify(meta.errors));
    meta = compileWire('G21\nG0 X10 Y0\nG2 X0 Y-3 I-10 J0 F100').meta;
    assert.ok(meta.errors.some((e) => e.line === 3 && /not a circle/.test(e.msg)), JSON.stringify(meta.errors));
    console.log('  ok  unit cases: quarter circle, full circle, signs, G91, inch, refused forms');
}

(function main() {
    console.log('Testing arc conversion geometry against the original files...');
    unitCases();
    if (!fs.existsSync(CORPUS)) {
        console.log(`  SKIP corpus: ${CORPUS} not found`);
        console.log('ALL TESTS PASSED SUCCESSFULLY!');
        return;
    }
    const files = fs.readdirSync(CORPUS).filter((f) => /\.(nc|ngc|gcode|tap|cnc)$/i.test(f)).sort();
    let total = 0;
    for (const f of files) {
        const r = checkFile(f);
        total += r.arcs;
        if (r.arcs) {
            console.log(`  ok  ${r.file}: ${r.arcs} arcs -> ${r.segments} chords, max ${r.worstRadial.toExponential(1)} mm off the arc, bow ${r.worstSagitta.toExponential(1)} mm`);
        }
    }
    console.log(`  ok  ${total} arcs across the corpus convert to the right shape`);
    console.log('ALL TESTS PASSED SUCCESSFULLY!');
})();
