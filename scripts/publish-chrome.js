'use strict';

const fs = require('fs');
const path = require('path');
const nma = require('./lib/nma');
const stores = require('./lib/stores');

const started = Date.now();
nma.guard('publish-chrome', started);

const args = nma.parseArgs(process.argv.slice(2));
const dryRun = args['dry-run'] === true;

async function main() {
    const version = args.version
        ? String(args.version)
        : nma.readJson(path.join(nma.ROOT, 'package.json')).version;
    const zipPath = args.zip
        ? path.resolve(nma.ROOT, String(args.zip))
        : path.join(nma.ROOT, 'packages', 'nexus-mods-assistant-chrome-v' + version + '.zip');

    if (!dryRun && args.confirm !== 'PUBLISH') {
        throw Object.assign(
            new Error('Refusing to publish without --confirm PUBLISH. Add --dry-run to check without publishing.'),
            { exitCode: nma.EXIT.REFUSED }
        );
    }
    if (!dryRun && !fs.existsSync(zipPath)) {
        throw new Error('Package not found: ' + zipPath + '. Run npm run build:chrome first.');
    }

    const creds = nma.loadCredentials();
    nma.step('Authenticating with the Chrome Web Store');
    const token = await stores.chromeToken(creds);

    nma.step('Reading current item status');
    const status = await stores.chromeFetchStatus(creds, token);
    stores.assertRevisionReadable(status);
    const submittedState = stores.revisionState(status.submittedItemRevisionStatus);
    const publishedVersion = stores.revisionVersion(status.publishedItemRevisionStatus);
    const submittedVersion = stores.revisionVersion(status.submittedItemRevisionStatus);

    nma.log('  published: ' + (publishedVersion || 'unknown'));
    nma.log('  submitted: ' + (submittedVersion || 'none') + ' state=' + (submittedState || 'none'));
    if (status.takenDown) {
        nma.warn('The store reports this item as taken down.');
    }

    if (publishedVersion && nma.compareVersions(version, publishedVersion) <= 0) {
        throw Object.assign(
            new Error('Version ' + version + ' is not greater than the published ' + publishedVersion + '. The store will reject it.'),
            { exitCode: nma.EXIT.PREFLIGHT }
        );
    }

    if (submittedVersion === version) {
        nma.log('Version ' + version + ' is already submitted. Nothing to upload.');
        nma.finish({
            script: 'publish-chrome',
            ok: true,
            target: 'chrome',
            version: version,
            action: 'publish',
            artifact: zipPath,
            store: { chrome: status },
            state: submittedState === 'PENDING_REVIEW' ? 'pending-review' : String(submittedState || 'submitted'),
            url: nma.CHROME_DASHBOARD,
            durationMs: Date.now() - started,
            nextStep: 'Already submitted. Check the dashboard for review progress.'
        }, nma.EXIT.OK);
    }

    if (submittedState === 'PENDING_REVIEW') {
        if (args['cancel-pending'] !== true || args['confirm-cancel'] !== 'CANCEL') {
            throw Object.assign(
                new Error('A submission (' + (submittedVersion || 'unknown version') + ') is already pending review. Uploading is blocked. To replace it, re-run with --cancel-pending --confirm-cancel CANCEL. Canceling forfeits your place in the review queue.'),
                { exitCode: nma.EXIT.STORE_BUSY }
            );
        }
        if (dryRun) {
            nma.log('DRY RUN: would cancel the pending submission');
        } else {
            nma.step('Canceling the pending submission');
            await stores.chromeCancelSubmission(creds, token);
        }
    }

    if (dryRun) {
        nma.log('DRY RUN: would upload ' + zipPath + ' and publish as ' + (args['publish-type'] || 'DEFAULT_PUBLISH'));
        nma.finish({
            script: 'publish-chrome',
            ok: true,
            target: 'chrome',
            version: version,
            action: 'dry-run',
            artifact: zipPath,
            store: { chrome: status },
            state: 'dry-run-ok',
            url: nma.CHROME_DASHBOARD,
            durationMs: Date.now() - started,
            nextStep: 'Auth, item status and version comparison all passed. Nothing was uploaded to the Chrome Web Store.'
        }, nma.EXIT.OK);
    }

    nma.step('Uploading package (' + (fs.statSync(zipPath).size / 1024).toFixed(0) + ' KB)');
    let upload = await stores.chromeUpload(creds, token, zipPath);
    nma.log('  uploadState=' + upload.uploadState + ' crxVersion=' + (upload.crxVersion || 'pending'));

    if (upload.uploadState === 'IN_PROGRESS' || upload.uploadState === 'UPLOAD_STATE_UNSPECIFIED') {
        const deadline = Date.now() + 300000;
        for (;;) {
            await nma.sleep(5000);
            const polled = await stores.chromeFetchStatus(creds, token);
            const state = polled.lastAsyncUploadState;
            nma.log('  processing... lastAsyncUploadState=' + state);
            if (state === 'SUCCEEDED') {
                upload = Object.assign({}, upload, { uploadState: 'SUCCEEDED' });
                break;
            }
            if (state === 'FAILED') {
                throw new Error('Upload processing failed on the store side. Not publishing. Check ' + nma.CHROME_DASHBOARD);
            }
            if (Date.now() > deadline) {
                throw Object.assign(
                    new Error('Upload processing did not finish within 5 minutes. The upload may still complete. Run node scripts/store-status.js before retrying.'),
                    { exitCode: nma.EXIT.NETWORK }
                );
            }
        }
    }

    if (upload.uploadState === 'FAILED') {
        throw new Error('Upload rejected: ' + JSON.stringify(upload));
    }
    if (upload.crxVersion && upload.crxVersion !== version) {
        throw new Error('The store read version ' + upload.crxVersion + ' from the package but this release is ' + version + '. Aborting before publish.');
    }

    nma.step('Publishing');
    const published = await stores.chromePublish(creds, token, {
        publishType: args['publish-type'] || 'DEFAULT_PUBLISH',
        deployPercentage: args['deploy-percentage']
    });
    nma.log('  state=' + (published.state || 'unknown'));

    const warnings = [];
    if (published.warningInfo && Object.keys(published.warningInfo).length) {
        warnings.push('Store returned warnings: ' + JSON.stringify(published.warningInfo));
        nma.warn(warnings[0]);
    }

    nma.finish({
        script: 'publish-chrome',
        ok: true,
        target: 'chrome',
        version: version,
        action: 'publish',
        artifact: zipPath,
        store: { chrome: { upload: upload, publish: published } },
        state: published.state === 'PENDING_REVIEW' ? 'pending-review'
            : published.state === 'STAGED' ? 'staged'
                : String(published.state || 'submitted'),
        url: nma.CHROME_DASHBOARD,
        warnings: warnings,
        durationMs: Date.now() - started,
        nextStep: 'Submitted for review. Chrome review is typically a few days and can be a few weeks. The live version is unchanged until it is approved.'
    }, nma.EXIT.OK);
}

main().catch((err) => {
    if (nma.isFinished(err)) {
        return;
    }
    nma.errline(err.message);
    nma.finish({
        script: 'publish-chrome',
        ok: false,
        target: 'chrome',
        state: err.exitCode === nma.EXIT.STORE_BUSY ? 'pending-review' : 'failed',
        errors: [err.message],
        url: nma.CHROME_DASHBOARD,
        durationMs: Date.now() - started,
        nextStep: 'Run node scripts/store-status.js to see exactly what the store thinks happened before retrying.'
    }, err.exitCode || nma.EXIT.FAILED);
});
