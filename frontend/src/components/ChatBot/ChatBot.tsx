/**
 * ChatBot Widget — Onefinity Assistant
 *
 * A self-contained, floating chat widget that connects to the
 * Python FastAPI chatbot backend on port 8000.
 *
 * - Does NOT modify any existing CNC UI components.
 * - Renders as a fixed-position overlay (bottom-right corner).
 * - Manages its own state (open/close, messages, API calls).
 */

import { useCNCStore } from '../../stores/cncStore';
import { useState, useRef, useEffect, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import './ChatBot.css';

/* ── Types ─────────────────────────────────────────────── */

interface ChatMessage {
    role: 'user' | 'assistant';
    content: string;
}

interface ChatApiResponse {
    answer: string;
    sources: string[];
    similarity_score: number;
    used_rag: boolean;
    request_id: string;
    latency_ms: number;
}

/* ── Config ─────────────────────────────────────────────── */

const CHATBOT_API_URL = 'http://localhost:8000/api/v1/chat';
const CHATBOT_API_KEY = 'Aravindraj07';
const MAX_HISTORY = 6; // Send last N messages as context

/* ── Component ──────────────────────────────────────────── */

export default function ChatBot() {
    const [isOpen, setIsOpen] = useState(false);
    const [isClosing, setIsClosing] = useState(false);
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [input, setInput] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    /* Auto-scroll to latest message */
    const scrollToBottom = useCallback(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
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
        // Grab live machine state from cncStore
        const store = useCNCStore.getState();
        const machineState = store.machineState; // 'idle' | 'running' | 'alarm' | 'motorError'
        const fileInfo = store.fileInfo;
        const errorLogs = store.consoleLines.filter(l => l.type === 'error');
        const lastError = errorLogs.length > 0 ? errorLogs[errorLogs.length - 1].text : null;


        const userMsg: ChatMessage = { role: 'user', content: trimmed };
        setMessages(prev => [...prev, userMsg]);
        setInput('');
        setError(null);
        setIsLoading(true);

        try {
            // Build history (last N messages for context)
            const history = [...messages, userMsg]
                .slice(-MAX_HISTORY)
                .map(m => ({ role: m.role, content: m.content }));

            const res = await fetch(CHATBOT_API_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-API-Key': CHATBOT_API_KEY,
                },
                body: JSON.stringify({
                    question: trimmed,
                    history: history,
                    machine_context: {
                        state: machineState,
                        last_error: lastError,
                        loaded_file: fileInfo?.name || null,
                        connected: store.connected
                    }
                }),

            });

            if (!res.ok) {
                const errBody = await res.json().catch(() => null);
                throw new Error(errBody?.detail || `Server error (${res.status})`);
            }

            const data: ChatApiResponse = await res.json();

            const botMsg: ChatMessage = { role: 'assistant', content: data.answer };
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
                                <div className={`chatbot-avatar-status ${isLoading ? 'online' : 'online'}`} />
                            </div>
                            <div>
                                <div className="chatbot-title">Onefinity Assistant</div>
                                <div className={`chatbot-status-text online`}>
                                    {isLoading ? 'Thinking...' : 'Online'}
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
                            <div
                                key={i}
                                className={`chatbot-msg ${
                                    msg.role === 'user' ? 'chatbot-msg-user' : 'chatbot-msg-bot'
                                }`}
                            >
                                <ReactMarkdown>{msg.content}</ReactMarkdown>
                            </div>
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
