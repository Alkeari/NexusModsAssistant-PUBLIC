'use strict';

const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const nma = require('./lib/nma');

const started = Date.now();
nma.guard('package-source', started);

// Anything untracked (node_modules, dist, credentials) is excluded by construction
// because the file list comes from git. These patterns remove tracked material that
// should not go to a reviewer: editor and tooling state and captured pages.
//
// Dot folders are one rule rather than a name each, because every one of them holds state
// a tool wrote and none of it is build input, so a new one is denied before anyone thinks
// to list it. Dot FILES are still named one at a time, so a config a build reads would
// keep shipping. .REFERENCE is the one that matters most: it is a saved authenticated
// Nexus page carrying live session cookies and it is TRACKED, so .gitignore does not
// exclude it.
const FORBIDDEN = [
    /^\.[^/]+\//,
    /^\.gitattributes$/,
    /^\.gitignore$/,
    /^RELEASE_NOTES\.md$/,
    /(^|\/)\.env($|\.)/i,
    /\.pem$/i,
    /\.p12$/i,
    /service-account.*\.json$/i,
    /nma-publish/i,
    /^node_modules\//,
    /^dist(-|\/)/,
    /^packages\//
];

const REQUIRED = ['package.json', 'package-lock.json', 'webpack.config.js', 'tsconfig.json', 'BUILD-INSTRUCTIONS.md'];

function forbiddenMatches(list) {
    return list.filter((entry) => FORBIDDEN.some((rule) => rule.test(entry)));
}

async function main() {
    const version = nma.readJson(path.join(nma.ROOT, 'package.json')).version;
    const packagesFolder = path.join(nma.ROOT, 'packages');
    fs.mkdirSync(packagesFolder, { recursive: true });

    const zipName = 'nexus-mods-assistant-source-v' + version + '.zip';
    const zipPath = path.join(packagesFolder, zipName);

    const listed = await nma.runGit(['ls-files', '-z']);
    if (listed.code !== 0) {
        throw new Error('git ls-files failed: ' + listed.stderr);
    }
    const tracked = listed.stdout.split('\0').filter(Boolean);
    if (!tracked.length) {
        throw new Error('git ls-files returned nothing. Refusing to build an empty source archive.');
    }
    const excluded = forbiddenMatches(tracked);
    const files = tracked.filter((file) => !FORBIDDEN.some((rule) => rule.test(file)));

    const missing = REQUIRED.filter((required) => !files.includes(required));
    if (missing.length) {
        throw Object.assign(
            new Error('Source archive would be incomplete. Missing tracked files: ' + missing.join(', ') +
                '. Every one of these must exist and be committed before an AMO submission.'),
            { exitCode: nma.EXIT.PREFLIGHT }
        );
    }
    if (!files.some((file) => file.startsWith('src/'))) {
        throw new Error('Source archive would contain no src/ files');
    }

    nma.log('Building AMO source archive with ' + files.length + ' of ' + tracked.length + ' tracked files');
    for (const entry of excluded) {
        nma.log('  excluded: ' + entry);
    }

    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', () => {
        // Independent of the filter above: this reads back what actually landed in the
        // archive. One guard that both builds and verifies the list can only ever agree
        // with itself.
        const entries = nma.zipEntries(zipPath);
        const leaked = forbiddenMatches(entries);
        if (leaked.length) {
            fs.unlinkSync(zipPath);
            nma.errline('Denylisted paths reached the source archive: ' + leaked.join(', '));
            nma.finish({
                script: 'package-source',
                ok: false,
                target: 'firefox',
                version: version,
                state: 'leaked',
                errors: ['Denylisted paths in the archive: ' + leaked.join(', ')],
                durationMs: Date.now() - started,
                nextStep: 'The archive was deleted rather than left on disk where it could be uploaded. Fix FORBIDDEN in scripts/package-source.js.'
            }, nma.EXIT.PREFLIGHT);
        }

        const sizeMb = fs.statSync(zipPath).size / 1024 / 1024;
        if (sizeMb > 200) {
            nma.finish({
                script: 'package-source',
                ok: false,
                target: 'firefox',
                version: version,
                artifact: zipPath,
                state: 'too-large',
                errors: ['Source archive is ' + sizeMb.toFixed(1) + ' MB, AMO rejects over 200 MB'],
                durationMs: Date.now() - started
            }, nma.EXIT.PREFLIGHT);
        }
        nma.log('Created ' + zipName + ' (' + sizeMb.toFixed(2) + ' MB, ' + entries.length + ' entries, ' + excluded.length + ' tracked paths excluded)');
        nma.finish({
            script: 'package-source',
            ok: true,
            target: 'firefox',
            version: version,
            action: 'package',
            artifact: zipPath,
            changed: entries,
            state: 'packaged',
            durationMs: Date.now() - started,
            nextStep: 'Open the zip and read the file list before the first AMO upload.'
        }, nma.EXIT.OK);
    });

    archive.on('warning', (err) => {
        nma.warn(err.message);
    });

    archive.on('error', (err) => {
        nma.errline('Source archiving failed: ' + err.message);
        nma.finish({
            script: 'package-source',
            ok: false,
            target: 'firefox',
            version: version,
            state: 'failed',
            errors: [err.message],
            durationMs: Date.now() - started
        }, nma.EXIT.FAILED);
    });

    archive.pipe(output);
    for (const file of files) {
        archive.file(path.join(nma.ROOT, file), { name: file });
    }
    archive.finalize();
}

main().catch((err) => {
    if (nma.isFinished(err)) {
        return;
    }
    nma.errline(err.message);
    nma.finish({
        script: 'package-source',
        ok: false,
        target: 'firefox',
        state: 'failed',
        errors: [err.message],
        durationMs: Date.now() - started
    }, err.exitCode || nma.EXIT.FAILED);
});
