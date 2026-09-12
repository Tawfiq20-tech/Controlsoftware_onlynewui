/**
 * ChatBot Widget — Onefinity Assistant
 *
 * A self-contained, floating chat widget backed by the SAME local Node
 * backend that already runs the machine (port 4000, /api/chat) — a
 * same-origin call exactly like every other control-panel button makes.
 * No separate service, no API key baked into the client bundle.
 *
 * The backend only ever answers with text plus, optionally, a named
 * suggestedAction. This component turns that suggestion into a confirm
 * button, and only THEN calls the existing backendHome/backendUnlock/
 * backendJobPause/etc. functions — the exact same functions the regular
 * Home/Alarm/Pause buttons already call. The chatbot never gets a new,
 * separate path to the machine.
 *
 * - Does NOT modify any existing CNC UI components.
 * - Renders as a fixed-position overlay (bottom-right corner).
 * - Manages its own state (open/close, messages, API calls).
 */

import { useCNCStore } from '../../stores/cncStore';
import {
    backendHome,
    backendUnlock,
    backendJobPause,
    backendJobResume,
    backendJobStop,
    backendJog,
} from '../../utils/backendConnection';
import { useState, useRef, useEffect, useCallback, memo } from 'react';
import ReactMarkdown from 'react-markdown';
import { remoteAuthHeaders } from '../../utils/remoteAuth';
import './ChatBot.css';

/* ── Types ─────────────────────────────────────────────── */

interface SuggestedAction {
    action: 'home' | 'unlock' | 'job_pause' | 'job_resume' | 'job_stop' | 'jog' | 'probe' | 'job_start';
    label: string;
    autoExec: boolean;
    // Only present for a successfully-parsed jog action (see ChatbotService.js
    // parseJogCommand). `label` already renders the exact resolved command
    // text ("Jog X +10mm @ 1000mm/min") so the confirm button never asks the
    // operator to trust an inferred move they can't see.
    params?: { axis: 'x' | 'y' | 'z'; distance: number; feedRate: number };
}

interface ChatMessage {
    role: 'user' | 'assistant';
    content: string;
    suggestedAction?: SuggestedAction | null;
    actionState?: 'idle' | 'confirming' | 'done' | 'error';
}

interface ChatApiResponse {
    answer: string;
    sources: string[];
    usedOnline: boolean;
    suggestedAction: SuggestedAction | null;
}

/* ── Config ─────────────────────────────────────────────── */

const getBackendBase = (): string => {
    const env = (import.meta as unknown as { env?: { VITE_API_URL?: string } }).env?.VITE_API_URL;
    if (env) return String(env).replace(/\/$/, '');
    if (typeof window !== 'undefined') {
        const { protocol, hostname } = window.location;
        return `${protocol}//${hostname}:4000`;
    }
    return 'http://localhost:4000';
};

const CHATBOT_API_URL = `${getBackendBase()}/api/chat`;
const MAX_HISTORY = 6; // Send last N messages as context

// Parameter-free actions -- "do the thing" is the whole command, so there's
// nothing an operator needs to double-check beyond the label itself. Jog is
// handled separately in runAction() below since it needs action.params;
// probe/job_start stay guide-only (no executor, answer text only).
const ACTION_EXECUTORS: Partial<Record<SuggestedAction['action'], () => void>> = {
    home: backendHome,
    unlock: backendUnlock,
    job_pause: backendJobPause,
    job_resume: backendJobResume,
    job_stop: backendJobStop,
};

/* ── ChatMessageItem (Memoized to prevent markdown re-parsing on typing) ── */

