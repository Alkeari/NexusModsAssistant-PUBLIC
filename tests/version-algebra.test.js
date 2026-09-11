'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { importSrc } = require('./harness.js');
const fixtures = require('./fixtures.js');

// The pure version algebra is where the badge verdict is decided, so a wrong answer here
// is a wrong claim made to the user about a mod.
//
// Nothing in this file is read out of the repository any more. NMA ships no version list:
// every build it knows is derived at runtime from a public source, identically on every
// machine. The lists below are therefore INPUT, not data the extension carries, and every
// string in them is one a recorded response in tests/fixtures actually contains.
// tests/harvest.test.js is where the harvester is held to producing them from those
// responses; this file is about what the algebra does once it has them.

let v = null;

test.before(async () => {
    v = await importSrc('src/background/versions.ts');
});

// nexus-collections-skyrimspecialedition.json, the four references that survive
// normalization. The same response also carries "1.4.15.0-VR", a platform variant, which
// is not a build of this game.
const SKYRIM = ['1.6.1170', '1.6.640', '1.6.353', '1.5.97'];

// steamcmd-261550.json branch names, "v" line, newest first. The publisher writes the
// prefix; parseVersion drops it.
const BANNERLORD_RELEASE = ['1.4.7', '1.4.6', '1.4.5', '1.3.15', '1.3.12', '1.3.4', '1.2.12', '1.2.11', '1.2.10', '1.2.9', '1.2.8', '1.2.7', '1.2.0', '1.1.6', '1.0.0'];
// The same response's "e" line: early access builds, numbered above the release line and
// older than all of it. Two lines cannot be ranked against each other by number alone.
const BANNERLORD_EARLY = ['1.9.0', '1.8.1', '1.7.2', '1.7.1', '1.7.0'];
const BANNERLORD = [...BANNERLORD_RELEASE, ...BANNERLORD_EARLY];

// steam-news-1091500.json announcement titles, newest first by the item date recorded
// beside each one. 2.01 and 2.02 are real builds and differ from 2.1 only in padding.
const CYBERPUNK = ['2.1', '2.02', '2.01', '2.0', '1.63'];

// nexus-collections-baldursgate3.json, the references in the four-component scheme
// Larian numbers its patches with.
const BG3 = ['4.1.1.7398727', '4.1.1.7209685'];

const HARVESTED_LINES = {
    'skyrim special edition, collection references': SKYRIM,
    'bannerlord, release branch line': BANNERLORD_RELEASE,
    'bannerlord, early access branch line': BANNERLORD_EARLY,
    "baldur's gate 3, collection references": BG3
};

// U+2014. Kept as an escape so no em dash character appears in this repository.
const EM_DASH = String.fromCharCode(0x2014);

const tokens = (result) => result.map(hit => hit.token);

test.describe('parseVersion: the branches that give a mod author phrasing its meaning', () => {
    test('a trailing plus is an open range, not part of the number', () => {
        const parsed = v.parseVersion('1.6.640+');
        assert.deepEqual(parsed.numbers, [1, 6, 640]);
        assert.equal(parsed.open, true);
        assert.equal(parsed.wildcard, false);
    });

    test('a trailing x or star is a wildcard on the remaining component', () => {
        for (const raw of ['1.6.x', '1.6.*', '1.6x']) {
            const parsed = v.parseVersion(raw);
            assert.deepEqual(parsed.numbers, [1, 6], `numbers for ${raw}`);
            assert.equal(parsed.wildcard, true, `wildcard for ${raw}`);
        }
    });

    test('open and wildcard combine', () => {
        const parsed = v.parseVersion('1.6.x+');
        assert.deepEqual(parsed.numbers, [1, 6]);
        assert.equal(parsed.wildcard, true);
        assert.equal(parsed.open, true);
    });

    test('a prefix letter attached to a number is dropped like the v prefix', () => {
        // "e1.2.9" is how one publisher spells a build on its own Steam branch, and
        // "v1.2.9" is how the same build arrives from a collection. Both are the
        // publisher's own spelling of a number, and the letter is not part of it.
        assert.deepEqual(v.parseVersion('e1.2.9').numbers, [1, 2, 9]);
        assert.equal(v.parseVersion('e1.2.9').prerelease, null);
        assert.equal(v.compareVersions('e1.2.9', 'v1.2.9'), 0);
    });

    test('a trailing dot is stripped rather than parsed as an empty component', () => {
        // "Requires 1.6." at the end of a sentence must not become [1, 6, NaN].
        assert.deepEqual(v.parseVersion('1.6.').numbers, [1, 6]);
    });

    test('an underscore separates a suffix, it does not separate components', () => {
        // Recorded, not endorsed: '1_6_640' is a file-name spelling of 1.6.640 and this
        // parser reads it as major 1 with the rest as a suffix. It stays harmless only
        // because isKnownGameVersion rejects a single-component number.
        const parsed = v.parseVersion('1_6_640');
        assert.deepEqual(parsed.numbers, [1]);
        assert.equal(parsed.prerelease, '6_640');
        assert.equal(v.isKnownGameVersion('1_6_640', SKYRIM), false);
    });

    test('an ISO date parses as a single component and cannot become a known build', () => {
        // Same guard as above, and the reason a changelog date never reaches a verdict.
        const parsed = v.parseVersion('2024-01-15');
        assert.deepEqual(parsed.numbers, [2024]);
        assert.equal(parsed.prerelease, '01-15');
        assert.equal(v.isKnownGameVersion('2024-01-15', SKYRIM), false);
    });

    test('the v prefix and the case a mod author typed are both normalized away', () => {
        // 'V1.6.640' is a real spelling on a Nexus file, and it names the same build as
        // '1.6.640'. Nothing downstream should be able to tell the two apart.
        assert.deepEqual(v.parseVersion('V1.6.640').numbers, [1, 6, 640]);
        assert.deepEqual(v.parseVersion('v1.6.640').components, ['1', '6', '640']);
        assert.equal(v.compareVersions('V1.6.640', '1.6.640'), 0);
    });

    test('surrounding whitespace is trimmed rather than refused', () => {
        assert.deepEqual(v.parseVersion('  1.6.1170  ').numbers, [1, 6, 1170]);
        assert.deepEqual(v.parseVersion(' 1.6.640+ ').numbers, [1, 6, 640]);
        assert.equal(v.parseVersion(' 1.6.640+ ').open, true);
    });

    test('a pre-release tag is separated from the numbers, never absorbed into them', () => {
        // '2.0.1-rc2' is 2.0.1, not 2.0.12.
        const parsed = v.parseVersion('2.0.1-rc2');
        assert.deepEqual(parsed.numbers, [2, 0, 1]);
        assert.equal(parsed.prerelease, 'rc2');
    });

    test('absent or non numeric input is null, never a guess', () => {
        for (const raw of [null, undefined, '', '   ', 'banana', 'SKSE64', 'v', 'x']) {
            assert.equal(v.parseVersion(raw), null, `parseVersion(${JSON.stringify(raw)})`);
        }
    });

    test('the padding a build number carries is kept beside the plain numbers', () => {
        // A publisher that numbers 2.01 and 2.1 as different builds makes the padding
        // load bearing, so the padded spelling has to survive the parse. numbers stays
        // the plain integer reading it always was, for the callers that key on it.
        const padded = v.parseVersion('2.01');
        assert.deepEqual(padded.components, ['2', '01']);
        assert.deepEqual(padded.numbers, [2, 1]);

        const plain = v.parseVersion('2.1');
        assert.deepEqual(plain.components, ['2', '1']);
        assert.deepEqual(plain.numbers, [2, 1]);
    });
});

