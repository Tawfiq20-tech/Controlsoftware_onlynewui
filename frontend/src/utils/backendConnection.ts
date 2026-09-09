/**
 * Backend connection utilities using the Controller (Socket.IO client).
 *
 * This module bridges the Controller singleton to the Zustand store,
 * providing convenience functions for React components.
 */
import controller from './controller';
import type { ControllerState, SenderStatus, PortInfo, AlarmInfo, ErrorInfo } from './controller';
import type { MachineState } from '../types/cnc';
import { useCNCStore } from '../stores/cncStore';
import { log } from './logger';

const getBackendUrl = (): string => {
    const url = (import.meta as unknown as { env?: { VITE_API_URL?: string } }).env?.VITE_API_URL;
    if (url !== undefined && url !== null && String(url).trim() !== '') {
        return String(url).replace(/\/$/, '');
    }
    // Use same host as the page so external devices (e.g. tablet on network) can connect to backend
    if (typeof window !== 'undefined' && window.location?.hostname) {
        const { protocol, hostname } = window.location;
        return `${protocol}//${hostname}:4000`;
    }
    return 'http://localhost:4000';
};

export type BackendPort = PortInfo;

export function getController() {
    return controller;
}

export function isBackendSupported(): boolean {
    return true;
}

// Socket.IO's underlying client fires its 'connect' event on every
// automatic reconnect, not just the first connection -- Controller.connect()
// forwards that straight through to the callback passed here, so without
// this guard _wireControllerToStore() below would run again on every
// WiFi drop / backend restart / laptop sleep-wake, each time registering a
// fresh closure for all ~50 controller.on(...) handlers (they're distinct
// function objects each call, so the listeners Set can't dedupe them) on
// top of the ones already there -- unbounded growth plus every event
// firing its side effects (console logs, state updates) multiple times per
// occurrence.
let _storeWired = false;

/**
 * Connect to the backend Socket.IO server and wire events to the store.
 */
export function connectBackendSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
        if (controller.socket?.connected) {
            resolve();
            return;
        }

        const url = getBackendUrl();
        const store = useCNCStore.getState();

        controller.connect(url, {}, (err) => {
            if (err) {
                store.setBackendSocketConnected(false);
                reject(err);
                return;
            }
            store.setBackendSocketConnected(true);
            // Wire controller events to store -- once per page load, not
            // once per reconnect (see _storeWired's comment above).
            if (!_storeWired) {
                _storeWired = true;
                _wireControllerToStore();
            }
            // Hydrate config from backend (machine profiles, ethernet, probe, preferences)
            controller.getConfigAll((_e, config) => {
                if (config && typeof config === 'object') {
                    const s = useCNCStore.getState();
                    const profiles = (config.machineProfiles as Array<{ id: string; name: string; voltage?: string; workArea?: string; maxFeed?: string; spindle?: string; controller?: string; notes?: string }>) ?? [];
                    const active = (config.activeMachineProfile as string | null) ?? null;
                    s.setMachineProfiles(Array.isArray(profiles) ? profiles : []);
                    s.setActiveMachineProfile(active);
                    const eth = config.ethernet as { connectToIP?: string } | undefined;
                    if (eth?.connectToIP) s.setEthernet({ connectToIP: eth.connectToIP });
                    const probe = config.probeSettings as Record<string, unknown> | undefined;
                    if (probe && typeof probe === 'object') {
                        s.setProbeSettings({
                            touchPlateType: (probe.touchPlateType as string) ?? 'Standard Block',
                            blockThickness: Number(probe.blockThickness) ?? 15,
                            xyThickness: Number(probe.xyThickness) ?? 10,
                            zProbeDistance: Number(probe.zProbeDistance) ?? 30,
                            fastFind: Number(probe.fastFind) ?? 150,
                            slowFind: Number(probe.slowFind) ?? 75,
                            retraction: Number(probe.retraction) ?? 2,
                            connectionTest: Boolean(probe.connectionTest ?? true),
                        });
                    }
                    const prefs = config.preferences as Record<string, unknown> | undefined;
                    if (prefs && typeof prefs === 'object') {
                        s.setAppPreferences({
                            units: (prefs.units as string) ?? 'mm',
                            safeHeight: Number(prefs.safeHeight) ?? 10,
                            reconnectAutomatically: Boolean(prefs.reconnectAutomatically ?? false),
                            firmwareFallback: (prefs.firmwareFallback as string) ?? 'grblHAL',
                            baudRate: Number(prefs.baudRate) ?? 115200,
                            rtscts: Boolean(prefs.rtscts ?? false),
                            runCheckOnFileLoad: Boolean(prefs.runCheckOnFileLoad ?? false),
                            outlineStyle: (prefs.outlineStyle as string) ?? 'Detailed',
                        });
                    }
                }
            });
            resolve();
        });
    });
}

/**
 * Disconnect from the backend.
 */
export function disconnectBackendSocket(): void {
    controller.disconnect();
    useCNCStore.getState().setBackendSocketConnected(false);
}

