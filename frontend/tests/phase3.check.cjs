/**
 * Phase 3 verification: 3D Visualization (lightweight Node.js check)
 * Run with: node tests/phase3.check.js   (from frontend/)
 */
const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;

function assert(condition, label) {
    if (condition) {
        passed++;
        console.log(`  PASS  ${label}`);
    } else {
        failed++;
        console.error(`  FAIL  ${label}`);
    }
}

function fileContains(filePath, pattern) {
    const content = fs.readFileSync(filePath, 'utf-8');
    if (typeof pattern === 'string') return content.includes(pattern);
    return pattern.test(content);
}

const SRC = path.resolve(__dirname, '..', 'src');
const COMPONENTS = path.join(SRC, 'components');
const ws3dPath = path.join(COMPONENTS, 'Workspace3D.tsx');
const vizPath = path.join(COMPONENTS, 'GCodeVisualizer.tsx');
const ws3dCssPath = path.join(COMPONENTS, 'Workspace3D.css');
const parserPath = path.join(SRC, 'utils', 'gcodeParser.ts');
const builderPath = path.join(SRC, 'utils', 'toolpathBuilder.ts');
const storePath = path.join(SRC, 'stores', 'cncStore.ts');

// ── 1. G-code parser exists and is complete ─────────────────────────────────
console.log('\n=== 1. G-code parser ===');
assert(fs.existsSync(parserPath), 'gcodeParser.ts exists');
assert(fileContains(parserPath, 'class GCodeParser'), 'GCodeParser class defined');
assert(fileContains(parserPath, 'parseGCode'), 'parseGCode method exists');
assert(fileContains(parserPath, 'G90'), 'Handles absolute mode (G90)');
assert(fileContains(parserPath, 'G91'), 'Handles relative mode (G91)');
assert(fileContains(parserPath, 'G20'), 'Handles inches (G20)');
assert(fileContains(parserPath, 'G21'), 'Handles mm (G21)');
assert(fileContains(parserPath, 'isMoveCommand'), 'isMoveCommand function');
assert(fileContains(parserPath, 'isRapidMove'), 'isRapidMove function');
assert(fileContains(parserPath, 'getToolpathVertices'), 'getToolpathVertices for Three.js');
assert(fileContains(parserPath, 'getToolpathColors'), 'getToolpathColors for Three.js');
assert(fileContains(parserPath, 'bounds'), 'Computes bounding box');

// ── 2. Toolpath builder exists and is complete ──────────────────────────────
console.log('\n=== 2. Toolpath builder ===');
assert(fs.existsSync(builderPath), 'toolpathBuilder.ts exists');
assert(fileContains(builderPath, 'buildToolpathSegments'), 'buildToolpathSegments function');
assert(fileContains(builderPath, 'calculateBoundingBox'), 'calculateBoundingBox function');
assert(fileContains(builderPath, 'unitScale'), 'Handles unit scaling');
assert(fileContains(builderPath, 'absolute'), 'Handles absolute/relative modes');
assert(fileContains(builderPath, 'currentLayer'), 'Tracks layers');

// ── 3. View presets (7 camera angles) ───────────────────────────────────────
console.log('\n=== 3. View presets (7 camera angles) ===');

assert(fileContains(ws3dPath, 'VIEW_PRESET_LABELS'), 'Workspace3D defines VIEW_PRESET_LABELS');
assert(fileContains(ws3dPath, "'iso'"), 'Has ISO preset');
assert(fileContains(ws3dPath, "'top'"), 'Has Top preset');
assert(fileContains(ws3dPath, "'front'"), 'Has Front preset');
assert(fileContains(ws3dPath, "'right'"), 'Has Right preset');
assert(fileContains(ws3dPath, "'bottom'"), 'Has Bottom preset');
assert(fileContains(ws3dPath, "'left'"), 'Has Left preset');
assert(fileContains(ws3dPath, "'back'"), 'Has Back preset');

assert(fileContains(ws3dPath, 'getPresetCamera'), 'getPresetCamera function');
assert(fileContains(ws3dPath, /case 'iso'/), 'getPresetCamera handles iso');
assert(fileContains(ws3dPath, /case 'top'/), 'getPresetCamera handles top');
assert(fileContains(ws3dPath, /case 'front'/), 'getPresetCamera handles front');
assert(fileContains(ws3dPath, /case 'right'/), 'getPresetCamera handles right');
assert(fileContains(ws3dPath, /case 'bottom'/), 'getPresetCamera handles bottom');
assert(fileContains(ws3dPath, /case 'left'/), 'getPresetCamera handles left');
assert(fileContains(ws3dPath, /case 'back'/), 'getPresetCamera handles back');

// Smooth camera animation (320ms)
assert(fileContains(ws3dPath, 'animateCameraTo'), 'animateCameraTo function');
assert(fileContains(ws3dPath, '320'), '320ms animation duration');
assert(fileContains(ws3dPath, 'lerpVectors'), 'Smooth interpolation with lerpVectors');
assert(fileContains(ws3dPath, 'performance.now'), 'Uses performance.now for timing');

// Cycle view
assert(fileContains(ws3dPath, 'handleCycleView'), 'handleCycleView function');
assert(fileContains(ws3dPath, 'Cycle View'), 'Cycle View button');

