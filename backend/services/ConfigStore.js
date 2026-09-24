/**
 * ConfigStore - Persistent JSON configuration storage.
 *
 * Stores:
 *   - User preferences
 *   - Machine profiles
 *   - Macros
 *   - Event triggers
 *   - Work coordinate offsets
 *   - Tool library
 *
 * Data is saved to a JSON file on disk and loaded on startup.
 * Writes are debounced to avoid excessive disk I/O.
 *
 * Reference: gSender configstore concept
 */
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const logger = require('../logger');

const SAVE_DEBOUNCE_MS = 1000;

/** Default machine profiles shown when none are saved. */
const DEFAULT_MACHINE_PROFILES = [
    {
        id: 'onefinity-journeyman',
        name: 'Onefinity Journeyman',
        voltage: '24 V',
        workArea: '406×305×102 mm (16×12×4 in)',
        maxFeed: '3000 mm/min',
        spindle: 'Router / 1.5 kW',
        controller: 'GRBL / grblHAL',
        notes: 'NEMA 23, ball screws',
    },
    {
        id: 'onefinity-elite',
        name: 'Onefinity Elite',
        voltage: '48 V',
        workArea: '609×406×102 mm (24×16×4 in)',
        maxFeed: '4000 mm/min',
        spindle: 'Router / 2.2 kW',
        controller: 'GRBL / grblHAL',
        notes: 'NEMA 23, ball screws',
    },
    {
        id: 'generic-3018',
        name: 'Generic 3018',
        voltage: '12–24 V',
        workArea: '300×180×45 mm',
        maxFeed: '1000 mm/min',
        spindle: 'Spindle / 200 W or Laser',
        controller: 'GRBL',
        notes: 'Common 3018 CNC',
    },
    {
        id: 'custom',
        name: 'Custom',
        voltage: '',
        workArea: '',
        maxFeed: '',
        spindle: '',
        controller: '',
        notes: 'User-defined machine',
    },
];

const DEFAULT_CONFIG = {
    macros: [],
    eventTriggers: {},
    toolLibrary: [],
    preferences: {
        units: 'mm',
        jogSpeed: 1000,
        jogDistance: 1,
        safeHeight: 10,
        probeFeedrate: 100,
        spindleDelay: 0,
        reconnectAutomatically: false,
        firmwareFallback: 'grblHAL',
        baudRate: 115200,
        runCheckOnFileLoad: false,
        outlineStyle: 'Detailed',
    },
    ethernet: {
        connectToIP: '192.168.5.1',
    },
    probeSettings: {
        touchPlateType: 'Standard Block',
        blockThickness: 15,
        // Corner block X/Y retract/offset: 20mm
        xyThickness: 20,
        zProbeDistance: 30,
        fastFind: 150,
        slowFind: 75,
        retraction: 2,
        traverseFeed: 2500,
        finalizeZFeed: 1500,
        finalizeXYFeed: 2500,
        // xyz-corner probe geometry (ProbingService.js _runRSP) -- split out
        // from blockThickness/xyThickness formulas per msg11454's exact
        // spec, so future tuning is a config change, not a code ship.
        zRetract: 11.5,
        xyReposition: 67,
        zDrop: 19,
        zRetractX: 3.0,
        xyRepositionX: 70.0,
        zDropX: 20.0,
        zRetractY: 20.0,
        xyRepositionY: 64.0,
        zDropY: 18.0,
        parkZClearance: 10,
        connectionTest: true,
        // FIX-7: Z-only retreat distance applied automatically after any
        // failed probe leg (no contact, rejected status, timeout, or link
        // loss) in ProbingService.js's RSP-native routines, so the bit
        // doesn't sit wherever the failed leg stopped -- often near/in the
        // stock right after a "drop Z below top surface" step.
        probeFailRetractMm: 5,
    },
    machineProfiles: [],
    activeMachineProfile: null,
    wcsOffsets: {},
};

class ConfigStore extends EventEmitter {
    /**
     * @param {string} configPath - Path to the config JSON file
     */
    constructor(configPath) {
        super();

        this.configPath = configPath;
        this.data = {};
        this._saveTimer = null;

        this._load();
    }

