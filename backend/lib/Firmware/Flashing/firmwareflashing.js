/**
 * firmwareflashing - High-level firmware flashing API.
 *
 * Provides a unified interface for flashing firmware to different
 * board types (LongMill MK1/MK2, SLB) using either Arduino bootloader
 * (avrgirl-arduino), STM32 serial bootloader, or DFU protocol.
 *
 * Emits Socket.IO events for UI progress tracking.
 *
 * Reference: gSender firmwareflashing.js (GPLv3, Sienci Labs Inc.)
 */

const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');
const STM32Loader = require('./STM32Loader');
const DFUFlasher = require('./DFUFlasher');

class FirmwareFlashing extends EventEmitter {
    static FIRMWARE_DIR = path.join(__dirname, 'hex');

    static BOARD_TYPES = {
        MK1: 'mk1',
        MK2: 'mk2',
        SLB: 'slb',
        GRBL: 'grbl',
        // EasyCNC's STM32H723 board: no BOOT0 pin/button available to the
        // end user (laptop or Pi host, no physical access assumed). Entry
        // to DFU is triggered over the existing RSP link instead of DTR/RTS
        // toggling -- see flashEasyCNC() below and fw_m3/Inc/dfu_bootloader.h.
        EASYCNC: 'easycnc',
    };

    /**
     * Flash firmware to the specified board type.
     *
     * @param {string} flashPort - Serial port path
     * @param {string} boardType - 'MK1' | 'MK2' | 'SLB' | 'GRBL'
     * @param {object} [options]
     * @param {object} [options.socket] - Socket.IO socket for progress events
     * @param {string} [options.hexPath] - Custom hex file path (server-side)
     * @param {string} [options.hexData] - Raw Intel HEX text, e.g. read
     *   client-side from a file the user picked and sent over the wire.
     *   Takes priority over hexPath -- the EasyCNC "Update Firmware" UI
     *   always uses this mode since the backend has no reason to keep a
     *   copy of a firmware image the user selected from their own disk.
     * @param {import('../../services/controllers/RSPController')} [options.controller]
     *   Required for boardType EASYCNC -- the live bound RSP controller.
     */
    static async flash(flashPort, boardType, options = {}) {
        const { socket } = options;

        if (!flashPort) {
            const error = 'No port specified for flashing';
            if (socket) socket.emit('flash:error', error);
            throw new Error(error);
        }

        // Determine hex data: prefer raw text passed directly over reading
        // a server-side path (see options.hexData doc above).
        let hexData = options.hexData;
        let hexPath = options.hexPath;
        if (hexData === undefined) {
            if (!hexPath) {
                const hexFilename = this.getHexFilename(boardType);
                hexPath = path.join(FirmwareFlashing.FIRMWARE_DIR, hexFilename);
            }

            if (!fs.existsSync(hexPath)) {
                const error = `Firmware file not found: ${hexPath}`;
                if (socket) socket.emit('flash:error', error);
                throw new Error(error);
            }

            hexData = fs.readFileSync(hexPath, 'utf-8');
        }

        if (socket) {
            socket.emit('flash:start', { port: flashPort, board: boardType });
            socket.emit('flash:message', {
                type: 'info',
                content: `Starting firmware flash on port ${flashPort} for board ${boardType}`,
            });
        }

        try {
            if (boardType === 'MK1' || boardType === 'MK2') {
                // Use Arduino bootloader (avrgirl-arduino)
                await this.flashArduino(flashPort, hexPath, socket);
            } else if (boardType === 'SLB') {
                // Use STM32 serial bootloader
                await this.flashSTM32(flashPort, hexData, socket);
            } else if (boardType === 'EASYCNC') {
                // No-BOOT0 USB DFU flash: RSP-triggered bootloader jump,
                // then DFU over USB (not the serial port passed in above --
                // the CDC port disappears once the device jumps to DFU).
                await this.flashEasyCNC(options.controller, hexData, socket);
            } else {
                throw new Error(`Unsupported board type: ${boardType}`);
            }

            if (socket) {
                socket.emit('flash:end', flashPort);
                socket.emit('flash:message', { type: 'success', content: 'Firmware flash successful!' });
            }
        } catch (error) {
            if (socket) {
                socket.emit('flash:error', error.message);
                socket.emit('flash:message', { type: 'error', content: error.message });
            }
            throw error;
        }
    }

