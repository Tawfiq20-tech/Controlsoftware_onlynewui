'use strict';

/**
 * Arc geometry for the wire compiler: G2/G3 become short G1 chords in the
 * host, because easycnc_protocol.c's GcodeMove struct (motion.h) has no
 * arc-centre field and the firmware rejects G2/G3 outright.
 *
 * 2026-09-17: the chords are no longer produced by a text pass of their own.
 * This file used to rewrite each arc line into "G1 X.. Y.. F.." text before
 * the wire compiler saw the program, with its own idea of the modal state.
 * Two interpreters of the same program disagreed (dialect audit D4-1/D4-2):
 *  - every other word on an arc line (G90/G91, G20/G21, G90.1, G41, G93,
 *    T/M6, M0, S) was thrown away -- 'G90 G2 ...' after a G91 section cut
 *    out to X390 at depth, 'G21 G2 ...' in an inch file went to X1270 mm;
 *  - "G4 X1" (a dwell) moved its X tracker, and a G20/G21 switch was never
 *    rescaled, so the next arc started from a point the machine was not at.
 * The arc is now expanded inside lib/wireCompiler.js, in the same pass that
 * owns units, distance modes, position and the refusal rules. What stays here
 * is the pure geometry: chord points, and the centre of an R-format arc.
 *
 * linearizeArcs(text) is kept for callers that pipe its text into
 * compileWire() (RSPController macro:run): the text comes back unchanged,
 * because compileWire() converts the arcs itself; arcCount / segmentCount are
 * what that compile converted.
 */

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

/**
 * Chord end points of an arc in its plane, in FILE units.
 * @param {number} sx,sy start   @param {number} ex,ey end   @param {number} cx,cy centre
 * @param {boolean} clockwise G2
 * @param {number} mmPerUnit 25.4 for a G20 (inch) file, 1 for G21 -- the
 *   tolerances above are real distances, so they have to be expressed in
 *   whatever units the file is written in.
 * @returns {number[][]} [[u, v], ...]; the last point is exactly [ex, ey]
 */
function tessellateArcAround(sx, sy, ex, ey, cx, cy, clockwise, mmPerUnit) {
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

    const steps = arcSteps(r, sweep, mmPerUnit);
    const points = [];
    for (let k = 1; k <= steps; k++) {
        const ang = startAng + (sweep * k) / steps;
        // If the file's own start and end radius differ slightly (CAM rounding),
        // sweep the radius across the arc instead of stepping off the circle at
        // the end -- the same thing LinuxCNC does, and it lands exactly on both
        // endpoints either way. (Large differences are refused by the compiler.)
        const rk = r + ((rEnd - r) * k) / steps;
        points.push([cx + rk * Math.cos(ang), cy + rk * Math.sin(ang)]);
    }
    if (points.length) points[points.length - 1] = [ex, ey]; // kill float drift, land exact
    return points;
}

/** Number of chords for a radius (file units) and a signed sweep (radians). */
function arcSteps(r, sweep, mmPerUnit) {
    const tol = ARC_TOL_MM / mmPerUnit;
    const minChord = MIN_CHORD_MM / mmPerUnit;
    let dTheta = (MAX_SEG_DEG * Math.PI) / 180;
    if (r > tol) {
        const byTolerance = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - tol / r)));
        const byChord = 2 * Math.asin(Math.max(0, Math.min(1, minChord / (2 * r))));
        dTheta = Math.min(Math.max(byTolerance, byChord), dTheta);
    }
    return Math.max(1, Math.ceil(Math.abs(sweep) / dTheta));
}

/** Same as tessellateArcAround() with the centre given as I/J offsets from the start. */
function tessellateArc(sx, sy, ex, ey, i, j, clockwise, mmPerUnit) {
    return tessellateArcAround(sx, sy, ex, ey, sx + i, sy + j, clockwise, mmPerUnit);
}

/**
 * Centre of an R-format arc (RS274NGC): of the two circles of radius |R|
 * through start and end, R > 0 takes the one whose arc turns at most half a
 * turn, R < 0 the longer way round.
 * @param {number} slackUnits how far the chord may exceed the diameter (rounding in the file)
 * @returns {{cx:number, cy:number}|{error:string}}
 */
function arcCentreFromRadius(sx, sy, ex, ey, R, clockwise, slackUnits) {
    const dx = ex - sx;
    const dy = ey - sy;
    const d = Math.hypot(dx, dy);
    if (d < 1e-9) return { error: 'an R-format arc cannot describe a full circle (start and end are the same point) -- use I/J for a full circle' };
    const r = Math.abs(R);
    const half = d / 2;
    let h = 0;
    if (r < half) {
        if (half - r > slackUnits) return { error: `arc radius R${R} is too small to reach from the start to the end point (they are ${d.toFixed(4)} apart)` };
    } else {
        h = Math.sqrt(r * r - half * half);
    }
    // Left of the start->end direction for a counter-clockwise short arc;
    // mirrored for clockwise, and again for the long way (negative R).
    let side = clockwise ? -1 : 1;
    if (R < 0) side = -side;
    return { cx: sx + dx / 2 - (side * h * dy) / d, cy: sy + dy / 2 + (side * h * dx) / d };
}

/**
 * Compatibility entry (see the header): the program text, unchanged, plus
 * the arc counts the wire compiler reports for it.
 * @param {string} gcodeText
 * @returns {{ text: string, arcCount: number, segmentCount: number }}
 */
function linearizeArcs(gcodeText) {
    const text = String(gcodeText);
    // Loaded here, not at the top: wireCompiler.js requires this file.
    const { compileWire } = require('./wireCompiler');
    const { meta } = compileWire(text, { motionLimit: { enabled: false } });
    return { text, arcCount: meta.arcCount, segmentCount: meta.arcSegmentCount };
}

module.exports = linearizeArcs;
module.exports.linearizeArcs = linearizeArcs;
module.exports.tessellateArc = tessellateArc;
module.exports.tessellateArcAround = tessellateArcAround;
module.exports.arcCentreFromRadius = arcCentreFromRadius;
module.exports.arcSteps = arcSteps;
module.exports.ARC_TOL_MM = ARC_TOL_MM;
module.exports.MIN_CHORD_MM = MIN_CHORD_MM;
module.exports.MAX_SEG_DEG = MAX_SEG_DEG;
