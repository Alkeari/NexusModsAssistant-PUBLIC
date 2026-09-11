'use strict';

/**
 * Builds the two archives uploaded to the Nexus Mods listing, one per browser,
 * matching the two file series on the mod page:
 *
 *   Nexus Mods Assistant (Firefox)  the Mozilla signed .xpi, which installs by
 *                                   itself. Wrapped in a zip because Nexus does
 *                                   not accept a bare .xpi.
 *   Nexus Mods Assistant (Chrome)   the unpacked extension, ready for Load
 *                                   unpacked. Chrome refuses to install an
 *                                   extension from outside the Web Store in any
 *                                   format, so this cannot be an installer and
 *                                   the enclosed instructions say so.
 *
 * The Chrome archive holds the extension files at its root rather than a nested
 * zip, so unzipping it produces exactly the folder Chrome expects. Every nested
 * layer is a step a user can get wrong.
 *
 * The signed xpi only exists once AMO has reviewed and signed the version, so
 * this refuses rather than shipping an unsigned file that Firefox will reject.
 */

const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const nma = require('./lib/nma');
const stores = require('./lib/stores');

const started = Date.now();
nma.guard('package-nexus', started);

const args = nma.parseArgs(process.argv.slice(2));
const version = args.version ? String(args.version) : nma.readJson(path.join(nma.ROOT, 'package.json')).version;
const OUT_DIR = path.join(nma.ROOT, 'packages');
const STAGE = path.join(OUT_DIR, 'nexus-bundle');

const CHROME_OUT = path.join(OUT_DIR, 'Nexus Mods Assistant (Chrome) ' + version + '.zip');
const FIREFOX_OUT = path.join(OUT_DIR, 'Nexus Mods Assistant (Firefox) ' + version + '.zip');

const CHROME_STORE = 'https://chromewebstore.google.com/detail/hflkcljgifgjdlpgibmldlpkpjhjdddf';
const AMO_LISTING = 'https://addons.mozilla.org/en-US/firefox/addon/nexus-mods-assistant/';

// Nexus accepts up to 20GB. These should each be a fraction of a megabyte, so a
// wild number means something went wrong rather than that the limit is near.
const SANITY_LIMIT_BYTES = 25 * 1024 * 1024;

function firefoxInstallText(xpiName) {
    return [
        'Nexus Mods Assistant ' + version + ' for Firefox',
        '',
        '  ' + xpiName,
        '',
        'That file is signed by Mozilla and installs on its own.',
        '',
        'To install it:',
        '  1. Unzip this archive.',
        '  2. Drag the .xpi onto an open Firefox window.',
        '',
        'Or, from the Firefox menu: Add-ons and themes, the gear icon, Install Add-on From File.',
        '',
        'Installing from addons.mozilla.org instead is recommended, because you get automatic',
        'updates and this copy will not update itself:',
        '  ' + AMO_LISTING,
        '',
        'This file exists so you have a copy that does not depend on the store being reachable.',
        '',
        'Firefox 140 or newer is required.',
        '',
        'Alkeari Labs LLC. This is an independent project and is not an official Nexus Mods product.',
        ''
    ].join('\n');
}

function chromeInstallText() {
    return [
        'Nexus Mods Assistant ' + version + ' for Chrome, Edge and other Chromium browsers',
        '',
        'READ THIS FIRST: this is not an installer.',
        '',
        'Chrome blocks extension installs from outside the Web Store. No file in any format gets',
        'around that, including .crx and .exe. Anything telling you otherwise is out of date.',
        '',
        '',
        'THE EASY WAY, and the one you probably want',
        '',
        '  Install from the Chrome Web Store. You get automatic updates and no warnings:',
        '  ' + CHROME_STORE,
        '',
        '',
        'THE MANUAL WAY, using the files in this archive',
        '',
        '  1. Unzip this archive to somewhere permanent. If you delete or move the folder later,',
        '     the extension stops working.',
        '  2. Open chrome://extensions',
        '  3. Turn on Developer mode, top right.',
        '  4. Click Load unpacked.',
        '  5. Select the folder you unzipped, the one containing manifest.json.',
        '',
        '  Two things to expect if you do it this way: it will not update itself, and Chrome will',
        '  ask you about developer mode extensions every time it starts.',
        '',
        '',
        'WHAT THIS EXTENSION DOES',
        '',
        '  It reads what mod authors wrote about game versions and puts a compatibility verdict on',
        '  each mod tile as you browse Nexus Mods, along with what that verdict was based on.',
        '',
        'Alkeari Labs LLC. This is an independent project and is not an official Nexus Mods product.',
        ''
    ].join('\n');
}

