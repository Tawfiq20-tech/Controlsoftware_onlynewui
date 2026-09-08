import { useState, useRef, useEffect } from 'react';
import {
    ChevronUp, ChevronDown,
    Upload, File, X, Play, Terminal,
    Settings, Info, Check, AlertTriangle, Circle, Plus, Edit, Trash2,
    RefreshCw, RotateCcw, FileText, Crosshair, Home, Ruler,
} from 'lucide-react';
import { useCNCStore } from '../stores/cncStore';
import { formatAxisValue, formatFileSize } from '../utils/formatters';
import { GCodeParser } from '../utils/gcodeParser';
import {
    sendBackendCommand,
    backendJog,
    backendHome,
    backendHomeAxis,
    backendUnlock,
    backendZeroAll,
    backendMotorReset,
} from '../utils/backendConnection';
import CoolantControl from './CoolantControl';
import SpindleLaserControl from './SpindleLaserControl';
import FeedOverrideControl from './FeedOverrideControl';
import CameraView from './CameraView/CameraView';
import './Sidebar.css';

// ── Settings Tabs ─────────────────────────────
// PROBE sub-tab removed per Tawfiq msg 7381 — probing is launched only
// from the File-Management Probe button now (single entry point).
const SETTINGS_TABS = ['Position', 'Jog', 'Controls', 'Macros', 'Console'] as const;
type SettingsTab = typeof SETTINGS_TABS[number];

