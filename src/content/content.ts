import {
    nmaConnectPort, nmaRejectAllPending,
    nmaNotifyRouteToken, nmaGenerateRouteToken, nmaToDateInputValue,
    request, runLimited, cancelQueued, closePort, REQUIREMENTS_LANE
} from './messaging';
import {
    initObservers, isCardVisible,
    ensureScrollAcceleration, accelerateVisibleHidden,
    addPendingHidden, clearPendingHidden,
    clearPendingLowTimer, resetScrollState
} from './observers';
import {
    STATUS_CONFIG,
    initBadges,
    attachInlineIndicator,
    toggleRequirementFilesDropdown,
    sweepOrphanBadges,
    refreshOpenFileLists
} from './badges';
import {
    setExclusionPhrases,
    getShowOldFiles, setShowOldFiles,
    getShowUpdateFiles, setShowUpdateFiles,
    getShowOptionalFiles, setShowOptionalFiles,
    getShowMiscFiles, setShowMiscFiles,
    getLastUpdatedStart, setLastUpdatedStart,
    getLastUpdatedEnd, setLastUpdatedEnd,
    setHideTranslations, getTranslationFilterReport,
    applyFilters, unhideAllCards, setFiltersAppliedHandler
} from './filters';
import {
    getSelection, clearSelection, clearAllSelections,
    ensureSelectionControl, restorePersistedSelection,
    syncSelectionCheckbox, updateSelectionButton,
    syncAllSelectionCheckboxes, dropSelectionsOutsideDomain
} from './file-picker';
import {
    initDownloads,
    getModFilesEntry, setModFilesEntry,
    getFileCategory, fetchModFilesList,
    updateControlPanelSummary,
    checkAndPromptDependencies,
    runFileDownloads, isBatchInFlight,
    clearModFilesCache, showNmaModal, abortBatch
} from './downloads';
import {
    injectFilterBar, getStatusListElement,
    resetPanelState, isPanelMounted, setPanelNote,
    hydratePanelCollapse
} from './panel';
import { createScope, unmountAllSurfaces } from './lifecycle';
import { getEpoch, bumpEpoch, isCurrent } from './epoch';
import { setContextShutdownHandler, isContextAlive } from './context';
import { reportToUser, clearNotices, forgetNotice, forgetRouteNotices, classifyError, shortFailureLabel } from './report';
import {
    findGrid, findCards, modLink, extractModId, pageGameDomain, extractGameDomain,
    isSkeletonGrid, checkLayout, findDetailHeader, findDetailTitleTarget,
    findRequirementTables, cardUpdatedAt
} from './selectors';
import { t } from '../i18n';
import type { CompatibilityResult } from '../types';

const BOOT_DEADLINE_MS = 15000;
const BOOT_POLL_MS = 600;
const HEALTH_CHECK_MS = 1500;
const ROUTE_POLL_MS = 750;
const EPOCH_KEYS = ['targetGameDomain', 'targetVersion', 'targetVersionEnd'];

let rootScope = null;
let routeScope = null;
let routeWatcherScope = null;
let currentRouteSignature = null;
let routeGeneration = 0;
let navHooksRegistered = false;
let nmaRouteToken = '';
let rescanTimer = null;
let sweepScheduled = false;
let modulesWired = false;
let config = {hasApiKey: false, matchesTarget: false, targetDomain: '', targetVersion: '', targetVersionEnd: ''};

console.info('NMA extension: content script booted.');

setContextShutdownHandler(reason => stopExtension(reason));
setFiltersAppliedHandler(report => {
    updateFilterNote(report);
    scheduleVisibilitySweep();
});

waitForHydration().then(async () => {
    const prefs = await chrome.storage.local.get([
        'extensionEnabled',
        'exclusionPhrases',
        'showOldFiles',
        'showUpdateFiles',
        'showOptionalFiles',
        'showMiscFiles',
        'lastUpdatedDays',
        'lastUpdatedStart',
        'lastUpdatedEnd',
        'hideTranslations',
        'panelCollapsed'
    ]);

    hydrateFilterState(prefs);
    wireModules();
    hydratePanelCollapse(prefs.panelCollapsed === true);

    if (prefs.extensionEnabled === false) {
        console.info('NMA extension: disabled via settings.');
        return;
    }

    startExtension();
}).catch(err => console.error('NMA extension: hydration failed', err));

function hydrateFilterState(prefs) {
    if (prefs.exclusionPhrases) {
        setExclusionPhrases(prefs.exclusionPhrases.split(',').map(p => p.trim().toLowerCase()).filter(p => p));
    }

    setShowOldFiles(prefs.showOldFiles === true);
    setShowUpdateFiles(prefs.showUpdateFiles !== false);
    setShowOptionalFiles(prefs.showOptionalFiles !== false);
    setShowMiscFiles(prefs.showMiscFiles !== false);
    // Same default as the popup checkbox, or the two would disagree about what
    // an unset key means and the grid would filter against the opposite of what
    // the popup shows.
    setHideTranslations(prefs.hideTranslations !== false);
    setLastUpdatedStart(prefs.lastUpdatedStart || '');
    setLastUpdatedEnd(prefs.lastUpdatedEnd || '');

    if (!getLastUpdatedStart() && !getLastUpdatedEnd() && (prefs.lastUpdatedDays || 0) > 0) {
        const days = prefs.lastUpdatedDays || 0;
        const end = new Date();
        const start = new Date();
        start.setDate(end.getDate() - days);
        setLastUpdatedStart(nmaToDateInputValue(start));
        setLastUpdatedEnd(nmaToDateInputValue(end));
        chrome.storage.local.set({
            lastUpdatedStart: getLastUpdatedStart(),
            lastUpdatedEnd: getLastUpdatedEnd(),
            lastUpdatedDays: 0
        }).catch(() => console.warn('NMA extension: could not migrate the date filter.'));
    }
}

