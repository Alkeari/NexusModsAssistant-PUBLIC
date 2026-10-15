/**
 * downloads.ts - Download, modal, requirements, and file-resolution logic
 * extracted from content.ts.
 *
 * Manages the downloading Set, modFilesMap cache, batch session state,
 * NXM/Vortex link handling, smart file selection, requirement modals,
 * and the generic showNmaModal helper.
 */

import { nmaMessageWithRetry, runLimited, REQUIREMENTS_LANE } from './messaging';
import {
    getShowOldFiles, getShowUpdateFiles,
    getShowOptionalFiles, getShowMiscFiles
} from './filters';
import { getSelection, updateSelectionButton } from './file-picker';
import { STATUS_CONFIG, attachInlineIndicator, findCardForMod } from './badges';
import { extractGameDomain } from './selectors';
import { setBatchControlsBusy, setBatchProgress } from './panel';
import { reportToUser, classifyError, forgetNotice } from './report';
import { getEpoch } from './epoch';
import { t } from '../i18n';

// ── Context interface ────────────────────────────────────────────────
// content.ts injects runtime dependencies that downloads.ts cannot
// import directly (to avoid circular imports).
export interface DownloadsContext {
    getRouteGeneration: () => number;
    getRouteToken: () => string;
    fetchCompatibility: (card: any, generation: number, priority?: string) => void;
}

let ctx: DownloadsContext | null = null;

export function initDownloads(context: DownloadsContext): void {
    ctx = context;
}

// ── State ────────────────────────────────────────────────────────────
const downloading = new Set<string>();
const modFilesMap = new Map(); // key: "gameDomain:modId" -> {ts, files}
const MOD_FILES_TTL_MS = 5 * 60 * 1000;

let batchInFlight = false;
// A token, not a flag: a boolean cleared by the next run would let a loop that
// was already told to stop resume as soon as the user started a new one.
let batchRun = 0;
let vortexNoticeShown = false;
let activeModalClose: ((reason: string) => void) | null = null;
let modalSeq = 0;

export interface BatchSessionState {
    ignoredModLinks: Set<string>;
    batchModIds: Set<string>;
    // No key, a rate limit or Nexus being down fails for the whole run, not for
    // one mod, so the question is asked once and the answer applied to the rest.
    requirementsFailureAnswer?: boolean;
}

export interface DownloadOutcome {
    modId: string;
    fileId?: number | null;
    ok: boolean;
    reason?: string;
    handedToVortex?: boolean;
}

// A reload mid-batch must not leave the buttons dead for the next page.
window.addEventListener('pagehide', () => {
    abortBatch('pagehide');
});

// ── modFilesMap accessors (for badges context) ───────────────────────
export function getModFilesMap(): Map<string, any[]> {
    return modFilesMap;
}

export function getModFilesEntry(key: string): any[] | undefined {
    const entry = modFilesMap.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.ts > MOD_FILES_TTL_MS) {
        modFilesMap.delete(key);
        return undefined;
    }
    return entry.files;
}

export function setModFilesEntry(key: string, files: any[]): void {
    modFilesMap.set(key, {ts: Date.now(), files});
}

export function clearModFilesCache(): void {
    modFilesMap.clear();
}

// ── Downloading set accessor ─────────────────────────────────────────
export function getDownloading(): Set<string> {
    return downloading;
}

export function isBatchInFlight(): boolean {
    return batchInFlight;
}

/**
 * Teardown closes any open modal through its own exit path, so a caller
 * awaiting the prompt settles instead of hanging on a removed overlay.
 */
export function dismissActiveModal(reason = 'teardown'): void {
    if (activeModalClose) activeModalClose(reason);
}

/**
 * Closing the modal only settles the item the run is currently on. Without a
 * flag the loop walks straight to the next mod and opens another prompt on an
 * extension the user has already switched off.
 */
export function abortBatch(reason = 'teardown'): void {
    batchRun += 1;
    batchInFlight = false;
    dismissActiveModal(reason);
    // The abandoned loop can no longer restore the controls: its own finally is
    // guarded on being the current run, which it just stopped being. Without
    // this the bar stays stuck on Stop with no run behind it.
    setBatchControlsBusy(false);
}

// ── File category helper ─────────────────────────────────────────────
export function getFileCategory(file): number {
    if (file.category_name) {
        const name = file.category_name.toUpperCase();
        if (name === 'MAIN') return 1;
        if (name === 'UPDATE' || name === 'UPDATES') return 2;
        if (name === 'OPTIONAL') return 3;
        if (name === 'OLDFILE') return 4;
        if (name === 'OLD_VERSION' || name === 'OLD') return 4;
        if (name === 'MISCELLANEOUS' || name === 'MISC') return 5;
        if (name === 'ARCHIVED') return 7;
    }
    return file.category_id;
}

// ── ensureFileId ─────────────────────────────────────────────────────
export async function ensureFileId(card) {
    const modId = card.dataset.modId;
    const gameDomain = card.dataset.gameDomain;
    if (card.dataset.nmaFileId) {
        return parseInt(card.dataset.nmaFileId, 10) || null;
    }
    const resp = await nmaMessageWithRetry({type: 'RESOLVE_LATEST_FILE', modId, gameDomain});
    const file = resp && (resp.file || resp.result?.file);
    if (file && file.file_id) {
        card.dataset.nmaFileId = String(file.file_id);
        return parseInt(card.dataset.nmaFileId, 10) || null;
    }
    return null;
}

