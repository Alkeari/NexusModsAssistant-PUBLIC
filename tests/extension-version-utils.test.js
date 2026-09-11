'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');

// The extension's version algebra is pure: no DOM, no chrome.*, no network. Node 25 strips
// TypeScript types natively, so these files import directly with no build step and no test
// dependency. If the module is moved, add the new path here rather than deleting the suite.
const CANDIDATES = [
    'src/background/versions.ts',
    'src/shared/version.ts',
    'src/shared/versions.ts',
    'src/core/version.ts',
    'src/core/versions.ts'
];

const found = CANDIDATES.find((rel) => fs.existsSync(path.join(ROOT, rel))) || null;

let mod = null;
let loadError = null;

test.before(async () => {
    if (!found) {
        return;
    }
    try {
        mod = await import(pathToFileURL(path.join(ROOT, found)).href);
    } catch (err) {
        loadError = err;
    }
});

function need(t, names) {
    if (!found) {
        t.skip('No pure version module found. Probed: ' + CANDIDATES.join(', ') +
            '. This is "could not look", not "passed".');
        return null;
    }
    if (loadError) {
        t.skip('Found ' + found + ' but could not import it: ' + loadError.message);
        return null;
    }
    const missing = names.filter((name) => typeof mod[name] !== 'function');
    if (missing.length) {
        t.skip(found + ' does not export ' + missing.join(', ') + ' yet.');
        return null;
    }
    return mod;
}

// Every version string below is real: taken off a Nexus Mods page or out of the defect
// dossier's stress list.

test('compareVersions orders four digit patches numerically', (t) => {
    const m = need(t, ['compareVersions']);
    if (!m) {
        return;
    }
    // Skyrim Special Edition. String comparison puts 1.6.640 above 1.6.1170.
    assert.equal(m.compareVersions('1.6.1170', '1.6.640'), 1);
    assert.equal(m.compareVersions('1.6.640', '1.6.1170'), -1);
    assert.equal(m.compareVersions('1.6.1170', '1.6.1170'), 0);
});

test('compareVersions orders a two digit minor above a one digit minor', (t) => {
    const m = need(t, ['compareVersions']);
    if (!m) {
        return;
    }
    assert.equal(m.compareVersions('1.10', '1.9'), 1);
    assert.equal(m.compareVersions('1.9', '1.10'), -1);
});

test('compareVersions ignores the leading v mod authors write', (t) => {
    const m = need(t, ['compareVersions']);
    if (!m) {
        return;
    }
    assert.equal(m.compareVersions('v2.0', '2.0'), 0);
    assert.equal(m.compareVersions('v2.1', '2.0'), 1);
});

test('compareVersions handles a four part Bannerlord build number', (t) => {
    const m = need(t, ['compareVersions']);
    if (!m) {
        return;
    }
    assert.equal(m.compareVersions('4.1.1.5849914', '4.1.1'), 1);
    assert.equal(m.compareVersions('4.1.1', '4.1.1.5849914'), -1);
});

test('compareVersions sorts a prerelease below its release', (t) => {
    const m = need(t, ['compareVersions']);
    if (!m) {
        return;
    }
    assert.equal(m.compareVersions('1.5.97-beta', '1.5.97'), -1);
    assert.equal(m.compareVersions('1.5.97', '1.5.97-beta'), 1);
});

test('compareVersions survives empty and null without throwing', (t) => {
    const m = need(t, ['compareVersions']);
    if (!m) {
        return;
    }
    // A thrown error here would abort a whole page of badges, so absent input must sort
    // below any real version rather than blow up.
    assert.equal(m.compareVersions(null, '1.0'), -1);
    assert.equal(m.compareVersions(undefined, '1.0'), -1);
    assert.equal(m.compareVersions('', '1.0'), -1);
    assert.equal(m.compareVersions('1.0', null), 1);
    assert.equal(m.compareVersions('', ''), 0);
});

test('parseVersion rejects text that only looks like a version', (t) => {
    const m = need(t, ['parseVersion']);
    if (!m) {
        return;
    }
    assert.equal(m.parseVersion(null), null);
    assert.equal(m.parseVersion(undefined), null);
    assert.equal(m.parseVersion(''), null);
    assert.equal(m.parseVersion('Install takes 1 to 5 minutes'), null);
});

test('parseVersion keeps the numbers and separates the prerelease tag', (t) => {
    const m = need(t, ['parseVersion']);
    if (!m) {
        return;
    }
    assert.deepEqual(m.parseVersion('v2.0').numbers, [2, 0]);
    assert.equal(m.parseVersion('v2.0').prerelease, null);

    const beta = m.parseVersion('1.5.97-beta');
    assert.deepEqual(beta.numbers, [1, 5, 97]);
    assert.equal(beta.prerelease, 'beta');

    assert.deepEqual(m.parseVersion('4.1.1.5849914').numbers, [4, 1, 1, 5849914]);
});

test('an empty known-version list means cannot judge, never everything passes', (t) => {
    const m = need(t, ['isKnownGameVersion']);
    if (!m) {
        return;
    }
    // Failing open here is what puts a confident green badge on a mod nothing was known
    // about.
    assert.equal(m.isKnownGameVersion('5.5', []), false);
    assert.equal(m.isKnownGameVersion('', ['1.2.11']), false);
    assert.equal(m.isKnownGameVersion('1.2.11', ['1.2.11', '1.0.3']), true);
});

test('a two part token stays open ended above a four digit patch', (t) => {
    const m = need(t, ['isCompatible']);
    if (!m) {
        return;
    }
    // The .999 sentinel defect: "1.6" read as at most 1.6.999 made identical mod text
    // COMPATIBLE at 1.6.640 and INCOMPATIBLE at 1.6.1170.
    assert.equal(m.isCompatible('1.6', '1.6.640', '1.6.640'), true);
    assert.equal(m.isCompatible('1.6', '1.6.1170', '1.6.1170'), true);
    assert.equal(m.isCompatible('1.6.1170', '1.6', '1.6'), true);
});

test('isCompatible respects the ends of the configured range', (t) => {
    const m = need(t, ['isCompatible']);
    if (!m) {
        return;
    }
    assert.equal(m.isCompatible('1.6.640', '1.5.0', '1.6.1170'), true);
    assert.equal(m.isCompatible('1.7', '1.5.0', '1.6.1170'), false);
});

test('a suffixed token does not widen the range it covers', (t) => {
    const m = need(t, ['versionRangeFromToken']);
    if (!m) {
        return;
    }
    const range = m.versionRangeFromToken('1.5.97-hotfix');
    assert.deepEqual(range.min, [1, 5, 97]);
    assert.deepEqual(range.max, [1, 5, 97]);
});
