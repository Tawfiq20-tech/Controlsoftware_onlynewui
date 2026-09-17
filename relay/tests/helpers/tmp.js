'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function tmpDir(prefix = 'relay-test-') {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function removeDir(dir) {
    if (!dir) return;
    for (let i = 0; i < 5; i++) {
        try {
            fs.rmSync(dir, { recursive: true, force: true });
            return;
        } catch (_) {
            // Windows may hold the WAL briefly after close; retry synchronously a few times.
            const until = Date.now() + 50;
            while (Date.now() < until) { /* spin */ }
        }
    }
}

module.exports = { tmpDir, removeDir };