function wireModules() {
    if (modulesWired) return;
    modulesWired = true;

    initObservers((card, gen) => fetchCompatibility(card, gen, 'HIGH'));

    initDownloads({
        getRouteGeneration: () => routeGeneration,
        getRouteToken: () => nmaRouteToken,
        fetchCompatibility: (card, gen, priority) => fetchCompatibility(card, gen, priority)
    });

    initBadges({
        getModFiles: (key) => getModFilesEntry(key),
        setModFiles: (key, files) => setModFilesEntry(key, files),
        getSelection: () => getSelection(),
        getShowOldFiles: () => getShowOldFiles(),
        getShowUpdateFiles: () => getShowUpdateFiles(),
        getShowOptionalFiles: () => getShowOptionalFiles(),
        getShowMiscFiles: () => getShowMiscFiles(),
        fetchModFilesList,
        getFileCategory,
        syncSelectionCheckbox,
        updateSelectionButton,
        checkAndPromptDependencies,
        runFileDownloads
    });
}

// ── Start / stop ─────────────────────────────────────────────────────

export function startExtension() {
    if (rootScope?.alive) return;
    if (!isContextAlive()) return;

    wireModules();
    restoreSelections();
    const scope = createScope('nma');
    rootScope = scope;
    nmaConnectPort();
    nmaRouteToken = nmaGenerateRouteToken();
    nmaNotifyRouteToken(nmaRouteToken);

    // Configuration is read before the first pass, or the first pass runs
    // against defaults and paints every tile as unconfigured.
    refreshConfiguration()
        .catch(err => console.warn('NMA extension: could not read settings', err))
        .then(() => {
            if (scope !== rootScope || !scope.alive) return;
            try {
                startRouteWatcher();
            } catch (err) {
                console.error('NMA extension: failed to start route watcher', err);
            }
        });
}

// A tick is user work, and a full page load used to throw it away silently.
// It is restored per game domain, and the user is told where the ticks came
// from and given the way out in the same sentence.
function restoreSelections() {
    const restored = restorePersistedSelection(pageGameDomain());
    if (restored === 0) return;
    reportToUser({
        level: 'info',
        code: 'SELECTION_RESTORED',
        message: t(restored === 1 ? 'content_selectionRestoredOne' : 'content_selectionRestoredMany', [String(restored)]),
        detail: t('content_selectionRestoredDetail'),
        action: {
            label: t('content_clearSelectionAction'),
            run: () => {
                clearAllSelections();
                forgetNotice('SELECTION_RESTORED');
            }
        }
    });
}

export function stopExtension(reason = 'stopped') {
    if (!rootScope) return;
    console.info('NMA extension: stopping -', reason);

    if (rescanTimer !== null) {
        clearTimeout(rescanTimer);
        rescanTimer = null;
    }

    // Order matters: surfaces first, then the scopes that own everything else.
    // Closing the modal alone would let the batch loop walk on to the next mod.
    abortBatch(reason);
    unmountAllSurfaces();
    resetPanelState();
    routeScope?.dispose();
    routeScope = null;
    routeWatcherScope = null;
    rootScope.dispose();
    rootScope = null;

    cancelQueued(reason);
    nmaRejectAllPending(reason);
    closePort();
    resetScrollState();
    clearPendingHidden();
    clearSelection();
    clearModFilesCache();
    clearNotices();

    // The page must be left exactly as Nexus rendered it. Filter-hidden mods
    // stay invisible otherwise, with no extension UI left to bring them back.
    purgeCardDecorations();
    unhideAllCards();
    sweepOrphanBadges();
    document.querySelectorAll('.nma-inline-wrapper, .nma-select-anchor, .nma-files-dropdown, .nma-modal-overlay').forEach(el => el.remove());
    document.getElementById('nma-setup-banner')?.remove();
    bumpEpoch();
}

// Registered outside every scope: this is how a switched-off extension learns
// it was switched back on.
chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;

    if (changes.extensionEnabled) {
        if (changes.extensionEnabled.newValue === false) {
            stopExtension('disabled by user');
        } else {
            // Idempotent restart: no page reload, so scroll position and any
            // ticked selections in other tabs survive.
            startExtension();
        }
        return;
    }

    if (!rootScope?.alive) return;

    if (changes.exclusionPhrases) {
        const val = changes.exclusionPhrases.newValue || '';
        setExclusionPhrases(val.split(',').map(p => p.trim().toLowerCase()).filter(p => p));
        const input = document.getElementById('nma-exclusion-input') as HTMLInputElement | null;
        if (input && input.value !== val) input.value = val;
        applyFilters();
    }

    syncCategoryToggle(changes, 'showOldFiles', setShowOldFiles, getShowOldFiles, 'nma-toggle-old-files', true);
    syncCategoryToggle(changes, 'showUpdateFiles', setShowUpdateFiles, getShowUpdateFiles, 'nma-toggle-update-files', false);
    syncCategoryToggle(changes, 'showOptionalFiles', setShowOptionalFiles, getShowOptionalFiles, 'nma-toggle-optional-files', false);
    syncCategoryToggle(changes, 'showMiscFiles', setShowMiscFiles, getShowMiscFiles, 'nma-toggle-misc-files', false);

    if (changes.downloadMode) {
        const select = document.getElementById('nma-download-mode') as HTMLSelectElement | null;
        if (select && select.value !== changes.downloadMode.newValue) {
            select.value = changes.downloadMode.newValue || 'MANUAL';
        }
    }

    if (changes.hideTranslations) {
        setHideTranslations(changes.hideTranslations.newValue !== false);
        applyFilters();
    }

    if (changes.lastUpdatedStart) {
        setLastUpdatedStart(changes.lastUpdatedStart.newValue || '');
        const input = document.getElementById('nma-last-updated-start') as HTMLInputElement | null;
        if (input && input.value !== String(getLastUpdatedStart())) input.value = String(getLastUpdatedStart());
        applyFilters();
    }

    if (changes.lastUpdatedEnd) {
        setLastUpdatedEnd(changes.lastUpdatedEnd.newValue || '');
        const input = document.getElementById('nma-last-updated-end') as HTMLInputElement | null;
        if (input && input.value !== String(getLastUpdatedEnd())) input.value = String(getLastUpdatedEnd());
        applyFilters();
    }

    if (changes.nexusApiKey || EPOCH_KEYS.some(k => k in changes)) {
        scheduleRescan();
    }
});

