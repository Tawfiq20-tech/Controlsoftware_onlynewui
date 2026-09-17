/**
 * SectionAppearance — theme picker.
 *
 * Two themes for v1:
 *   - Dark  (Desert Sandstone w/ orange accent)  — default
 *   - Light (Pebble Track, cream w/ brown accent)
 *
 * Selection persists via localStorage and broadcasts a 'cnc:theme' event so
 * the 3D scene re-colors itself without a remount.
 */
import { useEffect, useState } from 'react';
import { Palette, Sun, Moon, Check } from 'lucide-react';
import { ThemeId, getStoredTheme, setTheme, onThemeChange } from '../../utils/theme';
import { Keyboard } from 'lucide-react';
import { isOskEnabled, setOskEnabled } from '../../utils/onScreenKeyboard';

interface ThemeCard {
    id: ThemeId;
    name: string;
    tagline: string;
    icon: React.ReactNode;
    swatches: string[];
}

const THEMES: ThemeCard[] = [
    {
        id: 'dark',
        name: 'Minimal Grey – Dark',
        tagline: 'Clean macOS dark design · low light optimized',
        icon: <Moon size={16} />,
        swatches: ['#16191e', '#1d2127', '#252a32', '#383f4d', '#e6edf3', '#30363d'],
    },
    {
        id: 'light',
        name: 'Minimal Grey – Light',
        tagline: 'Clean, modern and professional macOS light design',
        icon: <Sun size={16} />,
        swatches: ['#ebedf0', '#f4f5f8', '#ffffff', '#5a6578', '#1e293b', '#d0d5dd'],
    },
];

export default function SectionAppearance() {
    const [active, setActive] = useState<ThemeId>(getStoredTheme());
    const [osk, setOsk] = useState<boolean>(isOskEnabled);

    useEffect(() => {
        const off = onThemeChange((t) => setActive(t));
        return off;
    }, []);

    function pick(id: ThemeId) {
        setActive(id);
        setTheme(id);
    }

    return (
        <div className="settings-section">
            <header className="settings-section-header">
                <div className="settings-section-title">
                    <Palette size={18} /> Appearance
                </div>
            </header>

            <div className="theme-grid">
                {THEMES.map((t) => (
                    <button key={t.id}
                        className={`theme-card ${active === t.id ? 'on' : ''}`}
                        onClick={() => pick(t.id)}
                        aria-pressed={active === t.id}>
                        <div className="theme-card-header">
                            {t.icon}
                            <span className="theme-card-name">{t.name}</span>
                            {active === t.id && <span className="theme-card-check"><Check size={14} /></span>}
                        </div>
                        <div className="theme-card-tagline">{t.tagline}</div>
                        <div className="theme-swatches">
                            {t.swatches.map((c, i) => (
                                <span key={i} className="theme-swatch" style={{ background: c }} />
                            ))}
                        </div>
                    </button>
                ))}
            </div>

            <div className="theme-hint">
                Theme applies instantly across the app, the 3D viewer, and the Carve controls.
                Your choice is remembered on this browser.
            </div>

            <header className="settings-section-header" style={{ marginTop: 22 }}>
                <div className="settings-section-title">
                    <Keyboard size={18} /> On-screen keyboard
                </div>
            </header>

            <button
                type="button"
                className={`theme-card ${osk ? 'on' : ''}`}
                onClick={() => { const next = !osk; setOsk(next); setOskEnabled(next); }}
                aria-pressed={osk}
            >
                <div className="theme-card-header">
                    <Keyboard size={16} />
                    <span className="theme-card-name">{osk ? 'On' : 'Off'}</span>
                    {osk && <span className="theme-card-check"><Check size={14} /></span>}
                </div>
                <div className="theme-card-tagline">
                    A touch keyboard opens whenever you tap a text or number field.
                </div>
            </button>

            <div className="theme-hint">
                Leave this on for the touchscreen. Turn it off if this machine has a
                physical keyboard. Remembered on this browser.
            </div>
        </div>
    );
}
