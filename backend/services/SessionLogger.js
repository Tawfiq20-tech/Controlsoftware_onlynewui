/**
 * Session logger: writes machine/session data (position, state, console, job events) to a JSON Lines file.
 * One file per connection window; throttle position to ~1s to limit size.
 */
const fs = require('fs');
const path = require('path');

function createSessionLogger(sessionsDir, portPath) {
    const safeName = (portPath || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
    const filename = path.join(
        sessionsDir,
        `${new Date().toISOString().replace(/[:.]/g, '-')}_${safeName}.ndjson`
    );
    const stream = fs.createWriteStream(filename, { flags: 'a' });
    let lastPositionTime = 0;
    let broken = false;
    const POSITION_THROTTLE_MS = 1000;

    // A write stream with no 'error' listener throws an UNCAUGHT exception when
    // the write fails -- disk full, permission denied, or the drive the app
    // runs from being pulled out. Logging must never be able to take the sender
    // down in the middle of a carve (plan BE-28a): give up on the log file and
    // let the job carry on.
    stream.on('error', (err) => {
        if (broken) return;
        broken = true;
        // eslint-disable-next-line no-console
        console.error(`[SessionLogger] session log disabled: ${err && err.message ? err.message : err}`);
    });

    function write(record) {
        if (broken) return;
        try {
            stream.write(JSON.stringify(record) + '\n');
        } catch (err) {
            broken = true;
        }
    }

    return {
        write,
        logConnection(opened, portPathOrReason) {
            write({
                t: Date.now(),
                event: opened ? 'connection:opened' : 'connection:closed',
                port: opened ? portPathOrReason : undefined,
                reason: opened ? undefined : portPathOrReason,
            });
        },
        logState(state) {
            write({ t: Date.now(), event: 'state', state });
        },
        logPosition(pos) {
            const now = Date.now();
            if (now - lastPositionTime >= POSITION_THROTTLE_MS) {
                lastPositionTime = now;
                write({ t: now, ...pos });
            }
        },
        logConsole(text) {
            write({ t: Date.now(), event: 'console', text });
        },
        logJob(payload) {
            write({ t: Date.now(), event: 'job', ...payload });
        },
        close() {
            try {
                broken = true; // no further writes; errors after end() are not ours to report
                stream.end();
            } catch (_) {}
        },
    };
}

module.exports = { createSessionLogger };
