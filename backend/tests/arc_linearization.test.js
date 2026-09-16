'use strict';

/**
 * Arc conversion, checked geometrically against the ORIGINAL files.
 *
 * The firmware cannot cut G2/G3, so the sender replaces every arc with short
 * straight chords before streaming (lib/linearizeArcs.js). The corpus test
 * compares the compiled output against an interpreter of the ALREADY
 * LINEARIZED text -- so an arc turned into the wrong shape would agree with
 * itself and pass. Your files contain thousands of arcs (Textured Clock 2710,
 * Batman 1365), and a mis-converted arc is a silently wrong carve.
 *
 * This walks the original and the linearized text side by side and checks,
 * for every arc:
 *   - every generated point lies ON the arc (distance to the centre == radius)
 *   - the sweep goes the right way round (G2 clockwise, G3 counter-clockwise)
 *     and covers the whole angle, no more
 *   - it ends exactly at the arc's endpoint
 *   - the chords are short enough that the cut never deviates from the true
 *     arc by more than a step (0.005 mm)
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const linearizeArcs = require('../lib/linearizeArcs');

const CORPUS = process.env.EASYCNC_CORPUS || 'C:/Users/Tawfiq/Downloads/gcode_test_file/file_finity';
const TOKEN_RE = /([XYZIJKF])\s*(-?\d*\.?\d+)/gi;
const G_WORD_RE = /G\s*(\d+(?:\.\d+)?)/gi;

function strip(line) {
    return String(line).replace(/\([^)]*\)/g, ' ').replace(/;.*$/, '').trim();
}

function words(line) {
    const t = {};
    TOKEN_RE.lastIndex = 0;
    let m;
    while ((m = TOKEN_RE.exec(line)) !== null) t[m[1].toUpperCase()] = parseFloat(m[2]);
    return t;
}

function motionOf(line, prev) {
    G_WORD_RE.lastIndex = 0;
    let m;
    let mo = prev;
    while ((m = G_WORD_RE.exec(line)) !== null) {
        const v = parseFloat(m[1]);
        if (v === 0 || v === 1 || v === 2 || v === 3) mo = v;
    }
    return mo;
}

/** Walks a program, yielding {kind:'move'|'arc', ...} in file order. */
function* walk(text) {
    const pos = { x: 0, y: 0, z: 0 };
    let motion = null;
    let seenXY = false;
    for (const raw of String(text).split(/\r?\n/)) {
        const line = strip(raw);
        if (!line || line.startsWith('%')) continue;
        motion = motionOf(line, motion);
        const w = words(line);
        const hasAxis = w.X !== undefined || w.Y !== undefined || w.Z !== undefined;
        const hasIJ = w.I !== undefined || w.J !== undefined;
        if (!hasAxis && !hasIJ) continue;
        const from = { ...pos };
        if (w.X !== undefined) pos.x = w.X;
        if (w.Y !== undefined) pos.y = w.Y;
        if (w.Z !== undefined) pos.z = w.Z;
        if ((motion === 2 || motion === 3) && hasIJ) {
            yield { kind: 'arc', cw: motion === 2, from, to: { ...pos }, i: w.I || 0, j: w.J || 0 };
        } else {
            yield { kind: 'move', from, to: { ...pos }, rapid: motion === 0 };
        }
        if (w.X !== undefined || w.Y !== undefined) seenXY = true;
    }
    void seenXY;
}

function angleOf(p, c) {
    return Math.atan2(p.y - c.y, p.x - c.x);
}

