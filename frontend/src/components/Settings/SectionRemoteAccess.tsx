/**
 * SectionRemoteAccess — control the machine from a phone or tablet.
 *
 *  - Anywhere: Tailscale (private, end-to-end encrypted; no public exposure,
 *    no port forwarding). The backend only reads Tailscale's status and flags
 *    what would silently break access later (key expiry, unattended mode,
 *    firewall) — see backend/services/remoteAccess/TailscaleService.js.
 *  - Same Wi-Fi: direct LAN address.
 *  - Security: optional PIN and signed-in devices. Only the machine's own
 *    screen (operator) may change these; remote viewers see them read-only.
 */
import { useEffect, useRef, useState } from 'react';
import {
    AlertTriangle, Check, Copy, ExternalLink, Globe, Info, Lock, RefreshCw,
    ShieldAlert, ShieldCheck, Smartphone, Unlock, Wifi, XCircle,
} from 'lucide-react';
import { remote, RemoteInfo, RemoteSession, TailscaleStatus, TailscaleWarning } from './api';

const POLL_MS = 10000;

const TS_PILL: Record<TailscaleStatus['state'], { cls: string; label: string }> = {
    running: { cls: 'ok', label: 'Connected' },
    'needs-login': { cls: 'fail', label: 'Signed out' },
    stopped: { cls: 'fail', label: 'Disconnected' },
    'service-stopped': { cls: 'fail', label: 'Service stopped' },
    starting: { cls: 'warn', label: 'Starting' },
    'not-installed': { cls: 'warn', label: 'Not set up' },
    error: { cls: 'fail', label: 'Error' },
};

function timeAgo(ms: number): string {
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    return `${Math.floor(s / 86400)} d ago`;
}

