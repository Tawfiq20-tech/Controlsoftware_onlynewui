/**
 * Remote-access session token — obtained once by exchanging the PIN
 * (see RemotePinGate.tsx / Settings/SectionRemoteAccess.tsx), cached in
 * localStorage so a phone/tablet on the LAN doesn't need to re-enter the
 * PIN on every reload (matches backend's 12h token TTL).
 *
 * On the control PC itself this stays empty forever — loopback requests
 * are never gated, so no header is ever attached, matching the backend's
 * "local machine is never gated" design in RemoteAccessService.js.
 */
const STORAGE_KEY = 'easycnc.remoteToken';

export function getRemoteToken(): string | null {
    try {
        return localStorage.getItem(STORAGE_KEY);
    } catch (_) {
        return null;
    }
}

export function setRemoteToken(token: string): void {
    try {
        localStorage.setItem(STORAGE_KEY, token);
    } catch (_) { /* storage unavailable (private mode etc.) */ }
}

export function clearRemoteToken(): void {
    try {
        localStorage.removeItem(STORAGE_KEY);
    } catch (_) { /* storage unavailable */ }
}

/** Merge into a fetch() headers object. No-op (empty object) when no token is cached. */
export function remoteAuthHeaders(): Record<string, string> {
    const token = getRemoteToken();
    return token ? { 'X-Remote-Token': token } : {};
}
