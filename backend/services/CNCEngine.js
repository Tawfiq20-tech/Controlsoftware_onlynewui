/**
 * CNCEngine - Socket.IO server for real-time frontend communication.
 *
 * Manages:
 *   - Connection lifecycle (open/close serial/network ports)
 *   - Automatic firmware detection and controller instantiation
 *   - Multi-client Socket.IO broadcasting
 *   - Port enumeration
 *   - G-code file management
 *   - Command routing to active controller
 *
 * Reference: gSender CNCEngine.js (GPLv3, Sienci Labs Inc.)
 * @see https://github.com/Sienci-Labs/gsender/blob/master/src/server/services/cncengine/CNCEngine.js
 */
const path = require('path');
const { EventEmitter } = require('events');
const { Connection, FIRMWARE_GRBL, FIRMWARE_GENERIC } = require('./Connection');
const { SerialConnection } = require('./SerialConnection');
const { createController } = require('./controllers');
const { createSessionLogger } = require('./SessionLogger');
const { ConfigStore } = require('./ConfigStore');
const { isRotaryFile } = require('../lib/rotary');
const remoteDiagMirror = require('./RemoteDiagMirror');
const configPolicy = require('./remoteAccess/configPolicy');
const { hasLocalControl, isOperatorIdentity, LOCAL_ROOM } = require('./remoteAccess/RemoteAccessService');
const logger = require('../logger');

/** Handshake identity set by RemoteAccessService.socketGate (absent without the gate: treated as remote). */
function socketIdentity(socket) {
    return socket && socket.data ? socket.data.identity : undefined;
}

const { ControllerRestartMonitor } = require('./ControllerRestartMonitor');

/** RemoteDiag status without the mirror URL, for sockets without local control. */
function publicDiagStatus(status) {
    return { ...status, url: null };
}

// Commands that start the machine on the loaded program: they wait for a file
// load still being prepared, or they would run the previous file.
const JOB_START_COMMANDS = new Set(['gcode:start', 'gcode:startFresh', 'gcode:startFromLine', 'gcode:resume', 'cyclestart']);

class CNCEngine extends EventEmitter {
    /**
     * @param {object} io - Socket.IO server instance
     */
    constructor(io) {
        super();

        this.io = io;

        /** @type {Connection|null} Active connection */
        this.connection = null;

        /** @type {import('./GRBLController').GrblController|null} Active controller */
        this.controller = null;

        /** @type {string|null} Active port/path */
        this.port = null;

        /** @type {object|null} Loaded G-code file info */
        this.loadedFile = null;

        /** @type {object|null} Session logger */
        this.sessionLogger = null;

        /** @type {ConfigStore} Persistent configuration */
        this.config = new ConfigStore(
            path.join(__dirname, '..', 'data', 'config.json')
        );

        /** @type {import('./jobresume/JobResumeService').JobResumeService|null} */
        this.jobResumeService = null;

        // Track whether a job is in a paused state for file-upload conflict detection.
        this._jobPaused = false;

        // File loads still being prepared (worker thread), and a counter that
        // cancels job starts waiting on them -- see _handleCommand.
        this._loadsInFlight = new Set();
        this._startGeneration = 0;
        // socket -> { name, reason } of that screen's last file:load that was
        // refused or failed. While set, every Start-type command from that
        // socket is refused: its screen shows a file the machine does not
        // have, so Start would run (or resume) something else. Cleared by that
        // socket's next successful load or its file:unload.
        this._refusedLoads = new WeakMap();

        // Detects a controller board that rebooted between connections (its
        // position is gone) -- see services/ControllerRestartMonitor.js.
        this._restartMonitor = new ControllerRestartMonitor();

        // Serializes _handleOpen() attempts. Without this, two overlapping
        // serialport:open requests can both pass the "no connection yet"
        // guard checks before either's real hardware open() completes,
        // each construct their own `new Connection(...)`, and the second
        // silently orphans the first (still opening, timers still running)
        // with nothing left referencing it to ever close.
        this._openLock = Promise.resolve();

        // ECSS-E: bring up the remote diag mirror if the user previously
        // toggled it on. The mirror connects out; it never accepts inbound
        // connections, so this is safe to fire-and-forget on boot.
        const diagEnabled = this.config.get('preferences.remoteDiagEnabled', false);
        const diagUrl = this.config.get('preferences.remoteDiagUrl', null);
        const diagToken = this.config.get('preferences.remoteDiagToken', null);
        // Inject (remote command -> live controller, i.e. remote motion) is a
        // SEPARATE opt-in from the mirror itself and defaults OFF. The mirror
        // connection alone only ever sends data outbound; nothing on the wire
        // format required a return channel. Requiring this second flag means
        // enabling telemetry visibility can never silently also enable remote
        // motion control -- that needs its own explicit decision.
        const diagAllowInject = this.config.get('preferences.remoteDiagAllowInject', false);
        if (diagUrl) remoteDiagMirror.setUrl(diagUrl);
        if (diagToken) remoteDiagMirror.setToken(diagToken);
        remoteDiagMirror.onInject((payload) => {
            if (!diagAllowInject) {
                logger.warn('[RemoteDiag] INJECT blocked -- preferences.remoteDiagAllowInject is not true');
                return;
            }
            // Inject-handler — forwards command to the active controller.
            try {
                if (this.controller && payload && payload.cmd) {
                    logger.warn(`[RemoteDiag] INJECT: ${payload.cmd} ${JSON.stringify(payload.args || [])}`);
                    this.controller.command(payload.cmd, ...(payload.args || []));
                }
            } catch (e) {
                logger.warn(`[RemoteDiag] inject failed: ${e.message}`);
            }
        });
        if (diagEnabled) {
            remoteDiagMirror.start();
        }

        this._setupSocketIO();
    }

    // ─── Socket.IO Setup ─────────────────────────────────────────────

