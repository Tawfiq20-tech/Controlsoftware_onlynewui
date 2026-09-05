import { useEffect, useState } from 'react';
import { Plus, Trash2, Camera, RefreshCw } from 'lucide-react';
import { webcam, type CameraCfg } from './api';

const BLANK: CameraCfg = {
    name: 'Shop camera',
    type: 'mjpeg-url',
    url: '',
    resolution: '640x480',
    fps: 15,
    quality: 5,
};

export default function SectionWebcam() {
    const [cameras, setCameras] = useState<CameraCfg[]>([]);
    const [editing, setEditing] = useState<CameraCfg | null>(null);
    const [err, setErr] = useState<string | null>(null);

    const refresh = async () => {
        try { setCameras(await webcam.list()); }
        catch (e) { setErr(String(e)); }
    };

    useEffect(() => { refresh(); }, []);

    const onSave = async () => {
        if (!editing) return;
        try {
            await webcam.upsert(editing);
            setEditing(null);
            refresh();
        } catch (e) { setErr(String(e)); }
    };

    return (
        <div className="settings-section">
            <div className="settings-section-header">
                <div>
                    <h3>Cameras</h3>
                    <p className="settings-section-sub">
                        Live MJPEG / RTSP / USB feeds for remote shop-floor monitoring.
                    </p>
                </div>
                <div className="settings-section-actions">
                    <button className="settings-btn" onClick={refresh} title="Refresh">
                        <RefreshCw size={14} />
                    </button>
                    <button className="settings-btn primary" onClick={() => setEditing({ ...BLANK })}>
                        <Plus size={14} /> Add camera
                    </button>
                </div>
            </div>

            {err && <div className="settings-error">{err}</div>}

            <div className="settings-card-grid">
                {cameras.length === 0 && !editing && (
                    <div className="settings-empty">
                        <Camera size={32} />
                        <p>No cameras yet. Add one above.</p>
                    </div>
                )}
                {cameras.map(c => (
                    <div className="settings-card" key={c.id}>
                        <img
                            className="settings-card-thumb"
                            src={webcam.streamUrl(c.id!)}
                            alt={c.name}
                            onError={(e) => { (e.target as HTMLImageElement).style.opacity = '0.2'; }}
                        />
                        <div className="settings-card-body">
                            <div className="settings-card-title">{c.name}</div>
                            <div className="settings-card-meta">
                                {c.type} · {c.online ? <span className="dot ok" /> : <span className="dot off" />}
                                {c.online ? ' live' : (c.lastError || ' offline')}
                            </div>
                            <div className="settings-card-actions">
                                <button className="settings-btn" onClick={() => setEditing({ ...c })}>Edit</button>
                                <button className="settings-btn danger" onClick={async () => {
                                    await webcam.remove(c.id!); refresh();
                                }}><Trash2 size={12} /></button>
                            </div>
                        </div>
                    </div>
                ))}
            </div>

            {editing && (
                <div className="settings-form">
                    <h4>{editing.id ? 'Edit camera' : 'New camera'}</h4>
                    <label>Name<input value={editing.name}
                        onChange={e => setEditing({ ...editing, name: e.target.value })} /></label>
                    <label>Type
                        <select value={editing.type}
                            onChange={e => setEditing({ ...editing, type: e.target.value as CameraCfg['type'] })}>
                            <option value="mjpeg-url">MJPEG URL (HTTP/HTTPS)</option>
                            <option value="rtsp">RTSP (IP camera)</option>
                            <option value="v4l2">USB camera (/dev/video*)</option>
                        </select>
                    </label>
                    {editing.type === 'v4l2' ? (
                        <label>Device<input value={editing.device || '/dev/video0'}
                            onChange={e => setEditing({ ...editing, device: e.target.value })} /></label>
                    ) : (
                        <label>URL<input value={editing.url || ''} placeholder="http://192.168.5.20/mjpg/video.mjpg"
                            onChange={e => setEditing({ ...editing, url: e.target.value })} /></label>
                    )}
                    <label>Resolution<input value={editing.resolution || '640x480'}
                        onChange={e => setEditing({ ...editing, resolution: e.target.value })} /></label>
                    <label>FPS<input type="number" value={editing.fps || 15}
                        onChange={e => setEditing({ ...editing, fps: +e.target.value })} /></label>
                    <div className="settings-form-actions">
                        <button className="settings-btn" onClick={() => setEditing(null)}>Cancel</button>
                        <button className="settings-btn primary" onClick={onSave}>Save</button>
                    </div>
                </div>
            )}
        </div>
    );
}