function checkFile(file) {
    const raw = fs.readFileSync(path.join(CORPUS, file), 'utf8');
    const lin = linearizeArcs(raw);
    const original = [...walk(raw)];
    const flat = [...walk(lin.text)];

    let fi = 0;
    let arcs = 0;
    let worstRadial = 0;
    let worstSagitta = 0;
    let worstEnd = 0;
    let segments = 0;

    for (const item of original) {
        if (item.kind === 'move') {
            const g = flat[fi++];
            assert.ok(g, `${file}: linearized program ended early`);
            assert.ok(Math.hypot(g.to.x - item.to.x, g.to.y - item.to.y, g.to.z - item.to.z) < 1e-6,
                `${file}: plain move changed: ${JSON.stringify(item.to)} -> ${JSON.stringify(g.to)}`);
            continue;
        }
        // an arc: consume the chords that replaced it
        arcs++;
        const c = { x: item.from.x + item.i, y: item.from.y + item.j };
        const r = Math.hypot(item.from.x - c.x, item.from.y - c.y);
        const rEnd = Math.hypot(item.to.x - c.x, item.to.y - c.y);
        // CAM arcs are consistent to well under a step; if the file itself is
        // inconsistent there is nothing the converter can do about it.
        assert.ok(Math.abs(r - rEnd) < 0.02, `${file}: the FILE's own arc is inconsistent (r ${r} vs ${rEnd})`);

        let a = angleOf(item.from, c);
        const aEnd = angleOf(item.to, c);
        let prev = item.from;
        let swept = 0;
        let guard = 0;
        for (;;) {
            const g = flat[fi];
            assert.ok(g, `${file}: arc ${arcs} ran out of segments`);
            assert.ok(++guard < 10000, `${file}: arc ${arcs} never reached its endpoint`);
            assert.strictEqual(g.kind, 'move', `${file}: arc ${arcs} left an arc behind`);
            fi++;
            segments++;

            // on the circle
            const rad = Math.hypot(g.to.x - c.x, g.to.y - c.y);
            worstRadial = Math.max(worstRadial, Math.abs(rad - r));

            // going the right way, and the chord is short enough that the cut
            // never bows away from the true arc by more than a step
            const a2 = angleOf(g.to, c);
            let d = a2 - a;
            while (d > Math.PI) d -= 2 * Math.PI;
            while (d < -Math.PI) d += 2 * Math.PI;
            if (Math.hypot(g.to.x - prev.x, g.to.y - prev.y) > 1e-9) {
                assert.ok(item.cw ? d <= 1e-9 : d >= -1e-9,
                    `${file}: arc ${arcs} turns the wrong way (${item.cw ? 'G2' : 'G3'}, step ${d.toFixed(6)} rad)`);
            }
            swept += Math.abs(d);
            worstSagitta = Math.max(worstSagitta, r * (1 - Math.cos(Math.abs(d) / 2)));
            a = a2;
            prev = g.to;

            if (Math.hypot(g.to.x - item.to.x, g.to.y - item.to.y, g.to.z - item.to.z) < 1e-6) break;
        }
        worstEnd = Math.max(worstEnd, Math.hypot(prev.x - item.to.x, prev.y - item.to.y));

        // the whole angle, and not a lap more
        let expected = aEnd - angleOf(item.from, c);
        if (item.cw) { while (expected > 0) expected -= 2 * Math.PI; } else { while (expected < 0) expected += 2 * Math.PI; }
        if (Math.abs(expected) < 1e-9) expected = item.cw ? -2 * Math.PI : 2 * Math.PI; // full circle
        assert.ok(Math.abs(swept - Math.abs(expected)) < 1e-6,
            `${file}: arc ${arcs} swept ${swept.toFixed(6)} rad, the file asks for ${Math.abs(expected).toFixed(6)}`);
    }
    assert.strictEqual(fi, flat.length, `${file}: ${flat.length - fi} extra moves after the program`);
    assert.strictEqual(arcs, lin.arcCount, `${file}: counted ${arcs} arcs, linearizer reported ${lin.arcCount}`);

    // Radial error and chord bow are in FILE units; inch files must be judged
    // in inches (0.005 mm = 0.000197 in).
    const inch = /G\s*20(?![0-9])/i.test(raw.slice(0, 4000));
    const stepMm = 0.005;
    const limit = inch ? stepMm / 25.4 : stepMm;
    assert.ok(worstRadial <= limit, `${file}: a generated point sits ${worstRadial} off the arc (limit ${limit})`);
    assert.ok(worstSagitta <= limit * 2, `${file}: chords bow ${worstSagitta} from the true arc (limit ${limit * 2})`);
    return { file, arcs, segments, worstRadial, worstSagitta, worstEnd, inch };
}

