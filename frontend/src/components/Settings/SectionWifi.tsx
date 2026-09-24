/**
 * SectionWifi — join the machine to a Wi-Fi network from the touchscreen.
 *
 * The kiosk has no desktop, so this is the only way to put it on a network
 * after it is moved. The backend refuses all of it to anyone but the operator
 * at the machine's own screen, so a remote phone cannot re-point the Wi-Fi and
 * cut off the link it is talking over.
 *
 * The password field is an ordinary <input>, so the app-wide on-screen
 * keyboard (components/OnScreenKeyboard) opens on it automatically.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
    Wifi, WifiOff, RefreshCw, Lock, Globe, Check, AlertTriangle, Cable, Eye, EyeOff, X,
} from 'lucide-react';
import { wifi, WifiNetwork, WifiStatus } from './api';

/** Four bars, filled by nmcli's 0-100 signal strength. */
function SignalBars({ signal }: { signal: number }) {
    const bars = signal >= 75 ? 4 : signal >= 50 ? 3 : signal >= 25 ? 2 : 1;
    return (
        <span className="wifi-bars" title={`Signal ${signal}%`}>
            {[1, 2, 3, 4].map((i) => (
                <span key={i} className={`wifi-bar ${i <= bars ? 'on' : ''}`} style={{ height: 4 + i * 3 }} />
            ))}
        </span>
    );
}

