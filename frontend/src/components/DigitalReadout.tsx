import React, { useState } from 'react';
import { useCNCStore } from '../stores/cncStore';
import './DigitalReadout.css';

interface DigitalReadoutProps {
    className?: string;
}

const DigitalReadout: React.FC<DigitalReadoutProps> = ({ className = '' }) => {
    const {
        position,
        machinePosition,
        connected,
        machineState,
        activeWCS,
        setActiveWCS,
        updatePosition
    } = useCNCStore();

    const [editingAxis, setEditingAxis] = useState<string | null>(null);
    const [editValue, setEditValue] = useState<string>('');

    const handleAxisClick = (axis: 'x' | 'y' | 'z') => {
        if (!connected || machineState !== 'idle') return;
        
        setEditingAxis(axis);
        setEditValue(position[axis].toFixed(3));
    };

    const handleAxisSubmit = (axis: 'x' | 'y' | 'z') => {
        const value = parseFloat(editValue);
        if (!isNaN(value)) {
            updatePosition(axis, value);
            // TODO: Send G10 command to set work coordinate
        }
        setEditingAxis(null);
        setEditValue('');
    };

    const handleKeyPress = (e: React.KeyboardEvent, axis: 'x' | 'y' | 'z') => {
        if (e.key === 'Enter') {
            handleAxisSubmit(axis);
        } else if (e.key === 'Escape') {
            setEditingAxis(null);
            setEditValue('');
        }
    };

    const formatPosition = (value: number): string => {
        return value.toFixed(3);
    };

    const getAxisColor = (axis: 'x' | 'y' | 'z'): string => {
        const colors = {
            x: '#ff4444', // Red for X
            y: '#44ff44', // Green for Y
            z: '#4444ff'  // Blue for Z
        };
        return colors[axis];
    };

    return (
        <div className={`digital-readout ${className}`}>
            <div className="dro-header">
                <h3>Digital Readout</h3>
                <div className="wcs-selector">
                    <select 
                        value={activeWCS} 
                        onChange={(e) => setActiveWCS(e.target.value)}
                        disabled={!connected}
                    >
                        <option value="G54">G54</option>
                        <option value="G55">G55</option>
                        <option value="G56">G56</option>
                        <option value="G57">G57</option>
                        <option value="G58">G58</option>
                        <option value="G59">G59</option>
                    </select>
                </div>
            </div>

            <div className="dro-positions">
                <div className="position-type">
                    <h4>Work Position</h4>
                    <div className="axis-group">
                        {(['x', 'y', 'z'] as const).map((axis) => (
                            <div key={axis} className="axis-display">
                                <label 
                                    className="axis-label"
                                    style={{ color: getAxisColor(axis) }}
                                >
                                    {axis.toUpperCase()}
                                </label>
                                {editingAxis === axis ? (
                                    <input
                                        type="number"
                                        step="0.001"
                                        value={editValue}
                                        onChange={(e) => setEditValue(e.target.value)}
                                        onBlur={() => handleAxisSubmit(axis)}
                                        onKeyDown={(e) => handleKeyPress(e, axis)}
                                        className="axis-input"
                                        autoFocus
                                    />
                                ) : (
                                    <div
                                        className={`axis-value ${connected && machineState === 'idle' ? 'editable' : ''}`}
                                        onClick={() => handleAxisClick(axis)}
                                        title={connected && machineState === 'idle' ? 'Click to edit' : ''}
                                    >
                                        {formatPosition(position[axis])}
                                    </div>
                                )}
                                <span className="axis-unit">mm</span>
                            </div>
                        ))}
                    </div>
                </div>

                <div className="position-type">
                    <h4>Machine Position</h4>
                    <div className="axis-group">
                        {(['x', 'y', 'z'] as const).map((axis) => (
                            <div key={axis} className="axis-display">
                                <label 
                                    className="axis-label"
                                    style={{ color: getAxisColor(axis) }}
                                >
                                    {axis.toUpperCase()}
                                </label>
                                <div className="axis-value readonly">
                                    {formatPosition(machinePosition[axis])}
                                </div>
                                <span className="axis-unit">mm</span>
                            </div>
                        ))}
                    </div>
                </div>
            </div>

            <div className="dro-actions">
                <button 
                    className="zero-button zero-all"
                    disabled={!connected || machineState !== 'idle'}
                    title="Zero all axes"
                >
                    Zero All
                </button>
                <button 
                    className="zero-button zero-xy"
                    disabled={!connected || machineState !== 'idle'}
                    title="Zero X and Y axes"
                >
                    Zero XY
                </button>
                <button 
                    className="zero-button zero-z"
                    disabled={!connected || machineState !== 'idle'}
                    title="Zero Z axis"
                >
                    Zero Z
                </button>
            </div>

            <div className="machine-status">
                <div className={`status-indicator ${connected ? 'connected' : 'disconnected'}`}>
                    <span className="status-dot"></span>
                    <span className="status-text">
                        {connected ? `${machineState.toUpperCase()}` : 'DISCONNECTED'}
                    </span>
                </div>
            </div>
        </div>
    );
};

export default DigitalReadout;