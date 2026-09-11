'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { importSrc } = require('./harness.js');
const fixtures = require('./fixtures.js');

/**
 * The harvester decides every verdict now.
 *
 * NMA ships no version list. Each build it knows is derived at runtime from a public,
 * keyless source, and the derivation is a handful of pure steps: read one recorded string
 * and refuse it or keep it, give two spellings of one build the same identity, fold many
 * sightings into one ordered list, decide whether a cue in mod text vouches for a number,
 * and accept or refuse a store listing as this game's app. Those steps are what this file
 * tests, against responses those endpoints really gave.
 *
 * No test here makes a network request. Everything is read out of tests/fixtures, which
 * tests/fixtures/record.js writes and tests/fixtures/provenance.json describes. Nothing
 * below names a game as a condition: a game name that appears is DATA, read from a
 * recorded response and passed in as an argument.
 */

let v = null;

test.before(async () => {
    v = await importSrc('src/background/versions.ts');
});

// Read off the recorded filenames rather than typed out, so the sweep covers whatever
// record.js last recorded instead of whatever someone remembered to list here.
const COLLECTION_DOMAINS = fixtures.fixtureFiles()
    .map(name => /^nexus-collections-(.+)\.json$/.exec(name))
    .filter(Boolean)
    .map(match => match[1])
    .sort();

/**
 * The branch and news readers the worker performs before it merges. They live here
 * because a payload has to be walked before its strings become observations, and the
 * merge contract starts at the observation. Nothing in them is game aware.
 */
function branchesOf(appInfo) {
    const out = [];
    const visit = (node) => {
        if (!node || typeof node !== 'object') return;
        const branches = node.branches || node.Branches;
        if (branches && typeof branches === 'object') {
            for (const [key, value] of Object.entries(branches)) {
                out.push({ key, time: Number(value?.timeupdated || 0), description: String(value?.description || '') });
            }
        }
        Object.values(node).forEach(visit);
    };
    visit(appInfo);
    return out;
}

function branchObservations(appId) {
    return branchesOf(fixtures.steamAppInfo(appId))
        .map(branch => v.makeVersionObservation(branch.key, 'STEAM_BRANCH', branch.time))
        .filter(Boolean);
}

const TITLE_VERSION_RE = /\b[a-z]?\d+(?:\.\d+){1,4}\b/gi;

function announcementObservations(appId) {
    const out = [];
    for (const item of fixtures.steamNews(appId).appnews.newsitems) {
        const matches = String(item.title || '').match(TITLE_VERSION_RE) || [];
        for (const raw of matches) {
            const observation = v.makeVersionObservation(raw, 'STEAM_ANNOUNCEMENT', Number(item.date) || 0);
            if (observation) out.push(observation);
        }
    }
    return out;
}

const labelsOf = (entries) => entries.map(entry => entry.label);
const keysOf = (entries) => entries.map(entry => entry.key);

test.describe('the fixtures are real responses and say where they came from', () => {
    test('every recorded file has a stated source', () => {
        // A fixture with no provenance is a number somebody typed, which is the one thing
        // the whole design forbids.
        for (const file of fixtures.fixtureFiles()) {
            const source = fixtures.sourceOf(file);
            assert.ok(source && source.length > 20, `${file} has no usable entry in provenance.json`);
        }
    });

    test('the recorded responses still hold the shapes the tests read', () => {
        // If a re-record changed the shape, every assertion below would be testing an
        // empty array and passing.
        for (const domain of COLLECTION_DOMAINS) {
            assert.ok(fixtures.collectionReferences(domain).length > 0, `${domain} recorded no collection references`);
        }
        assert.ok(fixtures.modNodes().length >= 20);
        assert.ok(fixtures.steamNews('261550').appnews.newsitems.length >= 20);
        assert.ok(branchesOf(fixtures.steamAppInfo('261550')).length >= 40);
        assert.ok(branchesOf(fixtures.steamAppInfo('294100')).length >= 20);
        assert.ok((fixtures.storeSearch('dirt2').items || []).length > 0);
    });
});

