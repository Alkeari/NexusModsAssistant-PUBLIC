'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { importSrc } = require('./harness.js');

// The pure modules of the content script and the background cache. Nothing here touches
// the DOM, chrome.* or the network, so these are behavior tests rather than a fake
// browser. DOM wiring, message routing and lifecycle are covered by the manual plan in
// docs/PRE-RELEASE-TESTS.md, and faking them here would give false confidence.

let report = null;
let errors = null;
let selectors = null;
let epoch = null;
let cache = null;
let messaging = null;
let selectionStore = null;
let filters = null;

test.before(async () => {
    report = await importSrc('src/content/report.ts');
    errors = await importSrc('src/content/errors.ts');
    selectors = await importSrc('src/content/selectors.ts');
    epoch = await importSrc('src/content/epoch.ts');
    cache = await importSrc('src/background/cache.ts');
    messaging = await importSrc('src/content/messaging.ts');
    selectionStore = await importSrc('src/content/selection-store.ts');
    filters = await importSrc('src/content/filters.ts');
});

test.describe('errors: what may be retried', () => {
    test('only the three transport codes are retryable', () => {
        // Retrying a rejected key or a disabled extension burns rate limit for nothing
        // and delays the honest message the user needs.
        for (const code of ['PORT_DISCONNECTED', 'PORT_TIMEOUT', 'RECEIVING_END']) {
            assert.equal(errors.isRetryable(new errors.NmaError(code, 'x')), true, code);
        }
        for (const code of ['CONTEXT_INVALID', 'CANCELED', 'DISABLED', 'BACKGROUND_ERROR']) {
            assert.equal(errors.isRetryable(new errors.NmaError(code, 'x')), false, code);
        }
    });

    test('a foreign error is not retryable, and absent input does not throw', () => {
        assert.equal(errors.isRetryable(new Error('PORT_TIMEOUT')), false);
        assert.equal(errors.isRetryable(null), false);
        assert.equal(errors.isRetryable(undefined), false);
        assert.equal(errors.isRetryable('PORT_TIMEOUT'), false);
    });

    test('an NmaError carries its code and detail intact', () => {
        const err = new errors.NmaError('PORT_TIMEOUT', 'took too long', {status: 504});
        assert.equal(err.code, 'PORT_TIMEOUT');
        assert.equal(err.message, 'took too long');
        assert.deepEqual(err.detail, {status: 504});
        assert.equal(err.name, 'NmaError');
        assert.ok(err instanceof Error);
    });
});

