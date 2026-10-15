'use strict';

const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const nma = require('./lib/nma');

const started = Date.now();
nma.guard('package', started);

const args = nma.parseArgs(process.argv.slice(2));
const browser = args._[0] === 'firefox' ? 'firefox' : 'chrome';
const distFolder = path.join(nma.ROOT, 'dist-' + browser);
const packagesFolder = path.join(nma.ROOT, 'packages');

function main() {
    if (!fs.existsSync(distFolder)) {
        throw Object.assign(new Error(distFolder + ' does not exist. Run npm run build:' + browser + ' first.'), {
            exitCode: nma.EXIT.FAILED
        });
    }

    const manifestFile = path.join(distFolder, 'manifest.json');
    if (!fs.existsSync(manifestFile)) {
        throw new Error('manifest.json missing from ' + distFolder);
    }

    const manifest = nma.readJson(manifestFile);
    const pkgVersion = nma.readJson(path.join(nma.ROOT, 'package.json')).version;

    // The version that ships is the one inside the built manifest. Reading it from
    // package.json instead is how a zip ends up named for a version it does not contain.
    const version = manifest.version;
    if (version !== pkgVersion) {
        throw Object.assign(
            new Error('Version drift: dist-' + browser + '/manifest.json is ' + version + ' but package.json is ' + pkgVersion + '. Run npm run version:sync and rebuild.'),
            { exitCode: nma.EXIT.PREFLIGHT }
        );
    }
    if (manifest.version_name) {
        throw Object.assign(
            new Error('Refusing to package a development build: manifest carries version_name ' + manifest.version_name),
            { exitCode: nma.EXIT.PREFLIGHT }
        );
    }
    if (/\(Dev\)$/.test(manifest.name)) {
        throw Object.assign(
            new Error('Refusing to package a development build: manifest name is ' + manifest.name),
            { exitCode: nma.EXIT.PREFLIGHT }
        );
    }

    fs.mkdirSync(packagesFolder, { recursive: true });

    const suffix = args.dated ? '-' + new Date().toISOString().split('T')[0] : '';
    const zipName = 'nexus-mods-assistant-' + browser + '-v' + version + suffix + '.zip';
    const zipPath = path.join(packagesFolder, zipName);

    nma.log('Packaging ' + browser + ' v' + version);
    nma.log('  Source: ' + distFolder);
    nma.log('  Output: ' + zipPath);

    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', () => {
        const entries = nma.zipEntries(zipPath);
        if (!entries.includes('manifest.json')) {
            nma.errline('manifest.json is not at the zip root. Both stores reject this.');
            nma.finish({
                script: 'package',
                ok: false,
                target: browser,
                version: version,
                artifact: zipPath,
                state: 'invalid-archive',
                errors: ['manifest.json not at zip root'],
                durationMs: Date.now() - started
            }, nma.EXIT.PREFLIGHT);
        }
        const sizeMb = (fs.statSync(zipPath).size / 1024 / 1024).toFixed(2);
        nma.log('Created ' + zipName + ' (' + sizeMb + ' MB, ' + entries.length + ' entries)');
        nma.finish({
            script: 'package',
            ok: true,
            target: browser,
            version: version,
            action: 'package',
            artifact: zipPath,
            changed: entries,
            state: 'packaged',
            durationMs: Date.now() - started,
            nextStep: 'Run node scripts/preflight.js --scope release before uploading.'
        }, nma.EXIT.OK);
    });

    archive.on('warning', (err) => {
        nma.warn(err.message);
    });

    archive.on('error', (err) => {
        nma.errline('Packaging failed: ' + err.message);
        nma.finish({
            script: 'package',
            ok: false,
            target: browser,
            version: version,
            state: 'failed',
            errors: [err.message],
            durationMs: Date.now() - started
        }, nma.EXIT.FAILED);
    });

    archive.pipe(output);
    // The false argument flattens dist-<browser>/ to the zip root. Removing it puts
    // manifest.json inside a folder and every upload is rejected.
    archive.directory(distFolder, false);
    archive.finalize();
}

try {
    main();
} catch (err) {
    if (nma.isFinished(err)) {
        throw err;
    }
    nma.errline(err.message);
    nma.finish({
        script: 'package',
        ok: false,
        target: browser,
        state: 'failed',
        errors: [err.message],
        durationMs: Date.now() - started
    }, err.exitCode || nma.EXIT.FAILED);
}
