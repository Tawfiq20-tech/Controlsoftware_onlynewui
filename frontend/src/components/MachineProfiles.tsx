/**
 * MachineProfiles.tsx — Machine Profiles panel
 *
 * Pre-built profiles with EEPROM defaults for common machines.
 * Lets users select a profile, preview its settings, and optionally
 * apply the EEPROM defaults to the connected controller.
 */
import { useState, useCallback } from 'react';
import { Cpu, Plus, Trash2, Check, ChevronRight, Download, Upload, Save } from 'lucide-react';
import { useCNCStore } from '../stores/cncStore';
import { sendBackendCommand, setBackendActiveMachineProfile } from '../utils/backendConnection';
import type { GRBLSettingDef } from './FirmwareSettings';
import { GRBL_SETTING_DEFS } from './FirmwareSettings';
import './MachineProfiles.css';

// ─── Profile types ────────────────────────────────────────────────────────────

export interface MachineProfileEEPROM {
    /** $id -> value */
    [settingId: string]: number | string;
}

export interface BuiltInMachineProfile {
    id: string;
    name: string;
    description: string;
    workArea: { x: number; y: number; z: number };   // mm
    maxFeed: { x: number; y: number; z: number };     // mm/min
    acceleration: { x: number; y: number; z: number };// mm/s²
    stepsPerMm: { x: number; y: number; z: number };
    spindleMaxRpm: number;
    eeprom: MachineProfileEEPROM;
    isBuiltIn: true;
}

export interface CustomMachineProfile {
    id: string;
    name: string;
    description: string;
    workArea: { x: number; y: number; z: number };
    maxFeed: { x: number; y: number; z: number };
    acceleration: { x: number; y: number; z: number };
    stepsPerMm: { x: number; y: number; z: number };
    spindleMaxRpm: number;
    eeprom: MachineProfileEEPROM;
    isBuiltIn: false;
}

export type AnyMachineProfile = BuiltInMachineProfile | CustomMachineProfile;

// ─── Built-in profiles ────────────────────────────────────────────────────────

function makeEeprom(p: {
    stepsPerMm: { x: number; y: number; z: number };
    maxFeed: { x: number; y: number; z: number };
    acceleration: { x: number; y: number; z: number };
    workArea: { x: number; y: number; z: number };
    spindleMaxRpm: number;
}): MachineProfileEEPROM {
    return {
        '$100': p.stepsPerMm.x,
        '$101': p.stepsPerMm.y,
        '$102': p.stepsPerMm.z,
        '$110': p.maxFeed.x,
        '$111': p.maxFeed.y,
        '$112': p.maxFeed.z,
        '$120': p.acceleration.x,
        '$121': p.acceleration.y,
        '$122': p.acceleration.z,
        '$130': p.workArea.x,
        '$131': p.workArea.y,
        '$132': p.workArea.z,
        '$30':  p.spindleMaxRpm,
        '$22':  1,   // homing enabled
        '$20':  0,   // soft limits off (user should enable after homing)
    };
}

