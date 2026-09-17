// Pure decisions behind the device, camera and activity views. DOM-free so it
// can be tested under plain Node.

// ---- job.start expect (SPEC §3.4.3, RemoteCommandGate FILE_CHANGED) ----------

// The machine publishes loadSeq at the top level of report.state even when no
// file is loaded (file === null); file.loadSeq carries the same value when one is.
export function currentLoadSeq(st, lastLoadSeq) {
    if (st && typeof st.loadSeq === 'number') return st.loadSeq;
    if (st && st.file && typeof st.file.loadSeq === 'number') return st.file.loadSeq;
    return typeof lastLoadSeq === 'number' ? lastLoadSeq : 0;
}

export function buildStartExpect(st, choice, lastLoadSeq) {
    if (!st || !choice) return null;
    const loadSeq = currentLoadSeq(st, lastLoadSeq);
    const wcsSeq = typeof st.wcsSeq === 'number' ? st.wcsSeq : 0;
    if (choice.libraryId) return { name: choice.name, size: choice.size, loadSeq, wcsSeq };
    return {
        name: st.file ? st.file.name : choice.name,
        size: st.file ? st.file.size : choice.size,
        loadSeq,
        wcsSeq,
    };
}

// ---- remote resume --------------------------------------------------------

// Resume from the cloud is accepted only for a pause made by a cloud client
// while no door or tool-change hold is in force. `channel` is honoured when the
// machine publishes it; an absent channel keeps the old behaviour (the machine
// still refuses a resume it does not own).
export function resumeState(st) {
    const pause = st && st.pause;
    const machine = st && st.machine;
    const raw = machine && typeof machine.rawState === 'string' ? machine.rawState : '';
    if (!pause) return { allowed: false, reason: 'unknown' };
    if (raw.startsWith('Door') || pause.origin === 'door') return { allowed: false, reason: 'door' };
    if (pause.origin === 'toolchange' || pause.toolchangePending === true) return { allowed: false, reason: 'toolchange' };
    if (pause.origin === 'lan') return { allowed: false, reason: 'lan' };
    if (pause.origin !== 'remote') return { allowed: false, reason: pause.origin || 'unknown' };
    if (pause.channel !== undefined && pause.channel !== null && pause.channel !== 'cloud') {
        return { allowed: false, reason: pause.channel === 'lan' ? 'lan' : 'other' };
    }
    return { allowed: true, reason: 'remote' };
}

export const RESUME_BLOCKED_TEXT = Object.freeze({
    door: 'Resume on the machine (door open)',
    toolchange: 'Resume on the machine (tool change)',
    lan: 'Paused from a device on the machine’s network: resume there or on the machine',
});

export function resumeBlockedText(reason) {
    return RESUME_BLOCKED_TEXT[reason] || 'Resume on the machine (tool change / local pause)';
}

// ---- camera frame cursor ----------------------------------------------------

// The relay serves a frame only when frame.seq > after. The machine restarts
// its per-camera seq at 1 whenever its camera lease ends, so an old `after`
// can hide every new frame for minutes. Once no new frame has arrived for
// `resetAfterMs` (a pause in polling, a reconnect, a restarted push), the
// cursor stops sending `after` and accepts whatever frame is current.
export const FRAME_CURSOR_RESET_MS = 5000;

export function createFrameCursor({ now, resetAfterMs = FRAME_CURSOR_RESET_MS } = {}) {
    if (typeof now !== 'function') throw new TypeError('createFrameCursor: now() required');
    let lastSeq = null;
    let lastTs = null;
    let lastProgressAt = null;
    return {
        after() {
            if (lastSeq === null || lastProgressAt === null) return null;
            return now() - lastProgressAt > resetAfterMs ? null : lastSeq;
        },
        // Returns true when the frame is new and should be shown.
        onFrame(seq, ts) {
            const s = Number.isFinite(seq) ? seq : null;
            const t = Number.isFinite(ts) ? ts : null;
            if (s !== null && s === lastSeq && t === lastTs) return false;
            lastSeq = s;
            lastTs = t;
            lastProgressAt = now();
            return true;
        },
        reset() {
            lastSeq = null;
            lastTs = null;
            lastProgressAt = null;
        },
        lastFrameAt: () => lastProgressAt,
    };
}

// ---- activity paging ---------------------------------------------------------

// Rows come newest first (ts DESC, id DESC); the next page starts strictly after
// the last row by the (ts, id) cursor, so rows sharing one millisecond are never skipped.
export function auditCursor(rows) {
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const last = rows[rows.length - 1];
    if (!last || !Number.isFinite(last.ts)) return null;
    return Number.isSafeInteger(last.id) ? { before: last.ts, beforeId: last.id } : { before: last.ts };
}

// ---- tier countdown ---------------------------------------------------------

export const TIER_AGE_MAX_MS = 60000;

// report.tier is refreshed every 30 s when nothing changes and the relay replays
// its cached copy on every subscribe. Estimate how old the body is on the
// machine's own clock: the latest report.state `at` plus the time since it
// arrived is the machine's "now"; the tier body carries its own `serverNow`.
export function tierAgeMs(tierBody, state, stateAt, nowMs) {
    if (!tierBody || !Number.isFinite(tierBody.serverNow)) return 0;
    if (!state || !Number.isFinite(state.at) || !Number.isFinite(stateAt) || !Number.isFinite(nowMs)) return 0;
    const machineNow = state.at + Math.max(0, nowMs - stateAt);
    const age = machineNow - tierBody.serverNow;
    if (!Number.isFinite(age) || age <= 0) return 0;
    return Math.min(age, TIER_AGE_MAX_MS);
}

