'use strict';

const fs = require('fs');
const path = require('path');
const { CSP } = require('./router');

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.txt': 'text/plain; charset=utf-8',
    '.woff2': 'font/woff2',
};

function notFound(res) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Security-Policy', CSP);
    res.end('Not found');
}

function createStaticHandler({ webDir }) {
    const root = path.resolve(webDir);

    function sendFile(req, res, file, stat) {
        const ext = path.extname(file).toLowerCase();
        res.statusCode = 200;
        res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
        res.setHeader('Content-Length', stat.size);
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Content-Security-Policy', CSP);
        if (req.method === 'HEAD') {
            res.end();
            return;
        }
        const stream = fs.createReadStream(file);
        stream.on('error', () => res.destroy());
        stream.pipe(res);
    }

    function statFile(file) {
        try {
            const st = fs.statSync(file);
            return st.isFile() ? st : null;
        } catch (_) {
            return null;
        }
    }

    return function serveStatic(req, res) {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.statusCode = 405;
            res.end();
            return;
        }
        const rawPath = String(req.url || '/').split('?')[0].split('#')[0];
        let decoded;
        try {
            decoded = decodeURIComponent(rawPath);
        } catch (_) {
            return notFound(res);
        }
        // Any dot-dot segment (raw or percent-encoded) or backslash is refused outright
        // rather than normalised, so no request can ever resolve outside the web root.
        if (decoded.includes('\0') || decoded.includes('\\') || decoded.split('/').some((seg) => seg === '..')) {
            return notFound(res);
        }
        const rel = decoded === '/' ? '/index.html' : decoded;
        const file = path.resolve(root, '.' + rel);
        if (file !== root && !file.startsWith(root + path.sep)) return notFound(res);

        const st = statFile(file);
        if (st) return sendFile(req, res, file, st);

        const last = rel.split('/').pop();
        if (rel.startsWith('/api') || rel.startsWith('/ws') || last.includes('.')) return notFound(res);
        const index = path.join(root, 'index.html');
        const ist = statFile(index);
        if (!ist) return notFound(res);
        return sendFile(req, res, index, ist);
    };
}

module.exports = { createStaticHandler, MIME };
