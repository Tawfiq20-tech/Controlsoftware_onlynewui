// Own copy of the wire protocol constants (SPEC §3). Kept DOM-free so the
// cores in js/core/ can import it under plain Node.

export const PROTOCOL_VERSION = 1;

export const CLS = Object.freeze({ STOP: 'stop', JOB: 'job', MOTION: 'motion', MONITOR: 'monitor' });

export const TTL_MAX = Object.freeze({ stop: 10000, job: 5000, monitor: 5000, motion: 500 });
export const TTL_DEFAULT = Object.freeze({ stop: 5000, job: 3000, monitor: 3000, motion: 500 });
export const KEEPALIVE_TTL_MS = 300;
export const JOG_KEEPALIVE_MS = 100;
export const ACK_TIMEOUT_MS = 5000;
export const MAX_SUBSCRIPTIONS = 20;

// type -> cls, mirrors COMMAND_TABLE in §9.2.3.
export const COMMANDS = Object.freeze({
    'job.stop': 'stop',
    'jog.cont.stop': 'stop',
    'tier.dropMotion': 'stop',
    'spindle.off': 'stop',
    'job.pause': 'job',
    'job.resume': 'job',
    'feed.override': 'job',
    'job.load': 'motion',
    'job.start': 'motion',
    'jog.step': 'motion',
    'jog.cont.start': 'motion',
    'jog.cont.keepalive': 'motion',
    'zero': 'motion',
    'home': 'motion',
    'spindle.on': 'motion',
});

export function commandCls(type) {
    return Object.prototype.hasOwnProperty.call(COMMANDS, type) ? COMMANDS[type] : null;
}

export const T = Object.freeze({
    HELLO: 'hello',
    WELCOME: 'welcome',
    PING: 'ping',
    PONG: 'pong',
    ERROR: 'error',
    SUBSCRIBE: 'subscribe',
    SUBSCRIBED: 'subscribed',
    PRESENCE: 'presence',
    DEVICE_REMOVED: 'device.removed',
    REPORT_STATE: 'report.state',
    REPORT_TIER: 'report.tier',
    CMD: 'cmd',
    CMD_ACK: 'cmd.ack',
    FILE_STATUS: 'file.status',
    CAMERA_ERROR: 'camera.error',
});

export const CLOSE = Object.freeze({
    NORMAL: 1000,
    GOING_AWAY: 1001,
    PROTOCOL: 4400,
    AUTH: 4401,
    RATE_LIMITED: 4429,
});

export const MACHINE_STATES = Object.freeze([
    'disconnected', 'boot', 'idle', 'jogging', 'homing', 'running', 'paused', 'stopping', 'alarm',
]);

export const STATE_LABEL = Object.freeze({
    disconnected: 'Disconnected',
    boot: 'Booting',
    idle: 'Idle',
    jogging: 'Jogging',
    homing: 'Homing',
    running: 'Running',
    paused: 'Paused',
    stopping: 'Stopping',
    alarm: 'Alarm',
});

export const LOCK_TEXT = Object.freeze({
    'alarm': 'Machine in ALARM: only Stop is available. Clear the alarm at the machine.',
    'disconnected': 'Controller disconnected: only Stop is available.',
    'no-controller': 'No controller connected on the machine: only Stop is available.',
    'board-link-down': 'Machine lost its link to the controller board: only Stop is available.',
    'lan-only': 'The machine is in LAN-only mode: cloud commands are refused.',
    'host-busy': 'The machine computer is busy: only Stop is available for a moment.',
    'local-activity': 'Someone is using the machine screen: remote commands are paused for a few seconds.',
});

