/**
 * Serial Connection Manager for CNC Controllers
 * Uses Web Serial API to communicate with USB-connected controllers (GRBL/grblHAL)
 */

export interface SerialConnectionConfig {
    baudRate: number;
    dataBits?: 7 | 8;
    stopBits?: 1 | 2;
    parity?: 'none' | 'even' | 'odd';
    flowControl?: 'none' | 'hardware';
}

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export type SerialMessageCallback = (message: string) => void;
export type ConnectionStatusCallback = (status: ConnectionStatus) => void;

export interface PortInfo {
    port: SerialPort;
    info: SerialPortInfo;
    displayName: string;
}

export class SerialConnection {
    private port: SerialPort | null = null;
    private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
    private status: ConnectionStatus = 'disconnected';
    private messageCallbacks: Set<SerialMessageCallback> = new Set();
    private statusCallbacks: Set<ConnectionStatusCallback> = new Set();
    private readBuffer: string = '';
    private isReading: boolean = false;

    constructor(private config: SerialConnectionConfig = { baudRate: 115200 }) {}

    /**
     * Check if Web Serial API is supported in the browser
     */
    public static isSupported(): boolean {
        return 'serial' in navigator;
    }

    /**
     * Get list of available ports with their information
     */
    public static async getAvailablePorts(): Promise<PortInfo[]> {
        if (!SerialConnection.isSupported()) {
            throw new Error('Web Serial API is not supported in this browser');
        }

        const ports = await navigator.serial.getPorts();
        const portInfos: PortInfo[] = [];

        for (const port of ports) {
            const info = port.getInfo();
            let displayName = 'Serial Port';

            // Try to create a descriptive name
            if (info.usbVendorId && info.usbProductId) {
                displayName = `USB Device (VID: ${info.usbVendorId.toString(16).toUpperCase()}, PID: ${info.usbProductId.toString(16).toUpperCase()})`;
            }

            portInfos.push({
                port,
                info,
                displayName
            });
        }

        return portInfos;
    }