const ChatMessageItem = memo(function ChatMessageItem({
    msg,
    index,
    connected,
    onRequestConfirm,
    onRunAction,
    onCancelConfirm,
}: {
    msg: ChatMessage;
    index: number;
    connected: boolean;
    onRequestConfirm: (index: number) => void;
    onRunAction: (index: number, action: SuggestedAction) => void;
    onCancelConfirm: (index: number) => void;
}) {
    return (
        <div
            className={`chatbot-msg ${
                msg.role === 'user' ? 'chatbot-msg-user' : 'chatbot-msg-bot'
            }`}
        >
            <ReactMarkdown>{msg.content}</ReactMarkdown>

            {msg.role === 'assistant' && msg.suggestedAction && (
                <div className="chatbot-action-row">
                    {msg.actionState === 'idle' && (
                        msg.suggestedAction.autoExec ? (
                            connected ? (
                                <button
                                    className="chatbot-action-btn"
                                    onClick={() => onRequestConfirm(index)}
                                >
                                    Want me to do this — {msg.suggestedAction.label}?
                                </button>
                            ) : (
                                <div className="chatbot-action-hint">
                                    (Machine isn't connected — connect first, then ask again.)
                                </div>
                            )
                        ) : (
                            <div className="chatbot-action-hint">
                                ({msg.suggestedAction.label} needs details I can't guess from chat — use the panel above.)
                            </div>
                        )
                    )}
                    {msg.actionState === 'confirming' && (
                        <div className="chatbot-action-confirm">
                            <span>Confirm: {msg.suggestedAction.label}?</span>
                            <button
                                className="chatbot-action-btn chatbot-action-yes"
                                onClick={() => onRunAction(index, msg.suggestedAction as SuggestedAction)}
                            >
                                Yes, do it
                            </button>
                            <button
                                className="chatbot-action-btn chatbot-action-no"
                                onClick={() => onCancelConfirm(index)}
                            >
                                Cancel
                            </button>
                        </div>
                    )}
                    {msg.actionState === 'done' && (
                        <div className="chatbot-action-done">Done — sent {msg.suggestedAction.label.toLowerCase()}.</div>
                    )}
                    {msg.actionState === 'error' && (
                        <div className="chatbot-error">Couldn't run that — try the button on the panel instead.</div>
                    )}
                </div>
            )}
        </div>
    );
});

/* ── Component ──────────────────────────────────────────── */

export default function ChatBot() {
    const connected = useCNCStore(s => s.connected);
    const [isOpen, setIsOpen] = useState(false);
    const [isClosing, setIsClosing] = useState(false);
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [input, setInput] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    /* Auto-scroll to latest message without running continuous smooth-scroll animation frames */
    const scrollToBottom = useCallback(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'auto' });
    }, []);

    useEffect(() => {
        scrollToBottom();
    }, [messages, isLoading, scrollToBottom]);

    /* Focus input when chat opens */
    useEffect(() => {
        if (isOpen) {
            setTimeout(() => inputRef.current?.focus(), 100);
        }
    }, [isOpen]);

    /* ── Open / Close ──────────────────────────────────── */

    const handleOpen = () => {
        setIsOpen(true);
        setIsClosing(false);
    };

    const handleClose = () => {
        setIsClosing(true);
        setTimeout(() => {
            setIsOpen(false);
            setIsClosing(false);
        }, 200);
    };

    const handleToggle = () => {
        if (isOpen) handleClose();
        else handleOpen();
    };

    /* ── Send Message ──────────────────────────────────── */

    const sendMessage = async () => {
        const trimmed = input.trim();
        if (!trimmed || isLoading) return;

        const userMsg: ChatMessage = { role: 'user', content: trimmed };
        setMessages(prev => [...prev, userMsg]);
        setInput('');
        setError(null);
        setIsLoading(true);

        try {
            // Build history from messages BEFORE this turn — the backend appends
            // the current query itself, so including userMsg here would send the
            // same message twice as consecutive "user" turns to the LLM.
            const history = messages
                .slice(-MAX_HISTORY)
                .map(m => ({ role: m.role, content: m.content }));

            // Live machine context, for reference only — the backend never
            // acts on this, it's just extra grounding for the answer text.
            const store = useCNCStore.getState();
            const errorLogs = store.consoleLines.filter(l => l.type === 'error');
            const machineContext = {
                state: store.machineState,
                lastError: errorLogs.length > 0 ? errorLogs[errorLogs.length - 1].text : null,
                loadedFile: store.fileInfo?.name || null,
                connected: store.connected,
            };

            const res = await fetch(CHATBOT_API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...remoteAuthHeaders() },
                body: JSON.stringify({ message: trimmed, history, machineContext }),
            });

            if (!res.ok) {
                const errBody = await res.json().catch(() => null);
                throw new Error(errBody?.error || `Server error (${res.status})`);
            }

            const data: ChatApiResponse = await res.json();

            const botMsg: ChatMessage = {
                role: 'assistant',
                content: data.answer,
                suggestedAction: data.suggestedAction,
                actionState: 'idle',
            };
            setMessages(prev => [...prev, botMsg]);
        } catch (err) {
            const msg = err instanceof Error ? err.message : 'Failed to connect to assistant';
            setError(msg);
        } finally {
            setIsLoading(false);
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    };

    /* ── Action confirm / execute ──────────────────────── */

    const setActionState = useCallback((index: number, state: ChatMessage['actionState']) => {
        setMessages(prev => prev.map((m, i) => (i === index ? { ...m, actionState: state } : m)));
    }, []);

    const requestConfirm = useCallback((index: number) => setActionState(index, 'confirming'), [setActionState]);
    const cancelConfirm = useCallback((index: number) => setActionState(index, 'idle'), [setActionState]);

    const runAction = useCallback((index: number, action: SuggestedAction) => {
        // Every other control in this app (Sidebar/JobControlBar/StatusBar/Header)
        // gates its backend calls on `connected` — match that here so a stale
        // confirm button can't silently no-op against a disconnected machine.
        if (!connected) {
            setActionState(index, 'error');
            return;
        }
        try {
            if (action.action === 'jog' && action.params) {
                const { axis, distance, feedRate } = action.params;
                backendJog(
                    axis === 'x' ? distance : undefined,
                    axis === 'y' ? distance : undefined,
                    axis === 'z' ? distance : undefined,
                    feedRate,
                );
                setActionState(index, 'done');
                return;
            }
            const exec = ACTION_EXECUTORS[action.action];
            if (!exec) {
                setActionState(index, 'error');
                return;
            }
            exec();
            setActionState(index, 'done');
        } catch (err) {
            setActionState(index, 'error');
        }
    }, [connected, setActionState]);

    /* ── Render ─────────────────────────────────────────── */

    return (
        <>
            {/* Chat Window */}
            {isOpen && (
                <div
                    className={`chatbot-window${isClosing ? ' chatbot-closing' : ''}`}
                    id="chatbot-window"
                >
                    {/* Header */}
                    <div className="chatbot-header">
                        <div className="chatbot-header-info">
                            <div className="chatbot-avatar">
                                OF
                                <div className={`chatbot-avatar-status ${connected ? 'online' : 'offline'}`} />
                            </div>
                            <div>
                                <div className="chatbot-title">Onefinity Assistant</div>
                                <div className={`chatbot-status-text ${connected ? 'online' : 'offline'}`}>
                                    {isLoading ? 'Thinking...' : connected ? 'Machine connected' : 'Machine offline'}
                                </div>
                            </div>
                        </div>
                        <button
                            className="chatbot-close-btn"
                            onClick={handleClose}
                            aria-label="Close chatbot"
                            id="chatbot-close"
                        >
                            <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path d="M6 18L18 6M6 6l12 12" strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} />
                            </svg>
                        </button>
                    </div>

                    {/* Messages */}
                    <div className="chatbot-messages">
                        {/* Welcome message shown when no messages */}
                        {messages.length === 0 && (
                            <>
                                <div className="chatbot-msg chatbot-msg-bot">
                                    Hello! I'm your Onefinity CNC assistant. How can I help you with your machine today?
                                </div>
                                <div className="chatbot-welcome">
                                    Ask about setup, troubleshooting, G-code, homing, or anything CNC-related.
                                </div>
                            </>
                        )}

                        {/* Message list */}
                        {messages.map((msg, i) => (
                            <ChatMessageItem
                                key={i}
                                msg={msg}
                                index={i}
                                connected={connected}
                                onRequestConfirm={requestConfirm}
                                onRunAction={runAction}
                                onCancelConfirm={cancelConfirm}
                            />
                        ))}

                        {/* Typing indicator */}
                        {isLoading && (
                            <div className="chatbot-typing">
                                <div className="chatbot-typing-dot" />
                                <div className="chatbot-typing-dot" />
                                <div className="chatbot-typing-dot" />
                            </div>
                        )}

                        {/* Error */}
                        {error && <div className="chatbot-error">{error}</div>}

                        <div ref={messagesEndRef} />
                    </div>

                    {/* Input */}
                    <div className="chatbot-input-area">
                        <input
                            ref={inputRef}
                            className="chatbot-input"
                            type="text"
                            placeholder="Type your message..."
                            value={input}
                            onChange={e => setInput(e.target.value)}
                            onKeyDown={handleKeyDown}
                            disabled={isLoading}
                            id="chatbot-input"
                        />
                        <button
                            className="chatbot-send-btn"
                            onClick={sendMessage}
                            disabled={isLoading || !input.trim()}
                            id="chatbot-send"
                        >
                            Send
                        </button>
                    </div>
                </div>
            )}

            {/* Floating Action Button */}
            <button
                className="chatbot-fab"
                onClick={handleToggle}
                aria-label="Toggle chatbot"
                id="chatbot-fab"
            >
                {isOpen ? (
                    <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path d="M6 18L18 6M6 6l12 12" strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} />
                    </svg>
                ) : (
                    <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path
                            d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                        />
                    </svg>
                )}
            </button>
        </>
    );
}
