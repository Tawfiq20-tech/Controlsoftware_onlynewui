/**
 * Dual Localhost Frontend Server (Onefinity Sender)
 *
 * Runs two standalone frontend endpoints:
 *   - http://localhost:3000 -> HORIZONTAL (Landscape desktop layout)
 *   - http://localhost:3001 -> VERTICAL (Portrait / Touchscreen layout)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const distPath = path.join(__dirname, '..', 'frontend', 'dist');

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

function createFrontendServer(port, forcedLayout) {
    const server = http.createServer((req, res) => {
        let reqUrl = req.url.split('?')[0];
        if (reqUrl === '/') reqUrl = '/index.html';

        let filePath = path.join(distPath, reqUrl);
        if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
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

    server.listen(port, () => {
        console.log(`[Frontend] ${forcedLayout.toUpperCase().padEnd(10)} running at http://localhost:${port}`);
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
    let exe = null;
    for (const c of candidates) {
        if (fs.existsSync(c)) { exe = c; break; }
    }
    if (!exe) return;

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

const args = process.argv.slice(2);
const startHorizontal = !args.includes('--vertical') || args.includes('--all') || args.includes('--horizontal');
const startVertical = !args.includes('--horizontal') || args.includes('--all') || args.includes('--vertical');

if (startHorizontal) {
    createFrontendServer(3000, 'horizontal');
}

if (startVertical) {
    createFrontendServer(3001, 'vertical');
}

setTimeout(() => {
    if (args.includes('--open-horizontal')) {
        launchAppWindow('http://localhost:3000', 1400, 900);
    } else if (args.includes('--open-vertical')) {
        launchAppWindow('http://localhost:3001', 600, 980);
    } else if (args.includes('--open-dual')) {
        launchAppWindow('http://localhost:3000', 1100, 850);
        setTimeout(() => launchAppWindow('http://localhost:3001', 580, 950), 600);
    }
}, 800);