// ── queueDownload ────────────────────────────────────────────────────
export async function queueDownload(card, fileId = null): Promise<DownloadOutcome> {
    const modId = card.dataset.modId;
    const gameDomain = card.dataset.gameDomain;

    let finalFileId = fileId || (card.dataset.nmaFileId ? parseInt(card.dataset.nmaFileId, 10) : null);

    const key = `${modId}:${finalFileId || 'latest'}`;
    if (downloading.has(key)) {
        return {modId, fileId: finalFileId, ok: false, reason: t('content_reasonAlreadyDownloading')};
    }
    downloading.add(key);

    const previousText = readBadgeText(card);
    attachInlineIndicator(card, t('content_preparingDownload'), 'muted', true);

    try {
        if (!finalFileId) {
            try {
                finalFileId = await ensureFileId(card);
            } catch (err) {
                const failure = classifyError(err);
                markDownloadIssue(card, t('content_noFileToDownload'), failure.message);
                return {modId, fileId: null, ok: false, reason: failure.message};
            }
        }
        if (!finalFileId) {
            markDownloadIssue(
                card,
                t('content_noDownloadableFile'),
                t('content_noDownloadableFileDetail')
            );
            return {modId, fileId: null, ok: false, reason: t('content_reasonNoDownloadableFile')};
        }

        const res = await nmaMessageWithRetry({
            type: 'DOWNLOAD_MOD',
            modId,
            fileId: finalFileId,
            gameDomain
        });

        // Both transport shapes are checked: the port rejects on failure, the
        // runtime path resolves with {status:'FAILED'} and no rejection at all.
        if (res?.ok === false || res?.status === 'FAILED' || res?.success === false) {
            const reason = classifyError(new Error(res?.error || res?.message || t('content_downloadFailed'))).message;
            markDownloadIssue(card, t('content_downloadFailed'), reason);
            return {modId, fileId: finalFileId, ok: false, reason};
        }

        markDownloadOk(card, previousText, t('content_downloadStarted'));
        return {modId, fileId: finalFileId, ok: true};
    } catch (err) {
        const failure = classifyError(err);
        markDownloadIssue(card, t('content_downloadFailed'), failure.message);
        return {modId, fileId: finalFileId, ok: false, reason: failure.message};
    } finally {
        downloading.delete(key);
    }
}

function readBadgeText(card): string {
    const node = card.querySelector('.nma-inline-flag .nma-flag-text span:last-child');
    return node?.textContent || '';
}

function markDownloadOk(card, previousText, note): void {
    // No post-download re-check: it re-queried the API for data that had not
    // changed and repainted over the only evidence a download had happened.
    const label = previousText ? t('content_badgeDownloadNote', [previousText, note]) : note;
    attachInlineIndicator(
        card,
        label,
        STATUS_CONFIG[card.dataset.nmaStatus]?.tone || 'muted',
        false,
        t('content_downloadStartedDetail'),
        !!card.dataset.nmaFileId,
        card.dataset.nmaStatus || 'UNKNOWN'
    );
}

// ── updateControlPanelSummary ────────────────────────────────────────
export function updateControlPanelSummary(lastStatus?) {
    const statusListElement = document.getElementById('nma-status-list');
    if (!statusListElement) return;

    const keys = Object.keys(STATUS_CONFIG);
    const totals = {};
    keys.forEach(k => { totals[k] = 0; });

    document.querySelectorAll('[data-nma-status]').forEach(n => {
        const s = (n as HTMLElement).dataset.nmaStatus || 'UNKNOWN';
        if (totals[s] !== undefined) totals[s] += 1;
    });

    statusListElement.innerHTML = '';
    keys.forEach(key => {
        if (key === 'NOT_CONFIGURED' && !totals[key]) return;
        const div = document.createElement('div');
        div.className = 'nma-summary-entry';
        div.textContent = t('content_summaryEntry', [STATUS_CONFIG[key]?.label || key, String(totals[key] || 0)]);
        statusListElement.appendChild(div);
    });

    if (lastStatus) {
        const short = document.createElement('div');
        short.className = 'nma-summary-entry';
        short.style.fontSize = '11px';
        short.style.color = 'var(--nma-text-muted, #6E6E6E)';
        short.textContent = t('content_summaryLastChecked', [STATUS_CONFIG[lastStatus]?.label || lastStatus]);
        statusListElement.appendChild(short);
    }
}

// ── getDownloadMode ──────────────────────────────────────────────────
export async function getDownloadMode(): Promise<string> {
    try {
        const {downloadMode} = await chrome.storage.local.get(['downloadMode']);
        return downloadMode || 'MANUAL';
    } catch (_) {
        return 'MANUAL';
    }
}

// ── openVortexLink ───────────────────────────────────────────────────
export function openVortexLink(gameDomain, modId, fileId, nxmLink = null): boolean {
    const nxm = nxmLink || `nxm://${gameDomain}/mods/${modId}/files/${fileId}`;
    if (!nxm) return false;
    try {
        const a = document.createElement('a');
        a.href = nxm;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        a.remove();
        return true;
    } catch (e) {
        console.warn('NMA: failed to trigger Vortex download', e);
        return false;
    }
}

