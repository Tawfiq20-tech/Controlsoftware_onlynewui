import { useEffect, useState } from 'react';
import { FolderOpen, RefreshCw } from 'lucide-react';
import { watchdir, type WatchDirCfg } from './api';

const DEFAULT: WatchDirCfg = { enabled: false, path: '', extensions: ['.nc', '.gcode', '.gc', '.cnc', '.tap', '.ngc'] };

export default function SectionWatchDir() {
    const [cfg, setCfg] = useState<WatchDirCfg>(DEFAULT);
    const [files, setFiles] = useState<{ name: string; size: number; mtime: number }[]>([]);
    const [err, setErr] = useState<string | null>(null);

    const refresh = async () => {
        try {
            const c = await watchdir.getConfig();
            setCfg({ ...DEFAULT, ...c });
            setFiles(await watchdir.listFiles());
        } catch (e) { setErr(String(e)); }
    };

    useEffect(() => { refresh(); }, []);

    const save = async () => {
        try { await watchdir.setConfig(cfg); refresh(); }
        catch (e) { setErr(String(e)); }
    };

    return (
        <div className="settings-section">
            <div className="settings-section-header">
                <div>
                    <h3>Watch directory</h3>
                    <p className="settings-section-sub">
                        Auto-detect new G-code files dropped into a folder (USB stick,
                        network share, CAM output dir).
                    </p>
                </div>
                <button className="settings-btn" onClick={refresh}><RefreshCw size={14} /></button>
            </div>

            {err && <div className="settings-error">{err}</div>}

            <label className="settings-toggle">
                <input type="checkbox" checked={cfg.enabled}
                    onChange={e => setCfg({ ...cfg, enabled: e.target.checked })} />
                <span>Enable folder watching</span>
            </label>

            <label>Folder path
                <input value={cfg.path} placeholder="/home/pi/cnc/jobs or C:\\Users\\you\\CAM"
                    onChange={e => setCfg({ ...cfg, path: e.target.value })} />
            </label>

            <label>Extensions (comma separated)
                <input value={cfg.extensions.join(', ')}
                    onChange={e => setCfg({ ...cfg, extensions: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })} />
            </label>

            <div className="settings-form-actions">
                <button className="settings-btn primary" onClick={save}>Save</button>
            </div>

            <h4>Files currently in folder</h4>
            <div className="settings-file-list">
                {files.length === 0 && (
                    <div className="settings-empty">
                        <FolderOpen size={32} />
                        <p>No matching files found. {cfg.enabled ? '' : 'Enable watching first.'}</p>
                    </div>
                )}
                {files.map(f => (
                    <div className="settings-file-row" key={f.name}>
                        <span className="settings-file-name">{f.name}</span>
                        <span className="settings-file-meta">{(f.size / 1024).toFixed(1)} KB · {new Date(f.mtime).toLocaleString()}</span>
                    </div>
                ))}
            </div>
        </div>
    );
}
