/**
 * Keeps appPreferences on the machine instead of in the browser tab.
 *
 * The store held these in memory only: nothing read them back at start-up and
 * nothing ever wrote them down. Every setting the operator chose -- units,
 * safe height, jog defaults, outline style -- was forgotten the moment the
 * kiosk restarted, which made the mm/inch toggle look broken (it worked, it
 * just went back to mm on the next boot) and meant machine settings had to be
 * entered again every session.
 *
 * The backend already stored them: config.json has had a `preferences` key all
 * along, and /api/config reads and writes it. This is the missing wire.
 *
 * Saving to the machine rather than to localStorage is deliberate: the pendant
 * and a phone on remote access then agree, and settings survive the browser
 * profile being cleared.
 */
import { useEffect, useRef } from 'react';
import { config } from '../components/Settings/api';
import { useCNCStore } from '../stores/cncStore';
import type { AppPreferences } from '../types/cnc';

/** Coalesce the bursts a slider or a stepper produces into one write. */
const SAVE_DEBOUNCE_MS = 600;

export function usePersistedPreferences() {
    const appPreferences = useCNCStore((s) => s.appPreferences);
    const setAppPreferences = useCNCStore((s) => s.setAppPreferences);

    /** Until the stored values are in, saving would write the defaults over them. */
    const loaded = useRef(false);
    const timer = useRef<number | null>(null);

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const { value } = await config.get('preferences');
                if (cancelled || !value || typeof value !== 'object') return;
                // Stored values win, but anything the app has added since is
                // kept at its default rather than coming back undefined.
                setAppPreferences((prev) => ({ ...prev, ...(value as Partial<AppPreferences>) }));
            } catch (_) {
                // Backend not up yet, or not permitted: carry on with defaults
                // in memory. The next change still tries to save.
            } finally {
                if (!cancelled) loaded.current = true;
            }
        })();
        return () => { cancelled = true; };
    }, [setAppPreferences]);

    useEffect(() => {
        if (!loaded.current) return;
        if (timer.current !== null) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => {
            timer.current = null;
            void config.set('preferences', appPreferences).catch(() => {
                // A read-only (non-operator) client just keeps its own view.
            });
        }, SAVE_DEBOUNCE_MS);
        return () => {
            if (timer.current !== null) window.clearTimeout(timer.current);
        };
    }, [appPreferences]);
}
