// --- Badge / indicator rendering extracted from content.ts ---

import { nmaMessageWithRetry } from './messaging';
import { classifyError } from './report';
import { badgeMountPoint, badgeAnchorSibling } from './selectors';
import { t } from '../i18n';

// ── Status configuration ────────────────────────────────────────────
// UNKNOWN means "we looked and the mod does not say".
// FAILED means "we could not look". They must never share a color.

export interface StatusConfigEntry {
    readonly label: string;
    readonly tone: string;
}

// The label is a getter, not a value: this object is built when the module is
// evaluated, which on some load orders is before chrome.i18n can answer, so the
// lookup has to happen at the moment a caller reads .label.
export const STATUS_CONFIG: Record<string, StatusConfigEntry> = {
    COMPATIBLE: {get label(): string { return t('content_statusCompatible'); }, tone: 'success'},
    LIKELY_COMPATIBLE: {get label(): string { return t('content_statusLikelyCompatible'); }, tone: 'likely'},
    INCOMPATIBLE: {get label(): string { return t('content_statusIncompatible'); }, tone: 'danger'},
    UNKNOWN: {get label(): string { return t('content_statusUnknown'); }, tone: 'muted'},
    FAILED: {get label(): string { return t('content_statusFailed'); }, tone: 'muted'},
    NOT_CONFIGURED: {get label(): string { return t('content_statusNotConfigured'); }, tone: 'muted'}
};

// NOT_CONFIGURED is a state of the extension, not a verdict about a mod, so it
// is never offered as a filter: a tile in that state must stay visible.
export const FILTERABLE_STATUSES = ['COMPATIBLE', 'LIKELY_COMPATIBLE', 'INCOMPATIBLE', 'UNKNOWN', 'FAILED'];

const EVIDENCE_KEYS: Record<string, string> = {
    FILE_VERSION: 'content_evidenceFileVersion',
    FILE_NAME: 'content_evidenceFileName',
    CHANGELOG: 'content_evidenceChangelog',
    DESCRIPTION: 'content_evidenceDescription',
    UPLOAD_DATE: 'content_evidenceUploadDate',
    NONE: 'content_evidenceNone'
};

const CONFIDENCE_KEYS: Record<string, string> = {
    EXACT: 'content_confidenceExact',
    INFERRED: 'content_confidenceInferred',
    NONE: 'content_confidenceNone'
};

// ── Context interface ───────────────────────────────────────────────
export interface BadgeContext {
    getModFiles: (key: string) => any[] | undefined;
    setModFiles: (key: string, files: any[]) => void;
    getSelection: () => Map<string, any>;
    getShowOldFiles: () => boolean;
    getShowUpdateFiles: () => boolean;
    getShowOptionalFiles: () => boolean;
    getShowMiscFiles: () => boolean;
    fetchModFilesList: (modId: string, gameDomain: string) => Promise<any[]>;
    getFileCategory: (file: any) => number;
    syncSelectionCheckbox: (card: any, checked: boolean, silent?: boolean) => void;
    updateSelectionButton: () => void;
    checkAndPromptDependencies: (modId: string, gameDomain: string, modName?: string) => Promise<boolean>;
    runFileDownloads?: (modId: string, gameDomain: string, fileIds: number[], report: (fileId: number, ok: boolean, reason?: string) => void) => Promise<void>;
}

let ctx: BadgeContext;

export function initBadges(context: BadgeContext): void {
    ctx = context;
}

// ── Tile lookup ─────────────────────────────────────────────────────
// Requirement cells carry data-mod-id too, so a bare attribute query can
// resolve to something that is not a tile.
export function findCardForMod(modId: string): HTMLElement | null {
    return document.querySelector(`[data-nma-processed][data-mod-id="${modId}"]`);
}

// ── Indicator mount point ───────────────────────────────────────────

export function resolveIndicatorMount(card) {
    let container = card.querySelector('.nma-inline-wrapper');
    if (container) {
        return container;
    }

    container = document.createElement('div');
    container.className = 'nma-inline-wrapper';

    // Containment is asserted: the dedup query above is card-scoped, so a wrapper
    // inserted outside the card could never be found again and would multiply.
    const anchor = badgeAnchorSibling(card);
    const parent = anchor ? anchor.parentElement : null;
    if (anchor && parent && card.contains(parent) && parent !== card) {
        parent.insertBefore(container, anchor.nextSibling);
    } else {
        badgeMountPoint(card).appendChild(container);
    }

    return container;
}

// Wrappers created before containment was asserted, or orphaned by a re-render,
// have no owning tile and would otherwise sit in the grid for the session.
export function sweepOrphanBadges(): void {
    document.querySelectorAll('.nma-inline-wrapper').forEach(el => {
        if (!el.closest('[data-nma-processed]')) el.remove();
    });
}

