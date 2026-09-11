'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { ROOT } = require('./harness.js');
const fixtures = require('./fixtures.js');

/**
 * The rule the whole version pipeline was rebuilt around, written as a test.
 *
 * Every byte of version knowledge the extension uses has to be derivable at runtime, the
 * same way, by any installation on any machine. Two things follow, and both are checkable
 * from here: the extension ships no version data, and no code branches on which game it
 * is looking at. A per-game rule is knowledge that exists only because someone typed it,
 * and it is invisible to every user whose game nobody typed.
 */

const SOURCE_DIRS = ['src'];
const SOURCE_EXTENSIONS = /\.(ts|js|mjs|html|css|json)$/;

function sourceFiles() {
    const found = [];
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full);
            } else if (SOURCE_EXTENSIONS.test(entry.name)) {
                found.push(full);
            }
        }
    };
    for (const dir of SOURCE_DIRS) {
        const abs = path.join(ROOT, dir);
        if (fs.existsSync(abs)) walk(abs);
    }
    return found;
}

/**
 * Comment lines are excluded. A comment naming a game as an example of a shape is
 * documentation; a game name reached by the running code is a rule about one title. The
 * exclusion is by line, so a block comment whose continuation lines carry neither `*` nor
 * `//` would be scanned as code, which errs toward reporting rather than toward silence.
 */
function codeLines(file) {
    return fs.readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .map((text, index) => ({ line: index + 1, text }))
        .filter(({ text }) => {
            const trimmed = text.trim();
            return trimmed !== '' && !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*');
        });
}

/**
 * The words to hunt for are read out of the recorded catalog responses rather than
 * listed from memory, so the check grows with the fixtures instead of with anyone's
 * recollection of which games used to be special-cased.
 */
function forbiddenWords() {
    const words = new Set();
    const byName = fixtures.load('nexus-games-by-name.json');
    for (const response of Object.values(byName)) {
        for (const node of response.data.games.nodes) {
            words.add(String(node.domainName).toLowerCase());
            // A domain is how this codebase used to identify a game, so it is the
            // high-value token. Long words out of the display name catch the rest.
            // Seven characters is the floor because "mount" and "blade" are ordinary
            // words in a browser extension and would report a hit on every mounted panel.
            for (const token of String(node.name).toLowerCase().split(/[^a-z0-9]+/)) {
                if (token.length >= 7) words.add(token);
            }
        }
    }
    // The short titles the previous design named directly, and the publishers and script
    // extenders behind them. A rule keyed on a publisher is a rule about that publisher's
    // games and nothing else.
    for (const word of ['skyrim', 'fallout', 'cyberpunk', 'starfield', 'baldur', 'bannerlord', 'rimworld', 'bethesda', 'taleworlds', 'larian', 'projekt', 'ludeon', 'skse', 'f4se', 'sfse', 'warsails', 'war sails']) {
        words.add(word);
    }
    return Array.from(words);
}

test('the check has something to look at and something to look for', () => {
    // Both halves of a scan can fail silently. An empty file list or an empty word list
    // reports "clean" and means "did not look".
    assert.ok(sourceFiles().length >= 20, 'the source walk found almost nothing');
    assert.ok(forbiddenWords().length >= 10, 'the word list came out empty');
});

test('no shipped file names a game', () => {
    const words = forbiddenWords();
    const offenders = [];
    for (const file of sourceFiles()) {
        for (const { line, text } of codeLines(file)) {
            const lowered = text.toLowerCase();
            for (const word of words) {
                if (lowered.includes(word)) {
                    offenders.push(`${path.relative(ROOT, file)}:${line}: ${word}`);
                }
            }
        }
    }
    assert.deepEqual(offenders, []);
});

test('the extension ships no version database', () => {
    // The file is gone and nothing replaces it. A bundled list is knowledge that only
    // exists because it was typed on one machine, and it is stale the day after.
    for (const file of sourceFiles()) {
        assert.notEqual(path.basename(file).toLowerCase(), 'versions.json', `${file} is a shipped version list`);
    }
    assert.equal(fs.existsSync(path.join(ROOT, 'src/assets/database')), false);
});

test('nothing anywhere still reaches for the deleted database', () => {
    // A build step or a manifest entry that still copies a file nobody writes is a broken
    // build; a fetch of it at runtime is a silent empty list.
    const searched = [
        ...sourceFiles(),
        path.join(ROOT, 'webpack.config.js'),
        path.join(ROOT, 'manifests/chrome.json'),
        path.join(ROOT, 'manifests/firefox.json')
    ].filter(file => fs.existsSync(file));

    const offenders = [];
    for (const file of searched) {
        const text = fs.readFileSync(file, 'utf8');
        if (/versions\.json|database\//i.test(text)) offenders.push(path.relative(ROOT, file));
    }
    assert.deepEqual(offenders, []);
});

test('the version pipeline is reachable without a key and without a browser', () => {
    // Every endpoint the harvest reads answers unauthenticated, which is what makes the
    // result the same for every user. A source that needed the user's own API key would
    // give two installations two different lists for one game.
    const provenance = fixtures.provenance.sources;
    assert.ok(Object.keys(provenance).length >= 10);
    for (const [file, note] of Object.entries(provenance)) {
        assert.equal(typeof note, 'string');
        assert.ok(note.length > 20, `${file} has no usable provenance note`);
    }
    // The recorder is the derivation, and it is in the repository so anyone can re-run it.
    assert.ok(fs.existsSync(path.join(ROOT, 'tests/fixtures/record.js')));
});
