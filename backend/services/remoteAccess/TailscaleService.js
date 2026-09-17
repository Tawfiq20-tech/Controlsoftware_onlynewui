/**
 * TailscaleService — read-only view of the Tailscale client on this PC, so
 * Settings can show a QR code for "control from anywhere" and warn about the
 * things that silently break it.
 *
 * Tailscale itself does the networking: phone and PC join the same private
 * tailnet (WireGuard, end-to-end encrypted, no public exposure, no port
 * forwarding). The backend already listens on 0.0.0.0, so it is reachable on
 * the PC's 100.x Tailscale address as soon as Tailscale is connected.
 *
 * What breaks remote access later, and is checked here:
 *  - node key expiry (180 days by default) → device drops off the tailnet
 *  - Windows "Run unattended" off → Tailscale disconnects when the user
 *    signs out of Windows
 *  - no inbound firewall rule for the port on the Tailscale adapter
 *
 * Deliberately NOT used: `tailscale serve` / `funnel`. Serve proxies from
 * localhost (every tailnet request would look like the operator, see
 * RemoteAccessService.isLoopback) and Funnel publishes to the internet.
 *
 * Every public method resolves; failures become a status, never a throw.
 */
const childProcess = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const STATUS_CACHE_MS = 5000;
const FIREWALL_CACHE_MS = 30000;
const CLI_RECHECK_MS = 60000;
const KEY_EXPIRY_WARN_MS = 30 * 24 * 60 * 60 * 1000;

const DOWNLOAD_URL = 'https://tailscale.com/download';
const ADMIN_MACHINES_URL = 'https://login.tailscale.com/admin/machines';

// Rule names created by scripts/enable-local-access.bat.
const FIREWALL_RULES = ['CNC Control Software Port 4000', 'CNC Control Software Runtime'];
const FIREWALL_SCRIPT = path.join(__dirname, '..', '..', '..', 'scripts', 'enable-local-access.bat');

function isTailscaleIPv4(ip) {
    if (!net.isIPv4(ip)) return false;
    const [o1, o2] = ip.split('.').map(Number);
    return o1 === 100 && o2 >= 64 && o2 <= 127;
}

function mapBackendState(state) {
    switch (state) {
        case 'Running': return 'running';
        case 'NeedsLogin':
        case 'NeedsMachineAuth': return 'needs-login';
        case 'Stopped': return 'stopped';
        case 'Starting':
        case 'NoState': return 'starting';
        default: return 'error';
    }
}

/** Pure: `tailscale status --json` → the shape the UI needs. */
function parseTailscaleStatus(json, port) {
    const self = (json && json.Self) || {};
    const ips = self.TailscaleIPs || json.TailscaleIPs || [];
    const ipv4 = ips.find((ip) => net.isIPv4(ip)) || null;
    const dnsName = String(self.DNSName || '').replace(/\.$/, '') || null;
    const tailnet = json.CurrentTailnet || null;
    const magicDns = !!(tailnet && tailnet.MagicDNSEnabled);
    const keyExpiry = self.KeyExpiry ? Date.parse(self.KeyExpiry) : NaN;
    const peers = Object.values(json.Peer || {}).map((p) => ({
        name: p.HostName || String(p.DNSName || '').split('.')[0] || 'device',
        os: p.OS || '',
        online: !!p.Online,
        ip: (p.TailscaleIPs || []).find((ip) => net.isIPv4(ip)) || null,
    }));

    return {
        installed: true,
        state: mapBackendState(json.BackendState),
        backendState: json.BackendState || null,
        version: json.Version || null,
        ipv4,
        dnsName,
        magicDns,
        tailnet: tailnet ? tailnet.Name || null : null,
        hostName: self.HostName || null,
        // KeyExpiry is omitted from the JSON when expiry is disabled.
        keyExpiry: Number.isFinite(keyExpiry) ? keyExpiry : null,
        authUrl: json.AuthURL || null,
        health: Array.isArray(json.Health) ? json.Health : [],
        peers,
        url: ipv4 ? `http://${ipv4}:${port}` : null,
        dnsUrl: dnsName && magicDns ? `http://${dnsName}:${port}` : null,
    };
}

