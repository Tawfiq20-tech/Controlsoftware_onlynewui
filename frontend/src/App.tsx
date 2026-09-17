import { useEffect, useState } from 'react';
import './App.css';
// Touchscreen overrides -- every rule is scoped to `.app.is-vertical`,
// so the horizontal layout is untouched.
import './styles/vertical-touch.css';
import Header from './components/Header';
import Sidebar from './components/Sidebar';
import Visualizer3D, { GcodePanel } from './components/Visualizer3D/Visualizer3D';
import DevicePanel from './components/DevicePanel';
import ProjectPanel from './components/ProjectPanel';
import Settings from './components/Settings/Settings';
import Library from './components/Library/Library';
import ErrorBoundary from './components/ErrorBoundary';
import StatusBar from './components/StatusBar';
import HomingOverlay from './components/HomingOverlay';
import { SafetyBanner } from './components/SafetyBanner';
import ResizeHandle from './components/ResizeHandle';
import ProbingModal from './components/ProbingModal/ProbingModal';
import ChatBot from './components/ChatBot/ChatBot';
import RemotePinGate from './components/RemotePinGate';
import OnScreenKeyboard from './components/OnScreenKeyboard/OnScreenKeyboard';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useAutoConnect } from './hooks/useAutoConnect';
import { useJobWakeLock } from './hooks/useJobWakeLock';
import { useCNCStore } from './stores/cncStore';
import { sendDesign } from './utils/designLoad';
import { GCodeParser } from './utils/gcodeParser';

// The app ships vertical-only (touchscreen pendant). The Auto/Horizontal/
// Vertical header toggle was removed, so the layout is fixed here.
const layout = 'vertical' as const;
const isVertical = true;

