/**
 * Queue — the list of designs to run, in order.
 *
 * Arming loads the first design and stops. Every design starts on a tap
 * (QueueGate), because nothing in this machine switches the router: see the
 * note beside the Auto switch, and backend/services/queue/QueueService.js.
 */
import { useEffect, useState } from 'react';
import {
    ListOrdered, Plus, Trash2, ChevronUp, ChevronDown, Play, SkipForward,
    RotateCcw, Check, X, AlertTriangle, Loader,
} from 'lucide-react';
import { useCNCStore, type QueueEntry } from '../../stores/cncStore';
import { queueApi } from '../../utils/queueApi';
import { remoteAuthHeaders } from '../../utils/remoteAuth';
import { isRemoteUpload, type LibraryEntry } from '../Settings/api';
import './QueuePanel.css';

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

const STATUS_TEXT: Record<QueueEntry['status'], string> = {
    pending: 'Waiting',
    loaded: 'Ready',
    running: 'Cutting',
    done: 'Finished',
    failed: 'Stopped',
    skipped: 'Skipped',
};

export default function QueuePanel() {
    const queue = useCNCStore((s) => s.queue);
    const [library, setLibrary] = useState<LibraryEntry[]>([]);
    const [picking, setPicking] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [askAuto, setAskAuto] = useState(false);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        // The panel can be the first thing opened after a page load, before
        // any queue:state has been pushed.
        if (!queue) void queueApi.get();
    }, [queue]);

    useEffect(() => {
        if (!picking) return;
        let cancelled = false;
        void (async () => {
            try {
                const r = await fetch(`${BACKEND_BASE}/api/library`, { credentials: 'include', headers: remoteAuthHeaders() });
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                const items = await r.json() as LibraryEntry[];
                if (!cancelled) setLibrary(items);
            } catch (err) {
                if (!cancelled) setError(`Could not read the library: ${err instanceof Error ? err.message : String(err)}`);
            }
        })();
        return () => { cancelled = true; };
    }, [picking]);

    async function act(fn: () => Promise<{ ok: boolean; error?: string; message?: string }>) {
        setBusy(true);
        const r = await fn();
        setBusy(false);
        setError(r.ok ? null : (r.message || r.error || 'That did not work'));
        return r.ok;
    }

    const entries = queue?.entries ?? [];
    const armed = !!queue?.armed;
    const state = queue?.state ?? 'idle';
    const running = state === 'running';
    const canEdit = !busy;

    return (
        <div className="queue-panel">
            <header className="queue-head">
                <div className="queue-head-title">
                    <ListOrdered size={22} />
                    <h2>Design queue</h2>
                </div>
                <div className="queue-head-counts">
                    <span><strong>{queue?.done ?? 0}</strong> done</span>
                    <span><strong>{queue?.pending ?? 0}</strong> waiting</span>
                </div>
            </header>

            {/* What the queue is doing right now, in the operator's words. */}
            <div className={`queue-status queue-status-${state}`}>
                {state === 'loading' && <Loader size={16} className="queue-spin" />}
                {state === 'held' && <AlertTriangle size={16} />}
                {state === 'done' && <Check size={16} />}
                <span>{queue?.message || (armed ? 'Armed.' : 'The queue is off. Arm it to run the list.')}</span>
            </div>

            {error && (
                <div className="queue-error" role="alert">
                    <AlertTriangle size={15} /> <span>{error}</span>
                    <button onClick={() => setError(null)} aria-label="Dismiss"><X size={14} /></button>
                </div>
            )}

            {/* ── Arm / mode ─────────────────────────────────────────── */}
            <section className="queue-controls">
                <button
                    className={`queue-arm ${armed ? 'on' : ''}`}
                    disabled={!canEdit || entries.length === 0}
                    onClick={() => void act(() => queueApi.arm(!armed))}
                >
                    {armed ? 'Queue is ON' : 'Arm the queue'}
                </button>

                <div className="queue-mode">
                    <button
                        className={`queue-mode-btn ${queue?.mode !== 'auto' ? 'on' : ''}`}
                        disabled={!canEdit || running}
                        onClick={() => void act(() => queueApi.setMode('gate'))}
                    >
                        Tap to start each design
                    </button>
                    <button
                        className={`queue-mode-btn ${queue?.mode === 'auto' ? 'on' : ''}`}
                        disabled={!canEdit || running}
                        onClick={() => (queue?.mode === 'auto' ? undefined : setAskAuto(true))}
                    >
                        Start the next one by itself
                    </button>
                </div>

                {queue?.mode === 'auto' && (
                    <div className="queue-auto-note">
                        <AlertTriangle size={15} />
                        <span>
                            The next design starts {queue.autoDelaySec} seconds after the last one ends.
                            This machine does not switch the router: leave it running, and only queue
                            designs that cut the same workpiece with the same tool.
                        </span>
                    </div>
                )}
            </section>

            {/* ── The list ───────────────────────────────────────────── */}
            <ol className="queue-list">
                {entries.map((e, i) => (
                    <li key={e.id} className={`queue-item status-${e.status} ${e.id === queue?.activeId ? 'is-running' : ''} ${e.id === queue?.gateId ? 'is-next' : ''}`}>
                        <span className="queue-num">{i + 1}</span>
                        <div className="queue-item-main">
                            <span className="queue-item-name">{e.name}</span>
                            <span className="queue-item-sub">
                                {STATUS_TEXT[e.status]}
                                {e.error ? ` — ${e.error}` : ''}
                                {e.size ? ` · ${(e.size / 1024 / 1024).toFixed(1)} MB` : ''}
                            </span>
                        </div>
                        <div className="queue-item-actions">
                            <button disabled={!canEdit || i === 0} onClick={() => void act(() => queueApi.move(e.id, -1))} aria-label="Move up"><ChevronUp size={18} /></button>
                            <button disabled={!canEdit || i === entries.length - 1} onClick={() => void act(() => queueApi.move(e.id, 1))} aria-label="Move down"><ChevronDown size={18} /></button>
                            <button disabled={!canEdit || e.id === queue?.activeId} onClick={() => void act(() => queueApi.remove(e.id))} aria-label="Remove"><Trash2 size={18} /></button>
                        </div>
                    </li>
                ))}
                {entries.length === 0 && (
                    <li className="queue-empty">Nothing queued. Add designs from the library below.</li>
                )}
            </ol>

            {/* ── Add / housekeeping ─────────────────────────────────── */}
            <section className="queue-actions">
                <button className="queue-add" onClick={() => setPicking((p) => !p)} disabled={!canEdit}>
                    <Plus size={18} /> Add a design
                </button>
                <button onClick={() => void act(() => queueApi.skip())} disabled={!canEdit || (state !== 'gate' && state !== 'countdown' && state !== 'held')}>
                    <SkipForward size={16} /> Skip
                </button>
                <button onClick={() => void act(() => queueApi.reset())} disabled={!canEdit || running}>
                    <RotateCcw size={16} /> Run the list again
                </button>
                <button className="queue-danger" onClick={() => void act(() => queueApi.clear())} disabled={!canEdit || running}>
                    <Trash2 size={16} /> Empty
                </button>
            </section>

            {picking && (
                <div className="queue-picker">
                    {library.length === 0 && <p className="queue-picker-empty">The library is empty. Save a design there first.</p>}
                    {library.map((item) => {
                        const unreviewed = isRemoteUpload(item) && !item.provenance?.reviewed;
                        return (
                            <button
                                key={item.id}
                                className="queue-picker-row"
                                disabled={!canEdit || unreviewed}
                                title={unreviewed ? 'Review this remote upload in the Library first' : ''}
                                onClick={async () => {
                                    if (await act(() => queueApi.add(item.id))) setPicking(false);
                                }}
                            >
                                <Plus size={16} />
                                <span className="queue-picker-name">{item.name}</span>
                                {unreviewed && <span className="queue-picker-flag">needs review</span>}
                            </button>
                        );
                    })}
                </div>
            )}

            {askAuto && (
                <div className="queue-ask" role="dialog" aria-modal="true" aria-label="Start the next design by itself">
                    <div className="queue-ask-box">
                        <h3><AlertTriangle size={18} /> Before you turn this on</h3>
                        <p>
                            This machine has no spindle output: it cannot switch the router on or off.
                            If the next design starts on its own, it starts with the router exactly as
                            you left it.
                        </p>
                        <ul>
                            <li>Router still running — the design cuts normally. This is what auto start is for:
                                a roughing pass and then a finishing pass on the same workpiece.</li>
                            <li>Router switched off — the design runs with a stopped tool and ruins the piece,
                                and probably the bit.</li>
                            <li>Nobody at the machine — a spinning cutter runs unattended until the design ends.</li>
                        </ul>
                        <p className="queue-ask-small">
                            Each start still counts down {queue?.autoDelaySec ?? 10} seconds, and anyone standing
                            there can stop it.
                        </p>
                        <div className="queue-ask-buttons">
                            <button onClick={() => setAskAuto(false)}>Keep tapping Start</button>
                            <button
                                className="queue-ask-go"
                                onClick={async () => {
                                    const ok = await act(() => queueApi.setMode('auto', true));
                                    if (ok) setAskAuto(false);
                                }}
                            >
                                I understand — start them by itself
                            </button>
                        </div>
                    </div>
                </div>
            )}

            <p className="queue-footnote">
                <Play size={13} /> Every queued design runs from its first line. A design that was stopped
                part way through is never continued by the queue — start that one yourself.
            </p>
        </div>
    );
}
