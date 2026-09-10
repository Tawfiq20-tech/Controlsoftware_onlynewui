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

const MAX_SEG_DEG = 3.0;
const MOTION_LINE_RE = /^(?:N\d+\s*)?G0?([0123])(?!\d)/i;
const TOKEN_RE = /([XYZIJKF])\s*(-?\d*\.?\d+)/gi;

function parseTokens(line) {
    const toks = {};
    TOKEN_RE.lastIndex = 0;
    let m;
    while ((m = TOKEN_RE.exec(line)) !== null) {
        toks[m[1].toUpperCase()] = parseFloat(m[2]);
    }
    return toks;
}

function tessellateArc(sx, sy, ex, ey, i, j, clockwise) {
    const cx = sx + i;
    const cy = sy + j;
    const r = Math.hypot(sx - cx, sy - cy);
    const startAng = Math.atan2(sy - cy, sx - cx);
    let endAng = Math.atan2(ey - cy, ex - cx);
    const fullCircle = Math.abs(sx - ex) < 1e-6 && Math.abs(sy - ey) < 1e-6;
    let sweep = endAng - startAng;
    if (clockwise) {
        if (fullCircle || sweep >= 0) sweep -= 2 * Math.PI;
    } else {
        if (fullCircle || sweep <= 0) sweep += 2 * Math.PI;
    }
    const steps = Math.max(1, Math.ceil(Math.abs((sweep * 180) / Math.PI) / MAX_SEG_DEG));
    const points = [];
    for (let k = 1; k <= steps; k++) {
        const ang = startAng + (sweep * k) / steps;
        points.push([cx + r * Math.cos(ang), cy + r * Math.sin(ang)]);
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
    // contain arcs. Fast-path out immediately without allocating or regex scanning:
    if (!/[Gg]0?[23]\b/.test(raw)) {
        return { text: raw, arcCount: 0, segmentCount: 0 };
    }

    const lines = raw.split(/\r?\n/);
    const out = [];
    let curX = 0;
    let curY = 0;
    let arcCount = 0;
    let segmentCount = 0;
    let motionMode = null; // last explicit G0/G1/G2/G3 word seen, '0'|'1'|'2'|'3'

    for (const line of lines) {
        const m = MOTION_LINE_RE.exec(line);
        const explicitMotion = m ? m[1] : null;
        const isArc = explicitMotion === '2' || explicitMotion === '3'
            || (explicitMotion === null && (motionMode === '2' || motionMode === '3') && /[IJ]\s*-?[0-9.]/i.test(line));

        if (explicitMotion !== null) motionMode = explicitMotion;

        if (!isArc) {
            if (/[xyXY]/.test(line)) {
                const toks = parseTokens(line);
                if (toks.X !== undefined) curX = toks.X;
                if (toks.Y !== undefined) curY = toks.Y;
            }
            out.push(line);
            continue;
        }

        if (/\bR-?[0-9.]/i.test(line)) {
            throw new Error(`R-format arc not supported by linearizeArcs: ${line.trim()}`);
        }
        const toks = parseTokens(line);
        if (toks.Z !== undefined) {
            throw new Error(`Helical (Z-changing) arc not supported by linearizeArcs: ${line.trim()}`);
        }

        const clockwise = motionMode === '2';
        const ex = toks.X !== undefined ? toks.X : curX;
        const ey = toks.Y !== undefined ? toks.Y : curY;
        const i = toks.I || 0;
        const j = toks.J || 0;
        const feed = toks.F;

        const pts = tessellateArc(curX, curY, ex, ey, i, j, clockwise);
        for (const [px, py] of pts) {
            let seg = `G1X${px.toFixed(4)}Y${py.toFixed(4)}`;
            if (feed !== undefined) seg += `F${feed}`;
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
