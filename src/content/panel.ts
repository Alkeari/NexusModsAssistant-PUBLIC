/**
 * panel.ts - Hybrid UI: inline filter bar + bottom action bar.
 *
 * #nma-filter-bar  - sticky bar inserted above the mod grid
 * #nma-action-bar  - fixed bottom bar for downloads/selection
 */

import {
    toggleStatus, isStatusEnabled,
    setExclusionPhrases,
    setShowOldFiles, getShowOldFiles,
    setShowUpdateFiles, getShowUpdateFiles,
    setShowOptionalFiles, getShowOptionalFiles,
    setShowMiscFiles, getShowMiscFiles,
    setLastUpdatedStart, getLastUpdatedStart,
    setLastUpdatedEnd, getLastUpdatedEnd,
    applyFilters
} from './filters';
import { downloadSelectedMods, downloadAllMods, abortBatch, isBatchInFlight } from './downloads';
import { clearAllSelections } from './file-picker';
import { STATUS_CONFIG, FILTERABLE_STATUSES, refreshOpenFileLists } from './badges';
import { Scope, Surface, mountSurface, unmountSurface, createScope } from './lifecycle';
import { pageHeaderOffset } from './selectors';
import {t, tHtml} from '../i18n';

const FILTER_BAR_ID = 'nma-filter-bar';
const ACTION_BAR_ID = 'nma-action-bar';

let filtersCollapsed = false;
let fallbackScope: Scope | null = null;

const CATEGORY_TOGGLES: Array<[string, string, (v: boolean) => void, () => boolean]> = [
    ['nma-toggle-update-files', 'showUpdateFiles', setShowUpdateFiles, getShowUpdateFiles],
    ['nma-toggle-optional-files', 'showOptionalFiles', setShowOptionalFiles, getShowOptionalFiles],
    ['nma-toggle-misc-files', 'showMiscFiles', setShowMiscFiles, getShowMiscFiles],
    ['nma-toggle-old-files', 'showOldFiles', setShowOldFiles, getShowOldFiles]
];

// ── Accessors ────────────────────────────────────────────────────────

export function getControlPanelHost(): HTMLElement | null {
    const host = document.getElementById(FILTER_BAR_ID);
    return host?.isConnected ? host : null;
}

export function getActionBarHost(): HTMLElement | null {
    const host = document.getElementById(ACTION_BAR_ID);
    return host?.isConnected ? host : null;
}

export function getStatusListElement(): HTMLElement | null {
    return getControlPanelHost()?.querySelector('#nma-status-list') || null;
}

export function isPanelMounted(): boolean {
    return !!getControlPanelHost() && !!getActionBarHost();
}

export function resetPanelState(): void {
    unmountSurface(FILTER_BAR_ID);
    // Ids are not unique in HTML, and our own bug is what would duplicate them,
    // so the sweep runs unconditionally rather than as a fallback branch.
    document.querySelectorAll(`#${FILTER_BAR_ID}, #${ACTION_BAR_ID}`).forEach(el => el.remove());
}

// ── Page helpers ─────────────────────────────────────────────────────

function getCurrentPage(): number {
    const params = new URLSearchParams(window.location.search);
    const pageParam = params.get('page');
    return pageParam ? parseInt(pageParam, 10) || 1 : 1;
}

function navigateToPage(pageNum: number): void {
    const url = new URL(window.location.href);
    if (pageNum === 1) {
        url.searchParams.delete('page');
    } else {
        url.searchParams.set('page', String(pageNum));
    }
    window.location.href = url.toString();
}

// ── Action bar visibility ────────────────────────────────────────────

