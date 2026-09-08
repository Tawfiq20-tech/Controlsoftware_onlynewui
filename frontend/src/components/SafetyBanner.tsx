// ECSS v1 — SafetyBanner
//
// Surfaces three classes of safety events to the operator:
//   • Pre-flight toolpath validation (Module 1) — blocks Start with the
//     exact offending line / axis / amount.
//   • WCS health (Module 2) — flags suspicious G54 offsets (> ±50 mm) that
//     usually mean NVRAM corruption from a prior session.
//   • Z runaway (Module 3) — confirms the watchdog fired and motion was
//     aborted on the wire.
//
// The component renders nothing when everything is healthy. When something
// fires, a sticky banner anchors to the top of the workspace until dismissed
// or resolved.
import { useEffect, useState } from 'react';
import { useCNCStore } from '../stores/cncStore';
import controller from '../utils/controller';
import './SafetyBanner.css';

export function SafetyBanner() {
    const validation = useCNCStore((s) => s.safetyValidation);
    const wcsHealth = useCNCStore((s) => s.safetyWcsHealth);
    const zRunaway = useCNCStore((s) => s.safetyZRunaway);
    const setSafetyZRunaway = useCNCStore((s) => s.setSafetyZRunaway);
    // Scoped selector, not getState() — this component doesn't full-store
    // subscribe, so a getState() read inside the render body below would go
    // stale until some OTHER selector happened to trigger a re-render.
    const overrideArmed = useCNCStore((s) => s.safetyOverrideArmed);
    const [dismissed, setDismissed] = useState<Set<string>>(new Set());

    // Auto-dismiss Z runaway notice after 60 seconds so the banner doesn't
    // hang forever — the abort itself is permanent in the session log.
    useEffect(() => {
        if (!zRunaway) return;
        const t = setTimeout(() => setSafetyZRunaway(null), 60_000);
        return () => clearTimeout(t);
    }, [zRunaway, setSafetyZRunaway]);

    const banners: JSX.Element[] = [];

    if (zRunaway) {
        banners.push(
            <div key="zrun" className="ecss-banner ecss-banner--critical">
                <div className="ecss-banner__icon">🛑</div>
                <div className="ecss-banner__body">
                    <strong>Z RUNAWAY ABORT — stream halted on safety.</strong>
                    <div className="ecss-banner__detail">
                        Z dropped <b>{zRunaway.drop} mm</b> in {zRunaway.windowMs} ms
                        (threshold: {zRunaway.threshold} mm). Machine Z now at {zRunaway.mposZ} mm.
                        A binary <code>0x03</code> abort was sent before the bit could reach material.
                        Power-cycle and re-home before resuming.
                    </div>
                </div>
                <button className="ecss-banner__dismiss" onClick={() => setSafetyZRunaway(null)}>×</button>
            </div>
        );
    }

    if (wcsHealth && !wcsHealth.healthy && !dismissed.has('wcs')) {
        banners.push(
            <div key="wcs" className="ecss-banner ecss-banner--warning">
                <div className="ecss-banner__icon">⚠️</div>
                <div className="ecss-banner__body">
                    <strong>WCS health check failed.</strong>
                    <div className="ecss-banner__detail">
                        Active G54 offsets are suspicious (threshold ±{wcsHealth.threshold} mm):{' '}
                        {wcsHealth.flagged.map(f => `${f.axis}=${f.value}`).join(', ')}.
                        This usually means NVRAM corruption from a previous session.
                        Home → click Zero All on the homed position → power-cycle before running any G-code.
                    </div>
                </div>
                <button
                    className="ecss-banner__dismiss"
                    onClick={() => setDismissed((d) => new Set(d).add('wcs'))}
                >
                    ×
                </button>
            </div>
        );
    }

    if (validation?.blocked && !validation.cleared) {
        const top = validation.issues.slice(0, 3);
        banners.push(
            <div key="val" className="ecss-banner ecss-banner--block">
                <div className="ecss-banner__icon">🚫</div>
                <div className="ecss-banner__body">
                    <strong>
                        Pre-flight BLOCKED — toolpath out of bounds.
                        {overrideArmed && <span className="ecss-banner__badge"> · OVERRIDE ARMED</span>}
                    </strong>
                    <ul className="ecss-banner__list">
                        {top.map((i, idx) => (
                            <li key={idx}>{i.message}</li>
                        ))}
                    </ul>
                    {validation.probableCorruptWCS && (
                        <div className="ecss-banner__detail">
                            The current G54 offset looks corrupted (magnitude {'>'} 50 mm). Run the touch-off
                            workflow before retrying — or arm Override below for a one-shot diagnostic move.
                        </div>
                    )}
                    {!overrideArmed && (
                        <button
                            className="ecss-banner__override"
                            onClick={() => {
                                controller.command('safety:overrideOnce');
                            }}
                            title="Bypass pre-flight for the next Start only. Module 3 Z watchdog still active."
                        >
                            ⚠️ Arm one-shot override
                        </button>
                    )}
                </div>
            </div>
        );
    }

    if (banners.length === 0) return null;
    return <div className="ecss-banner-stack">{banners}</div>;
}