function syncCategoryToggle(changes, key, setter, getter, inputId, defaultsOff) {
    if (!changes[key]) return;
    setter(defaultsOff ? changes[key].newValue === true : changes[key].newValue !== false);
    const toggle = document.getElementById(inputId) as HTMLInputElement | null;
    if (toggle && toggle.checked !== getter()) toggle.checked = getter();
    refreshOpenFileLists();
}

// ── Configuration ────────────────────────────────────────────────────

async function refreshConfiguration() {
    const prefs = await chrome.storage.local.get(['nexusApiKey', 'targetGameDomain', 'targetVersion', 'targetVersionEnd']);
    const pageDomain = pageGameDomain();

    config = {
        hasApiKey: !!(prefs.nexusApiKey && String(prefs.nexusApiKey).trim()),
        matchesTarget: prefs.targetGameDomain === pageDomain && !!prefs.targetVersion,
        targetDomain: prefs.targetGameDomain || '',
        targetVersion: prefs.targetVersion || '',
        targetVersionEnd: prefs.targetVersionEnd || ''
    };

    bumpEpoch({
        gameDomain: config.matchesTarget ? pageDomain : '',
        versionMin: config.targetVersion,
        versionMax: config.targetVersionEnd || config.targetVersion
    });

    announceConfiguration(pageDomain);
    return config;
}

function announceConfiguration(pageDomain) {
    forgetNotice('NO_API_KEY');
    forgetNotice('NOT_TARGETED');

    if (!config.hasApiKey) {
        reportToUser({
            level: 'info',
            code: 'NO_API_KEY',
            message: t('content_noticeNoApiKey'),
            detail: t('content_noticeNoApiKeyDetail'),
            action: {label: t('content_openSettings'), run: openSettings}
        });
        return;
    }

    if (!config.matchesTarget) {
        reportToUser({
            level: 'info',
            code: 'NOT_TARGETED',
            message: config.targetDomain && config.targetDomain !== pageDomain
                ? t('content_noticeOtherGame', [config.targetDomain, pageDomain])
                : t('content_noticeNoTarget'),
            detail: t('content_noticeNotTargetedDetail'),
            action: {label: t('content_useThisGame'), run: () => promptForTarget(pageDomain)}
        });
    }
}

function openSettings() {
    request({type: 'OPEN_POPUP'}, {timeoutMs: 3000, tries: 1, allowWhileDisabled: true})
        .catch(() => {
            // The background could not open it; a page-initiated open is blocked
            // unless popup.html is web accessible, so say so rather than fail mute.
            reportToUser({
                level: 'warn',
                code: 'OPEN_POPUP_FAILED',
                message: t('content_noticeOpenPopupManually')
            });
        });
}

function promptForTarget(pageDomain) {
    // Any earlier "nothing was saved" warning is about a dialog that is now
    // being reopened, so it stops being true the moment this one appears.
    forgetNotice('TARGET_NOT_SAVED');

    const body = document.createElement('div');
    const label = document.createElement('div');
    label.textContent = t('content_targetPromptQuestion', [pageDomain]);

    const listId = `nma-derived-versions-${Date.now()}`;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'nma-modal-input';
    input.placeholder = t('content_targetVersionPlaceholder');
    input.value = config.targetVersion || '';
    input.setAttribute('list', listId);

    const options = document.createElement('datalist');
    options.id = listId;

    // The three states this line can be in are different statements: still
    // looking, looked and found nothing, could not look. None may read as any
    // of the others, and none may read as a complete list.
    const status = document.createElement('div');
    status.className = 'nma-modal-note';
    status.textContent = t('content_targetVersionsDeriving');

    body.appendChild(label);
    body.appendChild(input);
    body.appendChild(options);
    body.appendChild(status);

    fillDerivedVersions(pageDomain, options, status, input);

    showNmaModal({
        title: t('content_targetModalTitle'),
        body,
        confirmText: t('content_save'),
        cancelText: t('content_cancel'),
        onConfirm: async () => {
            const version = input.value.trim();
            if (!version) {
                // Closing on an empty box used to write nothing and say nothing,
                // which reads as a save that happened.
                reportToUser({
                    level: 'warn',
                    code: 'TARGET_NOT_SAVED',
                    message: t('content_targetNotSaved'),
                    detail: t('content_targetNotSavedDetail'),
                    action: {label: t('content_tryAgain'), run: () => promptForTarget(pageDomain)}
                });
                return;
            }
            // The whole tuple is written, or the previous game's upper bound
            // survives and judges these mods against another game's build.
            await chrome.storage.local.set({
                targetGameDomain: pageDomain,
                targetVersion: version,
                targetVersionEnd: version,
                lastSelectedGame: {name: pageDomain, domain: pageDomain},
                lastVersion: version,
                lastVersionEnd: version
            });
        }
    });
}

