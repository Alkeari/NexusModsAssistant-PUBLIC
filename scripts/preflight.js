'use strict';

const fs = require('fs');
const path = require('path');
const nma = require('./lib/nma');
const stores = require('./lib/stores');

const started = Date.now();
nma.guard('preflight', started);

const args = nma.parseArgs(process.argv.slice(2));
const scope = args.scope === 'release' ? 'release' : 'local';
const phase = args.phase === 'pre-build' ? 'pre-build' : 'post-build';
const targets = String(args.targets || 'chrome,firefox').split(',').map((t) => t.trim()).filter(Boolean);
const expectVersion = args.version ? String(args.version) : null;
const offline = args.offline === true;

const failures = [];
const warnings = [];

function check(id, fn) {
    return Promise.resolve()
        .then(fn)
        .then((detail) => {
            nma.log('  PASS  ' + id + (detail ? ' - ' + detail : ''));
        })
        .catch((err) => {
            nma.errline('  FAIL  ' + id + ' - ' + err.message);
            failures.push(id + ': ' + err.message);
        });
}

function softCheck(id, fn) {
    return Promise.resolve()
        .then(fn)
        .then((detail) => {
            nma.log('  PASS  ' + id + (detail ? ' - ' + detail : ''));
        })
        .catch((err) => {
            nma.warn('  WARN  ' + id + ' - ' + err.message);
            warnings.push(id + ': ' + err.message);
        });
}

