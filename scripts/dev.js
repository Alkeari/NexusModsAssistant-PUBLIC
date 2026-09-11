'use strict';

const http = require('http');
const path = require('path');
const crypto = require('crypto');
const webpack = require('webpack');
const nma = require('./lib/nma');

const started = Date.now();
nma.guard('dev', started);

const args = nma.parseArgs(process.argv.slice(2));
const target = args._[0] === 'firefox' ? 'firefox' : 'chrome';
const port = Number(args.port || process.env.NMA_DEV_PORT || 9012);
const reloadEnabled = args['no-reload'] !== true && target === 'chrome';

process.env.BROWSER = target;
// Set before webpack.config.js is required: the config bakes this port into both the dev
// host permission and the reloader bundle.
process.env.NMA_DEV_PORT = String(port);
if (!reloadEnabled) {
    process.env.NMA_DEV_RELOAD = '0';
}

const status = {
    buildId: crypto.randomUUID(),
    building: true,
    ok: false,
    endedAt: 0,
    durationMs: 0,
    changed: [],
    errors: []
};

let server = null;

function startServer() {
    server = http.createServer((req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 'no-store');
        if (req.url === '/build-id') {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end(status.buildId);
            return;
        }
        if (req.url === '/status' || req.url === '/health') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(Object.assign({ target: target, pid: process.pid }, status)));
            return;
        }
        res.writeHead(404);
        res.end();
    });
    server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            nma.errline('Port ' + port + ' is already in use. Another dev session is running.');
            nma.finish({
                script: 'dev',
                ok: false,
                target: target,
                state: 'port-in-use',
                errors: ['Port ' + port + ' in use'],
                durationMs: Date.now() - started,
                nextStep: 'Stop the other dev session, or pass --port with a free port.'
            }, nma.EXIT.REFUSED);
        }
        throw err;
    });
    server.listen(port, '127.0.0.1', () => {
        nma.log('Reload server listening on http://127.0.0.1:' + port);
    });
}

function startWebpack() {
    const configFactory = require(path.join(nma.ROOT, 'webpack.config.js'));
    const compiler = webpack(configFactory({}, { mode: 'development' }));

    compiler.hooks.watchRun.tap('nma-dev', () => {
        status.building = true;
        // Heartbeat so an agent can tell compiling from hung.
        nma.log('Rebuilding ' + target + '...');
    });

    compiler.watch({ aggregateTimeout: 200, ignored: /node_modules/ }, (err, stats) => {
        status.building = false;
        status.endedAt = Date.now();
        if (err) {
            status.ok = false;
            status.errors = [err.message];
            nma.errline(err.message);
        } else {
            const info = stats.toJson({ all: false, errors: true, assets: true, timings: true });
            status.ok = !stats.hasErrors();
            status.errors = (info.errors || []).map((e) => e.message || String(e));
            status.durationMs = info.time || 0;
            status.changed = Array.from(stats.compilation.emittedAssets || []);
            if (status.ok) {
                status.buildId = crypto.randomUUID();
                nma.log('Build ok in ' + status.durationMs + 'ms, ' + status.changed.length + ' assets emitted');
            } else {
                for (const message of status.errors) {
                    nma.errline(message);
                }
            }
        }
        // The watcher is long lived, so it writes a result line per build directly
        // rather than through the one-shot emit guard.
        nma.writeResult({
            script: 'dev',
            ok: status.ok,
            target: target,
            action: 'build',
            version: nma.readJson(path.join(nma.ROOT, 'package.json')).version,
            artifact: path.join(nma.ROOT, 'dist-' + target),
            changed: status.changed,
            state: status.ok ? 'local-ready' : 'build-failed',
            durationMs: status.durationMs,
            errors: status.errors,
            nextStep: status.ok ? null : 'Fix the build errors above.'
        });
    });
}

async function startFirefoxRunner() {
    nma.log('Launching web-ext run against dist-firefox');
    const result = await nma.runBin('web-ext', [
        'run',
        '--source-dir', 'dist-firefox',
        '--target', 'firefox-desktop',
        '--no-input',
        '--no-config-discovery',
        '--browser-console'
    ]);
    if (result.code !== 0) {
        nma.errline('web-ext run exited with code ' + result.code);
    }
}

nma.log('Dev session: target=' + target + ' reload=' + (reloadEnabled ? 'on' : 'off'));
if (target === 'chrome' && !reloadEnabled) {
    nma.log('Reloading is off, so the extension will not refresh itself. Reload it by hand at chrome://extensions after each build. This is the mode to use when testing service worker sleep behavior.');
}
if (reloadEnabled) {
    startServer();
}
startWebpack();
if (target === 'firefox') {
    void startFirefoxRunner();
}

process.on('SIGINT', () => {
    nma.log('Shutting down dev session');
    if (server) {
        server.close();
    }
    process.exit(0);
});
