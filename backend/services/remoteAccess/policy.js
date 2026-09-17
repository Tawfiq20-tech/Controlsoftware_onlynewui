/**
 * LAN permission policy (spec 7.4): what a remote, non-local identity may
 * reach over HTTP and Socket.IO.
 *
 * Both tables are allowlists. Anything not listed is refused for every
 * identity without local control, including null (unauthenticated) ones, so
 * a route or socket event added later is closed until someone lists it here.
 *
 * Operator and local identities (hasLocalControl) skip these filters. Their
 * traffic instead goes through the operator activity tap, which tells the
 * remote command gate that someone at the machine is driving it.
 */
const { hasLocalControl } = require('./RemoteAccessService');

const deepFreeze = (obj) => {
    for (const value of Object.values(obj)) {
        if (value && typeof value === 'object') deepFreeze(value);
    }
    return Object.freeze(obj);
};

// `check` names a handler that must also pass (see createLanHttpFilter).
const HTTP_ALLOWLIST = deepFreeze([
    { method: 'GET', path: '/api/remote/info' },
    { method: 'POST', path: '/api/remote/verify-pin' },
    { method: 'POST', path: '/api/remote/logout' },
    { method: 'POST', path: '/api/remote/operator/claim' },
    { method: 'POST', path: '/api/log' },
    { method: 'GET', path: '/api/state' },
    { method: 'GET', path: '/api/remote/device' },
    { method: 'GET', path: '/api/remote/cloud/status' },
    { method: 'GET', path: '/api/remote/permissions' },
    { method: 'DELETE', path: '/api/remote/permissions/motion' },
    { method: 'GET', path: '/api/library' },
    { method: 'GET', path: '/api/library/:id/body', check: 'libraryBody' },
    { method: 'POST', path: '/api/library' },
    { method: 'GET', path: '/api/webcam/cameras' },
    { method: 'GET', path: '/api/webcam/snapshot/:id' },
    { method: 'GET', path: '/api/webcam/stream/:id' },
    { method: 'GET', path: '/api/jobhistory' },
    { method: 'GET', path: '/api/jobhistory/stats' },
    { method: 'GET', path: '/api/jobhistory/:id' },
    { method: 'POST', path: '/api/command', check: 'command' },
]);

// Read-only events that carry no secrets.
const SOCKET_ALLOW_EVENTS = deepFreeze(['hPing', 'list', 'macro:list', 'trigger:list', 'health:metrics']);

// Events decided per call by gate.checkLan.
const SOCKET_GATED_EVENTS = deepFreeze(['command', 'file:load', 'file:unload']);

function splitPath(p) {
    // Express matches with a non-strict trailing slash; do the same so an
    // allowlisted route is not refused for "/api/library/".
    const trimmed = p.length > 1 ? p.replace(/\/+$/, '') : p;
    return trimmed.split('/');
}

const COMPILED = HTTP_ALLOWLIST.map((rule) => ({ rule, segments: splitPath(rule.path) }));

/**
 * @returns {{method, path, check?, params:object} | null}
 * HEAD is treated as GET because Express answers HEAD with GET routes.
 */
function matchHttp(method, reqPath) {
    if (typeof method !== 'string' || typeof reqPath !== 'string') return null;
    const m = method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase();
    const parts = splitPath(reqPath);
    for (const { rule, segments } of COMPILED) {
        if (rule.method !== m || segments.length !== parts.length) continue;
        const params = {};
        let ok = true;
        for (let i = 0; i < segments.length; i++) {
            const seg = segments[i];
            if (seg.startsWith(':')) {
                if (!parts[i]) { ok = false; break; }
                let value = parts[i];
                try { value = decodeURIComponent(value); } catch (_) { ok = false; break; }
                params[seg.slice(1)] = value;
            } else if (seg !== parts[i]) {
                ok = false;
                break;
            }
        }
        if (ok) return { ...rule, params };
    }
    return null;
}

/** The identity handed to gate.checkLan for a request or socket. */
function lanIdentity(identity, { ip = null, socketId = null } = {}) {
    if (identity && identity.kind === 'lan') return { ...identity, socketId };
    return { kind: 'lan', sessionId: null, ip, via: 'no-pin', socketId };
}

function isUnreviewedCloudUpload(meta) {
    return !!(meta && meta.provenance && meta.provenance.origin === 'cloud' && meta.provenance.reviewed !== true);
}

/**
 * Express middleware, mounted right after httpGate. Relies on
 * req.remoteIdentity (possibly null) set by httpGate.
 */