test.describe('isKnownGameVersion: the prefix rule that closed the 1.2.5 defect', () => {
    test('a mod release number sharing major and minor with a real build is refused', () => {
        // Defect dossier 3.1: a mod version 1.2.5 was accepted as a game build because it
        // shared major+minor with 1.2.11, producing a green "Compatible - v1.2.5" badge on
        // a mod that only supported 1.0.3. This assertion is the ratchet on that fix, and
        // 1.2.5 is a number the branch list recorded in steamcmd-261550.json does not hold.
        assert.equal(v.isKnownGameVersion('1.2.5', BANNERLORD), false);
        assert.equal(v.isKnownGameVersion('1.6.2', SKYRIM), false);
    });

    test('a genuine prefix of a known build is accepted', () => {
        // "1.6" in prose means the 1.6 line, and 1.6.1170 is in it.
        assert.equal(v.isKnownGameVersion('1.6', SKYRIM), true);
        assert.equal(v.isKnownGameVersion('1.2', BANNERLORD), true);
    });

    test('a token longer than the known build it would match is refused', () => {
        assert.equal(v.isKnownGameVersion('1.6.1170.5', SKYRIM), false);
    });

    test('a bare major is refused however well it matches', () => {
        // One component is a chapter number, a mod page count or a price, never a build.
        assert.equal(v.isKnownGameVersion('1', SKYRIM), false);
        assert.equal(v.isKnownGameVersion('2', CYBERPUNK), false);
    });

    test('the commonest mod release numbers pass the prefix rule', () => {
        // Recorded, not endorsed. This is the pure half of BG-09. A harvest that yields
        // 2.0, 2.01, 2.02 and 2.1 accepts the bare strings a mod author is most likely to
        // put in a file version. The prefix rule is doing what it was written to do; the
        // hazard is that FILE_VERSION then grades the hit EXACT.
        assert.equal(v.isKnownGameVersion('2.0', CYBERPUNK), true);
        assert.equal(v.isKnownGameVersion('2.1', CYBERPUNK), true);
    });

    test('a padded build is confirmed by itself and not by its unpadded twin', () => {
        // 2.01, 2.02 and 2.1 are all real builds, announced on the dates recorded in
        // steam-news-1091500.json, and the twins can only be told apart by their padding.
        // 2.03 and 2.05 were never announced: before the padding fix they were accepted,
        // because they read as the same numbers as 2.3 and 2.5, which is a stated-build
        // claim about a version that does not exist.
        assert.equal(v.isKnownGameVersion('2.02', CYBERPUNK), true);
        assert.equal(v.isKnownGameVersion('2.01', CYBERPUNK), true);
        assert.equal(v.isKnownGameVersion('2.03', CYBERPUNK), false);
        assert.equal(v.isKnownGameVersion('2.05', CYBERPUNK), false);
    });

    test('the prefix rule reaches into a four component build number', () => {
        // 4.1.1.7398727 is a reference a real collection carries, and "4.1.1" is how a mod
        // page says the same thing in prose.
        assert.equal(v.isKnownGameVersion('4.1.1', BG3), true);
        assert.equal(v.isKnownGameVersion('4.1.1.7398727', BG3), true);
        assert.equal(v.isKnownGameVersion('4.1.2', BG3), false);
        assert.equal(v.isKnownGameVersion('4.1.1.7398728', BG3), false);
    });

    test('an absent or empty list means cannot judge, not everything passes', () => {
        // Fail closed. This is now the commonest case rather than an edge one: on a random
        // sample of the catalog, four games in ten yield no version from any source, and
        // for those games this branch is the whole answer.
        assert.equal(v.isKnownGameVersion('1.6.640', []), false);
        assert.equal(v.isKnownGameVersion('1.6.640', null), false);
        assert.equal(v.isKnownGameVersion('', SKYRIM), false);
        assert.equal(v.isKnownGameVersion(null, SKYRIM), false);
    });

    test('a list entry that is not a version cannot confirm anything', () => {
        // The harvest merges strings from several sources into this list, so an
        // unparseable entry has to be skipped rather than matched against.
        assert.equal(v.isKnownGameVersion('1.6.640', ['latest', 'unknown']), false);
        assert.equal(v.isKnownGameVersion('1.6.640', ['latest', '1.6.640']), true);
    });

    test('every build in a harvested line is recognized by its own line', () => {
        // A harvest that produced a string its own parser cannot read would otherwise be
        // invisible: the list would be full and every verdict against it UNKNOWN.
        for (const [line, builds] of Object.entries(HARVESTED_LINES)) {
            for (const build of builds) {
                assert.equal(v.isKnownGameVersion(build, builds), true, `${line}: ${build}`);
            }
        }
    });
});

