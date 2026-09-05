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
        name: 'Carbon Orange',
        tagline: 'Dark navy · orange accent',
        icon: <Moon size={16} />,
        swatches: ['#0e1015', '#15171f', '#181b25', '#f59e0b', '#e2e8f0', '#283040'],
    },
    {
        id: 'light',
        name: 'Stack Overflow Light',
        tagline: 'Light · soft grey · orange accent',
        icon: <Sun size={16} />,
        swatches: ['#f8f9f9', '#ffffff', '#f1f2f3', '#f48024', '#232629', '#d6d9dc'],
    },
];

export default function SectionAppearance() {
    const [active, setActive] = useState<ThemeId>(getStoredTheme());

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
        </div>
    );
}
