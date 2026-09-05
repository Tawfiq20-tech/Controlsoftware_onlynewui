/**
 * Phase 1 verification: Core Infrastructure
 *   - Type definitions (cnc.ts)
 *   - Formatters (formatters.ts)
 *   - G-code parser (gcodeParser.ts)
 *   - Toolpath builder (toolpathBuilder.ts)
 *   - Zustand store shape (cncStore.ts)
 *
 * Run with: npx tsx tests/phase1.test.ts   (from frontend/)
 */

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string) {
    if (condition) {
        passed++;
        console.log(`  PASS  ${label}`);
    } else {
        failed++;
        console.error(`  FAIL  ${label}`);
    }
}

// ── 1. Type definitions ─────────────────────────────────────────────────────
console.log('\n=== 1. Type definitions (cnc.ts) ===');
import type {
    MachineState,
    JogMode,
    ViewMode3D,
    ViewPreset,
    ConsoleMessageType,
    ConsoleLine,
    GCodeLine,
    ToolpathSegment,
    Position,
    FileInfo,
    SystemStatus,
} from '../src/types/cnc';

// If the imports compiled, the types exist. Verify shapes at runtime.
const samplePos: Position = { x: 1, y: 2, z: 3 };
assert(samplePos.x === 1 && samplePos.y === 2 && samplePos.z === 3, 'Position type has x, y, z');

const sampleLine: GCodeLine = { command: 'G0 X10', x: 10, comment: 'rapid' };
assert(sampleLine.command === 'G0 X10' && sampleLine.x === 10, 'GCodeLine type has command, x, y, z, f, comment');

const sampleSeg: ToolpathSegment = {
    start: { x: 0, y: 0, z: 0 },
    end: { x: 10, y: 10, z: 0 },
    rapid: true,
    layer: 0,
};
assert(sampleSeg.rapid === true && sampleSeg.layer === 0, 'ToolpathSegment type has start, end, rapid, layer');

const sampleConsole: ConsoleLine = { type: 'info', text: 'hello', time: '12:00' };
assert(sampleConsole.type === 'info', 'ConsoleLine type has type, text, time');

const sampleFile: FileInfo = { name: 'test.nc', size: 1024, lines: 50 };
assert(sampleFile.name === 'test.nc', 'FileInfo type has name, size, lines');

const sampleStatus: SystemStatus = { controller: 'grbl 1.1', buffer: 50, feedRate: 500, spindle: 'ON' };
assert(sampleStatus.controller === 'grbl 1.1', 'SystemStatus type has controller, buffer, feedRate, spindle');

// Verify union types compile (runtime check: assign and compare)
const ms: MachineState = 'running';
assert(['idle', 'running', 'paused', 'alarm'].includes(ms), 'MachineState union includes running');

const jm: JogMode = 'continuous';
assert(['continuous', 'step'].includes(jm), 'JogMode union includes continuous');

const vm: ViewMode3D = 'layers';
assert(['wireframe', 'solid', 'layers'].includes(vm), 'ViewMode3D union includes layers');

const vp: ViewPreset = 'back';
assert(['iso', 'top', 'front', 'right', 'bottom', 'left', 'back'].includes(vp), 'ViewPreset union includes back');

const cmt: ConsoleMessageType = 'warning';
assert(['system', 'info', 'success', 'warning', 'error'].includes(cmt), 'ConsoleMessageType union includes warning');

// ── 2. Formatters ───────────────────────────────────────────────────────────
console.log('\n=== 2. Formatters ===');
import {
    formatAxisValue,
    formatFileSize,
    formatTime,
    getTimestamp,
    formatPercentage,
} from '../src/utils/formatters';

assert(formatAxisValue(1.23456) === '1.235', 'formatAxisValue rounds to 3 decimals');
assert(formatAxisValue(0) === '0.000', 'formatAxisValue zero');
assert(formatAxisValue(-5.1) === '-5.100', 'formatAxisValue negative');