    /**
     * Flash using Arduino bootloader (avrgirl-arduino).
     */
    static async flashArduino(port, hexPath, socket) {
        // NOTE: Requires @sienci/avrgirl-arduino package
        // Stub implementation - add to package.json if needed
        try {
            const AvrgirlArduino = require('@sienci/avrgirl-arduino');
            const avrgirl = new AvrgirlArduino({ board: 'uno', port });

            return new Promise((resolve, reject) => {
                avrgirl.flash(hexPath, (error) => {
                    if (error) {
                        reject(error);
                    } else {
                        resolve();
                    }
                });
            });
        } catch (e) {
            throw new Error('avrgirl-arduino not installed. Run: npm install @sienci/avrgirl-arduino');
        }
    }

    /**
     * Flash using STM32 serial bootloader.
     */
    static async flashSTM32(port, hexData, socket) {
        const loader = new STM32Loader(port);

        loader.on('progress', (current, total) => {
            if (socket) {
                socket.emit('flash:progress', { current, total, percent: (current / total) * 100 });
            }
        });

        loader.on('info', (message) => {
            if (socket) socket.emit('flash:message', { type: 'info', content: message });
        });

        await loader.open();
        // NOTE: Actual flashing logic would go here (write hex blocks, verify, etc.)
        await loader.releaseChip();
        await loader.close();
    }

    /**
     * Flash EasyCNC's STM32H723 board with no BOOT0 pin/button interaction.
     *
     * Sequence (matches fw_m3/Inc/dfu_bootloader.h's documented contract):
     *   1. Send RSP_OP_ENTER_BOOTLOADER over the existing RSP link and wait
     *      for the ACK -- firmware only accepts this from SYS_IDLE and ACKs
     *      OK *before* jumping, so the ACK is the correct "go" signal.
     *   2. The CDC serial port disappears right after the ACK as the device
     *      re-enumerates in USB DFU mode (VID 0x0483, PID 0xDF11).
     *   3. DFU.open() (DFU.js) retries findByIds() for a few seconds to
     *      catch that re-enumeration, then DFUFlasher.flash() does the
     *      actual erase/write/manifest over DFU.
     *   4. On success the device resets back into the newly flashed
     *      application firmware and re-enumerates as CDC again -- the host
     *      (frontend) is responsible for reconnecting the RSP link after
     *      this resolves, same as after any other firmware update.
     *
     * @param {import('../../services/controllers/RSPController')} controller
     *   The currently-bound RSPController for the machine to flash. Must be
     *   bound and the machine must be idle (no active job/alarm/estop) --
     *   enforced firmware-side, not just here.
     * @param {string} hexData - Intel HEX firmware image contents.
     * @param {object} [socket] - Socket.IO socket for progress events.
     */
    static async flashEasyCNC(controller, hexData, socket) {
        if (!controller) {
            throw new Error('No active RSP connection -- connect to the machine before flashing.');
        }

        if (socket) socket.emit('flash:message', { type: 'info', content: 'Requesting bootloader entry over RSP...' });
        await controller.enterBootloader();

        if (socket) socket.emit('flash:message', { type: 'info', content: 'Waiting for device to re-enumerate as USB DFU...' });

        const flasher = new DFUFlasher({ hex: hexData });

        if (socket) {
            flasher.on('info', (message) => socket.emit('flash:message', { type: 'info', content: message }));
            flasher.on('error', (message) => socket.emit('flash:error', message));
            flasher.on('progress', (value, total) => {
                socket.emit('flash:progress', { current: value, total, percent: total ? (value / total) * 100 : 0 });
            });
        }

        await new Promise((resolve, reject) => {
            let failed = false;
            flasher.on('error', (message) => {
                failed = true;
                reject(new Error(message));
            });
            flasher.on('end', () => {
                if (!failed) resolve();
            });
            flasher.flash().catch(reject);
        });

        if (socket) {
            socket.emit('flash:message', {
                type: 'info',
                content: 'Flash complete -- device is rebooting into the new firmware and will re-enumerate as CDC. Reconnect once it reappears.',
            });
        }
    }

    /**
     * Get the default hex filename for a board type.
     */
    static getHexFilename(boardType) {
        switch (boardType) {
            case 'MK1':
                return 'mk1_20220214.hex';
            case 'MK2':
                return 'mk2_20220214.hex';
            case 'SLB':
                return 'slb_orange.hex';
            case 'GRBL':
                return 'grblsept15.hex';
            default:
                throw new Error(`Unknown board type: ${boardType}`);
        }
    }
}

module.exports = FirmwareFlashing;