test.describe('readVersionCore: what a recorded string is allowed to become', () => {
    test('a trailing zero component is kept in the core and dropped in the identity', () => {
        // "1.6.640.0" is how a collection records the build a publisher announces as
        // "1.6.640". Two rows for one build is how the same version came to appear twice.
        assert.equal(v.readVersionCore('1.6.640.0').core, '1.6.640.0');
        assert.equal(v.canonicalVersionKey('1.6.640.0'), v.canonicalVersionKey('1.6.640'));
        assert.equal(v.canonicalVersionKey('1.6.1170.0'), v.canonicalVersionKey('1.6.1170'));
    });

    test('a platform variant is refused rather than folded into the game it is not', () => {
        // "1.4.15.0-VR" and "1.2.72.0-VR" are real references. Stripping the suffix would
        // file a VR build under the flat game, and keeping the suffix would put letters on
        // a badge. Neither is a build of the game whose page the user is on.
        assert.equal(v.readVersionCore('1.4.15.0-VR'), null);
        assert.equal(v.readVersionCore('1.2.72.0-VR'), null);
    });

    test('an empty field and a zero-major revision counter are refused', () => {
        // Both are real: "" from one game's collection data, "0.0.1.3" from another's.
        assert.equal(v.readVersionCore(''), null);
        assert.equal(v.readVersionCore('   '), null);
        assert.equal(v.readVersionCore(null), null);
        assert.equal(v.readVersionCore('0.0.1.3'), null);
    });

    test('a trailing annotation word is dropped and the version kept', () => {
        // "1.3.3389 rev40" arrives with a carriage return and a newline attached as well.
        const raw = fixtures.collectionReferences('rimworld')[0];
        assert.match(raw, /rev40/);
        assert.equal(v.readVersionCore(raw).core, '1.3.3389');
    });

    test('a second version-shaped word refuses the whole value', () => {
        // A field holding two versions is a range or a list, and choosing an end of it is
        // guessing. Refusing costs one game a row; guessing wrong costs every verdict.
        assert.equal(v.readVersionCore('1.5.97 - 1.6.640'), null);
        assert.equal(v.readVersionCore('1.6.640 1.6.1170'), null);
        // A word that carries no version of its own is an annotation and is dropped.
        assert.equal(v.readVersionCore('1.6.640 or later').core, '1.6.640');
    });

    test('a prefix letter is separated from the number, and both spellings key alike', () => {
        // "v1.2.9" and "1.7.0" sit in one game's collection data together.
        const prefixed = v.readVersionCore('v1.2.9');
        assert.equal(prefixed.prefix, 'v');
        assert.equal(prefixed.core, '1.2.9');
        assert.equal(prefixed.label, 'v1.2.9');
        assert.equal(v.canonicalVersionKey(prefixed.core), v.canonicalVersionKey('1.2.9'));
    });

    test('a long build id survives and merges with nothing', () => {
        // "4.1.1.7398727" is a real current build. Its last component is not padding, so
        // the trailing-zero rule must not reach it.
        assert.equal(v.readVersionCore('4.1.1.7398727').core, '4.1.1.7398727');
        assert.equal(v.canonicalVersionKey('4.1.1.7398727'), '4.1.1.7398727');
        assert.notEqual(v.canonicalVersionKey('4.1.1.7398727'), v.canonicalVersionKey('4.1.1'));
        // A different scheme inside one game's data is still a version and is kept.
        assert.equal(v.readVersionCore('3.0.70.58535').core, '3.0.70.58535');
    });

    test('reading a core twice changes nothing', () => {
        for (const raw of ['1.6.640.0', 'v1.2.9', '1.3.3389 rev40', '3.0.70.58535', '4.1.1.7398727']) {
            const once = v.readVersionCore(raw);
            const twice = v.readVersionCore(once.label);
            assert.equal(twice.core, once.core, raw);
            assert.equal(twice.label, once.label, raw);
        }
    });

    test('nothing is invented: every digit kept was in the input, in order', () => {
        // The one property that has to hold for every string any source ever sends. A
        // harvester that manufactures a plausible version to fill a gap is the failure
        // this whole design exists to prevent.
        for (const domain of COLLECTION_DOMAINS) {
            for (const reference of fixtures.collectionReferences(domain)) {
                const read = v.readVersionCore(reference);
                if (!read) continue;
                assert.ok(
                    String(reference).replace(/\s+/g, ' ').trim().startsWith(read.label),
                    `${domain}: ${JSON.stringify(reference)} produced ${read.label}`
                );
            }
        }
    });
});