test.describe('classifyError: FAILED must stay distinguishable from UNKNOWN', () => {
    test('the HTTP forms the background actually emits are classified', () => {
        // Real strings from background.ts:213 and :216.
        assert.equal(report.classifyError(new Error('Nexus is not responding right now (HTTP 503).')).code, 'HTTP_503');
        assert.equal(report.classifyError(new Error('Nexus rejected the request (HTTP 404).')).code, 'HTTP_404');
        assert.equal(report.classifyError(new Error('Nexus rejected the request (HTTP 401).')).code, 'HTTP_401');
    });

    test('the precise Nexus API form is classified, though nothing currently emits it', () => {
        // statusFromMessage tries /Nexus API (\d{3})/ first. No string in src/ matches it:
        // the only "Nexus API " messages are the rate-limit sentence and "Nexus API request
        // failed". This assertion exists so that making the background emit the precise form
        // is a one-line change rather than a rediscovery.
        assert.equal(report.classifyError(new Error('Nexus API 404')).code, 'HTTP_404');
    });

    test('retryable is true for a rate limit and for Nexus being down, and false otherwise', () => {
        assert.equal(report.classifyError(new Error('(HTTP 429)')).retryable, true);
        assert.equal(report.classifyError(new Error('(HTTP 500)')).retryable, true);
        assert.equal(report.classifyError(new Error('(HTTP 503)')).retryable, true);
        assert.equal(report.classifyError(new Error('(HTTP 401)')).retryable, false);
        assert.equal(report.classifyError(new Error('(HTTP 403)')).retryable, false);
        assert.equal(report.classifyError(new Error('(HTTP 404)')).retryable, false);
    });

    test('a lost connection is offline, not a mod that does not exist', () => {
        assert.equal(report.classifyError(new Error('Failed to fetch')).code, 'OFFLINE');
        assert.equal(report.classifyError(new Error('NetworkError when attempting to fetch resource.')).code, 'OFFLINE');
        assert.equal(report.classifyError(new Error('Failed to fetch')).retryable, true);
    });

    test('a missing key says so instead of blaming the mod', () => {
        const failure = report.classifyError(new Error('API key not found. Add your Nexus API key in the extension popup.'));
        assert.equal(failure.code, 'NO_API_KEY');
        assert.equal(failure.retryable, false);
    });

    test('an unrecognized cause is UNEXPECTED and keeps the original text', () => {
        // Inventing a specific cause is the failure mode this module exists to prevent.
        const failure = report.classifyError(new Error('Nexus is down for maintenance'));
        assert.equal(failure.code, 'UNEXPECTED');
        assert.equal(failure.message, 'Nexus is down for maintenance');
        assert.equal(failure.retryable, false);
    });

    test('absent input yields a generic sentence rather than throwing', () => {
        for (const input of [null, undefined]) {
            const failure = report.classifyError(input);
            assert.equal(failure.code, 'UNEXPECTED');
            assert.equal(failure.message, 'Something went wrong.');
        }
    });

    test('an NmaError status in detail outranks any guess at the text', () => {
        const err = new errors.NmaError('BACKGROUND_ERROR', 'anything at all', {status: 403});
        assert.equal(report.classifyError(err).code, 'HTTP_403');
    });

    test('an NmaError with an unmapped status falls back to its own code', () => {
        const err = new errors.NmaError('BACKGROUND_ERROR', 'anything at all', {status: 999});
        const failure = report.classifyError(err);
        assert.equal(failure.code, 'BACKGROUND_ERROR');
        assert.equal(failure.message, 'anything at all');
    });

    test('an NmaError code with a user sentence uses that sentence', () => {
        assert.equal(report.classifyError(new errors.NmaError('DISABLED', 'x')).message, 'The extension is switched off.');
        assert.equal(report.classifyError(new errors.NmaError('CONTEXT_INVALID', 'x')).message, 'The extension was updated. Reload this page.');
        assert.equal(report.classifyError(new errors.NmaError('PORT_TIMEOUT', 'x')).retryable, true);
    });

    test('shortFailureLabel never returns an empty string', () => {
        // The label sits on the badge face. An empty one reads as a blank verdict.
        for (const code of ['HTTP_404', 'OFFLINE', 'PORT_TIMEOUT', 'DISABLED', 'UNEXPECTED', 'NOT_A_REAL_CODE']) {
            const label = report.shortFailureLabel({code, message: '', retryable: false});
            assert.equal(typeof label, 'string');
            assert.ok(label.length > 0, code);
        }
    });

    test('an unknown code degrades to the neutral label, never to a specific claim', () => {
        assert.equal(report.shortFailureLabel({code: 'NOT_A_REAL_CODE', message: '', retryable: false}), 'check failed');
    });
});

