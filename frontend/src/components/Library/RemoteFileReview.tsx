/**
 * RemoteFileReview — mandatory operator review before a file uploaded through
 * the cloud relay is loaded for the first time (docs/cloud-relay/SPEC.md §5.7,
 * §8.1).
 *
 * A remote upload can come from anyone the relay lets stage files, including a
 * compromised relay, so the operator sees where it came from and the extents
 * that matter physically (how deep Z goes, the fastest feed, the XY envelope)
 * before it reaches the sender. Loading marks the entry reviewed on the
 * backend first; until then remote users get REVIEW_REQUIRED for it.
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Cloud } from 'lucide-react';
import { parseGcodeAsync } from '../../utils/gcodeParser';
import type { LibraryEntry } from '../Settings/api';
import '../Settings/Settings.css';

interface Extents {
    zMin: number;
    zMax: number;
    feedMax: number;
    xMin: number;
    xMax: number;
    yMin: number;
    yMax: number;
    lines: number;
    units: 'mm' | 'in';
}

interface Props {
    entry: LibraryEntry;
    body: string;
    busy?: boolean;
    error?: string | null;
    onCancel: () => void;
    onLoad: () => void;
}

const fmt = (n: number) => (Number.isFinite(n) ? n.toFixed(3) : '—');

function fmtSize(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export default function RemoteFileReview({ entry, body, busy = false, error = null, onCancel, onLoad }: Props) {
    const [extents, setExtents] = useState<Extents | null>(null);
    const [parseError, setParseError] = useState<string | null>(null);
    const [checked, setChecked] = useState(false);

    useEffect(() => {
        let cancelled = false;
        setExtents(null);
        setParseError(null);
        parseGcodeAsync(body)
            .then((res) => {
                if (cancelled) return;
                const b = res.bounds;
                setExtents({
                    zMin: b.minZ, zMax: b.maxZ,
                    xMin: b.minX, xMax: b.maxX,
                    yMin: b.minY, yMax: b.maxY,
                    feedMax: res.parsedToolpath?.feedRange?.[1] ?? NaN,
                    lines: res.totalLines,
                    units: res.parsedToolpath?.units ?? 'mm',
                });
            })
            .catch((err) => {
                if (!cancelled) setParseError(err instanceof Error ? err.message : String(err));
            });
        return () => { cancelled = true; };
    }, [body]);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onCancel(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [busy, onCancel]);

    const p = entry.provenance;

    return createPortal(
        <div className="ca-confirm-backdrop settings-tokens">
            <div className="ca-confirm rfr-dialog" role="alertdialog" aria-modal="true" aria-labelledby="rfr-title">
                <div id="rfr-title" className="ca-confirm-title">
                    <Cloud size={18} style={{ verticalAlign: '-3px', marginRight: 8 }} />
                    Review remote upload
                </div>
                <div className="ca-confirm-note">
                    This file was uploaded from a phone through the cloud relay. Check that it is what you expect before
                    loading it. It will not start on its own.
                </div>

                <div className="ca-kv">
                    <span className="ca-k">File</span>
                    <span className="ca-v mono">{entry.fileName}</span>
                    <span className="ca-k">Uploaded by</span>
                    <span className="ca-v">{p?.uploadedBy || 'unknown'}</span>
                    <span className="ca-k">Received</span>
                    <span className="ca-v">{p?.receivedAt ? new Date(p.receivedAt).toLocaleString() : '—'}</span>
                    <span className="ca-k">Size</span>
                    <span className="ca-v">{fmtSize(entry.size)}</span>
                    <span className="ca-k">SHA-256</span>
                    <span className="ca-v mono">{p?.sha256 ? `${p.sha256.slice(0, 16)}…` : '—'}</span>
                </div>

                {!extents && !parseError && <div className="wa-empty">Reading the program…</div>}
                {parseError && (
                    <div className="ra-alert error">
                        <AlertTriangle size={15} />
                        <div className="ra-alert-body">Could not read the program: {parseError}</div>
                    </div>
                )}
                {extents && (
                    <div className="ca-kv">
                        <span className="ca-k">Z min / max</span>
                        <span className="ca-v mono">{fmt(extents.zMin)} / {fmt(extents.zMax)} mm</span>
                        <span className="ca-k">Max feed</span>
                        <span className="ca-v mono">{Number.isFinite(extents.feedMax) ? `${Math.round(extents.feedMax)} mm/min` : '—'}</span>
                        <span className="ca-k">X extent</span>
                        <span className="ca-v mono">{fmt(extents.xMin)} … {fmt(extents.xMax)} mm</span>
                        <span className="ca-k">Y extent</span>
                        <span className="ca-v mono">{fmt(extents.yMin)} … {fmt(extents.yMax)} mm</span>
                        <span className="ca-k">Lines</span>
                        <span className="ca-v">{extents.lines}{extents.units === 'in' ? ' (inch program)' : ''}</span>
                    </div>
                )}

                <label className="rfr-check">
                    <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} disabled={busy} />
                    I have checked this program
                </label>

                {error && <div className="settings-error">{error}</div>}

                <div className="ca-confirm-actions">
                    <button className="settings-btn ca-big-btn" onClick={onCancel} disabled={busy}>Cancel</button>
                    <button className="settings-btn primary ca-big-btn" onClick={onLoad} disabled={busy || !checked}>
                        Load
                    </button>
                </div>
            </div>
        </div>,
        document.body,
    );
}
