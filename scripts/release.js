'use strict';

const fs = require('fs');
const path = require('path');
const nma = require('./lib/nma');

const started = Date.now();
nma.guard('release', started);

const args = nma.parseArgs(process.argv.slice(2));
const dryRun = args['dry-run'] === true;
const targets = String(args.targets || 'chrome,firefox').split(',').map((t) => t.trim()).filter(Boolean);
const noGit = args['no-git'] === true;
const NOTE_PREFIX = /^(Added|Changed|Fixed|Removed):\s+\S/;
const PLACEHOLDER = "Fixed: Replace this file's contents before every release.";

function loadNotes() {
    if (typeof args.notes === 'string') {
        return args.notes.split('\\n').join('\n').trim();
    }
    const file = path.resolve(nma.ROOT, String(args['notes-file'] || 'RELEASE_NOTES.md'));
    if (!fs.existsSync(file)) {
        throw Object.assign(
            new Error('No release notes. Write them to ' + file + ' or pass --notes "Fixed: ...". Every line must start with Added:, Changed:, Fixed: or Removed:.'),
            { exitCode: nma.EXIT.REFUSED }
        );
    }
    return fs.readFileSync(file, 'utf8').trim();
}

function validateNotes(text) {
    if (text.trim() === PLACEHOLDER) {
        throw Object.assign(
            new Error('RELEASE_NOTES.md still contains the placeholder text. Write the real notes for this release.'),
            { exitCode: nma.EXIT.REFUSED }
        );
    }
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const entries = lines.filter((line) => !line.startsWith('###'));
    if (!entries.length) {
        throw Object.assign(new Error('Release notes contain no entries'), { exitCode: nma.EXIT.REFUSED });
    }
    const bad = entries.filter((line) => !NOTE_PREFIX.test(line.replace(/^-\s*/, '')));
    if (bad.length) {
        throw Object.assign(
            new Error('These note lines do not use an Added:/Changed:/Fixed:/Removed: prefix:\n    ' + bad.join('\n    ')),
            { exitCode: nma.EXIT.REFUSED }
        );
    }
    return lines.map((line) => (line.startsWith('###') ? line : '- ' + line.replace(/^-\s*/, '')));
}

function findInProgress() {
    if (!fs.existsSync(nma.STATE_DIR)) {
        return null;
    }
    const found = [];
    for (const file of fs.readdirSync(nma.STATE_DIR)) {
        if (!/^release-.*\.json$/.test(file)) {
            continue;
        }
        const state = nma.readState(file, null);
        if (state && state.status === 'in-progress') {
            found.push({ file: file, state: state });
        }
    }
    if (!found.length) {
        return null;
    }
    found.sort((a, b) => String(a.state.startedAt).localeCompare(String(b.state.startedAt)));
    return found[0];
}

function prependChangelog(version, noteLines) {
    const file = path.join(nma.ROOT, 'CHANGELOG.md');
    const header = '# Changelog\n\nNewest version first.\n';
    const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : header;
    if (existing.includes('\n## v' + version + '\n')) {
        return false;
    }
    const grouped = noteLines.some((line) => line.startsWith('###'))
        ? noteLines
        : ['### Nexus Mods Assistant'].concat(noteLines);
    const section = '## v' + version + '\n\n' + grouped.join('\n') + '\n';
    const marker = existing.indexOf('\n## v');
    const next = marker < 0
        ? existing.trimEnd() + '\n\n' + section + '\n'
        : existing.slice(0, marker + 1) + section + '\n' + existing.slice(marker + 1);
    fs.writeFileSync(file, next, 'utf8');
    return true;
}