export function updateActionBarVisibility(selectedCount: number): void {
    const actionBarHost = getActionBarHost();
    if (!actionBarHost) return;

    // Download All acts on what is visible, not on what is selected, so hiding
    // the bar until something is selected made it unreachable in its own use.
    // Hidden only when there is nothing on the page to act on at all.
    const hasCards = document.querySelector('[data-nma-processed]') !== null;
    const hidden = selectedCount === 0 && !hasCards;
    actionBarHost.classList.toggle('nma-action-hidden', hidden);
    // The bar slides off screen rather than leaving the DOM, so without this its
    // buttons stay in the tab order while invisible.
    actionBarHost.toggleAttribute('inert', hidden);

    const clearButton = actionBarHost.querySelector('#nma-clear-selection') as HTMLButtonElement | null;
    // Never enabled with nothing to clear: a control that does nothing reads as broken.
    if (clearButton && !isBatchInFlight()) clearButton.disabled = selectedCount === 0;

    const countEl = actionBarHost.querySelector('.nma-action-count');
    if (countEl) {
        countEl.textContent = selectedCount === 0
            ? t('content_noModsSelected')
            : t(selectedCount === 1 ? 'content_modsSelectedOne' : 'content_modsSelectedMany', [String(selectedCount)]);
    }
}

// ── Batch controls ───────────────────────────────────────────────────

export function setBatchControlsBusy(busy: boolean, label = ''): void {
    // The run is irreversible from where it is started, so the way out is put in
    // the same place: Download All becomes Stop for as long as a run is going,
    // whichever control started it.
    const bar = getActionBarHost();
    if (!bar) return;

    // Presence, not truthiness: an empty stash is still a stash, and treating it
    // as absent would leave the label undeleted and freeze the button's text.
    const progressBtn = bar.querySelector('#nma-download-selected') as HTMLButtonElement | null;
    if (progressBtn) {
        if (busy) {
            if (progressBtn.dataset.nmaLabel === undefined) progressBtn.dataset.nmaLabel = progressBtn.textContent || '';
            progressBtn.disabled = true;
            if (label) progressBtn.textContent = label;
        } else {
            progressBtn.disabled = false;
            if (progressBtn.dataset.nmaLabel !== undefined) {
                progressBtn.textContent = progressBtn.dataset.nmaLabel;
                delete progressBtn.dataset.nmaLabel;
            }
        }
    }

    // A run reads its list up front, so clearing mid-run would change nothing it does.
    const clearBtn = bar.querySelector('#nma-clear-selection') as HTMLButtonElement | null;
    if (clearBtn) clearBtn.disabled = busy;

    const stopBtn = bar.querySelector('#nma-download-visible') as HTMLButtonElement | null;
    if (stopBtn) {
        if (busy) {
            if (stopBtn.dataset.nmaLabel === undefined) stopBtn.dataset.nmaLabel = stopBtn.textContent || '';
            stopBtn.disabled = false;
            stopBtn.textContent = t('content_stopButton');
            stopBtn.title = t('content_stopButtonTooltip');
            stopBtn.classList.add('nma-chip-stop');
        } else {
            stopBtn.disabled = false;
            stopBtn.classList.remove('nma-chip-stop');
            stopBtn.removeAttribute('title');
            if (stopBtn.dataset.nmaLabel !== undefined) {
                stopBtn.textContent = stopBtn.dataset.nmaLabel;
                delete stopBtn.dataset.nmaLabel;
            }
        }
    }
}

export function setBatchProgress(label: string): void {
    const bar = getActionBarHost();
    if (!bar) return;
    ['#nma-download-selected', '#nma-download-visible'].forEach(sel => {
        const btn = bar.querySelector(sel) as HTMLButtonElement | null;
        if (btn && btn.disabled && btn.dataset.nmaLabel) btn.textContent = label;
    });
}

// ── Panel note (filter diagnostics) ──────────────────────────────────

export function setPanelNote(text: string): void {
    const host = getControlPanelHost();
    if (!host) return;
    const note = host.querySelector('#nma-filter-note');
    if (!note) return;
    note.textContent = text || '';
    note.classList.toggle('nma-bar-note-hidden', !text);
}

// ── Collapse toggle ──────────────────────────────────────────────────

