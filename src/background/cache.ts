/**
 * cache.ts - Three-tier caching for Nexus API responses.
 *
 * L0: Inflight deduplication (same endpoint being fetched concurrently)
 * L1: In-memory Map with TTL
 * L2: chrome.storage.local with TTL (survives service worker restarts)
 *
 * Extracted from background.ts as part of Phase 1 refactor.
 */

import type { CacheEntry } from '../types';

// ── Constants ────────────────────────────────────────────────────────
export const MOD_CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const STORAGE_PREFIX = 'nmaCache:';

// Long-lived, small, non-Nexus lookups (Steam build lists, per-game known
// versions). Kept in its own namespace because it must survive the 12h Nexus
// sweep, and bounded separately so it can never grow into the same quota
// problem the Nexus cache had.
const AUX_STORAGE_PREFIX = 'nmaAux:';
const ORPHANED_STORAGE_PREFIX = 'steamVersions:';
export const AUX_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MAX_AUX_BYTES = 256 * 1024;
const MAX_AUX_ENTRIES = 64;

// chrome.storage.local is capped near 10MB and the extension does not request
// unlimitedStorage. Settings writes share that quota, so the cache is budgeted
// well below it: a full quota makes the popup's own settings writes throw.
const MAX_CACHE_BYTES = 4 * 1024 * 1024;

// A long-lived worker scanning a large catalog would otherwise hold every
// mod body, description included, for the life of the worker.
const MEMORY_MAX_ENTRIES = 500;

// ── State ────────────────────────────────────────────────────────────
const memoryCache = new Map<string, CacheEntry<any>>();
const inflight = new Map<string, Promise<any>>();

function memorySet(key: string, entry: CacheEntry<any>): void {
    memoryCache.delete(key);
    memoryCache.set(key, entry);
    while (memoryCache.size > MEMORY_MAX_ENTRIES) {
        // Map preserves insertion order, so the first key is the oldest write.
        const oldest = memoryCache.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        memoryCache.delete(oldest);
    }
}

// ── Helpers ──────────────────────────────────────────────────────────

function isCacheable(endpoint: string): boolean {
    return /\/mods\/\d+\.json$/i.test(endpoint)
        || /\/mods\/\d+\/files\.json$/i.test(endpoint)
        || /\/mods\/\d+\/changelogs\.json$/i.test(endpoint);
}

// ── Public API ───────────────────────────────────────────────────────

/** Read from L1 in-memory cache. Returns data or null. */
export function cacheGet(key: string, ttlMs: number = MOD_CACHE_TTL_MS): any | null {
    const entry = memoryCache.get(key);
    if (entry && (Date.now() - entry.ts) < ttlMs) return entry.data;
    return null;
}

function entryBytes(storeKey: string, value: any): number {
    try {
        return storeKey.length + JSON.stringify(value).length;
    } catch (_) {
        return storeKey.length;
    }
}

async function readCacheIndex(prefix: string = STORAGE_PREFIX): Promise<{ storeKey: string; ts: number; bytes: number }[]> {
    const all = (await chrome.storage.local.get(null as any)) as unknown as Record<string, any>;
    const index: { storeKey: string; ts: number; bytes: number }[] = [];
    for (const storeKey of Object.keys(all)) {
        if (!storeKey.startsWith(prefix)) continue;
        const value = all[storeKey];
        index.push({ storeKey, ts: value?.ts || 0, bytes: entryBytes(storeKey, value) });
    }
    return index;
}

/**
 * Drop expired entries, then evict oldest-first until the cache fits its byte
 * budget. Returns what was reclaimed so callers can report it.
 */
export async function cacheSweepStorage(ttlMs: number = MOD_CACHE_TTL_MS): Promise<{ removed: number; bytesFreed: number }> {
    try {
        const index = await readCacheIndex();
        const now = Date.now();
        const doomed: string[] = [];
        let bytesFreed = 0;
        let liveBytes = 0;

        const live: { storeKey: string; ts: number; bytes: number }[] = [];
        for (const entry of index) {
            if (!entry.ts || (now - entry.ts) >= ttlMs) {
                doomed.push(entry.storeKey);
                bytesFreed += entry.bytes;
            } else {
                live.push(entry);
                liveBytes += entry.bytes;
            }
        }

        live.sort((a, b) => a.ts - b.ts);
        for (const entry of live) {
            if (liveBytes <= MAX_CACHE_BYTES) break;
            doomed.push(entry.storeKey);
            bytesFreed += entry.bytes;
            liveBytes -= entry.bytes;
        }

        if (doomed.length) {
            await chrome.storage.local.remove(doomed);
            for (const storeKey of doomed) memoryCache.delete(storeKey.slice(STORAGE_PREFIX.length));
        }
        return { removed: doomed.length, bytesFreed };
    } catch (_) {
        return { removed: 0, bytesFreed: 0 };
    }
}