/** Pure: status + environment checks → ordered, actionable warnings. */
function buildWarnings(status, { unattended = null, firewall = 'unknown', port, now = Date.now() } = {}) {
    const warnings = [];
    const add = (code, level, message, action) => warnings.push({ code, level, message, ...(action ? { action } : {}) });

    if (status.state === 'needs-login') {
        add('needs-login', 'error', 'Tailscale on this PC is signed out. Sign in so phones can reach the machine.',
            status.authUrl ? { label: 'Sign in to Tailscale', url: status.authUrl } : null);
    } else if (status.state === 'stopped') {
        add('stopped', 'error', 'Tailscale is installed but disconnected. Open Tailscale from the system tray and click Connect.');
    } else if (status.state === 'service-stopped') {
        add('service-stopped', 'error', 'The Tailscale service is not running on this PC. Start the Tailscale app (or the "Tailscale" Windows service).');
    }

    if (status.state === 'running') {
        if (status.keyExpiry != null) {
            const date = new Date(status.keyExpiry).toLocaleDateString();
            const adminAction = { label: 'Open Tailscale admin', url: ADMIN_MACHINES_URL };
            if (status.keyExpiry <= now) {
                add('key-expired', 'error', `This PC's Tailscale key expired on ${date}. Re-authenticate it, then disable key expiry for this machine.`, adminAction);
            } else if (status.keyExpiry - now < KEY_EXPIRY_WARN_MS) {
                add('key-expiring', 'warn', `This PC's Tailscale key expires on ${date}. Disable key expiry for this machine so remote access never drops.`, adminAction);
            } else {
                add('key-expiry-enabled', 'info', `This PC's Tailscale key expires on ${date}. For a machine that must stay reachable, disable key expiry for it.`, adminAction);
            }
        }
        if (unattended === false) {
            add('not-unattended', 'warn', 'Tailscale disconnects when you sign out of Windows. In the Tailscale tray menu, enable Preferences → Run unattended.');
        }
        if (!status.peers.some((p) => p.online)) {
            add('no-peers', 'info', 'No other devices are online in this tailnet yet. Install the Tailscale app on your phone and sign in with the same account.');
        }
        for (const message of status.health || []) {
            add('health', 'warn', `Tailscale reports: ${message}`);
        }
    }

    if (firewall === 'missing') {
        add('firewall', 'warn', `No Windows Firewall rule from this app allows port ${port}. If a phone can't open the page, allow it.`,
            { label: 'Allow through firewall', fix: 'firewall' });
    }
    return warnings;
}

class TailscaleService {
    constructor({ port, logger, execFile = childProcess.execFile, platform = process.platform, existsSync = fs.existsSync, env = process.env } = {}) {
        this.port = port;
        this.logger = logger;
        this.execFile = execFile;
        this.platform = platform;
        this.existsSync = existsSync;
        this.env = env;

        this._cli = undefined;       // string | null once resolved
        this._cliCheckedAt = 0;
        this._status = null;
        this._statusAt = 0;
        this._pending = null;
        this._firewall = null;
        this._firewallAt = 0;
    }

    /** Resolves { code, stdout, stderr }; never rejects. */
    _run(file, args, timeout) {
        return new Promise((resolve) => {
            try {
                this.execFile(file, args, { timeout, windowsHide: true, maxBuffer: 5 * 1024 * 1024 }, (err, stdout, stderr) => {
                    const code = err ? (typeof err.code === 'number' ? err.code : -1) : 0;
                    resolve({ code, stdout: String(stdout || ''), stderr: String(stderr || (err && err.message) || '') });
                });
            } catch (err) {
                resolve({ code: -1, stdout: '', stderr: err.message });
            }
        });
    }

    _cliCandidates() {
        if (this.platform === 'win32') {
            const dirs = [this.env.ProgramFiles, this.env['ProgramFiles(x86)'], 'C:\\Program Files'].filter(Boolean);
            return [...new Set(dirs.map((d) => path.win32.join(d, 'Tailscale', 'tailscale.exe')))];
        }
        if (this.platform === 'darwin') {
            return ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale'];
        }
        return ['/usr/bin/tailscale', '/usr/sbin/tailscale', '/usr/local/bin/tailscale'];
    }

    async _resolveCli() {
        const now = Date.now();
        if (this._cli || (this._cli === null && now - this._cliCheckedAt < CLI_RECHECK_MS)) return this._cli;
        this._cliCheckedAt = now;
        const found = this._cliCandidates().find((p) => {
            try { return this.existsSync(p); } catch (_) { return false; }
        });
        if (found) {
            this._cli = found;
            return found;
        }
        const onPath = await this._run('tailscale', ['version'], 4000);
        this._cli = onPath.code === 0 ? 'tailscale' : null;
        return this._cli;
    }

    /** A 100.64/10 address on any adapter (fallback when the CLI is missing). */
    _interfaceIp() {
        const nets = os.networkInterfaces();
        for (const name of Object.keys(nets)) {
            for (const addr of nets[name] || []) {
                if (!addr.internal && isTailscaleIPv4(addr.address)) return addr.address;
            }
        }
        return null;
    }