/**
 * Fills the target dialog from the background's version harvest. No game is
 * named and nothing is bundled: the same request is made for every domain, and
 * a domain with no public version data says so rather than showing a blank list
 * that would read as a complete one.
 */
async function fillDerivedVersions(pageDomain, options, status, input) {
    try {
        const result = await request<any>({type: 'GET_GAME_VERSIONS', gameDomain: pageDomain}, {timeoutMs: 15000, tries: 2});
        const entries = Array.isArray(result?.versions) ? result.versions
            : Array.isArray(result?.entries) ? result.entries : [];

        const seen = new Set();
        const labels = [];
        entries.forEach(entry => {
            const record = entry && typeof entry === 'object' ? entry : null;
            const value = String(record ? (record.version ?? record.label ?? record.value ?? '') : (entry ?? '')).trim();
            if (!value || seen.has(value)) return;
            seen.add(value);

            const declared = record ? (record.sources ?? record.source ?? record.origin) : null;
            const sources = (Array.isArray(declared) ? declared : declared ? [declared] : [])
                .map(code => String(code).toLowerCase().replace(/_/g, ' '))
                .filter(Boolean);
            labels.push({value, provenance: sources.slice(0, 2).join(' + ')});
        });

        if (labels.length === 0) {
            status.textContent = t('content_targetVersionsNone');
            return;
        }

        labels.forEach(entry => {
            const option = document.createElement('option');
            option.value = entry.value;
            // The browser shows an option's text beside its value, which is where
            // a number that looks wrong becomes traceable to what supplied it.
            if (entry.provenance) option.textContent = entry.provenance;
            options.appendChild(option);
        });

        status.textContent = t(labels.length === 1 ? 'content_targetVersionsFoundOne' : 'content_targetVersionsFoundMany', [String(labels.length)]);
        if (!input.value) input.value = labels[0].value;
    } catch (error) {
        status.textContent = t('content_targetVersionsFailed', [shortFailureLabel(classifyError(error))]);
    }
}

// ── Route lifecycle ──────────────────────────────────────────────────

function startRouteWatcher() {
    currentRouteSignature = getRouteKey();
    routeWatcherScope = rootScope.child('route-watcher');
    routeWatcherScope.interval(handleNavigationChange, ROUTE_POLL_MS);
    registerNavigationHooks();
    beginRoute();
}

function getRouteKey() {
    return `${window.location.pathname}|${window.location.search}|${window.location.hash}`;
}

function beginRoute() {
    if (!rootScope?.alive) return;
    routeScope?.dispose();
    routeGeneration += 1;
    const generation = routeGeneration;
    const scope = rootScope.child(`route:${generation}`);
    routeScope = scope;
    nmaRouteToken = nmaGenerateRouteToken();
    nmaNotifyRouteToken(nmaRouteToken);
    bumpEpoch();

    // config.matchesTarget is derived from the page's game domain, and an
    // in-site navigation can change that domain. Without this the epoch advances
    // carrying the previous page's game, so tiles on the game the user actually
    // configured paint NOT_CONFIGURED until they reload or touch a setting.
    refreshConfiguration()
        .catch(() => { /* startModProcessing still runs on the last known config */ })
        .then(() => {
            if (generation !== routeGeneration || !scope.alive) return;
            startModProcessing(generation, scope);
        });
}

function handleNavigationChange() {
    // The navigation hooks are patched into history once and cannot be unpatched,
    // so a stopped extension must refuse the work rather than rebuild itself.
    if (!rootScope?.alive) return;
    const nextKey = getRouteKey();
    if (nextKey === currentRouteSignature) return;
    currentRouteSignature = nextKey;
    resetForNewRoute();
    beginRoute();
}

function registerNavigationHooks() {
    if (navHooksRegistered) return;
    navHooksRegistered = true;
    const navigationEvent = () => {
        // Defer past React's commit: a synchronous pass reads the previous list.
        requestAnimationFrame(() => requestAnimationFrame(() => handleNavigationChange()));
    };
    window.addEventListener('popstate', navigationEvent);
    window.addEventListener('hashchange', navigationEvent);
    window.addEventListener('nma:navigate', navigationEvent);

    ['pushState', 'replaceState'].forEach(method => {
        const original = history[method];
        if (typeof original === 'function') {
            history[method] = function patchedHistory(...args) {
                const result = original.apply(this, args);
                window.dispatchEvent(new Event('nma:navigate'));
                return result;
            };
        }
    });
}

function resetForNewRoute() {
    // "No mods on this page." and the layout warnings describe the page the user
    // just left. Kept, they assert something untrue and cannot re-fire on a page
    // where they are true. The configuration notices are not page-scoped and stay.
    forgetRouteNotices();
    cancelQueued('Navigation changed');
    nmaRejectAllPending('Navigation changed');
    clearPendingHidden();
    clearModFilesCache();

    // Selections survive pagination inside one game; entries from another game
    // cannot be honoured and are dropped with a word about it.
    const dropped = dropSelectionsOutsideDomain(pageGameDomain());
    if (dropped > 0) {
        reportToUser({
            level: 'info',
            code: 'SELECTION_DROPPED',
            message: t(dropped === 1 ? 'content_selectionDroppedOne' : 'content_selectionDroppedMany', [String(dropped)])
        });
    }
    updateSelectionButton();

    const statusList = getStatusListElement();
    if (statusList) statusList.innerHTML = '';
    resetPanelState();
    purgeCardDecorations();
    sweepOrphanBadges();
}

