'use strict';

const fs = require('fs');
const crypto = require('crypto');
const nma = require('./nma');

const CWS_BASE = 'https://chromewebstore.googleapis.com';
const AMO_BASE = 'https://addons.mozilla.org/api/v5';
const CWS_SCOPE = 'https://www.googleapis.com/auth/chromewebstore';

function b64url(value) {
    return Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
}

async function chromeToken(creds) {
    if (creds.CHROME_SERVICE_ACCOUNT_CLIENT_EMAIL && creds.CHROME_SERVICE_ACCOUNT_PRIVATE_KEY) {
        const now = Math.floor(Date.now() / 1000);
        const unsigned = b64url({ alg: 'RS256', typ: 'JWT' }) + '.' + b64url({
            iss: creds.CHROME_SERVICE_ACCOUNT_CLIENT_EMAIL,
            scope: CWS_SCOPE,
            aud: 'https://oauth2.googleapis.com/token',
            iat: now,
            exp: now + 3600
        });
        const signer = crypto.createSign('RSA-SHA256');
        signer.update(unsigned);
        const assertion = unsigned + '.' + signer.sign(creds.CHROME_SERVICE_ACCOUNT_PRIVATE_KEY).toString('base64url');
        const res = await nma.fetchWithRetry('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
                assertion: assertion
            })
        });
        const body = await nma.readBody(res);
        if (!res.ok || !body.json || !body.json.access_token) {
            throw Object.assign(new Error('Chrome service account token request failed: ' + res.status + ' ' + body.text), {
                exitCode: nma.EXIT.CREDENTIALS
            });
        }
        return body.json.access_token;
    }

    // Naming only the fallback trio here reads as "these are what Chrome needs",
    // which sends the reader to build the wrong thing. Say which path is preferred.
    if (!creds.CHROME_CLIENT_ID && !creds.CHROME_CLIENT_SECRET && !creds.CHROME_REFRESH_TOKEN) {
        throw Object.assign(new Error(
            'No Chrome credentials. Preferred: set CHROME_SERVICE_ACCOUNT_CLIENT_EMAIL and '
            + 'CHROME_SERVICE_ACCOUNT_PRIVATE_KEY (a service account has no consent screen and no token expiry). '
            + 'Fallback: CHROME_CLIENT_ID, CHROME_CLIENT_SECRET and CHROME_REFRESH_TOKEN. '
            + 'Either way CHROME_PUBLISHER_ID is also required. See docs/credentials.template.txt.'
        ), { exitCode: nma.EXIT.CREDENTIALS });
    }

    nma.requireCreds(creds, ['CHROME_CLIENT_ID', 'CHROME_CLIENT_SECRET', 'CHROME_REFRESH_TOKEN']);
    nma.warn('Using the OAuth refresh token path. A refresh token dies after 7 days if the consent screen is still in Testing, and after 6 months unused. A service account has neither failure mode.');
    const res = await nma.fetchWithRetry('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: creds.CHROME_CLIENT_ID,
            client_secret: creds.CHROME_CLIENT_SECRET,
            refresh_token: creds.CHROME_REFRESH_TOKEN
        })
    });
    const body = await nma.readBody(res);
    if (!res.ok || !body.json || !body.json.access_token) {
        throw Object.assign(new Error('Chrome refresh token exchange failed: ' + res.status + ' ' + body.text), {
            exitCode: nma.EXIT.CREDENTIALS
        });
    }
    return body.json.access_token;
}

function chromeItemName(creds) {
    nma.requireCreds(creds, ['CHROME_PUBLISHER_ID']);
    const itemId = creds.CHROME_EXTENSION_ID || nma.CHROME_ITEM_ID;
    return 'publishers/' + creds.CHROME_PUBLISHER_ID + '/items/' + itemId;
}

async function chromeFetchStatus(creds, token) {
    const url = CWS_BASE + '/v2/' + chromeItemName(creds) + ':fetchStatus';
    const res = await nma.fetchWithRetry(url, { headers: { Authorization: 'Bearer ' + token } });
    const body = await nma.readBody(res);
    if (!res.ok) {
        throw Object.assign(new Error('Chrome fetchStatus failed: ' + res.status + ' ' + body.text), {
            exitCode: res.status === 401 || res.status === 403 ? nma.EXIT.CREDENTIALS : nma.EXIT.FAILED
        });
    }
    return body.json || {};
}

// UNVERIFIED: Google does not publish the ItemRevisionStatus field layout. These are
// candidate key names. Run scripts/store-status.js once and add the observed key here
// before the first publish. Callers must treat null as "unreadable", never as "clear".
function revisionState(revision) {
    if (!revision || typeof revision !== 'object') {
        return null;
    }
    for (const key of ['state', 'itemState', 'status', 'reviewState']) {
        if (typeof revision[key] === 'string') {
            return revision[key];
        }
    }
    return null;
}

function revisionVersion(revision) {
    if (!revision || typeof revision !== 'object') {
        return null;
    }
    for (const key of ['version', 'crxVersion', 'itemVersion']) {
        if (typeof revision[key] === 'string') {
            return revision[key];
        }
    }
    // Where the version actually lives on a published item: the v2 API reports it
    // per distribution channel, not on the revision. Reading only the top level
    // reported null for an item that is plainly published, which reads as "could
    // not look" when the answer was one level down.
    const channels = revision.distributionChannels;
    if (Array.isArray(channels)) {
        for (const channel of channels) {
            if (channel && typeof channel.crxVersion === 'string') {
                return channel.crxVersion;
            }
            if (channel && typeof channel.version === 'string') {
                return channel.version;
            }
        }
    }
    return null;
}

