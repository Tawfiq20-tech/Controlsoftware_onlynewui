import { useEffect, useRef, useState } from 'react';
import { Cpu, Monitor, Wifi, Keyboard } from 'lucide-react';
import { useCNCStore } from '../stores/cncStore';
import {
    setBackendActiveMachineProfile,
    setBackendConfig,
} from '../utils/backendConnection';
import OnScreenKeyboard from './OnScreenKeyboard';
import './HomeMenu.css';

type HomeMenuSection = 'machine' | 'device' | 'ethernet';

// Probe settings + Basics removed per Tawfiq msg 7370 — Probe settings is
// owned by the ProbingModal now; Basics moved to Settings → General.
const SECTIONS: { id: HomeMenuSection; label: string; Icon: React.ComponentType<{ size?: string | number; className?: string }> }[] = [
    { id: 'machine', label: 'Machine Information', Icon: Cpu },
    { id: 'device', label: 'Device Info', Icon: Monitor },
    { id: 'ethernet', label: 'Ethernet', Icon: Wifi },
];

interface HomeMenuProps {
    isOpen: boolean;
    onClose: () => void;
    anchorRef: React.RefObject<HTMLButtonElement | null>;
}

export default function HomeMenu({ isOpen, onClose, anchorRef }: HomeMenuProps) {
    const panelRef = useRef<HTMLDivElement>(null);
    const keyboardPanelRef = useRef<HTMLDivElement>(null);
    const [selectedSection, setSelectedSection] = useState<HomeMenuSection>('machine');
    const [keyboardTarget, setKeyboardTarget] = useState<HTMLInputElement | null>(null);

    const {
        connected,
        connectedPortInfo,
        machineProfiles,
        activeMachineProfile,
        setActiveMachineProfile,
        ethernet,
        setEthernet,
    } = useCNCStore();

    const activeProfile = activeMachineProfile
        ? machineProfiles.find((p) => p.id === activeMachineProfile)
        : null;

    useEffect(() => {
        if (!isOpen) return;
        const handleClick = (e: MouseEvent) => {
            if (
                panelRef.current?.contains(e.target as Node) ||
                anchorRef.current?.contains(e.target as Node) ||
                keyboardPanelRef.current?.contains(e.target as Node)
            )
                return;
            onClose();
        };
        document.addEventListener('mousedown', handleClick);
        return () => document.removeEventListener('mousedown', handleClick);
    }, [isOpen, onClose, anchorRef]);

    useEffect(() => {
        if (!isOpen) setKeyboardTarget(null);
    }, [isOpen]);

    const updateEthernet = (connectToIP: string) => {
        const next = { connectToIP };
        setEthernet(next);
        setBackendConfig('ethernet', next);
    };


    const openKeyboardForInput = (e: React.MouseEvent<HTMLButtonElement>) => {
        e.stopPropagation();
        const wrap = (e.currentTarget as HTMLElement).closest('.home-menu-input-with-kb, .home-menu-input-wrap');
        const input = wrap?.querySelector('input');
        if (input instanceof HTMLInputElement) {
            setKeyboardTarget(input);
            input.focus();
        }
    };

    if (!isOpen) return null;

    return (
        <div
            ref={panelRef}
            className="home-menu-panel"
            role="dialog"
            aria-label="Home menu - Machine and device settings"
        >
            {/* Left: headings only */}
            <nav className="home-menu-nav" aria-label="Settings sections">
                {SECTIONS.map(({ id, label, Icon }) => (
                    <button
                        key={id}
                        type="button"
                        className={`home-menu-nav-item ${selectedSection === id ? 'active' : ''}`}
                        onClick={() => setSelectedSection(id)}
                    >
                        <Icon size={18} className="home-menu-nav-icon" />
                        <span className="home-menu-nav-label">{label}</span>
                    </button>
                ))}
            </nav>

            {/* Right: content for selected section */}
            <div className="home-menu-detail">
                {selectedSection === 'machine' && (
                    <>
                        <h4 className="home-menu-section-title">Machine Information</h4>
                        <div className="home-menu-row">
                            <label className="home-menu-label">Machine profile</label>
                            <select
                                className="home-menu-select"
                                value={activeMachineProfile ?? ''}
                                onChange={(e) => {
                                    const id = e.target.value || null;
                                    setActiveMachineProfile(id);
                                    setBackendActiveMachineProfile(id);
                                }}
                            >
                                {machineProfiles.map((p) => (
                                    <option key={p.id} value={p.id}>
                                        {p.name}
                                    </option>
                                ))}
                            </select>
                        </div>
                        {activeProfile && (
                            <>
                                {activeProfile.voltage && (
                                    <div className="home-menu-row">
                                        <span className="home-menu-label">Voltage</span>
                                        <span className="home-menu-value">{activeProfile.voltage}</span>
                                    </div>
                                )}
                                {activeProfile.workArea && (
                                    <div className="home-menu-row">
                                        <span className="home-menu-label">Work area</span>
                                        <span className="home-menu-value">{activeProfile.workArea}</span>
                                    </div>
                                )}
                            </>
                        )}
                    </>
                )}

                {selectedSection === 'device' && (
                    <>
                        <h4 className="home-menu-section-title">Device Info</h4>
                        {connected && connectedPortInfo ? (
                            <>
                                <div className="home-menu-row">
                                    <span className="home-menu-label">Port</span>
                                    <span className="home-menu-value">{connectedPortInfo.port}</span>
                                </div>
                                {connectedPortInfo.manufacturer && (
                                    <div className="home-menu-row">
                                        <span className="home-menu-label">Manufacturer</span>
                                        <span className="home-menu-value">{connectedPortInfo.manufacturer}</span>
                                    </div>
                                )}
                                {connectedPortInfo.vendorId && (
                                    <div className="home-menu-row">
                                        <span className="home-menu-label">Vendor ID</span>
                                        <span className="home-menu-value">{connectedPortInfo.vendorId}</span>
                                    </div>
                                )}
                                <div className="home-menu-row">
                                    <span className="home-menu-label">Baud Rate</span>
                                    <span className="home-menu-value">115200</span>
                                </div>
                            </>
                        ) : (
                            <div className="home-menu-row">
                                <span className="home-menu-dim">Not connected</span>
                            </div>
                        )}
                    </>
                )}

                {selectedSection === 'ethernet' && (
                    <>
                        <h4 className="home-menu-section-title">Ethernet</h4>
                        <div className="home-menu-row home-menu-row-with-desc">
                            <label className="home-menu-label">Connect to IP</label>
                            <div className="home-menu-input-with-kb">
                                <input
                                    type="text"
                                    className="home-menu-ip-input"
                                    value={ethernet.connectToIP}
                                    onChange={(e) => updateEthernet(e.target.value)}
                                    placeholder="192.168.5.1"
                                />
                                <button
                                    type="button"
                                    className="home-menu-kb-btn"
                                    aria-label="Open on-screen keyboard"
                                    title="Open on-screen keyboard"
                                    onClick={openKeyboardForInput}
                                >
                                    <Keyboard size={14} />
                                </button>
                            </div>
                            <p className="home-menu-desc">
                                IP address used to connect to CNCs over Ethernet. (Default 192.168.5.1)
                            </p>
                        </div>
                    </>
                )}

            </div>
            <OnScreenKeyboard
                targetInput={keyboardTarget}
                onClose={() => setKeyboardTarget(null)}
                panelRef={keyboardPanelRef}
            />
        </div>
    );
}