function AppInner() {
    const [activeHeaderTab, setActiveHeaderTab] = useState('Prepare');
    const [probingOpen, setProbingOpen] = useState(false);
    const [probingType, setProbingType] = useState<'z' | 'xyz' | null>(null);

    // Backend socket bootstrap + auto-connect poll -- must run regardless
    // of which header tab is active (Tawfiq msg11358 item 3). See
    // hooks/useAutoConnect.ts for why this can't live inside DevicePanel.
    useAutoConnect();

    // Don't let the PC fall asleep mid-carve: the controller stops the machine
    // by itself when the USB port suspends with it.
    useJobWakeLock();

    // Push the parsed G-code to the backend feeder as soon as it's available and
    // the backend has a live controller instance. This is the single source of
    // truth for the file:load dispatch -- it used to be duplicated in
    // JobControlBar.tsx too (which mounts conditionally via Visualizer3D.tsx's
    // showCarveBar), and having both effects race on the same fileLoadedBackend
    // check caused two overlapping file:load emits and a redundant backend
    // reparse/reload (HIGH#8). That duplicate was removed; this app-root effect
    // is the only one left, so it must stay mounted unconditionally. Gating on
    // controllerReady (not just `connected`) avoids the race where `connected`
    // flips true the instant the serial port opens but the backend's controller
    // instance isn't assigned until firmware detection finishes ~100-200ms later.
    const {
        connected,
        controllerReady,
        rawGcodeContent,
        fileLoadedBackend,
        fileInfo,
        gcode,
        currentLine,
        setGcode,
        setToolpathSegments,
        setParsedToolpath,
        addConsoleLog,
        otherScreenFile,
        outlineRunActive,
    } = useCNCStore();
    useEffect(() => {
        if (!connected) return;
        if (!controllerReady) return;
        if (!rawGcodeContent) return;
        if (fileLoadedBackend) return;
        // Another screen's design is on the machine. Never load this screen's
        // design over it by itself: two screens used to swap the machine's
        // program back and forth forever, and Play ran whichever landed last.
        // The operator re-loads deliberately (banner button / open the file).
        if (otherScreenFile) return;
        // Run Outline has outline.gcode on the machine on purpose; RunOutline
        // loads the design back itself when the outline is over.
        if (outlineRunActive) return;
        sendDesign(fileInfo?.name || 'job.gcode', rawGcodeContent);
    }, [connected, controllerReady, rawGcodeContent, fileLoadedBackend, fileInfo?.name, otherScreenFile, outlineRunActive]);

    // rawGcodeContent/fileInfo survive a page refresh via localStorage
    // (cncStore.ts gcodeFileStorage), but the parsed `gcode` array that
    // drives the 3D toolpath and the G-code line panel does not -- it's
    // only ever built by the manual-upload handlers (Sidebar.tsx etc).
    // Without this, a refresh left the file "loaded" but the toolpath/
    // line panel blank until the user re-uploaded (Tawfiq msg11347 item
    // 5). Runs once on mount, using the exact same parser Sidebar.tsx
    // uses for a fresh upload, only when content was restored but never
    // parsed this session.
    useEffect(() => {
        if (!rawGcodeContent || gcode.length > 0) return;
        try {
            const result = new GCodeParser().parseGCode(rawGcodeContent);
            if (result.lines && result.lines.length > 0) {
                setGcode(result.lines);
                setToolpathSegments(result.segments);
                if (result.parsedToolpath) {
                    setParsedToolpath(result.parsedToolpath);
                }
                addConsoleLog('info', `Restored ${result.lines.length} G-code lines from last session`);
            }
        } catch (error) {
            console.error('Error re-parsing restored G-code:', error);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Non-copyable UI (Tawfiq msg12266) — text selection is already locked
    // down globally via index.css `body { user-select: none }` (Tawfiq's own
    // commit 770ebfcd). This closes the other route to the same content: the
    // browser's native right-click menu (Inspect/View Source/Save As/Copy).
    // Left enabled on inputs/textarea/contenteditable so users can still
    // paste values (e.g. numeric fields) via right-click — same exception
    // index.css already carves out for text-select.
    useEffect(() => {
        const blockContextMenu = (e: MouseEvent) => {
            const target = e.target as HTMLElement;
            if (target.closest('input, textarea, [contenteditable="true"]')) return;
            e.preventDefault();
        };

        // Desktop App Mode: Block browser refresh keystrokes (F5, Ctrl+R, Ctrl+Shift+R, Ctrl+F5)
        // so the software interface never reloads accidentally on keypresses.
        const blockRefreshKeys = (e: KeyboardEvent) => {
            const isRefreshKey = 
                e.key === 'F5' || 
                (e.key === 'r' && (e.ctrlKey || e.metaKey)) ||
                (e.key === 'R' && (e.ctrlKey || e.metaKey));

            if (isRefreshKey) {
                e.preventDefault();
                e.stopPropagation();
            }
        };

        // Prevent accidental browser reload / tab close when connected or working
        const handleBeforeUnload = (e: BeforeUnloadEvent) => {
            const state = useCNCStore.getState();
            if (state.connected || state.machineState === 'running') {
                e.preventDefault();
                e.returnValue = 'A CNC session is active. Are you sure you want to exit?';
                return e.returnValue;
            }
        };

        // Non-copyable UI: Block copy, cut, and selection globally on non-editable elements
        const blockCopy = (e: ClipboardEvent) => {
            const target = e.target as HTMLElement;
            if (target.closest('input, textarea, [contenteditable="true"]')) return;
            e.preventDefault();
        };

        const blockCut = (e: ClipboardEvent) => {
            const target = e.target as HTMLElement;
            if (target.closest('input, textarea, [contenteditable="true"]')) return;
            e.preventDefault();
        };

        const blockSelectStart = (e: Event) => {
            const target = e.target as HTMLElement;
            if (target.closest('input, textarea, [contenteditable="true"]')) return;
            e.preventDefault();
        };

        document.addEventListener('contextmenu', blockContextMenu);
        document.addEventListener('copy', blockCopy);
        document.addEventListener('cut', blockCut);
        document.addEventListener('selectstart', blockSelectStart);
        window.addEventListener('keydown', blockRefreshKeys, true);
        window.addEventListener('beforeunload', handleBeforeUnload);

        return () => {
            document.removeEventListener('contextmenu', blockContextMenu);
            document.removeEventListener('copy', blockCopy);
            document.removeEventListener('cut', blockCut);
            document.removeEventListener('selectstart', blockSelectStart);
            window.removeEventListener('keydown', blockRefreshKeys, true);
            window.removeEventListener('beforeunload', handleBeforeUnload);
        };
    }, []);

    // Activate global keyboard shortcuts — Ctrl+O triggers file open via sidebar
    useKeyboardShortcuts(() => {
        // Try to find and trigger the file input in Sidebar
        const fileInput = document.querySelector<HTMLInputElement>('input[type="file"][accept]');
        if (fileInput) fileInput.click();
    });

    // Sidebar PROBE tab tiles fire a CustomEvent with detail.type so we
    // know which routine to open. Modal then skips its own type-pick step.
    useEffect(() => {
        const open = (e: Event) => {
            const detail = (e as CustomEvent<{ type?: 'z' | 'xyz' }>).detail;
            setProbingType(detail?.type ?? null);
            setProbingOpen(true);
        };
        window.addEventListener('cnc:open-probing', open);
        return () => window.removeEventListener('cnc:open-probing', open);
    }, []);

    // Deep link into a Settings tab (e.g. the status-bar remote badge). Header
    // tabs are locked while carving, so only the settings tab is remembered
    // then and the operator sees it once the job is paused or done.
    useEffect(() => {
        const open = (e: Event) => {
            const tab = (e as CustomEvent<{ tab?: string }>).detail?.tab;
            const s = useCNCStore.getState();
            if (tab) s.setSettingsTab(tab);
            const tabLocked = s.machineState === 'running' || s.machineState === 'paused';
            if (!tabLocked) setActiveHeaderTab('Settings');
        };
        window.addEventListener('cnc:open-settings', open);
        return () => window.removeEventListener('cnc:open-settings', open);
    }, []);

    return (
        <div className="app force-vertical is-vertical">
            <HomingOverlay />
            <SafetyBanner />
            <Header
                activeTab={activeHeaderTab}
                setActiveTab={setActiveHeaderTab}
            />

            <div className="app-body-wrap">
                {isVertical && (activeHeaderTab === 'Prepare' || activeHeaderTab === 'Carve') ? (
                    <div className="app-vertical-grid-2x2">
                        {/* Left Column: Full-height Sidebar with Popup Camera placed down at bottom */}
                        <div className="vgrid-left-col">
                            <ErrorBoundary fallbackMessage="Sidebar error">
                                <Sidebar activeHeaderTab={activeHeaderTab} layout={layout} />
                            </ErrorBoundary>
                        </div>

                        {/* Right Column: 3D Visualizer (Full height in Prepare, split with G-Code in Carve) */}
                        <div className={`vgrid-right-col ${activeHeaderTab === 'Carve' ? 'has-gcode' : ''}`}>
                            <div className="vgrid-top-right">
                                <ErrorBoundary fallbackMessage="3D viewport error">
                                    <Visualizer3D mode={activeHeaderTab === 'Carve' ? 'carve' : 'prepare'} hideGcodePanel={true} />
                                </ErrorBoundary>
                            </div>
                            {activeHeaderTab === 'Carve' && (
                                <div className="vgrid-bottom-right">
                                    <ErrorBoundary fallbackMessage="G-code panel error">
                                        <GcodePanel gcode={gcode} currentLine={currentLine} fileName={fileInfo?.name} />
                                    </ErrorBoundary>
                                </div>
                            )}
                        </div>
                    </div>
                ) : (
                    <main className="app-main">
                        {(activeHeaderTab === 'Prepare' || activeHeaderTab === 'Carve') && (
                            <>
                                <ErrorBoundary fallbackMessage="Sidebar error">
                                    <Sidebar activeHeaderTab={activeHeaderTab} layout={layout} />
                                </ErrorBoundary>
                                <ResizeHandle
                                    targetSelector=".sidebar"
                                    cssVar="--sb-w"
                                    storageKey="cnc.sidebarW"
                                    defaultPx={360}
                                    minPx={200}
                                    maxPx={520}
                                    side="left"
                                />
                            </>
                        )}
                        {activeHeaderTab === 'Settings' && null /* Settings provides its own sidebar */}

                        <div className="viewport-container">
                            {activeHeaderTab === 'Device' && (
                                <ErrorBoundary fallbackMessage="Device panel error">
                                    <DevicePanel />
                                </ErrorBoundary>
                            )}
                            {activeHeaderTab === 'Project' && (
                                <ErrorBoundary fallbackMessage="Project panel error">
                                    <ProjectPanel />
                                </ErrorBoundary>
                            )}
                            {activeHeaderTab === 'Prepare' && (
                                <ErrorBoundary fallbackMessage="3D viewport error">
                                    <Visualizer3D mode="prepare" />
                                </ErrorBoundary>
                            )}
                            {activeHeaderTab === 'Carve' && (
                                <ErrorBoundary fallbackMessage="3D viewport error">
                                    <Visualizer3D mode="carve" />
                                </ErrorBoundary>
                            )}
                            {activeHeaderTab === 'Settings' && (
                                <ErrorBoundary fallbackMessage="Settings error">
                                    <Settings />
                                </ErrorBoundary>
                            )}
                            {activeHeaderTab === 'Library' && (
                                <ErrorBoundary fallbackMessage="Library error">
                                    <Library />
                                </ErrorBoundary>
                            )}
                        </div>
                    </main>
                )}
            </div>

            {/* Bottom status bar — always visible */}
            <StatusBar />



            {/* Probing wizard modal — opened from Sidebar PROBE tab tiles.
                Type is preselected there, modal goes straight to JOG+BIT. */}
            <ProbingModal
                open={probingOpen}
                initialType={probingType}
                onClose={() => { setProbingOpen(false); setProbingType(null); }}
            />

            {/* Onefinity Assistant — floating chat widget, always available */}
            <ChatBot />

            {/* Touch input for every text field in the app (see OnScreenKeyboard.tsx). */}
            <OnScreenKeyboard />
        </div>
    );
}

export default function App() {
    return (
        <ErrorBoundary fallbackMessage="Application encountered an error">
            <RemotePinGate>
                <AppInner />
            </RemotePinGate>
        </ErrorBoundary>
    );
}
