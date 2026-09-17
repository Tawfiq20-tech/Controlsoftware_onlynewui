/**
 * What of the main ConfigStore (backend/data/config.json) may leave the
 * machine's own screen, and which config writes are operator-only.
 *
 * config.json holds secrets next to harmless UI preferences: telegram.token,
 * whatsapp recipients, IP-camera URLs (often with credentials), and the
 * RemoteDiag URL/token. Spec 7.4 closes GET /api/config to LAN for exactly
 * that reason, so the Socket.IO pushes (config:all, config:change) must not
 * hand the same object to LAN sockets either.
 *
 * Writes: a 'local' identity keeps local machine control (D1) but may not
 * open an internet control channel that bypasses RemoteCommandGate
 * (RemoteDiag inject flag/URL/token, Telegram/WhatsApp bot settings); those
 * keys are operator-only.
 */

// Top-level keys a non-local socket may see (what the phone UI reads).
const PUBLIC_TOP_LEVEL_KEYS = Object.freeze([
    'machineProfiles', 'activeMachineProfile', 'ethernet', 'probeSettings', 'preferences', 'wcsOffsets',
]);

// Never public, even inside an allowed block.
const SECRET_PREF_KEY = /^remoteDiag|token|secret|password|passwd|apikey|api_key/i;

// Config writes only the operator may make.
const OPERATOR_ONLY_TOP_LEVEL = Object.freeze(['telegram', 'whatsapp', 'remoteAccess']);

function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

function redactPreferences(prefs) {
    if (!isPlainObject(prefs)) return prefs;
    const out = {};
    for (const [k, v] of Object.entries(prefs)) {
        if (SECRET_PREF_KEY.test(k)) continue;
        out[k] = v;
    }
    return out;
}

/** A copy of the whole config with only the public parts. */
function publicConfigView(all) {
    const src = isPlainObject(all) ? all : {};
    const out = {};
    for (const key of PUBLIC_TOP_LEVEL_KEYS) {
        if (!(key in src)) continue;
        out[key] = key === 'preferences' ? redactPreferences(src[key]) : src[key];
    }
    return out;
}

function splitKey(key) {
    return String(key == null ? '' : key).split('.').filter((p) => p !== '');
}

/**
 * The public form of a config:change, or null when nothing of it is public.
 * @returns {{key:string, value:any} | null}
 */
function publicConfigChange(key, value) {
    const parts = splitKey(key);
    if (parts.length === 0) return null;
    const [top, ...rest] = parts;
    if (!PUBLIC_TOP_LEVEL_KEYS.includes(top)) return null;
    if (top === 'preferences') {
        if (rest.length === 0) return { key: String(key), value: redactPreferences(value) };
        if (SECRET_PREF_KEY.test(rest[0])) return null;
    }
    return { key: String(key), value };
}

/**
 * True when writing `key` (with `value`) can open or retarget a remote control channel or change remote-access state. */
function isOperatorOnlyConfigWrite(key, value, currentPreferences = null) {
    const parts = splitKey(key);
    // An empty or root key would replace everything.
    if (parts.length === 0) return true;
    const [top, sub] = parts;
    if (OPERATOR_ONLY_TOP_LEVEL.includes(top)) return true;
    if (top === 'preferences') {
        if (sub === undefined) {
            // A whole-preferences write is fine unless it carries RemoteDiag keys.
            if (!isPlainObject(value)) return true;
            const cur = isPlainObject(currentPreferences) ? currentPreferences : {};
            return Object.keys(value).some((k) => /^remoteDiag/i.test(k) && JSON.stringify(value[k]) !== JSON.stringify(cur[k]));
        }
        return /^remoteDiag/i.test(sub);
    }
    return false;
}

module.exports = Object.freeze({
    PUBLIC_TOP_LEVEL_KEYS,
    OPERATOR_ONLY_TOP_LEVEL,
    publicConfigView,
    publicConfigChange,
    isOperatorOnlyConfigWrite,
});