// An unreadable submitted revision means the pending-review lockout and the idempotence
// check both lose their input. Publishing on unknown information is irreversible, so this
// is fatal rather than permissive.
function assertRevisionReadable(status) {
    if (status.submittedItemRevisionStatus && revisionState(status.submittedItemRevisionStatus) === null) {
        throw Object.assign(new Error(
            'The store returned a submitted revision I cannot interpret:\n' +
            JSON.stringify(status.submittedItemRevisionStatus, null, 2) +
            '\nRefusing to continue, because I cannot tell whether a review is pending. ' +
            'Add the observed field name to revisionState() in scripts/lib/stores.js.'),
            { exitCode: nma.EXIT.STORE_BUSY });
    }
}

async function chromeUpload(creds, token, zipPath) {
    const url = CWS_BASE + '/upload/v2/' + chromeItemName(creds) + ':upload';
    const res = await nma.fetchWithRetry(url, {
        method: 'POST',
        headers: {
            Authorization: 'Bearer ' + token,
            'X-Goog-Upload-Protocol': 'raw',
            'X-Goog-Upload-File-Name': 'extension.zip'
        },
        body: fs.readFileSync(zipPath)
    }, 0);
    const body = await nma.readBody(res);
    if (!res.ok) {
        throw Object.assign(new Error('Chrome upload failed: ' + res.status + ' ' + body.text), {
            exitCode: res.status === 409 || /review/i.test(body.text) ? nma.EXIT.STORE_BUSY : nma.EXIT.FAILED,
            responseText: body.text,
            status: res.status
        });
    }
    return body.json || {};
}

async function chromePublish(creds, token, options) {
    const url = CWS_BASE + '/v2/' + chromeItemName(creds) + ':publish';
    const payload = { publishType: options.publishType || 'DEFAULT_PUBLISH' };
    if (options.deployPercentage) {
        payload.deployInfos = [{ deployPercentage: Number(options.deployPercentage) }];
    }
    const res = await nma.fetchWithRetry(url, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    }, 0);
    const body = await nma.readBody(res);
    if (!res.ok) {
        throw Object.assign(new Error('Chrome publish failed: ' + res.status + ' ' + body.text), {
            exitCode: nma.EXIT.FAILED,
            responseText: body.text
        });
    }
    return body.json || {};
}

async function chromeCancelSubmission(creds, token) {
    const url = CWS_BASE + '/v2/' + chromeItemName(creds) + ':cancelSubmission';
    const res = await nma.fetchWithRetry(url, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token }
    }, 0);
    const body = await nma.readBody(res);
    if (!res.ok) {
        throw new Error('Chrome cancelSubmission failed: ' + res.status + ' ' + body.text);
    }
    return true;
}

function amoToken(creds) {
    nma.requireCreds(creds, ['AMO_JWT_ISSUER', 'AMO_JWT_SECRET']);
    const now = Math.floor(Date.now() / 1000);
    const unsigned = b64url({ alg: 'HS256', typ: 'JWT' }) + '.' + b64url({
        iss: creds.AMO_JWT_ISSUER,
        jti: crypto.randomUUID(),
        iat: now,
        exp: now + 240
    });
    const sig = crypto.createHmac('sha256', creds.AMO_JWT_SECRET).update(unsigned).digest('base64url');
    return unsigned + '.' + sig;
}

async function amoRequest(creds, method, endpoint, options) {
    const opts = options || {};
    const headers = Object.assign({ Authorization: 'JWT ' + amoToken(creds) }, opts.headers || {});
    const res = await nma.fetchWithRetry(AMO_BASE + endpoint, {
        method: method,
        headers: headers,
        body: opts.body
    }, opts.retries === undefined ? 2 : opts.retries);
    const body = await nma.readBody(res);
    if (!res.ok && !opts.allowError) {
        const code = res.status === 401 || res.status === 403 ? nma.EXIT.CREDENTIALS : nma.EXIT.FAILED;
        throw Object.assign(new Error('AMO ' + method + ' ' + endpoint + ' failed: ' + res.status + ' ' + body.text), {
            exitCode: code,
            status: res.status,
            responseText: body.text
        });
    }
    return { status: res.status, ok: res.ok, json: body.json, text: body.text };
}

function amoAddonGuid(creds) {
    return creds.AMO_ADDON_GUID || nma.AMO_ADDON_GUID;
}

// UNVERIFIED: whether the percent-encoded '@' is accepted in the addon_guid path segment.
// scripts/store-status.js exercises this. If it 404s, drop the encoding here.
function amoAddonPath(guid) {
    return '/addons/addon/' + encodeURIComponent(guid);
}

// Documented filter values are all_without_unlisted, all_with_unlisted, all_with_deleted.
// The default view shows only public versions, which excludes a version submitted minutes
// ago, so it cannot be used for an existence check.
async function amoListVersions(creds, guid) {
    const res = await amoRequest(creds, 'GET', amoAddonPath(guid) + '/versions/?filter=all_with_unlisted');
    if (!res.json || !Array.isArray(res.json.results)) {
        throw Object.assign(
            new Error('Could not read the AMO version list. Refusing to act on an unreadable version list, because "found nothing" and "could not look" mean opposite things here. Check ' + nma.AMO_DASHBOARD),
            { exitCode: nma.EXIT.NETWORK });
    }
    return res.json.results.slice().sort((a, b) => (b.id || 0) - (a.id || 0));
}

module.exports = {
    CWS_BASE,
    AMO_BASE,
    chromeToken,
    chromeItemName,
    chromeFetchStatus,
    chromeUpload,
    chromePublish,
    chromeCancelSubmission,
    revisionState,
    revisionVersion,
    assertRevisionReadable,
    amoToken,
    amoRequest,
    amoAddonGuid,
    amoAddonPath,
    amoListVersions
};