test.describe('rangesOverlap and the prefix-inclusive upper bound', () => {
    test('a two part upper bound admits every build that extends it', () => {
        // This is the decision that replaced the synthetic .999 ceiling: max [1,6] is a
        // PREFIX, so 1.6.1170 is inside it even though 1170 > 6.
        assert.equal(v.rangesOverlap({min: [1, 6], max: [1, 6]}, {min: [1, 6, 1170], max: [1, 6, 1170]}), true);
        assert.equal(v.rangesOverlap({min: [1, 6, 1170], max: [1, 6, 1170]}, {min: [1, 6], max: [1, 6]}), true);
    });

    test('a prefix upper bound still excludes the next line up', () => {
        assert.equal(v.rangesOverlap({min: [1, 6], max: [1, 6]}, {min: [1, 7], max: [1, 7]}), false);
    });

    test('a null upper bound is unbounded above', () => {
        assert.equal(v.rangesOverlap({min: [1, 6, 640], max: null}, {min: [9, 9, 9], max: [9, 9, 9]}), true);
        assert.equal(v.rangesOverlap({min: [1, 6, 640], max: null}, {min: [1, 5, 97], max: [1, 5, 97]}), false);
    });

    test('disjoint ranges do not overlap in either direction', () => {
        const low = {min: [1, 5, 97], max: [1, 5, 97]};
        const high = {min: [1, 6, 1170], max: [1, 6, 1170]};
        assert.equal(v.rangesOverlap(low, high), false);
        assert.equal(v.rangesOverlap(high, low), false);
    });

    test('a range touching another at exactly one build overlaps', () => {
        // The bounds are inclusive, so the single shared build 1.6.640 is enough.
        const lower = {min: [1, 5, 97], max: [1, 6, 640]};
        const upper = {min: [1, 6, 640], max: [1, 6, 1170]};
        assert.equal(v.rangesOverlap(lower, upper), true);
        assert.equal(v.rangesOverlap(upper, lower), true);
    });

    test('a range whose end is below its start overlaps nothing at all', () => {
        // VER-01's second half. Overlap is the permissive answer, so an inverted range
        // has to be refused rather than allowed to swallow everything.
        const inverted = {min: [1, 6, 1170], max: [1, 5, 97]};
        const real = {min: [1, 5, 97], max: [1, 6, 1170]};
        assert.equal(v.rangesOverlap(inverted, real), false);
        assert.equal(v.rangesOverlap(real, inverted), false);
        assert.equal(v.rangesOverlap(inverted, inverted), false);
        // Its own bounds are not a way back in either.
        assert.equal(v.rangesOverlap(inverted, {min: [1, 6, 1170], max: [1, 6, 1170]}), false);
        assert.equal(v.rangesOverlap(inverted, {min: [1, 5, 97], max: [1, 5, 97]}), false);
    });

    test('a prefix upper bound is not mistaken for an inverted range', () => {
        // max [1,6] against min [1,6,1170] is the prefix rule doing its job, not an
        // inversion, and refusing it would put the .999 ceiling back by another route.
        assert.equal(v.rangesOverlap({min: [1, 6, 1170], max: [1, 6]}, {min: [1, 6, 1170], max: [1, 6, 1170]}), true);
    });

    test('both bounds unbounded above always overlap', () => {
        assert.equal(v.rangesOverlap({min: [1, 5, 97], max: null}, {min: [1, 6, 1170], max: null}), true);
    });
});

test.describe('compareNumberArrays treats a missing component as zero', () => {
    test('a shorter array equals its zero padded self', () => {
        assert.equal(v.compareNumberArrays([1, 6], [1, 6, 0]), 0);
        assert.equal(v.compareNumberArrays([], []), 0);
    });

    test('an extra non zero component sorts above', () => {
        assert.equal(v.compareNumberArrays([1, 6, 1], [1, 6]), 1);
        assert.equal(v.compareNumberArrays([1, 6], [1, 6, 1]), -1);
    });

    test('every component is compared numerically, never as text', () => {
        // 1.6.1170 and 1.6.640 are both recorded collection references, and text ordering
        // says the wrong one is newer. This comparator is what every range decision sits on.
        assert.equal(v.compareNumberArrays([1, 6, 1170], [1, 6, 640]), 1);
        assert.equal(v.compareNumberArrays([1, 14, 74], [1, 9, 71]), 1);
        assert.equal(v.compareNumberArrays([1, 6, 1170], [1, 6, 1170]), 0);
    });

    test('an empty array is the floor rather than a special case', () => {
        assert.equal(v.compareNumberArrays([], [0, 0]), 0);
        assert.equal(v.compareNumberArrays([], [1, 6]), -1);
        assert.equal(v.compareNumberArrays([1, 6], []), 1);
    });
});

test.describe('formatVersionToken round trips every shape a token can take', () => {
    test('parse then format returns the input for each marker combination', () => {
        // Tokens are the strings the rest of the pipeline compares, caches and displays,
        // so a marker lost in this round trip silently changes a verdict.
        for (const raw of ['1.6.640', '1.6.x', '1.6.640+', '1.6.x+', '4.1.1.7398727', '1.6']) {
            assert.equal(v.formatVersionToken(v.parseVersion(raw)), raw);
        }
    });

    test('a padded build number round trips with its padding', () => {
        // The token is what the badge shows and what compareVersions is handed, so 2.01
        // has to come out of the round trip as 2.01 and not as 2.1.
        for (const raw of ['2.01', '2.02', '2.01+', '2.0.x', '2.1']) {
            assert.equal(v.formatVersionToken(v.parseVersion(raw)), raw);
        }
    });

    test('the prefix a mod author typed is dropped, the shape is kept', () => {
        assert.equal(v.formatVersionToken(v.parseVersion('e1.2.9')), '1.2.9');
        assert.equal(v.formatVersionToken(v.parseVersion('v1.6.640+')), '1.6.640+');
        assert.equal(v.formatVersionToken(v.parseVersion('1.6.*')), '1.6.x');
        assert.equal(v.formatVersionToken(v.parseVersion('1.5.97-beta')), '1.5.97');
    });
});