    /**
     * Load config from disk, merging with defaults.
     * @private
     */
    _load() {
        try {
            if (fs.existsSync(this.configPath)) {
                let parsed;
                try {
                    parsed = JSON.parse(fs.readFileSync(this.configPath, 'utf-8'));
                } catch (parseErr) {
                    // A power cut during the old non-atomic write left a
                    // truncated file here, and this used to fall through to
                    // "start from DEFAULT_CONFIG" silently -- machine profiles,
                    // wcsOffsets, the whole hand-tuned probeSettings block, the
                    // tool library and macros gone. The next set() then wrote
                    // those defaults over the damaged file, making it permanent.
                    parsed = this._recoverFromBackup(parseErr);
                }
                this.data = this._deepMerge(DEFAULT_CONFIG, parsed);
            } else {
                // First boot on a freshly flashed machine. The image no longer
                // carries the build PC's own config.json (it held that PC's
                // remote-diagnostics URL and token, its bot settings and its
                // probe geometry, identical on every machine flashed from it),
                // so seed from the scrubbed factory file beside it.
                this.data = { ...DEFAULT_CONFIG };
                const seed = path.join(path.dirname(this.configPath), 'config.default.json');
                try {
                    if (fs.existsSync(seed)) {
                        this.data = this._deepMerge(DEFAULT_CONFIG, JSON.parse(fs.readFileSync(seed, 'utf-8')));
                        logger.info(`[Config] first boot: seeded settings from ${seed}`);
                    }
                } catch (seedErr) {
                    logger.warn(`[Config] could not read ${seed}: ${seedErr && seedErr.message}; using built-in defaults`);
                }
                this._saveImmediate();
            }
            // Seed default machine profiles if none saved
            const profiles = this.data.machineProfiles || [];
            if (!Array.isArray(profiles) || profiles.length === 0) {
                this.data.machineProfiles = DEFAULT_MACHINE_PROFILES.map((p) => ({ ...p }));
                if (this.data.activeMachineProfile == null) {
                    this.data.activeMachineProfile = DEFAULT_MACHINE_PROFILES[0].id;
                }
                this._saveImmediate();
            }
        } catch (err) {
            logger.error(`[Config] ${this.configPath} could not be read (${err && err.message}); running on built-in defaults. The file on disk has NOT been overwritten.`);
            this.data = { ...DEFAULT_CONFIG };
        }
    }

    /**
     * A damaged config.json: move it aside (never delete it) and fall back to
     * the .bak written before every save. Returns the parsed backup, or {}.
     * @private
     */
    _recoverFromBackup(parseErr) {
        logger.error(`[Config] ${this.configPath} is damaged: ${parseErr && parseErr.message}`);
        const damaged = `${this.configPath}.damaged-${Date.now()}`;
        try {
            fs.renameSync(this.configPath, damaged);
            logger.error(`[Config] the damaged file was kept as ${damaged}`);
        } catch (_) { /* best effort -- keep going either way */ }
        const backup = `${this.configPath}.bak`;
        try {
            if (fs.existsSync(backup)) {
                const parsed = JSON.parse(fs.readFileSync(backup, 'utf-8'));
                logger.error(`[Config] recovered the previous good settings from ${backup}`);
                this.recoveredFromBackup = true;
                return parsed;
            }
        } catch (bakErr) {
            logger.error(`[Config] ${backup} is unusable too: ${bakErr && bakErr.message}`);
        }
        this.settingsLost = true;
        logger.error('[Config] no usable backup -- starting from built-in defaults.');
        return {};
    }

    /**
     * Reject a key path that would reach Object.prototype. POST /api/config
     * takes the key straight from the request body, and a walk through
     * '__proto__' assigned onto Object.prototype -- after which get(), which
     * used plain property access, served that value for EVERY unset setting in
     * the backend (remoteDiagEnabled true on a fresh machine, with nothing
     * written to config.json to show it).
     * @private
     */
    static _safeParts(key) {
        const parts = String(key).split('.');
        for (const part of parts) {
            if (part === '__proto__' || part === 'constructor' || part === 'prototype') return null;
        }
        return parts;
    }

