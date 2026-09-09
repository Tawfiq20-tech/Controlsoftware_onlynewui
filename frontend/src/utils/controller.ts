/**
 * Controller - Socket.IO client wrapper for the CNC backend.
 *
 * Provides a clean API for React components to:
 *   - Connect/disconnect from the backend Socket.IO server
 *   - Open/close serial/network ports
 *   - Send commands and G-code
 *   - Listen for controller state, position, workflow, and sender events
 *
 * Reference: gSender controller.ts (GPLv3, Sienci Labs Inc.)
 * @see https://github.com/Sienci-Labs/gsender
 */
import { io, Socket } from 'socket.io-client';

export interface ControllerPosition {
    x: number;
    y: number;
    z: number;
    a?: number;
}

export interface ControllerStatus {
    activeState: string;
    mpos: ControllerPosition;
    wpos: ControllerPosition;
    wco: ControllerPosition;
    ov: { feed: number; rapid: number; spindle: number };
    buf: { planner: number; rx: number };
    feedrate: number;
    spindle: number;
    spindleDirection: string;
    pinState: string;
    // RSP-only: current feed override percent (RSPController._onTelemetry()).
    // Optional because GRBL/RTS controllers report override via `ov` instead.
    feedOverridePct?: number;
}

export interface ControllerState {
    status: ControllerStatus;
    parserstate: {
        modal: Record<string, string>;
        tool: number;
        feedrate: number;
        spindle: number;
    };
}

export interface SenderStatus {
    name: string;
    total: number;
    sent: number;
    received: number;
    hold: boolean;
    holdReason: string | null;
    progress: number;
    elapsedTime: number;
    remainingTime: number;
    state: string;
}

export interface PortInfo {
    port: string;
    manufacturer: string;
    serialNumber: string;
    vendorId: string;
    productId: string;
    inuse: boolean;
}

// Shape varies by which backend controller is active -- RSPController emits
// { type: 'fault'|'estop'|'comm_lost', axis, code } (RSP protocol, EV_FAULT),
// RTSController emits { code, message } (grblHAL-style). All fields are
// optional here so the UI can render whatever the active controller actually
// sent instead of assuming a shape neither backend guarantees.
export interface AlarmInfo {
    type?: 'fault' | 'estop' | 'comm_lost' | string;
    axis?: number;
    code?: number;
    message?: string;
    description?: string;
    raw?: string;
}

export interface ErrorInfo {
    code: number;
    message: string;
    description: string;
    raw: string;
}

export interface FeederStatus {
    size: number;
    pending: boolean;
    hold: boolean;
    holdReason: string | null;
    totalFed: number;
    totalAcked: number;
}

export interface ToolChangerStatus {
    active: boolean;
    currentTool: number | null;
    requestedTool: number | null;
}

export interface Macro {
    id: string;
    name: string;
    content: string;
    createdAt?: number;
}

export interface Tool {
    id: string;
    name: string;
    number: number;
    diameter: number;
    length: number;
}

export interface DebugLogEntry {
    timestamp: number;
    type: 'tx' | 'rx' | 'ui' | 'error';
    data: string;
    meta: Record<string, unknown>;
}

export interface HealthMetrics {
    active: boolean;
    healthy: boolean;
    timeSinceLastStatus: number;
    failedChecks: number;
    successRate: number;
    autoReconnect: boolean;
    reconnectAttempt: number;
}

export type ControllerEventName =
    | 'connect'
    | 'disconnect'
    | 'connect_error'
    | 'serialport:list'
    | 'serialport:open'
    | 'serialport:close'
    | 'serialport:error'
    | 'connection:lost'
    | 'serialport:read'
    | 'controller:type'
    | 'controller:state'
    | 'controller:initialized'
    | 'controller:alarm'
    | 'controller:error'
    | 'controller:settings'
    | 'controller:feedback'
    | 'controller:parameters'
    | 'workflow:state'
    | 'sender:status'
    | 'sender:start'
    | 'sender:end'
    | 'sender:error'
    | 'feeder:status'
    | 'toolchange:start'
    | 'toolchange:complete'
    | 'toolchange:cancel'
    | 'toolchange:request'
    | 'toolchange:error'
    | 'eventtrigger:fired'
    | 'serial:debug:log'
    | 'health:stale'
    | 'health:reconnect:attempt'
    | 'health:reconnect:success'
    | 'health:reconnect:failed'
    | 'health:metrics'
    | 'homing:location'
    | 'homing:axis'
    | 'homing:limits'
    | 'macro:list'
    | 'tool:list'
    | 'config:all'
    | 'config:change'
    | 'toolchanger:status'
    | 'file:load'
    | 'file:unload'
    | 'safety:validation'
    | 'safety:wcsHealth'
    | 'safety:zRunaway'
    | 'safety:blocked'
    | 'safety:overrideArmed'
    | 'safety:overrideConsumed'
    | 'safety:remoteDiagStatus'
    | 'hPong';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ListenerFn = (...args: any[]) => void;

