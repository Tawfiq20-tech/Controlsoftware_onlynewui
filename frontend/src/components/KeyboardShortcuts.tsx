import { useState } from 'react';
import { Keyboard, X, ChevronDown, ChevronRight } from 'lucide-react';
import { DEFAULT_SHORTCUTS, type ShortcutDef } from '../hooks/useKeyboardShortcuts';
import './KeyboardShortcuts.css';

// ─── Shortcut Key display chip ─────────────────────────────────────
function KeyChip({ label }: { label: string }) {
    return <kbd className="shortcut-key-chip">{label}</kbd>;
}

function ShortcutRow({ shortcut }: { shortcut: ShortcutDef }) {
    const keys: string[] = [];
    if (shortcut.modifiers?.ctrl)  keys.push('Ctrl');
    if (shortcut.modifiers?.shift) keys.push('Shift');
    if (shortcut.modifiers?.alt)   keys.push('Alt');
    keys.push(shortcut.display);

    return (
        <div className="shortcut-row">
            <span className="shortcut-desc">{shortcut.description}</span>
            <div className="shortcut-keys">
                {keys.map((k, i) => (
                    <span key={i}>
                        {i > 0 && <span className="shortcut-plus">+</span>}
                        <KeyChip label={k} />
                    </span>
                ))}
            </div>
        </div>
    );
}

// ─── Group Accordion ───────────────────────────────────────────────
function ShortcutGroup({
    group,
    shortcuts,
}: {
    group: string;
    shortcuts: ShortcutDef[];
}) {
    const [open, setOpen] = useState(true);

    return (
        <div className="shortcut-group">
            <button
                className="shortcut-group-header"
                onClick={() => setOpen(v => !v)}
                aria-expanded={open}
            >
                <span className="shortcut-group-name">{group}</span>
                <span className="shortcut-group-count">{shortcuts.length}</span>
                {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </button>
            {open && (
                <div className="shortcut-group-body">
                    {shortcuts.map((s, i) => (
                        <ShortcutRow key={i} shortcut={s} />
                    ))}
                </div>
            )}
        </div>
    );
}

// ─── Main Panel ─────────────────────────────────────────────────────
interface KeyboardShortcutsProps {
    /** When true, renders as a floating overlay instead of an inline panel */
    overlay?: boolean;
    onClose?: () => void;
}

export default function KeyboardShortcuts({ overlay = false, onClose }: KeyboardShortcutsProps) {
    // Group shortcuts by group field
    const groups = DEFAULT_SHORTCUTS.reduce<Record<string, ShortcutDef[]>>((acc, s) => {
        if (!acc[s.group]) acc[s.group] = [];
        acc[s.group].push(s);
        return acc;
    }, {});

    const panel = (
        <div className={`keyboard-shortcuts-panel ${overlay ? 'overlay' : 'inline'}`}>
            <div className="shortcuts-header">
                <div className="shortcuts-title">
                    <Keyboard size={15} />
                    <span>Keyboard Shortcuts</span>
                </div>
                {onClose && (
                    <button
                        className="shortcuts-close-btn"
                        onClick={onClose}
                        aria-label="Close shortcuts panel"
                        title="Close"
                    >
                        <X size={15} />
                    </button>
                )}
            </div>

            <div className="shortcuts-body">
                <p className="shortcuts-note">
                    Shortcuts are disabled when focus is inside a text input.
                </p>

                {Object.entries(groups).map(([group, items]) => (
                    <ShortcutGroup key={group} group={group} shortcuts={items} />
                ))}
            </div>
        </div>
    );

    if (overlay) {
        return (
            <div
                className="shortcuts-overlay-backdrop"
                onClick={(e) => {
                    if (e.target === e.currentTarget) onClose?.();
                }}
                role="dialog"
                aria-modal="true"
                aria-label="Keyboard shortcuts"
            >
                {panel}
            </div>
        );
    }

    return panel;
}

// ─── Quick Help Floating Button ─────────────────────────────────────

export function QuickHelpButton() {
    const [open, setOpen] = useState(false);

    return (
        <>
            <button
                className="quick-help-fab"
                onClick={() => setOpen(true)}
                title="Keyboard shortcuts (press ? to toggle)"
                aria-label="Show keyboard shortcuts"
            >
                <Keyboard size={16} />
            </button>

            {open && (
                <KeyboardShortcuts overlay onClose={() => setOpen(false)} />
            )}
        </>
    );
}
