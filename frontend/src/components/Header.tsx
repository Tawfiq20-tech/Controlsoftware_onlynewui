import { useState, useRef } from 'react';
import { Square, Home, ChevronDown, AlertTriangle } from 'lucide-react';
import { useCNCStore } from '../stores/cncStore';
import { backendEstop, backendEstopClear, backendUnlock, backendMotorReset, backendClearLimitError } from '../utils/backendConnection';
import HomeMenu from './HomeMenu';
import onefinityLogo from '../assets/brand/onefinity-logo.png';
import './Header.css';

interface HeaderProps {
    activeTab: string;
    setActiveTab: (tab: string) => void;
}

const NAV_TABS = ['Prepare', 'Carve', 'Device', 'Project', 'Library', 'Settings'];

// RSP protocol axis byte (RSPController.js AXIS_X/Y/Z, confirmed backend/
// services/controllers/RSPController.js:67-69) -- EV_FAULT reports this
// same 0/1/2 index, not a per-motor id, so a Y fault could be either belt.
const RSP_AXIS_NAMES: Record<number, string> = { 0: 'X', 1: 'Y', 2: 'Z' };

export default function Header({ activeTab, setActiveTab }: HeaderProps) {
    const [homeMenuOpen, setHomeMenuOpen] = useState(false);
    const homeBtnRef = useRef<HTMLButtonElement>(null);
    const [alarmDetailsOpen, setAlarmDetailsOpen] = useState(false);

    const {
        connected,
        machineState,
        feedRate,
        spindleSpeed,
        isInitialized,
        firmwareType,
        firmwareVersion,
        lastAlarm,
        addConsoleLog
    } = useCNCStore();

    const getStatusText = () => {
        if (!connected) return 'OFFLINE';
        if (connected && !isInitialized) return 'INITIALIZING';
        return machineState.toUpperCase();
    };

    const getStatusDotClass = () => {
        if (!connected) return 'disconnected';
        if (connected && !isInitialized) return 'initializing';
        return machineState;
    };

    return (
        <>
        <header className="header flex items-center justify-between h-12 px-4 bg-bg-sidebar border-b border-border-ui">
            <div className="header-left flex items-center gap-3">
                {/* Onefinity brand logo (Tawfiq msg 7389) — sits to the LEFT
                    of the home icon so the product identity is the first
                    thing on the screen. */}
                <img src={onefinityLogo} alt="Onefinity" className="header-brand-logo" />

                {/* Home button + dropdown */}
                <div className="header-home-wrap">
                    <button
                        ref={homeBtnRef}
                        type="button"
                        className={`home-btn flex items-center gap-1 px-3 py-1.5 text-text-dim hover:text-text-main transition-colors duration-fast ${homeMenuOpen ? 'active' : ''}`}
                        aria-label="Home menu"
                        aria-expanded={homeMenuOpen}
                        aria-haspopup="dialog"
                        onClick={() => setHomeMenuOpen((v) => !v)}
                    >
                        <Home size={16} />
                        <ChevronDown size={8} />
                    </button>
                    <HomeMenu
                        isOpen={homeMenuOpen}
                        onClose={() => setHomeMenuOpen(false)}
                        anchorRef={homeBtnRef}
                    />
                </div>

                {/* Navigation Tabs — non-Carve tabs lock during an active carve job. */}
                <nav className="nav-tabs flex" role="tablist">
                    {NAV_TABS.map(tab => {
                        const isCarving = machineState === 'running' || machineState === 'paused';
                        const locked = isCarving && tab !== 'Carve';
                        return (
                            <button
                                key={tab}
                                className={`nav-tab px-4 py-2 text-sm font-medium transition-colors duration-fast border-b-2 ${
                                    activeTab === tab
                                        ? 'text-primary border-primary'
                                        : 'text-text-dim border-transparent hover:text-text-main'
                                } ${locked ? 'nav-tab-locked' : ''}`}
                                role="tab"
                                aria-selected={activeTab === tab}
                                aria-disabled={locked}
                                title={locked ? 'Pause carve first' : tab}
                                onClick={() => { if (!locked) setActiveTab(tab); }}
                            >
                                {tab}
                            </button>
                        );
                    })}
                </nav>
            </div>

            {/* Center — Status */}
            <div className="header-center flex items-center gap-4">
                <div className="machine-status-pill flex items-center gap-2 px-3 py-1 bg-bg-panel border border-border-ui rounded-md">
                    <div className={`status-dot w-2 h-2 rounded-full ${getStatusDotClass()}`} />
                    <span className="text-xs font-semibold text-text-main tracking-wider">{getStatusText()}</span>
                </div>

                {connected && isInitialized && (
                    <>
                        <div className="metric-inline text-xs text-text-dim font-mono">
                            F <span className="metric-val text-primary font-bold">{(feedRate * 32.4).toFixed(0)}</span> mm/min
                        </div>
                        <div className="metric-inline text-xs text-text-dim font-mono">
                            S <span className="metric-val text-primary font-bold">{(spindleSpeed * 185).toFixed(0)}</span> RPM
                        </div>
                        {firmwareType !== 'unknown' && (
                            <div className="metric-inline text-xs text-text-dim font-mono">
                                <span className="metric-val text-primary font-bold">{firmwareType}</span> {firmwareVersion}
                            </div>
                        )}
                    </>
                )}
            </div>

            {/* Right — Actions */}
            <div className="header-right">
                <button
                    className={`btn-danger flex items-center gap-2 px-3 py-1.5 text-xs font-bold rounded-md border transition-all duration-fast ${
                        !connected 
                            ? 'opacity-30 cursor-not-allowed bg-bg-panel border-border-ui text-text-dim' 
                            : 'bg-status-danger border-status-danger text-white hover:bg-red-600 hover:border-red-600'
                    }`}
                    disabled={!connected}
                    onClick={() => {
                        try {
                            backendEstop();
                            addConsoleLog('error', '*** EMERGENCY STOP ACTIVATED ***');
                        } catch (_) {}
                    }}
                >
                    <Square size={12} fill="currentColor" />
                    E-Stop
                </button>
            </div>
        </header>

        {/* Error / Alarm Popup — modal overlay, not just an inline banner
            (Tawfiq msg11440: the old below-header bar was easy to miss on
            another tab, so the only way he noticed the machine was locked
            was after trying to jog/probe and getting confused -- a blocking
            popup surfaces it the instant the alarm fires, on every tab). */}
        {connected && (machineState === 'alarm' || machineState === 'motorError') && (
            <div style={{
                position: 'fixed',
                inset: 0,
                background: 'rgba(0,0,0,0.6)',
                zIndex: 9999,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
            }}>
            <div style={{
                display: 'flex',
                flexDirection: 'column',
                background: machineState === 'motorError' ? '#e74c3c' : '#f39c12',
                color: '#fff',
                fontSize: '13px',
                fontWeight: 'bold',
                borderRadius: '8px',
                boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
                maxWidth: '520px',
                width: '90%',
            }}>
                <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '12px 16px',
                    gap: '12px',
                }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <AlertTriangle size={16} />
                        <span>
                            {machineState === 'motorError'
                                ? 'MOTOR ERROR — Closed-loop position error detected. Check motor wiring.'
                                : 'ALARM — Machine is locked. Clear alarm to continue.'}
                        </span>
                    </div>
                    <div style={{ display: 'flex', gap: '6px' }}>
                        <button
                            onClick={() => setAlarmDetailsOpen((v) => !v)}
                            aria-expanded={alarmDetailsOpen}
                            style={{ display: 'flex', alignItems: 'center', gap: '4px', padding: '4px 12px', fontSize: '11px', background: 'rgba(255,255,255,0.2)', color: '#fff', border: '1px solid rgba(255,255,255,0.4)', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}
                        >
                            Details <ChevronDown size={12} style={{ transform: alarmDetailsOpen ? 'rotate(180deg)' : 'none' }} />
                        </button>
                        {machineState === 'motorError' && (
                            <button
                                onClick={() => { backendMotorReset(); addConsoleLog('info', 'Resetting all motors (X, Y1, Y2, Z)...'); }}
                                style={{ padding: '4px 12px', fontSize: '11px', background: 'rgba(255,255,255,0.2)', color: '#fff', border: '1px solid rgba(255,255,255,0.4)', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}
                            >
                                Reset Motors
                            </button>
                        )}
                        <button
                            onClick={() => { backendClearLimitError(); addConsoleLog('info', 'Clearing limit error...'); }}
                            style={{ padding: '4px 12px', fontSize: '11px', background: 'rgba(255,255,255,0.2)', color: '#fff', border: '1px solid rgba(255,255,255,0.4)', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}
                        >
                            Clear Limit
                        </button>
                        <button
                            onClick={() => { backendEstopClear(); backendUnlock(); addConsoleLog('info', 'Clearing alarm...'); }}
                            style={{ padding: '4px 12px', fontSize: '11px', background: 'rgba(255,255,255,0.2)', color: '#fff', border: '1px solid rgba(255,255,255,0.4)', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}
                        >
                            Clear Alarm
                        </button>
                    </div>
                </div>

                {/* Alarm-detail dropdown -- Tawfiq msg11378 item 4: which
                    axis tripped, plus an unlock-and-continue path scoped to
                    just that axis instead of blind "Reset All". */}
                {alarmDetailsOpen && (
                    <div style={{
                        padding: '8px 16px 12px',
                        background: 'rgba(0,0,0,0.15)',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '8px',
                        fontWeight: 'normal',
                    }}>
                        <div style={{ fontSize: '12px', fontFamily: 'monospace' }}>
                            {lastAlarm ? (
                                <>
                                    type: {lastAlarm.type ?? 'n/a'}
                                    {lastAlarm.axis !== undefined && ` · axis: ${RSP_AXIS_NAMES[lastAlarm.axis] ?? lastAlarm.axis}`}
                                    {lastAlarm.code !== undefined && ` · code: ${lastAlarm.code}`}
                                    {lastAlarm.message && ` · ${lastAlarm.message}`}
                                    {lastAlarm.description && ` — ${lastAlarm.description}`}
                                </>
                            ) : (
                                'No alarm detail reported by the controller for this trip.'
                            )}
                        </div>
                        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                            {['X', 'Y1', 'Y2', 'Z'].map((motor) => {
                                const trippedName = lastAlarm?.axis !== undefined ? RSP_AXIS_NAMES[lastAlarm.axis] : undefined;
                                const isTripped = trippedName && (motor === trippedName || (trippedName === 'Y' && (motor === 'Y1' || motor === 'Y2')));
                                return (
                                    <button
                                        key={motor}
                                        onClick={() => { backendMotorReset(motor === 'Y1' || motor === 'Y2' ? 'Y' : motor); addConsoleLog('info', `Resetting ${motor} motor...`); }}
                                        style={{
                                            padding: '4px 10px',
                                            fontSize: '11px',
                                            background: isTripped ? '#fff' : 'rgba(255,255,255,0.2)',
                                            color: isTripped ? '#c0392b' : '#fff',
                                            border: isTripped ? '2px solid #fff' : '1px solid rgba(255,255,255,0.4)',
                                            borderRadius: '4px',
                                            cursor: 'pointer',
                                            fontWeight: 'bold',
                                        }}
                                        title={isTripped ? `${motor} is the axis that tripped` : `Reset ${motor} motor`}
                                    >
                                        Reset {motor}{isTripped ? ' ⚠' : ''}
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                )}
            </div>
            </div>
        )}
        </>
    );
}