export default function SectionWifi() {
    const [status, setStatus] = useState<WifiStatus | null>(null);
    const [networks, setNetworks] = useState<WifiNetwork[]>([]);
    const [scanning, setScanning] = useState(false);
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);

    // The network awaiting a password, and the password being typed for it.
    const [pending, setPending] = useState<WifiNetwork | null>(null);
    // A hidden network is typed in by name: scan() cannot list one (nmcli
    // reports an empty SSID for it), and this component used to pass hidden
    // false with no way to enter an SSID, so such a shop could not be joined
    // at all from the only Wi-Fi setup path the machine has.
    const [hiddenSsid, setHiddenSsid] = useState<string | null>(null);
    const [password, setPassword] = useState('');
    const [showPassword, setShowPassword] = useState(false);
    const passwordRef = useRef<HTMLInputElement | null>(null);

    const refreshStatus = useCallback(async () => {
        try {
            setStatus(await wifi.status());
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not read the Wi-Fi status.');
        }
    }, []);

    const scan = useCallback(async (rescan = true) => {
        setScanning(true);
        setError(null);
        try {
            const result = await wifi.scan(rescan);
            if (result.ok) setNetworks(result.networks);
            else setError(result.error || 'Could not scan for networks.');
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not scan for networks.');
        } finally {
            setScanning(false);
        }
    }, []);

    useEffect(() => {
        void (async () => {
            // Do NOT swallow this. A 403 (operator cookie not claimed yet) left
            // status null, and the page then rendered "No networks found. Move
            // closer to the router" -- pointing the operator at the router when
            // the real problem was authorization.
            const s = await wifi.status().catch((e) => {
                setError(e instanceof Error ? e.message : 'Could not read the Wi-Fi status.');
                return null;
            });
            setStatus(s);
            if (s?.supported && s.radioOn) void scan(true);
        })();
    }, [scan]);

    // Focus the password box as soon as it appears so the on-screen keyboard
    // comes up with it, instead of needing a second tap.
    useEffect(() => {
        if (pending) passwordRef.current?.focus();
    }, [pending]);

    async function join(network: WifiNetwork, secret?: string) {
        setBusy(network.ssid);
        setError(null);
        setNotice(null);
        try {
            const result = await wifi.connect(network.ssid, secret, !!network.hidden);
            if (result.ok) {
                setNotice(`Connected to "${network.ssid}".`);
                setPending(null);
                setPassword('');
                await refreshStatus();
                await scan(false);
            } else {
                setError(result.error || `Could not connect to "${network.ssid}".`);
                // Keep the sheet open so the password can be corrected --
                // INCLUDING for a saved network. When the shop changes its key
                // the stale profile still marks the network saved, so this used
                // to fail for ever with the same message and no way to type the
                // new password short of finding the small "Forget" button first.
                if (!network.open && !network.hidden) setPending(network);
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not connect.');
        } finally {
            setBusy(null);
        }
    }

    function pick(network: WifiNetwork) {
        setNotice(null);
        setError(null);
        // Open networks and ones we already hold the key for need no prompt.
        if (network.open || network.saved) {
            void join(network);
            return;
        }
        setPassword('');
        setShowPassword(false);
        setPending(network);
    }

    async function act(label: string, fn: () => Promise<{ ok: boolean; error?: string }>, done: string) {
        setBusy(label);
        setError(null);
        setNotice(null);
        try {
            const result = await fn();
            if (result.ok) {
                setNotice(done);
                await refreshStatus();
                await scan(false);
            } else {
                setError(result.error || 'That did not work.');
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : 'That did not work.');
        } finally {
            setBusy(null);
        }
    }

    const header = (
        <header className="settings-section-header">
            <div className="settings-section-title">
                <Wifi size={18} /> Wi-Fi
            </div>
        </header>
    );

    if (status && !status.supported) {
        return (
            <div className="settings-section">
                {header}
                <div className="wifi-empty">
                    <WifiOff size={40} style={{ color: 'var(--text-dim)' }} />
                    <p>{status.reason}</p>
                </div>
            </div>
        );
    }

    const connected = status?.connected ?? null;

    return (
        <div className="settings-section">
            {header}

            {/* ── What we are on right now ── */}
            <div className={`wifi-current ${connected ? 'on' : ''}`}>
                <div className="wifi-current-icon">
                    {connected ? <Wifi size={22} /> : <WifiOff size={22} />}
                </div>
                <div className="wifi-current-text">
                    <div className="wifi-current-ssid">
                        {connected ? connected.ssid : 'Not connected to Wi-Fi'}
                    </div>
                    <div className="wifi-current-sub">
                        {connected
                            ? `${connected.security || 'Open'}${connected.signal ? ` · signal ${connected.signal}%` : ''}`
                            : status?.hasAdapter === false
                                ? 'No Wi-Fi adapter found on this machine'
                                : 'Pick a network below to get online'}
                        {status?.ethernet?.connected && (
                            <span className="wifi-eth"><Cable size={13} /> Ethernet is connected</span>
                        )}
                    </div>
                    {!!status?.addresses?.length && (
                        <div className="wifi-addrs">Reachable at {status.addresses.join(', ')}</div>
                    )}
                </div>
                <div className="wifi-current-actions">
                    <button
                        className="settings-btn"
                        onClick={() => act('radio', () => wifi.radio(!status?.radioOn), status?.radioOn ? 'Wi-Fi turned off.' : 'Wi-Fi turned on.')}
                        disabled={busy !== null}
                    >
                        {status?.radioOn ? 'Turn Wi-Fi off' : 'Turn Wi-Fi on'}
                    </button>
                    {connected && (
                        <button
                            className="settings-btn"
                            onClick={() => act('disconnect', () => wifi.disconnect(), 'Disconnected.')}
                            disabled={busy !== null}
                        >
                            Disconnect
                        </button>
                    )}
                </div>
            </div>

            {notice && <div className="wifi-banner ok"><Check size={15} /> {notice}</div>}
            {error && <div className="wifi-banner bad"><AlertTriangle size={15} /> {error}</div>}

            {/* ── Password prompt for the chosen network ── */}
            {pending && (
                <div className="wifi-ask">
                    <div className="wifi-ask-head">
                        <Lock size={15} />
                        <span>Password for <b>{pending.ssid}</b></span>
                        <button
                            className="wifi-ask-close"
                            onClick={() => { setPending(null); setPassword(''); }}
                            aria-label="Cancel"
                        >
                            <X size={16} />
                        </button>
                    </div>
                    <div className="wifi-ask-row">
                        <input
                            ref={passwordRef}
                            type={showPassword ? 'text' : 'password'}
                            className="wa-input wifi-ask-input"
                            value={password}
                            placeholder="Network password"
                            autoComplete="off"
                            onChange={(e) => setPassword(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter' && password.length >= 8) void join(pending, password); }}
                        />
                        <button
                            className="settings-btn"
                            onClick={() => setShowPassword((v) => !v)}
                            aria-label={showPassword ? 'Hide password' : 'Show password'}
                        >
                            {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                        </button>
                        <button
                            className="settings-btn primary"
                            onClick={() => void join(pending, password)}
                            disabled={password.length < 8 || busy !== null}
                        >
                            {busy === pending.ssid ? 'Connecting…' : 'Connect'}
                        </button>
                    </div>
                    <div className="wifi-ask-hint">
                        Wi-Fi passwords are at least 8 characters. Tap the box to bring up the keyboard.
                    </div>
                </div>
            )}

            {/* ── A network that does not broadcast its name ── */}
            {hiddenSsid !== null && (
                <div className="wifi-ask">
                    <div className="wifi-ask-head">
                        <Lock size={15} />
                        <span>Join a hidden network</span>
                        <button
                            className="wifi-ask-close"
                            onClick={() => { setHiddenSsid(null); setPassword(''); }}
                            aria-label="Cancel"
                        >
                            <X size={16} />
                        </button>
                    </div>
                    <div className="wifi-ask-row">
                        <input
                            type="text"
                            className="wa-input wifi-ask-input"
                            value={hiddenSsid}
                            placeholder="Network name (SSID)"
                            autoComplete="off"
                            onChange={(e) => setHiddenSsid(e.target.value)}
                        />
                    </div>
                    <div className="wifi-ask-row">
                        <input
                            type={showPassword ? 'text' : 'password'}
                            className="wa-input wifi-ask-input"
                            value={password}
                            placeholder="Network password"
                            autoComplete="off"
                            onChange={(e) => setPassword(e.target.value)}
                        />
                        <button
                            className="settings-btn"
                            onClick={() => setShowPassword((v) => !v)}
                            aria-label={showPassword ? 'Hide password' : 'Show password'}
                        >
                            {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                        </button>
                        <button
                            className="settings-btn primary"
                            onClick={() => {
                                const ssid = hiddenSsid.trim();
                                if (!ssid) return;
                                void join(
                                    { ssid, signal: 0, security: 'WPA2', open: false, inUse: false, saved: false, hidden: true },
                                    password,
                                );
                            }}
                            disabled={!hiddenSsid.trim() || password.length < 8 || busy !== null}
                        >
                            {busy === hiddenSsid.trim() ? 'Connecting…' : 'Connect'}
                        </button>
                    </div>
                    <div className="wifi-ask-hint">
                        Type the name exactly as the router has it -- capitals count.
                    </div>
                </div>
            )}

            {/* ── Networks in range ── */}
            <div className="wifi-list-head">
                <span>Networks in range</span>
                <button
                    className="settings-btn"
                    onClick={() => { setNotice(null); setError(null); setPending(null); setPassword(''); setHiddenSsid(''); }}
                    disabled={busy !== null}
                >
                    Hidden network
                </button>
                <button className="settings-btn" onClick={() => void scan(true)} disabled={scanning || busy !== null}>
                    <RefreshCw size={14} className={scanning ? 'spin' : ''} /> {scanning ? 'Scanning…' : 'Scan again'}
                </button>
            </div>

            {status?.radioOn === false ? (
                <div className="wifi-empty"><WifiOff size={32} /><p>Wi-Fi is switched off.</p></div>
            ) : networks.length === 0 ? (
                <div className="wifi-empty">
                    <Globe size={32} style={{ color: 'var(--text-dim)' }} />
                    <p>{scanning ? 'Looking for networks…' : 'No networks found. Move closer to the router and scan again.'}</p>
                </div>
            ) : (
                <div className="wifi-list">
                    {networks.map((n) => (
                        <div key={n.ssid} className={`wifi-row ${n.inUse ? 'on' : ''}`}>
                            <button className="wifi-row-main" onClick={() => pick(n)} disabled={busy !== null}>
                                <SignalBars signal={n.signal} />
                                <span className="wifi-row-ssid">{n.ssid}</span>
                                {!n.open && <Lock size={13} className="wifi-row-lock" />}
                                {n.saved && !n.inUse && <span className="wifi-tag">Saved</span>}
                                {n.inUse && <span className="wifi-tag on"><Check size={12} /> Connected</span>}
                                {busy === n.ssid && <span className="wifi-tag">Connecting…</span>}
                            </button>
                            {n.saved && (
                                <button
                                    className="wifi-row-forget"
                                    onClick={() => act(n.ssid, () => wifi.forget(n.ssid), `Forgot "${n.ssid}".`)}
                                    disabled={busy !== null}
                                    title="Forget this network so it is not joined automatically"
                                >
                                    Forget
                                </button>
                            )}
                        </div>
                    ))}
                </div>
            )}

            <div className="wifi-foot">
                Wi-Fi can only be changed here, on the machine&rsquo;s own screen &mdash; not from a phone
                or another computer, which would cut off the connection it is using.
            </div>
        </div>
    );
}
