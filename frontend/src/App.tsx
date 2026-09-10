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
import ResizeHandle from './components/ResizeHandle';
import ProbingModal from './components/ProbingModal/ProbingModal';
import ChatBot from './components/ChatBot/ChatBot';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useAutoConnect } from './hooks/useAutoConnect';
import { useCNCStore } from './stores/cncStore';
import controller from './utils/controller';
import { parseGcodeAsync } from './utils/gcodeParser';

function AppInner() {
    const [activeHeaderTab, setActiveHeaderTab] = useState('Prepare');
    const [probingOpen, setProbingOpen] = useState(false);
    const [probingType, setProbingType] = useState<'z' | 'xyz' | null>(null);

    // Backend socket bootstrap + auto-connect poll -- must run regardless
    // of which header tab is active (Tawfiq msg11358 item 3). See
    // hooks/useAutoConnect.ts for why this can't live inside DevicePanel.
    useAutoConnect();

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
        setGcode,
        setParsedToolpath,
        setToolpathSegments,
        addConsoleLog,
    } = useCNCStore();
    useEffect(() => {
        if (!connected) return;
        if (!controllerReady) return;
        if (!rawGcodeContent) return;
        if (fileLoadedBackend) return;
        controller.loadFile(fileInfo?.name || 'job.gcode', rawGcodeContent);

        const timer = setTimeout(() => {
            if (useCNCStore.getState().connected && !useCNCStore.getState().fileLoadedBackend && rawGcodeContent) {
                controller.loadFile(fileInfo?.name || 'job.gcode', rawGcodeContent);
            }
        }, 1500);
        return () => clearTimeout(timer);
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
        (async () => {
            try {
                const result = await parseGcodeAsync(rawGcodeContent);
                if (result.lines && result.lines.length > 0) {
                    setGcode(result.lines);
                    setParsedToolpath(result.parsedToolpath);
                    setToolpathSegments(result.segments);
                    addConsoleLog('info', `Restored ${result.lines.length} G-code lines from last session`);
                }
            } catch (error) {
                console.error('Error re-parsing restored G-code:', error);
            }
        })();
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
        const blockCopy = (e: ClipboardEvent) => {
            const target = e.target as HTMLElement;
            if (target && target.closest('input, textarea, [contenteditable="true"]')) return;
            e.preventDefault();
        };
        document.addEventListener('contextmenu', blockContextMenu);
        document.addEventListener('copy', blockCopy);
        return () => {
            document.removeEventListener('contextmenu', blockContextMenu);
            document.removeEventListener('copy', blockCopy);
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

    return (
        <div className="app">
            <HomingOverlay />
            <SafetyBanner />
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