test.describe('versionRangeFromToken: what a token means as an interval', () => {
    test('a point token is a range of one build', () => {
        const range = v.versionRangeFromToken('1.6.640');
        assert.deepEqual(range.min, [1, 6, 640]);
        assert.deepEqual(range.max, [1, 6, 640]);
    });

    test('an open token has no upper bound', () => {
        const range = v.versionRangeFromToken('1.6.640+');
        assert.deepEqual(range.min, [1, 6, 640]);
        assert.equal(range.max, null);
    });

    test('a hyphen range keeps both endpoints', () => {
        const range = v.versionRangeFromToken('1.5.97-1.6.1170');
        assert.deepEqual(range.min, [1, 5, 97]);
        assert.deepEqual(range.max, [1, 6, 1170]);
    });

    test('a padded endpoint keeps its padding, so the interval is the one that shipped', () => {
        // 2.0-2.02 must not read as 2.0 to 2.2, which would swallow 2.1 and 2.11.
        assert.equal(v.isCompatible('2.1', '2.0-2.02', ''), false);
        assert.equal(v.isCompatible('2.02', '2.0-2.02', ''), true);
    });

    test('a suffix is not an endpoint, however it is spelled', () => {
        for (const raw of ['1.5.97-hotfix', '1.5.97-1', '1.5.97_2']) {
            const range = v.versionRangeFromToken(raw);
            assert.deepEqual(range.min, [1, 5, 97], `min for ${raw}`);
            assert.deepEqual(range.max, [1, 5, 97], `max for ${raw}`);
        }
    });

    test('absent or unreadable input yields null, which is what the popup reports on', () => {
        // background.ts calls this to decide whether the configured range is readable at
        // all, so null has to mean "cannot read" rather than "empty range".
        for (const raw of [null, undefined, '', '   ', 'latest', 'banana']) {
            assert.equal(v.versionRangeFromToken(raw), null, `versionRangeFromToken(${JSON.stringify(raw)})`);
        }
    });
});

test.describe('isCompatible: the untested branches', () => {
    test('an empty upper bound falls back to the lower bound, targeting one build', () => {
        // background.ts refuses to run a check at all without a versionMin, so the empty
        // case here is an empty MAX only: "I run exactly 1.6.640".
        assert.equal(v.isCompatible('1.6.640', '1.6.640', ''), true);
        assert.equal(v.isCompatible('1.6.1170', '1.6.640', ''), false);
        assert.equal(v.isCompatible('1.5.97', '1.6.640', ''), false);
    });

    test('an open mod token covers everything above its floor and nothing below', () => {
        assert.equal(v.isCompatible('1.6.640+', '1.6.1170', '1.6.1170'), true);
        assert.equal(v.isCompatible('1.6.640+', '1.5.0', '1.5.97'), false);
    });

    test('a wildcard mod token covers the whole line it names', () => {
        assert.equal(v.isCompatible('1.6.x', '1.6.1170', '1.6.1170'), true);
        assert.equal(v.isCompatible('1.6.x', '1.5.97', '1.5.97'), false);
    });

    test('an unparseable mod token is incompatible, never compatible by default', () => {
        // Failing open here is what puts a confident green badge on text nothing was
        // known about.
        assert.equal(v.isCompatible('banana', '1.6.640', '1.6.1170'), false);
        assert.equal(v.isCompatible('', '1.6.640', '1.6.1170'), false);
        assert.equal(v.isCompatible(null, '1.6.640', '1.6.1170'), false);
    });

    test('an inverted user range answers false for everything, including its own bounds', () => {
        // Recorded so the consequence is visible: this boolean API cannot express
        // "refuse to judge", so min > max produces a page of confident INCOMPATIBLE
        // badges. The guard has to live in the popup that collects the two fields.
        assert.equal(v.isCompatible('1.6.640', '1.6.1170', '1.5.0'), false);
        assert.equal(v.isCompatible('1.6.1170', '1.6.1170', '1.5.0'), false);
        assert.equal(v.isCompatible('1.5.0', '1.6.1170', '1.5.0'), false);
    });

    test('the ends of the configured range are inclusive', () => {
        assert.equal(v.isCompatible('1.5.97', '1.5.97', '1.6.1170'), true);
        assert.equal(v.isCompatible('1.6.1170', '1.5.97', '1.6.1170'), true);
    });

    test('an inverted mod token is incompatible with everything, its own bounds included', () => {
        // A backwards range is not a statement about a wide span, it is an unreadable
        // token, and the only safe answer to an unreadable token is no.
        assert.equal(v.isCompatible('1.6.1170-1.5.97', '1.6.640', '1.6.1170'), false);
        assert.equal(v.isCompatible('1.6.1170-1.5.97', '1.6.1170', '1.6.1170'), false);
        assert.equal(v.isCompatible('1.6.1170-1.5.97', '1.5.97', '1.5.97'), false);
    });

    test('an unreadable bound answers false rather than judging against a guess', () => {
        assert.equal(v.isCompatible('1.6.640', 'latest', '1.6.1170'), false);
        assert.equal(v.isCompatible('1.6.640', '1.5.97', 'latest'), false);
        assert.equal(v.isCompatible('1.6.640', '', ''), false);
    });

    test('a user range spelled as a prefix admits the whole line', () => {
        // "1.6" in the popup means the 1.6 line, so every build in it is inside.
        assert.equal(v.isCompatible('1.6.1170', '1.6', '1.6'), true);
        assert.equal(v.isCompatible('1.6.353', '1.6', '1.6'), true);
        assert.equal(v.isCompatible('1.5.97', '1.6', '1.6'), false);
    });
});