function noticeVortexOnce(): void {
    if (vortexNoticeShown) return;
    vortexNoticeShown = true;
    reportToUser({
        level: 'info',
        code: 'VORTEX_HANDOFF',
        message: t('content_vortexHandoff'),
        detail: t('content_vortexHandoffDetail')
    });
}

// ── markDownloadIssue ────────────────────────────────────────────────
export function markDownloadIssue(card, message, detail?) {
    if (!card) return;
    attachInlineIndicator(
        card,
        message,
        'muted',
        false,
        detail,
        false,
        card.dataset.nmaStatus || 'UNKNOWN'
    );
}

// ── resolveNxmLinkForFile ────────────────────────────────────────────
export async function resolveNxmLinkForFile(gameDomain, modId, fileId) {
    try {
        const resp = await nmaMessageWithRetry({
            type: 'RESOLVE_NXM_LINK',
            modId,
            fileId,
            gameDomain
        });
        const info = resp?.result || resp;
        return info?.nxm || null;
    } catch (e) {
        console.warn('NMA: failed to resolve NXM link', e);
        return null;
    }
}

// ── Batch plumbing ───────────────────────────────────────────────────

function summarizeBatch(outcomes: DownloadOutcome[], mode: string): void {
    // One stable code, cleared first: a per-run code defeats the dedup and
    // leaves every previous run's summary stacked on the page.
    forgetNotice('BATCH_EMPTY');
    forgetNotice('BATCH_SUMMARY');

    if (outcomes.length === 0) {
        reportToUser({level: 'info', code: 'BATCH_EMPTY', message: t('content_batchEmpty')});
        return;
    }

    const ok = outcomes.filter(o => o.ok).length;
    const failed = outcomes.filter(o => !o.ok);
    const verb = mode === 'VORTEX' ? t('content_batchVerbVortex') : t('content_batchVerbQueued');

    if (failed.length === 0) {
        reportToUser({level: 'info', code: 'BATCH_SUMMARY', message: t('content_batchSummary', [String(ok), verb])});
        return;
    }

    reportToUser({
        level: 'warn',
        code: 'BATCH_SUMMARY',
        message: t('content_batchSummaryWithFailures', [String(ok), verb, String(failed.length)]),
        detail: failed.map(o => t('content_batchFailureDetail', [`${o.modId}${o.fileId ? `/${o.fileId}` : ''}`, o.reason || t('content_reasonUnknown')])).join('; ')
    });
}

async function downloadOneMod(item, card, mode: string, session: BatchSessionState | null, outcomes: DownloadOutcome[], runId?: number): Promise<void> {
    const modName = (card && card.dataset.nmaModName) || item.modName || '';
    const proceed = await checkAndPromptDependencies(item.modId, item.gameDomain, modName, session);
    if (!proceed) {
        // A stopped run dismisses the requirements modal through the same exit as
        // the Skip button, and calling that a skip blames the user's own choice
        // for something they did not choose.
        const stopped = runId !== undefined && batchRun !== runId;
        outcomes.push({
            modId: item.modId,
            ok: false,
            reason: stopped ? t('content_reasonRunStopped') : t('content_reasonSkippedRequirements')
        });
        return;
    }

    const selection = await resolveSmartFileSelectionDetailed(item, card);
    const fileIds = selection.fileIds;

    if (fileIds.length === 0) {
        // Blaming the mod for the user's own click, or for a torn-down run, is a
        // wrong statement about the mod. Each cause is reported as itself.
        if (selection.reason === 'skipped') {
            if (card) markDownloadIssue(card, t('content_skippedAtFilePrompt'), t('content_skippedAtFilePromptDetail'));
            outcomes.push({modId: item.modId, ok: false, reason: t('content_reasonSkippedFilePrompt')});
            return;
        }
        if (selection.reason === 'stopped') {
            if (card) markDownloadIssue(card, t('content_downloadRunStopped'), t('content_downloadRunStoppedDetail'));
            outcomes.push({modId: item.modId, ok: false, reason: t('content_reasonRunStopped')});
            return;
        }
        if (selection.reason === 'error') {
            // resolveSmartFileSelectionDetailed already put the reason on the tile.
            outcomes.push({modId: item.modId, ok: false, reason: t('content_reasonFileListUnreadable')});
            return;
        }
        if (card) {
            markDownloadIssue(card, t('content_noDownloadableFile'), t('content_noDownloadableFileDetail'));
        }
        outcomes.push({modId: item.modId, ok: false, reason: t('content_reasonNoDownloadableFile')});
        return;
    }

    for (const fileId of fileIds) {
        if (mode === 'VORTEX') {
            noticeVortexOnce();
            const nxmLink = await resolveNxmLinkForFile(item.gameDomain, item.modId, fileId);
            if (!nxmLink) {
                if (card) {
                    markDownloadIssue(card, t('content_vortexUnavailable'), t('content_vortexUnavailableDetail'));
                }
                outcomes.push({modId: item.modId, fileId, ok: false, reason: t('content_reasonNoNxmLink')});
                continue;
            }
            const handed = openVortexLink(item.gameDomain, item.modId, fileId, nxmLink);
            if (card) {
                markDownloadIssue(card, handed ? t('content_handedToVortex') : t('content_vortexBlocked'), handed
                    ? t('content_handedToVortexDetail')
                    : t('content_vortexBlockedDetail'));
            }
            outcomes.push({modId: item.modId, fileId, ok: handed, handedToVortex: handed, reason: handed ? undefined : t('content_reasonNxmRefused')});
            await new Promise(r => setTimeout(r, 200));
        } else if (card) {
            outcomes.push(await queueDownload(card, fileId));
        } else {
            outcomes.push(await downloadWithoutCard(item, fileId));
        }
        if (fileIds.length > 1) await new Promise(r => setTimeout(r, 400));
    }
}