/**
 * Drop expired aux entries, then evict oldest-first past its own byte and entry
 * bounds. Separate budget from the Nexus cache so neither can starve the other.
 */
export async function auxSweepStorage(ttlMs: number = AUX_CACHE_TTL_MS): Promise<{ removed: number; bytesFreed: number }> {
    try {
        const index = await readCacheIndex(AUX_STORAGE_PREFIX);
        const now = Date.now();
        const doomed: string[] = [];
        let bytesFreed = 0;
        let liveBytes = 0;

        const live: { storeKey: string; ts: number; bytes: number }[] = [];
        for (const entry of index) {
            if (!entry.ts || (now - entry.ts) >= ttlMs) {
                doomed.push(entry.storeKey);
                bytesFreed += entry.bytes;
            } else {
                live.push(entry);
                liveBytes += entry.bytes;
            }
        }

        live.sort((a, b) => a.ts - b.ts);
        let liveCount = live.length;
        for (const entry of live) {
            if (liveBytes <= MAX_AUX_BYTES && liveCount <= MAX_AUX_ENTRIES) break;
            doomed.push(entry.storeKey);
            bytesFreed += entry.bytes;
            liveBytes -= entry.bytes;
            liveCount--;
        }

        // Written by versions before 3.1.0 at the storage root, outside every
        // swept namespace, so nothing else can ever reclaim them.
        for (const entry of await readCacheIndex(ORPHANED_STORAGE_PREFIX)) {
            doomed.push(entry.storeKey);
            bytesFreed += entry.bytes;
        }

        if (doomed.length) await chrome.storage.local.remove(doomed);
        return { removed: doomed.length, bytesFreed };
    } catch (_) {
        return { removed: 0, bytesFreed: 0 };
    }
}

/**
 * Every live auxiliary entry whose key starts with `prefix`, newest first.
 * One storage read, so a caller reporting on what it has derived does not pay a
 * request per game.
 */
export async function auxEntries(prefix: string = '', ttlMs: number = AUX_CACHE_TTL_MS): Promise<Array<{key: string; ts: number; data: any}>> {
    try {
        const all = (await chrome.storage.local.get(null as any)) as unknown as Record<string, any>;
        const now = Date.now();
        const entries: Array<{key: string; ts: number; data: any}> = [];
        for (const storeKey of Object.keys(all)) {
            if (!storeKey.startsWith(AUX_STORAGE_PREFIX)) continue;
            const key = storeKey.slice(AUX_STORAGE_PREFIX.length);
            if (prefix && !key.startsWith(prefix)) continue;
            const entry = all[storeKey] as CacheEntry<any> | undefined;
            if (!entry?.ts || (now - entry.ts) >= ttlMs || entry.data === undefined) continue;
            entries.push({key, ts: entry.ts, data: entry.data});
        }
        return entries.sort((a, b) => b.ts - a.ts);
    } catch (_) {
        return [];
    }
}

/** Write a long-lived auxiliary lookup. Best-effort, like cacheSet. */
export async function auxSet(key: string, data: any): Promise<void> {
    const record = { [`${AUX_STORAGE_PREFIX}${key}`]: { ts: Date.now(), data } };
    try {
        await chrome.storage.local.set(record);
    } catch (_) {
        await auxSweepStorage();
        try {
            await chrome.storage.local.set(record);
        } catch (_) { /* aux data is best-effort; a miss is correct behavior */ }
    }
}

/** Read a long-lived auxiliary lookup. Returns null when absent or expired. */
export async function auxGet(key: string, ttlMs: number = AUX_CACHE_TTL_MS): Promise<any | null> {
    try {
        const storeKey = `${AUX_STORAGE_PREFIX}${key}`;
        const stored = await chrome.storage.local.get([storeKey]);
        const entry = stored?.[storeKey] as CacheEntry<any> | undefined;
        if (entry && entry.ts && (Date.now() - entry.ts) < ttlMs && entry.data !== undefined) {
            return entry.data;
        }
    } catch (_) { /* ignore storage errors */ }
    return null;
}