export function setPanelCollapsed(collapsed, persist = false): void {
    filtersCollapsed = collapsed;
    const host = getControlPanelHost();
    if (!host) return;

    const filters = host.querySelector('.nma-bar-filters');
    const summary = host.querySelector('.nma-bar-summary');
    if (filters) filters.classList.toggle('nma-bar-section-hidden', collapsed);
    if (summary) summary.classList.toggle('nma-bar-section-hidden', collapsed);

    const toggle = host.querySelector('#nma-panel-toggle');
    if (toggle) {
        toggle.setAttribute('aria-expanded', String(!collapsed));
        toggle.setAttribute('aria-label', collapsed ? t('content_expandFilters') : t('content_collapseFilters'));
        const icon = toggle.querySelector('.nma-toggle-icon');
        if (icon) icon.textContent = collapsed ? 'v' : '^';
    }

    if (persist) {
        chrome.storage.local.set({panelCollapsed: collapsed})
            .catch(() => console.warn('NMA extension: could not save the panel collapse state.'));
    }
}

// ── Markup ───────────────────────────────────────────────────────────

function renderFilterBarMarkup(verdictsPossible: boolean): string {
    const statusToggles = FILTERABLE_STATUSES.map(key => `
                    <label class="nma-toggle">
                        <input type="checkbox" data-nma-status-filter value="${key}" ${isStatusEnabled(key) ? 'checked' : ''}>
                        <span>${STATUS_CONFIG[key].label}</span>
                    </label>
                `).join('');

    // A control that cannot affect anything is not offered. Without a key and a
    // matching target no tile ever gets a status, so the status filters and the
    // tally would be a row of switches wired to nothing.
    const statusRow = verdictsPossible ? `<div class="nma-bar-row">${statusToggles}</div>` : '';
    const statusList = verdictsPossible ? '<div class="nma-status-list" id="nma-status-list" aria-live="polite"></div>' : '';
    const summaryClass = verdictsPossible ? 'nma-bar-summary' : 'nma-bar-summary nma-bar-summary-quiet';

    const clearDateRange = t('content_clearDateRange');

    return `
        <div class="nma-bar-header">
            <div class="nma-panel-brand">
                <div class="nma-panel-title">${tHtml('content_panelTitle')}</div>
                <div class="nma-panel-subtitle">${tHtml('content_panelSubtitle')}</div>
            </div>
            <div class="nma-bar-header-actions">
                <span class="nma-action-rate" id="nma-action-rate" aria-live="polite"></span>
                <button class="nma-chip" id="nma-refresh-panel" type="button">${tHtml('content_refresh')}</button>
                <div class="nma-pagination-controls" role="group" aria-label="${tHtml('content_pageNavigation')}">
                    <button class="nma-chip" id="nma-prev-page" type="button">${tHtml('content_prevPage')}</button>
                    <label class="nma-visually-hidden" for="nma-page-input">${tHtml('content_pageNumber')}</label>
                    <input type="number" id="nma-page-input" min="1" value="1" title="${tHtml('content_goToPage')}">
                    <button class="nma-chip" id="nma-next-page" type="button">${tHtml('content_nextPage')}</button>
                </div>
                <button class="nma-chip nma-collapse-toggle" id="nma-panel-toggle" type="button" aria-expanded="true" aria-controls="nma-bar-filters" aria-label="${tHtml('content_collapseFilters')}">
                    <span class="nma-toggle-icon" aria-hidden="true">^</span>
                </button>
            </div>
        </div>
        <div class="nma-bar-filters" id="nma-bar-filters">
            ${statusRow}
            <div class="nma-bar-row">
                <label class="nma-toggle" title="${tHtml('content_showUpdateFiles')}">
                    <input type="checkbox" id="nma-toggle-update-files" ${getShowUpdateFiles() ? 'checked' : ''}>
                    <span>${tHtml('content_fileCategoryUpdate')}</span>
                </label>
                <label class="nma-toggle" title="${tHtml('content_showOptionalFiles')}">
                    <input type="checkbox" id="nma-toggle-optional-files" ${getShowOptionalFiles() ? 'checked' : ''}>
                    <span>${tHtml('content_fileCategoryOptional')}</span>
                </label>
                <label class="nma-toggle" title="${tHtml('content_showMiscFiles')}">
                    <input type="checkbox" id="nma-toggle-misc-files" ${getShowMiscFiles() ? 'checked' : ''}>
                    <span>${tHtml('content_fileCategoryMisc')}</span>
                </label>
                <label class="nma-toggle" title="${tHtml('content_showOldFiles')}">
                    <input type="checkbox" id="nma-toggle-old-files" ${getShowOldFiles() ? 'checked' : ''}>
                    <span>${tHtml('content_fileCategoryOld')}</span>
                </label>
            </div>
            <div class="nma-bar-row">
                <div class="nma-exclusion-wrapper">
                    <label class="nma-visually-hidden" for="nma-exclusion-input">${tHtml('content_exclusionLabel')}</label>
                    <input type="text" id="nma-exclusion-input" placeholder="${tHtml('content_exclusionPlaceholder')}" title="${tHtml('content_exclusionTooltip')}">
                </div>
                <div class="nma-filter-wrapper" role="group" aria-label="${tHtml('content_lastUpdatedRange')}">
                    <span class="nma-date-label" aria-hidden="true">${tHtml('content_lastUpdatedLabel')}</span>
                    <label class="nma-visually-hidden" for="nma-last-updated-start">${tHtml('content_updatedOnOrAfter')}</label>
                    <input id="nma-last-updated-start" class="nma-filter-date" type="date" title="${tHtml('content_startDateTooltip')}">
                    <span class="nma-date-sep" aria-hidden="true">&ndash;</span>
                    <label class="nma-visually-hidden" for="nma-last-updated-end">${tHtml('content_updatedOnOrBefore')}</label>
                    <input id="nma-last-updated-end" class="nma-filter-date" type="date" title="${tHtml('content_endDateTooltip')}">
                    <button class="nma-chip nma-chip-sm" id="nma-last-updated-clear" type="button" title="${clearDateRange}" aria-label="${clearDateRange}">${tHtml('content_clearButton')}</button>
                </div>
            </div>
        </div>
        <div class="${summaryClass}">
            ${statusList}
            <div class="nma-bar-note nma-bar-note-hidden" id="nma-filter-note"></div>
        </div>
    `;
}

