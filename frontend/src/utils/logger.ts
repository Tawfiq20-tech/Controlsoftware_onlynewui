/**
 * Frontend logger: in-memory buffer, optional POST to backend /api/log.
 * Use for connection, file, job events and in error boundary / window.onerror.
 */

const MAX_BUFFER = 500;

export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

export interface LogEntry {
    level: LogLevel;
    message: string;
    meta?: unknown;
    time: string;
}

const buffer: LogEntry[] = [];
let sendToBackend = true;

function getBackendUrl(): string {
    const url = (import.meta as unknown as { env?: { VITE_API_URL?: string } }).env?.VITE_API_URL;
    if (url !== undefined && url !== null && String(url).trim() !== '') {
        return String(url).replace(/\/$/, '');
    }
    if (typeof window !== 'undefined' && window.location?.hostname) {
        const { protocol, hostname } = window.location;
        return `${protocol}//${hostname}:4000`;
    }
    return 'http://localhost:4000';
}

function pushToBuffer(level: LogLevel, message: string, meta?: unknown): void {
    buffer.push({
        level,
        message,
        meta,
        time: new Date().toISOString(),
    });
    if (buffer.length > MAX_BUFFER) buffer.shift();
}

function postToBackend(level: string, message: string, meta?: unknown): void {
    if (!sendToBackend) return;
    const url = getBackendUrl();
    fetch(`${url}/api/log`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ level, message, meta }),
    }).catch(() => {});
}

export function log(level: LogLevel, message: string, meta?: unknown): void {
    pushToBuffer(level, message, meta);
    if ((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV) {
        if (level === 'error') console.error('[logger]', message, meta);
        else if (level === 'warn') console.warn('[logger]', message, meta);
        else console.log('[logger]', message, meta);
    }
    postToBackend(level, message, meta);
}

export function getLogBuffer(): LogEntry[] {
    return [...buffer];
}

export function clearLogBuffer(): void {
    buffer.length = 0;
}

export function setSendToBackend(enabled: boolean): void {
    sendToBackend = enabled;
}
