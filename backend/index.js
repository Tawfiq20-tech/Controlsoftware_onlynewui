/**
 * CNC backend: Express + Socket.IO + CNCEngine.
 *
 * Uses the 6-layer architecture:
 *   Layer 1: SerialConnection (hardware I/O)
 *   Layer 2: Connection (firmware detection, lifecycle)
 *   Layer 3: GrblController / GrblHalController (command handling)
 *   Layer 4: Sender (G-code streaming)
 *   Layer 5: CNCEngine (Socket.IO server) <-- this file wires it up
 *   Layer 6: Frontend controller.ts (client)
 *
 * Port: 4000 (or process.env.PORT)
 *
 * createBackend() builds everything without listening, so
 * tests/remote_integration.test.js can check the real wiring (identity,
 * LAN allowlist, routes) against a fake engine. Requiring this file starts
 * the server unless CNC_BACKEND_NO_AUTOSTART=1.
 */
const http = require('http');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const logger = require('./logger');
const runtimePaths = require('./lib/runtimePaths');
const processGuards = require('./lib/processGuards');
const { CNCEngine } = require('./services/CNCEngine');
const { WebcamService } = require('./services/webcam/WebcamService');
const { GamepadService } = require('./services/gamepad/GamepadService');
const { WatchDirService } = require('./services/watchdir/WatchDirService');
const { ProbingService } = require('./services/probing/ProbingService');
const { JobHistoryService } = require('./services/jobhistory/JobHistoryService');
const { JobResumeService } = require('./services/jobresume/JobResumeService');
const { ToolLibrary } = require('./services/toollibrary/ToolLibrary');
const { WhatsAppService } = require('./services/whatsapp/WhatsAppService');
const { TelegramBotService } = require('./services/telegram/TelegramBotService');
const { LibraryService } = require('./services/library/LibraryService');
const { ChatbotService, MAX_MESSAGE_CHARS: CHAT_MAX_MESSAGE_CHARS } = require('./services/chatbot/ChatbotService');
const { ConfigStore } = require('./services/ConfigStore');
const {
    RemoteAccessService, parseCookies, SESSION_COOKIE, hasLocalControl, isOperatorIdentity, LOCAL_ROOM,
} = require('./services/remoteAccess/RemoteAccessService');
const configPolicy = require('./services/remoteAccess/configPolicy');
const { TailscaleService } = require('./services/remoteAccess/TailscaleService');
const { WifiService } = require('./services/network/WifiService');
const { DeviceIdentity } = require('./services/remoteAccess/DeviceIdentity');
const { MdnsResponder } = require('./services/remoteAccess/MdnsResponder');
const { OperatorToken } = require('./services/remoteAccess/OperatorToken');
const policy = require('./services/remoteAccess/policy');
const { CloudLinkService, RemoteCommandGate, createAtomicJsonStore } = require('./services/cloudLink');
const defaultRemoteDiagMirror = require('./services/RemoteDiagMirror');
const FirmwareFlashing = require('./lib/Firmware/Flashing/firmwareflashing');
const { FirmwareUpdateService } = require('./services/firmware/FirmwareUpdateService');
const errlog = require('./middleware/errlog');
const errclient = require('./middleware/errclient');
const errnotfound = require('./middleware/errnotfound');
const errserver = require('./middleware/errserver');

const AUDIT_READ_MAX = 500;
const AUDIT_TAIL_BYTES = 1024 * 1024;

const CLOUD_STORE_DEFAULTS = Object.freeze({
    version: 1, enabled: false, relayUrl: null, credential: null, nextCredential: null, pendingCredential: null,
    relayDeviceId: null, accountLabel: null, pairedAt: null, credCreatedAt: null,
    maxFileMb: 25, cloudLibraryCapMb: 500,
    tiers: { jobControl: { lan: false, cloud: false } },
});