async function downloadWithoutCard(item, fileId): Promise<DownloadOutcome> {
    try {
        const res = await nmaMessageWithRetry({type: 'DOWNLOAD_MOD', modId: item.modId, fileId, gameDomain: item.gameDomain});
        if (res?.ok === false || res?.status === 'FAILED' || res?.success === false) {
            return {modId: item.modId, fileId, ok: false, reason: classifyError(new Error(res?.error || res?.message || t('content_downloadFailed'))).message};
        }
        return {modId: item.modId, fileId, ok: true};
    } catch (err) {
        return {modId: item.modId, fileId, ok: false, reason: classifyError(err).message};
    }
}

async function runBatch(items: any[], label: string): Promise<void> {
    if (batchInFlight) {
        reportToUser({level: 'info', code: 'BATCH_BUSY', message: t('content_batchBusy')});
        return;
    }
    batchInFlight = true;
    const myRun = ++batchRun;
    setBatchControlsBusy(true, t('content_batchProgress', [label, '0', String(items.length)]));

    const mode = await getDownloadMode();
    const outcomes: DownloadOutcome[] = [];
    const session: BatchSessionState = {
        ignoredModLinks: new Set(),
        batchModIds: new Set(items.map(i => String(i.modId)))
    };

    try {
        let done = 0;
        for (const item of items) {
            if (batchRun !== myRun) {
                outcomes.push({modId: item.modId, ok: false, reason: t('content_reasonRunStopped')});
                continue;
            }
            done += 1;
            setBatchProgress(t('content_batchProgress', [label, String(done), String(items.length)]));

            // Re-read the world at the point of the irreversible act, not from a
            // click-time snapshot: the grid may have re-rendered since.
            const card = findCardForMod(item.modId);
            if (card?.classList.contains('nma-hidden')) {
                outcomes.push({modId: item.modId, ok: false, reason: t('content_reasonHiddenByFilters')});
                continue;
            }
            await downloadOneMod(item, card, mode, session, outcomes, myRun);
            await new Promise(r => setTimeout(r, 200));
        }
    } catch (err) {
        outcomes.push({modId: 'batch', ok: false, reason: classifyError(err).message});
    } finally {
        // A superseded run must not clear the flag or the label a newer run set.
        if (batchRun === myRun) {
            batchInFlight = false;
            setBatchControlsBusy(false);
        }
        updateSelectionButton();
        summarizeBatch(outcomes, mode);
    }
}

// ── downloadSelectedMods ─────────────────────────────────────────────
export async function downloadSelectedMods() {
    const items = Array.from(getSelection().values()).map(entry => ({
        modId: String(entry.modId),
        gameDomain: entry.gameDomain,
        modName: entry.modName || '',
        fileIds: entry.fileIds
    }));
    await runBatch(items, t('content_batchLabelDownloading'));
}

// ── downloadAllMods ──────────────────────────────────────────────────
export async function downloadAllMods() {
    const items = Array.from(document.querySelectorAll<HTMLElement>('[data-nma-processed][data-mod-id]'))
        .filter(card => !card.classList.contains('nma-hidden'))
        .map(card => ({
            modId: card.dataset.modId,
            gameDomain: card.dataset.gameDomain,
            modName: card.dataset.nmaModName || ''
        }))
        .filter(item => item.modId && item.gameDomain);
    await runBatch(items, t('content_batchLabelDownloadingAll'));
}

// ── Dropdown entry point ─────────────────────────────────────────────
export async function runFileDownloads(
    modId: string,
    gameDomain: string,
    fileIds: number[],
    report: (fileId: number, ok: boolean, reason?: string) => void
): Promise<void> {
    if (batchInFlight) {
        fileIds.forEach(fileId => report(fileId, false, t('content_reasonAnotherRunInProgress')));
        return;
    }
    batchInFlight = true;
    const myRun = ++batchRun;
    setBatchControlsBusy(true, t('content_downloadingEllipsis'));

    const mode = await getDownloadMode();
    const card = findCardForMod(modId);
    const outcomes: DownloadOutcome[] = [];

    try {
        for (const fileId of fileIds) {
            if (batchRun !== myRun) {
                report(fileId, false, t('content_reasonRunStopped'));
                outcomes.push({modId, fileId, ok: false, reason: t('content_reasonRunStopped')});
                continue;
            }
            let outcome: DownloadOutcome;
            if (mode === 'VORTEX') {
                noticeVortexOnce();
                const nxmLink = await resolveNxmLinkForFile(gameDomain, modId, fileId);
                const handed = nxmLink ? openVortexLink(gameDomain, modId, fileId, nxmLink) : false;
                outcome = {modId, fileId, ok: handed, handedToVortex: handed, reason: handed ? undefined : t('content_reasonNoNxmLink')};
            } else if (card) {
                outcome = await queueDownload(card, fileId);
            } else {
                outcome = await downloadWithoutCard({modId, gameDomain}, fileId);
            }
            outcomes.push(outcome);
            report(fileId, outcome.ok, outcome.reason);
            if (fileIds.length > 1) await new Promise(r => setTimeout(r, 400));
        }
    } finally {
        if (batchRun === myRun) {
            batchInFlight = false;
            setBatchControlsBusy(false);
        }
        // Same as runBatch: the restored label is whatever was stashed when the
        // run armed the controls, which is stale if the bar was rebuilt meanwhile.
        updateSelectionButton();
        summarizeBatch(outcomes, mode);
    }
}