export function purgeCardDecorations(scoped = null) {
    const cards = scoped ? [scoped] : Array.from(document.querySelectorAll('[data-nma-processed]'));
    cards.forEach(card => {
        card.removeAttribute('data-nma-processed');
        card.removeAttribute('data-nma-epoch');
        card.removeAttribute('data-mod-id');
        card.removeAttribute('data-game-domain');
        card.removeAttribute('data-nma-status');
        card.removeAttribute('data-nma-file-id');
        card.removeAttribute('data-nma-mod-name');
        card.removeAttribute('data-nma-updated-at');
        card.classList.remove('nma-hidden');
        card.querySelector('.nma-inline-wrapper')?.remove();
        const selectAnchor = card.querySelector('.nma-select-anchor');
        if (selectAnchor) {
            const host = selectAnchor.parentElement;
            selectAnchor.remove();
            host?.classList?.remove('nma-select-host');
        }
    });
}

// ── Grid discovery, bounded ──────────────────────────────────────────

function startModProcessing(generation, scope) {
    let observedGrid = null;
    let gridObserver = null;
    let hydrationObserver = null;
    let bootTimer = null;
    let healthCheckStarted = false;

    const cancelBoot = () => {
        if (bootTimer === null) return;
        clearTimeout(bootTimer);
        bootTimer = null;
    };
    scope.own(cancelBoot);
    scope.own(() => {
        gridObserver?.disconnect();
        gridObserver = null;
        observedGrid = null;
    });

    const scheduleBoot = (startedAt) => {
        cancelBoot();
        bootTimer = setTimeout(() => {
            bootTimer = null;
            attemptBoot(startedAt);
        }, BOOT_POLL_MS);
    };

    const attachToGrid = (grid) => {
        // The hydration observer and the fallback poll can both arrive here.
        // Canceling the loser is what stops the double injection.
        cancelBoot();
        if (hydrationObserver) {
            hydrationObserver.disconnect();
            hydrationObserver = null;
        }
        if (isSkeletonGrid(grid)) {
            watchForHydration(grid);
            return;
        }

        // Re-attaching must replace the previous observer, not stack another.
        gridObserver?.disconnect();
        observedGrid = grid;
        // No key or no target means no tile can ever carry a status, so the five
        // status checkboxes and the tally would tick and change nothing.
        injectFilterBar(grid, scope, config.hasApiKey && config.matchesTarget);
        processCards(grid, generation);

        gridObserver = new MutationObserver(() => scheduleCardProcessing(grid, generation, scope));
        gridObserver.observe(grid, {childList: true, subtree: true});
        ensureScrollAcceleration(scope);
        startHealthCheck();
        console.info('NMA extension: observing mod grid.');
    };

    const watchForHydration = (grid) => {
        if (hydrationObserver) return;
        hydrationObserver = new MutationObserver(() => {
            const g = findGrid();
            if (!g || isSkeletonGrid(g)) return;
            attachToGrid(g);
        });
        hydrationObserver.observe(grid.parentElement || grid, {childList: true, subtree: true});
        scope.observe(hydrationObserver);
        console.info('NMA extension: grid found (skeleton), waiting for React hydration...');
    };

    const startHealthCheck = () => {
        if (healthCheckStarted) return;
        healthCheckStarted = true;
        scope.interval(() => {
            const gridAlive = observedGrid?.isConnected;
            const panelAlive = isPanelMounted();
            if (gridAlive && panelAlive) return;

            const newGrid = gridAlive ? observedGrid : findGrid();
            // Never tear down before a replacement exists: a null grid in the
            // gap used to leave the extension dead for the rest of the session.
            if (!newGrid) return;
            if (isSkeletonGrid(newGrid)) return;

            console.info('NMA extension: re-attaching (grid or panel detached).');
            resetPanelState();
            observedGrid = null;
            attachToGrid(newGrid);
        }, HEALTH_CHECK_MS);
    };

    const attemptBoot = (startedAt = Date.now()) => {
        if (!scope.alive) return;

        const grid = findGrid();
        if (grid && !isSkeletonGrid(grid)) {
            attachToGrid(grid);
            return;
        }

        const detailMatch = window.location.pathname.match(/\/games\/([^/]+)\/mods\/(\d+)/);
        if (!grid && detailMatch) {
            processModDetailPage(detailMatch[1], detailMatch[2], generation, scope);
            return;
        }

        if (grid) watchForHydration(grid);

        // Bounded: three polls used to run forever on any matched URL with no
        // grid, saying nothing to anyone.
        if (Date.now() - startedAt > BOOT_DEADLINE_MS) {
            reportBootFailure(grid);
            return;
        }

        scheduleBoot(startedAt);
    };

    attemptBoot();
}

function reportBootFailure(grid) {
    const report = checkLayout(grid);
    if (grid && report.brokenRequired.length === 0) {
        // Zero results is not a layout change. Saying so would be a lie.
        reportToUser({level: 'info', code: 'EMPTY_RESULTS', message: t('content_noModsOnPage')});
        return;
    }
    // A grid that is still a skeleton is either a slow page or changed markup,
    // and the extension cannot tell which, so it says both. The hydration
    // observer stays armed either way.
    reportToUser({
        level: 'warn',
        code: 'LAYOUT_CHANGED',
        message: grid
            ? t('content_layoutStillLoading')
            : t('content_layoutNotFound'),
        detail: t('content_layoutBrokenSelectors', [report.brokenRequired.join(', ') || t('content_layoutSelectorGrid')]),
        action: {label: t('content_reloadPage'), run: () => window.location.reload()}
    });
}

// ── Mod detail page ──────────────────────────────────────────────────

