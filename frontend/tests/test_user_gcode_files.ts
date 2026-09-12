import * as fs from 'fs';
import * as path from 'path';
import { parseGcodeFileCore } from '../src/workers/gcodeParser.worker';

const files = [
    {
        name: 'Buildbotics_CABIN CLOCK RELIEF ROUGH BIT.ngc',
        path: 'C:\\Users\\Tawfiq\\Downloads\\gcode_test_file\\file_finity\\Buildbotics_CABIN CLOCK RELIEF ROUGH BIT.ngc',
    },
    {
        name: 'Buildbotics_DRAGON ROUGH.ngc',
        path: 'C:\\Users\\Tawfiq\\Downloads\\gcode_test_file\\file_finity\\Buildbotics_DRAGON ROUGH.ngc',
    },
    {
        name: 'Redline_Happy Halloween 3D Roughing Redline.nc',
        path: 'C:\\Users\\Tawfiq\\Downloads\\gcode_test_file\\file_finity\\Redline_Happy Halloween 3D Roughing Redline.nc',
    },
    {
        name: 'Redline_Happy Halloween 3D Finishing Redline.nc',
        path: 'C:\\Users\\Tawfiq\\Downloads\\gcode_test_file\\file_finity\\Redline_Happy Halloween 3D Finishing Redline.nc',
    },
];

console.log('\n================================================================');
console.log('       BENCHMARKING USER G-CODE TEST FILES');
console.log('================================================================\n');

for (const file of files) {
    console.log(`Analyzing: ${file.name}`);
    if (!fs.existsSync(file.path)) {
        console.error(`  ERROR: File not found: ${file.path}`);
        continue;
    }

    const stat = fs.statSync(file.path);
    const sizeMb = (stat.size / (1024 * 1024)).toFixed(2);
    console.log(`  File size: ${sizeMb} MB (${stat.size.toLocaleString()} bytes)`);

    const tRead0 = performance.now();
    const content = fs.readFileSync(file.path, 'utf8');
    const readMs = (performance.now() - tRead0).toFixed(1);

    const memBefore = process.memoryUsage().heapUsed / (1024 * 1024);
    const tParse0 = performance.now();
    const result = parseGcodeFileCore(content);
    const parseMs = (performance.now() - tParse0).toFixed(1);
    const memAfter = process.memoryUsage().heapUsed / (1024 * 1024);
    const memDelta = (memAfter - memBefore).toFixed(1);

    const p = result.parsedToolpath;
    const dur100 = p.durationSec;
    const dur200 = p.durationSec / 2;

    const fmtTime = (s: number) => {
        const hrs = Math.floor(s / 3600);
        const mins = Math.floor((s % 3600) / 60);
        const secs = Math.floor(s % 60);
        return `${hrs > 0 ? hrs + 'h ' : ''}${mins}m ${secs}s`;
    };

    console.log(`  Read Time: ${readMs}ms | Parse Time: ${parseMs}ms | Heap Delta: +${memDelta} MB`);
    console.log(`  Total Lines: ${result.totalLines.toLocaleString()}`);
    console.log(`  Units: ${p.units.toUpperCase()}`);
    console.log(`  Bounding Box:`);
    console.log(`    X: [${result.bounds.minX.toFixed(2)}, ${result.bounds.maxX.toFixed(2)}] (${(result.bounds.maxX - result.bounds.minX).toFixed(2)})`);
    console.log(`    Y: [${result.bounds.minY.toFixed(2)}, ${result.bounds.maxY.toFixed(2)}] (${(result.bounds.maxY - result.bounds.minY).toFixed(2)})`);
    console.log(`    Z: [${result.bounds.minZ.toFixed(2)}, ${result.bounds.maxZ.toFixed(2)}] (${(result.bounds.maxZ - result.bounds.minZ).toFixed(2)})`);
    console.log(`  Segments:`);
    console.log(`    Rapids: ${result.stats.rapidCount.toLocaleString()} (${(p.distance.rapid).toFixed(1)} ${p.units})`);
    console.log(`    Cuts:   ${result.stats.cutCount.toLocaleString()} (${(p.distance.cut).toFixed(1)} ${p.units})`);
    console.log(`    Arcs:   ${result.stats.arcCount.toLocaleString()} (${(p.distance.arc).toFixed(1)} ${p.units})`);
    console.log(`    Total Distance: ${(p.distance.rapid + p.distance.cut + p.distance.arc).toFixed(1)} ${p.units}`);
    console.log(`  Feed Rate Range: [${p.feedRange[0].toFixed(0)}, ${p.feedRange[1].toFixed(0)}] ${p.units}/min`);
    console.log(`  Estimated Carve Duration:`);
    console.log(`    At 100% Feed Override: ${fmtTime(dur100)} (${dur100.toFixed(1)}s)`);
    console.log(`    At 200% Feed Override: ${fmtTime(dur200)} (${dur200.toFixed(1)}s) -- ~50% faster!`);
    console.log('----------------------------------------------------------------\n');
}
