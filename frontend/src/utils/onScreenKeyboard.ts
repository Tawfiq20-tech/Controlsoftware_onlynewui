/**
 * On-screen keyboard preference.
 *
 * The kiosk has no physical keyboard, so the virtual one is ON by default.
 * Anyone running the app on a desktop with a real keyboard can turn it off in
 * Settings -> Appearance; the choice is remembered on this browser.
 */

const STORAGE_KEY = 'cnc.onScreenKeyboard';
const EVENT = 'cnc:osk-pref';

export function isOskEnabled(): boolean {
    try {
        return localStorage.getItem(STORAGE_KEY) !== 'off';
    } catch (_) {
        return true;
    }
}

export function setOskEnabled(on: boolean): void {
    try {
        localStorage.setItem(STORAGE_KEY, on ? 'on' : 'off');
    } catch (_) {
        /* private mode: the keyboard still works, it just won't be remembered */
    }
    window.dispatchEvent(new CustomEvent<boolean>(EVENT, { detail: on }));
}

export function onOskPrefChange(cb: (on: boolean) => void): () => void {
    const handler = (e: Event) => cb((e as CustomEvent<boolean>).detail);
    window.addEventListener(EVENT, handler);
    return () => window.removeEventListener(EVENT, handler);
}
