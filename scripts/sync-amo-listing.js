'use strict';

/**
 * Pushes the AMO listing text to addons.mozilla.org.
 *
 * Both halves are rendered from README.md by Mod Publisher, so this script holds no copy of the
 * wording and cannot drift from the Nexus and Chrome versions of the same description.
 *
 * The Chrome Web Store has no API for listing metadata, so that half stays a manual paste of
 * out/listing/chromestore.txt.
 *
 * --dry-run prints what would be sent and touches nothing.
 */

const fs = require('fs');
const path = require('path');
const nma = require('./lib/nma');
const stores = require('./lib/stores');

const started = Date.now();
nma.guard('sync-amo-listing', started);

const args = nma.parseArgs(process.argv.slice(2));
const dryRun = !!args['dry-run'];
// Both come from README.md, rendered by Mod Publisher's render_listing.py: amo.md is the README in
// the Markdown subset AMO renders, and nexus-short.txt is the README's opening paragraph, which is
// also Nexus's Summary field. One source for all three stores, so they cannot drift apart again.
// Run render_listing.py against this folder first, or publish, which does.
const DESCRIPTION_FILE = path.join(nma.ROOT, 'out', 'listing', 'amo.md');
const SUMMARY_FILE = path.join(nma.ROOT, 'out', 'listing', 'nexus-short.txt');
const PRIVACY_URL = 'https://gist.github.com/Alkeari/7f1c44f095a696fec3cc64090e9e212e';

function assertNoDashes(label, value) {
    if (/[—–]/.test(value)) {
        throw Object.assign(new Error(label + ' contains an em or en dash, which this project does not use.'), {
            exitCode: nma.EXIT.PREFLIGHT
        });
    }
}

