/**
 * WifiService — joins the machine to a Wi-Fi network from the touchscreen.
 *
 * The kiosk is headless: there is no desktop, no terminal and no way to pick a
 * network when it is moved to a new shop. This drives NetworkManager through
 * `nmcli`, which is what Raspberry Pi OS (Bookworm) uses.
 *
 * The password never goes on a command line. `nmcli --ask` prompts on stdin,
 * so the secret is written to the child's stdin instead of argv, where any
 * local process could read it out of /proc/<pid>/cmdline.
 *
 * Every method resolves. A missing nmcli, a denied polkit action or a timeout
 * all come back as a result object with `ok: false` and something the operator
 * can act on -- nothing here throws into a request handler.
 *
 * Off Linux (the Windows control PC) the OS owns its own Wi-Fi, so the service
 * reports `supported: false` and the UI says so rather than showing dead
 * controls.
 */
const childProcess = require('child_process');

const SCAN_TIMEOUT_MS = 20000;
const CONNECT_TIMEOUT_MS = 45000;
const QUICK_TIMEOUT_MS = 8000;
/** nmcli's own connect budget, kept under CONNECT_TIMEOUT_MS. */
const NMCLI_WAIT_S = 30;

/** nmcli -t escapes ':' and '\' inside fields; undo that before splitting. */
function splitTerse(line) {
    const fields = [];
    let current = '';
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '\\' && i + 1 < line.length) {
            current += line[i + 1];
            i++;
        } else if (ch === ':') {
            fields.push(current);
            current = '';
        } else {
            current += ch;
        }
    }
    fields.push(current);
    return fields;
}

/** Map nmcli's stderr onto something an operator can act on. */
function explain(stderr, fallback) {
    const text = String(stderr || '').toLowerCase();
    if (text.includes('secrets were required') || text.includes('no secrets provided')) {
        return 'Wrong password for this network.';
    }
    if (text.includes('not authorized') || text.includes('access denied') || text.includes('permission')) {
        return 'This machine is not allowed to change Wi-Fi settings. Reinstall the kiosk package to add the permission rule.';
    }
    if (text.includes('no network with ssid') || text.includes('not found')) {
        return 'That network is no longer in range.';
    }
    if (text.includes('timeout') || text.includes('timed out')) {
        return 'The network did not respond in time. Move closer to the router and try again.';
    }
    return fallback;
}

class WifiService {
    /**
     * @param {object}   [opts]
     * @param {object}   [opts.logger]
     * @param {string}   [opts.platform]  process.platform override (tests)
     * @param {Function} [opts.execFile]  childProcess.execFile override (tests)
     * @param {Function} [opts.spawn]     childProcess.spawn override (tests)
     */
    constructor({ logger = console, platform = process.platform, execFile, spawn } = {}) {
        this._log = logger;
        this._platform = platform;
        this._execFile = execFile || childProcess.execFile;
        this._spawn = spawn || childProcess.spawn;
        this._nmcliMissing = false;
    }

    get supported() {
        return this._platform === 'linux';
    }