// ── showNmaModal ─────────────────────────────────────────────────────
export interface NmaModalOptions {
    title: string;
    body: string | HTMLElement;
    confirmText?: string;
    cancelText?: string;
    skipText?: string;
    // The raw close reason is passed on, so a handler reached through the
    // fallback chain can tell a dismissal from a teardown.
    onConfirm?: (reason?: string) => unknown;
    onCancel?: (reason?: string) => unknown;
    onSkip?: (reason?: string) => unknown;
}

export function showNmaModal({ title, body, confirmText, cancelText, skipText, onConfirm, onCancel, onSkip }: NmaModalOptions) {
    if (activeModalClose) {
        console.warn('NMA extension: a modal was already open; the previous one was dismissed.');
        activeModalClose('superseded');
    }

    const controller = new AbortController();
    const overlay = document.createElement('div');
    overlay.className = 'nma-modal-overlay';

    const modal = document.createElement('div');
    modal.className = 'nma-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');

    const titleId = `nma-modal-title-${++modalSeq}`;
    const titleEl = document.createElement('div');
    titleEl.className = 'nma-modal-title';
    titleEl.id = titleId;
    titleEl.textContent = title;
    modal.setAttribute('aria-labelledby', titleId);

    const bodyEl = document.createElement('div');
    bodyEl.className = 'nma-modal-body';
    if (typeof body === 'string') {
        bodyEl.textContent = body;
    } else {
        bodyEl.appendChild(body);
    }

    const actions = document.createElement('div');
    actions.className = 'nma-modal-actions';

    // Where focus was before the dialog took it. Returning it is the other half
    // of moving it: without this, keyboard focus lands back at the top of the
    // page and the user has to tab through the whole grid again.
    const previouslyFocused = document.activeElement as HTMLElement | null;

    let closed = false;
    const close = (reason: string) => {
        if (closed) return;
        closed = true;
        activeModalClose = null;
        controller.abort();
        overlay.remove();
        if (previouslyFocused?.isConnected) {
            try {
                previouslyFocused.focus();
            } catch (_) { /* the element went away with the page it was on */ }
        }
        if (reason === 'confirm' && onConfirm) onConfirm(reason);
        else if (reason === 'cancel' && onCancel) onCancel(reason);
        else if (reason === 'skip' && onSkip) onSkip(reason);
        else if (onSkip) onSkip(reason);
        else if (onCancel) onCancel(reason);
        else if (onConfirm) onConfirm(reason);
    };
    activeModalClose = close;

    if (skipText) {
        const skipBtn = document.createElement('button');
        skipBtn.type = 'button';
        skipBtn.className = 'secondary';
        skipBtn.style.marginRight = 'auto';
        skipBtn.textContent = skipText;
        skipBtn.addEventListener('click', () => close('skip'), {signal: controller.signal});
        actions.appendChild(skipBtn);
    }

    if (cancelText) {
        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'secondary';
        cancelBtn.textContent = cancelText;
        cancelBtn.addEventListener('click', () => close('cancel'), {signal: controller.signal});
        actions.appendChild(cancelBtn);
    }

    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = 'primary';
    confirmBtn.textContent = confirmText || t('content_modalOk');
    confirmBtn.addEventListener('click', () => close('confirm'), {signal: controller.signal});
    actions.appendChild(confirmBtn);

    modal.appendChild(titleEl);
    modal.appendChild(bodyEl);
    modal.appendChild(actions);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // Every exit resolves the same promise. Escape, the backdrop and the
    // buttons all route through close(), so the awaiting caller cannot hang.
    overlay.addEventListener('click', e => {
        if (e.target === overlay) close('dismiss');
    }, {signal: controller.signal});

    window.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
            close('dismiss');
            return;
        }
        if (e.key !== 'Tab') return;

        // A modal the tab key can walk out of is modal in appearance only: the
        // focus ring disappears into the page behind it with no way back.
        const focusable = Array.from(
            modal.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
        ).filter(el => !el.hasAttribute('disabled'));
        if (focusable.length === 0) return;

        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = document.activeElement as HTMLElement | null;

        if (!active || !modal.contains(active)) {
            e.preventDefault();
            (e.shiftKey ? last : first).focus();
            return;
        }
        if (e.shiftKey && active === first) {
            e.preventDefault();
            last.focus();
        } else if (!e.shiftKey && active === last) {
            e.preventDefault();
            first.focus();
        }
    }, {signal: controller.signal});

    // The body's own first control when there is one to fill in (the target
    // version prompt), the confirm button otherwise.
    const firstBodyControl = bodyEl.querySelector('input, select, textarea, button') as HTMLElement | null;
    (firstBodyControl || confirmBtn).focus();
}

