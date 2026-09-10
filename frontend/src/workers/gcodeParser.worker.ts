/**
 * G-code Parser Web Worker
 *
 * Runs full G-code parsing and toolpath generation off the main UI thread.
 * Returns typed Float32/Uint32 arrays via transferable ArrayBuffers for 0ms IPC transfer.
 */

export interface GCodeLine {
    command: string;
    x?: number;
    y?: number;
    z?: number;
    f?: number;
    comment?: string;
}

export interface ToolpathSegment {
    start: { x: number; y: number; z: number };
    end: { x: number; y: number; z: number };
    rapid: boolean;
    layer: number;
}

export interface ParsedToolpath {
    rapids: Float32Array;
    cuts: Float32Array;
    arcs: Float32Array;
    rapidLines: Uint32Array;
    cutLines: Uint32Array;
    arcLines: Uint32Array;
    cutFeeds: Float32Array;
    arcFeeds: Float32Array;
    cutZs: Float32Array;
    arcZs: Float32Array;
    cutCumSec: Float32Array;
    arcCumSec: Float32Array;
    bbox: { min: [number, number, number]; max: [number, number, number] };
    distance: { rapid: number; cut: number; arc: number };
    durationSec: number;
    lineCount: number;
    tools: number[];
    feedRange: [number, number];
    zRange: [number, number];
    units: 'mm' | 'in';
}

export interface GCodeParseResult {
    lines: GCodeLine[];
    totalLines: number;
    bounds: {
        minX: number;
        maxX: number;
        minY: number;
        maxY: number;
        minZ: number;
        maxZ: number;
    };
    segments: ToolpathSegment[];
    parsedToolpath: ParsedToolpath;
    stats: {
        rapidCount: number;
        cutCount: number;
        arcCount: number;
        totalLengthMm: number;
        downsampled: boolean;
        originalSegments: number;
    };
}

const ARC_CHORD_ERR = 0.05;
const MIN_ARC_SEGMENTS = 6;
const MAX_ARC_SEGMENTS = 200;

function parseLineFields(text: string): Map<string, number> {
    const out = new Map<string, number>();
    const cleaned = text.replace(/\([^)]*\)/g, '').replace(/;.*$/, '');
    const re = /([A-Z])\s*(-?\d*\.?\d+)/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(cleaned)) !== null) {
        out.set(m[1].toUpperCase(), parseFloat(m[2]));
    }
    return out;
}

function extractComment(line: string): string | undefined {
    const m = line.match(/;(.*)/) || line.match(/\((.*?)\)/);
    return m ? m[1].trim() : undefined;
}