test.describe('compareVersions: prerelease ordering', () => {
    test('two prerelease tags on the same build are ordered as strings', () => {
        // Recorded, not endorsed. rc10 sorting below rc2 is exactly the lexicographic
        // comparison the first test in this suite exists to forbid for numbers. No
        // shipping caller can reach it: every compareVersions argument in background.ts
        // is a token from formatVersionToken, which emits only digits, '.x' and '+'.
        assert.equal(v.compareVersions('1.0.0-rc10', '1.0.0-rc2'), -1);
        assert.equal(v.compareVersions('1.0.0-rc2', '1.0.0-rc10'), 1);
        assert.equal(v.compareVersions('1.0.0-beta', '1.0.0-beta'), 0);
    });
});

test.describe('compareVersions: zero padding is part of the build number', () => {
    test('an announcement ladder is ordered the way the publisher shipped it', () => {
        // 2.0, then 2.01, then 2.02, then 2.1: four consecutive announcements in
        // steam-news-1091500.json, in that order by their recorded dates. The padding is
        // the only thing separating 2.01 from 2.1.
        const ladder = ['2.0', '2.01', '2.02', '2.1'];
        for (let i = 1; i < ladder.length; i++) {
            assert.equal(v.compareVersions(ladder[i], ladder[i - 1]), 1, `${ladder[i]} > ${ladder[i - 1]}`);
            assert.equal(v.compareVersions(ladder[i - 1], ladder[i]), -1, `${ladder[i - 1]} < ${ladder[i]}`);
        }
    });

    test('padding does not disturb the ordering of unpadded builds', () => {
        // The rule that keeps 2.01 below 2.1 must not reach the numbers where a longer
        // component really is a later build.
        assert.equal(v.compareVersions('1.6.1170', '1.6.640'), 1);
        assert.equal(v.compareVersions('1.14.74', '1.9.71'), 1);
        assert.equal(v.compareVersions('1.2.11', '1.2.9'), 1);
        assert.equal(v.compareVersions('1.63', '1.6'), 1);
    });

    test('every harvested line is in strict newest first order', () => {
        // A harvested line is consumed as ordered data. A pair that compares equal or
        // backwards is a line the algebra cannot rank, which is how 2.1 came to sort
        // below 2.02.
        for (const [line, builds] of Object.entries(HARVESTED_LINES)) {
            for (let i = 1; i < builds.length; i++) {
                assert.equal(
                    v.compareVersions(builds[i - 1], builds[i]),
                    1,
                    `${line}: ${builds[i - 1]} should be newer than ${builds[i]}`
                );
            }
        }
    });

    test('a decimal-minor announcement ladder orders correctly', {
        todo: 'compareVersions cannot rank a scheme whose minor component is a decimal fraction. ' +
            'The old note said this needed a per-game scheme in versions.json. There is no versions.json ' +
            'now and there is no per-game anything: the fix has to be a rule the data itself supports, ' +
            'or the honest answer is that this publisher\'s ladder is unrankable and the harvest must ' +
            'not claim an order for it.'
    }, () => {
        // Derived, not asserted: the true order is the order the publisher announced them
        // in, which is the recorded date on each news item. Nothing here is typed from
        // memory.
        const announced = fixtures.steamNews('1091500').appnews.newsitems
            .map(item => ({date: Number(item.date), title: String(item.title)}))
            .map(item => ({date: item.date, version: (/^(?:Update|Patch|Hotfix)\s+(\d+\.\d+)\b/.exec(item.title) || [])[1]}))
            .filter(item => item.version)
            .sort((a, b) => b.date - a.date);

        const ladder = [];
        for (const item of announced) {
            if (!ladder.includes(item.version)) ladder.push(item.version);
        }

        for (let i = 1; i < ladder.length; i++) {
            assert.equal(v.compareVersions(ladder[i - 1], ladder[i]), 1, `${ladder[i - 1]} announced after ${ladder[i]}`);
        }
    });

    test('a padded component sorts below its unpadded twin at every position', () => {
        assert.equal(v.compareVersions('1.01.5', '1.1.5'), -1);
        assert.equal(v.compareVersions('1.1.05', '1.1.5'), -1);
        assert.equal(v.compareVersions('2.01', '2.0'), 1);
        assert.equal(v.compareVersions('2.01', '2.01'), 0);
    });
});

