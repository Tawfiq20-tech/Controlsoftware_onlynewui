/**
 * Session logger: writes machine/session data (position, state, console, job events) to a JSON Lines file.
 * One file per connection window; throttle position to ~1s to limit size.
 */
const fs = require('fs');
const path = require('path');

// A stalled disk (OneDrive hanging, a USB drive gone quiet) accepts writes
// into memory forever: past this much unwritten data, records are dropped.
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
// Once dropping, records are taken again only below this, so a disk that is
// slow rather than stalled does not flip in and out at every write.
const RESUME_BELOW_BYTES = MAX_BUFFERED_BYTES / 2;
// "not keeping up" goes to the app log at most this often per session log: a
// slow disk fills and drains over and over, and each gap is counted in the
// session log itself anyway (review, 2026-09-17).
const REPORT_EVERY_MS = 5 * 60 * 1000;

/** Report through the app logger when it is available, else stderr. */
function report(message) {
    try {
        require('../logger').warn(message);
    } catch (_) {
        // eslint-disable-next-line no-console
        try { console.error(message); } catch (__) { /* nowhere left */ }
    }
}

function createSessionLogger(sessionsDir, portPath) {
    const safeName = (portPath || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
    const filename = path.join(
        sessionsDir,
        `${new Date().toISOString().replace(/[:.]/g, '-')}_${safeName}.ndjson`
    );
    let lastPositionTime = 0;
    let broken = false;
    let dropping = false;
    let dropped = 0;        // in this session log, all gaps
    let gapDropped = 0;     // in the current gap
    let lastReportAt = -Infinity;
    const POSITION_THROTTLE_MS = 1000;

    let stream = null;
    try {
        stream = fs.createWriteStream(filename, { flags: 'a' });
    } catch (err) {
        broken = true;
        report(`[SessionLogger] session log disabled: cannot open ${filename}: ${err && err.message ? err.message : err}`);
    }

    // A write stream with no 'error' listener throws an UNCAUGHT exception when
    // the write fails -- disk full, permission denied, or the drive the app
    // runs from being pulled out. Logging must never be able to take the sender
    // down in the middle of a carve (plan BE-28a): give up on the log file and
    // let the job carry on. Reported once.
    if (stream) {
        stream.on('error', (err) => {
            if (broken) return;
            broken = true;
            report(`[SessionLogger] session log disabled for this connection: ${err && err.message ? err.message : err}`);
        });
    }

    function write(record) {
        if (broken || !stream) return;
        const unwritten = stream.writableLength;
        if (unwritten > (dropping ? RESUME_BELOW_BYTES : MAX_BUFFERED_BYTES)) {
            dropped++;
            gapDropped++;
            if (!dropping) {
                dropping = true;
                const now = Date.now();
                if (now - lastReportAt >= REPORT_EVERY_MS) {
                    lastReportAt = now;
                    report(`[SessionLogger] ${path.basename(filename)}: the disk is not keeping up (${Math.round(unwritten / 1048576)} MB unwritten); session records are being dropped until it catches up (${dropped} dropped in this log so far; each gap is counted in the log)`);
                }
            }
            return;
        }
        let line;
        try {
            line = JSON.stringify(record) + '\n';
        } catch (_) {
            return; // one unserialisable record; the log itself is fine
        }
        if (dropping) {
            dropping = false;
            line = JSON.stringify({ t: Date.now(), event: 'session-log', dropped: gapDropped, droppedTotal: dropped }) + '\n' + line;
            gapDropped = 0;
        }
        try {
            stream.write(line);
        } catch (err) {
            broken = true;
            report(`[SessionLogger] session log disabled for this connection: ${err && err.message ? err.message : err}`);
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
                if (stream) stream.end();
            } catch (_) {}
        },
        /** For diagnostics/tests: { disabled, dropped, bufferedBytes } */
        stats() {
            return { disabled: broken, dropped, bufferedBytes: stream ? stream.writableLength : 0 };
        },
    };
}

module.exports = { createSessionLogger };
