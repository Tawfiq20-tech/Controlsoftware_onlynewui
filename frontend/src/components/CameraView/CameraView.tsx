import { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, ChevronUp, VideoOff, Maximize, X, Sparkles } from 'lucide-react';
import { webcam, type CameraCfg } from '../Settings/api';
import controller from '../../utils/controller';
import './CameraView.css';

/**
 * CameraView — collapsible spindle/workspace camera panel.
 *
 * Supports:
 * - Native USB webcams via browser WebRTC (hardware-accelerated, zero-lag)
 *   with frame sync back to backend for WhatsApp/Telegram bot snapshots.
 * - MJPEG/RTSP stream proxies from the backend.
 * - Automatic hardware detection on load.
 * - Bottom tab popup mode: stays anchored at bottom and pops UPWARDS on click.
 */
interface CameraViewProps {
    className?: string;
    showHeader?: boolean;
    defaultExpanded?: boolean;
    isPopup?: boolean;
}

export default function CameraView({
    className = '',
    showHeader = true,
    defaultExpanded = false,
    isPopup = false,
}: CameraViewProps) {
    const [expanded, setExpanded] = useState(defaultExpanded);
    const [fullscreen, setFullscreen] = useState(false);
    const [cameras, setCameras] = useState<CameraCfg[]>([]);
    const [selectedId, setSelectedId] = useState<string>('');
    const [streamOk, setStreamOk] = useState(false);
    const [timestamp, setTimestamp] = useState('');
    const [autoDetecting, setAutoDetecting] = useState(false);

    const videoRef = useRef<HTMLVideoElement | null>(null);
    const fsVideoRef = useRef<HTMLVideoElement | null>(null);
    const localStreamRef = useRef<MediaStream | null>(null);
    const frameSyncTimerRef = useRef<number | null>(null);

    // ── Load configured cameras, keep list live via socket ──
    const refresh = useCallback(async () => {
        try {
            const list = await webcam.list();
            setCameras(list);
            if (list.length > 0) {
                setSelectedId(prev => (prev && list.some(c => c.id === prev)) ? prev : list[0].id!);
            } else {
                // If no cameras configured, attempt background auto-detect
                const auto = await webcam.autoDetect();
                if (auto.ok && auto.camera) {
                    const updated = await webcam.list();
                    setCameras(updated);
                    setSelectedId(auto.camera.id || updated[0]?.id || '');
                }
            }
        } catch {
            // Backend not reachable yet -- placeholder covers this.
        }
    }, []);

    useEffect(() => {
        refresh();
        const s = controller.socket;
        if (!s) return;
        const onList = (list: CameraCfg[]) => {
            setCameras(list);
            setSelectedId(prev => (prev && list.some(c => c.id === prev)) ? prev : (list[0]?.id || ''));
        };
        const onStatus = ({ id, online }: { id: string; online: boolean }) => {
            setCameras(prev => prev.map(c => c.id === id ? { ...c, online } : c));
        };
        s.on('webcam:cameras', onList);
        s.on('webcam:status', onStatus);
        return () => {
            s.off('webcam:cameras', onList);
            s.off('webcam:status', onStatus);
        };
    }, [refresh]);

    const selectedCamera = cameras.find(c => c.id === selectedId) || null;

    // ── Native USB Camera Stream Management ──
    const stopLocalStream = useCallback(() => {
        if (frameSyncTimerRef.current) {
            clearInterval(frameSyncTimerRef.current);
            frameSyncTimerRef.current = null;
        }
        if (localStreamRef.current) {
            localStreamRef.current.getTracks().forEach(t => t.stop());
            localStreamRef.current = null;
        }
        if (videoRef.current) videoRef.current.srcObject = null;
        if (fsVideoRef.current) fsVideoRef.current.srcObject = null;
    }, []);

    useEffect(() => {
        setStreamOk(false);
        stopLocalStream();

        if (!selectedCamera) return;

        if (selectedCamera.type === 'usb' && typeof navigator !== 'undefined' && navigator.mediaDevices?.getUserMedia) {
            let active = true;

            const startWebcam = async () => {
                try {
                    let targetDeviceId: string | undefined;

                    // Match device by label if possible
                    if (navigator.mediaDevices.enumerateDevices) {
                        try {
                            const devices = await navigator.mediaDevices.enumerateDevices();
                            const videoDevices = devices.filter(d => d.kind === 'videoinput');
                            const match = videoDevices.find(d => 
                                (selectedCamera.device && d.label.includes(selectedCamera.device)) ||
                                (selectedCamera.name && d.label.includes(selectedCamera.name))
                            );
                            if (match) targetDeviceId = match.deviceId;
                        } catch (_) {}
                    }

                    const constraints: MediaStreamConstraints = {
                        video: targetDeviceId 
                            ? { deviceId: { exact: targetDeviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
                            : { width: { ideal: 1280 }, height: { ideal: 720 } },
                        audio: false,
                    };

                    const stream = await navigator.mediaDevices.getUserMedia(constraints);
                    if (!active) {
                        stream.getTracks().forEach(t => t.stop());
                        return;
                    }

                    localStreamRef.current = stream;
                    if (videoRef.current) videoRef.current.srcObject = stream;
                    if (fsVideoRef.current) fsVideoRef.current.srcObject = stream;
                    setStreamOk(true);

                    // Sync periodic snapshots to backend (every 2s) for WhatsApp/Telegram bot /jog snapshots
                    frameSyncTimerRef.current = window.setInterval(() => {
                        const el = videoRef.current || fsVideoRef.current;
                        if (!el || el.readyState < 2 || !selectedCamera?.id) return;
                        try {
                            const canvas = document.createElement('canvas');
                            canvas.width = el.videoWidth || 640;
                            canvas.height = el.videoHeight || 480;
                            const ctx = canvas.getContext('2d');
                            if (ctx) {
                                ctx.drawImage(el, 0, 0);
                                canvas.toBlob((blob) => {
                                    if (blob && selectedCamera?.id) {
                                        webcam.postFrame(selectedCamera.id, blob);
                                    }
                                }, 'image/jpeg', 0.65);
                            }
                        } catch (_) {}
                    }, 2000);

                } catch (err) {
                    console.warn('[CameraView] getUserMedia fallback to backend proxy:', err);
                    setStreamOk(false);
                }
            };

            startWebcam();

            return () => {
                active = false;
                stopLocalStream();
            };
        }
    }, [selectedCamera, stopLocalStream]);

    // Keep fullscreen video in sync with stream
    useEffect(() => {
        if (fullscreen && fsVideoRef.current && localStreamRef.current) {
            fsVideoRef.current.srcObject = localStreamRef.current;
        }
    }, [fullscreen]);

    // ── Live timestamp ──
    useEffect(() => {
        const tick = () => {
            const now = new Date();
            const hh = String(now.getHours()).padStart(2, '0');
            const mm = String(now.getMinutes()).padStart(2, '0');
            const ss = String(now.getSeconds()).padStart(2, '0');
            const ms = String(Math.floor(now.getMilliseconds() / 10)).padStart(2, '0');
            setTimestamp(`${hh}:${mm}:${ss}:${ms}`);
        };
        tick();
        const id = setInterval(tick, 100);
        return () => clearInterval(id);
    }, []);

    // ── Close fullscreen on Escape ──
    useEffect(() => {
        if (!fullscreen) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setFullscreen(false);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [fullscreen]);

    const isStreaming = streamOk && !!selectedCamera;
    const cameraLabel = selectedCamera?.name || 'Camera';

    const handleAutoDetectClick = async (e: React.MouseEvent) => {
        e.stopPropagation();
        setAutoDetecting(true);
        try {
            await webcam.autoDetect();
            await refresh();
        } finally {
            setAutoDetecting(false);
        }
    };

    // ── Render helpers ──
    const renderPlaceholder = () => (
        <div className="camera-placeholder">
            <VideoOff size={32} className="camera-placeholder-icon" />
            <span className="camera-placeholder-text">
                {cameras.length === 0
                    ? 'No camera configured'
                    : (selectedCamera?.lastError || 'Connecting to video feed...')}
            </span>
            {cameras.length === 0 && (
                <button 
                    className="settings-btn primary"
                    style={{ marginTop: 8, fontSize: 11, padding: '4px 10px' }}
                    onClick={handleAutoDetectClick}
                    disabled={autoDetecting}
                >
                    <Sparkles size={13} /> {autoDetecting ? 'Detecting...' : 'Auto-Detect Camera'}
                </button>
            )}
        </div>
    );

    const renderOverlay = () => (
        <>
            {isStreaming && (
                <div className="camera-rec">
                    <span className="camera-rec-dot" />
                    REC
                </div>
            )}
            <span className="camera-timestamp">{timestamp}</span>
        </>
    );

    const renderStream = (isFs = false) => {
        if (!selectedCamera) return null;

        if (selectedCamera.type === 'usb') {
            return (
                <video
                    ref={isFs ? fsVideoRef : videoRef}
                    autoPlay
                    playsInline
                    muted
                    className="camera-video"
                    onLoadedMetadata={() => setStreamOk(true)}
                    onError={() => setStreamOk(false)}
                />
            );
        }

        return (
            <img
                key={selectedCamera.id}
                className="camera-video"
                src={webcam.streamUrl(selectedCamera.id!)}
                onLoad={() => setStreamOk(true)}
                onError={() => setStreamOk(false)}
                alt={selectedCamera.name}
            />
        );
    };

    const panelRef = useRef<HTMLDivElement | null>(null);

    // ── Close popup on click outside or Escape ──
    useEffect(() => {
        if (!isPopup || !expanded) return;
        const handleClickOutside = (e: Event) => {
            if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
                setExpanded(false);
            }
        };
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setExpanded(false);
        };
        document.addEventListener('pointerdown', handleClickOutside);
        window.addEventListener('keydown', handleKeyDown);
        return () => {
            document.removeEventListener('pointerdown', handleClickOutside);
            window.removeEventListener('keydown', handleKeyDown);
        };
    }, [isPopup, expanded]);

    return (
        <>
            {/* ── Sidebar panel ── */}
            <div
                ref={panelRef}
                className={`camera-panel ${isPopup ? 'camera-popup-mode' : ''} ${className}`}
            >
                {/* Video area */}
                <div className={`camera-body${expanded || !showHeader ? '' : ' collapsed'}`}>
                    {/* Top bar when in popup mode */}
                    {isPopup && (
                        <div className="camera-popup-top-bar">
                            <div className="camera-popup-title">
                                <span className={`camera-status-dot${isStreaming ? ' connected' : ''}`} />
                                <span>{cameraLabel}</span>
                                {isStreaming && <span className="camera-rec-mini-badge">LIVE</span>}
                            </div>
                            <div className="camera-popup-actions">
                                <button
                                    type="button"
                                    className="camera-popup-icon-btn"
                                    title="Fullscreen"
                                    disabled={!selectedCamera}
                                    onClick={() => setFullscreen(true)}
                                >
                                    <Maximize size={13} />
                                </button>
                                <button
                                    type="button"
                                    className="camera-popup-icon-btn close"
                                    title="Close popup"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        setExpanded(false);
                                    }}
                                >
                                    <X size={14} />
                                </button>
                            </div>
                        </div>
                    )}

                    <div className="camera-viewport">
                        {renderStream(false)}
                        {!isStreaming && renderPlaceholder()}
                        {renderOverlay()}
                    </div>

                    {/* Footer bar (only in non-popup mode, or if multiple cameras need selection) */}
                    {(!isPopup || cameras.length > 1) && (
                        <div className="camera-footer">
                            <span className="camera-footer-label">{cameras.length > 1 ? 'Camera:' : cameraLabel}</span>
                            <div className="camera-footer-actions">
                                {/* Camera selector */}
                                {cameras.length > 1 && (
                                    <div className="camera-select-wrapper">
                                        <select
                                            className="camera-select"
                                            value={selectedId}
                                            onChange={e => setSelectedId(e.target.value)}
                                            onClick={e => e.stopPropagation()}
                                        >
                                            {cameras.map(c => (
                                                <option key={c.id} value={c.id}>
                                                    {c.name}
                                                </option>
                                            ))}
                                        </select>
                                        <ChevronDown
                                            size={10}
                                            className="camera-select-chevron"
                                        />
                                    </div>
                                )}
                                {/* Fullscreen toggle (in non-popup mode) */}
                                {!isPopup && (
                                    <button
                                        className="camera-footer-btn"
                                        title="Fullscreen"
                                        disabled={!selectedCamera}
                                        onClick={e => {
                                            e.stopPropagation();
                                            setFullscreen(true);
                                        }}
                                    >
                                        <Maximize size={14} />
                                    </button>
                                )}
                            </div>
                        </div>
                    )}
                </div>

                {/* Toggle header — stays anchored down at bottom */}
                {showHeader && (
                    <div
                        className={`camera-header ${expanded ? 'active' : ''}`}
                        onClick={() => setExpanded(prev => !prev)}
                        role="button"
                        tabIndex={0}
                        title={expanded ? 'Click to close camera' : 'Click to open camera popup'}
                    >
                        <div className="camera-header-left">
                            <span className={`camera-status-dot${isStreaming ? ' connected' : ''}`} />
                            <span className="camera-header-label">Camera</span>
                            {isStreaming && <span className="camera-mini-live-tag">LIVE</span>}
                        </div>
                        {isPopup ? (
                            expanded ? (
                                <ChevronDown size={14} className="camera-header-chevron open" />
                            ) : (
                                <ChevronUp size={14} className="camera-header-chevron" />
                            )
                        ) : (
                            <ChevronDown
                                size={14}
                                className={`camera-header-chevron${expanded ? ' open' : ''}`}
                            />
                        )}
                    </div>
                )}
            </div>

            {/* ── Fullscreen overlay ── */}
            {fullscreen && createPortal(
                <div className="camera-fullscreen-overlay" onClick={() => setFullscreen(false)}>
                    <div
                        className="camera-fullscreen-video-wrap"
                        onClick={e => e.stopPropagation()}
                    >
                        <div className="camera-fullscreen-top-bar">
                            <span className="camera-fullscreen-label">{cameraLabel}</span>
                            <button
                                className="camera-fullscreen-close"
                                onClick={() => setFullscreen(false)}
                                title="Close (Esc)"
                            >
                                <X size={18} />
                            </button>
                        </div>
                        {renderStream(true)}
                        {!isStreaming && renderPlaceholder()}
                        {renderOverlay()}
                    </div>
                </div>,
                document.body
            )}
        </>
    );
}
