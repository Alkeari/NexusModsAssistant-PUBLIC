// Where a selection lives between page loads, and the only reader of it.
//
// sessionStorage rather than chrome.storage.local, for two reasons. A ticked
// checkbox is state of this tab: chrome.storage is shared by every tab and has
// no per-tab key, so ticks made here would appear in every other open Nexus tab.
// sessionStorage survives a reload and a Browse navigation and dies with the
// tab, which is the lifetime a selection should have.
//
// It is the page's own storage, so Nexus scripts can write the key too.
// Everything read back is validated and bounded rather than trusted.

export const SELECTION_STORAGE_KEY = 'nma:selection:v1';
export const SELECTION_TTL_MS = 12 * 60 * 60 * 1000;

const MAX_PERSISTED_ENTRIES = 500;
const MAX_PERSISTED_FILE_IDS = 100;
const MAX_PERSISTED_NAME_LENGTH = 200;

export interface PersistedSelectionEntry {
    readonly modId: string;
    readonly gameDomain: string;
    readonly modName: string;
    readonly fileIds: Set<number>;
}

export function serializeSelection(entries: Map<string, any>, nowMs: number = Date.now()): string {
    const list = Array.from(entries.entries()).slice(0, MAX_PERSISTED_ENTRIES).map(([modId, entry]) => ({
        modId: String(modId),
        gameDomain: String(entry?.gameDomain || ''),
        modName: String(entry?.modName || '').slice(0, MAX_PERSISTED_NAME_LENGTH),
        fileIds: Array.from(entry?.fileIds || [])
            .filter(id => Number.isInteger(id) && (id as number) > 0)
            .slice(0, MAX_PERSISTED_FILE_IDS)
    }));
    return JSON.stringify({v: 1, savedAt: nowMs, entries: list});
}

export function deserializeSelection(raw: string | null, gameDomain: string, nowMs: number = Date.now()): PersistedSelectionEntry[] {
    if (!raw) return [];

    let parsed: any;
    try {
        parsed = JSON.parse(raw);
    } catch (_) {
        return [];
    }

    if (!parsed || parsed.v !== 1 || !Array.isArray(parsed.entries)) return [];
    if (typeof parsed.savedAt !== 'number' || !Number.isFinite(parsed.savedAt)) return [];
    // A record stamped in the future is as good a reason to distrust it as an
    // expired one, so the age test is on the absolute difference.
    if (Math.abs(nowMs - parsed.savedAt) > SELECTION_TTL_MS) return [];

    const restored: PersistedSelectionEntry[] = [];
    for (const entry of parsed.entries.slice(0, MAX_PERSISTED_ENTRIES)) {
        const modId = typeof entry?.modId === 'string' ? entry.modId.trim() : '';
        if (!modId) continue;

        // The rule dropSelectionsOutsideDomain enforces at runtime: a mod id only
        // means something inside its own game. An entry that recorded no domain is
        // kept rather than guessed at, which is what that function does too.
        const entryDomain = typeof entry?.gameDomain === 'string' ? entry.gameDomain : '';
        if (entryDomain && entryDomain !== gameDomain) continue;

        const fileIds = new Set<number>();
        if (Array.isArray(entry?.fileIds)) {
            for (const id of entry.fileIds.slice(0, MAX_PERSISTED_FILE_IDS)) {
                // A file id goes straight to the download endpoint, so anything that
                // is not a positive whole number is dropped rather than passed on.
                if (typeof id === 'number' && Number.isInteger(id) && id > 0) fileIds.add(id);
            }
        }

        restored.push({
            modId,
            gameDomain: entryDomain,
            modName: typeof entry?.modName === 'string' ? entry.modName.slice(0, MAX_PERSISTED_NAME_LENGTH) : '',
            fileIds
        });
    }
    return restored;
}

export function readSelectionRecord(): string | null {
    try {
        return window.sessionStorage.getItem(SELECTION_STORAGE_KEY);
    } catch (_) {
        return null;
    }
}

export function writeSelectionRecord(value: string | null): void {
    try {
        if (value === null) window.sessionStorage.removeItem(SELECTION_STORAGE_KEY);
        else window.sessionStorage.setItem(SELECTION_STORAGE_KEY, value);
    } catch (_) {
        // Storage refused or full. The selection still works for this page load,
        // and nothing the user did has failed, so nothing is claimed here.
    }
}