test.describe('normalizing the collection references seven games really returned', () => {
    // Recorded output, asserted in full rather than sampled, so a change to the rules
    // shows up as the exact strings a user would gain or lose.
    const EXPECTED = {
        skyrimspecialedition: ['1.6.640.0', '1.6.1170.0', '1.6.353.0', '1.5.97.0'],
        rimworld: ['1.3.3389'],
        cyberpunk2077: ['2.3.1.0', '2.2.0.0', '3.0.70.58535', '2.2.1.0', '2.3.0.0', '3.0.76.64179'],
        starfield: ['1.14.74.0', '1.7.36.0', '1.7.23.0', '1.7.29.0', '1.16.244.0', '1.12.36.0', '1.8.86.0', '1.7.33.0', '1.14.70.0', '1.10.32.0'],
        fallout4: ['1.10.163.0', '1.10.984.0', '1.11.191.0'],
        baldursgate3: ['4.69.95.620', '4.72.9.685', '4.50.22.896', '4.1.1.7209685', '4.67.58.295', '4.1.1.7398727', '4.69.46.847', '4.71.51.330', '4.68.48.561', '4.68.97.358', '4.69.31.813'],
        mountandblade2bannerlord: ['1.0.1', 'v1.2.9', '1.7.0', '1.8.0', '1.7.1', '1.7.2', 'v1.2.11', '1.0.0.0', 'v1.3.15', '1.8.1', '1.0.0', '1.2.5', '1.0.2']
    };

    test('every recorded collection response is swept', () => {
        // A domain recorded but not expected would otherwise be swept by nothing and the
        // suite would report a pass for a response it never read.
        assert.ok(COLLECTION_DOMAINS.length >= 7, 'the collection fixtures went missing');
        assert.deepEqual(COLLECTION_DOMAINS, Object.keys(EXPECTED).sort());
    });

    for (const domain of COLLECTION_DOMAINS) {
        test(domain, () => {
            const seen = [];
            for (const reference of fixtures.collectionReferences(domain)) {
                const read = v.readVersionCore(reference);
                if (read && !seen.includes(read.label)) seen.push(read.label);
            }
            assert.deepEqual(seen, EXPECTED[domain]);
        });
    }

    test('one build recorded under two spellings becomes one row', () => {
        // "1.0.0" and "1.0.0.0" are both in one game's recorded references, and they are
        // the same build written twice.
        const observations = fixtures.collectionReferences('mountandblade2bannerlord')
            .map(reference => v.makeVersionObservation(reference, 'COLLECTION'))
            .filter(Boolean);
        const merged = v.mergeVersionObservations(observations);
        const keys = keysOf(merged);
        assert.equal(new Set(keys).size, keys.length, `duplicate keys in ${keys.join(', ')}`);
        assert.equal(keys.filter(key => key === '1.0').length, 1);
    });
});

