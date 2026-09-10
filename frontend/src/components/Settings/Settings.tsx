/**
 * Settings — top-level page wired into Header's `Settings` tab.
 *
 * Six sections:
 *   - Webcam       (cameras + live MJPEG)
 *   - Gamepad      (jog bindings)
 *   - Watch dir    (auto-detect G-code files)
 *   - Probing      (touch-off strategies)
 *   - Tools        (tool library)
 *   - History      (job history)
 *
 * Persistence happens via the backend ConfigStore (REST), so settings
 * survive process restarts and roam to all connected browsers.
 */
import { useState } from 'react';
import {
    Camera, FolderOpen, Crosshair, Wrench, History, Layers, MessageCircle, Palette, Cpu, Wifi,
} from 'lucide-react';
import SectionWebcam from './SectionWebcam';
import SectionWatchDir from './SectionWatchDir';
import SectionProbing from './SectionProbing';
import SectionTools from './SectionTools';
import SectionJobHistory from './SectionJobHistory';
import SectionSurfacing from './SectionSurfacing';
import SectionNotifications from './SectionNotifications';
import SectionAppearance from './SectionAppearance';
import SectionFirmwareUpdate from './SectionFirmwareUpdate';
import SectionRemoteAccess from './SectionRemoteAccess';
import './Settings.css';

type Tab = 'surfacing' | 'webcam' | 'watchdir' | 'probing' | 'tools' | 'history' | 'notifications' | 'appearance' | 'firmware' | 'remote';

interface TabDef { id: Tab; label: string; icon: React.ReactNode; }

// Grouped categories — easier to scan than a flat 9-row list (Tawfiq msg 7370).
// Probing already exists as its own section, so "Basics" from the Home menu
// isn't re-added here; if generic app prefs need their own section later
// they belong in a new "General" group entry.
const GROUPS: { id: string; title: string; tabs: TabDef[] }[] = [
    {
        id: 'general',
        title: 'General',
        tabs: [
            { id: 'appearance',    label: 'Appearance', icon: <Palette size={16} /> },
            { id: 'notifications', label: 'WhatsApp',   icon: <MessageCircle size={16} /> },
        ],
    },
    {
        id: 'hardware',
        title: 'Hardware',
        tabs: [
            // Gamepad dropped per Tawfiq msg 7396 — duplicates DevicePanel → Joystick.
            { id: 'webcam',   label: 'Cameras',      icon: <Camera size={16} /> },
            { id: 'watchdir', label: 'Watch folder', icon: <FolderOpen size={16} /> },
            { id: 'firmware', label: 'Firmware',     icon: <Cpu size={16} /> },
            { id: 'remote',   label: 'Remote access', icon: <Wifi size={16} /> },
        ],
    },
    {
        id: 'cnc',
        title: 'CNC',
        tabs: [
            { id: 'surfacing', label: 'Surfacing', icon: <Layers size={16} /> },
            { id: 'probing',   label: 'Probing',   icon: <Crosshair size={16} /> },
            { id: 'tools',     label: 'Tools',     icon: <Wrench size={16} /> },
        ],
    },
    {
        id: 'activity',
        title: 'Activity',
        tabs: [
            { id: 'history', label: 'Job history', icon: <History size={16} /> },
        ],
    },
];

export default function Settings() {
    const [active, setActive] = useState<Tab>('appearance');

    return (
        <div className="settings-root">
            <aside className="settings-sidebar">
                <div className="settings-sidebar-title">Settings</div>
                {GROUPS.map((g) => (
                    <div key={g.id} className="settings-sidebar-group">
                        <div className="settings-sidebar-group-title">{g.title}</div>
                        {g.tabs.map((t) => (
                            <button key={t.id}
                                className={`settings-sidebar-tab ${active === t.id ? 'active' : ''}`}
                                onClick={() => setActive(t.id)}>
                                {t.icon}<span>{t.label}</span>
                            </button>
                        ))}
                    </div>
                ))}
            </aside>

            <div className="settings-content">
                {active === 'surfacing' && <SectionSurfacing />}
                {active === 'webcam'    && <SectionWebcam />}
                {active === 'watchdir'  && <SectionWatchDir />}
                {active === 'firmware'  && <SectionFirmwareUpdate />}
                {active === 'probing'   && <SectionProbing />}
                {active === 'tools'     && <SectionTools />}
                {active === 'history'   && <SectionJobHistory />}
                {active === 'notifications' && <SectionNotifications />}
                {active === 'appearance'   && <SectionAppearance />}
                {active === 'remote'       && <SectionRemoteAccess />}
            </div>
        </div>
    );
}
