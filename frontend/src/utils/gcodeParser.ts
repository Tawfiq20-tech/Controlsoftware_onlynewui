import type { GCodeLine, ToolpathSegment } from '../types/cnc';

/**
 * Enhanced G-code parser with visualization support.
 *
 * v1.3 (Phase A) additions:
 *   - G2 / G3 arc parsing (IJK center-offset and R radius forms)
 *   - G17 / G18 / G19 plane selection (XY / XZ / YZ)
 *   - G92  (set position — applies a work offset)
 *   - G53  (one-shot machine coordinates — skips work offset)
 *   - Hard segment cap (MAX_SEGMENTS) — downsamples evenly if exceeded
 */

export interface GCodeFile {
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
    stats: {
        rapidCount: number;
        cutCount: number;
        arcCount: number;
        totalLengthMm: number;
        downsampled: boolean;
        originalSegments: number;
    };
}

const MAX_SEGMENTS = 100_000;
const ARC_SEGS_PER_TURN = 64;
const ARC_MIN_SEGS = 6;

type Plane = 'XY' | 'XZ' | 'YZ';

export class GCodeParser {
    private currentX = 0;
    private currentY = 0;
    private currentZ = 0;
    private absoluteMode = true;
    private units: 'mm' | 'inches' = 'mm';
    private plane: Plane = 'XY';
    private offsetX = 0;
    private offsetY = 0;
    private offsetZ = 0;
    private activeMotion: 'G0' | 'G1' | 'G2' | 'G3' | null = null;

