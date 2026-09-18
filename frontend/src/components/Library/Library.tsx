/**
 * Library — top-level page. Three cards:
 *   • Custom Library — designs the user has saved. Backed by the LibraryService
 *     on the backend (files on disk in backend/data/library/); designs survive
 *     a browser change / cache clear.
 *   • FILEFINITY — Onefinity community files (forum) in a new tab.
 *   • Documentation — placeholder for the docs site (Tawfiq msg 7396).
 */
import { useEffect, useRef, useState } from 'react';
import { FolderOpen, Globe, Plus, Trash2, Download, FileText, BookOpen, Cloud, QrCode } from 'lucide-react';
import { useCNCStore } from '../../stores/cncStore';
import { GCodeParser } from '../../utils/gcodeParser';
import { remoteAuthHeaders } from '../../utils/remoteAuth';
import { isRemoteUpload, remoteCloud, type LibraryEntry } from '../Settings/api';
import RemoteFileReview from './RemoteFileReview';
import './Library.css';

type LibraryItem = LibraryEntry;

// Operator review must happen before the first load of a cloud upload (§5.7).
const needsReview = (item: LibraryItem) => isRemoteUpload(item) && !item.provenance?.reviewed;

const REVIEW_ERROR_TEXT: Record<string, string> = {
    operator_required: 'Only the machine operator can review remote uploads. Open the kiosk with its operator link.',
    operator_only: 'Remote uploads can only be reviewed on the machine\'s own screen.',
};

const FILEFINITY_URL = 'https://main.filefinity.com/model/6a9fed70af386fe917fce2f0/';
// Documentation site URL — Tawfiq said leave it simple, link gets added later.
const DOCS_URL = '#';

const BACKEND_BASE = (() => {
    const env = (import.meta as unknown as { env?: { VITE_API_URL?: string } }).env?.VITE_API_URL;
    if (env) return String(env).replace(/\/$/, '');
    if (typeof window !== 'undefined') {
        const { protocol, hostname } = window.location;
        return `${protocol}//${hostname}:4000`;
    }
    return 'http://localhost:4000';
})();

type View = 'home' | 'custom' | 'filefinity';

