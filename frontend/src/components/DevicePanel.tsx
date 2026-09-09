import { useState, useEffect, useRef } from 'react';
import { Wifi, RefreshCw, ChevronDown, Check, Loader, Gamepad2, PlayCircle, StopCircle, Target, Cpu, Layout } from 'lucide-react';
import { useCNCStore } from '../stores/cncStore';
import {
    requestBackendPorts,
    connectToBackendPort,
    disconnectFromBackendPort,
    connectBackendSocket,
    backendJog,
    setBackendActiveMachineProfile,
    type BackendPort,
} from '../utils/backendConnection';
import { lastDeviceStorage } from '../utils/localStorage';
import { JoystickManager, JoystickCNCMapper, type JoystickState } from '../utils/joystickManager';
import FirmwareSettings from './FirmwareSettings';
import MachineProfiles from './MachineProfiles';
import './DevicePanel.css';

export default function DevicePanel() {
    const { 
        connected, 
        connectionStatus,
        backendSocketConnected,
        position,
        machinePosition,
        machineState,
        activeWCS,
        setActiveWCS,
        machineProfiles,
        activeMachineProfile,
        setActiveMachineProfile,
    } = useCNCStore();

    const [availablePorts, setAvailablePorts] = useState<BackendPort[]>([]);
    const [selectedPort, setSelectedPort] = useState<BackendPort | null>(null);
    const [isDropdownOpen, setIsDropdownOpen] = useState(false);
    const [isRefreshing, setIsRefreshing] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // Local state for baud rate and flow control — avoids store sync bugs
    const [localBaudRate, setLocalBaudRate] = useState<number>(() =>
        useCNCStore.getState().appPreferences?.baudRate ?? 115200
    );
    const [localRtscts, setLocalRtscts] = useState<boolean>(() =>
        useCNCStore.getState().appPreferences?.rtscts ?? false
    );

    // Joystick state
    const [joystickManager] = useState(() => new JoystickManager());
    const [joystickMapper] = useState(() => new JoystickCNCMapper(500, 2000));
    const [joystickConnected, setJoystickConnected] = useState(false);
    const [joystickActive, setJoystickActive] = useState(false);
    const [joystickInfo, setJoystickInfo] = useState<string>('');
    const [joystickState, setJoystickState] = useState<JoystickState | null>(null);
    // Not React state on purpose: this is a pure throttle timestamp, read
    // and written only from inside the joystickManager poll callback below
    // (registered once per connect, never re-created on render) -- as a
    // useState value it was captured into that callback's closure at
    // connect-time and never saw its own updates, so the 100ms throttle
    // only worked during the app's very first 100ms of life. Same reason
    // `connected`/`joystickActive` are mirrored into refs below instead of
    // read directly from the closure.
    const lastJogTimeRef = useRef(0);
    const connectedRef = useRef(connected);
    const joystickActiveRef = useRef(joystickActive);
    const joystickUnsubscribeRef = useRef<(() => void) | null>(null);
    useEffect(() => { connectedRef.current = connected; }, [connected]);
    useEffect(() => { joystickActiveRef.current = joystickActive; }, [joystickActive]);

    // UI state
    const [activeSection, setActiveSection] = useState<'controller' | 'joystick' | 'position' | 'firmware' | 'profiles'>('controller');

    // DRO state (reserved for future inline DRO editing)
    const [_editingAxis, _setEditingAxis] = useState<string | null>(null);
    const [_editValue, _setEditValue] = useState<string>('');
    // Track last position update time via ref to avoid re-renders on every position tick
    const lastPositionUpdateRef = useRef<number>(Date.now());
    useEffect(() => {
        lastPositionUpdateRef.current = Date.now();
    }, [position, machinePosition]);

    useEffect(() => {
        // Connect to backend Socket.IO on mount
        connectBackendSocket().then(() => {
            loadPorts();
        }).catch((err) => {
            setError(`Backend not available. Start the backend (port 4000) or check your connection. ${err?.message ? ` (${err.message})` : ''}`);
        });

        // Check for joystick on mount
        if (JoystickManager.isSupported()) {
            const gamepads = JoystickManager.getConnectedGamepads();
            if (gamepads.length > 0) {
                setJoystickInfo(`${gamepads[0].id} detected`);
            }
        }

        // Cleanup joystick on unmount
        return () => {
            joystickUnsubscribeRef.current?.();
            joystickUnsubscribeRef.current = null;
            if (joystickManager.isConnected()) {
                joystickManager.disconnect();
            }
        };
    }, [joystickManager]);

    const loadPorts = async () => {
        setIsRefreshing(true);
        setError(null);

        try {
            const ports = await requestBackendPorts();
            setAvailablePorts(ports);

            if (ports.length === 0) {
                setError('No serial ports found. Check USB connection and power.');
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to load devices');
        } finally {
            setIsRefreshing(false);
        }
    };

    const handleSelectPort = (port: BackendPort) => {
        setSelectedPort(port);
        setIsDropdownOpen(false);
    };

    // Shared by the manual Connect button and the auto-connect poll below --
    // takes the port explicitly instead of reading `selectedPort` state so
    // the auto-connect path can't race a stale/async setState read.
    const connectToPort = async (port: BackendPort) => {
        try {
            setError(null);
            useCNCStore.getState().setConnectionStatus('connecting');
            console.log(`[DevicePanel] Connecting: ${port.port}, baudRate=${localBaudRate}, rtscts=${localRtscts}`);
            await connectToBackendPort(port.port, { baudRate: localBaudRate, rtscts: localRtscts });
            useCNCStore.getState().setConnectedPortInfo(
                { port: port.port, manufacturer: port.manufacturer, vendorId: port.vendorId, productId: port.productId }
            );
            // Remember this device (by VID/PID, not OS path) so a future
            // session auto-connects to it directly (Tawfiq msg11347 item 4).
            if (port.vendorId && port.productId) {
                lastDeviceStorage.save({ vendorId: port.vendorId, productId: port.productId });
            }
        } catch (err) {
            console.error('Connection failed:', err);
            const errObj = err as Error | { message?: string } | null;
            const errorMessage =
                errObj && typeof errObj === 'object' && 'message' in errObj && String(errObj.message).trim()
                    ? String(errObj.message)
                    : err instanceof Error
                        ? err.message
                        : 'Connection failed';
            setError(errorMessage);
            useCNCStore.getState().setConnectionStatus('error');
        }
    };

    const handleConnect = async () => {
        if (!selectedPort) {
            setError('Please select a serial port');
            return;
        }
        await connectToPort(selectedPort);
    };

    // Auto-connect now lives in hooks/useAutoConnect.ts, called once from
    // App.tsx's always-mounted root -- it used to be a useEffect here, but
    // that meant it died the instant the user left the Device tab (Tawfiq
    // msg11358 item 3). This panel still owns manual connect (handleConnect
    // above) and its own port-list dropdown (loadPorts/availablePorts).

    const handleDisconnect = async () => {
        try {
            await disconnectFromBackendPort();
            setError(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Disconnect failed');
        }
    };

    const getPortDisplayName = (port: BackendPort): string => {
        if (port.manufacturer) {
            return `${port.manufacturer} (${port.port})`;
        }
        if (port.vendorId) {
            const vid = port.vendorId.toUpperCase();
            if (vid.includes('1A86')) return `CH340 Serial (${port.port})`;
            if (vid.includes('0403')) return `FTDI Serial (${port.port})`;
            if (vid.includes('10C4')) return `CP210x Serial (${port.port})`;
            if (vid.includes('2341')) return `Arduino (${port.port})`;
            return `USB Serial VID:${vid} (${port.port})`;
        }
        return port.port;
    };

    // Joystick handlers
    const handleConnectJoystick = () => {
        try {
            if (!JoystickManager.isSupported()) {
                setError('Gamepad API not supported in this browser');
                return;
            }

            joystickManager.connect();
            const info = joystickManager.getGamepadInfo();

            if (info) {
                setJoystickConnected(true);
                setJoystickInfo(info.id);
                setError(null);

                // Defensive: unsubscribe any stray previous listener before
                // registering a fresh one, so this handler firing twice (or
                // a reconnect that raced its own cleanup) can never stack a
                // second poll callback.
                joystickUnsubscribeRef.current?.();
                joystickUnsubscribeRef.current = joystickManager.onStateChange((state) => {
                    setJoystickState(state);
                    handleJoystickJog(state);
                });
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to connect joystick');
        }
    };

    const handleDisconnectJoystick = () => {
        joystickUnsubscribeRef.current?.();
        joystickUnsubscribeRef.current = null;
        joystickManager.disconnect();
        setJoystickConnected(false);
        setJoystickActive(false);
        setJoystickInfo('');
        setJoystickState(null);
    };

    const handleToggleJoystickActive = () => {
        if (!connected) {
            setError('Connect to CNC controller first');
            return;
        }
        setJoystickActive(!joystickActive);
    };

    const handleJoystickJog = (state: JoystickState) => {
        if (!connectedRef.current || !joystickActiveRef.current) return;

        const jogCmd = joystickMapper.mapAxesToJog(state.axes);

        if (jogCmd) {
            const now = Date.now();
            if (now - lastJogTimeRef.current < 100) return;
            lastJogTimeRef.current = now;

            const { x, y, z, feedRate } = jogCmd;
            
            if (Math.abs(x) > 0.01 || Math.abs(y) > 0.01 || Math.abs(z) > 0.01) {
                const scaleFactor = feedRate / 2000;
                const distance = 0.5 * scaleFactor;
                
                backendJog(
                    Math.abs(x) > 0.01 ? x * distance : undefined,
                    Math.abs(y) > 0.01 ? y * distance : undefined,
                    Math.abs(z) > 0.01 ? z * distance : undefined,
                    feedRate
                );
            }
        }
    };

    // Full-bleed sections that take over the entire panel
    const isFullBleed = activeSection === 'firmware' || activeSection === 'profiles';

    return (
        <div className={`device-panel${isFullBleed ? ' full-panel' : ''}`}>
            <div className={isFullBleed ? 'device-section-fullbleed' : 'device-section'}>
                {/* Header with Section Tabs */}
                <div className="section-header-device" style={isFullBleed ? { maxWidth: '100%', padding: '0 var(--space-5)', margin: 0 } : undefined}>
                    <h3>Device Management</h3>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <span className={`backend-status ${backendSocketConnected ? 'online' : 'offline'}`}
                              title={backendSocketConnected ? 'Backend connected' : 'Backend disconnected'}>
                            {backendSocketConnected ? 'Backend Online' : 'Backend Offline'}
                        </span>
                        <button
                            className="refresh-btn"
                            onClick={loadPorts}
                            disabled={isRefreshing || !backendSocketConnected}
                            title="Refresh device list"
                        >
                            <RefreshCw size={14} className={isRefreshing ? 'spinning' : ''} />
                        </button>
                    </div>
                </div>

                {/* Section Selector */}
                <div className="device-section-tabs">
                    <button
                        className={`section-tab ${activeSection === 'controller' ? 'active' : ''}`}
                        onClick={() => setActiveSection('controller')}
                    >
                        <Wifi size={16} />
                        <span>CNC Controller</span>
                        {connected && <span className="tab-badge">●</span>}
                    </button>
                    <button
                        className={`section-tab ${activeSection === 'joystick' ? 'active' : ''}`}
                        onClick={() => setActiveSection('joystick')}
                    >
                        <Gamepad2 size={16} />
                        <span>Joystick Control</span>
                        {joystickConnected && <span className="tab-badge">●</span>}
                    </button>
                    <button
                        className={`section-tab ${activeSection === 'position' ? 'active' : ''}`}
                        onClick={() => setActiveSection('position')}
                    >
                        <Target size={16} />
                        <span>Position (DRO)</span>
                        {connected && <span className="tab-badge">●</span>}
                    </button>
                    <button
                        className={`section-tab ${activeSection === 'firmware' ? 'active' : ''}`}
                        onClick={() => setActiveSection('firmware')}
                    >
                        <Cpu size={16} />
                        <span>Firmware</span>
                    </button>
                    <button
                        className={`section-tab ${activeSection === 'profiles' ? 'active' : ''}`}
                        onClick={() => setActiveSection('profiles')}
                    >
                        <Layout size={16} />
                        <span>Profiles</span>
                    </button>
                </div>

                {/* CNC Controller Section */}
                {activeSection === 'controller' && (
                    <div className="device-content">

                        {/* Device Selector Dropdown */}
                        <div className="device-selector">
                            <label className="device-label">Select CNC Controller</label>
                            <div className="dropdown-container">
                                <button
                                    className={`dropdown-trigger ${isDropdownOpen ? 'open' : ''}`}
                                    onClick={() => setIsDropdownOpen(!isDropdownOpen)}
                                    disabled={connected}
                                >
                                    <Wifi size={16} />
                                    <span className="dropdown-text">
                                        {selectedPort 
                                            ? getPortDisplayName(selectedPort)
                                            : 'Select a device...'}
                                    </span>
                                    <ChevronDown size={16} className={`chevron ${isDropdownOpen ? 'open' : ''}`} />
                                </button>

                                {isDropdownOpen && (
                                    <div className="dropdown-menu">
                                        {availablePorts.length === 0 ? (
                                            <div className="dropdown-empty">
                                                <p>No serial ports found</p>
                                                <small>Check USB connection and power</small>
                                            </div>
                                        ) : (
                                            availablePorts.map((port, index) => (
                                                <button
                                                    key={index}
                                                    className={`dropdown-item ${selectedPort?.port === port.port ? 'selected' : ''}`}
                                                    onClick={() => handleSelectPort(port)}
                                                >
                                                    <div className="dropdown-item-content">
                                                        <Wifi size={14} />
                                                        <div className="dropdown-item-text">
                                                            <span className="device-name">
                                                                {getPortDisplayName(port)}
                                                            </span>
                                                            {port.vendorId && (
                                                                <span className="device-id">
                                                                    VID:{port.vendorId} | PID:{port.productId}
                                                                </span>
                                                            )}
                                                        </div>
                                                    </div>
                                                    {selectedPort?.port === port.port && (
                                                        <Check size={16} className="check-icon" />
                                                    )}
                                                </button>
                                            ))
                                        )}
                                    </div>
                                )}
                            </div>
                        </div>

                        {/* Serial Settings: Baud Rate & Flow Control */}
                        <div className="device-selector" style={{ marginTop: '8px' }}>
                            <label className="device-label">Baud Rate</label>
                            <select
                                value={localBaudRate}
                                onChange={(e) => {
                                    const val = Number(e.target.value);
                                    setLocalBaudRate(val);
                                    const store = useCNCStore.getState();
                                    store.setAppPreferences({ ...store.appPreferences, baudRate: val });
                                }}
                                disabled={connected}
                                style={{
                                    width: '100%',
                                    padding: '8px 12px',
                                    borderRadius: '6px',
                                    border: '1px solid var(--border-ui)',
                                    background: 'var(--bg-input)',
                                    color: 'var(--text-main)',
                                    fontSize: '13px',
                                }}
                            >
                                <option value={9600}>9600</option>
                                <option value={19200}>19200</option>
                                <option value={38400}>38400</option>
                                <option value={57600}>57600</option>
                                <option value={115200}>115200 (GRBL/grblHAL)</option>
                                <option value={230400}>230400 (RTS/Buildbotics)</option>
                                <option value={250000}>250000</option>
                            </select>
                            <small style={{ color: 'var(--text-dim)', fontSize: '11px', marginTop: '2px', display: 'block' }}>
                                GRBL/grblHAL: 115200 | RTS/Buildbotics: 230400
                            </small>
                        </div>

                        <div className="device-selector" style={{ marginTop: '8px' }}>
                            <label className="device-label">Flow Control</label>
                            <select
                                value={localRtscts ? 'rtscts' : 'none'}
                                onChange={(e) => {
                                    const val = e.target.value === 'rtscts';
                                    setLocalRtscts(val);
                                    const store = useCNCStore.getState();
                                    store.setAppPreferences({ ...store.appPreferences, rtscts: val });
                                }}
                                disabled={connected}
                                style={{
                                    width: '100%',
                                    padding: '8px 12px',
                                    borderRadius: '6px',
                                    border: '1px solid var(--border-ui)',
                                    background: 'var(--bg-input)',
                                    color: 'var(--text-main)',
                                    fontSize: '13px',
                                }}
                            >
                                <option value="none">None (GRBL/grblHAL)</option>
                                <option value="rtscts">RTS/CTS Hardware (RTS/Buildbotics)</option>
                            </select>
                            <small style={{ color: 'var(--text-dim)', fontSize: '11px', marginTop: '2px', display: 'block' }}>
                                Enable RTS/CTS for RealtimeCNC RTS-1/RTS-2 boards
                            </small>
                        </div>

                        {/* Connection Button */}
                        <div className="connection-actions">
                            {!connected ? (
                                <button
                                    className={`connect-btn ${connectionStatus === 'connecting' ? 'connecting' : ''}`}
                                    onClick={handleConnect}
                                    disabled={connectionStatus === 'connecting' || !selectedPort || !backendSocketConnected}
                                >
                                    {connectionStatus === 'connecting' ? (
                                        <>
                                            <Loader size={16} className="spinning" />
                                            Connecting...
                                        </>
                                    ) : (
                                        <>
                                            <Wifi size={16} />
                                            Connect
                                        </>
                                    )}
                                </button>
                            ) : (
                                <button
                                    className="disconnect-btn"
                                    onClick={handleDisconnect}
                                >
                                    <Wifi size={16} />
                                    Disconnect
                                </button>
                            )}
                        </div>

                        {/* Connection Status */}
                        <div className={`connection-status ${connectionStatus}`}>
                            <div className={`status-indicator ${connectionStatus}`}></div>
                            <span className="status-text">
                                {connectionStatus === 'disconnected' && 'Not Connected'}
                                {connectionStatus === 'connecting' && 'Connecting...'}
                                {connectionStatus === 'connected' && `Connected to ${selectedPort ? getPortDisplayName(selectedPort) : 'device'}`}
                                {connectionStatus === 'error' && 'Connection Error'}
                            </span>
                        </div>

                        {/* Error Message */}
                        {error && (
                            <div className="error-message">
                                <p>{error}</p>
                                <details style={{ marginTop: '8px', fontSize: '12px', opacity: 0.8 }}>
                                    <summary>Troubleshooting Tips</summary>
                                    <ul style={{ marginTop: '4px', paddingLeft: '16px' }}>
                                        <li>Ensure your CNC controller is powered on and connected via USB</li>
                                        <li>Close other CNC software (UGS, bCNC, Candle, RTS-X, etc.) that may be using the port</li>
                                        <li>Try unplugging and reconnecting the USB cable</li>
                                        <li>Check if the device appears in Windows Device Manager (Ports)</li>
                                        <li>Start the backend server (port 4000) and ensure no firewall is blocking it</li>
                                    </ul>
                                </details>
                            </div>
                        )}

                        {/* Device Information */}
                        {connected && selectedPort && (
                            <div className="device-info-card">
                                <h4>Device Information</h4>
                                <div className="info-row">
                                    <span className="info-label">Port:</span>
                                    <span className="info-value">{selectedPort.port}</span>
                                </div>
                                {selectedPort.manufacturer && (
                                    <div className="info-row">
                                        <span className="info-label">Manufacturer:</span>
                                        <span className="info-value">{selectedPort.manufacturer}</span>
                                    </div>
                                )}
                                {selectedPort.vendorId && (
                                    <div className="info-row">
                                        <span className="info-label">Vendor ID:</span>
                                        <span className="info-value">{selectedPort.vendorId}</span>
                                    </div>
                                )}
                                <div className="info-row">
                                    <span className="info-label">Baud Rate:</span>
                                    <span className="info-value">{localBaudRate}</span>
                                </div>
                            </div>
                        )}

                        {/* Machine Information */}
                        <div className="device-info-card machine-info-card">
                            <h4>Machine Information</h4>
                            <div className="machine-profile-select-row">
                                <label className="info-label" htmlFor="machine-profile-select">Machine profile</label>
                                <select
                                    id="machine-profile-select"
                                    className="machine-profile-select"
                                    value={activeMachineProfile ?? ''}
                                    onChange={(e) => {
                                        const id = e.target.value || null;
                                        setActiveMachineProfile(id);
                                        setBackendActiveMachineProfile(id);
                                    }}
                                >
                                    {machineProfiles.length === 0 && (
                                        <option value="">No profiles</option>
                                    )}
                                    {machineProfiles.map((p) => (
                                        <option key={p.id} value={p.id}>
                                            {p.name}
                                        </option>
                                    ))}
                                </select>
                            </div>
                            {activeMachineProfile && (() => {
                                const profile = machineProfiles.find((p) => p.id === activeMachineProfile);
                                if (!profile) return null;
                                return (
                                    <div className="machine-details-block">
                                        {profile.voltage != null && profile.voltage !== '' && (
                                            <div className="info-row">
                                                <span className="info-label">Voltage:</span>
                                                <span className="info-value">{profile.voltage}</span>
                                            </div>
                                        )}
                                        {profile.workArea != null && profile.workArea !== '' && (
                                            <div className="info-row">
                                                <span className="info-label">Work area:</span>
                                                <span className="info-value">{profile.workArea}</span>
                                            </div>
                                        )}
                                        {profile.maxFeed != null && profile.maxFeed !== '' && (
                                            <div className="info-row">
                                                <span className="info-label">Max feed rate:</span>
                                                <span className="info-value">{profile.maxFeed}</span>
                                            </div>
                                        )}
                                        {profile.spindle != null && profile.spindle !== '' && (
                                            <div className="info-row">
                                                <span className="info-label">Spindle:</span>
                                                <span className="info-value">{profile.spindle}</span>
                                            </div>
                                        )}
                                        {profile.controller != null && profile.controller !== '' && (
                                            <div className="info-row">
                                                <span className="info-label">Controller:</span>
                                                <span className="info-value">{profile.controller}</span>
                                            </div>
                                        )}
                                        {profile.notes != null && profile.notes !== '' && (
                                            <div className="info-row">
                                                <span className="info-label">Notes:</span>
                                                <span className="info-value">{profile.notes}</span>
                                            </div>
                                        )}
                                    </div>
                                );
                            })()}
                        </div>

                        {/* Help Text */}
                        <div className="help-section">
                            <h4>Connection Help</h4>
                            <ul className="help-list">
                                <li>Make sure your CNC controller is connected via USB</li>
                                <li>Close other applications using the serial port (UGS, bCNC, etc.)</li>
                                <li>Supported controllers: GRBL, grblHAL, RTS/Buildbotics</li>
                                <li>Supported controllers: GRBL, grblHAL, FluidNC, RTS-1/RTS-2</li>
                            </ul>
                        </div>
                    </div>
                )}

                {/* Position (DRO) Section */}
                {activeSection === 'position' && (
                    <div className="device-content">
                        <div className="dro-section">
                            <div className="dro-header">
                                <h4>Digital Readout (DRO)</h4>
                                <div className="dro-status">
                                    <span className={`status-indicator ${Date.now() - lastPositionUpdateRef.current < 1000 ? 'active' : ''}`} title="Position updates"></span>
                                </div>
                            </div>
                            <div className="wcs-selector-wrapper">
                                <select 
                                    value={activeWCS} 
                                    onChange={(e) => setActiveWCS(e.target.value)}
                                    disabled={!connected}
                                    className="wcs-selector"
                                >
                                    <option value="G54">G54</option>
                                    <option value="G55">G55</option>
                                    <option value="G56">G56</option>
                                    <option value="G57">G57</option>
                                    <option value="G58">G58</option>
                                    <option value="G59">G59</option>
                                </select>
                            </div>

                            <div className="position-displays">
                                <div className="position-group">
                                    <h5>Work Position</h5>
                                    {(['x', 'y', 'z'] as const).map((axis) => (
                                        <div key={axis} className="axis-row">
                                            <span className={`axis-label axis-${axis}`}>{axis.toUpperCase()}</span>
                                            <span className="axis-value">{position[axis].toFixed(3)}</span>
                                            <span className="axis-unit">mm</span>
                                        </div>
                                    ))}
                                </div>

                                <div className="position-group">
                                    <h5>Machine Position</h5>
                                    {(['x', 'y', 'z'] as const).map((axis) => (
                                        <div key={axis} className="axis-row">
                                            <span className={`axis-label axis-${axis}`}>{axis.toUpperCase()}</span>
                                            <span className="axis-value machine">{machinePosition[axis].toFixed(3)}</span>
                                            <span className="axis-unit">mm</span>
                                        </div>
                                    ))}
                                </div>
                            </div>

                            <div className="zero-controls">
                                <button 
                                    className="zero-btn zero-all"
                                    disabled={!connected || machineState !== 'idle'}
                                    title="Zero all axes"
                                >
                                    Zero All
                                </button>
                                <button 
                                    className="zero-btn zero-xy"
                                    disabled={!connected || machineState !== 'idle'}
                                    title="Zero X and Y axes"
                                >
                                    Zero XY
                                </button>
                                <button 
                                    className="zero-btn zero-z"
                                    disabled={!connected || machineState !== 'idle'}
                                    title="Zero Z axis"
                                >
                                    Zero Z
                                </button>
                            </div>

                            <div className="machine-status-display">
                                <div className={`status-badge ${connected ? 'connected' : 'disconnected'}`}>
                                    <span className="status-dot"></span>
                                    <span className="status-text">
                                        {connected ? `${machineState.toUpperCase()}` : 'DISCONNECTED'}
                                    </span>
                                </div>
                            </div>
                        </div>
                    </div>
                )}

                {/* Firmware Settings Section */}
                {activeSection === 'firmware' && (
                    <div className="device-content">
                        <FirmwareSettings />
                    </div>
                )}

                {/* Machine Profiles Section */}
                {activeSection === 'profiles' && (
                    <div className="device-content">
                        <MachineProfiles />
                    </div>
                )}

                {/* Joystick Control Section */}
                {activeSection === 'joystick' && (
                    <div className="device-content">
                        {!joystickConnected ? (
                            <div className="joystick-connect-prompt">
                                <Gamepad2 size={48} className="joystick-icon-large" />
                                <p>Connect a gamepad or joystick for analog control</p>
                                <button
                                    className="joystick-connect-btn"
                                    onClick={handleConnectJoystick}
                                >
                                    <Gamepad2 size={16} />
                                    Connect Joystick
                                </button>
                                {joystickInfo && (
                                    <small className="joystick-hint">{joystickInfo}</small>
                                )}
                            </div>
                        ) : (
                        <>
                            <div className="joystick-info-card">
                                <div className="joystick-status">
                                    <Gamepad2 size={20} />
                                    <div>
                                        <div className="joystick-name">{joystickInfo}</div>
                                        <div className="joystick-status-text">
                                            {joystickActive ? 'Active' : 'Standby'}
                                        </div>
                                    </div>
                                </div>

                                {joystickState && (
                                    <div className="joystick-axes">
                                        <div className="axis-display">
                                            <span>Left X:</span>
                                            <div className="axis-bar">
                                                <div 
                                                    className="axis-fill" 
                                                    style={{ 
                                                        width: `${Math.abs(joystickState.axes.leftX) * 100}%`,
                                                        background: joystickState.axes.leftX > 0 ? '#10b981' : '#ef4444'
                                                    }}
                                                />
                                            </div>
                                        </div>
                                        <div className="axis-display">
                                            <span>Left Y:</span>
                                            <div className="axis-bar">
                                                <div 
                                                    className="axis-fill" 
                                                    style={{ 
                                                        width: `${Math.abs(joystickState.axes.leftY) * 100}%`,
                                                        background: joystickState.axes.leftY > 0 ? '#10b981' : '#ef4444'
                                                    }}
                                                />
                                            </div>
                                        </div>
                                        <div className="axis-display">
                                            <span>Right Y (Z):</span>
                                            <div className="axis-bar">
                                                <div 
                                                    className="axis-fill" 
                                                    style={{ 
                                                        width: `${Math.abs(joystickState.axes.rightY) * 100}%`,
                                                        background: joystickState.axes.rightY > 0 ? '#10b981' : '#ef4444'
                                                    }}
                                                />
                                            </div>
                                        </div>
                                    </div>
                                )}
                            </div>

                            <div className="joystick-controls">
                                <button
                                    className={`joystick-toggle-btn ${joystickActive ? 'active' : ''}`}
                                    onClick={handleToggleJoystickActive}
                                    disabled={!connected}
                                >
                                    {joystickActive ? (
                                        <>
                                            <StopCircle size={16} />
                                            Stop Control
                                        </>
                                    ) : (
                                        <>
                                            <PlayCircle size={16} />
                                            Start Control
                                        </>
                                    )}
                                </button>

                                <button
                                    className="joystick-disconnect-btn"
                                    onClick={handleDisconnectJoystick}
                                >
                                    Disconnect Joystick
                                </button>
                            </div>

                            <div className="joystick-help">
                                <h5>Controls:</h5>
                                <ul>
                                    <li>Left Stick: X/Y movement</li>
                                    <li>Right Stick (Y): Z movement</li>
                                    <li>Speed varies with stick deflection</li>
                                    <li>Must be connected to CNC to control</li>
                                </ul>
                            </div>
                        </>
                    )}
                    </div>
                )}
            </div>
        </div>
    );
}
