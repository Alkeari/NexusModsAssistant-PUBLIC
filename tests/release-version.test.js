'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const nma = require('../scripts/lib/nma');

// These are the store manifest version rules, not the Nexus mod version rules. Both
// stores accept 1 to 4 dot separated integers, each 0-65535, not all zero. Every string
// below is a real version string taken off Nexus Mods or out of this repository, so the
// expectations record what the release pipeline will actually do with them.

test.describe('parseVersion accepts what the stores accept', () => {
    test('accepts one to four numeric parts', () => {
        assert.deepEqual(nma.parseVersion('3'), [3]);
        assert.deepEqual(nma.parseVersion('3.1'), [3, 1]);
        assert.deepEqual(nma.parseVersion('3.1.0'), [3, 1, 0]);
        assert.deepEqual(nma.parseVersion('1.6.1170'), [1, 6, 1170]);
        assert.deepEqual(nma.parseVersion('2.4.11'), [2, 4, 11]);
    });

    test('rejects a leading v, which Nexus mod pages use constantly', () => {
        assert.equal(nma.parseVersion('v2.0'), null);
        assert.equal(nma.parseVersion('V3.1.0'), null);
    });

    test('rejects prerelease and build suffixes', () => {
        assert.equal(nma.parseVersion('1.5.97-beta'), null);
        assert.equal(nma.parseVersion('2.0.1-rc2'), null);
        assert.equal(nma.parseVersion('1.6.640+hotfix'), null);
    });

    test('rejects a part above the 65535 store limit', () => {
        // A real Bannerlord build number. Four parts is legal, this value is not.
        assert.equal(nma.parseVersion('4.1.1.5849914'), null);
        assert.equal(nma.parseVersion('1.6.65536'), null);
        assert.deepEqual(nma.parseVersion('1.6.65535'), [1, 6, 65535]);
    });

    test('rejects more than four parts', () => {
        assert.equal(nma.parseVersion('1.2.3.4.5'), null);
        assert.deepEqual(nma.parseVersion('1.2.3.4'), [1, 2, 3, 4]);
    });

    test('rejects leading zeroes, which the stores treat as malformed', () => {
        assert.equal(nma.parseVersion('2.01'), null);
        assert.equal(nma.parseVersion('01.0.0'), null);
    });

    test('rejects an all zero version', () => {
        assert.equal(nma.parseVersion('0'), null);
        assert.equal(nma.parseVersion('0.0.0'), null);
        assert.deepEqual(nma.parseVersion('0.0.1'), [0, 0, 1]);
    });

    test('rejects empty, null and undefined rather than throwing', () => {
        assert.equal(nma.parseVersion(''), null);
        assert.equal(nma.parseVersion(null), null);
        assert.equal(nma.parseVersion(undefined), null);
        assert.equal(nma.parseVersion('   '), null);
        assert.equal(nma.parseVersion({}), null);
    });
});

test.describe('compareVersions is numeric, never lexicographic', () => {
    test('orders a four digit patch above a three digit one', () => {
        // Skyrim SE 1.6.1170 against 1.6.640. String comparison gets this backwards.
        assert.equal(nma.compareVersions('1.6.1170', '1.6.640'), 1);
        assert.equal(nma.compareVersions('1.6.640', '1.6.1170'), -1);
    });

    test('orders a two digit minor above a one digit one', () => {
        assert.equal(nma.compareVersions('1.10', '1.9'), 1);
        assert.equal(nma.compareVersions('1.9', '1.10'), -1);
    });

    test('treats a missing trailing part as zero', () => {
        assert.equal(nma.compareVersions('1.6', '1.6.0'), 0);
        assert.equal(nma.compareVersions('3', '3.0.0.0'), 0);
        assert.equal(nma.compareVersions('1.6.1', '1.6'), 1);
    });

    test('reports equality for identical versions', () => {
        assert.equal(nma.compareVersions('3.1.0', '3.1.0'), 0);
    });

    test('refuses to guess at an unparseable version', () => {
        // Silently returning 0 here would let a release upload a version the store
        // has already published.
        assert.throws(() => nma.compareVersions('v2.0', '2.0'), /Cannot compare versions/);
        assert.throws(() => nma.compareVersions('1.5.97-beta', '1.5.97'), /Cannot compare versions/);
        assert.throws(() => nma.compareVersions('', '1.0.0'), /Cannot compare versions/);
        assert.throws(() => nma.compareVersions(null, '1.0.0'), /Cannot compare versions/);
        assert.throws(() => nma.compareVersions('4.1.1.5849914', '4.1.1'), /Cannot compare versions/);
    });
});

test.describe('bumpVersion moves in one direction only', () => {
    test('bumps each level', () => {
        assert.equal(nma.bumpVersion('3.1.0', 'patch'), '3.1.1');
        assert.equal(nma.bumpVersion('3.1.0', 'minor'), '3.2.0');
        assert.equal(nma.bumpVersion('3.1.0', 'major'), '4.0.0');
    });

    test('pads a short version to three parts before bumping', () => {
        assert.equal(nma.bumpVersion('3', 'patch'), '3.0.1');
        assert.equal(nma.bumpVersion('3.1', 'minor'), '3.2.0');
    });

    test('every bump is strictly greater than its input', () => {
        for (const level of ['patch', 'minor', 'major']) {
            for (const from of ['1.6.1170', '2.4.11', '3.1.0', '1.10']) {
                assert.equal(nma.compareVersions(nma.bumpVersion(from, level), from), 1);
            }
        }
    });

    test('rejects an unknown level instead of defaulting to patch', () => {
        assert.throws(() => nma.bumpVersion('3.1.0', 'hotfix'), /Unknown bump level/);
    });

    test('rejects an unparseable current version', () => {
        assert.throws(() => nma.bumpVersion('v2.0', 'patch'), /Unparseable current version/);
        assert.throws(() => nma.bumpVersion('', 'patch'), /Unparseable current version/);
        assert.throws(() => nma.bumpVersion(null, 'patch'), /Unparseable current version/);
    });
});
