import { create } from 'zustand';
import type {
    MachineState,
    JogMode,
    ViewMode3D,
    ViewPreset,
    ConsoleLine,
    GCodeLine,
    ToolpathSegment,
    Position,
    FileInfo,
    MachineProfile,
    EthernetConfig,
    ProbeSettings,
    AppPreferences,
} from '../types/cnc';
import type { AlarmInfo } from '../utils/controller';
import { getTimestamp } from '../utils/formatters';
import { jogDistanceStorage, jogSpeedStorage, coordSystemStorage, gcodeFileStorage } from '../utils/localStorage';
import type { ParsedToolpath } from '../utils/gcodeParser';

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';
export type CoordSystem = 'Z' | 'XYZ' | 'XY' | 'X' | 'Y';
export type CoolantState = 'off' | 'mist' | 'flood';
export type SpindleMode = 'spindle' | 'laser';

interface CNCStore {
    // Connection
    connected: boolean;
    connectionStatus: ConnectionStatus;
    isInitialized: boolean;
    firmwareType: string;
    firmwareVersion: string;
    backendSocketConnected: boolean;
    setConnected: (connected: boolean) => void;
    setConnectionStatus: (status: ConnectionStatus) => void;
    setInitialized: (initialized: boolean) => void;
    setFirmwareInfo: (type: string, version: string) => void;
    setBackendSocketConnected: (connected: boolean) => void;

    // Raw G-code content
    rawGcodeContent: string | null;
    setRawGcodeContent: (content: string | null) => void;

    // Whether the backend feeder has the file loaded (separate from frontend parse).
    // Cleared on disconnect / new upload, set to true when 'file:load' echo arrives.
    fileLoadedBackend: boolean;
    setFileLoadedBackend: (loaded: boolean) => void;

    // Whether the backend has a live controller instance for the current serial
    // connection. False the instant 'serialport:open' fires (port is open but
    // firmware detection hasn't finished), true once 'controller:type' arrives
    // (CNCEngine.js assigns this.controller synchronously before emitting it).
    // Auto-file-load must wait on this, not just `connected` -- see race in
    // CNCEngine.js _handleFileLoad which hard-rejects file:load with no retry
    // if this.controller is still null.
    controllerReady: boolean;
    setControllerReady: (ready: boolean) => void;

    // Machine State
    machineState: MachineState;
    setMachineState: (state: MachineState) => void;

    // Most recent alarm detail (which axis/type tripped) -- drives the
    // alarm-detail dropdown in Header.tsx. Cleared when the alarm clears.
    lastAlarm: AlarmInfo | null;
    setLastAlarm: (alarm: AlarmInfo | null) => void;

    // Job-active flag (separate from machineState — only true while the
    // GCodeFeeder is actually streaming). machineState='running' can be set
    // by transient firmware states like Home/Jog/Homing, which are not jobs.
    jobActive: boolean;
    setJobActive: (active: boolean) => void;

    // Position
    position: Position;
    setPosition: (position: Position) => void;
    updatePosition: (axis: 'x' | 'y' | 'z', value: number) => void;

    // Jog Controls
    jogMode: JogMode;
    setJogMode: (mode: JogMode) => void;
    jogDistance: number;
    setJogDistance: (distance: number) => void;
    jogSpeed: number;
    setJogSpeed: (speed: number) => void;
    coordSystem: CoordSystem;
    setCoordSystem: (system: CoordSystem) => void;

    // Overrides
    feedRate: number;
    setFeedRate: (rate: number) => void;
    spindleSpeed: number;
    setSpindleSpeed: (speed: number) => void;
    rapidRate: number;
    setRapidRate: (rate: number) => void;

    // G-Code & File
    gcode: GCodeLine[];
    setGcode: (gcode: GCodeLine[]) => void;
    parsedToolpath: ParsedToolpath | null;
    setParsedToolpath: (toolpath: ParsedToolpath | null) => void;
    toolpathSegments: ToolpathSegment[];
    setToolpathSegments: (segments: ToolpathSegment[]) => void;
    fileInfo: FileInfo | null;
    setFileInfo: (info: FileInfo | null) => void;
    cleanupForNewFile: () => void;

    // 3D View
    viewMode3D: ViewMode3D;
    setViewMode3D: (mode: ViewMode3D) => void;
    viewPreset: ViewPreset;
    setViewPreset: (preset: ViewPreset) => void;
    showGrid3D: boolean;
    setShowGrid3D: (show: boolean) => void;