// A new permission or host permission makes a justification field appear on the Chrome
// Privacy tab, and :publish fails with "Publish condition not met" until it is filled by
// hand. No API can detect that, so the only useful thing to do is say so before starting.
async function permissionDiffWarnings() {
    const tags = await nma.runGit(['tag', '--list', 'v*', '--sort=-v:refname']);
    const previous = tags.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0];
    if (!previous) {
        return ['No previous release tag exists, so permissions could not be compared against a shipped version. This is "could not look", not "nothing changed". If this is the first submission, expect to fill every Chrome permission justification by hand.'];
    }
    const messages = [];
    for (const target of ['chrome', 'firefox']) {
        const file = 'manifests/' + target + '.json';
        const shown = await nma.runGit(['show', previous + ':' + file]);
        if (shown.code !== 0) {
            messages.push('Could not read ' + file + ' at ' + previous + ', so permissions were not compared for ' + target + '.');
            continue;
        }
        let old;
        try {
            old = JSON.parse(shown.stdout);
        } catch (err) {
            messages.push('Could not parse ' + file + ' at ' + previous + ' (' + err.message + '), so permissions were not compared for ' + target + '.');
            continue;
        }
        const now = nma.readJson(path.join(nma.ROOT, file));
        for (const key of ['permissions', 'host_permissions', 'optional_permissions']) {
            const before = new Set(old[key] || []);
            const added = (now[key] || []).filter((entry) => !before.has(entry));
            if (added.length) {
                messages.push(target + ': ' + key + ' gained ' + added.join(', ') + ' since ' + previous + '. Chrome will require a written justification on the Privacy tab before :publish succeeds.');
            }
        }
    }
    return messages;
}

async function runStep(state, id, fn) {
    if (state.steps[id] && state.steps[id].ok) {
        nma.log('SKIP  ' + id + ' (already done at ' + state.steps[id].at + ')');
        return state.steps[id].value;
    }
    nma.step(id);
    try {
        const value = await fn();
        state.steps[id] = { ok: true, at: new Date().toISOString(), value: value === undefined ? null : value };
        nma.writeState(state.__file, state);
        return value;
    } catch (err) {
        state.steps[id] = { ok: false, at: new Date().toISOString(), error: err.message };
        nma.writeState(state.__file, state);
        throw err;
    }
}

async function npmStep(id, npmArgs) {
    const result = await nma.runNpm(npmArgs, { capture: true, echo: true, timeoutMs: 900000 });
    if (result.code !== 0) {
        throw new Error(id + ' failed with exit code ' + result.code);
    }
    return true;
}