// ── Inline badge indicator ──────────────────────────────────────────

export function attachInlineIndicator(card, text, tone, loading = false, detail = '', hasFile = false, statusKey = undefined, evidence = null) {
    const mount = resolveIndicatorMount(card);
    let flag = mount.querySelector('.nma-inline-flag');
    if (!flag) {
        flag = document.createElement('div');
        flag.className = 'nma-inline-flag';
        mount.appendChild(flag);
    }

    // A badge belongs to a mod, not to a slot in the grid. If the node was
    // recycled for a different mod, nothing from the previous one survives.
    const modId = card.dataset.modId || '';
    if (flag.dataset.nmaModId && flag.dataset.nmaModId !== modId) {
        flag.innerHTML = '';
    }
    flag.dataset.nmaModId = modId;

    // Preserve an open Files dropdown across the rebuild: the user's ticks live
    // in it and a background re-render must not throw their work away.
    const openDropdown = flag.querySelector('.nma-files-dropdown');
    if (openDropdown) openDropdown.remove();

    flag.className = `nma-inline-flag tone-${tone}`;
    if (statusKey) flag.classList.add(`nma-status-${statusKey}`);
    flag.classList.toggle('nma-inline-loading', !!loading);
    flag.title = '';

    flag.innerHTML = '';
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

    if (!loading) {
        const filesBtn = document.createElement('button');
        filesBtn.type = 'button';
        filesBtn.className = 'nma-files-button';
        filesBtn.textContent = t('content_filesButton');
        const modName = card.dataset.nmaModName;
        filesBtn.setAttribute('aria-label', modName ? t('content_filesButtonForMod', [modName]) : t('content_filesButtonForThisMod'));
        filesBtn.setAttribute('aria-expanded', 'false');
        filesBtn.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            toggleFilesDropdown(card, flag);
        });
        flag.appendChild(filesBtn);
    }

    const tooltipText = buildTooltip(detail, evidence);
    if (tooltipText) {
        const tooltip = document.createElement('div');
        tooltip.className = 'nma-badge-tooltip';
        tooltip.textContent = tooltipText;
        flag.appendChild(tooltip);
    }

    if (openDropdown) {
        flag.appendChild(openDropdown);
        markFilesExpanded(flag, true);
    }
}

function buildTooltip(detail, evidence): string {
    const parts: string[] = [];
    if (detail) parts.push(detail);
    if (evidence) {
        if (evidence.detectedVersion) parts.push(t('content_tooltipDetectedVersion', [String(evidence.detectedVersion)]));
        if (evidence.evidenceSource) {
            const sourceKey = EVIDENCE_KEYS[evidence.evidenceSource];
            parts.push(t('content_tooltipEvidence', [sourceKey ? t(sourceKey) : String(evidence.evidenceSource)]));
        }
        if (evidence.confidence) {
            const confidenceKey = CONFIDENCE_KEYS[evidence.confidence];
            parts.push(t('content_tooltipConfidence', [confidenceKey ? t(confidenceKey) : String(evidence.confidence)]));
        }
        if (evidence.evidenceText) parts.push(t('content_tooltipMatched', [String(evidence.evidenceText)]));
    }
    return parts.join('\n');
}

// ── Files dropdown ──────────────────────────────────────────────────

export async function toggleFilesDropdown(card, flag) {
    const modId = card.dataset.modId;
    const gameDomain = card.dataset.gameDomain;
    return openFilesDropdown(flag, modId, gameDomain, card);
}

export async function toggleRequirementFilesDropdown(cell, flag, modId, gameDomain) {
    return openFilesDropdown(flag, modId, gameDomain, null);
}

// The Files control opens a panel, and a control that says nothing about the
// state it is in is a control a keyboard user has to open to find out.
function markFilesExpanded(flag, expanded: boolean): void {
    const button = flag?.querySelector?.('.nma-files-button');
    if (button) button.setAttribute('aria-expanded', String(expanded));
}