class Controller {
    socket: Socket | null = null;
    listeners: Map<string, Set<ListenerFn>> = new Map();
    private _connecting = false;
    private _pendingConnectCallbacks: Array<(err?: Error) => void> = [];

    // Cached state
    port: string = '';
    type: string = '';
    state: ControllerState | null = null;
    workflowState: string = 'idle';
    senderStatus: SenderStatus | null = null;

    /**
     * Connect to the backend Socket.IO server.
     */
    connect(
        host: string = 'http://localhost:4000',
        options: Record<string, unknown> = {},
        callback?: (err?: Error) => void
    ): void {
        if (this.socket?.connected) {
            callback?.();
            return;
        }

        // useAutoConnect's always-mounted effect and DevicePanel's own mount
        // effect both call connectBackendSocket() -> connect() on app boot.
        // The guard above only blocks an ALREADY-connected socket -- while
        // the first handshake is still in flight, a second caller passed it
        // too and used to create a second io() client here, orphaning the
        // first (never .disconnect()'d, never dereferenced). Both sockets
        // then had _wireServerEvents() wired to the SAME this.listeners Map,
        // so any server broadcast that reached both live sockets fired every
        // registered listener twice for one logical event -- self-resolving
        // once the orphan errored out, which matches "the FIRST <event>
        // happens twice" and not subsequent ones. Queue the second caller's
        // callback onto the in-flight connection instead of starting a new
        // socket.
        if (this._connecting) {
            if (callback) this._pendingConnectCallbacks.push(callback);
            return;
        }
        this._connecting = true;

        this.socket = io(host, {
            transports: ['websocket', 'polling'],
            ...options,
        });

        this.socket.on('connect', () => {
            this._connecting = false;
            this._emit('connect');
            callback?.();
            this._flushPendingConnectCallbacks();
        });

        this.socket.on('disconnect', () => {
            this._emit('disconnect');
        });

        this.socket.on('connect_error', (err: Error) => {
            this._connecting = false;
            this._emit('connect_error', err);
            callback?.(err);
            this._flushPendingConnectCallbacks(err);
        });

        // Wire up all server events to local listeners
        this._wireServerEvents();
    }

    /**
     * Disconnect from the backend.
     */
    disconnect(): void {
        if (this.socket) {
            this.socket.disconnect();
            this.socket = null;
        }
        this._connecting = false;
        this._flushPendingConnectCallbacks(new Error('disconnected before connect completed'));
        this.port = '';
        this.type = '';
        this.state = null;
        this.workflowState = 'idle';
        this.senderStatus = null;
    }

    /**
     * Reconnect to the backend.
     */
    reconnect(): void {
        if (this.socket) {
            this.socket.connect();
        }
    }

    // ─── Port Management ─────────────────────────────────────────

    /**
     * List available serial ports.
     */
    listPorts(callback?: (err: Error | null, ports?: PortInfo[]) => void): void {
        this.socket?.emit('list', callback);
    }

    /**
     * Open a serial/network port.
     */
    openPort(
        port: string,
        options: { baudRate?: number; network?: boolean; rtscts?: boolean } = {},
        callback?: (err: Error | null) => void
    ): void {
        this.socket?.emit('open', port, options, callback);
    }

    /**
     * Close the current port.
     */
    closePort(port?: string, callback?: (err: Error | null) => void): void {
        this.socket?.emit('close', port || this.port, callback);
    }

    // ─── Commands ────────────────────────────────────────────────

    /**
     * Execute a named controller command.
     */
    command(cmd: string, ...args: unknown[]): void {
        this.socket?.emit('command', this.port, cmd, ...args);
    }

    /**
     * Write raw data to the controller.
     */
    write(data: string, context?: Record<string, unknown>): void {
        this.socket?.emit('write', this.port, data, context);
    }

