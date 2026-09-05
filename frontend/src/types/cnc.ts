// CNC Machine Types
export type MachineState = 'idle' | 'running' | 'paused' | 'alarm' | 'motorError';

export type JogMode = 'continuous' | 'step';

export type ViewMode3D = 'wireframe' | 'solid' | 'layers';

export type ViewPreset = 'iso' | 'top' | 'front' | 'right' | 'bottom' | 'left' | 'back';

// Console Message Types
export type ConsoleMessageType = 'system' | 'info' | 'success' | 'warning' | 'error';

export interface ConsoleLine {
    type: ConsoleMessageType;
    text: string;
    time?: string;
}

// G-Code Types
export interface GCodeLine {
    command: string;
    x?: number;
    y?: number;
    z?: number;
    f?: number;
    comment?: string;
}

export interface ToolpathSegment {
    start: { x: number; y: number; z: number };
    end: { x: number; y: number; z: number };
    rapid: boolean;
    layer: number;
}

// Machine Position
export interface Position {
    x: number;
    y: number;
    z: number;
}

// File Info
export interface FileInfo {
    name: string;
    size: number;
    lines: number;
}

// System Status
export interface SystemStatus {
    controller: string;
    buffer: number;
    feedRate: number;
    spindle: string;
}

// Machine profile (for Device tab dropdown and details)
export interface MachineProfile {
    id: string;
    name: string;
    voltage?: string;
    workArea?: string;
    maxFeed?: string;
    spindle?: string;
    controller?: string;
    notes?: string;
}

// Home menu / config (ethernet, probe, preferences)
export interface EthernetConfig {
    connectToIP: string;
}

export interface ProbeSettings {
    touchPlateType: string;
    blockThickness: number;
    xyThickness: number;
    zProbeDistance: number;
    fastFind: number;
    slowFind: number;
    retraction: number;
    connectionTest: boolean;
}

export interface AppPreferences {
    units: string;
    safeHeight: number;
    reconnectAutomatically: boolean;
    firmwareFallback: string;
    baudRate: number;
    rtscts: boolean;
    runCheckOnFileLoad: boolean;
    outlineStyle: string;
    // ECSS-E: Remote diagnostic mirror toggle + URL.
    remoteDiagEnabled?: boolean;
    remoteDiagUrl?: string;
}