    async checkFirewall({ force = false } = {}) {
        if (this.platform !== 'win32') return 'not-applicable';
        const now = Date.now();
        if (!force && this._firewall && now - this._firewallAt < FIREWALL_CACHE_MS) return this._firewall;
        let result = 'missing';
        for (const rule of FIREWALL_RULES) {
            const r = await this._run('netsh', ['advfirewall', 'firewall', 'show', 'rule', `name=${rule}`], 5000);
            if (r.code === 0) { result = 'present'; break; }
            // netsh exits 1 for "No rules match"; anything else means we couldn't tell.
            if (r.code !== 1) result = 'unknown';
        }
        this._firewall = result;
        this._firewallAt = now;
        return result;
    }

    /** Opens the elevation (UAC) prompt for scripts/enable-local-access.bat. */
    async fixFirewall() {
        if (this.platform !== 'win32') return { ok: false, error: 'Only needed on Windows' };
        if (!this.existsSync(FIREWALL_SCRIPT)) return { ok: false, error: 'scripts/enable-local-access.bat is missing' };
        const script = FIREWALL_SCRIPT.replace(/'/g, "''");
        const r = await this._run('powershell.exe', ['-NoProfile', '-Command', `Start-Process -FilePath '${script}' -Verb RunAs`], 120000);
        this._firewall = null;
        if (r.code !== 0) {
            return { ok: false, error: /cancel/i.test(r.stderr) ? 'The administrator prompt was cancelled' : 'Could not start the firewall setup' };
        }
        return { ok: true };
    }

    async _unattended(cli) {
        if (this.platform !== 'win32') return null;
        const r = await this._run(cli, ['debug', 'prefs'], 5000);
        if (r.code !== 0) return null;
        try {
            const prefs = JSON.parse(r.stdout);
            return typeof prefs.ForceDaemon === 'boolean' ? prefs.ForceDaemon : null;
        } catch (_) {
            return null;
        }
    }

    async _collect() {
        const firewall = await this.checkFirewall();
        const cli = await this._resolveCli();

        if (!cli) {
            const ipv4 = this._interfaceIp();
            const status = {
                installed: false,
                state: 'not-installed',
                ipv4,
                url: ipv4 ? `http://${ipv4}:${this.port}` : null,
                dnsUrl: null,
                peers: [],
                downloadUrl: DOWNLOAD_URL,
            };
            return { ...status, firewall, warnings: buildWarnings(status, { firewall, port: this.port }) };
        }

        const raw = await this._run(cli, ['status', '--json'], 6000);
        let json = null;
        try { json = JSON.parse(raw.stdout); } catch (_) { json = null; }

        if (!json) {
            const serviceDown = /tailscaled|failed to connect|connection refused|not running/i.test(raw.stderr);
            const status = {
                installed: true,
                state: serviceDown ? 'service-stopped' : 'error',
                error: raw.stderr.trim().split('\n')[0] || 'Could not read Tailscale status',
                ipv4: this._interfaceIp(),
                url: null,
                dnsUrl: null,
                peers: [],
            };
            return { ...status, firewall, warnings: buildWarnings(status, { firewall, port: this.port }) };
        }

        const status = parseTailscaleStatus(json, this.port);
        const unattended = status.state === 'running' ? await this._unattended(cli) : null;
        return {
            ...status,
            unattended,
            firewall,
            adminUrl: ADMIN_MACHINES_URL,
            warnings: buildWarnings(status, { unattended, firewall, port: this.port }),
        };
    }

    async getStatus({ force = false } = {}) {
        const now = Date.now();
        if (!force && this._status && now - this._statusAt < STATUS_CACHE_MS) return this._status;
        if (this._pending) return this._pending;
        this._pending = this._collect()
            .catch((err) => ({ installed: false, state: 'error', error: err.message, peers: [], warnings: [] }))
            .then((status) => {
                if (this._status && this._status.state !== status.state && this.logger) {
                    this.logger.info(`[Tailscale] ${this._status.state} -> ${status.state}`);
                }
                this._status = status;
                this._statusAt = Date.now();
                this._pending = null;
                return status;
            });
        return this._pending;
    }

    /** This PC's tailnet names, for RemoteAccessService's own-hostname check. */
    getCachedHostnames() {
        const s = this._status;
        if (!s) return [];
        return [s.dnsName, s.dnsName && s.dnsName.split('.')[0], s.hostName].filter(Boolean);
    }
}

module.exports = { TailscaleService, parseTailscaleStatus, buildWarnings, mapBackendState };