assert(formatFileSize(0) === '0 Bytes', 'formatFileSize 0');
assert(formatFileSize(1024) === '1 KB', 'formatFileSize 1KB');
assert(formatFileSize(1048576) === '1 MB', 'formatFileSize 1MB');
assert(formatFileSize(500) === '500 Bytes', 'formatFileSize 500 bytes');

assert(formatTime(0) === '00:00', 'formatTime 0s');
assert(formatTime(61) === '01:01', 'formatTime 61s');
assert(formatTime(3661) === '01:01:01', 'formatTime 3661s (1h 1m 1s)');

assert(typeof getTimestamp() === 'string' && getTimestamp().length > 0, 'getTimestamp returns non-empty string');

assert(formatPercentage(50.7) === '51%', 'formatPercentage rounds');
assert(formatPercentage(0) === '0%', 'formatPercentage zero');
assert(formatPercentage(100) === '100%', 'formatPercentage 100');

// ── 3. G-code parser ────────────────────────────────────────────────────────
console.log('\n=== 3. G-code parser ===');
import { GCodeParser, parseGCode, isMoveCommand, isRapidMove, getCommandType } from '../src/utils/gcodeParser';

// 3a. Basic parsing
const parser = new GCodeParser();
const basicGcode = `
; header comment
G21 ; mm mode
G90 ; absolute
G0 X10 Y20 Z5
G1 X30 Y40 Z-1 F500
G0 X0 Y0 Z5
`;
const result = parser.parseGCode(basicGcode);

assert(result.totalLines > 0, 'parser returns parsed lines');
assert(result.segments.length === 3, 'parser creates 3 segments (3 move commands)');
assert(result.bounds.maxX === 30, 'bounds maxX = 30');
assert(result.bounds.maxY === 40, 'bounds maxY = 40');
assert(result.bounds.minZ === -1, 'bounds minZ = -1');

// 3b. Rapid vs feed detection
assert(result.segments[0].rapid === true, 'G0 is rapid');
assert(result.segments[1].rapid === false, 'G1 is not rapid');

// 3c. Comment handling
const commentGcode = `G0 X10 ; move to start\n; full line comment\nG1 Y20 F300`;
const parser2 = new GCodeParser();
const commentResult = parser2.parseGCode(commentGcode);
assert(commentResult.totalLines === 2, 'comments-only lines are skipped');

// 3d. G91 relative mode
const relativeGcode = `G21\nG90\nG0 X10 Y10\nG91\nG1 X5 Y5 F200\nG1 X5 Y5 F200`;
const parser3 = new GCodeParser();
const relResult = parser3.parseGCode(relativeGcode);
// After G0 X10 Y10, then G91 relative G1 X5 Y5 twice => final should be X20 Y20
const lastSeg = relResult.segments[relResult.segments.length - 1];
assert(lastSeg.end.x === 20 && lastSeg.end.y === 20, 'G91 relative mode accumulates correctly');

// 3e. G20 inches mode
const inchGcode = `G20\nG90\nG0 X1 Y1 Z0`;
const parser4 = new GCodeParser();
const inchResult = parser4.parseGCode(inchGcode);
// 1 inch = 25.4 mm
assert(
    Math.abs(inchResult.segments[0].end.x - 25.4) < 0.01,
    'G20 inches mode converts to mm (25.4)'
);

// 3f. Legacy functions
assert(isMoveCommand('G0 X10') === true, 'isMoveCommand G0');
assert(isMoveCommand('G1 X10 F500') === true, 'isMoveCommand G1');
assert(isMoveCommand('G21') === false, 'isMoveCommand G21 is not a move');
assert(isRapidMove('G0 X10') === true, 'isRapidMove G0');
assert(isRapidMove('G1 X10') === false, 'isRapidMove G1 is not rapid');
assert(getCommandType('G0 X10') === 'G0', 'getCommandType G0');
assert(getCommandType('G1 X10 F500') === 'G1', 'getCommandType G1');
assert(getCommandType('no command here') === null, 'getCommandType null for no G-code');

