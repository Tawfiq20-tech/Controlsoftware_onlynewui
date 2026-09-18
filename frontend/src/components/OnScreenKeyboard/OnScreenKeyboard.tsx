/**
 * OnScreenKeyboard — one virtual keyboard for the whole app.
 *
 * Mounted once in App.tsx. It watches document focus, so every text field in
 * the app gets a keyboard without being touched individually: it opens when an
 * <input>/<textarea> takes focus and closes when focus leaves. Opt a field out
 * with `data-no-osk` on it or on any ancestor.
 *
 * Two things make this work with React-controlled inputs:
 *   1. Writing through the native value setter and dispatching a bubbling
 *      'input' event -- assigning `el.value` directly is invisible to React.
 *   2. preventDefault on pointerdown for every key, so pressing a key never
 *      moves focus off the field being typed into.
 *
 * Number fields get a numeric pad and a "logical value" buffer. A number input
 * throws away anything that isn't a valid number, so typing "1", ".", "5"
 * would blank the field at the ".". The buffer holds the half-finished text
 * and only writes to the field once it parses again.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowBigUp, CornerDownLeft, Delete, X } from 'lucide-react';
import { isOskEnabled, onOskPrefChange } from '../../utils/onScreenKeyboard';
import './OnScreenKeyboard.css';

type Field = HTMLInputElement | HTMLTextAreaElement;
type Mode = 'letters' | 'symbols' | 'numeric';

/** Input types that take typed text. An <input> with no type reports 'text'. */
const TEXT_TYPES = new Set(['text', 'search', 'url', 'email', 'password', 'tel', 'number']);
const NUMERIC_TYPES = new Set(['number', 'tel']);

const LETTER_ROWS = [
    ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
    ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
    ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'],
    ['z', 'x', 'c', 'v', 'b', 'n', 'm'],
];

const SYMBOL_ROWS = [
    ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
    ['!', '@', '#', '$', '%', '^', '&', '*', '(', ')'],
    ['-', '_', '=', '+', '[', ']', '{', '}', ':', ';'],
    ['/', '?', '.', ',', "'", '"', '<', '>', '~', '|'],
];

const NUMERIC_ROWS = [
    ['7', '8', '9'],
    ['4', '5', '6'],
    ['1', '2', '3'],
    ['-', '0', '.'],
];

function isEligible(el: Element | null): el is Field {
    if (!el) return false;
    if (el.closest('[data-no-osk]')) return false;
    if (el.tagName === 'TEXTAREA') {
        const ta = el as HTMLTextAreaElement;
        return !ta.readOnly && !ta.disabled;
    }
    if (el.tagName !== 'INPUT') return false;
    const input = el as HTMLInputElement;
    if (!TEXT_TYPES.has(input.type)) return false;
    return !input.readOnly && !input.disabled;
}

function isNumericField(el: Field): boolean {
    if (el.tagName === 'TEXTAREA') return false;
    const input = el as HTMLInputElement;
    const inputMode = input.getAttribute('inputmode');
    return NUMERIC_TYPES.has(input.type) || inputMode === 'numeric' || inputMode === 'decimal';
}

/** A number input silently blanks anything else, so check before writing. */
function isWritableNumber(text: string): boolean {
    return text === '' || /^-?\d+(\.\d+)?$/.test(text);
}

/** Longest leading part of `text` a number input will actually hold. */
function numericPrefix(text: string): string {
    let head = text;
    while (head.length > 0 && !isWritableNumber(head)) head = head.slice(0, -1);
    return head;
}

