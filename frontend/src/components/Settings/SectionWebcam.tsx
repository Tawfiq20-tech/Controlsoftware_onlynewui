import { useEffect, useState, useCallback } from 'react';
import { Plus, Trash2, Camera, RefreshCw, Sparkles, Check, AlertCircle } from 'lucide-react';
import { webcam, type CameraCfg, type CameraDevice } from './api';

const BLANK: CameraCfg = {
    name: 'USB WebCam',
    type: 'usb',
    device: '',
    url: '',
    resolution: '1280x720',
    fps: 30,
    quality: 5,
};

export default function SectionWebcam() {
    const [cameras, setCameras] = useState<CameraCfg[]>([]);
    const [detectedDevices, setDetectedDevices] = useState<CameraDevice[]>([]);
    const [editing, setEditing] = useState<CameraCfg | null>(null);
    const [err, setErr] = useState<string | null>(null);
    const [detecting, setDetecting] = useState(false);
    const [notice, setNotice] = useState<string | null>(null);

    const refresh = useCallback(async () => {
        try {
            setErr(null);
            const list = await webcam.list();
            setCameras(list);
        } catch (e) {
            setErr(String(e));
        }
    }, []);

    const scanHardware = useCallback(async () => {
        try {
            const res = await webcam.detectDevices();
            if (res && Array.isArray(res.devices)) {
                setDetectedDevices(res.devices);
            }
        } catch (_) {}
    }, []);

    const handleAutoDetect = async () => {
        setDetecting(true);
        setErr(null);
        setNotice(null);
        try {
            const res = await webcam.autoDetect();
            await scanHardware();
            await refresh();
            if (res.ok && res.camera) {
                setNotice(res.created 
                    ? `Auto-detected and connected: ${res.camera.name}` 
                    : `${res.camera.name} is connected and ready.`);
            } else if (res.error) {
                setErr(res.error);
            } else {
                setNotice('Scan complete. No new cameras found.');
            }
        } catch (e) {
            setErr(String(e));
        } finally {
            setDetecting(false);
        }
    };

    useEffect(() => {
        refresh();
        scanHardware();
    }, [refresh, scanHardware]);

    const onSave = async () => {
        if (!editing) return;
        try {
            await webcam.upsert(editing);
            setEditing(null);
            refresh();
            scanHardware();
        } catch (e) { setErr(String(e)); }
    };

    // Find any detected hardware camera not yet configured
    const unconfigured = detectedDevices.find(d => !cameras.some(c => c.device === d.name || c.name === d.name));

    return (
        <div className="settings-section">
            <div className="settings-section-header">
                <div>
                    <h3>Cameras</h3>
                    <p className="settings-section-sub">
                        Live USB Webcams, MJPEG, and RTSP feeds for shop-floor & spindle monitoring.
                    </p>
                </div>
                <div className="settings-section-actions">
                    <button 
                        className="settings-btn" 
                        onClick={handleAutoDetect} 
                        disabled={detecting}
                        title="Scan and auto-connect plugged-in cameras"
                    >
                        <Sparkles size={14} color="#38bdf8" /> {detecting ? 'Scanning...' : 'Auto-Detect Camera'}
                    </button>
                    <button className="settings-btn" onClick={refresh} title="Refresh">
                        <RefreshCw size={14} />
                    </button>
                    <button className="settings-btn primary" onClick={() => {
                        const defaultDev = detectedDevices[0]?.name || '';
                        setEditing({ 
                            ...BLANK, 
                            name: defaultDev || 'USB WebCam',
                            device: defaultDev 
                        });
                    }}>
                        <Plus size={14} /> Add camera
                    </button>
                </div>
            </div>

            {notice && (
                <div style={{
                    padding: '10px 14px',
                    marginBottom: 16,
                    background: 'rgba(56, 189, 248, 0.12)',
                    border: '1px solid rgba(56, 189, 248, 0.4)',
                    borderRadius: 6,
                    color: '#7dd3fc',
                    fontSize: 13,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                }}>
                    <Check size={16} />
                    <span>{notice}</span>
                </div>
            )}

            {unconfigured && cameras.length === 0 && !notice && (
                <div style={{
                    padding: '12px 16px',
                    marginBottom: 16,
                    background: 'rgba(74, 222, 128, 0.1)',
                    border: '1px solid rgba(74, 222, 128, 0.35)',
                    borderRadius: 6,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    flexWrap: 'wrap',
                    gap: 12,
                }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <Sparkles size={18} color="#4ade80" />
                        <div>
                            <div style={{ fontWeight: 600, color: '#4ade80' }}>
                                Found connected camera: {unconfigured.name}
                            </div>
                            <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.6)' }}>
                                Ready to connect with zero configuration.
                            </div>
                        </div>
                    </div>
                    <button 
                        className="settings-btn primary" 
                        onClick={handleAutoDetect}
                        disabled={detecting}
                    >
                        {detecting ? 'Connecting...' : 'Connect Now'}
                    </button>
                </div>
            )}

            {err && (
                <div className="settings-error" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <AlertCircle size={15} />
                    <span>{err}</span>
                </div>
            )}

            <div className="settings-card-grid">
                {cameras.length === 0 && !editing && (
                    <div className="settings-empty">
                        <Camera size={32} />
                        <p>No cameras configured yet.</p>
                        <button 
                            className="settings-btn primary" 
                            style={{ marginTop: 12 }} 
                            onClick={handleAutoDetect}
                            disabled={detecting}
                        >
                            <Sparkles size={14} /> Auto-Detect Connected Camera
                        </button>
                    </div>
                )}
                {cameras.map(c => (
                    <div className="settings-card" key={c.id}>
                        <img
                            className="settings-card-thumb"
                            src={webcam.streamUrl(c.id!)}
                            alt={c.name}
                            onError={(e) => { (e.target as HTMLImageElement).style.opacity = '0.4'; }}
                        />
                        <div className="settings-card-body">
                            <div className="settings-card-title">{c.name}</div>
                            <div className="settings-card-meta">
                                {c.type.toUpperCase()} {c.device ? `· ${c.device}` : ''} · {c.online ? <span className="dot ok" /> : <span className="dot off" />}
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
                    <label>Name
                        <input 
                            value={editing.name}
                            onChange={e => setEditing({ ...editing, name: e.target.value })} 
                        />
                    </label>
                    <label>Type
                        <select 
                            value={editing.type}
                            onChange={e => {
                                const newType = e.target.value as CameraCfg['type'];
                                const defaultDev = detectedDevices[0]?.name || '';
                                setEditing({ 
                                    ...editing, 
                                    type: newType,
                                    device: newType === 'usb' ? defaultDev : editing.device
                                });
                            }}
                        >
                            <option value="usb">USB Camera (Plug & Play)</option>
                            <option value="mjpeg-url">MJPEG URL (HTTP/HTTPS IP Camera)</option>
                            <option value="rtsp">RTSP (IP Camera)</option>
                            <option value="v4l2">Linux Video Device (/dev/video*)</option>
                        </select>
                    </label>
                    {editing.type === 'usb' ? (
                        <label>Detected Camera Device
                            {detectedDevices.length > 0 ? (
                                <select
                                    value={editing.device || detectedDevices[0]?.name || ''}
                                    onChange={e => setEditing({ 
                                        ...editing, 
                                        device: e.target.value,
                                        name: editing.name === BLANK.name ? e.target.value : editing.name 
                                    })}
                                >
                                    {detectedDevices.map(d => (
                                        <option key={d.id} value={d.name}>{d.name}</option>
                                    ))}
                                </select>
                            ) : (
                                <input 
                                    value={editing.device || ''} 
                                    placeholder="Camera device name (e.g. Logi C310 HD WebCam)"
                                    onChange={e => setEditing({ ...editing, device: e.target.value })} 
                                />
                            )}
                        </label>
                    ) : editing.type === 'v4l2' ? (
                        <label>Device Node
                            <input 
                                value={editing.device || '/dev/video0'}
                                onChange={e => setEditing({ ...editing, device: e.target.value })} 
                            />
                        </label>
                    ) : (
                        <label>Stream URL
                            <input 
                                value={editing.url || ''} 
                                placeholder="http://192.168.1.50:8080/video"
                                onChange={e => setEditing({ ...editing, url: e.target.value })} 
                            />
                        </label>
                    )}
                    <label>Resolution
                        <input 
                            value={editing.resolution || '1280x720'}
                            onChange={e => setEditing({ ...editing, resolution: e.target.value })} 
                        />
                    </label>
                    <label>FPS
                        <input 
                            type="number" 
                            value={editing.fps || 30}
                            onChange={e => setEditing({ ...editing, fps: +e.target.value })} 
                        />
                    </label>
                    <div className="settings-form-actions">
                        <button className="settings-btn" onClick={() => setEditing(null)}>Cancel</button>
                        <button className="settings-btn primary" onClick={onSave}>Save</button>
                    </div>
                </div>
            )}
        </div>
    );
}