    _setupSocketIO() {
        this.io.on('connection', (socket) => {
            logger.info(`Socket.IO client connected: ${socket.id}`);

            // Send current state to newly connected client
            this._sendInitialState(socket);

            // Register the socket with the active connection
            if (this.connection) {
                this.connection.addConnection(socket);
            }

            // ─── Port Management ─────────────────────────────────
            socket.on('list', (callback) => this._handleList(socket, callback));
            socket.on('open', (portPath, options, callback) => this._handleOpen(socket, portPath, options, callback));
            socket.on('close', (portPath, callback) => this._handleClose(socket, portPath, callback));

            // ─── Commands ────────────────────────────────────────
            socket.on('command', (portPath, cmd, ...args) => this._handleCommand(socket, portPath, cmd, ...args));
            socket.on('write', (portPath, data, context) => this._handleWrite(socket, portPath, data, context));
            socket.on('writeln', (portPath, data, context) => this._handleWriteln(socket, portPath, data, context));

            // [GENERIC MODE] Raw command passthrough — writes directly to serial port
            // Raw text is written THROUGH the controller, never straight to the
            // port: on the RSP board every non-framed byte reaches the
            // firmware's plain-text G-code parser, so a raw line could move the
            // machine in the middle of a carve (RSPController.write() refuses
            // it and says why). Blocked outright while a job is running.
            socket.on('command:raw', (cmd) => {
                if (!this.controller || !this.connection || !this.connection.isOpen) return;
                if (this.controller.job && this.controller.job.active) {
                    logger.warn(`[RAW CMD] refused while a job is running: ${String(cmd).slice(0, 64)}`);
                    socket.emit('serialport:read', '[RAW CMD] refused: a job is running');
                    return;
                }
                const data = String(cmd).endsWith('\n') ? String(cmd) : String(cmd) + '\n';
                logger.info(`[RAW CMD] ${data.trim()}`);
                this.controller.write(data);
            });

            // ─── File Management ─────────────────────────────────
            socket.on('file:load', (data) => {
                const load = this._handleFileLoad(socket, data).catch((err) => {
                    logger.error(`[Engine] file:load failed: ${err && err.stack ? err.stack : err}`);
                    const msg = `Loading failed: ${err && err.message ? err.message : err}`;
                    socket.emit('file:loadError', { name: (data && data.name) || '', errorCount: 1, errors: [{ line: null, msg }] });
                    return { ok: false, reason: msg };
                }).then((outcome) => this._noteLoadOutcome(socket, data, outcome));
                // Start commands wait for this (see _handleCommand).
                this._loadsInFlight.add(load);
                load.finally(() => this._loadsInFlight.delete(load));
            });
            socket.on('file:unload', () => this._handleFileUnload(socket));

            // ECSS-E remote diag toggle is handled in _handleCommand (frontend
            // routes everything through controller.command → 'command' event,
            // not as a separate top-level socket event). On connect we still
            // push current status so the frontend hydrates the badge state.
            {
                const diag = remoteDiagMirror.status();
                socket.emit('safety:remoteDiagStatus', hasLocalControl(socketIdentity(socket)) ? diag : publicDiagStatus(diag));
            }

            // ─── Macros ──────────────────────────────────────────
            socket.on('macro:list', (callback) => {
                const macros = this.config.getMacros();
                if (typeof callback === 'function') callback(null, macros);
                else socket.emit('macro:list', macros);
            });
            socket.on('macro:save', (macro, callback) => {
                this.config.saveMacro(macro);
                const macros = this.config.getMacros();
                this.io.emit('macro:list', macros);
                if (typeof callback === 'function') callback(null, macros);
            });
            socket.on('macro:delete', (id, callback) => {
                this.config.deleteMacro(id);
                const macros = this.config.getMacros();
                this.io.emit('macro:list', macros);
                if (typeof callback === 'function') callback(null, macros);
            });
            socket.on('macro:run', (id) => {
                const macro = this.config.getMacro(id);
                if (macro && this.controller) {
                    this.controller.command('macro:run', macro.content);
                }
            });

            // ─── Tool Library ────────────────────────────────────
            socket.on('tool:list', (callback) => {
                const tools = this.config.getTools();
                if (typeof callback === 'function') callback(null, tools);
                else socket.emit('tool:list', tools);
            });
            socket.on('tool:save', (tool, callback) => {
                this.config.saveTool(tool);
                const tools = this.config.getTools();
                this.io.emit('tool:list', tools);
                if (typeof callback === 'function') callback(null, tools);
            });
            socket.on('tool:delete', (id, callback) => {
                this.config.deleteTool(id);
                const tools = this.config.getTools();
                this.io.emit('tool:list', tools);
                if (typeof callback === 'function') callback(null, tools);
            });

            // ─── Event Triggers ──────────────────────────────────
            socket.on('trigger:list', (callback) => {
                if (this.controller) {
                    const triggers = this.controller.getEventTriggers();
                    if (typeof callback === 'function') callback(null, triggers);
                    else socket.emit('trigger:list', triggers);
                }
            });
            socket.on('trigger:set', (eventName, config) => {
                if (this.controller) {
                    this.controller.command('trigger:set', eventName, config);
                    this.config.set(`eventTriggers.${eventName}`, config);
                }
            });

            // ─── Config / Preferences ────────────────────────────
            // The LAN packet filter already refuses these events; the checks
            // below keep secrets and remote-channel settings safe regardless.
            socket.on('config:get', (key, callback) => {
                if (typeof callback !== 'function') return;
                if (typeof key !== 'string') return callback(null, undefined);
                const value = this.config.get(key);
                if (hasLocalControl(socketIdentity(socket))) return callback(null, value);
                const pub = configPolicy.publicConfigChange(key, value);
                return callback(null, pub ? pub.value : undefined);
            });
            socket.on('config:set', (key, value) => {
                if (typeof key !== 'string' || !key) return;
                const identity = socketIdentity(socket);
                if (!hasLocalControl(identity)
                    || (!isOperatorIdentity(identity)
                        && configPolicy.isOperatorOnlyConfigWrite(key, value, this.config.get('preferences', {})))) {
                    logger.warn(`[Engine] config:set '${key}' refused: operator only`);
                    socket.emit('config:denied', { key, error: 'operator_required' });
                    return;
                }
                this.config.set(key, value);
                this._emitConfigChange(key, value);
            });
            socket.on('config:getAll', (callback) => {
                if (typeof callback !== 'function') return;
                const all = this.config.getAll();
                callback(null, hasLocalControl(socketIdentity(socket)) ? all : configPolicy.publicConfigView(all));
            });

            // ─── Debug Monitor ───────────────────────────────────
            socket.on('debug:enable', () => {
                if (this.controller) this.controller.command('debug:enable');
            });
            socket.on('debug:disable', () => {
                if (this.controller) this.controller.command('debug:disable');
            });
            socket.on('debug:getEntries', (count, type, callback) => {
                if (this.controller) {
                    const entries = this.controller.debugMonitor.getEntries(count, type);
                    if (typeof callback === 'function') callback(null, entries);
                }
            });

            // ─── Health Check ────────────────────────────────────
            socket.on('hPing', () => {
                socket.emit('hPong');
                if (this.controller) {
                    this.controller.healthMonitor.recordPong();
                }
            });
            socket.on('health:metrics', (callback) => {
                if (this.controller) {
                    const metrics = this.controller.getHealthMetrics();
                    if (typeof callback === 'function') callback(null, metrics);
                    else socket.emit('health:metrics', metrics);
                }
            });

            // ─── Firmware Flashing ───────────────────────────────
            socket.on('firmware:flash', async (options, callback) => {
                const { port, boardType, hexPath, useOfficialRelease } = options || {};
                let hexData = options?.hexData;
                try {
                    // Safety check: ensure machine is not actively running a job or in alarm
                    const currentMachineState = this.state?.status?.activeState || this.controller?.state?.status?.activeState || 'idle';
                    if (this.firmwareUpdateService) {
                        const safety = this.firmwareUpdateService.canFlash(currentMachineState);
                        if (!safety.allowed) {
                            throw new Error(safety.reason);
                        }
                    }

                    // Official OTA release flow: in-memory secure retrieval with SHA-256 validation
                    if (useOfficialRelease || (!hexData && !hexPath && boardType === 'EASYCNC')) {
                        if (!this.firmwareUpdateService) {
                            const { FirmwareUpdateService } = require('./firmware/FirmwareUpdateService');
                            this.firmwareUpdateService = new FirmwareUpdateService({ logger });
                        }
                        socket.emit('flash:message', { type: 'info', content: 'Retrieving and verifying official firmware release...' });
                        hexData = await this.firmwareUpdateService.getOfficialHexData();
                    }

                    const FirmwareFlashing = require('../lib/Firmware/Flashing/firmwareflashing');
                    // EASYCNC's no-BOOT0 DFU path drives the bootloader jump
                    // over the existing RSP link, so it needs the live bound
                    // controller, not just the port string the other board
                    // types use (avrgirl / DTR-RTS serial bootloader).
                    await FirmwareFlashing.flash(port, boardType, { hexPath, hexData, socket, controller: this.controller });
                    if (typeof callback === 'function') callback(null, { success: true });
                } catch (err) {
                    logger.error(err);
                    if (typeof callback === 'function') callback(err);
                    else socket.emit('flash:error', err.message);
                }
            });

            // ─── Job Isolation (paused-job conflict resolution) ───────
            socket.on('job:conflict:replace', () => {
                // User chose to replace the paused job with the new file.
                logger.info('[Engine] job:conflict:replace — aborting paused job');
                if (this.controller) {
                    this.controller.command('gcode:stop');
                }
                if (this.jobResumeService) {
                    this.jobResumeService.clearCheckpoint();
                }
                this._jobPaused = false;
                // The file:load that was rejected will be retried by the
                // frontend after receiving 'job:conflict:resolved'.
                this.io.emit('job:conflict:resolved', { action: 'replaced' });
            });

            socket.on('job:conflict:cancel', () => {
                // User chose to keep the paused job — reject the upload.
                logger.info('[Engine] job:conflict:cancel — keeping paused job');
                this.io.emit('job:conflict:resolved', { action: 'cancelled' });
            });

            socket.on('job:conflict:save', () => {
                // User chose to save the paused job checkpoint, then allow the new file.
                logger.info('[Engine] job:conflict:save — saving checkpoint then clearing');
                if (this.controller) {
                    this.controller.command('gcode:stop');
                }
                // Checkpoint is already saved by the stop handler via JobResumeService.
                // Don't clear it — user explicitly asked to save.
                this._jobPaused = false;
                this.io.emit('job:conflict:resolved', { action: 'saved' });
            });

            socket.on('job:resume:confirm', (opts) => {
                // User confirmed they want to resume from the checkpoint.
                if (this.jobResumeService) {
                    const result = this.jobResumeService.resumeFromCheckpoint(opts || {});
                    socket.emit('job:resume:result', result);
                } else {
                    socket.emit('job:resume:result', { ok: false, error: 'Resume service not available' });
                }
            });

            // ─── Cleanup ─────────────────────────────────────────────
            socket.on('disconnect', () => {
                logger.info(`Socket.IO client disconnected: ${socket.id}`);
                if (this.connection) {
                    this.connection.removeConnection(socket);
                }
            });
        });
    }

