/**
 * DFU - USB Device Firmware Upgrade (DFU) protocol handler for STM32.
 *
 * Communicates with STM32 microcontrollers in DFU bootloader mode
 * over USB to flash firmware images. Uses WebUSB for cross-platform
 * compatibility.
 *
 * Reference: gSender DFU.js (GPLv3, Sienci Labs Inc.)
 */

const { EventEmitter } = require('events');
const { delay } = require('../../delay');

class DFU extends EventEmitter {
    // USB VID/PID for STM32 in DFU mode
    static VID = 0x0483;
    static PID = 0xDF11;

    // DFU request commands
    static DETACH = 0x00;
    static DNLOAD = 0x01;
    static UPLOAD = 0x02;
    static GETSTATUS = 0x03;
    static CLRSTATUS = 0x04;
    static GETSTATE = 0x05;
    static ABORT = 0x06;

    // DFU states
    static APP_IDLE = 0;
    static APP_DETACH = 1;
    static DFU_IDLE = 2;
    static DFU_DNLOAD_SYNC = 3;
    static DFU_DNBUSY = 4;
    static DFU_DNLOAD_IDLE = 5;
    static DFU_MANIFEST_SYNC = 6;
    static DFU_MANIFEST = 7;
    static DFU_MANIFEST_WAIT_RESET = 8;
    static DFU_UPLOAD_IDLE = 9;
    static DFU_ERROR = 10;

    static STATUS_OK = 0x0;

    // DFU opcodes
    static SET_ADDRESS = 0x21;
    static ERASE_PAGE = 0x41;

    static DFU_TIMEOUT = 8000;

    constructor(options = {}) {
        super();
        this.options = options;
        this.device = null;
        this.interface = null;
        this.segments = {};
    }

    /**
     * Parse memory descriptor string from DFU interface.
     * Format: @Internal Flash  /0x08000000/04*016Kg,01*064Kg,07*128Kg
     * @param {string} desc
     */
    parseMemorySegments(desc = '') {
        const nameEndIndex = desc.indexOf('/');
        if (!desc.startsWith('@') || nameEndIndex === -1) {
            throw new Error(`Invalid DFU memory descriptor: ${desc}`);
        }

        const name = desc.substring(1, nameEndIndex).trim();
        const segmentString = desc.substring(nameEndIndex);
        const segments = [];

        const sectorMultipliers = {
            ' ': 1,
            'B': 1,
            'K': 1024,
            'M': 1048576,
        };

        const contiguousRegex = /\/\s*(0x[0-9a-fA-F]{1,8})\s*\/(\s*[0-9]+\s*\*\s*[0-9]+\s?[ BKM]\s*[abcdefg]\s*,?\s*)+/g;
        let contiguousMatch;

        while ((contiguousMatch = contiguousRegex.exec(segmentString)) !== null) {
            const segmentRegex = /([0-9]+)\s*\*\s*([0-9]+)\s?([ BKM])\s*([abcdefg])\s*,?\s*/g;
            let startAddress = parseInt(contiguousMatch[1], 16);
            let segmentMatch;

            while ((segmentMatch = segmentRegex.exec(contiguousMatch[0])) !== null) {
                const sectorCount = parseInt(segmentMatch[1], 10);
                const sectorSize = parseInt(segmentMatch[2], 10) * sectorMultipliers[segmentMatch[3]];
                const properties = segmentMatch[4].charCodeAt(0) - 'a'.charCodeAt(0) + 1;

                const segment = {
                    start: startAddress,
                    sectorSize,
                    end: startAddress + sectorSize * sectorCount,
                    readable: (properties & 0x1) !== 0,
                    erasable: (properties & 0x2) !== 0,
                    writable: (properties & 0x4) !== 0,
                };
                segments.push(segment);

                startAddress += sectorSize * sectorCount;
            }
        }

        this.segments = { name, segments };
        return this.segments;
    }

    /**
     * Get memory segment containing the given address.
     * @param {number} addr
     */
    getSegment(addr) {
        const { segments } = this.segments;
        for (const segment of segments) {
            if (segment.start <= addr && addr < segment.end) {
                return segment;
            }
        }
        return null;
    }