test.describe('extractModId: the link between a tile and every request about it', () => {
    test('every Nexus mod URL shape yields the id', () => {
        assert.equal(selectors.extractModId('/games/skyrimspecialedition/mods/266'), '266');
        assert.equal(selectors.extractModId('https://www.nexusmods.com/games/skyrimspecialedition/mods/266'), '266');
        assert.equal(selectors.extractModId('https://www.nexusmods.com/games/skyrimspecialedition/mods/266?tab=files'), '266');
        // The pre-2024 path shape, still served on old links.
        assert.equal(selectors.extractModId('/skyrimspecialedition/mods/266'), '266');
    });

    test('a URL with no mod id yields null rather than a guess', () => {
        // Returning something wrong here means requesting a different mod's data and
        // badging this tile with it.
        assert.equal(selectors.extractModId('/games/skyrimspecialedition/mods/'), null);
        assert.equal(selectors.extractModId('/games/skyrimspecialedition/mods'), null);
        assert.equal(selectors.extractModId('/users/12345'), null);
        assert.equal(selectors.extractModId(null), null);
        assert.equal(selectors.extractModId(''), null);
    });

    test('the id is returned as a string of digits only', () => {
        assert.equal(selectors.extractModId('/games/x/mods/12a'), '12');
        assert.equal(selectors.extractModId('/games/x/mods/007'), '007');
    });
});

test.describe('isTranslationCategory: which tile the popup setting hides', () => {
    test('both wordings Nexus uses for the category match', () => {
        assert.equal(filters.isTranslationCategory('Translation'), true);
        assert.equal(filters.isTranslationCategory('Translations'), true);
        assert.equal(filters.isTranslationCategory('translations'), true);
        assert.equal(filters.isTranslationCategory('  Translations  '), true);
    });

    test('a category that is not translations is left alone', () => {
        for (const category of ['Gameplay', 'Armour', 'Utilities', 'User Interface', 'Patches', '']) {
            assert.equal(filters.isTranslationCategory(category), false, category);
        }
    });

    test('an absent category is not a translation, because it is not an answer at all', () => {
        // null is what cardCategoryText returns when the tile exposes no category.
        // Treating it as a match would hide every tile on a page whose markup changed.
        assert.equal(filters.isTranslationCategory(null), false);
        assert.equal(filters.isTranslationCategory(undefined), false);
    });

    test('the mod title is not consulted, only the category', () => {
        // The predicate takes the category text alone. A mod called "Universal
        // Translator" is a gameplay mod, and hiding it would be a wrong verdict.
        assert.equal(filters.isTranslationCategory('Gameplay'), false);
    });

    test('the default is on, matching the popup checkbox', () => {
        // popup.ts reads `stored.hideTranslations ?? true`. If the two disagreed the
        // grid would filter against the opposite of what the popup shows.
        assert.equal(filters.getHideTranslations(), true);
        filters.setHideTranslations(false);
        assert.equal(filters.getHideTranslations(), false);
        filters.setHideTranslations(true);
    });
});

test.describe('epoch: the token that invalidates in-flight work', () => {
    test('each bump produces a strictly higher id and invalidates the previous token', () => {
        const before = epoch.getEpoch();
        const after = epoch.bumpEpoch({gameDomain: 'skyrimspecialedition'});
        assert.ok(after.id > before.id);
        assert.equal(epoch.isCurrent(after), true);
        assert.equal(epoch.isCurrent(before), false);
    });

    test('an omitted field carries forward and an empty string does not', () => {
        // bumpEpoch uses ??, so '' is a value, not an absence. Clearing the max version
        // in the popup has to reach the epoch, and it does.
        epoch.bumpEpoch({gameDomain: 'starfield', versionMin: '1.15.216', versionMax: '1.15.216'});
        const carried = epoch.bumpEpoch({});
        assert.equal(carried.gameDomain, 'starfield');
        assert.equal(carried.versionMin, '1.15.216');

        const cleared = epoch.bumpEpoch({versionMax: ''});
        assert.equal(cleared.versionMax, '');
        assert.equal(cleared.gameDomain, 'starfield');
    });

    test('absent input is not current', () => {
        assert.equal(epoch.isCurrent(null), false);
        assert.equal(epoch.isCurrent(undefined), false);
    });

    test('bumpEpoch called with no argument still bumps', () => {
        const before = epoch.getEpoch();
        const after = epoch.bumpEpoch();
        assert.equal(after.id, before.id + 1);
    });
});