// ── getModRequirements ───────────────────────────────────────────────
export interface RequirementsResult {
    ok: boolean;
    requirements: any[];
    error?: string;
}

export async function getModRequirementsResult(modId, gameDomain): Promise<RequirementsResult> {
    try {
        const resp = await nmaMessageWithRetry({ type: 'GET_MOD_REQUIREMENTS', modId, gameDomain });
        const reqs = resp?.requirements || resp?.result?.requirements || resp;
        if (!Array.isArray(reqs)) {
            return {ok: false, requirements: [], error: t('content_requirementsUnreadable')};
        }
        return {ok: true, requirements: reqs};
    } catch (e) {
        return {ok: false, requirements: [], error: classifyError(e).message};
    }
}

export async function getModRequirements(modId, gameDomain) {
    const result = await getModRequirementsResult(modId, gameDomain);
    return result.requirements;
}

// ── fetchModFilesList ────────────────────────────────────────────────
export interface FilesResult {
    ok: boolean;
    files: any[];
    error?: string;
}

export async function fetchModFilesResult(modId, gameDomain): Promise<FilesResult> {
    const cacheKey = `${gameDomain}:${modId}`;
    const cached = getModFilesEntry(cacheKey);
    if (cached) return {ok: true, files: cached};

    try {
        const resp = await nmaMessageWithRetry({type: 'GET_MOD_FILES', modId, gameDomain});
        let files = null;
        if (resp && resp.ok && Array.isArray(resp.files)) files = resp.files;
        else if (Array.isArray(resp)) files = resp;
        else if (resp && Array.isArray(resp.files)) files = resp.files;

        if (!files) return {ok: false, files: [], error: resp?.error || t('content_fileListUnreadable')};
        setModFilesEntry(cacheKey, files);
        return {ok: true, files};
    } catch (e) {
        return {ok: false, files: [], error: classifyError(e).message};
    }
}

export async function fetchModFilesList(modId, gameDomain) {
    const result = await fetchModFilesResult(modId, gameDomain);
    return result.files;
}

// ── resolveSmartFileSelection ────────────────────────────────────────

/**
 * Why the selection is empty, because the caller cannot tell "this mod has no
 * file" from "the user declined" or "the run was stopped" by looking at [].
 */
export type FileSelectionReason = 'ok' | 'none' | 'skipped' | 'stopped' | 'error';

export interface FileSelection {
    fileIds: number[];
    reason: FileSelectionReason;
}

export async function resolveSmartFileSelection(item, card): Promise<number[]> {
    return (await resolveSmartFileSelectionDetailed(item, card)).fileIds;
}

export async function resolveSmartFileSelectionDetailed(item, card): Promise<FileSelection> {
    const modId = item.modId;
    const gameDomain = item.gameDomain;

    const fileIds: number[] = item.fileIds && item.fileIds.size > 0
        ? Array.from(item.fileIds) as number[]
        : (item.fileId ? [item.fileId] : []);

    if (fileIds.length > 0) return {fileIds, reason: 'ok'};

    const result = await fetchModFilesResult(modId, gameDomain);
    if (!result.ok) {
        if (card) markDownloadIssue(card, t('content_couldNotLoadFileList'), result.error);
        return {fileIds: [], reason: 'error'};
    }

    const files = result.files;
    const mainFiles = files.filter(f => getFileCategory(f) === 1);
    const updateFiles = files.filter(f => getFileCategory(f) === 2);
    const optionalFiles = files.filter(f => getFileCategory(f) === 3);
    const miscFiles = files.filter(f => getFileCategory(f) === 5);
    const oldFiles = files.filter(f => getFileCategory(f) === 4 || getFileCategory(f) === 7);

    // The same category switches the file dropdown honours, or the same mod
    // behaves differently depending on which button started the download.
    const activeFiles = [...mainFiles];
    if (getShowUpdateFiles()) activeFiles.push(...updateFiles);
    if (getShowOptionalFiles()) activeFiles.push(...optionalFiles);
    if (getShowMiscFiles()) activeFiles.push(...miscFiles);
    if (getShowOldFiles()) activeFiles.push(...oldFiles);

    if (activeFiles.length === 0) return {fileIds: [], reason: 'none'};

    if (activeFiles.length === 1) {
        return {fileIds: [activeFiles[0].file_id], reason: 'ok'};
    }

    return new Promise((resolve) => {
        promptFileSelection(modId, gameDomain, mainFiles, optionalFiles, updateFiles, miscFiles, oldFiles,
            (selected: number[], reason: FileSelectionReason = 'ok') => {
                resolve({fileIds: selected, reason: selected.length > 0 ? 'ok' : reason});
            });
    });
}

