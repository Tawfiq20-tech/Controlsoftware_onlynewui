/**
 * G-code parser → typed segments for the 3D visualizer.
 *
 * Supported codes:
 *   G0  rapid
 *   G1  feed move
 *   G2  CW arc
 *   G3  CCW arc
 *   G17/18/19  plane select (XY / XZ / YZ)
 *   G20 inches  /  G21 mm
 *   G90 absolute  /  G91 incremental
 *   G93/94 feed mode
 *   T<n>, S<n>, F<n>, M3/M5/M7/M9 — captured as state
 *
 * Arcs are tessellated into chord segments (max chord error 0.05 mm) so the
 * downstream renderer only has to draw lines.
 *
 * Returns Float32 typed arrays so they can drop straight into BufferGeometry
 * without per-frame GC churn.
 */

export type MotionType = 'rapid' | 'feed' | 'arc-cw' | 'arc-ccw';

export interface ParsedToolpath {
    /** Positions, 3 floats per vertex. */
    rapids:  Float32Array;
    cuts:    Float32Array;
    arcs:    Float32Array;
    /** Line index per segment (length = positions.length / 6). */
    rapidLines: Uint32Array;
    cutLines:   Uint32Array;
    arcLines:   Uint32Array;
    /** Per-segment feedrate (mm/min). Length = positions.length / 6. */
    cutFeeds:   Float32Array;
    arcFeeds:   Float32Array;
    /** Per-segment min Z (mm) — used for depth heatmap. */
    cutZs:      Float32Array;
    arcZs:      Float32Array;
    /** Cumulative duration (seconds) at the END of each segment. Lets the
     *  scrubber map a t∈[0..durationSec] → segment + interpolation factor. */
    cutCumSec:  Float32Array;
    arcCumSec:  Float32Array;
    bbox: { min: [number, number, number]; max: [number, number, number] };
    distance: { rapid: number; cut: number; arc: number };
    durationSec: number;
    lineCount: number;
    tools: number[];
    feedRange: [number, number];
    zRange: [number, number];
    units: 'mm' | 'in';
}

const ARC_CHORD_ERR = 0.05;       // mm — finer = more chord segments
const MIN_ARC_SEGMENTS = 6;
const MAX_ARC_SEGMENTS = 200;

interface State {
    x: number; y: number; z: number;
    plane: 'xy' | 'xz' | 'yz';
    absolute: boolean;
    units: 'mm' | 'in';
    feed: number;
    tool: number;
    spindle: number;
}

function parseLine(text: string): Map<string, number> {
    const out = new Map<string, number>();
    // Strip comments: (...) and ; to end-of-line.
    const cleaned = text.replace(/\([^)]*\)/g, '').replace(/;.*$/, '');
    const re = /([A-Z])\s*(-?\d*\.?\d+)/g;
    let m;
    while ((m = re.exec(cleaned))) {
        out.set(m[1], parseFloat(m[2]));
    }
    return out;
}