test.describe('extractVersionTokens: the harvest every badge flows through', () => {
    test('a hyphen range yields the range and both endpoints', () => {
        const got = tokens(v.extractVersionTokens('Compatible 1.5.97 - 1.6.640', SKYRIM, {
            source: 'DESCRIPTION',
            requireCue: true
        }));
        assert.deepEqual(got, ['1.5.97-1.6.640', '1.5.97', '1.6.640']);
    });

    test('an em dash range is read the same as a hyphen range', () => {
        // Nexus descriptions are pasted from word processors constantly, so the separator
        // arrives as U+2014 rather than a hyphen. Spelled as an escape here on purpose.
        const got = tokens(v.extractVersionTokens(`Compatible 1.5.97 ${EM_DASH} 1.6.640`, SKYRIM, {
            source: 'DESCRIPTION',
            requireCue: true
        }));
        assert.deepEqual(got, ['1.5.97-1.6.640', '1.5.97', '1.6.640']);
    });

    test('requireCue drops a bare number with no game-version wording near it', () => {
        const bare = 'Just some text 1.6.640 here';
        assert.deepEqual(tokens(v.extractVersionTokens(bare, SKYRIM, {source: 'DESCRIPTION', requireCue: true})), []);
        // Without the cue requirement the same text yields the number, which is why
        // description scanning sets requireCue and file-version scanning does not.
        assert.deepEqual(tokens(v.extractVersionTokens(bare, SKYRIM, {source: 'DESCRIPTION'})), ['1.6.640']);
    });

    test('a cue split from the number by markup still counts, because tags are stripped first', () => {
        const got = tokens(v.extractVersionTokens('<p>game version <b>1.6.640</b></p>', SKYRIM, {
            source: 'DESCRIPTION',
            requireCue: true
        }));
        assert.deepEqual(got, ['1.6.640']);
    });

    test('prose meaning "or later" becomes an open token', () => {
        const got = v.extractVersionTokens('Requires game version 1.6.640 or later', SKYRIM, {
            source: 'DESCRIPTION',
            requireCue: true
        });
        assert.deepEqual(tokens(got), ['1.6.640+']);
        // The evidence text shown to the user stays the author's own words.
        assert.equal(got[0].text, '1.6.640');
        assert.equal(got[0].cued, true);
        assert.equal(got[0].source, 'DESCRIPTION');
    });

    test('a plus the author typed becomes the same open token', () => {
        assert.deepEqual(
            tokens(v.extractVersionTokens('game version 1.6.640+', SKYRIM, {source: 'DESCRIPTION', requireCue: true})),
            ['1.6.640+']
        );
    });

    test('a wildcard the author typed survives the harvest', () => {
        assert.deepEqual(
            tokens(v.extractVersionTokens('compatible with game version 1.6.x', SKYRIM, {source: 'DESCRIPTION', requireCue: true})),
            ['1.6.x']
        );
    });

    test('a number no known build confirms is dropped', () => {
        // 1.6.999 is in no recorded source for this game. Admitting it would resurrect
        // the .999 ceiling as a real-looking version.
        assert.deepEqual(
            tokens(v.extractVersionTokens('game version 1.6.999', SKYRIM, {source: 'DESCRIPTION', requireCue: true})),
            []
        );
    });

    test('allowUnknownBuilds is a discovery door and it lets a date through', () => {
        // Recorded as a hazard with its guard named: this door is used by version
        // DISCOVERY only. A caller that used it for a verdict would put "2024.01.15" on a
        // badge, and isKnownGameVersion is what stops that happening on the verdict path.
        // The token keeps the calendar padding because the token keeps ALL padding now:
        // dropping it is what made 2.01 and 2.1 the same string (VER-02).
        const got = tokens(v.extractVersionTokens('game version updated 2024.01.15', SKYRIM, {
            source: 'DESCRIPTION',
            allowUnknownBuilds: true
        }));
        assert.deepEqual(got, ['2024.01.15']);
        assert.equal(v.isKnownGameVersion('2024.01.15', SKYRIM), false);
    });

    test('an e-prefixed build is harvested without its prefix', () => {
        assert.deepEqual(
            tokens(v.extractVersionTokens('for game version e1.2.9', BANNERLORD, {source: 'DESCRIPTION', requireCue: true})),
            ['1.2.9']
        );
    });

    test('a dependency version that happens to equal a game build is still harvested', () => {
        // Recorded, not endorsed: "Requires SKSE 1.6.640" is a script extender version,
        // not a statement about the game. It is admitted because "Requires" is a cue and
        // 1.6.640 is a build the harvest confirmed. SKSE builds track game builds, so the
        // answer is usually right by coincidence rather than by reasoning.
        assert.deepEqual(
            tokens(v.extractVersionTokens('Requires SKSE 1.6.640', SKYRIM, {source: 'DESCRIPTION', requireCue: true})),
            ['1.6.640']
        );
    });

    test('prose that only looks like a version yields nothing', () => {
        assert.deepEqual(tokens(v.extractVersionTokens('Install takes 1 to 5 minutes', SKYRIM, {source: 'DESCRIPTION'})), []);
        assert.deepEqual(tokens(v.extractVersionTokens('', SKYRIM, {source: 'DESCRIPTION'})), []);
        assert.deepEqual(tokens(v.extractVersionTokens(null, SKYRIM, {source: 'DESCRIPTION'})), []);
        assert.deepEqual(tokens(v.extractVersionTokens(undefined, SKYRIM, {source: 'DESCRIPTION'})), []);
    });

    test('an empty known-build list harvests nothing unless the discovery door is open', () => {
        assert.deepEqual(tokens(v.extractVersionTokens('game version 1.6.640', [], {source: 'DESCRIPTION'})), []);
        assert.deepEqual(
            tokens(v.extractVersionTokens('game version 1.6.640', [], {source: 'DESCRIPTION', allowUnknownBuilds: true})),
            ['1.6.640']
        );
    });

    test('the exclusion set keeps a mod own release number out of the harvest', () => {
        // background.ts builds this set from the mod's own version fields so a mod
        // numbered 1.6.640 cannot claim to support game 1.6.640 by existing.
        assert.deepEqual(
            tokens(v.extractVersionTokens('game version 1.6.640', SKYRIM, {
                source: 'DESCRIPTION',
                requireCue: true,
                exclude: new Set(['1.6.640'])
            })),
            []
        );
    });

    test('excluding one endpoint of a range leaves the range whole and the other endpoint harvested', () => {
        // Recorded, not endorsed, and it is the open half of VER-04: the range token
        // survives intact even though its low end is the mod's own release number, because
        // the exclusion set is consulted on the candidate branch only. Whether the right
        // answer is to drop the range or clip it to its high end is a verdict decision.
        assert.deepEqual(
            tokens(v.extractVersionTokens('compatible 1.5.97 - 1.6.1170', SKYRIM, {
                source: 'DESCRIPTION',
                requireCue: true,
                exclude: new Set(['1.5.97'])
            })),
            ['1.5.97-1.6.1170', '1.6.1170']
        );
    });

    test('a file version with a numeric revision suffix normalizes before any verdict', () => {
        // This is the production guard against the inverted range recorded further down:
        // '1.5.97-1' never reaches isCompatible as written, because the harvest turns it
        // into the point token '1.5.97' first.
        const got = v.extractVersionTokens('1.5.97-1', SKYRIM, {source: 'FILE_VERSION'});
        assert.deepEqual(tokens(got), ['1.5.97']);
        assert.equal(got[0].text, '1.5.97-1');
        assert.equal(v.isCompatible(got[0].token, '1.6.640', '1.6.1170'), false);
    });

    test('a bare file version equal to a known build is harvested with no cue at all', () => {
        // Recorded, not endorsed, and it is the open question in MISSED-01: FILE_VERSION
        // scanning sets no requireCue, so a mod whose file is numbered 1.2.9 states game
        // build 1.2.9 by existing. The exclusion set only removes the mod's own version
        // field, which is a different number. Whether file.version should count as game
        // evidence at all is a developer decision.
        const got = v.extractVersionTokens('1.2.9', BANNERLORD, {
            source: 'FILE_VERSION',
            exclude: new Set(['1.2.5'])
        });
        assert.deepEqual(tokens(got), ['1.2.9']);
        assert.equal(got[0].cued, false);
    });

    test('a cue found after the number counts as well as one before it', () => {
        assert.deepEqual(
            tokens(v.extractVersionTokens('1.6.640 is the game version this targets', SKYRIM, {
                source: 'DESCRIPTION',
                requireCue: true
            })),
            ['1.6.640']
        );
    });

    test('a cue too far away does not carry', () => {
        const far = `game version${' '.repeat(200)}1.6.640`;
        assert.deepEqual(tokens(v.extractVersionTokens(far, SKYRIM, {source: 'DESCRIPTION', requireCue: true})), []);
    });

    test('the cue windows are caller settable in both directions', () => {
        // background.ts leaves these at their defaults today. They are the knob that
        // decides how much text a cue is allowed to speak for, so a change to either
        // default has to show up here rather than in a user's badge.
        const behind = 'game version 1.6.640';
        assert.deepEqual(tokens(v.extractVersionTokens(behind, SKYRIM, {source: 'DESCRIPTION', requireCue: true})), ['1.6.640']);
        assert.deepEqual(
            tokens(v.extractVersionTokens(behind, SKYRIM, {source: 'DESCRIPTION', requireCue: true, cueLookBehind: 3})),
            []
        );

        const ahead = '1.6.640 game version';
        assert.deepEqual(tokens(v.extractVersionTokens(ahead, SKYRIM, {source: 'DESCRIPTION', requireCue: true})), ['1.6.640']);
        assert.deepEqual(
            tokens(v.extractVersionTokens(ahead, SKYRIM, {source: 'DESCRIPTION', requireCue: true, cueLookAhead: 3})),
            []
        );
    });

    test('the same number seen twice is one hit, and the cued sighting is the one kept', () => {
        // A description usually names a build in passing before saying anything about it.
        // The evidence the user is shown should be the sighting that had a reason.
        const gap = '.'.repeat(80);
        const uncuedFirst = v.extractVersionTokens(`1.6.640${gap} game version 1.6.640`, SKYRIM, {source: 'DESCRIPTION'});
        assert.deepEqual(tokens(uncuedFirst), ['1.6.640']);
        assert.equal(uncuedFirst[0].cued, true);

        const cuedFirst = v.extractVersionTokens(`game version 1.6.640${gap} 1.6.640`, SKYRIM, {source: 'DESCRIPTION'});
        assert.deepEqual(tokens(cuedFirst), ['1.6.640']);
        assert.equal(cuedFirst[0].cued, true);
    });

    test('every prose spelling of an open range becomes the same open token', () => {
        for (const tail of ['or later', 'and later', 'or newer', 'and newer', 'or higher', 'and above', 'or above']) {
            assert.deepEqual(
                tokens(v.extractVersionTokens(`game version 1.6.640 ${tail}`, SKYRIM, {source: 'DESCRIPTION', requireCue: true})),
                ['1.6.640+'],
                `tail: ${tail}`
            );
        }
    });

    test('prose that does not mean "or later" leaves the token closed', () => {
        // "1.6.640 or earlier" is the opposite claim, and reading it as open would put a
        // green badge on every build above it.
        assert.deepEqual(
            tokens(v.extractVersionTokens('game version 1.6.640 or earlier', SKYRIM, {source: 'DESCRIPTION', requireCue: true})),
            ['1.6.640']
        );
    });

    test('a word separator is read as a range the same as a dash', () => {
        for (const separator of ['to', 'through']) {
            assert.deepEqual(
                tokens(v.extractVersionTokens(`compatible 1.5.97 ${separator} 1.6.640`, SKYRIM, {
                    source: 'DESCRIPTION',
                    requireCue: true
                })),
                ['1.5.97-1.6.640', '1.5.97', '1.6.640'],
                `separator: ${separator}`
            );
        }
    });

    test('a padded build survives the harvest as the build the author named', () => {
        // The end to end half of VER-02: harvesting 2.01 as the token '2.1' handed the
        // rest of the pipeline a different, real build, and 2.1 is a game the mod was
        // never tested against.
        const got = v.extractVersionTokens('game version 2.01', CYBERPUNK, {source: 'DESCRIPTION', requireCue: true});
        assert.deepEqual(tokens(got), ['2.01']);
        assert.equal(v.isCompatible(got[0].token, '2.1', '2.1'), false);
        assert.equal(v.isCompatible(got[0].token, '2.01', '2.01'), true);

        assert.deepEqual(
            tokens(v.extractVersionTokens('compatible 2.0 - 2.02', CYBERPUNK, {source: 'DESCRIPTION', requireCue: true})),
            ['2.0-2.02', '2.0', '2.02']
        );
    });

    test('the source the caller named is carried on every hit', () => {
        // The verdict is graded by where the evidence came from, so a hit that forgot its
        // own source would be graded as something it is not.
        const got = v.extractVersionTokens('skse64_1_6_640.7z 1.6.640', SKYRIM, {source: 'FILE_NAME'});
        assert.deepEqual(tokens(got), ['1.6.640']);
        assert.equal(got[0].source, 'FILE_NAME');
    });

    test('two different builds in one blob are two hits', () => {
        assert.deepEqual(
            tokens(v.extractVersionTokens('Works on game version 1.6.640 and on 1.6.1170', SKYRIM, {
                source: 'DESCRIPTION',
                requireCue: true
            })),
            ['1.6.640', '1.6.1170']
        );
    });
});