    /**
     * Open the DFU device. Enumerates over 'usb' (node-usb, libusb backend),
     * wraps it as a WebUSBDevice so the rest of this class can use the same
     * controlTransferIn/Out shape as a browser WebUSB device -- matches the
     * gSender reference this class was ported from.
     *
     * The device disappears from CDC and re-enumerates as DFU (0483:DF11)
     * right after RSP_OP_ENTER_BOOTLOADER is ACKed on the firmware side, so
     * this retries for a few seconds rather than failing on the first miss.
     */
    async open() {
        const usb = require('usb');
        const { WebUSBDevice } = usb;

        const findDeviceWithRetries = async (retries = 6, intervalMs = 1000) => {
            for (let attempt = 0; attempt < retries; attempt += 1) {
                const found = usb.findByIds(DFU.VID, DFU.PID);
                if (found) {
                    return found;
                }
                await delay(intervalMs);
            }
            return null;
        };

        const usbDevice = await findDeviceWithRetries();
        if (!usbDevice) {
            throw new Error(
                `DFU device not found (VID=0x${DFU.VID.toString(16)}, PID=0x${DFU.PID.toString(16)}) after retrying. `
                + 'Is the board in DFU mode? On Windows, confirm the device is bound to WinUSB (via Zadig), not the ST DfuSe driver.'
            );
        }

        this.device = await WebUSBDevice.createInstance(usbDevice);
        await this.device.open();
        await delay(450);

        const configuration = this.device.configuration || this.device.configurations[0];
        if (!this.device.configuration) {
            await this.device.selectConfiguration(configuration.configurationValue);
        }

        const iface = configuration.interfaces[0];
        await this.device.claimInterface(iface.interfaceNumber);
        this.interfaceNumber = iface.interfaceNumber;

        const alternate = iface.alternates[0];
        if (iface.alternates.length > 1) {
            await this.device.selectAlternateInterface(iface.interfaceNumber, alternate.alternateSetting);
        }

        this.parseMemorySegments(alternate.interfaceName);
    }

    /**
     * Close the DFU device.
     */
    async close() {
        if (this.device) {
            try {
                await this.device.close();
            } catch (e) {
                // Device may already be gone -- e.g. it just reset into the newly
                // flashed application firmware and re-enumerated as CDC. Not fatal.
            }
            this.device = null;
        }
    }

    /**
     * Send a DFU control IN request.
     */
    async requestIn(bRequest, wLength, wValue = 0) {
        const result = await this.device.controlTransferIn({
            requestType: 'class',
            recipient: 'interface',
            request: bRequest,
            value: wValue,
            index: this.interfaceNumber,
        }, wLength);

        if (result.status !== 'ok') {
            throw new Error(`DFU control IN transfer failed (bRequest=0x${bRequest.toString(16)}): ${result.status}`);
        }
        return result.data;
    }

    /**
     * Send a DFU control OUT request.
     */
    async requestOut(bRequest, data = undefined, wValue = 0) {
        const result = await this.device.controlTransferOut({
            requestType: 'class',
            recipient: 'interface',
            request: bRequest,
            value: wValue,
            index: this.interfaceNumber,
        }, data);

        if (result.status !== 'ok') {
            throw new Error(`DFU control OUT transfer failed (bRequest=0x${bRequest.toString(16)}): ${result.status}`);
        }
        return result.bytesWritten;
    }

    /**
     * Get DFU status.
     */
    async getStatus() {
        const data = await this.requestIn(DFU.GETSTATUS, 6);
        return {
            status: data.getUint8(0),
            pollTimeout: data.getUint32(1, true) & 0xFFFFFF,
            state: data.getUint8(4),
        };
    }

    /**
     * Get DFU state.
     */
    async getState() {
        const data = await this.requestIn(DFU.GETSTATE, 1);
        return data.getUint8(0);
    }

    /**
     * Poll until a predicate is true.
     */
    async pollUntil(predicate) {
        let dfuStatus = await this.getStatus();
        while (!predicate(dfuStatus.state) && dfuStatus.state !== DFU.DFU_ERROR) {
            await delay(dfuStatus.pollTimeout);
            dfuStatus = await this.getStatus();
        }
        return dfuStatus;
    }

    /**
     * Poll until idle state.
     */
    async pollUntilIdle(idleState) {
        return this.pollUntil(state => state === idleState);
    }

    /**
     * Abort DFU operation.
     */
    async abort() {
        return this.requestOut(DFU.ABORT);
    }

    /**
     * Abort and return to idle.
     */
    async abortToIdle() {
        await this.abort();
        let state = await this.getState();
        if (state === DFU.DFU_ERROR) {
            await this.clearStatus();
            state = await this.getState();
        }
        if (state !== DFU.DFU_IDLE) {
            throw new Error('Failed to return to idle state after abort');
        }
    }

    /**
     * Clear DFU status.
     */
    async clearStatus() {
        return this.requestOut(DFU.CLRSTATUS);
    }

    /**
     * Upload data from device.
     */
    async upload(length, blockNum) {
        return this.requestIn(DFU.UPLOAD, length, blockNum);
    }

    /**
     * Download data to device.
     */
    async download(data, blockNum) {
        return this.requestOut(DFU.DNLOAD, data, blockNum);
    }

    /**
     * Detach from DFU mode.
     */
    async detach() {
        return this.requestOut(DFU.DETACH, undefined, 1000);
    }
}

module.exports = DFU;
