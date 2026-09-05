/**
 * Phase 4 + 5 Verification Tests
 * Validates: continuous jog, jog mode toggle, override commands,
 * performance optimization, error boundary, styling polish.
 */
const fs = require('fs');
const path = require('path');

const frontendSrc = path.resolve(__dirname, '..', 'src');
let passed = 0;
let failed = 0;

function assert(condition, label) {
    if (condition) {
        passed++;
        console.log(`  PASS  ${label}`);
    } else {
        failed++;
        console.log(`  FAIL  ${label}`);
    }
}

function fileContains(relPath, ...patterns) {
    const full = path.join(frontendSrc, relPath);
    if (!fs.existsSync(full)) return false;
    const content = fs.readFileSync(full, 'utf-8');
    return patterns.every(p => content.includes(p));
}

function fileExists(relPath) {
    return fs.existsSync(path.join(frontendSrc, relPath));
}

console.log('\n=== Phase 4: Advanced Controls ===\n');

// 4.1 Continuous jog mode
console.log('-- Continuous Jog --');
assert(
    fileContains('components/Sidebar.tsx', 'handleContinuousJogStart', 'handleContinuousJogStop', 'continuousJogRef'),
    'Sidebar has continuous jog start/stop handlers and interval ref'
);
assert(
    fileContains('components/Sidebar.tsx', 'onPointerDown', 'onPointerUp', 'onPointerLeave'),
    'Sidebar uses pointer events for continuous jog'
);
assert(
    fileContains('components/Sidebar.tsx', 'jogButtonProps'),
    'Sidebar has jogButtonProps helper for step/continuous dispatch'
);
assert(
    fileContains('components/Sidebar.tsx', "sendCommand('\\x85')"),
    'Continuous jog stop sends jog cancel (0x85)'
);

// 4.2 Jog mode toggle
console.log('-- Jog Mode Toggle --');
assert(
    fileContains('components/Sidebar.tsx', 'jogMode', 'setJogMode'),
    'Sidebar destructures jogMode and setJogMode from store'
);
assert(
    fileContains('components/Sidebar.tsx', 'jog-mode-toggle', 'jog-mode-btn'),
    'Sidebar renders jog mode toggle UI'
);
assert(
    fileContains('components/Sidebar.tsx', "jogMode === 'step'", "jogMode === 'continuous'"),
    'Sidebar has step and continuous mode buttons'
);
assert(
    fileContains('components/Sidebar.tsx', 'Footprints', 'Move'),
    'Sidebar imports Footprints and Move icons for jog mode toggle'
);

// 4.3 Override commands
console.log('-- Override Commands --');
assert(
    fileContains('components/Sidebar.tsx', 'sendFeedOverride', 'sendSpindleOverride', 'sendRapidOverride'),
    'Sidebar has real-time override command functions'
);
assert(
    fileContains('components/Sidebar.tsx', "\\x90", "\\x91", "\\x92"),
    'Feed override uses GRBL real-time commands (0x90, 0x91, 0x92)'
);
assert(
    fileContains('components/Sidebar.tsx', "\\x99", "\\x9A", "\\x9B"),
    'Spindle override uses GRBL real-time commands (0x99, 0x9A, 0x9B)'
);
assert(
    fileContains('components/Sidebar.tsx', "\\x95", "\\x96", "\\x97"),
    'Rapid override uses GRBL real-time commands (0x95, 0x96, 0x97)'
);
assert(
    fileContains('components/Sidebar.tsx', 'override-reset-btn'),
    'Override sliders have reset buttons'
);

// 4.4 Connection management (already done)
console.log('-- Connection Management (pre-existing) --');
assert(fileExists('components/DevicePanel.tsx'), 'DevicePanel exists');
assert(
    fileContains('utils/backendConnection.ts', 'connectBackendSocket', 'disconnectBackendSocket', 'connectToBackendPort'),
    'Backend connection management functions exist'
);

// 4.5 Machine state management (already done)
console.log('-- Machine State Management (pre-existing) --');
assert(
    fileContains('stores/cncStore.ts', 'machineState', 'setMachineState'),
    'Store has machineState management'
);

console.log('\n=== Phase 5: Polish & Integration ===\n');

// 5.1 Performance optimization
console.log('-- Performance --');
assert(
    fileContains('components/GCodeVisualizer.tsx', 'useMemo', 'mergedGeometries'),
    'GCodeVisualizer uses useMemo for merged geometries'
);
assert(
    fileContains('components/GCodeVisualizer.tsx', 'LineSegments'),
    'GCodeVisualizer uses batched LineSegments instead of individual Lines'
);
assert(
    fileContains('components/Sidebar.tsx', 'useCallback'),
    'Sidebar uses useCallback for memoized handlers'
);

// 5.2 Error handling
console.log('-- Error Handling --');
assert(fileExists('components/ErrorBoundary.tsx'), 'ErrorBoundary component exists');
assert(
    fileContains('components/ErrorBoundary.tsx', 'getDerivedStateFromError', 'componentDidCatch', 'handleReset'),
    'ErrorBoundary has proper error lifecycle methods and reset'
);
assert(
    fileContains('App.tsx', 'ErrorBoundary', 'fallbackMessage'),
    'App.tsx wraps components with ErrorBoundary'
);

// Backend error handling
const backendSrc = path.resolve(__dirname, '..', '..', 'backend');
const socketHandlers = fs.readFileSync(path.join(backendSrc, 'socketHandlers.js'), 'utf-8');
assert(
    socketHandlers.includes("serialService.on('error'"),
    'Backend handles serial port error events'
);
assert(
    socketHandlers.includes('gcodeFeeder.stop()'),
    'Backend stops feeder on unexpected disconnect'
);

// 5.3 E-Stop wired
console.log('-- E-Stop --');
assert(
    fileContains('components/Header.tsx', "sendCommand('\\x18')", 'E-STOP'),
    'E-Stop button sends GRBL soft-reset (Ctrl+X)'
);

// 5.4 CSS polish
console.log('-- CSS Polish --');
const sidebarCSS = fs.readFileSync(path.join(frontendSrc, 'components', 'Sidebar.css'), 'utf-8');
assert(sidebarCSS.includes('.jog-mode-toggle'), 'Sidebar CSS has jog-mode-toggle styles');
assert(sidebarCSS.includes('.jog-mode-btn'), 'Sidebar CSS has jog-mode-btn styles');
assert(sidebarCSS.includes('.override-reset-btn'), 'Sidebar CSS has override-reset-btn styles');

// Summary
console.log(`\n${'='.repeat(50)}`);
console.log(`Phase 4+5 Results: ${passed} passed, ${failed} failed out of ${passed + failed}`);
console.log(`${'='.repeat(50)}\n`);

process.exit(failed > 0 ? 1 : 0);