const SECRET_PATTERNS = [
    [/-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/, 'private key block'],
    [/"private_key"\s*:/, 'service account private_key field'],
    [/\buser:\d{3,}:\d+\b/, 'AMO JWT issuer'],
    [/\bAIza[0-9A-Za-z_\-]{35}\b/, 'Google API key'],
    [/\bya29\.[0-9A-Za-z_\-]{20,}/, 'Google access token'],
    [/\b1\/\/[0-9A-Za-z_\-]{30,}/, 'Google refresh token'],
    [/[a-z0-9-]+\.iam\.gserviceaccount\.com/, 'service account address'],
    // The backslashes are not optional decoration: the tracked .REFERENCE capture stores
    // its cookies as JSON inside a JSON string, so every quote arrives escaped as \".
    // A pattern that only matches bare quotes cannot see the one credential this
    // repository has actually leaked.
    [/(?:nexusmods_session|nexusmods_session_refresh|__cf_bm|sessionid|steamLoginSecure)\\?"?\s*:\s*\\?"[^"\\]{16,}/i, 'session cookie'],
    [/(?:secret|token|api[_-]?key)["'\s:=]{1,12}[0-9a-f]{64}\b/i, '64 hex characters next to a secret-ish name']
];

// The single tracked file in this repo that has ever contained a credential is an .html
// capture. An allowlist that omits .html cannot see it.
const SCANNABLE = /\.(ts|js|mjs|cjs|json|md|ps1|sh|yml|yaml|txt|html|htm|xml|csv|cfg|ini|env)$/i;

// No file in this repository is exempt from the credential scan.
const CREDENTIAL_DOC_ALLOWLIST = [];

function isAllowlisted(file) {
    return CREDENTIAL_DOC_ALLOWLIST.some((rule) => rule.test(file));
}

function scanTextForSecrets(label, text) {
    for (const [pattern, description] of SECRET_PATTERNS) {
        const match = text.match(pattern);
        if (match) {
            throw new Error(label + ' contains ' + description + ' near: ' + String(match[0]).slice(0, 24) + '...');
        }
    }
}

const CHUNK_BYTES = 4 * 1024 * 1024;
const CHUNK_OVERLAP = 4096;

// Large files are read in chunks rather than skipped. Skipping one for its size would
// turn "could not look" into a silent PASS, which is exactly the failure mode this whole
// check exists to prevent.
function scanFileForSecrets(label, file) {
    const size = fs.statSync(file).size;
    if (size <= CHUNK_BYTES) {
        scanTextForSecrets(label, fs.readFileSync(file, 'utf8'));
        return;
    }
    const handle = fs.openSync(file, 'r');
    try {
        const buffer = Buffer.alloc(CHUNK_BYTES + CHUNK_OVERLAP);
        let position = 0;
        while (position < size) {
            const read = fs.readSync(handle, buffer, 0, buffer.length, position);
            if (read <= 0) {
                break;
            }
            scanTextForSecrets(label, buffer.toString('utf8', 0, read));
            position += CHUNK_BYTES;
        }
    } finally {
        fs.closeSync(handle);
    }
}

function manifestComparableSubset(manifest) {
    const copy = JSON.parse(JSON.stringify(manifest));
    delete copy.name;
    delete copy.version;
    delete copy.version_name;
    delete copy.background;
    delete copy.browser_specific_settings;
    return copy;
}

async function run() {
    const version = expectVersion || nma.readJson(path.join(nma.ROOT, 'package.json')).version;
    nma.step('Preflight scope=' + scope + ' phase=' + phase + ' targets=' + targets.join(',') + ' version=' + version);

    await check('version.sync', async () => {
        const result = await nma.runNode(['scripts/version.js', 'check'], { capture: true });
        if (result.code !== 0) {
            throw new Error('version locations disagree. Run npm run version:sync. Detail:\n' +
                result.stdout.split(/\r?\n/).filter((line) => line.startsWith('[nma]')).join('\n'));
        }
        return 'all five locations agree';
    });

    await check('version.valid', () => {
        if (!nma.parseVersion(version)) {
            throw new Error(version + ' is not 1-4 dot separated integers in 0-65535');
        }
        return version;
    });

    await check('typescript', async () => {
        const result = await nma.runBin('tsc', ['--noEmit'], { capture: true, timeoutMs: 300000 });
        if (result.code !== 0) {
            throw new Error('tsc --noEmit failed:\n' + (result.stdout + result.stderr).split(/\r?\n/).slice(0, 15).join('\n'));
        }
        return 'clean';
    });

    await check('manifests.agree', () => {
        const chrome = nma.readJson(path.join(nma.ROOT, 'manifests', 'chrome.json'));
        const firefox = nma.readJson(path.join(nma.ROOT, 'manifests', 'firefox.json'));
        if (JSON.stringify(manifestComparableSubset(chrome)) !== JSON.stringify(manifestComparableSubset(firefox))) {
            throw new Error('the two source manifests differ outside the allowed keys (name, version, version_name, background, browser_specific_settings). Diff them by hand.');
        }
        if (chrome.name.length > 75 || firefox.name.length > 75) {
            throw new Error('manifest name exceeds the 75 character store limit');
        }
        return 'permissions, host_permissions, content_scripts and web_accessible_resources identical';
    });

    await check('manifest.firefox.gates', () => {
        const firefox = nma.readJson(path.join(nma.ROOT, 'manifests', 'firefox.json'));
        const gecko = firefox.browser_specific_settings && firefox.browser_specific_settings.gecko;
        if (!gecko || gecko.id !== nma.AMO_ADDON_GUID) {
            throw new Error('gecko.id must be exactly ' + nma.AMO_ADDON_GUID + '. A mismatch creates a new add-on instead of updating the listing.');
        }
        if (!gecko.strict_min_version) {
            throw new Error('gecko.strict_min_version is missing');
        }
        const dcp = gecko.data_collection_permissions;
        if (!dcp || !Array.isArray(dcp.required) || dcp.required.length === 0) {
            throw new Error('data_collection_permissions.required is missing. Once adopted it must be retained in every version.');
        }
        if (dcp.required.includes('none') && dcp.required.length > 1) {
            throw new Error('data_collection_permissions.required may contain "none" only on its own');
        }
        if (Array.isArray(dcp.optional) && dcp.optional.includes('none')) {
            throw new Error('data_collection_permissions.optional may never contain "none"');
        }
        // The extension sends the user's Nexus Personal API Key on every api.nexusmods.com
        // request. "none" is a declaration the network traffic contradicts, which is a
        // human-review rejection reason on AMO.
        if (dcp.required.includes('none')) {
            throw new Error('data_collection_permissions.required is ["none"] while the extension transmits the user API key to api.nexusmods.com. Declare the real category (authenticationInfo) instead of a declaration a reviewer can disprove.');
        }
        if (!firefox.background || !Array.isArray(firefox.background.scripts)) {
            throw new Error('Firefox manifest needs background.scripts. Firefox does not support background.service_worker.');
        }
        return 'gecko id, min version, data collection and background shape all valid';
    });

    await check('manifest.chrome.gates', () => {
        const chrome = nma.readJson(path.join(nma.ROOT, 'manifests', 'chrome.json'));
        if (chrome.browser_specific_settings) {
            throw new Error('Chrome manifest must not carry browser_specific_settings');
        }
        if (!chrome.background || !chrome.background.service_worker) {
            throw new Error('Chrome manifest needs background.service_worker');
        }
        if ((chrome.host_permissions || []).some((host) => /localhost|127\.0\.0\.1/.test(host))) {
            throw new Error('a localhost host permission is present in the source manifest. That belongs only in the dev overlay.');
        }
        if (chrome.version_name) {
            throw new Error('version_name is set in the source manifest. Only the dev overlay may set it.');
        }
        return 'ok';
    });

    if (scope !== 'release') {
        return version;
    }

    await check('git.clean', async () => {
        if (args['allow-dirty'] === true) {
            return 'skipped by --allow-dirty';
        }
        const result = await nma.runGit(['status', '--porcelain']);
        const dirty = result.stdout.split(/\r?\n/).filter(Boolean);
        if (dirty.length) {
            throw new Error('working tree is dirty:\n    ' + dirty.join('\n    '));
        }
        return 'clean';
    });

    await check('git.no-tracked-ignored', async () => {
        const result = await nma.runGit(['ls-files', '-ci', '--exclude-standard']);
        const tracked = result.stdout.split(/\r?\n/).filter(Boolean);
        if (tracked.length) {
            throw new Error(tracked.length + ' files are tracked despite matching a .gitignore rule, so ignore rules are not protecting this repo:\n    ' + tracked.join('\n    ') + '\n    Fix once with: git rm -r --cached .idea ".REFERENCE"');
        }
        return 'none';
    });

    await check('git.no-secrets-tracked', async () => {
        const listed = await nma.runGit(['ls-files', '-z']);
        const files = listed.stdout.split('\0').filter(Boolean);
        const suspicious = files.filter((file) =>
            !isAllowlisted(file) &&
            /(^|\/)\.env|\.pem$|\.p12$|service-account.*\.json$|nma-publish/i.test(file));
        if (suspicious.length) {
            throw new Error('credential shaped files are tracked: ' + suspicious.join(', '));
        }
        let scanned = 0;
        let skipped = 0;
        let allowlisted = 0;
        for (const file of files) {
            if (isAllowlisted(file)) {
                allowlisted++;
                continue;
            }
            if (!SCANNABLE.test(file)) {
                skipped++;
                continue;
            }
            scanFileForSecrets(file, path.join(nma.ROOT, file));
            scanned++;
        }
        // Read off the allowlist itself rather than restated beside it, so the count and the
        // paths cannot drift apart and an empty allowlist reports itself honestly.
        const covered = CREDENTIAL_DOC_ALLOWLIST.length
            ? ' allowlisted (' + CREDENTIAL_DOC_ALLOWLIST.map((rule) => rule.source).join(', ') +
                ', none of which ships in any artifact)'
            : ' allowlisted';
        return scanned + ' tracked files scanned, ' + skipped + ' binary, ' + allowlisted + covered;
    });

    if (phase === 'post-build') {
        for (const target of targets) {
            const zipPath = path.join(nma.ROOT, 'packages', 'nexus-mods-assistant-' + target + '-v' + version + '.zip');

            await check('package.' + target + '.exists', () => {
                if (!fs.existsSync(zipPath)) {
                    throw new Error('missing ' + zipPath + '. Run npm run build:' + target);
                }
                return (fs.statSync(zipPath).size / 1024).toFixed(0) + ' KB';
            });

            if (!fs.existsSync(zipPath)) {
                continue;
            }

            await check('package.' + target + '.manifest-at-root', () => {
                const entries = nma.zipEntries(zipPath);
                if (!entries.includes('manifest.json')) {
                    throw new Error('manifest.json is not at the zip root. Both stores reject this.');
                }
                const forbidden = entries.filter((entry) => /\.map$|(^|\/)\.env|\.pem$|service-account/i.test(entry));
                if (forbidden.length) {
                    throw new Error('forbidden entries in the package: ' + forbidden.join(', '));
                }
                return entries.length + ' entries';
            });

            // Every check below reads the zip, never dist-*. The zip is what the
            // store receives, and a later development build overwrites dist
            // without touching it.
            await check('package.' + target + '.version-matches', () => {
                const manifest = JSON.parse(nma.zipReadText(zipPath, 'manifest.json'));
                if (manifest.version !== version) {
                    throw new Error('packaged manifest is ' + manifest.version + ' but the release is ' + version);
                }
                if (manifest.version_name) {
                    throw new Error('packaged manifest carries version_name, which only the dev overlay sets. This is a development build.');
                }
                if (/\(Dev\)$/.test(manifest.name)) {
                    throw new Error('packaged manifest name ends with (Dev). This is a development build.');
                }
                return version;
            });

            await check('package.' + target + '.no-dev-artifacts', () => {
                const manifest = JSON.parse(nma.zipReadText(zipPath, 'manifest.json'));
                if ((manifest.host_permissions || []).some((host) => /localhost|127\.0\.0\.1/.test(host))) {
                    throw new Error('packaged manifest carries a localhost host permission from the dev overlay');
                }
                for (const rel of nma.zipEntries(zipPath)) {
                    if (!/\.js$/.test(rel)) {
                        continue;
                    }
                    const text = nma.zipReadText(zipPath, rel);
                    if (text.includes('sourceMappingURL')) {
                        throw new Error(rel + ' references a source map');
                    }
                    if (text.includes('NMA_DEV_RELOAD')) {
                        throw new Error(rel + ' contains the dev reloader');
                    }
                    if (/127\.0\.0\.1|localhost/.test(text)) {
                        throw new Error(rel + ' references a local host');
                    }
                    if (/\beval\(/.test(text)) {
                        throw new Error(rel + ' contains eval(), which MV3 CSP blocks');
                    }
                }
                return 'no maps, no reloader, no localhost, no eval';
            });

            await check('package.' + target + '.no-secrets', () => {
                for (const rel of nma.zipEntries(zipPath)) {
                    if (!/\.(js|json|html|css)$/i.test(rel)) {
                        continue;
                    }
                    scanTextForSecrets(rel, nma.zipReadText(zipPath, rel));
                }
                return 'clean';
            });

            await check('package.' + target + '.size', () => {
                const limitMb = target === 'firefox' ? 200 : 2048;
                const sizeMb = fs.statSync(zipPath).size / 1024 / 1024;
                if (sizeMb > limitMb) {
                    throw new Error(sizeMb.toFixed(1) + ' MB exceeds the ' + limitMb + ' MB store limit');
                }
                return sizeMb.toFixed(2) + ' MB';
            });
        }

        if (targets.includes('firefox')) {
            await check('firefox.addons-linter', async () => {
                const result = await nma.runBin('web-ext',
                    ['lint', '--source-dir', 'dist-firefox', '--no-input', '--no-config-discovery'],
                    { capture: true, timeoutMs: 300000 });
                if (result.code !== 0) {
                    throw new Error('web-ext lint reported errors:\n' + (result.stdout + result.stderr).split(/\r?\n/).slice(-25).join('\n'));
                }
                return 'no errors';
            });

            await check('firefox.source-archive', () => {
                const sourcePath = path.join(nma.ROOT, 'packages', 'nexus-mods-assistant-source-v' + version + '.zip');
                if (!fs.existsSync(sourcePath)) {
                    throw new Error('missing ' + sourcePath + '. AMO requires a source archive for a webpack build. Run npm run package:source');
                }
                const entries = nma.zipEntries(sourcePath);
                const required = ['package.json', 'package-lock.json', 'webpack.config.js', 'tsconfig.json'];
                const missing = required.filter((file) => !entries.includes(file));
                if (missing.length) {
                    throw new Error('source archive is missing: ' + missing.join(', '));
                }
                // Deliberately spelled out here rather than imported from package-source.js:
                // a denylist that both builds and verifies the archive can only agree with
                // itself, and .REFERENCE reaching a Mozilla reviewer is the failure this
                // exists to make impossible.
                const leaked = entries.filter((entry) =>
                    /^node_modules\/|^dist-|^packages\/|(^|\/)\.env|^\.[^/]+\/|\.pem$|\.p12$|service-account.*\.json$|nma-publish/i.test(entry));
                if (leaked.length) {
                    throw new Error('source archive contains files it must not: ' + leaked.slice(0, 8).join(', '));
                }
                if (!entries.some((entry) => entry.startsWith('src/'))) {
                    throw new Error('source archive has no src/ files');
                }
                return entries.length + ' files, no denylisted path present';
            });
        }
    }

    if (offline) {
        nma.warn('Store version comparison and the clock skew check were both skipped because --offline was passed.');
        warnings.push('store version comparison and clock skew check skipped by --offline, so nothing store-side was verified');
        return version;
    }

    if (targets.includes('firefox')) {
        await softCheck('clock-skew', async () => {
            const res = await nma.fetchWithRetry('https://addons.mozilla.org/api/v5/', { method: 'HEAD' }, 0);
            const header = res.headers.get('date');
            if (!header) {
                throw new Error('server sent no Date header, cannot check skew');
            }
            const skew = Math.abs(Date.parse(header) - Date.now());
            if (skew > 60000) {
                throw new Error('local clock is ' + Math.round(skew / 1000) + 's off AMO. The AMO JWT lives 4 minutes and will be rejected.');
            }
            return Math.round(skew / 1000) + 's skew';
        });
    }

    const creds = nma.loadCredentials();

    if (targets.includes('chrome')) {
        await check('chrome.version-greater', async () => {
            const token = await stores.chromeToken(creds);
            const status = await stores.chromeFetchStatus(creds, token);
            stores.assertRevisionReadable(status);
            const published = stores.revisionVersion(status.publishedItemRevisionStatus);
            const submittedState = stores.revisionState(status.submittedItemRevisionStatus);
            if (submittedState === 'PENDING_REVIEW') {
                throw new Error('a submission is already pending review. Uploading is blocked until it is reviewed or canceled.');
            }
            // A revision object that exists but yields no version means the field names in
            // revisionVersion() are wrong, not that nothing is published. Passing on that
            // would report "could not look" as "nothing in the way".
            if (status.publishedItemRevisionStatus && !published) {
                throw new Error('the store returned a published revision whose version field I cannot read:\n' +
                    JSON.stringify(status.publishedItemRevisionStatus) +
                    '\nAdd the observed field name to revisionVersion() in scripts/lib/stores.js.');
            }
            if (published && nma.compareVersions(version, published) <= 0) {
                throw new Error(version + ' is not greater than the published ' + published);
            }
            return published
                ? 'published ' + published + ' < ' + version
                : 'nothing published yet, ' + version + ' would be the first';
        });
    }

    if (targets.includes('firefox')) {
        await check('amo.version-greater', async () => {
            const guid = stores.amoAddonGuid(creds);
            const addon = await stores.amoRequest(creds, 'GET', stores.amoAddonPath(guid) + '/');
            const listed = addon.json && addon.json.current_version && addon.json.current_version.version;
            if (listed && nma.compareVersions(version, listed) <= 0) {
                throw new Error(version + ' is not greater than the listed ' + listed);
            }
            return listed
                ? 'listed ' + listed + ' < ' + version
                : 'AMO reports no current_version, so nothing was there to compare against';
        });
    }

    return version;
}

// A passing run may only claim what its scope actually looked at. Local scope never reads
// git state, packages or either store, and --offline reads neither store.
function passedNextStep() {
    if (scope !== 'release') {
        return 'Local checks passed. This scope did not look at git state, the packaged zips or either store. Run node scripts/preflight.js --scope release before publishing.';
    }
    if (offline) {
        return 'Every offline check passed. Neither store was contacted because --offline was passed, so no store-side version was compared.';
    }
    return 'Safe to publish.';
}

run().then((version) => {
    const ok = failures.length === 0;
    nma.log(ok ? 'Preflight passed' : 'Preflight FAILED with ' + failures.length + ' problem(s)');
    nma.finish({
        script: 'preflight',
        ok: ok,
        target: targets.length === 2 ? 'both' : targets[0],
        version: version,
        action: 'check',
        state: ok ? 'preflight-ok' : 'preflight-failed',
        errors: failures,
        warnings: warnings,
        durationMs: Date.now() - started,
        nextStep: ok ? passedNextStep() : 'Fix every FAIL above. Do not bypass preflight.'
    }, ok ? nma.EXIT.OK : nma.EXIT.PREFLIGHT);
}).catch((err) => {
    if (nma.isFinished(err)) {
        return;
    }
    nma.errline(err.message);
    nma.finish({
        script: 'preflight',
        ok: false,
        state: 'crashed',
        errors: [err.message].concat(failures),
        warnings: warnings,
        durationMs: Date.now() - started
    }, err.exitCode || nma.EXIT.FAILED);
});
