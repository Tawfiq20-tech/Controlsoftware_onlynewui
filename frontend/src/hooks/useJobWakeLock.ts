import { useEffect, useRef } from 'react';
import { useCNCStore } from '../stores/cncStore';

/**
 * Keeps the screen (and with it this machine) awake while a job is running.
 *
 * A 3-hour carve outlives the default Windows sleep timer. When the PC sleeps
 * the USB port is suspended, the controller stops hearing from the sender and
 * stops the machine on its own 5-second watchdog -- mid-cut, with the tool in
 * the material. The Screen Wake Lock API prevents that for the display-sleep
 * case, which is the one the app can control from inside the browser.
 *
 * The lock is dropped by the browser whenever the tab is hidden, so it is
 * re-acquired on visibilitychange for as long as the job is running.
 */
export function useJobWakeLock() {
    const jobActive = useCNCStore((s) => s.jobActive);
    const addConsoleLog = useCNCStore((s) => s.addConsoleLog);
    const sentinelRef = useRef<WakeLockSentinel | null>(null);
    const warnedRef = useRef(false);

    useEffect(() => {
        let cancelled = false;

        const release = () => {
            const s = sentinelRef.current;
            sentinelRef.current = null;
            if (s) s.release().catch(() => { /* already gone */ });
        };

        const acquire = async () => {
            if (!jobActive || cancelled || sentinelRef.current) return;
            if (!('wakeLock' in navigator)) {
                if (!warnedRef.current) {
                    warnedRef.current = true;
                    addConsoleLog('warning', 'This browser cannot keep the PC awake. Set Windows sleep to "Never" before long carves.');
                }
                return;
            }
            try {
                const sentinel = await navigator.wakeLock.request('screen');
                if (cancelled) {
                    sentinel.release().catch(() => {});
                    return;
                }
                sentinelRef.current = sentinel;
                sentinel.addEventListener('release', () => {
                    if (sentinelRef.current === sentinel) sentinelRef.current = null;
                });
            } catch (err) {
                if (!warnedRef.current) {
                    warnedRef.current = true;
                    addConsoleLog('warning', `Could not stop the PC sleeping during the job (${(err as Error).message}). Set Windows sleep to "Never" before long carves.`);
                }
            }
        };

        const onVisibility = () => {
            if (document.visibilityState === 'visible') void acquire();
        };

        if (jobActive) {
            void acquire();
            document.addEventListener('visibilitychange', onVisibility);
        } else {
            release();
        }

        return () => {
            cancelled = true;
            document.removeEventListener('visibilitychange', onVisibility);
            release();
        };
    }, [jobActive, addConsoleLog]);
}
