import type { GCodeLine, ToolpathSegment } from '../types/cnc';
import { isMoveCommand, isRapidMove } from './gcodeParser';

/**
 * Build toolpath segments from G-code lines
 */
export function buildToolpathSegments(lines: GCodeLine[]): ToolpathSegment[] {
    const segments: ToolpathSegment[] = [];

    let unitScale = 1; // mm by default
    let absolute = true; // G90 absolute positioning
    let current = { x: 0, y: 0, z: 0 };
    let currentLayer = 0;
    let lastZ = 0;

    for (const line of lines) {
        const cmd = line.command.toUpperCase();

        // Handle unit changes
        if (cmd.includes('G20')) unitScale = 25.4; // inches to mm
        if (cmd.includes('G21')) unitScale = 1; // mm

        // Handle positioning mode
        if (cmd.includes('G90')) absolute = true;
        if (cmd.includes('G91')) absolute = false;

        // Only process move commands
        if (!isMoveCommand(cmd)) continue;

        // Calculate scaled coordinates
        const dx = (line.x ?? 0) * unitScale;
        const dy = (line.y ?? 0) * unitScale;
        const dz = (line.z ?? 0) * unitScale;

        // Calculate next position
        const next = absolute
            ? {
                x: line.x !== undefined ? dx : current.x,
                y: line.y !== undefined ? dy : current.y,
                z: line.z !== undefined ? dz : current.z,
            }
            : {
                x: current.x + (line.x !== undefined ? dx : 0),
                y: current.y + (line.y !== undefined ? dy : 0),
                z: current.z + (line.z !== undefined ? dz : 0),
            };

        // Track layers by Z-height changes
        if (line.z !== undefined && next.z !== lastZ) {
            currentLayer += 1;
            lastZ = next.z;
        }

        // Create segment if position changed
        const rapid = isRapidMove(cmd);
        if (current.x !== next.x || current.y !== next.y || current.z !== next.z) {
            segments.push({
                start: { ...current },
                end: { ...next },
                rapid,
                layer: currentLayer,
            });
        }

        current = next;
    }

    return segments;
}

/**
 * Calculate bounding box from toolpath segments
 */
export function calculateBoundingBox(segments: ToolpathSegment[]) {
    if (segments.length === 0) {
        return {
            min: { x: 0, y: 0, z: 0 },
            max: { x: 0, y: 0, z: 0 },
            center: { x: 0, y: 0, z: 0 },
            size: { x: 0, y: 0, z: 0 },
        };
    }

    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

    for (const segment of segments) {
        minX = Math.min(minX, segment.start.x, segment.end.x);
        minY = Math.min(minY, segment.start.y, segment.end.y);
        minZ = Math.min(minZ, segment.start.z, segment.end.z);
        maxX = Math.max(maxX, segment.start.x, segment.end.x);
        maxY = Math.max(maxY, segment.start.y, segment.end.y);
        maxZ = Math.max(maxZ, segment.start.z, segment.end.z);
    }

    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    const centerZ = (minZ + maxZ) / 2;

    return {
        min: { x: minX, y: minY, z: minZ },
        max: { x: maxX, y: maxY, z: maxZ },
        center: { x: centerX, y: centerY, z: centerZ },
        size: { x: maxX - minX, y: maxY - minY, z: maxZ - minZ },
    };
}
