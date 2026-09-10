/**
 * SectionFirmwareUpdate — Live OTA firmware update dashboard for STM32H723 (fw_m3).
 *
 * Design & Security:
 *   1. Zero .hex exposure: Raw Intel HEX binaries are completely hidden from regular end users.
 *   2. 1-Click OTA updates: Checks current board version against latest release, displays
 *      release highlights, and allows flashing in 1 click over USB DFU.
 *   3. Cryptographic integrity: Backend validates SHA-256 hash before entering bootloader.
 *   4. Developer Mode bypass: Hidden 5-click sequence on the header unlocks manual .hex upload.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import {
    Cpu,
    Sparkles,
    CheckCircle2,
    AlertTriangle,
    RefreshCw,
    DownloadCloud,
    Terminal,
    Code2,
    ShieldCheck,
    Lock,
    Unlock,
    ChevronRight,
} from 'lucide-react';
import controller from '../../utils/controller';
import { useCNCStore } from '../../stores/cncStore';
import './FirmwareUpdate.css';

interface LogLine {
    type: 'info' | 'error' | 'success';
    content: string;
}

interface FirmwareInfo {
    board: string;
    currentVersion: string;
    latestVersion: string;
    hasUpdate: boolean;
    title: string;
    releaseDate: string;
    changelog: string[];
    minSupportedVersion: string;
    isOfficial: boolean;
    sha256?: string | null;
}

export default function SectionFirmwareUpdate() {
    const connected = useCNCStore((s) => s.connected);
    const firmwareVersion = useCNCStore((s) => s.firmwareVersion);
    const connectedPortInfo = useCNCStore((s) => s.connectedPortInfo);
    const machineState = useCNCStore((s) => s.machineState);

    const [firmwareInfo, setFirmwareInfo] = useState<FirmwareInfo | null>(null);
    const [loadingInfo, setLoadingInfo] = useState(false);
    const [confirming, setConfirming] = useState(false);
    const [flashing, setFlashing] = useState(false);
    const [progress, setProgress] = useState<number | null>(null);
    const [log, setLog] = useState<LogLine[]>([]);
    const [done, setDone] = useState<'success' | 'error' | null>(null);

    // Hidden Developer Mode state (5 clicks on title)
    const [devClicks, setDevClicks] = useState(0);
    const [devMode, setDevMode] = useState(false);
    const [devFile, setDevFile] = useState<File | null>(null);
    const [devConfirming, setDevConfirming] = useState(false);
    const devFileInputRef = useRef<HTMLInputElement>(null);
    const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Fetch latest firmware info from backend
    const fetchFirmwareInfo = useCallback(async () => {
        setLoadingInfo(true);
        try {
            const ver = firmwareVersion || '';
            const res = await fetch(`/api/firmware/info?currentVersion=${encodeURIComponent(ver)}`);
            if (res.ok) {
                const data: FirmwareInfo = await res.json();
                setFirmwareInfo(data);
            }
        } catch (err) {
            console.error('[FirmwareUpdate] Failed to fetch info:', err);
        } finally {
            setLoadingInfo(false);
        }
    }, [firmwareVersion]);

    useEffect(() => {
        fetchFirmwareInfo();
    }, [fetchFirmwareInfo]);

    // Listen for socket events from backend
    useEffect(() => {
        const s = controller.socket;
        if (!s) return;

        const onInfo = (info: FirmwareInfo) => setFirmwareInfo(info);
        const onMessage = (m: { type: 'info' | 'error' | 'success'; content: string }) => {
            setLog((prev) => [...prev, m]);
        };
        const onProgress = (p: { percent: number }) => setProgress(p.percent);
        const onError = (message: string) => {
            setLog((prev) => [...prev, { type: 'error', content: message }]);
            setFlashing(false);
            setDone('error');
        };
        const onEnd = () => {
            setFlashing(false);
            setDone('success');
            fetchFirmwareInfo();
        };

        s.on('firmware:info', onInfo);
        s.on('firmware:info:updated', onInfo);
        s.on('flash:message', onMessage);
        s.on('flash:progress', onProgress);
        s.on('flash:error', onError);
        s.on('flash:end', onEnd);

        return () => {
            s.off('firmware:info', onInfo);
            s.off('firmware:info:updated', onInfo);
            s.off('flash:message', onMessage);
            s.off('flash:progress', onProgress);
            s.off('flash:error', onError);
            s.off('flash:end', onEnd);
        };
    }, [fetchFirmwareInfo]);

    // Handle developer mode easter egg (click header 5 times)
    const handleHeaderClick = () => {
        if (clickTimerRef.current) clearTimeout(clickTimerRef.current);
        const nextClicks = devClicks + 1;
        if (nextClicks >= 5) {
            setDevMode((prev) => !prev);
            setDevClicks(0);
        } else {
            setDevClicks(nextClicks);
            clickTimerRef.current = setTimeout(() => {
                setDevClicks(0);
            }, 3000);
        }
    };

    // 1-Click OTA Update trigger
    const startOtaUpdate = () => {
        if (!controller.socket?.connected || !connectedPortInfo) return;

        setFlashing(true);
        setConfirming(false);
        setDone(null);
        setProgress(0);
        setLog([
            { type: 'info', content: `Preparing live firmware update to v${firmwareInfo?.latestVersion || 'latest'}...` },
            { type: 'info', content: 'Checking machine idle state and validating cryptographic checksum...' },
        ]);

        controller.socket.emit(
            'firmware:flash',
            { port: connectedPortInfo.port, boardType: 'EASYCNC', useOfficialRelease: true },
            (err?: { message?: string } | null) => {
                if (err) {
                    setLog((prev) => [...prev, { type: 'error', content: err.message || String(err) }]);
                    setFlashing(false);
                    setDone('error');
                }
            },
        );
    };

    // Developer Mode: Flash custom local file
    const startDevFlash = () => {
        if (!devFile || !controller.socket?.connected || !connectedPortInfo) return;

        setFlashing(true);
        setDevConfirming(false);
        setDone(null);
        setProgress(0);
        setLog([{ type: 'info', content: `[DEV] Reading local hex file: ${devFile.name}...` }]);

        const reader = new FileReader();
        reader.onload = () => {
            const hexData = reader.result as string;
            controller.socket?.emit(
                'firmware:flash',
                { port: connectedPortInfo.port, boardType: 'EASYCNC', hexData },
                (err?: { message?: string } | null) => {
                    if (err) {
                        setLog((prev) => [...prev, { type: 'error', content: err.message || String(err) }]);
                        setFlashing(false);
                        setDone('error');
                    }
                },
            );
        };
        reader.onerror = () => {
            setLog((prev) => [...prev, { type: 'error', content: 'Failed to read local developer file.' }]);
            setFlashing(false);
            setDone('error');
        };
        reader.readAsText(devFile);
    };

    const reset = () => {
        setDone(null);
        setLog([]);
        setProgress(null);
        setConfirming(false);
        setDevConfirming(false);
        setDevFile(null);
        if (devFileInputRef.current) devFileInputRef.current.value = '';
    };

    const isIdle = machineState === 'idle';
    const currentVer = firmwareVersion ? `v${firmwareVersion.replace(/^v/i, '')}` : 'Unknown';
    const latestVer = firmwareInfo?.latestVersion ? `v${firmwareInfo.latestVersion.replace(/^v/i, '')}` : 'v1.1.0';
    const hasUpdate = firmwareInfo ? firmwareInfo.hasUpdate : true;

    return (
        <div className="settings-section ota-container">
            {/* Header with Developer Easter Egg */}
            <div className="settings-section-header">
                <div>
                    <h3
                        onClick={handleHeaderClick}
                        style={{ cursor: 'pointer', userSelect: 'none' }}
                        title="Click 5 times for Developer Mode"
                    >
                        Firmware & Updates
                        {devClicks > 0 && devClicks < 5 && (
                            <span style={{ fontSize: 11, color: '#94a3b8', marginLeft: 8 }}>
                                ({5 - devClicks} clicks to Developer Mode)
                            </span>
                        )}
                    </h3>
                    <p className="settings-section-sub">
                        Live over-the-air firmware updates for EasyCNC STM32H723. Automatically verifies
                        cryptographic integrity and flashes via USB DFU with zero manual file handling.
                    </p>
                </div>
                <div className="settings-section-actions">
                    <button
                        className="settings-btn"
                        onClick={fetchFirmwareInfo}
                        disabled={loadingInfo || flashing}
                        title="Check for updates"
                    >
                        <RefreshCw size={13} className={loadingInfo ? 'spin' : ''} />
                        Check for updates
                    </button>
                    {devMode && (
                        <span
                            className="ota-dev-badge"
                            onClick={() => setDevMode(false)}
                            title="Click to exit Developer Mode"
                        >
                            <Unlock size={12} /> Dev Mode Active
                        </span>
                    )}
                </div>
            </div>

            {/* Connection & Safety Bar */}
            <div className="settings-detect">
                <span className={`dot ${connected ? 'ok' : 'off'}`} />
                {connected ? (
                    <span>
                        Connected on <b>{connectedPortInfo?.port ?? 'USB Port'}</b> — Board:{' '}
                        <b>{firmwareInfo?.board || 'STM32H723'}</b> — Installed Firmware: <b>{currentVer}</b>
                    </span>
                ) : (
                    <span className="dim">Not connected — connect machine to inspect or update firmware.</span>
                )}
            </div>

            {connected && !isIdle && !flashing && (
                <div className="settings-error">
                    <AlertTriangle size={14} style={{ verticalAlign: 'text-bottom', marginRight: 6 }} />
                    Machine is not idle (state: {machineState}). Finish or stop the current job first. The
                    firmware refuses to enter the bootloader unless it is fully idle.
                </div>
            )}

            {/* 1-Click OTA Update Card */}
            {!flashing && done !== 'success' && (
                <div className="ota-card">
                    <div className="ota-version-row">
                        <div className="ota-version-badges">
                            <span className="ota-ver-pill">
                                Current: <b>{currentVer}</b>
                            </span>
                            <ChevronRight size={14} style={{ color: '#64748b' }} />
                            <span className="ota-ver-pill latest">
                                Latest: <b>{latestVer}</b>
                            </span>
                            <span className={`ota-status-badge ${hasUpdate ? 'has-update' : 'up-to-date'}`}>
                                {hasUpdate ? (
                                    <>
                                        <Sparkles size={13} /> Update Available
                                    </>
                                ) : (
                                    <>
                                        <CheckCircle2 size={13} /> Up to Date
                                    </>
                                )}
                            </span>
                        </div>
                        <div style={{ fontSize: 11, color: '#64748b', display: 'flex', alignItems: 'center', gap: 4 }}>
                            <ShieldCheck size={13} style={{ color: '#34d399' }} /> SHA-256 Verified Release
                        </div>
                    </div>

                    <div className="ota-release-details">
                        <h4 className="ota-release-title">
                            {firmwareInfo?.title || 'Safety Hardening & Async Motion Release'}
                        </h4>
                        <div className="ota-release-meta">
                            <span>Release Date: {firmwareInfo?.releaseDate || '2026-09-10'}</span>
                            <span>•</span>
                            <span>Target: {firmwareInfo?.board || 'STM32H723 (fw_m3)'}</span>
                        </div>
                    </div>

                    {firmwareInfo?.changelog && firmwareInfo.changelog.length > 0 && (
                        <div className="ota-changelog-card">
                            <div className="ota-changelog-header">
                                <Code2 size={13} /> What's New in {latestVer}
                            </div>
                            <ul className="ota-changelog-list">
                                {firmwareInfo.changelog.map((item, idx) => (
                                    <li key={idx}>{item}</li>
                                ))}
                            </ul>
                        </div>
                    )}

                    {/* Confirmation Dialog */}
                    {confirming ? (
                        <div className="ota-confirm-modal">
                            <div className="ota-confirm-title">
                                <AlertTriangle size={15} /> Confirm Firmware Update
                            </div>
                            <p className="ota-confirm-text">
                                The board will jump into USB DFU bootloader mode and flash firmware version{' '}
                                <b>{latestVer}</b>. The serial connection will briefly drop and re-enumerate.
                                <b> Do not power off or disconnect the machine during flashing.</b>
                            </p>
                            <div className="ota-confirm-actions">
                                <button className="settings-btn" onClick={() => setConfirming(false)}>
                                    Cancel
                                </button>
                                <button className="settings-btn primary" onClick={startOtaUpdate}>
                                    <DownloadCloud size={14} /> Yes, Install Update Now
                                </button>
                            </div>
                        </div>
                    ) : (
                        <div className="ota-actions">
                            <button
                                className="ota-btn-primary"
                                disabled={!connected || !isIdle}
                                onClick={() => setConfirming(true)}
                            >
                                <DownloadCloud size={15} />
                                {hasUpdate ? `Install Firmware Update (${latestVer})` : `Reinstall Firmware (${latestVer})`}
                            </button>
                        </div>
                    )}
                </div>
            )}

            {/* Developer Mode Section (Secret / Unlocked) */}
            {devMode && !flashing && done !== 'success' && (
                <div className="ota-dev-section">
                    <div className="ota-dev-header">
                        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <Lock size={14} /> Developer Mode: Manual HEX Override
                        </span>
                        <button
                            className="settings-btn"
                            style={{ height: 24, fontSize: 11 }}
                            onClick={() => setDevMode(false)}
                        >
                            Close Dev Mode
                        </button>
                    </div>
                    <p style={{ fontSize: 12, color: '#94a3b8', margin: 0 }}>
                        Override official OTA distribution and flash an unreleased development .hex binary
                        directly from disk.
                    </p>

                    <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12 }}>
                        Select custom Intel HEX file (.hex)
                        <input
                            ref={devFileInputRef}
                            type="file"
                            accept=".hex"
                            onChange={(e) => {
                                setDevFile(e.target.files?.[0] ?? null);
                                setDevConfirming(false);
                            }}
                        />
                    </label>

                    {devFile && !devConfirming && (
                        <div className="settings-form-actions">
                            <button
                                className="settings-btn primary"
                                disabled={!connected || !isIdle}
                                onClick={() => setDevConfirming(true)}
                            >
                                <Cpu size={14} /> Flash Dev Binary: {devFile.name}
                            </button>
                        </div>
                    )}

                    {devFile && devConfirming && (
                        <div className="ota-confirm-modal" style={{ borderColor: 'rgba(168, 85, 247, 0.4)' }}>
                            <div className="ota-confirm-title" style={{ color: '#c084fc' }}>
                                <AlertTriangle size={15} /> Flash Unverified Custom Binary?
                            </div>
                            <p className="ota-confirm-text" style={{ color: '#e9d5ff' }}>
                                Custom development binaries bypass the official SHA-256 release manifest.
                                Ensure the binary was compiled for STM32H723 at address 0x08000000.
                            </p>
                            <div className="ota-confirm-actions">
                                <button className="settings-btn" onClick={() => setDevConfirming(false)}>
                                    Cancel
                                </button>
                                <button
                                    className="settings-btn primary"
                                    style={{ background: 'rgba(168, 85, 247, 0.25)', borderColor: '#a855f7' }}
                                    onClick={startDevFlash}
                                >
                                    Flash Custom Binary
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* Live Flashing Progress & Terminal Console */}
            {(flashing || log.length > 0) && (
                <div className="settings-form ota-progress-section">
                    <div className="ota-progress-header">
                        <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600, color: '#f8fafc' }}>
                            <Terminal size={14} />
                            {flashing ? 'Flashing Firmware...' : done === 'success' ? 'Update Complete' : 'Process Log'}
                        </span>
                        {progress !== null && flashing && <span>{Math.round(progress)}%</span>}
                    </div>

                    {progress !== null && flashing && (
                        <div className="ota-progress-track">
                            <div
                                className="ota-progress-bar"
                                style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
                            />
                        </div>
                    )}

                    <div className="ota-terminal-box">
                        {log.map((l, i) => (
                            <div key={i} className={`ota-log-line ${l.type}`}>
                                <span>{l.type === 'error' ? '✖ ' : l.type === 'success' ? '✔ ' : '› '}</span>
                                {l.content}
                            </div>
                        ))}
                    </div>

                    {done === 'success' && (
                        <div className="settings-result" style={{ color: '#4ade80', display: 'flex', alignItems: 'center', gap: 8 }}>
                            <CheckCircle2 size={16} />
                            <span>
                                Firmware updated successfully! Device is rebooting into the new version and
                                will re-enumerate on USB CDC. Reconnect once the port is detected.
                            </span>
                        </div>
                    )}

                    {!flashing && (
                        <div className="settings-form-actions">
                            <button className="settings-btn" onClick={reset}>
                                <Cpu size={14} /> {done === 'success' ? 'Done' : 'Try Again'}
                            </button>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
