'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const nodeModule = require('node:module');
const { importSrc, typescriptAvailable } = require('./harness.js');

// The suite is only as honest as its ability to load the code it claims to test. A
// harness that silently degrades reports green while testing nothing, so the checks
// below are deliberately loud: they fail the run rather than skipping it.

test('the runtime supports the synchronous module hooks the harness needs', () => {
    // Without registerHooks nothing under src/ can be imported at all, and a suite that
    // skipped in that case would say "passed" when it meant "could not look".
    assert.equal(typeof nodeModule.registerHooks, 'function',
        'node:module.registerHooks is missing. Node 22.15 or newer is required to run this suite.');
});

test('the TypeScript compiler the harness transpiles with is installed', () => {
    assert.equal(typescriptAvailable, true, 'run npm install: the typescript devDependency is missing');
});

// Each entry names exports that must be real values after transpilation. A strip-only
// failure or a broken resolver surfaces as a MISSING NAMED EXPORT rather than as a
// throw, so asserting the module object is non-null would not catch it.
const IMPORTABLE = [
    ['src/background/versions.ts', [
        'parseVersion', 'compareVersions', 'isCompatible', 'isKnownGameVersion', 'extractVersionTokens',
        // The harvest. Every build the extension knows is derived through these, so a
        // missing one is not a smaller suite, it is a game with no versions at all.
        'readVersionCore', 'canonicalVersionKey', 'makeVersionObservation', 'mergeVersionObservations',
        'isCorroboratedOrigin', 'buildGameNameCues', 'extractCuedVersionCandidates',
        'matchStoreTitle', 'pickStoreApp', 'normalizeVersionForDisplay',
        'versionRangeFromToken', 'rangesOverlap', 'formatVersionToken'
    ]],
    ['src/background/cache.ts', ['cacheDedup', 'cacheClear', 'cacheGet', 'cacheSet', 'fetchNexusCached']],
    ['src/background/sso.ts', ['startSso', 'cancelSso', 'getSsoStatus']],
    ['src/content/errors.ts', ['NmaError', 'isRetryable']],
    ['src/content/epoch.ts', ['getEpoch', 'isCurrent', 'bumpEpoch']],
    ['src/content/selectors.ts', ['extractModId', 'findCards', 'checkLayout', 'badgeMountPoint']],
    ['src/content/report.ts', ['classifyError', 'shortFailureLabel', 'reportToUser']],
    ['src/content/messaging.ts', ['request', 'nmaToDateInputValue', 'nmaGenerateRouteToken', 'runLimited']],
    ['src/content/filters.ts', ['applyFilters', 'toggleStatus', 'getDateFilterReport']],
    ['src/content/lifecycle.ts', ['createScope', 'mountSurface', 'unmountSurface', 'isSurfaceMounted']],
    ['src/content/context.ts', ['isContextAlive', 'assertContextAlive', 'isContextInvalidatedError']],
    ['src/content/observers.ts', ['initObservers', 'collectCards', 'isCardVisible']],
    ['src/content/badges.ts', ['STATUS_CONFIG', 'FILTERABLE_STATUSES', 'initBadges']]
];

test.describe('every module the suite depends on loads with its exports intact', () => {
    for (const [relativePath, exportNames] of IMPORTABLE) {
        test(relativePath, async () => {
            const loaded = await importSrc(relativePath);
            for (const name of exportNames) {
                assert.notEqual(loaded[name], undefined, `${relativePath} does not export ${name}`);
            }
        });
    }
});

test('the resolver only rewrites specifiers inside src/', () => {
    // A resolver that reached outside the project would change how node:test itself
    // loads, which is the kind of harness bug that produces confident wrong results.
    assert.doesNotThrow(() => require('node:path'));
    assert.doesNotThrow(() => require('../scripts/lib/nma.js'));
});

test('lifecycle.ts scopes work after transpilation, parameter property included', () => {
    // src/content/lifecycle.ts:26 uses `constructor(readonly name: string) {}`, which is
    // the one construct in the content tree that Node's strip-only mode refuses. If this
    // assertion fails the harness has quietly stopped compiling and started stripping.
    return importSrc('src/content/lifecycle.ts').then((lifecycle) => {
        const scope = lifecycle.createScope('badges');
        assert.equal(scope.name, 'badges');
    });
});
