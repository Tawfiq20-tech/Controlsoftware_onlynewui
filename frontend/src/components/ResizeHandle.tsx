/**
 * ResizeHandle — vertical drag handle for resizing a sibling element by width.
 *
 * Sits between two flex / grid children. Mousedown captures global mousemove,
 * computes new width, writes it to a CSS variable on the target element and
 * persists to localStorage. Double-click resets to the default.
 *
 * Usage:
 *   <Sidebar style={{ width: 'var(--sb-w, 360px)' }} />
 *   <ResizeHandle targetSelector=".sidebar"
 *                 cssVar="--sb-w" storageKey="cnc.sidebarW"
 *                 defaultPx={360} minPx={180} maxPx={520} />
 *   <ViewportContainer />
 *
 * Pointer events used (works with mouse, touch, pen).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import './ResizeHandle.css';

interface Props {
    /** CSS selector for the element being resized (its width is what we drive). */
    targetSelector: string;
    /** CSS custom property to write the resolved width into (on documentElement). */
    cssVar: string;
    /** localStorage key for persisting the user's chosen width. */
    storageKey: string;
    /** Default width in px when nothing stored. */
    defaultPx: number;
    /** Lower bound — drag can't go below this. */
    minPx?: number;
    /** Upper bound — drag can't go above this. */
    maxPx?: number;
    /** Drag direction. 'left' = sibling on left grows when handle moves right;
     *  'right' = sibling on right grows when handle moves left.  */
    side?: 'left' | 'right';
    /** Hide the handle entirely (used at narrow widths where the target is hidden). */
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
    hidden = false,
}: Props) {
    const [dragging, setDragging] = useState(false);
    const widthRef = useRef<number>(loadStored(storageKey, defaultPx));
    const startRef = useRef<{ x: number; w: number } | null>(null);

    // Apply initial width on mount + whenever default changes.
    useEffect(() => {
        applyWidth(widthRef.current);
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    const applyWidth = useCallback((w: number) => {
        const clamped = Math.max(minPx, Math.min(maxPx, w));
        widthRef.current = clamped;
        document.documentElement.style.setProperty(cssVar, `${clamped}px`);
        const el = document.querySelector(targetSelector) as HTMLElement | null;
        if (el) el.style.width = `${clamped}px`;
    }, [cssVar, targetSelector, minPx, maxPx]);

    const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
        e.preventDefault();
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        startRef.current = { x: e.clientX, w: widthRef.current };
        setDragging(true);
    };
    const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
        if (!startRef.current) return;
        const dx = e.clientX - startRef.current.x;
        const next = side === 'left' ? startRef.current.w + dx : startRef.current.w - dx;
        applyWidth(next);
    };
    const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
        if (!startRef.current) return;
        startRef.current = null;
        setDragging(false);
        try { window.localStorage.setItem(storageKey, String(widthRef.current)); } catch {}
        (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
    };
    const onDoubleClick = () => {
        applyWidth(defaultPx);
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
            aria-orientation="vertical"
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