// ── promptFileSelection ──────────────────────────────────────────────
export function promptFileSelection(modId, gameDomain, mainFiles, optionalFiles, updateFiles, miscFiles, oldFiles, callback) {
    const body = document.createElement('div');
    body.className = 'nma-modal-file-list';

    const selected = new Set();

    const addSection = (files, label) => {
        if (!files || files.length === 0) return;
        const h = document.createElement('div');
        h.className = 'nma-category-label';
        h.style.marginTop = '12px';
        h.textContent = label;
        body.appendChild(h);

        files.forEach(f => {
            const item = document.createElement('div');
            item.className = 'nma-modal-file-item';

            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.addEventListener('change', () => {
                if (cb.checked) selected.add(f.file_id);
                else selected.delete(f.file_id);
            });

            const info = document.createElement('div');
            info.className = 'nma-file-info';
            const name = document.createElement('div');
            name.className = 'nma-file-name';
            name.textContent = f.name;
            const meta = document.createElement('div');
            meta.className = 'nma-file-meta';
            meta.textContent = t('content_fileVersion', [String(f.version || '?')]);

            info.appendChild(name);
            if (f.description) {
                const desc = document.createElement('div');
                desc.className = 'nma-file-desc';
                desc.textContent = f.description;
                info.appendChild(desc);
            }
            info.appendChild(meta);
            item.appendChild(cb);
            item.appendChild(info);

            item.addEventListener('click', (e) => {
                if (e.target !== cb) {
                    cb.checked = !cb.checked;
                    cb.dispatchEvent(new Event('change'));
                }
            });

            body.appendChild(item);
        });
    };

    addSection(mainFiles, t('content_fileCategoryMain'));
    if (getShowUpdateFiles()) addSection(updateFiles, t('content_fileCategoryUpdate'));
    if (getShowOptionalFiles()) addSection(optionalFiles, t('content_fileCategoryOptional'));
    if (getShowMiscFiles()) addSection(miscFiles, t('content_fileCategoryMisc'));
    if (getShowOldFiles()) addSection(oldFiles, t('content_fileCategoryOld'));

    showNmaModal({
        title: t('content_selectFilesTitle'),
        body: body,
        confirmText: t('content_downloadSelected'),
        cancelText: t('content_skipMod'),
        onConfirm: () => callback(Array.from(selected), selected.size > 0 ? 'ok' : 'skipped'),
        onCancel: () => callback([], 'skipped'),
        // Declared so the fallback chain in close() is not load-bearing: Escape
        // and the backdrop are the user declining, a teardown is not.
        onSkip: (reason?: string) => callback([], reason === 'skip' || reason === 'dismiss' ? 'skipped' : 'stopped')
    });
}

function modSubject(modName: string): string {
    return modName ? t('content_quotedModName', [modName]) : t('content_thisMod');
}

function safeHttpUrl(raw: unknown): string | null {
    if (!raw) return null;
    try {
        const url = new URL(String(raw), window.location.origin);
        return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
    } catch (_) {
        return null;
    }
}