function createLanHttpFilter({ gate, libraryService }) {
    const checks = {
        command(req, res, next, id) {
            const body = req.body || {};
            const cmd = body.command || body.cmd;
            // Deny, never pass through: the handler dispatches through
            // controller._commands[cmd], where a non-string key such as
            // ["gcode"] coerces to a real command name and would skip the gate.
            if (typeof cmd !== 'string' || !cmd) {
                return res.status(403).json({ error: 'BAD_ARGS', message: 'command must be a non-empty string' });
            }
            if (body.args != null && !Array.isArray(body.args)) {
                return res.status(403).json({ error: 'BAD_ARGS', message: 'args must be an array' });
            }
            const args = Array.isArray(body.args) ? body.args : [];
            const r = gate.checkLan(lanIdentity(id, { ip: req.ip }), cmd, args);
            if (!r.ok) return res.status(403).json({ error: r.code, message: r.message || null });
            // Hand the engine the gate's canonical arguments, not the phone's
            // (stops keep theirs: they are never refused or reshaped).
            if (r.tier !== 'stop' && Array.isArray(r.engineArgs)) {
                req.body = { ...body, args: r.engineArgs.slice() };
            }
            return next();
        },
        libraryBody(req, res, next, id, params) {
            let meta = null;
            try { meta = libraryService.get(params.id); } catch (_) { meta = null; }
            if (isUnreviewedCloudUpload(meta)) return res.status(403).json({ error: 'review_required' });
            return next();
        },
    };
    return function lanHttpFilter(req, res, next) {
        if (!req.path.startsWith('/api/')) return next();
        const id = req.remoteIdentity;
        if (hasLocalControl(id)) return next();
        const rule = matchHttp(req.method, req.path);
        if (!rule) return res.status(403).json({ error: 'operator_only' });
        if (!rule.check) return next();
        if (!checks[rule.check]) return res.status(403).json({ error: 'operator_only' });
        return checks[rule.check](req, res, next, id, rule.params);
    };
}

/**
 * socket.use middleware for sockets without local control. A denied packet
 * is dropped: next is never called, and never with an error, because
 * socket.io 4.8 re-emits next(err) as a server-side 'error' event.
 */
function createLanPacketFilter({ gate, socket, logger, isIdentityCurrent = null }) {
    const deny = (event, cmd, code, message) => {
        try {
            socket.emit('remote:denied', { event, cmd: cmd || null, code, message: message || null });
        } catch (err) {
            if (logger) logger.debug?.('[socket] remote:denied emit failed', err && err.message);
        }
    };
    return function lanPacketFilter(packet, next) {
        const [event, ...args] = Array.isArray(packet) ? packet : [];
        // The identity was fixed at the handshake. A session revoked or a PIN
        // set since then must not keep a live socket: drop the packet and
        // close the socket (revocation also disconnects; this is the backstop).
        if (typeof isIdentityCurrent === 'function') {
            let current = false;
            try { current = !!isIdentityCurrent(socket.data && socket.data.identity); } catch (_) { current = false; }
            if (!current) {
                deny(typeof event === 'string' ? event : String(event), null, 'SESSION_REVOKED', 'Remote session ended; enter the PIN again');
                try { socket.disconnect(true); } catch (_) { /* already gone */ }
                return undefined;
            }
        }
        if (typeof event !== 'string') return deny(String(event), null, 'UNKNOWN_COMMAND', 'Not available remotely');
        if (SOCKET_ALLOW_EVENTS.includes(event)) return next();
        if (!SOCKET_GATED_EVENTS.includes(event)) {
            return deny(event, null, 'UNKNOWN_COMMAND', 'Not available remotely');
        }
        const identity = lanIdentity(socket.data && socket.data.identity, {
            ip: socket.handshake && socket.handshake.address,
            socketId: socket.id,
        });
        let r;
        if (event === 'command') {
            const cmd = args[1];
            if (typeof cmd !== 'string') return deny(event, null, 'BAD_ARGS', 'Missing command');
            // Ack callbacks are not command arguments.
            const rest = args.slice(2).filter((a) => typeof a !== 'function');
            r = gate.checkLan(identity, cmd, rest);
            if (!r.ok) return deny(event, cmd, r.code, r.message);
            // Forward the gate's canonical arguments in place of the phone's
            // (socket.io dispatches this same array). Stops keep theirs.
            if (r.tier !== 'stop' && Array.isArray(r.engineArgs)) {
                const acks = args.slice(2).filter((a) => typeof a === 'function');
                packet.length = 3;
                packet.push(...r.engineArgs, ...acks);
            }
        } else {
            r = gate.checkLan(identity, event, []);
            if (!r.ok) return deny(event, null, r.code, r.message);
        }
        return next();
    };
}

/** socket.use middleware for operator and local sockets: observe, never block. */
function createOperatorActivityTap({ gate, logger }) {
    return function operatorActivityTap(packet, next) {
        try {
            const [event, ...args] = Array.isArray(packet) ? packet : [];
            if (typeof event === 'string') gate.onLocalCommand(event, args);
        } catch (err) {
            if (logger) logger.warn?.(`[remote] operator activity tap failed: ${err && err.message}`);
        }
        next();
    };
}

module.exports = Object.freeze({
    HTTP_ALLOWLIST,
    SOCKET_ALLOW_EVENTS,
    SOCKET_GATED_EVENTS,
    matchHttp,
    lanIdentity,
    isUnreviewedCloudUpload,
    createLanHttpFilter,
    createLanPacketFilter,
    createOperatorActivityTap,
});