    /**
     * Sends an event in full to sockets with local control and, when
     * publicPayload is given, that redacted form to every other socket.
     */
    _emitScoped(event, fullPayload, publicPayload) {
        const io = this.io;
        if (!io) return;
        if (typeof io.to === 'function' && typeof io.except === 'function') {
            io.to(LOCAL_ROOM).emit(event, fullPayload);
            if (publicPayload !== undefined) io.except(LOCAL_ROOM).emit(event, publicPayload);
        } else if (publicPayload !== undefined && typeof io.emit === 'function') {
            io.emit(event, publicPayload);
        }
    }

    _emitConfigChange(key, value) {
        const pub = configPolicy.publicConfigChange(key, value);
        this._emitScoped('config:change', { key, value }, pub || undefined);
    }

    // ─── Initial State ───────────────────────────────────────────────

    _sendInitialState(socket) {
        // Send current connection state
        if (this.controller && this.connection && this.connection.isOpen) {
            socket.emit('serialport:open', {
                port: this.port,
                controllerType: this.connection.controllerType,
            });

            // Send current controller state
            const controllerState = {
                status: this.controller.state?.status || {},
                parserstate: this.controller.state?.parserstate || {},
            };
            socket.emit('controller:state', this.controller.type, controllerState);

            // Send workflow state (all controllers implement this)
            if (typeof this.controller.getWorkflowState === 'function') {
                socket.emit('workflow:state', this.controller.getWorkflowState());
            }

            // Send sender status
            if (typeof this.controller.getSenderStatus === 'function') {
                socket.emit('sender:status', this.controller.getSenderStatus());
            }

            // Where a stopped job can continue, and whether the machine is
            // waiting at a program pause right now (a client that connects or
            // refreshes mid-job has to see both).
            if (typeof this.controller.getResumePoint === 'function') {
                socket.emit('job:resumePoint', this.controller.getResumePoint());
            }
            if (this._programPause) socket.emit('job:programPause', this._programPause);

            // Send feeder status
            if (typeof this.controller.getFeederStatus === 'function') {
                socket.emit('feeder:status', this.controller.getFeederStatus());
            }

            // Send tool changer status
            if (typeof this.controller.getToolChangerStatus === 'function') {
                socket.emit('toolchanger:status', this.controller.getToolChangerStatus());
            }

            // Send loaded file info
            if (this.loadedFile) {
                socket.emit('file:load', this.loadedFile);
            }

            // Controller identity. 'controller:type' and 'controller:initialized'
            // are emitted once at bind; a screen that restarts mid-carve joined
            // after that and kept firmwareType 'unknown' (treated as RSP), so on
            // an RTS/GRBL machine the Start-From-Line dialog waited forever for a
            // preview the backend has no handler for -- and controllerReady, which
            // serialport:open sets false, was never set true again.
            socket.emit('controller:type', this.controller.type);
            socket.emit('controller:initialized', this._controllerInitialized || {
                firmwareType: this.controller.type,
                firmwareVersion: '',
            });
        }

        // Always send config data (macros, tools, preferences)
        socket.emit('macro:list', this.config.getMacros());
        socket.emit('tool:list', this.config.getTools());
        // Full config (telegram.token, RemoteDiag token, camera URLs) only
        // to sockets with local control; everyone else gets the public view.
        const all = this.config.getAll();
        socket.emit('config:all', hasLocalControl(socketIdentity(socket)) ? all : configPolicy.publicConfigView(all));
    }

    /**
     * Come back to the origin corner when a design finishes.
     *
     * The operator lines the next piece up against X0 Y0, so ending there is
     * what makes the next setup quick and repeatable. Z is NOT taken to 0 --
     * work Z0 is the material surface. It ends at a travel height instead, so
     * the DRO reads 0.000 / 0.000 / <height>: the zero survived, and one jog
     * step down touches the wood.
     *
     * The first version of this sent command('gcode', 'G0 Z10'). The RSP
     * controller accepts nothing but M3/M4/M5/M7/M8/M9 on that command and
     * warns "ignored" for the rest, so it never moved an axis while logging
     * that it had. It now goes through job:returnToOrigin, which is a real
     * OP_MOVE.
     *
     * @param {object} data  the sender:end payload
     */
    _returnToOriginAfterJob(data) {
        try {
            const say = (why) => logger.info(`[Engine] not returning to origin: ${why}`);

            // A macro is not a design. Touch-plate Z-zeroing is a macro, and it
            // finishes with the operator's hands at the machine -- the last
            // moment to start an unannounced rapid.
            if (data && data.macro) return;
            if (!this.controller || !this.connection || !this.connection.isOpen) return;

            const mode = String(this.config.get('preferences.returnToOrigin', 'origin'));
            if (mode === 'off') return;

            const st = (this.controller.state && this.controller.state.status) || {};
            const active = String(st.activeState || '').toLowerCase();
            if (active === 'alarm' || active === 'hold' || st.estop) return say(`machine is ${active || 'in e-stop'}`);

            // The board lost its position at some point in this job: X0 Y0 no
            // longer means what the operator set.
            const point = typeof this.controller.getResumePoint === 'function' ? this.controller.getResumePoint() : null;
            if (point && point.positionExact === false) return say('the machine is not sure where it is');
            if (this._controllerRestartedThisJob) return say('the controller restarted during this job');

            // How high to travel. safeHeight is a jog convenience, not a
            // clearance plane: a rapid across the work at that height can still
            // hit a clamp or the stock itself. Clear the program's own highest
            // point as well, plus whatever the shop's hold-downs need.
            const safe = Number(this.config.get('preferences.safeHeight', 10)) || 10;
            const extra = Number(this.config.get('preferences.returnClearanceExtra', 0)) || 0;
            const meta = this.controller._loadedMeta || null;
            const ext = meta && meta.extents;
            const fileMaxZ = ext && ext.max && Number.isFinite(Number(ext.max.z)) ? Number(ext.max.z) : null;

            let travelZ = Math.max(safe, fileMaxZ === null ? safe : fileMaxZ) + extra;

            // Never ask for more height than the machine has.
            const headroom = this.config.get('machine.zHeadroom', null);
            if (headroom !== null && Number.isFinite(Number(headroom)) && travelZ > Number(headroom)) {
                travelZ = Number(headroom);
            }

            // Travelling across the work is only safe if we know what the work
            // reaches up to. Without extents, lift and stop there.
            const xy = mode === 'origin' && fileMaxZ !== null && travelZ >= safe - 0.001;
            if (mode === 'origin' && !xy) {
                say(fileMaxZ === null
                    ? 'the height of this program is unknown, so the tool was lifted but not moved across the work'
                    : 'there is not enough height above the work zero to travel clear');
            }

            // One tick, so the job:end and workflow:state listeners that follow
            // this event finish before any new motion starts.
            setImmediate(() => {
                try {
                    logger.info(`[Engine] design finished -- lifting to Z${travelZ.toFixed(3)}${xy ? ' and returning to X0 Y0' : ''}`);
                    this.controller.command('job:returnToOrigin', { travelZ, xy });
                } catch (err) {
                    logger.warn(`[Engine] could not return to origin: ${err && err.message}`);
                }
            });
        } catch (err) {
            // A convenience must never break the end of a job.
            logger.warn(`[Engine] could not return to origin: ${err && err.message}`);
        }
    }

