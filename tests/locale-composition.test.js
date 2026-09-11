'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..');
const LOCALES = path.join(ROOT, 'src', '_locales');

// A catalog entry that is a bare noun phrase ("The changelog", "A file version") is passed into
// another catalog entry as $source$, where it becomes the subject of a translated sentence. That
// reads correctly in all sixteen languages today only because every language defines both halves
// and every translator wrote an agreeing subject. Neither is a property of the design, so this
// suite pins the part a change can silently break: coverage. A missing label in one language puts
// an English subject inside a translated sentence, and nothing else would report it.

const read = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const languages = fs.readdirSync(LOCALES).filter((d) => fs.statSync(path.join(LOCALES, d)).isDirectory());
const english = read(path.join('src', '_locales', 'en', 'messages.json'));

const source = fs.readFileSync(path.join(ROOT, 'src', 'background', 'background.ts'), 'utf8');
const badges = fs.readFileSync(path.join(ROOT, 'src', 'content', 'badges.ts'), 'utf8');

// Every catalog key that is filled into another catalog entry, read from the maps that do it.
function keysInMap(text, name) {
    const block = text.match(new RegExp(`const ${name}[^=]*=\\s*{([^}]*)}`, 's'));
    if (!block) return [];
    return [...block[1].matchAll(/'([a-zA-Z_]+)'/g)].map((m) => m[1]);
}

const filledIn = [
    ...keysInMap(source, 'SOURCE_LABEL'),
    ...keysInMap(badges, 'EVIDENCE_KEYS'),
    ...keysInMap(badges, 'CONFIDENCE_KEYS'),
];

const frames = [
    'background_verdictStatedInRange',
    'background_verdictMentionedInRange',
    'background_verdictStatedOutOfRange',
    'background_verdictMentionedOutOfRange',
    'content_tooltipEvidence',
    'content_tooltipConfidence',
];

test('the maps that fill a sentence still name catalog keys', () => {
    assert.ok(filledIn.length >= 6, `expected the source, evidence and confidence maps to name keys, got ${filledIn.length}`);
    for (const key of filledIn) {
        assert.ok(key in english, `${key} is filled into a sentence but is not in the English catalog`);
    }
});

test('every frame that takes a filled fragment exists in English', () => {
    for (const key of frames) {
        assert.ok(key in english, `${key} is missing from the English catalog`);
    }
});

test('every language defines both halves, so no English subject lands in a translated sentence', () => {
    for (const lang of languages) {
        const catalog = read(path.join('src', '_locales', lang, 'messages.json'));
        for (const key of [...filledIn, ...frames]) {
            assert.ok(key in catalog, `${lang} is missing ${key}, which would mix languages inside one sentence`);
        }
    }
});

test('every language is complete, since a fallback is only invisible while nothing is missing', () => {
    for (const lang of languages) {
        const catalog = read(path.join('src', '_locales', lang, 'messages.json'));
        const missing = Object.keys(english).filter((k) => !(k in catalog));
        assert.deepEqual(missing, [], `${lang} is missing ${missing.length} key(s), first: ${missing.slice(0, 3).join(', ')}`);
    }
});
