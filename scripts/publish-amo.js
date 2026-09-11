'use strict';

const fs = require('fs');
const path = require('path');
const nma = require('./lib/nma');
const stores = require('./lib/stores');

const started = Date.now();
nma.guard('publish-amo', started);

const args = nma.parseArgs(process.argv.slice(2));
const dryRun = args['dry-run'] === true;

function readNotes() {
    const file = args['notes-file'] ? path.resolve(nma.ROOT, String(args['notes-file'])) : null;
    if (file && fs.existsSync(file)) {
        return fs.readFileSync(file, 'utf8').trim();
    }
    if (typeof args.notes === 'string') {
        return args.notes.split('\\n').join('\n');
    }
    return '';
}

function approvalNotes() {
    const firefox = nma.readJson(path.join(nma.ROOT, 'manifests', 'firefox.json'));
    const gecko = (firefox.browser_specific_settings && firefox.browser_specific_settings.gecko) || {};
    const dcp = (gecko.data_collection_permissions && gecko.data_collection_permissions.required) || [];
    return [
        'This extension is bundled from TypeScript with webpack and minified for release',
        '(optimization.minimize is true for --mode production in webpack.config.js). Nothing is',
        'obfuscated: minification is webpack terser at its defaults, so whitespace is removed and',
        'local names are shortened, and no control flow, string or logic is concealed. Complete',
        'source and package-lock.json are attached as the source archive.',
        '',
        'Build: npm ci, then npx cross-env BROWSER=firefox webpack --mode production.',
        'Reviewable output is dist-firefox/, which is the content of the submitted package.',
        '',
        'Data handling: the only data that leaves the browser is the user\'s own Nexus Mods',
        'Personal API Key, sent solely to api.nexusmods.com, the service that issued it, in',
        'order to perform the extension\'s single stated function. Nothing is sent to the',
        'developer or to any third party. The key is a credential, so',
        'data_collection_permissions declares required: ' + JSON.stringify(dcp) + '.',
        '',
        'store.steampowered.com, api.steampowered.com and api.steamcmd.net are contacted only',
        'to read public game version numbers, with no user data attached.'
    ].join('\n');
}