    /**
     * Write a line to the controller (with newline).
     */
    writeln(data: string, context?: Record<string, unknown>): void {
        this.socket?.emit('writeln', this.port, data, context);
    }

    // ─── File Management ─────────────────────────────────────────

    /**
     * Load a G-code file.
     */
    loadFile(name: string, content: string): void {
        this.socket?.emit('file:load', { name, content });
    }

    /**
     * Unload the current file.
     */
    unloadFile(): void {
        this.socket?.emit('file:unload');
    }

    // ─── Convenience Commands ────────────────────────────────────

    startJob(): void { this.command('gcode:start'); }
    pauseJob(): void { this.command('gcode:pause'); }
    resumeJob(): void { this.command('gcode:resume'); }
    stopJob(): void { this.command('gcode:stop'); }
    startFromLine(line: number): void { this.command('gcode:startFromLine', line); }

    home(): void { this.command('homing'); }
    homeAxis(axis: string): void { this.command(`homing:${axis}`); }
    unlock(): void { this.command('unlock'); }
    reset(): void { this.command('reset'); }
    feedHold(): void { this.command('feedhold'); }
    feedOverrideReset(): void { this.command('feedOverride:reset'); }
    feedOverrideCoarsePlus(): void { this.command('feedOverride:coarsePlus'); }
    feedOverrideCoarseMinus(): void { this.command('feedOverride:coarseMinus'); }
    feedOverrideFinePlus(): void { this.command('feedOverride:finePlus'); }
    feedOverrideFineMinus(): void { this.command('feedOverride:fineMinus'); }
    cycleStart(): void { this.command('cyclestart'); }
    jogCancel(): void { this.command('jogcancel'); }
    checkMode(): void { this.command('checkmode'); }

    jog(params: {
        x?: number; y?: number; z?: number; a?: number;
        feedRate?: number; units?: string; mode?: string;
    }): void {
        this.command('jog', params);
    }

    jogSafe(params: {
        x?: number; y?: number; z?: number;
        feedRate?: number; units?: string; mode?: string;
    }): void {
        this.command('jog:safe', params);
    }

    sendGcode(code: string): void { this.command('gcode', code); }
    getSettings(): void { this.command('settings'); }
    getBuildInfo(): void { this.command('buildinfo'); }
    getParserState(): void { this.command('parserstate'); }
    getWorkCoordinates(): void { this.command('workcoordinates'); }

    // ─── Probing ─────────────────────────────────────────────────

    probeZ(params?: { depth?: number; feedRate?: number; retract?: number }): void {
        this.command('probe:z', params);
    }

    // ─── Work Coordinate Systems ─────────────────────────────────

    setWCS(wcs: string): void { this.command('wcs:set', wcs); }
    zeroWCS(params?: { axes?: string[]; wcs?: string }): void { this.command('wcs:zero', params); }
    zeroAll(): void { this.command('wcs:zeroAll'); }

    // ─── Tool Change ─────────────────────────────────────────────

    confirmToolChange(): void { this.command('toolchange:confirm'); }
    cancelToolChange(): void { this.command('toolchange:cancel'); }

    // ─── Macros ──────────────────────────────────────────────────

    listMacros(callback?: (err: Error | null, macros?: Macro[]) => void): void {
        this.socket?.emit('macro:list', callback);
    }
    saveMacro(macro: Partial<Macro>, callback?: (err: Error | null, macros?: Macro[]) => void): void {
        this.socket?.emit('macro:save', macro, callback);
    }
    deleteMacro(id: string, callback?: (err: Error | null, macros?: Macro[]) => void): void {
        this.socket?.emit('macro:delete', id, callback);
    }
    runMacro(id: string): void {
        this.socket?.emit('macro:run', id);
    }
    runMacroContent(content: string): void {
        this.command('macro:run', content);
    }

    // ─── Tools ───────────────────────────────────────────────────

    listTools(callback?: (err: Error | null, tools?: Tool[]) => void): void {
        this.socket?.emit('tool:list', callback);
    }
    saveTool(tool: Partial<Tool>, callback?: (err: Error | null, tools?: Tool[]) => void): void {
        this.socket?.emit('tool:save', tool, callback);
    }
    deleteTool(id: string, callback?: (err: Error | null, tools?: Tool[]) => void): void {
        this.socket?.emit('tool:delete', id, callback);
    }

