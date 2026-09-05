import { useState, useEffect, useRef } from 'react';
import { Zap, RotateCcw, Square, AlertTriangle, Flame } from 'lucide-react';
import { useCNCStore } from '../stores/cncStore';
import { sendBackendCommand } from '../utils/backendConnection';
import './SpindleLaserControl.css';

type MachineMode = 'spindle' | 'laser';

export default function SpindleLaserControl() {
    const {
        connected,
        spindleMode, setSpindleMode,
        spindleRpm, setSpindleRpm,
        spindleRunning, setSpindleRunning,
        laserPower, setLaserPower,
        addConsoleLog,
    } = useCNCStore();

    const [showModeWarning, setShowModeWarning] = useState(false);
    const [pendingMode, setPendingMode] = useState<MachineMode | null>(null);
    const [testFireDuration, setTestFireDuration] = useState(200); // ms
    const testFireTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Cleanup test fire timer on unmount
    useEffect(() => {
        return () => {
            if (testFireTimerRef.current) clearTimeout(testFireTimerRef.current);
        };
    }, []);

    // GRBL defaults: $30=1000 (max RPM), $31=0 (min RPM)
    const minRpm = 0;
    const maxRpm = 24000;

    const requestModeSwitch = (mode: MachineMode) => {
        if (mode === spindleMode) return;
        if (spindleRunning) {
            setPendingMode(mode);
            setShowModeWarning(true);
        } else {
            applyModeSwitch(mode);
        }
    };

    const applyModeSwitch = (mode: MachineMode) => {
        setSpindleMode(mode);
        setSpindleRunning(false);
        // Stop spindle/laser when switching
        sendBackendCommand('M5');
        addConsoleLog('info', `Switched to ${mode === 'spindle' ? 'Spindle' : 'Laser'} mode`);
        setShowModeWarning(false);
        setPendingMode(null);
    };

    // ─── Spindle Controls ────────────────────────────────────────
    const handleSpindleCW = () => {
        if (!connected) return;
        const rpm = Math.max(minRpm, Math.min(maxRpm, spindleRpm));
        sendBackendCommand(`M3 S${rpm}`);
        setSpindleRunning(true);
        addConsoleLog('info', `Spindle CW @ ${rpm} RPM (M3 S${rpm})`);
    };

    const handleSpindleCCW = () => {
        if (!connected) return;
        const rpm = Math.max(minRpm, Math.min(maxRpm, spindleRpm));
        sendBackendCommand(`M4 S${rpm}`);
        setSpindleRunning(true);
        addConsoleLog('info', `Spindle CCW @ ${rpm} RPM (M4 S${rpm})`);
    };

    const handleSpindleStop = () => {
        if (!connected) return;
        sendBackendCommand('M5');
        setSpindleRunning(false);
        addConsoleLog('info', 'Spindle stopped (M5)');
    };

    // ─── Laser Controls ──────────────────────────────────────────
    const handleLaserOn = () => {
        if (!connected) return;
        // Convert power % to S value (0-1000 for GRBL default $30=1000)
        const sValue = Math.round((laserPower / 100) * 1000);
        sendBackendCommand(`M3 S${sValue}`);
        setSpindleRunning(true);
        addConsoleLog('info', `Laser ON @ ${laserPower}% power (M3 S${sValue})`);
    };

    const handleLaserOff = () => {
        if (!connected) return;
        sendBackendCommand('M5');
        setSpindleRunning(false);
        addConsoleLog('info', 'Laser OFF (M5)');
    };

    const handleTestFire = () => {
        if (!connected) return;
        // Cancel any in-progress test fire
        if (testFireTimerRef.current) {
            clearTimeout(testFireTimerRef.current);
            testFireTimerRef.current = null;
        }
        const sValue = Math.round((laserPower / 100) * 1000);
        sendBackendCommand(`M3 S${sValue}`);
        addConsoleLog('info', `Laser test fire: ${testFireDuration}ms @ ${laserPower}%`);
        testFireTimerRef.current = setTimeout(() => {
            testFireTimerRef.current = null;
            sendBackendCommand('M5');
            addConsoleLog('info', 'Laser test fire complete');
        }, testFireDuration);
    };

    return (
        <div className={`slc-control ${!connected ? 'disabled' : ''}`}>
            {/* Mode Toggle */}
            <div className="slc-mode-row">
                <button
                    className={`slc-mode-btn ${spindleMode === 'spindle' ? 'active' : ''}`}
                    onClick={() => requestModeSwitch('spindle')}
                >
                    <RotateCcw size={13} />
                    Spindle
                </button>
                <button
                    className={`slc-mode-btn laser-mode ${spindleMode === 'laser' ? 'active' : ''}`}
                    onClick={() => requestModeSwitch('laser')}
                >
                    <Zap size={13} />
                    Laser
                </button>
            </div>

            {/* Mode switch warning */}
            {showModeWarning && (
                <div className="slc-warning">
                    <AlertTriangle size={13} />
                    <span>Stop spindle/laser before switching modes?</span>
                    <div className="slc-warn-actions">
                        <button
                            className="slc-warn-btn confirm"
                            onClick={() => pendingMode && applyModeSwitch(pendingMode)}
                        >
                            Stop & Switch
                        </button>
                        <button
                            className="slc-warn-btn cancel"
                            onClick={() => { setShowModeWarning(false); setPendingMode(null); }}
                        >
                            Cancel
                        </button>
                    </div>
                </div>
            )}

            {/* Running indicator */}
            {spindleRunning && (
                <div className={`slc-running-badge ${spindleMode}`}>
                    <span className="slc-running-dot" />
                    {spindleMode === 'spindle' ? 'Spindle Running' : 'Laser Active'}
                </div>
            )}

            {/* ── Spindle Mode ── */}
            {spindleMode === 'spindle' && (
                <div className="slc-spindle">
                    <div className="slc-field">
                        <label className="slc-label">Speed (RPM)</label>
                        <div className="slc-rpm-row">
                            <input
                                type="number"
                                className="slc-num-input"
                                value={spindleRpm}
                                min={minRpm}
                                max={maxRpm}
                                step={100}
                                onChange={(e) => setSpindleRpm(Math.max(minRpm, Math.min(maxRpm, parseInt(e.target.value) || 0)))}
                            />
                            <span className="slc-unit">RPM</span>
                        </div>
                        <input
                            type="range"
                            className="slc-slider"
                            min={minRpm}
                            max={maxRpm}
                            step={100}
                            value={spindleRpm}
                            onChange={(e) => setSpindleRpm(parseInt(e.target.value))}
                        />
                        <div className="slc-range-labels">
                            <span>{minRpm}</span>
                            <span>{maxRpm.toLocaleString()} max</span>
                        </div>
                    </div>

                    <div className="slc-spindle-btns">
                        <button
                            className={`slc-spin-btn cw ${spindleRunning ? 'running' : ''}`}
                            onClick={handleSpindleCW}
                            disabled={!connected}
                            title="Spindle CW (M3)"
                        >
                            <RotateCcw size={14} style={{ transform: 'scaleX(-1)' }} />
                            CW
                            <span className="slc-code">M3</span>
                        </button>
                        <button
                            className={`slc-spin-btn ccw ${spindleRunning ? 'running' : ''}`}
                            onClick={handleSpindleCCW}
                            disabled={!connected}
                            title="Spindle CCW (M4)"
                        >
                            <RotateCcw size={14} />
                            CCW
                            <span className="slc-code">M4</span>
                        </button>
                        <button
                            className="slc-spin-btn stop"
                            onClick={handleSpindleStop}
                            disabled={!connected || !spindleRunning}
                            title="Stop Spindle (M5)"
                        >
                            <Square size={14} />
                            Stop
                            <span className="slc-code">M5</span>
                        </button>
                    </div>
                </div>
            )}

            {/* ── Laser Mode ── */}
            {spindleMode === 'laser' && (
                <div className="slc-laser">
                    <div className="slc-laser-warning">
                        <AlertTriangle size={12} />
                        Wear laser safety glasses at all times
                    </div>

                    <div className="slc-field">
                        <label className="slc-label">Power</label>
                        <div className="slc-rpm-row">
                            <input
                                type="number"
                                className="slc-num-input"
                                value={laserPower}
                                min={0}
                                max={100}
                                step={1}
                                onChange={(e) => setLaserPower(Math.max(0, Math.min(100, parseInt(e.target.value) || 0)))}
                            />
                            <span className="slc-unit">%</span>
                        </div>
                        <input
                            type="range"
                            className="slc-slider laser"
                            min={0}
                            max={100}
                            value={laserPower}
                            onChange={(e) => setLaserPower(parseInt(e.target.value))}
                        />
                        <div className="slc-range-labels">
                            <span>0%</span>
                            <span>100%</span>
                        </div>
                    </div>

                    <div className="slc-laser-btns">
                        <button
                            className={`slc-laser-btn on ${spindleRunning ? 'running' : ''}`}
                            onClick={handleLaserOn}
                            disabled={!connected}
                            title="Laser ON (M3)"
                        >
                            <Flame size={13} />
                            ON
                        </button>
                        <button
                            className="slc-laser-btn off"
                            onClick={handleLaserOff}
                            disabled={!connected || !spindleRunning}
                            title="Laser OFF (M5)"
                        >
                            <Square size={13} />
                            OFF
                        </button>
                    </div>

                    {/* Test Fire */}
                    <div className="slc-test-fire">
                        <span className="slc-label">Test Fire</span>
                        <div className="slc-testfire-row">
                            <input
                                type="number"
                                className="slc-num-input small"
                                value={testFireDuration}
                                min={50}
                                max={5000}
                                step={50}
                                onChange={(e) => setTestFireDuration(Math.max(50, Math.min(5000, parseInt(e.target.value) || 200)))}
                            />
                            <span className="slc-unit">ms</span>
                            <button
                                className="slc-testfire-btn"
                                onClick={handleTestFire}
                                disabled={!connected}
                                title={`Fire laser for ${testFireDuration}ms`}
                            >
                                <Flame size={12} />
                                Fire
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