test.describe('cacheDedup: one fetch per key while it is in flight', () => {
    test('concurrent callers share the single in-flight promise', async () => {
        cache.cacheClear();
        let calls = 0;
        const fetchOnce = () => new Promise(resolve => setTimeout(() => resolve(++calls), 5));

        const first = cache.cacheDedup('mod/266', fetchOnce, false);
        const second = cache.cacheDedup('mod/266', fetchOnce, false);
        assert.equal(first, second);
        assert.deepEqual(await Promise.all([first, second]), [1, 1]);
        assert.equal(calls, 1);
    });

    test('the key is released once the fetch settles, so a later call refetches', async () => {
        cache.cacheClear();
        let calls = 0;
        const fetchOnce = async () => ++calls;

        assert.equal(await cache.cacheDedup('mod/266', fetchOnce, false), 1);
        assert.equal(await cache.cacheDedup('mod/266', fetchOnce, false), 2);
    });

    test('a rejected fetch releases the key instead of pinning the failure forever', async () => {
        // The release is in a finally. Without it one network blip would make that mod
        // permanently unfetchable for the life of the service worker.
        cache.cacheClear();
        let calls = 0;
        const failThenSucceed = async () => {
            calls += 1;
            if (calls === 1) throw new Error('Failed to fetch');
            return 'ok';
        };

        await assert.rejects(cache.cacheDedup('mod/266', failThenSucceed, false), /Failed to fetch/);
        assert.equal(await cache.cacheDedup('mod/266', failThenSucceed, false), 'ok');
    });

    test('different keys are not deduplicated against each other', async () => {
        cache.cacheClear();
        const seen = [];
        const fetchKey = (key) => async () => {
            seen.push(key);
            return key;
        };
        assert.deepEqual(
            await Promise.all([
                cache.cacheDedup('mod/266', fetchKey('a'), false),
                cache.cacheDedup('mod/1334', fetchKey('b'), false)
            ]),
            ['a', 'b']
        );
        assert.equal(seen.length, 2);
    });

    test('the aux namespace outlives the Nexus sweep it must survive', () => {
        // Aux entries are Steam build lists and per-game known versions. They are kept in
        // a separate namespace precisely so the 12 hour Nexus sweep cannot take them.
        assert.ok(cache.AUX_CACHE_TTL_MS > cache.MOD_CACHE_TTL_MS);
    });
});

