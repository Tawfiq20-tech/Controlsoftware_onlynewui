import { Droplets, Waves, X } from 'lucide-react';
import { useCNCStore } from '../stores/cncStore';
import { sendBackendCommand } from '../utils/backendConnection';
import './CoolantControl.css';

export default function CoolantControl() {
    const { connected, coolantState, setCoolantState, addConsoleLog } = useCNCStore();

    const handleMist = () => {
        if (!connected) return;
        if (coolantState === 'mist') {
            sendBackendCommand('M9');
            setCoolantState('off');
            addConsoleLog('info', 'Coolant: Mist OFF (M9)');
        } else {
            sendBackendCommand('M7');
            setCoolantState('mist');
            addConsoleLog('info', 'Coolant: Mist ON (M7)');
        }
    };

    const handleFlood = () => {
        if (!connected) return;
        if (coolantState === 'flood') {
            sendBackendCommand('M9');
            setCoolantState('off');
            addConsoleLog('info', 'Coolant: Flood OFF (M9)');
        } else {
            sendBackendCommand('M8');
            setCoolantState('flood');
            addConsoleLog('info', 'Coolant: Flood ON (M8)');
        }
    };

    const handleStop = () => {
        if (!connected) return;
        sendBackendCommand('M9');
        setCoolantState('off');
        addConsoleLog('info', 'Coolant: All OFF (M9)');
    };

    return (
        <div className={`coolant-control ${!connected ? 'disabled' : ''}`}>
            <div className="coolant-header">
                <Droplets size={13} />
                <span className="coolant-title">Coolant</span>
                {coolantState !== 'off' && (
                    <span className={`coolant-badge ${coolantState}`}>
                        {coolantState === 'mist' ? 'MIST' : 'FLOOD'}
                    </span>
                )}
            </div>

            <div className="coolant-buttons">
                <button
                    className={`coolant-btn mist ${coolantState === 'mist' ? 'active' : ''}`}
                    onClick={handleMist}
                    disabled={!connected}
                    title="Toggle Mist Coolant (M7)"
                >
                    <Droplets size={13} />
                    Mist
                    <span className="coolant-code">M7</span>
                </button>

                <button
                    className={`coolant-btn flood ${coolantState === 'flood' ? 'active' : ''}`}
                    onClick={handleFlood}
                    disabled={!connected}
                    title="Toggle Flood Coolant (M8)"
                >
                    <Waves size={13} />
                    Flood
                    <span className="coolant-code">M8</span>
                </button>

                <button
                    className={`coolant-btn stop ${coolantState === 'off' ? 'off-active' : ''}`}
                    onClick={handleStop}
                    disabled={!connected || coolantState === 'off'}
                    title="Stop Coolant (M9)"
                >
                    <X size={13} />
                    Stop
                    <span className="coolant-code">M9</span>
                </button>
            </div>
        </div>
    );
}