    // ─── Port Listing ────────────────────────────────────────────────

    async _handleList(socket, callback) {
        try {
            const ports = await SerialConnection.listPorts();
            const portList = ports.map((p) => ({
                port: p.path,
                manufacturer: p.manufacturer || '',
                serialNumber: p.serialNumber || '',
                vendorId: p.vendorId || '',
                productId: p.productId || '',
                inuse: this.port === p.path,
            }));

            if (typeof callback === 'function') {
                callback(null, portList);
            }
            socket.emit('serialport:list', portList);
        } catch (err) {
            logger.error('Port listing error:', err);
            if (typeof callback === 'function') {
                callback(err);
            }
        }
    }

    // ─── Open Connection ─────────────────────────────────────────────

    // Thin serializing wrapper around _doHandleOpen(). Chains onto
    // _openLock so overlapping 'open' requests (e.g. two browser tabs, or
    // a frontend reload racing the socket reconnect) run one at a time
    // instead of each constructing their own Connection and orphaning
    // whichever one loses the race.
    _handleOpen(socket, portPath, options, callback) {
        this._openLock = this._openLock
            .then(() => this._doHandleOpen(socket, portPath, options, callback))
            .catch((exc) => {
                logger.error(`_handleOpen chain error: ${exc?.message || exc}`);
            });
    }

    async _doHandleOpen(socket, portPath, options, callback) {
        if (typeof options === 'function') {
            callback = options;
            options = {};
        }
        options = options || {};

        if (!portPath) {
            const err = new Error('Missing port path or IP address');
            if (typeof callback === 'function') callback(err);
            return;
        }

        // FIX-10 (Tawfiq fix-plan item 6): the frontend's useAutoConnect hook
        // resets its "connected" state to false on every page reload and, on
        // a race against the backend's serialport:open replay to the new
        // socket, re-issues an 'open' for the same port that's already live
        // -- even mid-job. Tearing down and recreating the connection here
        // re-runs Connection.js's firmware-detection probe, which sends a
        // real soft-reset byte to the board, killing whatever was running.
        // If it's the exact same already-open port, this is just the new
        // socket asking to attach to what's already there -- do that instead
        // of resetting the link.
        if (this.connection && this.connection.isOpen && this.port === portPath) {
            this.connection.addConnection(socket);
            socket.emit('serialport:open', { port: this.port, controllerType: this.connection.controllerType });
            if (typeof callback === 'function') callback(null);
            return;
        }

        // Close existing connection if any (different port, or a stale one)
        if (this.connection && this.connection.isOpen) {
            this._closeConnection();
        }

        const baudRate = options.baudRate || 115200;
        const network = options.network || false;
        const networkPort = options.networkPort || undefined;
        const rtscts = options.rtscts || false;

        logger.info(`Opening connection: ${portPath} (baud: ${baudRate}, network: ${network}, rtscts: ${rtscts})`);

        // Create Connection (Layer 2)
        this.connection = new Connection({
            path: portPath,
            baudRate,
            network,
            networkPort,
            rtscts,
        });
        this.port = portPath;

        // Register the requesting socket
        this.connection.addConnection(socket);

        // Listen for firmware detection
        this.connection.on('firmwareDetected', (firmware, dataBuffer) => {
            this._onFirmwareDetected(firmware, dataBuffer);
        });

        // Listen for connection events
        this.connection.on('error', (err) => {
            logger.error(`Connection error: ${err?.message}`);
            this.io.emit('serialport:error', { port: portPath, error: err?.message });
        });

        this.connection.on('close', () => {
            this._onConnectionClose();
        });

        // Open the connection. _handleOpen() chains this call onto
        // _openLock, so wrap it in a Promise that resolves once the open
        // attempt (success or failure) actually completes -- otherwise the
        // lock would release as soon as this synchronous body returns.
        return new Promise((resolveOpen) => {
            this.connection.open((err) => {
                if (err) {
                    logger.error(`Failed to open ${portPath}: ${err.message}`);
                    this.connection = null;
                    this.port = null;
                    if (typeof callback === 'function') callback(err);
                    socket.emit('serialport:error', { port: portPath, error: err.message });
                    resolveOpen();
                    return;
                }

                // Start session logging
                if (this.sessionLogger) {
                    this.sessionLogger.close();
                }
                this.sessionLogger = createSessionLogger(logger.sessionsDir, portPath);
                this.sessionLogger.logConnection(true, portPath);

                logger.info(`Connection opened: ${portPath}`);
                this.io.emit('serialport:open', { port: portPath });

                if (typeof callback === 'function') callback(null);
                resolveOpen();
            });
        });
    }

    // ─── Firmware Detection → Controller Instantiation ───────────────

    _onFirmwareDetected(firmware, dataBuffer) {
        logger.info(`Firmware detected: ${firmware}`);

        // Create the appropriate controller
        this.controller = createController(firmware);
        // Jogs are held to the same per-axis rates as programs (RSP), read
        // from the config at each jog so a changed setting applies at once.
        if (typeof this.controller.setMachineLimitsProvider === 'function') {
            this.controller.setMachineLimitsProvider(() => ({ maxRate: this._machineMaxRate() }));
        }

        // Bind controller to connection
        this.controller.bind(this.connection);
        this._restartMonitor.onBind();

        // Wire controller events to Socket.IO
        this._wireControllerEvents();

        // Notify all clients
        this.io.emit('controller:type', firmware);

        // Internal (non-socket) event so services holding a stale
        // getController() closure (e.g. JobHistoryService) can re-attach
        // their own listeners to this fresh controller instance. A new
        // controller object is created on every connect/reconnect, so a
        // one-time wire-up in a service constructor goes stale after the
        // first bind (FIXFILE.html FIX-20).
        this.emit('controller:bound', this.controller);

        // [GENERIC MODE] GenericController has no runner — skip replay
        // [RTS] RTSController has no runner — skip replay
        // [GRBL ONLY] Replay buffered data through the GRBL runner
        if (this.controller.runner && typeof this.controller.runner.parse === 'function' && dataBuffer && dataBuffer.length > 0) {
            for (const line of dataBuffer) {
                this.controller.runner.parse(line);
            }
        }

        // Log
        if (this.sessionLogger) {
            this.sessionLogger.logConnection(true, `Firmware: ${firmware}`);
        }
    }

    // ─── Controller Event Wiring ─────────────────────────────────────