    // Console
    consoleLines: ConsoleLine[];
    addConsoleLog: (type: ConsoleLine['type'], text: string) => void;
    clearConsole: () => void;
    consoleExpanded: boolean;
    setConsoleExpanded: (expanded: boolean) => void;

    // Job Control
    jobProgress: number;
    setJobProgress: (progress: number) => void;
    currentLine: number;
    setCurrentLine: (line: number) => void;

    // Queue
    queueCounts: { jobId?: string; waiting: number; active: number; completed: number; failed: number };
    setQueueCounts: (counts: { jobId?: string; waiting?: number; active?: number; completed?: number; failed?: number }) => void;

    // Macros
    macros: Array<{ id: string; name: string; content: string; createdAt?: number }>;
    setMacros: (macros: Array<{ id: string; name: string; content: string; createdAt?: number }>) => void;

    // Tools
    tools: Array<{ id: string; name: string; number: number; diameter: number; length: number }>;
    setTools: (tools: Array<{ id: string; name: string; number: number; diameter: number; length: number }>) => void;

    // Tool Change
    toolChangeActive: boolean;
    toolChangeCurrentTool: number | null;
    toolChangeRequestedTool: number | null;
    setToolChangeState: (active: boolean, current: number | null, requested: number | null) => void;

    // Debug Monitor
    debugEnabled: boolean;
    debugEntries: Array<{ timestamp: number; type: string; data: string; meta: Record<string, unknown> }>;
    setDebugEnabled: (enabled: boolean) => void;
    addDebugEntry: (entry: { timestamp: number; type: string; data: string; meta: Record<string, unknown> }) => void;
    clearDebugEntries: () => void;

    // Health
    healthMetrics: { healthy: boolean; successRate: number; reconnectAttempt: number } | null;
    setHealthMetrics: (metrics: { healthy: boolean; successRate: number; reconnectAttempt: number } | null) => void;

    // Machine Position (separate from work position)
    machinePosition: Position;
    setMachinePosition: (pos: Position) => void;

    // Feed-rate override percent (RSP OP_SET_FEED_OVERRIDE, 10-200%)
    feedOverridePct: number;
    setFeedOverridePct: (pct: number) => void;

    // A axis (rotary) — only displayed when connected
    aAxis: { connected: boolean; work: number; machine: number };
    setAAxis: (a: { connected: boolean; work: number; machine: number }) => void;

    // WCS
    activeWCS: string;
    setActiveWCS: (wcs: string) => void;

    // Homing
    homingLocation: string | null;
    setHomingLocation: (location: string | null) => void;

    // ECSS — EasyCNC Safety System v1
    safetyValidation: SafetyVerdict | null;
    safetyWcsHealth: WcsHealth | null;
    safetyZRunaway: ZRunawayEvent | null;
    safetyOverrideArmed: boolean;
    remoteDiagStatus: RemoteDiagStatus | null;
    setSafetyValidation: (v: SafetyVerdict | null) => void;
    setSafetyWcsHealth: (h: WcsHealth | null) => void;
    setSafetyZRunaway: (z: ZRunawayEvent | null) => void;
    setSafetyOverrideArmed: (armed: boolean) => void;
    setRemoteDiagStatus: (s: RemoteDiagStatus | null) => void;

    // Machine profiles (Device tab)
    machineProfiles: MachineProfile[];
    activeMachineProfile: string | null;
    setMachineProfiles: (profiles: MachineProfile[]) => void;
    setActiveMachineProfile: (id: string | null) => void;

    // Connected port info (for Home menu Device Info when connected)
    connectedPortInfo: { port: string; manufacturer?: string; vendorId?: string; productId?: string } | null;
    setConnectedPortInfo: (info: { port: string; manufacturer?: string; vendorId?: string; productId?: string } | null) => void;

    // Home menu settings (ethernet, probe, app preferences)
    ethernet: EthernetConfig;
    probeSettings: ProbeSettings;
    appPreferences: AppPreferences;
    setEthernet: (v: EthernetConfig | ((prev: EthernetConfig) => EthernetConfig)) => void;
    setProbeSettings: (v: ProbeSettings | ((prev: ProbeSettings) => ProbeSettings)) => void;
    setAppPreferences: (v: AppPreferences | ((prev: AppPreferences) => AppPreferences)) => void;

    // Coolant State
    coolantState: CoolantState;
    setCoolantState: (state: CoolantState) => void;

    // Spindle / Laser
    spindleMode: SpindleMode;
    setSpindleMode: (mode: SpindleMode) => void;
    spindleRpm: number;
    setSpindleRpm: (rpm: number) => void;
    spindleRunning: boolean;
    setSpindleRunning: (running: boolean) => void;
    laserPower: number;
    setLaserPower: (power: number) => void;

