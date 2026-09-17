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
import { loadAndConfirm } from '../utils/designLoad';
import './SafetyBanner.css';

export function SafetyBanner() {
    const validation = useCNCStore((s) => s.safetyValidation);
    const wcsHealth = useCNCStore((s) => s.safetyWcsHealth);
    const zRunaway = useCNCStore((s) => s.safetyZRunaway);
    const setSafetyZRunaway = useCNCStore((s) => s.setSafetyZRunaway);
    const controllerRestart = useCNCStore((s) => s.controllerRestart);
    const otherScreenFile = useCNCStore((s) => s.otherScreenFile);
    const myFileName = useCNCStore((s) => s.fileInfo?.name);
    const jobActive = useCNCStore((s) => s.jobActive);
    const [reloading, setReloading] = useState(false);
    const [dismissed, setDismissed] = useState<Set<string>>(new Set());

    // Auto-dismiss Z runaway notice after 60 seconds so the banner doesn't
    // hang forever — the abort itself is permanent in the session log.
    useEffect(() => {
        if (!zRunaway) return;
        const t = setTimeout(() => setSafetyZRunaway(null), 60_000);
        return () => clearTimeout(t);
    }, [zRunaway, setSafetyZRunaway]);

    const banners: JSX.Element[] = [];

    // Another screen put a different design on the machine. This screen does
    // not load its own design back by itself any more (that made two screens
    // swap designs forever); the operator decides.
    if (otherScreenFile) {
        const reloadMine = async () => {
            const s = useCNCStore.getState();
            if (!s.rawGcodeContent) return;
            const name = s.fileInfo?.name || 'job.gcode';
            setReloading(true);
            try {
                const r = await loadAndConfirm(name, s.rawGcodeContent);
                if (r.ok) useCNCStore.getState().addConsoleLog('success', `"${name}" is loaded on the machine again. Check the preview, then press Play.`);
                else useCNCStore.getState().addConsoleLog('error', r.message);
            } finally {
                setReloading(false);
            }
        };
        banners.push(
            <div key="otherscreen" className="ecss-banner ecss-banner--critical">
                <div className="ecss-banner__icon">⚠️</div>
                <div className="ecss-banner__body">
                    <strong>
                        Another screen loaded {otherScreenFile === myFileName ? <>a different version of "{otherScreenFile}"</> : <>"{otherScreenFile}"</>} onto the machine.
                    </strong>
                    <div className="ecss-banner__detail">
                        The design shown here{myFileName ? <> ("{myFileName}")</> : null} is NOT loaded and will not run.
                        To cut it, load it again, check the preview, then press <b>Play</b>.
                    </div>
                </div>
                <button className="ecss-banner__dismiss" disabled={reloading || jobActive} onClick={() => { void reloadMine(); }}
                    title={jobActive ? 'A job is running' : 'Load the design shown here onto the machine (does not start it)'}
                    style={{ width: 'auto', padding: '0 10px', fontSize: 13 }}>
                    {reloading ? 'Loading...' : 'Load my design again'}
                </button>
            </div>
        );
    }

    // Not dismissible: it clears itself once X, Y and Z are zeroed or the
    // machine is homed (the backend refuses Start until then).
    if (controllerRestart) {
        banners.push(
            <div key="restart" className="ecss-banner ecss-banner--critical">
                <div className="ecss-banner__icon">🛑</div>
                <div className="ecss-banner__body">
                    <strong>
                        {controllerRestart.line > 0
                            ? `Controller restarted during the job — stopped at line ${controllerRestart.line}. Position lost.`
                            : 'Controller restarted — position lost.'}
                    </strong>
                    <div className="ecss-banner__detail">
                        {controllerRestart.message} Check the tool, raise Z clear of the work, then set the work
                        zero again (<b>Zero X, Y and Z</b> at the job's origin, or <b>Home</b>).
                        {controllerRestart.line > 0 && <> Then use <b>Start From Line {controllerRestart.line}</b>.</>}
                        {' '}Start stays blocked until then.
                    </div>
                </div>
            </div>
        );
    }

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
        const overrideArmed = useCNCStore.getState().safetyOverrideArmed;
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
