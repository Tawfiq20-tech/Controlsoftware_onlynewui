/**
 * Theme helpers — single source of truth for the active CSS theme.
 *
 * - Reads/writes localStorage key `cnc.theme`
 * - Sets `data-theme` on <html>
 * - Fires `window` event `cnc:theme` after every change, so non-React
 *   consumers (Three.js scenes) can re-color themselves without a remount.
 *
 * Themes:
 *   'dark'  — Desert Sandstone w/ orange accent (default)
 *   'light' — Pebble Track cream w/ brown accent
 */

export type ThemeId = 'dark' | 'light';

const STORAGE_KEY = 'cnc.theme';
const EVENT_NAME = 'cnc:theme';
const DEFAULT_THEME: ThemeId = 'dark';

export function getStoredTheme(): ThemeId {
    if (typeof window === 'undefined') return DEFAULT_THEME;
    const v = window.localStorage?.getItem(STORAGE_KEY);
    return v === 'light' || v === 'dark' ? v : DEFAULT_THEME;
}

export function applyStoredTheme(): void {
    setTheme(getStoredTheme(), { broadcast: false, persist: false });
}

export function setTheme(theme: ThemeId, opts: { broadcast?: boolean; persist?: boolean } = {}): void {
    const { broadcast = true, persist = true } = opts;
    if (typeof document !== 'undefined') {
        document.documentElement.setAttribute('data-theme', theme);
    }
    if (persist && typeof window !== 'undefined') {
        window.localStorage?.setItem(STORAGE_KEY, theme);
    }
    if (broadcast && typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent<ThemeId>(EVENT_NAME, { detail: theme }));
    }
}

export function onThemeChange(handler: (theme: ThemeId) => void): () => void {
    if (typeof window === 'undefined') return () => {};
    const listener = (e: Event) => {
        const detail = (e as CustomEvent<ThemeId>).detail;
        handler(detail || getStoredTheme());
    };
    window.addEventListener(EVENT_NAME, listener);
    return () => window.removeEventListener(EVENT_NAME, listener);
}

/**
 * Read a CSS variable as a Three.js hex number (0xRRGGBB).
 * Falls back to provided default if var is missing or unparsable.
 */
export function cssVarHex(name: string, fallback: number): number {
    if (typeof document === 'undefined') return fallback;
    const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    if (!raw) return fallback;
    const m = raw.match(/^#?([0-9a-fA-F]{6})$/);
    if (m) return parseInt(m[1], 16);
    const m3 = raw.match(/^#?([0-9a-fA-F]{3})$/);
    if (m3) {
        const [r, g, b] = m3[1].split('');
        return parseInt(r + r + g + g + b + b, 16);
    }
    return fallback;
}
