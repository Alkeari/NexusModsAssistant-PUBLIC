// --- Filter state and logic extracted from content.ts ---

import { STATUS_CONFIG } from './badges';
import { findGrid, cardCategoryText } from './selectors';

// ── Filter state ───────────────────────────────────────────────────
const enabledStatuses = new Set(Object.keys(STATUS_CONFIG));
let exclusionPhrases: string[] = [];
let showOldFiles = false;
// File category toggles (Main Files always shown)
let showUpdateFiles = true;
let showOptionalFiles = true;
let showMiscFiles = true;
// Last updated filter (YYYY-MM-DD inputs; empty = no bound)
let lastUpdatedStart = '';
let lastUpdatedEnd = '';
// Mirrors the popup's setting, which until now only rewrote the Browse URL.
let hideTranslations = true;

export interface DateFilterReport {
    active: boolean;
    total: number;
    dated: number;
    undatedHidden: number;
    selectorLikelyBroken: boolean;
}

export interface TranslationFilterReport {
    active: boolean;
    hidden: number;
    /** No tile on the page exposed a category, so the filter could not look. */
    signalUnavailable: boolean;
}

let dateReport: DateFilterReport = {active: false, total: 0, dated: 0, undatedHidden: 0, selectorLikelyBroken: false};
let translationReport: TranslationFilterReport = {active: false, hidden: 0, signalUnavailable: false};
let onFiltersApplied: ((report: DateFilterReport) => void) | null = null;

export function setFiltersAppliedHandler(handler: ((report: DateFilterReport) => void) | null): void {
    onFiltersApplied = handler;
}

export function getDateFilterReport(): DateFilterReport {
    return dateReport;
}

export function getTranslationFilterReport(): TranslationFilterReport {
    return translationReport;
}

// ── Getters / setters ──────────────────────────────────────────────
export function getEnabledStatuses(): Set<string> { return enabledStatuses; }
export function isStatusEnabled(status: string): boolean { return enabledStatuses.has(status); }
export function toggleStatus(status: string, enabled: boolean): void {
    if (enabled) {
        enabledStatuses.add(status);
    } else {
        enabledStatuses.delete(status);
    }
}

export function setExclusionPhrases(phrases: string[]): void { exclusionPhrases = phrases; }
export function getExclusionPhrases(): string[] { return [...exclusionPhrases]; }

export function setLastUpdatedStart(v: string): void { lastUpdatedStart = v; }
export function getLastUpdatedStart(): string { return lastUpdatedStart; }

export function setLastUpdatedEnd(v: string): void { lastUpdatedEnd = v; }
export function getLastUpdatedEnd(): string { return lastUpdatedEnd; }

export function setShowOldFiles(v: boolean): void { showOldFiles = v; }
export function getShowOldFiles(): boolean { return showOldFiles; }

export function setShowUpdateFiles(v: boolean): void { showUpdateFiles = v; }
export function getShowUpdateFiles(): boolean { return showUpdateFiles; }

export function setShowOptionalFiles(v: boolean): void { showOptionalFiles = v; }
export function getShowOptionalFiles(): boolean { return showOptionalFiles; }

export function setShowMiscFiles(v: boolean): void { showMiscFiles = v; }
export function getShowMiscFiles(): boolean { return showMiscFiles; }

export function setHideTranslations(v: boolean): void { hideTranslations = v; }
export function getHideTranslations(): boolean { return hideTranslations; }

/**
 * Nexus names the category in English on every locale of the site, and both the
 * singular and the plural are in use ("Translation", "Translations"). Matching
 * the stem covers both without reaching for the mod title, which is where a
 * heuristic would start hiding mods the user actually wanted.
 */
export function isTranslationCategory(text: string | null): boolean {
    return typeof text === 'string' && /translat/i.test(text);
}

// ── Restore the page to its unfiltered state ───────────────────────
export function unhideAllCards(): void {
    document.querySelectorAll('.nma-hidden').forEach(card => card.classList.remove('nma-hidden'));
}

