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
    load: (): number => loadFromStorage(STORAGE_KEYS.JOG_SPEED, 3000), // Default to 3000 mm/min (Medium)
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
 * Persists loaded G-code across page refreshes.
 * Writes are deferred to requestIdleCallback / setTimeout to eliminate main-thread freeze
 * when serializing megabytes of G-code.
 */
export interface StoredGcodeFile {
    name: string;
    size: number;
    lines: number;
    content: string;
}

let pendingGcodeSaveHandle: number | ReturnType<typeof setTimeout> | null = null;

export const gcodeFileStorage = {
    save: (file: StoredGcodeFile | null): void => {
        // Cancel any pending deferred save
        if (pendingGcodeSaveHandle !== null) {
            if (typeof window !== 'undefined' && 'cancelIdleCallback' in window && typeof pendingGcodeSaveHandle === 'number') {
                window.cancelIdleCallback(pendingGcodeSaveHandle);
            } else {
                clearTimeout(pendingGcodeSaveHandle as ReturnType<typeof setTimeout>);
            }
            pendingGcodeSaveHandle = null;
        }

        if (file === null) {
            try {
                localStorage.removeItem(STORAGE_KEYS.GCODE_FILE);
            } catch (error) {
                console.warn(`Failed to clear localStorage (${STORAGE_KEYS.GCODE_FILE}):`, error);
            }
            return;
        }

        // Schedule async/idle write so large string serialization never blocks user interaction
        const doSave = () => {
            pendingGcodeSaveHandle = null;
            try {
                // If the content is extremely large (> 10MB), catch quota errors safely
                saveToStorage(STORAGE_KEYS.GCODE_FILE, file);
            } catch (err) {
                console.warn('[gcodeFileStorage] Async save failed:', err);
            }
        };

        if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
            pendingGcodeSaveHandle = window.requestIdleCallback(doSave, { timeout: 1000 });
        } else {
            pendingGcodeSaveHandle = setTimeout(doSave, 50);
        }
    },
    load: (): StoredGcodeFile | null => loadFromStorage<StoredGcodeFile | null>(STORAGE_KEYS.GCODE_FILE, null),
};

/**
 * Last device successfully connected to, keyed by vendorId+productId.
 */
export interface LastDevice {
    vendorId: string;
    productId: string;
}

export const lastDeviceStorage = {
    save: (device: LastDevice | null): void => saveToStorage(STORAGE_KEYS.LAST_DEVICE, device),
    load: (): LastDevice | null => loadFromStorage<LastDevice | null>(STORAGE_KEYS.LAST_DEVICE, null),
};