export default function Library() {
    const [view, setView] = useState<View>('home');
    /* Filefinity lives on the internet, and the kiosk's Chromium blocks every
       URL but this app's own. window.open() there put the operator in a blocked
       window with no tab bar, no keyboard and no way back -- a power cycle was
       the only exit. Show the address as a QR to scan instead. */
    const [showFilefinityQr, setShowFilefinityQr] = useState(false);
    const [filefinityQr, setFilefinityQr] = useState<string | null>(null);

    useEffect(() => {
        if (!showFilefinityQr || filefinityQr) return;
        let cancelled = false;
        void (async () => {
            try {
                const r = await fetch(`/api/remote/qr?url=${encodeURIComponent(FILEFINITY_URL)}`, {
                    credentials: 'include',
                    headers: { ...remoteAuthHeaders() },
                });
                if (!r.ok) return;
                const data = await r.json();
                if (!cancelled) setFilefinityQr(data.dataUrl ?? null);
            } catch (_) {
                /* The address is shown as text either way. */
            }
        })();
        return () => { cancelled = true; };
    }, [showFilefinityQr, filefinityQr]);
    const [items, setItems] = useState<LibraryItem[]>([]);
    const [filter, setFilter] = useState<'all' | 'remote'>('all');
    const [review, setReview] = useState<{ item: LibraryItem; body: string } | null>(null);
    const [reviewBusy, setReviewBusy] = useState(false);
    const [reviewError, setReviewError] = useState<string | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const setRawGcodeContent = useCNCStore((s) => s.setRawGcodeContent);
    const setFileInfo = useCNCStore((s) => s.setFileInfo);
    const setGcode = useCNCStore((s) => s.setGcode);
    const setToolpathSegments = useCNCStore((s) => s.setToolpathSegments);
    const setParsedToolpath = useCNCStore((s) => s.setParsedToolpath);
    const addConsoleLog = useCNCStore((s) => s.addConsoleLog);

    useEffect(() => { reload(); }, []);

    async function reload() {
        try {
            const r = await fetch(`${BACKEND_BASE}/api/library`, { credentials: 'include', headers: remoteAuthHeaders() });
            if (r.ok) setItems(await r.json());
        } catch (_) { /* offline — empty list */ }
    }

    async function onUpload(e: React.ChangeEvent<HTMLInputElement>) {
        const file = e.target.files?.[0];
        if (!file) return;
        const text = await file.text();
        try {
            const r = await fetch(`${BACKEND_BASE}/api/library`, {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json', ...remoteAuthHeaders() },
                body: JSON.stringify({
                    name: file.name.replace(/\.[^.]+$/, ''),
                    fileName: file.name,
                    body: text,
                }),
            });
            if (r.ok) {
                const entry = await r.json() as LibraryItem;
                setItems((prev) => [entry, ...prev]);
            }
        } catch (err) {
            console.warn('[Library] upload failed', err);
        }
        if (fileInputRef.current) fileInputRef.current.value = '';
    }

    async function loadIntoSender(item: LibraryItem) {
        // Same guard as the Sidebar: a job that is running or paused keeps its file.
        const st = useCNCStore.getState();
        if (st.jobActive || st.machineState === 'running' || st.machineState === 'paused') {
            addConsoleLog('warning', 'Cannot load file while a carve job is active. Press STOP [■] in the control bar first.');
            return;
        }
        try {
            const r = await fetch(`${BACKEND_BASE}/api/library/${item.id}/body`, { credentials: 'include', headers: remoteAuthHeaders() });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const body = await r.text();
            if (needsReview(item)) {
                setReviewError(null);
                setReview({ item, body });
                return;
            }
            applyBody(item, body);
        } catch (err) {
            addConsoleLog('error', `Library load failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    async function confirmReview() {
        if (!review) return;
        const { item, body } = review;
        setReviewBusy(true);
        setReviewError(null);
        try {
            await remoteCloud.reviewLibraryEntry(item.id);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            setReviewError(REVIEW_ERROR_TEXT[msg] || `Review failed: ${msg}`);
            setReviewBusy(false);
            return;
        }
        const reviewed = { ...item, provenance: item.provenance ? { ...item.provenance, reviewed: true } : item.provenance };
        setItems((prev) => prev.map((i) => (i.id === item.id ? reviewed : i)));
        setReviewBusy(false);
        setReview(null);
        addConsoleLog('info', `Remote upload reviewed: ${item.fileName}`);
        applyBody(reviewed, body);
    }

    function applyBody(item: LibraryItem, body: string) {
        try {
            // Mirror Sidebar's upload pipeline: parse via GCodeParser so the
            // Visualizer3D, sender, and rest of the store actually see the
            // toolpath. Without this the load is a no-op visually. Tawfiq
            // msg 7430 — "cant able to load and work on it".
            const parser = new GCodeParser();
            const result = parser.parseGCode(body);
            if (!result.lines || result.lines.length === 0) {
                addConsoleLog('warning', `Library file ${item.fileName} parsed to 0 lines`);
                return;
            }

            setGcode(result.lines);
            setToolpathSegments(result.segments);
            if (result.parsedToolpath) {
                setParsedToolpath(result.parsedToolpath);
            }
            setRawGcodeContent(body);
            setFileInfo({
                name: item.fileName,
                size: item.size,
                lines: result.lines.length,
            });
            addConsoleLog('success', `Loaded ${result.lines.length} lines from Library: ${item.fileName}`);
        } catch (err) {
            addConsoleLog('error', `Library load failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    async function deleteItem(id: string) {
        try { await fetch(`${BACKEND_BASE}/api/library/${id}`, { method: 'DELETE', credentials: 'include', headers: remoteAuthHeaders() }); }
        catch (_) {}
        setItems((prev) => prev.filter((i) => i.id !== id));
    }

    async function deleteRemoteUploads() {
        const remoteItems = items.filter(isRemoteUpload);
        if (remoteItems.length === 0) return;
        if (!confirm(`Delete all ${remoteItems.length} remote upload${remoteItems.length === 1 ? '' : 's'}? Files you added on this machine are kept.`)) return;
        for (const item of remoteItems) await deleteItem(item.id);
        addConsoleLog('info', `Deleted ${remoteItems.length} remote upload${remoteItems.length === 1 ? '' : 's'} from the Library`);
        setFilter('all');
        reload();
    }

    const remoteCount = items.filter(isRemoteUpload).length;
    const visibleItems = filter === 'remote' ? items.filter(isRemoteUpload) : items;

    if (view === 'custom') {
        return (
            <div className="lib-root">
                <header className="lib-header">
                    <button className="lib-back" onClick={() => setView('home')}>← Library</button>
                    <h2>Custom Library</h2>
                    <div className="lib-spacer" />
                    {remoteCount > 0 && (
                        <>
                            <select
                                className="lib-btn"
                                value={filter}
                                onChange={(e) => setFilter(e.target.value as 'all' | 'remote')}
                                aria-label="Filter library"
                            >
                                <option value="all">All files</option>
                                <option value="remote">Remote uploads ({remoteCount})</option>
                            </select>
                            {filter === 'remote' && (
                                <button className="lib-btn lib-btn-danger" onClick={deleteRemoteUploads} title="Delete every file uploaded through the cloud relay">
                                    <Trash2 size={14} /> Delete remote uploads
                                </button>
                            )}
                        </>
                    )}
                    <button className="lib-btn lib-btn-primary" onClick={() => fileInputRef.current?.click()}>
                        <Plus size={14} /> Add file
                    </button>
                    <input type="file" accept=".gcode,.nc,.tap,.cnc,.ngc" ref={fileInputRef}
                        style={{ display: 'none' }} onChange={onUpload} />
                </header>

                {visibleItems.length === 0 ? (
                    <div className="lib-empty">
                        <FolderOpen size={56} />
                        <h3>No saved designs yet</h3>
                        <p>Click <b>Add file</b> to save a G-code file to your library.</p>
                    </div>
                ) : (
                    <table className="lib-table">
                        <thead>
                            <tr>
                                <th></th>
                                <th>Name</th>
                                <th>File</th>
                                <th>Saved</th>
                                <th>Size</th>
                                <th></th>
                            </tr>
                        </thead>
                        <tbody>
                            {visibleItems.map((item) => (
                                <tr key={item.id}>
                                    <td>{isRemoteUpload(item) ? <Cloud size={14} /> : <FileText size={14} />}</td>
                                    <td>
                                        <b>{item.name}</b>
                                        {isRemoteUpload(item) && (
                                            <>
                                                <span className={`rfr-badge${item.provenance?.reviewed ? ' reviewed' : ''}`}>
                                                    Remote upload by {item.provenance?.uploadedBy || 'unknown'}
                                                </span>
                                                <span className="rfr-sub">
                                                    Received {item.provenance?.receivedAt ? new Date(item.provenance.receivedAt).toLocaleString() : '—'}
                                                    {item.provenance?.reviewed ? ' · reviewed' : ' · review before loading'}
                                                </span>
                                            </>
                                        )}
                                    </td>
                                    <td><code>{item.fileName}</code></td>
                                    <td>{new Date(item.savedAt).toLocaleString()}</td>
                                    <td>{fmtSize(item.size)}</td>
                                    <td className="lib-row-actions">
                                        <button className="lib-btn" onClick={() => loadIntoSender(item)}
                                            title="Load into the sender">
                                            <Download size={14} /> Load
                                        </button>
                                        <button className="lib-btn lib-btn-danger" onClick={() => deleteItem(item.id)}
                                            title="Delete from library">
                                            <Trash2 size={14} />
                                        </button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}

                {review && (
                    <RemoteFileReview
                        entry={review.item}
                        body={review.body}
                        busy={reviewBusy}
                        error={reviewError}
                        onCancel={() => { if (!reviewBusy) setReview(null); }}
                        onLoad={confirmReview}
                    />
                )}
            </div>
        );
    }

    if (view === 'filefinity') {
        return (
            <div className="lib-root">
                <header className="lib-header">
                    <button className="lib-back" onClick={() => setView('home')}>← Library</button>
                    <h2>FILEFINITY</h2>
                    <div className="lib-spacer" />
                    <button
                        className="lib-btn lib-btn-primary"
                        onClick={() => setShowFilefinityQr((v) => !v)}
                    >
                        <QrCode size={14} /> {showFilefinityQr ? 'Hide code' : 'Open on my phone'}
                    </button>
                </header>

                <div className="lib-empty">
                    <Globe size={56} style={{ color: 'var(--accent, #f59e0b)', opacity: 0.9 }} />
                    <h3>Onefinity Community & Filefinity</h3>
                    <p style={{ maxWidth: 520, lineHeight: 1.6, margin: '8px 0 20px', color: 'var(--text-dim, #94a3b8)' }}>
                        Access community-shared G-code projects, CNC templates, and design files.
                        Download files from Filefinity, then save them to your Custom Library to load and carve directly on your machine.
                    </p>
                    {showFilefinityQr && (
                        <div className="lib-qr">
                            {filefinityQr
                                ? <img src={filefinityQr} alt="Filefinity address as a QR code" width={180} height={180} />
                                : <div className="lib-qr-wait">Generating code…</div>}
                            <div className="lib-qr-url">{FILEFINITY_URL}</div>
                            <div className="lib-qr-hint">
                                Scan with your phone to browse Filefinity there, then copy the file
                                onto a USB stick or send it over remote access.
                            </div>
                        </div>
                    )}
                    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', justifyContent: 'center' }}>
                        <button
                            className="lib-btn lib-btn-primary"
                            style={{ padding: '9px 18px', fontSize: 13 }}
                            onClick={() => setShowFilefinityQr((v) => !v)}
                        >
                            <QrCode size={15} /> {showFilefinityQr ? 'Hide code' : 'Open on my phone'}
                        </button>
                        <button
                            className="lib-btn"
                            style={{ padding: '9px 18px', fontSize: 13 }}
                            onClick={() => setView('custom')}
                        >
                            <FolderOpen size={15} /> Go to Custom Library
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="lib-root">
            <header className="lib-header">
                <h2>Library</h2>
                <span className="lib-sub">Save your own designs or browse community files.</span>
            </header>

            <div className="lib-card-grid">
                <button className="lib-card" onClick={() => setView('custom')}>
                    <div className="lib-card-icon"><FolderOpen size={28} /></div>
                    <div className="lib-card-name">Custom Library</div>
                    <div className="lib-card-desc">
                        Your private collection. Save any G-code file here and load it
                        back into the sender whenever you need it.
                    </div>
                    <div className="lib-card-meta">{items.length} saved</div>
                </button>

                <button className="lib-card" onClick={() => setView('filefinity')}>
                    <div className="lib-card-icon"><Globe size={28} /></div>
                    <div className="lib-card-name">FILEFINITY</div>
                    <div className="lib-card-desc">
                        Onefinity community files + templates. Browse forum projects,
                        download community files, and import them into your Custom Library to load here.
                    </div>
                    <div className="lib-card-meta">Onefinity community ↗</div>
                </button>

                {/* Documentation card — Tawfiq msg 7396: leave URL simple, wired in later. */}
                <a className="lib-card"
                    href={DOCS_URL}
                    onClick={(e) => { if (DOCS_URL === '#') e.preventDefault(); }}>
                    <div className="lib-card-icon"><BookOpen size={28} /></div>
                    <div className="lib-card-name">Documentation</div>
                    <div className="lib-card-desc">
                        How-tos, setup guides, troubleshooting. The docs site will
                        live here — link will be wired in once it's online.
                    </div>
                    <div className="lib-card-meta">Coming soon</div>
                </a>
            </div>
        </div>
    );
}

function fmtSize(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
