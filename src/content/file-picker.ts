/**
 * file-picker.ts - Selection/checkbox state for mod cards.
 *
 * Manages the `selection` Map that tracks which mods the user has
 * checked for batch download, and provides helpers to create, sync
 * and update the selection UI controls on each card.
 */

import { updateActionBarVisibility } from './panel';
import { selectionMountPoint } from './selectors';
import { t } from '../i18n';
import {
    serializeSelection, deserializeSelection,
    readSelectionRecord, writeSelectionRecord
} from './selection-store';

const selection: Map<string, any> = new Map();

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export function persistSelection(): void {
    writeSelectionRecord(selection.size === 0 ? null : serializeSelection(selection));
}

/**
 * Restore the ticks from before a full page load. Returns how many entries came
 * back, so the caller can tell the user where the ticks came from.
 */
export function restorePersistedSelection(gameDomain: string): number {
    const entries = deserializeSelection(readSelectionRecord(), gameDomain);
    for (const entry of entries) {
        if (selection.has(entry.modId)) continue;
        selection.set(entry.modId, {
            modId: entry.modId,
            gameDomain: entry.gameDomain,
            modName: entry.modName,
            fileIds: entry.fileIds
        });
    }
    return entries.length;
}

// ---------------------------------------------------------------------------
// Public accessors
// ---------------------------------------------------------------------------

export function getSelection(): Map<string, any> {
    return selection;
}

export function getSelectionCount(): number {
    return selection.size;
}

export function getSelectedFileCount(): number {
    let count = 0;
    for (const entry of selection.values()) {
        count += entry?.fileIds?.size > 0 ? entry.fileIds.size : 1;
    }
    return count;
}

/**
 * Drops the ticks from memory only. Teardown uses this, so switching the
 * extension off and on again does not throw the user's work away.
 */
export function clearSelection(): void {
    selection.clear();
}

/**
 * The user-facing clear: forgets the ticks, unticks every rendered tile and
 * drops the saved copy, so the ticks do not come back on the next reload.
 */
export function clearAllSelections(): void {
    selection.clear();
    syncAllSelectionCheckboxes();
    updateSelectionButton();
}

/**
 * Selections survive pagination within one game, which is what the user
 * expects from a checkbox. Entries for another game are dropped, because a
 * mod id only means something inside its own domain.
 */
export function dropSelectionsOutsideDomain(gameDomain: string): number {
    let dropped = 0;
    for (const [modId, entry] of Array.from(selection.entries())) {
        if (entry?.gameDomain && entry.gameDomain !== gameDomain) {
            selection.delete(modId);
            dropped += 1;
        }
    }
    return dropped;
}

// ---------------------------------------------------------------------------
// Checkbox creation & synchronisation
// ---------------------------------------------------------------------------

/**
 * Ensure the card has a selection checkbox.  Creates one if missing and
 * wires up the change handler.  Always syncs the checked state with the
 * current selection Map.
 */
export function ensureSelectionControl(card): void {
    let anchor = card.querySelector('.nma-select-anchor');
    if (!anchor) {
        anchor = document.createElement('label');
        anchor.className = 'nma-select-anchor';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'nma-select-checkbox';
        checkbox.addEventListener('change', event => handleSelectionToggle(card, (event.target as HTMLInputElement).checked));
        const label = document.createElement('span');
        label.textContent = t('content_selectMod');
        anchor.append(checkbox, label);

        const hero = selectionMountPoint(card);
        hero.classList.add('nma-select-host');
        hero.appendChild(anchor);
    }

    const checkbox = anchor.querySelector('input');
    checkbox.disabled = false; // Selection is independent of compatibility/file availability
    checkbox.checked = selection.has(card.dataset.modId);

    // "Select" repeated down a grid of forty tiles says nothing about which mod
    // is being selected. The name is filled in as soon as the tile knows it.
    const modName = card.dataset.nmaModName;
    checkbox.setAttribute('aria-label', modName ? t('content_selectModNamed', [modName]) : t('content_selectThisMod'));
}

/**
 * Called when a card's checkbox value changes. Updates the selection Map
 * accordingly and refreshes the download-selected button.
 */
export function handleSelectionToggle(card, isChecked): void {
    const modId = card.dataset.modId;
    if (isChecked) {
        let entry = selection.get(modId);
        if (!entry) {
            const fileId = card.dataset.nmaFileId ? parseInt(card.dataset.nmaFileId, 10) : null;
            entry = {
                modId,
                fileIds: new Set(),
                gameDomain: card.dataset.gameDomain,
                modName: card.dataset.nmaModName || ''
            };
            if (fileId) entry.fileIds.add(fileId);
            selection.set(modId, entry);
        } else if (!entry.modName) {
            entry.modName = card.dataset.nmaModName || '';
        }
    } else {
        selection.delete(modId);
    }

    updateSelectionButton();
}

/**
 * Synchronise a card's checkbox visual state with the selection Map.
 * Optionally force the checked value via `checked`; when `silent` is
 * true the checkbox is updated even if disabled.
 */
export function syncSelectionCheckbox(card, checked, silent = false): void {
    const checkbox = card.querySelector('.nma-select-checkbox');
    if (checkbox) {
        checkbox.checked = checked;
        if (!silent && checked && checkbox.disabled) {
            checkbox.checked = false;
        }
    }
}

/**
 * Re-apply the selection to every rendered tile. Needed after a route change,
 * where the tiles are new nodes but the selection is deliberately kept.
 */
export function syncAllSelectionCheckboxes(): void {
    document.querySelectorAll<HTMLElement>('[data-nma-processed][data-mod-id]').forEach(card => {
        syncSelectionCheckbox(card, selection.has(card.dataset.modId), true);
    });
}

/**
 * Update the "Download Selected (N)" button text and disabled state.
 * Looks up the button via DOM id so the panel module doesn't need to
 * pass us a reference.
 */
export function updateSelectionButton(): void {
    // Every path that changes the selection ends here: the tile checkbox, the
    // per-file ticks in the dropdown, the fileId a verdict fills in, the batch
    // runner and the cross-game drop. Saving here is what makes restoring as
    // reliable as saving, rather than one call site remembering and four not.
    persistSelection();

    const selectionButton = document.getElementById('nma-download-selected');
    const mods = selection.size;
    const files = getSelectedFileCount();
    if (selectionButton) {
        // One entry can carry several files, so a mod count alone understates the run.
        const label = files > mods
            ? t('content_downloadSelectedModsFiles', [String(mods), String(files)])
            : t('content_downloadSelectedCount', [String(mods)]);
        const stashed = (selectionButton as HTMLElement).dataset.nmaLabel;
        if (stashed === undefined) {
            selectionButton.textContent = label;
            (selectionButton as HTMLButtonElement).disabled = mods === 0;
        } else {
            // A run owns the visible text while it reports progress there. The
            // count is written to the label it will be restored from instead.
            (selectionButton as HTMLElement).dataset.nmaLabel = label;
        }
    }
    updateActionBarVisibility(mods);
}