// 3g. parseGCode legacy wrapper
const legacyLines = parseGCode('G0 X10\nG1 Y20 F300');
assert(Array.isArray(legacyLines) && legacyLines.length === 2, 'parseGCode legacy returns array of GCodeLine');

// 3h. Vertex and color generation
const parser5 = new GCodeParser();
const vertResult = parser5.parseGCode('G21\nG90\nG0 X10 Y20\nG1 X30 Y40 F500');
const vertices = parser5.getToolpathVertices(vertResult.segments);
assert(vertices instanceof Float32Array, 'getToolpathVertices returns Float32Array');
assert(vertices.length === vertResult.segments.length * 6, 'vertices has 6 floats per segment (2 points * 3 coords)');

const colors = parser5.getToolpathColors(vertResult.segments);
assert(colors instanceof Float32Array, 'getToolpathColors returns Float32Array');
assert(colors.length === vertResult.segments.length * 6, 'colors has 6 floats per segment (2 points * 3 RGB)');

// ── 4. Toolpath builder ─────────────────────────────────────────────────────
console.log('\n=== 4. Toolpath builder ===');
import { buildToolpathSegments, calculateBoundingBox } from '../src/utils/toolpathBuilder';

// 4a. Build segments from parsed lines
const lines: GCodeLine[] = [
    { command: 'G21' },
    { command: 'G90' },
    { command: 'G0 X10 Y10', x: 10, y: 10 },
    { command: 'G1 X20 Y20 F500', x: 20, y: 20, f: 500 },
    { command: 'G0 X0 Y0 Z5', x: 0, y: 0, z: 5 },
];
const segs = buildToolpathSegments(lines);
assert(segs.length === 3, 'buildToolpathSegments creates 3 segments from 3 moves');
assert(segs[0].rapid === true, 'first segment (G0) is rapid');
assert(segs[1].rapid === false, 'second segment (G1) is not rapid');
assert(segs[2].rapid === true, 'third segment (G0) is rapid');

// 4b. Segment coordinates
assert(segs[0].start.x === 0 && segs[0].start.y === 0, 'first segment starts at origin');
assert(segs[0].end.x === 10 && segs[0].end.y === 10, 'first segment ends at (10,10)');
assert(segs[1].start.x === 10 && segs[1].end.x === 20, 'second segment from 10 to 20');

// 4c. Layer tracking
assert(segs[2].layer > segs[1].layer, 'Z-change increments layer');

// 4d. Bounding box
const bbox = calculateBoundingBox(segs);
assert(bbox.min.x === 0 && bbox.min.y === 0, 'bbox min is (0,0)');
assert(bbox.max.x === 20 && bbox.max.y === 20, 'bbox max is (20,20)');
assert(bbox.center.x === 10 && bbox.center.y === 10, 'bbox center is (10,10)');
assert(bbox.size.x === 20 && bbox.size.y === 20, 'bbox size is (20,20)');

// 4e. Empty bounding box
const emptyBbox = calculateBoundingBox([]);
assert(emptyBbox.min.x === 0 && emptyBbox.max.x === 0, 'empty bbox returns zeros');

// 4f. Inch conversion
const inchLines: GCodeLine[] = [
    { command: 'G20' },
    { command: 'G90' },
    { command: 'G0 X1 Y1', x: 1, y: 1 },
];
const inchSegs = buildToolpathSegments(inchLines);
assert(
    Math.abs(inchSegs[0].end.x - 25.4) < 0.01,
    'toolpath builder converts inches to mm (25.4)'
);

// 4g. Relative mode
const relLines: GCodeLine[] = [
    { command: 'G21' },
    { command: 'G90' },
    { command: 'G0 X10 Y10', x: 10, y: 10 },
    { command: 'G91' },
    { command: 'G1 X5 Y5 F200', x: 5, y: 5, f: 200 },
];
const relSegs = buildToolpathSegments(relLines);
assert(relSegs.length === 2, 'relative mode creates 2 segments');
assert(relSegs[1].end.x === 15 && relSegs[1].end.y === 15, 'relative G1 X5 Y5 from (10,10) = (15,15)');