    _wireControllerEvents() {
        if (!this.controller) return;

        // Console output
        this.controller.on('console', (line) => {
            this.io.emit('serialport:read', line);
            if (this.sessionLogger) this.sessionLogger.logConsole(line);
        });

        // Status updates
        this.controller.on('status', (status) => {
            const restart = this._restartMonitor.onStatus(status);
            if (restart && typeof this.controller.notifyControllerRestarted === 'function') {
                this.controller.notifyControllerRestarted(restart);
            }
            this.io.emit('controller:state', this.controller.type, {
                status,
                parserstate: this.controller.state.parserstate,
            });
            if (this.sessionLogger) {
                const pos = status.wpos || status.mpos;
                /* job-63998 debug extension -- see RSPController.js
                 * _onTelemetry(). Only RSPController sets these; every other
                 * controller leaves them undefined and JSON.stringify drops
                 * undefined keys, so this is a no-op for GRBL/RTS sessions. */
                this.sessionLogger.logPosition({
                    ...pos,
                    last_executed_line: status.lastExecutedLine,
                    state: status.state,
                    estop_active: status.estop,
                    dbg_jog_active: status.dbgJogActive,
                    dbg_jog_done_evt: status.dbgJogDoneEvt,
                    dbg_tim2_isr_count: status.dbgTim2IsrCount,
                    dbg_steps_done: status.dbgStepsDone,
                    dbg_steps_total: status.dbgStepsTotal,
                    fault_flags: status.faultFlags,
                    limit_flags: status.limitFlags,
                    pos_exact: status.posExact,
                    feed: status.feedrate,
                });
            }
        });

        // Parser state
        this.controller.on('parserstate', (ps) => {
            this.io.emit('controller:state', this.controller.type, {
                status: this.controller.state.status,
                parserstate: ps,
            });
        });

        // ECSS Module 2 — WCS health banner.
        this.controller.on('safety:wcsHealth', (payload) => {
            this.io.emit('safety:wcsHealth', payload);
            if (!payload.healthy) {
                logger.warn(`[ECSS] WCS health: ${payload.flagged.map(f => `${f.axis}=${f.value}`).join(', ')} (threshold ±${payload.threshold} mm).`);
            }
        });

        // ECSS Module 3 — Z runaway abort surfaced to UI + session log.
        this.controller.on('safety:zRunaway', (payload) => {
            this.io.emit('safety:zRunaway', payload);
            logger.error(`[ECSS] Z RUNAWAY fired: drop=${payload.drop} mm in ${payload.windowMs} ms, mposZ=${payload.mposZ}`);
            if (this.sessionLogger) {
                this.sessionLogger.logJob({ event: 'ecss-z-runaway', ...payload });
            }
        });

        // Initialization
        this.controller.on('initialized', (info) => {
            // Kept so _sendInitialState() can replay it to a screen that
            // restarted after bind (see there).
            this._controllerInitialized = info;
            this.io.emit('controller:initialized', info);
            if (this.sessionLogger) {
                this.sessionLogger.logConnection(true, `Initialized: ${info.firmwareType} ${info.firmwareVersion}`);
            }
        });

        // Workflow state changes
        this.controller.on('workflow:state', (state) => {
            this.io.emit('workflow:state', state);
            if (this.sessionLogger) this.sessionLogger.logState(state);
        });

        // Sender status
        this.controller.on('sender:status', (status) => {
            this.io.emit('sender:status', status);
        });

        // Sender paused — track for job isolation guard
        this.controller.on('sender:pause', () => {
            this._jobPaused = true;
            this.io.emit('sender:pause');
        });

        this.controller.on('sender:resume', () => {
            this._jobPaused = false;
            this.io.emit('sender:resume');
        });

        this.controller.on('sender:start', (data) => {
            // Cleared per job: a restart during THIS job is what makes the
            // origin untrustworthy afterwards.
            this._controllerRestartedThisJob = false;
            this.io.emit('sender:start', data);
            if (this.sessionLogger) this.sessionLogger.logJob({ event: 'started' });
        });

        this.controller.on('sender:end', (data) => {
            this._jobPaused = false;
            this.io.emit('sender:end', data);
            if (this.sessionLogger) this.sessionLogger.logJob({ event: 'completed', ...data });
            if (!data || !data.aborted) this._returnToOriginAfterJob(data);
        });

        this.controller.on('sender:error', (err) => {
            this._jobPaused = false;
            this.io.emit('sender:error', err);
            if (this.sessionLogger) this.sessionLogger.logJob({ event: 'error', ...err });
        });

        // Alarms and errors
        this.controller.on('alarm', (alarm) => {
            this.io.emit('controller:alarm', alarm);
            // Session .ndjson previously had no record of WHY a job stopped
            // (fault axis/code only reached app.log) -- keep it with the run.
            if (this.sessionLogger) this.sessionLogger.logJob({ event: 'alarm', ...alarm });
        });

        // Resume point (RSP): where a stopped/alarmed job can continue, and
        // the Start From Line dialog's preview of what a resume will do.
        this.controller.on('controller:restarted', (info) => {
            // The board lost its step counters, so work zero is no longer
            // where the operator set it -- do not drive to X0 Y0 after this.
            this._controllerRestartedThisJob = true;
            this.io.emit('controller:restarted', info);
            if (this.sessionLogger) this.sessionLogger.logJob({ event: 'controllerRestarted', ...info });
        });
        this.controller.on('controller:restartCleared', (info) => {
            this.io.emit('controller:restartCleared', info);
        });
        this.controller.on('job:resumePoint', (point) => {
            this.io.emit('job:resumePoint', point);
            if (this.sessionLogger && point && point.line) {
                this.sessionLogger.logJob({ event: 'resumePoint', line: point.line, reason: point.reason, positionExact: point.positionExact });
            }
        });
        this.controller.on('job:resumePreview', (preview) => {
            this.io.emit('job:resumePreview', preview);
        });
        // Durable power-cut checkpoint. JobResumeService has always had the
        // machinery, but onLoad()/onStart() had NO caller anywhere in the
        // product -- so nothing was ever written to disk and "resume after a
        // power cut" could never find a checkpoint. The in-memory resume point
        // in the controller only survives while the process does.
        this.controller.on('sender:start', (info) => {
            if (!this.jobResumeService) return;
            // A macro (RSP) is not the loaded file: it must not overwrite the
            // checkpoint a stopped job left behind with the file at line 0.
            if (info && info.macro) return;
            try {
                // No file loaded through here: a resume from the checkpoint
                // after a backend restart (JobResumeService.resumeFromCheckpoint
                // loads straight into the controller and has set the file
                // itself). Overwriting that saved the resumed job's checkpoint
                // with no G-code, so it could not be resumed again.
                if (this._loadedGcodeContent) {
                    this.jobResumeService.onLoad({
                        filename: (this.loadedFile && this.loadedFile.name) || 'untitled.nc',
                        gcodeText: this._loadedGcodeContent,
                        modalState: typeof this.controller.getModalState === 'function' ? this.controller.getModalState() : {},
                        ...(this._loadedFileOptions || {}),
                    });
                }
                this.jobResumeService.onStart({
                    totalLines: (info && info.total) || (this.loadedFile && this.loadedFile.total) || 0,
                    startLine: info && info.resumedFrom,
                });
            } catch (err) {
                logger.warn(`[Engine] could not start the resume checkpoint: ${err.message}`);
            }
        });

        // Program pause (M0/M1): the machine is holding until the operator
        // presses Resume -- the UI shows it as a banner with its message.
        this.controller.on('job:programPause', (p) => {
            this._programPause = p;
            this.io.emit('job:programPause', p);
            if (this.sessionLogger) this.sessionLogger.logJob({ event: 'programPause', ...p });
        });
        for (const ev of ['sender:resume', 'sender:end', 'sender:error']) {
            this.controller.on(ev, () => {
                if (!this._programPause) return;
                this._programPause = null;
                this.io.emit('job:programPause', null);
            });
        }
        // Once-a-minute summary of ignored driver-ALM blips (RSP fw 0.1.1+)
        this.controller.on('alm:noise', (summary) => {
            if (this.sessionLogger) this.sessionLogger.logJob({ event: 'almNoise', ...summary });
        });

        this.controller.on('error', (err) => {
            // A refusal the controller has already explained on the console.
            // Re-broadcasting it printed the same sentence twice, once as
            // "Error undefined: ...".
            if (err && err.silent) return;
            this.io.emit('controller:error', err);
        });

        // Settings
        this.controller.on('settings', (setting) => {
            this.io.emit('controller:settings', setting);
        });

        // Feedback messages
        this.controller.on('feedback', (fb) => {
            this.io.emit('controller:feedback', fb);
        });

        // Parameters (probe results, work coordinates)
        this.controller.on('parameters', (params) => {
            this.io.emit('controller:parameters', params);
        });

        // ─── Feeder events ───────────────────────────────────
        this.controller.on('feeder:status', (status) => {
            this.io.emit('feeder:status', status);
        });

        // ─── Tool changer events ─────────────────────────────
        this.controller.on('toolchange:start', (data) => {
            this.io.emit('toolchange:start', data);
        });
        this.controller.on('toolchange:complete', (data) => {
            this.io.emit('toolchange:complete', data);
        });
        this.controller.on('toolchange:cancel', () => {
            this.io.emit('toolchange:cancel');
        });
        this.controller.on('toolchange:request', (data) => {
            this.io.emit('toolchange:request', data);
        });
        this.controller.on('toolchange:error', (data) => {
            this.io.emit('toolchange:error', data);
        });

        // ─── Event trigger events ────────────────────────────
        this.controller.on('eventtrigger:fired', (data) => {
            this.io.emit('eventtrigger:fired', data);
        });

        // ─── Debug monitor events ────────────────────────────
        this.controller.on('serial:debug:log', (entry) => {
            this.io.emit('serial:debug:log', entry);
        });

        // ─── Health monitor events ───────────────────────────
        this.controller.on('health:stale', (data) => {
            this.io.emit('health:stale', data);
        });
        this.controller.on('health:reconnect:attempt', (data) => {
            this.io.emit('health:reconnect:attempt', data);
        });
        this.controller.on('health:reconnect:success', () => {
            this.io.emit('health:reconnect:success');
        });
        this.controller.on('health:reconnect:failed', (data) => {
            this.io.emit('health:reconnect:failed', data);
        });

        // ─── Homing events ──────────────────────────────────
        this.controller.on('homing:location', (data) => {
            this.io.emit('homing:location', data);
        });
        this.controller.on('homing:limits', (data) => {
            this.io.emit('homing:limits', data);
        });
        // Per-axis progress signal — tells the overlay which axis is running now.
        this.controller.on('homing:axis', (data) => {
            this.io.emit('homing:axis', data);
        });

        // ─── Motor status events ──────────────────────────────
        this.controller.on('motor:status', (data) => {
            this.io.emit('motor:status', data);
        });

        // Close
        this.controller.on('close', () => {
            // Handled by _onConnectionClose
        });

        // Load saved event triggers into the controller
        const savedTriggers = this.config.get('eventTriggers', {});
        if (Object.keys(savedTriggers).length > 0) {
            this.controller.command('trigger:loadAll', savedTriggers);
        }
    }