async function openFilesDropdown(flag, modId, gameDomain, card) {
    const existing = flag.querySelector('.nma-files-dropdown');
    if (existing) {
        existing.remove();
        markFilesExpanded(flag, false);
        delete flag.dataset.nmaFilesLoading;
        return;
    }

    if (flag.dataset.nmaFilesLoading === '1') return;
    flag.dataset.nmaFilesLoading = '1';

    document.querySelectorAll('.nma-files-dropdown').forEach(other => {
        markFilesExpanded(other.parentElement, false);
        other.remove();
    });

    const dropdown = document.createElement('div');
    dropdown.className = 'nma-files-dropdown';
    dropdown.setAttribute('role', 'group');
    dropdown.setAttribute('aria-label', t('content_filesDropdownLabel'));
    dropdown.dataset.nmaModId = String(modId || '');
    dropdown.dataset.nmaGameDomain = String(gameDomain || '');
    dropdown.textContent = t('content_filesLoading');
    flag.appendChild(dropdown);
    markFilesExpanded(flag, true);

    const cacheKey = `${gameDomain}:${modId}`;

    try {
        let files = ctx.getModFiles(cacheKey);
        if (!files) {
            const resp = await nmaMessageWithRetry({type: 'GET_MOD_FILES', modId, gameDomain});
            if (resp && resp.ok && Array.isArray(resp.files)) {
                files = resp.files;
            } else if (Array.isArray(resp)) {
                files = resp;
            } else if (resp && Array.isArray(resp.files)) {
                files = resp.files;
            }

            if (files) {
                ctx.setModFiles(cacheKey, files);
            } else {
                throw new Error(resp?.error || t('content_filesFetchFailed'));
            }
        }

        if (!dropdown.isConnected) return;
        renderFilesList(dropdown, files, modId, gameDomain, card);
    } catch (err) {
        if (!dropdown.isConnected) return;
        dropdown.textContent = t('content_filesLoadFailed', [classifyError(err).message]);
    } finally {
        delete flag.dataset.nmaFilesLoading;
    }
}

// A category toggle that leaves an open list showing the old categories is a
// control that half works. Re-render from the cached file list instead.
export function refreshOpenFileLists(): void {
    document.querySelectorAll<HTMLElement>('.nma-files-dropdown').forEach(dropdown => {
        const modId = dropdown.dataset.nmaModId;
        const gameDomain = dropdown.dataset.nmaGameDomain;
        if (!modId || !gameDomain) return;
        const files = ctx?.getModFiles(`${gameDomain}:${modId}`);
        if (!files) return;
        renderFilesList(dropdown, files, modId, gameDomain);
    });
}

// ── Render categorized files list ───────────────────────────────────