// ── 5. Zustand store shape ──────────────────────────────────────────────────
console.log('\n=== 5. Zustand store shape ===');

// We can't fully test the store without a DOM (React), but we can verify the
// module exports and the store's initial state shape.
// Dynamic import to avoid issues with React DOM in Node.
const storeModule = await import('../src/stores/cncStore');
const { useCNCStore } = storeModule;

assert(typeof useCNCStore === 'function', 'useCNCStore is exported as a function');

// Get initial state
const state = useCNCStore.getState();

// Connection state
assert(state.connected === false, 'initial connected = false');
assert(state.connectionStatus === 'disconnected', 'initial connectionStatus = disconnected');
assert(state.connectionMode === 'browser', 'initial connectionMode = browser');
assert(state.backendSocketConnected === false, 'initial backendSocketConnected = false');
assert(typeof state.setConnected === 'function', 'setConnected action exists');
assert(typeof state.setConnectionStatus === 'function', 'setConnectionStatus action exists');
assert(typeof state.setConnectionMode === 'function', 'setConnectionMode action exists');
assert(typeof state.connectToPort === 'function', 'connectToPort action exists');
assert(typeof state.connectToBackend === 'function', 'connectToBackend action exists');
assert(typeof state.disconnect === 'function', 'disconnect action exists');
assert(typeof state.sendCommand === 'function', 'sendCommand action exists');

// Machine state
assert(state.machineState === 'idle', 'initial machineState = idle');
assert(typeof state.setMachineState === 'function', 'setMachineState action exists');

// Position
assert(state.position.x === 0 && state.position.y === 0 && state.position.z === 0, 'initial position = (0,0,0)');
assert(typeof state.setPosition === 'function', 'setPosition action exists');
assert(typeof state.updatePosition === 'function', 'updatePosition action exists');

// Jog controls
assert(state.jogMode === 'step', 'initial jogMode = step');
assert(typeof state.jogDistance === 'number', 'jogDistance is a number');
assert(typeof state.setJogMode === 'function', 'setJogMode action exists');
assert(typeof state.setJogDistance === 'function', 'setJogDistance action exists');

// Overrides
assert(typeof state.feedRate === 'number', 'feedRate is a number');
assert(typeof state.spindleSpeed === 'number', 'spindleSpeed is a number');
assert(typeof state.rapidRate === 'number', 'rapidRate is a number');
assert(typeof state.setFeedRate === 'function', 'setFeedRate action exists');
assert(typeof state.setSpindleSpeed === 'function', 'setSpindleSpeed action exists');
assert(typeof state.setRapidRate === 'function', 'setRapidRate action exists');

// G-code & file
assert(Array.isArray(state.gcode), 'gcode is an array');
assert(Array.isArray(state.toolpathSegments), 'toolpathSegments is an array');
assert(typeof state.setGcode === 'function', 'setGcode action exists');
assert(typeof state.setToolpathSegments === 'function', 'setToolpathSegments action exists');
assert(typeof state.setFileInfo === 'function', 'setFileInfo action exists');

// 3D view
assert(['wireframe', 'solid', 'layers'].includes(state.viewMode3D), 'viewMode3D is a valid ViewMode3D');
assert(typeof state.setViewMode3D === 'function', 'setViewMode3D action exists');
assert(typeof state.setViewPreset === 'function', 'setViewPreset action exists');
assert(typeof state.showGrid3D === 'boolean', 'showGrid3D is a boolean');

// Console
assert(Array.isArray(state.consoleLines), 'consoleLines is an array');
assert(typeof state.addConsoleLog === 'function', 'addConsoleLog action exists');
assert(typeof state.clearConsole === 'function', 'clearConsole action exists');

