/**
 * Gamepad/Joystick Manager for CNC Control
 * Uses Gamepad API to connect and read joystick input
 */

export type JoystickButton = 'A' | 'B' | 'X' | 'Y' | 'LB' | 'RB' | 'LT' | 'RT' | 'BACK' | 'START';
export type JoystickAxis = 'LEFT_X' | 'LEFT_Y' | 'RIGHT_X' | 'RIGHT_Y';

export interface JoystickState {
    connected: boolean;
    id: string;
    index: number;
    axes: {
        leftX: number;
        leftY: number;
        rightX: number;
        rightY: number;
    };
    buttons: {
        a: boolean;
        b: boolean;
        x: boolean;
        y: boolean;
        lb: boolean;
        rb: boolean;
        lt: boolean;
        rt: boolean;
        back: boolean;
        start: boolean;
    };
}

export type JoystickCallback = (state: JoystickState) => void;

export class JoystickManager {
    private gamepad: Gamepad | null = null;
    private animationFrame: number | null = null;
    private callbacks: Set<JoystickCallback> = new Set();
    private deadzone: number = 0.15; // Ignore small movements
    private pollInterval: number = 50; // Poll every 50ms
    private lastPollTime: number = 0;

    /**
     * Check if Gamepad API is supported
     */
    public static isSupported(): boolean {
        return 'getGamepads' in navigator;
    }

    /**
     * Get list of connected gamepads
     */
    public static getConnectedGamepads(): Gamepad[] {
        if (!JoystickManager.isSupported()) {
            return [];
        }
        const gamepads = navigator.getGamepads();
        return Array.from(gamepads).filter((gp): gp is Gamepad => gp !== null);
    }

    /**
     * Start listening for gamepad input
     */
    public connect(): boolean {
        if (!JoystickManager.isSupported()) {
            throw new Error('Gamepad API is not supported in this browser');
        }

        const gamepads = JoystickManager.getConnectedGamepads();
        if (gamepads.length === 0) {
            throw new Error('No gamepad/joystick detected. Please connect one and press any button.');
        }

        this.gamepad = gamepads[0];
        this.startPolling();
        return true;
    }

    /**
     * Stop listening for gamepad input
     */
    public disconnect(): void {
        this.stopPolling();
        this.gamepad = null;
    }

    /**
     * Check if currently connected
     */
    public isConnected(): boolean {
        return this.gamepad !== null;
    }

    /**
     * Get current gamepad info
     */
    public getGamepadInfo(): { id: string; index: number } | null {
        if (!this.gamepad) return null;
        return {
            id: this.gamepad.id,
            index: this.gamepad.index
        };
    }

    /**
     * Set deadzone for analog sticks (0-1)
     */
    public setDeadzone(deadzone: number): void {
        this.deadzone = Math.max(0, Math.min(1, deadzone));
    }

    /**
     * Add callback for gamepad state changes
     */
    public onStateChange(callback: JoystickCallback): () => void {
        this.callbacks.add(callback);
        return () => {
            this.callbacks.delete(callback);
        };
    }

    /**
     * Apply deadzone to axis value
     */
    private applyDeadzone(value: number): number {
        if (Math.abs(value) < this.deadzone) {
            return 0;
        }
        // Scale remaining range
        const sign = Math.sign(value);
        const magnitude = Math.abs(value);
        return sign * ((magnitude - this.deadzone) / (1 - this.deadzone));
    }