function processModDetailPage(gameDomain, modId, generation, scope, startedAt = Date.now()) {
    if (!scope.alive || generation !== routeGeneration) return;

    const header = findDetailHeader();
    if (!header) {
        if (Date.now() - startedAt > BOOT_DEADLINE_MS) {
            reportToUser({
                level: 'info',
                code: 'DETAIL_LAYOUT',
                message: t('content_detailLayoutUnrecognized')
            });
            return;
        }
        scope.timeout(() => processModDetailPage(gameDomain, modId, generation, scope, startedAt), 500);
        return;
    }

    if (header.dataset.nmaProcessed === String(generation)) return;
    header.dataset.nmaProcessed = String(generation);

    const virtualCard = document.createElement('div');
    virtualCard.dataset.modId = modId;
    virtualCard.dataset.gameDomain = gameDomain;
    virtualCard.dataset.nmaProcessed = String(generation);

    const badgeContainer = document.createElement('div');
    badgeContainer.className = 'nma-detail-badge-container';
    badgeContainer.appendChild(virtualCard);
    scope.mount(badgeContainer);

    const targetParent = findDetailTitleTarget() || header;
    if (targetParent === header) header.prepend(badgeContainer);
    else targetParent.appendChild(badgeContainer);

    if (!config.hasApiKey || !config.matchesTarget) {
        attachInlineIndicator(virtualCard, t('content_badgeNotConfigured', [STATUS_CONFIG.NOT_CONFIGURED.label]), 'muted', false,
            t('content_setVersionInPopup'), false, 'NOT_CONFIGURED');
    } else {
        fetchCompatibility(virtualCard, generation, 'HIGH');
    }

    enhanceRequirementsTables(gameDomain, generation, scope);
}

function enhanceRequirementsTables(gameDomain, generation, scope) {
    if (!scope.alive || generation !== routeGeneration) return;

    const tables = findRequirementTables();
    if (tables.length === 0) return;

    for (const table of tables) {
        const tbody = table.querySelector('tbody');
        if (!tbody || tbody.dataset.nmaEnhanced === String(generation)) continue;
        tbody.dataset.nmaEnhanced = String(generation);

        const thead = table.querySelector('thead tr');
        if (thead && !thead.querySelector('.table-require-compat')) {
            const compatHeader = document.createElement('th');
            compatHeader.className = 'table-require-compat';
            const headerLabel = document.createElement('span');
            headerLabel.className = 'table-header';
            headerLabel.textContent = t('content_compatibilityColumn');
            compatHeader.appendChild(headerLabel);
            thead.appendChild(compatHeader);
            scope.mount(compatHeader);
        }

        const rows = tbody.querySelectorAll('tr');
        for (const row of Array.from(rows)) {
            if (row.dataset.nmaCompatProcessed === String(generation)) continue;
            row.dataset.nmaCompatProcessed = String(generation);

            const link = row.querySelector<HTMLAnchorElement>('a[href*="/mods/"]');
            if (!link) continue;

            const reqModId = extractModId(link.href);
            if (!reqModId) continue;
            const reqGameDomain = extractGameDomain(link.href) || gameDomain;

            const compatCell = document.createElement('td');
            compatCell.className = 'table-require-compat';
            compatCell.dataset.nmaReqModId = reqModId;
            compatCell.dataset.gameDomain = reqGameDomain;

            const wrapper = document.createElement('div');
            wrapper.className = 'nma-inline-wrapper';
            compatCell.appendChild(wrapper);
            row.appendChild(compatCell);
            scope.mount(compatCell);

            renderRequirementCell(compatCell, t('content_checking'), 'muted', true);
            fetchRequirementCompatibility(compatCell, reqModId, reqGameDomain, generation);
        }
    }
}

function renderRequirementCell(cell, text, tone, loading, statusKey = undefined, detail = '') {
    const wrapper = cell.querySelector('.nma-inline-wrapper') || cell;
    wrapper.innerHTML = '';

    const flag = document.createElement('div');
    flag.className = `nma-inline-flag tone-${tone}`;
    if (statusKey) flag.classList.add(`nma-status-${statusKey}`);
    flag.classList.toggle('nma-inline-loading', !!loading);

    const header = document.createElement('div');
    header.className = 'nma-flag-text';
    if (!loading && statusKey) {
        const dot = document.createElement('span');
        dot.className = 'nma-dot';
        header.appendChild(dot);
    }
    const textNode = document.createElement('span');
    textNode.textContent = text;
    header.appendChild(textNode);
    flag.appendChild(header);

    if (detail) {
        const tooltip = document.createElement('div');
        tooltip.className = 'nma-badge-tooltip';
        tooltip.textContent = detail;
        flag.appendChild(tooltip);
    }

    wrapper.appendChild(flag);
    return flag;
}

async function fetchRequirementCompatibility(cell, modId, gameDomain, generation) {
    const epoch = getEpoch();
    if (generation !== routeGeneration) return;

    try {
        if (!config.hasApiKey || !config.matchesTarget) {
            renderRequirementCell(cell, STATUS_CONFIG.NOT_CONFIGURED.label, 'muted', false, 'NOT_CONFIGURED',
                t('content_setVersionInPopup'));
            return;
        }

        const result = await runLimited(
            `check:${gameDomain}:${modId}:${epoch.id}`,
            () => request<CompatibilityResult>({type: 'CHECK_MOD', modId, gameDomain, priority: 'NORMAL', routeToken: nmaRouteToken, epochId: epoch.id},
                {timeoutMs: 180000, signal: routeScope?.signal}),
            REQUIREMENTS_LANE
        );

        if (!isCurrent(epoch) || generation !== routeGeneration || !cell.isConnected) return;

        const status = result?.status || 'UNKNOWN';
        const tone = STATUS_CONFIG[status]?.tone || 'muted';
        const label = STATUS_CONFIG[status]?.label || t('content_statusFallbackUnknown');
        const versionText = result?.detectedVersion || t('content_versionNotReportedShort');
        const detail = result?.message || result?.reason || '';

        cell.dataset.nmaStatus = status;
        cell.dataset.nmaFileId = result?.fileId ? String(result.fileId) : '';
        if (result?.modName) cell.dataset.nmaModName = result.modName;

        const flag = renderRequirementCell(cell, t('content_badgeStatusVersion', [label, versionText]), tone, false, status, detail);

        const filesBtn = document.createElement('button');
        filesBtn.type = 'button';
        filesBtn.className = 'nma-files-button';
        filesBtn.textContent = t('content_filesButton');
        filesBtn.setAttribute('aria-label', result?.modName ? t('content_filesButtonForMod', [result.modName]) : t('content_filesButtonForRequiredMod'));
        filesBtn.setAttribute('aria-expanded', 'false');
        filesBtn.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            toggleRequirementFilesDropdown(cell, flag, modId, gameDomain);
        });
        flag.appendChild(filesBtn);
    } catch (err) {
        // The same guard the resolve path has. An epoch bump does not dispose the
        // route scope, so a connected cell is not on its own proof of freshness.
        if (!isCurrent(epoch) || generation !== routeGeneration || !cell.isConnected) return;
        const failure = classifyError(err);
        // A requirement cell left on "Checking..." forever is the same lie as a
        // spinner with no request behind it.
        renderRequirementCell(cell, t('content_badgeStatusReason', [STATUS_CONFIG.FAILED.label, shortFailureLabel(failure)]), 'muted', false, 'FAILED', failure.message);
    }
}

