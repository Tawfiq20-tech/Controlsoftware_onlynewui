// Which design is on the machine, and starting only the design this screen shows.
//
// The backend announces every load to every screen with file:load
// { name, total, size, hash? } (size = content length). A screen compares
// that with its own design by name AND content (size, plus the hash when the
// backend sends one), so a re-exported file with the same name is not taken
// for "my file".
//
// Play / Space never start on a timer after an upload any more: they send the
// design and wait for the backend's file:load of exactly that content, and
// give up with a clear message on file:loadError or when the link drops.
import controller from './controller';
import { useCNCStore } from '../stores/cncStore';

export interface LoadedFileInfo {
    name?: string;
    total?: number;
    size?: number;
    hash?: string;
}

// FNV-1a 32-bit over UTF-16 code units. Only used to tell two contents apart
// on this screen; cached for the last string (designs can be 30 MB).
let lastHashed: string | null = null;
let lastHash = '';
export function contentHash(content: string): string {
    if (content === lastHashed) return lastHash;
    let h = 0x811c9dc5;
    for (let i = 0; i < content.length; i++) {
        h ^= content.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    lastHashed = content;
    lastHash = (h >>> 0).toString(16).padStart(8, '0');
    return lastHash;
}

/** True when the backend's announced file is this name + content. */
export function loadedFileMatches(data: LoadedFileInfo | null | undefined, name: string, content: string): boolean {
    if (!data || !data.name || data.name !== name) return false;
    if (typeof data.size === 'number' && data.size !== content.length) return false;
    // The backend's hash algorithm is its own: only compare when it is ours.
    if (typeof data.hash === 'string' && /^[0-9a-f]{8}$/.test(data.hash) && data.hash !== contentHash(content)) return false;
    return true;
}

// Loads THIS screen sent and whose file:load has not come back yet. When the
// operator switches A -> B quickly, A's echo arrives while the screen already
// shows B: that is this screen's own older load, not "another screen".
const ownPendingLoads: Array<{ name: string; size: number; at: number }> = [];

/** Send a design from this screen (no start). */
export function sendDesign(name: string, content: string): void {
    const now = Date.now();
    while (ownPendingLoads.length && (ownPendingLoads.length > 8 || now - ownPendingLoads[0].at > 300_000)) ownPendingLoads.shift();
    ownPendingLoads.push({ name, size: content.length, at: now });
    controller.loadFile(name, content);
}

/**
 * A load of `name` was refused (file:loadError): it will never echo, so forget
 * the oldest pending entry. Left behind, a later load of a same-name, same-size
 * file by ANOTHER screen was taken for this screen's own echo, and Play then
 * started without sending this screen's content first.
 */
export function forgetOwnLoad(name: string | undefined): void {
    if (!name) return;
    const i = ownPendingLoads.findIndex((l) => l.name === name);
    if (i >= 0) ownPendingLoads.splice(i, 1);
}

/** True (and forgotten) when this file:load is the echo of a load this screen sent. */
export function takeOwnLoadEcho(data: LoadedFileInfo | null | undefined): boolean {
    lastLoadWasOwn = false;
    if (!data || !data.name) return false;
    const i = ownPendingLoads.findIndex((l) => l.name === data.name && (typeof data.size !== 'number' || l.size === data.size));
    if (i < 0) return false;
    ownPendingLoads.splice(i, 1);
    lastLoadWasOwn = true;
    return true;
}

// True when the latest file:load was the echo of a load THIS screen sent. When
// it was not (another screen, or the backend replaying its file to a screen
// that just connected), name + size cannot prove the content is the same: a
// re-exported file can have the same name and size. Play / Space then send
// this screen's content again and start only after the machine confirms it
// (the same content is simply re-announced by the backend).
let lastLoadWasOwn = false;

export type LoadResult = { ok: true } | { ok: false; message: string };

// Large designs compile off-thread on the backend; allow for that.
const LOAD_CONFIRM_TIMEOUT_MS = 180_000;

/**
 * Send a design to the backend and resolve once the backend confirms that
 * exactly this content is loaded. Never starts anything.
 */
export function loadAndConfirm(name: string, content: string, timeoutMs = LOAD_CONFIRM_TIMEOUT_MS): Promise<LoadResult> {
    return new Promise<LoadResult>((resolve) => {
        let done = false;
        const finish = (r: LoadResult) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            controller.off('file:load', onLoad);
            controller.off('file:loadError', onError);
            controller.off('serialport:close', onClose);
            controller.off('serialport:error', onSerialError);
            resolve(r);
        };
        const onLoad = (data: unknown) => {
            if (loadedFileMatches(data as LoadedFileInfo, name, content)) finish({ ok: true });
            // A different file announced meanwhile (another screen): keep waiting
            // for ours -- the backend handles loads in order.
        };
        const onError = (data: unknown) => {
            const d = (data || {}) as { name?: string; busy?: boolean; errors?: Array<{ msg?: string }> };
            if (d.name && d.name !== name) return;
            if (d.busy) {
                finish({ ok: false, message: d.errors?.[0]?.msg || `A job is running, so "${name}" was not loaded. Stop the job first, then press Play again.` });
            } else {
                finish({ ok: false, message: `"${name}" was not loaded onto the machine (see the reasons above), so nothing was started.` });
            }
        };
        const onClose = () => finish({ ok: false, message: `The machine disconnected before "${name}" finished loading. Nothing was started. Reconnect, then press Play again.` });
        const onSerialError = (data: unknown) => {
            const err = (data as { error?: string } | null)?.error;
            if (err === 'No active controller' || err === 'Missing G-code content') {
                finish({ ok: false, message: `"${name}" could not be loaded (${err}). Nothing was started. Wait until the machine shows connected, then press Play again.` });
            }
        };
        const timer = setTimeout(() => finish({ ok: false, message: `The machine did not confirm loading "${name}" in time. Nothing was started. Press Play again.` }), timeoutMs);
        controller.on('file:load', onLoad);
        controller.on('file:loadError', onError);
        controller.on('serialport:close', onClose);
        controller.on('serialport:error', onSerialError);
        sendDesign(name, content);
    });
}