    // Probe Wizard
    probeWizard: {
        status: 'idle' | 'running' | 'success' | 'error';
        lastRoutine: string | null;
        lastPlateType: string | null;
        lastRunAt: number | null;
    };
    setProbeWizardStatus: (status: 'idle' | 'running' | 'success' | 'error', meta?: { routine?: string; plateType?: string }) => void;

    // Settings active tab
    settingsTab: string;
    setSettingsTab: (tab: string) => void;

    // Firmware (EEPROM) settings: id -> value
    firmwareSettings: Record<number, string>;
    setFirmwareSetting: (id: number, value: string) => void;
    setFirmwareSettings: (settings: Record<number, string>) => void;
    clearFirmwareSettings: () => void;
}

// ECSS types — kept in this file to avoid spreading new module surface area.
export interface SafetyIssue {
    axis: 'X' | 'Y' | 'Z';
    line: number;
    kind: 'above_max' | 'below_min';
    value: number;
    machineTarget: number;
    limit: number;
    exceedance: number;
    message: string;
}
export interface SafetyVerdict {
    blocked: boolean;
    issues: SafetyIssue[];
    summary?: Record<string, unknown>;
    probableCorruptWCS?: boolean;
    cleared?: boolean;
}
export interface WcsHealth {
    healthy: boolean;
    wco: { x: number; y: number; z: number; a?: number };
    flagged: { axis: string; value: number }[];
    threshold: number;
}
export interface ZRunawayEvent {
    drop: number;
    windowMs: number;
    threshold: number;
    mposZ: number;
}
export interface RemoteDiagStatus {
    enabled: boolean;
    connected: boolean;
    url: string;
    backlog?: number;
    startedAt?: number | null;
}

// Restored once at module load so both initial fields below agree with each
// other (rawGcodeContent and fileInfo must come from the same saved file).
const restoredGcodeFile = gcodeFileStorage.load();