export function motionRemainingMs(tier, tierAt, nowMs) {
    if (!tier) return null;
    const base = Number.isFinite(tier.motionRemainingMs)
        ? tier.motionRemainingMs
        : (Number.isFinite(tier.motionExpiresAt) && Number.isFinite(tier.serverNow) ? tier.motionExpiresAt - tier.serverNow : null);
    if (base === null) return null;
    const at = Number.isFinite(tierAt) ? tierAt : nowMs;
    return base - (nowMs - at);
}

// Text for the polite live region: tier changes and 60 s / 10 s thresholds only.
export const MOTION_ANNOUNCE_THRESHOLDS_MS = Object.freeze([60000, 10000]);

export function tierAnnouncement(prev, next) {
    const p = prev || { tier: null, remaining: null };
    const n = next || { tier: null, remaining: null };
    if (p.tier !== n.tier) {
        if (p.tier === null) return null;
        if (n.tier === 'motion') return 'Motion enabled';
        if (p.tier === 'motion') return n.tier === 'job' ? 'Motion ended; job control only' : 'Motion ended';
        if (n.tier === 'job') return 'Job control enabled';
        if (n.tier === 'monitor') return 'Monitor only';
        return null;
    }
    if (n.tier !== 'motion' || !Number.isFinite(n.remaining) || !Number.isFinite(p.remaining)) return null;
    for (const t of MOTION_ANNOUNCE_THRESHOLDS_MS) {
        if (p.remaining > t && n.remaining <= t) return 'Motion ends in ' + Math.round(t / 1000) + ' seconds';
    }
    return null;
}

// ---- retries ----------------------------------------------------------------

export function retryDelayMs(attempt, { baseMs = 1000, maxMs = 30000 } = {}) {
    const n = Math.max(1, Math.floor(attempt) || 1);
    return Math.min(maxMs, baseMs * 2 ** Math.min(n - 1, 16));
}

// ---- machine list -------------------------------------------------------------

// Presence line for one card on #/devices. `live` is the store entry (presence +
// latest report.state); `dev` is the GET /api/devices row.
export function devicePresence(dev, live, nowWallMs, stateLabel = {}) {
    const d = dev || {};
    const presence = live && live.presence;
    const online = presence ? !!presence.online : !!d.online;
    const pending = d.status === 'pending_confirmation';
    const machineState = live && live.state && live.state.machine ? live.state.machine.state : null;
    let text;
    if (pending) text = 'Waiting for confirmation on the machine screen';
    else if (online) text = 'Online' + (machineState ? ' · ' + (stateLabel[machineState] || machineState) : '');
    else if (Number.isFinite(d.lastSeenAt)) text = 'Offline · last seen ' + timeAgo(nowWallMs - d.lastSeenAt);
    else text = 'Offline · never connected';
    return {
        pending,
        online,
        text,
        dot: pending ? 'dot-warn' : online ? 'dot-ok' : 'dot-idle',
        controller: (presence && presence.controllerType) || d.controllerType || 'Unknown controller',
    };
}

export function timeAgo(ms) {
    if (!Number.isFinite(ms)) return 'never';
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return s + ' s ago';
    const m = Math.round(s / 60);
    if (m < 60) return m + ' min ago';
    const hrs = Math.round(m / 60);
    if (hrs < 48) return hrs + ' h ago';
    return Math.round(hrs / 24) + ' days ago';
}

// What forces a card to be rebuilt (its element type or link changes). Anything
// else (presence, machine state, controller) is updated in place.
export function deviceCardShape(dev) {
    const d = dev || {};
    return JSON.stringify([d.id, d.name || '', d.role || '', d.status === 'pending_confirmation']);
}

// Keyed list that builds each item once and updates it in place afterwards, so
// telemetry at 1-5 Hz never detaches the focused link or a tapped card.
// container: { replaceChildren(...nodes) }; build(row) -> { node, ... };
// update(item, row) refreshes an item built by build().
export function createKeyedList({ container, key, shape, build, update }) {
    let items = new Map();
    let mounted = false;
    return {
        // Rebuilds only rows whose shape changed and touches the container only
        // when the set or order of nodes changed. Returns true if it did.
        setRows(rows) {
            const next = new Map();
            for (const row of rows) {
                const k = key(row);
                const s = shape(row);
                const prev = items.get(k);
                const item = prev && prev.shape === s ? prev : { shape: s, ...build(row) };
                update(item, row);
                next.set(k, item);
            }
            const before = [...items.values()].map((it) => it.node);
            const nodes = [...next.values()].map((it) => it.node);
            const changed = !mounted || nodes.length !== before.length || nodes.some((n, i) => n !== before[i]);
            items = next;
            mounted = true;
            if (changed) container.replaceChildren(...nodes);
            return changed;
        },
        // In-place refresh of existing items only (all rows, or the one keyed k).
        refresh(rows, k) {
            for (const row of rows) {
                if (k !== undefined && key(row) !== k) continue;
                const item = items.get(key(row));
                if (item) update(item, row);
            }
        },
    };
}

// ---- camera availability announcements ---------------------------------------

// The "Frame N s ago" line is rewritten every second, so it is not a live
// region. Only transitions between these phases are announced.
export function cameraPhase(lastFrameAt, nowMs, noFrameMs, errCode) {
    if (lastFrameAt === null || !Number.isFinite(lastFrameAt) || nowMs - lastFrameAt > noFrameMs) {
        return errCode === 'LAN_ONLY' ? 'lan-only' : 'none';
    }
    return 'live';
}

export function cameraAnnouncement(prevPhase, nextPhase) {
    if (prevPhase === nextPhase) return null;
    if (nextPhase === 'live') return 'Camera image available';
    if (nextPhase === 'lan-only') return 'No camera image (machine is LAN-only)';
    if (prevPhase === null || prevPhase === undefined) return null;
    return 'No camera image';
}
