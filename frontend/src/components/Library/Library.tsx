/**
 * Library — top-level page. Three cards:
 *   • Custom Library — designs the user has saved. Backed by the LibraryService
 *     on the backend (files on disk in backend/data/library/); designs survive
 *     a browser change / cache clear.
 *   • FILEFINITY — real import via PKCE auth + our /api/external/import gate
 *     (see backend/services/filefinity/FilefinityService.js). Falls back to
 *     the community forum link since Filefinity's real browse/redirect URLs
 *     are still unconfirmed -- see parseFilefinityImportParams() below.
 *   • Documentation — placeholder for the docs site (Tawfiq msg 7396).
 */
import { useEffect, useRef, useState } from 'react';
import { FolderOpen, Globe, Plus, Trash2, Download, FileText, BookOpen } from 'lucide-react';
import { useCNCStore } from '../../stores/cncStore';
import { GCodeParser } from '../../utils/gcodeParser';
import './Library.css';

interface LibraryItem {
    id: string;
    name: string;
    fileName: string;
    size: number;
    lineCount?: number;
    savedAt: string;     // ISO
}

const FILEFINITY_URL = 'https://forum.onefinitycnc.com/c/projects-files-and-tools/files-and-templates/9';
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

type View = 'home' | 'custom';

// Filefinity's real model-browse/redirect shape is unconfirmed (no signoff
// from their eng team -- see FILEFINITY_API_SPECIFICATION_FIXED.md). This is
// our best-guess landing contract: after auth, whatever picks the model
// (their site or a future in-app browser) sends the user back here with
// these params. Everything downstream of parsing them IS real and tested:
// mint a local import token, call our own gated /api/external/import.
type FilefinityImportParams = {
    modelId: string;
    fileName: string;
    downloadUrl: string;
    modelTitle: string | null;
};

function parseFilefinityImportParams(search: string): FilefinityImportParams | null {
    const p = new URLSearchParams(search);
    if (p.get('filefinity_import') !== '1') return null;
    const modelId = p.get('modelId');
    const fileName = p.get('fileName');
    const downloadUrl = p.get('downloadUrl');
    if (!modelId || !fileName || !downloadUrl) return null;
    return { modelId, fileName, downloadUrl, modelTitle: p.get('modelTitle') };
}

export default function Library() {
    const [view, setView] = useState<View>('home');
    const [items, setItems] = useState<LibraryItem[]>([]);
    const [filefinityStatus, setFilefinityStatus] = useState<
        { kind: 'idle' } | { kind: 'importing' } | { kind: 'done'; name: string } | { kind: 'error'; message: string }
    >({ kind: 'idle' });
    const fileInputRef = useRef<HTMLInputElement>(null);
    const setRawGcodeContent = useCNCStore((s) => s.setRawGcodeContent);
    const setFileInfo = useCNCStore((s) => s.setFileInfo);
    const setGcode = useCNCStore((s) => s.setGcode);
    const setToolpathSegments = useCNCStore((s) => s.setToolpathSegments);
    const addConsoleLog = useCNCStore((s) => s.addConsoleLog);

    useEffect(() => { reload(); }, []);

    useEffect(() => {
        const params = parseFilefinityImportParams(window.location.search);
        if (!params) return;
        // Strip the params immediately so a refresh doesn't re-trigger the import.
        window.history.replaceState({}, '', window.location.pathname);
        importFromFilefinity(params);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    async function importFromFilefinity(params: FilefinityImportParams) {
        setView('custom');
        setFilefinityStatus({ kind: 'importing' });
        try {
            const tokenRes = await fetch(`${BACKEND_BASE}/api/filefinity/import-token`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ modelId: params.modelId }),
            });
            if (!tokenRes.ok) throw new Error(`Could not mint import token (HTTP ${tokenRes.status})`);
            const { token } = await tokenRes.json() as { token: string };

            const importRes = await fetch(`${BACKEND_BASE}/api/external/import`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Import-Token': token },
                body: JSON.stringify({
                    source: 'filefinity',
                    modelId: params.modelId,
                    modelTitle: params.modelTitle,
                    fileName: params.fileName,
                    downloadUrl: params.downloadUrl,
                }),
            });
            const data = await importRes.json();
            if (!importRes.ok) throw new Error(data?.error || `Import failed (HTTP ${importRes.status})`);

            setFilefinityStatus({ kind: 'done', name: data.meta.name });
            addConsoleLog('success', `Imported "${data.meta.name}" from Filefinity`);
            reload();
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            setFilefinityStatus({ kind: 'error', message });
            addConsoleLog('error', `Filefinity import failed: ${message}`);
        }
    }

    async function connectFilefinity() {
        try {
            const r = await fetch(`${BACKEND_BASE}/api/filefinity/auth/start`);
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const { authorizeUrl } = await r.json() as { authorizeUrl: string };
            window.location.href = authorizeUrl;
        } catch (err) {
            // Expected until Filefinity confirms their real authorize URL —
            // see FilefinityService.js header. Fall back to the forum link.
            addConsoleLog('warning', 'Filefinity connect unavailable — opening community forum instead.');
            window.open(FILEFINITY_URL, '_blank', 'noopener,noreferrer');
        }
    }

    async function reload() {
        try {
            const r = await fetch(`${BACKEND_BASE}/api/library`);
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
                headers: { 'Content-Type': 'application/json' },
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
        try {
            const r = await fetch(`${BACKEND_BASE}/api/library/${item.id}/body`);
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const body = await r.text();

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
        try { await fetch(`${BACKEND_BASE}/api/library/${id}`, { method: 'DELETE' }); }
        catch (_) {}
        setItems((prev) => prev.filter((i) => i.id !== id));
    }

    if (view === 'custom') {
        return (
            <div className="lib-root">
                <header className="lib-header">
                    <button className="lib-back" onClick={() => setView('home')}>← Library</button>
                    <h2>Custom Library</h2>
                    <div className="lib-spacer" />
                    <button className="lib-btn lib-btn-primary" onClick={() => fileInputRef.current?.click()}>
                        <Plus size={14} /> Add file
                    </button>
                    <input type="file" accept=".gcode,.nc,.tap,.cnc" ref={fileInputRef}
                        style={{ display: 'none' }} onChange={onUpload} />
                </header>

                {filefinityStatus.kind === 'importing' && (
                    <div className="lib-empty" style={{ padding: '8px 0' }}>Importing from Filefinity…</div>
                )}
                {filefinityStatus.kind === 'done' && (
                    <div className="lib-empty" style={{ padding: '8px 0' }}>Imported "{filefinityStatus.name}" from Filefinity.</div>
                )}
                {filefinityStatus.kind === 'error' && (
                    <div className="lib-empty" style={{ padding: '8px 0', color: '#c0392b' }}>
                        Filefinity import failed: {filefinityStatus.message}
                    </div>
                )}

                {items.length === 0 ? (
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
                            {items.map((item) => (
                                <tr key={item.id}>
                                    <td><FileText size={14} /></td>
                                    <td><b>{item.name}</b></td>
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

                <button className="lib-card" onClick={connectFilefinity}>
                    <div className="lib-card-icon"><Globe size={28} /></div>
                    <div className="lib-card-name">FILEFINITY</div>
                    <div className="lib-card-desc">
                        Connect your Filefinity account to import models directly into
                        your library. Falls back to the community forum if Filefinity
                        connect isn't available yet.
                    </div>
                    <div className="lib-card-meta">Connect →</div>
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