    /**
     * Get a value by dot-separated key path.
     * @param {string} key - e.g. 'preferences.units' or 'macros'
     * @param {*} [defaultValue]
     * @returns {*}
     */
    get(key, defaultValue) {
        const parts = ConfigStore._safeParts(key);
        if (!parts) return defaultValue;
        let current = this.data;

        for (const part of parts) {
            if (current == null || typeof current !== 'object') {
                return defaultValue;
            }
            // Own properties only: an inherited value -- from a polluted
            // Object.prototype, or just a built-in like 'constructor' -- must
            // never be served as this machine's setting.
            current = Object.prototype.hasOwnProperty.call(current, part) ? current[part] : undefined;
        }

        return current !== undefined ? current : defaultValue;
    }

    /**
     * Set a value by dot-separated key path.
     * @param {string} key
     * @param {*} value
     */
    set(key, value) {
        const parts = ConfigStore._safeParts(key);
        if (!parts) {
            logger.warn(`[Config] refusing to write the unsafe key path "${String(key).slice(0, 80)}"`);
            return;
        }
        let current = this.data;

        for (let i = 0; i < parts.length - 1; i++) {
            if (!Object.prototype.hasOwnProperty.call(current, parts[i])
                || current[parts[i]] == null || typeof current[parts[i]] !== 'object') {
                current[parts[i]] = {};
            }
            current = current[parts[i]];
        }

        current[parts[parts.length - 1]] = value;
        this._scheduleSave();
        this.emit('change', key, value);
    }

    /**
     * Delete a key.
     * @param {string} key
     */
    delete(key) {
        const parts = ConfigStore._safeParts(key);
        if (!parts) {
            logger.warn(`[Config] refusing to delete the unsafe key path "${String(key).slice(0, 80)}"`);
            return;
        }
        let current = this.data;

        for (let i = 0; i < parts.length - 1; i++) {
            if (!Object.prototype.hasOwnProperty.call(current, parts[i]) || current[parts[i]] == null) return;
            current = current[parts[i]];
        }

        delete current[parts[parts.length - 1]];
        this._scheduleSave();
        this.emit('change', key, undefined);
    }

    /**
     * Get the entire config object.
     * @returns {object}
     */
    getAll() {
        return { ...this.data };
    }

    // ─── Macro Helpers ───────────────────────────────────────────

    /**
     * Get all macros.
     * @returns {Array<{id: string, name: string, content: string}>}
     */
    getMacros() {
        return this.get('macros', []);
    }

    /**
     * Add or update a macro.
     * @param {{ id: string, name: string, content: string }} macro
     */
    saveMacro(macro) {
        const macros = this.getMacros();
        const idx = macros.findIndex((m) => m.id === macro.id);
        if (idx >= 0) {
            macros[idx] = { ...macros[idx], ...macro };
        } else {
            macros.push({
                id: macro.id || `macro-${Date.now()}`,
                name: macro.name || 'Untitled',
                content: macro.content || '',
                createdAt: Date.now(),
            });
        }
        this.set('macros', macros);
    }

    /**
     * Delete a macro by ID.
     * @param {string} id
     */
    deleteMacro(id) {
        const macros = this.getMacros().filter((m) => m.id !== id);
        this.set('macros', macros);
    }

    /**
     * Get a macro by ID.
     * @param {string} id
     * @returns {object|null}
     */
    getMacro(id) {
        return this.getMacros().find((m) => m.id === id) || null;
    }

    // ─── Tool Library Helpers ────────────────────────────────────

    /**
     * Get all tools.
     * @returns {Array<{id: string, name: string, number: number, diameter: number, length: number}>}
     */
    getTools() {
        return this.get('toolLibrary', []);
    }

    /**
     * Add or update a tool.
     * @param {object} tool
     */
    saveTool(tool) {
        const tools = this.getTools();
        const idx = tools.findIndex((t) => t.id === tool.id);
        if (idx >= 0) {
            tools[idx] = { ...tools[idx], ...tool };
        } else {
            tools.push({
                id: tool.id || `tool-${Date.now()}`,
                name: tool.name || 'Untitled',
                number: tool.number || 0,
                diameter: tool.diameter || 0,
                length: tool.length || 0,
            });
        }
        this.set('toolLibrary', tools);
    }

