/**
 * useServerCountdown — display-only countdown for a server-authoritative
 * remaining time (TierState.motionRemainingMs).
 *
 * The machine computes the remaining time from its monotonic clock, so the
 * kiosk only subtracts how long ago that value arrived, measured with
 * performance.now(). Wall clocks are never compared: a PC clock step would
 * otherwise make the grant look longer or shorter than it really is.
 */
import { useEffect, useState } from 'react';

export interface ServerCountdown {
    remainingMs: number | null;
    label: string;
    expired: boolean;
}

function formatMmSs(ms: number): string {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const mm = Math.floor(total / 60);
    const ss = total % 60;
    return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

function compute(remainingMs: number | null, receivedAt: number | null): ServerCountdown {
    if (remainingMs === null) return { remainingMs: null, label: '00:00', expired: false };
    const elapsed = receivedAt === null ? 0 : performance.now() - receivedAt;
    const remaining = Math.max(0, remainingMs - elapsed);
    return { remainingMs: remaining, label: formatMmSs(remaining), expired: remaining <= 0 };
}

export function useServerCountdown(remainingMs: number | null, receivedAt: number | null): ServerCountdown {
    const [, setTick] = useState(0);

    useEffect(() => {
        if (remainingMs === null) return;
        const id = window.setInterval(() => setTick((t) => t + 1), 1000);
        return () => window.clearInterval(id);
    }, [remainingMs, receivedAt]);

    return compute(remainingMs, receivedAt);
}

export default useServerCountdown;