test.describe('selection persistence: what survives a full page load', () => {
    const entry = (modId, gameDomain, modName, fileIds) => [modId, {modId, gameDomain, modName, fileIds: new Set(fileIds)}];
    const map = (...entries) => new Map(entries);

    test('a saved selection comes back whole for the same game', () => {
        const raw = selectionStore.serializeSelection(map(
            entry('266', 'skyrimspecialedition', 'SkyUI', [1001, 1002]),
            entry('1334', 'skyrimspecialedition', 'SKSE', [])
        ), 1000);

        const restored = selectionStore.deserializeSelection(raw, 'skyrimspecialedition', 1000);
        assert.equal(restored.length, 2);
        assert.deepEqual(restored[0], {
            modId: '266',
            gameDomain: 'skyrimspecialedition',
            modName: 'SkyUI',
            fileIds: new Set([1001, 1002])
        });
        assert.deepEqual(restored[1].fileIds, new Set());
    });

    test('another game is not restored, because a mod id only means something in its own domain', () => {
        // The same rule dropSelectionsOutsideDomain enforces at runtime. Restoring
        // across games would tick a tile for a mod that is not the mod that was ticked.
        const raw = selectionStore.serializeSelection(map(
            entry('266', 'skyrimspecialedition', 'SkyUI', [1001]),
            entry('266', 'starfield', 'Something else', [77])
        ), 1000);
        const restored = selectionStore.deserializeSelection(raw, 'starfield', 1000);
        assert.equal(restored.length, 1);
        assert.equal(restored[0].modName, 'Something else');
    });

    test('an entry that recorded no game is kept rather than guessed at', () => {
        const raw = selectionStore.serializeSelection(map(entry('266', '', 'No domain recorded', [])), 1000);
        assert.equal(selectionStore.deserializeSelection(raw, 'starfield', 1000).length, 1);
    });

    test('a record older than the TTL is dropped, and one inside it is kept', () => {
        const raw = selectionStore.serializeSelection(map(entry('266', 'starfield', 'x', [])), 1000);
        assert.equal(selectionStore.deserializeSelection(raw, 'starfield', 1000 + selectionStore.SELECTION_TTL_MS - 1).length, 1);
        assert.equal(selectionStore.deserializeSelection(raw, 'starfield', 1000 + selectionStore.SELECTION_TTL_MS + 1).length, 0);
    });

    test('a record stamped in the future is distrusted the same as an expired one', () => {
        const raw = selectionStore.serializeSelection(map(entry('266', 'starfield', 'x', [])), 5_000_000_000);
        assert.equal(selectionStore.deserializeSelection(raw, 'starfield', 1000).length, 0);
    });

    test('absent, malformed or foreign records restore nothing instead of throwing', () => {
        // This is the page's own sessionStorage, so anything at all can be in the key.
        for (const raw of [
            null,
            '',
            'not json',
            '{}',
            '[]',
            '{"v":2,"savedAt":1000,"entries":[]}',
            '{"v":1,"entries":[]}',
            '{"v":1,"savedAt":"soon","entries":[]}',
            '{"v":1,"savedAt":1000,"entries":"all of them"}'
        ]) {
            assert.deepEqual(selectionStore.deserializeSelection(raw, 'starfield', 1000), [], String(raw));
        }
    });

    test('entries with no usable mod id are skipped, not restored as blanks', () => {
        const raw = JSON.stringify({v: 1, savedAt: 1000, entries: [
            {modId: '', gameDomain: 'starfield'},
            {modId: '   ', gameDomain: 'starfield'},
            {gameDomain: 'starfield'},
            {modId: 42, gameDomain: 'starfield'},
            {modId: '266', gameDomain: 'starfield'}
        ]});
        const restored = selectionStore.deserializeSelection(raw, 'starfield', 1000);
        assert.equal(restored.length, 1);
        assert.equal(restored[0].modId, '266');
    });

    test('a file id that is not a positive whole number never reaches the selection', () => {
        // A junk file id would be posted straight at the download endpoint.
        const raw = JSON.stringify({v: 1, savedAt: 1000, entries: [
            {modId: '266', gameDomain: 'starfield', fileIds: ['7', null, NaN, 1.5, -3, 0, 88]}
        ]});
        const restored = selectionStore.deserializeSelection(raw, 'starfield', 1000);
        assert.deepEqual(restored[0].fileIds, new Set([88]));
    });

    test('a page stuffed record is bounded rather than restored whole', () => {
        const entries = [];
        for (let i = 0; i < 600; i++) entries.push({modId: String(i), gameDomain: 'starfield', fileIds: []});
        const raw = JSON.stringify({v: 1, savedAt: 1000, entries});
        assert.equal(selectionStore.deserializeSelection(raw, 'starfield', 1000).length, 500);
    });

    test('a serialized record round trips through its own reader', () => {
        const original = map(entry('266', 'starfield', 'A mod', [1, 2, 3]));
        const restored = selectionStore.deserializeSelection(selectionStore.serializeSelection(original, 2000), 'starfield', 2000);
        assert.deepEqual(restored, [{modId: '266', gameDomain: 'starfield', modName: 'A mod', fileIds: new Set([1, 2, 3])}]);
    });
});

