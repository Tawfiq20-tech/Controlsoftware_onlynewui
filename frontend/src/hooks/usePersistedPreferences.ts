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
 * `preferences` is SHARED. The backend and other screens keep their own keys
 * in it -- spindle spin-up delay, jog speed and distance, probe feedrate and
 * thickness, the remote-diagnostics settings -- none of which the store knows
 * about. Two rules follow, and the first version of this hook broke both:
 *
 *   1. Never save before the stored values have actually been read. It used
 *      to mark itself loaded even when the read failed (backend not up yet),
 *      and the next change wrote the store's defaults over the real config.
 *      Now it retries the read until the backend answers.
 *   2. Never write the store's object on its own. Every save re-reads what the
 *      machine holds and merges onto it, so a key the store has never heard
 *      of survives untouched.
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
/** How often to retry the first read while the backend is still starting. */
const LOAD_RETRY_MS = 2000;

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

export function usePersistedPreferences() {
    const appPreferences = useCNCStore((s) => s.appPreferences);
    const setAppPreferences = useCNCStore((s) => s.setAppPreferences);

    /** Set only once the stored values have really been read (rule 1). */
    const loaded = useRef(false);
    const timer = useRef<number | null>(null);

    useEffect(() => {
        let cancelled = false;
        let retry: number | null = null;

        const load = async () => {
            try {
                const { value } = await config.get('preferences');
                if (cancelled) return;
                // Stored values win; anything the app has added since keeps its
                // default rather than coming back undefined. An absent key (a
                // brand-new machine) is a successful read with nothing in it.
                if (isPlainObject(value)) {
                    setAppPreferences((prev) => ({ ...prev, ...(value as Partial<AppPreferences>) }));
                }
                loaded.current = true;
            } catch (_) {
                // Backend not answering yet. Do NOT mark loaded: saving now
                // would write defaults over the machine's real settings.
                if (!cancelled) retry = window.setTimeout(load, LOAD_RETRY_MS);
            }
        };

        void load();
        return () => {
            cancelled = true;
            if (retry !== null) window.clearTimeout(retry);
        };
    }, [setAppPreferences]);

    useEffect(() => {
        if (!loaded.current) return;
        if (timer.current !== null) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => {
            timer.current = null;
            void (async () => {
                try {
                    // Rule 2: merge onto what the machine holds right now.
                    const { value } = await config.get('preferences');
                    const onMachine = isPlainObject(value) ? value : {};
                    await config.set('preferences', { ...onMachine, ...appPreferences });
                } catch (_) {
                    // Backend unreachable, or a client not allowed to write:
                    // keep this screen's own view; the next change tries again.
                }
            })();
        }, SAVE_DEBOUNCE_MS);
        return () => {
            if (timer.current !== null) window.clearTimeout(timer.current);
        };
    }, [appPreferences]);
}