test.describe('the branch filter, on the branches two games really publish', () => {
    test('a branch name that is not a version yields no observation', () => {
        // Every one of these is a real branch key. The filter is structural: one optional
        // leading letter, then digits and dots. It names no publisher and no game.
        for (const key of ['public', 'beta', 'local', 'perf_test', 'perf_test_beta', 'unstable', 'v1.3.7_launcher_watchdog', 'v1.3.9_launcher_opengl_fix', 'v137_warsails_beta', 'alpha13', 'version-1.6.4633']) {
            assert.equal(v.readVersionCore(key), null, key);
        }
    });

    test('a game whose branches are all named some other way yields nothing at all', () => {
        // This is the honest empty state, and it is the commonest one: on a random sample
        // of the catalog, four games in ten yield no version from any source. Every one
        // of this game's 21 branches is named "version-1.6.4633" style or "alpha13", and
        // none of them is a version string.
        const observations = branchObservations('294100');
        assert.deepEqual(observations, []);
        assert.deepEqual(v.mergeVersionObservations(observations), []);
    });

    test('the announcements of that same game carry what its branches do not', () => {
        // The two Steam sources are not interchangeable, and this is the pair that shows
        // it: zero version-shaped branches, six builds named in announcement titles. A
        // design that read only branches would report nothing for this game and be wrong.
        const merged = v.mergeVersionObservations([
            ...branchObservations('294100'),
            ...announcementObservations('294100')
        ]);
        assert.deepEqual(labelsOf(merged), ['1.6.4850', '1.6.4630', '1.6.4566', '1.6.4543', '1.6.4535', '1.6.4528', '1.6']);
        assert.ok(merged.every(entry => entry.origin === 'STEAM_ANNOUNCEMENT'));
        // Two separate posts name the line "1.6" alone. That is one build, twice.
        assert.equal(merged.find(entry => entry.key === '1.6').corroboration, 2);
    });

    test('the version-named branches of a game that uses them all survive', () => {
        const labels = branchObservations('261550').map(observation => observation.label).sort();
        assert.deepEqual(labels, [
            'e1.7.0', 'e1.7.1', 'e1.7.2', 'e1.8.1', 'e1.9.0',
            'v1.0.0', 'v1.0.1', 'v1.0.2', 'v1.0.3',
            'v1.1.0', 'v1.1.1', 'v1.1.2', 'v1.1.3', 'v1.1.4', 'v1.1.5', 'v1.1.6',
            'v1.2.0', 'v1.2.10', 'v1.2.11', 'v1.2.12', 'v1.2.7', 'v1.2.8', 'v1.2.9',
            'v1.3.10', 'v1.3.11', 'v1.3.12', 'v1.3.13', 'v1.3.14', 'v1.3.15',
            'v1.3.4', 'v1.3.5', 'v1.3.6', 'v1.3.7', 'v1.3.8', 'v1.3.9',
            'v1.4.5', 'v1.4.6', 'v1.4.7'
        ]);
    });
});

test.describe('merging and ordering, on one game real branches and real announcements', () => {
    let merged = null;

    test.before(async () => {
        v = v || await importSrc('src/background/versions.ts');
        merged = v.mergeVersionObservations([...branchObservations('261550'), ...announcementObservations('261550')]);
    });

    test('a build published as a branch and named in an announcement is one row', () => {
        // The recorded titles name v1.4.7 and v1.4.5, and the recorded branches publish
        // both. On the raw label those are two rows.
        const keys = keysOf(merged);
        assert.equal(new Set(keys).size, keys.length);
        for (const key of ['1.4.7', '1.4.5']) {
            const rows = merged.filter(entry => entry.key === key);
            assert.equal(rows.length, 1, `${key} appears ${rows.length} times`);
            assert.deepEqual(rows[0].sources.slice().sort(), ['STEAM_ANNOUNCEMENT', 'STEAM_BRANCH']);
            assert.ok(rows[0].corroboration >= 2);
        }
    });

    test('a build only an announcement names is kept, and says so', () => {
        // The newest build in this data was announced before its branch appeared. Dropping
        // it because no branch carries it would hide the version users are actually on.
        const newest = merged.find(entry => entry.key === '1.4.8');
        assert.ok(newest, 'the announced build 1.4.8 is missing');
        assert.deepEqual(newest.sources, ['STEAM_ANNOUNCEMENT']);
    });

    test('the release line comes first and the early access line last', () => {
        // Requirement 6, on real multi-line data. The e-line numbers ABOVE the v-line
        // (e1.9.0 against v1.4.7) and predates all of it, so ordering on the number alone
        // puts the oldest builds on top. Which line is newer is read from the timestamps,
        // never hardcoded.
        const lines = labelsOf(merged).map(label => (/^[a-z]/i.test(label) ? label[0].toLowerCase() : ''));
        const firstEarly = lines.indexOf('e');
        const lastRelease = lines.lastIndexOf('v');
        assert.ok(firstEarly > 0, 'no early access line in the merged data');
        assert.ok(lastRelease < firstEarly, `a v-line row at ${lastRelease} sits below the e-line starting at ${firstEarly}`);
    });

    test('a double-digit patch outranks a single-digit one inside a line', () => {
        // Alphabetical order, which is what the API returns branches in, puts 1.2.10 below
        // 1.2.9. This is the pair the ordering exists for.
        const labels = labelsOf(merged);
        assert.ok(labels.indexOf('v1.2.10') < labels.indexOf('v1.2.9'), labels.join(' '));
        assert.ok(labels.indexOf('v1.2.12') < labels.indexOf('v1.2.10'));
        assert.ok(labels.indexOf('v1.4.7') < labels.indexOf('v1.4.6'));
    });

    test('the whole release line is in strict newest-first order', () => {
        const release = merged.filter(entry => entry.prefix === 'v');
        for (let i = 1; i < release.length; i++) {
            assert.equal(
                v.compareVersions(release[i - 1].core, release[i].core),
                1,
                `${release[i - 1].label} should be newer than ${release[i].label}`
            );
        }
    });

    test('a title naming two version lines at once contributes both, with no special case', () => {
        // The recorded titles pair a component's version with the game's: "WS v1.2.8 / BL
        // v1.4.8". Both are version-shaped and both are harvested. Reading one of them as
        // meaning something particular would be a rule about one title and nothing else.
        assert.ok(merged.some(entry => entry.key === '1.2.8'));
        assert.ok(merged.some(entry => entry.key === '1.4.8'));
    });
});