let startInFlight = false;

/**
 * Play / Space from idle: start the design this screen shows, and only that.
 * Returns true when a start was sent (or a load+start is under way).
 */
export function startShownDesign(source: string): boolean {
    const s = useCNCStore.getState();
    if (startInFlight) {
        s.addConsoleLog('info', 'Still loading the design onto the machine -- the job starts as soon as the machine confirms it.');
        return false;
    }
    const content = s.rawGcodeContent;
    const name = s.fileInfo?.name || 'job.gcode';
    if (!content) {
        s.addConsoleLog('warning', 'No design is open on this screen. Open a file first.');
        return false;
    }
    if (s.outlineRunActive) {
        s.addConsoleLog('warning', 'The outline run is not finished yet. Wait until the design is restored, then press Play.');
        return false;
    }
    if (s.otherScreenFile) {
        s.addConsoleLog('error',
            `Nothing started: another screen loaded "${s.otherScreenFile}" onto the machine, so "${name}" shown here is not loaded. ` +
            'Use "Load my design again" in the warning at the top (or open the file again), check the preview, then press Play.');
        return false;
    }
    const sendStart = () => {
        controller.startJob();
        useCNCStore.getState().addConsoleLog('info', `Job started: ${name}${source === 'keyboard' ? ' (keyboard shortcut)' : ''}`);
    };
    if (s.fileLoadedBackend && lastLoadWasOwn) {
        sendStart();
        return true;
    }
    startInFlight = true;
    s.addConsoleLog('info', `Loading "${name}" onto the machine -- the job starts when the machine confirms it.`);
    loadAndConfirm(name, content).then((r) => {
        startInFlight = false;
        const cur = useCNCStore.getState();
        if (!r.ok) {
            cur.addConsoleLog('error', r.message);
            return;
        }
        // The operator changed the design, or another screen took over, while it loaded.
        if (cur.rawGcodeContent !== content || (cur.fileInfo?.name || 'job.gcode') !== name) {
            cur.addConsoleLog('warning', 'The design changed while it was loading. Nothing was started. Check the preview, then press Play again.');
            return;
        }
        if (cur.otherScreenFile || !cur.fileLoadedBackend) {
            cur.addConsoleLog('error', 'Another screen loaded a different design while this one was loading. Nothing was started.');
            return;
        }
        sendStart();
    });
    return true;
}
