/**
 * Verification test for Upload & Stop Freeze Fixes
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

function fileDoesNotContain(relPath, ...patterns) {
    const full = path.join(frontendSrc, relPath);
    if (!fs.existsSync(full)) return false;
    const content = fs.readFileSync(full, 'utf-8');
    return patterns.every(p => !content.includes(p));
}

console.log('\n=== Testing 6 Freeze Fixes ===\n');

// 1. Elimination of Parse #2 & Web Worker Integration
console.log('-- Issue 1: Double Parse Elimination --');
assert(
    fileDoesNotContain('components/Visualizer3D/Visualizer3D.tsx', 'stringifyGcode'),
    'Visualizer3D no longer re-stringifies G-code'
);
assert(
    fileDoesNotContain('components/Visualizer3D/Visualizer3D.tsx', 'parseGcode(stringifyGcode'),
    'Visualizer3D no longer re-parses stringified G-code'
);
assert(
    fileContains('components/Visualizer3D/Visualizer3D.tsx', 'parsedToolpath: parsed'),
    'Visualizer3D directly reads parsedToolpath from CNC store'
);
assert(
    fs.existsSync(path.join(frontendSrc, 'workers/gcodeParser.worker.ts')),
    'Web worker gcodeParser.worker.ts exists'
);
assert(
    fileContains('utils/gcodeParser.ts', 'parseGcodeAsync', 'parseGcodeFile'),
    'utils/gcodeParser.ts exports parseGcodeAsync and parseGcodeFile'
);

// 2. Store cleanupForNewFile action
console.log('\n-- Issue 2: Cleanup for New File --');
assert(
    fileContains('stores/cncStore.ts', 'cleanupForNewFile: () => {', 'parsedToolpath: null'),
    'cncStore defines cleanupForNewFile action'
);
assert(
    fileContains('components/Sidebar.tsx', 'cleanupForNewFile()'),
    'Sidebar calls cleanupForNewFile before reading/parsing new file'
);
assert(
    fileContains('components/Library/Library.tsx', 'cleanupForNewFile()'),
    'Library calls cleanupForNewFile before loading file'
);
assert(
    fileContains('components/SurfacingTool.tsx', 'cleanupForNewFile()'),
    'SurfacingTool calls cleanupForNewFile before loading file'
);

// 3. Async LocalStorage writes
console.log('\n-- Issue 3: Asynchronous LocalStorage Save --');
assert(
    fileContains('utils/localStorage.ts', 'requestIdleCallback', 'pendingGcodeSaveHandle'),
    'localStorage gcodeFileStorage uses requestIdleCallback/setTimeout'
);

// 4. Console log capping
console.log('\n-- Issue 4: Console Log Ring Buffer Capping --');
assert(
    fileContains('stores/cncStore.ts', 'prev.length >= 500', 'prev.slice(prev.length - 499)'),
    'addConsoleLog bounds consoleLines to 500 items using slice'
);

// 5. Hot-path console.log removal
console.log('\n-- Issue 5: Hot-path console.log Removal --');
assert(
    fileDoesNotContain('stores/cncStore.ts', "console.log('[Store] Setting work position:'"),
    'setPosition does not contain console.log'
);
assert(
    fileDoesNotContain('stores/cncStore.ts', "console.log('[Store] Setting machine position:'"),
    'setMachinePosition does not contain console.log'
);
assert(
    fileDoesNotContain('utils/backendConnection.ts', "console.log('[Position Update] Work:'"),
    'backendConnection work position does not contain console.log'
);
assert(
    fileDoesNotContain('utils/backendConnection.ts', "console.log('[Position Update] Machine:'"),
    'backendConnection machine position does not contain console.log'
);

// 6. Three.js GPU memory cleanup
console.log('\n-- Issue 6: Three.js GPU Memory Leak Prevention --');
assert(
    fileContains('components/Visualizer3D/Visualizer3D.tsx', 'safeSetAttribute', 'safeDeleteAttribute', 'disposeMaterial'),
    'Visualizer3D uses safeSetAttribute, safeDeleteAttribute, and disposeMaterial'
);
assert(
    fileContains('components/Visualizer3D/RealisticStockMesh.ts', 'disposeRealisticWorkpiece'),
    'RealisticStockMesh exports disposeRealisticWorkpiece helper'
);

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
