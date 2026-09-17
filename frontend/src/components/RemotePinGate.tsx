/**
 * RemotePinGate — app-root gate for the optional PIN feature
 * (backend/services/remoteAccess/RemoteAccessService.js).
 *
 * The backend decides: /api/remote/info reports `authorized` for the
 * control PC itself, when no PIN is set, or for a valid session (header
 * token or session cookie). Only an unauthorized remote client sees the
 * PIN screen. This is UX only — the backend gates every request itself.
 */
import { useEffect, useState } from 'react';
import { Lock } from 'lucide-react';
import { getRemoteToken, setRemoteToken, clearRemoteToken } from '../utils/remoteAuth';
import { disconnectBackendSocket, REMOTE_SESSION_ENDED_EVENT } from '../utils/backendConnection';
import './RemotePinGate.css';

const getBackendBase = (): string => {
    const env = (import.meta as unknown as { env?: { VITE_API_URL?: string } }).env?.VITE_API_URL;
    if (env) return String(env).replace(/\/$/, '');
    if (typeof window !== 'undefined') {
        const { protocol, hostname, port, origin } = window.location;
        if (port === '5173') return `${protocol}//${hostname}:4000`;
        if (port === '4000') return `${protocol}//${hostname}:4000`;
        return origin;
    }
    return 'http://localhost:4000';
};

type GateState = 'checking' | 'open' | 'needs-pin';

export default function RemotePinGate({ children }: { children: React.ReactNode }) {
    const [state, setState] = useState<GateState>('checking');
    const [pin, setPin] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => { check(); }, []);

    // The backend ended this client's socket (revoked session, PIN changed).
    // Drop the dead socket, unmount the app while re-checking, and show the
    // PIN screen if the session is gone; the app reconnects when it remounts.
    useEffect(() => {
        const onEnded = () => {
            disconnectBackendSocket();
            setState('checking');
            check();
        };
        window.addEventListener(REMOTE_SESSION_ENDED_EVENT, onEnded);
        return () => window.removeEventListener(REMOTE_SESSION_ENDED_EVENT, onEnded);
    }, []);

    async function check() {
        const base = getBackendBase();
        try {
            const token = getRemoteToken();
            const infoRes = await fetch(`${base}/api/remote/info`, {
                headers: token ? { 'X-Remote-Token': token } : {},
            });
            const info = await infoRes.json();
            if (info.authorized) { setState('open'); return; }
            // Stale or revoked token: drop it and ask again.
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
            // The app (and its socket) only mounts after this, so it starts
            // with the session token and cookie already in place.
            setState('open');
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
            {children}
        </>
    );
}