// ── Card processing ──────────────────────────────────────────────────

function scheduleCardProcessing(grid, generation, scope) {
    if (!scope.alive || generation !== routeGeneration) return;
    scope.frame(() => processCards(grid, generation));
}

function processCards(grid, generation) {
    if (!rootScope?.alive || generation !== routeGeneration) return;

    const epoch = getEpoch();
    const cards = findCards(grid);
    const genKey = String(generation);
    const domain = pageGameDomain();

    cards.forEach(card => {
        // Identity is read before the early return: a node React recycled for a
        // different mod would otherwise keep the previous mod's badge forever.
        const link = modLink(card);
        if (!link) return;
        const modId = extractModId(link.getAttribute('href') || link.href);
        if (!modId) return;

        const alreadyDone = card.dataset.nmaProcessed === genKey
            && card.dataset.modId === modId
            && card.dataset.nmaEpoch === String(epoch.id);
        if (alreadyDone) return;

        if (card.dataset.modId && card.dataset.modId !== modId) {
            purgeCardDecorations(card);
        }

        card.dataset.nmaProcessed = genKey;
        card.dataset.nmaEpoch = String(epoch.id);
        card.dataset.modId = modId;
        card.dataset.gameDomain = domain;
        card.dataset.nmaModName = (link.textContent || '').trim();

        const updatedAt = cardUpdatedAt(card);
        if (updatedAt !== null) {
            card.dataset.nmaUpdatedAt = String(updatedAt);
        } else {
            // NaN never reaches the dataset; an absent value is recorded as absent.
            card.removeAttribute('data-nma-updated-at');
        }

        ensureSelectionControl(card);

        if (!config.hasApiKey) {
            // Optional means absent: no badge, no spinner, no wall of red.
            card.querySelector('.nma-inline-wrapper')?.remove();
            return;
        }
        if (!config.matchesTarget) {
            card.dataset.nmaStatus = 'NOT_CONFIGURED';
            attachInlineIndicator(card, t('content_badgeNotConfigured', [STATUS_CONFIG.NOT_CONFIGURED.label]), 'muted', false,
                t('content_pickVersionInPopup'), false, 'NOT_CONFIGURED');
            return;
        }

        if (isCardVisible(card)) {
            attachInlineIndicator(card, t('content_checkingCompatibility'), 'muted', true);
            fetchCompatibility(card, generation, 'HIGH');
        } else {
            // Honest deferred state: no pulse for a request that does not exist.
            attachInlineIndicator(card, t('content_scrollToCheck'), 'muted', false, t('content_scrollToCheckDetail'), false, undefined);
            addPendingHidden(card);
            clearPendingLowTimer(card);
        }
    });

    applyFilters();
    syncAllSelectionCheckboxes();
    updateSelectionButton();
    sweepOrphanBadges();
    accelerateVisibleHidden();
}

function scheduleVisibilitySweep() {
    if (sweepScheduled || !rootScope?.alive) return;
    sweepScheduled = true;
    requestAnimationFrame(() => {
        sweepScheduled = false;
        accelerateVisibleHidden();
    });
}

function updateFilterNote(report) {
    if (!report) return;

    const translations = getTranslationFilterReport();
    if (translations.signalUnavailable) {
        reportToUser({
            level: 'warn',
            code: 'TRANSLATION_SIGNAL_MISSING',
            message: t('content_translationSignalMissing'),
            detail: t('content_translationSignalMissingDetail')
        });
    } else {
        forgetNotice('TRANSLATION_SIGNAL_MISSING');
    }

    const notes: string[] = [];
    if (report.selectorLikelyBroken) {
        notes.push(t('content_dateFilterNotApplied'));
        reportToUser({
            level: 'warn',
            code: 'DATE_SELECTOR_BROKEN',
            message: t('content_dateSelectorBroken'),
            detail: t('content_dateSelectorBrokenDetail')
        });
    } else if (report.active && report.undatedHidden > 0) {
        notes.push(t(report.undatedHidden === 1 ? 'content_undatedHiddenOne' : 'content_undatedHiddenMany', [String(report.undatedHidden)]));
    }

    if (translations.hidden > 0) {
        notes.push(t(translations.hidden === 1 ? 'content_translationsHiddenOne' : 'content_translationsHiddenMany', [String(translations.hidden)]));
    }

    setPanelNote(notes.join(' '));
}

// ── Compatibility ────────────────────────────────────────────────────

