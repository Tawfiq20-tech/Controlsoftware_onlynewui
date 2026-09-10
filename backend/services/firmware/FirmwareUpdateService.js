/**
 * FirmwareUpdateService — Live OTA firmware distribution and verification service.
 *
 * Provides:
 *   1. Version check & manifest resolution (Current vs Latest release).
 *   2. Secure in-memory retrieval of official Intel HEX binaries (hides raw .hex from end users).
 *   3. SHA-256 cryptographic integrity validation before handing firmware to DFU flasher.
 *   4. Developer API for publishing new firmware releases dynamically.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');

class FirmwareUpdateService {
    /**
     * @param {object} [options]
     * @param {string} [options.dataDir] - Path to firmware storage directory
     * @param {object} [options.io] - Socket.IO server instance
     * @param {object} [options.logger] - Logger instance
     */
    constructor(options = {}) {
        this.dataDir = options.dataDir || path.join(__dirname, '../../data/firmware');
        this.manifestPath = path.join(this.dataDir, 'manifest.json');
        this.io = options.io || null;
        this.logger = options.logger || console;

        if (!fs.existsSync(this.dataDir)) {
            fs.mkdirSync(this.dataDir, { recursive: true });
        }
    }

    /**
     * Parse and normalize version string (e.g. "v1.1.0" -> [1, 1, 0]).
     * @param {string} ver
     * @returns {number[]}
     */
    parseVersion(ver) {
        if (!ver || typeof ver !== 'string') return [0, 0, 0];
        const cleaned = ver.trim().replace(/^[vV]/, '').split('-')[0];
        const parts = cleaned.split('.').map((p) => {
            const num = parseInt(p, 10);
            return isNaN(num) ? 0 : num;
        });
        while (parts.length < 3) parts.push(0);
        return parts.slice(0, 3);
    }

    /**
     * Compare two semantic version strings.
     * Returns:
     *   1 if v1 > v2
     *  -1 if v1 < v2
     *   0 if v1 === v2
     *
     * @param {string} v1
     * @param {string} v2
     * @returns {number}
     */
    compareVersions(v1, v2) {
        const p1 = this.parseVersion(v1);
        const p2 = this.parseVersion(v2);

        for (let i = 0; i < 3; i++) {
            if (p1[i] > p2[i]) return 1;
            if (p1[i] < p2[i]) return -1;
        }
        return 0;
    }

    /**
     * Load manifest from disk.
     * @returns {object}
     */
    getManifest() {
        if (!fs.existsSync(this.manifestPath)) {
            throw new Error(`Firmware manifest not found at: ${this.manifestPath}`);
        }
        const raw = fs.readFileSync(this.manifestPath, 'utf8');
        return JSON.parse(raw);
    }

    /**
     * Get firmware release info and update availability.
     *
     * @param {string} [currentBoardVersion] - Current firmware reported by machine over RSP
     * @returns {object}
     */
    getFirmwareInfo(currentBoardVersion = '') {
        const manifest = this.getManifest();
        const latestVersion = manifest.version || '0.0.0';
        const currentVersion = currentBoardVersion ? currentBoardVersion.trim() : '';

        // If current version is unknown/blank, we offer update if a valid release exists
        const hasUpdate = currentVersion
            ? this.compareVersions(latestVersion, currentVersion) > 0
            : true;

        return {
            board: manifest.board || 'STM32H723 (fw_m3)',
            currentVersion: currentVersion || 'Unknown',
            latestVersion,
            hasUpdate,
            title: manifest.title || `Firmware v${latestVersion}`,
            releaseDate: manifest.releaseDate || new Date().toISOString().split('T')[0],
            changelog: Array.isArray(manifest.changelog) ? manifest.changelog : [],
            minSupportedVersion: manifest.minSupportedVersion || '1.0.0',
            isOfficial: true,
            sha256: manifest.sha256 || null,
        };
    }

    /**
     * Verify whether machine state is safe for flashing.
     * @param {string} state
     * @returns {{ allowed: boolean, reason?: string }}
     */
    canFlash(state) {
        const norm = (state || '').toLowerCase();
        if (norm === 'running' || norm === 'hold' || norm === 'jog') {
            return {
                allowed: false,
                reason: `Machine is currently active (state: ${state}). Pause/stop the job first before updating firmware.`,
            };
        }
        if (norm === 'alarm') {
            return {
                allowed: false,
                reason: 'Machine is in alarm state. Clear the alarm and ensure machine is idle before flashing.',
            };
        }
        return { allowed: true };
    }

    /**
     * Calculate SHA-256 hash of a string or buffer.
     * @param {string|Buffer} data
     * @returns {string}
     */
    computeSha256(data) {
        return crypto.createHash('sha256').update(data).digest('hex');
    }

    /**
     * Retrieve the verified official Intel HEX firmware image into memory.
     * Raw contents are never written to client storage or exposed in UI.
     *
     * @returns {Promise<string>} Intel HEX file content
     */
    async getOfficialHexData() {
        const manifest = this.getManifest();
        const hexFileName = manifest.hexFile || 'fw_m3.hex';
        const localHexPath = path.isAbsolute(hexFileName)
            ? hexFileName
            : path.join(this.dataDir, hexFileName);

        let hexData = null;

        if (fs.existsSync(localHexPath)) {
            hexData = fs.readFileSync(localHexPath, 'utf8');
        } else if (manifest.downloadUrl) {
            // Optional remote fetch if configured
            this.logger.info(`[FirmwareUpdateService] Fetching firmware binary from: ${manifest.downloadUrl}`);
            hexData = await this.fetchRemoteFile(manifest.downloadUrl);
        } else {
            throw new Error(`Official firmware binary not found: ${localHexPath}`);
        }

        // Integrity verification
        if (manifest.sha256) {
            const calculatedSha = this.computeSha256(hexData);
            if (calculatedSha.toLowerCase() !== manifest.sha256.toLowerCase()) {
                const err = `SHA-256 integrity verification failed: expected ${manifest.sha256}, got ${calculatedSha}`;
                this.logger.error(`[FirmwareUpdateService] ${err}`);
                throw new Error(err);
            }
            this.logger.info(`[FirmwareUpdateService] SHA-256 checksum verified: ${calculatedSha.slice(0, 12)}...`);
        }

        return hexData;
    }

    /**
     * Helper to download remote file as text.
     * @param {string} url
     * @returns {Promise<string>}
     */
    fetchRemoteFile(url) {
        return new Promise((resolve, reject) => {
            const client = url.startsWith('https') ? https : http;
            client.get(url, (res) => {
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    return reject(new Error(`Failed to download firmware: HTTP ${res.statusCode}`));
                }
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => resolve(data));
            }).on('error', reject);
        });
    }

    /**
     * Developer API: Publish/Deploy a new firmware release dynamically.
     *
     * @param {object} payload
     * @param {object} payload.manifest - Updated manifest object
     * @param {string} [payload.hexData] - Intel HEX file string
     * @returns {object} updated manifest
     */
    deployRelease(payload) {
        const { manifest, hexData } = payload;
        if (!manifest || !manifest.version) {
            throw new Error('Invalid release payload: manifest with version is required');
        }

        const hexFileName = manifest.hexFile || 'fw_m3.hex';
        const localHexPath = path.join(this.dataDir, hexFileName);

        if (hexData) {
            // Automatically compute SHA-256 if not specified
            const calculatedSha = this.computeSha256(hexData);
            manifest.sha256 = calculatedSha;
            fs.writeFileSync(localHexPath, hexData, 'utf8');
            this.logger.info(`[FirmwareUpdateService] Wrote new firmware binary to ${localHexPath} (SHA256: ${calculatedSha})`);
        }

        fs.writeFileSync(this.manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
        this.logger.info(`[FirmwareUpdateService] Published firmware release v${manifest.version}`);

        if (this.io) {
            this.io.emit('firmware:info:updated', this.getFirmwareInfo());
        }

        return manifest;
    }
}

module.exports = { FirmwareUpdateService };