export function parseGcode(source: string): ParsedToolpath {
    const lines = source.split('\n');
    const state: State = {
        x: 0, y: 0, z: 0,
        plane: 'xy', absolute: true, units: 'mm',
        feed: 1000, tool: 0, spindle: 0,
    };

    const rapidsArr: number[] = [];
    const cutsArr:   number[] = [];
    const arcsArr:   number[] = [];
    const rLine: number[] = [];
    const cLine: number[] = [];
    const aLine: number[] = [];
    const cFeed: number[] = [];
    const aFeed: number[] = [];
    const cZ:    number[] = [];
    const aZ:    number[] = [];
    const cCum:  number[] = [];
    const aCum:  number[] = [];

    const tools = new Set<number>();
    let feedMin = Infinity, feedMax = 0;
    let bboxMin: [number, number, number] = [+Infinity, +Infinity, +Infinity];
    let bboxMax: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    let distRapid = 0, distCut = 0, distArc = 0;
    let duration = 0;

    let lastMotion: 'G0' | 'G1' | 'G2' | 'G3' = 'G0';

    for (let li = 0; li < lines.length; li++) {
        const fields = parseLine(lines[li]);
        if (fields.size === 0) continue;

        if (fields.has('G')) {
            const g = fields.get('G')!;
            if (g === 0) lastMotion = 'G0';
            else if (g === 1) lastMotion = 'G1';
            else if (g === 2) lastMotion = 'G2';
            else if (g === 3) lastMotion = 'G3';
            else if (g === 17) state.plane = 'xy';
            else if (g === 18) state.plane = 'xz';
            else if (g === 19) state.plane = 'yz';
            else if (g === 20) state.units = 'in';
            else if (g === 21) state.units = 'mm';
            else if (g === 90) state.absolute = true;
            else if (g === 91) state.absolute = false;
        }
        if (fields.has('T')) tools.add(fields.get('T')!);
        if (fields.has('S')) state.spindle = fields.get('S')!;
        if (fields.has('F')) {
            state.feed = fields.get('F')! * (state.units === 'in' ? 25.4 : 1);
            if (state.feed > 0) {
                feedMin = Math.min(feedMin, state.feed);
                feedMax = Math.max(feedMax, state.feed);
            }
        }

        // Compute target.
        const sx = state.units === 'in' ? 25.4 : 1;
        const tx = fields.has('X')
            ? (state.absolute ? fields.get('X')! * sx : state.x + fields.get('X')! * sx)
            : state.x;
        const ty = fields.has('Y')
            ? (state.absolute ? fields.get('Y')! * sx : state.y + fields.get('Y')! * sx)
            : state.y;
        const tz = fields.has('Z')
            ? (state.absolute ? fields.get('Z')! * sx : state.z + fields.get('Z')! * sx)
            : state.z;

        const hasMotionField = fields.has('X') || fields.has('Y') || fields.has('Z')
            || fields.has('I') || fields.has('J') || fields.has('K') || fields.has('R');
        if (!hasMotionField) continue;

        if (lastMotion === 'G0') {
            if (tx !== state.x || ty !== state.y || tz !== state.z) {
                rapidsArr.push(state.x, state.y, state.z, tx, ty, tz);
                rLine.push(li);
                const dx = tx - state.x, dy = ty - state.y, dz = tz - state.z;
                distRapid += Math.hypot(dx, dy, dz);
            }
            state.x = tx; state.y = ty; state.z = tz;
        } else if (lastMotion === 'G1') {
            if (tx !== state.x || ty !== state.y || tz !== state.z) {
                cutsArr.push(state.x, state.y, state.z, tx, ty, tz);
                cLine.push(li);
                cFeed.push(state.feed);
                cZ.push(Math.min(state.z, tz));
                const dx = tx - state.x, dy = ty - state.y, dz = tz - state.z;
                const d = Math.hypot(dx, dy, dz);
                distCut += d;
                if (state.feed > 0) duration += d / state.feed * 60;
                cCum.push(duration);
            }
            state.x = tx; state.y = ty; state.z = tz;
        } else {
            // G2 / G3.
            const cw = lastMotion === 'G2';
            const i = (fields.get('I') ?? 0) * sx;
            const j = (fields.get('J') ?? 0) * sx;
            // We support XY plane only; XZ/YZ rarely used in CNC routers.
            const cx = state.x + i;
            const cy = state.y + j;
            const r = Math.hypot(state.x - cx, state.y - cy);
            const a1 = Math.atan2(state.y - cy, state.x - cx);
            let a2 = Math.atan2(ty - cy, tx - cx);
            let sweep = cw ? (a1 - a2) : (a2 - a1);
            while (sweep <= 0) sweep += 2 * Math.PI;
            const arcLen = r * sweep;
            const segs = Math.min(MAX_ARC_SEGMENTS,
                Math.max(MIN_ARC_SEGMENTS,
                    Math.ceil(arcLen / Math.sqrt(8 * r * ARC_CHORD_ERR))));
            let px = state.x, py = state.y, pz = state.z;
            for (let k = 1; k <= segs; k++) {
                const t = k / segs;
                const a = cw ? a1 - sweep * t : a1 + sweep * t;
                const nx = cx + r * Math.cos(a);
                const ny = cy + r * Math.sin(a);
                const nz = state.z + (tz - state.z) * t;
                arcsArr.push(px, py, pz, nx, ny, nz);
                aLine.push(li);
                aFeed.push(state.feed);
                aZ.push(Math.min(pz, nz));
                const d = Math.hypot(nx - px, ny - py, nz - pz);
                distArc += d;
                if (state.feed > 0) duration += d / state.feed * 60;
                aCum.push(duration);
                px = nx; py = ny; pz = nz;
            }
            state.x = tx; state.y = ty; state.z = tz;
        }

        bboxMin = [Math.min(bboxMin[0], state.x), Math.min(bboxMin[1], state.y), Math.min(bboxMin[2], state.z)];
        bboxMax = [Math.max(bboxMax[0], state.x), Math.max(bboxMax[1], state.y), Math.max(bboxMax[2], state.z)];
    }

    if (!isFinite(feedMin)) feedMin = 0;
    if (!isFinite(bboxMin[0])) bboxMin = [0, 0, 0];
    if (!isFinite(bboxMax[0])) bboxMax = [0, 0, 0];

    return {
        rapids:  new Float32Array(rapidsArr),
        cuts:    new Float32Array(cutsArr),
        arcs:    new Float32Array(arcsArr),
        rapidLines: new Uint32Array(rLine),
        cutLines:   new Uint32Array(cLine),
        arcLines:   new Uint32Array(aLine),
        cutFeeds:   new Float32Array(cFeed),
        arcFeeds:   new Float32Array(aFeed),
        cutZs:      new Float32Array(cZ),
        arcZs:      new Float32Array(aZ),
        cutCumSec:  new Float32Array(cCum),
        arcCumSec:  new Float32Array(aCum),
        bbox: { min: bboxMin, max: bboxMax },
        distance: { rapid: distRapid, cut: distCut, arc: distArc },
        durationSec: duration,
        lineCount: lines.length,
        tools: [...tools],
        feedRange: [feedMin, feedMax],
        zRange: [bboxMin[2], bboxMax[2]],
        units: state.units,
    };
}
