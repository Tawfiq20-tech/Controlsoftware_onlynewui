import type { GCodeLine, ToolpathSegment } from '../types/cnc';
import {
    parseGcodeFileCore,
    type ParsedToolpath,
    type GCodeParseResult,
} from '../workers/gcodeParser.worker';

export type { ParsedToolpath, GCodeParseResult };

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

/**
 * Synchronous unified G-code parser.
 * Produces lines, typed Float32 arrays for Three.js, segments, bounds, and stats in a single pass.
 */
export function parseGcodeFile(content: string): GCodeParseResult {
    return parseGcodeFileCore(content);
}

// ── Web Worker Singleton & Async Dispatch ─────────────────────────────
let workerInstance: Worker | null = null;
let reqId = 0;
const pendingRequests = new Map<number, {
    resolve: (res: GCodeParseResult) => void;
    reject: (err: Error) => void;
}>();

function getOrCreateWorker(): Worker | null {
    if (typeof window === 'undefined' || typeof Worker === 'undefined') {
        return null;
    }
    if (!workerInstance) {
        try {
            workerInstance = new Worker(
                new URL('../workers/gcodeParser.worker.ts', import.meta.url),
                { type: 'module' }
            );
            workerInstance.onmessage = (e: MessageEvent<{ type: string; id?: number; result?: GCodeParseResult; error?: string }>) => {
                const { id, type, result, error } = e.data;
                if (id === undefined) return;
                const req = pendingRequests.get(id);
                if (!req) return;
                pendingRequests.delete(id);

                if (type === 'SUCCESS' && result) {
                    req.resolve(result);
                } else {
                    req.reject(new Error(error || 'Worker parsing failed'));
                }
            };
            workerInstance.onerror = (err) => {
                console.warn('[GCodeParserWorker] Worker error, falling back to main thread:', err);
                for (const [, req] of pendingRequests) {
                    req.reject(new Error('Worker encountered an error'));
                }
                pendingRequests.clear();
                workerInstance = null;
            };
        } catch (e) {
            console.warn('[GCodeParserWorker] Worker initialization failed:', e);
            workerInstance = null;
        }
    }
    return workerInstance;
}

/**
 * Async G-code parser. Offloads parsing to a Web Worker with zero-copy transferable buffers.
 * Transparently falls back to synchronous main thread parsing if workers are unavailable.
 */
export async function parseGcodeAsync(content: string): Promise<GCodeParseResult> {
    const worker = getOrCreateWorker();
    if (!worker) {
        return parseGcodeFile(content);
    }

    const currentId = ++reqId;
    return new Promise<GCodeParseResult>((resolve, reject) => {
        pendingRequests.set(currentId, { resolve, reject });
        try {
            worker.postMessage({ type: 'PARSE', id: currentId, content });
        } catch (postErr) {
            pendingRequests.delete(currentId);
            console.warn('[GCodeParserWorker] postMessage failed, falling back to sync parse:', postErr);
            try {
                resolve(parseGcodeFile(content));
            } catch (syncErr) {
                reject(syncErr instanceof Error ? syncErr : new Error(String(syncErr)));
            }
        }
    });
}

/**
 * Backwards compatible GCodeParser class.
 * Handles G90 (absolute), G91 (incremental), G20 (inches), G21 (mm), arcs (G2/G3).
 */
export class GCodeParser {
    parseGCode(content: string): GCodeFile {
        const res = parseGcodeFileCore(content);
        return {
            lines: res.lines,
            totalLines: res.totalLines,
            bounds: res.bounds,
            segments: res.segments,
            stats: res.stats,
        };
    }

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

export function parseGCode(content: string): GCodeLine[] {
    return parseGcodeFileCore(content).lines;
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
