'use strict';

/**
 * Proves the publishing credentials work, without ever printing one.
 *
 * Every value is reported as present or absent and, where the shape is
 * checkable, as well-formed or not. A secret is never echoed, never logged and
 * never written to the result line, so this command is safe to run anywhere and
 * safe to paste the output of.
 *
 * It ends by authenticating against both stores read-only, because a
 * well-formed credential and a working one are different things.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const nma = require('./lib/nma');
const stores = require('./lib/stores');

const started = Date.now();
nma.guard('creds-check', started);

const checks = [];
let hardFailures = 0;

function record(name, ok, detail, fatal = true) {
    checks.push({ name, ok, detail });
    if (ok) {
        nma.log('  PASS  ' + name + ' - ' + detail);
    } else if (fatal) {
        hardFailures += 1;
        nma.errline('  FAIL  ' + name + ' - ' + detail);
    } else {
        nma.warn('  WARN  ' + name + ' - ' + detail);
    }
}

// Length and shape only. The value itself never leaves this process.
function describe(value) {
    if (!value) return 'absent';
    return 'present, ' + String(value).length + ' characters';
}

async function main() {
    const creds = nma.loadCredentials();
    const file = nma.credentialsPath();

    nma.log('---- Credential check');
    nma.log('Reading ' + file);
    nma.log('No secret is printed by this command.');
    nma.log('');

    record('file.exists', creds.__exists,
        creds.__exists ? 'found' : 'not found. Copy docs/credentials.template.txt to ' + file);

    if (creds.__exists) {
        try {
            const mode = fs.statSync(file).mode & 0o777;
            // Windows does not model POSIX bits meaningfully, so this is advisory.
            record('file.permissions', true, 'mode ' + mode.toString(8) + ' (advisory on Windows)', false);
        } catch (err) {
            record('file.permissions', false, 'could not stat: ' + err.message, false);
        }
        if (file.startsWith(nma.ROOT)) {
            record('file.outside-repo', false, 'the credential file is INSIDE the repository. Move it to ' + os.homedir());
        } else {
            record('file.outside-repo', true, 'outside the working tree, where git cannot reach it');
        }
    }

    nma.log('');
    nma.log('---- Chrome Web Store');

    const hasServiceAccount = !!(creds.CHROME_SERVICE_ACCOUNT_CLIENT_EMAIL && creds.CHROME_SERVICE_ACCOUNT_PRIVATE_KEY);
    const hasOauth = !!(creds.CHROME_CLIENT_ID && creds.CHROME_CLIENT_SECRET && creds.CHROME_REFRESH_TOKEN);

    record('chrome.extension-id', !!creds.CHROME_EXTENSION_ID, describe(creds.CHROME_EXTENSION_ID) + ' (public, not a secret)');
    record('chrome.publisher-id', !!creds.CHROME_PUBLISHER_ID, describe(creds.CHROME_PUBLISHER_ID));
    record('chrome.auth-method', hasServiceAccount || hasOauth,
        hasServiceAccount ? 'service account (preferred: no consent screen, no token expiry)'
            : hasOauth ? 'OAuth refresh token (works, but expires; a service account does not)'
                : 'neither a service account nor an OAuth trio is set');

    if (hasServiceAccount) {
        record('chrome.client-email', /@.+\.iam\.gserviceaccount\.com$/.test(creds.CHROME_SERVICE_ACCOUNT_CLIENT_EMAIL),
            'expects an address ending .iam.gserviceaccount.com');
        const key = creds.CHROME_SERVICE_ACCOUNT_PRIVATE_KEY || '';
        // Parse it rather than pattern-match it. A PEM carrying a stray quote
        // looks correct to any shape check and fails inside OpenSSL with a
        // message that names nothing the reader can act on.
        let keyDetail = describe(key);
        let keyOk = false;
        if (!key) {
            keyDetail = 'absent';
        } else if (key.includes('\\n')) {
            keyDetail = 'the literal characters backslash-n are still in the value. Wrap it in double quotes so the loader expands them.';
        } else {
            try {
                crypto.createPrivateKey(key);
                keyOk = true;
                keyDetail = describe(key) + ', parses as a private key';
            } catch (err) {
                const stray = /["']/.test(key);
                keyDetail = stray
                    ? 'a quote character is inside the value. The template ships an empty pair of quotes for this field, so pasting an already-quoted value leaves one behind. Delete the extra quote.'
                    : 'does not parse as a private key: ' + (err.message || String(err));
            }
        }
        record('chrome.private-key', keyOk, keyDetail);
    }

    nma.log('');
    nma.log('---- addons.mozilla.org');
    record('amo.addon-guid', !!creds.AMO_ADDON_GUID, describe(creds.AMO_ADDON_GUID) + ' (public, not a secret)');
    record('amo.issuer', /^user:\d+:\d+$/.test(creds.AMO_JWT_ISSUER || ''),
        creds.AMO_JWT_ISSUER ? 'expects the form user:NNNNNN:NN' : 'absent');
    record('amo.secret', !!creds.AMO_JWT_SECRET, describe(creds.AMO_JWT_SECRET));

    // A well-formed credential and a working one are different things.
    nma.log('');
    nma.log('---- Live authentication (read only, nothing is uploaded)');

    if (hasServiceAccount || hasOauth) {
        try {
            const token = await stores.chromeToken(creds);
            record('chrome.authenticates', !!token, 'Google returned an access token');
            if (token && creds.CHROME_PUBLISHER_ID && creds.CHROME_EXTENSION_ID) {
                try {
                    const name = await stores.chromeItemName(creds);
                    record('chrome.item-readable', true, 'the publisher can see item ' + creds.CHROME_EXTENSION_ID + (name ? ' (' + name + ')' : ''));
                } catch (err) {
                    record('chrome.item-readable', false,
                        'authenticated, but could not read the item. The usual cause is that the service account has not been added as a user on the publisher account. ' + (err.message || ''));
                }
            }
        } catch (err) {
            record('chrome.authenticates', false, err.message || String(err));
        }
    } else {
        record('chrome.authenticates', false, 'skipped, no Chrome credentials to try');
    }

    if (creds.AMO_JWT_ISSUER && creds.AMO_JWT_SECRET) {
        try {
            const guid = stores.amoAddonGuid(creds);
            const versions = await stores.amoListVersions(creds, guid);
            record('amo.authenticates', true, 'read ' + (Array.isArray(versions) ? versions.length : 0) + ' existing versions for ' + guid);
        } catch (err) {
            const hint = /401/.test(String(err.message)) ? ' A 401 here is usually a wrong system clock: the JWT lives four minutes.' : '';
            record('amo.authenticates', false, (err.message || String(err)) + hint);
        }
    } else {
        record('amo.authenticates', false, 'skipped, no AMO credentials to try');
    }

    const ok = hardFailures === 0;
    nma.log('');
    nma.log(ok ? 'Credentials are complete and both stores answered.' : 'Credential check FAILED with ' + hardFailures + ' problem(s).');

    nma.finish({
        script: 'creds-check',
        ok,
        target: 'both',
        version: null,
        action: 'check',
        artifact: null,
        changed: [],
        store: null,
        state: ok ? 'credentials-ok' : 'credentials-incomplete',
        url: null,
        durationMs: Date.now() - started,
        warnings: checks.filter(c => !c.ok).map(c => c.name),
        errors: ok ? [] : checks.filter(c => !c.ok).map(c => c.name + ': ' + c.detail),
        nextStep: ok
            ? 'Run node scripts/release.js --dry-run for a full rehearsal that touches neither store.'
            : 'Fix each FAIL above. See docs/credentials.template.txt for where each value comes from.'
    }, ok ? nma.EXIT.OK : nma.EXIT.CREDENTIALS);
}

main().catch(err => {
    nma.finish({
        script: 'creds-check',
        ok: false,
        target: 'both',
        version: null,
        action: 'check',
        artifact: null,
        changed: [],
        store: null,
        state: 'failed',
        url: null,
        durationMs: Date.now() - started,
        warnings: [],
        errors: [err && err.message ? err.message : String(err)],
        nextStep: 'Fix the error above, then run node scripts/creds-check.js again.'
    }, (err && err.exitCode) || nma.EXIT.FAILED);
});
