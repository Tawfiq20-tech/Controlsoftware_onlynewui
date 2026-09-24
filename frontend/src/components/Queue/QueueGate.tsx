/**
 * The one tap between two designs.
 *
 * This sits over whatever screen the operator is on, because the moment it
 * matters is the moment a design finishes -- and that is the moment they are
 * walking back to the machine, not looking at the Queue page.
 *
 * It shows only when the queue is waiting, counting down, or held. While a
 * design is cutting it stays out of the way: the job bar owns that screen.
 *
 * The preview follows the machine. When the queue puts the next design on the
 * controller, this fetches that program and hands it to the store, so the 3D
 * view is never showing the design that just finished while the button says
 * "Start design 4".
 */
import { useEffect, useRef, useState } from 'react';
import { Play, Pause, SkipForward, AlertTriangle, ListOrdered } from 'lucide-react';
import { useCNCStore } from '../../stores/cncStore';
import { queueApi } from '../../utils/queueApi';
import { remoteAuthHeaders } from '../../utils/remoteAuth';
import { parseGcodeAsync } from '../../utils/gcodeParser';
import './QueueGate.css';

const BACKEND_BASE = (() => {
    const env = (import.meta as unknown as { env?: { VITE_API_URL?: string } }).env?.VITE_API_URL;
    if (env) return String(env).replace(/\/$/, '');
    if (typeof window !== 'undefined') {
        const { protocol, hostname, port, origin } = window.location;
        if (port === '5173' || port === '4000') return `${protocol}//${hostname}:4000`;
        return origin;
    }
    return 'http://localhost:4000';
})();

export default function QueueGate() {
    const queue = useCNCStore((s) => s.queue);
    const setGcode = useCNCStore((s) => s.setGcode);
    const setToolpathSegments = useCNCStore((s) => s.setToolpathSegments);
    const setParsedToolpath = useCNCStore((s) => s.setParsedToolpath);
    const setRawGcodeContent = useCNCStore((s) => s.setRawGcodeContent);
    const setFileInfo = useCNCStore((s) => s.setFileInfo);
    const addConsoleLog = useCNCStore((s) => s.addConsoleLog);

    const [left, setLeft] = useState(0);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const shownFor = useRef<string | null>(null);

    const state = queue?.state;
    const gateId = queue?.gateId ?? null;
    const open = state === 'gate' || state === 'countdown' || state === 'held' || state === 'returning' || state === 'loading';

    // Seconds remaining, recomputed from the backend's deadline rather than
    // counted down locally: a screen that was asleep must not show 7 seconds
    // left on a countdown that ended a minute ago.
    useEffect(() => {
        if (state !== 'countdown' || !queue?.countdownEndsAt) { setLeft(0); return; }
        const tick = () => setLeft(Math.max(0, Math.ceil((queue.countdownEndsAt - Date.now()) / 1000)));
        tick();
        const t = setInterval(tick, 250);
        return () => clearInterval(t);
    }, [state, queue?.countdownEndsAt]);

    // Show the design the machine now holds, not the one that just finished.
    useEffect(() => {
        if (!gateId || shownFor.current === gateId) return;
        shownFor.current = gateId;
        let cancelled = false;
        void (async () => {
            try {
                const r = await fetch(`${BACKEND_BASE}/api/job/program`, { credentials: 'include', headers: remoteAuthHeaders() });
                if (!r.ok) return;
                const content = await r.text();
                if (!content || cancelled) return;
                const name = r.headers.get('X-Program-Name') ? decodeURIComponent(r.headers.get('X-Program-Name') as string) : '';
                const parsed = await parseGcodeAsync(content);
                if (cancelled || !parsed.lines?.length) return;
                setGcode(parsed.lines);
                setToolpathSegments(parsed.segments);
                if (parsed.parsedToolpath) setParsedToolpath(parsed.parsedToolpath);
                setRawGcodeContent(content);
                setFileInfo({ name: name || 'queued design', size: content.length, lines: parsed.lines.length });
                addConsoleLog('info', `Queue loaded "${name}" — the preview is the design that will run.`);
            } catch (_) {
                // The gate still works; only the preview is missing.
            }
        })();
        return () => { cancelled = true; };
    }, [gateId, setGcode, setToolpathSegments, setParsedToolpath, setRawGcodeContent, setFileInfo, addConsoleLog]);

    if (!open || !queue) return null;

    const entry = queue.entries.find((e) => e.id === queue.gateId);
    const held = state === 'held';
    const waiting = state === 'returning' || state === 'loading';

    async function run(fn: () => Promise<{ ok: boolean; error?: string; message?: string }>) {
        setBusy(true);
        const r = await fn();
        setBusy(false);
        setError(r.ok ? null : (r.message || r.error || 'That did not work'));
    }

    return (
        <div className={`queue-gate ${held ? 'held' : ''}`} role="status">
            <div className="queue-gate-head">
                {held ? <AlertTriangle size={18} /> : <ListOrdered size={18} />}
                <span className="queue-gate-title">
                    {held ? 'Queue holding' : waiting ? 'Queue' : `Design ${queue.position} of ${queue.total}`}
                </span>
                <span className="queue-gate-count">{queue.done}/{queue.total} done</span>
            </div>

            <p className="queue-gate-msg">{error || queue.message}</p>
            {entry && !held && !waiting && <p className="queue-gate-name">{entry.name}</p>}

            {!waiting && (
                <div className="queue-gate-buttons">
                    {state === 'countdown' ? (
                        <>
                            <button className="queue-gate-hold" disabled={busy} onClick={() => void run(() => queueApi.hold())}>
                                <Pause size={20} /> Hold ({left}s)
                            </button>
                            <button className="queue-gate-start" disabled={busy} onClick={() => void run(() => queueApi.start())}>
                                <Play size={20} /> Start now
                            </button>
                        </>
                    ) : (
                        <>
                            <button className="queue-gate-skip" disabled={busy} onClick={() => void run(() => queueApi.skip())}>
                                <SkipForward size={18} /> Skip
                            </button>
                            <button
                                className="queue-gate-start"
                                disabled={busy || held}
                                onClick={() => void run(() => queueApi.start())}
                            >
                                <Play size={20} /> {held ? 'Held' : `Start design ${queue.position}`}
                            </button>
                        </>
                    )}
                </div>
            )}

            {held && (
                <button className="queue-gate-rearm" disabled={busy} onClick={() => void run(() => queueApi.arm(true))}>
                    Arm the queue again
                </button>
            )}

            <p className="queue-gate-router">The router is yours to switch — this machine cannot.</p>
        </div>
    );
}
