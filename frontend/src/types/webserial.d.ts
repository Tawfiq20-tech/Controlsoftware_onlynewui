// Web Serial API TypeScript declarations
// These types are not included in TypeScript by default

interface SerialPort {
    readonly readable: ReadableStream<Uint8Array> | null;
    readonly writable: WritableStream<Uint8Array> | null;
    
    open(options: SerialOptions): Promise<void>;
    close(): Promise<void>;
    
    getInfo(): SerialPortInfo;
    
    forget(): Promise<void>;
}

interface SerialPortInfo {
    usbVendorId?: number;
    usbProductId?: number;
}

interface SerialOptions {
    baudRate: number;
    dataBits?: 7 | 8;
    stopBits?: 1 | 2;
    parity?: 'none' | 'even' | 'odd';
    bufferSize?: number;
    flowControl?: 'none' | 'hardware';
}

interface SerialPortRequestOptions {
    filters?: SerialPortFilter[];
}

interface SerialPortFilter {
    usbVendorId?: number;
    usbProductId?: number;
}

interface Serial extends EventTarget {
    onconnect: ((this: Serial, ev: Event) => any) | null;
    ondisconnect: ((this: Serial, ev: Event) => any) | null;
    
    getPorts(): Promise<SerialPort[]>;
    requestPort(options?: SerialPortRequestOptions): Promise<SerialPort>;
}

interface Navigator {
    readonly serial: Serial;
}