    /**
     * Request user to select a serial port from browser dialog
     */
    public async requestPort(): Promise<SerialPort> {
        if (!SerialConnection.isSupported()) {
            throw new Error('Web Serial API is not supported. Use Chrome, Edge, or Opera browser.');
        }

        try {
            // This will show the browser's port selection dialog
            const port = await navigator.serial.requestPort();
            return port;
        } catch (error) {
            if (error instanceof Error && error.name === 'NotFoundError') {
                throw new Error('No port selected');
            }
            throw new Error(`Failed to request port: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    /**
     * Connect to a specific port
     */
    public async connect(port?: SerialPort): Promise<void> {
        if (!SerialConnection.isSupported()) {
            throw new Error('Web Serial API is not supported');
        }

        try {
            this.setStatus('connecting');

            // If no port provided, request one from user
            if (!port) {
                port = await this.requestPort();
            }

            this.port = port;

            // Check if port is already open
            if (this.port.readable && this.port.writable) {
                console.log('Port is already open, using existing connection');
            } else {
                // Open the port with configuration
                await this.port.open({
                    baudRate: this.config.baudRate,
                    dataBits: this.config.dataBits || 8,
                    stopBits: this.config.stopBits || 1,
                    parity: this.config.parity || 'none',
                    flowControl: this.config.flowControl || 'none',
                });
                console.log('Port opened successfully with config:', {
                    baudRate: this.config.baudRate,
                    dataBits: this.config.dataBits || 8,
                    stopBits: this.config.stopBits || 1,
                    parity: this.config.parity || 'none',
                    flowControl: this.config.flowControl || 'none',
                });
            }

            this.setStatus('connected');

            // Start reading data
            this.startReading();

            // Get writer for sending commands
            if (this.port.writable) {
                this.writer = this.port.writable.getWriter();
            }

            // Send soft reset to controller to trigger startup message
            await this.sendCommand('\x18'); // Ctrl-X for GRBL
            
            // Wait a moment for the controller to reset and send startup message
            await new Promise(resolve => setTimeout(resolve, 100));

        } catch (error) {
            this.setStatus('error');
            this.port = null;
            
            // Provide more specific error messages
            if (error instanceof Error) {
                if (error.name === 'NotFoundError') {
                    throw new Error('Serial port not found. Please ensure the device is connected and try again.');
                } else if (error.name === 'SecurityError') {
                    throw new Error('Access denied. Please ensure you have permission to access this serial port.');
                } else if (error.name === 'NetworkError') {
                    throw new Error('Port is already in use by another application. Please close other CNC software and try again.');
                } else if (error.name === 'InvalidStateError') {
                    throw new Error('Port is in an invalid state. Try disconnecting and reconnecting the USB cable.');
                } else {
                    throw new Error(`Connection failed: ${error.message}`);
                }
            } else {
                throw new Error('Failed to connect: Unknown error');
            }
        }
    }

    /**
     * Connect to the first available authorized port
     */
    public async connectToFirstAvailable(): Promise<void> {
        const ports = await SerialConnection.getAvailablePorts();
        if (ports.length === 0) {
            throw new Error('No previously authorized ports found. Please select a port.');
        }

        await this.connect(ports[0].port);
    }

    /**
     * Disconnect from the serial port
     */
    public async disconnect(): Promise<void> {
        try {
            this.isReading = false;

            // Cancel reading
            if (this.reader) {
                try {
                    await this.reader.cancel();
                } catch (e) {
                    // Ignore cancel errors
                }
                try {
                    this.reader.releaseLock();
                } catch (e) {
                    // Ignore release errors
                }
                this.reader = null;
            }

            // Release writer
            if (this.writer) {
                try {
                    await this.writer.close();
                } catch (e) {
                    // Ignore close errors
                }
                this.writer = null;
            }

            // Close port
            if (this.port) {
                try {
                    await this.port.close();
                } catch (e) {
                    // Ignore close errors
                }
                this.port = null;
            }

            this.setStatus('disconnected');
        } catch (error) {
            console.error('Error during disconnect:', error);
            this.setStatus('disconnected');
        }
    }

    /**
     * Send a command to the controller
     */
    public async sendCommand(command: string): Promise<void> {
        if (!this.writer || this.status !== 'connected') {
            throw new Error('Not connected to a serial port');
        }

        try {
            const encoder = new TextEncoder();
            const data = encoder.encode(command + '\n');
            await this.writer.write(data);
        } catch (error) {
            throw new Error(`Failed to send command: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    /**
     * Add a callback to receive messages from the controller
     */
    public onMessage(callback: SerialMessageCallback): () => void {
        this.messageCallbacks.add(callback);
        // Return unsubscribe function
        return () => {
            this.messageCallbacks.delete(callback);
        };
    }

    /**
     * Add a callback to receive status updates
     */
    public onStatusChange(callback: ConnectionStatusCallback): () => void {
        this.statusCallbacks.add(callback);
        // Return unsubscribe function
        return () => {
            this.statusCallbacks.delete(callback);
        };
    }

    /**
     * Get current connection status
     */
    public getStatus(): ConnectionStatus {
        return this.status;
    }

    /**
     * Check if connected
     */
    public isConnected(): boolean {
        return this.status === 'connected' && this.port !== null;
    }

    /**
     * Get port information
     */
    public getPortInfo(): SerialPortInfo | null {
        if (!this.port) return null;
        return this.port.getInfo();
    }

    /**
     * Update connection status and notify callbacks
     */
    private setStatus(status: ConnectionStatus): void {
        if (this.status !== status) {
            this.status = status;
            this.statusCallbacks.forEach(callback => {
                try {
                    callback(status);
                } catch (error) {
                    console.error('Error in status callback:', error);
                }
            });
        }
    }

    /**
     * Start reading data from the serial port
     */
    private async startReading(): Promise<void> {
        if (!this.port || !this.port.readable) {
            return;
        }

        this.isReading = true;

        try {
            this.reader = this.port.readable.getReader();
            const decoder = new TextDecoder();

            while (this.isReading) {
                const { value, done } = await this.reader!.read();
                if (done) {
                    break;
                }

                // Decode the incoming data
                const text = decoder.decode(value);
                this.readBuffer += text;

                // Process complete lines
                const lines = this.readBuffer.split('\n');
                this.readBuffer = lines.pop() || ''; // Keep incomplete line in buffer

                // Emit each complete line to callbacks
                for (const line of lines) {
                    const trimmedLine = line.trim();
                    if (trimmedLine) {
                        this.notifyCallbacks(trimmedLine);
                    }
                }
            }
        } catch (error) {
            if (this.isReading) {
                console.error('Error reading from serial port:', error);
                this.setStatus('error');
            }
        } finally {
            if (this.reader) {
                try {
                    this.reader.releaseLock();
                } catch (e) {
                    // Ignore
                }
                this.reader = null;
            }
        }
    }

    /**
     * Notify all callbacks with a new message
     */
    private notifyCallbacks(message: string): void {
        this.messageCallbacks.forEach(callback => {
            try {
                callback(message);
            } catch (error) {
                console.error('Error in message callback:', error);
            }
        });
    }
}

/**
 * GRBL/grblHAL-specific helper functions
 */
export class GRBLConnection extends SerialConnection {
    constructor() {
        super({ baudRate: 115200 }); // GRBL default baud rate
    }

    /**
     * Send a soft reset to GRBL
     */
    public async softReset(): Promise<void> {
        await this.sendCommand('\x18'); // Ctrl-X
    }

    /**
     * Request GRBL status (should be called periodically)
     */
    public async requestStatus(): Promise<void> {
        await this.sendCommand('?');
    }

    /**
     * Home all axes
     */
    public async home(): Promise<void> {
        await this.sendCommand('$H');
    }

    /**
     * Unlock GRBL (after alarm)
     */
    public async unlock(): Promise<void> {
        await this.sendCommand('$X');
    }

    /**
     * Get GRBL settings
     */
    public async getSettings(): Promise<void> {
        await this.sendCommand('$$');
    }

    /**
     * Get build info
     */
    public async getBuildInfo(): Promise<void> {
        await this.sendCommand('$I');
    }

    /**
     * Get work coordinates
     */
    public async getWorkCoordinates(): Promise<void> {
        await this.sendCommand('$#');
    }

    /**
     * Get parser state
     */
    public async getParserState(): Promise<void> {
        await this.sendCommand('$G');
    }

    /**
     * Send feed hold command
     */
    public async feedHold(): Promise<void> {
        await this.sendCommand('!');
    }

    /**
     * Send cycle start command
     */
    public async cycleStart(): Promise<void> {
        await this.sendCommand('~');
    }

    /**
     * Jog command
     */
    public async jog(x?: number, y?: number, z?: number, feedRate: number = 1000): Promise<void> {
        let cmd = '$J=G91 G21';
        if (x !== undefined) cmd += ` X${x}`;
        if (y !== undefined) cmd += ` Y${y}`;
        if (z !== undefined) cmd += ` Z${z}`;
        cmd += ` F${feedRate}`;
        await this.sendCommand(cmd);
    }

    /**
     * Parse GRBL status message
     * Example: <Idle|MPos:0.000,0.000,0.000|FS:0,0>
     */
    public static parseStatus(message: string): {
        state: string;
        mpos?: { x: number; y: number; z: number };
        wpos?: { x: number; y: number; z: number };
        feedRate?: number;
        spindleSpeed?: number;
    } | null {
        if (!message.startsWith('<') || !message.endsWith('>')) {
            return null;
        }

        const parts = message.slice(1, -1).split('|');
        const result: any = { state: parts[0] };

        for (let i = 1; i < parts.length; i++) {
            const part = parts[i];
            
            if (part.startsWith('MPos:')) {
                const coords = part.slice(5).split(',').map(Number);
                result.mpos = { x: coords[0] || 0, y: coords[1] || 0, z: coords[2] || 0 };
            } else if (part.startsWith('WPos:')) {
                const coords = part.slice(5).split(',').map(Number);
                result.wpos = { x: coords[0] || 0, y: coords[1] || 0, z: coords[2] || 0 };
            } else if (part.startsWith('FS:')) {
                const values = part.slice(3).split(',').map(Number);
                result.feedRate = values[0] || 0;
                result.spindleSpeed = values[1] || 0;
            }
        }

        return result;
    }
}
