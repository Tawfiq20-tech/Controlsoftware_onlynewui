/**
 * Library — top-level page. Three cards:
 *   • Custom Library — designs the user has saved. Backed by the LibraryService
 *     on the backend (files on disk in backend/data/library/); designs survive
 *     a browser change / cache clear.
 *   • FILEFINITY — Onefinity community files (forum) in a new tab.
 *   • Documentation — placeholder for the docs site (Tawfiq msg 7396).
 */
import { useEffect, useRef, useState } from 'react';
import { FolderOpen, Globe, Plus, Trash2, Download, FileText, BookOpen } from 'lucide-react';
import { useCNCStore } from '../../stores/cncStore';
import { GCodeParser } from '../../utils/gcodeParser';
import { remoteAuthHeaders } from '../../utils/remoteAuth';
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

export default function Library() {
    const [view, setView] = useState<View>('home');
    const [items, setItems] = useState<LibraryItem[]>([]);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const setRawGcodeContent = useCNCStore((s) => s.setRawGcodeContent);
    const setFileInfo = useCNCStore((s) => s.setFileInfo);
    const setGcode = useCNCStore((s) => s.setGcode);
    const setToolpathSegments = useCNCStore((s) => s.setToolpathSegments);
    const addConsoleLog = useCNCStore((s) => s.addConsoleLog);

    useEffect(() => { reload(); }, []);

    async function reload() {
        try {
            const r = await fetch(`${BACKEND_BASE}/api/library`, { headers: remoteAuthHeaders() });
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
        try {
            const r = await fetch(`${BACKEND_BASE}/api/library/${item.id}/body`, { headers: remoteAuthHeaders() });
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
        try { await fetch(`${BACKEND_BASE}/api/library/${id}`, { method: 'DELETE', headers: remoteAuthHeaders() }); }
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
                    <input type="file" accept=".gcode,.nc,.tap,.cnc,.ngc" ref={fileInputRef}
                        style={{ display: 'none' }} onChange={onUpload} />
                </header>

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

                <a className="lib-card"
                    href={FILEFINITY_URL}
                    target="_blank"
                    rel="noopener noreferrer">
                    <div className="lib-card-icon"><Globe size={28} /></div>
                    <div className="lib-card-name">FILEFINITY</div>
                    <div className="lib-card-desc">
                        Onefinity community files + templates. Opens in a new tab —
                        download a file from the forum, then add it to your Custom
                        Library to load it here.
                    </div>
                    <div className="lib-card-meta">Onefinity community ↗</div>
                </a>

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
