/**
 * Dual Localhost Frontend Server (Onefinity Sender)
 *
 * Runs two standalone frontend endpoints:
 *   - http://localhost:3000 -> HORIZONTAL (Landscape desktop layout)
 *   - http://localhost:3001 -> VERTICAL (Portrait / Touchscreen layout)
 *
 * The built frontend talks to its own origin for any port other than 5173 and
 * 4000, so /api/* and /socket.io/* (polling and WebSocket) are proxied to the
 * backend on 127.0.0.1:<BACKEND_PORT|4000>. Without this the kiosk on 3000/3001
 * never reaches the backend and the operator claim (?op=) silently fails.
 *
 * Trust: the proxy connects from loopback and forwards the client's headers
 * unchanged, adding no forwarding headers. That is only equivalent to the
 * browser talking to :4000 directly when the client itself is on loopback, so
 * proxying is refused (403) for every non-loopback client — otherwise a LAN
 * device could reach the backend as a trusted local identity through here.
 */
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const DEFAULT_BACKEND_PORT = Number(process.env.BACKEND_PORT) || 4000;

function isLoopbackAddress(address) {
    if (typeof address !== 'string' || !address) return false;
    let a = address.trim().toLowerCase();
    if (a.startsWith('::ffff:')) a = a.slice(7);
    return a === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a);
}

function isBackendPath(url) {
    const p = String(url || '').split('?')[0];
    return p === '/api' || p.startsWith('/api/') || p === '/socket.io' || p.startsWith('/socket.io/');
}

function refuseNonLoopback(req, res) {
    if (isLoopbackAddress(req.socket && req.socket.remoteAddress)) return false;
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'backend_proxy_loopback_only' }));
    return true;
}

/** Plain HTTP (API calls, Socket.IO polling): headers pass through untouched. */
function proxyHttp(req, res, backendPort) {
    const upstream = http.request({
        host: '127.0.0.1',
        port: backendPort,
        method: req.method,
        path: req.url,
        headers: req.headers,
    }, (up) => {
        res.writeHead(up.statusCode || 502, up.headers);
        up.pipe(res);
    });
    upstream.on('error', () => {
        if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'backend_unreachable' }));
        } else {
            res.destroy();
        }
    });
    req.pipe(upstream);
}

/** Socket.IO WebSocket upgrade: replay the request head, then splice the sockets. */
function proxyUpgrade(req, socket, head, backendPort) {
    if (!isBackendPath(req.url) || !isLoopbackAddress(socket.remoteAddress)) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        return;
    }
    const upstream = net.connect(backendPort, '127.0.0.1', () => {
        const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
        for (let i = 0; i < req.rawHeaders.length; i += 2) {
            lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
        }
        upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
        if (head && head.length) upstream.write(head);
        upstream.pipe(socket);
        socket.pipe(upstream);
    });
    const close = () => { upstream.destroy(); socket.destroy(); };
    upstream.on('error', close);
    socket.on('error', close);
    upstream.on('close', () => socket.destroy());
    socket.on('close', () => upstream.destroy());
}

const distPath = path.join(__dirname, '..', 'frontend', 'dist');
// Written by the backend on first start (backend/services/remoteAccess/OperatorToken.js).
const operatorTokenPath = path.join(__dirname, '..', 'backend', 'data', 'operator-token');
const OPERATOR_SECRET_PATTERN = /^[0-9a-f]{64}$/;
const OPERATOR_TOKEN_WAIT_MS = 30000;

function getMime(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const map = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.json': 'application/json',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.svg': 'image/svg+xml',
        '.ico': 'image/x-icon',
        '.woff': 'font/woff',
        '.woff2': 'font/woff2',
        '.ttf': 'font/ttf'
    };
    return map[ext] || 'application/octet-stream';
}