    /**
     * Get current gamepad state
     */
    private getState(): JoystickState {
        if (!this.gamepad) {
            return this.getEmptyState();
        }

        // Refresh gamepad object (required for Chrome)
        const gamepads = navigator.getGamepads();
        const currentGamepad = gamepads[this.gamepad.index];
        
        if (!currentGamepad) {
            return this.getEmptyState();
        }

        this.gamepad = currentGamepad;

        return {
            connected: true,
            id: this.gamepad.id,
            index: this.gamepad.index,
            axes: {
                leftX: this.applyDeadzone(this.gamepad.axes[0] || 0),
                leftY: this.applyDeadzone(this.gamepad.axes[1] || 0),
                rightX: this.applyDeadzone(this.gamepad.axes[2] || 0),
                rightY: this.applyDeadzone(this.gamepad.axes[3] || 0),
            },
            buttons: {
                a: this.gamepad.buttons[0]?.pressed || false,
                b: this.gamepad.buttons[1]?.pressed || false,
                x: this.gamepad.buttons[2]?.pressed || false,
                y: this.gamepad.buttons[3]?.pressed || false,
                lb: this.gamepad.buttons[4]?.pressed || false,
                rb: this.gamepad.buttons[5]?.pressed || false,
                lt: this.gamepad.buttons[6]?.pressed || false,
                rt: this.gamepad.buttons[7]?.pressed || false,
                back: this.gamepad.buttons[8]?.pressed || false,
                start: this.gamepad.buttons[9]?.pressed || false,
            }
        };
    }

    /**
     * Get empty state when disconnected
     */
    private getEmptyState(): JoystickState {
        return {
            connected: false,
            id: '',
            index: -1,
            axes: {
                leftX: 0,
                leftY: 0,
                rightX: 0,
                rightY: 0,
            },
            buttons: {
                a: false,
                b: false,
                x: false,
                y: false,
                lb: false,
                rb: false,
                lt: false,
                rt: false,
                back: false,
                start: false,
            }
        };
    }

    /**
     * Start polling gamepad state
     */
    private startPolling(): void {
        const poll = (timestamp: number) => {
            if (timestamp - this.lastPollTime >= this.pollInterval) {
                const state = this.getState();
                this.notifyCallbacks(state);
                this.lastPollTime = timestamp;
            }
            this.animationFrame = requestAnimationFrame(poll);
        };
        this.animationFrame = requestAnimationFrame(poll);
    }

    /**
     * Stop polling gamepad state
     */
    private stopPolling(): void {
        if (this.animationFrame !== null) {
            cancelAnimationFrame(this.animationFrame);
            this.animationFrame = null;
        }
    }

    /**
     * Notify all callbacks of state change
     */
    private notifyCallbacks(state: JoystickState): void {
        this.callbacks.forEach(callback => {
            try {
                callback(state);
            } catch (error) {
                console.error('Error in joystick callback:', error);
            }
        });
    }
}

/**
 * Helper to map joystick input to CNC jog commands
 */
export class JoystickCNCMapper {
    private speedMultiplier: number = 1.0;
    private minSpeed: number = 100; // mm/min
    private maxSpeed: number = 3000; // mm/min

    constructor(minSpeed: number = 100, maxSpeed: number = 3000) {
        this.minSpeed = minSpeed;
        this.maxSpeed = maxSpeed;
    }

    /**
     * Set speed multiplier (0-1)
     */
    public setSpeedMultiplier(multiplier: number): void {
        this.speedMultiplier = Math.max(0, Math.min(1, multiplier));
    }

    /**
     * Convert joystick axes to jog commands
     */
    public mapAxesToJog(axes: JoystickState['axes']): {
        x: number;
        y: number;
        z: number;
        feedRate: number;
    } | null {
        const { leftX, leftY, rightY } = axes;

        // No movement if all axes are at zero
        if (leftX === 0 && leftY === 0 && rightY === 0) {
            return null;
        }

        // Calculate feed rate based on maximum axis deflection
        const maxDeflection = Math.max(Math.abs(leftX), Math.abs(leftY), Math.abs(rightY));
        const feedRate = this.minSpeed + (this.maxSpeed - this.minSpeed) * maxDeflection * this.speedMultiplier;

        return {
            x: leftX,
            y: -leftY, // Invert Y axis (joystick up = positive Y)
            z: rightY, // Right stick Y controls Z
            feedRate: Math.round(feedRate)
        };
    }
}