// ── checkAndPromptDependencies ───────────────────────────────────────
export async function checkAndPromptDependencies(modId, gameDomain, modName = '', session: BatchSessionState | null = null): Promise<boolean> {
    const result = await getModRequirementsResult(modId, gameDomain);

    if (!result.ok) {
        // "Could not look" must never be reported as "found nothing": a missing
        // dependency is what breaks the user's game.
        if (session && session.requirementsFailureAnswer !== undefined) {
            return session.requirementsFailureAnswer;
        }
        return new Promise((resolve) => {
            // Only a button press is remembered. A dismissal or a teardown is not
            // an answer, and must not decide the rest of the run.
            const answer = (value: boolean, remember: boolean) => {
                if (session && remember) session.requirementsFailureAnswer = value;
                resolve(value);
            };
            showNmaModal({
                title: t('content_requirementsUnverifiedTitle'),
                body: t('content_requirementsUnverifiedBody', [modSubject(modName), result.error])
                    + (session ? t('content_requirementsUnverifiedRunNote') : ''),
                confirmText: t('content_downloadAnyway'),
                cancelText: session ? t('content_skipTheseMods') : t('content_skipThisMod'),
                onConfirm: reason => answer(true, reason === 'confirm'),
                onCancel: reason => answer(false, reason === 'cancel')
            });
        });
    }

    const allReqs = result.requirements;

    const reqs = allReqs.filter(r => {
        if (!r.link) return true;
        if (session?.ignoredModLinks.has(r.link)) return false;
        const m = r.link.match(/\/mods\/(\d+)/);
        if (m && session?.batchModIds.has(m[1])) return false;
        return true;
    });

    if (reqs.length === 0) return true;

    const epoch = getEpoch();
    const routeToken = ctx ? ctx.getRouteToken() : '';
    const reqsWithStatus = await Promise.all(reqs.map(async r => {
        if (!r.link) return { ...r, statusKey: 'UNKNOWN' };
        const m = r.link.match(/\/mods\/(\d+)/);
        if (!m) return { ...r, statusKey: 'UNKNOWN' };
        const reqModId = m[1];
        const reqGameDomain = extractGameDomain(r.link) || gameDomain;
        try {
            const res = await runLimited(
                `check:${reqGameDomain}:${reqModId}:${epoch.id}`,
                () => nmaMessageWithRetry({type: 'CHECK_MOD', modId: reqModId, gameDomain: reqGameDomain, priority: 'NORMAL', routeToken}),
                REQUIREMENTS_LANE
            );
            return { ...r, statusKey: res?.status || 'UNKNOWN' };
        } catch (err) {
            return { ...r, statusKey: 'FAILED', statusDetail: classifyError(err).message };
        }
    }));

    return new Promise((resolve) => {
        const body = document.createElement('div');
        body.className = 'nma-modal-req-list';

        const intro = document.createElement('p');
        intro.textContent = t('content_requirementsIntro', [modSubject(modName)]);
        body.appendChild(intro);

        const list = document.createElement('div');
        list.className = 'nma-req-list';

        const selectedReqs = new Set<{ link?: string }>();

        reqsWithStatus.forEach(r => {
            const item = document.createElement('div');
            item.className = 'nma-req-item';

            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = r.statusKey !== 'INCOMPATIBLE';
            if (cb.checked) selectedReqs.add(r);

            cb.addEventListener('change', () => {
                if (cb.checked) selectedReqs.add(r);
                else selectedReqs.delete(r);
            });

            const content = document.createElement('div');
            content.className = 'nma-req-content';

            const headerRow = document.createElement('div');
            headerRow.style.display = 'flex';
            headerRow.style.alignItems = 'center';
            headerRow.style.gap = '8px';

            const name = document.createElement('div');
            name.className = 'nma-req-name';
            name.textContent = r.link_name || t('content_unknownMod');

            const statusBadge = document.createElement('span');
            statusBadge.className = `nma-req-status-badge tone-${STATUS_CONFIG[r.statusKey]?.tone || 'muted'} nma-status-${r.statusKey}`;
            statusBadge.textContent = STATUS_CONFIG[r.statusKey]?.label || t('content_statusFallbackUnknown');
            if (r.statusDetail) statusBadge.title = r.statusDetail;

            headerRow.appendChild(name);
            headerRow.appendChild(statusBadge);

            // The link is scraped out of the mod page HTML, not returned by the
            // API, so it is whatever the page said. Anything that is not http(s)
            // is shown as text and is not made clickable.
            const href = safeHttpUrl(r.link);
            const link = document.createElement('a');
            link.className = 'nma-req-link';
            link.textContent = r.link || t('content_noLinkProvided');
            if (href) {
                link.href = href;
                link.target = '_blank';
                link.rel = 'noopener noreferrer';
            }

            content.appendChild(headerRow);
            content.appendChild(link);

            if (r.notes) {
                const notes = document.createElement('div');
                notes.className = 'nma-req-notes';
                notes.textContent = r.notes;
                content.appendChild(notes);
            }

            item.appendChild(cb);
            item.appendChild(content);

            item.addEventListener('click', (e) => {
                if (e.target !== cb && e.target !== link) {
                    cb.checked = !cb.checked;
                    cb.dispatchEvent(new Event('change'));
                }
            });

            list.appendChild(item);
        });
        body.appendChild(list);

        showNmaModal({
            title: modName ? t('content_requirementsForMod', [modName]) : t('content_requirementsDetected'),
            body: body,
            confirmText: t('content_installWithRequirements'),
            cancelText: t('content_installWithoutRequirements'),
            skipText: t('content_skipMod'),
            onConfirm: async () => {
                const mode = await getDownloadMode();
                const outcomes: DownloadOutcome[] = [];
                for (const r of selectedReqs) {
                    if (!r.link) continue;
                    const m = r.link.match(/\/mods\/(\d+)/);
                    if (!m) continue;
                    const reqModId = m[1];
                    const reqGameDomain = extractGameDomain(r.link) || gameDomain;

                    try {
                        const latest = await nmaMessageWithRetry({type: 'RESOLVE_LATEST_FILE', modId: reqModId, gameDomain: reqGameDomain});
                        const file = latest && (latest.file || latest.result?.file);
                        if (!file || !file.file_id) {
                            outcomes.push({modId: reqModId, ok: false, reason: t('content_reasonNoDownloadableFile')});
                            continue;
                        }
                        if (mode === 'VORTEX') {
                            noticeVortexOnce();
                            const nxmLink = await resolveNxmLinkForFile(reqGameDomain, reqModId, file.file_id);
                            const handed = nxmLink ? openVortexLink(reqGameDomain, reqModId, file.file_id, nxmLink) : false;
                            outcomes.push({modId: reqModId, fileId: file.file_id, ok: handed, handedToVortex: handed, reason: handed ? undefined : t('content_reasonNoNxmLink')});
                            await new Promise(res => setTimeout(res, 200));
                        } else {
                            outcomes.push(await downloadWithoutCard({modId: reqModId, gameDomain: reqGameDomain}, file.file_id));
                            await new Promise(res => setTimeout(res, 500));
                        }
                    } catch (e) {
                        outcomes.push({modId: reqModId, ok: false, reason: classifyError(e).message});
                    }
                }
                if (outcomes.length > 0) {
                    const failed = outcomes.filter(o => !o.ok);
                    if (failed.length > 0) {
                        forgetNotice('REQS_PARTIAL');
                        reportToUser({
                            level: 'warn',
                            code: 'REQS_PARTIAL',
                            message: t('content_requirementsPartial', [String(outcomes.length - failed.length), String(outcomes.length), String(failed.length)]),
                            detail: failed.map(o => t('content_batchFailureDetail', [String(o.modId), o.reason || t('content_reasonUnknown')])).join('; ')
                        });
                    }
                }
                resolve(true);
            },
            onCancel: () => {
                reqs.forEach(r => {
                    if (r.link && session) {
                        session.ignoredModLinks.add(r.link);
                    }
                });
                resolve(true);
            },
            onSkip: () => {
                resolve(false);
            }
        });
    });
}