    // ─── Debug Monitor ───────────────────────────────────────────

    enableDebug(): void { this.command('debug:enable'); }
    disableDebug(): void { this.command('debug:disable'); }
    clearDebug(): void { this.command('debug:clear'); }
    logUIAction(action: string, command?: string): void {
        this.command('debug:logUI', action, command);
    }

    // ─── Event Triggers ──────────────────────────────────────────

    setEventTrigger(eventName: string, config: { enabled?: boolean; commands?: string }): void {
        this.socket?.emit('trigger:set', eventName, config);
    }

    // ─── Config ──────────────────────────────────────────────────

    getConfig(key: string, callback?: (err: Error | null, value?: unknown) => void): void {
        this.socket?.emit('config:get', key, callback);
    }
    getConfigAll(callback?: (err: Error | null, config?: Record<string, unknown>) => void): void {
        this.socket?.emit('config:getAll', callback);
    }
    setConfig(key: string, value: unknown): void {
        this.socket?.emit('config:set', key, value);
    }

    // ─── Health ──────────────────────────────────────────────────

    healthCheck(): void {
        this.socket?.emit('hPing');
    }

    // ─── Event Listeners ─────────────────────────────────────────

    addListener(eventName: ControllerEventName | string, listener: ListenerFn): void {
        if (!this.listeners.has(eventName)) {
            this.listeners.set(eventName, new Set());
        }
        this.listeners.get(eventName)!.add(listener);
    }

    removeListener(eventName: ControllerEventName | string, listener: ListenerFn): void {
        this.listeners.get(eventName)?.delete(listener);
    }

    on(eventName: ControllerEventName | string, listener: ListenerFn): void {
        this.addListener(eventName, listener);
    }

    off(eventName: ControllerEventName | string, listener: ListenerFn): void {
        this.removeListener(eventName, listener);
    }

    private _emit(eventName: string, ...args: unknown[]): void {
        this.listeners.get(eventName)?.forEach((fn) => {
            try { fn(...args); } catch (_) { /* ignore */ }
        });
    }

    private _flushPendingConnectCallbacks(err?: Error): void {
        const pending = this._pendingConnectCallbacks;
        this._pendingConnectCallbacks = [];
        pending.forEach((cb) => cb(err));
    }

    // ─── Server Event Wiring ─────────────────────────────────────