test.describe('nmaToDateInputValue: the value written into a date input', () => {
    test('a local date is formatted as the input element expects', () => {
        assert.equal(messaging.nmaToDateInputValue(new Date(2024, 0, 5)), '2024-01-05');
        assert.equal(messaging.nmaToDateInputValue(new Date(2024, 11, 31)), '2024-12-31');
        assert.equal(messaging.nmaToDateInputValue(new Date(2026, 7, 13)), '2026-08-13');
    });

    test('month and day are zero padded to two digits', () => {
        assert.equal(messaging.nmaToDateInputValue(new Date(2024, 8, 9)), '2024-09-09');
    });

    test('the date is read in local time, not UTC', () => {
        // Using toISOString here would shift the date by a day for anyone west of
        // Greenwich after 00:00 local, silently filtering out a day of mods.
        const lateLocalEvening = new Date(2024, 0, 5, 23, 30, 0);
        assert.equal(messaging.nmaToDateInputValue(lateLocalEvening), '2024-01-05');
    });
});

test.describe('runLimited: the requirements burst must not stall the grid', () => {
    // Each job here is a deferred promise, so the test controls exactly how many are
    // in flight. Nothing touches chrome.* or the network: the limiter is pure.
    const deferred = () => {
        let settle;
        const promise = new Promise(resolve => { settle = resolve; });
        return {promise, settle};
    };

    test('a saturated compat lane does not delay a requirements job', async () => {
        const started = [];
        const gates = [];
        const start = (key, lane) => {
            const gate = deferred();
            gates.push(gate);
            return messaging.runLimited(key, () => {
                started.push(key);
                return gate.promise;
            }, lane);
        };

        // Six is the compat lane's whole allowance, so the seventh compat job queues.
        const running = [];
        for (let i = 0; i < 6; i++) running.push(start(`compat/${i}`, messaging.COMPAT_LANE));
        running.push(start('compat/queued', messaging.COMPAT_LANE));
        running.push(start('req/0', messaging.REQUIREMENTS_LANE));

        await new Promise(resolve => setTimeout(resolve, 0));
        assert.equal(started.includes('req/0'), true, 'the requirements job ran');
        assert.equal(started.includes('compat/queued'), false, 'the seventh compat job waited');

        gates.forEach(g => g.settle('done'));
        await Promise.all(running);
    });

    test('the requirements lane has its own smaller cap and drains in order', async () => {
        const started = [];
        const gates = [];
        const start = (key) => {
            const gate = deferred();
            gates.push(gate);
            return messaging.runLimited(key, () => {
                started.push(key);
                return gate.promise;
            }, messaging.REQUIREMENTS_LANE);
        };

        const running = [start('r/0'), start('r/1'), start('r/2'), start('r/3')];
        await new Promise(resolve => setTimeout(resolve, 0));
        assert.deepEqual(started, ['r/0', 'r/1', 'r/2']);

        gates[0].settle('done');
        await new Promise(resolve => setTimeout(resolve, 0));
        assert.deepEqual(started, ['r/0', 'r/1', 'r/2', 'r/3']);

        gates.forEach(g => g.settle('done'));
        await Promise.all(running);
    });

    test('the lane defaults to compat, so an unchanged call site keeps its old queue', async () => {
        const gate = deferred();
        const promise = messaging.runLimited('lane/default', () => gate.promise);
        gate.settle('ok');
        assert.equal(await promise, 'ok');
    });

    test('dedup is global: the same key in another lane shares the one request', async () => {
        let calls = 0;
        const gate = deferred();
        const job = () => {
            calls += 1;
            return gate.promise;
        };
        const first = messaging.runLimited('dedup/266', job, messaging.COMPAT_LANE);
        const second = messaging.runLimited('dedup/266', job, messaging.REQUIREMENTS_LANE);
        assert.equal(first, second);
        gate.settle('shared');
        assert.deepEqual(await Promise.all([first, second]), ['shared', 'shared']);
        assert.equal(calls, 1);
    });

    test('cancelQueued drains every lane, and rejects rather than truncates', async () => {
        const gates = [];
        const start = (key, lane) => {
            const gate = deferred();
            gates.push(gate);
            return messaging.runLimited(key, () => gate.promise, lane);
        };

        const running = [];
        for (let i = 0; i < 6; i++) running.push(start(`c/live/${i}`, messaging.COMPAT_LANE));
        for (let i = 0; i < 3; i++) running.push(start(`r/live/${i}`, messaging.REQUIREMENTS_LANE));
        const queuedCompat = start('c/queued', messaging.COMPAT_LANE);
        const queuedReq = start('r/queued', messaging.REQUIREMENTS_LANE);

        messaging.cancelQueued('Navigation changed');
        await assert.rejects(queuedCompat, err => err.code === 'CANCELED');
        await assert.rejects(queuedReq, err => err.code === 'CANCELED');

        gates.forEach(g => g.settle('done'));
        await Promise.all(running);
    });
});