export const BUILT_IN_PROFILES: BuiltInMachineProfile[] = [
    {
        id: 'generic-3018',
        name: 'Generic 3018 CNC',
        description: 'Common hobbyist 3018 desktop CNC router. 300×180×45 mm work area. Fixed gantry, 3-axis, typically runs a 775 or ER11 spindle.',
        workArea:     { x: 300,  y: 180,  z: 45 },
        maxFeed:      { x: 1000, y: 1000, z: 500 },
        acceleration: { x: 50,   y: 50,   z: 30 },
        stepsPerMm:   { x: 800,  y: 800,  z: 800 },
        spindleMaxRpm: 10000,
        isBuiltIn: true,
        eeprom: makeEeprom({
            stepsPerMm:   { x: 800,  y: 800,  z: 800 },
            maxFeed:      { x: 1000, y: 1000, z: 500 },
            acceleration: { x: 50,   y: 50,   z: 30 },
            workArea:     { x: 300,  y: 180,  z: 45 },
            spindleMaxRpm: 10000,
        }),
    },
    {
        id: 'shapeoko-3',
        name: 'Shapeoko 3',
        description: 'Carbide 3D Shapeoko 3 standard size. 425×425×75 mm. Belt-driven XY, lead-screw Z. Runs Carbide Motion / GRBL.',
        workArea:     { x: 425,  y: 425,  z: 75 },
        maxFeed:      { x: 5000, y: 5000, z: 3000 },
        acceleration: { x: 200,  y: 200,  z: 100 },
        stepsPerMm:   { x: 40,   y: 40,   z: 200 },
        spindleMaxRpm: 24000,
        isBuiltIn: true,
        eeprom: makeEeprom({
            stepsPerMm:   { x: 40,   y: 40,   z: 200 },
            maxFeed:      { x: 5000, y: 5000, z: 3000 },
            acceleration: { x: 200,  y: 200,  z: 100 },
            workArea:     { x: 425,  y: 425,  z: 75 },
            spindleMaxRpm: 24000,
        }),
    },
    {
        id: 'xcarve-750',
        name: 'X-Carve 750mm',
        description: 'Inventables X-Carve 750×750×65 mm. Belt-driven XY motion, Makerslide extrusions. Easel-compatible GRBL settings.',
        workArea:     { x: 750,  y: 750,  z: 65 },
        maxFeed:      { x: 8000, y: 8000, z: 500 },
        acceleration: { x: 500,  y: 500,  z: 50 },
        stepsPerMm:   { x: 40,   y: 40,   z: 188.976 },
        spindleMaxRpm: 12000,
        isBuiltIn: true,
        eeprom: makeEeprom({
            stepsPerMm:   { x: 40,   y: 40,   z: 188.976 },
            maxFeed:      { x: 8000, y: 8000, z: 500 },
            acceleration: { x: 500,  y: 500,  z: 50 },
            workArea:     { x: 750,  y: 750,  z: 65 },
            spindleMaxRpm: 12000,
        }),
    },
    {
        id: 'openbuilds-lead-1010',
        name: 'OpenBuilds LEAD 1010',
        description: 'OpenBuilds LEAD 1010 — 1000×1000×90 mm. V-slot extrusion, lead-screw Z, belt-driven XY. Widely used DIY platform.',
        workArea:     { x: 1000, y: 1000, z: 90 },
        maxFeed:      { x: 5000, y: 5000, z: 1000 },
        acceleration: { x: 250,  y: 250,  z: 100 },
        stepsPerMm:   { x: 200,  y: 200,  z: 200 },
        spindleMaxRpm: 24000,
        isBuiltIn: true,
        eeprom: makeEeprom({
            stepsPerMm:   { x: 200,  y: 200,  z: 200 },
            maxFeed:      { x: 5000, y: 5000, z: 1000 },
            acceleration: { x: 250,  y: 250,  z: 100 },
            workArea:     { x: 1000, y: 1000, z: 90 },
            spindleMaxRpm: 24000,
        }),
    },
    {
        id: 'onefinity-woodworker',
        name: 'Onefinity Woodworker',
        description: 'Onefinity Woodworker X-35 — 816×816×133 mm. Rail-and-carriage design, lead-screw all axes, grblHAL controller. Very rigid.',
        workArea:     { x: 816,  y: 816,  z: 133 },
        maxFeed:      { x: 5080, y: 5080, z: 2540 },
        acceleration: { x: 508,  y: 508,  z: 381 },
        stepsPerMm:   { x: 200,  y: 200,  z: 200 },
        spindleMaxRpm: 24000,
        isBuiltIn: true,
        eeprom: makeEeprom({
            stepsPerMm:   { x: 200,  y: 200,  z: 200 },
            maxFeed:      { x: 5080, y: 5080, z: 2540 },
            acceleration: { x: 508,  y: 508,  z: 381 },
            workArea:     { x: 816,  y: 816,  z: 133 },
            spindleMaxRpm: 24000,
        }),
    },
];

