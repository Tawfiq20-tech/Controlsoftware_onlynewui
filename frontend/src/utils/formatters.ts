/**
 * Format axis value to 3 decimal places
 */
export function formatAxisValue(value: number): string {
    return value.toFixed(3);
}

/**
 * Format file size in human-readable format
 */
export function formatFileSize(bytes: number): string {
    if (bytes === 0) return '0 Bytes';

    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

/**
 * Format time in HH:MM:SS format
 */
export function formatTime(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    const parts = [];
    if (hours > 0) parts.push(hours.toString().padStart(2, '0'));
    parts.push(minutes.toString().padStart(2, '0'));
    parts.push(secs.toString().padStart(2, '0'));

    return parts.join(':');
}

/**
 * Get current timestamp
 */
export function getTimestamp(): string {
    return new Date().toLocaleTimeString();
}

/**
 * Format percentage
 */
export function formatPercentage(value: number): string {
    return `${Math.round(value)}%`;
}