test.describe('normalizeVersionForDisplay: what reaches the badge face', () => {
    test('a bare version gains the v prefix', () => {
        assert.equal(v.normalizeVersionForDisplay('1.6.640'), 'v1.6.640');
        assert.equal(v.normalizeVersionForDisplay('  1.6.640  '), 'v1.6.640');
    });

    test('an existing v or e prefix is left alone', () => {
        assert.equal(v.normalizeVersionForDisplay('v1.6.640'), 'v1.6.640');
        assert.equal(v.normalizeVersionForDisplay('e1.2.9'), 'e1.2.9');
    });

    test('absent input yields null rather than a bare v', () => {
        assert.equal(v.normalizeVersionForDisplay(null), null);
        assert.equal(v.normalizeVersionForDisplay(undefined), null);
        assert.equal(v.normalizeVersionForDisplay(''), null);
        assert.equal(v.normalizeVersionForDisplay('   '), null);
    });

    test('internal whitespace is concatenated away instead of rejected', () => {
        // Recorded, not endorsed: '1.6 640' becomes 'v1.6640', a plausible-looking version
        // the user never saw anywhere. No token can contain a space, so the only live path
        // is a user-typed version string echoed back into an UPLOAD_DATE badge.
        assert.equal(v.normalizeVersionForDisplay('1.6 640'), 'v1.6640');
    });

    test('a repeated prefix letter collapses to one', () => {
        // One source spells a build v1.4.0 and another prepends its own v, which put the
        // same build in the list twice under two spellings.
        assert.equal(v.normalizeVersionForDisplay('vv1.4.0'), 'v1.4.0');
        assert.equal(v.normalizeVersionForDisplay('VV1.4.0'), 'V1.4.0');
        assert.equal(v.normalizeVersionForDisplay('ee1.7.0'), 'e1.7.0');
        assert.equal(v.normalizeVersionForDisplay('v1.4.0'), 'v1.4.0');
        assert.equal(v.normalizeVersionForDisplay('1.4.0'), 'v1.4.0');
    });
});