function createFrontendServer(port, forcedLayout, { backendPort = DEFAULT_BACKEND_PORT, host, onListening } = {}) {
    const server = http.createServer((req, res) => {
        if (isBackendPath(req.url)) {
            if (refuseNonLoopback(req, res)) return;
            return proxyHttp(req, res, backendPort);
        }
        let reqUrl = req.url.split('?')[0];
        if (reqUrl === '/') reqUrl = '/index.html';

        let filePath = path.resolve(distPath, `.${path.posix.normalize(`/${reqUrl}`)}`);
        // Never serve outside dist (e.g. /../../backend/data/operator-token sent with --path-as-is).
        const insideDist = filePath === distPath || filePath.startsWith(distPath + path.sep);
        if (!insideDist || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
            filePath = path.join(distPath, 'index.html');
        }

        try {
            let content = fs.readFileSync(filePath);
            let mime = getMime(filePath);

            if (filePath.endsWith('index.html')) {
                let html = content.toString('utf-8');
                html = html.replace('<body', `<body data-forced-layout="${forcedLayout}"`);
                content = Buffer.from(html, 'utf-8');
            }

            res.writeHead(200, {
                'Content-Type': mime,
                'Cache-Control': 'no-cache',
                'Access-Control-Allow-Origin': '*'
            });
            res.end(content);
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Error serving static asset: ' + e.message);
        }
    });

    server.on('upgrade', (req, socket, head) => proxyUpgrade(req, socket, head, backendPort));

    server.listen(port, host, () => {
        const actual = server.address().port;
        console.log(`[Frontend] ${forcedLayout.toUpperCase().padEnd(10)} running at http://localhost:${actual} (backend proxy -> 127.0.0.1:${backendPort})`);
        if (typeof onListening === 'function') onListening(actual);
    });

    return server;
}

function launchAppWindow(url, width, height) {
    const candidates = [
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ];
    if (process.env.LOCALAPPDATA) {
        candidates.push(path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    }
    let exe = null;
    for (const c of candidates) {
        if (fs.existsSync(c)) { exe = c; break; }
    }
    if (!exe) {
        console.warn('[Frontend] No Edge/Chrome found to open the app window; open the operator link the backend prints.');
        return;
    }

    try {
        const child = spawn(exe, [
            `--app=${url}`,
            `--window-size=${width},${height}`,
            '--disable-extensions',
            '--disable-plugins',
            '--no-first-run'
        ], { detached: true, stdio: 'ignore' });
        child.unref();
    } catch (_) {}
}

/**
 * The kiosk proves it runs on this PC by opening ?op=<secret>; the page trades
 * it for the operator cookie. The backend may still be starting, so wait for
 * the file. Resolves null if it never becomes readable: the window then opens
 * as an ordinary local browser (full machine control, no remote admin).
 */
function readOperatorSecret(timeoutMs = OPERATOR_TOKEN_WAIT_MS) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve) => {
        const attempt = () => {
            try {
                const secret = fs.readFileSync(operatorTokenPath, 'utf8').trim().toLowerCase();
                if (OPERATOR_SECRET_PATTERN.test(secret)) return resolve(secret);
            } catch (_) {
                // Not created yet, or briefly locked by OneDrive/antivirus.
            }
            if (Date.now() >= deadline) return resolve(null);
            setTimeout(attempt, 500);
        };
        attempt();
    });
}

function kioskUrl(port, secret) {
    const base = `http://localhost:${port}`;
    return secret ? `${base}/?op=${secret}` : base;
}

module.exports = { createFrontendServer, isLoopbackAddress, isBackendPath, kioskUrl };

if (require.main !== module) return;

const args = process.argv.slice(2);
const startHorizontal = !args.includes('--vertical') || args.includes('--all') || args.includes('--horizontal');
const startVertical = !args.includes('--horizontal') || args.includes('--all') || args.includes('--vertical');

if (startHorizontal) {
    createFrontendServer(3000, 'horizontal');
}

if (startVertical) {
    createFrontendServer(3001, 'vertical');
}

const openRequested = ['--open-horizontal', '--open-vertical', '--open-dual'].some((flag) => args.includes(flag));

if (openRequested) {
    setTimeout(async () => {
        const secret = await readOperatorSecret();
        if (!secret) {
            console.warn('[Frontend] backend/data/operator-token is not readable yet; opening without operator access.');
            console.warn('[Frontend] Start the backend (RUN.bat) first, or open the operator link it prints.');
        }
        if (args.includes('--open-horizontal')) {
            launchAppWindow(kioskUrl(3000, secret), 1400, 900);
        } else if (args.includes('--open-vertical')) {
            launchAppWindow(kioskUrl(3001, secret), 600, 980);
        } else if (args.includes('--open-dual')) {
            launchAppWindow(kioskUrl(3000, secret), 1100, 850);
            setTimeout(() => launchAppWindow(kioskUrl(3001, secret), 580, 950), 600);
        }
    }, 800);
}
