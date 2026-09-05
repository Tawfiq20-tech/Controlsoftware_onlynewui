import { useEffect, useCallback, useRef } from 'react';
import { useCNCStore } from '../stores/cncStore';
import {
    backendJog,
    backendHome,
    backendJobPause,
    backendJobResume,
    backendJobStop,
    backendJobStart,
    backendZeroAll,
} from '../utils/backendConnection';
import controller from '../utils/controller';

export interface ShortcutDef {
    key: string;
    display: string;
    description: string;
    group: string;
    modifiers?: { ctrl?: boolean; shift?: boolean; alt?: boolean };
}

export const DEFAULT_SHORTCUTS: ShortcutDef[] = [
    // Jog
    { key: 'ArrowUp',    display: '↑',       description: 'Jog Y+',          group: 'Jog' },
    { key: 'ArrowDown',  display: '↓',       description: 'Jog Y−',          group: 'Jog' },
    { key: 'ArrowRight', display: '→',       description: 'Jog X+',          group: 'Jog' },
    { key: 'ArrowLeft',  display: '←',       description: 'Jog X−',          group: 'Jog' },
    { key: 'PageUp',     display: 'PgUp',    description: 'Jog Z+',          group: 'Jog' },
    { key: 'PageDown',   display: 'PgDn',    description: 'Jog Z−',          group: 'Jog' },
    // Step presets
    { key: '1',          display: '1',       description: 'Step: 0.1 mm',    group: 'Step' },
    { key: '2',          display: '2',       description: 'Step: 1 mm',      group: 'Step' },
    { key: '3',          display: '3',       description: 'Step: 10 mm',     group: 'Step' },
    { key: '4',          display: '4',       description: 'Step: 100 mm',    group: 'Step' },
    // Job control
    { key: ' ',          display: 'Space',   description: 'Pause / Resume',  group: 'Job' },
    { key: 'Escape',     display: 'Esc',     description: 'Stop job',        group: 'Job' },
    // Machine
    { key: 'Home',       display: 'Home',    description: 'Home all axes',   group: 'Machine' },
    { key: 'z',          display: 'Ctrl+Z',  description: 'Zero all axes',   group: 'Machine', modifiers: { ctrl: true } },
    // File
    { key: 'o',          display: 'Ctrl+O',  description: 'Open file',       group: 'File',    modifiers: { ctrl: true } },
];

const STEP_PRESETS = [0.1, 1, 10, 100];

const JOG_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown']);

function isInputFocused(): boolean {
    const el = document.activeElement;
    if (!el) return false;
    const tag = el.tagName.toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || (el as HTMLElement).isContentEditable;
}

/**
 * Registers global keyboard shortcuts for jog, job control, and machine commands.
 * Skips when focus is inside an input/textarea/select element.
 *
 * @param onOpenFile  Optional callback invoked on Ctrl+O
 * @param enabled     Set false to temporarily disable all shortcuts
 */