function renderActionBarMarkup(): string {
    return `
        <span class="nma-action-count">${tHtml('content_modsSelectedMany', ['0'])}</span>
        <div class="nma-action-buttons">
            <button class="nma-chip" id="nma-download-selected" type="button" disabled>${tHtml('content_downloadSelectedCount', ['0'])}</button>
            <button class="nma-chip" id="nma-clear-selection" type="button" disabled title="${tHtml('content_clearSelectionTooltip')}">${tHtml('content_clearSelection')}</button>
            <button class="nma-chip" id="nma-download-visible" type="button">${tHtml('content_downloadAll')}</button>
            <label class="nma-visually-hidden" for="nma-download-mode">${tHtml('content_downloadMode')}</label>
            <select id="nma-download-mode" class="nma-download-mode" title="${tHtml('content_downloadMode')}">
                <option value="MANUAL">${tHtml('content_downloadModeManual')}</option>
                <option value="VORTEX">${tHtml('content_downloadModeVortex')}</option>
            </select>
        </div>
    `;
}

// ── Wiring ───────────────────────────────────────────────────────────

function wireFilterControls(host: HTMLElement, scope: Scope): void {
    host.querySelectorAll('input[data-nma-status-filter]').forEach(input => {
        scope.listen(input, 'change', event => {
            toggleStatus(event.target.value, event.target.checked);
            applyFilters();
        });
    });

    CATEGORY_TOGGLES.forEach(([id, storageKey, setter, getter]) => {
        const input = host.querySelector(`#${id}`) as HTMLInputElement | null;
        if (!input) return;
        input.checked = getter();
        scope.listen(input, 'change', () => {
            setter(input.checked);
            chrome.storage.local.set({[storageKey]: input.checked})
                .catch(() => console.warn(`NMA extension: could not save ${storageKey}.`));
            refreshOpenFileLists();
        });
    });

    const exclInput = host.querySelector('#nma-exclusion-input') as HTMLInputElement | null;
    if (exclInput) {
        chrome.storage.local.get(['exclusionPhrases'], prefs => {
            if (prefs.exclusionPhrases && exclInput.isConnected) exclInput.value = prefs.exclusionPhrases;
        });
        scope.listen(exclInput, 'input', () => {
            const val = exclInput.value;
            chrome.storage.local.set({exclusionPhrases: val})
                .catch(() => console.warn('NMA extension: could not save the exclusion list.'));
            setExclusionPhrases(val.split(',').map(p => p.trim().toLowerCase()).filter(p => p));
            applyFilters();
        });
    }

    const startInput = host.querySelector('#nma-last-updated-start') as HTMLInputElement | null;
    const endInput = host.querySelector('#nma-last-updated-end') as HTMLInputElement | null;
    const clearButton = host.querySelector('#nma-last-updated-clear');
    if (startInput && endInput) {
        startInput.value = getLastUpdatedStart() || '';
        endInput.value = getLastUpdatedEnd() || '';

        const persist = () => {
            setLastUpdatedStart(startInput.value || '');
            setLastUpdatedEnd(endInput.value || '');
            chrome.storage.local.set({lastUpdatedStart: getLastUpdatedStart(), lastUpdatedEnd: getLastUpdatedEnd()})
                .catch(() => console.warn('NMA extension: could not save the date range.'));
            applyFilters();
        };

        scope.listen(startInput, 'change', persist);
        scope.listen(endInput, 'change', persist);
        if (clearButton) {
            scope.listen(clearButton, 'click', () => {
                startInput.value = '';
                endInput.value = '';
                persist();
            });
        }
    }

    const currentPage = getCurrentPage();
    const pageInput = host.querySelector('#nma-page-input') as HTMLInputElement | null;
    const prevPageBtn = host.querySelector('#nma-prev-page') as HTMLButtonElement | null;
    const nextPageBtn = host.querySelector('#nma-next-page') as HTMLButtonElement | null;

    if (pageInput) {
        pageInput.value = String(currentPage);
        scope.listen(pageInput, 'keydown', e => {
            if (e.key !== 'Enter') return;
            const page = parseInt(pageInput.value, 10);
            if (page && page > 0) navigateToPage(page);
        });
        scope.listen(pageInput, 'change', () => {
            const page = parseInt(pageInput.value, 10);
            if (page && page > 0) navigateToPage(page);
        });
    }

    if (prevPageBtn) {
        prevPageBtn.disabled = currentPage <= 1;
        scope.listen(prevPageBtn, 'click', () => {
            if (currentPage > 1) navigateToPage(currentPage - 1);
        });
    }

    if (nextPageBtn) {
        scope.listen(nextPageBtn, 'click', () => navigateToPage(currentPage + 1));
    }

    const refreshBtn = host.querySelector('#nma-refresh-panel');
    if (refreshBtn) scope.listen(refreshBtn, 'click', () => window.location.reload());

    const collapseToggle = host.querySelector('#nma-panel-toggle');
    if (collapseToggle) scope.listen(collapseToggle, 'click', () => setPanelCollapsed(!filtersCollapsed, true));
    setPanelCollapsed(filtersCollapsed);
}