export default function SectionRemoteAccess() {
    const [info, setInfo] = useState<RemoteInfo | null>(null);
    const [ts, setTs] = useState<TailscaleStatus | null>(null);
    const [sessions, setSessions] = useState<RemoteSession[]>([]);
    const [qr, setQr] = useState<Record<string, string>>({});
    const [pinDraft, setPinDraft] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [copied, setCopied] = useState<string | null>(null);
    const qrRequested = useRef(new Set<string>());

    const operator = !!info?.operator;
    const minPin = info?.minPinLength ?? 6;

    async function load(refreshTailscale = false) {
        const [i, t] = await Promise.all([remote.info(), remote.tailscale(refreshTailscale)]);
        setInfo(i);
        setTs(t);
        if (i.operator) {
            const s = await remote.sessions().catch(() => null);
            if (s) setSessions(s.sessions);
        }
    }

    useEffect(() => {
        load().catch((err) => setError(err instanceof Error ? err.message : String(err)));
        // Background polls stay quiet; a failed manual refresh reports.
        const timer = setInterval(() => { load().catch(() => {}); }, POLL_MS);
        return () => clearInterval(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const tsUrl = ts?.state === 'running' ? ts.url : null;
    const lanUrl = info?.lanUrl ?? null;

    useEffect(() => {
        for (const url of [tsUrl, lanUrl]) {
            if (!url || qrRequested.current.has(url)) continue;
            qrRequested.current.add(url);
            remote.qr(url)
                .then((r) => setQr((prev) => ({ ...prev, [url]: r.dataUrl })))
                .catch(() => qrRequested.current.delete(url));
        }
    }, [tsUrl, lanUrl]);

    async function run(action: () => Promise<unknown>, success?: string) {
        setBusy(true);
        setError(null);
        setNotice(null);
        try {
            await action();
            if (success) setNotice(success);
            await load(true);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    }

    function copy(text: string) {
        navigator.clipboard?.writeText(text).catch(() => {});
        setCopied(text);
        setTimeout(() => setCopied((c) => (c === text ? null : c)), 2000);
    }

    function savePin() {
        const pin = pinDraft.trim();
        if (pin.length < minPin) {
            setError(`PIN must be at least ${minPin} characters`);
            return;
        }
        run(async () => {
            await remote.setPin(pin);
            setPinDraft('');
        }, info?.pinSet
            ? 'PIN changed. Every remote device has been signed out and must enter the new PIN.'
            : 'PIN set. Remote devices must now enter it before they can see or move the machine.');
    }

    function removePin() {
        if (!confirm('Remove the PIN? Anyone who can reach this PC over Wi-Fi or Tailscale will be able to control the machine.')) return;
        run(() => remote.clearPin(), 'PIN removed. Remote devices can connect without one.');
    }

    function disconnectAll() {
        if (!confirm('Sign out every remote device now?')) return;
        run(() => remote.revokeSessions(), 'All remote devices were signed out.');
    }

    function renderWarning(w: TailscaleWarning) {
        const Icon = w.level === 'error' ? XCircle : w.level === 'warn' ? AlertTriangle : Info;
        return (
            <div key={`${w.code}:${w.message}`} className={`ra-alert ${w.level}`}>
                <Icon size={15} />
                <div className="ra-alert-body">
                    <span>{w.message}</span>
                    {w.action?.url && (
                        <a className="settings-btn" href={w.action.url} target="_blank" rel="noreferrer">
                            <ExternalLink size={13} /> {w.action.label}
                        </a>
                    )}
                    {w.action?.fix === 'firewall' && operator && (
                        <button
                            className="settings-btn"
                            disabled={busy}
                            onClick={() => run(() => remote.fixFirewall(), 'Firewall setup opened. Approve the administrator prompt on this PC.')}
                        >
                            <ShieldCheck size={13} /> {w.action.label}
                        </button>
                    )}
                </div>
            </div>
        );
    }

    function renderQr(url: string, note: string) {
        return (
            <div className="wa-qr-block ra-qr">
                <div className="ra-qr-text">
                    <div className="ra-url">{url}</div>
                    <div className="wa-qr-note">{note}</div>
                    <div className="ra-actions">
                        <button className="settings-btn" onClick={() => copy(url)}>
                            {copied === url ? <Check size={14} /> : <Copy size={14} />}
                            {copied === url ? 'Copied' : 'Copy link'}
                        </button>
                    </div>
                </div>
                {qr[url] && <img src={qr[url]} alt={`QR code for ${url}`} className="wa-qr-img" />}
            </div>
        );
    }

    const pill = ts ? TS_PILL[ts.state] : null;
    const onlinePeers = (ts?.peers ?? []).slice().sort((a, b) => Number(b.online) - Number(a.online));

    return (
        <div className="settings-section">
            <header className="settings-section-header">
                <div>
                    <div className="settings-section-title">
                        <Smartphone size={18} /> Remote access
                    </div>
                    <div className="settings-section-sub">
                        Control this machine from a phone or tablet: on the same Wi-Fi, or from anywhere through Tailscale.
                    </div>
                </div>
                <div className="settings-section-actions">
                    <button className="settings-btn" onClick={() => run(() => Promise.resolve())} disabled={busy}>
                        <RefreshCw size={14} /> Refresh
                    </button>
                </div>
            </header>

            {error && <div className="settings-error">{error}</div>}
            {info?.deviceIdentityUnavailable && (
                <div className="ra-alert warn" role="alert">
                    <AlertTriangle size={15} />
                    <div className="ra-alert-body">
                        The machine identity file cannot be read. Remote and cloud features stay LAN-only until it
                        can; the backend keeps retrying. Local control of the machine is not affected.
                    </div>
                </div>
            )}
            {notice &&<div className="ra-alert info"><Check size={15} /><div className="ra-alert-body">{notice}</div></div>}

            {/* ─── Anywhere: Tailscale ─── */}
            <div className="wa-block">
                <div className="ra-title-row">
                    <div className="wa-block-title ra-title"><Globe size={16} /> From anywhere (Tailscale)</div>
                    {pill && <span className={`settings-pill ${pill.cls}`}>{pill.label}</span>}
                </div>
                <div className="wa-block-sub">
                    A private, end-to-end encrypted link between this PC and your own devices. It works over 5G and any
                    Wi-Fi without port forwarding, and devices outside your Tailscale account cannot reach the machine.
                </div>

                {!ts && <div className="wa-empty">Checking Tailscale…</div>}

                {ts?.state === 'not-installed' && (
                    <ol className="ra-steps">
                        <li>
                            Install Tailscale on this PC and sign in.{' '}
                            <a className="ra-link" href={ts.downloadUrl || 'https://tailscale.com/download'} target="_blank" rel="noreferrer">
                                Download Tailscale <ExternalLink size={11} />
                            </a>
                        </li>
                        <li>In the Tailscale tray menu, enable <strong>Preferences → Run unattended</strong> so it stays connected when you sign out of Windows.</li>
                        <li>Install the Tailscale app on your phone and sign in with the <strong>same account</strong>.</li>
                        <li>Come back here. The QR code for your phone appears automatically.</li>
                    </ol>
                )}

                {ts?.state === 'error' && ts.error && (
                    <div className="ra-alert error"><XCircle size={15} /><div className="ra-alert-body">{ts.error}</div></div>
                )}

                {tsUrl && renderQr(tsUrl, 'Scan with a phone that has the Tailscale app connected. This address stays the same.')}

                {ts?.state === 'running' && ts.dnsUrl && (
                    <div className="wa-block-sub">
                        Also works by name: <code>{ts.dnsUrl}</code>
                    </div>
                )}

                {ts?.state === 'running' && onlinePeers.length > 0 && (
                    <>
                        <div className="ra-label">Your Tailscale devices{ts.tailnet ? ` · ${ts.tailnet}` : ''}</div>
                        <div className="ra-list">
                            {onlinePeers.map((p) => (
                                <div key={`${p.name}:${p.ip}`} className="ra-row">
                                    <span className={`ra-dot ${p.online ? 'on' : ''}`} />
                                    <div className="ra-row-main">
                                        <span className="ra-row-name">{p.name}</span>
                                        <span className="ra-row-meta">{[p.os, p.ip, p.online ? 'online' : 'offline'].filter(Boolean).join(' · ')}</span>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </>
                )}

                {ts && ts.warnings.length > 0 && <div className="ra-alerts">{ts.warnings.map(renderWarning)}</div>}
            </div>

            {/* ─── Same Wi-Fi ─── */}
            <div className="wa-block">
                <div className="ra-title-row">
                    <div className="wa-block-title ra-title"><Wifi size={16} /> On the same Wi-Fi</div>
                    {lanUrl && <span className="settings-pill ok">Available</span>}
                </div>
                <div className="wa-block-sub">Phones and tablets on the same network as this PC can open this address directly.</div>
                {lanUrl
                    ? renderQr(lanUrl, 'Scan with a phone on the same Wi-Fi as this PC.')
                    : info && <div className="wa-empty">This PC has no local network address right now.</div>}
                {(info?.lanUrls?.length ?? 0) > 1 && (
                    <div className="wa-block-sub">
                        Other addresses: {info!.lanUrls!.slice(1).map((u) => <code key={u} style={{ marginRight: 6 }}>{u}</code>)}
                    </div>
                )}
            </div>

            {/* ─── Security ─── */}
            <div className="wa-block">
                <div className="ra-title-row">
                    <div className="wa-block-title ra-title"><Lock size={16} /> PIN and signed-in devices</div>
                    {info && (
                        <span className="ra-title">
                            {info.pinSource === 'access-code' && (
                                <span className="settings-pill ok">Access code is the PIN (see Cloud access)</span>
                            )}
                            <span className={`settings-pill ${info.pinSet ? 'ok' : 'fail'}`}>
                                {info.pinSet ? 'PIN on' : 'No PIN'}
                            </span>
                        </span>
                    )}
                </div>
                <div className="wa-block-sub">
                    Remote devices must enter the PIN before they can see or move the machine. This PC's own screen never needs it.
                    After 5 wrong tries a device is locked out for 15 minutes.
                </div>

                {info && !info.pinSet && (
                    <div className="ra-alert warn">
                        <ShieldAlert size={15} />
                        <div className="ra-alert-body">
                            Without a PIN, anyone who can reach this PC over Wi-Fi or Tailscale can control the machine. Set one before using remote access.
                        </div>
                    </div>
                )}

                {operator ? (
                    <>
                        <div className="wa-add-row ra-pin-row">
                            <input
                                type="password"
                                inputMode="numeric"
                                autoComplete="new-password"
                                className="wa-input"
                                placeholder={`${info?.pinSet ? 'New PIN' : 'PIN'} (at least ${minPin} characters)`}
                                value={pinDraft}
                                onChange={(e) => setPinDraft(e.target.value)}
                                onKeyDown={(e) => { if (e.key === 'Enter') savePin(); }}
                                disabled={busy}
                            />
                            <button className="settings-btn primary" onClick={savePin} disabled={busy || pinDraft.trim().length < minPin}>
                                <Lock size={14} /> {info?.pinSet ? 'Change PIN' : 'Set PIN'}
                            </button>
                            {info?.pinSet && (
                                <button className="settings-btn danger" onClick={removePin} disabled={busy}>
                                    <Unlock size={14} /> Remove PIN
                                </button>
                            )}
                        </div>

                        {info?.pinSet && (
                            <>
                                <div className="ra-title-row ra-label-row">
                                    <div className="ra-label">Signed-in devices ({sessions.length})</div>
                                    {sessions.length > 0 && (
                                        <button className="settings-btn danger" onClick={disconnectAll} disabled={busy}>
                                            Sign out all
                                        </button>
                                    )}
                                </div>
                                {sessions.length === 0 ? (
                                    <div className="wa-empty">No remote devices are signed in.</div>
                                ) : (
                                    <div className="ra-list">
                                        {sessions.map((s) => (
                                            <div key={s.id} className="ra-row">
                                                {s.via === 'tailscale' ? <Globe size={14} /> : <Wifi size={14} />}
                                                <div className="ra-row-main">
                                                    <span className="ra-row-name">{s.device}</span>
                                                    <span className="ra-row-meta">
                                                        {s.via === 'tailscale' ? 'Tailscale' : 'Wi-Fi'} · {s.ip} · active {timeAgo(s.lastSeen)}
                                                    </span>
                                                </div>
                                                <button
                                                    className="settings-btn"
                                                    disabled={busy}
                                                    onClick={() => run(() => remote.revokeSession(s.id), `${s.device} was signed out.`)}
                                                >
                                                    Sign out
                                                </button>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </>
                        )}
                    </>
                ) : (
                    info && <div className="wa-empty">The PIN and signed-in devices can only be changed on the machine's own screen.</div>
                )}

                <div className="ra-alert info">
                    <AlertTriangle size={15} />
                    <div className="ra-alert-body">
                        A phone is not an emergency stop. Only move the machine remotely when you can see it, and keep the physical E-stop within reach.
                    </div>
                </div>
            </div>
        </div>
    );
}