    private _wireServerEvents(): void {
        if (!this.socket) return;

        // Port events
        this.socket.on('serialport:list', (ports: PortInfo[]) => {
            this._emit('serialport:list', ports);
        });

        this.socket.on('serialport:open', (data: { port: string; controllerType?: string }) => {
            this.port = data.port || '';
            this._emit('serialport:open', data);
        });

        this.socket.on('serialport:close', (data: { port: string }) => {
            this.port = '';
            this.type = '';
            this.state = null;
            this.workflowState = 'idle';
            this.senderStatus = null;
            this._emit('serialport:close', data);
        });

        this.socket.on('connection:lost', (data: { port: string; resumeLine: number }) => {
            this._emit('connection:lost', data);
        });

        this.socket.on('serialport:error', (data: { error: string }) => {
            this._emit('serialport:error', data);
        });

        this.socket.on('serialport:read', (line: string) => {
            this._emit('serialport:read', line);
        });

        // Controller events
        this.socket.on('controller:type', (type: string) => {
            this.type = type;
            this._emit('controller:type', type);
        });

        this.socket.on('controller:state', (type: string, state: ControllerState) => {
            this.type = type;
            this.state = state;
            this._emit('controller:state', type, state);
        });

        this.socket.on('controller:initialized', (info: { firmwareType: string; firmwareVersion: string }) => {
            this._emit('controller:initialized', info);
        });

        this.socket.on('controller:alarm', (alarm: AlarmInfo) => {
            this._emit('controller:alarm', alarm);
        });

        this.socket.on('controller:error', (err: ErrorInfo) => {
            this._emit('controller:error', err);
        });

        this.socket.on('controller:settings', (setting: unknown) => {
            this._emit('controller:settings', setting);
        });

        this.socket.on('controller:feedback', (fb: unknown) => {
            this._emit('controller:feedback', fb);
        });

        this.socket.on('controller:parameters', (params: unknown) => {
            this._emit('controller:parameters', params);
        });

        // Workflow
        this.socket.on('workflow:state', (state: string) => {
            this.workflowState = state;
            this._emit('workflow:state', state);
        });

        // Sender
        this.socket.on('sender:status', (status: SenderStatus) => {
            this.senderStatus = status;
            this._emit('sender:status', status);
        });

        this.socket.on('sender:start', (data: unknown) => {
            this._emit('sender:start', data);
        });

        this.socket.on('sender:end', (data: unknown) => {
            this._emit('sender:end', data);
        });

        this.socket.on('sender:error', (err: unknown) => {
            this._emit('sender:error', err);
        });

        // File
        this.socket.on('file:load', (data: unknown) => {
            this._emit('file:load', data);
        });

        this.socket.on('file:unload', () => {
            this._emit('file:unload');
        });

        // ECSS — EasyCNC Safety System v1
        this.socket.on('safety:validation', (data: unknown) => {
            this._emit('safety:validation', data);
        });
        this.socket.on('safety:wcsHealth', (data: unknown) => {
            this._emit('safety:wcsHealth', data);
        });
        this.socket.on('safety:zRunaway', (data: unknown) => {
            this._emit('safety:zRunaway', data);
        });
        this.socket.on('safety:blocked', (data: unknown) => {
            this._emit('safety:blocked', data);
        });
        this.socket.on('safety:overrideArmed', (data: unknown) => {
            this._emit('safety:overrideArmed', data);
        });
        this.socket.on('safety:overrideConsumed', (data: unknown) => {
            this._emit('safety:overrideConsumed', data);
        });
        this.socket.on('safety:remoteDiagStatus', (data: unknown) => {
            this._emit('safety:remoteDiagStatus', data);
        });

        // Feeder
        this.socket.on('feeder:status', (status: FeederStatus) => {
            this._emit('feeder:status', status);
        });

        // Tool changer
        this.socket.on('toolchange:start', (data: unknown) => {
            this._emit('toolchange:start', data);
        });
        this.socket.on('toolchange:complete', (data: unknown) => {
            this._emit('toolchange:complete', data);
        });
        this.socket.on('toolchange:cancel', () => {
            this._emit('toolchange:cancel');
        });
        this.socket.on('toolchange:request', (data: unknown) => {
            this._emit('toolchange:request', data);
        });
        this.socket.on('toolchange:error', (data: unknown) => {
            this._emit('toolchange:error', data);
        });
        this.socket.on('toolchanger:status', (status: ToolChangerStatus) => {
            this._emit('toolchanger:status', status);
        });

        // Event triggers
        this.socket.on('eventtrigger:fired', (data: unknown) => {
            this._emit('eventtrigger:fired', data);
        });

        // Debug monitor
        this.socket.on('serial:debug:log', (entry: DebugLogEntry) => {
            this._emit('serial:debug:log', entry);
        });

        // Health monitor
        this.socket.on('health:stale', (data: unknown) => {
            this._emit('health:stale', data);
        });
        this.socket.on('health:reconnect:attempt', (data: unknown) => {
            this._emit('health:reconnect:attempt', data);
        });
        this.socket.on('health:reconnect:success', () => {
            this._emit('health:reconnect:success');
        });
        this.socket.on('health:reconnect:failed', (data: unknown) => {
            this._emit('health:reconnect:failed', data);
        });
        this.socket.on('health:metrics', (data: HealthMetrics) => {
            this._emit('health:metrics', data);
        });

        // Homing
        this.socket.on('homing:location', (data: unknown) => {
            this._emit('homing:location', data);
        });
        this.socket.on('homing:limits', (data: unknown) => {
            this._emit('homing:limits', data);
        });
        this.socket.on('homing:axis', (data: unknown) => {
            this._emit('homing:axis', data);
        });

        // Macros
        this.socket.on('macro:list', (macros: Macro[]) => {
            this._emit('macro:list', macros);
        });

        // Tools
        this.socket.on('tool:list', (tools: Tool[]) => {
            this._emit('tool:list', tools);
        });

        // Config
        this.socket.on('config:all', (config: unknown) => {
            this._emit('config:all', config);
        });
        this.socket.on('config:change', (data: { key: string; value: unknown }) => {
            this._emit('config:change', data);
        });

        // Health
        this.socket.on('hPong', () => {
            this._emit('hPong');
        });
    }
}

// Singleton instance
const controller = new Controller();

export { Controller };
export default controller;