async function main() {
    for (const file of [DESCRIPTION_FILE, SUMMARY_FILE]) {
        if (!fs.existsSync(file)) {
            throw Object.assign(new Error(
                'Missing ' + file + '. Render the descriptions from README.md into out/listing first: '
                + 'run render_listing.py against this folder, or publish, which does.'
            ), { exitCode: nma.EXIT.PREFLIGHT });
        }
    }

    // Normalized to LF. Git checks this repository out with CRLF, and the paragraph handling below
    // matches on a bare newline: against CRLF the blank-line split never matched, so the whole
    // description once collapsed into a single 4300-character paragraph and shipped to AMO that way
    // (live on the listing, 2026-09-06). AMO stores blank lines faithfully; that one was ours.
    const description = fs.readFileSync(DESCRIPTION_FILE, 'utf8').replace(/\r\n/g, '\n').trim();

    // The summary is one line on the listing, so the rendered file's own wrapping has to collapse
    // or AMO stores the line breaks verbatim.
    const summary = fs.readFileSync(SUMMARY_FILE, 'utf8').replace(/\s*\n\s*/g, ' ').trim();

    assertNoDashes('The AMO summary', summary);
    assertNoDashes('The AMO description', description);

    // The tags were escaped and shown to users verbatim once. Refuse rather than
    // repeat it.
    // Named tags only, and never inside a code span: `nexusmods.com/games/<game>/mods` is a
    // placeholder the reader is meant to see, not markup, and the blanket /<[a-z]+>/ refused it.
    const outsideCode = description.replace(/`[^`]*`/g, '');
    if (/<\/?(?:a|b|i|em|strong|p|br|hr|ul|ol|li|div|span|code|pre|blockquote|h[1-6])\b[^>]*>/i.test(outsideCode)) {
        throw Object.assign(new Error('The AMO description contains an HTML tag. AMO escapes tags and shows them to users as text, so the description must be plain.'), {
            exitCode: nma.EXIT.PREFLIGHT
        });
    }

    if (summary.length > 250) {
        throw Object.assign(new Error('The AMO summary is ' + summary.length + ' characters, over the 250 limit.'), {
            exitCode: nma.EXIT.PREFLIGHT
        });
    }

    nma.log('---- AMO listing sync');
    nma.log('  summary     ' + summary.length + ' characters');
    nma.log('  description ' + description.length + ' characters');
    nma.log('  privacy     ' + PRIVACY_URL);

    const creds = nma.loadCredentials();
    const guid = stores.amoAddonGuid(creds);
    const endpoint = '/addons/addon/' + encodeURIComponent(guid) + '/';

    const before = await stores.amoRequest(creds, 'GET', endpoint, {});
    const beforeBody = before.json || {};
    const localised = (value) => (value && typeof value === 'object' ? (value['en-US'] || Object.values(value)[0]) : value);
    nma.log('  current description length ' + String(localised(beforeBody.description) || '').length);

    if (dryRun) {
        nma.log('');
        nma.log('DRY RUN. Nothing was sent. The description that would be written begins:');
        nma.log('  ' + description.slice(0, 120).replace(/\n/g, ' ') + '...');
        nma.finish({
            script: 'sync-amo-listing', ok: true, target: 'firefox', version: null, action: 'dry-run',
            artifact: null, changed: [], store: null, state: 'dry-run-ok', url: stores.AMO_LISTING || null,
            durationMs: Date.now() - started, warnings: [], errors: [],
            nextStep: 'Run without --dry-run to write the listing.'
        });
        return;
    }

    // Only these two fields are sent. A full object would overwrite categories,
    // support links and everything else the listing carries.
    //
    // privacy_policy is deliberately NOT sent. PATCHing it returns 200 and leaves
    // has_privacy_policy false, so the field is not writable here and sending it
    // would let this script report a change that did not happen.
    const payload = {
        summary: { 'en-US': summary },
        description: { 'en-US': description }
    };

    nma.step('Writing the listing');
    await stores.amoRequest(creds, 'PATCH', endpoint, {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });

    // Read back rather than trusting the write. A 200 on a PATCH does not prove
    // the field landed as intended.
    const after = await stores.amoRequest(creds, 'GET', endpoint, {});
    const afterBody = after.json || {};
    const writtenSummary = String(localised(afterBody.summary) || '');
    const writtenDescription = String(localised(afterBody.description) || '');

    const summaryOk = writtenSummary.trim() === summary;
    const descriptionOk = writtenDescription.length > 0;

    nma.log('  summary written     ' + (summaryOk ? 'yes' : 'MISMATCH'));
    nma.log('  description written ' + writtenDescription.length + ' characters');

    const hasPolicy = afterBody.has_privacy_policy === true;
    const policyNote = 'AMO privacy policy field: ' + (hasPolicy ? 'set' : 'NOT set, and it cannot be set from the API. Paste it in the AMO dashboard under Manage Listing.');
    if (hasPolicy) {
        nma.log('  ' + policyNote);
    } else {
        nma.warn('  ' + policyNote);
    }

    const ok = summaryOk && descriptionOk;
    nma.finish({
        script: 'sync-amo-listing', ok, target: 'firefox', version: null, action: 'update',
        artifact: null, changed: ['summary', 'description'], store: null,
        state: ok ? 'listing-synced' : 'listing-mismatch', url: nma.AMO_LISTING,
        durationMs: Date.now() - started, warnings: [], errors: ok ? [] : ['the listing did not read back as written'],
        nextStep: ok
            ? 'Firefox listing updated. The Chrome Web Store has no listing API, so paste the Chrome half from docs/STORE-LISTINGS.md by hand.'
            : 'Read the listing in the AMO dashboard and compare it against docs/STORE-LISTINGS.md.'
    }, ok ? nma.EXIT.OK : nma.EXIT.FAILED);
}

main().catch(err => {
    nma.finish({
        script: 'sync-amo-listing', ok: false, target: 'firefox', version: null, action: 'update',
        artifact: null, changed: [], store: null, state: 'failed', url: null,
        durationMs: Date.now() - started, warnings: [], errors: [err && err.message ? err.message : String(err)],
        nextStep: 'Fix the error above and run again.'
    }, (err && err.exitCode) || nma.EXIT.FAILED);
});
