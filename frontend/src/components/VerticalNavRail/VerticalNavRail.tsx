import { Home, Play, Box, Folder, Layers, Settings, CloudSun } from 'lucide-react';
import onefinityLogo from '../../assets/brand/onefinity-logo.png';
import { useCNCStore } from '../../stores/cncStore';
import './VerticalNavRail.css';

interface Props {
    activeTab: string;
    setActiveTab: (tab: string) => void;
}

const NAV_ITEMS = [
    { id: 'Prepare', label: 'Prepare', icon: Home },
    { id: 'Carve', label: 'Carve', icon: Play },
    { id: 'Device', label: 'Device', icon: Box },
    { id: 'Project', label: 'Project', icon: Folder },
    { id: 'Library', label: 'Library', icon: Layers },
    { id: 'Settings', label: 'Settings', icon: Settings },
];

export default function VerticalNavRail({ activeTab, setActiveTab }: Props) {
    const { machineState, jobActive } = useCNCStore();
    const isCarving = machineState === 'running' || machineState === 'paused' || jobActive;

    return (
        <aside className="v-nav-rail" aria-label="Primary Navigation">
            {/* Top Logo */}
            <div className="v-nav-logo-wrap">
                <img src={onefinityLogo} alt="Onefinity" className="v-nav-logo" />
            </div>

            {/* Navigation Tab Items */}
            <nav className="v-nav-list" role="tablist">
                {NAV_ITEMS.map((item) => {
                    const Icon = item.icon;
                    const isActive = activeTab === item.id;
                    const isLocked = isCarving && item.id !== 'Carve';

                    return (
                        <button
                            key={item.id}
                            className={`v-nav-item ${isActive ? 'active' : ''} ${isLocked ? 'locked' : ''}`}
                            onClick={() => { if (!isLocked) setActiveTab(item.id); }}
                            role="tab"
                            aria-selected={isActive}
                            aria-disabled={isLocked}
                            title={isLocked ? 'Locked while carving' : item.label}
                        >
                            <div className="v-nav-icon-box">
                                <Icon size={20} strokeWidth={isActive ? 2.2 : 1.8} />
                            </div>
                            <span className="v-nav-label">{item.label}</span>
                        </button>
                    );
                })}
            </nav>

            {/* Bottom Weather / Status */}
            <div className="v-nav-bottom">
                <div className="v-nav-weather" title="System Temperature / Status">
                    <CloudSun size={18} className="v-nav-weather-icon" />
                    <span className="v-nav-weather-text">26°C</span>
                </div>
            </div>
        </aside>
    );
}
