import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { toollib, type ToolDef } from './api';

const BLANK: ToolDef = {
    number: 1, name: 'New tool',
    diameter: 6.35, flutes: 2, stickout: 22,
    material: 'carbide', coating: 'TiAlN',
    defaultFeed: 1500, defaultPlunge: 400, defaultRpm: 18000,
    defaultStepdown: 1.0, defaultStepover: 3.0,
    length: 50, notes: '',
};

export default function SectionTools() {
    const [tools, setTools] = useState<ToolDef[]>([]);
    const [editing, setEditing] = useState<ToolDef | null>(null);
    const [err, setErr] = useState<string | null>(null);

    const refresh = async () => {
        try { setTools(await toollib.list()); }
        catch (e) { setErr(String(e)); }
    };
    useEffect(() => { refresh(); }, []);

    const save = async () => {
        if (!editing) return;
        try { await toollib.upsert(editing); setEditing(null); refresh(); }
        catch (e) { setErr(String(e)); }
    };

    return (
        <div className="settings-section">
            <div className="settings-section-header">
                <div>
                    <h3>Tool library</h3>
                    <p className="settings-section-sub">
                        Named tools with default feeds/speeds. Used by the job pre-flight check
                        and the inspector when picking a tool.
                    </p>
                </div>
                <button className="settings-btn primary"
                    onClick={() => setEditing({ ...BLANK, number: (tools[tools.length - 1]?.number || 0) + 1 })}>
                    <Plus size={14} /> Add tool
                </button>
            </div>

            {err && <div className="settings-error">{err}</div>}

            <div className="settings-tool-table">
                <div className="settings-tool-row head">
                    <span>T#</span><span>Name</span><span>Ø mm</span><span>Flutes</span>
                    <span>Feed</span><span>RPM</span><span>Stepdown</span><span></span>
                </div>
                {tools.map(t => (
                    <div className="settings-tool-row" key={t.number}>
                        <span>T{t.number}</span>
                        <span>{t.name}</span>
                        <span>{t.diameter.toFixed(2)}</span>
                        <span>{t.flutes}</span>
                        <span>{t.defaultFeed}</span>
                        <span>{t.defaultRpm}</span>
                        <span>{t.defaultStepdown}</span>
                        <span className="settings-tool-actions">
                            <button className="settings-btn" onClick={() => setEditing({ ...t })}>Edit</button>
                            <button className="settings-btn danger" onClick={async () => {
                                await toollib.remove(t.number); refresh();
                            }}><Trash2 size={12} /></button>
                        </span>
                    </div>
                ))}
            </div>

            {editing && (
                <div className="settings-form">
                    <h4>{tools.find(t => t.number === editing.number) ? `Edit T${editing.number}` : 'New tool'}</h4>
                    <div className="settings-grid-3">
                        <label>Tool #<input type="number" value={editing.number}
                            onChange={e => setEditing({ ...editing, number: +e.target.value })} /></label>
                        <label>Name<input value={editing.name}
                            onChange={e => setEditing({ ...editing, name: e.target.value })} /></label>
                        <label>Diameter (mm)<input type="number" step="0.01" value={editing.diameter}
                            onChange={e => setEditing({ ...editing, diameter: +e.target.value })} /></label>
                        <label>Flutes<input type="number" value={editing.flutes}
                            onChange={e => setEditing({ ...editing, flutes: +e.target.value })} /></label>
                        <label>Stickout (mm)<input type="number" value={editing.stickout}
                            onChange={e => setEditing({ ...editing, stickout: +e.target.value })} /></label>
                        <label>Length (mm)<input type="number" value={editing.length}
                            onChange={e => setEditing({ ...editing, length: +e.target.value })} /></label>
                        <label>Material<select value={editing.material}
                            onChange={e => setEditing({ ...editing, material: e.target.value })}>
                            <option>carbide</option><option>hss</option><option>diamond</option>
                        </select></label>
                        <label>Coating<select value={editing.coating}
                            onChange={e => setEditing({ ...editing, coating: e.target.value })}>
                            <option>none</option><option>TiN</option><option>TiAlN</option>
                        </select></label>
                        <label>Default feed<input type="number" value={editing.defaultFeed}
                            onChange={e => setEditing({ ...editing, defaultFeed: +e.target.value })} /></label>
                        <label>Default plunge<input type="number" value={editing.defaultPlunge}
                            onChange={e => setEditing({ ...editing, defaultPlunge: +e.target.value })} /></label>
                        <label>Default RPM<input type="number" value={editing.defaultRpm}
                            onChange={e => setEditing({ ...editing, defaultRpm: +e.target.value })} /></label>
                        <label>Default stepdown<input type="number" step="0.1" value={editing.defaultStepdown}
                            onChange={e => setEditing({ ...editing, defaultStepdown: +e.target.value })} /></label>
                        <label>Default stepover<input type="number" step="0.1" value={editing.defaultStepover}
                            onChange={e => setEditing({ ...editing, defaultStepover: +e.target.value })} /></label>
                    </div>
                    <label>Notes<textarea value={editing.notes || ''} rows={2}
                        onChange={e => setEditing({ ...editing, notes: e.target.value })} /></label>
                    <div className="settings-form-actions">
                        <button className="settings-btn" onClick={() => setEditing(null)}>Cancel</button>
                        <button className="settings-btn primary" onClick={save}>Save</button>
                    </div>
                </div>
            )}
        </div>
    );
}
