/**
 * RemotePinGate — app-root gate for the optional PIN feature
 * (backend/services/remoteAccess/RemoteAccessService.js).
 *
 * On the control PC itself this is invisible: loopback requests are never
 * gated server-side, so the one probe call below always succeeds and the
 * app renders immediately, no matter whether a PIN is set.
 *
 * On a remote LAN client, once a PIN has been set from the control PC's
 * Settings panel, this blocks rendering behind a PIN-entry screen until a
 * valid session token is obtained and cached (see utils/remoteAuth.ts).
 * A small reliability banner stays visible for the rest of the session as
 * a reminder that E-Stop lives at the machine, not on the phone screen.
 */
import { useEffect, useState } from 'react';
import { AlertTriangle, Lock } from 'lucide-react';
import { getRemoteToken, setRemoteToken, clearRemoteToken } from '../utils/remoteAuth';
import './RemotePinGate.css';

const getBackendBase = (): string => {
    const env = (import.meta as unknown as { env?: { VITE_API_URL?: string } }).env?.VITE_API_URL;
    if (env) return String(env).replace(/\/$/, '');
    if (typeof window !== 'undefined') {
        const { protocol, hostname } = window.location;
        return `${protocol}//${hostname}:4000`;
    }
    return 'http://localhost:4000';
};

type GateState = 'checking' | 'open' | 'needs-pin' | 'remote-session';

export default function RemotePinGate({ children }: { children: React.ReactNode }) {
    const [state, setState] = useState<GateState>('checking');
    const [pin, setPin] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => { check(); }, []);

    async function check() {
        const base = getBackendBase();
        try {
            const infoRes = await fetch(`${base}/api/remote/info`);
            const info = await infoRes.json();
            if (!info.pinSet) { setState('open'); return; }

            const token = getRemoteToken();
            if (!token) { setState('needs-pin'); return; }

            // Loopback always passes regardless of token; a stale/wrong
            // remote token gets a real 401 here and falls back to the PIN
            // screen instead of silently rendering a half-broken app.
            const probe = await fetch(`${base}/api/state`, { headers: { 'X-Remote-Token': token } });
            if (probe.ok) { setState('remote-session'); return; }
            clearRemoteToken();
            setState('needs-pin');
        } catch (_) {
            // Backend unreachable -- let the rest of the app's own
            // connection-status UI surface that instead of hard-blocking here.
            setState('open');
        }
    }

    async function submitPin() {
        if (!pin.trim() || busy) return;
        setBusy(true); setError(null);
        try {
            const base = getBackendBase();
            const r = await fetch(`${base}/api/remote/verify-pin`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pin: pin.trim() }),
            });
            const data = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(data.error || 'Incorrect PIN');
            setRemoteToken(data.token);
            setPin('');
            setState('remote-session');
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    }

    if (state === 'checking') return null;

    if (state === 'needs-pin') {
        return (
            <div className="remote-pin-screen">
                <div className="remote-pin-card">
                    <Lock size={28} />
                    <h2>PIN required</h2>
                    <p>This machine's control software is protected. Enter the PIN set on the control PC.</p>
                    <input
                        type="password"
                        inputMode="numeric"
                        className="remote-pin-input"
                        placeholder="PIN"
                        value={pin}
                        onChange={(e) => setPin(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') submitPin(); }}
                        autoFocus
                        disabled={busy}
                    />
                    {error && <div className="remote-pin-error">{error}</div>}
                    <button className="remote-pin-btn" onClick={submitPin} disabled={busy || !pin.trim()}>
                        {busy ? 'Checking…' : 'Connect'}
                    </button>
                </div>
            </div>
        );
    }

    return (
        <>
            {state === 'remote-session' && (
                <div className="remote-session-banner">
                    <AlertTriangle size={14} />
                    Remote session — E-Stop stays at the machine, not on this screen.
                </div>
            )}
            {children}
        </>
    );
}
