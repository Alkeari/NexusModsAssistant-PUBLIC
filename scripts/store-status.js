'use strict';

const fs = require('fs');
const path = require('path');
const nma = require('./lib/nma');
const stores = require('./lib/stores');

const started = Date.now();
nma.guard('store-status', started);

// publish/chromestore.json and publish/amo.json exist so the workspace dashboard can track what
// each store actually carries, the same way publish/nexus.json tracks the Nexus page. They carry
// "publishedBy": "project", so Mod Publisher reads them and uploads nothing. Only a store read that
// succeeded rewrites its file: overwriting a known version with null after a network failure would
// turn "could not look" into "nothing is published".
function recordStoreVersions(result) {
    const written = [];
    const record = (name, fields) => {
        const file = path.join(nma.ROOT, 'publish', name);
        if (!fs.existsSync(file)) {
            return;
        }
        const config = nma.readJson(file);
        const next = Object.assign({}, config, fields);
        if (JSON.stringify(next) === JSON.stringify(config)) {
            return;
        }
        nma.writeJson(file, next);
        written.push(name);
    };
    if (result.chrome) {
        record('chromestore.json', {
            publishedVersion: result.chrome.published || null,
            submittedVersion: result.chrome.submitted && result.chrome.submitted !== result.chrome.published
                ? result.chrome.submitted
                : null
        });
    }
    if (result.amo) {
        record('amo.json', {
            slug: result.amo.slug || null,
            publishedVersion: result.amo.listed || null,
            submittedVersion: result.amo.latestSubmitted && result.amo.latestSubmitted !== result.amo.listed
                ? result.amo.latestSubmitted
                : null
        });
    }
    return written;
}

async function main() {
    const version = nma.readJson(path.join(nma.ROOT, 'package.json')).version;
    const creds = nma.loadCredentials();
    const result = { chrome: null, amo: null };
    const errors = [];
    let worstExit = nma.EXIT.OK;

    try {
        const token = await stores.chromeToken(creds);
        const status = await stores.chromeFetchStatus(creds, token);
        result.chrome = {
            published: stores.revisionVersion(status.publishedItemRevisionStatus),
            publishedState: stores.revisionState(status.publishedItemRevisionStatus),
            submitted: stores.revisionVersion(status.submittedItemRevisionStatus),
            submittedState: stores.revisionState(status.submittedItemRevisionStatus),
            lastAsyncUploadState: status.lastAsyncUploadState || null,
            takenDown: Boolean(status.takenDown),
            warned: Boolean(status.warned),
            raw: status
        };
        nma.log('Chrome  published=' + result.chrome.published + ' submitted=' + result.chrome.submitted + ' (' + result.chrome.submittedState + ')');
        if (status.submittedItemRevisionStatus && result.chrome.submittedState === null) {
            nma.warn('Could not read the submitted revision state. Raw object follows; add its state field name to revisionState() in scripts/lib/stores.js.');
            nma.warn(JSON.stringify(status.submittedItemRevisionStatus));
        }
    } catch (err) {
        errors.push('chrome: ' + err.message);
        worstExit = err.exitCode || nma.EXIT.NETWORK;
        nma.warn('Chrome status unavailable: ' + err.message);
    }

    try {
        const guid = stores.amoAddonGuid(creds);
        const addon = await stores.amoRequest(creds, 'GET', stores.amoAddonPath(guid) + '/');
        const versions = await stores.amoListVersions(creds, guid);
        const latest = versions[0];
        result.amo = {
            slug: addon.json && addon.json.slug,
            listed: addon.json && addon.json.current_version && addon.json.current_version.version,
            latestSubmitted: latest ? latest.version : null,
            latestFileStatus: latest && latest.file ? latest.file.status : null,
            status: addon.json && addon.json.status
        };
        nma.log('AMO     listed=' + result.amo.listed + ' latest=' + result.amo.latestSubmitted + ' (' + result.amo.latestFileStatus + ')');
    } catch (err) {
        errors.push('amo: ' + err.message);
        if (worstExit === nma.EXIT.OK || err.exitCode === nma.EXIT.CREDENTIALS) {
            worstExit = err.exitCode || nma.EXIT.NETWORK;
        }
        nma.warn('AMO status unavailable: ' + err.message);
    }

    const recorded = recordStoreVersions(result);
    if (recorded.length) {
        nma.log('Recorded the live store versions in publish/' + recorded.join(' and publish/'));
    }

    const chromeBehind = result.chrome && result.chrome.published && nma.compareVersions(version, result.chrome.published) > 0;
    const amoBehind = result.amo && result.amo.listed && nma.compareVersions(version, result.amo.listed) > 0;

    nma.finish({
        script: 'store-status',
        ok: errors.length === 0,
        target: 'both',
        version: version,
        action: 'check',
        store: result,
        state: errors.length ? 'partial' : 'ok',
        url: nma.CHROME_DASHBOARD,
        errors: errors,
        durationMs: Date.now() - started,
        nextStep: errors.length
            ? 'At least one store could not be read. This is "could not look", not "nothing pending".'
            : ((chromeBehind || amoBehind)
                ? 'Local version ' + version + ' is ahead of at least one store. A release would ship it.'
                : 'Local version matches or trails both stores. Bump before releasing.')
    }, errors.length ? worstExit : nma.EXIT.OK);
}

main().catch((err) => {
    if (nma.isFinished(err)) {
        return;
    }
    nma.errline(err.message);
    nma.finish({
        script: 'store-status',
        ok: false,
        state: 'failed',
        errors: [err.message],
        durationMs: Date.now() - started
    }, err.exitCode || nma.EXIT.FAILED);
});
