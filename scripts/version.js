'use strict';

const fs = require('fs');
const path = require('path');
const nma = require('./lib/nma');

const started = Date.now();
nma.guard('version', started);

const PKG = path.join(nma.ROOT, 'package.json');
const LOCK = path.join(nma.ROOT, 'package-lock.json');
const CHROME = path.join(nma.ROOT, 'manifests', 'chrome.json');
const FIREFOX = path.join(nma.ROOT, 'manifests', 'firefox.json');
// README.md carries no version marker. It is the store description: Mod Publisher renders it to
// the Nexus page on every release, and the page prints the version above the description itself,
// so a line in the body could only ever be a second copy to go stale (house store-description
// system, adopted here 2026-09-06).

/**
 * Documents that are pasted into a store or a mod page by hand. They state which
 * build they describe, and a stale statement there is worse than one in the code:
 * nothing compiles it, nobody reviews it, and it ends up in front of users. Each
 * carries a "Written for vX.Y.Z" marker so this script can own it.
 */
const DOC_MARKER_PATTERN = /(Written for v)(\d+(?:\.\d+){0,3})/;
const VERSIONED_DOCS = [
    'docs/STORE-LISTINGS.md',
    'docs/PRE-RELEASE-TESTS.md'
];

function readDocVersion(rel) {
    const full = path.join(nma.ROOT, rel);
    if (!fs.existsSync(full)) {
        return null;
    }
    const match = fs.readFileSync(full, 'utf8').match(DOC_MARKER_PATTERN);
    return match ? match[2] : null;
}

function writeDocVersions(version) {
    for (const rel of VERSIONED_DOCS) {
        const full = path.join(nma.ROOT, rel);
        if (!fs.existsSync(full)) {
            continue;
        }
        const text = fs.readFileSync(full, 'utf8');
        if (!DOC_MARKER_PATTERN.test(text)) {
            throw new Error(rel + ' is missing its version marker. It must contain: Written for vX.Y.Z');
        }
        fs.writeFileSync(full, text.replace(DOC_MARKER_PATTERN, '$1' + version), 'utf8');
    }
}

function readAll() {
    const lock = nma.readJson(LOCK);
    return {
        'package.json': nma.readJson(PKG).version,
        'package-lock.json': lock.version || null,
        'manifests/chrome.json': nma.readJson(CHROME).version,
        'manifests/firefox.json': nma.readJson(FIREFOX).version,
        ...Object.fromEntries(VERSIONED_DOCS.map(rel => [rel, readDocVersion(rel)]))
    };
}

function writeAll(version) {
    const pkg = nma.readJson(PKG);
    pkg.version = version;
    nma.writeJson(PKG, pkg);

    // The lockfile carries the version twice and npm ci reads both. A reviewer following
    // BUILD-INSTRUCTIONS.md runs npm ci against exactly this file.
    const lock = nma.readJson(LOCK);
    lock.version = version;
    if (lock.packages && lock.packages['']) {
        lock.packages[''].version = version;
    }
    nma.writeJson(LOCK, lock);

    for (const file of [CHROME, FIREFOX]) {
        const manifest = nma.readJson(file);
        manifest.version = version;
        nma.writeJson(file, manifest);
    }

    writeDocVersions(version);
}

function checkOnly() {
    const versions = readAll();
    const canonical = versions['package.json'];
    const drift = [];
    for (const [file, value] of Object.entries(versions)) {
        if (value === null) {
            drift.push(file + ': version marker not found');
        } else if (value !== canonical) {
            drift.push(file + ': ' + value + ' (expected ' + canonical + ')');
        }
    }
    if (!nma.parseVersion(canonical)) {
        drift.push('package.json: ' + canonical + ' is not a valid 1-4 part version with each part 0-65535');
    }
    return { canonical: canonical, versions: versions, drift: drift };
}

