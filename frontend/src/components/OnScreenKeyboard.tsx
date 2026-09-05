import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import './OnScreenKeyboard.css';

interface OnScreenKeyboardProps {
    targetInput: HTMLInputElement | null;
    onClose: () => void;
    /** Ref set to the keyboard panel root so parent can treat clicks inside as "inside" (e.g. avoid closing menu). */
    panelRef?: React.RefObject<HTMLDivElement | null>;
}

function sendKeyToInput(input: HTMLInputElement, key: string) {
    const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value'
    )?.set;
    if (!nativeSetter) return;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    let next: string;
    if (key === 'Backspace') {
        next = input.value.slice(0, Math.max(0, start - 1)) + input.value.slice(end);
        nativeSetter.call(input, next);
        input.setSelectionRange(Math.max(0, start - 1), Math.max(0, start - 1));
    } else {
        next = input.value.slice(0, start) + key + input.value.slice(end);
        nativeSetter.call(input, next);
        input.setSelectionRange(start + key.length, start + key.length);
    }
    input.dispatchEvent(new Event('input', { bubbles: true }));
}

const NUMBERS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '.'];
const ROW1 = ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'];
const ROW2 = ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'];
const ROW3 = ['z', 'x', 'c', 'v', 'b', 'n', 'm'];

export default function OnScreenKeyboard({ targetInput, onClose, panelRef: forwardedPanelRef }: OnScreenKeyboardProps) {
    const localPanelRef = useRef<HTMLDivElement>(null);
    const panelRef = forwardedPanelRef ?? localPanelRef;

    useEffect(() => {
        if (!targetInput) return;
        const handleClickOutside = (e: MouseEvent) => {
            if (
                panelRef.current?.contains(e.target as Node) ||
                targetInput.contains(e.target as Node)
            )
                return;
            onClose();
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [targetInput, onClose, panelRef]);

    if (!targetInput) return null;

    const setRef = (el: HTMLDivElement | null) => {
        (localPanelRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
        if (forwardedPanelRef) (forwardedPanelRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
    };

    const handleKey = (key: string) => {
        const type = targetInput.type.toLowerCase();
        if (type === 'number') {
            if (key === '.' && targetInput.value.includes('.')) return;
            if (key !== 'Backspace' && key !== '.' && key !== '-' && (key.length !== 1 || key < '0' || key > '9'))
                return;
        }
        if (key === 'Backspace') {
            sendKeyToInput(targetInput, 'Backspace');
            return;
        }
        if (key.length === 1) sendKeyToInput(targetInput, key);
    };

    const panel = (
        <div ref={setRef} className="on-screen-keyboard" role="group" aria-label="On-screen keyboard">
            <div className="osk-row osk-row-numbers">
                {NUMBERS.map((k) => (
                    <button
                        key={k}
                        type="button"
                        className="osk-key"
                        onClick={() => handleKey(k)}
                    >
                        {k}
                    </button>
                ))}
                <button type="button" className="osk-key osk-key-backspace" onClick={() => handleKey('Backspace')}>
                    ⌫
                </button>
            </div>
            <div className="osk-row">
                {ROW1.map((k) => (
                    <button key={k} type="button" className="osk-key" onClick={() => handleKey(k)}>
                        {k}
                    </button>
                ))}
            </div>
            <div className="osk-row">
                {ROW2.map((k) => (
                    <button key={k} type="button" className="osk-key" onClick={() => handleKey(k)}>
                        {k}
                    </button>
                ))}
            </div>
            <div className="osk-row">
                {ROW3.map((k) => (
                    <button key={k} type="button" className="osk-key" onClick={() => handleKey(k)}>
                        {k}
                    </button>
                ))}
            </div>
            <div className="osk-row osk-row-actions">
                <button type="button" className="osk-key osk-key-close" onClick={onClose}>
                    Close
                </button>
            </div>
        </div>
    );

    return createPortal(panel, document.body);
}