export const useCNCStore = create<CNCStore>((set, get) => ({
    // Connection
    connected: false,
    connectionStatus: 'disconnected',
    isInitialized: false,
    firmwareType: 'unknown',
    firmwareVersion: '',
    backendSocketConnected: false,
    setConnected: (connected) => set({ connected }),
    setConnectionStatus: (status) => set({ connectionStatus: status }),
    setInitialized: (isInitialized) => set({ isInitialized }),
    setFirmwareInfo: (firmwareType, firmwareVersion) => set({ firmwareType, firmwareVersion }),
    setBackendSocketConnected: (backendSocketConnected) => set({ backendSocketConnected }),

    // Raw G-code content -- restored from localStorage so a page refresh
    // doesn't strand the user with a "connected" UI but no file to send
    // (see gcodeFileStorage doc comment for the incident this fixes).
    rawGcodeContent: restoredGcodeFile?.content ?? null,
    setRawGcodeContent: (rawGcodeContent) => {
        set({ rawGcodeContent, fileLoadedBackend: false, jobActive: false, safetyValidation: null });
        const fi = get().fileInfo;
        gcodeFileStorage.save(
            rawGcodeContent && fi ? { name: fi.name, size: fi.size, lines: fi.lines, content: rawGcodeContent } : null
        );
    },

    // Backend feeder file-loaded flag
    fileLoadedBackend: false,
    setFileLoadedBackend: (fileLoadedBackend) => set({ fileLoadedBackend }),

    // Backend controller-instance-ready flag
    controllerReady: false,
    setControllerReady: (controllerReady) => set({ controllerReady }),

    // Machine State
    machineState: 'idle',
    setMachineState: (machineState) => set({ machineState }),

    lastAlarm: null,
    setLastAlarm: (lastAlarm) => set({ lastAlarm }),

    // Job-active flag
    jobActive: false,
    setJobActive: (jobActive) => set({ jobActive }),

    // Position
    position: { x: 0, y: 0, z: 0 },
    setPosition: (position) => {
        set({ position: { ...position } });
    },
    updatePosition: (axis, value) =>
        set((state) => ({
            position: { ...state.position, [axis]: value },
        })),

    // Jog Controls
    jogMode: 'step',
    setJogMode: (jogMode) => set({ jogMode }),
    jogDistance: jogDistanceStorage.load(),
    setJogDistance: (jogDistance) => {
        jogDistanceStorage.save(jogDistance);
        set({ jogDistance });
    },
    jogSpeed: jogSpeedStorage.load(),
    setJogSpeed: (jogSpeed) => {
        jogSpeedStorage.save(jogSpeed);
        set({ jogSpeed });
    },
    coordSystem: coordSystemStorage.load(),
    setCoordSystem: (coordSystem) => {
        coordSystemStorage.save(coordSystem);
        set({ coordSystem });
    },

    // Overrides
    feedRate: 100,
    setFeedRate: (feedRate) => set({ feedRate }),
    spindleSpeed: 100,
    setSpindleSpeed: (spindleSpeed) => set({ spindleSpeed }),
    rapidRate: 100,
    setRapidRate: (rapidRate) => set({ rapidRate }),

    // G-Code & File
    gcode: [],
    setGcode: (gcode) => set({ gcode }),
    parsedToolpath: null,
    setParsedToolpath: (parsedToolpath) => set({ parsedToolpath }),
    toolpathSegments: [],
    setToolpathSegments: (toolpathSegments) => set({ toolpathSegments }),
    fileInfo: restoredGcodeFile
        ? { name: restoredGcodeFile.name, size: restoredGcodeFile.size, lines: restoredGcodeFile.lines }
        : null,
    setFileInfo: (fileInfo) => {
        set({ fileInfo });
        const content = get().rawGcodeContent;
        gcodeFileStorage.save(
            fileInfo && content ? { name: fileInfo.name, size: fileInfo.size, lines: fileInfo.lines, content } : null
        );
    },
    cleanupForNewFile: () => {
        set({
            gcode: [],
            parsedToolpath: null,
            toolpathSegments: [],
            rawGcodeContent: null,
            fileInfo: null,
            fileLoadedBackend: false,
            jobActive: false,
            jobProgress: 0,
            currentLine: 0,
            safetyValidation: null,
            safetyWcsHealth: null,
            safetyZRunaway: null,
            safetyOverrideArmed: false,
        });
        gcodeFileStorage.save(null);
    },

    // 3D View
    viewMode3D: 'wireframe',
    setViewMode3D: (viewMode3D) => set({ viewMode3D }),
    viewPreset: 'iso',
    setViewPreset: (viewPreset) => set({ viewPreset }),
    showGrid3D: true,
    setShowGrid3D: (showGrid3D) => set({ showGrid3D }),

    // Console
    consoleLines: [
        { type: 'system', text: 'CNC Control System v1.0', time: getTimestamp() },
        { type: 'system', text: 'Ready to connect...', time: getTimestamp() },
    ],
    addConsoleLog: (type, text) =>
        set((state) => {
            const newEntry = { type, text, time: getTimestamp() };
            const prev = state.consoleLines;
            return {
                consoleLines: prev.length >= 500 ? [...prev.slice(prev.length - 499), newEntry] : [...prev, newEntry],
            };
        }),
    clearConsole: () => set({ consoleLines: [] }),
    consoleExpanded: false,
    setConsoleExpanded: (consoleExpanded) => set({ consoleExpanded }),

    // Job Control
    jobProgress: 0,
    setJobProgress: (jobProgress) => set({ jobProgress }),
    currentLine: 0,
    setCurrentLine: (currentLine) => set({ currentLine }),

    // Queue
    queueCounts: { waiting: 0, active: 0, completed: 0, failed: 0 },
    setQueueCounts: (counts) =>
        set((state) => ({
            queueCounts: {
                ...state.queueCounts,
                ...(counts.jobId !== undefined && { jobId: counts.jobId }),
                waiting: counts.waiting ?? state.queueCounts.waiting,
                active: counts.active ?? state.queueCounts.active,
                completed: counts.completed ?? state.queueCounts.completed,
                failed: counts.failed ?? state.queueCounts.failed,
            },
        })),

    // Macros
    macros: [],
    setMacros: (macros) => set({ macros }),

    // Tools
    tools: [],
    setTools: (tools) => set({ tools }),

    // Tool Change
    toolChangeActive: false,
    toolChangeCurrentTool: null,
    toolChangeRequestedTool: null,
    setToolChangeState: (active, current, requested) => set({
        toolChangeActive: active,
        toolChangeCurrentTool: current,
        toolChangeRequestedTool: requested,
    }),

    // Debug Monitor
    debugEnabled: false,
    debugEntries: [],
    setDebugEnabled: (debugEnabled) => set({ debugEnabled }),
    addDebugEntry: (entry) =>
        set((state) => ({
            debugEntries: [...state.debugEntries.slice(-499), entry],
        })),
    clearDebugEntries: () => set({ debugEntries: [] }),

    // Health
    healthMetrics: null,
    setHealthMetrics: (healthMetrics) => set({ healthMetrics }),

    // Machine Position
    aAxis: { connected: false, work: 0, machine: 0 },
    setAAxis: (aAxis) => set({ aAxis }),

    machinePosition: { x: 0, y: 0, z: 0 },
    setMachinePosition: (machinePosition) => {
        set({ machinePosition: { ...machinePosition } });
    },

    feedOverridePct: 100,
    setFeedOverridePct: (feedOverridePct) => set({ feedOverridePct }),

    // WCS
    activeWCS: 'G54',
    setActiveWCS: (activeWCS) => set({ activeWCS }),

    // Homing
    homingLocation: null,
    setHomingLocation: (homingLocation) => set({ homingLocation }),

    // ECSS — EasyCNC Safety System v1
    safetyValidation: null,
    safetyWcsHealth: null,
    safetyZRunaway: null,
    safetyOverrideArmed: false,
    remoteDiagStatus: null,
    setSafetyValidation: (safetyValidation) => set({ safetyValidation }),
    setSafetyWcsHealth: (safetyWcsHealth) => set({ safetyWcsHealth }),
    setSafetyZRunaway: (safetyZRunaway) => set({ safetyZRunaway }),
    setSafetyOverrideArmed: (safetyOverrideArmed) => set({ safetyOverrideArmed }),
    setRemoteDiagStatus: (remoteDiagStatus) => set({ remoteDiagStatus }),

    // Machine profiles (Device tab)
    machineProfiles: [],
    activeMachineProfile: null,
    setMachineProfiles: (machineProfiles) => set({ machineProfiles }),
    setActiveMachineProfile: (activeMachineProfile) => set({ activeMachineProfile }),

    connectedPortInfo: null,
    setConnectedPortInfo: (connectedPortInfo) => set({ connectedPortInfo }),

    // Home menu settings
    ethernet: { connectToIP: '192.168.5.1' },
    probeSettings: {
        touchPlateType: 'Standard Block',
        blockThickness: 15,
        xyThickness: 10,
        zProbeDistance: 30,
        fastFind: 150,
        slowFind: 75,
        retraction: 2,
        connectionTest: true,
    },
    appPreferences: {
        units: 'mm',
        safeHeight: 10,
        reconnectAutomatically: false,
        firmwareFallback: 'grblHAL',
        baudRate: 115200,
        rtscts: false,
        runCheckOnFileLoad: false,
        outlineStyle: 'Detailed',
    },
    setEthernet: (v) => set((s) => ({ ethernet: typeof v === 'function' ? v(s.ethernet) : v })),
    setProbeSettings: (v) => set((s) => ({ probeSettings: typeof v === 'function' ? v(s.probeSettings) : v })),
    setAppPreferences: (v) => set((s) => ({ appPreferences: typeof v === 'function' ? v(s.appPreferences) : v })),

    // Coolant State
    coolantState: 'off',
    setCoolantState: (coolantState) => set({ coolantState }),

    // Spindle / Laser
    spindleMode: 'spindle',
    setSpindleMode: (spindleMode) => set({ spindleMode }),
    spindleRpm: 10000,
    setSpindleRpm: (spindleRpm) => set({ spindleRpm }),
    spindleRunning: false,
    setSpindleRunning: (spindleRunning) => set({ spindleRunning }),
    laserPower: 10,
    setLaserPower: (laserPower) => set({ laserPower }),

    // Probe Wizard
    probeWizard: {
        status: 'idle',
        lastRoutine: null,
        lastPlateType: null,
        lastRunAt: null,
    },
    setProbeWizardStatus: (status, meta) => set((s) => ({
        probeWizard: {
            ...s.probeWizard,
            status,
            ...(meta?.routine !== undefined && { lastRoutine: meta.routine }),
            ...(meta?.plateType !== undefined && { lastPlateType: meta.plateType }),
            ...(status === 'running' && { lastRunAt: Date.now() }),
        },
    })),

    // Settings active tab
    settingsTab: 'appearance',
    setSettingsTab: (tab) => set({ settingsTab: tab }),

    // Firmware (EEPROM) settings
    firmwareSettings: {},
    setFirmwareSetting: (id, value) =>
        set((s) => ({ firmwareSettings: { ...s.firmwareSettings, [id]: value } })),
    setFirmwareSettings: (settings) => set({ firmwareSettings: settings }),
    clearFirmwareSettings: () => set({ firmwareSettings: {} }),
}));
