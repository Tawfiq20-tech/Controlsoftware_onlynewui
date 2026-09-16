'use strict';

/**
 * Converts G2/G3 (IJ-form, XY-plane) arcs into short G1 chords, in the
 * host, before the text ever reaches firmware. easycnc_protocol.c's
 * GcodeMove struct (motion.h) has no arc-center field and rejects G2/G3
 * outright (GCODE_UNSUPPORTED) -- this is the fix for that gap that
 * doesn't touch the firmware or the user's uploaded file, only the
 * in-memory copy handed to JobStream.upload().
 *
 * Deliberately unit-agnostic: firmware's own G20/G21 modal handling
 * already scales X/Y/I/J by unit_scale, so this operates on whatever
 * units the file is already in and never converts anything.
 *
 * R-format and helical (Z-changing) arcs are NOT handled -- throws
 * instead of silently mis-converting. Every arc-bearing CAM export seen
 * on this project (Vectric, Carveco) uses IJ-form XY-plane arcs only.
 *
 * Tracks the G0/G1/G2/G3 modal motion word across lines: valid G-code lets
 * a CAM post chain several arc segments without repeating "G2"/"G3" on
 * every line (the motion mode carries over from the previous block, same
 * as it does for G1). A line with no motion word but an I/J token while
 * the last motion word was G2/G3 is such a continuation and must still be
 * tessellated -- firmware's line_has_arc() (easycnc_protocol.c:384) scans
 * the whole line for a literal G2/G3 token, so it only ever catches an
 * EXPLICIT arc word; a continuation line with none would sail through
 * unconverted into firmware and get queued as a wrong-shape straight cut
 * instead of being rejected -- worse than a NAK, a silent wrong carve.
 */

const { splitComment } = require('./resumeFromLine');

// How far a straight chord may bow away from the true arc: one motor step
// (0.005 mm), the same precision the rest of the pipeline works to. A fixed
// angular step cannot promise that -- the bow grows with the radius, so the
// old flat 3 deg left a 50 mm radius arc 0.017 mm inside the true curve while
// chopping a 1 mm radius arc into far more moves than it needs. Deriving the
// step from the radius fixes both ends: big arcs get finer, small arcs coarser.
const ARC_TOL_MM = 0.005;
// ...but never chop an arc into moves shorter than this. The controller has no
// lookahead, so every chord is a separate accelerate/decelerate: thousands of
// micro-moves make the machine crawl and chatter for no visible gain.
const MIN_CHORD_MM = 0.05;
// ...and never coarser than this, however tiny the arc.
const MAX_SEG_DEG = 5.0;
// Any G0/G1/G2/G3 word anywhere on the line, compact or spaced: "G2X1", "G02 X1",
// "G17 G2 X1", "g3x1". (?![0-9.]) keeps G20/G21/G28/G2.5 out. The previous
// /[Gg]0?[23]\b/ fast path never matched "G2X..." (no word boundary between
// "2" and "X"), so both Vectric Bluey files skipped conversion entirely and the
// firmware NAK'd the job at the first arc (plan BE-2).
const ARC_WORD_RE = /G\s*0*[23](?![0-9.])/i;
const G_WORD_RE = /G\s*(\d+(?:\.\d+)?)/gi;
// An explicit plus is legal G-code ("X+10.5", written by some posts). Without
// [-+]? the token simply did not match, the word vanished, and the arc was
// tessellated to the wrong endpoint -- or, when every word carried a sign,
// collapsed onto a single point. Silently the wrong cut.
const TOKEN_RE = /([XYZIJKF])\s*([-+]?\d*\.?\d+)/gi;

/** Last G0-G3 motion word on the line, plus G17/18/19, G90/91 and G20/21 changes. */
function scanGWords(line) {
    const res = { motion: null, plane: null, distance: null, units: null };
    G_WORD_RE.lastIndex = 0;
    let m;
    while ((m = G_WORD_RE.exec(line)) !== null) {
        const v = parseFloat(m[1]);
        if (v === 0 || v === 1 || v === 2 || v === 3) res.motion = String(v);
        else if (v === 17 || v === 18 || v === 19) res.plane = v;
        else if (v === 90 || v === 91) res.distance = v;
        else if (v === 20 || v === 21) res.units = v;
    }
    return res;
}

function parseTokens(line) {
    const toks = {};
    TOKEN_RE.lastIndex = 0;
    let m;
    while ((m = TOKEN_RE.exec(line)) !== null) {
        toks[m[1].toUpperCase()] = parseFloat(m[2]);
    }
    return toks;
}

/**
 * @param {number} mmPerUnit 25.4 for a G20 (inch) file, 1 for G21 -- the
 *   tolerances above are real distances, so they have to be expressed in
 *   whatever units the file is written in.
 */