export default function Sidebar() {
    const [settingsTab, setSettingsTab] = useState<SettingsTab>('Position');
    const [consoleExpanded, setConsoleExpanded] = useState(true);
    const [consoleCmd, setConsoleCmd] = useState('');
    
    // Macro state
    const [macros, setMacros] = useState<Array<{id: string, name: string, content: string}>>([]);
    const [editingMacro, setEditingMacro] = useState<{id: string, name: string, content: string} | null>(null);
    const [showMacroForm, setShowMacroForm] = useState(false);
    

    // Drag and drop state
    const [isDragOver, setIsDragOver] = useState(false);

    const fileInputRef = useRef<HTMLInputElement>(null);
    const consoleOutputRef = useRef<HTMLDivElement>(null);
    const dropZoneRef = useRef<HTMLDivElement>(null);

    const {
        connected,
        machineState,
        position, setPosition,
        machinePosition,
        aAxis,
        jogDistance, setJogDistance,
        jogSpeed, setJogSpeed,
        coordSystem, setCoordSystem,
        setGcode,
        fileInfo, setFileInfo,
        setRawGcodeContent,
        toolpathSegments: _ts, setToolpathSegments,
        consoleLines, addConsoleLog,
        appPreferences, setAppPreferences,
    } = useCNCStore();

    // Lock the Controls tab while the machine is actively running a job, so
    // operators can't accidentally toggle hardware mid-carve. (Tawfiq msg 7292.)
    const isCarving = machineState === 'running' || machineState === 'paused';

    // Continuous jog interval ref
    const continuousJogRef = useRef<ReturnType<typeof setInterval> | null>(null);

    // Jog speed presets (msg11535: 600/1000/6000/10000)
    const jogSpeedPresets = [
        { label: 'Slow', value: 600 },
        { label: 'Medium', value: 1000 },
        { label: 'Fast', value: 6000 },
        { label: 'Ultra', value: 10000 },
    ];

    // Auto-scroll console
    useEffect(() => {
        if (consoleOutputRef.current && consoleExpanded) {
            consoleOutputRef.current.scrollTop = consoleOutputRef.current.scrollHeight;
        }
    }, [consoleLines, consoleExpanded]);

    // Cleanup continuous jog on unmount
    useEffect(() => {
        return () => {
            if (continuousJogRef.current) clearInterval(continuousJogRef.current);
        };
    }, []);

    // Drag and drop handlers
    const handleDragOver = (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragOver(true);
    };

    const handleDragLeave = (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragOver(false);
    };

    const handleDrop = (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragOver(false);
        
        const files = Array.from(e.dataTransfer.files);
        if (files.length === 0) return;
        
        if (files.length > 1) {
            addConsoleLog('warning', 'Please drop only one file at a time');
            return;
        }
        
        const file = files[0];
        processFile(file);
    };

    // ── Handlers ─────────────────────────────
    const handleJog = (axis: 'x' | 'y' | 'z', direction: 1 | -1) => {
        if (!connected) return;
        const distance = jogDistance * direction;
        const params: Record<string, number | undefined> = {};
        params[axis] = distance;
        backendJog(params.x, params.y, params.z, jogSpeed);
        addConsoleLog('info', `Jog ${axis.toUpperCase()} ${direction > 0 ? '+' : ''}${distance}mm`);
    };

    const handleDiagonalJog = (xDir: 1 | -1, yDir: 1 | -1) => {
        if (!connected) return;
        const xDistance = jogDistance * xDir;
        const yDistance = jogDistance * yDir;
        backendJog(xDistance, yDistance, undefined, jogSpeed);
        addConsoleLog('info', `Jog X${xDir > 0 ? '+' : ''}${xDistance} Y${yDir > 0 ? '+' : ''}${yDistance}mm`);
    };

    // Continuous jog start/stop can be wired to pointer events when continuous mode UI is added.
    // For now, step-mode jog is used via handleJog.

    const handleToggleUnits = () => {
        const currentUnit = appPreferences?.units?.toLowerCase() === 'inches' || appPreferences?.units?.toLowerCase() === 'in' ? 'inches' : 'mm';
        const nextUnits = currentUnit === 'inches' ? 'mm' : 'inches';
        setAppPreferences({ ...appPreferences, units: nextUnits });
        sendBackendCommand(nextUnits === 'mm' ? 'G21' : 'G20');
        addConsoleLog('info', `Units switched to ${nextUnits.toUpperCase()} (${nextUnits === 'mm' ? 'G21' : 'G20'})`);
    };

    const handleZero = (axis: 'x' | 'y' | 'z') => {
        if (!connected) return;
        const axisNum = axis === 'x' ? 'X' : axis === 'y' ? 'Y' : 'Z';
        sendBackendCommand(`G10 L20 P0 ${axisNum}0`);
        setPosition({ ...position, [axis]: 0 });
        addConsoleLog('info', `${axis.toUpperCase()} axis zeroed`);
    };

    const handleZeroAll = () => {
        if (!connected) return;
        backendZeroAll();
        setPosition({ x: 0, y: 0, z: 0 });
        addConsoleLog('info', 'All axes zeroed');
    };

    const handleHomeAll = () => {
        if (!connected) return;
        backendHome();
        addConsoleLog('info', 'Homing all axes...');
    };

    const handleHomeAxis = (axis: 'X' | 'Y' | 'Z') => {
        if (!connected) return;
        backendHomeAxis(axis);
        addConsoleLog('info', `Homing ${axis} axis...`);
    };

    const processFile = (file: File) => {
        // Validate file type
        const validExtensions = ['.nc', '.gcode', '.txt', '.ngc', '.cnc', '.tap'];
        const fileExtension = file.name.toLowerCase().substring(file.name.lastIndexOf('.'));
        
        if (!validExtensions.includes(fileExtension)) {
            addConsoleLog('error', `Invalid file type: ${fileExtension}. Supported formats: ${validExtensions.join(', ')}`);
            return;
        }
        
        // Validate file size (max 50MB)
        const maxSize = 50 * 1024 * 1024; // 50MB
        if (file.size > maxSize) {
            addConsoleLog('error', `File too large: ${formatFileSize(file.size)}. Maximum size: ${formatFileSize(maxSize)}`);
            return;
        }
        
        addConsoleLog('info', `Loading file: ${file.name} (${formatFileSize(file.size)})`);
        
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const content = e.target?.result as string;
                
                // Validate content is not empty
                if (!content || content.trim().length === 0) {
                    addConsoleLog('error', 'File is empty or contains no valid content');
                    return;
                }
                
                // Parse G-code (v1.3: GCodeParser handles arcs, G92/G53, plane select, downsampling)
                const parser = new GCodeParser();
                const result = parser.parseGCode(content);
                const parsed = result.lines;
                const segments = result.segments;
                if (!parsed || parsed.length === 0) {
                    addConsoleLog('warning', 'No valid G-code commands found in file');
                    return;
                }

                setGcode(parsed);
                setToolpathSegments(segments);
                setRawGcodeContent(content);
                setFileInfo({ name: file.name, size: file.size, lines: parsed.length });

                addConsoleLog('success', `Successfully loaded ${parsed.length} G-code lines from ${file.name}`);
                addConsoleLog('info', `Generated ${segments.length} toolpath segments for visualization`);

                const { rapidCount, cutCount, arcCount, totalLengthMm, downsampled, originalSegments } = result.stats;
                addConsoleLog('info',
                    `File stats: ${rapidCount} rapids, ${cutCount} cuts, ${arcCount} arc blocks, ${totalLengthMm.toFixed(1)} mm path`
                );
                if (downsampled) {
                    addConsoleLog('warning', `Segment cap hit: downsampled ${originalSegments} → ${segments.length} for GPU performance`);
                }
                
            } catch (error) {
                console.error('Error parsing G-code file:', error);
                addConsoleLog('error', `Failed to parse G-code file: ${error instanceof Error ? error.message : 'Unknown error'}`);
            }
        };
        
        reader.onerror = () => {
            addConsoleLog('error', `Failed to read file: ${file.name}`);
        };
        
        reader.readAsText(file);
    };

    const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file) return;
        processFile(file);
    };

    const handleClearFile = () => {
        setFileInfo(null);
        setGcode([]);
        setToolpathSegments([]);
        setRawGcodeContent(null);
        addConsoleLog('info', 'File cleared');
        if (fileInputRef.current) fileInputRef.current.value = '';
    };

    const handleReloadFile = () => {
        if (!fileInputRef.current || !fileInputRef.current.files?.[0]) {
            addConsoleLog('warning', 'No file to reload - please load a file first');
            return;
        }
        
        const file = fileInputRef.current.files[0];
        addConsoleLog('info', `Reloading file: ${file.name}`);
        processFile(file);
    };


    // Macro handlers
    const handleRunMacro = (macro: {id: string, name: string, content: string}) => {
        if (!connected) return;
        const lines = macro.content.split('\n').filter(line => line.trim());
        lines.forEach((line, index) => {
            setTimeout(() => {
                sendBackendCommand(line.trim());
                addConsoleLog('info', `Macro "${macro.name}": ${line.trim()}`);
            }, index * 100); // Small delay between commands
        });
    };

    const handleSaveMacro = (name: string, content: string) => {
        const id = editingMacro?.id || Date.now().toString();
        const newMacro = { id, name, content };
        
        if (editingMacro) {
            setMacros(prev => prev.map(m => m.id === id ? newMacro : m));
            addConsoleLog('info', `Macro "${name}" updated`);
        } else {
            setMacros(prev => [...prev, newMacro]);
            addConsoleLog('info', `Macro "${name}" created`);
        }
        
        setEditingMacro(null);
        setShowMacroForm(false);
    };

    const handleDeleteMacro = (id: string) => {
        const macro = macros.find(m => m.id === id);
        setMacros(prev => prev.filter(m => m.id !== id));
        addConsoleLog('warning', `Macro "${macro?.name}" deleted`);
    };


    const getConsoleClass = (type: string) => {
        switch (type) {
            case 'system': return 'console-system';
            case 'info': return 'console-info';
            case 'success': return 'console-success';
            case 'warning': return 'console-warning';
            case 'error': return 'console-error';
            default: return 'console-info';
        }
    };

    const getConsoleIcon = (type: string) => {
        const iconProps = { size: 12, strokeWidth: 2.5 };
        switch (type) {
            case 'system': return <Settings {...iconProps} />;
            case 'info': return <Info {...iconProps} />;
            case 'success': return <Check {...iconProps} />;
            case 'warning': return <AlertTriangle {...iconProps} />;
            case 'error': return <X {...iconProps} />;
            default: return <Circle {...iconProps} />;
        }
    };


    // Axis colors (tactical industrial grade)
    const AXIS_COLORS = {
        x: '#ef4444',
        y: '#10b981',
        z: '#0284c7',
    };

    return (
        <aside className="sidebar">
            <div className="sidebar-scroll">

                {/* ──── File Management ──── */}
                <div className="sidebar-section">
                    <div className="section-header">
                        <span className="section-label">File Management</span>
                        <button className="section-action-icon" title="Settings">
                            <Settings size={13} />
                        </button>
                    </div>

                    <div 
                        ref={dropZoneRef}
                        className={`file-drop-zone ${isDragOver ? 'drag-over' : ''}`}
                        onDragOver={handleDragOver}
                        onDragLeave={handleDragLeave}
                        onDrop={handleDrop}
                    >
                        {fileInfo ? (
                            <div className="file-card">
                                <div className="file-card-icon">
                                    <FileText size={16} />
                                </div>
                                <div className="file-card-details">
                                    <div className="file-card-name" title={fileInfo.name}>
                                        {fileInfo.name}
                                    </div>
                                    <div className="file-card-meta">
                                        {fileInfo.lines} lines • {formatFileSize(fileInfo.size)}
                                    </div>
                                    <div className="file-card-status">
                                        <Circle size={8} className="file-status-indicator loaded" />
                                        <span>Loaded & Ready</span>
                                    </div>
                                </div>
                                <div className="file-card-actions">
                                    <button 
                                        className="file-card-action" 
                                        onClick={handleReloadFile} 
                                        title="Reload current file"
                                    >
                                        <RefreshCw size={12} />
                                    </button>
                                    <button 
                                        className="file-card-action" 
                                        onClick={handleClearFile} 
                                        title="Clear file"
                                    >
                                        <X size={12} />
                                    </button>
                                </div>
                            </div>
                        ) : (
                            <div className="file-card file-card-empty">
                                <div className="file-card-icon">
                                    <File size={16} />
                                </div>
                                <div className="file-card-details">
                                    <div className="file-card-name">
                                        {isDragOver ? 'Drop G-code file here' : 'No file loaded'}
                                    </div>
                                    <div className="file-card-meta">
                                        {isDragOver ? 'Release to load file' : 'Load a G-code file to begin or drag & drop'}
                                    </div>
                                    <div className="file-card-status">
                                        <Circle size={8} className="file-status-indicator empty" />
                                        <span>Ready to Load</span>
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>

                    <input
                        ref={fileInputRef}
                        type="file"
                        accept=".nc,.gcode,.txt,.ngc,.cnc,.tap"
                        style={{ display: 'none' }}
                        onChange={handleFileUpload}
                    />
                    
                    <div className="file-management-actions">
                        <button
                            className="file-upload-btn primary"
                            onClick={() => fileInputRef.current?.click()}
                        >
                            <Upload size={14} />
                            Browse for G-Code File
                        </button>

                        {fileInfo && (
                            <button
                                className="file-upload-btn secondary"
                                onClick={handleReloadFile}
                            >
                                <RotateCcw size={14} />
                                Reload Current
                            </button>
                        )}

                    </div>

                </div>

                {isCarving && (
                    <div className="sidebar-carve-lock" role="status">
                        🔒 Carve in progress — Controls tab locked. Pause to change settings.
                    </div>
                )}

                {/* ──── Settings Tabs ──── */}
                <div className="settings-tabs" role="tablist">
                    {SETTINGS_TABS.map(tab => {
                        const locked = isCarving && tab === 'Controls';
                        const isAfterJog = tab === 'Controls';
                        return (
                            <>
                                {/* Probe launcher sits between JOG and CONTROLS
                                    in the sub-tab bar (Tawfiq msg 7384). It's a
                                    button, not a tab — clicking opens the
                                    ProbingModal at Step 1 (type picker). */}
                                {isAfterJog && (
                                    <button
                                        key="probe-launcher"
                                        className="settings-tab-btn settings-tab-launcher"
                                        onClick={() => window.dispatchEvent(new CustomEvent('cnc:open-probing'))}
                                        title="Open probing"
                                    >
                                        <Crosshair size={11} style={{ marginRight: 4, verticalAlign: 'middle' }} />
                                        Probe
                                    </button>
                                )}
                                <button
                                    key={tab}
                                    className={`settings-tab-btn ${settingsTab === tab ? 'active' : ''} ${locked ? 'locked' : ''}`}
                                    onClick={() => { if (!locked) setSettingsTab(tab); }}
                                    role="tab"
                                    aria-selected={settingsTab === tab}
                                    aria-disabled={locked}
                                    title={locked ? 'Locked while carving' : tab}
                                >
                                    {tab}
                                </button>
                            </>
                        );
                    })}
                </div>

                {/* ──── Tab Content: Position ──── */}
                {settingsTab === 'Position' && (
                    <div className="sidebar-section" style={{ borderBottom: 'none' }}>
                        {/* Alarm / Motor Error Banner */}
                        {(machineState === 'alarm' || machineState === 'motorError') && (
                            <div className="pos-alarm-banner" style={{ flexDirection: 'column', gap: '6px' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', width: '100%' }}>
                                    <AlertTriangle size={14} />
                                    <span style={{ flex: 1 }}>
                                        {machineState === 'motorError'
                                            ? 'MOTOR ERROR — Closed-loop error detected'
                                            : 'ALARM — Machine locked'}
                                    </span>
                                </div>
                                <div style={{ display: 'flex', gap: '4px', width: '100%', flexWrap: 'wrap' }}>
                                    {['X', 'Y1', 'Y2', 'Z'].map(motor => (
                                        <button key={motor} style={{ flex: 1, minWidth: '50px', padding: '4px 8px', fontSize: '11px', background: '#c0392b', color: '#fff', border: 'none', borderRadius: '3px', cursor: 'pointer' }}
                                            onClick={() => { backendMotorReset(motor === 'Y1' || motor === 'Y2' ? 'Y' : motor); addConsoleLog('info', `Resetting ${motor} motor...`); }}>
                                            Reset {motor}
                                        </button>
                                    ))}
                                    <button style={{ flex: 1, minWidth: '60px', padding: '4px 8px', fontSize: '11px', background: '#2980b9', color: '#fff', border: 'none', borderRadius: '3px', cursor: 'pointer' }}
                                        onClick={() => { backendMotorReset(); backendUnlock(); addConsoleLog('info', 'Resetting all motors...'); }}>
                                        Reset All
                                    </button>
                                </div>
                            </div>
                        )}

                        {/* Action Buttons Row */}
                        <div className="pos-action-row">
                            <button className="pos-action-btn pos-zero-btn" onClick={handleZeroAll} disabled={!connected}>
                                <Crosshair size={14} />
                                ZERO ALL
                            </button>
                            <button className="pos-action-btn pos-home-btn" onClick={handleHomeAll} disabled={!connected}>
                                <Home size={14} />
                                HOME ALL
                            </button>
                        </div>

                        {/* Position Table Header */}
                        <div className="pos-table-header">
                            <span className="pos-th-axis">Axis</span>
                            <span className="pos-th-work">Work Position</span>
                            <span className="pos-th-machine">Machine Position</span>
                            <span className="pos-th-actions">
                                <button
                                    className="pos-unit-toggle-btn"
                                    onClick={handleToggleUnits}
                                    title={`Active Units: ${appPreferences?.units || 'mm'}. Click to toggle mm / inches (G21 / G20)`}
                                >
                                    <Ruler size={10} />
                                    <span>{appPreferences?.units?.toLowerCase() === 'inches' || appPreferences?.units?.toLowerCase() === 'in' ? 'in' : 'mm'}</span>
                                </button>
                            </span>
                        </div>

                        {/* Axis Rows */}
                        <div className="dro-container">
                            {(['x', 'y', 'z'] as const).map(axis => {
                                const machinePos = machinePosition;
                                const isInch = appPreferences?.units?.toLowerCase() === 'inches' || appPreferences?.units?.toLowerCase() === 'in';
                                return (
                                    <div className="dro-row" key={axis}>
                                        <div
                                            className="dro-axis-badge"
                                            style={{ background: AXIS_COLORS[axis] }}
                                        >
                                            {axis.toUpperCase()}
                                        </div>
                                        <span className="dro-value">
                                            {formatAxisValue(position[axis])}
                                            <span className="dro-unit">{isInch ? 'in' : 'mm'}</span>
                                        </span>
                                        <span className="dro-machine-value">
                                            {formatAxisValue(machinePos[axis])}
                                        </span>
                                        <div className="dro-btn-group">
                                            <button className="dro-zero-btn" onClick={() => handleZero(axis)} title="Zero this axis">
                                                <Crosshair size={11} />
                                            </button>
                                            <button className="dro-home-btn" onClick={() => handleHomeAxis(axis.toUpperCase() as 'X' | 'Y' | 'Z')} title={`Home ${axis.toUpperCase()} axis`}>
                                                <Home size={11} />
                                            </button>
                                        </div>
                                    </div>
                                );
                            })}
                            {/* A axis (rotary) — only rendered when firmware
                                reports the rotary as connected. Tawfiq msg 7350. */}
                            {aAxis.connected && (() => {
                                const a = aAxis;
                                return (
                                    <div className="dro-row" key="a">
                                        <div className="dro-axis-badge" style={{ background: '#a855f7' }}>A</div>
                                        <span className="dro-value">
                                            {a.work.toFixed(3)}<span className="dro-unit">°</span>
                                        </span>
                                        <span className="dro-machine-value">{a.machine.toFixed(3)}</span>
                                        <div className="dro-btn-group">
                                            <button className="dro-zero-btn" disabled title="Zero rotary (v2)">
                                                <Crosshair size={11} />
                                            </button>
                                            <button className="dro-home-btn" disabled title="Home rotary (v2)">
                                                <Home size={11} />
                                            </button>
                                        </div>
                                    </div>
                                );
                            })()}
                        </div>
                    </div>
                )}

                {/* ──── Tab Content: Jog ──── */}
                {settingsTab === 'Jog' && (
                    <div className="sidebar-section" style={{ borderBottom: 'none' }}>
                        {/* Alarm / Motor Error Banner */}
                        {(machineState === 'alarm' || machineState === 'motorError') && (
                            <div style={{
                                background: 'rgba(220, 50, 50, 0.15)',
                                border: '1px solid rgba(220, 50, 50, 0.4)',
                                borderRadius: '6px',
                                padding: '8px 12px',
                                marginBottom: '8px',
                                display: 'flex',
                                flexDirection: 'column',
                                gap: '6px',
                            }}>
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                                    <span style={{ color: '#ff6b6b', fontWeight: 700, fontSize: '12px' }}>
                                        {machineState === 'motorError'
                                            ? 'MOTOR ERROR — Closed-loop error'
                                            : 'ALARM — Machine locked'}
                                    </span>
                                </div>
                                <div style={{ display: 'flex', gap: '4px' }}>
                                    {['X', 'Y', 'Z'].map(axis => (
                                        <button key={axis}
                                            onClick={() => { backendMotorReset(axis); addConsoleLog('info', `Resetting ${axis} motor...`); }}
                                            style={{ flex: 1, background: '#c0392b', color: '#fff', border: 'none', borderRadius: '4px', padding: '4px 8px', fontSize: '11px', fontWeight: 700, cursor: 'pointer' }}>
                                            Reset {axis}
                                        </button>
                                    ))}
                                    <button
                                        onClick={() => { backendMotorReset(); backendUnlock(); addConsoleLog('info', 'Resetting all motors...'); }}
                                        style={{ flex: 1, background: '#2980b9', color: '#fff', border: 'none', borderRadius: '4px', padding: '4px 8px', fontSize: '11px', fontWeight: 700, cursor: 'pointer' }}>
                                        Reset All
                                    </button>
                                </div>
                            </div>
                        )}
                        <span className="section-label">Manual Jog Control</span>

                        <div className="jog-grid">
                            {/* Circular Jog Control - 8 pie slices with 3° gaps */}
                            <div className="jog-radial-container">
                                <svg viewBox="0 0 240 240" className="jog-clean-svg">
                                    {/*
                                        Math: center=(120,120), radius=98
                                        x = 120 + 98*sin(θ°), y = 120 - 98*cos(θ°)
                                        8 segments × 42° + 8 gaps × 3° = 360°
                                        N:339°-21° NE:24°-66° E:69°-111° SE:114°-156°
                                        S:159°-201° SW:204°-246° W:249°-291° NW:294°-336°
                                    */}

                                    {/* N - Up (Y+) : 339° to 21° */}
                                    <path d="M120 120 L84.88 28.51 A98 98 0 0 1 155.12 28.51Z" className="jog-ref-segment" onClick={() => handleJog('y', 1)}/>

                                    {/* NE - Diagonal : 24° to 66° */}
                                    <path d="M120 120 L159.86 30.47 A98 98 0 0 1 209.52 80.14Z" className="jog-ref-segment" onClick={() => handleDiagonalJog(1, 1)}/>

                                    {/* E - Right (X+) : 69° to 111° */}
                                    <path d="M120 120 L211.49 84.88 A98 98 0 0 1 211.49 155.12Z" className="jog-ref-segment" onClick={() => handleJog('x', 1)}/>

                                    {/* SE - Diagonal : 114° to 156° */}
                                    <path d="M120 120 L209.52 159.86 A98 98 0 0 1 159.86 209.52Z" className="jog-ref-segment" onClick={() => handleDiagonalJog(1, -1)}/>

                                    {/* S - Down (Y-) : 159° to 201° */}
                                    <path d="M120 120 L155.12 211.49 A98 98 0 0 1 84.88 211.49Z" className="jog-ref-segment" onClick={() => handleJog('y', -1)}/>

                                    {/* SW - Diagonal : 204° to 246° */}
                                    <path d="M120 120 L80.14 209.52 A98 98 0 0 1 30.48 159.86Z" className="jog-ref-segment" onClick={() => handleDiagonalJog(-1, -1)}/>

                                    {/* W - Left (X-) : 249° to 291° */}
                                    <path d="M120 120 L28.51 155.12 A98 98 0 0 1 28.51 84.88Z" className="jog-ref-segment" onClick={() => handleJog('x', -1)}/>

                                    {/* NW - Diagonal : 294° to 336° */}
                                    <path d="M120 120 L30.48 80.14 A98 98 0 0 1 80.14 30.48Z" className="jog-ref-segment" onClick={() => handleDiagonalJog(-1, 1)}/>

                                    {/* Cardinal block arrows + labels */}
                                    {/* N - Up arrow */}
                                    <g transform="translate(120 56)" pointerEvents="none"><polygon points="0,-14 12,0 5,0 5,12 -5,12 -5,0 -12,0" className="jog-ref-icon"/></g>
                                    <text x="120" y="82" textAnchor="middle" className="jog-ref-label" pointerEvents="none">Y+</text>

                                    {/* E - Right arrow */}
                                    <g transform="translate(186 120) rotate(90)" pointerEvents="none"><polygon points="0,-14 12,0 5,0 5,12 -5,12 -5,0 -12,0" className="jog-ref-icon"/></g>
                                    <text x="166" y="124" textAnchor="middle" className="jog-ref-label" pointerEvents="none">X+</text>

                                    {/* S - Down arrow */}
                                    <g transform="translate(120 184) rotate(180)" pointerEvents="none"><polygon points="0,-14 12,0 5,0 5,12 -5,12 -5,0 -12,0" className="jog-ref-icon"/></g>
                                    <text x="120" y="168" textAnchor="middle" className="jog-ref-label" pointerEvents="none">Y-</text>

                                    {/* W - Left arrow */}
                                    <g transform="translate(54 120) rotate(270)" pointerEvents="none"><polygon points="0,-14 12,0 5,0 5,12 -5,12 -5,0 -12,0" className="jog-ref-icon"/></g>
                                    <text x="74" y="124" textAnchor="middle" className="jog-ref-label" pointerEvents="none">X-</text>

                                    {/* Diagonal arrows (triangles) */}
                                    <g transform="translate(163 77) rotate(45)" pointerEvents="none"><polygon points="0,-9 7,4 -7,4" className="jog-ref-icon"/></g>
                                    <g transform="translate(163 163) rotate(135)" pointerEvents="none"><polygon points="0,-9 7,4 -7,4" className="jog-ref-icon"/></g>
                                    <g transform="translate(77 163) rotate(225)" pointerEvents="none"><polygon points="0,-9 7,4 -7,4" className="jog-ref-icon"/></g>
                                    <g transform="translate(77 77) rotate(315)" pointerEvents="none"><polygon points="0,-9 7,4 -7,4" className="jog-ref-icon"/></g>

                                    {/* Center STOP button - OCTAGONAL like reference */}
                                    <polygon points="133,88 152,107 152,133 133,152 107,152 88,133 88,107 107,88" className="jog-ref-stop"/>
                                    <text x="120" y="127" textAnchor="middle" className="jog-ref-stop-text" pointerEvents="none">STOP</text>
                                </svg>
                            </div>

                            {/* Z Controls */}
                            <div className="jog-z-column">
                                <span className="jog-z-label">Z Axis</span>
                                <button className="jog-z-btn" onClick={() => handleJog('z', 1)}>
                                    <ChevronUp size={20} />
                                    <span>Z+</span>
                                </button>
                                <button className="jog-z-btn" onClick={() => handleJog('z', -1)}>
                                    <ChevronDown size={20} />
                                    <span>Z−</span>
                                </button>
                            </div>
                        </div>

                        {/* Step selection */}
                        <div className="step-row flex items-center gap-2 mt-3">
                            <span className="step-label text-xs font-bold text-text-dim uppercase tracking-wider whitespace-nowrap">Step (mm)</span>
                            <div className="step-options flex gap-1 flex-1">
                                {[0.1, 1, 10, 50, 100].map(s => (
                                    <button
                                        key={s}
                                        className={`step-opt flex-1 py-1 text-xs font-semibold font-mono text-center rounded-sm border transition-all duration-fast ${
                                            jogDistance === s 
                                                ? 'bg-blue-600 text-white border-blue-600 font-bold shadow-lg ring-2 ring-blue-300' 
                                                : 'bg-bg-input text-text-dim border-border-ui hover:border-border-hover hover:text-text-main'
                                        }`}
                                        onClick={() => setJogDistance(s)}
                                    >
                                        {s}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* Speed selection */}
                        <div className="step-row flex items-center gap-2 mt-2">
                            <span className="step-label text-xs font-bold text-text-dim uppercase tracking-wider whitespace-nowrap">Speed</span>
                            <div className="step-options flex gap-1 flex-1">
                                {jogSpeedPresets.map(({ label, value }) => (
                                    <button
                                        key={value}
                                        className={`step-opt flex-1 py-1 text-xs font-semibold text-center rounded-sm border transition-all duration-fast ${
                                            jogSpeed === value
                                                ? 'bg-blue-600 text-white border-blue-600 font-bold shadow-lg ring-2 ring-blue-300'
                                                : 'bg-bg-input text-text-dim border-border-ui hover:border-border-hover hover:text-text-main'
                                        }`}
                                        onClick={() => setJogSpeed(value)}
                                    >
                                        {label}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* Coordinate System Selection */}
                        <div className="coord-system-row flex items-center gap-2 mt-3">
                            <span className="coord-label text-xs font-bold text-text-dim uppercase tracking-wider whitespace-nowrap flex-shrink-0">Coordinate System</span>
                            <div className="coord-buttons flex gap-1 flex-1">
                                {(['Z', 'XYZ', 'XY', 'X', 'Y'] as const).map(system => (
                                    <button
                                        key={system}
                                        className={`coord-btn flex-1 px-2 py-1.5 text-xs font-semibold text-center rounded-sm border transition-all duration-fast uppercase tracking-wider ${
                                            coordSystem === system 
                                                ? 'bg-blue-600 text-white border-blue-600 font-bold shadow-lg ring-2 ring-blue-300' 
                                                : 'bg-bg-input text-text-dim border-border-ui hover:border-border-hover hover:text-text-main hover:bg-bg-hover'
                                        }`}
                                        onClick={() => setCoordSystem(system)}
                                    >
                                        {system}
                                    </button>
                                ))}
                            </div>
                        </div>
                    </div>
                )}


                {/* ──── Tab Content: Probe ──── (Tawfiq msg 7364 — type
                    selection moved here; clicking a card opens the modal
                    directly at the JOG+BIT step.) */}
                {/* ──── Tab Content: Controls (Coolant + Spindle/Laser) ──── */}
                {settingsTab === 'Controls' && (
                    <div className="sidebar-section" style={{ borderBottom: 'none' }}>
                        <div className="section-header" style={{ marginBottom: '12px' }}>
                            <span className="section-label">Machine Controls</span>
                        </div>

                        <div style={{ marginBottom: '16px' }}>
                            <CoolantControl />
                        </div>

                        <div className="sidebar-divider" />

                        <div style={{ marginTop: '16px', marginBottom: '16px' }}>
                            <div className="section-label" style={{ marginBottom: '8px' }}>Spindle / Laser</div>
                            <SpindleLaserControl />
                        </div>

                        <div className="sidebar-divider" />

                        {/* Feed-rate override -- Tawfiq msg11358: "speed of the
                            design can be change in the control software in
                            the controls". Backend + RSP protocol already had
                            this end-to-end; only the UI control was missing. */}
                        <div style={{ marginTop: '16px' }}>
                            <FeedOverrideControl />
                        </div>
                    </div>
                )}

                {/* ──── Tab Content: Macros ──── */}
                {settingsTab === 'Macros' && (
                    <div className="settings-content">
                        <div className="macro-section">
                            <div className="macro-header">
                                <span className="section-label">Macro Management</span>
                                <button
                                    className="macro-add-btn"
                                    onClick={() => {
                                        setEditingMacro(null);
                                        setShowMacroForm(true);
                                    }}
                                >
                                    <Plus size={14} />
                                    Add Macro
                                </button>
                            </div>

                            {showMacroForm && (
                                <MacroForm
                                    macro={editingMacro}
                                    onSave={handleSaveMacro}
                                    onCancel={() => {
                                        setEditingMacro(null);
                                        setShowMacroForm(false);
                                    }}
                                />
                            )}

                            <div className="macro-list">
                                {macros.length === 0 ? (
                                    <div className="macro-empty">
                                        <Settings size={28} />
                                        <p>No macros created yet</p>
                                        <small>Create macros to automate common G-code sequences</small>
                                    </div>
                                ) : (
                                    macros.map((macro) => (
                                        <div key={macro.id} className="macro-item">
                                            <div className="macro-info">
                                                <span className="macro-name">{macro.name}</span>
                                                <span className="macro-preview">
                                                    {macro.content.split('\n')[0].substring(0, 40)}
                                                    {macro.content.length > 40 ? '...' : ''}
                                                </span>
                                            </div>
                                            <div className="macro-actions">
                                                <button
                                                    className="macro-run-btn"
                                                    onClick={() => handleRunMacro(macro)}
                                                    disabled={!connected}
                                                    title="Run Macro"
                                                >
                                                    <Play size={12} />
                                                </button>
                                                <button
                                                    className="macro-edit-btn"
                                                    onClick={() => {
                                                        setEditingMacro(macro);
                                                        setShowMacroForm(true);
                                                    }}
                                                    title="Edit Macro"
                                                >
                                                    <Edit size={12} />
                                                </button>
                                                <button
                                                    className="macro-delete-btn"
                                                    onClick={() => handleDeleteMacro(macro.id)}
                                                    title="Delete Macro"
                                                >
                                                    <Trash2 size={12} />
                                                </button>
                                            </div>
                                        </div>
                                    ))
                                )}
                            </div>
                        </div>
                    </div>
                )}

                {/* ──── Tab Content: Console ──── */}
                {settingsTab === 'Console' && (
                    <div className="sidebar-section" style={{ borderBottom: 'none', padding: 0 }}>
                        <div className="console-section">
                            <div className="console-header" onClick={() => setConsoleExpanded(!consoleExpanded)}>
                                <div className="console-title">
                                    <Terminal size={14} />
                                    <span>Console</span>
                                    <span className="console-count">({consoleLines.length})</span>
                                </div>
                                <button className="console-toggle">
                                    {consoleExpanded ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
                                </button>
                            </div>

                            <div className="console-body" ref={consoleOutputRef} style={{ maxHeight: consoleExpanded ? 400 : 200 }}>
                                {consoleLines.map((line, i) => (
                                    <div key={i} className={`console-line ${getConsoleClass(line.type)}`}>
                                        <span className="console-icon">{getConsoleIcon(line.type)}</span>
                                        <span className="console-text">{line.text}</span>
                                    </div>
                                ))}
                                {consoleLines.length === 0 && (
                                    <div className="console-empty">
                                        <Terminal size={28} />
                                        <p>No messages yet</p>
                                    </div>
                                )}
                            </div>
                            <div className="console-input-row">
                                <input
                                    className="console-input"
                                    type="text"
                                    placeholder="Type G-code command..."
                                    value={consoleCmd}
                                    onChange={(e) => setConsoleCmd(e.target.value)}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter' && consoleCmd.trim()) {
                                            sendBackendCommand(consoleCmd.trim());
                                            addConsoleLog('info', `> ${consoleCmd.trim()}`);
                                            setConsoleCmd('');
                                        }
                                    }}
                                />
                                <button
                                    className="console-send-btn"
                                    onClick={() => {
                                        if (consoleCmd.trim()) {
                                            sendBackendCommand(consoleCmd.trim());
                                            addConsoleLog('info', `> ${consoleCmd.trim()}`);
                                            setConsoleCmd('');
                                        }
                                    }}
                                >Send</button>
                            </div>
                        </div>
                    </div>
                )}

            </div>

            {/* Camera panel — fixed footer, outside the scroll area */}
            <CameraView />
        </aside>
    );
}

// Macro Form Component
interface MacroFormProps {
    macro: {id: string, name: string, content: string} | null;
    onSave: (name: string, content: string) => void;
    onCancel: () => void;
}

function MacroForm({ macro, onSave, onCancel }: MacroFormProps) {
    const [name, setName] = useState(macro?.name || '');
    const [content, setContent] = useState(macro?.content || '');

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (name.trim() && content.trim()) {
            onSave(name.trim(), content.trim());
        }
    };

    return (
        <div className="macro-form">
            <form onSubmit={handleSubmit}>
                <div className="form-group">
                    <label>Macro Name</label>
                    <input
                        type="text"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="Enter macro name..."
                        required
                    />
                </div>
                <div className="form-group">
                    <label>G-code Commands</label>
                    <textarea
                        value={content}
                        onChange={(e) => setContent(e.target.value)}
                        placeholder="Enter G-code commands (one per line)..."
                        rows={6}
                        required
                    />
                </div>
                <div className="form-actions">
                    <button type="button" onClick={onCancel} className="btn-cancel">
                        Cancel
                    </button>
                    <button type="submit" className="btn-save">
                        {macro ? 'Update' : 'Create'} Macro
                    </button>
                </div>
            </form>
        </div>
    );
}