    // ─── Close Connection ────────────────────────────────────────────

    _handleClose(socket, portPath, callback) {
        if (typeof portPath === 'function') {
            callback = portPath;
            portPath = this.port;
        }

        this._closeConnection();

        if (typeof callback === 'function') callback(null);
    }

    _closeConnection() {
        if (this.controller) {
            // FIX-10: this path (explicit disconnect, or _handleOpen tearing
            // down a stale/different-port connection) used to unbind()
            // straight away, silently discarding an in-flight job with no
            // checkpoint and no frontend notice -- unlike the genuine
            // transport-drop path below in _onConnectionClose(), which
            // already does this. Mirror that here so a job survives an
            // open-a-different-port or manual-disconnect the same way it
            // survives a real USB drop.
            // Tell the MACHINE first. Closing the port under a running job
            // leaves the controller hearing nothing, and it stops itself on
            // its 5 s host watchdog -- an uncontrolled stop with the tool
            // still in the cut. An abort frame costs a millisecond and stops
            // it properly: drivers off, position kept, resume point saved.
            const jobRunning = !!(this.controller.job && this.controller.job.active);
            if (jobRunning) {
                logger.warn('[Engine] disconnecting while a job is running -- stopping the machine first');
                try {
                    this.controller.command('gcode:stop');
                } catch (err) {
                    logger.warn(`[Engine] stop-before-disconnect failed: ${err.message}`);
                }
            }
            let lostJob = null;
            if (typeof this.controller.notifyConnectionLost === 'function') {
                try {
                    lostJob = this.controller.notifyConnectionLost();
                } catch (err) {
                    logger.warn(`notifyConnectionLost failed: ${err.message}`);
                }
            }
            if (lostJob && lostJob.jobWasActive) {
                this.io.emit('connection:lost', {
                    port: this.port,
                    resumeLine: lostJob.resumeLine,
                });
            }
            const ctl = this.controller;
            this.controller = null;
            if (jobRunning) {
                // give the abort frame a moment on the wire before the port
                // is torn down under it
                const conn = this.connection;
                this.connection = null;
                setTimeout(() => {
                    try { ctl.unbind(); ctl.removeAllListeners(); } catch (_) { /* best effort */ }
                    try { if (conn) conn.close(); } catch (_) { /* best effort */ }
                }, 250);
            } else {
                ctl.unbind();
                ctl.removeAllListeners();
            }
        }

        if (this.connection) {
            this.connection.close();
            this.connection = null;
        }

        const closedPort = this.port;
        this.port = null;

        if (this.sessionLogger) {
            this.sessionLogger.logConnection(false, 'disconnect');
            this.sessionLogger.close();
            this.sessionLogger = null;
        }

        if (closedPort) {
            this.io.emit('serialport:close', { port: closedPort });
        }
    }

    _onConnectionClose() {
        const closedPort = this.port;

        if (this.controller) {
            // Tawfiq msg11378: an OS-level USB/COM drop mid-job silently
            // killed the job with no explanation beyond a generic
            // "Disconnected" — unlike an RSP-protocol link-loss (job.js's
            // LINK_GRACE_S), the transport itself is gone here, so there's
            // nothing to retry; the least we can do is checkpoint the
            // resume point NOW (before it's lost to unbind()) and tell the
            // frontend a job was actually interrupted, not just closed.
            let lostJob = null;
            if (typeof this.controller.notifyConnectionLost === 'function') {
                try {
                    lostJob = this.controller.notifyConnectionLost();
                } catch (err) {
                    logger.warn(`notifyConnectionLost failed: ${err.message}`);
                }
            }
            if (lostJob && lostJob.jobWasActive) {
                this.io.emit('connection:lost', {
                    port: closedPort,
                    resumeLine: lostJob.resumeLine,
                });
            }
            this._restartMonitor.onConnectionLost(lostJob && lostJob.jobWasActive
                ? { name: (this.loadedFile && this.loadedFile.name) || '', line: lostJob.resumeLine, at: Date.now() }
                : null);
            this.controller.unbind();
            this.controller.removeAllListeners();
            this.controller = null;
        }

        this.connection = null;
        this.port = null;

        if (this.sessionLogger) {
            this.sessionLogger.logConnection(false, 'disconnect');
            this.sessionLogger.close();
            this.sessionLogger = null;
        }

        if (closedPort) {
            logger.info(`Connection closed: ${closedPort}`);
            this.io.emit('serialport:close', { port: closedPort });
        }
    }

    // ─── Command Handling ────────────────────────────────────────────

