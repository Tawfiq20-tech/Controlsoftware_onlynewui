import { useEffect, useState } from 'react';
import './App.css';
import Header from './components/Header';
import Sidebar from './components/Sidebar';
import Visualizer3D from './components/Visualizer3D/Visualizer3D';
import DevicePanel from './components/DevicePanel';
import ProjectPanel from './components/ProjectPanel';
import Settings from './components/Settings/Settings';
import Library from './components/Library/Library';
import ErrorBoundary from './components/ErrorBoundary';
import StatusBar from './components/StatusBar';
import { QuickHelpButton } from './components/KeyboardShortcuts';
import HomingOverlay from './components/HomingOverlay';
import { SafetyBanner } from './components/SafetyBanner';
import MotorErrorDialog from './components/MotorErrorDialog';
import ResizeHandle from './components/ResizeHandle';
import ProbingModal from './components/ProbingModal/ProbingModal';
import ChatBot from './components/ChatBot/ChatBot';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useAutoConnect } from './hooks/useAutoConnect';
import { useCNCStore } from './stores/cncStore';
import controller from './utils/controller';
import { GCodeParser } from './utils/gcodeParser';

function AppInner() {
    const [activeHeaderTab, setActiveHeaderTab] = useState('Prepare');
    const [probingOpen, setProbingOpen] = useState(false);
    const [probingType, setProbingType] = useState<'z' | 'xyz' | null>(null);

    // Backend socket bootstrap + auto-connect poll -- must run regardless
    // of which header tab is active (Tawfiq msg11358 item 3). See
    // hooks/useAutoConnect.ts for why this can't live inside DevicePanel.
    useAutoConnect();

    // Push the parsed G-code to the backend feeder as soon as it's available and
    // the backend has a live controller instance. This effect used to live only
    // in JobControlBar.tsx, but JobControlBar is never mounted anywhere in this
    // app's actual render tree (it's only used inside the orphaned
    // Workspace3D.tsx, which nothing imports) -- so the backend never received
    // file:load at all, no matter which fix was made to that dead component.
    // Moved here, to the always-mounted app root, so it actually runs. Gating
    // on controllerReady (not just `connected`) avoids the race where
    // `connected` flips true the instant the serial port opens but the
    // backend's controller instance isn't assigned until firmware detection
    // finishes ~100-200ms later.
    const {
        connected,
        controllerReady,
        rawGcodeContent,
        fileLoadedBackend,
        fileInfo,
        gcode,
        setGcode,
        setToolpathSegments,
        addConsoleLog,
    } = useCNCStore();
    useEffect(() => {
        if (!connected) return;
        if (!controllerReady) return;
        if (!rawGcodeContent) return;
        if (fileLoadedBackend) return;
        controller.loadFile(fileInfo?.name || 'job.gcode', rawGcodeContent);
    }, [connected, controllerReady, rawGcodeContent, fileLoadedBackend, fileInfo?.name]);

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
                addConsoleLog('info', `Restored ${result.lines.length} G-code lines from last session`);
            }
        } catch (error) {
            console.error('Error re-parsing restored G-code:', error);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
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

    return (
        <div className="app">
            <HomingOverlay />
            <SafetyBanner />
            <MotorErrorDialog />
            <Header activeTab={activeHeaderTab} setActiveTab={setActiveHeaderTab} />

            <main className="app-main">
                {(activeHeaderTab === 'Prepare' || activeHeaderTab === 'Carve') && (
                    <>
                        <ErrorBoundary fallbackMessage="Sidebar error">
                            <Sidebar />
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

            {/* Bottom status bar — always visible */}
            <StatusBar />

            {/* Floating quick-help button */}
            <QuickHelpButton />

            {/* Probing wizard modal — opened from Sidebar PROBE tab tiles.
                Type is preselected there, modal goes straight to JOG+BIT. */}
            <ProbingModal
                open={probingOpen}
                initialType={probingType}
                onClose={() => { setProbingOpen(false); setProbingType(null); }}
            />

            {/* Onefinity Assistant — floating chat widget, always available */}
            <ChatBot />
        </div>
    );
}

export default function App() {
    return (
        <ErrorBoundary fallbackMessage="Application encountered an error">
            <AppInner />
        </ErrorBoundary>
    );
}