async function main() {
    const version = args.version
        ? String(args.version)
        : nma.readJson(path.join(nma.ROOT, 'package.json')).version;
    const zipPath = args.zip
        ? path.resolve(nma.ROOT, String(args.zip))
        : path.join(nma.ROOT, 'packages', 'nexus-mods-assistant-firefox-v' + version + '.zip');
    const sourcePath = args.source
        ? path.resolve(nma.ROOT, String(args.source))
        : path.join(nma.ROOT, 'packages', 'nexus-mods-assistant-source-v' + version + '.zip');

    if (!dryRun && args.confirm !== 'PUBLISH') {
        throw Object.assign(
            new Error('Refusing to publish without --confirm PUBLISH. Add --dry-run to check without publishing.'),
            { exitCode: nma.EXIT.REFUSED }
        );
    }
    if (!dryRun) {
        for (const file of [zipPath, sourcePath]) {
            if (!fs.existsSync(file)) {
                throw new Error('Missing artifact: ' + file + '. Run npm run build:firefox and npm run package:source.');
            }
        }
    }

    const creds = nma.loadCredentials();
    nma.requireCreds(creds, ['AMO_JWT_ISSUER', 'AMO_JWT_SECRET']);
    const guid = stores.amoAddonGuid(creds);

    nma.step('Reading current add-on state');
    const addon = await stores.amoRequest(creds, 'GET', stores.amoAddonPath(guid) + '/');
    const currentVersion = addon.json && addon.json.current_version && addon.json.current_version.version;
    nma.log('  listed version: ' + (currentVersion || 'unknown'));
    if (currentVersion && nma.compareVersions(version, currentVersion) <= 0) {
        throw Object.assign(
            new Error('Version ' + version + ' is not greater than the listed ' + currentVersion + '. AMO will reject it.'),
            { exitCode: nma.EXIT.PREFLIGHT }
        );
    }

    // An unreadable version list throws rather than returning null: "found nothing" and
    // "could not look" mean opposite things, and getting it wrong burns a version number.
    const allVersions = await stores.amoListVersions(creds, guid);
    const existing = allVersions.find((entry) => entry.version === version) || null;

    if (existing) {
        nma.log('Version ' + version + ' already exists on AMO (id ' + existing.id + '). Skipping upload.');
        const detail = await stores.amoRequest(creds, 'GET',
            stores.amoAddonPath(guid) + '/versions/' + existing.id + '/');
        const fileStatus = detail.json && detail.json.file && detail.json.file.status;
        nma.finish({
            script: 'publish-amo',
            ok: true,
            target: 'firefox',
            version: version,
            action: 'publish',
            artifact: zipPath,
            store: { amo: detail.json },
            state: fileStatus === 'public' ? 'published' : 'awaiting-validation',
            url: nma.AMO_DASHBOARD,
            warnings: (detail.json && detail.json.source) ? [] : ['This version has no source archive attached. AMO requires one for a webpack build.'],
            durationMs: Date.now() - started,
            nextStep: 'Already submitted. Confirm the source archive is attached at ' + nma.AMO_DASHBOARD
        }, nma.EXIT.OK);
    }

    if (dryRun) {
        nma.log('DRY RUN: would upload ' + zipPath + ' (listed channel) with source ' + sourcePath);
        nma.finish({
            script: 'publish-amo',
            ok: true,
            target: 'firefox',
            version: version,
            action: 'dry-run',
            artifact: zipPath,
            store: { amo: { current_version: currentVersion, versionCount: allVersions.length } },
            state: 'dry-run-ok',
            url: nma.AMO_DASHBOARD,
            durationMs: Date.now() - started,
            nextStep: 'Auth, add-on lookup and version comparison all passed. Nothing was uploaded to AMO.'
        }, nma.EXIT.OK);
    }

    nma.step('Uploading package to the listed channel');
    const uploadForm = new FormData();
    uploadForm.append('upload', new Blob([fs.readFileSync(zipPath)], { type: 'application/zip' }), path.basename(zipPath));
    uploadForm.append('channel', 'listed');
    const uploadRes = await stores.amoRequest(creds, 'POST', '/addons/upload/', { body: uploadForm, retries: 0 });
    const uuid = uploadRes.json && uploadRes.json.uuid;
    if (!uuid) {
        throw new Error('AMO upload returned no uuid: ' + uploadRes.text);
    }
    nma.log('  upload uuid ' + uuid);

    nma.step('Waiting for AMO validation');
    const deadline = Date.now() + 600000;
    let upload = uploadRes.json;
    for (;;) {
        await nma.sleep(5000);
        const polled = await stores.amoRequest(creds, 'GET', '/addons/upload/' + uuid + '/');
        upload = polled.json || {};
        nma.log('  processed=' + Boolean(upload.processed) + ' valid=' + Boolean(upload.valid));
        if (upload.processed) {
            break;
        }
        if (Date.now() > deadline) {
            throw Object.assign(
                new Error('AMO validation did not finish within 10 minutes. Upload uuid ' + uuid + ' still exists; no version was created, so this version number is not consumed.'),
                { exitCode: nma.EXIT.NETWORK }
            );
        }
    }
    if (!upload.valid) {
        const messages = (upload.validation && upload.validation.messages) || [];
        for (const message of messages.filter((m) => m.type === 'error').slice(0, 20)) {
            nma.errline(message.message + ' (' + (message.file || '') + ')');
        }
        throw Object.assign(new Error('AMO validation failed. No version was created and this version number is not consumed.'), {
            exitCode: nma.EXIT.PREFLIGHT
        });
    }

    nma.step('Creating the version with the source archive attached');
    const versionForm = new FormData();
    versionForm.append('upload', uuid);
    versionForm.append('source', new Blob([fs.readFileSync(sourcePath)], { type: 'application/zip' }), path.basename(sourcePath));
    const created = await stores.amoRequest(creds, 'POST',
        stores.amoAddonPath(guid) + '/versions/', { body: versionForm, retries: 0 });
    const versionId = created.json && created.json.id;
    if (!versionId) {
        throw new Error('AMO version create returned no id: ' + created.text);
    }
    nma.log('  version id ' + versionId);

    nma.step('Attaching release notes and reviewer notes');
    const notes = readNotes();
    const patchBody = { approval_notes: approvalNotes() };
    if (notes) {
        patchBody.release_notes = { 'en-US': notes };
    }
    // release_notes is an object, so it cannot travel in the same multipart request that
    // carried the source archive. This is a second call by necessity, not by choice.
    await stores.amoRequest(creds, 'PATCH',
        stores.amoAddonPath(guid) + '/versions/' + versionId + '/', {
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(patchBody),
            retries: 0
        });

    const detail = await stores.amoRequest(creds, 'GET',
        stores.amoAddonPath(guid) + '/versions/' + versionId + '/');
    const fileStatus = (detail.json && detail.json.file && detail.json.file.status) || 'unknown';
    const sourceAttached = Boolean(detail.json && detail.json.source);
    const warnings = [];
    if (!sourceAttached) {
        warnings.push('AMO did not report a source archive on this version. Attach it by hand at ' + nma.AMO_DASHBOARD + ' before a reviewer asks.');
        nma.warn(warnings[0]);
    }
    if (!notes) {
        warnings.push('No release notes were supplied, so the listing shows none for this version.');
    }

    nma.finish({
        script: 'publish-amo',
        ok: true,
        target: 'firefox',
        version: version,
        action: 'publish',
        artifact: zipPath,
        store: { amo: { versionId: versionId, fileStatus: fileStatus, source: sourceAttached } },
        state: fileStatus === 'public' ? 'published' : 'awaiting-validation',
        url: nma.AMO_DASHBOARD,
        warnings: warnings,
        durationMs: Date.now() - started,
        nextStep: 'Submitted to the listed channel. Signing and publication usually complete within 24 hours unless it is pulled for manual review.'
    }, nma.EXIT.OK);
}

main().catch((err) => {
    if (nma.isFinished(err)) {
        return;
    }
    nma.errline(err.message);
    nma.finish({
        script: 'publish-amo',
        ok: false,
        target: 'firefox',
        state: 'failed',
        errors: [err.message],
        url: nma.AMO_DASHBOARD,
        durationMs: Date.now() - started,
        nextStep: 'Run node scripts/store-status.js to see whether a version was actually created before retrying.'
    }, err.exitCode || nma.EXIT.FAILED);
});