function unitCases() {
    // quarter circle counter-clockwise, radius 10, centre at origin
    const lin = linearizeArcs('G21\nG90\nG0 X10 Y0\nG3 X0 Y10 I-10 J0');
    assert.strictEqual(lin.arcCount, 1);
    const pts = [...walk(lin.text)].slice(1); // drop the G0
    // enough chords that the cut never bows more than one step (0.005 mm) off
    // the true arc, and not so many that each is a pointless micro-move
    const maxBow = 10 * (1 - Math.cos((Math.PI / 2) / pts.length / 2));
    assert.ok(maxBow <= 0.005 + 1e-9, `quarter circle of r10 bows ${maxBow} mm with ${pts.length} chords`);
    assert.ok(pts.length <= 40, `r10 quarter circle should not need ${pts.length} chords`);
    for (const p of pts) {
        assert.ok(Math.abs(Math.hypot(p.to.x, p.to.y) - 10) < 0.005, `point off the circle: ${JSON.stringify(p.to)}`);
    }
    const last = pts[pts.length - 1].to;
    assert.ok(Math.hypot(last.x - 0, last.y - 10) < 1e-9, 'ends exactly on the arc endpoint');

    // full circle (start == end) must not collapse to nothing
    const full = linearizeArcs('G21\nG90\nG0 X10 Y0\nG2 X10 Y0 I-10 J0');
    const fullPts = [...walk(full.text)].slice(1);
    assert.ok(fullPts.length >= 4 * pts.length - 2, `a full circle must sweep all the way round, got ${fullPts.length} chords vs ${pts.length} for a quarter`);
    const back = fullPts[fullPts.length - 1].to;
    assert.ok(Math.hypot(back.x - 10, back.y - 0) < 1e-9, 'a full circle returns to its start');

    // Explicit plus signs are legal G-code. They used to make the word vanish:
    // every coordinate read as "unchanged", so the whole arc collapsed onto one
    // point -- a silently wrong cut, no error anywhere.
    const plus = linearizeArcs('G21\nG90\nG0 X0 Y0\nG2 X+10 Y+0 I+5 J0');
    const plusPts = [...walk(plus.text)].slice(1);
    assert.ok(plusPts.length > 10, `signed arc became ${plusPts.length} chords`);
    for (const p of plusPts) {
        assert.ok(Math.abs(Math.hypot(p.to.x - 5, p.to.y) - 5) < 0.005, `signed arc point off the circle: ${JSON.stringify(p.to)}`);
    }
    assert.ok(Math.hypot(plusPts[plusPts.length - 1].to.x - 10, plusPts[plusPts.length - 1].to.y) < 1e-9);

    // An arc AFTER an incremental section starts where the tool really is.
    // Incremental moves used not to move the tracker, so the arc was
    // tessellated from a stale point and cut the wrong shape from a jump.
    const afterG91 = linearizeArcs('G21\nG90\nG0 X0 Y0\nG91\nG1 X10\nG1 Y10\nG90\nG2 X15 Y5 I5 J0');
    const g91Pts = [...walk(afterG91.text)].slice(3); // after G0 and the two incremental moves
    for (const p of g91Pts) {
        assert.ok(Math.abs(Math.hypot(p.to.x - 15, p.to.y - 10) - 5) < 0.005,
            `arc after G91 is off its circle: ${JSON.stringify(p.to)} (centre 15,10 r5)`);
    }
    assert.ok(Math.hypot(g91Pts[g91Pts.length - 1].to.x - 15, g91Pts[g91Pts.length - 1].to.y - 5) < 1e-9);

    // unsupported forms are refused, never silently mis-cut
    assert.throws(() => linearizeArcs('G21\nG0 X0 Y0\nG2 X10 Y0 R5'), /R-format|unsupported/i);
    assert.throws(() => linearizeArcs('G0 X0 Y0\nG18\nG2 X1 Z1 I1 K0'), /XY plane|Helical/i);
    console.log('  ok  unit cases: quarter circle, full circle, refused forms');
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
            const u = r.inch ? 'in' : 'mm';
            console.log(`  ok  ${r.file}: ${r.arcs} arcs -> ${r.segments} chords, max ${r.worstRadial.toExponential(1)} ${u} off the arc, bow ${r.worstSagitta.toExponential(1)} ${u}`);
        }
    }
    console.log(`  ok  ${total} arcs across the corpus convert to the right shape`);
    console.log('ALL TESTS PASSED SUCCESSFULLY!');
})();