    parseGCode(content: string): GCodeFile {
        const lines = content.split('\n');
        const parsedLines: GCodeLine[] = [];
        const segments: ToolpathSegment[] = [];

        let minX = Infinity, maxX = -Infinity;
        let minY = Infinity, maxY = -Infinity;
        let minZ = Infinity, maxZ = -Infinity;
        let rapidCount = 0;
        let cutCount = 0;
        let arcCount = 0;
        let totalLengthMm = 0;

        console.log('[GCodeParser] Starting parse. Total lines:', lines.length);

        lines.forEach((rawLine) => {
            const trimmed = rawLine.trim();
            if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('(')) return;

            const tokens = this.tokenize(trimmed);
            if (tokens.length === 0) return;

            const params: Record<string, number> = {};
            const motions: string[] = [];
            const modal: string[] = [];

            for (const tok of tokens) {
                const letter = tok[0];
                const rest = tok.slice(1);
                const value = parseFloat(rest);

                if (letter === 'G' || letter === 'M') {
                    const code = `${letter}${parseInt(rest, 10)}`;
                    if (code === 'G0' || code === 'G1' || code === 'G2' || code === 'G3') {
                        motions.push(code);
                    } else {
                        modal.push(code);
                    }
                } else if (isFinite(value)) {
                    params[letter] = value;
                }
            }

            // Modal state updates
            for (const m of modal) {
                if (m === 'G17') this.plane = 'XY';
                else if (m === 'G18') this.plane = 'XZ';
                else if (m === 'G19') this.plane = 'YZ';
                else if (m === 'G20') this.units = 'inches';
                else if (m === 'G21') this.units = 'mm';
                else if (m === 'G90') this.absoluteMode = true;
                else if (m === 'G91') this.absoluteMode = false;
            }

            // G53: one-shot machine coords — temporarily zero work offsets for this block.
            const oneShotMachine = modal.includes('G53');

            // G92: set current position to the given coords (applies a persistent offset).
            if (modal.includes('G92')) {
                if (params.X !== undefined) this.offsetX = this.currentX - params.X;
                if (params.Y !== undefined) this.offsetY = this.currentY - params.Y;
                if (params.Z !== undefined) this.offsetZ = this.currentZ - params.Z;
                parsedLines.push({ command: trimmed, comment: this.extractComment(trimmed) });
                return;
            }

            // Resolve motion mode (sticky like vendor controllers)
            const motion = motions[0]
                ? (motions[0] as 'G0' | 'G1' | 'G2' | 'G3')
                : (this.hasAxisWord(params) ? this.activeMotion : null);

            if (motions[0]) this.activeMotion = motions[0] as 'G0' | 'G1' | 'G2' | 'G3';

            if (!motion) {
                parsedLines.push({ command: trimmed, comment: this.extractComment(trimmed) });
                return;
            }

            const startX = this.currentX;
            const startY = this.currentY;
            const startZ = this.currentZ;

            const resolveAxis = (val: number | undefined, current: number, offset: number): number => {
                if (val === undefined) return current;
                let v = this.absoluteMode ? val : current + val;
                if (oneShotMachine) v = v - offset;
                return v;
            };

            const targetX = resolveAxis(params.X, startX, this.offsetX);
            const targetY = resolveAxis(params.Y, startY, this.offsetY);
            const targetZ = resolveAxis(params.Z, startZ, this.offsetZ);

            const isRapid = motion === 'G0';
            const isArc = motion === 'G2' || motion === 'G3';

            parsedLines.push({
                command: trimmed,
                x: targetX,
                y: targetY,
                z: targetZ,
                f: params.F,
                comment: this.extractComment(trimmed),
            });

            if (isArc) {
                const clockwise = motion === 'G2';
                const arcSegs = this.buildArcSegments({
                    startX, startY, startZ,
                    endX: targetX, endY: targetY, endZ: targetZ,
                    iOff: params.I, jOff: params.J, kOff: params.K,
                    radius: params.R,
                    clockwise,
                    plane: this.plane,
                });
                arcCount++;
                for (const seg of arcSegs) {
                    segments.push(seg);
                    cutCount++;
                    minX = Math.min(minX, seg.start.x, seg.end.x); maxX = Math.max(maxX, seg.start.x, seg.end.x);
                    minY = Math.min(minY, seg.start.y, seg.end.y); maxY = Math.max(maxY, seg.start.y, seg.end.y);
                    minZ = Math.min(minZ, seg.start.z, seg.end.z); maxZ = Math.max(maxZ, seg.start.z, seg.end.z);
                    totalLengthMm += this.dist(seg.start, seg.end);
                }
            } else {
                const seg: ToolpathSegment = {
                    start: { x: startX, y: startY, z: startZ },
                    end: { x: targetX, y: targetY, z: targetZ },
                    rapid: isRapid,
                    layer: 0,
                };
                segments.push(seg);
                if (isRapid) rapidCount++; else cutCount++;
                minX = Math.min(minX, startX, targetX); maxX = Math.max(maxX, startX, targetX);
                minY = Math.min(minY, startY, targetY); maxY = Math.max(maxY, startY, targetY);
                minZ = Math.min(minZ, startZ, targetZ); maxZ = Math.max(maxZ, startZ, targetZ);
                totalLengthMm += this.dist(seg.start, seg.end);
            }

            this.currentX = targetX;
            this.currentY = targetY;
            this.currentZ = targetZ;
        });

        // Inches → mm conversion
        const unitMultiplier = this.units === 'inches' ? 25.4 : 1.0;
        if (unitMultiplier !== 1.0) {
            console.log('[GCodeParser] Converting inches → mm');
            segments.forEach(seg => {
                seg.start.x *= unitMultiplier; seg.start.y *= unitMultiplier; seg.start.z *= unitMultiplier;
                seg.end.x *= unitMultiplier;   seg.end.y *= unitMultiplier;   seg.end.z *= unitMultiplier;
            });
            minX *= unitMultiplier; maxX *= unitMultiplier;
            minY *= unitMultiplier; maxY *= unitMultiplier;
            minZ *= unitMultiplier; maxZ *= unitMultiplier;
            totalLengthMm *= unitMultiplier;
        }

        // Segment guard
        const originalSegments = segments.length;
        let finalSegments = segments;
        let downsampled = false;
        if (segments.length > MAX_SEGMENTS) {
            const stride = Math.ceil(segments.length / MAX_SEGMENTS);
            finalSegments = segments.filter((_, i) => i % stride === 0);
            downsampled = true;
            console.warn(`[GCodeParser] Downsampled ${originalSegments} → ${finalSegments.length} (stride ${stride})`);
        }