export const ERROR_TEXT = Object.freeze({
    // cmd.ack codes (§3.4.4)
    OK: 'Done',
    BAD_VERSION: 'Protocol mismatch; reload the page',
    BAD_ARGS: 'The machine refused the command parameters',
    UNKNOWN_COMMAND: 'The machine does not know this command',
    ENC_UNSUPPORTED: 'Encryption mode not supported',
    ACL_DENIED: 'Your access to this machine does not allow that',
    DEVICE_OFFLINE: 'The machine is offline',
    RATE_LIMITED: 'Too many commands; slow down',
    REPLAY: 'Command arrived out of order; try again',
    EXPIRED: 'Command arrived too late (slow connection); try again',
    TIER_REQUIRED: 'Not enabled on the machine screen',
    LOCKED: 'The machine is locked; only Stop is available',
    JOB_ACTIVE: 'A job is active',
    NO_JOB: 'No job is running',
    NOT_PAUSED: 'The job is not paused',
    NOT_RUNNING: 'The job is not running',
    NOT_IDLE: 'The machine is not idle',
    NO_FILE: 'No file is loaded, or the file is gone',
    FILE_CHANGED: 'The loaded file or work zero changed; check again',
    PAUSE_NOT_REMOTE: 'Resume on the machine (tool change / local pause)',
    REVIEW_REQUIRED: 'The operator must review this uploaded file on the machine first',
    BUSY: 'The machine is busy',
    LATENCY_TOO_HIGH: 'Connection too slow for motion',
    STALE_TELEMETRY: 'Machine status is out of date',
    JOG_ACTIVE: 'Another jog is active',
    NOT_SUPPORTED: 'Not supported on this controller',
    UNSUPPORTED_ON_CONTROLLER: 'Not supported on this controller',
    ENGINE_ERROR: 'The controller reported an error',
    INTERNAL: 'Something went wrong; try again',
    NOT_SYNCED: 'Still connecting; wait a moment',
    // REST error codes (§4.3)
    network: 'Cannot reach the relay; check your connection',
    invalid: 'Invalid request',
    invalid_credentials: 'Email or password is incorrect',
    locked: 'Too many attempts; try again later',
    rate_limited: 'Too many requests; try again later',
    csrf: 'Session check failed; reload the page',
    email_taken: 'An account with this email already exists',
    signup_closed: 'Sign-up is closed; ask the relay administrator for an account',
    invite_invalid: 'The invite code is not valid',
    code_invalid: 'That code is not valid or has expired. Check the code on the machine screen.',
    device_limit: 'You already have the maximum number of machines',
    not_found: 'Not found',
    user_not_found: 'No account exists with that email',
    offline: 'The machine is offline',
    bad_type: 'File type not allowed (.nc, .gcode, .ngc, .tap, .txt, .cnc)',
    hash_mismatch: 'Upload was corrupted in transit; try again',
    quota: 'Your storage quota on the relay is full',
    insufficient_storage: 'The relay is out of storage',
    busy: 'The relay is busy; try again',
    operator_required: 'Only possible on the machine screen',
    unauthorized: 'Please sign in',
    forbidden: 'Not allowed',
    registration_failed: 'Could not create the account. If you already have one, sign in instead.',
    invalid_email: 'Enter a valid email address',
    invalid_password: 'The password does not meet the requirements',
    invalid_display_name: 'Enter a valid display name',
    bad_request: 'Invalid request',
    bad_name: 'Enter a valid name',
    bad_role: 'Choose a valid access level',
    bad_count: 'Choose a valid number of invites',
    bad_expiry: 'Choose a valid invite expiry',
    is_owner: 'The owner’s access cannot be changed',
    cannot_disable_self: 'You cannot disable your own account',
    pairing_capacity: 'Too many machines are pairing right now; try again in a few minutes',
    too_large: 'File too large for the relay',
    empty: 'The file is empty',
    bad_sha256: 'Upload check failed; try again',
    length_required: 'Upload failed: the file size was not sent; try again',
    range_not_satisfiable: 'Download range not available',
    timeout: 'The request took too long; try again',
    incomplete: 'Upload was incomplete; try again',
    aborted: 'Upload was interrupted; try again',
    origin: 'Request blocked: open the app from the relay address',
    internal: 'Something went wrong on the relay; try again',
    protocol: 'Protocol mismatch; reload the page',
    shutting_down: 'The relay is restarting; try again shortly',
    unconfirmed: 'The machine is waiting for confirmation on its screen',
});

export const DEFERRED_HINT = Object.freeze({
    TIER_REQUIRED: 'Enable cloud Job control on the machine',
    BUSY: 'Machine is busy; delivery resumes when it is idle',
    DOWNLOAD_FAILED: 'Retrying delivery',
    LAN_ONLY: 'Machine is in LAN-only mode',
});

export const REJECT_TEXT = Object.freeze({
    HASH_MISMATCH: 'file damaged in transit',
    TOO_LARGE: 'file too large for the machine',
    BAD_TYPE: 'file type not allowed',
    NOT_UTF8: 'not a text G-code file',
    NO_SPACE: 'machine disk is full',
    INTERNAL: 'machine error',
});

export function errorText(code, message) {
    if (code && Object.prototype.hasOwnProperty.call(ERROR_TEXT, code)) {
        const base = ERROR_TEXT[code];
        if (code === 'TIER_REQUIRED' && message === 'motion') return 'Motion is not enabled on the machine screen';
        if (code === 'TIER_REQUIRED' && message === 'job') return 'Job control is not enabled on the machine screen';
        if (code === 'LOCKED' && message) return base + ' (' + message + ')';
        return base;
    }
    if (message && typeof message === 'string') return message;
    return code ? 'Error: ' + code : 'Something went wrong';
}

const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

function randomBytes(n) {
    const out = new Uint8Array(n);
    const c = globalThis.crypto;
    if (c && typeof c.getRandomValues === 'function') {
        c.getRandomValues(out);
    } else {
        for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
    }
    return out;
}

// prefix + 12 base36 chars; rejection sampling keeps the distribution uniform.
export function newId(prefix = 'm_') {
    let s = '';
    while (s.length < 12) {
        const bytes = randomBytes(16);
        for (let i = 0; i < bytes.length && s.length < 12; i++) {
            if (bytes[i] < 252) s += ID_ALPHABET[bytes[i] % 36];
        }
    }
    return prefix + s;
}

export function deviceIdFromTopic(topic) {
    if (typeof topic !== 'string') return null;
    const m = /^device\/([A-Za-z0-9_-]{1,40})\/(report|request)$/.exec(topic);
    return m ? m[1] : null;
}

export function requestTopic(deviceId) {
    return 'device/' + deviceId + '/request';
}
