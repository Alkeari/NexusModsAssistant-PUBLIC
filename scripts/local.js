'use strict';

const fs = require('fs');
const path = require('path');
const webpack = require('webpack');
const nma = require('./lib/nma');

const started = Date.now();
nma.guard('local', started);

const args = nma.parseArgs(process.argv.slice(2));
const target = args._[0] === 'firefox' ? 'firefox' : 'chrome';
const port = Number(args.port || process.env.NMA_DEV_PORT || 9012);
const distDir = path.join(nma.ROOT, 'dist-' + target);
const firstRunMarker = 'first-run-' + target + '.json';

function newestSourceMtime() {
    let newest = 0;
    for (const root of [path.join(nma.ROOT, 'src'), path.join(nma.ROOT, 'manifests')]) {
        for (const rel of nma.walkFiles(root)) {
            const stat = fs.statSync(path.join(root, rel));
            if (stat.mtimeMs > newest) {
                newest = stat.mtimeMs;
            }
        }
    }
    return newest;
}

async function devServerStatus() {
    try {
        const res = await fetch('http://127.0.0.1:' + port + '/status', { signal: AbortSignal.timeout(1500) });
        if (!res.ok) {
            return null;
        }
        return await res.json();
    } catch (err) {
        void err;
        return null;
    }
}

async function waitForWatcher(sourceMtime) {
    const deadline = Date.now() + 60000;
    let lastLog = 0;
    for (;;) {
        const status = await devServerStatus();
        if (!status) {
            return null;
        }
        if (!status.building && status.endedAt >= sourceMtime) {
            return status;
        }
        if (Date.now() - lastLog > 5000) {
            nma.log('Waiting for the dev watcher to finish rebuilding...');
            lastLog = Date.now();
        }
        if (Date.now() > deadline) {
            throw new Error('Dev watcher did not produce a build within 60s. Is node scripts/dev.js ' + target + ' healthy?');
        }
        await nma.sleep(300);
    }
}

function buildOnce() {
    process.env.BROWSER = target;
    process.env.NMA_DEV_PORT = String(port);
    const configFactory = require(path.join(nma.ROOT, 'webpack.config.js'));
    const compiler = webpack(configFactory({}, { mode: 'development' }));
    return new Promise((resolve, reject) => {
        compiler.run((err, stats) => {
            compiler.close(() => {
                if (err) {
                    reject(err);
                    return;
                }
                const info = stats.toJson({ all: false, errors: true, assets: true, timings: true });
                resolve({
                    ok: !stats.hasErrors(),
                    errors: (info.errors || []).map((e) => e.message || String(e)),
                    changed: Array.from(stats.compilation.emittedAssets || []),
                    durationMs: info.time || 0
                });
            });
        });
    });
}

