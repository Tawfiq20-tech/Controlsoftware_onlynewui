/**
 * Re-export unified G-code parser types and methods for Visualizer3D.
 */
import {
    parseGcodeFile,
    type ParsedToolpath,
    type GCodeParseResult,
} from '../../utils/gcodeParser';

export type { ParsedToolpath, GCodeParseResult };

export function parseGcode(source: string): ParsedToolpath {
    return parseGcodeFile(source).parsedToolpath;
}
