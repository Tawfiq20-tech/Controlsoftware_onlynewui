import { useEffect, useState } from 'react';
import { Gamepad2, RefreshCw } from 'lucide-react';
import { gamepad, type GamepadBindings } from './api';

const DEFAULT: GamepadBindings = {
    enabled: false,
    deadzone: 0.15,
    maxFeedrate: 3000,
    axes: { x: 0, y: 1, z: 3 },
    axisInvert: { x: false, y: true, z: false },
    buttons: { home: 8, estop: 9, cyclestart: 0, hold: 1, probe: 2, mistOn: 6 },
};

export default function SectionGamepad() {
    const [b, setB] = useState<GamepadBindings>(DEFAULT);
    const [detected, setDetected] = useState<{ id: string; axes: number; buttons: number } | null>(null);
    const [liveAxes, setLiveAxes] = useState<number[]>([]);

    useEffect(() => {
        gamepad.get().then(setB).catch(() => {});
    }, []);

    // Poll the browser Gamepad API to show what's plugged in.
    useEffect(() => {
        let raf = 0;
        const tick = () => {
            const gps = navigator.getGamepads?.() || [];
            const gp = Array.from(gps).find(g => g);
            if (gp) {
                setDetected({ id: gp.id, axes: gp.axes.length, buttons: gp.buttons.length });
                setLiveAxes(Array.from(gp.axes));
            } else {
                setDetected(null);
                setLiveAxes([]);
            }
            raf = requestAnimationFrame(tick);
        };
        tick();
        return () => cancelAnimationFrame(raf);
    }, []);

    const save = async () => { await gamepad.set(b); };

    return (
        <div className="settings-section">
            <div className="settings-section-header">
                <div>
                    <h3>Gamepad / Joystick</h3>
                    <p className="settings-section-sub">
                        Map a USB controller to jogging + machine actions. Works with any
                        standard HID gamepad (Xbox, PS, generic).
                    </p>
                </div>
                <button className="settings-btn" onClick={() => gamepad.get().then(setB)}>
                    <RefreshCw size={14} />
                </button>
            </div>

            <div className="settings-detect">
                <Gamepad2 size={18} />
                {detected
                    ? <span>{detected.id} — {detected.axes} axes, {detected.buttons} buttons</span>
                    : <span className="dim">No gamepad detected. Press any button to wake it.</span>}
            </div>

            <label className="settings-toggle">
                <input type="checkbox" checked={b.enabled}
                    onChange={e => setB({ ...b, enabled: e.target.checked })} />
                <span>Enable jog from gamepad</span>
            </label>

            <div className="settings-grid-2">
                <label>Deadzone (0–1)<input type="number" step="0.05" min="0" max="0.5"
                    value={b.deadzone}
                    onChange={e => setB({ ...b, deadzone: +e.target.value })} /></label>
                <label>Max feedrate (mm/min)<input type="number"
                    value={b.maxFeedrate}
                    onChange={e => setB({ ...b, maxFeedrate: +e.target.value })} /></label>
            </div>

            <h4>Axis bindings</h4>
            <div className="settings-grid-3">
                {(['x', 'y', 'z'] as const).map(ax => (
                    <div key={ax} className="settings-axis-row">
                        <label>{ax.toUpperCase()} axis index
                            <input type="number" min="0" max="15"
                                value={b.axes[ax]}
                                onChange={e => setB({ ...b, axes: { ...b.axes, [ax]: +e.target.value } })} />
                        </label>
                        <label className="settings-toggle small">
                            <input type="checkbox" checked={b.axisInvert[ax]}
                                onChange={e => setB({ ...b, axisInvert: { ...b.axisInvert, [ax]: e.target.checked } })} />
                            <span>invert</span>
                        </label>
                        <div className="settings-axis-bar">
                            <div className="bar-fill" style={{
                                width: `${Math.abs(liveAxes[b.axes[ax]] ?? 0) * 100}%`,
                                left: (liveAxes[b.axes[ax]] ?? 0) < 0 ? 'auto' : '50%',
                                right: (liveAxes[b.axes[ax]] ?? 0) < 0 ? '50%' : 'auto',
                            }} />
                        </div>
                    </div>
                ))}
            </div>

            <h4>Button bindings</h4>
            <div className="settings-grid-3">
                {(Object.keys(b.buttons) as Array<keyof typeof b.buttons>).map(name => (
                    <label key={name}>
                        {name}
                        <input type="number" min="0" max="31" value={b.buttons[name]}
                            onChange={e => setB({ ...b, buttons: { ...b.buttons, [name]: +e.target.value } })} />
                    </label>
                ))}
            </div>

            <div className="settings-form-actions">
                <button className="settings-btn primary" onClick={save}>Save bindings</button>
            </div>
        </div>
    );
}
