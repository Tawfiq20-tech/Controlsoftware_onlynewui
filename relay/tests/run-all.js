'use strict';

// Runs every relay/tests/*.test.js in its own child process (§10.1) and prints a summary.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const FILE_TIMEOUT_MS = 30000;
const CONCURRENCY = Math.max(1, Number(process.env.RELAY_TEST_CONCURRENCY) || 3);

const dir = __dirname;
const only = process.argv.slice(2);
const files = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.test.js'))
    .filter((f) => only.length === 0 || only.some((o) => f.includes(o)))
    .sort();

function runOne(file) {
    return new Promise((resolve) => {
        const started = Date.now();
        const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(dir, file)], {
            cwd: path.join(dir, '..'),
            env: Object.assign({}, process.env, { NODE_ENV: 'test' }),
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { out += d; });
        const timer = setTimeout(() => {
            out += `\n[run-all] killed after ${FILE_TIMEOUT_MS} ms\n`;
            child.kill();
        }, FILE_TIMEOUT_MS + 2000);
        child.on('close', (code) => {
            clearTimeout(timer);
            resolve({ file, code, out, ms: Date.now() - started, skipped: /^SKIP:/m.test(out) });
        });
    });
}

(async () => {
    const results = [];
    const queue = files.slice();
    async function worker() {
        while (queue.length) {
            const file = queue.shift();
            const r = await runOne(file);
            results.push(r);
            process.stdout.write(`\n----- ${file} (${r.code === 0 ? (r.skipped ? 'skipped' : 'ok') : 'FAILED'}, ${r.ms} ms) -----\n${r.out}`);
        }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, worker));
    results.sort((a, b) => a.file.localeCompare(b.file));
    console.log('\n===== Relay test summary =====');
    for (const r of results) console.log(`${r.code === 0 ? (r.skipped ? 'SKIP' : 'PASS') : 'FAIL'}  ${r.file}  (${r.ms} ms)`);
    const failed = results.filter((r) => r.code !== 0);
    console.log(`${results.length - failed.length}/${results.length} files passed`);
    process.exit(failed.length ? 1 : 0);
})();