function assertUnpackedArtifact() {
    const problems = [];
    const manifestFile = path.join(distDir, 'manifest.json');
    if (!fs.existsSync(manifestFile)) {
        problems.push('manifest.json missing from ' + distDir);
        return problems;
    }
    const manifest = nma.readJson(manifestFile);
    const expected = [
        'background/background.js',
        'content/content.js',
        'content/content.css',
        'popup/popup.js',
        'popup/popup.html',
        'popup/popup.css'
    ];
    for (const rel of expected) {
        const full = path.join(distDir, rel);
        if (!fs.existsSync(full) || fs.statSync(full).size === 0) {
            problems.push('missing or empty: ' + rel);
        }
    }
    for (const size of ['16', '32', '48', '128']) {
        const icon = manifest.icons && manifest.icons[size];
        if (icon && !fs.existsSync(path.join(distDir, icon))) {
            problems.push('icon declared but missing: ' + icon);
        }
    }
    if (!/\(Dev\)$/.test(manifest.name)) {
        problems.push('dev overlay did not apply: manifest name is ' + JSON.stringify(manifest.name));
    }
    const bundleFile = path.join(distDir, 'background', 'background.js');
    if (fs.existsSync(bundleFile)) {
        const bundle = fs.readFileSync(bundleFile, 'utf8');
        if (/\beval\(/.test(bundle)) {
            problems.push('background bundle contains eval(), which MV3 CSP blocks. Check webpack devtool.');
        }
    }
    return problems;
}

async function main() {
    const version = nma.readJson(path.join(nma.ROOT, 'package.json')).version;

    nma.step('Version drift check');
    const versionCheck = await nma.runNode(['scripts/version.js', 'check'], { capture: true, echo: true });
    if (versionCheck.code !== 0) {
        nma.finish({
            script: 'local',
            ok: false,
            target: target,
            version: version,
            state: 'drift',
            errors: ['Version locations disagree'],
            durationMs: Date.now() - started,
            nextStep: 'Run: npm run version:sync'
        }, nma.EXIT.PREFLIGHT);
    }

    nma.step('Type check');
    const tsc = await nma.runBin('tsc', ['--noEmit'], { capture: true, echo: true, timeoutMs: 300000 });
    if (tsc.code !== 0) {
        nma.finish({
            script: 'local',
            ok: false,
            target: target,
            version: version,
            state: 'type-error',
            errors: (tsc.stdout + tsc.stderr).split(/\r?\n/).filter(Boolean).slice(0, 40),
            durationMs: Date.now() - started,
            nextStep: 'Fix the TypeScript errors above, then re-run node scripts/local.js ' + target + '.'
        }, nma.EXIT.PREFLIGHT);
    }

    let build = null;
    const running = await devServerStatus();
    if (running && running.target === target) {
        nma.step('Dev watcher is running, waiting for its build');
        build = await waitForWatcher(newestSourceMtime());
    } else {
        nma.step('Building ' + target + ' (development)');
        const release = await nma.acquireLock('local-' + target, 90000);
        try {
            build = await buildOnce();
        } finally {
            release();
        }
    }

    if (!build || !build.ok) {
        nma.finish({
            script: 'local',
            ok: false,
            target: target,
            version: version,
            state: 'build-failed',
            errors: (build && build.errors) || ['build produced no result'],
            durationMs: Date.now() - started,
            nextStep: 'Fix the build errors above.'
        }, nma.EXIT.FAILED);
    }

    nma.step('Artifact assertions');
    const problems = assertUnpackedArtifact();
    if (problems.length) {
        for (const problem of problems) {
            nma.errline(problem);
        }
        nma.finish({
            script: 'local',
            ok: false,
            target: target,
            version: version,
            artifact: distDir,
            state: 'artifact-invalid',
            errors: problems,
            durationMs: Date.now() - started,
            nextStep: 'The build completed but the output is not loadable. See errors above.'
        }, nma.EXIT.PREFLIGHT);
    }

    const warnings = [];
    let nextStep = null;
    const firstRun = nma.readState(firstRunMarker, null);

    // Nothing on this side can observe the browser, so these say what the build did and
    // what should follow from it. Claiming the extension reloaded would be a guess.
    if (target === 'chrome') {
        if (running && running.target === 'chrome') {
            nextStep = 'Build is on disk and the dev watcher is serving a new build id, so a loaded (Dev) extension reloads itself and refreshes open Nexus tabs within a few seconds. Look at the browser. If nothing moves, the extension is not loaded from ' + distDir + ' or the reloader is off.';
        } else {
            warnings.push('No reload server answered on port ' + port + ', so either no dev watcher is running or it was started with --no-reload. Nothing auto-reloaded.');
            nextStep = 'Open chrome://extensions and click the reload arrow on the (Dev) copy of Nexus Mods Assistant, then press F5 on any open nexusmods.com mods tab. Run node scripts/dev.js chrome to make this automatic.';
        }
    } else {
        nextStep = running && running.target === 'firefox'
            ? 'Build is on disk. web-ext reloads the temporary add-on on its own once it sees the change.'
            : 'Open about:debugging#/runtime/this-firefox, Load Temporary Add-on, pick ' + path.join(distDir, 'manifest.json') + '. Run node scripts/dev.js firefox to make this automatic.';
    }

    if (!firstRun) {
        nma.log('');
        nma.log('First time loading this build:');
        if (target === 'chrome') {
            nma.log('  1. Open chrome://extensions');
            nma.log('  2. Turn Developer mode ON and leave it on. Chrome 134+ disables unpacked extensions when it is off.');
            nma.log('  3. Click Load unpacked');
            nma.log('  4. Select ' + distDir);
            nma.log('  5. Pin it. The name carries a (Dev) suffix so it cannot be confused with the store copy.');
        } else {
            nma.log('  1. Open about:debugging#/runtime/this-firefox');
            nma.log('  2. Click Load Temporary Add-on');
            nma.log('  3. Select ' + path.join(distDir, 'manifest.json'));
            nma.log('  Note: the dev build uses gecko id nexus-mods-assistant-dev@alkearilabs.com so it coexists with the store copy.');
        }
        nma.log('');
        nma.writeState(firstRunMarker, { shown: new Date().toISOString(), dist: distDir });
    }

    nma.finish({
        script: 'local',
        ok: true,
        target: target,
        version: version,
        action: 'build',
        artifact: distDir,
        changed: build.changed || [],
        state: 'local-ready',
        durationMs: Date.now() - started,
        warnings: warnings,
        nextStep: nextStep
    }, nma.EXIT.OK);
}

main().catch((err) => {
    if (nma.isFinished(err)) {
        return;
    }
    nma.errline(err.message);
    nma.finish({
        script: 'local',
        ok: false,
        target: target,
        state: 'failed',
        errors: [err.message],
        durationMs: Date.now() - started
    }, err.exitCode || nma.EXIT.FAILED);
});