export function renderFilesList(dropdown, files, modId, gameDomain, cardHint = null) {
    const card = cardHint || findCardForMod(modId);
    dropdown.innerHTML = '';

    const getFileCategory = ctx.getFileCategory;

    // Categories: 1 = Main, 2 = Update, 3 = Optional, 4 = Old, 5 = Misc, 7 = Archived
    const mainFiles = files.filter(f => getFileCategory(f) === 1);
    const updateFiles = files.filter(f => getFileCategory(f) === 2);
    const optionalFiles = files.filter(f => getFileCategory(f) === 3);
    const miscFiles = files.filter(f => getFileCategory(f) === 5);
    const oldFiles = files.filter(f => getFileCategory(f) === 4 || getFileCategory(f) === 7);

    const sections: Array<[string, any[], boolean]> = [
        [t('content_fileCategoryMain'), mainFiles, true],
        [t('content_fileCategoryUpdate'), updateFiles, ctx.getShowUpdateFiles()],
        [t('content_fileCategoryOptional'), optionalFiles, ctx.getShowOptionalFiles()],
        [t('content_fileCategoryMisc'), miscFiles, ctx.getShowMiscFiles()],
        [t('content_fileCategoryOld'), oldFiles, ctx.getShowOldFiles()]
    ];

    const shown = sections.filter(([, , visible]) => visible);
    const hiddenWithFiles = sections.filter(([, list, visible]) => !visible && list.length > 0);
    const hasVisibleFiles = shown.some(([, list]) => list.length > 0);

    if (!hasVisibleFiles) {
        dropdown.textContent = hiddenWithFiles.length > 0
            ? t('content_filesNoneInActiveCategories', [hiddenWithFiles.map(([label]) => label).join(', ')])
            : t('content_filesNoneForMod');
        return;
    }

    const selection = ctx.getSelection();
    const entry = selection.get(modId) || { modId, gameDomain, fileIds: new Set() };
    const selectedFileIds: Set<number> = entry.fileIds;

    const status = document.createElement('div');
    status.className = 'nma-files-status';
    // Progress and outcome are written here while the button text is a counter,
    // so it has to announce rather than change silently.
    status.setAttribute('role', 'status');

    const dlBtn = document.createElement('button');
    dlBtn.type = 'button';
    dlBtn.className = 'nma-download-selected';
    dlBtn.textContent = t('content_downloadSelected');
    dlBtn.disabled = selectedFileIds.size === 0;

    const rowByFileId = new Map<number, HTMLElement>();

    const addFiles = (fileList, label) => {
        if (fileList.length === 0) return;

        const catLabel = document.createElement('div');
        catLabel.className = 'nma-category-label';
        catLabel.textContent = label;
        dropdown.appendChild(catLabel);

        fileList.forEach(file => {
            const item = document.createElement('div');
            item.className = 'nma-file-item';
            rowByFileId.set(file.file_id, item);

            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.value = file.file_id;
            // The row is a div, so the checkbox has no label to take a name from.
            cb.setAttribute('aria-label', t('content_fileCheckboxLabel', [file.name || t('content_fileFallbackName'), label]));
            cb.checked = selectedFileIds.has(file.file_id);
            cb.addEventListener('change', () => {
                if (cb.checked) {
                    selectedFileIds.add(file.file_id);
                    if (!selection.has(modId)) {
                        selection.set(modId, entry);
                    }
                } else {
                    selectedFileIds.delete(file.file_id);
                    if (selectedFileIds.size === 0) {
                        selection.delete(modId);
                    }
                }

                if (card) ctx.syncSelectionCheckbox(card, selection.has(modId), true);

                ctx.updateSelectionButton();
                dlBtn.disabled = selectedFileIds.size === 0;
            });

            const info = document.createElement('div');
            info.className = 'nma-file-info';

            const name = document.createElement('div');
            name.className = 'nma-file-name';
            name.textContent = file.name;
            name.title = file.name;

            const meta = document.createElement('div');
            meta.className = 'nma-file-meta';
            const sizeStr = file.size_kb
                ? (file.size_kb > 1024
                    ? t('content_fileSizeMb', [(file.size_kb / 1024).toFixed(1)])
                    : t('content_fileSizeKb', [String(file.size_kb)]))
                : t('content_fileSizeUnknown');
            const dateStr = file.uploaded_timestamp ? new Date(file.uploaded_timestamp * 1000).toLocaleDateString() : t('content_fileDateUnknown');
            meta.textContent = t('content_fileMeta', [String(file.version || '?'), sizeStr, dateStr]);

            const outcome = document.createElement('div');
            outcome.className = 'nma-file-outcome';

            info.appendChild(name);
            info.appendChild(meta);
            info.appendChild(outcome);
            item.appendChild(cb);
            item.appendChild(info);

            item.addEventListener('click', (e) => {
                if (e.target !== cb) {
                    cb.checked = !cb.checked;
                    cb.dispatchEvent(new Event('change'));
                }
            });

            dropdown.appendChild(item);
        });
    };

    shown.forEach(([label, list]) => addFiles(list, label));

    if (hiddenWithFiles.length > 0) {
        const note = document.createElement('div');
        note.className = 'nma-files-note';
        note.textContent = t('content_filesHiddenByFilters', [
            hiddenWithFiles.map(([label, list]) => t('content_fileCategoryWithCount', [label, String(list.length)])).join(', ')
        ]);
        dropdown.appendChild(note);
    }

    dlBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (dlBtn.disabled) return;

        const modName = (card && card.dataset.nmaModName) || '';
        const proceed = await ctx.checkAndPromptDependencies(modId, gameDomain, modName);
        if (!proceed) return;

        const ids = Array.from(selectedFileIds);
        if (ids.length === 0) return;

        const originalLabel = dlBtn.textContent;
        dlBtn.disabled = true;
        dlBtn.textContent = t('content_downloadingProgress', ['0', String(ids.length)]);

        let done = 0;
        let failed = 0;
        const report = (fileId: number, ok: boolean, reason?: string) => {
            done += 1;
            if (!ok) failed += 1;
            const row = rowByFileId.get(fileId);
            const outcome = row?.querySelector('.nma-file-outcome');
            if (outcome) {
                outcome.textContent = ok ? t('content_fileOutcomeQueued') : t('content_fileOutcomeFailed', [reason || t('content_reasonUnknown')]);
                outcome.classList.toggle('nma-file-outcome-failed', !ok);
            }
            if (dlBtn.isConnected) dlBtn.textContent = t('content_downloadingProgress', [String(done), String(ids.length)]);
        };

        try {
            if (ctx.runFileDownloads) {
                await ctx.runFileDownloads(modId, gameDomain, ids, report);
            } else {
                for (const fileId of ids) {
                    try {
                        await nmaMessageWithRetry({type: 'DOWNLOAD_MOD', modId, fileId, gameDomain});
                        report(fileId, true);
                    } catch (err) {
                        report(fileId, false, classifyError(err).message);
                    }
                }
            }
        } finally {
            // Runs even on throw: a dead button is worse than a failed download.
            if (dlBtn.isConnected) {
                dlBtn.disabled = selectedFileIds.size === 0;
                dlBtn.textContent = originalLabel;
            }
            if (status.isConnected) {
                status.textContent = failed === 0
                    ? t(done === 1 ? 'content_filesQueuedOne' : 'content_filesQueuedMany', [String(done)])
                    : t('content_filesQueuedWithFailures', [String(done - failed), String(failed)]);
                status.classList.toggle('nma-files-status-failed', failed > 0);
            }
        }
    });

    dropdown.appendChild(status);
    dropdown.appendChild(dlBtn);
}