    /**
     * Delete a tool by ID.
     * @param {string} id
     */
    deleteTool(id) {
        const tools = this.getTools().filter((t) => t.id !== id);
        this.set('toolLibrary', tools);
    }

    // ─── Machine Profile Helpers ─────────────────────────────────

    /**
     * Get all machine profiles.
     * @returns {Array<{id: string, name: string, voltage?: string, workArea?: string, maxFeed?: string, spindle?: string, controller?: string, notes?: string}>}
     */
    getMachineProfiles() {
        const profiles = this.get('machineProfiles', []);
        return Array.isArray(profiles) ? [...profiles] : [];
    }

    /**
     * Get the active machine profile ID.
     * @returns {string|null}
     */
    getActiveMachineProfile() {
        return this.get('activeMachineProfile', null);
    }

    /**
     * Set the active machine profile by ID.
     * @param {string|null} id - Profile ID or null to clear
     */
    setActiveMachineProfile(id) {
        this.set('activeMachineProfile', id);
    }

    /**
     * Add or update a machine profile.
     * @param {{ id?: string, name: string, voltage?: string, workArea?: string, maxFeed?: string, spindle?: string, controller?: string, notes?: string }} profile
     */
    saveMachineProfile(profile) {
        const profiles = this.getMachineProfiles();
        const id = profile.id || `machine-${Date.now()}`;
        const entry = {
            id,
            name: profile.name || 'Untitled',
            voltage: profile.voltage ?? '',
            workArea: profile.workArea ?? '',
            maxFeed: profile.maxFeed ?? '',
            spindle: profile.spindle ?? '',
            controller: profile.controller ?? '',
            notes: profile.notes ?? '',
        };
        const idx = profiles.findIndex((p) => p.id === id);
        if (idx >= 0) {
            profiles[idx] = { ...profiles[idx], ...entry };
        } else {
            profiles.push(entry);
        }
        this.set('machineProfiles', profiles);
    }

    // ─── Persistence ─────────────────────────────────────────────

    /** @private */
    _scheduleSave() {
        if (this._saveTimer) clearTimeout(this._saveTimer);
        this._saveTimer = setTimeout(() => this._saveImmediate(), SAVE_DEBOUNCE_MS);
    }

    /** @private */
    _saveImmediate() {
        try {
            const dir = path.dirname(this.configPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            const json = JSON.stringify(this.data, null, 2);
            // Operators switch this appliance off at the wall. An in-place
            // writeFileSync leaves a truncated config.json if the power goes
            // during it, and the whole machine configuration is then lost.
            // Keep the last good file, then write-and-rename so config.json is
            // only ever a complete document.
            const tmp = `${this.configPath}.tmp`;
            const bak = `${this.configPath}.bak`;
            try {
                if (fs.existsSync(this.configPath)) fs.copyFileSync(this.configPath, bak);
            } catch (_) { /* a missing backup must not stop the save */ }
            const fd = fs.openSync(tmp, 'w');
            try {
                fs.writeFileSync(fd, json, 'utf-8');
                fs.fsyncSync(fd);
            } finally {
                fs.closeSync(fd);
            }
            fs.renameSync(tmp, this.configPath);
        } catch (err) {
            this.emit('error', err);
        }
    }

    /** Force an immediate save. */
    flush() {
        if (this._saveTimer) {
            clearTimeout(this._saveTimer);
            this._saveTimer = null;
        }
        this._saveImmediate();
    }

    // ─── Utilities ───────────────────────────────────────────────

    /** @private */
    _deepMerge(target, source) {
        const result = { ...target };
        for (const key of Object.keys(source)) {
            // JSON.parse('{"__proto__":{...}}') makes __proto__ an OWN key, and
            // plain assignment below would then run the prototype setter. A
            // hand-edited or tampered config.json must not be able to do that.
            if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
            if (
                source[key] &&
                typeof source[key] === 'object' &&
                !Array.isArray(source[key]) &&
                target[key] &&
                typeof target[key] === 'object' &&
                !Array.isArray(target[key])
            ) {
                result[key] = this._deepMerge(target[key], source[key]);
            } else {
                result[key] = source[key];
            }
        }
        return result;
    }
}

module.exports = { ConfigStore, DEFAULT_CONFIG };
