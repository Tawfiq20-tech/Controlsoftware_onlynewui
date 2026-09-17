'use strict';

const { parseConfig } = require('./config');
const { createLogger } = require('./log');
const { createRelay } = require('./relay');

const FORCE_EXIT_MS = 15000;

async function main() {
    const { ok, config, errors } = parseConfig(process.env);
    if (!ok) {
        for (const e of errors) process.stderr.write(`config error: ${e}\n`);
        process.exit(1);
    }
    const logger = createLogger({ level: config.logLevel });
    let relay;
    try {
        relay = await createRelay({
            host: config.host,
            port: config.port,
            dataDir: config.dataDir,
            publicUrl: config.publicUrl,
            trustProxy: config.trustProxy,
            allowInsecure: config.allowInsecure,
            signup: config.signup,
            limits: config.limits,
            log: logger,
        });
    } catch (err) {
        logger.error('relay failed to start', { err });
        process.exit(1);
    }

    let stopping = false;
    const shutdown = (signal) => {
        if (stopping) return;
        stopping = true;
        logger.info('shutdown requested', { signal });
        const force = setTimeout(() => {
            logger.error('shutdown timed out');
            process.exit(1);
        }, FORCE_EXIT_MS);
        force.unref();
        relay.close().then(() => process.exit(0), (err) => {
            logger.error('shutdown failed', { err });
            process.exit(1);
        });
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('uncaughtException', (err) => {
        logger.error('uncaught exception', { err });
        shutdown('uncaughtException');
    });
}

main();
