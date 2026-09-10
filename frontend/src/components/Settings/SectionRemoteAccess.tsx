/**
 * SectionRemoteAccess — LAN access panel (gSender-style Wireless Control
 * parity) + optional PIN gate.
 *
 * Shows this machine's LAN IP(s)/port and a QR code so a phone/tablet on
 * the same network can open the control UI directly, and lets the operator
 * set/clear a PIN from here to require a short-lived token (see
 * RemoteAccessService.js) before a remote client can drive the machine.
 *
 * Setting/clearing the PIN is loopback-only on the backend (isLoopback(req)
 * guard in the /api/remote/pin routes), so this panel only does anything
 * useful when Settings is opened on the control PC itself -- which is the
 * normal way to reach it.
 */
import { useEffect, useState } from 'react';
import { Wifi, RefreshCw, Lock, Unlock, QrCode } from 'lucide-react';
import { remote, RemoteInfo } from './api';

export default function SectionRemoteAccess() {
    const [info, setInfo] = useState<RemoteInfo | null>(null);
    const [selectedIp, setSelectedIp] = useState<string | null>(null);
    const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
    const [pinDraft, setPinDraft] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);

    useEffect(() => { refresh(); }, []);

    useEffect(() => {
        if (!selectedIp || !info) return;
        remote.qr(selectedIp).then((r) => setQrDataUrl(r.dataUrl)).catch(() => setQrDataUrl(null));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedIp]);

    async function refresh() {
        setBusy(true); setError(null);
        try {
            const i = await remote.info();
            setInfo(i);
            const ip = i.ips[0] ?? null;
            setSelectedIp(ip);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    }

    async function setPin() {
        const v = pinDraft.trim();
        if (v.length < 4) { setError('PIN must be at least 4 characters'); return; }
        setBusy(true); setError(null); setNotice(null);
        try {
            await remote.setPin(v);
            setPinDraft('');
            setNotice('PIN set. Remote devices will need it to connect.');
            await refresh();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    }

    async function clearPin() {
        setBusy(true); setError(null); setNotice(null);
        try {
            await remote.clearPin();
            setNotice('PIN cleared. Remote devices on this network connect without one.');
            await refresh();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="settings-section">
            <header className="settings-section-header">
                <div className="settings-section-title">
                    <Wifi size={18} /> Remote Access
                </div>
                <div className="settings-section-actions">
                    <button className="settings-btn" onClick={refresh} disabled={busy}>
                        <RefreshCw size={14} /> Refresh
                    </button>
                </div>
            </header>

            {error && <div className="settings-error">{error}</div>}
            {notice && <div className="wa-block-sub">{notice}</div>}

            <div className="wa-block">
                <div className="wa-block-title">Open on another device</div>
                <div className="wa-block-sub">
                    Any phone, tablet, or laptop on the same LAN can open this control software directly — no app install.
                </div>

                {!info || info.ips.length === 0 ? (
                    <div className="wa-empty">No LAN address detected yet. Make sure this PC is on Wi-Fi or Ethernet.</div>
                ) : (
                    <>
                        {info.ips.length > 1 && (
                            <div className="wa-cfg-row">
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
                            <div className="wa-qr-block">
                                <div>
                                    <div className="wa-qr-title">
                                        <QrCode size={14} style={{ verticalAlign: 'middle', marginRight: 6 }} />
                                        http://{selectedIp}:{info.port}
                                    </div>
                                    <div className="wa-qr-note">Scan with a phone camera, or type this address into a browser on the same network.</div>
                                </div>
                                {qrDataUrl && <img src={qrDataUrl} alt="Remote access QR" className="wa-qr-img" />}
                            </div>
                        )}
                    </>
                )}
            </div>

            <div className="wa-block">
                <div className="wa-block-title">PIN protection</div>
                <div className="wa-block-sub">
                    Optional. When set, remote devices must enter this PIN once before they can view or control the machine.
                    This PC itself is never gated.
                </div>

                <div className="wa-cfg-row">
                    <span className={`settings-pill ${info?.pinSet ? 'ok' : 'fail'}`}>
                        {info?.pinSet ? 'PIN set' : 'No PIN'}
                    </span>
                </div>

                {info?.pinSet ? (
                    <div className="wa-cfg-row">
                        <button className="settings-btn settings-btn danger" onClick={clearPin} disabled={busy}>
                            <Unlock size={14} /> Clear PIN
                        </button>
                    </div>
                ) : (
                    <div className="wa-add-row">
                        <input
                            type="text"
                            inputMode="numeric"
                            className="wa-input"
                            placeholder="New PIN (min 4 chars)"
                            value={pinDraft}
                            onChange={(e) => setPinDraft(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') setPin(); }}
                            disabled={busy}
                        />
                        <button className="settings-btn settings-btn primary" onClick={setPin} disabled={busy || pinDraft.trim().length < 4}>
                            <Lock size={14} /> Set PIN
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}