function wireActionControls(bar: HTMLElement, scope: Scope): void {
    const selectionButton = bar.querySelector('#nma-download-selected');
    const downloadVisibleButton = bar.querySelector('#nma-download-visible');
    const downloadModeSelect = bar.querySelector('#nma-download-mode') as HTMLSelectElement | null;

    chrome.storage.local.get(['downloadMode'], prefs => {
        if (downloadModeSelect?.isConnected) downloadModeSelect.value = prefs.downloadMode || 'MANUAL';
    });

    if (downloadModeSelect) {
        scope.listen(downloadModeSelect, 'change', () => {
            chrome.storage.local.set({downloadMode: downloadModeSelect.value})
                .catch(() => console.warn('NMA extension: could not save the download mode.'));
        });
    }

    if (downloadVisibleButton) {
        scope.listen(downloadVisibleButton, 'click', () => {
            // Read the button's own state, not a module flag: what the control
            // does has to be what the control says, including on a bar that was
            // rebuilt after the run started.
            if (downloadVisibleButton.classList.contains('nma-chip-stop')) {
                abortBatch('stopped by user');
                return;
            }
            downloadAllMods();
        });
    }
    if (selectionButton) scope.listen(selectionButton, 'click', () => downloadSelectedMods());

    // Selections now outlive a page load, so the way to undo them has to be
    // reachable from the same bar that shows them.
    const clearSelectionButton = bar.querySelector('#nma-clear-selection');
    if (clearSelectionButton) scope.listen(clearSelectionButton, 'click', () => clearAllSelections());

    // A bar rebuilt mid-run (the health check re-attaches on a grid re-render)
    // would otherwise come back with no way out of the run that is still going.
    if (isBatchInFlight()) setBatchControlsBusy(true);
}

