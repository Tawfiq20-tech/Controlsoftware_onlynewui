/**
 * SectionRemoteAccess — Unified Single Remote Connection (Local LAN & Global Internet Tunnel)
 * with Industrial Multi-Layer Security.
 *
 * Provides ONE single QR code and connection link for the user that works
 * whether on the local workshop Wi-Fi or across the global internet.
 */
import { useEffect, useState } from 'react';
import {
    Wifi, RefreshCw, Lock, Unlock, Globe, Power, Copy, Check, Users, ShieldAlert, Smartphone
} from 'lucide-react';
import { remote, RemoteInfo, TunnelStatus } from './api';

export default function SectionRemoteAccess() {
    const [info, setInfo] = useState<RemoteInfo | null>(null);
    const [tunnel, setTunnel] = useState<TunnelStatus | null>(null);
    const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
    const [activeUrl, setActiveUrl] = useState<string>('');
    const [pinDraft, setPinDraft] = useState('');
    const [busy, setBusy] = useState(false);
    const [tunnelBusy, setTunnelBusy] = useState(false);
    const [copiedUrl, setCopiedUrl] = useState(false);
    const [copiedPw, setCopiedPw] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);

    useEffect(() => {
        refresh();
        const timer = setInterval(() => {
            refreshTunnelStatus();
        }, 6000);
        return () => clearInterval(timer);
    }, []);

    // Update QR code whenever unified URL or tunnel changes
    useEffect(() => {
        updateQrCode();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tunnel?.url, info?.unifiedUrl, info?.lanUrl]);

    async function refresh() {
        setBusy(true);
        setError(null);
        try {
            const [i, t] = await Promise.all([
                remote.info(),
                remote.tunnelStatus().catch(() => null),
            ]);
            setInfo(i);
            if (t) setTunnel(t);
            else if (i.tunnel) setTunnel(i.tunnel);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    }

    async function refreshTunnelStatus() {
        try {
            const t = await remote.tunnelStatus();
            setTunnel(t);
        } catch (_) {}
    }

    async function updateQrCode(overrideUrl?: string) {
        try {
            const urlToUse = overrideUrl !== undefined 
                ? overrideUrl 
                : (tunnel?.status === 'running' && tunnel?.url ? tunnel.url : info?.unifiedUrl);
            const res = await remote.qr(urlToUse, !!urlToUse);
            setQrDataUrl(res.dataUrl);
            setActiveUrl(res.url);
        } catch (_) {
            setQrDataUrl(null);
        }
    }

    async function startGlobalTunnel() {
        if (!info?.pinSet) {
            setError('Please set a security PIN first before enabling Global Internet Access.');
            return;
        }
        setTunnelBusy(true);
        setError(null);
        setNotice(null);
        try {
            const res = await remote.startTunnel();
            setNotice(`Global access online: ${res.url}`);
            await refresh();
            await updateQrCode(res.url);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setTunnelBusy(false);
        }
    }

    async function stopGlobalTunnel() {
        setTunnelBusy(true);
        setError(null);
        setNotice(null);
        try {
            await remote.stopTunnel();
            setNotice('Switched to local workshop Wi-Fi only.');
            await refresh();
            await updateQrCode(info?.lanUrl);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setTunnelBusy(false);
        }
    }

    async function revokeAllSessions() {
        if (!confirm('Are you sure you want to disconnect all remote devices right now?')) return;
        setBusy(true);
        setError(null);
        setNotice(null);
        try {
            await remote.revokeSessions();
            setNotice('All remote device sessions have been revoked.');
            await refreshTunnelStatus();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    }

    async function setPin() {
        const v = pinDraft.trim();
        if (v.length < 4) {
            setError('PIN must be at least 4 characters');
            return;
        }
        setBusy(true);
        setError(null);
        setNotice(null);
        try {
            await remote.setPin(v);
            setPinDraft('');
            setNotice('Security PIN set successfully. Remote devices will be required to enter it.');
            await refresh();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    }

    async function clearPin() {
        setBusy(true);
        setError(null);
        setNotice(null);
        try {
            await remote.clearPin();
            setNotice('PIN cleared. Remote devices on local network can connect without one.');
            await refresh();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    }

    function copyToClipboard(text: string, isPassword = false) {
        if (!text) return;
        navigator.clipboard.writeText(text);
        if (isPassword) {
            setCopiedPw(true);
            setTimeout(() => setCopiedPw(false), 2000);
        } else {
            setCopiedUrl(true);
            setTimeout(() => setCopiedUrl(false), 2000);
        }
    }

    const isTunnelRunning = tunnel?.status === 'running' && !!tunnel?.url;
    const targetUrl = (isTunnelRunning ? tunnel?.url : activeUrl) || info?.unifiedUrl || '';

    return (
        <div className="settings-section">
            <header className="settings-section-header">
                <div>
                    <div className="settings-section-title">
                        <Smartphone size={18} style={{ marginRight: 6, verticalAlign: 'middle' }} /> Single Remote Connection
                    </div>
                    <div className="settings-section-sub">
                        Connect and control your CNC from any phone, tablet, or laptop using a single QR code for both local Wi-Fi and worldwide internet access.
                    </div>
                </div>
                <div className="settings-section-actions">
                    <button className="settings-btn" onClick={refresh} disabled={busy || tunnelBusy}>
                        <RefreshCw size={14} /> Refresh
                    </button>
                </div>
            </header>

            {error && <div className="settings-error">{error}</div>}
            {notice && <div className="wa-block-sub" style={{ color: '#4ade80', fontWeight: 500 }}>{notice}</div>}

            {/* ─── SINGLE UNIFIED CONNECTION CARD ─── */}
            <div className="wa-block">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
                    <div>
                        <div className="wa-block-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            {isTunnelRunning ? <Globe size={16} color="#38bdf8" /> : <Wifi size={16} color="#4ade80" />}
                            <span>Single Connection Point ({isTunnelRunning ? 'Worldwide Global + Local' : 'Local Wi-Fi'})</span>
                        </div>
                        <div className="wa-block-sub">
                            {isTunnelRunning
                                ? 'Encrypted HTTPS tunnel active: Connect from anywhere in the world on 5G/cellular or inside your local shop.'
                                : 'Direct local Wi-Fi connection active: Connect from any phone or tablet on the same workshop Wi-Fi network.'}
                        </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span className={`settings-pill ${isTunnelRunning ? 'ok' : 'warn'}`}>
                            {isTunnelRunning ? 'Global & Local Live' : 'Local Wi-Fi Active'}
                        </span>
                    </div>
                </div>

                {/* Single QR Code & Direct Link */}
                <div style={{ marginTop: 16 }}>
                    <div className="wa-qr-block">
                        <div style={{ flex: 1 }}>
                            <div className="wa-qr-title" style={{ wordBreak: 'break-all' }}>
                                {isTunnelRunning ? <Globe size={15} style={{ verticalAlign: 'middle', marginRight: 6 }} /> : <Wifi size={15} style={{ verticalAlign: 'middle', marginRight: 6 }} />}
                                {targetUrl || 'Detecting connection URL...'}
                            </div>
                            <div className="wa-qr-note">
                                <strong>Scan with any phone camera</strong> to open the control interface instantly.
                            </div>

                            <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                                <button className="settings-btn" onClick={() => copyToClipboard(targetUrl)} disabled={!targetUrl}>
                                    {copiedUrl ? <Check size={14} color="#4ade80" /> : <Copy size={14} />}
                                    {copiedUrl ? 'Copied URL!' : 'Copy Connection Link'}
                                </button>
                                {isTunnelRunning && (
                                    <button
                                        className="settings-btn danger"
                                        onClick={revokeAllSessions}
                                        disabled={busy}
                                        title="Immediately disconnects all external phones and browsers"
                                    >
                                        <Users size={14} /> Revoke Sessions ({tunnel?.activeSessions || 0})
                                    </button>
                                )}
                            </div>

                            {/* Global Tunnel Controls */}
                            <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid rgba(255,255,255,0.08)' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                                    {!isTunnelRunning ? (
                                        <button
                                            className="settings-btn primary"
                                            onClick={startGlobalTunnel}
                                            disabled={tunnelBusy || busy}
                                            style={{ height: 34, padding: '0 16px' }}
                                        >
                                            <Power size={14} /> Enable Worldwide Internet Access
                                        </button>
                                    ) : (
                                        <button
                                            className="settings-btn"
                                            onClick={stopGlobalTunnel}
                                            disabled={tunnelBusy || busy}
                                            style={{ height: 34 }}
                                        >
                                            <Power size={14} /> Switch to Local Wi-Fi Only
                                        </button>
                                    )}
                                    {!isTunnelRunning && (
                                        <div style={{ marginTop: 8, fontSize: 11, color: '#94a3b8', width: '100%' }}>
                                            ℹ️ <em>Direct Wi-Fi connects when phone & PC share private shop Wi-Fi. For 5G/cellular data or university/campus Wi-Fi, click <strong>Enable Worldwide Internet Access</strong> above.</em>
                                        </div>
                                    )}
                                </div>
                            </div>

                            {!info?.pinSet && !isTunnelRunning && (
                                <div style={{ marginTop: 12, padding: '8px 12px', background: 'rgba(234, 179, 8, 0.12)', border: '1px solid rgba(234, 179, 8, 0.3)', borderRadius: 6, fontSize: 12, color: '#fde047' }}>
                                    <ShieldAlert size={14} style={{ verticalAlign: 'middle', marginRight: 6 }} />
                                    A security PIN must be set below before opening worldwide access.
                                </div>
                            )}

                            {isTunnelRunning && tunnel?.tunnelPassword && (
                                <div style={{ marginTop: 14, padding: '10px 12px', background: 'rgba(59, 130, 246, 0.12)', border: '1px solid rgba(59, 130, 246, 0.3)', borderRadius: 8 }}>
                                    <div style={{ fontSize: 12, fontWeight: 600, color: '#93c5fd' }}>
                                        Endpoint IP / Password:
                                    </div>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
                                        <code style={{ fontSize: 13, background: 'rgba(0,0,0,0.3)', padding: '2px 6px', borderRadius: 4, color: '#fff' }}>
                                            {tunnel.tunnelPassword}
                                        </code>
                                        <button className="settings-btn" onClick={() => copyToClipboard(tunnel.tunnelPassword!, true)} style={{ height: 26, fontSize: 11 }}>
                                            {copiedPw ? <Check size={12} color="#4ade80" /> : <Copy size={12} />}
                                            {copiedPw ? 'Copied' : 'Copy'}
                                        </button>
                                    </div>
                                    <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4 }}>
                                        If your phone browser displays a "Friendly Reminder" submit screen on first connection, enter this IP.
                                    </div>
                                </div>
                            )}
                        </div>

                        {/* Single QR Image Display */}
                        {qrDataUrl && (
                            <div style={{ textAlign: 'center' }}>
                                <img src={qrDataUrl} alt="Unified Remote Connection QR" className="wa-qr-img" />
                                <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 6 }}>
                                    Single QR for Phone / Tablet
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {/* ─── PIN & SECURITY CONFIGURATION ─── */}
            <div className="wa-block">
                <div className="wa-block-title">Security & PIN Gate</div>
                <div className="wa-block-sub">
                    Requires external remote devices to authenticate before viewing coordinates or jogging the machine.
                    Protected with salted <strong>scrypt</strong> hashing and automatic 15-minute brute-force lockout after 5 failed attempts.
                    This computer (localhost) is never locked out.
                </div>

                <div className="wa-cfg-row" style={{ marginTop: 12 }}>
                    <span className={`settings-pill ${info?.pinSet ? 'ok' : 'fail'}`}>
                        {info?.pinSet ? 'PIN Set (Protected)' : 'No PIN (Unprotected)'}
                    </span>
                </div>

                {info?.pinSet ? (
                    <div className="wa-cfg-row" style={{ marginTop: 10 }}>
                        <button className="settings-btn danger" onClick={clearPin} disabled={busy || tunnelBusy}>
                            <Unlock size={14} /> Clear PIN
                        </button>
                    </div>
                ) : (
                    <div className="wa-add-row" style={{ marginTop: 10, display: 'flex', gap: 10 }}>
                        <input
                            type="password"
                            inputMode="numeric"
                            className="wa-input"
                            placeholder="New Security PIN (min 4 chars)"
                            value={pinDraft}
                            onChange={(e) => setPinDraft(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') setPin(); }}
                            disabled={busy}
                            style={{ maxWidth: 260 }}
                        />
                        <button className="settings-btn primary" onClick={setPin} disabled={busy || pinDraft.trim().length < 4}>
                            <Lock size={14} /> Set PIN
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}
