/**
 * FirmwareSettings.tsx — EEPROM / Firmware Settings Editor
 *
 * Reads all GRBL settings via the $$ command, displays them in categorized
 * sections, allows inline editing (saves via $X=value), import/export,
 * and restore-defaults.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import {
    Download, Upload, RotateCcw, RefreshCw, Search, Filter,
    ChevronDown, Check, X, Save, Cpu,
} from 'lucide-react';
import { useCNCStore } from '../stores/cncStore';
import { sendBackendCommand, backendReadEEPROM } from '../utils/backendConnection';
import './FirmwareSettings.css';

// ─── GRBL Setting Definitions ─────────────────────────────────────────────────

export interface GRBLSettingDef {
    id: number;
    name: string;
    description: string;
    unit?: string;
    category: string;
    defaultValue: number | string;
}

export const GRBL_SETTING_DEFS: GRBLSettingDef[] = [
    // ── Step Pulse & Timing ────────────────────────────
    { id: 0,  name: 'Step Pulse Time',         description: 'Duration of step signal pulse in microseconds.',               unit: 'µs',    category: 'Motors',  defaultValue: 10 },
    { id: 1,  name: 'Step Idle Delay',         description: 'Time to keep motors energized after motion stops.',             unit: 'ms',    category: 'Motors',  defaultValue: 25 },
    { id: 2,  name: 'Step Pulse Invert',       description: 'Bitmask to invert step signal polarity per axis (X=1,Y=2,Z=4).', unit: 'mask', category: 'Motors',  defaultValue: 0 },
    { id: 3,  name: 'Step Dir Invert',         description: 'Bitmask to invert direction signal per axis (X=1,Y=2,Z=4).',   unit: 'mask',  category: 'Motors',  defaultValue: 0 },
    { id: 4,  name: 'Invert Step Enable Pin',  description: 'Invert the stepper enable pin (0=low-enable, 1=high-enable).', unit: 'bool',  category: 'Motors',  defaultValue: 0 },
    // ── Limit Switches ─────────────────────────────────
    { id: 5,  name: 'Invert Limit Pins',       description: 'Invert logic of limit switch inputs.',                          unit: 'bool',  category: 'Limits',  defaultValue: 0 },
    { id: 6,  name: 'Invert Probe Pin',        description: 'Invert the probe input pin logic.',                             unit: 'bool',  category: 'Limits',  defaultValue: 0 },
    // ── Status Report ──────────────────────────────────
    { id: 10, name: 'Status Report Mask',      description: 'Bitmask for status report content (1=pos,2=buf).',              unit: 'mask',  category: 'Reporting', defaultValue: 1 },
    { id: 11, name: 'Junction Deviation',      description: 'Cornering speed factor. Lower = smoother, slower corners.',    unit: 'mm',    category: 'Motion',  defaultValue: 0.010 },
    { id: 12, name: 'Arc Tolerance',           description: 'Deviation from ideal arc path in arc-mode moves.',              unit: 'mm',    category: 'Motion',  defaultValue: 0.002 },
    { id: 13, name: 'Report in Inches',        description: 'Report positions in inches instead of millimeters.',            unit: 'bool',  category: 'Reporting', defaultValue: 0 },
    // ── Homing ─────────────────────────────────────────
    { id: 20, name: 'Soft Limits Enable',      description: 'Enable software travel limits (requires homing).',             unit: 'bool',  category: 'Homing',  defaultValue: 0 },
    { id: 21, name: 'Hard Limits Enable',      description: 'Enable hardware limit switches for protection.',                unit: 'bool',  category: 'Homing',  defaultValue: 0 },
    { id: 22, name: 'Homing Cycle Enable',     description: 'Enable homing at power-on.',                                   unit: 'bool',  category: 'Homing',  defaultValue: 0 },
    { id: 23, name: 'Homing Dir Invert Mask',  description: 'Bitmask to invert homing direction per axis.',                 unit: 'mask',  category: 'Homing',  defaultValue: 0 },
    { id: 24, name: 'Homing Feed Rate',        description: 'Slow feed rate used for accurate homing touch-off.',           unit: 'mm/min',category: 'Homing',  defaultValue: 25 },
    { id: 25, name: 'Homing Seek Rate',        description: 'Fast seek rate for initial limit switch search.',              unit: 'mm/min',category: 'Homing',  defaultValue: 500 },
    { id: 26, name: 'Homing Debounce Delay',   description: 'Delay after limit switch triggered to debounce signal.',       unit: 'ms',    category: 'Homing',  defaultValue: 250 },
    { id: 27, name: 'Homing Pull-off Dist',    description: 'Distance to back off limit switch after homing.',              unit: 'mm',    category: 'Homing',  defaultValue: 1 },
    // ── Spindle ────────────────────────────────────────
    { id: 30, name: 'Spindle Max RPM',         description: 'Maximum spindle speed mapped to full PWM output.',             unit: 'RPM',   category: 'Spindle', defaultValue: 1000 },
    { id: 31, name: 'Spindle Min RPM',         description: 'Minimum spindle speed (PWM floor).',                           unit: 'RPM',   category: 'Spindle', defaultValue: 0 },
    { id: 32, name: 'Laser Mode Enable',       description: 'Enable laser mode (spindle on during moves only).',            unit: 'bool',  category: 'Spindle', defaultValue: 0 },
    // ── Steps per mm ───────────────────────────────────
    { id: 100, name: 'X Steps/mm',             description: 'Number of motor steps required to move X axis 1 mm.',          unit: 'step/mm', category: 'Axes',  defaultValue: 250 },
    { id: 101, name: 'Y Steps/mm',             description: 'Number of motor steps required to move Y axis 1 mm.',          unit: 'step/mm', category: 'Axes',  defaultValue: 250 },
    { id: 102, name: 'Z Steps/mm',             description: 'Number of motor steps required to move Z axis 1 mm.',          unit: 'step/mm', category: 'Axes',  defaultValue: 250 },
    // ── Max Rates ──────────────────────────────────────
    { id: 110, name: 'X Max Rate',             description: 'Maximum X axis jog/rapid velocity.',                           unit: 'mm/min',category: 'Axes',  defaultValue: 500 },
    { id: 111, name: 'Y Max Rate',             description: 'Maximum Y axis jog/rapid velocity.',                           unit: 'mm/min',category: 'Axes',  defaultValue: 500 },
    { id: 112, name: 'Z Max Rate',             description: 'Maximum Z axis jog/rapid velocity.',                           unit: 'mm/min',category: 'Axes',  defaultValue: 500 },
    // ── Acceleration ───────────────────────────────────
    { id: 120, name: 'X Acceleration',         description: 'X axis acceleration for motion planning.',                     unit: 'mm/s²', category: 'Axes',  defaultValue: 10 },
    { id: 121, name: 'Y Acceleration',         description: 'Y axis acceleration for motion planning.',                     unit: 'mm/s²', category: 'Axes',  defaultValue: 10 },
    { id: 122, name: 'Z Acceleration',         description: 'Z axis acceleration for motion planning.',                     unit: 'mm/s²', category: 'Axes',  defaultValue: 10 },
    // ── Travel ─────────────────────────────────────────
    { id: 130, name: 'X Max Travel',           description: 'Maximum X travel for soft limits and outline moves.',          unit: 'mm',    category: 'Axes',  defaultValue: 200 },
    { id: 131, name: 'Y Max Travel',           description: 'Maximum Y travel for soft limits and outline moves.',          unit: 'mm',    category: 'Axes',  defaultValue: 200 },
    { id: 132, name: 'Z Max Travel',           description: 'Maximum Z travel for soft limits and outline moves.',          unit: 'mm',    category: 'Axes',  defaultValue: 200 },
];

const CATEGORIES = ['Motors', 'Limits', 'Homing', 'Spindle', 'Axes', 'Motion', 'Reporting'];

// Map id -> def for quick lookup
const DEF_MAP = new Map<number, GRBLSettingDef>(
    GRBL_SETTING_DEFS.map((d) => [d.id, d])
);

// ─── Types ────────────────────────────────────────────────────────────────────

export interface FirmwareSetting {
    id: number;
    value: string;
}

type Toast = { kind: 'success' | 'error'; message: string } | null;

// ─── Component ────────────────────────────────────────────────────────────────

export default function FirmwareSettings() {
    const { connected, addConsoleLog, firmwareSettings, setFirmwareSettings } = useCNCStore();

    // Pending edits not yet written (id -> new value)
    const [pendingEdits, setPendingEdits] = useState<Map<number, string>>(new Map());
    const [loading, setLoading] = useState(false);
    const [editingId, setEditingId] = useState<number | null>(null);
    const [editValue, setEditValue] = useState('');

    // UI filters
    const [search, setSearch] = useState('');
    const [showChangedOnly, setShowChangedOnly] = useState(false);
    const [collapsedCats, setCollapsedCats] = useState<Set<string>>(new Set());

    // Confirm restore dialog
    const [showRestoreConfirm, setShowRestoreConfirm] = useState(false);

    // Toast
    const [toast, setToast] = useState<Toast>(null);
    const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const showToast = useCallback((kind: 'success' | 'error', message: string) => {
        if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
        setToast({ kind, message });
        toastTimerRef.current = setTimeout(() => setToast(null), 3000);
    }, []);

    // Convert store Record<number,string> to Map for convenience
    const settings = new Map<number, string>(
        Object.entries(firmwareSettings).map(([k, v]) => [Number(k), v])
    );

    // ── Read $$ from controller ──────────────────────────────────────────────

    const readSettings = useCallback(async () => {
        if (!connected) return;
        setLoading(true);
        setPendingEdits(new Map());
        try {
            // backendReadEEPROM sends $$ and collects $N=V responses for 3 seconds
            const result = await backendReadEEPROM(3000);
            const count = Object.keys(result).length;
            // Merge into store — read current state at call time to avoid stale closure
            const currentSettings = useCNCStore.getState().firmwareSettings;
            setFirmwareSettings({ ...currentSettings, ...result });
            if (count === 0) {
                showToast('error', 'No settings received — check controller connection.');
            } else {
                showToast('success', `Loaded ${count} EEPROM settings`);
            }
        } finally {
            setLoading(false);
        }
    }, [connected, setFirmwareSettings, showToast]);

    // When store firmwareSettings populates (e.g. from serialport:read events),
    // stop the loading spinner if we have data
    useEffect(() => {
        if (loading && Object.keys(firmwareSettings).length > 0) {
            // data came in — stop loading
            setLoading(false);
        }
    }, [firmwareSettings, loading]);

    // ── Inline edit ──────────────────────────────────────────────────────────

    const startEdit = (id: number) => {
        const current = pendingEdits.get(id) ?? settings.get(id) ?? '';
        setEditingId(id);
        setEditValue(String(current));
    };

    const cancelEdit = () => {
        setEditingId(null);
        setEditValue('');
    };

    const saveEdit = useCallback(
        (id: number, val: string) => {
            if (!connected) return;
            const trimmed = val.trim();
            if (trimmed === '') return;
            // Optimistic update
            setPendingEdits((prev) => new Map(prev).set(id, trimmed));
            sendBackendCommand(`$${id}=${trimmed}`);
            addConsoleLog('info', `EEPROM: $${id}=${trimmed}`);
            setEditingId(null);
            showToast('success', `$${id} saved`);
        },
        [connected, addConsoleLog, showToast]
    );

    // ── Save all pending ─────────────────────────────────────────────────────

    const saveAllPending = useCallback(() => {
        if (!connected || pendingEdits.size === 0) return;
        pendingEdits.forEach((val, id) => {
            sendBackendCommand(`$${id}=${val}`);
        });
        addConsoleLog('info', `EEPROM: applied ${pendingEdits.size} setting(s)`);
        showToast('success', `${pendingEdits.size} setting(s) written`);
    }, [connected, pendingEdits, addConsoleLog, showToast]);

    // ── Restore defaults ─────────────────────────────────────────────────────

    const restoreDefaults = useCallback(() => {
        if (!connected) return;
        GRBL_SETTING_DEFS.forEach((def) => {
            sendBackendCommand(`$${def.id}=${def.defaultValue}`);
        });
        // Apply locally
        const newPending = new Map<number, string>();
        GRBL_SETTING_DEFS.forEach((def) => newPending.set(def.id, String(def.defaultValue)));
        setPendingEdits(newPending);
        setShowRestoreConfirm(false);
        addConsoleLog('warning', 'EEPROM: restored all defaults');
        showToast('success', 'Defaults restored');
    }, [connected, addConsoleLog, showToast]);

    // ── Export JSON ──────────────────────────────────────────────────────────

    const exportSettings = () => {
        const obj: Record<string, string> = {};
        const merged = new Map([...settings, ...pendingEdits]);
        merged.forEach((v, k) => { obj[`$${k}`] = v; });
        const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'grbl-settings.json';
        a.click();
        URL.revokeObjectURL(url);
        showToast('success', 'Settings exported');
    };

    // ── Import JSON ──────────────────────────────────────────────────────────

    const importSettings = () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.onchange = () => {
            const file = input.files?.[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (ev) => {
                try {
                    const raw = JSON.parse(ev.target?.result as string);
                    const newPending = new Map<number, string>();
                    Object.entries(raw).forEach(([k, v]) => {
                        const id = parseInt(k.replace('$', ''), 10);
                        if (!isNaN(id)) newPending.set(id, String(v));
                    });
                    setPendingEdits(newPending);
                    showToast('success', `${newPending.size} settings imported — review and save`);
                } catch {
                    showToast('error', 'Invalid JSON file');
                }
            };
            reader.readAsText(file);
        };
        input.click();
    };

    // ── Filtering ────────────────────────────────────────────────────────────

    const effectiveValue = (id: number): string =>
        pendingEdits.has(id)
            ? pendingEdits.get(id)!
            : settings.get(id) ?? '';

    const isChanged = (id: number): boolean => {
        const ev = effectiveValue(id);
        if (!ev) return false;
        const def = DEF_MAP.get(id);
        if (!def) return false;
        return String(def.defaultValue) !== ev;
    };

    const filteredDefs = GRBL_SETTING_DEFS.filter((def) => {
        if (showChangedOnly && !isChanged(def.id)) return false;
        if (search) {
            const q = search.toLowerCase();
            return (
                String(def.id).includes(q) ||
                def.name.toLowerCase().includes(q) ||
                def.description.toLowerCase().includes(q) ||
                def.category.toLowerCase().includes(q)
            );
        }
        return true;
    });

    const categorizedDefs = CATEGORIES.map((cat) => ({
        cat,
        items: filteredDefs.filter((d) => d.category === cat),
    })).filter((g) => g.items.length > 0);

    // Also add an "Unknown" category for settings received from controller not in defs
    const knownIds = new Set(GRBL_SETTING_DEFS.map((d) => d.id));
    const unknownSettings = [...settings.keys()].filter((id) => !knownIds.has(id));

    const toggleCat = (cat: string) => {
        setCollapsedCats((prev) => {
            const next = new Set(prev);
            if (next.has(cat)) next.delete(cat);
            else next.add(cat);
            return next;
        });
    };

    const changedCount = GRBL_SETTING_DEFS.filter((d) => isChanged(d.id)).length;
    const pendingCount = pendingEdits.size;
    const settingsLoaded = settings.size > 0;

    // ─────────────────────────────────────────────────────────────────────────

    return (
        <div className="firmware-settings">
            {/* ── Toolbar ── */}
            <div className="fw-toolbar">
                <div className="fw-toolbar-left">
                    <div className="fw-search-wrap">
                        <Search size={14} className="fw-search-icon" />
                        <input
                            type="text"
                            className="fw-search"
                            placeholder="Search settings…"
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                        />
                    </div>
                    <button
                        type="button"
                        className={`fw-filter-chip ${showChangedOnly ? 'active' : ''}`}
                        onClick={() => setShowChangedOnly((v) => !v)}
                        title="Show only changed settings"
                    >
                        <Filter size={12} />
                        Changed only
                        {changedCount > 0 && <span>({changedCount})</span>}
                    </button>
                </div>

                <div className="fw-toolbar-right">
                    <button
                        type="button"
                        className="fw-icon-btn"
                        title="Import settings from JSON"
                        onClick={importSettings}
                    >
                        <Upload size={14} />
                    </button>
                    <button
                        type="button"
                        className="fw-icon-btn"
                        title="Export settings to JSON"
                        onClick={exportSettings}
                        disabled={!settingsLoaded && pendingEdits.size === 0}
                    >
                        <Download size={14} />
                    </button>
                    <button
                        type="button"
                        className="fw-icon-btn danger"
                        title="Restore all settings to defaults"
                        onClick={() => setShowRestoreConfirm(true)}
                        disabled={!connected}
                    >
                        <RotateCcw size={14} />
                    </button>
                    <button
                        type="button"
                        className="fw-read-btn"
                        onClick={readSettings}
                        disabled={!connected || loading}
                    >
                        <RefreshCw size={14} className={loading ? 'fw-spinning' : ''} />
                        {loading ? 'Reading…' : 'Read $$'}
                    </button>
                </div>
            </div>

            {/* ── Status bar ── */}
            {settingsLoaded && (
                <div className="fw-status-bar">
                    <span className="fw-status-badge total">
                        {settings.size} settings loaded
                    </span>
                    {changedCount > 0 && (
                        <span className="fw-status-badge changed">
                            {changedCount} non-default
                        </span>
                    )}
                    {pendingCount > 0 && (
                        <span className="fw-status-badge changed">
                            {pendingCount} pending write
                        </span>
                    )}
                    <span className="fw-status-sep" />
                    {pendingCount > 0 && (
                        <button
                            type="button"
                            className="fw-save-all-btn"
                            onClick={saveAllPending}
                            disabled={!connected}
                        >
                            <Save size={12} />
                            Write {pendingCount} setting(s)
                        </button>
                    )}
                </div>
            )}

            {/* ── Main content ── */}
            {!connected ? (
                <div className="fw-empty">
                    <Cpu size={48} className="fw-empty-icon" />
                    <h4>Not Connected</h4>
                    <p>Connect to your CNC controller first, then click <strong>Read $$</strong> to load firmware settings.</p>
                </div>
            ) : !settingsLoaded && !loading ? (
                <div className="fw-empty">
                    <Cpu size={48} className="fw-empty-icon" />
                    <h4>No Settings Loaded</h4>
                    <p>Click <strong>Read $$</strong> to read all GRBL EEPROM settings from your controller.</p>
                    <button type="button" className="fw-read-btn" onClick={readSettings}>
                        <RefreshCw size={14} />
                        Read $$
                    </button>
                </div>
            ) : loading ? (
                <div className="fw-empty">
                    <RefreshCw size={40} className="fw-empty-icon fw-spinning" />
                    <h4>Reading settings…</h4>
                    <p>Sending $$ command and collecting responses.</p>
                </div>
            ) : (
                <div className="fw-settings-list">
                    {categorizedDefs.map(({ cat, items }) => (
                        <div key={cat} className="fw-category">
                            <div
                                className="fw-category-header"
                                onClick={() => toggleCat(cat)}
                                role="button"
                                tabIndex={0}
                                onKeyDown={(e) => e.key === 'Enter' && toggleCat(cat)}
                            >
                                <Cpu size={14} className="fw-cat-icon" />
                                <span className="fw-cat-title">{cat}</span>
                                <span className="fw-cat-count">{items.length}</span>
                                <ChevronDown
                                    size={14}
                                    className={`fw-cat-chevron ${collapsedCats.has(cat) ? 'collapsed' : ''}`}
                                />
                            </div>

                            {!collapsedCats.has(cat) && items.map((def) => {
                                const ev = effectiveValue(def.id);
                                const changed = isChanged(def.id);
                                const editing = editingId === def.id;

                                return (
                                    <div
                                        key={def.id}
                                        className={`fw-setting-row ${changed ? 'changed' : ''} ${editing ? 'editing' : ''}`}
                                    >
                                        {/* ID badge */}
                                        <div className="fw-setting-id">${def.id}</div>

                                        {/* Info */}
                                        <div className="fw-setting-info">
                                            <span className="fw-setting-name">{def.name}</span>
                                            <span className="fw-setting-desc">{def.description}</span>
                                            <span className="fw-setting-default">
                                                Default: {def.defaultValue}{def.unit ? ` ${def.unit}` : ''}
                                            </span>
                                        </div>

                                        {/* Value / edit */}
                                        <div className="fw-setting-value-col">
                                            {editing ? (
                                                <div className="fw-edit-form">
                                                    <input
                                                        autoFocus
                                                        type="number"
                                                        className="fw-edit-input"
                                                        value={editValue}
                                                        onChange={(e) => setEditValue(e.target.value)}
                                                        onKeyDown={(e) => {
                                                            if (e.key === 'Enter') saveEdit(def.id, editValue);
                                                            if (e.key === 'Escape') cancelEdit();
                                                        }}
                                                    />
                                                    <button
                                                        type="button"
                                                        className="fw-save-btn"
                                                        title="Save"
                                                        onClick={() => saveEdit(def.id, editValue)}
                                                    >
                                                        <Check size={12} />
                                                    </button>
                                                    <button
                                                        type="button"
                                                        className="fw-cancel-btn"
                                                        title="Cancel"
                                                        onClick={cancelEdit}
                                                    >
                                                        <X size={12} />
                                                    </button>
                                                </div>
                                            ) : (
                                                <>
                                                    <div className="fw-value-display">
                                                        {changed && <div className="fw-changed-dot" title="Changed from default" />}
                                                        <span className="fw-value-text">
                                                            {ev !== '' ? ev : '—'}
                                                        </span>
                                                        {def.unit && (
                                                            <span className="fw-value-unit">{def.unit}</span>
                                                        )}
                                                    </div>
                                                    <button
                                                        type="button"
                                                        className="fw-edit-btn"
                                                        onClick={() => startEdit(def.id)}
                                                        disabled={!connected}
                                                    >
                                                        Edit
                                                    </button>
                                                </>
                                            )}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    ))}

                    {/* Unknown settings (reported by controller but not in our defs) */}
                    {unknownSettings.length > 0 && (
                        <div className="fw-category">
                            <div
                                className="fw-category-header"
                                onClick={() => toggleCat('__unknown')}
                                role="button"
                                tabIndex={0}
                                onKeyDown={(e) => e.key === 'Enter' && toggleCat('__unknown')}
                            >
                                <Cpu size={14} className="fw-cat-icon" />
                                <span className="fw-cat-title">Other / Extended</span>
                                <span className="fw-cat-count">{unknownSettings.length}</span>
                                <ChevronDown
                                    size={14}
                                    className={`fw-cat-chevron ${collapsedCats.has('__unknown') ? 'collapsed' : ''}`}
                                />
                            </div>

                            {!collapsedCats.has('__unknown') && unknownSettings.map((id) => {
                                const ev = settings.get(id) ?? '';
                                const editing = editingId === id;
                                const pending = pendingEdits.get(id);

                                return (
                                    <div
                                        key={id}
                                        className={`fw-setting-row ${editing ? 'editing' : ''}`}
                                    >
                                        <div className="fw-setting-id">${id}</div>
                                        <div className="fw-setting-info">
                                            <span className="fw-setting-name">Setting ${id}</span>
                                            <span className="fw-setting-desc">Extended or firmware-specific setting.</span>
                                        </div>
                                        <div className="fw-setting-value-col">
                                            {editing ? (
                                                <div className="fw-edit-form">
                                                    <input
                                                        autoFocus
                                                        type="text"
                                                        className="fw-edit-input"
                                                        value={editValue}
                                                        onChange={(e) => setEditValue(e.target.value)}
                                                        onKeyDown={(e) => {
                                                            if (e.key === 'Enter') saveEdit(id, editValue);
                                                            if (e.key === 'Escape') cancelEdit();
                                                        }}
                                                    />
                                                    <button type="button" className="fw-save-btn" onClick={() => saveEdit(id, editValue)}><Check size={12} /></button>
                                                    <button type="button" className="fw-cancel-btn" onClick={cancelEdit}><X size={12} /></button>
                                                </div>
                                            ) : (
                                                <>
                                                    <div className="fw-value-display">
                                                        <span className="fw-value-text">{pending ?? ev}</span>
                                                    </div>
                                                    <button type="button" className="fw-edit-btn" onClick={() => startEdit(id)}>Edit</button>
                                                </>
                                            )}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}

                    {filteredDefs.length === 0 && unknownSettings.length === 0 && (
                        <div className="fw-empty">
                            <Search size={32} className="fw-empty-icon" />
                            <h4>No Results</h4>
                            <p>No settings match your search or filter.</p>
                        </div>
                    )}
                </div>
            )}

            {/* ── Restore defaults confirm dialog ── */}
            {showRestoreConfirm && (
                <div className="fw-confirm-overlay" onClick={() => setShowRestoreConfirm(false)}>
                    <div className="fw-confirm-dialog" onClick={(e) => e.stopPropagation()}>
                        <h4>Restore Default Settings?</h4>
                        <p>
                            This will write <strong>{GRBL_SETTING_DEFS.length} settings</strong> to your
                            controller, replacing all current EEPROM values with the standard GRBL defaults.
                            Your machine may need to be reconfigured afterward.
                        </p>
                        <div className="fw-confirm-actions">
                            <button type="button" className="fw-confirm-cancel" onClick={() => setShowRestoreConfirm(false)}>
                                Cancel
                            </button>
                            <button type="button" className="fw-confirm-ok" onClick={restoreDefaults}>
                                Restore Defaults
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* ── Toast ── */}
            {toast && (
                <div className={`fw-toast ${toast.kind}`}>
                    {toast.kind === 'success' ? <Check size={14} /> : <X size={14} />}
                    {toast.message}
                </div>
            )}
        </div>
    );
}