// ── Apply filters ──────────────────────────────────────────────────
export function applyFilters(): void {
    // Tiles only. The mod detail page stamps the same attribute on its header and
    // on its virtual card, and those carry no update date: counting them made the
    // broken-selector heuristic fire on a healthy page, and hiding them deleted
    // the only badge on that page.
    const grid = findGrid();
    const cards = grid ? Array.from(grid.querySelectorAll<HTMLElement>('[data-nma-processed]')) : [];

    const parseLocalDateToEpochSeconds = (value, endOfDay = false) => {
        const v = String(value || '').trim();
        if (!v) return null;
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
        if (!m) return null;
        const year = parseInt(m[1], 10);
        const month = parseInt(m[2], 10) - 1;
        const day = parseInt(m[3], 10);
        if (endOfDay) {
            return Math.floor(new Date(year, month, day, 23, 59, 59, 999).getTime() / 1000);
        }
        return Math.floor(new Date(year, month, day, 0, 0, 0, 0).getTime() / 1000);
    };

    const startEpoch = parseLocalDateToEpochSeconds(lastUpdatedStart, false);
    const endEpoch = parseLocalDateToEpochSeconds(lastUpdatedEnd, true);
    const dateFilterActive = startEpoch !== null || endEpoch !== null;

    const dated = cards.filter(card => {
        const raw = card.dataset.nmaUpdatedAt;
        return !!raw && Number.isFinite(parseInt(raw, 10));
    }).length;

    // Zero timestamps across a whole page is a broken selector, not a data gap.
    // Hiding everything in that case would be a lie about the mods; refusing to
    // filter and saying so is the honest failure.
    const selectorLikelyBroken = dateFilterActive && cards.length > 0 && dated === 0;
    let undatedHidden = 0;

    // Same shape as the date rule above, for the same reason: a page where no
    // tile exposes a category is a page the translation filter cannot read, and
    // hiding nothing while saying so beats hiding everything or hiding silently.
    const categories = cards.map(card => cardCategoryText(card));
    const categorised = categories.filter(text => text !== null).length;
    const translationSignalUnavailable = hideTranslations && cards.length > 0 && categorised === 0;
    const translationFilterActive = hideTranslations && !translationSignalUnavailable;
    let translationsHidden = 0;

    cards.forEach((card, index) => {
        // A tile still being checked has no status yet. Treating that as UNKNOWN
        // hides it the moment Unknown is unchecked, and a hidden tile has a zero
        // rect so it is never observed and never gets a verdict: it disappears
        // permanently without ever having been judged.
        const status = card.dataset.nmaStatus;
        const statusMatch = !status || enabledStatuses.has(status);

        const modName = (card.dataset.nmaModName || '').toLowerCase();
        const isExcluded = exclusionPhrases.some(p => modName.includes(p));

        let passesDateFilter = true;
        if (dateFilterActive && !selectorLikelyBroken) {
            const raw = card.dataset.nmaUpdatedAt;
            const updateTimestamp = raw ? parseInt(raw, 10) : NaN;
            if (Number.isFinite(updateTimestamp)) {
                if (startEpoch !== null && updateTimestamp < startEpoch) passesDateFilter = false;
                if (endEpoch !== null && updateTimestamp > endEpoch) passesDateFilter = false;
            } else {
                // A row the filter cannot evaluate does not silently pass.
                passesDateFilter = false;
                undatedHidden += 1;
            }
        }

        let passesTranslationFilter = true;
        if (translationFilterActive && isTranslationCategory(categories[index])) {
            passesTranslationFilter = false;
            translationsHidden += 1;
        }

        if (statusMatch && !isExcluded && passesDateFilter && passesTranslationFilter) {
            card.classList.remove('nma-hidden');
        } else {
            card.classList.add('nma-hidden');
        }
    });

    dateReport = {
        active: dateFilterActive,
        total: cards.length,
        dated,
        undatedHidden,
        selectorLikelyBroken
    };

    translationReport = {
        active: translationFilterActive,
        hidden: translationsHidden,
        signalUnavailable: translationSignalUnavailable
    };

    if (onFiltersApplied) onFiltersApplied(dateReport);
}