test.describe('merging: what one spelling of a build is allowed to do to another', () => {
    test('the spelling the publisher used as a branch name wins', () => {
        const merged = v.mergeVersionObservations([
            v.makeVersionObservation('1.4.0', 'STEAM_ANNOUNCEMENT', 1775740888),
            v.makeVersionObservation('v1.4.0', 'STEAM_BRANCH', 1775000000)
        ]);
        assert.deepEqual(labelsOf(merged), ['v1.4.0']);
        assert.equal(merged[0].corroboration, 2);
    });

    test('an article body never displaces a published build, however recent it is', () => {
        // The body of a patch-note post, and of the press items the unfiltered feed mixes
        // in, is prose full of numbers that are not versions.
        const merged = v.mergeVersionObservations([
            v.makeVersionObservation('v1.4.7', 'STEAM_BRANCH', 1783516947),
            v.makeVersionObservation('1.4.7', 'STEAM_NEWS', 1786363746)
        ]);
        assert.equal(merged.length, 1);
        assert.equal(merged[0].origin, 'STEAM_BRANCH');
        assert.equal(merged[0].label, 'v1.4.7');
    });

    test('a collection reference and a branch of the same build are one row from two sources', () => {
        const merged = v.mergeVersionObservations([
            v.makeVersionObservation('1.6.640.0', 'COLLECTION'),
            v.makeVersionObservation('1.6.640', 'STEAM_ANNOUNCEMENT', 1690000000)
        ]);
        assert.equal(merged.length, 1);
        assert.equal(merged[0].key, '1.6.640');
        assert.deepEqual(merged[0].sources.slice().sort(), ['COLLECTION', 'STEAM_ANNOUNCEMENT']);
        assert.equal(merged[0].corroboration, 2);
    });

    test('nothing in, nothing out', () => {
        assert.deepEqual(v.mergeVersionObservations([]), []);
        assert.deepEqual(v.mergeVersionObservations([null, undefined].filter(Boolean)), []);
    });

    test('every origin is either corroborating or not, and the set is closed', () => {
        // A verdict is graded by where its evidence came from, so the whole set has to be
        // decided rather than the two ends of it.
        const origins = ['STEAM_BRANCH', 'STEAM_ANNOUNCEMENT', 'COLLECTION', 'MOD_TEXT', 'STEAM_NEWS'];
        const decided = origins.map(origin => [origin, v.isCorroboratedOrigin(origin)]);
        assert.deepEqual(decided, [
            ['STEAM_BRANCH', true],
            ['STEAM_ANNOUNCEMENT', true],
            ['COLLECTION', true],
            ['MOD_TEXT', true],
            ['STEAM_NEWS', false]
        ]);
    });
});

