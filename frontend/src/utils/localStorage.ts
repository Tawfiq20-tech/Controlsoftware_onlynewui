/**
 * LocalStorage utility for persisting user preferences
 */

const STORAGE_KEYS = {
    JOG_DISTANCE: 'onefinity_jog_distance',
    JOG_SPEED: 'onefinity_jog_speed',
    COORD_SYSTEM: 'onefinity_coord_system',
    GCODE_FILE: 'onefinity_gcode_file',
    LAST_DEVICE: 'onefinity_last_device',
} as const;

/**
 * Save a value to localStorage with error handling
 */
function saveToStorage<T>(key: string, value: T): void {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
        console.warn(`Failed to save to localStorage (${key}):`, error);
    }
}

/**
 * Load a value from localStorage with error handling and default fallback
 */
function loadFromStorage<T>(key: string, defaultValue: T): T {
    try {
        const stored = localStorage.getItem(key);
        if (stored === null) {
            return defaultValue;
        }
        return JSON.parse(stored) as T;
    } catch (error) {
        console.warn(`Failed to load from localStorage (${key}):`, error);
        return defaultValue;
    }
}

/**
 * Jog distance persistence
 */
export const jogDistanceStorage = {
    save: (distance: number): void => saveToStorage(STORAGE_KEYS.JOG_DISTANCE, distance),
    load: (): number => loadFromStorage(STORAGE_KEYS.JOG_DISTANCE, 1), // Default to 1mm
};

/**
 * Jog speed persistence
 */
export const jogSpeedStorage = {
    save: (speed: number): void => saveToStorage(STORAGE_KEYS.JOG_SPEED, speed),
    load: (): number => loadFromStorage(STORAGE_KEYS.JOG_SPEED, 1000), // Default to 1000 mm/min (medium-slow)
};

/**
 * Coordinate system persistence
 */
export const coordSystemStorage = {
    save: (system: 'Z' | 'XYZ' | 'XY' | 'X' | 'Y'): void => saveToStorage(STORAGE_KEYS.COORD_SYSTEM, system),
    load: (): 'Z' | 'XYZ' | 'XY' | 'X' | 'Y' => loadFromStorage(STORAGE_KEYS.COORD_SYSTEM, 'Y'), // Default to 'Y'
};

/**
 * Loaded G-code file persistence.
 *
 * Without this, a page refresh wipes the in-memory rawGcodeContent (Zustand
 * state is not persisted), so the auto-reload-on-reconnect effect in
 * JobControlBar.tsx has nothing to send to the backend -- Start silently
 * no-ops with a local-only warning that never reaches the session log
 * (Tawfiq msg11296, "SAME issue" after a reconnect with no G-code loaded
 * anywhere -- no backend console event at all, unlike the earlier
 * fileLoadedBackend bug, because the command never left the browser).
 */
export interface StoredGcodeFile {
    name: string;
    size: number;
    lines: number;
    content: string;
}

export const gcodeFileStorage = {
    save: (file: StoredGcodeFile | null): void => {
        if (file === null) {
            try {
                localStorage.removeItem(STORAGE_KEYS.GCODE_FILE);
            } catch (error) {
                console.warn(`Failed to clear localStorage (${STORAGE_KEYS.GCODE_FILE}):`, error);
            }
            return;
        }
        saveToStorage(STORAGE_KEYS.GCODE_FILE, file);
    },
    load: (): StoredGcodeFile | null => loadFromStorage<StoredGcodeFile | null>(STORAGE_KEYS.GCODE_FILE, null),
};

/**
 * Last device successfully connected to, keyed by vendorId+productId (not
 * the OS port path, which changes across USB hubs/reboots on some systems).
 * Used by DevicePanel's auto-connect poll so a previously-paired controller
 * reconnects itself on next detection instead of requiring a manual pick
 * (Tawfiq msg11347 item 4).
 */
export interface LastDevice {
    vendorId: string;
    productId: string;
}

export const lastDeviceStorage = {
    save: (device: LastDevice | null): void => saveToStorage(STORAGE_KEYS.LAST_DEVICE, device),
    load: (): LastDevice | null => loadFromStorage<LastDevice | null>(STORAGE_KEYS.LAST_DEVICE, null),
};