/**
 * ResizeHandle — dual-axis drag handle for resizing sibling panels by width or height.
 *
 * Automatically detects whether layout is horizontal (columns, left-right drag) or
 * vertical (rows, up-down drag) based on orientation/aspect ratio media query or prop.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import './ResizeHandle.css';

interface Props {
    /** CSS selector for the element being resized. */
    targetSelector: string;
    /** CSS custom property to write the resolved size into (on documentElement). */
    cssVar: string;
    /** localStorage key for persisting the user's chosen size. */
    storageKey: string;
    /** Default size in px when nothing stored. */
    defaultPx: number;
    /** Lower bound — drag can't go below this. */
    minPx?: number;
    /** Upper bound — drag can't go above this. */
    maxPx?: number;
    /** Drag direction. 'left' / 'top' = sibling grows when handle moves forward;
     *  'right' / 'bottom' = sibling grows when handle moves backward. */
    side?: 'left' | 'right' | 'top' | 'bottom';
    /** Explicit orientation override, or 'auto' to follow screen aspect ratio. */
    orientation?: 'auto' | 'horizontal' | 'vertical';
    /** Hide the handle entirely. */
    hidden?: boolean;
}

export default function ResizeHandle({
    targetSelector,
    cssVar,
    storageKey,
    defaultPx,
    minPx = 100,
    maxPx = 800,
    side = 'left',
    orientation = 'auto',
    hidden = false,
}: Props) {
    const [dragging, setDragging] = useState(false);
    const sizeRef = useRef<number>(loadStored(storageKey, defaultPx));
    const startRef = useRef<{ x: number; y: number; s: number; isVertical: boolean } | null>(null);

    const isPortraitMode = useCallback(() => {
        if (orientation === 'vertical') return false; // column-resize (X drag)
        if (orientation === 'horizontal') return true; // row-resize (Y drag)
        return window.matchMedia('(max-aspect-ratio: 1/1), (orientation: portrait), (max-width: 900px)').matches;
    }, [orientation]);

    const applySize = useCallback((s: number) => {
        const clamped = Math.max(minPx, Math.min(maxPx, s));
        sizeRef.current = clamped;
        document.documentElement.style.setProperty(cssVar, `${clamped}px`);
        const el = document.querySelector(targetSelector) as HTMLElement | null;
        if (el) {
            if (isPortraitMode()) {
                el.style.height = `${clamped}px`;
            } else {
                el.style.width = `${clamped}px`;
            }
        }
    }, [cssVar, targetSelector, minPx, maxPx, isPortraitMode]);

    // Apply initial size on mount
    useEffect(() => {
        applySize(sizeRef.current);
    }, [applySize]);

    const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
        e.preventDefault();
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        const isVert = isPortraitMode();
        startRef.current = {
            x: e.clientX,
            y: e.clientY,
            s: sizeRef.current,
            isVertical: isVert,
        };
        setDragging(true);
    };

    const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
        if (!startRef.current) return;
        if (startRef.current.isVertical) {
            // Dragging vertically (Y delta)
            const dy = e.clientY - startRef.current.y;
            const next = side === 'top' ? startRef.current.s - dy : startRef.current.s + dy;
            applySize(next);
        } else {
            // Dragging horizontally (X delta)
            const dx = e.clientX - startRef.current.x;
            const next = side === 'left' ? startRef.current.s + dx : startRef.current.s - dx;
            applySize(next);
        }
    };

    const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
        if (!startRef.current) return;
        startRef.current = null;
        setDragging(false);
        try { window.localStorage.setItem(storageKey, String(sizeRef.current)); } catch {}
        (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
    };

    const onDoubleClick = () => {
        applySize(defaultPx);
        try { window.localStorage.removeItem(storageKey); } catch {}
    };

    if (hidden) return null;
    return (
        <div
            className={`resize-handle ${dragging ? 'dragging' : ''}`}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onDoubleClick={onDoubleClick}
            role="separator"
            aria-orientation={isPortraitMode() ? 'horizontal' : 'vertical'}
            title="Drag to resize · double-click to reset"
        />
    );
}

function loadStored(key: string, fallback: number): number {
    try {
        const raw = window.localStorage.getItem(key);
        if (!raw) return fallback;
        const n = Number(raw);
        return Number.isFinite(n) && n > 0 ? n : fallback;
    } catch {
        return fallback;
    }
}