function zipDirectory(sourceDir, outPath) {
    return new Promise((resolve, reject) => {
        const output = fs.createWriteStream(outPath);
        const archive = archiver('zip', { zlib: { level: 9 } });
        output.on('close', resolve);
        archive.on('error', reject);
        archive.pipe(output);
        archive.directory(sourceDir, false);
        archive.finalize();
    });
}

function report(label, outPath) {
    const size = fs.statSync(outPath).size;
    if (size > SANITY_LIMIT_BYTES) {
        throw Object.assign(new Error(path.basename(outPath) + ' is ' + size + ' bytes, far larger than expected.'), {
            exitCode: nma.EXIT.PREFLIGHT
        });
    }
    const entries = nma.zipEntries(outPath);
    nma.log('  ' + label + ': ' + path.basename(outPath));
    nma.log('    ' + entries.length + ' entries, ' + (size / 1024).toFixed(0) + ' KB');
    return entries;
}

async function main() {
    const distChrome = path.join(nma.ROOT, 'dist-chrome');
    if (!fs.existsSync(path.join(distChrome, 'manifest.json'))) {
        throw Object.assign(new Error('dist-chrome is missing or incomplete. Run npm run build:chrome first.'), {
            exitCode: nma.EXIT.PREFLIGHT
        });
    }

    // dist-chrome is a development build whenever scripts/local.js ran last, and
    // shipping that would put the dev name and the reload client on a mod page.
    const distManifest = nma.readJson(path.join(distChrome, 'manifest.json'));
    if (distManifest.version_name || /\(Dev\)$/.test(distManifest.name || '')) {
        throw Object.assign(new Error(
            'dist-chrome holds a development build (' + (distManifest.version_name || distManifest.name) + '). '
            + 'Run npm run build:chrome to produce a release build before packaging.'
        ), { exitCode: nma.EXIT.PREFLIGHT });
    }
    if (distManifest.version !== version) {
        throw Object.assign(new Error('dist-chrome is version ' + distManifest.version + ', expected ' + version + '.'), {
            exitCode: nma.EXIT.PREFLIGHT
        });
    }

    nma.log('---- Nexus upload files for v' + version);

    nma.step('Locating the Mozilla signed build');
    const creds = nma.loadCredentials();
    const guid = stores.amoAddonGuid(creds);
    const res = await stores.amoRequest(creds, 'GET', '/addons/addon/' + encodeURIComponent(guid) + '/versions/?filter=all_with_unlisted', {});
    const match = ((res.json || {}).results || []).find(v => v.version === version);
    if (!match) {
        throw Object.assign(new Error('AMO has no version ' + version + '. Publish it and let it be signed first.'), {
            exitCode: nma.EXIT.PREFLIGHT
        });
    }
    const file = match.file || (match.files || [])[0];
    if (!file || !file.url) {
        throw Object.assign(new Error('AMO returned no file URL for ' + version + '.'), { exitCode: nma.EXIT.FAILED });
    }
    if (file.status !== 'public') {
        throw Object.assign(new Error(
            'AMO reports version ' + version + ' as "' + file.status + '", not public. It is not signed yet, and an '
            + 'unsigned xpi will not install in Firefox. Wait for review to finish.'
        ), { exitCode: nma.EXIT.PREFLIGHT });
    }

    fs.rmSync(STAGE, { recursive: true, force: true });
    const firefoxStage = path.join(STAGE, 'firefox');
    const chromeStage = path.join(STAGE, 'chrome');
    fs.mkdirSync(firefoxStage, { recursive: true });
    fs.mkdirSync(chromeStage, { recursive: true });

    const xpiName = 'nexus-mods-assistant-' + version + '.xpi';
    const xpiPath = path.join(firefoxStage, xpiName);
    nma.step('Downloading the signed ' + xpiName);
    const download = await nma.fetchWithRetry(file.url, {}, 2);
    if (!download.ok) {
        throw Object.assign(new Error('Downloading the signed xpi failed: ' + download.status), { exitCode: nma.EXIT.NETWORK });
    }
    fs.writeFileSync(xpiPath, Buffer.from(await download.arrayBuffer()));

    // Prove it is signed and is the right version, rather than trusting the URL.
    if (!nma.zipEntries(xpiPath).includes('META-INF/mozilla.rsa')) {
        throw Object.assign(new Error('The downloaded xpi carries no Mozilla signature. Refusing to ship it.'), {
            exitCode: nma.EXIT.PREFLIGHT
        });
    }
    const xpiManifest = JSON.parse(nma.zipReadText(xpiPath, 'manifest.json'));
    if (xpiManifest.version !== version) {
        throw Object.assign(new Error('The signed xpi is version ' + xpiManifest.version + ', expected ' + version + '.'), {
            exitCode: nma.EXIT.PREFLIGHT
        });
    }
    nma.log('  signed: yes, manifest version ' + xpiManifest.version);
    fs.writeFileSync(path.join(firefoxStage, 'INSTALL.txt'), firefoxInstallText(xpiName), 'utf8');

    nma.step('Staging the Chrome files');
    for (const rel of nma.walkFiles(distChrome)) {
        const dest = path.join(chromeStage, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(path.join(distChrome, rel), dest);
    }
    fs.writeFileSync(path.join(chromeStage, 'INSTALL.txt'), chromeInstallText(), 'utf8');

    nma.step('Writing the archives');
    fs.rmSync(FIREFOX_OUT, { force: true });
    fs.rmSync(CHROME_OUT, { force: true });
    await zipDirectory(firefoxStage, FIREFOX_OUT);
    await zipDirectory(chromeStage, CHROME_OUT);

    const firefoxEntries = report('Firefox', FIREFOX_OUT);
    const chromeEntries = report('Chrome', CHROME_OUT);

    if (!chromeEntries.includes('manifest.json')) {
        throw Object.assign(new Error('The Chrome archive has no manifest.json at its root, so Load unpacked would fail.'), {
            exitCode: nma.EXIT.PREFLIGHT
        });
    }

    nma.finish({
        script: 'package-nexus', ok: true, target: 'nexus', version, action: 'package',
        artifact: OUT_DIR, changed: [path.basename(FIREFOX_OUT), path.basename(CHROME_OUT)],
        store: null, state: 'packaged', url: nma.NEXUS_LISTING,
        durationMs: Date.now() - started,
        warnings: [], errors: [],
        nextStep: 'Upload both to ' + nma.NEXUS_LISTING + ' as two file series, "Nexus Mods Assistant (Chrome)" and '
            + '"Nexus Mods Assistant (Firefox)". Mod Publisher uploads both through the Nexus v3 API: Publish-Mod.ps1 -Mod . -Publish.'
    });
}

main().catch(err => {
    nma.finish({
        script: 'package-nexus', ok: false, target: 'nexus', version: null, action: 'package',
        artifact: null, changed: [], store: null, state: 'failed', url: null,
        durationMs: Date.now() - started, warnings: [], errors: [err && err.message ? err.message : String(err)],
        nextStep: 'Fix the error above and run again.'
    }, (err && err.exitCode) || nma.EXIT.FAILED);
});