function tessellateArc(sx, sy, ex, ey, i, j, clockwise, mmPerUnit) {
    const cx = sx + i;
    const cy = sy + j;
    const r = Math.hypot(sx - cx, sy - cy);
    const rEnd = Math.hypot(ex - cx, ey - cy);
    const startAng = Math.atan2(sy - cy, sx - cx);
    const endAng = Math.atan2(ey - cy, ex - cx);
    const fullCircle = Math.abs(sx - ex) < 1e-6 && Math.abs(sy - ey) < 1e-6;
    let sweep = endAng - startAng;
    if (clockwise) {
        if (fullCircle || sweep >= 0) sweep -= 2 * Math.PI;
    } else {
        if (fullCircle || sweep <= 0) sweep += 2 * Math.PI;
    }

    const tol = ARC_TOL_MM / mmPerUnit;
    const minChord = MIN_CHORD_MM / mmPerUnit;
    let dTheta = (MAX_SEG_DEG * Math.PI) / 180;
    if (r > tol) {
        const byTolerance = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - tol / r)));
        const byChord = 2 * Math.asin(Math.max(0, Math.min(1, minChord / (2 * r))));
        dTheta = Math.min(Math.max(byTolerance, byChord), dTheta);
    }
    const steps = Math.max(1, Math.ceil(Math.abs(sweep) / dTheta));

    const points = [];
    for (let k = 1; k <= steps; k++) {
        const ang = startAng + (sweep * k) / steps;
        // If the file's own start and end radius differ slightly (CAM rounding),
        // sweep the radius across the arc instead of stepping off the circle at
        // the end -- the same thing LinuxCNC does, and it lands exactly on both
        // endpoints either way.
        const rk = r + ((rEnd - r) * k) / steps;
        points.push([cx + rk * Math.cos(ang), cy + rk * Math.sin(ang)]);
    }
    if (points.length) points[points.length - 1] = [ex, ey]; // kill float drift, land exact
    return points;
}

/**
 * @param {string} gcodeText - raw job text, as loaded from the user's file
 * @returns {{ text: string, arcCount: number, segmentCount: number }}
 */
function linearizeArcs(gcodeText) {
    const raw = String(gcodeText);
    // 3D finishing files with hundreds of thousands of lines almost never
    // contain arcs. Fast-path out without allocating when no arc word exists
    // anywhere (comments included -- a false positive only costs the slow path).
    if (!ARC_WORD_RE.test(raw)) {
        return { text: raw, arcCount: 0, segmentCount: 0 };
    }

    const lines = raw.split(/\r?\n/);
    const out = [];
    let curX = 0;
    let curY = 0;
    let arcCount = 0;
    let segmentCount = 0;
    let motionMode = null; // last explicit G0/G1/G2/G3 word seen, '0'|'1'|'2'|'3'
    let plane = 17;
    let absolute = true;
    let mmPerUnit = 1; // G21 until the file says otherwise

    for (let idx = 0; idx < lines.length; idx++) {
        const line = lines[idx];
        // comments never contribute motion words (nested parentheses handled)
        const { code } = splitComment(line);
        const g = scanGWords(code);
        const explicitMotion = g.motion;
        if (g.plane !== null) plane = g.plane;
        if (g.distance !== null) absolute = g.distance === 90;
        if (g.units !== null) mmPerUnit = g.units === 20 ? 25.4 : 1;
        const isArc = explicitMotion === '2' || explicitMotion === '3'
            || (explicitMotion === null && (motionMode === '2' || motionMode === '3') && /[XYIJ]\s*[-+]?[0-9.]/i.test(code));

        if (explicitMotion !== null) motionMode = explicitMotion;

        if (!isArc) {
            // Track the pen position through EVERY move, incremental ones
            // included. Only absolute moves used to count, so a G91 section
            // (or a single G91 move) left this tracker behind: the next G90
            // arc was then tessellated from a stale start point, cutting the
            // wrong shape from a jump. Lines that do not move to a work
            // coordinate (G53/G28/G30 retracts, G92 offsets) are skipped --
            // their axis words are not a destination in this coordinate frame.
            if (/[XY]/i.test(code) && !/G\s*0*(?:53|28|30|92)(?![0-9.])/i.test(code)) {
                const toks = parseTokens(code);
                if (toks.X !== undefined) curX = absolute ? toks.X : curX + toks.X;
                if (toks.Y !== undefined) curY = absolute ? toks.Y : curY + toks.Y;
            }
            out.push(line);
            continue;
        }

        const where = `line ${idx + 1}: ${line.trim()}`;
        if (!absolute) {
            throw new Error(`Incremental (G91) arc not supported, ${where}`);
        }
        if (plane !== 17) {
            throw new Error(`Arc outside the XY plane (G${plane}) not supported, ${where}`);
        }
        if (/R\s*[-+]?[0-9.]/i.test(code)) {
            throw new Error(`R-format arc not supported, ${where}`);
        }
        const toks = parseTokens(code);
        if (toks.Z !== undefined) {
            throw new Error(`Helical (Z-changing) arc not supported, ${where}`);
        }
        if (toks.I === undefined && toks.J === undefined) {
            throw new Error(`Arc without I/J centre not supported, ${where}`);
        }

        const clockwise = motionMode === '2';
        const ex = toks.X !== undefined ? toks.X : curX;
        const ey = toks.Y !== undefined ? toks.Y : curY;
        const i = toks.I || 0;
        const j = toks.J || 0;
        const feed = toks.F;

        const pts = tessellateArc(curX, curY, ex, ey, i, j, clockwise, mmPerUnit);
        for (const [px, py] of pts) {
            let seg = `G1 X${px.toFixed(4)} Y${py.toFixed(4)}`;
            if (feed !== undefined) seg += ` F${feed}`;
            out.push(seg);
            segmentCount++;
        }
        curX = ex;
        curY = ey;
        arcCount++;
    }

    return { text: out.join('\n'), arcCount, segmentCount };
}

module.exports = linearizeArcs;