// ── Fixed defects, now ratchets ─────────────────────────────────────
// Each test below was written as a todo against the defect it names, and each turns red
// again the moment that defect comes back. VER-01, VER-02 and VER-04 are the findings.

test.describe('recorded defects', () => {
    test('a zero padded component is not the same build as an unpadded one', () => {
        // VER-02. The publisher shipped 2.0, 2.01, 2.02, then 2.1. The padding is load
        // bearing, and parseInt dropped it, so 2.1 sorted BELOW 2.02 and equal to 2.01.
        assert.equal(v.compareVersions('2.1', '2.01'), 1);
        assert.equal(v.compareVersions('2.1', '2.02'), 1);
        assert.equal(v.isCompatible('2.1', '2.0', '2.02'), false);
    });

    test('no two builds in a harvested line compare equal', () => {
        // VER-02 again, over every line at once rather than a chosen pair. A healthy
        // harvest produces an empty list here; before the fix it produced "2.1 == 2.01".
        const collisions = [];
        for (const [line, builds] of Object.entries({...HARVESTED_LINES, cyberpunk: CYBERPUNK})) {
            for (let i = 0; i < builds.length; i++) {
                for (let j = i + 1; j < builds.length; j++) {
                    if (v.compareVersions(builds[i], builds[j]) === 0) {
                        collisions.push(`${line} ${builds[i]} == ${builds[j]}`);
                    }
                }
            }
        }
        assert.deepEqual(collisions, []);
    });

    test('a numeric revision suffix never widens the range a token covers', () => {
        // VER-01. '1.5.97-hotfix' was already handled correctly, so the suffix rule
        // itself was never in question: only the numeric spelling of it was. An inverted
        // range is not a range, and the permissive answer it degenerated to was a green
        // badge on a mod built for a game two minor versions back.
        const range = v.versionRangeFromToken('1.5.97-1');
        assert.deepEqual(range.min, [1, 5, 97]);
        assert.equal(v.isCompatible('1.5.97-1', '1.6.640', '1.6.1170'), false);
        assert.equal(v.isCompatible('1.5.97-1.2', '1.6.640', '1.6.1170'), false);
    });

    test('a range built entirely from excluded numbers is not harvested', () => {
        // VER-04. Both endpoints are the mod's own release numbers, so the whole range is
        // the mod talking about itself. It used to survive because the range branch
        // hard-coded its exclusion key to null.
        assert.deepEqual(
            tokens(v.extractVersionTokens('compatible 1.5.97 - 1.6.640', SKYRIM, {
                source: 'DESCRIPTION',
                requireCue: true,
                exclude: new Set(['1.5.97', '1.6.640'])
            })),
            []
        );
    });
});

test.describe('the shapes a publisher actually publishes', () => {
    test('a double digit patch outranks a single digit one', () => {
        // steamcmd-261550.json carries branches v1.2.7 through v1.2.12. Alphabetical
        // order, which is what the API returns them in, puts v1.2.10 above v1.2.7.
        assert.equal(v.compareVersions('1.2.12', '1.2.9'), 1);
        assert.equal(v.compareVersions('1.2.10', '1.2.9'), 1);
        assert.equal(v.compareVersions('1.2.10', '1.2.7'), 1);
        assert.equal(v.compareVersions('1.3.15', '1.3.4'), 1);
    });

    test('a recorded release line sorts newest first', () => {
        const line = ['1.0.0', '1.1.6', '1.2.7', '1.2.12', '1.3.4', '1.3.15', '1.4.5', '1.4.7'];
        const sorted = line.slice().sort((a, b) => v.compareVersions(b, a));
        assert.deepEqual(sorted, ['1.4.7', '1.4.5', '1.3.15', '1.3.4', '1.2.12', '1.2.7', '1.1.6', '1.0.0']);
    });
});