async function main() {
    if (args.abandon === true) {
        const found = findInProgress();
        if (!found) {
            nma.log('No in-progress release to abandon.');
            nma.finish({
                script: 'release', ok: true, action: 'check', state: 'none',
                durationMs: Date.now() - started, nextStep: 'Nothing to abandon.'
            }, nma.EXIT.OK);
        }
        const state = found.state;
        state.status = 'abandoned';
        state.abandonedAt = new Date().toISOString();
        nma.writeState(found.file, state);
        nma.finish({
            script: 'release', ok: true, version: state.version, action: 'check', state: 'abandoned',
            durationMs: Date.now() - started,
            nextStep: 'Abandoned release v' + state.version + '. Neither store was touched by this command. Any version number already uploaded stays burned. Run node scripts/store-status.js.'
        }, nma.EXIT.OK);
    }

    if (!dryRun && args.confirm !== 'PUBLISH') {
        throw Object.assign(
            new Error('Refusing to release without --confirm PUBLISH. Run node scripts/release.js --dry-run first, then: node scripts/release.js --bump patch --confirm PUBLISH'),
            { exitCode: nma.EXIT.REFUSED }
        );
    }

    const current = nma.readJson(path.join(nma.ROOT, 'package.json')).version;
    const resume = findInProgress();
    let version;
    let state;

    if (resume && !dryRun) {
        if (args.resume !== true) {
            throw Object.assign(
                new Error('A release of v' + resume.state.version + ' is in progress (' + resume.file + '). Re-run with --resume to continue it, or --abandon to give up on it. Refusing to start a new release on top of it.'),
                { exitCode: nma.EXIT.REFUSED }
            );
        }
        version = resume.state.version;
        state = resume.state;
        state.__file = resume.file;
        nma.log('RESUMING release of v' + version + '. --bump and --set are ignored on a resume.');
    } else {
        version = args.set ? String(args.set) : nma.bumpVersion(current, String(args.bump || 'patch'));
        state = {
            __file: 'release-' + version + '.json',
            version: version,
            from: current,
            targets: targets,
            status: 'in-progress',
            startedAt: new Date().toISOString(),
            steps: {}
        };
    }

    const noteLines = validateNotes(loadNotes());
    nma.log('Release ' + current + ' -> ' + version + ' targets=' + targets.join(',') + (dryRun ? ' (DRY RUN)' : ''));
    for (const line of noteLines) {
        nma.log('  ' + line);
    }

    const permissionWarnings = await permissionDiffWarnings();
    for (const message of permissionWarnings) {
        nma.warn(message);
    }

    if (dryRun) {
        // A dry run must not change the version, so it builds and packages at the CURRENT
        // version to prove the build works, and validates the TARGET version against the
        // stores. Artifact-existence checks are therefore skipped via --phase pre-build.
        await npmStep('build:all', ['run', 'build:all']);
        if (targets.includes('firefox')) {
            await npmStep('package:source', ['run', 'package:source']);
        }
        const pf = await nma.runNode([
            'scripts/preflight.js', '--scope', 'release', '--phase', 'pre-build',
            '--targets', targets.join(','), '--allow-dirty', '--version', version
        ], { capture: true, echo: true });
        if (pf.code !== 0) {
            throw Object.assign(new Error('Preflight failed. See output above.'), { exitCode: nma.EXIT.PREFLIGHT });
        }
        for (const target of targets) {
            const script = target === 'chrome' ? 'publish-chrome.js' : 'publish-amo.js';
            const res = await nma.runNode(['scripts/' + script, '--dry-run', '--version', version],
                { capture: true, echo: true });
            if (res.code !== 0) {
                throw Object.assign(new Error(target + ' dry run failed with exit code ' + res.code), { exitCode: res.code });
            }
        }
        nma.finish({
            script: 'release',
            ok: true,
            target: targets.length === 2 ? 'both' : targets[0],
            version: version,
            action: 'dry-run',
            state: 'dry-run-ok',
            url: nma.CHROME_LISTING,
            warnings: permissionWarnings,
            durationMs: Date.now() - started,
            nextStep: 'Would publish v' + version + ' to ' + targets.join(' and ') + '. Nothing changed on either store. Locally, dist-chrome, dist-firefox and packages/ were rebuilt at the current version ' + current + '. Run again with --bump ' + (args.bump || 'patch') + ' --confirm PUBLISH to do it for real.'
        }, nma.EXIT.OK);
    }

    await runStep(state, 'guard.tree', async () => {
        if (args['allow-dirty'] === true) {
            nma.warn('Working tree check skipped by --allow-dirty');
            return 'skipped';
        }
        const result = await nma.runGit(['status', '--porcelain']);
        const dirty = result.stdout.split(/\r?\n/).filter(Boolean);
        if (dirty.length) {
            throw Object.assign(
                new Error('Working tree is dirty. Commit or stash first, or pass --allow-dirty:\n    ' + dirty.join('\n    ')),
                { exitCode: nma.EXIT.REFUSED }
            );
        }
        return 'clean';
    });

    await runStep(state, 'version.bump', async () => {
        const now = nma.readJson(path.join(nma.ROOT, 'package.json')).version;
        if (now === version) {
            return 'already at ' + version;
        }
        const result = await nma.runNode(['scripts/version.js', 'bump', '--set', version], { capture: true, echo: true });
        if (result.code !== 0) {
            throw new Error('version bump failed');
        }
        return version;
    });

    await runStep(state, 'changelog', () => {
        return prependChangelog(version, noteLines) ? 'section added' : 'section already present';
    });

    if (!noGit) {
        await runStep(state, 'git.commit', async () => {
            // docs/STORE-LISTINGS.md and docs/PRE-RELEASE-TESTS.md carry a "Written for vX.Y.Z"
            // marker that scripts/version.js rewrites on every bump. Leaving them unstaged left the
            // tree dirty after each release, and the next release's own git.clean gate then refused
            // to run: the release made the condition that blocked the release after it.
            const add = await nma.runGit(['add', 'package.json', 'package-lock.json',
                'manifests/chrome.json', 'manifests/firefox.json', 'README.md', 'CHANGELOG.md',
                'docs/STORE-LISTINGS.md', 'docs/PRE-RELEASE-TESTS.md']);
            if (add.code !== 0) {
                throw new Error('git add failed: ' + add.stderr);
            }
            const message = ['Changed: Released v' + version + '.']
                .concat(noteLines.filter((line) => line.startsWith('- ')).map((line) => line.slice(2)))
                .join('\n') + '\n';
            // A multi-line -m argument is silently truncated on Windows, so the message
            // goes through a file.
            const messageFile = nma.writeTempFile('commit-message-' + version + '.txt', message);
            const result = await nma.runGit(['commit', '-F', messageFile]);
            if (result.code !== 0 && !/nothing to commit/i.test(result.stdout + result.stderr)) {
                throw new Error('git commit failed: ' + result.stderr);
            }
            return 'committed';
        });
    }

    await runStep(state, 'build', () => npmStep('build:all', ['run', 'build:all']));
    if (targets.includes('firefox')) {
        await runStep(state, 'package.source', () => npmStep('package:source', ['run', 'package:source']));
    }

    await runStep(state, 'preflight', async () => {
        const result = await nma.runNode([
            'scripts/preflight.js', '--scope', 'release', '--phase', 'post-build',
            '--targets', targets.join(','), '--version', version
        ], { capture: true, echo: true });
        if (result.code !== 0) {
            throw Object.assign(new Error('Preflight refused this release. Nothing was uploaded.'), {
                exitCode: nma.EXIT.PREFLIGHT
            });
        }
        return 'passed';
    });

    const storeResults = {};
    const storeErrors = [];

    for (const target of targets) {
        const stepId = 'publish.' + target;
        try {
            await runStep(state, stepId, async () => {
                const script = target === 'chrome' ? 'publish-chrome.js' : 'publish-amo.js';
                const publishArgs = ['scripts/' + script, '--confirm', 'PUBLISH', '--version', version];
                if (target === 'chrome' && args['publish-type']) {
                    publishArgs.push('--publish-type', String(args['publish-type']));
                }
                if (target === 'chrome' && args['deploy-percentage']) {
                    publishArgs.push('--deploy-percentage', String(args['deploy-percentage']));
                }
                if (target === 'firefox') {
                    publishArgs.push('--notes-file', String(args['notes-file'] || 'RELEASE_NOTES.md'));
                }
                const result = await nma.runNode(publishArgs, { capture: true, echo: true });
                const line = result.stdout.split(/\r?\n/).reverse().find((l) => l.startsWith(nma.RESULT_MARKER));
                const parsed = line ? JSON.parse(line.slice(nma.RESULT_MARKER.length)) : null;
                if (result.code !== 0) {
                    throw Object.assign(new Error(target + ' publish exited ' + result.code), {
                        exitCode: result.code,
                        parsed: parsed
                    });
                }
                return parsed;
            });
            storeResults[target] = state.steps[stepId].value;
        } catch (err) {
            storeErrors.push(target + ': ' + err.message);
            storeResults[target] = { ok: false, state: 'failed', error: err.message };
            nma.errline(target + ' publish failed: ' + err.message);
        }
    }

    const anySucceeded = targets.some((target) => storeResults[target] && storeResults[target].ok);
    const allSucceeded = targets.every((target) => storeResults[target] && storeResults[target].ok);

    if (anySucceeded && !noGit) {
        await runStep(state, 'git.tag', async () => {
            const existing = await nma.runGit(['tag', '--list', 'v' + version]);
            if (existing.stdout.trim()) {
                return 'tag already exists';
            }
            const message = 'v' + version + '\n\n' + noteLines.join('\n') + '\n';
            const messageFile = nma.writeTempFile('tag-message-' + version + '.txt', message);
            const result = await nma.runGit(['tag', '-a', 'v' + version, '-F', messageFile]);
            if (result.code !== 0) {
                throw new Error('git tag failed: ' + result.stderr);
            }
            return 'v' + version;
        });
        if (args.push === true) {
            await runStep(state, 'git.push', async () => {
                const result = await nma.runGit(['push', '--follow-tags']);
                if (result.code !== 0) {
                    throw new Error('git push failed: ' + result.stderr);
                }
                return 'pushed';
            });
        }
    }

    state.status = allSucceeded ? 'complete' : 'in-progress';
    state.finishedAt = new Date().toISOString();
    nma.writeState(state.__file, state);

    const headline = allSucceeded
        ? 'Version published: v' + version
        : anySucceeded
            ? 'PARTIAL: v' + version + ' reached one store and not the other'
            : 'NOT PUBLISHED: v' + version + ' reached no store';

    const summary = [
        headline,
        'Chrome:  ' + (storeResults.chrome ? (storeResults.chrome.state || 'unknown') : 'not targeted') + '  ' + nma.CHROME_LISTING,
        'Firefox: ' + (storeResults.firefox ? (storeResults.firefox.state || 'unknown') : 'not targeted') + '  ' + nma.AMO_LISTING,
        'Dashboards: ' + nma.CHROME_DASHBOARD + ' and ' + nma.AMO_DASHBOARD,
        'Nexus:   NOT UPDATED BY THIS SCRIPT  ' + nma.NEXUS_LISTING,
        'Nexus is not a manual paste: run Publish-Mod.ps1 -Mod . -Publish, which uploads the file and the '
        + 'changelog through the Nexus v3 API and pushes the rendered description. It packages the '
        + 'signed Firefox xpi, so it has to wait for AMO review to finish. '
            + 'confirm the AMO source archive is attached; confirm no new permission needs a Chrome privacy justification.'
    ];
    for (const line of summary) {
        nma.log(line);
    }

    nma.finish({
        script: 'release',
        ok: allSucceeded,
        target: targets.length === 2 ? 'both' : targets[0],
        version: version,
        action: 'publish',
        artifact: path.join(nma.ROOT, 'packages'),
        store: storeResults,
        state: allSucceeded ? 'published' : (anySucceeded ? 'partial' : 'failed'),
        url: nma.CHROME_DASHBOARD,
        errors: storeErrors,
        warnings: permissionWarnings,
        durationMs: Date.now() - started,
        nextStep: allSucceeded
            ? summary.join(' | ')
            : (anySucceeded ? 'PARTIAL RELEASE. ' : 'NOTHING WAS PUBLISHED. ') + summary.join(' | ') +
                ' Re-run: node scripts/release.js --resume --confirm PUBLISH. Completed stores are skipped and the version is not re-bumped.'
    }, allSucceeded ? nma.EXIT.OK : (anySucceeded ? nma.EXIT.PARTIAL : nma.EXIT.FAILED));
}

main().catch((err) => {
    if (nma.isFinished(err)) {
        return;
    }
    nma.errline(err.message);
    nma.finish({
        script: 'release',
        ok: false,
        state: 'failed',
        errors: [err.message],
        durationMs: Date.now() - started,
        nextStep: 'Run node scripts/store-status.js to confirm what, if anything, each store received, then re-run with --resume.'
    }, err.exitCode || nma.EXIT.FAILED);
});
