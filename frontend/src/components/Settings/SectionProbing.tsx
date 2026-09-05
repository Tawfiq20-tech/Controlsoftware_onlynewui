import { useEffect, useState } from 'react';
import { probing, type ProbeStrategyMeta } from './api';

export default function SectionProbing() {
    const [strategies, setStrategies] = useState<ProbeStrategyMeta[]>([]);
    const [activeWcs, setActiveWcs] = useState('G54');
    const [running, setRunning] = useState<string | null>(null);
    const [lastResult, setLastResult] = useState<string | null>(null);

    useEffect(() => { probing.strategies().then(setStrategies).catch(() => {}); }, []);

    const run = async (id: string) => {
        setRunning(id); setLastResult(null);
        try {
            const r = await probing.run({ strategy: id, wcs: activeWcs });
            setLastResult(`${id}: ${r.success ? 'OK' : 'FAIL'} — ${JSON.stringify(r.updates)}`);
        } catch (e) {
            setLastResult(`${id}: ERROR — ${String(e)}`);
        } finally {
            setRunning(null);
        }
    };

    return (
        <div className="settings-section">
            <div className="settings-section-header">
                <div>
                    <h3>Probe strategies</h3>
                    <p className="settings-section-sub">
                        Built-in touch-off wizards. Pre-position the spindle near the
                        touch plate, pick a strategy, hit run.
                    </p>
                </div>
                <label className="settings-inline-field">
                    Active WCS
                    <select value={activeWcs} onChange={e => setActiveWcs(e.target.value)}>
                        {['G54', 'G55', 'G56', 'G57', 'G58', 'G59'].map(w =>
                            <option key={w} value={w}>{w}</option>)}
                    </select>
                </label>
            </div>

            <div className="settings-strategy-grid">
                {strategies.map(s => (
                    <button key={s.id} className="settings-strategy-card"
                        disabled={!!running}
                        onClick={() => run(s.id)}>
                        <div className="settings-strategy-name">{s.name}</div>
                        <div className="settings-strategy-id">{s.id}</div>
                        {running === s.id && <div className="settings-strategy-running">running…</div>}
                    </button>
                ))}
            </div>

            {lastResult && (
                <div className="settings-result">
                    <b>Last run:</b> <code>{lastResult}</code>
                </div>
            )}
        </div>
    );
}
