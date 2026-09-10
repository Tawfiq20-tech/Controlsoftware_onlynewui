import { parseGcodeFileCore } from '../src/workers/gcodeParser.worker';

function assert(condition: boolean, msg: string) {
    if (!condition) {
        throw new Error(`Assertion failed: ${msg}`);
    }
    console.log(`  PASS: ${msg}`);
}

console.log('\n=== Functional Parser Test ===\n');

const testGCode = `
; Test Header
(Sample CNC Carve File)
G21 (mm mode)
G90 (absolute mode)
G0 Z10.000 F1000
G0 X0.000 Y0.000
G1 Z-1.500 F300 S12000
G1 X50.000 Y0.000 F800
G2 X100.000 Y50.000 I0.000 J50.000 (CW Arc)
G3 X50.000 Y100.000 I-50.000 J0.000 (CCW Arc)
G1 X0.000 Y100.000
G1 X0.000 Y0.000
G0 Z15.000
M5
M2
`;

const result = parseGcodeFileCore(testGCode);

assert(result.lines.length > 0, `Parsed lines count > 0 (${result.lines.length})`);
assert(result.parsedToolpath.rapids.length > 0, `Rapids float array generated (${result.parsedToolpath.rapids.length / 6} rapids)`);
assert(result.parsedToolpath.cuts.length > 0, `Cuts float array generated (${result.parsedToolpath.cuts.length / 6} cuts)`);
assert(result.parsedToolpath.arcs.length > 0, `Arcs float array generated (${result.parsedToolpath.arcs.length / 6} arc segments)`);
assert(result.bounds.maxX >= 100, `Bounds maxX is correct (${result.bounds.maxX})`);
assert(result.bounds.maxY >= 100, `Bounds maxY is correct (${result.bounds.maxY})`);
assert(result.bounds.minZ <= -1.5, `Bounds minZ is correct (${result.bounds.minZ})`);
assert(result.parsedToolpath.durationSec > 0, `Estimated duration computed (${result.parsedToolpath.durationSec.toFixed(2)}s)`);
assert(result.stats.arcCount === 2, `Arc blocks counted correctly (${result.stats.arcCount})`);

console.log('\nAll functional parser assertions passed successfully!\n');
