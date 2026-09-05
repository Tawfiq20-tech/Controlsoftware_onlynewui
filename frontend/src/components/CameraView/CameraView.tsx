import { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';

import { ChevronDown, VideoOff, Maximize, X } from 'lucide-react';
import { webcam, type CameraCfg } from '../Settings/api';
import controller from '../../utils/controller';
import './CameraView.css';


/**
 * CameraView — collapsible spindle/workspace camera panel.
 *
 * Pulls from the backend's WebcamService (services/webcam/WebcamService.js)
 * -- MJPEG proxy for mjpeg-url/rtsp/v4l2 cameras -- via the same
 * Settings/api.ts `webcam` client SectionWebcam.tsx already uses. This is
 * deliberately NOT the browser's own getUserMedia camera: the backend
 * stream works for cameras attached to the CNC machine itself (or an IP
 * cam on the shop LAN), viewable from any device that can reach the
 * backend, not just whatever's plugged into the viewer's own laptop.
 * Camera config (add/edit/remove) lives in Settings -> Cameras
 * (SectionWebcam.tsx) -- this panel is read-only display + fullscreen.
 *
 * Placed at the bottom of the Sidebar on Prepare / Carve pages.
 */
export default function CameraView() {
    const [expanded, setExpanded] = useState(true);
    const [fullscreen, setFullscreen] = useState(false);
    const [cameras, setCameras] = useState<CameraCfg[]>([]);
    const [selectedId, setSelectedId] = useState<string>('');
    const [streamOk, setStreamOk] = useState(false);
    const [timestamp, setTimestamp] = useState('');

    // ── Load configured cameras, keep list live via socket ──
    const refresh = useCallback(async () => {
        try {
            const list = await webcam.list();
            setCameras(list);
            setSelectedId(prev => (prev && list.some(c => c.id === prev)) ? prev : (list[0]?.id || ''));
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

    // Reset the "did the frame load" flag whenever the selected camera changes.
    useEffect(() => { setStreamOk(false); }, [selectedId]);

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

    const selectedCamera = cameras.find(c => c.id === selectedId) || null;
    const isStreaming = streamOk && !!selectedCamera;
    const cameraLabel = selectedCamera?.name || 'Camera';

    // ── Render helpers ──
    const renderPlaceholder = () => (
        <div className="camera-placeholder">
            <VideoOff size={32} className="camera-placeholder-icon" />
            <span className="camera-placeholder-text">
                {cameras.length === 0
                    ? 'No camera configured -- add one in Settings > Cameras'
                    : (selectedCamera?.lastError || 'No signal')}
            </span>
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

    const renderStream = (extraClass = '') => (
        selectedCamera && (
            // eslint-disable-next-line jsx-a11y/alt-text -- MJPEG multipart stream, browser renders it natively as a live <img>
            <img
                key={selectedCamera.id}
                className={`camera-video ${extraClass}`}
                src={webcam.streamUrl(selectedCamera.id!)}
                onLoad={() => setStreamOk(true)}
                onError={() => setStreamOk(false)}
            />
        )
    );

    return (
        <>
            {/* ── Sidebar panel ── */}
            <div className="camera-panel">
                {/* Toggle header */}
                <div className="camera-header" onClick={() => setExpanded(prev => !prev)}>
                    <div className="camera-header-left">
                        <span className={`camera-status-dot${isStreaming ? ' connected' : ''}`} />
                        <span className="camera-header-label">Camera</span>
                    </div>
                    <ChevronDown
                        size={14}
                        className={`camera-header-chevron${expanded ? ' open' : ''}`}
                    />
                </div>

                {/* Video area */}
                <div className={`camera-body${expanded ? '' : ' collapsed'}`}>
                    <div className="camera-viewport">
                        {selectedCamera ? renderStream() : null}
                        {!isStreaming && renderPlaceholder()}
                        {renderOverlay()}
                    </div>

                    {/* Footer bar */}
                    <div className="camera-footer">
                        <span className="camera-footer-label">{cameraLabel}</span>
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
                            {/* Fullscreen toggle */}
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
                        </div>
                    </div>
                </div>
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
                        {selectedCamera ? renderStream() : null}
                        {!isStreaming && renderPlaceholder()}
                        {renderOverlay()}
                    </div>
                </div>,
                document.body
            )}
        </>
    );
}