    _handleCommand(socket, portPath, cmd, ...args) {
        if (!this.controller) {
            logger.warn(`[Engine] command '${cmd}' rejected: no active controller`);
            socket.emit('serialport:error', { error: 'No active controller' });
            return;
        }

        // ECSS Commit E — Remote diagnostic mirror toggle (intercept before
        // routing to controller, otherwise RTSController treats it as an
        // unknown command and logs a warning).
        if (cmd === 'safety:remoteDiagToggle') {
            const opts = args[0] || {};
            const enable = !!opts.enabled;
            const url = typeof opts.url === 'string' ? opts.url : null;
            // Opening or retargeting the mirror is operator-only: with
            // remoteDiagAllowInject it is a remote control channel that
            // bypasses RemoteCommandGate. Anyone at the machine may turn it off.
            if ((enable || url) && !isOperatorIdentity(socketIdentity(socket))) {
                logger.warn('[RemoteDiag] toggle refused: operator only');
                const diag = remoteDiagMirror.status();
                socket.emit('safety:remoteDiagStatus', hasLocalControl(socketIdentity(socket)) ? diag : publicDiagStatus(diag));
                socket.emit('remote:denied', { event: 'command', cmd, code: 'operator_required', message: 'Only the machine’s own screen can enable remote diagnostics' });
                return;
            }
            if (url) remoteDiagMirror.setUrl(url);
            if (enable) {
                remoteDiagMirror.start();
            } else {
                remoteDiagMirror.stop();
            }
            try {
                this.config.set('preferences.remoteDiagEnabled', enable);
                if (url) this.config.set('preferences.remoteDiagUrl', url);
            } catch (_) {}
            {
                const diag = remoteDiagMirror.status();
                this._emitScoped('safety:remoteDiagStatus', diag, publicDiagStatus(diag));
            }
            return;
        }
        if (cmd === 'safety:remoteDiagStatus') {
            const diag = remoteDiagMirror.status();
            socket.emit('safety:remoteDiagStatus', hasLocalControl(socketIdentity(socket)) ? diag : publicDiagStatus(diag));
            return;
        }

        if (cmd && (cmd.startsWith('gcode:') || cmd === 'feedhold' || cmd === 'cyclestart')) {
            logger.info(`[Engine] command: ${cmd}${args.length ? ' ' + JSON.stringify(args) : ''}`);
        }

        if (cmd === 'gcode:stop' || cmd === 'file:unload') {
            this._jobPaused = false;
            this._pendingUpload = null;
            this._startGeneration += 1; // a Start still waiting for a file load is cancelled
        }

        // A file load is prepared on a worker thread now, so it can still be
        // in progress when a Start arrives -- the Play button sends the file
        // and Start 250 ms apart, the Space shortcut back to back. Starting
        // then would run the PREVIOUSLY loaded program. Hold job starts until
        // every load in progress has been applied; a Stop meanwhile cancels.
        if (JOB_START_COMMANDS.has(cmd) && this._loadsInFlight.size > 0) {
            const gen = this._startGeneration;
            logger.info(`[Engine] command: ${cmd} waiting for the file load in progress`);
            const waitForLoads = async () => {
                while (this._loadsInFlight.size > 0) await Promise.all([...this._loadsInFlight]);
            };
            waitForLoads().then(() => {
                if (gen !== this._startGeneration) {
                    logger.info(`[Engine] command: ${cmd} cancelled (stop/unload while the file was loading)`);
                    return;
                }
                if (this._refuseStartAfterRefusedLoad(socket, cmd)) return;
                this._dispatchToController(socket, cmd, args);
            });
            return;
        }

        // A Start from a screen whose last file load was refused or failed
        // must not run (or resume) the program the machine still holds.
        if (JOB_START_COMMANDS.has(cmd) && this._refuseStartAfterRefusedLoad(socket, cmd)) return;

        // Save the durable checkpoint at the moments worth saving it.
        if (this.jobResumeService) {
            try {
                if (cmd === 'gcode:stop') this.jobResumeService.onStop();
                else if (cmd === 'gcode:pause' || cmd === 'feedhold') this.jobResumeService.onPause();
            } catch (err) {
                logger.warn(`[Engine] checkpoint save failed: ${err.message}`);
            }
        }

        this._dispatchToController(socket, cmd, args);
    }

    /**
     * Remember whether this socket's file:load was accepted. `outcome` is what
     * _handleFileLoad returned: { ok: true }, { ok: false, reason }, or
     * undefined (superseded by a newer load / controller changed: no verdict).
     */
    _noteLoadOutcome(socket, data, outcome) {
        if (!outcome) return outcome;
        if (outcome.ok === false) {
            const name = (data && data.name) || 'untitled.gcode';
            this._refusedLoads.set(socket, { name, reason: outcome.reason || 'the machine refused it' });
            logger.warn(`[Engine] file:load "${name}" was not accepted (${outcome.reason}); Start from this screen is blocked until a file loads`);
        } else if (outcome.ok === true) {
            this._refusedLoads.delete(socket);
        }
        return outcome;
    }

    /** True (and the operator told why) when `cmd` must not run because this socket's last load was refused. */
    _refuseStartAfterRefusedLoad(socket, cmd) {
        const refused = this._refusedLoads.get(socket);
        if (!refused) return false;
        const reason = String(refused.reason || '').replace(/\.\s*$/, '');
        const message = `The file you loaded was not accepted: ${reason}. Nothing was started.`;
        logger.warn(`[Engine] command: ${cmd} refused -- "${refused.name}" was not accepted (${refused.reason})`);
        socket.emit('serialport:error', { error: message }); // shown in that screen's console
        socket.emit('job:startRefused', { command: cmd, name: refused.name, reason: refused.reason, message });
        return true;
    }

    _dispatchToController(socket, cmd, args) {
        if (!this.controller) {
            socket.emit('serialport:error', { error: 'No active controller' });
            return;
        }
        try {
            this.controller.command(cmd, ...args);
        } catch (err) {
            logger.error(`[Engine] command '${cmd}' threw: ${err.message}`);
            socket.emit('serialport:error', { error: err.message });
        }
    }

    _handleWrite(socket, portPath, data, context) {
        if (!this.controller) return;
        this.controller.write(data, context);
    }

    _handleWriteln(socket, portPath, data, context) {
        if (!this.controller) return;
        this.controller.writeln(data, context);
    }

    /** machine.maxRate (mm/min per axis): the compiler's clamp for programs, and the RSP jog cap. */
    _machineMaxRate() {
        return this.config.get('machine.maxRate', { x: 5000, y: 5000, z: 3000 });
    }

    // ─── File Management ─────────────────────────────────────────────