/**
 * Wire all controller events to the Zustand store.
 */
function _wireControllerToStore(): void {
    const getStore = () => useCNCStore.getState();

    // Connection events
    controller.on('connect', () => {
        getStore().setBackendSocketConnected(true);
    });

    controller.on('disconnect', () => {
        getStore().setBackendSocketConnected(false);
    });

    // Serial port events
    controller.on('serialport:open', (data: { port: string; controllerType?: string }) => {
        const s = getStore();
        s.setConnectionStatus('connected');
        s.setConnected(true);
        s.setControllerReady(false);
        s.addConsoleLog('success', `Connected to ${data.port}`);
        s.addConsoleLog('info', 'Detecting firmware...');
        log('info', `Connected to ${data.port}`);
    });

    controller.on('connection:lost', (data: { port: string; resumeLine: number }) => {
        const s = getStore();
        const resumeMsg = data.resumeLine > 1
            ? ` Reconnect and reload the file to resume from line ${data.resumeLine}.`
            : '';
        s.addConsoleLog('error', `Job interrupted — USB/serial connection dropped.${resumeMsg}`);
        log('error', `Job interrupted by connection loss at line ${data.resumeLine}`);
    });

    controller.on('serialport:close', () => {
        const s = getStore();
        s.setConnectionStatus('disconnected');
        s.setConnected(false);
        s.setControllerReady(false);
        s.setInitialized(false);
        s.setConnectedPortInfo(null);
        s.setJobActive(false);
        s.addConsoleLog('warning', 'Disconnected from controller');
        log('warn', 'Disconnected from controller');
    });

    controller.on('serialport:error', (data: { error: string }) => {
        const s = getStore();
        s.addConsoleLog('error', data.error || 'Connection error');
        log('error', data.error);
        // Defensive retry: if the backend rejected file:load because it lost the
        // controllerReady race despite the gate below, retry once instead of
        // leaving fileLoadedBackend stuck false with no recovery path.
        if (data.error === 'No active controller' && !s.fileLoadedBackend && s.rawGcodeContent) {
            setTimeout(() => {
                const cur = getStore();
                if (cur.controllerReady && !cur.fileLoadedBackend && cur.rawGcodeContent) {
                    controller.loadFile(cur.fileInfo?.name || 'job.gcode', cur.rawGcodeContent);
                }
            }, 500);
        }
    });

    controller.on('serialport:read', (line: string) => {
        getStore().addConsoleLog('system', line);
        // Parse $N=V lines from raw serial (captures $$ responses)
        const m = (line ?? '').match(/^\$(\d+)=([^\s(]+)/);
        if (m) {
            const id = parseInt(m[1], 10);
            const val = m[2];
            getStore().setFirmwareSetting(id, val);
            window.dispatchEvent(new CustomEvent('fw:setting', { detail: { key: id, value: val } }));
        }
    });

    // Controller type detection
    controller.on('controller:type', (type: string) => {
        const s = getStore();
        s.addConsoleLog('info', `Controller type: ${type}`);
        s.setControllerReady(true);
    });

    // Controller state updates
    controller.on('controller:state', (_type: string, state: ControllerState) => {
        const s = getStore();

        if (state.status) {
            // Map active state
            const stateMap: Record<string, MachineState> = {
                'Idle': 'idle', 'Run': 'running', 'Hold': 'paused',
                // 'Jog' mapped to 'running' used to trip isCarving in
                // Sidebar.tsx (machineState==='running'||'paused'), so every
                // manual jog showed the "Carve in progress" lock banner and
                // locked the Controls tab -- jogging isn't carving.
                // (Tawfiq msg11562/11578.)
                'Jog': 'idle', 'Alarm': 'alarm', 'Door': 'paused',
                'Check': 'idle', 'Home': 'running', 'Sleep': 'idle',
                'MotorError': 'motorError', 'Homing': 'running',
                // fw_m3 easycnc_protocol.c state_name() also emits these --
                // were missing here, so activeState:'EStop' left machineState
                // frozen on whatever it was before (e.g. still 'alarm' from a
                // prior fault), so "Clear Alarm" looked like a no-op when the
                // real state was actually an unresolved E-stop trip, not a
                // driver ALM fault. 'EStop'/'Fault' route to the alarm popup
                // so it's never silently missed; 'Stream'/'Boot'/'Stop' route
                // to their nearest existing bucket.
                'EStop': 'alarm', 'Fault': 'alarm',
                'Stream': 'running', 'Boot': 'idle', 'Stop': 'idle',
            };
            const mapped = stateMap[state.status.activeState];
            if (mapped) s.setMachineState(mapped);
            // Alarm cleared via a status poll (e.g. $X / unlock succeeded)
            // rather than an explicit clear button -- drop the stale detail
            // so the dropdown doesn't keep showing a resolved alarm.
            if (mapped && mapped !== 'alarm' && mapped !== 'motorError' && s.lastAlarm) {
                s.setLastAlarm(null);
            }

            // Update work position
            if (state.status.wpos) {
                const newPos = {
                    x: state.status.wpos.x,
                    y: state.status.wpos.y,
                    z: state.status.wpos.z,
                };
                console.log('[Position Update] Work:', newPos);
                s.setPosition(newPos);
            }

            // Update machine position
            if (state.status.mpos) {
                const newMachinePos = {
                    x: state.status.mpos.x,
                    y: state.status.mpos.y,
                    z: state.status.mpos.z,
                };
                console.log('[Position Update] Machine:', newMachinePos);
                s.setMachinePosition(newMachinePos);
            }

            // Update feed rate and spindle
            if (state.status.feedrate !== undefined) s.setFeedRate(state.status.feedrate);
            if (state.status.spindle !== undefined) s.setSpindleSpeed(state.status.spindle);

            // Update feed-rate override percent (RSP only -- 50-150%)
            if (state.status.feedOverridePct !== undefined) s.setFeedOverridePct(state.status.feedOverridePct);

            // Update overrides
            if (state.status.ov) {
                s.setFeedRate(state.status.ov.feed);
                s.setRapidRate(state.status.ov.rapid);
            }
        }

        // Track active WCS from parser state
        if (state.parserstate?.modal?.wcs) {
            s.setActiveWCS(state.parserstate.modal.wcs);
        }
    });

    // Initialization
    controller.on('controller:initialized', (info: { firmwareType: string; firmwareVersion: string }) => {
        const s = getStore();
        s.setInitialized(true);
        s.setFirmwareInfo(info.firmwareType, info.firmwareVersion);
        s.addConsoleLog('success', `Controller initialized: ${info.firmwareType} ${info.firmwareVersion}`);
        log('info', `Controller initialized: ${info.firmwareType} ${info.firmwareVersion}`);
    });

    // Alarms
    controller.on('controller:alarm', (alarm: AlarmInfo) => {
        const s = getStore();
        s.setMachineState('alarm');
        s.setLastAlarm(alarm);
        const detail = alarm.message
            ? `${alarm.code ?? ''} ${alarm.message}${alarm.description ? ' - ' + alarm.description : ''}`.trim()
            : `type=${alarm.type ?? 'unknown'}${alarm.axis !== undefined ? ` axis=${alarm.axis}` : ''}${alarm.code !== undefined ? ` code=${alarm.code}` : ''}`;
        s.addConsoleLog('error', `ALARM: ${detail}`);
    });

    // Errors
    controller.on('controller:error', (err: ErrorInfo) => {
        getStore().addConsoleLog('error', `Error ${err.code}: ${err.message}`);
    });

    // Homing status
    controller.on('homing:location', (data: { location: string; status: string }) => {
        const s = getStore();
        if (data.status === 'started') {
            s.setHomingLocation(data.location);
        } else if (data.status === 'completed' || data.status === 'failed') {
            s.setHomingLocation(null);
        }
    });

    // Workflow state
    controller.on('workflow:state', (state: string) => {
        const s = getStore();
        if (state === 'running') s.setMachineState('running');
        else if (state === 'paused') s.setMachineState('paused');
        else if (state === 'idle') {
            // Only set to idle if not in alarm
            if (s.machineState !== 'alarm') s.setMachineState('idle');
        }
    });

    // Sender status
    controller.on('sender:status', (status: SenderStatus) => {
        const s = getStore();
        if (typeof status.progress === 'number') s.setJobProgress(status.progress);
        if (typeof status.received === 'number') s.setCurrentLine(status.received);
    });

    // jobActive flip points — drive the Play/Pause button independently of
    // machineState (which reflects firmware activeState, not the streamer).
    controller.on('sender:start', () => {
        getStore().setJobActive(true);
    });

    controller.on('sender:end', (data: unknown) => {
        const s = getStore();
        const aborted = !!(data && typeof data === 'object' && 'aborted' in data && (data as { aborted?: boolean }).aborted);
        s.setJobActive(false);
        s.setMachineState('idle');
        // MED#11: sender:end fires on abort paths too (user stop,
        // Z-runaway ECSS abort, RTS stream-pump safety bound) -- not just
        // real completion. Forcing jobProgress to 100 and logging "Job
        // completed" on those paths lied about the job having finished.
        if (aborted) {
            s.addConsoleLog('warning', 'Job stopped');
            log('info', 'Job stopped');
        } else {
            s.setJobProgress(100);
            s.addConsoleLog('success', 'Job completed');
            log('info', 'Job completed');
        }
    });

    controller.on('sender:error', (err: unknown) => {
        const reason = (err && typeof err === 'object' && 'reason' in err)
            ? String((err as { reason?: unknown }).reason)
            : null;
        getStore().setJobActive(false);
        getStore().addConsoleLog('error', reason ? `Job stopped: ${reason}` : 'Streaming error');
    });

    // File events — flips the gate that lets START become clickable
    controller.on('file:load', (data: { name: string; total: number }) => {
        const s = getStore();
        s.setFileLoadedBackend(true);
        // MED#10: without this, currentLine/jobProgress kept showing the
        // PREVIOUS file's last values until the newly loaded job's first
        // sender:status arrived -- old job's line count/percentage bled
        // into the new file's initial display (Tawfiq's "old-job-bleed"
        // report). Backend resets its own _currentLine on gcode:load
        // (RSPController.js); mirror that here.
        s.setCurrentLine(0);
        s.setJobProgress(0);
        s.addConsoleLog('info', `File loaded: ${data.name} (${data.total} lines)`);
    });

    // Real disconnect event name is 'serialport:close' (see controller.ts) --
    // 'connection:closed' is never emitted by anything, so this listener was
    // dead code and fileLoadedBackend never reset on a real hardware drop.
    // That let a stale "file loaded" flag survive a reconnect: the backend
    // spins up a brand-new controller with no G-code loaded, but the frontend
    // still thought it did, so Start became clickable and silently no-op'd
    // ("no G-code is loaded on the controller" from RSPController.js:676).
    controller.on('serialport:close', () => {
        getStore().setFileLoadedBackend(false);
    });

    // ECSS — EasyCNC Safety System v1
    controller.on('safety:validation', (verdict: unknown) => {
        const v = verdict as import('../stores/cncStore').SafetyVerdict;
        getStore().setSafetyValidation(v);
        if (v?.cleared) return;
        if (v?.blocked) {
            getStore().addConsoleLog('error', `[ECSS] Pre-flight BLOCKED — ${v.issues.length} issue(s).`);
            v.issues.slice(0, 3).forEach((i) => getStore().addConsoleLog('error', `  • ${i.message}`));
        } else {
            getStore().addConsoleLog('system', '[ECSS] Pre-flight PASS — toolpath fits machine envelope.');
        }
    });

    controller.on('safety:wcsHealth', (health: unknown) => {
        const h = health as import('../stores/cncStore').WcsHealth;
        getStore().setSafetyWcsHealth(h);
        if (!h?.healthy) {
            getStore().addConsoleLog('warning',
                `[ECSS] WCS health failed: ${h.flagged.map((f) => `${f.axis}=${f.value}`).join(', ')}`);
        }
    });

    controller.on('safety:zRunaway', (event: unknown) => {
        const z = event as import('../stores/cncStore').ZRunawayEvent;
        getStore().setSafetyZRunaway(z);
        getStore().addConsoleLog('error',
            `[ECSS] Z RUNAWAY ABORT — dropped ${z.drop} mm in ${z.windowMs} ms. Binary 0x03 sent.`);
    });

    controller.on('safety:blocked', (data: unknown) => {
        const payload = data as { command: string; verdict: import('../stores/cncStore').SafetyVerdict };
        getStore().addConsoleLog('error',
            `[ECSS] Command "${payload.command}" blocked by pre-flight validator. Fix the toolpath / WCS first, or arm Override.`);
    });

    controller.on('safety:overrideArmed', () => {
        getStore().setSafetyOverrideArmed(true);
        getStore().addConsoleLog('warning', '[ECSS] Pre-flight override ARMED — next Start will bypass validator. Module 3 Z watchdog still active.');
    });

    controller.on('safety:overrideConsumed', (data: unknown) => {
        const p = data as { command: string };
        getStore().setSafetyOverrideArmed(false);
        getStore().addConsoleLog('warning', `[ECSS] Override consumed by "${p.command}". Validator re-engaged.`);
    });

    controller.on('safety:remoteDiagStatus', (data: unknown) => {
        const s = data as import('../stores/cncStore').RemoteDiagStatus;
        getStore().setRemoteDiagStatus(s);
        if (s?.enabled) {
            getStore().addConsoleLog(
                s.connected ? 'system' : 'warning',
                `[RemoteDiag] ${s.connected ? 'CONNECTED' : 'reconnecting...'}  ${s.url}`
            );
        }
    });

    // Settings — store in firmwareSettings and dispatch custom DOM event for FirmwareSettings UI
    controller.on('controller:settings', (setting: { key: number; value: number; message: string }) => {
        const s = getStore();
        s.addConsoleLog('system', `$${setting.key}=${setting.value} (${setting.message})`);
        s.setFirmwareSetting(setting.key, String(setting.value));
        window.dispatchEvent(
            new CustomEvent('fw:setting', { detail: { key: setting.key, value: String(setting.value) } })
        );
    });

    // Feedback
    controller.on('controller:feedback', (fb: { message: string }) => {
        getStore().addConsoleLog('info', `[MSG: ${fb.message}]`);
    });

    // ─── New Feature Events ──────────────────────────────────────

    // Macros
    controller.on('macro:list', (macros: Array<{ id: string; name: string; content: string; createdAt?: number }>) => {
        getStore().setMacros(macros);
    });

    // Tools
    controller.on('tool:list', (tools: Array<{ id: string; name: string; number: number; diameter: number; length: number }>) => {
        getStore().setTools(tools);
    });

    // Tool change events
    controller.on('toolchange:start', (data: { currentTool: number | null; requestedTool: number | null }) => {
        const s = getStore();
        s.setToolChangeState(true, data.currentTool, data.requestedTool);
        s.addConsoleLog('warning', `Tool change requested: T${data.requestedTool}`);
    });

    controller.on('toolchange:complete', (data: { tool: number }) => {
        const s = getStore();
        s.setToolChangeState(false, data.tool, null);
        s.addConsoleLog('success', `Tool change complete: T${data.tool}`);
    });

    controller.on('toolchange:cancel', () => {
        const s = getStore();
        s.setToolChangeState(false, s.toolChangeCurrentTool, null);
        s.addConsoleLog('info', 'Tool change cancelled');
    });

    // Debug monitor
    controller.on('serial:debug:log', (entry: { timestamp: number; type: string; data: string; meta: Record<string, unknown> }) => {
        getStore().addDebugEntry(entry);
    });

    // Health monitor
    controller.on('health:stale', () => {
        getStore().addConsoleLog('warning', 'Connection health: stale - no status reports received');
    });

    controller.on('health:reconnect:attempt', (data: { attempt: number; maxAttempts: number }) => {
        getStore().addConsoleLog('info', `Auto-reconnect attempt ${data.attempt}/${data.maxAttempts}`);
    });

    controller.on('health:reconnect:success', () => {
        getStore().addConsoleLog('success', 'Auto-reconnect successful');
    });

    controller.on('health:reconnect:failed', (data: { message: string }) => {
        getStore().addConsoleLog('error', `Auto-reconnect failed: ${data.message}`);
    });

    // Homing (handled above in the main event section)

    // Event triggers
    controller.on('eventtrigger:fired', (data: { event: string; trigger: string }) => {
        getStore().addConsoleLog('info', `Event trigger fired: ${data.trigger}`);
    });

    // Config (machine profiles, ethernet, probe, preferences)
    controller.on('config:all', (config: Record<string, unknown>) => {
        const s = getStore();
        const profiles = (config?.machineProfiles as Array<{ id: string; name: string; voltage?: string; workArea?: string; maxFeed?: string; spindle?: string; controller?: string; notes?: string }>) ?? [];
        const active = (config?.activeMachineProfile as string | null) ?? null;
        s.setMachineProfiles(Array.isArray(profiles) ? profiles : []);
        s.setActiveMachineProfile(active);

        const eth = config?.ethernet as { connectToIP?: string } | undefined;
        if (eth && typeof eth.connectToIP === 'string') {
            s.setEthernet({ connectToIP: eth.connectToIP });
        }
        const probe = config?.probeSettings as Record<string, unknown> | undefined;
        if (probe && typeof probe === 'object') {
            s.setProbeSettings({
                touchPlateType: (probe.touchPlateType as string) ?? 'Standard Block',
                blockThickness: Number(probe.blockThickness) ?? 15,
                xyThickness: Number(probe.xyThickness) ?? 10,
                zProbeDistance: Number(probe.zProbeDistance) ?? 30,
                fastFind: Number(probe.fastFind) ?? 150,
                slowFind: Number(probe.slowFind) ?? 75,
                retraction: Number(probe.retraction) ?? 2,
                connectionTest: Boolean(probe.connectionTest ?? true),
            });
        }
        const prefs = config?.preferences as Record<string, unknown> | undefined;
        if (prefs && typeof prefs === 'object') {
            s.setAppPreferences({
                units: (prefs.units as string) ?? 'mm',
                safeHeight: Number(prefs.safeHeight) ?? 10,
                reconnectAutomatically: Boolean(prefs.reconnectAutomatically ?? false),
                firmwareFallback: (prefs.firmwareFallback as string) ?? 'grblHAL',
                baudRate: Number(prefs.baudRate) ?? 115200,
                rtscts: Boolean(prefs.rtscts ?? false),
                runCheckOnFileLoad: Boolean(prefs.runCheckOnFileLoad ?? false),
                outlineStyle: (prefs.outlineStyle as string) ?? 'Detailed',
            });
        }
    });

    controller.on('config:change', (data: { key: string; value: unknown }) => {
        const s = getStore();
        if (data.key === 'machineProfiles') {
            s.setMachineProfiles(Array.isArray(data.value) ? (data.value as Parameters<typeof s.setMachineProfiles>[0]) : []);
        } else if (data.key === 'activeMachineProfile') {
            s.setActiveMachineProfile(data.value as string | null);
        } else if (data.key === 'ethernet' && data.value && typeof data.value === 'object') {
            const eth = data.value as { connectToIP?: string };
            s.setEthernet((prev) => ({ ...prev, connectToIP: eth.connectToIP ?? prev.connectToIP }));
        } else if (data.key === 'ethernet.connectToIP') {
            s.setEthernet((prev) => ({ ...prev, connectToIP: String(data.value ?? '') }));
        } else if (data.key === 'probeSettings' && data.value && typeof data.value === 'object') {
            const p = data.value as Record<string, unknown>;
            s.setProbeSettings((prev) => ({
                ...prev,
                ...(p.touchPlateType !== undefined && { touchPlateType: String(p.touchPlateType) }),
                ...(p.blockThickness !== undefined && { blockThickness: Number(p.blockThickness) }),
                ...(p.xyThickness !== undefined && { xyThickness: Number(p.xyThickness) }),
                ...(p.zProbeDistance !== undefined && { zProbeDistance: Number(p.zProbeDistance) }),
                ...(p.fastFind !== undefined && { fastFind: Number(p.fastFind) }),
                ...(p.slowFind !== undefined && { slowFind: Number(p.slowFind) }),
                ...(p.retraction !== undefined && { retraction: Number(p.retraction) }),
                ...(p.connectionTest !== undefined && { connectionTest: Boolean(p.connectionTest) }),
            }));
        } else if (data.key.startsWith('probeSettings.')) {
            const field = data.key.slice('probeSettings.'.length);
            s.setProbeSettings((prev) => ({ ...prev, [field]: data.value }));
        } else if (data.key === 'preferences' && data.value && typeof data.value === 'object') {
            const p = data.value as Record<string, unknown>;
            s.setAppPreferences((prev) => ({
                ...prev,
                ...(p.units !== undefined && { units: String(p.units) }),
                ...(p.safeHeight !== undefined && { safeHeight: Number(p.safeHeight) }),
                ...(p.reconnectAutomatically !== undefined && { reconnectAutomatically: Boolean(p.reconnectAutomatically) }),
                ...(p.firmwareFallback !== undefined && { firmwareFallback: String(p.firmwareFallback) }),
                ...(p.baudRate !== undefined && { baudRate: Number(p.baudRate) }),
                ...(p.runCheckOnFileLoad !== undefined && { runCheckOnFileLoad: Boolean(p.runCheckOnFileLoad) }),
                ...(p.outlineStyle !== undefined && { outlineStyle: String(p.outlineStyle) }),
            }));
        } else if (data.key.startsWith('preferences.')) {
            const field = data.key.slice('preferences.'.length);
            s.setAppPreferences((prev) => ({ ...prev, [field]: data.value }));
        }
    });
}

// ─── Convenience Functions ───────────────────────────────────────

export function requestBackendPorts(): Promise<BackendPort[]> {
    return new Promise((resolve, reject) => {
        if (!controller.socket?.connected) {
            reject(new Error('Not connected to backend'));
            return;
        }
        controller.listPorts((err, ports) => {
            if (err) reject(err);
            else resolve(ports || []);
        });
    });
}

const IPV4_REGEX = /^(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.(?:25[0-5]|2[0-4]\d|[01]?\d\d?)$/;

export function connectToBackendPort(
    path: string,
    options: { baudRate?: number; network?: boolean; rtscts?: boolean } = {}
): Promise<void> {
    const baudRate = options.baudRate ?? 115200;
    const network = options.network ?? IPV4_REGEX.test(path.trim());
    const rtscts = options.rtscts ?? false;
    return new Promise((resolve, reject) => {
        if (!controller.socket?.connected) {
            reject(new Error('Not connected to backend. Start the backend server (port 4000) or check the connection.'));
            return;
        }
        controller.openPort(path, { baudRate, network, rtscts }, (err: Error | { message?: string } | null) => {
            if (err) reject(err);
            else resolve();
        });
    });
}

export function disconnectFromBackendPort(): Promise<void> {
    return new Promise((resolve) => {
        controller.closePort(undefined, () => resolve());
        setTimeout(resolve, 1000);
    });
}

export function sendBackendCommand(command: string): Promise<void> {
    controller.sendGcode(command);
    return Promise.resolve();
}

export function backendJog(x?: number, y?: number, z?: number, feedRate = 1000): void {
    controller.jog({ x, y, z, feedRate });
}

export function backendHome(): void { controller.home(); }
export function backendUnlock(): void { controller.unlock(); }
export function backendFeedOverrideReset(): void { controller.feedOverrideReset(); }
export function backendFeedOverrideCoarsePlus(): void { controller.feedOverrideCoarsePlus(); }
export function backendFeedOverrideCoarseMinus(): void { controller.feedOverrideCoarseMinus(); }
export function backendFeedOverrideFinePlus(): void { controller.feedOverrideFinePlus(); }
export function backendFeedOverrideFineMinus(): void { controller.feedOverrideFineMinus(); }
export function backendMotorReset(axis?: string): void {
    if (axis) {
        controller.command(`motor:reset`, axis);
    } else {
        controller.command('motor:resetAll');
    }
}

export function backendJobLoad(content: string): void {
    controller.loadFile('loaded.gcode', content);
}

export function backendJobStart(): void { controller.startJob(); }
export function backendJobStartFromLine(line: number): void { controller.startFromLine(line); }
export function backendJobPause(): void { controller.pauseJob(); }
export function backendJobResume(): void { controller.resumeJob(); }
export function backendJobStop(): void { controller.stopJob(); }

export function backendJobQueue(content: string, _startFromLine = 0): void {
    controller.loadFile('queued.gcode', content);
}

export function backendFeedHold(): void { controller.feedHold(); }
export function backendCycleStart(): void { controller.cycleStart(); }
export function backendSoftReset(): void { controller.reset(); }
export function backendEstop(): void { controller.command('estop'); }
export function backendEstopClear(): void { controller.command('estop:clear'); }
export function backendClearLimitError(): void { controller.command('limit:clear'); }
export function backendCheckMode(): void { controller.checkMode(); }
export function backendGetHelp(): void { controller.sendGcode('$'); }
export function backendGetBuildInfo(): void { controller.getBuildInfo(); }
export function backendGetWorkCoordinates(): void { controller.getWorkCoordinates(); }
export function backendGetParserState(): void { controller.getParserState(); }
export function backendJogCancel(): void { controller.jogCancel(); }

// ─── New Feature Functions ───────────────────────────────────────

export function backendHomeAxis(axis: string): void { controller.homeAxis(axis); }
export function backendProbeZ(params?: { depth?: number; feedRate?: number; retract?: number }): void {
    controller.probeZ(params);
}

export function backendProbeXY(params: {
    thickness: number;
    fastFeedrate: number;
    slowFeedrate: number;
    retract: number;
    depth: number;
    corner: string;
}): Promise<void> {
    // Build XY-only probe G-code and send via command stream
    const { thickness, fastFeedrate, slowFeedrate, retract, depth, corner } = params;
    const xDir = (corner === 'front-right' || corner === 'back-right') ? -1 : 1;
    const yDir = (corner === 'front-left' || corner === 'front-right') ? 1 : -1;
    const lines = [
        'G21', 'G91',
        `G38.2 X${xDir * depth} F${fastFeedrate}`,
        `G38.2 X${-xDir * retract} F${slowFeedrate}`,
        `G38.2 X${xDir * (retract + 2)} F${slowFeedrate}`,
        `G10 L20 P0 X${xDir > 0 ? thickness : -thickness}`,
        `G0 X${-xDir * retract}`,
        `G38.2 Y${yDir * depth} F${fastFeedrate}`,
        `G38.2 Y${-yDir * retract} F${slowFeedrate}`,
        `G38.2 Y${yDir * (retract + 2)} F${slowFeedrate}`,
        `G10 L20 P0 Y${yDir > 0 ? thickness : -thickness}`,
        `G0 Y${-yDir * retract}`,
        'G90',
    ];
    controller.sendGcode(lines.join('\n'));
    return Promise.resolve();
}

export function backendProbeXYZ(params: {
    blockThickness: number;
    xyThickness: number;
    fastFeedrate: number;
    slowFeedrate: number;
    retract: number;
    depth: number;
    corner: string;
}): Promise<void> {
    const { blockThickness, xyThickness, fastFeedrate, slowFeedrate, retract, depth, corner } = params;
    const xDir = (corner === 'front-right' || corner === 'back-right') ? -1 : 1;
    const yDir = (corner === 'front-left' || corner === 'front-right') ? 1 : -1;
    const lines = [
        'G21', 'G91',
        // Z
        `G38.2 Z-${depth} F${fastFeedrate}`,
        `G38.2 Z${retract} F${slowFeedrate}`,
        `G38.2 Z-${retract + 2} F${slowFeedrate}`,
        `G10 L20 P0 Z${blockThickness}`,
        `G0 Z${retract}`,
        // X
        `G38.2 X${xDir * depth} F${fastFeedrate}`,
        `G38.2 X${-xDir * retract} F${slowFeedrate}`,
        `G38.2 X${xDir * (retract + 2)} F${slowFeedrate}`,
        `G10 L20 P0 X${xDir > 0 ? xyThickness : -xyThickness}`,
        `G0 X${-xDir * retract}`,
        // Y
        `G38.2 Y${yDir * depth} F${fastFeedrate}`,
        `G38.2 Y${-yDir * retract} F${slowFeedrate}`,
        `G38.2 Y${yDir * (retract + 2)} F${slowFeedrate}`,
        `G10 L20 P0 Y${yDir > 0 ? xyThickness : -xyThickness}`,
        `G0 Y${-yDir * retract}`,
        'G90',
    ];
    controller.sendGcode(lines.join('\n'));
    return Promise.resolve();
}

/**
 * Request the current probe pin state from the backend.
 * Returns true if the pin is currently active/triggered (circuit closed),
 * false if open (normal "ready" state). Rejects on error/timeout.
 */
export function backendTestProbePin(): Promise<boolean> {
    return new Promise((resolve, reject) => {
        if (!controller.socket?.connected) {
            reject(new Error('Not connected to backend'));
            return;
        }
        // Send a probe test query via the gcode command — G38.2 Z0 F1 is a
        // zero-distance probe that immediately resolves with the pin state.
        // We listen for the next controller state to read the pin flag.
        // Alternatively, some backends expose a probe:test event directly.
        // Here we use a best-effort approach: emit probe:test if supported,
        // fall back to reading the probe pin from the next controller state.
        const timeout = setTimeout(() => {
            cleanup();
            // Timeout is not a hard failure — assume pin is open (ready)
            resolve(false);
        }, 3000);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const handleState = (_type: string, state: any) => {
            if (state?.status?.pinState !== undefined) {
                const pinState: string = state.status.pinState ?? '';
                cleanup();
                // Pin state 'P' means probe is triggered in grblHAL
                resolve(pinState.includes('P'));
            }
        };

        const cleanup = () => {
            clearTimeout(timeout);
            controller.off('controller:state', handleState);
        };

        controller.on('controller:state', handleState);

        // Send a status request to get fresh pin state
        controller.sendGcode('?');
    });
}
export function backendSetWCS(wcs: string): void { controller.setWCS(wcs); }
export function backendZeroWCS(params?: { axes?: string[]; wcs?: string }): void { controller.zeroWCS(params); }
export function backendZeroAll(): void { controller.zeroAll(); }

/** Set active machine profile on backend (persists and triggers config:change). */
export function setBackendActiveMachineProfile(id: string | null): void {
    controller.setConfig('activeMachineProfile', id);
}

/** Persist a config key to backend (e.g. 'ethernet', 'probeSettings', 'preferences'). */
export function setBackendConfig(key: string, value: unknown): void {
    controller.setConfig(key, value);
}
export function backendConfirmToolChange(): void { controller.confirmToolChange(); }
export function backendCancelToolChange(): void { controller.cancelToolChange(); }
export function backendRunMacro(id: string): void { controller.runMacro(id); }
export function backendRunMacroContent(content: string): void { controller.runMacroContent(content); }
export function backendEnableDebug(): void { controller.enableDebug(); }
export function backendDisableDebug(): void { controller.disableDebug(); }

// ─── EEPROM / Firmware Settings ──────────────────────────────────

/**
 * Request all GRBL EEPROM settings via the $$ command.
 * Settings are returned as controller:settings events (already wired to
 * addConsoleLog). Returns a promise that resolves with the parsed settings map
 * after collecting responses for up to `timeoutMs` milliseconds.
 */
export function backendReadEEPROM(timeoutMs = 3000): Promise<Record<number, string>> {
    return new Promise((resolve) => {
        const result: Record<number, string> = {};

        const handleLine = (line: string) => {
            // GRBL responds with lines like: $0=10 (step pulse, usec)
            const m = line.match(/^\$(\d+)=([^\s(]+)/);
            if (m) {
                result[parseInt(m[1], 10)] = m[2];
            }
        };

        // Subscribe to raw serial reads to capture $$ output
        controller.on('serialport:read', handleLine);

        // Send $$ to request all settings
        controller.sendGcode('$$');

        setTimeout(() => {
            controller.off('serialport:read', handleLine);
            resolve(result);
        }, timeoutMs);
    });
}

/**
 * Write a single GRBL EEPROM setting: $id=value
 */
export function backendWriteEEPROMSetting(id: number, value: string | number): void {
    controller.sendGcode(`$${id}=${value}`);
}

/**
 * Write multiple GRBL EEPROM settings from an id->value map.
 * Sends each as a separate command with a small gap.
 */
export function backendWriteEEPROMBatch(
    settings: Record<number, string | number>,
    delayMs = 50
): Promise<void> {
    const entries = Object.entries(settings);
    if (entries.length === 0) return Promise.resolve();

    return entries.reduce<Promise<void>>(
        (chain, [id, val]) =>
            chain.then(
                () =>
                    new Promise((res) => {
                        controller.sendGcode(`$${id}=${val}`);
                        setTimeout(res, delayMs);
                    })
            ),
        Promise.resolve()
    );
}

// ─── Coolant Commands ────────────────────────────────────────────
export function backendCoolantMist(): void { controller.sendGcode('M7'); }
export function backendCoolantFlood(): void { controller.sendGcode('M8'); }
export function backendCoolantOff(): void { controller.sendGcode('M9'); }

// ─── Spindle Commands ────────────────────────────────────────────
export function backendSpindleCW(rpm: number): void { controller.sendGcode(`M3 S${rpm}`); }
export function backendSpindleCCW(rpm: number): void { controller.sendGcode(`M4 S${rpm}`); }
export function backendSpindleStop(): void { controller.sendGcode('M5'); }

// ─── Outline Run ─────────────────────────────────────────────────
export function backendRunOutlineGcode(name: string, gcode: string): void {
    controller.loadFile(name, gcode);
    setTimeout(() => controller.command('gcode:start'), 200);
}

export { getBackendUrl };