        console.log('[GCodeParser] Done. Segments:', finalSegments.length,
            'Rapids:', rapidCount, 'Cuts:', cutCount, 'Arcs:', arcCount,
            'Length:', totalLengthMm.toFixed(1), 'mm');

        return {
            lines: parsedLines,
            totalLines: parsedLines.length,
            bounds: {
                minX: minX === Infinity ? 0 : minX,
                maxX: maxX === -Infinity ? 0 : maxX,
                minY: minY === Infinity ? 0 : minY,
                maxY: maxY === -Infinity ? 0 : maxY,
                minZ: minZ === Infinity ? 0 : minZ,
                maxZ: maxZ === -Infinity ? 0 : maxZ,
            },
            segments: finalSegments,
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

    // Tokenizer — handles "G1X10Y20" (no spaces) and "G1 X10 Y20" alike.
    private tokenize(line: string): string[] {
        const code = line.split(';')[0].split('(')[0];
        const out: string[] = [];
        const re = /([GMXYZIJKRFEPST])\s*(-?\d*\.?\d+)/gi;
        let m: RegExpExecArray | null;
        while ((m = re.exec(code)) !== null) {
            out.push(m[1].toUpperCase() + m[2]);
        }
        return out;
    }

    private extractComment(line: string): string | undefined {
        const m = line.match(/;(.*)/) || line.match(/\((.*?)\)/);
        return m ? m[1].trim() : undefined;
    }

    private hasAxisWord(p: Record<string, number>): boolean {
        return p.X !== undefined || p.Y !== undefined || p.Z !== undefined;
    }

    private dist(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) {
        const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
        return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    // Arc interpolation — IJK form (exact) or R form (resolved via perpendicular bisector).
    private buildArcSegments(opts: {
        startX: number; startY: number; startZ: number;
        endX: number; endY: number; endZ: number;
        iOff?: number; jOff?: number; kOff?: number;
        radius?: number;
        clockwise: boolean;
        plane: Plane;
    }): ToolpathSegment[] {
        const { plane, clockwise } = opts;

        const pick = (p: { x: number; y: number; z: number }) => {
            if (plane === 'XY') return { u: p.x, v: p.y, w: p.z };
            if (plane === 'XZ') return { u: p.x, v: p.z, w: p.y };
            return { u: p.y, v: p.z, w: p.x };
        };
        const unpick = (u: number, v: number, w: number): { x: number; y: number; z: number } => {
            if (plane === 'XY') return { x: u, y: v, z: w };
            if (plane === 'XZ') return { x: u, y: w, z: v };
            return { x: w, y: u, z: v };
        };

        const start = pick({ x: opts.startX, y: opts.startY, z: opts.startZ });
        const end   = pick({ x: opts.endX,   y: opts.endY,   z: opts.endZ });

        let cu: number, cv: number;
        if (opts.iOff !== undefined || opts.jOff !== undefined || opts.kOff !== undefined) {
            let dU: number, dV: number;
            if (plane === 'XY') { dU = opts.iOff ?? 0; dV = opts.jOff ?? 0; }
            else if (plane === 'XZ') { dU = opts.iOff ?? 0; dV = opts.kOff ?? 0; }
            else { dU = opts.jOff ?? 0; dV = opts.kOff ?? 0; }
            cu = start.u + dU;
            cv = start.v + dV;
        } else if (opts.radius !== undefined) {
            const mx = (start.u + end.u) / 2;
            const my = (start.v + end.v) / 2;
            const dx = end.u - start.u;
            const dy = end.v - start.v;
            const chord = Math.hypot(dx, dy);
            const r = opts.radius;
            const absR = Math.abs(r);
            const h2 = absR * absR - (chord / 2) * (chord / 2);
            if (h2 < 0 || chord < 1e-9) {
                return [{
                    start: { x: opts.startX, y: opts.startY, z: opts.startZ },
                    end: { x: opts.endX, y: opts.endY, z: opts.endZ },
                    rapid: false, layer: 0,
                }];
            }
            const h = Math.sqrt(h2);
            const px = -dy / chord;
            const py = dx / chord;
            const shortArc = r > 0;
            const ccw = !clockwise;
            const sign = (shortArc === ccw) ? 1 : -1;
            cu = mx + sign * h * px;
            cv = my + sign * h * py;
        } else {
            return [{
                start: { x: opts.startX, y: opts.startY, z: opts.startZ },
                end: { x: opts.endX, y: opts.endY, z: opts.endZ },
                rapid: false, layer: 0,
            }];
        }

        const r0 = Math.hypot(start.u - cu, start.v - cv);
        if (r0 < 1e-9) {
            return [{
                start: { x: opts.startX, y: opts.startY, z: opts.startZ },
                end: { x: opts.endX, y: opts.endY, z: opts.endZ },
                rapid: false, layer: 0,
            }];
        }

        const aStart = Math.atan2(start.v - cv, start.u - cu);
        const aEnd   = Math.atan2(end.v   - cv, end.u   - cu);

        let sweep = aEnd - aStart;
        if (clockwise) {
            while (sweep > 0) sweep -= 2 * Math.PI;
            if (sweep === 0) sweep = -2 * Math.PI;
        } else {
            while (sweep < 0) sweep += 2 * Math.PI;
            if (sweep === 0) sweep = 2 * Math.PI;
        }

        const turns = Math.abs(sweep) / (2 * Math.PI);
        const nSegs = Math.max(ARC_MIN_SEGS, Math.ceil(turns * ARC_SEGS_PER_TURN));

        const segs: ToolpathSegment[] = [];
        let prevPoint = { x: opts.startX, y: opts.startY, z: opts.startZ };
        for (let i = 1; i <= nSegs; i++) {
            const t = i / nSegs;
            const a = aStart + sweep * t;
            const u = cu + r0 * Math.cos(a);
            const v = cv + r0 * Math.sin(a);
            const w = start.w + (end.w - start.w) * t;
            const pt = unpick(u, v, w);
            segs.push({
                start: { ...prevPoint },
                end: { ...pt },
                rapid: false,
                layer: 0,
            });
            prevPoint = pt;
        }
        return segs;
    }

    // GPU helpers — G-code X→world X, Y→-world Z, Z→world Y mapping is done in the renderer.
    getToolpathVertices(segments: ToolpathSegment[]): Float32Array {
        const vertices: number[] = [];
        segments.forEach(segment => {
            vertices.push(
                segment.start.x, segment.start.z || 0, segment.start.y,
                segment.end.x,   segment.end.z   || 0, segment.end.y
            );
        });
        return new Float32Array(vertices);
    }

    getToolpathColors(segments: ToolpathSegment[]): Float32Array {
        const colors: number[] = [];
        const cutR = 0.35, cutG = 0.85, cutB = 1.0;
        const rapidR = 0.5, rapidG = 0.65, rapidB = 0.75;
        segments.forEach(segment => {
            if (segment.rapid) colors.push(rapidR, rapidG, rapidB, rapidR, rapidG, rapidB);
            else               colors.push(cutR, cutG, cutB, cutR, cutG, cutB);
        });
        return new Float32Array(colors);
    }
}

// Legacy exports
export function parseGCode(content: string): GCodeLine[] {
    const parser = new GCodeParser();
    return parser.parseGCode(content).lines;
}

export function isMoveCommand(command: string): boolean {
    return /\b(G0|G00|G1|G01|G2|G02|G3|G03)\b/i.test(command);
}

export function isRapidMove(command: string): boolean {
    return /\b(G0|G00)\b/i.test(command);
}

export function getCommandType(command: string): string | null {
    const match = command.match(/\b(G\d+)\b/i);
    return match ? match[1].toUpperCase() : null;
}