function fetchCompatibility(card, generation, priority = 'NORMAL', attempt = 0) {
    if (!rootScope?.alive || generation !== routeGeneration) return;
    if (!config.hasApiKey || !config.matchesTarget) return;

    const epoch = getEpoch();
    const modId = card.dataset.modId;
    const gameDomain = card.dataset.gameDomain || pageGameDomain();
    if (!modId) return;

    attachInlineIndicator(card, t('content_checkingCompatibility'), 'muted', true);

    const timeoutMs = priority === 'HIGH' ? 60000 : 180000;
    runLimited(
        `check:${gameDomain}:${modId}:${epoch.id}`,
        () => request<CompatibilityResult>({type: 'CHECK_MOD', modId, gameDomain, priority, routeToken: nmaRouteToken, epochId: epoch.id},
            {timeoutMs, signal: routeScope?.signal})
    )
        .then(result => {
            if (!isCurrent(epoch) || generation !== routeGeneration || !card.isConnected) return;
            if (card.dataset.modId !== modId) return;
            // Failure payloads legitimately carry no modId, so the guard is on presence.
            if (result?.modId && String(result.modId) !== modId) return;
            if (result?.gameDomain && result.gameDomain !== gameDomain) return;
            renderStatus(card, result || {status: 'UNKNOWN', reason: t('content_noResponse')}, generation);
        })
        .catch(error => {
            if (!isCurrent(epoch) || generation !== routeGeneration || !card.isConnected) return;
            if (card.dataset.modId !== modId) return;

            const failure = classifyError(error);
            renderFailure(card, failure, generation);

            // One retry, on a deadline strictly above the transport timeout it
            // supervises, owned by the route scope so navigation cancels it.
            if (attempt === 0 && failure.retryable) {
                routeScope?.timeout(() => fetchCompatibility(card, generation, priority, 1), timeoutMs + 10000);
            }
        });
}

function renderFailure(card, failure, generation) {
    if (card.dataset.nmaProcessed !== String(generation)) return;
    card.dataset.nmaStatus = 'FAILED';
    attachInlineIndicator(
        card,
        t('content_badgeStatusReason', [STATUS_CONFIG.FAILED.label, shortFailureLabel(failure)]),
        STATUS_CONFIG.FAILED.tone,
        false,
        failure.message,
        !!card.dataset.nmaFileId,
        'FAILED'
    );
    applyFilters();
    updateControlPanelSummary('FAILED');
    reportToUser({level: 'warn', code: failure.code, message: failure.message});
}

function renderStatus(card, payload, generation) {
    if (card.dataset.nmaProcessed !== String(generation)) return;
    if (payload.gameDomain && card.dataset.gameDomain && payload.gameDomain !== card.dataset.gameDomain) return;
    if (payload.modId && card.dataset.modId && String(payload.modId) !== card.dataset.modId) return;

    const status = payload.status || 'UNKNOWN';
    card.dataset.nmaStatus = status;
    card.dataset.nmaFileId = payload.fileId ? String(payload.fileId) : '';
    if (payload.modName) card.dataset.nmaModName = payload.modName;

    const tone = STATUS_CONFIG[status]?.tone || 'muted';
    const label = STATUS_CONFIG[status]?.label || t('content_statusFallbackUnknown');
    const versionText = payload.detectedVersion || t('content_versionNotReported');
    const text = status === 'FAILED' || status === 'NOT_CONFIGURED' ? label : t('content_badgeStatusVersion', [label, versionText]);

    attachInlineIndicator(
        card,
        text,
        tone,
        false,
        payload.message || payload.reason || '',
        !!payload.fileId,
        status,
        {
            detectedVersion: payload.detectedVersion,
            confidence: payload.confidence,
            evidenceSource: payload.evidenceSource,
            evidenceText: payload.evidenceText
        }
    );
    ensureSelectionControl(card);

    if (payload.fileId && getSelection().has(card.dataset.modId)) {
        const entry = getSelection().get(card.dataset.modId);
        if (entry && (!entry.fileIds || entry.fileIds.size === 0)) {
            if (!entry.fileIds) entry.fileIds = new Set();
            entry.fileIds.add(payload.fileId);
            updateSelectionButton();
        }
    }

    applyFilters();
    updateControlPanelSummary(status);
}

// ── Rescan on settings change ────────────────────────────────────────

function scheduleRescan() {
    if (rescanTimer !== null) clearTimeout(rescanTimer);
    // Debounced: the popup can write target keys per keystroke, and every write
    // reaches every open tab.
    rescanTimer = setTimeout(async () => {
        rescanTimer = null;
        if (!rootScope?.alive) return;

        // Never rescan across a batch or an open modal: it would cancel work the
        // user is in the middle of answering.
        if (document.querySelector('.nma-modal-overlay') || isBatchInFlight()) {
            reportToUser({
                level: 'info',
                code: 'RESCAN_DEFERRED',
                message: t('content_rescanDeferred')
            });
            // Deferred, not dropped: it re-arms until the run is over.
            rescanTimer = setTimeout(() => { rescanTimer = null; forgetNotice('RESCAN_DEFERRED'); scheduleRescan(); }, 3000);
            return;
        }

        // A settings change invalidates every verdict on the page, and the route
        // scope is what owns them: the detail badge, the injected Compatibility
        // column and the filter bar as well as the tiles. Repainting the grid by
        // hand rebuilt one of those and left the rest stale or missing until a
        // reload, so the whole route is rebuilt instead.
        purgeCardDecorations();
        sweepOrphanBadges();
        beginRoute();
    }, 500);
}

function waitForHydration() {
    return new Promise<void>(resolve => {
        if (document.readyState === 'complete') {
            resolve();
            return;
        }
        window.addEventListener('load', () => resolve(), {once: true});
    });
}