test.describe('the mod-text cue, built from the game display name the catalog publishes', () => {
    // Read out of a recorded response, never typed into an assertion. The catalog spells
    // this game's name with a different capitalisation from the one its own modders use,
    // which is exactly why the cue is folded rather than compared.
    const game = () => fixtures.nexusGame('RimWorld', 'rimworld');
    const cues = () => v.buildGameNameCues(game().name, game().domainName);

    test('the cue comes from the catalog entry, not from anything written here', () => {
        const entry = game();
        assert.equal(entry.domainName, 'rimworld');
        assert.ok(entry.name.length > 0);
        assert.ok(cues().length > 0);
        // A name that folds to nothing usable yields no cue rather than a cue that matches
        // everything.
        assert.deepEqual(v.buildGameNameCues('', ''), []);
        assert.deepEqual(v.buildGameNameCues(null, null), []);
    });

    test('the two mod titles the sample really carries both state a build', () => {
        // Both strings are recorded: the first is inside one mod's description, the second
        // is another mod's whole title.
        const options = { cues: cues(), allowGenericCue: false };
        assert.deepEqual(v.extractCuedVersionCandidates('RimWorld Tweaks (RimWorld 1.6)', options), ['1.6']);
        assert.deepEqual(v.extractCuedVersionCandidates('MOD BMW XM FOR RIMWORLD 1.6', options), ['1.6']);
    });

    test('a list of builds after one cue yields all of them', () => {
        // A real summary from the sample. "Supported: RimWorld 1.4, 1.5, 1.6" states three
        // builds and a scan that only took the number nearest the cue would report one.
        const summary = fixtures.modNodes().map(node => node.summary).find(text => /Supported: RimWorld 1\.4/.test(text || ''));
        assert.ok(summary, 'the recorded sample no longer carries the list summary this test reads');
        const got = v.extractCuedVersionCandidates(summary, { cues: cues(), allowGenericCue: false });
        assert.deepEqual(got.sort(), ['1.4', '1.5', '1.6']);
    });

    test('another game name does not vouch for this game text', () => {
        // The cue is the game's own name and nothing else. Supplied here from a different
        // recorded catalog entry, so the negative case is data too.
        const other = fixtures.nexusGame('Skyrim Special Edition', 'skyrimspecialedition');
        const got = v.extractCuedVersionCandidates('MOD BMW XM FOR RIMWORLD 1.6', {
            cues: v.buildGameNameCues(other.name, other.domainName),
            allowGenericCue: false
        });
        assert.deepEqual(got, []);
    });

    test('a cue too far in front of the number does not carry', () => {
        const options = { cues: cues(), allowGenericCue: false };
        assert.deepEqual(v.extractCuedVersionCandidates(`RimWorld ${'x'.repeat(40)} 1.6`, options), []);
        assert.deepEqual(v.extractCuedVersionCandidates('RimWorld version 1.6', options), ['1.6']);
    });

    test('a number with no cue at all is not a game version', () => {
        assert.deepEqual(v.extractCuedVersionCandidates('Adds 1.6 tonnes of steel', { cues: [], allowGenericCue: false }), []);
        assert.deepEqual(v.extractCuedVersionCandidates('', { cues: cues() }), []);
        assert.deepEqual(v.extractCuedVersionCandidates(null, { cues: cues() }), []);
    });
});