/** React tracks its own last value on the node; go through the native setter. */
function writeValue(el: Field, value: string): void {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Number and email inputs throw on selectionStart; fall back to the end. */
function caretOf(el: Field): { start: number; end: number } {
    try {
        const { selectionStart, selectionEnd } = el;
        if (selectionStart !== null && selectionEnd !== null) {
            return { start: selectionStart, end: selectionEnd };
        }
    } catch (_) {
        /* unsupported for this input type */
    }
    const len = el.value.length;
    return { start: len, end: len };
}

function setCaret(el: Field, pos: number): void {
    try {
        el.setSelectionRange(pos, pos);
    } catch (_) {
        /* unsupported for this input type */
    }
}

export default function OnScreenKeyboard() {
    const [enabled, setEnabled] = useState(isOskEnabled);
    const [open, setOpen] = useState(false);
    const [mode, setMode] = useState<Mode>('letters');
    const [shift, setShift] = useState(false);
    const [capsLock, setCapsLock] = useState(false);

    const fieldRef = useRef<Field | null>(null);
    const panelRef = useRef<HTMLDivElement | null>(null);
    /** Half-finished number text ("1.", "-") that the field itself won't hold. */
    const draftRef = useRef<string | null>(null);
    /** The exact string we last wrote, to tell our edits from the app's. */
    const lastWrittenRef = useRef<string | null>(null);
    const closeTimer = useRef<number | null>(null);

    useEffect(() => onOskPrefChange(setEnabled), []);

    const close = useCallback(() => {
        setOpen(false);
        fieldRef.current = null;
        draftRef.current = null;
        lastWrittenRef.current = null;
        setShift(false);
        setMode('letters');
    }, []);

    // Follow focus. focusout fires before the next focusin, so the close is
    // deferred a tick and cancelled if focus lands on another field.
    useEffect(() => {
        if (!enabled) {
            close();
            return;
        }

        const adopt = (target: Field) => {
            if (closeTimer.current !== null) {
                window.clearTimeout(closeTimer.current);
                closeTimer.current = null;
            }
            fieldRef.current = target;
            draftRef.current = null;
            lastWrittenRef.current = null;
            setMode(isNumericField(target) ? 'numeric' : 'letters');
            setShift(false);
            setOpen(true);
        };

        const onFocusIn = (e: FocusEvent) => {
            const target = e.target as Element | null;
            if (isEligible(target)) adopt(target);
        };

        // Switching the keyboard back on in Settings does not move focus, so no
        // focusin ever fires and the sheet stayed hidden until the field was
        // tapped again (closing and reopening the chat was the only way back).
        // Take whatever already has focus when we start listening.
        const active = document.activeElement;
        if (isEligible(active)) adopt(active);

        const onFocusOut = () => {
            if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
            closeTimer.current = window.setTimeout(() => {
                closeTimer.current = null;
                const active = document.activeElement;
                if (isEligible(active)) return;
                if (panelRef.current && active && panelRef.current.contains(active)) return;
                close();
            }, 0);
        };

        document.addEventListener('focusin', onFocusIn);
        document.addEventListener('focusout', onFocusOut);
        return () => {
            document.removeEventListener('focusin', onFocusIn);
            document.removeEventListener('focusout', onFocusOut);
            if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
        };
    }, [enabled, close]);

    // Shrink the app while the sheet is up and bring the field into view, so
    // the keyboard never sits on top of what is being typed into.
    useEffect(() => {
        if (!open) {
            document.body.classList.remove('osk-open');
            return;
        }
        document.body.classList.add('osk-open');
        const el = fieldRef.current;
        const raf = window.requestAnimationFrame(() => {
            try {
                el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
            } catch (_) {
                /* older engines */
            }
        });
        return () => {
            window.cancelAnimationFrame(raf);
            document.body.classList.remove('osk-open');
        };
    }, [open]);

    /**
     * What the operator has typed, which is the field's own value unless a
     * half-finished number ("1.", "-") is parked in the draft. The draft only
     * counts while the field still holds exactly what we last wrote to it --
     * anything else means the app changed the value underneath us.
     */
    const logicalValue = (el: Field): string => {
        const draft = draftRef.current;
        if (draft !== null && el.value === lastWrittenRef.current) return draft;
        return el.value;
    };

    const commit = useCallback((el: Field, next: string, caret: number) => {
        if (isNumericField(el)) {
            // Write as much as the field will keep and park the rest, so "1."
            // shows "1" rather than blanking the field.
            const writable = isWritableNumber(next) ? next : numericPrefix(next);
            writeValue(el, writable);
            lastWrittenRef.current = writable;
            draftRef.current = isWritableNumber(next) ? null : next;
            setCaret(el, writable.length);
            return;
        }
        draftRef.current = null;
        writeValue(el, next);
        lastWrittenRef.current = next;
        setCaret(el, caret);
    }, []);

    const insert = useCallback((text: string) => {
        const el = fieldRef.current;
        if (!el) return;
        if (isNumericField(el)) {
            const next = logicalValue(el) + text;
            commit(el, next, next.length);
            return;
        }
        const { start, end } = caretOf(el);
        const value = el.value;
        commit(el, value.slice(0, start) + text + value.slice(end), start + text.length);
    }, [commit]);

    const backspace = useCallback(() => {
        const el = fieldRef.current;
        if (!el) return;
        if (isNumericField(el)) {
            let next = logicalValue(el).slice(0, -1);
            // Deleting a parked '.' leaves the field looking identical, which
            // reads as a dead key. Keep going until the display actually moves.
            while (next.length > 0 && (isWritableNumber(next) ? next : numericPrefix(next)) === el.value) {
                next = next.slice(0, -1);
            }
            commit(el, next, next.length);
            return;
        }
        const { start, end } = caretOf(el);
        const value = el.value;
        if (start !== end) {
            commit(el, value.slice(0, start) + value.slice(end), start);
        } else if (start > 0) {
            commit(el, value.slice(0, start - 1) + value.slice(start), start - 1);
        }
    }, [commit]);

    const clearAll = useCallback(() => {
        const el = fieldRef.current;
        if (!el) return;
        commit(el, '', 0);
    }, [commit]);

    const moveCaret = useCallback((delta: number) => {
        const el = fieldRef.current;
        if (!el) return;
        const { start } = caretOf(el);
        setCaret(el, Math.max(0, Math.min(el.value.length, start + delta)));
    }, []);

    const pressEnter = useCallback(() => {
        const el = fieldRef.current;
        if (!el) return;
        if (el.tagName === 'TEXTAREA') {
            insert('\n');
            return;
        }
        // Real events, so component onKeyDown/onKeyUp handlers and form
        // submission behave exactly as they do for a physical Enter.
        for (const type of ['keydown', 'keypress', 'keyup'] as const) {
            el.dispatchEvent(new KeyboardEvent(type, {
                key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true,
            }));
        }
        const form = (el as HTMLInputElement).form;
        if (form && typeof form.requestSubmit === 'function') {
            try {
                form.requestSubmit();
            } catch (_) {
                /* no submitter */
            }
        }
        el.blur();
        close();
    }, [insert, close]);

    const onLetter = useCallback((ch: string) => {
        insert(shift || capsLock ? ch.toUpperCase() : ch);
        if (shift && !capsLock) setShift(false);
    }, [insert, shift, capsLock]);

    const toggleShift = useCallback(() => {
        // Second tap within the same open keyboard latches caps lock.
        if (shift && !capsLock) {
            setCapsLock(true);
            return;
        }
        if (capsLock) {
            setCapsLock(false);
            setShift(false);
            return;
        }
        setShift(true);
    }, [shift, capsLock]);

    if (!enabled || !open) return null;

    const upper = shift || capsLock;
    const rows = mode === 'symbols' ? SYMBOL_ROWS : LETTER_ROWS;

    // Every key blocks pointerdown: the field must keep focus and its caret.
    const keyProps = (fn: () => void) => ({
        type: 'button' as const,
        onPointerDown: (e: React.PointerEvent) => e.preventDefault(),
        onMouseDown: (e: React.MouseEvent) => e.preventDefault(),
        onClick: fn,
    });

    return (
        <div
            className={`osk ${mode === 'numeric' ? 'osk-numeric' : ''}`}
            ref={panelRef}
            role="application"
            aria-label="On-screen keyboard"
        >
            <div className="osk-bar">
                <span className="osk-bar-title">Keyboard</span>
                <button className="osk-bar-btn" {...keyProps(clearAll)} aria-label="Clear field">Clear</button>
                <button className="osk-bar-btn" {...keyProps(() => moveCaret(-1))} aria-label="Cursor left">◀</button>
                <button className="osk-bar-btn" {...keyProps(() => moveCaret(1))} aria-label="Cursor right">▶</button>
                <button
                    className="osk-bar-btn osk-bar-close"
                    {...keyProps(() => { fieldRef.current?.blur(); close(); })}
                    aria-label="Hide keyboard"
                >
                    <X size={18} />
                </button>
            </div>

            {mode === 'numeric' ? (
                <div className="osk-rows">
                    {NUMERIC_ROWS.map((row, i) => (
                        <div className="osk-row" key={i}>
                            {row.map((ch) => (
                                <button className="osk-key" key={ch} {...keyProps(() => insert(ch))}>{ch}</button>
                            ))}
                            {i === 0 && (
                                <button className="osk-key osk-key-wide osk-key-alt" {...keyProps(backspace)} aria-label="Backspace">
                                    <Delete size={20} />
                                </button>
                            )}
                            {i === 1 && (
                                <button className="osk-key osk-key-wide osk-key-alt" {...keyProps(() => setMode('letters'))}>ABC</button>
                            )}
                            {i === 2 && (
                                <button className="osk-key osk-key-wide osk-key-alt" {...keyProps(() => insert(' '))}>Space</button>
                            )}
                            {i === 3 && (
                                <button className="osk-key osk-key-wide osk-key-go" {...keyProps(pressEnter)} aria-label="Done">
                                    <CornerDownLeft size={20} />
                                </button>
                            )}
                        </div>
                    ))}
                </div>
            ) : (
                <div className="osk-rows">
                    {rows.map((row, i) => (
                        <div className="osk-row" key={i}>
                            {i === 3 && mode === 'letters' && (
                                <button
                                    className={`osk-key osk-key-wide osk-key-alt ${capsLock ? 'osk-locked' : shift ? 'osk-on' : ''}`}
                                    {...keyProps(toggleShift)}
                                    aria-label="Shift"
                                >
                                    <ArrowBigUp size={20} />
                                </button>
                            )}
                            {row.map((ch) => (
                                <button
                                    className="osk-key"
                                    key={ch}
                                    {...keyProps(() => (mode === 'letters' ? onLetter(ch) : insert(ch)))}
                                >
                                    {mode === 'letters' && upper ? ch.toUpperCase() : ch}
                                </button>
                            ))}
                            {i === 3 && (
                                <button className="osk-key osk-key-wide osk-key-alt" {...keyProps(backspace)} aria-label="Backspace">
                                    <Delete size={20} />
                                </button>
                            )}
                        </div>
                    ))}
                    <div className="osk-row">
                        <button
                            className="osk-key osk-key-wide osk-key-alt"
                            {...keyProps(() => setMode(mode === 'symbols' ? 'letters' : 'symbols'))}
                        >
                            {mode === 'symbols' ? 'ABC' : '?123'}
                        </button>
                        <button className="osk-key" {...keyProps(() => insert('@'))}>@</button>
                        <button className="osk-key osk-key-space" {...keyProps(() => insert(' '))}>Space</button>
                        <button className="osk-key" {...keyProps(() => insert('.'))}>.</button>
                        <button className="osk-key osk-key-wide osk-key-go" {...keyProps(pressEnter)} aria-label="Enter">
                            <CornerDownLeft size={20} />
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