// Job control
assert(typeof state.jobProgress === 'number', 'jobProgress is a number');
assert(typeof state.currentLine === 'number', 'currentLine is a number');
assert(typeof state.jobLoadBackend === 'function', 'jobLoadBackend action exists');
assert(typeof state.jobStartBackend === 'function', 'jobStartBackend action exists');
assert(typeof state.jobPauseBackend === 'function', 'jobPauseBackend action exists');
assert(typeof state.jobResumeBackend === 'function', 'jobResumeBackend action exists');
assert(typeof state.jobStopBackend === 'function', 'jobStopBackend action exists');
assert(typeof state.jobQueueBackend === 'function', 'jobQueueBackend action exists');

// Backend controls
assert(typeof state.jogBackend === 'function', 'jogBackend action exists');
assert(typeof state.homeBackend === 'function', 'homeBackend action exists');
assert(typeof state.unlockBackend === 'function', 'unlockBackend action exists');

// Queue counts
assert(typeof state.queueCounts === 'object', 'queueCounts is an object');
assert(typeof state.queueCounts.waiting === 'number', 'queueCounts.waiting is a number');
assert(typeof state.setQueueCounts === 'function', 'setQueueCounts action exists');

// Raw gcode content
assert(state.rawGcodeContent === null, 'initial rawGcodeContent = null');
assert(typeof state.setRawGcodeContent === 'function', 'setRawGcodeContent action exists');

// ── 5b. Store mutations ─────────────────────────────────────────────────────
console.log('\n=== 5b. Store mutations ===');

// Test setPosition
useCNCStore.getState().setPosition({ x: 10, y: 20, z: 30 });
assert(
    useCNCStore.getState().position.x === 10 &&
    useCNCStore.getState().position.y === 20 &&
    useCNCStore.getState().position.z === 30,
    'setPosition updates position'
);

// Test updatePosition (single axis)
useCNCStore.getState().updatePosition('x', 99);
assert(useCNCStore.getState().position.x === 99, 'updatePosition updates single axis');
assert(useCNCStore.getState().position.y === 20, 'updatePosition preserves other axes');

// Test setMachineState
useCNCStore.getState().setMachineState('running');
assert(useCNCStore.getState().machineState === 'running', 'setMachineState updates state');

// Test addConsoleLog
const prevLen = useCNCStore.getState().consoleLines.length;
useCNCStore.getState().addConsoleLog('info', 'test message');
assert(useCNCStore.getState().consoleLines.length === prevLen + 1, 'addConsoleLog adds a line');
const lastLine = useCNCStore.getState().consoleLines[useCNCStore.getState().consoleLines.length - 1];
assert(lastLine.type === 'info' && lastLine.text === 'test message', 'addConsoleLog sets correct type and text');

// Test clearConsole
useCNCStore.getState().clearConsole();
assert(useCNCStore.getState().consoleLines.length === 0, 'clearConsole empties consoleLines');

// Test setQueueCounts
useCNCStore.getState().setQueueCounts({ waiting: 3, active: 1 });
assert(useCNCStore.getState().queueCounts.waiting === 3, 'setQueueCounts updates waiting');
assert(useCNCStore.getState().queueCounts.active === 1, 'setQueueCounts updates active');

// Partial update preserves other fields
useCNCStore.getState().setQueueCounts({ completed: 5 });
assert(useCNCStore.getState().queueCounts.waiting === 3, 'partial setQueueCounts preserves waiting');
assert(useCNCStore.getState().queueCounts.completed === 5, 'partial setQueueCounts updates completed');

// Test setGcode
useCNCStore.getState().setGcode([{ command: 'G0 X10' }]);
assert(useCNCStore.getState().gcode.length === 1, 'setGcode updates gcode array');

// Test setJobProgress
useCNCStore.getState().setJobProgress(75);
assert(useCNCStore.getState().jobProgress === 75, 'setJobProgress updates progress');

// Test setRawGcodeContent
useCNCStore.getState().setRawGcodeContent('G0 X10\nG1 Y20');
assert(useCNCStore.getState().rawGcodeContent === 'G0 X10\nG1 Y20', 'setRawGcodeContent stores content');

// ── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n${'='.repeat(50)}`);
console.log(`Phase 1 results: ${passed} passed, ${failed} failed`);
console.log('='.repeat(50));
process.exit(failed > 0 ? 1 : 0);