    async _handleFileLoad(socket, data) {
        if (!this.controller) {
            logger.warn('[Engine] file:load rejected: no active controller');
            socket.emit('serialport:error', { error: 'No active controller' });
            return { ok: false, reason: 'the machine is not connected' };
        }

        const { name, content, gcode } = data || {};
        const gcodeContent = content || gcode;

        if (!gcodeContent) {
            logger.warn('[Engine] file:load rejected: missing content');
            socket.emit('serialport:error', { error: 'Missing G-code content' });
            return { ok: false, reason: 'the file was empty' };
        }

        const fileName = name || 'untitled.gcode';
        logger.info(`[Engine] file:load received: name="${fileName}" bytes=${gcodeContent.length}`);

        // ─── A running job is never replaced by a file load ──────────
        // The browser re-uploads the open file on every refresh/reconnect.
        // This used to send gcode:stop first, so refreshing the page (or a
        // second tab opening) stopped the carve mid-job. The same file is
        // simply re-announced; a different file is refused until the
        // operator stops the job.
        const rspJobActive = typeof this.controller.getResumePoint === 'function' && this.controller.job && this.controller.job.active;
        if (rspJobActive) {
            if (this.loadedFile && this._loadedGcodeContent === gcodeContent) {
                logger.info(`[Engine] file:load "${fileName}" is the file already running -- job left untouched`);
                socket.emit('file:load', this.loadedFile);
                if (typeof this.controller.getResumePoint === 'function') socket.emit('job:resumePoint', this.controller.getResumePoint());
                return { ok: true };
            }
            logger.warn(`[Engine] file:load "${fileName}" refused: a job is running`);
            socket.emit('file:loadError', {
                name: fileName,
                errorCount: 1,
                errors: [{ line: null, msg: 'A job is running. Stop it before loading another file.' }],
                busy: true,
            });
            return { ok: false, reason: `a job ("${(this.loadedFile && this.loadedFile.name) || 'the previous file'}") is still running, paused or waiting to resume -- press Stop before loading another file, or load that job's file again on this screen to continue it` };
        }
        if (this._jobPaused || (this.controller && this.controller.job && this.controller.job.active)) {
            logger.info(`[Engine] file:load replacing previous active/paused job with "${fileName}"`);
            try {
                this.controller.command('gcode:stop');
            } catch (_) {}
            this._jobPaused = false;
            this._pendingUpload = null;
        }

        // Load into controller's sender. spindleDelay is read here (not
        // inside the controller, which has no ConfigStore reference) and
        // passed through so RSPController can inject a spin-up dwell after
        // every M3/M4 -- see FIXFILE.html FIX-16.
        const spindleDelay = Number(this.config.get('preferences.spindleDelay', 0)) || 0;
        // Wire-compile options for RSP boards (lib/wireCompiler.js). Machine
        // limits live under `machine.*` in data/config.json; defaults are the
        // conservative values the plan specifies until CAL-1 measures them.
        const compileOptions = {
            rapidFeed: Number(this.config.get('machine.rapidFeed', 3000)) || 3000,
            maxRate: this._machineMaxRate(),
            zHeadroom: this.config.get('machine.zHeadroom', null),
            safeHeight: Number(this.config.get('preferences.safeHeight', 10)) || 10,
            // M0/M1 program pauses stop the job until Resume. Off by default:
            // the operator starts the spindle before pressing Start.
            honorProgramPauses: this.config.get('preferences.honorProgramPauses', false) === true,
            // Slow the short, zig-zag moves of fine 3D detail so the machine can
            // follow the firmware's per-line start/stop (lib/firmwareMotionLimit.js).
            // machine.motionLimit: { enabled, maxAccel: {x,y,z} mm/s^2, maxJump: {x,y,z} mm/s }
            motionLimit: { enabled: true, ...(this.config.get('machine.motionLimit', {}) || {}) },
        };
        // RSP compiles on a worker thread (lib/prepareProgram.js): compiling a
        // large 3D file on this thread stalled the event loop for ~3.7 s, long
        // enough for the RSP link to be declared lost (2026-09-16 19:32:42).
        const controller = this.controller;
        let loadResult;
        if (typeof controller.loadGcode === 'function') {
            loadResult = await controller.loadGcode(fileName, gcodeContent, spindleDelay, compileOptions);
            // A newer load, an unload or a disconnect happened meanwhile: that one counts.
            if (!loadResult || loadResult.superseded || this.controller !== controller) return undefined;
        } else {
            controller.command('gcode:load', fileName, gcodeContent, spindleDelay, compileOptions);
            loadResult = controller.lastLoadResult;
        }

        // A file the controller refused (cannot run correctly on this machine)
        // is never announced as loaded -- clients keep Start disabled and show why.
        if (loadResult && loadResult.ok === false) {
            this.loadedFile = null;
            this._loadedGcodeContent = null;
            this._loadedFileOptions = null;
            this.io.emit('file:loadError', {
                name: fileName,
                errorCount: loadResult.meta.errorCount,
                errors: (loadResult.meta.errors || []).slice(0, 20),
            });
            if (this.sessionLogger) {
                this.sessionLogger.logJob({ event: 'loadRejected', name: fileName, errorCount: loadResult.meta.errorCount, errors: (loadResult.meta.errors || []).slice(0, 5) });
            }
            const first = (loadResult.meta && loadResult.meta.errors && loadResult.meta.errors[0]) || null;
            return { ok: false, reason: (first && first.msg) || 'it cannot run on this machine' };
        }

        // Store file info for reconnecting clients
        const senderTotal = (this.controller && this.controller._loadedLines && this.controller._loadedLines.length)
            || (this.controller && this.controller.job && this.controller.job.totalLineCount)
            || this.controller.sender?.total
            || gcodeContent.split(/\r?\n/).length;
        this.loadedFile = {
            name: fileName,
            total: senderTotal,
            size: gcodeContent.length,
            isRotary: isRotaryFile(gcodeContent),
        };

        this.io.emit('file:load', this.loadedFile);

        this._loadedGcodeContent = gcodeContent;
        // Recorded with the durable checkpoint so a resume from it compiles the same lines.
        this._loadedFileOptions = { spindleDelay, compileOptions };

        if (this.sessionLogger) {
            this.sessionLogger.logJob({ event: 'loaded', name: fileName, total: senderTotal });
        }
        return { ok: true };
    }

    /**
     * Record a program another service loaded straight into the controller
     * (job resume), so loadedFile names what the controller really holds.
     */
    noteProgramLoaded(name, gcodeContent, options) {
        const content = typeof gcodeContent === 'string' ? gcodeContent : '';
        const total = (this.controller && this.controller.job && this.controller.job.totalLineCount)
            || this.controller?.sender?.total
            || content.split(/\r?\n/).length;
        this.loadedFile = {
            name: name || 'untitled.gcode',
            total,
            size: content.length,
            isRotary: isRotaryFile(content),
            // A checkpoint-resume program (preamble + remaining lines) under the
            // original name: never startable "from the beginning" remotely.
            // _handleFileLoad builds loadedFile without this flag.
            resume: true,
        };
        this._loadedGcodeContent = content;
        // loadedFile / _loadedGcodeContent / _loadedFileOptions are read as one
        // record (see the sender:start handler). Leaving the options out here
        // saved the next checkpoint with spindleDelay/compileOptions undefined,
        // so a second resume recompiled the file with wireCompiler DEFAULTS --
        // no motion limit, wrong maxRate/safeHeight, one fewer line per M3 --
        // and the resume line then landed in the wrong place.
        this._loadedFileOptions = (options && typeof options === 'object') ? options : null;
        this.io.emit('file:load', this.loadedFile);
    }

    _handleFileUnload(socket) {
        this._startGeneration += 1; // a Start still waiting for a file load is cancelled
        if (socket) this._refusedLoads.delete(socket); // that screen no longer shows the refused file
        if (this.controller) {
            this.controller.command('gcode:unload');
        }
        // The controller just dropped its resume point for this file; the
        // durable checkpoint goes with it (a Stop keeps the checkpoint now).
        if (this.jobResumeService && this._loadedGcodeContent) {
            try {
                this.jobResumeService.discardCheckpointFor(this._loadedGcodeContent);
            } catch (err) {
                logger.warn(`[Engine] could not clear the unloaded file's checkpoint: ${err.message}`);
            }
        }
        this._jobPaused = false;
        this._pendingUpload = null;
        this.loadedFile = null;
        this._loadedGcodeContent = null;
        this._loadedFileOptions = null;
        this.io.emit('file:unload');
    }

    // ─── Public API ──────────────────────────────────────────────────

    /**
     * Get current engine state for REST API.
     */
    getState() {
        const ctrl = this.controller;
        return {
            connected: this.connection != null && this.connection.isOpen,
            port: this.port,
            controllerType: this.connection?.controllerType || null,
            machineState: (typeof ctrl?.getMappedState === 'function') ? ctrl.getMappedState() : 'idle',
            activeState: (typeof ctrl?.getState === 'function') ? ctrl.getState() : 'Idle',
            position: (typeof ctrl?.getPosition === 'function') ? ctrl.getPosition() : { x: 0, y: 0, z: 0 },
            machinePosition: (typeof ctrl?.getMachinePosition === 'function') ? ctrl.getMachinePosition() : { x: 0, y: 0, z: 0 },
            workflowState: (typeof ctrl?.getWorkflowState === 'function') ? ctrl.getWorkflowState() : 'idle',
            senderStatus: (typeof ctrl?.getSenderStatus === 'function') ? ctrl.getSenderStatus() : null,
            feederStatus: (typeof ctrl?.getFeederStatus === 'function') ? ctrl.getFeederStatus() : null,
            overrides: (typeof ctrl?.getOverrides === 'function') ? ctrl.getOverrides() : { feed: 100, rapid: 100, spindle: 100 },
            toolChanger: (typeof ctrl?.getToolChangerStatus === 'function') ? ctrl.getToolChangerStatus() : null,
            health: (typeof ctrl?.getHealthMetrics === 'function') ? ctrl.getHealthMetrics() : null,
            loadedFile: this.loadedFile,
        };
    }

    /**
     * Get RSP link liveness snapshot for /api/link-health.
     */
    getLinkHealth() {
        const ctrl = this.controller;
        return (typeof ctrl?.getLinkHealth === 'function')
            ? ctrl.getLinkHealth()
            : { linkOk: false, lastRxAgoS: null, heartbeatS: null, heartbeatTimeoutS: null, inFlight: 0, recentEvents: [] };
    }

    /** Active on-demand link test for /api/link-test. See RSPController.pingNow(). */
    async pingNow() {
        const ctrl = this.controller;
        return (typeof ctrl?.pingNow === 'function')
            ? ctrl.pingNow()
            : { ok: false, rttMs: null, error: 'controller does not support active ping' };
    }

    /**
     * List available serial ports.
     */
    async listPorts() {
        return SerialConnection.listPorts();
    }
}

module.exports = { CNCEngine };
