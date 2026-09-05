/**
 * Phase 3 verification: 3D Visualization
 *   - G-code parser (verified in Phase 1, spot-check here)
 *   - Toolpath builder (verified in Phase 1, spot-check here)
 *   - View presets (7 camera angles) in Workspace3D
 *   - Zoom controls in Workspace3D
 *   - Axis HUD labels in Workspace3D + GCodeVisualizer
 *   - Layer visualization mode in GCodeVisualizer
 *
 * Run with: npx tsx tests/phase3.test.ts   (from frontend/)
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

function fileContains(filePath: string, pattern: string | RegExp): boolean {
    const content = fs.readFileSync(filePath, 'utf-8');
    if (typeof pattern === 'string') return content.includes(pattern);
    return pattern.test(content);
}

const SRC = path.resolve(__dirname, '..', 'src');
const COMPONENTS = path.join(SRC, 'components');
const ws3dPath = path.join(COMPONENTS, 'Workspace3D.tsx');
const vizPath = path.join(COMPONENTS, 'GCodeVisualizer.tsx');
const ws3dCssPath = path.join(COMPONENTS, 'Workspace3D.css');

// ── 1. G-code parser (spot-check) ──────────────────────────────────────────
console.log('\n=== 1. G-code parser (spot-check) ===');
import { GCodeParser } from '../src/utils/gcodeParser';

const parser = new GCodeParser();
const result = parser.parseGCode('G21\nG90\nG0 X10 Y20\nG1 X30 Y40 Z-1 F500\nG0 X0 Y0 Z5');
assert(result.segments.length === 3, 'Parser creates correct segment count');
assert(result.bounds.maxX === 30, 'Parser computes correct bounds');
assert(result.segments[0].rapid === true, 'Parser identifies rapid moves');
assert(result.segments[1].rapid === false, 'Parser identifies feed moves');

// ── 2. Toolpath builder (spot-check) ────────────────────────────────────────
console.log('\n=== 2. Toolpath builder (spot-check) ===');
import { buildToolpathSegments, calculateBoundingBox } from '../src/utils/toolpathBuilder';

const segs = buildToolpathSegments([
    { command: 'G21' }, { command: 'G90' },
    { command: 'G0 X10 Y10', x: 10, y: 10 },
    { command: 'G1 X20 Y20 F500', x: 20, y: 20, f: 500 },
]);
assert(segs.length === 2, 'Toolpath builder creates correct segments');
const bbox = calculateBoundingBox(segs);
assert(bbox.max.x === 20 && bbox.max.y === 20, 'Bounding box correct');

// ── 3. View presets (7 camera angles) ───────────────────────────────────────
console.log('\n=== 3. View presets (7 camera angles) ===');

// Verify Workspace3D has all 7 presets
assert(fileContains(ws3dPath, 'VIEW_PRESET_LABELS'), 'Workspace3D defines VIEW_PRESET_LABELS');
assert(fileContains(ws3dPath, "'iso'"), 'Workspace3D has ISO preset');
assert(fileContains(ws3dPath, "'top'"), 'Workspace3D has Top preset');
assert(fileContains(ws3dPath, "'front'"), 'Workspace3D has Front preset');
assert(fileContains(ws3dPath, "'right'"), 'Workspace3D has Right preset');
assert(fileContains(ws3dPath, "'bottom'"), 'Workspace3D has Bottom preset');
assert(fileContains(ws3dPath, "'left'"), 'Workspace3D has Left preset');
assert(fileContains(ws3dPath, "'back'"), 'Workspace3D has Back preset');

// Verify camera position logic for each preset
assert(fileContains(ws3dPath, 'getPresetCamera'), 'Workspace3D has getPresetCamera function');
assert(fileContains(ws3dPath, /case 'iso'/), 'getPresetCamera handles iso');
assert(fileContains(ws3dPath, /case 'top'/), 'getPresetCamera handles top');
assert(fileContains(ws3dPath, /case 'front'/), 'getPresetCamera handles front');
assert(fileContains(ws3dPath, /case 'right'/), 'getPresetCamera handles right');
assert(fileContains(ws3dPath, /case 'bottom'/), 'getPresetCamera handles bottom');
assert(fileContains(ws3dPath, /case 'left'/), 'getPresetCamera handles left');
assert(fileContains(ws3dPath, /case 'back'/), 'getPresetCamera handles back');

// Verify smooth camera animation (320ms transitions)
assert(fileContains(ws3dPath, 'animateCameraTo'), 'Workspace3D has animateCameraTo function');
assert(fileContains(ws3dPath, '320'), 'Animation uses 320ms duration');
assert(fileContains(ws3dPath, 'lerpVectors'), 'Animation uses lerpVectors for smooth interpolation');
assert(fileContains(ws3dPath, 'performance.now'), 'Animation uses performance.now for timing');

// Verify cycle view button
assert(fileContains(ws3dPath, 'handleCycleView'), 'Workspace3D has handleCycleView function');
assert(fileContains(ws3dPath, 'Cycle View'), 'Workspace3D has Cycle View button title');

// Verify view preset selector UI
assert(fileContains(ws3dPath, 'handleViewPreset'), 'Workspace3D has handleViewPreset handler');
assert(fileContains(ws3dPath, 'view-presets-panel'), 'Workspace3D has view presets panel');
assert(fileContains(ws3dPath, 'view-preset-btn'), 'Workspace3D has view preset buttons');
assert(fileContains(ws3dPath, 'showViewPresets'), 'Workspace3D toggles view presets panel');
assert(fileContains(ws3dPath, 'View Presets'), 'Workspace3D has View Presets button title');

// Verify store integration
assert(fileContains(ws3dPath, 'useCNCStore'), 'Workspace3D imports useCNCStore');
assert(fileContains(ws3dPath, 'viewPreset'), 'Workspace3D reads viewPreset from store');
assert(fileContains(ws3dPath, 'setViewPreset'), 'Workspace3D writes viewPreset to store');

// Verify ViewPreset type import
assert(fileContains(ws3dPath, 'ViewPreset'), 'Workspace3D imports ViewPreset type');

// ── 4. Zoom controls ───────────────────────────────────────────────────────
console.log('\n=== 4. Zoom controls ===');

assert(fileContains(ws3dPath, 'handleZoomIn'), 'Workspace3D has handleZoomIn');
assert(fileContains(ws3dPath, 'handleZoomOut'), 'Workspace3D has handleZoomOut');
assert(fileContains(ws3dPath, 'ZoomIn'), 'Workspace3D has ZoomIn icon');
assert(fileContains(ws3dPath, 'ZoomOut'), 'Workspace3D has ZoomOut icon');
assert(fileContains(ws3dPath, 'distance * 0.8'), 'ZoomIn reduces distance by 20%');
assert(fileContains(ws3dPath, 'distance * 1.2'), 'ZoomOut increases distance by 20%');
assert(fileContains(ws3dPath, 'minDistance'), 'Workspace3D has min zoom distance');
assert(fileContains(ws3dPath, 'maxDistance'), 'Workspace3D has max zoom distance');

// ── 5. Axis HUD labels ─────────────────────────────────────────────────────
console.log('\n=== 5. Axis HUD labels ===');

// Workspace3D axis overlay
assert(fileContains(ws3dPath, 'createAxisOverlay'), 'Workspace3D has createAxisOverlay');
assert(fileContains(ws3dPath, 'makeTextSprite'), 'Workspace3D creates text sprites for labels');
assert(fileContains(ws3dPath, 'CanvasTexture'), 'Workspace3D uses CanvasTexture for labels');
assert(fileContains(ws3dPath, 'SpriteMaterial'), 'Workspace3D uses SpriteMaterial for labels');
assert(fileContains(ws3dPath, 'LineDashedMaterial'), 'Workspace3D has dashed axis lines');
assert(fileContains(ws3dPath, '0xff4040'), 'Workspace3D X axis is red');
assert(fileContains(ws3dPath, '0x34d399'), 'Workspace3D Y axis is green');
assert(fileContains(ws3dPath, 'tickStep'), 'Workspace3D has tick marks');
assert(fileContains(ws3dPath, 'computeLineDistances'), 'Workspace3D computes line distances for dashes');

// GCodeVisualizer axis labels
assert(fileContains(vizPath, 'AxesHelper'), 'GCodeVisualizer has AxesHelper');
assert(fileContains(vizPath, 'createScaleMarkers'), 'GCodeVisualizer has scale markers');
assert(fileContains(vizPath, 'createTextSprite'), 'GCodeVisualizer creates text sprites');
assert(fileContains(vizPath, '0xff4444'), 'GCodeVisualizer X markers are red');
assert(fileContains(vizPath, '0x44ff44'), 'GCodeVisualizer Y markers are green');
assert(fileContains(vizPath, '0x4444ff'), 'GCodeVisualizer Z markers are blue');

// ── 6. Layer visualization mode ─────────────────────────────────────────────
console.log('\n=== 6. Layer visualization mode ===');

assert(fileContains(vizPath, "viewMode3D === 'layers'"), 'GCodeVisualizer checks for layers mode');
assert(fileContains(vizPath, 'segment.layer'), 'GCodeVisualizer uses segment.layer');
assert(fileContains(vizPath, 'hsl'), 'GCodeVisualizer uses HSL colors for layers');
assert(fileContains(vizPath, 'hue'), 'GCodeVisualizer computes hue per layer');
assert(fileContains(vizPath, 'viewMode3D'), 'GCodeVisualizer reads viewMode3D from store');

// Verify the store has viewMode3D
import { useCNCStore } from '../src/stores/cncStore';
const state = useCNCStore.getState();
assert(typeof state.viewMode3D === 'string', 'Store has viewMode3D');
assert(typeof state.setViewMode3D === 'function', 'Store has setViewMode3D');
assert(['wireframe', 'solid', 'layers'].includes(state.viewMode3D), 'viewMode3D is valid');

// Verify ViewPreset store
assert(typeof state.viewPreset === 'string', 'Store has viewPreset');
assert(typeof state.setViewPreset === 'function', 'Store has setViewPreset');
assert(['iso', 'top', 'front', 'right', 'bottom', 'left', 'back'].includes(state.viewPreset), 'viewPreset is valid');

// ── 7. CSS for view presets ─────────────────────────────────────────────────
console.log('\n=== 7. CSS for view presets ===');

assert(fileContains(ws3dCssPath, 'view-presets-panel'), 'CSS has view-presets-panel styles');
assert(fileContains(ws3dCssPath, 'view-preset-btn'), 'CSS has view-preset-btn styles');
assert(fileContains(ws3dCssPath, 'control-divider'), 'CSS has control-divider styles');
assert(fileContains(ws3dCssPath, 'backdrop-filter'), 'View presets panel has backdrop blur');

// ── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n${'='.repeat(50)}`);
console.log(`Phase 3 results: ${passed} passed, ${failed} failed`);
console.log('='.repeat(50));
process.exit(failed > 0 ? 1 : 0);
