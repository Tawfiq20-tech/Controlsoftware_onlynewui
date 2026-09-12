/**
 * SectionRemoteAccess — Dual-mode Remote Access (Global Internet Tunnel + Local LAN)
 * with Industrial Multi-Layer Security.
 */
import { useEffect, useState } from 'react';
import {
    Wifi, RefreshCw, Lock, Unlock, QrCode, Globe, Power, Copy, Check, Users, ShieldAlert
} from 'lucide-react';
import { remote, RemoteInfo, TunnelStatus } from './api';

type AccessMode = 'global' | 'local';

export default function SectionRemoteAccess() {
    // Default to Local Wi-Fi, not Global Internet: the tunnel exposes this
    // machine to the public internet and should be an explicit opt-in, not
    // the first thing the operator sees.
    const [mode, setMode] = useState<AccessMode>('local');
    const [info, setInfo] = useState<RemoteInfo | null>(null);
    const [tunnel, setTunnel] = useState<TunnelStatus | null>(null);
    const [selectedIp, setSelectedIp] = useState<string | null>(null);
    const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
    const [pinDraft, setPinDraft] = useState('');
    const [busy, setBusy] = useState(false);
    const [tunnelBusy, setTunnelBusy] = useState(false);
    const [understandRisk, setUnderstandRisk] = useState(false);
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

    // Update QR code whenever mode, selectedIp, or tunnel URL changes
    useEffect(() => {
        updateQrCode();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mode, selectedIp, tunnel?.url]);

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
            const ip = i.ips[0] ?? null;
            if (!selectedIp) setSelectedIp(ip);
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

    async function updateQrCode() {
        if (mode === 'global') {
            if (tunnel?.url) {
                try {
                    const res = await remote.qr(tunnel.url, true);
                    setQrDataUrl(res.dataUrl);
                } catch (_) {
                    setQrDataUrl(null);
                }
            } else {
                setQrDataUrl(null);
            }
        } else {
            if (selectedIp) {
                try {
                    const res = await remote.qr(selectedIp, false);
                    setQrDataUrl(res.dataUrl);
                } catch (_) {
                    setQrDataUrl(null);
                }
            } else {
                setQrDataUrl(null);
            }
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
            await refreshTunnelStatus();
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
            setNotice('Global internet tunnel stopped.');
            await refreshTunnelStatus();
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

    return (
        <div className="settings-section">
            <header className="settings-section-header">
                <div>
                    <div className="settings-section-title">
                        <Globe size={18} style={{ marginRight: 6, verticalAlign: 'middle' }} /> Remote Access
                    </div>
                    <div className="settings-section-sub">
                        Monitor and control the CNC machine from phones, tablets, or remote computers.
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

            {/* Mode Switcher */}
            <div style={{ display: 'flex', gap: 10, margin: '4px 0 12px' }}>
                <button
                    className={`settings-btn ${mode === 'global' ? 'primary' : ''}`}
                    onClick={() => setMode('global')}
                    style={{ padding: '8px 16px', fontSize: 13, height: 36 }}
                >
                    <Globe size={15} /> Global Internet (Anywhere)
                </button>
                <button
                    className={`settings-btn ${mode === 'local' ? 'primary' : ''}`}
                    onClick={() => setMode('local')}
                    style={{ padding: '8px 16px', fontSize: 13, height: 36 }}
                >
                    <Wifi size={15} /> Local Network (Wi-Fi)
                </button>
            </div>

            {/* ─── GLOBAL INTERNET MODE ─── */}
            {mode === 'global' && (
                <div className="wa-block">
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <div>
                            <div className="wa-block-title">Worldwide Access (Encrypted HTTPS)</div>
                            <div className="wa-block-sub">
                                Access from any mobile phone or browser over cellular (5G/4G) or external networks — no router port forwarding needed.
                            </div>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span className={`settings-pill ${isTunnelRunning ? 'ok' : tunnel?.status === 'starting' ? 'warn' : 'fail'}`}>
                                {isTunnelRunning ? 'Live & Secure' : tunnel?.status === 'starting' ? 'Starting...' : 'Stopped'}
                            </span>
                        </div>
                    </div>

                    {!isTunnelRunning && (
                        <div style={{ marginTop: 12, padding: '8px 12px', background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.3)', borderRadius: 6, fontSize: 12, color: '#fca5a5' }}>
                            <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer' }}>
                                <input
                                    type="checkbox"
                                    checked={understandRisk}
                                    onChange={(e) => setUnderstandRisk(e.target.checked)}
                                    style={{ marginTop: 2 }}
                                />
                                <span>
                                    <ShieldAlert size={14} style={{ verticalAlign: 'middle', marginRight: 4 }} />
                                    I understand this exposes my machine to the internet and requires a 6+ character PIN.
                                </span>
                            </label>
                        </div>
                    )}

                    <div style={{ display: 'flex', gap: 10, marginTop: 14, alignItems: 'center', flexWrap: 'wrap' }}>
                        {!isTunnelRunning ? (
                            <button
                                className="settings-btn primary"
                                onClick={startGlobalTunnel}
                                disabled={tunnelBusy || busy || !understandRisk}
                                style={{ height: 34, padding: '0 16px' }}
                                title={!understandRisk ? 'Check the box above to confirm you understand the exposure risk' : undefined}
                            >
                                <Power size={14} /> Enable Global Access
                            </button>
                        ) : (
                            <>
                                <button
                                    className="settings-btn"
                                    onClick={stopGlobalTunnel}
                                    disabled={tunnelBusy || busy}
                                    style={{ height: 34 }}
                                >
                                    <Power size={14} /> Stop Global Access
                                </button>
                                <button
                                    className="settings-btn danger"
                                    onClick={revokeAllSessions}
                                    disabled={busy}
                                    title="Immediately disconnects all external phones and browsers"
                                    style={{ height: 34 }}
                                >
                                    <Users size={14} /> Revoke All Sessions ({tunnel?.activeSessions || 0})
                                </button>
                            </>
                        )}
                    </div>

                    {!info?.pinSet && !isTunnelRunning && (
                        <div style={{ marginTop: 12, padding: '8px 12px', background: 'rgba(234, 179, 8, 0.12)', border: '1px solid rgba(234, 179, 8, 0.3)', borderRadius: 6, fontSize: 12, color: '#fde047' }}>
                            <ShieldAlert size={14} style={{ verticalAlign: 'middle', marginRight: 6 }} />
                            A security PIN must be set below before opening worldwide access.
                        </div>
                    )}

                    {isTunnelRunning && tunnel?.url && (
                        <div style={{ marginTop: 16 }}>
                            <div className="wa-qr-block">
                                <div style={{ flex: 1 }}>
                                    <div className="wa-qr-title">
                                        <Globe size={15} style={{ verticalAlign: 'middle', marginRight: 6 }} />
                                        {tunnel.url}
                                    </div>
                                    <div className="wa-qr-note">
                                        Scan with any mobile phone camera, or open this link from anywhere in the world.
                                    </div>

                                    <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
                                        <button className="settings-btn" onClick={() => copyToClipboard(tunnel.url!)}>
                                            {copiedUrl ? <Check size={14} color="#4ade80" /> : <Copy size={14} />}
                                            {copiedUrl ? 'Copied URL!' : 'Copy Link'}
                                        </button>
                                    </div>

                                    {tunnel.tunnelPassword && (
                                        <div style={{ marginTop: 16, padding: '10px 12px', background: 'rgba(59, 130, 246, 0.12)', border: '1px solid rgba(59, 130, 246, 0.3)', borderRadius: 8 }}>
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
                                {qrDataUrl && <img src={qrDataUrl} alt="Global Remote QR" className="wa-qr-img" />}
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* ─── LOCAL NETWORK (WI-FI) MODE ─── */}
            {mode === 'local' && (
                <div className="wa-block">
                    <div className="wa-block-title">Local Wi-Fi Network Access</div>
                    <div className="wa-block-sub">
                        Direct connection within your local workshop router (offline-capable).
                    </div>

                    {!info || info.ips.length === 0 ? (
                        <div className="wa-empty">No LAN address detected yet. Make sure this PC is connected to Wi-Fi or Ethernet.</div>
                    ) : (
                        <>
                            {info.ips.length > 1 && (
                                <div className="wa-cfg-row" style={{ marginTop: 12 }}>
                                    <label className="wa-label">
                                        Network interface
                                        <select
                                            className="wa-input"
                                            value={selectedIp ?? ''}
                                            onChange={(e) => setSelectedIp(e.target.value)}
                                        >
                                            {info.ips.map((ip) => <option key={ip} value={ip}>{ip}</option>)}
                                        </select>
                                    </label>
                                </div>
                            )}

                            {selectedIp && (
                                <div className="wa-qr-block" style={{ marginTop: 14 }}>
                                    <div>
                                        <div className="wa-qr-title">
                                            <QrCode size={14} style={{ verticalAlign: 'middle', marginRight: 6 }} />
                                            http://{selectedIp}:{info.port}
                                        </div>
                                        <div className="wa-qr-note">
                                            Scan with a phone on the same Wi-Fi network.
                                        </div>
                                        <div style={{ marginTop: 12, padding: '10px 12px', background: 'rgba(255, 255, 255, 0.03)', border: '1px solid rgba(255, 255, 255, 0.08)', borderRadius: 6, fontSize: 11, color: '#94a3b8' }}>
                                            💡 <strong>Connection blocked by Windows?</strong><br />
                                            Run <code>scripts\enable-local-access.bat</code> on this computer to allow incoming port 4000 in Windows Firewall.
                                        </div>
                                    </div>
                                    {qrDataUrl && <img src={qrDataUrl} alt="Local access QR" className="wa-qr-img" />}
                                </div>
                            )}
                        </>
                    )}
                </div>
            )}

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
                            placeholder={mode === 'global' ? 'New Security PIN (min 6 chars for internet access)' : 'New Security PIN (min 4 chars)'}
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
                {mode === 'global' && (
                    <div className="wa-block-sub" style={{ marginTop: 8 }}>
                        Internet tunnel access requires a PIN of at least 6 characters.
                    </div>
                )}
            </div>
        </div>
    );
}
