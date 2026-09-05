/**
 * Phase 2 verification: Enhanced Components
 *   - App.tsx with state management routing
 *   - Sidebar (ControlPanel) with all features
 *   - GCodeVisualizer component
 *   - FileUpload (integrated in Sidebar + Workspace3D)
 *   - JobControl (integrated in Sidebar)
 *   - Console (integrated in Sidebar)
 *   - QuickActions (probe in Sidebar, E-Stop in Header)
 *   - SystemStatus (DevicePanel + Header)
 *
 * Run with: npx tsx tests/phase2.test.ts   (from frontend/)
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

function fileExists(filePath: string): boolean {
    return fs.existsSync(filePath);
}

const SRC = path.resolve(__dirname, '..', 'src');
const COMPONENTS = path.join(SRC, 'components');

// ── 1. App.tsx – State Management & Routing ─────────────────────────────────
console.log('\n=== 1. App.tsx – State Management & Routing ===');

const appPath = path.join(SRC, 'App.tsx');
assert(fileExists(appPath), 'App.tsx exists');
assert(fileContains(appPath, 'Header'), 'App.tsx imports Header');
assert(fileContains(appPath, 'Sidebar'), 'App.tsx imports Sidebar');
assert(fileContains(appPath, 'Workspace3D'), 'App.tsx imports Workspace3D');
assert(fileContains(appPath, 'DevicePanel'), 'App.tsx imports DevicePanel');
assert(fileContains(appPath, 'ProjectPanel'), 'App.tsx imports ProjectPanel');
assert(fileContains(appPath, 'useState'), 'App.tsx uses useState for tab state');
assert(fileContains(appPath, 'activeHeaderTab'), 'App.tsx manages activeHeaderTab');
assert(fileContains(appPath, 'Prepare'), 'App.tsx has Prepare tab');
assert(fileContains(appPath, 'Preview'), 'App.tsx has Preview tab');
assert(fileContains(appPath, 'Device'), 'App.tsx has Device tab');
assert(fileContains(appPath, 'Project'), 'App.tsx has Project tab');

// ── 2. Sidebar (ControlPanel) – All Features ────────────────────────────────
console.log('\n=== 2. Sidebar (ControlPanel) – All Features ===');

const sidebarPath = path.join(COMPONENTS, 'Sidebar.tsx');
assert(fileExists(sidebarPath), 'Sidebar.tsx exists');
assert(fileContains(sidebarPath, 'useCNCStore'), 'Sidebar uses Zustand store');

// DRO (Digital Readout)
assert(fileContains(sidebarPath, 'Machine Position'), 'Sidebar has Machine Position section');
assert(fileContains(sidebarPath, 'formatAxisValue'), 'Sidebar uses formatAxisValue for DRO');
assert(fileContains(sidebarPath, 'dro-value'), 'Sidebar has DRO value display');
assert(fileContains(sidebarPath, 'Zero All'), 'Sidebar has Zero All button');
assert(fileContains(sidebarPath, 'handleZero'), 'Sidebar has per-axis zero handler');

// Jog Controls
assert(fileContains(sidebarPath, 'Manual Jog Control'), 'Sidebar has Jog Control section');
assert(fileContains(sidebarPath, 'handleJog'), 'Sidebar has jog handler');
assert(fileContains(sidebarPath, 'jog-xy-pad'), 'Sidebar has XY jog pad');
assert(fileContains(sidebarPath, 'jog-z-column'), 'Sidebar has Z jog column');
assert(fileContains(sidebarPath, 'Step (mm)'), 'Sidebar has step size selector');
assert(fileContains(sidebarPath, /\[0\.1,\s*1,\s*10,\s*100\]/), 'Sidebar has step options 0.1, 1, 10, 100');

// Overrides
assert(fileContains(sidebarPath, 'Feed / Speed Overrides'), 'Sidebar has Overrides section');
assert(fileContains(sidebarPath, 'Feed Rate'), 'Sidebar has Feed Rate override');
assert(fileContains(sidebarPath, 'Spindle Speed'), 'Sidebar has Spindle Speed override');
assert(fileContains(sidebarPath, 'Rapid Rate'), 'Sidebar has Rapid Rate override');
assert(fileContains(sidebarPath, 'override-slider'), 'Sidebar has override sliders');

// File Upload
assert(fileContains(sidebarPath, 'File Management'), 'Sidebar has File Management section');
assert(fileContains(sidebarPath, 'handleFileUpload'), 'Sidebar has file upload handler');
assert(fileContains(sidebarPath, '.nc,.gcode,.txt,.ngc'), 'Sidebar accepts .nc, .gcode, .txt, .ngc');
assert(fileContains(sidebarPath, 'Load G-Code'), 'Sidebar has Load G-Code button');
assert(fileContains(sidebarPath, 'handleClearFile'), 'Sidebar has clear file handler');
assert(fileContains(sidebarPath, 'parseGCode'), 'Sidebar uses G-code parser');
assert(fileContains(sidebarPath, 'buildToolpathSegments'), 'Sidebar uses toolpath builder');

// Job Control
assert(fileContains(sidebarPath, 'handlePlayPause'), 'Sidebar has play/pause handler');
assert(fileContains(sidebarPath, 'handleStop'), 'Sidebar has stop handler');
assert(fileContains(sidebarPath, 'job-play-btn'), 'Sidebar has play button');
assert(fileContains(sidebarPath, 'job-stop-btn'), 'Sidebar has stop button');
assert(fileContains(sidebarPath, 'job-progress-bar'), 'Sidebar has progress bar');
assert(fileContains(sidebarPath, 'jobLoadBackend'), 'Sidebar uses backend job load');
assert(fileContains(sidebarPath, 'jobStartBackend'), 'Sidebar uses backend job start');
assert(fileContains(sidebarPath, 'jobPauseBackend'), 'Sidebar uses backend job pause');
assert(fileContains(sidebarPath, 'jobResumeBackend'), 'Sidebar uses backend job resume');
assert(fileContains(sidebarPath, 'jobStopBackend'), 'Sidebar uses backend job stop');

// Queue
assert(fileContains(sidebarPath, 'jobQueueBackend'), 'Sidebar uses backend job queue');
assert(fileContains(sidebarPath, 'queueCounts'), 'Sidebar displays queue counts');
assert(fileContains(sidebarPath, 'Add to queue'), 'Sidebar has Add to queue button');

// Console
assert(fileContains(sidebarPath, 'Console'), 'Sidebar has Console section');
assert(fileContains(sidebarPath, 'console-line'), 'Sidebar renders console lines');
assert(fileContains(sidebarPath, 'getConsoleClass'), 'Sidebar has console message type styling');
assert(fileContains(sidebarPath, 'getConsoleIcon'), 'Sidebar has console message type icons');
assert(fileContains(sidebarPath, 'consoleExpanded'), 'Sidebar has expandable console');
assert(fileContains(sidebarPath, 'console-time'), 'Sidebar shows console timestamps');

// Quick Actions (Probe)
assert(fileContains(sidebarPath, 'Probe'), 'Sidebar has Probe button');
assert(fileContains(sidebarPath, 'probe-input'), 'Sidebar has probe size input');
assert(fileContains(sidebarPath, 'Coordinate System'), 'Sidebar has coordinate system selector');

// Settings Tabs
assert(fileContains(sidebarPath, 'Position'), 'Sidebar has Position tab');
assert(fileContains(sidebarPath, "'Jog'"), 'Sidebar has Jog tab');
assert(fileContains(sidebarPath, "'Overrides'"), 'Sidebar has Overrides tab');
assert(fileContains(sidebarPath, "'Console'"), 'Sidebar has Console tab');

// ── 3. GCodeVisualizer ──────────────────────────────────────────────────────
console.log('\n=== 3. GCodeVisualizer ===');

const vizPath = path.join(COMPONENTS, 'GCodeVisualizer.tsx');
assert(fileExists(vizPath), 'GCodeVisualizer.tsx exists');
assert(fileContains(vizPath, 'THREE'), 'GCodeVisualizer uses Three.js');
assert(fileContains(vizPath, 'OrbitControls'), 'GCodeVisualizer has orbit controls');
assert(fileContains(vizPath, 'toolpathSegments'), 'GCodeVisualizer renders toolpath segments');
assert(fileContains(vizPath, 'viewMode3D'), 'GCodeVisualizer supports view modes');
assert(fileContains(vizPath, 'showGrid3D'), 'GCodeVisualizer has grid toggle');
assert(fileContains(vizPath, 'calculateBoundingBox'), 'GCodeVisualizer auto-fits camera');
assert(fileContains(vizPath, 'LineBasicMaterial'), 'GCodeVisualizer has cut material');
assert(fileContains(vizPath, 'LineDashedMaterial'), 'GCodeVisualizer has rapid material');
assert(fileContains(vizPath, 'layers'), 'GCodeVisualizer supports layer visualization');
assert(fileContains(vizPath, 'visualizer-empty'), 'GCodeVisualizer has empty state');
assert(fileContains(vizPath, 'viewport-status'), 'GCodeVisualizer has status bar');

// ── 4. Workspace3D (Enhanced 3D with drag-drop) ────────────────────────────
console.log('\n=== 4. Workspace3D (Enhanced 3D + Drag-Drop) ===');

const ws3dPath = path.join(COMPONENTS, 'Workspace3D.tsx');
assert(fileExists(ws3dPath), 'Workspace3D.tsx exists');
assert(fileContains(ws3dPath, 'THREE'), 'Workspace3D uses Three.js');
assert(fileContains(ws3dPath, 'OrbitControls'), 'Workspace3D has orbit controls');
assert(fileContains(ws3dPath, 'handleDrop'), 'Workspace3D supports drag-and-drop');
assert(fileContains(ws3dPath, 'handleDragOver'), 'Workspace3D handles drag over');
assert(fileContains(ws3dPath, 'handleFileUpload'), 'Workspace3D has file upload');
assert(fileContains(ws3dPath, 'GCodeParser'), 'Workspace3D uses GCodeParser');
assert(fileContains(ws3dPath, 'TubeGeometry'), 'Workspace3D renders solid tube toolpaths');
assert(fileContains(ws3dPath, 'handleZoomIn'), 'Workspace3D has zoom in');
assert(fileContains(ws3dPath, 'handleZoomOut'), 'Workspace3D has zoom out');
assert(fileContains(ws3dPath, 'handleResetView'), 'Workspace3D has reset view');
assert(fileContains(ws3dPath, 'isLocked'), 'Workspace3D has camera lock');
assert(fileContains(ws3dPath, 'showGrid'), 'Workspace3D has grid toggle');

// ── 5. Header (Status + E-Stop) ────────────────────────────────────────────
console.log('\n=== 5. Header (Status + E-Stop) ===');

const headerPath = path.join(COMPONENTS, 'Header.tsx');
assert(fileExists(headerPath), 'Header.tsx exists');
assert(fileContains(headerPath, 'useCNCStore'), 'Header uses Zustand store');
assert(fileContains(headerPath, 'machine-status-pill'), 'Header has status pill');
assert(fileContains(headerPath, 'status-dot'), 'Header has status dot indicator');
assert(fileContains(headerPath, 'E-Stop'), 'Header has E-Stop button');
assert(fileContains(headerPath, 'feedRate'), 'Header displays feed rate');
assert(fileContains(headerPath, 'spindleSpeed'), 'Header displays spindle speed');
assert(fileContains(headerPath, 'NAV_TABS'), 'Header has navigation tabs');
assert(fileContains(headerPath, 'OFFLINE'), 'Header shows OFFLINE when disconnected');

// ── 6. DevicePanel (SystemStatus + Connection) ─────────────────────────────
console.log('\n=== 6. DevicePanel (SystemStatus + Connection) ===');

const devicePath = path.join(COMPONENTS, 'DevicePanel.tsx');
assert(fileExists(devicePath), 'DevicePanel.tsx exists');
assert(fileContains(devicePath, 'useCNCStore'), 'DevicePanel uses Zustand store');
assert(fileContains(devicePath, 'connectionMode'), 'DevicePanel supports connection modes');
assert(fileContains(devicePath, "'browser'"), 'DevicePanel has browser mode');
assert(fileContains(devicePath, "'backend'"), 'DevicePanel has backend mode');
assert(fileContains(devicePath, 'connectToPort'), 'DevicePanel has browser connect');
assert(fileContains(devicePath, 'connectToBackend'), 'DevicePanel has backend connect');
assert(fileContains(devicePath, 'disconnect'), 'DevicePanel has disconnect');
assert(fileContains(devicePath, 'requestBackendPorts'), 'DevicePanel can list backend ports');
assert(fileContains(devicePath, 'JoystickManager'), 'DevicePanel has joystick support');
assert(fileContains(devicePath, 'device-info-card'), 'DevicePanel shows device info');
assert(fileContains(devicePath, 'Connection Help'), 'DevicePanel has help section');
assert(fileContains(devicePath, 'CH340'), 'DevicePanel identifies common controllers');

// ── 7. ProjectPanel ────────────────────────────────────────────────────────
console.log('\n=== 7. ProjectPanel (Job History) ===');

const projectPath = path.join(COMPONENTS, 'ProjectPanel.tsx');
assert(fileExists(projectPath), 'ProjectPanel.tsx exists');
assert(fileContains(projectPath, 'Project History'), 'ProjectPanel has history header');
assert(fileContains(projectPath, 'localStorage'), 'ProjectPanel persists to localStorage');
assert(fileContains(projectPath, 'handleDeleteProject'), 'ProjectPanel can delete projects');
assert(fileContains(projectPath, 'handleRunProject'), 'ProjectPanel can re-run projects');
assert(fileContains(projectPath, 'project-details'), 'ProjectPanel has detail view');

// ── 8. PortSelectionModal ──────────────────────────────────────────────────
console.log('\n=== 8. PortSelectionModal ===');

const modalPath = path.join(COMPONENTS, 'PortSelectionModal.tsx');
assert(fileExists(modalPath), 'PortSelectionModal.tsx exists');
assert(fileContains(modalPath, 'handleRequestNewPort'), 'Modal can request new port');
assert(fileContains(modalPath, 'handleSelectPort'), 'Modal can select existing port');

// ── 9. CSS files exist ─────────────────────────────────────────────────────
console.log('\n=== 9. CSS files ===');

const cssFiles = [
    'Sidebar.css', 'Header.css', 'DevicePanel.css',
    'GCodeVisualizer.css', 'Workspace3D.css', 'ProjectPanel.css',
    'PortSelectionModal.css',
];
for (const css of cssFiles) {
    assert(fileExists(path.join(COMPONENTS, css)), `${css} exists`);
}

assert(fileExists(path.join(SRC, 'App.css')), 'App.css exists');

// ── 10. Zustand store integration ──────────────────────────────────────────
console.log('\n=== 10. Zustand store integration ===');

// Verify key components import from cncStore
const storeUsers = ['Sidebar.tsx', 'Header.tsx', 'DevicePanel.tsx', 'GCodeVisualizer.tsx'];
for (const comp of storeUsers) {
    assert(
        fileContains(path.join(COMPONENTS, comp), 'useCNCStore'),
        `${comp} imports useCNCStore`
    );
}

// ── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n${'='.repeat(50)}`);
console.log(`Phase 2 results: ${passed} passed, ${failed} failed`);
console.log('='.repeat(50));
process.exit(failed > 0 ? 1 : 0);
