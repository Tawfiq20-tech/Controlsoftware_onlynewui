// Tiny observable state plus the per-device telemetry cache fed by the socket.

import { T, deviceIdFromTopic } from './protocol.js';
import { tierAgeMs } from './core/view.js';

function sameJson(a, b) {
    try { return JSON.stringify(a) === JSON.stringify(b); } catch (_) { return false; }
}

export function createStore(initial = {}) {
    let state = { ...initial };
    const subs = new Set();
    return {
        get: () => state,
        set(patch) {
            state = { ...state, ...patch };
            for (const fn of Array.from(subs)) {
                try { fn(state); } catch (err) { console.error('[store]', err); }
            }
        },
        subscribe(fn) {
            subs.add(fn);
            return () => subs.delete(fn);
        },
    };
}

// Keeps the latest presence / report.state / report.tier per device, plus the
// local monotonic receive times the countdowns need (SPEC §3.8).
export function createDeviceStore({ now = () => performance.now() } = {}) {
    const devices = new Map();
    const subs = new Set();

    function entry(id) {
        let d = devices.get(id);
        if (!d) {
            d = {
                id,
                presence: null,
                state: null,
                stateAt: null,
                tier: null,
                tierAt: null,
                tierId: null,
                wcsSeq: null,
                wcsChangedAt: null,
                lastLoadSeq: null,
                files: new Map(),
                cameraError: null,
                removed: false,
                denied: false,
            };
            devices.set(id, d);
        }
        return d;
    }

    function notify(id, kind, payload) {
        for (const fn of Array.from(subs)) {
            try { fn(id, kind, payload); } catch (err) { console.error('[devices]', err); }
        }
    }

    function apply(msg) {
        const body = msg.body && typeof msg.body === 'object' ? msg.body : {};
        switch (msg.t) {
        case T.SUBSCRIBED: {
            for (const id of Array.isArray(body.denied) ? body.denied : []) {
                if (typeof id !== 'string') continue;
                entry(id).denied = true;
                notify(id, 'denied');
            }
            for (const id of Array.isArray(body.deviceIds) ? body.deviceIds : []) {
                if (typeof id !== 'string') continue;
                const d = entry(id);
                d.denied = false;
                d.removed = false;
            }
            return;
        }
        case T.PRESENCE: {
            const id = deviceIdFromTopic(msg.topic);
            if (!id) return;
            const d = entry(id);
            d.presence = body;
            if (!body.online) {
                // Stale telemetry must never look current once the machine is gone.
                d.cameraError = null;
            }
            notify(id, 'presence');
            return;
        }
        case T.REPORT_STATE: {
            const id = deviceIdFromTopic(msg.topic);
            if (!id) return;
            const d = entry(id);
            if (d.state && typeof body.seq === 'number' && typeof d.state.seq === 'number'
                && body.seq < d.state.seq && body.at <= d.state.at) return;
            if (typeof body.wcsSeq === 'number') {
                if (d.wcsSeq !== null && body.wcsSeq !== d.wcsSeq) d.wcsChangedAt = now();
                d.wcsSeq = body.wcsSeq;
            }
            // loadSeq is published at the top level even when no file is loaded.
            if (typeof body.loadSeq === 'number') d.lastLoadSeq = body.loadSeq;
            else if (body.file && typeof body.file.loadSeq === 'number') d.lastLoadSeq = body.file.loadSeq;
            d.state = body;
            d.stateAt = now();
            notify(id, 'state');
            return;
        }
        case T.REPORT_TIER: {
            const id = deviceIdFromTopic(msg.topic);
            if (!id) return;
            const d = entry(id);
            const at = now();
            const envId = typeof msg.id === 'string' ? msg.id : null;
            // The relay replays its cached tier on every subscribe. A copy of the
            // tier already held must not restart the Motion countdown.
            const replay = d.tier !== null && d.tierAt !== null
                && ((envId !== null && envId === d.tierId) || sameJson(body, d.tier));
            if (!replay) {
                d.tier = body;
                d.tierId = envId;
                // A body that is already old (cached on the relay for up to 30 s)
                // counts down from when the machine sent it, not from now.
                d.tierAt = at - tierAgeMs(body, d.state, d.stateAt, at);
            }
            notify(id, 'tier');
            return;
        }
        case T.DEVICE_REMOVED: {
            if (typeof body.deviceId !== 'string') return;
            const d = entry(body.deviceId);
            d.removed = true;
            d.presence = null;
            d.state = null;
            d.tier = null;
            notify(body.deviceId, 'removed');
            return;
        }
        case T.FILE_STATUS: {
            if (typeof body.deviceId !== 'string' || typeof body.transferId !== 'string') return;
            entry(body.deviceId).files.set(body.transferId, body);
            notify(body.deviceId, 'file', body);
            return;
        }
        case T.CAMERA_ERROR: {
            const id = deviceIdFromTopic(msg.topic);
            if (!id) return;
            entry(id).cameraError = { ...body, at: now() };
            notify(id, 'camera', body);
            return;
        }
        default:
        }
    }

    return {
        apply,
        get: (id) => devices.get(id) || null,
        ensure: entry,
        subscribe(fn) {
            subs.add(fn);
            return () => subs.delete(fn);
        },
        // On reconnect the cached state is replayed by `subscribed`; until then
        // presence must read as unknown rather than as the last seen value.
        markAllUnknown() {
            for (const [id, d] of devices) {
                d.presence = d.presence ? { ...d.presence, online: false, stale: true } : null;
                notify(id, 'presence');
            }
        },
        clear() {
            devices.clear();
        },
    };
}