// View preset selector UI
assert(fileContains(ws3dPath, 'handleViewPreset'), 'handleViewPreset handler');
assert(fileContains(ws3dPath, 'view-presets-panel'), 'View presets panel in JSX');
assert(fileContains(ws3dPath, 'view-preset-btn'), 'View preset buttons');
assert(fileContains(ws3dPath, 'showViewPresets'), 'Toggle for view presets panel');
assert(fileContains(ws3dPath, 'View Presets'), 'View Presets button title');

// Store integration
assert(fileContains(ws3dPath, 'useCNCStore'), 'Imports useCNCStore');
assert(fileContains(ws3dPath, 'viewPreset'), 'Reads viewPreset from store');
assert(fileContains(ws3dPath, 'setViewPreset'), 'Writes viewPreset to store');
assert(fileContains(ws3dPath, 'ViewPreset'), 'Imports ViewPreset type');

// ── 4. Zoom controls ───────────────────────────────────────────────────────
console.log('\n=== 4. Zoom controls ===');

assert(fileContains(ws3dPath, 'handleZoomIn'), 'handleZoomIn function');
assert(fileContains(ws3dPath, 'handleZoomOut'), 'handleZoomOut function');
assert(fileContains(ws3dPath, 'ZoomIn'), 'ZoomIn icon');
assert(fileContains(ws3dPath, 'ZoomOut'), 'ZoomOut icon');
assert(fileContains(ws3dPath, 'distance * 0.8'), 'ZoomIn reduces distance by 20%');
assert(fileContains(ws3dPath, 'distance * 1.2'), 'ZoomOut increases distance by 20%');
assert(fileContains(ws3dPath, 'minDistance'), 'Min zoom distance');
assert(fileContains(ws3dPath, 'maxDistance'), 'Max zoom distance');

// ── 5. Axis HUD labels ─────────────────────────────────────────────────────
console.log('\n=== 5. Axis HUD labels ===');

// Workspace3D axis overlay
assert(fileContains(ws3dPath, 'createAxisOverlay'), 'createAxisOverlay function');
assert(fileContains(ws3dPath, 'makeTextSprite'), 'makeTextSprite for labels');
assert(fileContains(ws3dPath, 'CanvasTexture'), 'Uses CanvasTexture');
assert(fileContains(ws3dPath, 'SpriteMaterial'), 'Uses SpriteMaterial');
assert(fileContains(ws3dPath, 'LineDashedMaterial'), 'Dashed axis lines');
assert(fileContains(ws3dPath, '0xff4040'), 'X axis red');
assert(fileContains(ws3dPath, '0x34d399'), 'Y axis green');
assert(fileContains(ws3dPath, 'tickStep'), 'Tick marks');
assert(fileContains(ws3dPath, 'computeLineDistances'), 'Computes line distances for dashes');

// GCodeVisualizer axis labels
assert(fileContains(vizPath, 'AxesHelper'), 'GCodeVisualizer AxesHelper');
assert(fileContains(vizPath, 'createScaleMarkers'), 'GCodeVisualizer scale markers');
assert(fileContains(vizPath, 'createTextSprite'), 'GCodeVisualizer text sprites');
assert(fileContains(vizPath, '0xff4444'), 'GCodeVisualizer X markers red');
assert(fileContains(vizPath, '0x44ff44'), 'GCodeVisualizer Y markers green');
assert(fileContains(vizPath, '0x4444ff'), 'GCodeVisualizer Z markers blue');

// ── 6. Layer visualization mode ─────────────────────────────────────────────
console.log('\n=== 6. Layer visualization mode ===');

assert(fileContains(vizPath, "viewMode3D === 'layers'"), 'Checks for layers mode');
assert(fileContains(vizPath, 'segment.layer'), 'Uses segment.layer');
assert(fileContains(vizPath, 'hsl'), 'Uses HSL colors for layers');
assert(fileContains(vizPath, 'hue'), 'Computes hue per layer');
assert(fileContains(vizPath, 'viewMode3D'), 'Reads viewMode3D from store');

// Store has viewMode3D and viewPreset
assert(fileContains(storePath, 'viewMode3D'), 'Store has viewMode3D');
assert(fileContains(storePath, 'setViewMode3D'), 'Store has setViewMode3D');
assert(fileContains(storePath, 'viewPreset'), 'Store has viewPreset');
assert(fileContains(storePath, 'setViewPreset'), 'Store has setViewPreset');

// ── 7. CSS for view presets ─────────────────────────────────────────────────
console.log('\n=== 7. CSS for view presets ===');

assert(fileContains(ws3dCssPath, 'view-presets-panel'), 'CSS: view-presets-panel');
assert(fileContains(ws3dCssPath, 'view-preset-btn'), 'CSS: view-preset-btn');
assert(fileContains(ws3dCssPath, 'control-divider'), 'CSS: control-divider');
assert(fileContains(ws3dCssPath, 'backdrop-filter'), 'CSS: backdrop blur');

// ── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n${'='.repeat(50)}`);
console.log(`Phase 3 results: ${passed} passed, ${failed} failed`);
console.log('='.repeat(50));
process.exit(failed > 0 ? 1 : 0);