test.describe('the sentence-splitting trap', () => {
    test('a version survives text that a sentence split would tear apart', () => {
        // The trap, stated as a test so it cannot come back: a version contains '.', so
        // splitting the text into sentences on '.' first cuts "1.6" into "1" and "6" and
        // every game yields nothing. The first assertion shows the damage; the second
        // shows the scanner does not take it.
        const game = fixtures.nexusGame('RimWorld', 'rimworld');
        const cues = v.buildGameNameCues(game.name, game.domainName);
        const description = fixtures.modNodes().find(node => /RimWorld 1\.6/i.test(node.description || '')).description;

        const sentences = description.split('.');
        assert.ok(!sentences.some(part => /RimWorld\s*1\.6/i.test(part)),
            'the recorded text no longer demonstrates the trap');

        const got = v.extractCuedVersionCandidates(description, { cues, allowGenericCue: false });
        assert.ok(got.includes('1.6'), `whole-text scan lost the version: ${got.join(', ')}`);
    });

    test('the same holds for the shortest real case', () => {
        const game = fixtures.nexusGame('RimWorld', 'rimworld');
        const cues = v.buildGameNameCues(game.name, game.domainName);
        const title = 'MOD BMW XM FOR RIMWORLD 1.6';
        assert.deepEqual(title.split('.'), ['MOD BMW XM FOR RIMWORLD 1', '6']);
        assert.deepEqual(v.extractCuedVersionCandidates(title, { cues, allowGenericCue: false }), ['1.6']);
    });
});

test.describe("a mod's own release number never votes for itself", () => {
    test('the mod version field is excluded even when the game name sits in front of it', () => {
        // Built from one recorded mod's own fields: its title carries the game name, and
        // its release number follows. Without the exclusion the mod states a game build by
        // existing, which is the defect that put "Compatible - v1.2.5" on a mod that
        // supported nothing of the sort.
        const game = fixtures.nexusGame('RimWorld', 'rimworld');
        const cues = v.buildGameNameCues(game.name, game.domainName);
        const node = fixtures.modNodes().find(entry => entry.modId === 761);
        assert.equal(node.version, '1.0.1');

        const text = `${node.name} ${node.version} (RimWorld 1.6)`;
        const own = v.parseVersion(node.version).numbers.join('.');

        const unguarded = v.extractCuedVersionCandidates(text, { cues, allowGenericCue: false });
        assert.ok(unguarded.includes('1.0.1'), 'the recorded fields no longer demonstrate the hazard');

        const guarded = v.extractCuedVersionCandidates(text, { cues, allowGenericCue: false, exclude: new Set([own]) });
        assert.deepEqual(guarded, ['1.6']);
    });

    test('across the whole recorded sample no mod votes for its own number', () => {
        const game = fixtures.nexusGame('RimWorld', 'rimworld');
        const cues = v.buildGameNameCues(game.name, game.domainName);
        for (const node of fixtures.modNodes()) {
            const parsed = v.parseVersion(node.version);
            if (!parsed) continue;
            const own = parsed.numbers.join('.');
            const text = [node.name, node.summary, node.description].filter(Boolean).join('\n');
            const got = v.extractCuedVersionCandidates(text, {
                cues,
                allowGenericCue: false,
                exclude: new Set([own])
            });
            for (const candidate of got) {
                assert.notEqual(v.parseVersion(candidate).numbers.join('.'), own, `mod ${node.modId} voted for its own ${node.version}`);
            }
        }
    });
});

test.describe('corroboration across the mod sample the endpoint really returned', () => {
    test('the build the sample agrees on is the one that carries the count', () => {
        // 50 mods, keyless, as recorded. This is the source that works for a game with no
        // Steam presence at all, and it is also the weakest, which is why the count
        // travels with the row instead of every sighting becoming a build.
        const game = fixtures.nexusGame('RimWorld', 'rimworld');
        const cues = v.buildGameNameCues(game.name, game.domainName);

        const observations = [];
        for (const node of fixtures.modNodes()) {
            const parsed = v.parseVersion(node.version);
            const exclude = new Set(parsed ? [parsed.numbers.join('.')] : []);
            const text = [node.name, node.summary, node.description].filter(Boolean).join('\n');
            for (const candidate of v.extractCuedVersionCandidates(text, { cues, allowGenericCue: false, exclude })) {
                const observation = v.makeVersionObservation(candidate, 'MOD_TEXT');
                if (observation) observations.push(observation);
            }
        }

        const merged = v.mergeVersionObservations(observations);
        const counts = Object.fromEntries(merged.map(entry => [entry.key, entry.corroboration]));
        assert.deepEqual(counts, { '1.6': 12, '1.5': 3, '1.4': 1 });

        // A floor of two mods is what separates a build the community states from one
        // author's typo, and the count is what lets a caller apply one. The floor is a
        // caller's decision, so it is applied here rather than assumed.
        const corroborated = merged.filter(entry => entry.corroboration >= 2).map(entry => entry.key);
        assert.deepEqual(corroborated, ['1.6', '1.5']);
    });

    test('a game whose authors never state a build yields nothing from this source', () => {
        // The honest empty state again, from the other direction: no cue, no candidates,
        // no observations, no list. Six games in ten in a random sample end here.
        const merged = v.mergeVersionObservations(
            ['A mod that adds 3 new weapons', 'Fixes the 2 broken doors']
                .flatMap(text => v.extractCuedVersionCandidates(text, { cues: ['rimworld'], allowGenericCue: false }))
                .map(candidate => v.makeVersionObservation(candidate, 'MOD_TEXT'))
                .filter(Boolean)
        );
        assert.deepEqual(merged, []);
    });
});