test.describe('nmaGenerateRouteToken: distinguishing one navigation from the next', () => {
    test('two tokens generated back to back are different', () => {
        // Equal tokens would let a response from the previous page badge the new one.
        const seen = new Set();
        for (let i = 0; i < 1000; i++) {
            seen.add(messaging.nmaGenerateRouteToken());
        }
        assert.equal(seen.size, 1000);
    });
});

test.describe('statusFromMessage: a status needs context, not just three digits', () => {
    test('a bare status shaped number in prose is not read as an HTTP status', () => {
        // "This mod is not available (deleted, hidden, or wrong game)" is a statement about
        // the mod. NMA must not make it because a number that happens to be 404 appeared
        // somewhere in an error string. The distinction the module header protects is
        // exactly this one: FAILED means "could not look", not "looked and it is gone".
        assert.equal(report.classifyError(new Error('Could not read mod 404 from the grid')).code, 'UNEXPECTED');
        assert.equal(report.classifyError(new Error('Timed out after 500 ms')).code, 'UNEXPECTED');

        // The forms production really emits must keep classifying after the fix.
        assert.equal(report.classifyError(new Error('Nexus is not responding right now (HTTP 503).')).code, 'HTTP_503');
        assert.equal(report.classifyError(new Error('Nexus rejected the request (HTTP 404).')).code, 'HTTP_404');
    });

    test('a mod name or a size that contains a status shaped number stays UNEXPECTED', () => {
        for (const raw of [
            'Could not check Fallout 404',
            'Fallout 404 - Enhanced Edition failed',
            'Response body was 503 bytes',
            'Waited 429 ms for the grid',
            'Mod 500 has no files'
        ]) {
            const failure = report.classifyError(new Error(raw));
            assert.equal(failure.code, 'UNEXPECTED', raw);
            assert.equal(failure.message, raw);
        }
    });

    test('the background throw sites that label a status still classify', () => {
        // Real strings from background.ts:727, :866, :1593 and :1633. They carry no
        // "HTTP", so dropping them would trade one wrong answer for a lost right one.
        assert.equal(report.classifyError(new Error('Download popup 403')).code, 'HTTP_403');
        assert.equal(report.classifyError(new Error('Failed to load mod page for requirements: 404')).code, 'HTTP_404');
        assert.equal(report.classifyError(new Error('Steam storesearch 503')).code, 'HTTP_503');
        assert.equal(report.classifyError(new Error('SteamCMD 500')).code, 'HTTP_500');
    });

    test('the generic status wordings classify too', () => {
        assert.equal(report.classifyError(new Error('Request failed, status 429')).code, 'HTTP_429');
        assert.equal(report.classifyError(new Error('status code: 401')).code, 'HTTP_401');
        assert.equal(report.classifyError(new Error('HTTP/1.1 502 Bad Gateway')).code, 'HTTP_502');
    });

    test('a labeled number that is not a status NMA maps stays UNEXPECTED', () => {
        // 418 has no entry in HTTP_MESSAGES, so the fallback must be the honest one
        // rather than an invented HTTP_418 badge with an empty sentence.
        const failure = report.classifyError(new Error('Nexus rejected the request (HTTP 418).'));
        assert.equal(failure.code, 'UNEXPECTED');
        assert.equal(failure.message, 'Nexus rejected the request (HTTP 418).');
    });
});
