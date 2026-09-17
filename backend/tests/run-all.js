'use strict';

/**
 * `npm test` entry point: runs every self-contained test file in this folder
 * as its own Node process and fails if any of them fails.
 *
 * Excluded (legacy, not runnable standalone): phase0.test.js (imports a
 * GRBLController export that no longer exists) and recovery.test.js (written
 * for a mocha runner that is not installed).
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { GUARD, makeRunRoot, isolatedEnv, removeDir } = require('./helpers/isolatedEnv');

const EXCLUDE = new Set(['phase0.test.js', 'recovery.test.js']);
const dir = __dirname;
const only = process.argv.slice(2);
const files = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.test.js') && !EXCLUDE.has(f))
    .filter((f) => !only.length || only.some((o) => f.includes(o)))
    .sort();

// Exit code 0 is not enough. These tests run on mocked timers, and a test that
// stops making progress (an await that never settles) empties the event loop
// and Node exits 0 in the middle -- a silent PASS for a test that never ran to
// the end. Every test file must SAY it finished.
const DONE = 'ALL TESTS PASSED SUCCESSFULLY!';

// Each test gets its own logs/ and data/ folder (EASYCNC_LOG_DIR /
// EASYCNC_DATA_DIR, lib/runtimePaths.js) and the production write guard, so a
// test run on the machine PC can never write the real app.log, session logs,
// job history, checkpoint or config. Test output in the real app.log was once
// mistaken for a real link loss during a job (2026-09-11, job 8).
const runRoot = makeRunRoot();

let failed = 0;
for (const f of files) {
    const t0 = Date.now();
    const iso = isolatedEnv(runRoot, f);
    const r = spawnSync(process.execPath, ['--require', GUARD, path.join(dir, f)], {
        encoding: 'utf8',
        timeout: 15 * 60 * 1000,
        env: iso.env,
    });
    const finished = String(r.stdout || '').includes(DONE);
    const ok = r.status === 0 && finished;
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const why = r.status !== 0 ? '' : (finished ? '' : '  <-- exited without finishing');
    // A test that skipped its corpus says so; that must not read as full cover.
    const skipped = ok && /\bSKIPPED\b|^\s*SKIP[: ]/m.test(String(r.stdout || ''));
    console.log(`${ok ? (skipped ? 'PASS*' : 'PASS ') : 'FAIL '} ${f}  (${secs}s)${why}${skipped ? '   [something was SKIPPED -- see the file\'s own output]' : ''}`);
    if (ok) {
        removeDir(iso.dir);
    } else {
        failed++;
        const tail = `${r.stdout || ''}\n${r.stderr || ''}${r.error ? `\n${r.error.message}` : ''}`.trim().split('\n').slice(-25).join('\n');
        console.log(tail.replace(/^/gm, '      '));
        console.log(`      (its logs and data were kept in ${iso.dir})`);
    }
}
if (!failed) removeDir(runRoot);
console.log(failed ? `\n${failed} test file(s) FAILED` : `\nall ${files.length} test files passed`);
process.exit(failed ? 1 : 0);