/**
 * Remove every persisted Nexus cache entry, in both namespaces. Both
 * directions: cacheSet writes, this clears. The aux namespace goes too, so
 * this is also the only way a user can drop a learned version list that has
 * gone wrong; those lists are re-fetched the next time the popup resolves them.
 */
export async function cachePurgeStorage(): Promise<{ removed: number; bytesFreed: number }> {
    try {
        // Both namespaces: a control labeled "clear cached Nexus data" that
        // leaves half the cached Nexus data behind is reporting a lie. The aux
        // entries are learned build lists, refetched on demand.
        const index = [...await readCacheIndex(), ...await readCacheIndex(AUX_STORAGE_PREFIX)];
        if (!index.length) return { removed: 0, bytesFreed: 0 };
        await chrome.storage.local.remove(index.map(e => e.storeKey));
        memoryCache.clear();
        return { removed: index.length, bytesFreed: index.reduce((n, e) => n + e.bytes, 0) };
    } catch (_) {
        return { removed: 0, bytesFreed: 0 };
    }
}

/** Write to both L1 (memory) and L2 (chrome.storage.local). */
export async function cacheSet(key: string, data: any): Promise<void> {
    const ts = Date.now();
    memorySet(key, { ts, data });
    const record = { [`${STORAGE_PREFIX}${key}`]: { ts, data } };
    try {
        await chrome.storage.local.set(record);
    } catch (_) {
        // A quota rejection here would otherwise be silent until an unrelated
        // settings write throws in the popup, so reclaim space and retry once.
        await cacheSweepStorage();
        try {
            await chrome.storage.local.set(record);
        } catch (_) { /* cache is best-effort; a miss is correct behavior */ }
    }
}

/** Read from L2 (chrome.storage.local), promoting to L1 on hit. Returns data or null. */
export async function cacheGetStorage(key: string, ttlMs: number = MOD_CACHE_TTL_MS): Promise<any | null> {
    try {
        const storeKey = `${STORAGE_PREFIX}${key}`;
        const stored = await chrome.storage.local.get([storeKey]);
        const entry = stored?.[storeKey] as CacheEntry<any> | undefined;
        if (entry && entry.ts && (Date.now() - entry.ts) < ttlMs && entry.data) {
            memorySet(key, { ts: entry.ts, data: entry.data });
            return entry.data;
        }
    } catch (_) { /* ignore storage errors */ }
    return null;
}

/**
 * Deduplicate concurrent fetches for the same key.
 * If a fetch for `key` is already in flight, returns the same Promise.
 * Otherwise invokes `fn`, caches the result (if the key is cacheable), and returns it.
 */
export function cacheDedup<T>(key: string, fn: () => Promise<T>, cacheable?: boolean): Promise<T> {
    const existing = inflight.get(key);
    if (existing) return existing;

    const shouldCache = cacheable ?? isCacheable(key);

    const p = (async () => {
        try {
            const data = await fn();
            if (shouldCache) {
                await cacheSet(key, data);
            }
            return data;
        } finally {
            inflight.delete(key);
        }
    })();

    inflight.set(key, p);
    return p;
}

/** Clear all in-memory cache entries and inflight trackers. */
export function cacheClear(): void {
    memoryCache.clear();
    inflight.clear();
}

/**
 * High-level cached fetch for Nexus API endpoints.
 * Three-tier: inflight dedup → in-memory → chrome.storage.local → actual fetch.
 */
export async function fetchNexusCached(
    endpoint: string,
    fetchFn: () => Promise<any>,
    ttlMs: number = MOD_CACHE_TTL_MS
): Promise<any> {
    const key = endpoint;

    // L0: inflight dedup
    const inflightResult = inflight.get(key);
    if (inflightResult) return inflightResult;

    const cacheable = isCacheable(endpoint);

    if (cacheable) {
        // L1: in-memory
        const memHit = cacheGet(key, ttlMs);
        if (memHit !== null) return memHit;

        // L2: chrome.storage.local
        const storageHit = await cacheGetStorage(key, ttlMs);
        if (storageHit !== null) return storageHit;
    }

    // L3: actual fetch (with dedup wrapper)
    return cacheDedup(key, fetchFn, cacheable);
}
