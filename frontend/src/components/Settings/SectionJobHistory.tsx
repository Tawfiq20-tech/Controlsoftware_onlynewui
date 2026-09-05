import { useEffect, useState } from 'react';
import { Trash2, RefreshCw } from 'lucide-react';
import { jobhistory, type JobRecord } from './api';

function fmtDur(ms: number) {
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60), rs = s - m * 60;
    if (m < 60) return `${m}m ${rs}s`;
    const h = Math.floor(m / 60), rm = m - h * 60;
    return `${h}h ${rm}m`;
}

export default function SectionJobHistory() {
    const [records, setRecords] = useState<JobRecord[]>([]);
    const [stats, setStats] = useState<{ total: number; ok: number; fail: number; aborted: number; totalMs: number } | null>(null);

    const refresh = async () => {
        try {
            setRecords(await jobhistory.list(100));
            setStats(await jobhistory.stats());
        } catch (_) { /* empty */ }
    };
    useEffect(() => { refresh(); }, []);

    return (
        <div className="settings-section">
            <div className="settings-section-header">
                <div>
                    <h3>Job history</h3>
                    <p className="settings-section-sub">
                        Every completed run. Useful for debugging failures and tracking
                        machine usage.
                    </p>
                </div>
                <div className="settings-section-actions">
                    <button className="settings-btn" onClick={refresh}><RefreshCw size={14} /></button>
                    <button className="settings-btn danger" onClick={async () => {
                        if (confirm('Clear all job history?')) { await jobhistory.clear(); refresh(); }
                    }}>Clear all</button>
                </div>
            </div>

            {stats && (
                <div className="settings-stats">
                    <div><b>{stats.total}</b><span>total</span></div>
                    <div className="ok"><b>{stats.ok}</b><span>ok</span></div>
                    <div className="fail"><b>{stats.fail}</b><span>fail</span></div>
                    <div><b>{stats.aborted}</b><span>aborted</span></div>
                    <div><b>{fmtDur(stats.totalMs)}</b><span>total runtime</span></div>
                </div>
            )}

            <div className="settings-jobhistory-list">
                {records.length === 0 && <div className="settings-empty"><p>No jobs yet.</p></div>}
                {records.map(r => (
                    <div className="settings-job-row" key={r.id}>
                        <div className="settings-job-line">
                            <span className={`settings-pill ${r.outcome}`}>{r.outcome}</span>
                            <span className="settings-job-name">{r.filename}</span>
                            <span className="settings-job-meta">
                                {r.controller} · {r.lineCount} lines · {fmtDur(r.durationMs)}
                            </span>
                            <button className="settings-btn danger" onClick={async () => {
                                await jobhistory.deleteOne(r.id); refresh();
                            }}><Trash2 size={12} /></button>
                        </div>
                        <div className="settings-job-sub">
                            {new Date(r.startedAt).toLocaleString()} → {new Date(r.endedAt).toLocaleString()}
                            {r.error && <span className="settings-job-error"> · {r.error}</span>}
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}