// ── Surface ──────────────────────────────────────────────────────────

function filterBarSurface(grid: HTMLElement, verdictsPossible: boolean): Surface {
    return {
        id: FILTER_BAR_ID,
        isMounted(): boolean {
            return isPanelMounted();
        },
        mount(scope: Scope): void {
            const parent = grid.parentElement;
            if (!parent) return;

            document.querySelectorAll(`#${FILTER_BAR_ID}, #${ACTION_BAR_ID}`).forEach(el => el.remove());

            const host = document.createElement('div');
            host.id = FILTER_BAR_ID;
            // Named landmarks: the two bars are the extension's whole UI on this
            // page, and without a name they are two unlabelled divs to navigate by.
            host.setAttribute('role', 'region');
            host.setAttribute('aria-label', t('content_filtersRegionLabel'));
            host.style.setProperty('--nma-header-offset', `${pageHeaderOffset()}px`);
            host.innerHTML = renderFilterBarMarkup(verdictsPossible);
            parent.insertBefore(host, grid);
            // Owned only after a successful insert, so a throwing insert cannot
            // arm the guard with a node that was never shown.
            scope.mount(host);

            const actionBar = document.createElement('div');
            actionBar.id = ACTION_BAR_ID;
            actionBar.setAttribute('role', 'region');
            actionBar.setAttribute('aria-label', t('content_downloadsRegionLabel'));
            actionBar.classList.add('nma-action-hidden');
            actionBar.setAttribute('inert', '');
            actionBar.innerHTML = renderActionBarMarkup();
            document.body.appendChild(actionBar);
            scope.mount(actionBar);

            wireFilterControls(host, scope);
            wireActionControls(actionBar, scope);

            scope.listen(document, 'nma:rate-limit', (e: CustomEvent) => {
                const el = document.getElementById('nma-action-rate');
                if (!el) return;
                const {remaining} = e.detail || {};
                if (remaining === null || remaining === undefined) {
                    el.textContent = '';
                    el.classList.remove('nma-rate-warning');
                    return;
                }
                el.textContent = t('content_apiRemaining', [String(remaining)]);
                el.classList.toggle('nma-rate-warning', remaining < 100);
            });
        }
    };
}

export function injectFilterBar(gridElement: HTMLElement, routeScope?: Scope, verdictsPossible = true): void {
    let scope = routeScope;
    if (!scope) {
        // Standalone callers still get a real lifecycle rather than module globals.
        if (!fallbackScope?.alive) fallbackScope = createScope('panel-fallback');
        scope = fallbackScope;
    }
    mountSurface(filterBarSurface(gridElement, verdictsPossible), scope);
}

export function hydratePanelCollapse(collapsed: boolean): void {
    setPanelCollapsed(collapsed);
}