    /** Run nmcli and resolve { ok, stdout, stderr }. Never rejects. */
    _nmcli(args, { timeout = QUICK_TIMEOUT_MS } = {}) {
        return new Promise((resolve) => {
            let settled = false;
            const done = (result) => {
                if (settled) return;
                settled = true;
                resolve(result);
            };
            try {
                this._execFile('nmcli', args, { timeout, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
                    if (err && (err.code === 'ENOENT' || /not recognized|not found/i.test(String(err.message)))) {
                        this._nmcliMissing = true;
                        return done({ ok: false, missing: true, stdout: '', stderr: 'nmcli not installed' });
                    }
                    done({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || (err && err.message) || '') });
                });
            } catch (exc) {
                done({ ok: false, stdout: '', stderr: (exc && exc.message) || String(exc) });
            }
        });
    }

    /** Wi-Fi radio state, the joined network, and the addresses we are reachable on. */
    async getStatus() {
        if (!this.supported) {
            return {
                supported: false,
                reason: 'This computer manages its own Wi-Fi. Use the operating system’s network settings.',
            };
        }

        const devices = await this._nmcli(['-t', '-f', 'DEVICE,TYPE,STATE,CONNECTION', 'device', 'status']);
        if (devices.missing) {
            return {
                supported: false,
                reason: 'NetworkManager (nmcli) is not installed on this machine, so Wi-Fi cannot be set up here.',
            };
        }

        let wifi = null;
        let ethernet = null;
        for (const line of devices.stdout.split('\n')) {
            if (!line.trim()) continue;
            const [device, type, state, connection] = splitTerse(line);
            const up = state === 'connected';
            if (type === 'wifi' && !wifi) {
                wifi = { device, state, up, ssid: up ? connection : null };
            } else if (type === 'ethernet' && !ethernet) {
                ethernet = { device, up, connection: up ? connection : null };
            }
        }

        const radio = await this._nmcli(['-t', 'radio', 'wifi']);
        const radioOn = radio.ok && radio.stdout.trim() === 'enabled';

        let signal = null;
        let security = null;
        if (wifi && wifi.up) {
            const active = await this._nmcli(['-t', '-f', 'IN-USE,SIGNAL,SECURITY', 'device', 'wifi', 'list']);
            for (const line of active.stdout.split('\n')) {
                const [inUse, sig, sec] = splitTerse(line);
                if (inUse === '*') {
                    signal = Number(sig) || null;
                    security = sec || 'Open';
                    break;
                }
            }
        }

        return {
            supported: true,
            radioOn,
            hasAdapter: !!wifi,
            device: wifi ? wifi.device : null,
            connected: wifi && wifi.up ? { ssid: wifi.ssid, signal, security } : null,
            ethernet: ethernet ? { connected: ethernet.up, name: ethernet.connection } : null,
            addresses: await this._addresses(),
        };
    }

    /** IPv4 addresses NetworkManager currently has, for "reach it at" hints. */
    async _addresses() {
        const out = await this._nmcli(['-t', '-f', 'IP4.ADDRESS', 'device', 'show']);
        if (!out.ok) return [];
        const ips = [];
        for (const line of out.stdout.split('\n')) {
            const match = /^IP4\.ADDRESS\[\d+\]:(.+)$/.exec(line.trim());
            if (match) ips.push(match[1].split('/')[0]);
        }
        return ips;
    }

    /** Networks in range, strongest first, with the saved ones marked. */
    async scan({ rescan = true } = {}) {
        if (!this.supported) return { ok: false, error: 'Wi-Fi setup is not available on this computer.', networks: [] };

        const list = await this._nmcli(
            ['-t', '-f', 'IN-USE,SSID,SIGNAL,SECURITY', 'device', 'wifi', 'list', '--rescan', rescan ? 'yes' : 'no'],
            { timeout: SCAN_TIMEOUT_MS },
        );
        if (!list.ok) {
            return {
                ok: false,
                error: explain(list.stderr, 'Could not scan for networks.'),
                networks: [],
            };
        }

        const saved = await this._savedSsids();
        const bySsid = new Map();
        for (const line of list.stdout.split('\n')) {
            if (!line.trim()) continue;
            const [inUse, ssid, signal, security] = splitTerse(line);
            if (!ssid) continue; // hidden networks report an empty SSID
            const entry = {
                ssid,
                signal: Number(signal) || 0,
                security: security && security !== '' ? security : 'Open',
                open: !security || security === '',
                inUse: inUse === '*',
                saved: saved.has(ssid),
            };
            // The same SSID shows up once per band/AP; keep the strongest.
            const prev = bySsid.get(ssid);
            if (!prev || entry.signal > prev.signal) bySsid.set(ssid, { ...entry, inUse: entry.inUse || !!(prev && prev.inUse) });
        }

        const networks = [...bySsid.values()].sort((a, b) => {
            if (a.inUse !== b.inUse) return a.inUse ? -1 : 1;
            return b.signal - a.signal;
        });
        return { ok: true, networks };
    }

    async _savedSsids() {
        const out = await this._nmcli(['-t', '-f', 'NAME,TYPE', 'connection', 'show']);
        const names = new Set();
        if (!out.ok) return names;
        for (const line of out.stdout.split('\n')) {
            const [name, type] = splitTerse(line);
            if (type && type.includes('wireless') && name) names.add(name);
        }
        return names;
    }

    /**
     * Join a network. An already-saved network reconnects without a password.
     * Resolves { ok } or { ok: false, error }.
     */
    async connect({ ssid, password = '', hidden = false } = {}) {
        if (!this.supported) return { ok: false, error: 'Wi-Fi setup is not available on this computer.' };
        const name = String(ssid || '').trim();
        if (!name) return { ok: false, error: 'Pick a network first.' };
        if (password && password.length < 8) {
            // WPA-PSK minimum; catching it here beats a slow, vague nmcli failure.
            return { ok: false, error: 'Wi-Fi passwords are at least 8 characters.' };
        }

        const args = ['--wait', String(NMCLI_WAIT_S), 'device', 'wifi', 'connect', name];
        if (hidden) args.push('hidden', 'yes');
        if (password) args.unshift('--ask');

        const result = await this._run(args, password ? `${password}\n` : null, CONNECT_TIMEOUT_MS);
        if (result.ok) {
            this._log.info?.(`[Wifi] joined "${name}"`);
            return { ok: true, ssid: name };
        }
        this._log.warn?.(`[Wifi] could not join "${name}": ${result.stderr.trim()}`);
        return { ok: false, error: explain(result.stderr, `Could not connect to "${name}".`) };
    }

    /** Spawn nmcli, optionally feeding a secret on stdin, never on argv. */
    _run(args, stdin, timeout) {
        return new Promise((resolve) => {
            let child;
            try {
                child = this._spawn('nmcli', args, { stdio: ['pipe', 'pipe', 'pipe'] });
            } catch (exc) {
                return resolve({ ok: false, stdout: '', stderr: (exc && exc.message) || String(exc) });
            }

            let stdout = '';
            let stderr = '';
            let settled = false;
            const done = (result) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(result);
            };
            // Deliberately not unref'd: this timer is the only thing that
            // guarantees the caller gets an answer, so it has to be allowed
            // to fire rather than letting the process idle out first.
            const timer = setTimeout(() => {
                try { child.kill('SIGTERM'); } catch (_) { /* already gone */ }
                done({ ok: false, stdout, stderr: stderr || 'timed out' });
            }, timeout);

            child.stdout?.on('data', (d) => { stdout += d; });
            child.stderr?.on('data', (d) => { stderr += d; });
            child.on('error', (err) => done({ ok: false, stdout, stderr: (err && err.message) || String(err) }));
            child.on('close', (code) => done({ ok: code === 0, stdout, stderr }));

            if (stdin !== null && child.stdin) {
                try {
                    child.stdin.end(stdin);
                } catch (_) {
                    /* nmcli exited before reading the prompt */
                }
            } else if (child.stdin) {
                try { child.stdin.end(); } catch (_) { /* ignore */ }
            }
        });
    }

    async disconnect() {
        if (!this.supported) return { ok: false, error: 'Wi-Fi setup is not available on this computer.' };
        const status = await this.getStatus();
        if (!status.device) return { ok: false, error: 'No Wi-Fi adapter on this machine.' };
        const out = await this._nmcli(['device', 'disconnect', status.device], { timeout: CONNECT_TIMEOUT_MS });
        return out.ok ? { ok: true } : { ok: false, error: explain(out.stderr, 'Could not disconnect.') };
    }

    /** Delete a saved network so it stops being joined automatically. */
    async forget(ssid) {
        if (!this.supported) return { ok: false, error: 'Wi-Fi setup is not available on this computer.' };
        const name = String(ssid || '').trim();
        if (!name) return { ok: false, error: 'Pick a network first.' };
        const out = await this._nmcli(['connection', 'delete', 'id', name]);
        return out.ok ? { ok: true } : { ok: false, error: explain(out.stderr, `Could not forget "${name}".`) };
    }

    async setRadio(on) {
        if (!this.supported) return { ok: false, error: 'Wi-Fi setup is not available on this computer.' };
        const out = await this._nmcli(['radio', 'wifi', on ? 'on' : 'off']);
        return out.ok ? { ok: true, radioOn: !!on } : { ok: false, error: explain(out.stderr, 'Could not switch the Wi-Fi radio.') };
    }
}

module.exports = { WifiService, splitTerse, explain };