async function main() {
    const args = nma.parseArgs(process.argv.slice(2));
    const command = args._[0] || 'check';

    if (command === 'check') {
        const result = checkOnly();
        for (const [file, value] of Object.entries(result.versions)) {
            nma.log('  ' + file.padEnd(26) + (value === null ? '(marker missing)' : value));
        }
        if (result.drift.length) {
            for (const line of result.drift) {
                nma.errline(line);
            }
            nma.finish({
                script: 'version',
                ok: false,
                action: 'check',
                version: result.canonical,
                state: 'drift',
                errors: result.drift,
                durationMs: Date.now() - started,
                nextStep: 'Run: npm run version:sync'
            }, nma.EXIT.PREFLIGHT);
        }
        nma.log('All version locations agree on ' + result.canonical);
        nma.finish({
            script: 'version',
            ok: true,
            action: 'check',
            version: result.canonical,
            state: 'in-sync',
            durationMs: Date.now() - started
        }, nma.EXIT.OK);
    }

    if (command === 'sync') {
        const canonical = nma.readJson(PKG).version;
        if (!nma.parseVersion(canonical)) {
            throw new Error('package.json version is invalid: ' + canonical);
        }
        writeAll(canonical);
        nma.log('Synced all version locations to ' + canonical);
        nma.finish({
            script: 'version',
            ok: true,
            action: 'sync',
            version: canonical,
            state: 'in-sync',
            durationMs: Date.now() - started
        }, nma.EXIT.OK);
    }

    if (command === 'bump') {
        const current = nma.readJson(PKG).version;
        const target = args.set ? String(args.set) : nma.bumpVersion(current, String(args.level || 'patch'));
        if (!nma.parseVersion(target)) {
            throw new Error('Refusing to write an invalid version: ' + target);
        }
        if (nma.compareVersions(target, current) <= 0) {
            throw Object.assign(new Error('Refusing to bump ' + current + ' to ' + target + ': not an increase'), {
                exitCode: nma.EXIT.REFUSED
            });
        }

        // A version number is a claim that the shipped extension changed. Bumping
        // for a documentation edit or a change to the publishing scripts makes the
        // local number run ahead of every store while the code is byte identical,
        // which is exactly how 3.2.9, 3.2.10 and 3.2.11 came to be the same build.
        // --allow-no-code is the deliberate override.
        if (!args['allow-no-code']) {
            let changed = '';
            try {
                // Uncommitted work counts, and so does anything committed since the last release.
                // Checking only the working tree asked the wrong question: it refused a bump whose
                // code had been committed first, which is the normal order when the change is large
                // enough to want reviewing before the version claim is made. The tag is the release,
                // so the tag is what a new number is measured against.
                changed = String((await nma.runGit(['status', '--porcelain', '--', 'src', 'manifests'])).stdout || '').trim();
                if (!changed) {
                    const tag = 'v' + current;
                    const known = String((await nma.runGit(['tag', '--list', tag])).stdout || '').trim();
                    if (known) {
                        changed = String((await nma.runGit(
                            ['diff', '--name-only', tag, 'HEAD', '--', 'src', 'manifests'])).stdout || '').trim();
                    }
                }
            } catch (err) {
                void err;
            }
            if (!changed) {
                throw Object.assign(new Error(
                    'Refusing to bump: nothing under src/ or manifests/ has changed, so the shipped\n'
                    + 'extension would be identical to ' + current + ' under a new number. Bump when the\n'
                    + 'extension changes, not when documentation or the release scripts do.\n'
                    + 'Pass --allow-no-code if you really mean it.'
                ), { exitCode: nma.EXIT.REFUSED });
            }
        }

        writeAll(target);
        nma.log('Bumped ' + current + ' to ' + target + ' in all five locations');
        nma.finish({
            script: 'version',
            ok: true,
            action: 'bump',
            version: target,
            state: 'in-sync',
            durationMs: Date.now() - started,
            nextStep: 'Nothing was committed. Run node scripts/release.js when ready to publish.'
        }, nma.EXIT.OK);
    }

    throw new Error('Unknown command: ' + command + '. Use check, sync, or bump.');
}

main().catch((err) => {
    if (nma.isFinished(err)) {
        throw err;
    }
    nma.errline(err.message);
    nma.finish({
        script: 'version',
        ok: false,
        state: 'failed',
        errors: [err.message],
        durationMs: Date.now() - started
    }, err.exitCode || nma.EXIT.FAILED);
});
