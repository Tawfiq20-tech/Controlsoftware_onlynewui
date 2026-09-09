'use strict';

/**
 * Inserts a G4 dwell after every spindle-start command (M3/M03/M4/M04) so
 * the tool isn't plunging into stock before the spindle has reached speed.
 * Host-side only, same pattern as linearizeArcs.js -- rewrites the
 * in-memory copy handed to JobStream.upload(), never the user's file.
 *
 * Skips insertion if the file already dwells right after the M3/M4 line
 * (respects an author who already added their own spin-up delay).
 */

const SPINDLE_ON_RE = /^(?:N\d+\s*)?M0?[34]\b/i;
const DWELL_RE = /^(?:N\d+\s*)?G0?4\b/i;

function injectSpindleDelay(text, delaySeconds) {
    const delay = Number(delaySeconds) || 0;
    if (!(delay > 0)) {
        return { text: String(text || ''), insertedCount: 0 };
    }

    const lines = String(text || '').split(/\r?\n/);
    const out = [];
    let insertedCount = 0;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        out.push(line);
        if (SPINDLE_ON_RE.test(line.trim())) {
            let j = i + 1;
            while (j < lines.length && lines[j].trim() === '') j++;
            if (j < lines.length && DWELL_RE.test(lines[j].trim())) {
                continue;
            }
            out.push(`G4 P${delay}`);
            insertedCount++;
        }
    }

    return { text: out.join('\n'), insertedCount };
}

module.exports = injectSpindleDelay;