export function parseGcodeFileCore(content: string): GCodeParseResult {
    const rawLines = content.split('\n');
    const parsedLines: GCodeLine[] = [];
    const segments: ToolpathSegment[] = [];

    const state = {
        x: 0, y: 0, z: 0,
        plane: 'XY' as 'XY' | 'XZ' | 'YZ',
        absolute: true,
        units: 'mm' as 'mm' | 'in',
        feed: 1000,
        tool: 0,
        spindle: 0,
        offsetX: 0,
        offsetY: 0,
        offsetZ: 0,
    };

    const rapidsArr: number[] = [];
    const cutsArr: number[] = [];
    const arcsArr: number[] = [];
    const rLine: number[] = [];
    const cLine: number[] = [];
    const aLine: number[] = [];
    const cFeed: number[] = [];
    const aFeed: number[] = [];
    const cZ: number[] = [];
    const aZ: number[] = [];
    const cCum: number[] = [];
    const aCum: number[] = [];

    const tools = new Set<number>();
    let feedMin = Infinity, feedMax = 0;
    let bboxMin: [number, number, number] = [+Infinity, +Infinity, +Infinity];
    let bboxMax: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    let distRapid = 0, distCut = 0, distArc = 0;
    let duration = 0;
    let rapidCount = 0, cutCount = 0, arcCount = 0;
    let activeMotion: 'G0' | 'G1' | 'G2' | 'G3' | null = null;

    for (let li = 0; li < rawLines.length; li++) {
        const rawLine = rawLines[li];
        const trimmed = rawLine.trim();
        if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('(')) {
            continue;
        }

        const fields = parseLineFields(trimmed);
        const comment = extractComment(trimmed);

        if (fields.size === 0) {
            parsedLines.push({ command: trimmed, comment });
            continue;
        }

        // Check for G/M codes
        const gVal = fields.get('G');
        if (gVal !== undefined) {
            if (gVal === 0) activeMotion = 'G0';
            else if (gVal === 1) activeMotion = 'G1';
            else if (gVal === 2) activeMotion = 'G2';
            else if (gVal === 3) activeMotion = 'G3';
            else if (gVal === 17) state.plane = 'XY';
            else if (gVal === 18) state.plane = 'XZ';
            else if (gVal === 19) state.plane = 'YZ';
            else if (gVal === 20) state.units = 'in';
            else if (gVal === 21) state.units = 'mm';
            else if (gVal === 90) state.absolute = true;
            else if (gVal === 91) state.absolute = false;
        }

        if (fields.has('T')) tools.add(fields.get('T')!);
        if (fields.has('S')) state.spindle = fields.get('S')!;
        if (fields.has('F')) {
            const rawF = fields.get('F')!;
            state.feed = rawF * (state.units === 'in' ? 25.4 : 1);
            if (state.feed > 0) {
                feedMin = Math.min(feedMin, state.feed);
                feedMax = Math.max(feedMax, state.feed);
            }
        }

        // G92: set persistent work offset
        if (gVal === 92) {
            const scale = state.units === 'in' ? 25.4 : 1;
            if (fields.has('X')) state.offsetX = state.x - fields.get('X')! * scale;
            if (fields.has('Y')) state.offsetY = state.y - fields.get('Y')! * scale;
            if (fields.has('Z')) state.offsetZ = state.z - fields.get('Z')! * scale;
            parsedLines.push({ command: trimmed, comment });
            continue;
        }

        const oneShotMachine = gVal === 53;
        const hasMotionField = fields.has('X') || fields.has('Y') || fields.has('Z') ||
                               fields.has('I') || fields.has('J') || fields.has('K') || fields.has('R');

        if (!hasMotionField && gVal === undefined) {
            parsedLines.push({ command: trimmed, comment });
            continue;
        }

        const scale = state.units === 'in' ? 25.4 : 1;
        const resolveAxis = (val: number | undefined, current: number, offset: number): number => {
            if (val === undefined) return current;
            let v = state.absolute ? val * scale : current + val * scale;
            if (oneShotMachine) v = v - offset;
            return v;
        };

        const targetX = resolveAxis(fields.get('X'), state.x, state.offsetX);
        const targetY = resolveAxis(fields.get('Y'), state.y, state.offsetY);
        const targetZ = resolveAxis(fields.get('Z'), state.z, state.offsetZ);

        parsedLines.push({
            command: trimmed,
            x: targetX,
            y: targetY,
            z: targetZ,
            f: fields.get('F'),
            comment,
        });

        if (!activeMotion || !hasMotionField) {
            continue;
        }

        const startX = state.x;
        const startY = state.y;
        const startZ = state.z;

        if (activeMotion === 'G0') {
            if (targetX !== startX || targetY !== startY || targetZ !== startZ) {
                rapidsArr.push(startX, startY, startZ, targetX, targetY, targetZ);
                rLine.push(li);
                const d = Math.hypot(targetX - startX, targetY - startY, targetZ - startZ);
                distRapid += d;
                rapidCount++;
                segments.push({
                    start: { x: startX, y: startY, z: startZ },
                    end: { x: targetX, y: targetY, z: targetZ },
                    rapid: true,
                    layer: 0,
                });
            }
            state.x = targetX; state.y = targetY; state.z = targetZ;
        } else if (activeMotion === 'G1') {
            if (targetX !== startX || targetY !== startY || targetZ !== startZ) {
                cutsArr.push(startX, startY, startZ, targetX, targetY, targetZ);
                cLine.push(li);
                cFeed.push(state.feed);
                cZ.push(Math.min(startZ, targetZ));
                const d = Math.hypot(targetX - startX, targetY - startY, targetZ - startZ);
                distCut += d;
                cutCount++;
                if (state.feed > 0) duration += (d / state.feed) * 60;
                cCum.push(duration);
                segments.push({
                    start: { x: startX, y: startY, z: startZ },
                    end: { x: targetX, y: targetY, z: targetZ },
                    rapid: false,
                    layer: 0,
                });
            }
            state.x = targetX; state.y = targetY; state.z = targetZ;
        } else {
            // G2 / G3 Arc
            const cw = activeMotion === 'G2';
            const i = (fields.get('I') ?? 0) * scale;
            const j = (fields.get('J') ?? 0) * scale;
            const cx = startX + i;
            const cy = startY + j;
            const r = Math.hypot(startX - cx, startY - cy);
            const a1 = Math.atan2(startY - cy, startX - cx);
            let a2 = Math.atan2(targetY - cy, targetX - cx);
            let sweep = cw ? (a1 - a2) : (a2 - a1);
            while (sweep <= 0) sweep += 2 * Math.PI;
            const arcLen = r * sweep;
            const segs = Math.min(MAX_ARC_SEGMENTS,
                Math.max(MIN_ARC_SEGMENTS,
                    Math.ceil(arcLen / Math.sqrt(8 * Math.max(0.001, r) * ARC_CHORD_ERR))));

            let px = startX, py = startY, pz = startZ;
            arcCount++;
            for (let k = 1; k <= segs; k++) {
                const t = k / segs;
                const a = cw ? a1 - sweep * t : a1 + sweep * t;
                const nx = cx + r * Math.cos(a);
                const ny = cy + r * Math.sin(a);
                const nz = startZ + (targetZ - startZ) * t;
                arcsArr.push(px, py, pz, nx, ny, nz);
                aLine.push(li);
                aFeed.push(state.feed);
                aZ.push(Math.min(pz, nz));
                const d = Math.hypot(nx - px, ny - py, nz - pz);
                distArc += d;
                cutCount++;
                if (state.feed > 0) duration += (d / state.feed) * 60;
                aCum.push(duration);

                segments.push({
                    start: { x: px, y: py, z: pz },
                    end: { x: nx, y: ny, z: nz },
                    rapid: false,
                    layer: 0,
                });

                px = nx; py = ny; pz = nz;
            }
            state.x = targetX; state.y = targetY; state.z = targetZ;
        }

        bboxMin = [Math.min(bboxMin[0], state.x), Math.min(bboxMin[1], state.y), Math.min(bboxMin[2], state.z)];
        bboxMax = [Math.max(bboxMax[0], state.x), Math.max(bboxMax[1], state.y), Math.max(bboxMax[2], state.z)];
    }

    if (!isFinite(feedMin)) feedMin = 0;
    if (!isFinite(bboxMin[0])) bboxMin = [0, 0, 0];
    if (!isFinite(bboxMax[0])) bboxMax = [0, 0, 0];

    const rapids = new Float32Array(rapidsArr);
    const cuts = new Float32Array(cutsArr);
    const arcs = new Float32Array(arcsArr);
    const rapidLines = new Uint32Array(rLine);
    const cutLines = new Uint32Array(cLine);
    const arcLines = new Uint32Array(aLine);
    const cutFeeds = new Float32Array(cFeed);
    const arcFeeds = new Float32Array(aFeed);
    const cutZs = new Float32Array(cZ);
    const arcZs = new Float32Array(aZ);
    const cutCumSec = new Float32Array(cCum);
    const arcCumSec = new Float32Array(aCum);

    // Hard segment downsample cap for backward-compatible segments array (max 100k)
    const originalSegments = segments.length;
    let finalSegments = segments;
    let downsampled = false;
    if (segments.length > 100_000) {
        const stride = Math.ceil(segments.length / 100_000);
        finalSegments = segments.filter((_, i) => i % stride === 0);
        downsampled = true;
    }

    const totalLengthMm = distRapid + distCut + distArc;

    const parsedToolpath: ParsedToolpath = {
        rapids,
        cuts,
        arcs,
        rapidLines,
        cutLines,
        arcLines,
        cutFeeds,
        arcFeeds,
        cutZs,
        arcZs,
        cutCumSec,
        arcCumSec,
        bbox: { min: bboxMin, max: bboxMax },
        distance: { rapid: distRapid, cut: distCut, arc: distArc },
        durationSec: duration,
        lineCount: rawLines.length,
        tools: [...tools],
        feedRange: [feedMin, feedMax],
        zRange: [bboxMin[2], bboxMax[2]],
        units: state.units,
    };

    return {
        lines: parsedLines,
        totalLines: parsedLines.length,
        bounds: {
            minX: bboxMin[0],
            maxX: bboxMax[0],
            minY: bboxMin[1],
            maxY: bboxMax[1],
            minZ: bboxMin[2],
            maxZ: bboxMax[2],
        },
        segments: finalSegments,
        parsedToolpath,
        stats: {
            rapidCount,
            cutCount,
            arcCount,
            totalLengthMm,
            downsampled,
            originalSegments,
        },
    };
}

// Web Worker message listener
if (typeof self !== 'undefined' && 'addEventListener' in self && typeof (self as unknown as Worker).postMessage === 'function') {
    self.addEventListener('message', (e: MessageEvent<{ type: string; id?: number; content: string }>) => {
        if (!e.data || e.data.type !== 'PARSE') return;
        try {
            const result = parseGcodeFileCore(e.data.content);
            const pt = result.parsedToolpath;
            const transferList = [
                pt.rapids.buffer,
                pt.cuts.buffer,
                pt.arcs.buffer,
                pt.rapidLines.buffer,
                pt.cutLines.buffer,
                pt.arcLines.buffer,
                pt.cutFeeds.buffer,
                pt.arcFeeds.buffer,
                pt.cutZs.buffer,
                pt.arcZs.buffer,
                pt.cutCumSec.buffer,
                pt.arcCumSec.buffer,
            ];
            (self as unknown as Worker).postMessage({ type: 'SUCCESS', id: e.data.id, result }, transferList);
        } catch (err) {
            (self as unknown as Worker).postMessage({
                type: 'ERROR',
                id: e.data.id,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    });
}