/** The kiosk launch secret travels in ?op=; it must never reach app.log. */
function redactUrl(url) {
    return String(url || '').replace(/([?&]op=)[^&#]*/gi, '$1[redacted]');
}

/** Non-operators see only the relay host and no error text (spec 7.2). */
function redactCloudStatus(status) {
    if (!status) return status;
    let host = null;
    if (status.relayUrl) {
        try { host = new URL(status.relayUrl).hostname; } catch (_) { host = null; }
    }
    const { maxFileMb, cloudLibraryCapMb, ...rest } = status;
    return { ...rest, relayUrl: host, lastError: null };
}

function lanActivity(activeJog) {
    return activeJog ? { ...activeJog, userLabel: null, userId: null } : null;
}

/** The last `limit` entries of a JSON-lines file, newest first. */
function readAuditTail(file, limit) {
    let fd;
    try {
        fd = fs.openSync(file, 'r');
    } catch (err) {
        if (err.code === 'ENOENT') return [];
        throw err;
    }
    try {
        const size = fs.fstatSync(fd).size;
        const length = Math.min(size, AUDIT_TAIL_BYTES);
        const buf = Buffer.alloc(length);
        fs.readSync(fd, buf, 0, length, size - length);
        const lines = buf.toString('utf8').split('\n');
        // A tail read starting mid-file begins with a partial line.
        if (length < size) lines.shift();
        const out = [];
        for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
            const line = lines[i].trim();
            if (!line) continue;
            try { out.push(JSON.parse(line)); } catch (_) { /* torn or foreign line */ }
        }
        return out;
    } finally {
        fs.closeSync(fd);
    }
}

function loadDeviceIdentity(file) {
    const identity = new DeviceIdentity({ file, logger });
    // Local machine control must never depend on this file: an unreadable
    // identity leaves the backend running with remote features fail-closed
    // (LAN-only, no mDNS, no cloud) and createBackend retries in the background.
    const markUnreadable = (err) => {
        logger.error(`[DeviceIdentity] ${file} exists but cannot be read (${err.code || 'I/O error'}). `
            + 'Remote access features (cloud, mDNS, access code, internet services) stay off until it can be read; '
            + 'local machine control is unaffected. Close whatever is locking it (OneDrive sync, antivirus). The file was not changed.');
        identity.markUnavailable(err);
    };
    try {
        identity.load();
    } catch (err) {
        if (err.message === 'device_identity_unreadable') {
            markUnreadable(err);
            return identity;
        }
        if (err.message !== 'device_identity_corrupt') throw err;
        // load() renamed both corrupt files aside, so this creates a fresh identity.
        logger.error('[DeviceIdentity] identity file and backup were corrupt; creating a new device identity');
        try {
            identity.load();
        } catch (retryErr) {
            if (retryErr.message !== 'device_identity_unreadable') throw retryErr;
            markUnreadable(retryErr);
        }
    }
    return identity;
}

function createBackend({
    port = Number(process.env.PORT) || 4000,
    dataDir = runtimePaths.dataDir(),
    isTest = process.env.NODE_ENV === 'test',
    createEngine = (io) => new CNCEngine(io),
    createCloudLink = (deps) => new CloudLinkService(deps),
    createMdns = (deps) => new MdnsResponder(deps),
    remoteDiagMirror = defaultRemoteDiagMirror,
    initServices = true,
    identityRetryMs = 30000,
} = {}) {
    const app = express();
    // Every filter below keys on req.path.startsWith('/api/'); with Express's
    // default case-insensitive routing "/API/config" would reach the route
    // while skipping the PIN gate and the LAN allowlist.
    app.set('case sensitive routing', true);

    // Remote access (LAN + Tailscale) — own ConfigStore file so it doesn't depend
    // on CNCEngine's init order. See RemoteAccessService.js for the trust model.
    const tailscaleService = new TailscaleService({ port, logger });
    const wifiService = new WifiService({ logger });

    const deviceIdentity = loadDeviceIdentity(path.join(dataDir, 'device-identity.json'));
    // Before CNCEngine: its constructor starts the mirror when preferences say so.
    remoteDiagMirror.setOutboundAllowed(!deviceIdentity.isLanOnly());

    const operatorToken = new OperatorToken({ file: path.join(dataDir, 'operator-token'), logger });
    operatorToken.load();

    const remoteAccessConfigStore = new ConfigStore(path.join(dataDir, 'remote-access.json'));
    const remoteAccessService = new RemoteAccessService({
        configStore: remoteAccessConfigStore,
        port,
        getTrustedHostnames: () => [...tailscaleService.getCachedHostnames(), deviceIdentity.mdnsHostname()].filter(Boolean),
        operatorToken,
    });
    // A PIN set or cleared while device-identity.json was unreadable could not
    // turn the access code off in that file. This marker (in remote-access.json)
    // remembers it, so recovery or the next boot never reinstates the old code.
    const ACCESS_CODE_OFF_PENDING = 'remoteAccess.accessCodeOffPending';

    function turnAccessCodeOff() {
        try {
            deviceIdentity.setAccessCodeActive(false, { force: true });
            remoteAccessConfigStore.delete(ACCESS_CODE_OFF_PENDING);
        } catch (err) {
            remoteAccessConfigStore.set(ACCESS_CODE_OFF_PENDING, true);
            logger.error(`[remote] access code state not saved (will apply when the identity file is readable): ${err.code || err.message}`);
        }
    }

    function syncIdentityPin() {
        if (remoteAccessConfigStore.get(ACCESS_CODE_OFF_PENDING, false) === true) {
            if (!deviceIdentity.isAvailable()) return false;
            try {
                deviceIdentity.setAccessCodeActive(false, { force: true });
                remoteAccessConfigStore.delete(ACCESS_CODE_OFF_PENDING);
            } catch (err) {
                // Still pending: never fall through to syncPin, which would
                // put the old access code back as the PIN.
                logger.error(`[remote] pending access-code-off not saved: ${err.code || err.message}`);
                return false;
            }
        }
        return deviceIdentity.syncPin(remoteAccessService);
    }

    syncIdentityPin();
    // Warm the Tailscale cache so this PC's MagicDNS name is trusted right away.
    tailscaleService.getStatus().catch(() => {});

    // Create HTTP + Socket.IO server
    const server = http.createServer(app);
    const io = new Server(server, {
        // allowRequest enforces Host/Origin for polling AND WebSocket handshakes
        // (browsers don't apply CORS to WebSockets, so cors alone isn't enough).
        cors: { origin: true, credentials: true },
        allowRequest: remoteAccessService.socketAllowRequest(),
        path: '/socket.io',
        serveClient: true,
        pingTimeout: 60000,
        pingInterval: 25000,
        transports: ['websocket', 'polling'],
        // G-code files are sent whole over file:load. The 1 MB default silently
        // dropped the connection for fish_wall (10 MB) and Halloween 3D Finishing
        // (13 MB), so the largest reference designs could never be loaded (plan BE-10).
        maxHttpBufferSize: 64 * 1024 * 1024,
    });
    io.use(remoteAccessService.socketGate());

    // Create CNCEngine (Layer 5)
    const engine = createEngine(io);

    // ─── Phase A/B services (AxioCNC + gSender parity) ───────────────
    const getController = () => engine.controller || null;

    const webcamService     = new WebcamService({     configStore: engine.config, io, logger });
    const gamepadService    = new GamepadService({    configStore: engine.config, io, logger, getController });
    const watchdirService   = new WatchDirService({   configStore: engine.config, io, logger, forbiddenRoots: [dataDir] });
    const probingService    = new ProbingService({    configStore: engine.config, io, logger, getController });
    const jobHistoryService = new JobHistoryService({ dataDir,                    io, logger, getController, getEngine: () => engine });
    const jobResumeService  = new JobResumeService({  dataDir, io, logger, getController,
                                                      getConfig: () => engine.config,
                                                      onProgramLoaded: ({ name, content }) => engine.noteProgramLoaded(name, content) });
    const toolLibrary       = new ToolLibrary({       configStore: engine.config, io, logger });
    const libraryService    = new LibraryService({    dataDir, io, logger });
    const chatbotService    = new ChatbotService();
    // Notification services push bot config, recipients, chat IDs and the
    // WhatsApp pairing QR (a credential): only sockets with local control
    // may receive them, never LAN sockets.
    const localIo = { emit: (...args) => io.to(LOCAL_ROOM).emit(...args) };
    const whatsappService   = new WhatsAppService({   configStore: engine.config, io: localIo, logger,
                                                      getController, getEngine: () => engine, dataDir,
                                                      libraryService, webcamService });
    const telegramService   = new TelegramBotService({ configStore: engine.config, io: localIo, logger,
                                                       getController, getEngine: () => engine, dataDir,
                                                       libraryService, webcamService });

    // Wire JobResumeService to the CNCEngine so it can be used by the
    // job:conflict/job:resume socket handlers.
    engine.jobResumeService = jobResumeService;

    const firmwareUpdateService = new FirmwareUpdateService({ io, logger });
    engine.firmwareUpdateService = firmwareUpdateService;
    // Every online firmware path (update check, OTA download, and the
    // official-release fetch inside CNCEngine's flash handler) goes through
    // fetchRemoteFile, so LAN-only is enforced here as well as on the routes.
    const fetchRemoteFile = firmwareUpdateService.fetchRemoteFile.bind(firmwareUpdateService);
    firmwareUpdateService.fetchRemoteFile = (...args) => (deviceIdentity.isLanOnly()
        ? Promise.reject(new Error('lan_only'))
        : fetchRemoteFile(...args));

    // ─── Remote command gate, cloud link, mDNS ───────────────────────
    const cloudStore = createAtomicJsonStore(path.join(dataDir, 'cloud-link.json'), { defaults: CLOUD_STORE_DEFAULTS, logger });

    function broadcastPermissions() {
        io.to('operator').emit('remote:permissions', gate.getState('operator'));
        io.except('operator').emit('remote:permissions', gate.getState('lan'));
    }

    /**
     * Host-sequenced local work queued in the controller's Feeder (Grbl
     * macros, probe:z/xyz, console lines). Feeder lines go straight to the
     * connection, so the gate never sees them; while any are queued or
     * un-acked the machine may be dwelling (Idle) between local moves.
     */
    function controllerFeederBusy() {
        const ctl = engine.controller;
        if (!ctl || typeof ctl.getFeederStatus !== 'function') return false;
        const st = ctl.getFeederStatus() || {};
        const queued = Number(st.size != null ? st.size : st.queue) || 0;
        const pending = st.pending === true || (typeof st.pending === 'number' && st.pending > 0);
        return queued > 0 || pending;
    }

    const gate = new RemoteCommandGate({
        store: cloudStore,
        logger,
        getEngine: () => engine,
        libraryService,
        auditFile: path.join(dataDir, 'remote-audit.jsonl'),
        isLanOnly: () => deviceIdentity.isLanOnly(),
        // A local probing routine or a macro/probe sequence still in the
        // controller Feeder holds the local-activity lock for its whole
        // duration, including Idle gaps (G4 dwell) between its moves. A
        // throwing status read counts as busy (gate fails closed).
        isLocalBusy: () => !!(probingService && probingService.activeRun) || controllerFeederBusy(),
        onChange: () => broadcastPermissions(),
        onAudit: (entry) => io.to('operator').emit('remote:audit', entry),
        onJogActivity: (activeJog) => {
            io.to('operator').emit('remote:activity', activeJog);
            io.except('operator').emit('remote:activity', lanActivity(activeJog));
        },
        onMotionExpired: (e) => io.emit('remote:motion:expired', e),
    });
    gate.attachEngine(engine);

    function emitCloudStatus(status) {
        io.to('operator').emit('remote:cloud:status', status);
        io.except('operator').emit('remote:cloud:status', redactCloudStatus(status));
    }

    const cloudLink = createCloudLink({
        dataDir,
        store: cloudStore,
        logger,
        gate,
        getEngine: () => engine,
        libraryService,
        webcamService,
        isLanOnly: () => deviceIdentity.isLanOnly(),
        getHardwareId: () => deviceIdentity.getDeviceId(),
        getDeviceName: () => deviceIdentity.getName(),
        appVersion: require('./package.json').version,
        onStatus: (status) => emitCloudStatus(status),
        onPairing: (pairing) => io.to('operator').emit('remote:cloud:pairing', pairing),
        onCameraDemand: (demand) => io.to('operator').emit('remote:camera:demand', demand),
    });

    const mdns = createMdns({
        hostname: deviceIdentity.mdnsHostname(),
        getAddresses: () => remoteAccessService.getAddresses().lan,
        logger,
    });

    function deviceView(operator) {
        const view = { ...deviceIdentity.getPublicView(), mdns: mdns.getStatus() };
        if (operator) {
            view.accessCode = deviceIdentity.getAccessCode();
            view.accessCodeActive = deviceIdentity.isAccessCodeActive();
            view.pinSource = remoteAccessService.getPinSource();
        }
        return view;
    }

    function emitDevice() {
        io.to('operator').emit('remote:device', deviceView(true));
    }
    deviceIdentity.on('change', emitDevice);

    /** LAN-only (spec 7.3): every service that can reach the internet. */
    function applyOutbound(allowed) {
        remoteDiagMirror.setOutboundAllowed(allowed);
        if (allowed && engine.config && engine.config.get('preferences.remoteDiagEnabled', false)) {
            remoteDiagMirror.start();
        }
        for (const [name, svc] of [['telegram', telegramService], ['whatsapp', whatsappService], ['chatbot', chatbotService]]) {
            try {
                svc.setOutboundAllowed(allowed);
            } catch (err) {
                logger.warn(`[lan-only] ${name}.setOutboundAllowed failed: ${err && err.message}`);
            }
        }
    }

    function setLanOnly(enabled) {
        const on = enabled === true;
        try {
            deviceIdentity.setLanOnly(on);
        } catch (err) {
            // setLanOnly updates memory before writing, so the switch still
            // takes effect for this run; only persistence failed.
            logger.error(`[lan-only] could not persist the LAN-only switch: ${err && (err.code || err.message)}`);
        }
        // Apply the effective state, not the request: an unavailable identity
        // refuses the change and stays LAN-only.
        if (deviceIdentity.isLanOnly()) {
            cloudLink.applyLanOnly(true);
            applyOutbound(false);
        } else {
            applyOutbound(true);
            cloudLink.applyLanOnly(false);
        }
        emitCloudStatus(cloudLink.getStatus());
        emitDevice();
        return { lanOnly: deviceIdentity.isLanOnly() };
    }

    // Blocked before the services start, so a LAN-only machine never opens
    // a Telegram poll or a WhatsApp browser even for a moment.
    if (deviceIdentity.isLanOnly()) applyOutbound(false);

    // ─── Unreadable identity file: background recovery ───────────────
    // Boot never waits on device-identity.json. While it is unreadable the
    // identity is fail-closed (see DeviceIdentity.markUnavailable); once a
    // retry reads it, the saved LAN-only choice, PIN and mDNS name apply.
    let cloudLinkStarted = false;
    let mdnsWanted = false;
    let identityRetryTimer = null;
    function onIdentityAvailable() {
        if (identityRetryTimer) {
            clearInterval(identityRetryTimer);
            identityRetryTimer = null;
        }
        try {
            syncIdentityPin();
        } catch (err) {
            logger.error(`[DeviceIdentity] PIN sync after recovery failed: ${err && err.message}`);
        }
        if (!deviceIdentity.isLanOnly()) {
            applyOutbound(true);
            if (cloudLinkStarted) cloudLink.applyLanOnly(false);
        }
        const hostname = deviceIdentity.mdnsHostname();
        if (hostname && typeof mdns.setHostname === 'function') mdns.setHostname(hostname);
        if (mdnsWanted) mdns.start();
        emitCloudStatus(cloudLink.getStatus());
        emitDevice();
    }
    deviceIdentity.on('available', onIdentityAvailable);
    if (!deviceIdentity.isAvailable() && identityRetryMs > 0) {
        identityRetryTimer = setInterval(() => {
            try {
                deviceIdentity.retryLoad();
            } catch (err) {
                logger.warn(`[DeviceIdentity] background retry failed: ${err && err.message}`);
            }
        }, identityRetryMs);
        if (typeof identityRetryTimer.unref === 'function') identityRetryTimer.unref();
    }

    /** Answers 503 for identity mutations while the file is unreadable. */
    function refuseWhenIdentityUnavailable(res) {
        if (deviceIdentity.isAvailable()) return false;
        res.status(503).json({ error: 'device_identity_unavailable', code: deviceIdentity.getUnavailableCode() });
        return true;
    }

    if (initServices) {
        webcamService.init();
        gamepadService.init();
        watchdirService.init();
        whatsappService.init();
        telegramService.init();
    }

    // ─── HTTP middleware ─────────────────────────────────────────────
    // Order matters: CORS answers preflights, the guard refuses foreign
    // Host/Origin (drive-by pages, DNS rebinding), then the PIN gate, then the
    // LAN allowlist for identities without local control (spec 7.4).
    app.use(cors(remoteAccessService.corsOptionsDelegate()));
    app.use(remoteAccessService.requestGuard());
    app.use(express.json());
    app.use(remoteAccessService.httpGate());
    app.use(policy.createLanHttpFilter({ gate, libraryService }));

    // Request logging
    app.use((req, res, next) => {
        const start = Date.now();
        res.on('finish', () => {
            logger.info('request', {
                method: req.method,
                url: redactUrl(req.originalUrl || req.url),
                statusCode: res.statusCode,
                responseTime: Date.now() - start,
            });
        });
        next();
    });

    // ─── Socket middleware ───────────────────────────────────────────
    // socket.use runs before any event handler, including the ones CNCEngine
    // registers, so every packet passes one of these two filters.
    io.use((socket, next) => {
        const identity = socket.data && socket.data.identity;
        // A middleware error must never become an unhandled 'error' event.
        socket.on('error', (err) => logger.debug('[socket] error', err && err.message));
        if (hasLocalControl(identity)) socket.use(policy.createOperatorActivityTap({ gate, logger }));
        else {
            socket.use(policy.createLanPacketFilter({
                gate, socket, logger,
                isIdentityCurrent: (id) => remoteAccessService.isLanIdentityCurrent(id),
            }));
        }
        socket.on('disconnect', () => gate.onLanSocketGone(socket.id));
        next();
    });

    // Re-send full state on every new socket connect.
    io.on('connection', (socket) => {
        const operator = isOperatorIdentity(socket.data && socket.data.identity);
        const local = hasLocalControl(socket.data && socket.data.identity);
        socket.emit('webcam:cameras', local ? webcamService.list() : webcamService.publicList());
        socket.emit('gamepad:bindings', gamepadService.getBindings());
        socket.emit('watchdir:list', watchdirService.list());
        socket.emit('jobhistory:list', jobHistoryService.list({ limit: 50 }));
        socket.emit('tools:list', toolLibrary.list());
        socket.emit('probing:strategies', probingService.listStrategies());
        socket.emit('library:list', libraryService.list());
        if (local) {
            const ws = whatsappService.getStatus();
            socket.emit('whatsapp:status', { state: ws.state });
            socket.emit('whatsapp:config', ws.config);
            socket.emit('whatsapp:recipients', ws.config.recipients || []);
            if (ws.state === 'qr' && ws.qrDataUrl) socket.emit('whatsapp:qr', { dataUrl: ws.qrDataUrl });
        }
        if (local) {
            const ts = telegramService.getStatus();
            socket.emit('telegram:status', { state: ts.state, info: ts.info });
            socket.emit('telegram:config', ts.config);
        }
        {
            const status = cloudLink.getStatus();
            socket.emit('remote:cloud:status', operator ? status : redactCloudStatus(status));
            socket.emit('remote:permissions', gate.getState(operator ? 'operator' : 'lan'));
            if (operator) {
                socket.emit('remote:device', deviceView(true));
                socket.emit('remote:cloud:pairing', cloudLink.getPairing());
            }
        }
        socket.on('gamepad:axes',   (vals) => gamepadService.onAxes(vals));
        socket.on('gamepad:button', ({ index, pressed }) => gamepadService.onButton(index, pressed));
    });

    // Operator HTTP routes that command the machine feed the gate like the
    // socket tap does; LAN requests were already recorded by gate.checkLan.
    function noteLocalCommand(req, route) {
        if (!hasLocalControl(req.remoteIdentity)) return;
        try {
            gate.onLocalCommand(`http:${route}`, req.body || {});
        } catch (err) {
            logger.warn(`[remote] operator activity (${route}) failed: ${err && err.message}`);
        }
    }

    // Operator-only actions: the kiosk on this PC (loopback + operator cookie).
    // A second browser on the PC is 'local': full machine control, but none of
    // these (spec Decision D1). requestGuard() has already refused
    // foreign-origin browser requests before this point.
    function requireOperator(req, res) {
        if (isOperatorIdentity(req.remoteIdentity)) return true;
        res.status(403).json({ error: 'operator_required', message: 'This can only be changed on the machine’s own screen' });
        return false;
    }

    // ─── REST API ────────────────────────────────────────────────────

    // Frontend logging endpoint
    app.post('/api/log', (req, res) => {
        const { level = 'info', message, meta } = req.body || {};
        logger.log(level, message || 'frontend log', meta ? { frontend: meta } : {});
        res.status(204).end();
    });

    app.get('/api/ports', async (req, res) => {
        try {
            const ports = await engine.listPorts();
            res.json(ports);
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: err.message });
        }
    });

    app.get('/api/state', (req, res) => {
        res.json(engine.getState());
    });

    app.get('/api/link-health', (req, res) => {
        res.json(engine.getLinkHealth());
    });

    app.post('/api/link-test', async (req, res) => {
        try {
            res.json(await engine.pingNow());
        } catch (err) {
            logger.error(err);
            res.status(500).json({ ok: false, rttMs: null, error: err.message });
        }
    });

    app.post('/api/connect', (req, res) => {
        const path = req.body.path || req.body.port;
        const baudRate = req.body.baudRate || 115200;
        const network = req.body.network || false;
        const networkPort = req.body.networkPort || undefined;
        if (!path) {
            return res.status(400).json({ error: 'Missing path, port, or IP address' });
        }
        noteLocalCommand(req, '/api/connect');

        // Use a temporary socket-like object for the REST callback
        const fakeSocket = {
            id: `rest-${Date.now()}`,
            emit: () => {},
        };

        engine._handleOpen(fakeSocket, path, { baudRate, network, networkPort }, (err) => {
            if (err) {
                logger.error(err);
                return res.status(500).json({ error: err.message });
            }
            res.json({
                ok: true,
                port: engine.port,
                controllerType: engine.connection?.controllerType || null,
            });
        });
    });

    app.post('/api/disconnect', (req, res) => {
        noteLocalCommand(req, '/api/disconnect');
        try {
            engine._closeConnection();
            res.json({ ok: true });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: err.message });
        }
    });

    app.post('/api/command', (req, res) => {
        const cmd = req.body.command || req.body.cmd;
        const args = req.body.args == null ? [] : req.body.args;
        if (!cmd) return res.status(400).json({ error: 'Missing command' });
        // Every identity: controllers dispatch through this._commands[cmd], and
        // a non-string key (["gcode"]) coerces to a real command name.
        if (typeof cmd !== 'string') return res.status(400).json({ error: 'BAD_ARGS', message: 'command must be a string' });
        if (!Array.isArray(args)) return res.status(400).json({ error: 'BAD_ARGS', message: 'args must be an array' });
        if (!engine.controller) return res.status(400).json({ error: 'Not connected' });
        noteLocalCommand(req, '/api/command');
        try {
            engine.controller.command(cmd, ...args);
            res.json({ ok: true });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: err.message });
        }
    });

    // ─── Chatbot ──────────────────────────────────────────────────────
    // Answers only — never touches the machine. If a suggestedAction comes
    // back, the frontend is responsible for confirming with the user and
    // executing it through the exact same local functions the regular UI
    // buttons already call.
    app.post('/api/chat', async (req, res) => {
        const message = req.body.message;
        const history = req.body.history || [];
        const machineContext = req.body.machineContext || null;
        if (!message || typeof message !== 'string') {
            return res.status(400).json({ error: 'Missing message' });
        }
        if (message.length > CHAT_MAX_MESSAGE_CHARS) {
            return res.status(400).json({ error: `Message too long — keep it under ${CHAT_MAX_MESSAGE_CHARS} characters.` });
        }
        try {
            const result = await chatbotService.answer(message, history, machineContext);
            res.json(result);
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Chatbot request failed, try again.' });
        }
    });

    // ─── Remote access (LAN + Tailscale) ─────────────────────────────
    // See services/remoteAccess/RemoteAccessService.js (trust model, PIN gate)
    // and TailscaleService.js ("control from anywhere" status).

    // Open route: an unauthenticated remote client only learns whether a PIN is
    // required. Everything else (addresses, sessions) needs authorization.
    app.get('/api/remote/info', (req, res) => {
        const identity = req.remoteIdentity;
        const operator = isOperatorIdentity(identity);
        const token = remoteAccessService.tokenFromRequest(req);
        const hasSession = !!(identity && identity.kind === 'lan' && identity.sessionId);
        const authorized = !!identity;
        // Header-only session (e.g. cookie expired or cleared): re-issue the
        // cookie so camera streams and plain fetches keep working.
        if (hasSession && token && !parseCookies(req.headers.cookie)[SESSION_COOKIE]) {
            res.setHeader('Set-Cookie', remoteAccessService.sessionCookie(token));
        }
        const info = remoteAccessService.getInfo({ authorized, operator });
        if (authorized) {
            info.accessCodeActive = deviceIdentity.isAccessCodeActive();
            // `identity` is the field the kiosk reads (RemoteInfo.identity);
            // identityKind is kept for existing clients.
            info.identity = identity.kind;
            info.identityKind = identity.kind;
            if (!deviceIdentity.isAvailable()) info.deviceIdentityUnavailable = true;
        }
        res.json(info);
    });

    app.get('/api/remote/tailscale', async (req, res) => {
        res.json(await tailscaleService.getStatus({ force: req.query.refresh === '1' }));
    });

    // QR image of a connection URL for the Settings panel.
    app.get('/api/remote/qr', async (req, res) => {
        let url = typeof req.query.url === 'string' ? req.query.url : '';
        if (!url) url = remoteAccessService.getInfo().unifiedUrl;
        if (url.length > 512 || !/^https?:\/\//i.test(url)) {
            return res.status(400).json({ error: 'url must be an http(s) URL' });
        }
        try {
            const dataUrl = await remoteAccessService.getQrDataUrl(url);
            res.json({ url, dataUrl });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'QR generation failed' });
        }
    });

    app.post('/api/remote/pin', (req, res) => {
        if (!requireOperator(req, res)) return;
        try {
            remoteAccessService.setPin(req.body && req.body.pin, { source: 'custom' });
        } catch (err) {
            return res.status(400).json({ error: err.message });
        }
        turnAccessCodeOff();
        res.json({ ok: true });
    });

    app.delete('/api/remote/pin', (req, res) => {
        if (!requireOperator(req, res)) return;
        remoteAccessService.clearPin();
        turnAccessCodeOff();
        res.json({ ok: true });
    });

    // Remote clients exchange the PIN for a session (rate-limited). The token is
    // returned for header/Socket.IO use and also set as an HttpOnly cookie so
    // <img> camera streams and every same-origin request are authorized too.
    app.post('/api/remote/verify-pin', (req, res) => {
        const clientIp = req.socket && req.socket.remoteAddress;
        const result = remoteAccessService.verifyPinWithRateLimit(req.body && req.body.pin, clientIp, {
            userAgent: req.headers['user-agent'],
        });
        if (!result.ok) {
            return res.status(result.locked ? 429 : 401).json({
                error: result.error,
                remainingAttempts: result.remainingAttempts,
                locked: !!result.locked,
            });
        }
        res.setHeader('Set-Cookie', remoteAccessService.sessionCookie(result.token));
        res.json({ token: result.token });
    });

    app.post('/api/remote/logout', (req, res) => {
        remoteAccessService.revokeToken(remoteAccessService.tokenFromRequest(req));
        res.setHeader('Set-Cookie', remoteAccessService.clearedSessionCookie());
        res.json({ ok: true });
    });

    app.get('/api/remote/sessions', (req, res) => {
        if (!requireOperator(req, res)) return;
        res.json(remoteAccessService.getActiveSessions());
    });

    app.delete('/api/remote/sessions/:id', (req, res) => {
        if (!requireOperator(req, res)) return;
        const removed = remoteAccessService.revokeSession(req.params.id);
        if (!removed) return res.status(404).json({ error: 'Session not found' });
        res.json({ ok: true });
    });

    app.post('/api/remote/sessions/revoke', (req, res) => {
        if (!requireOperator(req, res)) return;
        res.json(remoteAccessService.revokeAllSessions());
    });

    // Windows: opens the UAC prompt for scripts/enable-local-access.bat.
    app.post('/api/remote/firewall/fix', async (req, res) => {
        if (!requireOperator(req, res)) return;
        const result = await tailscaleService.fixFirewall();
        res.status(result.ok ? 200 : 400).json(result);
    });

    // ─── Wi-Fi (kiosk network setup) ─────────────────────────────────
    //
    // Operator-only, all of it. Re-pointing the machine's Wi-Fi from a phone
    // would drop the very link the request arrived on, and the network list
    // says where the machine is. This is a decision for whoever is standing
    // at the screen.

    app.get('/api/wifi/status', async (req, res) => {
        if (!requireOperator(req, res)) return;
        res.json(await wifiService.getStatus());
    });

    app.post('/api/wifi/scan', async (req, res) => {
        if (!requireOperator(req, res)) return;
        const result = await wifiService.scan({ rescan: req.body?.rescan !== false });
        res.status(result.ok ? 200 : 400).json(result);
    });

    app.post('/api/wifi/connect', async (req, res) => {
        if (!requireOperator(req, res)) return;
        const { ssid, password, hidden } = req.body || {};
        const result = await wifiService.connect({ ssid, password, hidden: !!hidden });
        res.status(result.ok ? 200 : 400).json(result);
    });

    app.post('/api/wifi/disconnect', async (req, res) => {
        if (!requireOperator(req, res)) return;
        const result = await wifiService.disconnect();
        res.status(result.ok ? 200 : 400).json(result);
    });

    app.post('/api/wifi/forget', async (req, res) => {
        if (!requireOperator(req, res)) return;
        const result = await wifiService.forget(req.body?.ssid);
        res.status(result.ok ? 200 : 400).json(result);
    });

    app.post('/api/wifi/radio', async (req, res) => {
        if (!requireOperator(req, res)) return;
        const result = await wifiService.setRadio(!!req.body?.on);
        res.status(result.ok ? 200 : 400).json(result);
    });

    // ─── Kiosk operator token (spec 6.5) ─────────────────────────────

    // The launcher exchanges the secret from backend/data/operator-token for
    // the HttpOnly operator cookie. Failures share the global PIN cooldown.
    app.post('/api/remote/operator/claim', (req, res) => {
        const secret = req.body && typeof req.body.secret === 'string' ? req.body.secret : '';
        // A claim can only ever succeed from this PC, so anything else is
        // refused before any rate-limit accounting: remote clients must not
        // be able to put the kiosk's claim into cooldown.
        if (!remoteAccessService.isLoopback(req)) {
            return res.status(403).json({ error: 'operator_claim_refused' });
        }
        if (remoteAccessService.isOperatorClaimBlocked()) {
            return res.status(403).json({ error: 'operator_claim_refused' });
        }
        if (!operatorToken.verifyLaunchSecret(secret)) {
            remoteAccessService.noteFailedOperatorClaim();
            return res.status(403).json({ error: 'operator_claim_refused' });
        }
        try {
            res.setHeader('Set-Cookie', operatorToken.cookieHeader());
        } catch (err) {
            return res.status(500).json({ error: 'operator_token_unreadable' });
        }
        res.json({ operator: true });
    });

    app.post('/api/remote/operator/rotate', (req, res) => {
        if (!requireOperator(req, res)) return;
        try {
            operatorToken.rotate();
            res.setHeader('Set-Cookie', operatorToken.cookieHeader());
            // Sockets admitted with the old cookie keep operator powers until
            // they reconnect; close them once this response (and its new
            // cookie) has been sent, so the kiosk reconnects as operator.
            res.on('finish', () => {
                try {
                    remoteAccessService.disconnectOperatorSockets();
                } catch (err) {
                    logger.warn(`[OperatorToken] disconnecting old operator sockets failed: ${err && err.message}`);
                }
            });
            res.json({ ok: true });
        } catch (err) {
            logger.error(`[OperatorToken] rotate failed: ${err.code || err.message}`);
            res.status(500).json({ error: 'operator_token_unreadable' });
        }
    });

    // ─── Device identity, access code, LAN-only (spec 7.2/7.3) ───────

    app.get('/api/remote/device', (req, res) => {
        res.json(deviceView(isOperatorIdentity(req.remoteIdentity)));
    });

    app.post('/api/remote/device/name', (req, res) => {
        if (!requireOperator(req, res)) return;
        if (refuseWhenIdentityUnavailable(res)) return;
        try {
            deviceIdentity.setName(req.body && req.body.name);
        } catch (err) {
            return res.status(err.message === 'invalid_name' ? 400 : 500).json({ error: err.message === 'invalid_name' ? 'invalid_name' : 'save_failed' });
        }
        res.json(deviceView(false));
    });

    app.post('/api/remote/access-code/regenerate', (req, res) => {
        if (!requireOperator(req, res)) return;
        if (refuseWhenIdentityUnavailable(res)) return;
        try {
            const accessCode = deviceIdentity.regenerateAccessCode();
            remoteAccessConfigStore.delete(ACCESS_CODE_OFF_PENDING);
            remoteAccessService.setPin(accessCode, { source: 'access-code' });
            emitDevice();
            res.json({ accessCode });
        } catch (err) {
            logger.error(`[remote] access code regenerate failed: ${err.code || err.message}`);
            res.status(500).json({ error: 'save_failed' });
        }
    });

    app.post('/api/remote/access-code/use', (req, res) => {
        if (!requireOperator(req, res)) return;
        if (refuseWhenIdentityUnavailable(res)) return;
        try {
            deviceIdentity.setAccessCodeActive(true);
            remoteAccessConfigStore.delete(ACCESS_CODE_OFF_PENDING);
            syncIdentityPin();
            emitDevice();
            res.json({ accessCode: deviceIdentity.getAccessCode() });
        } catch (err) {
            logger.error(`[remote] use access code failed: ${err.code || err.message}`);
            res.status(500).json({ error: 'save_failed' });
        }
    });

    app.post('/api/remote/lan-only', (req, res) => {
        if (!requireOperator(req, res)) return;
        if (refuseWhenIdentityUnavailable(res)) return;
        const enabled = req.body && req.body.enabled;
        if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be a boolean' });
        res.json(setLanOnly(enabled));
    });

    // ─── Cloud link (spec 7.2) ───────────────────────────────────────

    // cloud-link.json exists but is locked (OneDrive sync, antivirus): the
    // store is read-only until it can be read again, so this is retryable.
    function storeUnreadable(res, err) {
        if (!err || err.code !== 'STORE_UNREADABLE') return false;
        res.status(503).json({
            error: 'store_unreadable',
            message: 'Settings file is locked (OneDrive/antivirus?). Nothing was changed; try again.',
        });
        return true;
    }

    function cloudError(res, err, conflicts = []) {
        if (storeUnreadable(res, err)) return res;
        const code = err && err.message;
        if (conflicts.includes(code)) return res.status(409).json({ error: code });
        if (code === 'relay_unreachable') return res.status(502).json({ error: code });
        if (code === 'invalid_url' || code === 'invalid_limits') return res.status(400).json({ error: code });
        logger.error(`[cloud-link] request failed: ${code}`);
        return res.status(500).json({ error: 'internal' });
    }

    app.get('/api/remote/cloud/status', (req, res) => {
        const status = cloudLink.getStatus();
        res.json(isOperatorIdentity(req.remoteIdentity) ? status : redactCloudStatus(status));
    });

    app.post('/api/remote/cloud/config', (req, res) => {
        if (!requireOperator(req, res)) return;
        try {
            res.json(cloudLink.setRelayUrl(req.body && req.body.relayUrl));
        } catch (err) {
            cloudError(res, err);
        }
    });

    app.post('/api/remote/cloud/enabled', (req, res) => {
        if (!requireOperator(req, res)) return;
        const enabled = req.body && req.body.enabled;
        if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be a boolean' });
        try {
            res.json(cloudLink.setEnabled(enabled));
        } catch (err) {
            cloudError(res, err);
        }
    });

    app.post('/api/remote/cloud/pairing', async (req, res) => {
        if (!requireOperator(req, res)) return;
        try {
            res.json(await cloudLink.startPairing());
        } catch (err) {
            cloudError(res, err, ['lan_only', 'no_relay_url', 'already_paired']);
        }
    });

    app.get('/api/remote/cloud/pairing', (req, res) => {
        if (!requireOperator(req, res)) return;
        res.json(cloudLink.getPairing() || {});
    });

    app.delete('/api/remote/cloud/pairing', (req, res) => {
        if (!requireOperator(req, res)) return;
        try {
            cloudLink.cancelPairing();
            res.status(204).end();
        } catch (err) {
            cloudError(res, err);
        }
    });

    app.post('/api/remote/cloud/pairing/confirm', async (req, res) => {
        if (!requireOperator(req, res)) return;
        try {
            res.json(await cloudLink.confirmPairing());
        } catch (err) {
            cloudError(res, err, ['not_claimed']);
        }
    });

    app.post('/api/remote/cloud/pairing/reject', async (req, res) => {
        if (!requireOperator(req, res)) return;
        try {
            await cloudLink.rejectPairing();
            res.status(204).end();
        } catch (err) {
            cloudError(res, err, ['not_claimed']);
        }
    });

    app.post('/api/remote/cloud/unpair', async (req, res) => {
        if (!requireOperator(req, res)) return;
        try {
            await cloudLink.unpair();
            res.json(cloudLink.getStatus());
        } catch (err) {
            cloudError(res, err);
        }
    });

    app.post('/api/remote/cloud/limits', (req, res) => {
        if (!requireOperator(req, res)) return;
        const { maxFileMb, cloudLibraryCapMb } = req.body || {};
        try {
            res.json(cloudLink.setLimits({ maxFileMb, cloudLibraryCapMb }));
        } catch (err) {
            cloudError(res, err);
        }
    });

    app.get('/api/remote/cloud/recent-users', (req, res) => {
        if (!requireOperator(req, res)) return;
        res.json(gate.getRecentCloudUsers());
    });

    // ─── Remote permissions (tiers) ──────────────────────────────────

    app.get('/api/remote/permissions', (req, res) => {
        res.json(gate.getState(isOperatorIdentity(req.remoteIdentity) ? 'operator' : 'lan'));
    });

    app.post('/api/remote/permissions/job-control', (req, res) => {
        if (!requireOperator(req, res)) return;
        const { channel, enabled } = req.body || {};
        if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be a boolean' });
        try {
            res.json(gate.setJobControl(channel, enabled, req.remoteIdentity));
        } catch (err) {
            if (err.message === 'bad_scope') return res.status(400).json({ error: 'bad_scope' });
            if (storeUnreadable(res, err)) return;
            logger.error(`[gate] setJobControl failed: ${err.message}`);
            res.status(500).json({ error: 'internal' });
        }
    });

    app.post('/api/remote/permissions/motion', (req, res) => {
        if (!requireOperator(req, res)) return;
        const { minutes, scope } = req.body || {};
        try {
            res.json(gate.grantMotion(minutes, req.remoteIdentity, scope));
        } catch (err) {
            if (err.message === 'locked') return res.status(409).json({ error: 'locked', locks: err.locks || [] });
            if (err.message === 'bad_scope' || err.message === 'bad_duration') return res.status(400).json({ error: err.message });
            if (storeUnreadable(res, err)) return;
            logger.error(`[gate] grantMotion failed: ${err.message}`);
            res.status(500).json({ error: 'internal' });
        }
    });

    // Anyone may drop the grant; the audit records who did.
    app.delete('/api/remote/permissions/motion', (req, res) => {
        const identity = req.remoteIdentity || { kind: 'lan', sessionId: null, ip: req.ip, via: 'no-pin' };
        gate.revokeMotion('revoked', identity);
        res.json(gate.getState(isOperatorIdentity(identity) ? 'operator' : 'lan'));
    });

    app.get('/api/remote/audit', (req, res) => {
        if (!requireOperator(req, res)) return;
        const requested = parseInt(req.query.limit, 10);
        const limit = Math.min(AUDIT_READ_MAX, Number.isFinite(requested) && requested > 0 ? requested : 100);
        try {
            res.json(readAuditTail(path.join(dataDir, 'remote-audit.jsonl'), limit));
        } catch (err) {
            logger.error(`[remote] audit read failed: ${err.code || err.message}`);
            res.status(500).json({ error: 'audit_unreadable' });
        }
    });

    // ─── Macro REST API ──────────────────────────────────────────────

    app.get('/api/macros', (req, res) => {
        res.json(engine.config.getMacros());
    });

    app.post('/api/macros', (req, res) => {
        engine.config.saveMacro(req.body);
        res.json(engine.config.getMacros());
    });

    app.delete('/api/macros/:id', (req, res) => {
        engine.config.deleteMacro(req.params.id);
        res.json(engine.config.getMacros());
    });

    app.post('/api/macros/:id/run', (req, res) => {
        const macro = engine.config.getMacro(req.params.id);
        if (!macro) return res.status(404).json({ error: 'Macro not found' });
        if (!engine.controller) return res.status(400).json({ error: 'Not connected' });
        noteLocalCommand(req, `/api/macros/${req.params.id}/run`);
        engine.controller.command('macro:run', macro.content);
        res.json({ ok: true });
    });

    // ─── Tool Library REST API ───────────────────────────────────────

    app.get('/api/tools', (req, res) => {
        res.json(engine.config.getTools());
    });

    app.post('/api/tools', (req, res) => {
        engine.config.saveTool(req.body);
        res.json(engine.config.getTools());
    });

    app.delete('/api/tools/:id', (req, res) => {
        engine.config.deleteTool(req.params.id);
        res.json(engine.config.getTools());
    });

    // ─── Config REST API ─────────────────────────────────────────────

    app.get('/api/config', (req, res) => {
        res.json(engine.config.getAll());
    });

    app.get('/api/config/:key', (req, res) => {
        const value = engine.config.get(req.params.key);
        res.json({ key: req.params.key, value });
    });

    app.post('/api/config', (req, res) => {
        const { key, value } = req.body || {};
        if (!key) return res.status(400).json({ error: 'Missing key' });
        if (typeof key !== 'string') return res.status(400).json({ error: 'key must be a string' });
        // Local identities keep machine settings (D1) but may not open an
        // internet control channel (RemoteDiag inject/URL/token, bot config).
        if (configPolicy.isOperatorOnlyConfigWrite(key, value, engine.config.get('preferences', {}))
            && !requireOperator(req, res)) return;
        engine.config.set(key, value);
        res.json({ ok: true });
    });

    // ─── Health REST API ─────────────────────────────────────────────

    app.get('/api/health', (req, res) => {
        res.json({
            status: 'ok',
            uptime: process.uptime(),
            connected: engine.controller != null,
            health: engine.controller?.getHealthMetrics() || null,
        });
    });

    // ─── Firmware Flashing & Live OTA ─────────────────────────────────

    function refuseWhenLanOnly(res) {
        if (!deviceIdentity.isLanOnly()) return false;
        res.status(409).json({ error: 'lan_only' });
        return true;
    }

    // Get firmware release information (optionally querying cloud repository)
    app.get('/api/firmware/info', async (req, res) => {
        const currentVersion = req.query.currentVersion || engine.controller?.state?.status?.firmwareVersion || '';
        const checkOnline = req.query.checkOnline === 'true';
        try {
            if (checkOnline) {
                if (refuseWhenLanOnly(res)) return;
                const info = await firmwareUpdateService.checkOnlineUpdate(currentVersion);
                return res.json(info);
            }
            const info = firmwareUpdateService.getFirmwareInfo(currentVersion);
            res.json(info);
        } catch (err) {
            logger.error(`[FirmwareAPI] ${err.message}`);
            res.status(500).json({ error: err.message });
        }
    });

    // Explicitly check internet for new OTA firmware releases
    app.post('/api/firmware/check-online', async (req, res) => {
        if (refuseWhenLanOnly(res)) return;
        const currentVersion = req.body?.currentVersion || engine.controller?.state?.status?.firmwareVersion || '';
        try {
            const info = await firmwareUpdateService.checkOnlineUpdate(currentVersion);
            res.json(info);
        } catch (err) {
            logger.error(`[FirmwareAPI] ${err.message}`);
            res.status(500).json({ error: err.message });
        }
    });

    // Download and stage official OTA release from cloud
    app.post('/api/firmware/ota-download', async (req, res) => {
        if (refuseWhenLanOnly(res)) return;
        try {
            const result = await firmwareUpdateService.downloadAndStageOtaRelease();
            res.json(result);
        } catch (err) {
            logger.error(`[FirmwareAPI] ${err.message}`);
            res.status(500).json({ error: err.message });
        }
    });

    // Flash firmware to controller board (STM32H723 USB DFU)
    app.post('/api/firmware/flash', async (req, res) => {
        const { port: flashPort, hexPath, useOfficialRelease } = req.body;
        let hexData = req.body.hexData;
        const boardType = req.body.boardType || 'EASYCNC'; // Default to STM32H723 USB DFU

        // A job that is merely PAUSED still owns the machine, and flashing reboots
        // the board: the run would be unrecoverable and the tool left in the cut.
        // The state string alone is not enough (a paused job can read as Idle).
        if (processGuards.jobIsActive(engine)) {
            return res.status(400).json({ error: 'A job is loaded and running (or paused). Stop it before updating firmware.' });
        }
        const currentMachineState = engine.state?.status?.activeState || engine.controller?.state?.status?.activeState || 'idle';
        const safety = firmwareUpdateService.canFlash(currentMachineState);
        if (!safety.allowed) {
            return res.status(400).json({ error: safety.reason });
        }

        try {
            const socket = io.sockets.sockets.values().next().value;
            if (useOfficialRelease || (!hexData && !hexPath)) {
                hexData = await firmwareUpdateService.getOfficialHexData();
            }

            await FirmwareFlashing.flash(flashPort || 'USB_DFU', boardType, {
                hexPath,
                hexData,
                socket,
                controller: engine.controller,
            });
            res.json({ success: true, message: 'Firmware flashed successfully via USB DFU' });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: err.message });
        }
    });

    // ─── Webcam REST ─────────────────────────────────────────────────

    // LAN phones get only id/name/type/online: stream URLs carry camera credentials.
    app.get('/api/webcam/cameras', (req, res) => res.json(hasLocalControl(req.remoteIdentity)
        ? webcamService.list()
        : webcamService.publicList()));
    app.get('/api/webcam/devices', async (req, res) => {
        try {
            const devices = await webcamService.detectLocalDevices();
            res.json({ devices });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
    app.post('/api/webcam/auto-detect', async (req, res) => {
        try {
            const result = await webcamService.autoDetectAndAdd();
            res.json(result);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
    app.post('/api/webcam/cameras', (req, res) => {
        try { res.json(webcamService.upsert(req.body)); }
        catch (e) { res.status(400).json({ error: e.message }); }
    });
    app.delete('/api/webcam/cameras/:id', (req, res) => {
        webcamService.remove(req.params.id); res.json({ ok: true });
    });
    app.post('/api/webcam/frame/:id', express.raw({ type: ['image/jpeg', 'application/octet-stream'], limit: '10mb' }), (req, res) => {
        const buf = Buffer.isBuffer(req.body) ? req.body : (req.body?.data ? Buffer.from(req.body.data, 'base64') : null);
        if (!buf || buf.length === 0) return res.status(400).json({ error: 'No frame buffer provided' });
        const ok = webcamService.setFrame(req.params.id, buf);
        res.json({ ok });
    });
    app.get('/api/webcam/stream/:id', (req, res) => {
        webcamService.subscribe(req.params.id, res);
    });
    app.get('/api/webcam/snapshot/:id', (req, res) => {
        const buf = webcamService.snapshot(req.params.id);
        if (!buf) return res.status(404).end();
        res.set('Content-Type', 'image/jpeg').send(buf);
    });

    // ─── Gamepad REST ────────────────────────────────────────────────

    app.get('/api/gamepad/bindings', (req, res) => res.json(gamepadService.getBindings()));
    app.post('/api/gamepad/bindings', (req, res) => {
        gamepadService.setBindings(req.body); res.json(gamepadService.getBindings());
    });

    // ─── WatchDir REST ───────────────────────────────────────────────

    app.get('/api/watchdir/config', (req, res) => res.json(watchdirService.getConfig()));
    app.post('/api/watchdir/config', (req, res) => {
        try { res.json(watchdirService.setConfig(req.body)); }
        catch (e) { res.status(400).json({ error: e.message }); }
    });
    app.get('/api/watchdir/files', (req, res) => res.json(watchdirService.list()));
    app.get('/api/watchdir/file/:name', (req, res) => {
        try { res.type('text/plain').send(watchdirService.readFile(req.params.name)); }
        catch (e) { res.status(400).json({ error: e.message }); }
    });

    // ─── Probing REST ────────────────────────────────────────────────

    app.get('/api/probing/strategies', (req, res) => res.json(probingService.listStrategies()));
    app.post('/api/probing/run', async (req, res) => {
        noteLocalCommand(req, '/api/probing/run');
        try { res.json(await probingService.run(req.body)); }
        catch (e) { res.status(400).json({ error: e.message }); }
    });
    app.post('/api/probing/abort', (req, res) => {
        probingService.abort(); res.json({ ok: true });
    });
    // msg11601 item 4: operator confirms the probe/touch-plate has been
    // physically removed, THEN this drops Z by probeSettings.blockThickness and re-zeros --
    // see ProbingService.finalizeCornerZero() doc comment for why this is a
    // separate human-triggered step and not part of /api/probing/run.
    app.post('/api/probing/finalize-corner', async (req, res) => {
        noteLocalCommand(req, '/api/probing/finalize-corner');
        try { res.json(await probingService.finalizeCornerZero()); }
        catch (e) { res.status(400).json({ error: e.message }); }
    });
    // Probe Recorder (msg11469): persists real measured zRetract/xyReposition/
    // zDrop values captured by the frontend's manual-jog-and-mark wizard, so
    // these no longer need another code ship after every hardware retest.
    //
    // backend/data/config.json (the main ConfigStore) is gitignored -- runtime
    // state only, never visible in the repo. Tawfiq (msg11476) wants the actual
    // measured numbers as their own tracked file he can see/diff, so this also
    // writes probe_calibration.json at the repo root, which IS committed.
    const PROBE_CALIBRATION_FILE = path.join(__dirname, '..', 'probe_calibration.json');
    app.post('/api/probing/record/save', (req, res) => {
        try {
            const { zRetract, xyReposition, zDrop } = req.body || {};
            if (zRetract != null) engine.config.set('probeSettings.zRetract', zRetract);
            if (xyReposition != null) engine.config.set('probeSettings.xyReposition', xyReposition);
            if (zDrop != null) engine.config.set('probeSettings.zDrop', zDrop);
            const probeSettings = engine.config.get('probeSettings');
            fs.writeFileSync(PROBE_CALIBRATION_FILE, JSON.stringify({
                zRetract: probeSettings.zRetract,
                xyReposition: probeSettings.xyReposition,
                zDrop: probeSettings.zDrop,
                recordedAt: new Date().toISOString(),
            }, null, 2) + '\n');
            res.json({ success: true, probeSettings });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    // ─── Job History REST ────────────────────────────────────────────

    app.get('/api/jobhistory', (req, res) => res.json(jobHistoryService.list(req.query)));
    app.get('/api/jobhistory/stats', (req, res) => res.json(jobHistoryService.stats()));
    app.get('/api/jobhistory/:id', (req, res) => {
        const r = jobHistoryService.get(req.params.id);
        if (!r) return res.status(404).end();
        res.json(r);
    });
    app.delete('/api/jobhistory', (req, res) => { jobHistoryService.clear(); res.json({ ok: true }); });
    app.delete('/api/jobhistory/:id', (req, res) => { jobHistoryService.deleteOne(req.params.id); res.json({ ok: true }); });

    // Is a carve running right now? RUN.bat asks this before it frees port 4000
    // by killing whatever holds it -- doing that mid-carve killed the sender and
    // the machine E-stopped on its own host watchdog (2026-09-15 19:18 log).
    app.get('/api/job/active', (req, res) => {
        const ctrl = engine.controller;
        const job = ctrl && ctrl.job;
        res.json({
            active: !!(job && job.active),
            paused: !!(job && job.active && job.paused),
            line: job && job.active ? job.nextLineToRun() : 0,
            total: job && job.active ? job.totalLineCount : 0,
            file: (engine.loadedFile && engine.loadedFile.name) || null,
        });
    });

    // ─── Job Resume / Checkpoint REST API ───────────────────────────────

    app.get('/api/job/checkpoint', (req, res) => {
        const meta = jobResumeService.getCheckpointMeta();
        res.json(meta || { checkpoint: null });
    });

    app.get('/api/job/checkpoint/valid', (req, res) => {
        res.json(jobResumeService.validateCheckpoint());
    });

    app.post('/api/job/resume', (req, res) => {
        noteLocalCommand(req, '/api/job/resume');
        const result = jobResumeService.resumeFromCheckpoint(req.body || {});
        if (result.ok) {
            res.json(result);
        } else {
            res.status(400).json(result);
        }
    });

    app.delete('/api/job/checkpoint', (req, res) => {
        jobResumeService.clearCheckpoint();
        res.json({ ok: true });
    });

    // ─── Tool Library REST (v2 — replaces engine.config tools API) ───

    app.get('/api/toollib', (req, res) => res.json(toolLibrary.list()));
    app.get('/api/toollib/:number', (req, res) => {
        const t = toolLibrary.get(req.params.number);
        if (!t) return res.status(404).end();
        res.json(t);
    });
    app.post('/api/toollib', (req, res) => {
        try { res.json(toolLibrary.upsert(req.body)); }
        catch (e) { res.status(400).json({ error: e.message }); }
    });
    app.delete('/api/toollib/:number', (req, res) => {
        toolLibrary.remove(req.params.number); res.json({ ok: true });
    });
    app.post('/api/toollib/preflight', (req, res) => {
        res.json(toolLibrary.preflight(req.body?.gcode || ''));
    });

    // ─── WhatsApp Notifications REST API ─────────────────────────────
    // Bot settings (open mode, recipients, allowed chats, token) decide who
    // can command the machine from the internet outside RemoteCommandGate,
    // so every change is operator-only; reads stay available locally (D1).
    app.use(['/api/whatsapp', '/api/telegram'], (req, res, next) => {
        if (req.method === 'GET' || req.method === 'HEAD') return next();
        if (!requireOperator(req, res)) return undefined;
        return next();
    });
    app.get('/api/whatsapp/status', (req, res) => res.json(whatsappService.getStatus()));
    app.post('/api/whatsapp/enable', async (req, res) => {
        try { res.json(await whatsappService.enable()); }
        catch (err) { res.status(err.message === 'lan_only' ? 409 : 500).json({ error: err.message }); }
    });
    app.post('/api/whatsapp/disable', async (req, res) => {
        try { res.json(await whatsappService.disable()); }
        catch (err) { res.status(500).json({ error: err.message }); }
    });
    app.post('/api/whatsapp/recipients', (req, res) => {
        try { res.json({ recipients: whatsappService.addRecipient(req.body?.phone) }); }
        catch (err) { res.status(400).json({ error: err.message }); }
    });
    app.delete('/api/whatsapp/recipients/:phone', (req, res) => {
        res.json({ recipients: whatsappService.removeRecipient(req.params.phone) });
    });
    app.post('/api/whatsapp/events', (req, res) => {
        try { res.json(whatsappService.updateEvents(req.body?.events || [])); }
        catch (err) { res.status(400).json({ error: err.message }); }
    });
    app.post('/api/whatsapp/config', (req, res) => {
        res.json(whatsappService.updateConfig(req.body || {}));
    });
    app.post('/api/whatsapp/test', async (req, res) => {
        try { res.json({ results: await whatsappService.sendTest() }); }
        catch (err) { res.status(err.message === 'lan_only' ? 409 : 400).json({ error: err.message }); }
    });

    // ─── Telegram Bot REST API ────────────────────────────────────────
    app.get('/api/telegram/status', (req, res) => res.json(telegramService.getStatus()));
    app.post('/api/telegram/config', (req, res) => {
        res.json(telegramService.updateConfig(req.body || {}));
    });
    app.post('/api/telegram/enable', async (req, res) => {
        try { res.json(await telegramService.enable()); }
        catch (err) { res.status(err.message === 'lan_only' ? 409 : 400).json({ error: err.message }); }
    });
    app.post('/api/telegram/disable', async (req, res) => {
        try { res.json(await telegramService.disable()); }
        catch (err) { res.status(400).json({ error: err.message }); }
    });
    app.post('/api/telegram/test', async (req, res) => {
        try { res.json(await telegramService.test()); }
        catch (err) { res.status(err.message === 'lan_only' ? 409 : 400).json({ error: err.message }); }
    });

    // ─── Library REST API ─────────────────────────────────────────────
    app.get('/api/library', (req, res) => res.json(libraryService.list()));
    app.get('/api/library/:id/body', (req, res) => {
        try { res.type('text/plain').send(libraryService.getBody(req.params.id)); }
        catch (err) { res.status(404).json({ error: err.message }); }
    });
    app.post('/api/library', (req, res) => {
        try { res.json(libraryService.upsert(req.body || {})); }
        catch (err) { res.status(400).json({ error: err.message }); }
    });
    // The operator has checked a remote upload; only then can a remote
    // job.load/job.start use it (REVIEW_REQUIRED otherwise).
    app.post('/api/library/:id/review', (req, res) => {
        if (!requireOperator(req, res)) return;
        let meta;
        try {
            meta = libraryService.markReviewed(req.params.id);
        } catch (err) {
            return res.status(404).json({ error: 'not_found' });
        }
        try {
            gate.audit(req.remoteIdentity, { event: 'file.reviewed', args: { libraryId: meta.id, name: meta.name } });
        } catch (err) {
            logger.warn(`[remote] file.reviewed audit failed: ${err.message}`);
        }
        res.json(meta);
    });
    app.delete('/api/library/:id', (req, res) => {
        libraryService.remove(req.params.id);
        res.json({ ok: true });
    });

    // ─── Frontend static serving (production build) ──────────────────
    // Serves frontend/dist/ (built via `cd frontend && npm run build`) so the
    // whole app -- backend API + Socket.IO + UI -- comes up from one process on
    // one port, no separate dev server needed. Placed after all /api/* routes
    // (so API paths are never shadowed by the static handler / SPA fallback)
    // but before the error-handling chain. Silently no-ops (falls through to
    // the 404 handler below) if dist/ hasn't been built yet, so this is safe
    // to have even during backend-only development.
    const frontendDistPath = path.join(__dirname, '..', 'frontend', 'dist');
    app.use(express.static(frontendDistPath));
    app.get(/^(?!\/api\/).*/, (req, res, next) => {
        // Only handle browser page navigations, not API/websocket traffic --
        // res.sendFile 404s (via the `next()` in its callback) fall through to
        // the normal error chain instead of masking a real missing-asset error.
        res.sendFile(path.join(frontendDistPath, 'index.html'), (err) => {
            if (err) next();
        });
    });

    // ─── Error Handling Middleware Chain ──────────────────────────────
    // Order matters: 404 → log → client (JSON) → server (fallback)
    app.use(errnotfound());
    app.use(errlog);
    app.use(errclient);
    app.use(errserver());

    /** Operator link for this PC only: console, never logger file sinks or sockets. */
    function operatorLink(url) {
        if (!operatorToken.isLoaded()) return null;
        try {
            return `${url}/?op=${operatorToken.getLaunchSecret()}`;
        } catch (_) {
            return null;
        }
    }

    function start({ host = process.env.HOST || '0.0.0.0', listenPort = port, exitOnError = true } = {}) {
        if (!isTest) {
            cloudLink.init();
            cloudLinkStarted = true;
        }

        // Handle server port errors gracefully
        server.on('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                logger.error(`Port ${listenPort} is already in use by another process.`);
                logger.error(`Please close any existing server window or terminate the process using port ${listenPort}.`);
            } else {
                logger.error(`Server error: ${err.message}`);
            }
            if (exitOnError) process.exit(1);
        });

        return new Promise((resolve) => {
            server.listen(listenPort, host, () => {
                const actualPort = server.address().port;
                const url = `http://${host === '0.0.0.0' ? 'localhost' : host}:${actualPort}`;
                logger.info(`CNC backend listening on ${url}`);
                logger.info('>>> BACKEND BUILD: vendor-pcap-v3 (msg 7099) — retransmit-on-B until-A + Z-runaway off');
                if (!isTest && process.env.NO_MDNS !== '1') {
                    mdnsWanted = true;
                    // No name to announce until the identity file can be read.
                    if (deviceIdentity.isAvailable()) mdns.start();
                }
                if (!isTest) {
                    const link = operatorLink(`http://localhost:${actualPort}`);
                    if (link) {
                        console.log(`Operator link: ${link}`);
                    } else {
                        console.warn(`Operator access is unavailable: backend/data/operator-token cannot be read (${operatorToken.getLoadError() || 'unknown error'}). This PC's browsers still have local control.`);
                    }
                    openBrowserApp(link || url);
                }
                resolve({ url, port: actualPort });
            });
        });
    }

    let shutdownPromise = null;
    function shutdown() {
        if (shutdownPromise) return shutdownPromise;
        const step = async (name, fn) => {
            try {
                await fn();
            } catch (err) {
                logger.warn(`[shutdown] ${name} failed: ${err && err.message}`);
            }
        };
        shutdownPromise = (async () => {
            await step('cloudLink.stop', () => cloudLink.stop('shutdown'));
            await step('gate.cancelAllJogs', () => gate.cancelAllJogs('shutdown'));
            if (identityRetryTimer) {
                clearInterval(identityRetryTimer);
                identityRetryTimer = null;
            }
            await step('mdns.stop', () => mdns.stop());
            await step('webcam.shutdown', () => webcamService.shutdown());
            await step('remoteAccessConfig.flush', () => remoteAccessConfigStore.flush());
            await step('config.flush', () => engine.config && engine.config.flush && engine.config.flush());
            await step('gate.dispose', () => gate.dispose());
            await new Promise((resolve) => {
                const timer = setTimeout(resolve, 2000);
                if (typeof timer.unref === 'function') timer.unref();
                io.close(() => {
                    clearTimeout(timer);
                    resolve();
                });
                if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
            });
        })();
        return shutdownPromise;
    }

    return {
        app,
        server,
        io,
        engine,
        gate,
        cloudLink,
        cloudStore,
        mdns,
        deviceIdentity,
        operatorToken,
        remoteAccessService,
        remoteAccessConfigStore,
        remoteDiagMirror,
        services: {
            webcamService, gamepadService, watchdirService, probingService, jobHistoryService, jobResumeService,
            toolLibrary, libraryService, chatbotService, whatsappService, telegramService, firmwareUpdateService,
            tailscaleService, wifiService,
        },
        applyOutbound,
        setLanOnly,
        start,
        shutdown,
    };
}

// Auto-launch browser in standalone app mode (removes URL bar, tabs, and browser refresh buttons)
const { exec, spawn } = require('child_process');
function openBrowserApp(targetUrl) {
    if (process.env.NO_BROWSER || process.env.NODE_ENV === 'test') return;
    const candidates = [
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ];

    const exe = candidates.find(p => {
        try { return p && fs.existsSync(p); } catch { return false; }
    });

    if (exe) {
        try {
            const child = spawn(exe, [`--app=${targetUrl}`], {
                detached: true,
                stdio: 'ignore'
            });
            child.unref();
            return;
        } catch (e) {
            logger.warn('Failed to spawn browser in app mode, falling back to default browser', { error: e.message });
        }
    }

    if (process.platform === 'win32') {
        exec(`start "" "${targetUrl}"`);
    } else if (process.platform === 'darwin') {
        exec(`open "${targetUrl}"`);
    } else {
        exec(`xdg-open "${targetUrl}"`);
    }
}

function main() {
    let backend;
    try {
        backend = createBackend();
    } catch (err) {
        logger.error(`Backend failed to start: ${err && err.message}`);
        process.exit(1);
    }
    backend.start();

    // ─── Staying alive, and stopping the machine before we don't ────────
    //
    // The controller stops the machine by itself if the PC goes quiet for 5 s
    // (host watchdog). So a backend crash, or this window being closed during a
    // carve, does not just end the program -- it stops the machine mid-cut and
    // leaves the spindle in the material. Two guards (lib/processGuards.js):
    //   1. an unexpected error never takes the process down; it is logged
    //      (rate-limited) and reported to the UI, and a running job's resume
    //      checkpoint is saved at once
    //   2. an intentional shutdown saves the resume checkpoint, then stops the
    //      job cleanly (drivers off, position kept) rather than letting the
    //      watchdog fire
    processGuards.installExceptionGuards({
        logger,
        notify: (message) => backend.io.emit('controller:error', { message }),
        isJobActive: () => processGuards.jobIsActive(backend.engine),
        saveCheckpoint: (reason) => processGuards.saveCheckpointNow(backend.services.jobResumeService, reason),
    });

    // Save the checkpoint and stop the job cleanly first, then tear down the
    // cloud link, sockets and services.
    // createShutdown() is synchronous and signals completion by calling `exit`
    // once the stop frame has had time to reach the controller, so the promise
    // is resolved from there -- the cloud link and sockets must not be torn
    // down before the machine has actually been told to stop.
    let stopDone;
    const jobStopped = new Promise((resolve) => { stopDone = resolve; });
    const stopJobCleanly = processGuards.createShutdown({
        logger,
        getEngine: () => backend.engine,
        jobResumeService: backend.services.jobResumeService,
        jobHistoryService: backend.services.jobHistoryService,
        exit: () => stopDone(),
    });

    let stopping = false;
    const onSignal = (signal) => {
        if (stopping) return;
        stopping = true;
        logger.info(`${signal} received, shutting down`);
        // server.close() can wait on idle keep-alive sockets; never hang the exit.
        setTimeout(() => process.exit(0), 2500).unref();
        try {
            stopJobCleanly(signal);
        } catch (err) {
            logger.warn(`[shutdown] job stop failed: ${err && err.message}`);
            stopDone();
        }
        jobStopped
            .then(() => backend.shutdown())
            .finally(() => process.exit(0));
    };
    process.on('SIGINT', () => onSignal('SIGINT'));
    process.on('SIGTERM', () => onSignal('SIGTERM'));
    return backend;
}

module.exports = { createBackend, loadDeviceIdentity, redactCloudStatus, redactUrl, readAuditTail };

if (require.main === module || process.env.CNC_BACKEND_NO_AUTOSTART !== '1') {
    const backend = main();
    module.exports.backend = backend;
    // Flat handles: tests and tooling require index.js and reach for these
    // directly (tests/shutdown_saves_checkpoint.test.js).
    module.exports.app = backend.app;
    module.exports.server = backend.server;
    module.exports.io = backend.io;
    module.exports.engine = backend.engine;
    module.exports.shutdown = backend.shutdown;
    module.exports.jobResumeService = backend.services.jobResumeService;
    module.exports.jobHistoryService = backend.services.jobHistoryService;
}