const CUSTOM_PROFILE_TEMPLATE: Omit<CustomMachineProfile, 'id' | 'name' | 'isBuiltIn'> = {
    description: '',
    workArea:     { x: 400,  y: 400,  z: 80 },
    maxFeed:      { x: 3000, y: 3000, z: 1000 },
    acceleration: { x: 200,  y: 200,  z: 100 },
    stepsPerMm:   { x: 200,  y: 200,  z: 200 },
    spindleMaxRpm: 24000,
    eeprom: {},
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function defForKey(key: string): GRBLSettingDef | undefined {
    const id = parseInt(key.replace('$', ''), 10);
    return GRBL_SETTING_DEFS.find((d) => d.id === id);
}

function settingLabel(key: string): string {
    const def = defForKey(key);
    return def ? def.name : key;
}

function settingUnit(key: string): string {
    const def = defForKey(key);
    return def?.unit ?? '';
}

// ─── Storage helpers (localStorage for custom profiles) ───────────────────────

const STORAGE_KEY = 'easycnc:customMachineProfiles';

function loadCustomProfiles(): CustomMachineProfile[] {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return [];
        return JSON.parse(raw) as CustomMachineProfile[];
    } catch {
        return [];
    }
}

function saveCustomProfiles(profiles: CustomMachineProfile[]): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(profiles));
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function MachineProfiles() {
    const { connected, activeMachineProfile, setActiveMachineProfile, addConsoleLog } = useCNCStore();

    const [customProfiles, setCustomProfiles] = useState<CustomMachineProfile[]>(loadCustomProfiles);
    const [selectedId, setSelectedId] = useState<string | null>(
        activeMachineProfile ?? BUILT_IN_PROFILES[0].id
    );

    // Custom profile creation
    const [showCreateForm, setShowCreateForm] = useState(false);
    const [newProfileName, setNewProfileName] = useState('My Machine');
    const [newProfileDesc, setNewProfileDesc] = useState('');
    const [newWorkArea, setNewWorkArea] = useState(CUSTOM_PROFILE_TEMPLATE.workArea);
    const [newMaxFeed, setNewMaxFeed] = useState(CUSTOM_PROFILE_TEMPLATE.maxFeed);
    const [newAccel, setNewAccel] = useState(CUSTOM_PROFILE_TEMPLATE.acceleration);
    const [newSteps, setNewSteps] = useState(CUSTOM_PROFILE_TEMPLATE.stepsPerMm);
    const [newSpindleRpm, setNewSpindleRpm] = useState(CUSTOM_PROFILE_TEMPLATE.spindleMaxRpm);

    // Apply EEPROM dialog
    const [applyTarget, setApplyTarget] = useState<AnyMachineProfile | null>(null);

    const allProfiles: AnyMachineProfile[] = [...BUILT_IN_PROFILES, ...customProfiles];

    const selectedProfile = allProfiles.find((p) => p.id === selectedId) ?? null;

    // ── Select & activate ───────────────────────────────────────────────────

    const activateProfile = useCallback(
        (profile: AnyMachineProfile) => {
            setActiveMachineProfile(profile.id);
            setBackendActiveMachineProfile(profile.id);
            addConsoleLog('info', `Machine profile set: ${profile.name}`);
        },
        [setActiveMachineProfile, addConsoleLog]
    );

    // ── Apply EEPROM ────────────────────────────────────────────────────────

    const applyEEPROM = useCallback(
        (profile: AnyMachineProfile) => {
            if (!connected) return;
            const eeprom = profile.eeprom;
            Object.entries(eeprom).forEach(([key, val]) => {
                const id = key.replace('$', '');
                sendBackendCommand(`$${id}=${val}`);
            });
            addConsoleLog('info', `Applied ${Object.keys(eeprom).length} EEPROM settings for "${profile.name}"`);
            setApplyTarget(null);
        },
        [connected, addConsoleLog]
    );

    // ── Create custom profile ────────────────────────────────────────────────

    const saveCustomProfile = () => {
        const id = `custom-${Date.now()}`;
        const eeprom = makeEeprom({
            stepsPerMm:   newSteps,
            maxFeed:      newMaxFeed,
            acceleration: newAccel,
            workArea:     newWorkArea,
            spindleMaxRpm: newSpindleRpm,
        });
        const profile: CustomMachineProfile = {
            id,
            name:        newProfileName || 'Custom Machine',
            description: newProfileDesc,
            workArea:    newWorkArea,
            maxFeed:     newMaxFeed,
            acceleration: newAccel,
            stepsPerMm:  newSteps,
            spindleMaxRpm: newSpindleRpm,
            eeprom,
            isBuiltIn: false,
        };
        const updated = [...customProfiles, profile];
        setCustomProfiles(updated);
        saveCustomProfiles(updated);
        setSelectedId(id);
        setShowCreateForm(false);
    };

    // ── Delete custom profile ────────────────────────────────────────────────

    const deleteCustomProfile = (id: string) => {
        const updated = customProfiles.filter((p) => p.id !== id);
        setCustomProfiles(updated);
        saveCustomProfiles(updated);
        if (selectedId === id) setSelectedId(BUILT_IN_PROFILES[0].id);
    };

    // ── Import / Export custom profiles ─────────────────────────────────────

    const exportProfiles = () => {
        const blob = new Blob([JSON.stringify(customProfiles, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'machine-profiles.json';
        a.click();
        URL.revokeObjectURL(url);
    };

    const importProfiles = () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.onchange = () => {
            const file = input.files?.[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (ev) => {
                try {
                    const imported = JSON.parse(ev.target?.result as string) as CustomMachineProfile[];
                    const updated = [...customProfiles, ...imported.map((p) => ({ ...p, isBuiltIn: false as const }))];
                    setCustomProfiles(updated);
                    saveCustomProfiles(updated);
                } catch { /* ignore */ }
            };
            reader.readAsText(file);
        };
        input.click();
    };

    // ─────────────────────────────────────────────────────────────────────────

    return (
        <div className="machine-profiles">
            {/* ── Toolbar ── */}
            <div className="mp-toolbar">
                <span className="mp-toolbar-title">Machine Profiles</span>
                <div className="mp-toolbar-actions">
                    <button
                        type="button"
                        className="mp-action-btn"
                        title="Import custom profiles from JSON"
                        onClick={importProfiles}
                    >
                        <Upload size={13} />
                        Import
                    </button>
                    <button
                        type="button"
                        className="mp-action-btn"
                        title="Export custom profiles to JSON"
                        onClick={exportProfiles}
                        disabled={customProfiles.length === 0}
                    >
                        <Download size={13} />
                        Export
                    </button>
                    <button
                        type="button"
                        className="mp-action-btn primary"
                        onClick={() => { setShowCreateForm(true); setSelectedId('__new'); }}
                    >
                        <Plus size={13} />
                        New Profile
                    </button>
                </div>
            </div>

            <div className="mp-content">
                {/* ── Left: profile list ── */}
                <div className="mp-list">
                    <div className="mp-list-section-label">Built-in</div>
                    {BUILT_IN_PROFILES.map((p) => (
                        <div
                            key={p.id}
                            className={`mp-list-item ${selectedId === p.id ? 'selected' : ''}`}
                            onClick={() => { setSelectedId(p.id); setShowCreateForm(false); }}
                            role="button"
                            tabIndex={0}
                            onKeyDown={(e) => e.key === 'Enter' && setSelectedId(p.id)}
                        >
                            <Cpu size={14} className="mp-list-item-icon" />
                            <div className="mp-list-item-text">
                                <span className="mp-list-item-name">{p.name}</span>
                                <span className="mp-list-item-sub">
                                    {p.workArea.x}×{p.workArea.y}mm
                                </span>
                            </div>
                            {activeMachineProfile === p.id && (
                                <div className="mp-active-dot" title="Active profile" />
                            )}
                        </div>
                    ))}

                    {customProfiles.length > 0 && (
                        <>
                            <div className="mp-list-divider" />
                            <div className="mp-list-section-label">Custom</div>
                            {customProfiles.map((p) => (
                                <div
                                    key={p.id}
                                    className={`mp-list-item ${selectedId === p.id ? 'selected' : ''}`}
                                    onClick={() => { setSelectedId(p.id); setShowCreateForm(false); }}
                                    role="button"
                                    tabIndex={0}
                                    onKeyDown={(e) => e.key === 'Enter' && setSelectedId(p.id)}
                                >
                                    <Cpu size={14} className="mp-list-item-icon" />
                                    <div className="mp-list-item-text">
                                        <span className="mp-list-item-name">{p.name}</span>
                                        <span className="mp-list-item-sub">
                                            {p.workArea.x}×{p.workArea.y}mm
                                        </span>
                                    </div>
                                    {activeMachineProfile === p.id && (
                                        <div className="mp-active-dot" title="Active profile" />
                                    )}
                                </div>
                            ))}
                        </>
                    )}
                </div>

                {/* ── Right: detail panel ── */}
                <div className="mp-detail">
                    {showCreateForm ? (
                        /* Create form */
                        <div className="mp-custom-form">
                            <div className="mp-detail-header">
                                <div className="mp-detail-title-block">
                                    <h3 className="mp-detail-name">New Custom Profile</h3>
                                    <p className="mp-detail-desc">Configure your machine dimensions and motion parameters.</p>
                                </div>
                            </div>

                            <div className="mp-form-group">
                                <label className="mp-form-label">Profile Name</label>
                                <input
                                    className="mp-form-input"
                                    type="text"
                                    value={newProfileName}
                                    onChange={(e) => setNewProfileName(e.target.value)}
                                    placeholder="My CNC Machine"
                                />
                            </div>

                            <div className="mp-form-group">
                                <label className="mp-form-label">Description (optional)</label>
                                <textarea
                                    className="mp-form-textarea"
                                    value={newProfileDesc}
                                    onChange={(e) => setNewProfileDesc(e.target.value)}
                                    placeholder="Describe your machine…"
                                />
                            </div>

                            <div className="mp-form-group">
                                <label className="mp-form-label">Work Area (mm)</label>
                                <div className="mp-form-row">
                                    {(['x', 'y', 'z'] as const).map((axis) => (
                                        <div key={axis} className="mp-form-input-wrap">
                                            <input
                                                className="mp-form-input"
                                                type="number"
                                                placeholder={axis.toUpperCase()}
                                                value={newWorkArea[axis]}
                                                onChange={(e) => setNewWorkArea((p) => ({ ...p, [axis]: Number(e.target.value) }))}
                                            />
                                            <span className="mp-form-unit">{axis.toUpperCase()}</span>
                                        </div>
                                    ))}
                                </div>
                            </div>

                            <div className="mp-form-group">
                                <label className="mp-form-label">Steps per mm (X / Y / Z)</label>
                                <div className="mp-form-row">
                                    {(['x', 'y', 'z'] as const).map((axis) => (
                                        <div key={axis} className="mp-form-input-wrap">
                                            <input
                                                className="mp-form-input"
                                                type="number"
                                                placeholder={axis.toUpperCase()}
                                                value={newSteps[axis]}
                                                onChange={(e) => setNewSteps((p) => ({ ...p, [axis]: Number(e.target.value) }))}
                                            />
                                            <span className="mp-form-unit">st/mm</span>
                                        </div>
                                    ))}
                                </div>
                            </div>

                            <div className="mp-form-group">
                                <label className="mp-form-label">Max Feed Rate (mm/min)</label>
                                <div className="mp-form-row">
                                    {(['x', 'y', 'z'] as const).map((axis) => (
                                        <div key={axis} className="mp-form-input-wrap">
                                            <input
                                                className="mp-form-input"
                                                type="number"
                                                placeholder={axis.toUpperCase()}
                                                value={newMaxFeed[axis]}
                                                onChange={(e) => setNewMaxFeed((p) => ({ ...p, [axis]: Number(e.target.value) }))}
                                            />
                                        </div>
                                    ))}
                                </div>
                            </div>

                            <div className="mp-form-group">
                                <label className="mp-form-label">Acceleration (mm/s²)</label>
                                <div className="mp-form-row">
                                    {(['x', 'y', 'z'] as const).map((axis) => (
                                        <div key={axis} className="mp-form-input-wrap">
                                            <input
                                                className="mp-form-input"
                                                type="number"
                                                placeholder={axis.toUpperCase()}
                                                value={newAccel[axis]}
                                                onChange={(e) => setNewAccel((p) => ({ ...p, [axis]: Number(e.target.value) }))}
                                            />
                                        </div>
                                    ))}
                                </div>
                            </div>

                            <div className="mp-form-group">
                                <label className="mp-form-label">Spindle Max RPM</label>
                                <div className="mp-form-input-wrap">
                                    <input
                                        className="mp-form-input"
                                        type="number"
                                        value={newSpindleRpm}
                                        onChange={(e) => setNewSpindleRpm(Number(e.target.value))}
                                    />
                                    <span className="mp-form-unit">RPM</span>
                                </div>
                            </div>

                            <button type="button" className="mp-form-save-btn" onClick={saveCustomProfile}>
                                <Save size={14} />
                                Save Profile
                            </button>
                        </div>
                    ) : selectedProfile ? (
                        /* Profile detail */
                        <>
                            <div className="mp-detail-header">
                                <div className="mp-detail-title-block">
                                    <h3 className="mp-detail-name">{selectedProfile.name}</h3>
                                    {selectedProfile.description && (
                                        <p className="mp-detail-desc">{selectedProfile.description}</p>
                                    )}
                                </div>
                                <div className="mp-detail-actions">
                                    <button
                                        type="button"
                                        className={`mp-apply-btn ${activeMachineProfile === selectedProfile.id ? 'active-state' : ''}`}
                                        onClick={() => activateProfile(selectedProfile)}
                                        title="Set as the active machine profile in the app"
                                    >
                                        {activeMachineProfile === selectedProfile.id ? (
                                            <><Check size={14} /> Active</>
                                        ) : (
                                            <><ChevronRight size={14} /> Use Profile</>
                                        )}
                                    </button>
                                    {!selectedProfile.isBuiltIn && (
                                        <button
                                            type="button"
                                            className="mp-delete-btn"
                                            title="Delete this custom profile"
                                            onClick={() => deleteCustomProfile(selectedProfile.id)}
                                        >
                                            <Trash2 size={14} />
                                        </button>
                                    )}
                                </div>
                            </div>

                            {/* Specs grid */}
                            <div className="mp-specs-grid">
                                <div className="mp-spec-card">
                                    <div className="mp-spec-label">Work Area</div>
                                    <div className="mp-spec-value">
                                        {selectedProfile.workArea.x}×{selectedProfile.workArea.y}
                                    </div>
                                    <div className="mp-spec-sub">× {selectedProfile.workArea.z} mm (Z)</div>
                                </div>
                                <div className="mp-spec-card">
                                    <div className="mp-spec-label">Max Feed XY</div>
                                    <div className="mp-spec-value">{selectedProfile.maxFeed.x}</div>
                                    <div className="mp-spec-sub">mm/min</div>
                                </div>
                                <div className="mp-spec-card">
                                    <div className="mp-spec-label">Acceleration</div>
                                    <div className="mp-spec-value">{selectedProfile.acceleration.x}</div>
                                    <div className="mp-spec-sub">mm/s²</div>
                                </div>
                                <div className="mp-spec-card">
                                    <div className="mp-spec-label">Steps/mm</div>
                                    <div className="mp-spec-value">{selectedProfile.stepsPerMm.x}</div>
                                    <div className="mp-spec-sub">X/Y axis</div>
                                </div>
                                <div className="mp-spec-card">
                                    <div className="mp-spec-label">Spindle Max</div>
                                    <div className="mp-spec-value">{selectedProfile.spindleMaxRpm.toLocaleString()}</div>
                                    <div className="mp-spec-sub">RPM</div>
                                </div>
                                <div className="mp-spec-card">
                                    <div className="mp-spec-label">EEPROM Settings</div>
                                    <div className="mp-spec-value">{Object.keys(selectedProfile.eeprom).length}</div>
                                    <div className="mp-spec-sub">will be written</div>
                                </div>
                            </div>

                            {/* EEPROM preview */}
                            <div className="mp-eeprom-section">
                                <h5 className="mp-section-title">EEPROM Settings</h5>
                                <div className="mp-eeprom-grid">
                                    {Object.entries(selectedProfile.eeprom).map(([key, val]) => (
                                        <div key={key} className="mp-eeprom-item">
                                            <span className="mp-eeprom-key" title={settingLabel(key)}>
                                                {key} — {settingLabel(key)}
                                            </span>
                                            <span className="mp-eeprom-val">
                                                {val}
                                                {settingUnit(key) ? ` ${settingUnit(key)}` : ''}
                                            </span>
                                        </div>
                                    ))}
                                </div>

                                <div style={{ marginTop: '12px' }}>
                                    <button
                                        type="button"
                                        className="mp-apply-btn"
                                        style={{ marginTop: '8px' }}
                                        disabled={!connected}
                                        onClick={() => setApplyTarget(selectedProfile)}
                                        title={connected ? 'Write these EEPROM values to the connected controller' : 'Connect to controller first'}
                                    >
                                        <Cpu size={14} />
                                        Apply to Controller EEPROM
                                    </button>
                                    {!connected && (
                                        <p style={{ margin: '8px 0 0', fontSize: '12px', color: 'var(--text-dim)' }}>
                                            Connect to your controller first to apply EEPROM settings.
                                        </p>
                                    )}
                                </div>
                            </div>
                        </>
                    ) : (
                        <div className="mp-empty">
                            <Cpu size={48} className="mp-empty-icon" />
                            <h4>Select a Profile</h4>
                            <p>Choose a machine profile from the list to view details and EEPROM settings.</p>
                        </div>
                    )}
                </div>
            </div>

            {/* ── Apply EEPROM confirm dialog ── */}
            {applyTarget && (
                <div className="mp-apply-overlay" onClick={() => setApplyTarget(null)}>
                    <div className="mp-apply-dialog" onClick={(e) => e.stopPropagation()}>
                        <h4>Apply EEPROM Settings?</h4>
                        <p>
                            This will write <strong>{Object.keys(applyTarget.eeprom).length} settings</strong> to
                            your controller for profile <strong>{applyTarget.name}</strong>.
                            Your existing EEPROM values will be overwritten.
                        </p>
                        <div className="mp-apply-preview">
                            {Object.entries(applyTarget.eeprom).map(([key, val]) => (
                                <span key={key} className="mp-apply-chip">
                                    <span className="mp-apply-chip-key">{key}=</span>
                                    {val}
                                </span>
                            ))}
                        </div>
                        <div className="mp-apply-dialog-actions">
                            <button type="button" className="mp-dialog-cancel" onClick={() => setApplyTarget(null)}>
                                Cancel
                            </button>
                            <button type="button" className="mp-dialog-apply" onClick={() => applyEEPROM(applyTarget)}>
                                Apply {Object.keys(applyTarget.eeprom).length} Settings
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
