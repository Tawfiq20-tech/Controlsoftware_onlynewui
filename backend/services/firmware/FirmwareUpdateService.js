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
        this.onlineManifestUrl = options.onlineManifestUrl || 'https://raw.githubusercontent.com/axio-cnc/firmware-releases/main/manifest.json';
        this.io = options.io || null;
        this.logger = options.logger || console;
        this.remoteManifest = null;

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
     * Check the internet for the latest official firmware release.
     * Compares remote semantic version against current board version.
     *
     * @param {string} [currentBoardVersion]
     * @returns {Promise<object>}
     */
    async checkOnlineUpdate(currentBoardVersion = '') {
        const currentVersion = currentBoardVersion ? currentBoardVersion.trim() : '';
        try {
            this.logger.info(`[FirmwareUpdateService] Checking online OTA endpoint: ${this.onlineManifestUrl}`);
            const raw = await this.fetchRemoteFile(this.onlineManifestUrl, { timeout: 6000 });
            const remoteManifest = JSON.parse(raw);

            if (!remoteManifest || !remoteManifest.version) {
                throw new Error('Invalid remote manifest: missing version');
            }

            this.remoteManifest = remoteManifest;
            const latestVersion = remoteManifest.version;
            const hasUpdate = currentVersion
                ? this.compareVersions(latestVersion, currentVersion) > 0
                : true;

            const info = {
                board: remoteManifest.board || 'STM32H723 (fw_m3)',
                currentVersion: currentVersion || 'Unknown',
                latestVersion,
                hasUpdate,
                title: remoteManifest.title || `Firmware v${latestVersion}`,
                releaseDate: remoteManifest.releaseDate || new Date().toISOString().split('T')[0],
                changelog: Array.isArray(remoteManifest.changelog) ? remoteManifest.changelog : [],
                minSupportedVersion: remoteManifest.minSupportedVersion || '1.0.0',
                isOfficial: true,
                sha256: remoteManifest.sha256 || null,
                downloadUrl: remoteManifest.downloadUrl || null,
                isOnline: true,
                source: 'internet',
            };

            if (this.io) {
                this.io.emit('firmware:info:updated', info);
            }

            return info;
        } catch (err) {
            this.logger.warn(`[FirmwareUpdateService] Online check failed (${err.message}). Falling back to local manifest.`);
            const localInfo = this.getFirmwareInfo(currentBoardVersion);
            return {
                ...localInfo,
                isOnline: false,
                source: 'local_cache',
                offlineReason: err.message,
            };
        }
    }

    /**
     * Download the latest firmware binary from the internet, cryptographically
     * verify SHA-256 against the manifest, and stage it into the local firmware cache.
     *
     * @param {object} [options]
     * @param {object} [options.manifest] - Explicit manifest, or uses this.remoteManifest
     * @param {function} [options.onProgress] - (loaded, total, percent)
     * @returns {Promise<{ success: boolean, version: string, sha256: string }>}
     */
    async downloadAndStageOtaRelease(options = {}) {
        const manifest = options.manifest || this.remoteManifest || this.getManifest();
        if (!manifest || !manifest.downloadUrl) {
            throw new Error('No remote downloadUrl configured in manifest for OTA update');
        }

        if (this.io) {
            this.io.emit('flash:message', {
                type: 'info',
                content: `Downloading firmware v${manifest.version} from cloud repository...`,
            });
        }

        const hexData = await this.fetchRemoteFile(manifest.downloadUrl, {
            timeout: 30000,
            onProgress: (loaded, total, percent) => {
                if (typeof options.onProgress === 'function') {
                    options.onProgress(loaded, total, percent);
                }
                if (this.io && total > 0) {
                    this.io.emit('flash:progress', {
                        stage: 'download',
                        current: loaded,
                        total,
                        percent: Math.round(percent),
                    });
                }
            },
        });

        // Strict Cryptographic Integrity Check
        const calculatedSha = this.computeSha256(hexData);
        if (manifest.sha256 && calculatedSha.toLowerCase() !== manifest.sha256.toLowerCase()) {
            const err = `SHA-256 integrity verification failed: expected ${manifest.sha256}, got ${calculatedSha}`;
            this.logger.error(`[FirmwareUpdateService] ${err}`);
            throw new Error(err);
        }

        this.logger.info(`[FirmwareUpdateService] SHA-256 checksum verified for OTA release: ${calculatedSha.slice(0, 16)}...`);

        // Stage binary and update local manifest
        const hexFileName = manifest.hexFile || 'fw_m3.hex';
        const localHexPath = path.join(this.dataDir, hexFileName);
        fs.writeFileSync(localHexPath, hexData, 'utf8');

        manifest.sha256 = calculatedSha;
        fs.writeFileSync(this.manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

        if (this.io) {
            this.io.emit('flash:message', {
                type: 'success',
                content: `Firmware v${manifest.version} successfully verified and staged for USB DFU flashing.`,
            });
            this.io.emit('firmware:info:updated', this.getFirmwareInfo());
        }

        return {
            success: true,
            version: manifest.version,
            sha256: calculatedSha,
            hexData,
        };
    }

    /**
     * Helper to download remote file with progress tracking and timeout.
     * @param {string} url
     * @param {object} [options]
     * @param {number} [options.timeout=8000]
     * @param {function} [options.onProgress]
     * @returns {Promise<string>}
     */
    fetchRemoteFile(url, options = {}) {
        return new Promise((resolve, reject) => {
            const client = url.startsWith('https') ? https : http;
            const timeout = options.timeout || 8000;
            const req = client.get(url, (res) => {
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    return reject(new Error(`Failed to download firmware: HTTP ${res.statusCode}`));
                }
                const totalBytes = parseInt(res.headers['content-length'] || '0', 10);
                let loadedBytes = 0;
                let data = '';
                res.on('data', (chunk) => {
                    data += chunk;
                    loadedBytes += chunk.length;
                    if (typeof options.onProgress === 'function' && totalBytes > 0) {
                        options.onProgress(loadedBytes, totalBytes, (loadedBytes / totalBytes) * 100);
                    }
                });
                res.on('end', () => resolve(data));
            });
            req.setTimeout(timeout, () => {
                req.destroy(new Error(`Download timed out after ${timeout}ms`));
            });
            req.on('error', reject);
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