test.describe('binding a store listing to a catalog entry', () => {
    test('an exact name in a different capitalisation binds', () => {
        // The catalog spells it one way and the store another. Case is not a difference.
        const game = fixtures.nexusGame('RimWorld', 'rimworld');
        const picked = v.pickStoreApp(game.name, fixtures.storeSearch('rimworld').items);
        assert.ok(picked, 'the exact store listing was refused');
        assert.equal(picked.id, 294100);
        assert.notEqual(picked.name, game.name);
        assert.equal(picked.name.toLowerCase(), game.name.toLowerCase());
    });

    test('the search that returns another game entirely is refused', () => {
        // The recorded search for this catalog entry returns a different racing game
        // first and never returns the game itself. Binding to it harvested that game's
        // version list: a complete, plausible, entirely wrong answer, which is worse than
        // no answer at all.
        const game = fixtures.nexusGame('DiRT 2', 'dirt2');
        const items = fixtures.storeSearch('dirt2').items;
        assert.ok(items.some(item => item.id === 690790), 'the recorded search no longer shows the mis-bind');
        assert.equal(v.pickStoreApp(game.name, items), null);
    });

    test('the rule is stated in the numbers and the tail, not in a list of games', () => {
        // Two conditions, both structural. Same numbers in both titles, and the shorter
        // title is the END of the longer one: a store prefixes a franchise, while a
        // trailing qualifier is a different product every time.
        assert.equal(v.matchStoreTitle('DiRT 2', 'DiRT Rally 2.0'), null);
        assert.equal(v.matchStoreTitle('RimWorld', 'RimWorld - Odyssey'), null);
        assert.equal(v.matchStoreTitle('Skyrim Special Edition', 'Skyrim Special Edition: Creation Kit'), null);
        assert.deepEqual(v.matchStoreTitle('Skyrim Special Edition', 'The Elder Scrolls V: Skyrim Special Edition'), {extras: 4});
        assert.deepEqual(v.matchStoreTitle('RimWorld', 'RimWorld'), {extras: 0});
    });

    test('an ampersand and an accent are spelling, not identity', () => {
        const game = fixtures.nexusGame('Mount & Blade II: Bannerlord', 'mountandblade2bannerlord');
        assert.ok(v.matchStoreTitle(game.name, 'Mount and Blade II: Bannerlord'));
        assert.ok(v.matchStoreTitle('Pokemon Legends', 'Pok' + String.fromCharCode(0xe9) + 'mon Legends'));
    });

    test('two listings equally close is ambiguity, and ambiguity is refused', () => {
        // Breaking the tie by order would make the answer depend on how the store sorted
        // its results that day.
        const tied = [{name: 'Alpha Game', type: 'app'}, {name: 'Alpha Game', type: 'app'}];
        assert.equal(v.pickStoreApp('Alpha Game', tied), null);
        assert.equal(v.pickStoreApp('Alpha Game', []), null);
        assert.equal(v.pickStoreApp('Alpha Game', null), null);
    });

    test('anything the store does not call an app is not a candidate', () => {
        const items = [{name: 'Alpha Game', type: 'bundle'}, {name: 'Alpha Game', type: 'app', id: 7}];
        assert.equal(v.pickStoreApp('Alpha Game', items).id, 7);
    });
});