export function useKeyboardShortcuts(
    onOpenFile?: () => void,
    enabled = true
): void {
    const heldKeys = useRef<Set<string>>(new Set());
    const jogIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const jogStartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const stopContinuousJog = useCallback(() => {
        if (jogIntervalRef.current) {
            clearInterval(jogIntervalRef.current);
            jogIntervalRef.current = null;
        }
        if (jogStartTimerRef.current) {
            clearTimeout(jogStartTimerRef.current);
            jogStartTimerRef.current = null;
        }
    }, []);

    const startContinuousJog = useCallback(() => {
        if (jogIntervalRef.current) return;
        jogIntervalRef.current = setInterval(() => {
            const { connected, jogDistance } = useCNCStore.getState();
            if (!connected) return;
            const keys = heldKeys.current;
            let dx = 0, dy = 0, dz = 0;
            if (keys.has('ArrowRight')) dx += jogDistance;
            if (keys.has('ArrowLeft'))  dx -= jogDistance;
            if (keys.has('ArrowUp'))    dy += jogDistance;
            if (keys.has('ArrowDown'))  dy -= jogDistance;
            if (keys.has('PageUp'))     dz += jogDistance;
            if (keys.has('PageDown'))   dz -= jogDistance;
            if (dx !== 0 || dy !== 0 || dz !== 0) {
                backendJog(
                    dx !== 0 ? dx : undefined,
                    dy !== 0 ? dy : undefined,
                    dz !== 0 ? dz : undefined,
                    3000
                );
            }
        }, 120);
    }, []);

    const handleKeyDown = useCallback((e: KeyboardEvent) => {
        if (!enabled || isInputFocused()) return;

        const store = useCNCStore.getState();
        const { connected, machineState, jogDistance, setJogDistance, rawGcodeContent, fileInfo } = store;

        // --- Jog keys ---
        if (JOG_KEYS.has(e.key) && !e.ctrlKey && !e.altKey) {
            e.preventDefault();
            if (!connected) return;

            if (!heldKeys.current.has(e.key)) {
                heldKeys.current.add(e.key);

                // Immediate single jog
                let dx: number | undefined, dy: number | undefined, dz: number | undefined;
                if (e.key === 'ArrowRight') dx = jogDistance;
                else if (e.key === 'ArrowLeft')  dx = -jogDistance;
                else if (e.key === 'ArrowUp')    dy = jogDistance;
                else if (e.key === 'ArrowDown')  dy = -jogDistance;
                else if (e.key === 'PageUp')     dz = jogDistance;
                else if (e.key === 'PageDown')   dz = -jogDistance;

                backendJog(dx, dy, dz, 2000);

                // Start continuous after 350ms hold
                if (!jogStartTimerRef.current) {
                    jogStartTimerRef.current = setTimeout(() => {
                        jogStartTimerRef.current = null;
                        if (heldKeys.current.size > 0) startContinuousJog();
                    }, 350);
                }
            }
            return;
        }

        // --- Step presets 1-4 ---
        if (!e.ctrlKey && !e.altKey && ['1', '2', '3', '4'].includes(e.key)) {
            const idx = parseInt(e.key) - 1;
            setJogDistance(STEP_PRESETS[idx]);
            return;
        }

        // --- Space: Pause / Resume / Start ---
        if (e.key === ' ' && !e.ctrlKey && !e.altKey) {
            e.preventDefault();
            if (!connected) return;
            if (machineState === 'running') {
                backendJobPause();
                store.addConsoleLog('warning', 'Job paused (keyboard shortcut)');
            } else if (machineState === 'paused') {
                backendJobResume();
                store.addConsoleLog('info', 'Job resumed (keyboard shortcut)');
            } else if (machineState === 'idle' && rawGcodeContent) {
                controller.loadFile(fileInfo?.name || 'job.gcode', rawGcodeContent);
                backendJobStart();
                store.addConsoleLog('info', 'Job started (keyboard shortcut)');
            }
            return;
        }

        // --- Escape: Stop job ---
        if (e.key === 'Escape' && !e.ctrlKey) {
            if (!connected) return;
            backendJobStop();
            store.addConsoleLog('warning', 'Job stopped (keyboard shortcut)');
            return;
        }

        // --- Home: Home all axes ---
        if (e.key === 'Home' && !e.ctrlKey) {
            e.preventDefault();
            if (!connected) return;
            backendHome();
            store.addConsoleLog('info', 'Homing all axes (keyboard shortcut)');
            return;
        }

        // --- Ctrl+O: Open file ---
        if (e.key === 'o' && e.ctrlKey && !e.altKey) {
            e.preventDefault();
            onOpenFile?.();
            return;
        }

        // --- Ctrl+Z: Zero all ---
        if (e.key === 'z' && e.ctrlKey && !e.shiftKey && !e.altKey) {
            e.preventDefault();
            if (!connected) return;
            backendZeroAll();
            store.setPosition({ x: 0, y: 0, z: 0 });
            store.addConsoleLog('info', 'All axes zeroed (keyboard shortcut)');
            return;
        }
    }, [enabled, onOpenFile, startContinuousJog]);

    const handleKeyUp = useCallback((e: KeyboardEvent) => {
        heldKeys.current.delete(e.key);
        if (heldKeys.current.size === 0) {
            stopContinuousJog();
        }
    }, [stopContinuousJog]);

    useEffect(() => {
        window.addEventListener('keydown', handleKeyDown);
        window.addEventListener('keyup', handleKeyUp);
        return () => {
            window.removeEventListener('keydown', handleKeyDown);
            window.removeEventListener('keyup', handleKeyUp);
            stopContinuousJog();
        };
    }, [handleKeyDown, handleKeyUp, stopContinuousJog]);
}
