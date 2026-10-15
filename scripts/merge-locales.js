'use strict';

/**
 * Builds `src/_locales/en/messages.json` from the per-surface fragments in
 * `src/_locales/en/parts/`, then checks every other locale against it.
 *
 * The fragments exist because the extraction was split by surface (popup, content, background) and
 * one shared catalog would have been three writers on one file. The merged file is generated, so it
 * is never hand-edited: change a fragment and rerun.
 *
 *   node scripts/merge-locales.js            merge, then report on every locale
 *   node scripts/merge-locales.js --check    report only, and exit 1 on any problem
 *
 * A locale is complete when it has every key the English catalog has, and no key it does not.
 * Chrome silently falls back to the default locale for a missing key, which is the failure that
 * ships: half a translated UI reads worse than an untranslated one, because the reader cannot tell
 * which half is authoritative.
 */

const fs = require('fs');
const path = require('path');
const nma = require('./lib/nma');

const started = Date.now();
nma.guard('merge-locales', started);

const args = nma.parseArgs(process.argv.slice(2));
const checkOnly = !!args.check;

const LOCALES = path.join(nma.ROOT, 'src', '_locales');
const PARTS = path.join(LOCALES, 'en', 'parts');
const EN = path.join(LOCALES, 'en', 'messages.json');
const SEED = path.join(LOCALES, 'en', 'seed.json');

// Chrome caps the store's short description at 132 characters and rejects a longer one at upload,
// so a translation that overruns it fails the release rather than the review.
const DESCRIPTION_LIMIT = 132;

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
}

function writeJson(file, value) {
    fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function mergeEnglish() {
    const merged = fs.existsSync(SEED) ? readJson(SEED) : {};
    const collisions = [];
    if (fs.existsSync(PARTS)) {
        for (const name of fs.readdirSync(PARTS).filter(f => f.endsWith('.json')).sort()) {
            const part = readJson(path.join(PARTS, name));
            for (const [key, entry] of Object.entries(part)) {
                if (key in merged && JSON.stringify(merged[key]) !== JSON.stringify(entry)) {
                    collisions.push(key + ' (' + name + ')');
                }
                merged[key] = entry;
            }
        }
    }
    return { merged, collisions };
}

function problemsFor(locale, english, table) {
    const problems = [];
    const englishKeys = Object.keys(english);
    const missing = englishKeys.filter(k => !(k in table));
    const extra = Object.keys(table).filter(k => !(k in english));
    if (missing.length) {
        problems.push(missing.length + ' missing: ' + missing.slice(0, 6).join(', ')
            + (missing.length > 6 ? ', ...' : ''));
    }
    if (extra.length) {
        problems.push(extra.length + ' not in English: ' + extra.slice(0, 6).join(', '));
    }
    for (const [key, entry] of Object.entries(table)) {
        if (!entry || typeof entry.message !== 'string' || !entry.message.trim()) {
            problems.push(key + ': empty message');
            continue;
        }
        // A placeholder that survives translation is what keeps a number or a name in the sentence.
        // Case-insensitive on purpose. Chrome matches $NAME$ against the placeholders object
        // without regard to case, and this catalog is mixed: the background surface writes
        // $seconds$ while the popup and content surfaces write $COUNT$. An exact-case test passed
        // the lowercase ones only because a placeholders block happened to exist, which would have
        // let a locale that inlined a lowercase token with no block through the audit.
        const wanted = Object.keys((english[key] || {}).placeholders || {});
        for (const name of wanted) {
            const token = new RegExp('\\$' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\$', 'i');
            if (!token.test(entry.message) && !(entry.placeholders && entry.placeholders[name])) {
                problems.push(key + ': lost the $' + name.toUpperCase() + '$ placeholder');
            }
        }
        if (key === 'extDescription' && entry.message.length > DESCRIPTION_LIMIT) {
            problems.push('extDescription is ' + entry.message.length + ' characters, over Chrome\'s '
                + DESCRIPTION_LIMIT);
        }
    }
    return problems;
}

function main() {
    const { merged, collisions } = mergeEnglish();
    if (collisions.length) {
        throw Object.assign(new Error('Fragments disagree on: ' + collisions.join('; ')
            + '. Two surfaces defined the same key with different text.'),
        { exitCode: nma.EXIT.FAILED });
    }
    const keyCount = Object.keys(merged).length;
    if (!checkOnly) {
        writeJson(EN, merged);
    }
    nma.log('---- English catalog');
    nma.log('  ' + keyCount + ' keys from ' + (fs.existsSync(PARTS) ? fs.readdirSync(PARTS).length : 0)
        + ' fragments' + (checkOnly ? ' (not written)' : ' -> src/_locales/en/messages.json'));

    const english = checkOnly && fs.existsSync(EN) ? readJson(EN) : merged;
    const locales = fs.readdirSync(LOCALES).filter(d => d !== 'en'
        && fs.existsSync(path.join(LOCALES, d, 'messages.json'))).sort();

    nma.step('Locales');
    const broken = [];
    for (const locale of locales) {
        const problems = problemsFor(locale, english, readJson(path.join(LOCALES, locale, 'messages.json')));
        if (problems.length) {
            broken.push(locale);
            nma.errline('  ' + locale.padEnd(8) + problems.join('; '));
        } else {
            nma.log('  ' + locale.padEnd(8) + 'complete');
        }
    }
    if (!locales.length) {
        nma.warn('  none yet, English only');
    }

    nma.finish({
        schema: 1, script: 'merge-locales', ok: broken.length === 0, target: null, version: null,
        action: checkOnly ? 'check' : 'merge', artifact: checkOnly ? null : EN,
        changed: checkOnly ? [] : ['src/_locales/en/messages.json'], store: null,
        state: broken.length ? 'incomplete' : 'complete', url: null,
        durationMs: Date.now() - started, warnings: [],
        errors: broken.map(l => l + ' is incomplete'),
        nextStep: broken.length ? 'Fill the gaps above before releasing.' : null
    });
    if (broken.length) {
        process.exitCode = 1;
    }
}

main();
