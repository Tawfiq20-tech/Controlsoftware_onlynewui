'use strict';

/**
 * Notices when the RSP controller board has restarted between two
 * connections, so the sender stops trusting a position the board no longer has.
 *
 * Why: on 2026-09-16 the board rebooted mid-job three times (12:10, 22:37,
 * 23:20; also 2026-09-10 18:40). A reboot resets the board's X/Y/Z to 0 at
 * wherever the tool is, the drivers drop out, and USB re-enumerates -- the
 * sender reconnected 3 s later and nothing said the zero was gone. The next
 * Start ran the file from that accidental zero.
 *
 * How: telemetry carries dbg_tim2_isr_count, the step-timer interrupt count
 * since the board booted. Within one boot it only ever grows; after a reboot
 * it starts again from 0. The last value seen is kept across reconnects and
 * backend restarts (data/controller_last_seen.json), and the first telemetry
 * of a new connection is compared with it.
 */

const fs = require('fs');
const path = require('path');
const logger = require('../logger');

const PERSIST_EVERY_MS = 10000;

class ControllerRestartMonitor {
    /** @param {string} file JSON file the last-seen state is kept in */
    constructor(file = path.join(__dirname, '..', 'data', 'controller_last_seen.json')) {
        this._file = file;
        this._last = null;      // { isr, pos: {x,y,z}, at }
        this._lostJob = null;   // { name, line, at } when a job was cut off by a connection loss
        this._checkPending = false;
        this._persistedAt = 0;
        this._load();
    }

    /** A new controller instance was bound to a fresh connection. */
    onBind() {
        this._checkPending = true;
    }

    /**
     * Feed every controller status. Returns restart info the first time a
     * new connection shows the board has rebooted, otherwise null.
     * @returns {null | { previous: {isr:number, pos:object, at:number}, lostJob: object|null }}
     */
    onStatus(status) {
        if (!status || typeof status.dbgTim2IsrCount !== 'number') return null;
        const isr = status.dbgTim2IsrCount;
        const pos = status.wpos || status.mpos || null;
        let restart = null;
        if (this._checkPending) {
            this._checkPending = false;
            const prev = this._last;
            if (prev && typeof prev.isr === 'number' && isr < prev.isr) {
                restart = { previous: prev, lostJob: this._lostJob };
                logger.warn(`[RestartMonitor] controller restarted: step-timer count ${prev.isr} -> ${isr}${this._lostJob ? ` (job "${this._lostJob.name}" was cut off at line ${this._lostJob.line})` : ''}`);
            }
            // Either way the connection that lost a job has been accounted for.
            this._lostJob = null;
        }
        this._last = { isr, pos: pos ? { x: pos.x, y: pos.y, z: pos.z } : null, at: Date.now() };
        if (restart || Date.now() - this._persistedAt >= PERSIST_EVERY_MS) this._persist();
        return restart;
    }

    /** The serial port dropped. `lostJob` is set when a job was running. */
    onConnectionLost(lostJob) {
        this._lostJob = lostJob || null;
        this._persist();
    }

    _load() {
        try {
            const data = JSON.parse(fs.readFileSync(this._file, 'utf8'));
            if (data && data.last && typeof data.last.isr === 'number') this._last = data.last;
            if (data && data.lostJob) this._lostJob = data.lostJob;
        } catch (_) { /* first run, or unreadable: nothing to compare against yet */ }
    }

    _persist() {
        this._persistedAt = Date.now();
        try {
            fs.writeFileSync(this._file, JSON.stringify({ last: this._last, lostJob: this._lostJob }));
        } catch (err) {
            // A full disk must not break the connection; detection still works for this process.
            logger.warn(`[RestartMonitor] could not save ${path.basename(this._file)}: ${err.message}`);
        }
    }
}

module.exports = { ControllerRestartMonitor };
