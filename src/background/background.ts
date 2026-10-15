import type {
  CompatibilityResult,
  Confidence,
  EvidenceSource,
  FoundEvidenceSource,
  ModFile,
  ModRequirement,
  NexusGame,
  RateLimitSnapshot,
  DownloadPopupInfo
} from '../types';
import { fetchNexusCached, cacheGet, cacheSet, cacheGetStorage, cacheClear, cacheSweepStorage, cachePurgeStorage, auxEntries, auxGet, auxSet, auxSweepStorage, MOD_CACHE_TTL_MS } from './cache';
import {
  buildGameNameCues,
  canonicalVersionKey,
  compareVersions,
  extractCuedVersionCandidates,
  extractVersionTokens,
  isCompatible,
  isCorroboratedOrigin,
  isKnownGameVersion,
  makeVersionObservation,
  mergeVersionObservations,
  matchStoreTitle,
  normalizeVersionForDisplay,
  parseVersion,
  pickStoreApp,
  readVersionCore,
  versionRangeFromToken,
  type DerivedVersionEntry,
  type VersionObservation,
  type VersionOrigin,
  type VersionToken
} from './versions';
import { startSso, cancelSso, getSsoStatus } from './sso';
import { t } from '../i18n';

const API_BASE = 'https://api.nexusmods.com/v1';
const GRAPHQL_URL = 'https://api.nexusmods.com/v2/graphql';
const APP_NAME = 'Nexus Mods Assistant';
const APP_VERSION = chrome.runtime.getManifest().version;

/**
 * A machine-readable cause travels beside every human message. Errors crossing
 * the message boundary serialize to {} when posted as Error objects, so a
 * rate limit, a rejected key, a 5xx and an offline browser have to be told
 * apart by this field, not by substring-matching a clipped string.
 */
type FailureCode =
    | 'RATE_LIMITED'
    | 'INVALID_KEY'
    | 'FORBIDDEN'
    | 'NOT_FOUND'
    | 'SERVER_ERROR'
    | 'BAD_REQUEST'
    | 'OFFLINE'
    | 'TIMEOUT'
    | 'CANCELED'
    | 'DISABLED'
    | 'NOT_CONFIGURED'
    | 'GAME_MISMATCH'
    | 'UNSUPPORTED_GAME'
    | 'STALE_REQUEST'
    | 'LAYOUT_UNRECOGNIZED'
    | 'UNEXPECTED';

interface FailureInfo {
    code: FailureCode;
    message: string;
    retryable: boolean;
    status?: number;
    retryAfterMs?: number;
    rateLimit?: RateLimitSnapshot;
}

/** CompatibilityResult plus the background-only failure channel. */
interface BackgroundCompatibilityResult extends CompatibilityResult {
    failure?: FailureInfo;
}

let rateLimitRemaining: number | null = null;
let rateLimitResetAtMs: number | null = null;
const gameIdCache = new Map<string, number>();

let NMA_DEBUG = false;
const dbg = (...args: any[]): void => { if (NMA_DEBUG) console.debug('[NMA BG]', ...args); };

const MAX_CONCURRENT = 5;
let activeCount = 0;
const highQueue: Array<() => void> = [];
const normalQueue: Array<() => void> = [];

const DEFAULT_HTTP_TIMEOUT_MS = 30000;
const DOWNLOAD_HTTP_TIMEOUT_MS = 60000;
const STEAM_HTTP_TIMEOUT_MS = 30000;

const routeTokenByTabId = new Map<number, string>();
const connectedPorts = new Set<chrome.runtime.Port>();

// ── Alarms-based keepalive (backup for port heartbeat) ───────────────
const KEEPALIVE_ALARM = 'nma-keepalive';
const CACHE_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
let lastCacheSweepAt = 0;

chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.48 }); // ~29s
chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== KEEPALIVE_ALARM) return;
    dbg('Keepalive alarm fired');

    const now = Date.now();
    if (now - lastCacheSweepAt < CACHE_SWEEP_INTERVAL_MS) return;
    lastCacheSweepAt = now;
    cacheSweepStorage().then(({ removed, bytesFreed }) => {
        if (removed) dbg(`Cache sweep removed ${removed} entries (${bytesFreed} bytes)`);
    });
    auxSweepStorage().then(({ removed, bytesFreed }) => {
        if (removed) dbg(`Aux sweep removed ${removed} entries (${bytesFreed} bytes)`);
    });
});

// Registered synchronously at worker evaluation, or the event cannot wake the
// worker and the map grows for the life of the profile.
chrome.tabs.onRemoved.addListener((tabId: number) => {
    routeTokenByTabId.delete(tabId);
});

const MAX_API_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 400;
const MAX_BACKOFF_MS = 8000;

// Blocking a semaphore slot until a daily quota resets can mean hours of a
// frozen page, so past this the request fails fast and says when it can retry.
const MAX_RATE_LIMIT_WAIT_MS = 60 * 1000;

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function backoffDelayMs(attempt: number, retryAfterMs: number | null): number {
    const base = retryAfterMs && retryAfterMs > 0 ? retryAfterMs : BASE_BACKOFF_MS * Math.pow(2, attempt);
    const jitter = Math.random() * 250;
    return Math.min(MAX_BACKOFF_MS, Math.max(250, base + jitter));
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs: number = DEFAULT_HTTP_TIMEOUT_MS): Promise<Response> {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    try {
        return await fetch(url, {...init, signal: controller.signal});
    } catch (error: any) {
        // This timer is the only thing that aborts a request here. Letting the
        // raw AbortError escape made a transport timeout read as a cancellation,
        // which is a statement about the user's intent, not about the network.
        if (timedOut) {
            throw new NexusApiError({
                code: 'TIMEOUT',
                message: t('background_errorTimeoutSeconds', [String(Math.round(timeoutMs / 1000))]),
                retryable: true
            });
        }
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}

// Matched on the error name only. Sniffing the message for "aborted" also
// caught Nexus body text spliced into a correctly classified BAD_REQUEST.
function isAbortError(err: any): boolean {
    return err?.name === 'AbortError';
}

class NexusApiError extends Error {
    readonly failure: FailureInfo;

    constructor(failure: FailureInfo) {
        super(failure.message);
        this.name = 'NexusApiError';
        this.failure = failure;
    }
}

function failureForHttpStatus(status: number, retryAfterMs: number | null, body: string): FailureInfo {
    const snapshot = getRateLimitSnapshot();
    if (status === 429) {
        return {
            code: 'RATE_LIMITED',
            message: snapshot.resetAt
                ? t('background_errorRateLimitedUntil', [snapshot.resetAt])
                : t('background_errorRateLimited'),
            retryable: true,
            status,
            retryAfterMs: retryAfterMs ?? undefined,
            rateLimit: snapshot
        };
    }
    if (status === 401) {
        return {code: 'INVALID_KEY', message: t('background_errorInvalidKey'), retryable: false, status};
    }
    if (status === 403) {
        return {code: 'FORBIDDEN', message: t('background_errorForbidden'), retryable: false, status};
    }
    if (status === 404) {
        return {code: 'NOT_FOUND', message: t('background_errorNotFound'), retryable: false, status};
    }
    if (status >= 500) {
        return {code: 'SERVER_ERROR', message: t('background_errorServerError', [String(status)]), retryable: true, status};
    }
    const detail = body ? ` ${body.slice(0, 120)}` : '';
    return {code: 'BAD_REQUEST', message: t('background_errorBadRequest', [String(status), detail]), retryable: false, status};
}

function classifyFailure(error: any): FailureInfo {
    if (error instanceof NexusApiError) return error.failure;
    if (error?.failure?.code) return error.failure as FailureInfo;
    if (isAbortError(error)) {
        return {code: 'TIMEOUT', message: t('background_errorTimeout'), retryable: true};
    }
    const raw = String(error?.message || error || '');
    if (/failed to fetch|network ?error|networkerror/i.test(raw)) {
        return {code: 'OFFLINE', message: t('background_errorOffline'), retryable: true};
    }
    if (raw === 'Extension is disabled') {
        return {code: 'DISABLED', message: t('background_errorDisabled'), retryable: false};
    }
    return {code: 'UNEXPECTED', message: raw || t('background_errorUnexpected'), retryable: false};
}

/**
 * "Not configured" is a setup step, not a fault. Thrown as a bare Error it
 * classified as UNEXPECTED and no caller could tell it from a real failure.
 * The leading sentence is kept verbatim: the content script's runtime path
 * still recognizes this case by that substring.
 */
function missingApiKeyError(): NexusApiError {
    return new NexusApiError({
        code: 'NOT_CONFIGURED',
        message: t('background_errorNoApiKey'),
        retryable: false
    });
}

function errorResponse(error: any): {ok: false; error: string; failure: FailureInfo} {
    const failure = classifyFailure(error);
    return {ok: false, error: failure.message, failure};
}

function getTabId(sender: chrome.runtime.MessageSender | null | undefined): number | null {
    const tabId = sender?.tab?.id;
    return typeof tabId === 'number' ? tabId : null;
}

function setRouteToken(tabId: number | null, token: string | null | undefined): void {
    if (tabId === null) return;
    if (!token) return;
    routeTokenByTabId.set(tabId, String(token));
}

function isCurrentRouteToken(tabId: number | null, token: any): boolean {
    if (tabId === null) return true;
    const current = routeTokenByTabId.get(tabId);
    if (!current) return true;
    if (!token) return true;
    return String(token) === current;
}

function dequeueNext(): (() => void) | null {
    return highQueue.shift() || normalQueue.shift() || null;
}

function getFileCategory(file: ModFile): number {
    if (file.category_name) {
        const name = file.category_name.toUpperCase();
        if (name === 'MAIN') return 1;
        if (name === 'UPDATE' || name === 'UPDATES') return 2;
        if (name === 'OPTIONAL') return 3;
        if (name === 'OLD_VERSION' || name === 'OLD') return 4;
        if (name === 'MISCELLANEOUS' || name === 'MISC') return 5;
        if (name === 'ARCHIVED') return 7;
    }
    return file.category_id;
}

function runWithSemaphore<T>(fn: () => Promise<T>, priority: 'HIGH' | 'NORMAL' = 'NORMAL'): Promise<T> {
    return new Promise((resolve, reject) => {
        const job = async (): Promise<void> => {
            activeCount++;
            try {
                const result = await fn();
                resolve(result);
            } catch (e) {
                reject(e);
            } finally {
                activeCount--;
                const next = dequeueNext();
                if (next) next();
            }
        };
        if (activeCount < MAX_CONCURRENT) {
            job();
        } else {
            (priority === 'HIGH' ? highQueue : normalQueue).push(job);
        }
    });
}

let bootstrapPromise: Promise<void> = bootstrap();

chrome.runtime.onInstalled.addListener(() => { bootstrapPromise = bootstrap(); });
chrome.runtime.onStartup.addListener(() => { bootstrapPromise = bootstrap(); });

/**
 * A cold-started worker has read no settings yet. Nothing about version
 * knowledge is bundled any more, so this waits for the worker's own state and
 * never for a file.
 */
async function ensureBootstrapped(): Promise<void> {
    try { await bootstrapPromise; } catch (_) { /* the caller's own path still runs */ }
}

chrome.runtime.onMessage.addListener((request: any, _sender: chrome.runtime.MessageSender, sendResponse: (response?: any) => void) => {
    if (request.type === 'PING') {
        sendResponse({ok: true, ts: Date.now()});
        return false;
    }

    if (request.type === 'GET_RATE_LIMIT') {
        sendResponse(getRateLimitSnapshot());
        return false;
    }

    if (request.type === 'START_SSO') {
        startSso();
        sendResponse({ok: true});
        return false;
    }

    if (request.type === 'CANCEL_SSO') {
        cancelSso();
        sendResponse({ok: true});
        return false;
    }

    if (request.type === 'GET_SSO_STATUS') {
        sendResponse(getSsoStatus());
        return false;
    }

    // Deliberately outside the enabled gate below: reclaiming storage is a
    // maintenance action, and a user whose quota is full needs it most when
    // they have already switched the extension off.
    if (request.type === 'PURGE_CACHE') {
        cachePurgeStorage()
            .then(result => {
                cacheClear();
                sendResponse({ok: true, result});
            })
            .catch(error => sendResponse(errorResponse(error)));
        return true;
    }

    if (request.type === 'OPEN_POPUP') {
        openSettingsSurface()
            .then(result => sendResponse({ok: true, result}))
            .catch(error => sendResponse(errorResponse(error)));
        return true;
    }

    // Settings information, readable while the extension is switched off: the
    // user needs to see how stale the version data is exactly when they are
    // deciding whether to trust it.
    if (request.type === 'GET_VERSION_DB_INFO') {
        getVersionDataInfo()
            .then(info => sendResponse({ok: true, info, result: {info}}))
            .catch(error => sendResponse(errorResponse(error)));
        return true;
    }

    const handleMessage = async (): Promise<any> => {
        try {
            if (!(await isExtensionEnabled())) {
                throw new Error('Extension is disabled');
            }

            switch (request.type) {
                case 'SET_ROUTE_TOKEN': {
                    setRouteToken(getTabId(_sender), request.token);
                    return {ok: true};
                }
                case 'CHECK_MOD':
                    return await runWithSemaphore(
                        () => runCheckMod(request, getTabId(_sender)),
                        request.priority === 'HIGH' ? 'HIGH' : 'NORMAL'
                    );
                case 'GET_GAMES':
                    return await runWithSemaphore(async () => {
                        await respectRateLimit();
                        return fetchGames();
                    });
                case 'RESOLVE_STEAM_APP':
                    return await resolveSteamAppId(request.name);
                case 'GET_GAME_VERSIONS':
                    await ensureBootstrapped();
                    return await resolveDerivedVersions(request.gameDomain, request.force, request.name);
                case 'GET_STEAM_VERSIONS':
                    await ensureBootstrapped();
                    return await resolveGameVersions(request.appId, request.gameDomain, request.force);
                case 'DOWNLOAD_MOD':
                    return await resolveDownload(request);
                case 'RESOLVE_NXM_LINK':
                    return await resolveNxmDownloadLink(request);
                case 'RESOLVE_LATEST_FILE':
                    return await runWithSemaphore(async () => {
                        await respectRateLimit();
                        const prefs = await chrome.storage.local.get(['nexusApiKey']);
                        const apiKey = (prefs.nexusApiKey as string)?.trim();
                        if (!apiKey) throw missingApiKeyError();
                        return resolveLatestFile(request.gameDomain, request.modId, apiKey);
                    });
                case 'GET_MOD_FILES':
                    return await runWithSemaphore(async () => {
                        await respectRateLimit();
                        const prefs = await chrome.storage.local.get(['nexusApiKey']);
                        const apiKey = (prefs.nexusApiKey as string)?.trim();
                        if (!apiKey) throw missingApiKeyError();
                        return fetchModFiles(request.gameDomain, request.modId, apiKey);
                    });
                case 'GET_MOD_REQUIREMENTS':
                    return await runWithSemaphore(async () => {
                        await respectRateLimit();
                        const prefs = await chrome.storage.local.get(['nexusApiKey']);
                        const apiKey = (prefs.nexusApiKey as string)?.trim();
                        if (!apiKey) throw missingApiKeyError();
                        return fetchModRequirements(request.gameDomain, request.modId, apiKey);
                    });
                default:
                    return {error: `Unknown type: ${request.type}`};
            }
        } catch (error: any) {
            if (request.type === 'CHECK_MOD') {
                return checkModFailureResult(request.modId, request.gameDomain, error);
            }
            const failure = classifyFailure(error);
            return {ok: false, status: 'FAILED', error: failure.message, message: failure.message, failure};
        }
    };

    handleMessage().then(sendResponse);
    return true;
});

chrome.runtime.onConnect.addListener((port: chrome.runtime.Port) => {
    if (!port || port.name !== 'nma-port') return;
    dbg('Port connected:', port.sender?.tab?.id);
    const portTabId = typeof port.sender?.tab?.id === 'number' ? port.sender?.tab?.id : null;
    connectedPorts.add(port);

    const respond = (reqId: string, payload: any): void => {
        try { port.postMessage({reqId, ...payload}); } catch (e) { /* ignore */ }
    };

    port.onMessage.addListener(async (msg: any) => {
        const {reqId, type} = msg || {};
        if (!type) return;

        const alwaysAllowed = type === 'PING' || type === 'GET_VERSION_DB_INFO' || type === 'OPEN_POPUP';
        if (!alwaysAllowed && !(await isExtensionEnabled())) {
            respond(reqId, {ok: false, error: 'Extension is disabled', failure: {code: 'DISABLED', message: t('background_errorDisabled'), retryable: false}});
            return;
        }

        switch (type) {
            case 'PING':
                respond(reqId, {ok: true, ts: Date.now()});
                break;
            case 'SET_ROUTE_TOKEN': {
                setRouteToken(portTabId, msg.token);
                respond(reqId, {ok: true, result: {ok: true}});
                break;
            }
            case 'CHECK_MOD': {
                runWithSemaphore(
                    () => runCheckMod(msg, portTabId),
                    msg.priority === 'HIGH' ? 'HIGH' : 'NORMAL'
                ).then(result => respond(reqId, {ok: true, result}))
                    .catch(error => respond(reqId, {ok: true, result: checkModFailureResult(msg.modId, msg.gameDomain, error)}));
                break;
            }
            case 'DOWNLOAD_MOD': {
                resolveDownload(msg).then(res => respond(reqId, {ok: true, result: res}))
                    .catch(err => respond(reqId, errorResponse(err)));
                break;
            }
            case 'RESOLVE_NXM_LINK': {
                resolveNxmDownloadLink(msg).then(res => respond(reqId, {ok: true, result: res}))
                    .catch(err => respond(reqId, errorResponse(err)));
                break;
            }
            case 'RESOLVE_LATEST_FILE': {
                runWithSemaphore(async () => {
                    await respectRateLimit();
                    const {nexusApiKey} = await chrome.storage.local.get(['nexusApiKey']);
                    if (!nexusApiKey) throw missingApiKeyError();
                    return resolveLatestFile(msg.gameDomain, msg.modId, nexusApiKey as string);
                }).then(file => respond(reqId, {ok: true, result: {file}}))
                  .catch(err => respond(reqId, errorResponse(err)));
                break;
            }
            case 'GET_MOD_FILES': {
                runWithSemaphore(async () => {
                    await respectRateLimit();
                    const {nexusApiKey} = await chrome.storage.local.get(['nexusApiKey']);
                    if (!nexusApiKey) throw missingApiKeyError();
                    return fetchModFiles(msg.gameDomain, msg.modId, nexusApiKey as string);
                }).then(files => respond(reqId, {ok: true, result: {ok: true, files}}))
                  .catch(err => respond(reqId, errorResponse(err)));
                break;
            }
            case 'GET_MOD_REQUIREMENTS': {
                runWithSemaphore(async () => {
                    await respectRateLimit();
                    const {nexusApiKey} = await chrome.storage.local.get(['nexusApiKey']);
                    if (!nexusApiKey) throw missingApiKeyError();
                    return fetchModRequirements(msg.gameDomain, msg.modId, nexusApiKey as string);
                }).then(reqs => respond(reqId, {ok: true, result: {ok: true, requirements: reqs}}))
                  .catch(err => respond(reqId, errorResponse(err)));
                break;
            }
            case 'GET_GAMES': {
                runWithSemaphore(async () => {
                    await respectRateLimit();
                    return fetchGames();
                }).then(res => respond(reqId, {ok: true, result: res}))
                    .catch(err => respond(reqId, errorResponse(err)));
                break;
            }
            case 'RESOLVE_STEAM_APP': {
                resolveSteamAppId(msg.name).then(res => respond(reqId, {ok: true, result: res}))
                    .catch(err => respond(reqId, errorResponse(err)));
                break;
            }
            case 'GET_GAME_VERSIONS': {
                ensureBootstrapped()
                    .then(() => resolveDerivedVersions(msg.gameDomain, msg.force, msg.name))
                    .then(result => respond(reqId, {ok: true, result}))
                    .catch(err => respond(reqId, errorResponse(err)));
                break;
            }
            case 'GET_STEAM_VERSIONS': {
                ensureBootstrapped()
                    .then(() => resolveGameVersions(msg.appId, msg.gameDomain, msg.force))
                    .then(result => respond(reqId, {ok: true, result}))
                    .catch(err => respond(reqId, errorResponse(err)));
                break;
            }
            case 'OPEN_POPUP': {
                openSettingsSurface()
                    .then(result => respond(reqId, {ok: true, result}))
                    .catch(err => respond(reqId, errorResponse(err)));
                break;
            }
            case 'GET_VERSION_DB_INFO': {
                getVersionDataInfo()
                    .then(info => respond(reqId, {ok: true, result: {info}}))
                    .catch(err => respond(reqId, errorResponse(err)));
                break;
            }
            case 'GET_RATE_LIMIT': {
                respond(reqId, {ok: true, result: getRateLimitSnapshot()});
                break;
            }
            default:
                respond(reqId, {ok: false, error: `Unknown type: ${type}`});
        }
    });

    port.onDisconnect.addListener(() => {
        dbg('Port disconnected:', port.sender?.tab?.id);
        connectedPorts.delete(port);
    });
});

async function bootstrap(): Promise<void> {
    try {
        const {nmaDebug} = await chrome.storage.local.get(['nmaDebug']);
        NMA_DEBUG = !!nmaDebug;
    } catch (_) { /* the debug flag is a convenience, never a requirement */ }
}

interface VersionDataInfo {
    /** Nothing is bundled any more, so there is no file that can fail to load. */
    loaded: boolean;
    error: string | null;
    schemaVersion: number | null;
    updatedAt: string | null;
    verifiedAt: string | null;
    domains: string[];
    /** Zero, permanently: no version in this extension is authored by anyone. */
    curatedGameCount: number;
    harvestedGameCount: number;
    games: Array<{domain: string; versions: number; harvestedAt: string | null; sources: VersionOrigin[]; storeBound: boolean}>;
}

/**
 * What version knowledge this installation currently holds and when it derived
 * it. Staleness has to be visible from inside the extension, and now so does
 * provenance: a list derived from one source on one day is a different thing to
 * trust than one four sources agree on.
 */
async function getVersionDataInfo(): Promise<VersionDataInfo> {
    const harvests = await readAllHarvests();
    const games = harvests.map(harvest => ({
        domain: harvest.domain,
        versions: harvest.entries.length,
        harvestedAt: harvest.harvestedAt ? new Date(harvest.harvestedAt).toISOString() : null,
        sources: harvestSources(harvest),
        storeBound: harvest.storeBound
    }));
    const newest = harvests.reduce((acc, harvest) => Math.max(acc, harvest.harvestedAt || 0), 0);
    const newestIso = newest > 0 ? new Date(newest).toISOString() : null;

    return {
        loaded: true,
        error: null,
        schemaVersion: null,
        updatedAt: newestIso,
        verifiedAt: newestIso,
        domains: games.map(game => game.domain),
        curatedGameCount: 0,
        harvestedGameCount: games.length,
        games
    };
}

async function fetchGames(): Promise<NexusGame[]> {
    const {nexusApiKey} = await chrome.storage.local.get(['nexusApiKey']);
    if (!nexusApiKey) {
        throw missingApiKeyError();
    }

    return fetchNexus('/games.json', nexusApiKey as string);
}

function normalizeHtmlLink(value: string | null): string | null {
    if (!value) return value;
    return value.replace(/&amp;/g, '&');
}

function extractNxmLink(html: string): string | null {
    if (!html) return null;
    const match = html.match(/nxm:\/\/[^"'\s<>]+/i);
    return match ? normalizeHtmlLink(match[0]) : null;
}

function extractKeyAndExpiresFromLink(link: string | null): {key: string | null; expires: string | null} {
    if (!link) return {key: null, expires: null};
    const idx = link.indexOf('?');
    if (idx === -1) return {key: null, expires: null};
    const query = normalizeHtmlLink(link.slice(idx + 1));
    if (!query) return {key: null, expires: null};
    const params = new URLSearchParams(query);
    return {
        key: params.get('key'),
        expires: params.get('expires')
    };
}

function extractKeyAndExpiresFromHtml(html: string): {key: string | null; expires: string | null} {
    if (!html) return {key: null, expires: null};
    const keyMatch = html.match(/(?:[?&]|\b)key=([^&"'\s<>]+)/i);
    const expiresMatch = html.match(/(?:[?&]|\b)expires=([^&"'\s<>]+)/i);
    return {
        key: keyMatch ? normalizeHtmlLink(keyMatch[1]) : null,
        expires: expiresMatch ? normalizeHtmlLink(expiresMatch[1]) : null
    };
}

function extractManualDownloadLink(html: string): string | null {
    if (!html) return null;
    const candidates: string[] = [];
    const hrefRegex = /href="([^"]+)"/gi;
    let match;
    while ((match = hrefRegex.exec(html)) !== null) {
        const link = normalizeHtmlLink(match[1]);
        if (link) candidates.push(link);
    }
    const dataRegex = /data-(?:download-url|download|url)="([^"]+)"/gi;
    while ((match = dataRegex.exec(html)) !== null) {
        const link = normalizeHtmlLink(match[1]);
        if (link) candidates.push(link);
    }
    const pick = candidates.find(link => /download/i.test(link) && !/DownloadPopUp/i.test(link));
    if (!pick) return null;
    if (pick.startsWith('http')) return pick;
    return `https://www.nexusmods.com${pick.startsWith('/') ? '' : '/'}${pick}`;
}

function pickDownloadLink(links: any[]): string | null {
    if (!Array.isArray(links) || links.length === 0) return null;
    const normalized = links
        .map(link => ({
            ...link,
            uri: link.URI || link.uri || link.url || null
        }))
        .filter(link => !!link.uri);
    if (normalized.length === 0) return null;
    const preferred = normalized.find(link => {
        const name = `${link.name || ''} ${link.short_name || ''}`.toLowerCase();
        return name.includes('nexus cdn') || name.includes('global');
    });
    return (preferred ? preferred.uri : normalized[0].uri);
}

async function resolveGameId(gameDomain: string, apiKey: string): Promise<number> {
    if (gameIdCache.has(gameDomain)) {
        return gameIdCache.get(gameDomain)!;
    }
    const game: any = await fetchNexus(`/games/${gameDomain}.json`, apiKey);
    if (!game?.id) {
        throw new Error(`Failed to resolve game id for ${gameDomain}`);
    }
    gameIdCache.set(gameDomain, game.id);
    return game.id;
}

async function fetchDownloadPopupHtml(gameDomain: string, fileId: number, apiKey: string, useNmm = false): Promise<string> {
    const gameId = await resolveGameId(gameDomain, apiKey);
    const suffix = useNmm ? '&nmm=1' : '';
    const url = `https://www.nexusmods.com/Core/Libs/Common/Widgets/DownloadPopUp?id=${fileId}&game_id=${gameId}${suffix}`;
    const response = await fetchWithTimeout(url, {
        credentials: 'include',
        cache: 'no-store',
        headers: {
            'X-Requested-With': 'XMLHttpRequest'
        }
    }, DOWNLOAD_HTTP_TIMEOUT_MS);
    if (!response.ok) {
        throw new Error(`Download popup ${response.status}`);
    }
    return response.text();
}

async function resolveDownloadPopupInfo(gameDomain: string, fileId: number, apiKey: string): Promise<DownloadPopupInfo> {
    const info: DownloadPopupInfo = {nxm: null, key: null, expires: null, manualUrl: null};

    try {
        const nmmHtml = await fetchDownloadPopupHtml(gameDomain, fileId, apiKey, true);
        info.nxm = extractNxmLink(nmmHtml);
        const parsed = extractKeyAndExpiresFromLink(info.nxm);
        info.key = parsed.key;
        info.expires = parsed.expires;
        if (!info.key || !info.expires) {
            const fallback = extractKeyAndExpiresFromHtml(nmmHtml);
            info.key = info.key || fallback.key;
            info.expires = info.expires || fallback.expires;
        }
    } catch (e) {
        dbg('Download popup (nmm) failed', e);
    }

    if (!info.manualUrl || !info.key || !info.expires) {
        try {
            const manualHtml = await fetchDownloadPopupHtml(gameDomain, fileId, apiKey, false);
            if (!info.manualUrl) {
                info.manualUrl = extractManualDownloadLink(manualHtml);
            }
            if (!info.key || !info.expires) {
                const fallback = extractKeyAndExpiresFromHtml(manualHtml);
                info.key = info.key || fallback.key;
                info.expires = info.expires || fallback.expires;
            }
        } catch (e) {
            dbg('Download popup (manual) failed', e);
        }
    }

    return info;
}

async function resolveDownloadLinkFromApi({modId, fileId, gameDomain, apiKey, key, expires}: {modId: string; fileId: number; gameDomain: string; apiKey: string; key?: string; expires?: string}): Promise<string> {
    const query = key && expires
        ? `?key=${encodeURIComponent(key)}&expires=${encodeURIComponent(expires)}`
        : '';
    const links = await fetchNexus(`/games/${gameDomain}/mods/${modId}/files/${fileId}/download_link.json${query}`, apiKey);
    const link = pickDownloadLink(links);
    if (!link) {
        throw new Error(t('background_errorDownloadLinkMissing'));
    }
    return link;
}

async function resolveNxmDownloadLink({modId, fileId, gameDomain}: {modId: string; fileId: number; gameDomain: string}): Promise<DownloadPopupInfo> {
    if (!fileId) {
        throw new Error('Missing file id.');
    }
    const {nexusApiKey} = await chrome.storage.local.get(['nexusApiKey']);
    const apiKey = (nexusApiKey as string)?.trim();
    if (!apiKey) {
        throw missingApiKeyError();
    }
    const info = await resolveDownloadPopupInfo(gameDomain, fileId, apiKey);
    if (!info.nxm) {
        throw new Error(t('background_errorNxmLinkMissing'));
    }
    return info;
}

async function resolveDownload({modId, fileId, gameDomain}: {modId: string; fileId: number; gameDomain: string}): Promise<{success: boolean; link: string}> {
    if (!fileId) {
        throw new Error('Missing file id.');
    }

    const {nexusApiKey} = await chrome.storage.local.get(['nexusApiKey']);
    const apiKey = (nexusApiKey as string)?.trim();
    if (!apiKey) {
        throw missingApiKeyError();
    }

    let link: string | null = null;
    try {
        link = await resolveDownloadLinkFromApi({
            modId,
            fileId,
            gameDomain,
            apiKey
        });
    } catch (error) {
        const popupInfo = await resolveDownloadPopupInfo(gameDomain, fileId, apiKey);
        if (popupInfo.key && popupInfo.expires) {
            try {
                link = await resolveDownloadLinkFromApi({
                    modId,
                    fileId,
                    gameDomain,
                    apiKey,
                    key: popupInfo.key,
                    expires: popupInfo.expires
                });
            } catch (apiErr) {
                dbg('Download link fallback with key/expires failed', apiErr);
            }
        }
        if (!link && popupInfo.manualUrl) {
            link = popupInfo.manualUrl;
        }
        if (!link) {
            throw error;
        }
    }

    await chrome.downloads.download({url: link});
    return {success: true, link};
}

async function fetchModFiles(gameDomain: string, modId: string, apiKey: string): Promise<ModFile[]> {
    if (!gameDomain || !modId) throw new Error('Missing gameDomain or modId');
    const filesResponse: any = await fetchNexusWithCache(`/games/${gameDomain}/mods/${modId}/files.json`, apiKey);
    return filesResponse?.files || [];
}

async function fetchModRequirements(gameDomain: string, modId: string, apiKey: string): Promise<ModRequirement[]> {
    if (!gameDomain || !modId) throw new Error('Missing gameDomain or modId');

    const reqCacheKey = `requirements:${gameDomain}:${modId}`;

    // L1: in-memory
    const memHit = cacheGet(reqCacheKey);
    if (memHit !== null && Array.isArray(memHit)) return memHit;

    // L2: chrome.storage.local
    const storageHit = await cacheGetStorage(reqCacheKey);
    if (storageHit !== null && Array.isArray(storageHit)) return storageHit;

    const url = `https://www.nexusmods.com/${gameDomain}/mods/${modId}`;
    const response = await fetchWithTimeout(url, {cache: 'no-store'}, DEFAULT_HTTP_TIMEOUT_MS);
    if (!response.ok) {
        throw new Error(`Failed to load mod page for requirements: ${response.status}`);
    }
    const html = await response.text();
    const requirements = parseRequirementsFromHTML(html);

    // An empty list must mean "this mod has no requirements", never "the markup
    // changed and the parser found nothing". Caching the second for 12h hides a
    // mod's dependencies for half a day.
    if (requirements.length === 0 && !hasRecognisedRequirementsLayout(html)) {
        throw new NexusApiError({
            code: 'LAYOUT_UNRECOGNIZED',
            message: t('background_errorLayoutUnrecognized'),
            retryable: false
        });
    }

    if (requirements.length > 0) {
        await cacheSet(reqCacheKey, requirements);
    }

    return requirements;
}

/**
 * A page NMA can parse carries at least one of these anchors. Without one,
 * an empty parse is a parser failure and not a fact about the mod.
 */
function hasRecognisedRequirementsLayout(html: string): boolean {
    if (!html) return false;
    return /table-require-name/i.test(html)
        || /<h3>\s*(?:Nexus|Off-site)\s+requirements\s*<\/h3>/i.test(html)
        || /id="mod_dependencies"/i.test(html)
        || /\bmods?\s+requiring\s+this\s+file\b/i.test(html)
        || /\bRequirements\s*<\/h[23]>/i.test(html);
}

async function resolveLatestFile(gameDomain: string, modId: string, apiKey: string): Promise<{file_id: number; name: string; version: string; uploaded_timestamp: number; category_id: number; category_name: string | null; candidates: Array<{file_id: number; name: string; version: string; category_id: number; category_name: string | null; uploaded_timestamp: number}>}> {
    if (!gameDomain || !modId) throw new Error('Missing gameDomain or modId');
    const filesResponse: any = await fetchNexusWithCache(`/games/${gameDomain}/mods/${modId}/files.json`, apiKey);
    const {showOldFiles} = await chrome.storage.local.get(['showOldFiles']);

    // Category rank first, upload time second. Sorting by time alone made an
    // optional texture variant the "latest file" a dependency install would get.
    const activeFiles = rankModFiles(filesResponse?.files || [], !!showOldFiles);

    const latest = activeFiles[0] || null;
    if (!latest) throw new Error(t('background_errorNoEligibleFiles'));

    return {
        file_id: latest.file_id,
        name: latest.name,
        version: latest.version,
        uploaded_timestamp: latest.uploaded_timestamp ?? 0,
        category_id: getFileCategory(latest),
        category_name: latest.category_name ?? null,
        candidates: activeFiles.slice(0, 20).map(file => ({
            file_id: file.file_id,
            name: file.name,
            version: file.version,
            category_id: getFileCategory(file),
            category_name: file.category_name ?? null,
            uploaded_timestamp: file.uploaded_timestamp ?? 0
        }))
    };
}

function parseMetaVersionsFromHTML(html: string): string[] {
    const versions = new Set<string>();
    const metaRegex = /<(?:meta)\s+(?:property|name)="twitter:data1"\s+content="([^"]+)"/gi;
    let match;
    while ((match = metaRegex.exec(html)) !== null) {
        versions.add(match[1].trim());
    }
    return Array.from(versions);
}

async function fetchNexusWithCache(endpoint: string, apiKey: string, ttlMs: number = MOD_CACHE_TTL_MS): Promise<any> {
    return fetchNexusCached(endpoint, () => fetchNexus(endpoint, apiKey), ttlMs);
}

const GAME_DOMAIN_RE = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;

// A naive `href.split('/')[3]` on '/games/<domain>/mods/<id>' yields 'games',
// so an unvalidated per-request domain turns a partial bug into a guaranteed 404.
const RESERVED_DOMAIN_TOKENS = new Set(['games', 'mods', 'files', 'users', 'www', 'about', 'search', 'images', 'videos', 'news']);

function validateGameDomain(value: any): string | null {
    if (typeof value !== 'string') return null;
    const domain = value.trim().toLowerCase();
    if (!GAME_DOMAIN_RE.test(domain)) return null;
    if (RESERVED_DOMAIN_TOKENS.has(domain)) return null;
    return domain;
}

const SOURCE_CONFIDENCE: Record<EvidenceSource, Confidence> = {
    FILE_VERSION: 'EXACT',
    FILE_NAME: 'INFERRED',
    CHANGELOG: 'INFERRED',
    DESCRIPTION: 'INFERRED',
    UPLOAD_DATE: 'INFERRED',
    NONE: 'NONE'
};

const SOURCE_RANK: Record<EvidenceSource, number> = {
    FILE_VERSION: 5,
    FILE_NAME: 4,
    CHANGELOG: 3,
    DESCRIPTION: 2,
    UPLOAD_DATE: 1,
    NONE: 0
};

const SOURCE_LABEL: Record<EvidenceSource, string> = {
    FILE_VERSION: t('background_sourceFileVersion'),
    FILE_NAME: t('background_sourceFileName'),
    CHANGELOG: t('background_sourceChangelog'),
    DESCRIPTION: t('background_sourceDescription'),
    UPLOAD_DATE: t('background_sourceUploadDate'),
    NONE: t('background_sourceNone')
};

interface EvidenceHit {
    token: string;
    text: string;
    // Narrower than EvidenceSource on purpose: a hit is evidence that was found, and its label is
    // filled into a sentence as the subject.
    source: FoundEvidenceSource;
    // Overrides the source's default grading. Only for rules that read a stated
    // game version out of prose the allow-list cannot confirm.
    confidence?: Confidence;
    fileId: number | null;
    fileName: string | null;
    fileVersion: string | null;
    uploadedAt: number | null;
}

function baseResult(modId: string, gameDomain: string | null): BackgroundCompatibilityResult {
    return {
        status: 'UNKNOWN',
        modId,
        gameDomain: gameDomain || null,
        detectedVersion: null,
        fileId: null,
        fileName: null,
        fileVersion: null,
        uploadedAt: null,
        confidence: 'NONE',
        evidenceSource: 'NONE',
        evidenceText: null
    };
}

function staleResult(modId: string, gameDomain: string | null): BackgroundCompatibilityResult {
    return {
        ...baseResult(modId, gameDomain),
        reason: 'Stale request',
        message: t('background_errorNavigationChanged'),
        failure: {code: 'STALE_REQUEST', message: t('background_errorNavigationChanged'), retryable: false}
    };
}

function notConfiguredResult(modId: string, gameDomain: string | null, code: FailureCode, reason: string, message: string): BackgroundCompatibilityResult {
    return {
        ...baseResult(modId, gameDomain),
        status: 'NOT_CONFIGURED',
        reason,
        message,
        failure: {code, message, retryable: false}
    };
}

/**
 * FAILED means NMA could not look. UNKNOWN means it looked and the mod does not
 * say. Collapsing them is what makes a transport problem read as a fact about
 * the mod, so they stay separate all the way to the badge.
 */
function checkModFailureResult(modId: string, gameDomain: any, error: any): BackgroundCompatibilityResult {
    const domain = validateGameDomain(gameDomain);
    // An explicit code always wins: a timeout is a failure to look, and only a
    // real cancellation leaves the mod unjudged without anything going wrong.
    const failure = classifyFailure(error);
    if (failure.code === 'CANCELED') {
        return {
            ...baseResult(modId, domain),
            reason: 'Canceled',
            message: failure.message,
            failure
        };
    }
    return {
        ...baseResult(modId, domain),
        status: 'FAILED',
        reason: 'Could not check',
        message: failure.message,
        failure
    };
}

async function runCheckMod(msg: any, tabId: number | null): Promise<BackgroundCompatibilityResult> {
    const modId = msg?.modId;
    const requestedDomain = validateGameDomain(msg?.gameDomain);

    if (!isCurrentRouteToken(tabId, msg?.routeToken)) {
        return staleResult(modId, requestedDomain);
    }

    await ensureBootstrapped();

    const prefs = await chrome.storage.local.get(['nexusApiKey', 'targetGameDomain', 'targetVersion', 'targetVersionEnd']);
    const apiKey = (prefs.nexusApiKey as string)?.trim();
    const configuredDomain = validateGameDomain(prefs.targetGameDomain);
    const versionMin = (prefs.targetVersion as string)?.trim();
    const versionMax = ((prefs.targetVersionEnd || prefs.targetVersion) as string)?.trim();

    if (!apiKey || !configuredDomain || !versionMin) {
        const parts = [
            !apiKey ? t('background_setupNeedsApiKey') : null,
            !configuredDomain ? t('background_setupNeedsGame') : null,
            !versionMin ? t('background_setupNeedsVersion') : null
        ].filter(Boolean) as string[];
        const missing = parts.length > 1
            ? t('background_setupNeedsJoin', [parts.slice(0, -1).join(', '), parts[parts.length - 1]])
            : parts[0];
        return notConfiguredResult(
            modId,
            requestedDomain || configuredDomain,
            'NOT_CONFIGURED',
            'Not set up yet',
            t('background_errorNotConfigured', [missing])
        );
    }

    // The version range in settings belongs to the configured game. Judging
    // another game's mods against it swaps a wrong mod for a wrong version
    // scale, which is harder to notice, so the mismatch is reported instead.
    if (requestedDomain && requestedDomain !== configuredDomain) {
        return notConfiguredResult(
            modId,
            requestedDomain,
            'GAME_MISMATCH',
            'Different game',
            t('background_errorGameMismatch', [requestedDomain, configuredDomain])
        );
    }

    // A range NMA cannot parse makes isCompatible false for every token, which
    // paints the whole page red for a reason the user cannot see. Name the value.
    // After the mismatch gate: on another game's page the range is the wrong
    // scale anyway, and the mismatch is the more useful thing to report.
    const unreadableBound = !versionRangeFromToken(versionMin)
        ? versionMin
        : (!versionRangeFromToken(versionMax || versionMin) ? versionMax : null);
    if (unreadableBound) {
        return notConfiguredResult(
            modId,
            requestedDomain || configuredDomain,
            'NOT_CONFIGURED',
            'Version not readable',
            t('background_errorVersionUnreadable', [unreadableBound])
        );
    }

    const gameDomain = requestedDomain || configuredDomain;
    await respectRateLimit();

    const deepScan = msg?.priority === 'HIGH' || msg?.deepScan === true;
    return checkModCompatibility(modId, gameDomain, versionMin, versionMax || versionMin, apiKey, deepScan, tabId, msg?.routeToken);
}

function ownVersionExclusions(...values: Array<string | null | undefined>): Set<string> {
    const set = new Set<string>();
    for (const value of values) {
        const parsed = parseVersion(value);
        if (parsed) set.add(parsed.numbers.join('.'));
    }
    return set;
}

/**
 * True only when the token names every component of a known build. The
 * allow-list accepts component-wise PREFIXES, so "2.0" passes against build
 * 2.02 - and "2.0" is one of the most common mod release numbers there is.
 * A prefix is still evidence, but it is an inference, not a stated build.
 */
function tokenNamesFullBuild(token: string, allowedVersions: string[]): boolean {
    const parsed = parseVersion(token);
    if (!parsed) return false;
    const numbers = parsed.numbers.join('.');
    return allowedVersions.some(candidate => {
        const known = parseVersion(candidate);
        if (!known) return false;
        return known.numbers.length === parsed.numbers.length && known.numbers.join('.') === numbers;
    });
}

function pickStrongestHit(hits: EvidenceHit[]): EvidenceHit | null {
    let best: EvidenceHit | null = null;
    for (const hit of hits) {
        if (!best) { best = hit; continue; }
        const rank = SOURCE_RANK[hit.source] - SOURCE_RANK[best.source];
        if (rank > 0 || (rank === 0 && compareVersions(hit.token, best.token) > 0)) best = hit;
    }
    return best;
}

function pickNewestHit(hits: EvidenceHit[]): EvidenceHit | null {
    let newest: EvidenceHit | null = null;
    for (const hit of hits) {
        if (!newest) { newest = hit; continue; }
        const order = compareVersions(hit.token, newest.token);
        if (order > 0 || (order === 0 && SOURCE_RANK[hit.source] > SOURCE_RANK[newest.source])) newest = hit;
    }
    return newest;
}

const FILE_CATEGORY_RANK: Record<number, number> = {1: 0, 2: 1, 3: 2, 5: 3, 4: 4, 7: 5};

/** Main before Update before Optional before Misc, newest first inside each. */
function rankModFiles(files: ModFile[], includeOldFiles: boolean): ModFile[] {
    return (files || [])
        .filter((file: ModFile) => {
            const category = getFileCategory(file);
            if ([1, 2, 3, 5].includes(category)) return true;
            return includeOldFiles && [4, 7].includes(category);
        })
        .sort((a: ModFile, b: ModFile) => {
            const byCategory = (FILE_CATEGORY_RANK[getFileCategory(a)] ?? 9) - (FILE_CATEGORY_RANK[getFileCategory(b)] ?? 9);
            if (byCategory !== 0) return byCategory;
            return (b.uploaded_timestamp ?? 0) - (a.uploaded_timestamp ?? 0);
        });
}

async function checkModCompatibility(modId: string, gameDomain: string, userMinVersion: string, userMaxVersion: string, apiKey: string, deepScan = false, tabId: number | null = null, routeToken: string | null = null): Promise<BackgroundCompatibilityResult> {
    const allowedVersions = await getAllowedVersionsFor(gameDomain);
    if (!isCurrentRouteToken(tabId, routeToken)) {
        return staleResult(modId, gameDomain);
    }

    // An empty list is a fact about what the public sources say, not a fault and
    // not an unsupported game. It reads the same on every installation, and a
    // harvest is already running or already cached behind this call.
    if (allowedVersions.length === 0) {
        return notConfiguredResult(
            modId,
            gameDomain,
            'UNSUPPORTED_GAME',
            'No version derived',
            t('background_errorNoVersionDerived', [gameDomain])
        );
    }

    const modDetails: any = await fetchNexusWithCache(`/games/${gameDomain}/mods/${modId}.json`, apiKey);
    const modName = modDetails?.name;

    // A mod's own release number is not a game version, whichever field it
    // arrives in, so every source is filtered against it.
    const exclude = ownVersionExclusions(modDetails?.version);

    const hits: EvidenceHit[] = [];
    const addTokens = (tokens: VersionToken[], file: ModFile | null = null): void => {
        for (const token of tokens) {
            // FILE_VERSION is the only source graded EXACT, and the only thing
            // between a mod's own release number and a confident verdict is the
            // allow-list, which matches prefixes. Downgrade a partial match.
            const partialBuild = token.source === 'FILE_VERSION' && !tokenNamesFullBuild(token.token, allowedVersions);
            hits.push({
                token: token.token,
                text: token.text,
                source: token.source,
                confidence: partialBuild ? 'INFERRED' : undefined,
                fileId: file?.file_id ?? null,
                fileName: file?.name ?? null,
                fileVersion: file?.version ?? null,
                uploadedAt: file?.uploaded_timestamp ?? null
            });
        }
    };

    addTokens(extractVersionTokens(
        `${modDetails?.summary || ''} ${modDetails?.description || ''}`,
        allowedVersions,
        {source: 'DESCRIPTION', requireCue: true, exclude}
    ));

    let probedFiles = false;
    let probeFailure: FailureInfo | null = null;
    let newestFile: ModFile | null = null;

    // Files first: it is the only source that can be EXACT, and finding one
    // there spares the changelog request entirely.
    if (deepScan && isCurrentRouteToken(tabId, routeToken)) {
        try {
            const filesResponse: any = await fetchNexusWithCache(`/games/${gameDomain}/mods/${modId}/files.json`, apiKey);
            const {showOldFiles} = await chrome.storage.local.get(['showOldFiles']);
            const files = rankModFiles(filesResponse?.files || [], !!showOldFiles);
            probedFiles = true;
            for (const file of files) {
                const fileExclude = ownVersionExclusions(modDetails?.version, file.version);
                // Deliberately `exclude` and not `fileExclude`: authors on these
                // games do publish a file whose version IS the game build it is
                // built for, and excluding file.version from its own scan would
                // discard the only EXACT-capable source. The guard against a mod
                // release number slipping through is tokenNamesFullBuild above,
                // not this exclusion set.
                addTokens(extractVersionTokens(file.version, allowedVersions, {source: 'FILE_VERSION', exclude}), file);
                addTokens(extractVersionTokens(file.name, allowedVersions, {source: 'FILE_NAME', exclude: fileExclude}), file);
                addTokens(extractVersionTokens(file.description, allowedVersions, {source: 'DESCRIPTION', requireCue: true, exclude: fileExclude}), file);
                if ((file.uploaded_timestamp ?? 0) > (newestFile?.uploaded_timestamp ?? 0)) newestFile = file;
            }
        } catch (error: any) {
            probeFailure = classifyFailure(error);
        }
    }

    const hasExactHit = hits.some(hit => (hit.confidence || SOURCE_CONFIDENCE[hit.source]) === 'EXACT');
    let changelogFailure: FailureInfo | null = null;
    if (!hasExactHit && isCurrentRouteToken(tabId, routeToken)) {
        try {
            const changelogs: any = await fetchNexusWithCache(`/games/${gameDomain}/mods/${modId}/changelogs.json`, apiKey);
            if (changelogs && typeof changelogs === 'object') {
                for (const key of Object.keys(changelogs)) {
                    addTokens(extractVersionTokens(key, allowedVersions, {source: 'CHANGELOG', exclude}));
                    const entries = changelogs[key];
                    const entryText = Array.isArray(entries) ? entries.join(' ') : String(entries || '');
                    addTokens(extractVersionTokens(entryText, allowedVersions, {source: 'CHANGELOG', requireCue: true, exclude}));
                }
            }
        } catch (error: any) {
            // A mod with no changelog answers 404, which is a fact about the mod.
            // Anything else means NMA could not read it, and that must not later
            // be reported as "this mod names no game version".
            const failure = classifyFailure(error);
            if (failure.code !== 'NOT_FOUND') changelogFailure = failure;
        }
    }

    if (deepScan && hits.length === 0 && isCurrentRouteToken(tabId, routeToken)) {
        try {
            const url = `https://www.nexusmods.com/${gameDomain}/mods/${modId}`;
            const response = await fetchWithTimeout(url, {cache: 'no-store'}, DEFAULT_HTTP_TIMEOUT_MS);
            if (response.ok) {
                const html = await response.text();
                // twitter:data1 is the mod page's own Version field, so it
                // widens the exclusion set rather than feeding the verdict.
                const pageExclude = ownVersionExclusions(modDetails?.version, ...parseMetaVersionsFromHTML(html));
                addTokens(extractVersionTokens(html, allowedVersions, {source: 'DESCRIPTION', requireCue: true, exclude: pageExclude}));
            }
        } catch (_) { /* the page probe is a bonus, never a requirement */ }
    }

    if (hits.length === 0 && probedFiles && newestFile) {
        const releaseTime = await getKnownVersionReleaseTime(gameDomain, userMaxVersion);
        const uploadedMs = (newestFile.uploaded_timestamp ?? 0) * 1000;
        if (releaseTime && uploadedMs > releaseTime) {
            hits.push({
                token: userMaxVersion,
                text: new Date(uploadedMs).toISOString().slice(0, 10),
                source: 'UPLOAD_DATE',
                fileId: newestFile.file_id ?? null,
                fileName: newestFile.name ?? null,
                fileVersion: newestFile.version ?? null,
                uploadedAt: newestFile.uploaded_timestamp ?? null
            });
        }
    }

    const unreadSource = probeFailure || changelogFailure;
    if (hits.length === 0 && unreadSource) {
        return {
            ...baseResult(modId, gameDomain),
            status: 'FAILED',
            modName,
            reason: 'Could not check',
            message: unreadSource.message,
            failure: unreadSource
        };
    }

    // A verdict reached while one source could not be read is a partial check.
    // Saying so is the difference between "this is what the mod says" and
    // "this is what the part of the mod NMA could read says".
    const partialNote = unreadSource
        ? ' ' + t('background_verdictPartialNote', [unreadSource.message])
        : '';

    const matches = hits.filter(hit => isCompatible(hit.token, userMinVersion, userMaxVersion));
    const best = pickStrongestHit(matches);

    if (best) {
        const confidence = best.confidence || SOURCE_CONFIDENCE[best.source];
        const exact = confidence === 'EXACT';
        return {
            ...baseResult(modId, gameDomain),
            status: exact ? 'COMPATIBLE' : 'LIKELY_COMPATIBLE',
            modName,
            reason: exact ? 'Version match' : 'Inferred match',
            message: (best.source === 'UPLOAD_DATE'
                ? t('background_verdictUploadDateInRange', [best.text, userMaxVersion])
                : exact
                    ? t('background_verdictStatedInRange', [SOURCE_LABEL[best.source], best.text])
                    : t('background_verdictMentionedInRange', [SOURCE_LABEL[best.source], best.text])) + partialNote,
            // An upload-date inference detected no version at all, so reporting
            // the target version as "detected" would invent the evidence.
            detectedVersion: best.source === 'UPLOAD_DATE' ? null : normalizeVersionForDisplay(best.token),
            confidence,
            evidenceSource: best.source,
            evidenceText: best.text,
            fileId: best.fileId,
            fileName: best.fileName,
            fileVersion: best.fileVersion,
            uploadedAt: best.uploadedAt
        };
    }

    const newest = pickNewestHit(hits);
    if (newest) {
        const newestConfidence = newest.confidence || SOURCE_CONFIDENCE[newest.source];
        return {
            ...baseResult(modId, gameDomain),
            status: 'INCOMPATIBLE',
            modName,
            reason: 'Outside your range',
            // The compatible branch grades and words itself per hit; this one
            // said "states" for every source, including the ones that only
            // mention, and reported the user's own target as detected evidence.
            message: (newest.source === 'UPLOAD_DATE'
                ? t('background_verdictUploadDateOutOfRange', [newest.text])
                : newestConfidence === 'EXACT'
                    ? t('background_verdictStatedOutOfRange', [SOURCE_LABEL[newest.source], newest.text])
                    : t('background_verdictMentionedOutOfRange', [SOURCE_LABEL[newest.source], newest.text])) + partialNote,
            detectedVersion: newest.source === 'UPLOAD_DATE' ? null : normalizeVersionForDisplay(newest.token),
            confidence: newestConfidence,
            evidenceSource: newest.source,
            evidenceText: newest.text,
            fileId: newest.fileId,
            fileName: newest.fileName,
            fileVersion: newest.fileVersion,
            uploadedAt: newest.uploadedAt
        };
    }

    return {
        ...baseResult(modId, gameDomain),
        modName,
        reason: 'No version data',
        message: probedFiles
            ? t('background_verdictNoVersionDataDeep')
            : t('background_verdictNoVersionDataShallow')
    };
}

// ── Version harvest ──────────────────────────────────────────────────
//
// One pipeline, four sources, no game named anywhere in it.
//
//   A  Steam announcement titles      the publisher naming its own build
//   B  Nexus mod text, keyless        what mod authors say the game version is
//   C  Nexus collection metadata      a structured game-version field
//   D  Steam branch names, keyless    the build names a publisher ships
//
// B and C are the floor: both work with no key and no store binding, so every
// game in the catalog gets a harvest. A and D enrich it only when the store
// listing for the game has been VERIFIED, because a wrong store binding yields a
// complete, plausible, entirely wrong list, which is far worse than an empty one.
//
// Where all four say nothing, the list is empty and the extension says so. That
// empty state is correct, and it is identical on every machine.

const HARVEST_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// A game that yielded nothing is re-tried a day later rather than a week later:
// a game gains public version data when it gains mods, and that happens daily.
const EMPTY_HARVEST_TTL_MS = 24 * 60 * 60 * 1000;
const STORE_BIND_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const GAME_INFO_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const MAX_LEARNED_VERSIONS = 200;
const MOD_SAMPLE_SIZE = 50;
const COLLECTION_SAMPLE_SIZE = 50;
const STEAM_NEWS_COUNT = 100;
// Two mods, because one author writing "1.6" in a title is a coincidence and two
// unrelated authors writing it is the game's build number. This is the only
// filter source B has: nothing corroborates a number found in free text.
const MOD_CORROBORATION_FLOOR = 2;

interface HarvestBudget {
    /** Requests spent, counted rather than estimated. */
    requests: number;
    /** Endpoints that actually answered. Zero means the network, not the data. */
    answered: number;
}

interface GameHarvest {
    domain: string;
    harvestedAt: number;
    entries: DerivedVersionEntry[];
    /** False when the store listing could not be identified, which skips A and D. */
    storeBound: boolean;
    storeAppId: string | null;
    storeNote: string;
    requests: number;
}

interface StoreBinding {
    appId: string | null;
    verified: boolean;
    note: string;
    /** The SteamCMD payload the verification already paid for, reused for source D. */
    info?: any;
}

function harvestKey(domain: string): string {
    return `versionHarvest:${domain}`;
}

function harvestTtlFor(harvest: GameHarvest | null): number {
    return (harvest && harvest.entries.length > 0) ? HARVEST_TTL_MS : EMPTY_HARVEST_TTL_MS;
}

function harvestSources(harvest: GameHarvest): VersionOrigin[] {
    const sources = new Set<VersionOrigin>();
    for (const entry of harvest.entries) {
        for (const origin of entry.sources) sources.add(origin);
    }
    return Array.from(sources);
}

function reviveHarvest(domain: string, data: any): GameHarvest | null {
    if (!data || !Array.isArray(data.entries)) return null;
    return {
        domain,
        harvestedAt: Number(data.harvestedAt) || 0,
        entries: data.entries as DerivedVersionEntry[],
        storeBound: data.storeBound === true,
        storeAppId: data.storeAppId ? String(data.storeAppId) : null,
        storeNote: typeof data.storeNote === 'string' ? data.storeNote : '',
        requests: Number(data.requests) || 0
    };
}

async function readHarvest(domain: string): Promise<GameHarvest | null> {
    const data = await auxGet(harvestKey(domain), HARVEST_TTL_MS);
    return reviveHarvest(domain, data);
}

async function readAllHarvests(): Promise<GameHarvest[]> {
    const raw = await auxEntries('versionHarvest:');
    const harvests: GameHarvest[] = [];
    for (const item of raw) {
        const harvest = reviveHarvest(item.key.slice('versionHarvest:'.length), item.data);
        if (harvest) harvests.push(harvest);
    }
    return harvests.sort((a, b) => b.harvestedAt - a.harvestedAt);
}

async function writeHarvest(harvest: GameHarvest): Promise<void> {
    await auxSet(harvestKey(harvest.domain), {
        harvestedAt: harvest.harvestedAt,
        entries: harvest.entries.slice(0, MAX_LEARNED_VERSIONS),
        storeBound: harvest.storeBound,
        storeAppId: harvest.storeAppId,
        storeNote: harvest.storeNote,
        requests: harvest.requests
    });
}

function isHarvestFresh(harvest: GameHarvest | null): boolean {
    if (!harvest || !harvest.harvestedAt) return false;
    return (Date.now() - harvest.harvestedAt) < harvestTtlFor(harvest);
}

const harvestsInFlight = new Map<string, Promise<GameHarvest>>();
const lastBackgroundHarvestAt = new Map<string, number>();
// A page of fifty tiles asks for the allow-list fifty times. Nothing caches a
// harvest that could not reach anything, so without this an offline browser
// would start a fresh one for every tile.
const BACKGROUND_HARVEST_COOLDOWN_MS = 10 * 60 * 1000;

/**
 * Start a harvest without waiting for it. Nothing a page renders may block on
 * network work this slow, so a badge check reads whatever is cached, and the
 * refresh lands for the next one. Connected pages are told when it lands.
 */
function scheduleHarvest(domain: string): void {
    if (harvestsInFlight.has(domain)) return;
    const last = lastBackgroundHarvestAt.get(domain) ?? 0;
    if (Date.now() - last < BACKGROUND_HARVEST_COOLDOWN_MS) return;
    lastBackgroundHarvestAt.set(domain, Date.now());
    harvestGameVersions(domain, {}).catch(error => dbg('Background harvest failed', domain, error));
}

/**
 * Run the whole pipeline for one game domain, or join the run already going.
 *
 * Every request is timed out, the result is cached per domain, and the number of
 * requests it took is reported back rather than estimated.
 */
function harvestGameVersions(domain: string, options: {force?: boolean; nameHint?: string}): Promise<GameHarvest> {
    const existing = harvestsInFlight.get(domain);
    if (existing) return existing;

    const run = runHarvest(domain, options)
        .finally(() => { harvestsInFlight.delete(domain); });
    harvestsInFlight.set(domain, run);
    return run;
}

async function runHarvest(domain: string, options: {force?: boolean; nameHint?: string}): Promise<GameHarvest> {
    const cached = await readHarvest(domain);
    if (!options.force && isHarvestFresh(cached)) return cached!;

    const budget: HarvestBudget = {requests: 0, answered: 0};
    const observations: VersionObservation[] = [];

    const game = await resolveGameInfo(domain, budget, options.nameHint);
    const displayName = game?.name || options.nameHint || domain;

    // C and B first, in that order: both are keyless and neither needs a store
    // binding, so a game that binds to nothing still gets everything it can.
    observations.push(...await harvestFromCollections(domain, budget));
    observations.push(...await harvestFromModText(domain, displayName, budget));

    const binding = await resolveStoreBinding(domain, displayName, budget, options.force === true);
    if (binding.verified && binding.appId) {
        observations.push(...await harvestFromStore(binding, budget));
    }

    // Every keyless source came back empty, so the last floor is tried: the files
    // of the most downloaded mods, which need the user's own key to read. It runs
    // only here, because it is the most expensive source and the only one that
    // spends the Nexus rate limit.
    if (observations.length === 0) {
        observations.push(...await discoverVersionsFromNexus(domain, [], budget));
    }

    // "Found nothing" and "could not look" are opposite statements, so a run in
    // which no source answered at all is not cached and not reported as an empty
    // list. A stale answer, if there is one, outlives a failed refresh.
    if (budget.answered === 0) {
        if (cached) return cached;
        throw new NexusApiError({
            code: 'OFFLINE',
            message: t('background_errorNoVersionSource'),
            retryable: true
        });
    }

    const entries = mergeVersionObservations(observations);
    const harvest: GameHarvest = {
        domain,
        harvestedAt: Date.now(),
        entries,
        storeBound: binding.verified && !!binding.appId,
        storeAppId: binding.verified ? binding.appId : null,
        storeNote: binding.note,
        requests: budget.requests
    };

    await writeHarvest(harvest);
    await rememberLearnedVersions(domain, entries.filter(entry => isCorroboratedOrigin(entry.origin)).map(entry => entry.core));
    broadcastHarvest(harvest);
    return harvest;
}

function broadcastHarvest(harvest: GameHarvest): void {
    const payload = {
        type: 'VERSIONS_HARVESTED',
        gameDomain: harvest.domain,
        versions: harvest.entries.length,
        storeBound: harvest.storeBound
    };
    for (const port of connectedPorts) {
        try {
            port.postMessage(payload);
        } catch (_) {
            connectedPorts.delete(port);
        }
    }
    try {
        const maybe = chrome.runtime.sendMessage(payload);
        if (maybe && typeof maybe.then === 'function' && typeof maybe.catch === 'function') maybe.catch(() => {});
    } catch (_) { /* no extension page is listening */ }
}

// ── Nexus GraphQL, no key required ───────────────────────────────────

/**
 * The domain is validated against GAME_DOMAIN_RE before it reaches any query, so
 * it carries nothing a GraphQL string can be broken with.
 */
async function fetchGraphQL(query: string, budget: HarvestBudget): Promise<any> {
    budget.requests++;
    const response = await fetchWithTimeout(GRAPHQL_URL, {
        method: 'POST',
        cache: 'no-store',
        headers: {
            'Content-Type': 'application/json',
            'Application-Name': APP_NAME,
            'Application-Version': APP_VERSION
        },
        body: JSON.stringify({query})
    }, STEAM_HTTP_TIMEOUT_MS);
    if (!response.ok) throw new Error(`Nexus GraphQL ${response.status}`);
    const payload: any = await response.json();
    budget.answered++;
    return payload?.data ?? null;
}

interface GameInfo {
    id: number | null;
    name: string;
    modCount: number;
}

/**
 * The game's own catalog entry, which is where the display name comes from.
 * That name is the cue source B is built on, so it is derived, never authored.
 */
async function resolveGameInfo(domain: string, budget: HarvestBudget, nameHint?: string): Promise<GameInfo | null> {
    const key = `gameInfo:${domain}`;
    const cached = await auxGet(key, GAME_INFO_TTL_MS);
    if (cached && cached.name) return cached as GameInfo;

    try {
        const data = await fetchGraphQL(`{ game(domainName:"${domain}"){ id name modCount } }`, budget);
        const game = data?.game;
        if (game?.name) {
            const info: GameInfo = {id: Number(game.id) || null, name: String(game.name), modCount: Number(game.modCount) || 0};
            await auxSet(key, info);
            return info;
        }
    } catch (error) {
        dbg('Game info lookup failed', domain, error);
    }

    return nameHint ? {id: null, name: nameHint, modCount: 0} : null;
}

/**
 * Source C. The one place a game version arrives in a field that exists to hold
 * one, so it needs no cue: what it needs is the structural filter, because the
 * field is free text and carries platform variants, revision counters and
 * blanks beside real builds.
 */
async function harvestFromCollections(domain: string, budget: HarvestBudget): Promise<VersionObservation[]> {
    const query = `{ collectionsV2(filter:{gameDomain:{value:"${domain}",op:EQUALS}}, count:${COLLECTION_SAMPLE_SIZE}){ nodes { currentRevision { gameVersions { reference } } } } }`;
    const observations: VersionObservation[] = [];
    try {
        const data = await fetchGraphQL(query, budget);
        const nodes = data?.collectionsV2?.nodes || [];
        for (const node of nodes) {
            const versions = node?.currentRevision?.gameVersions || [];
            for (const version of versions) {
                const observation = makeVersionObservation(version?.reference, 'COLLECTION');
                if (observation) observations.push(observation);
            }
        }
    } catch (error) {
        dbg('Collection harvest failed', domain, error);
    }
    return observations;
}

/**
 * Source B. The most universal source there is, and the one that needs the most
 * care: a mod's own release number is never a game version, and a number in a
 * mod title is only a game version when the game's name is in front of it.
 *
 * A build is kept only when two different mods name it. One author is a
 * coincidence; two unrelated authors are the game's numbering.
 */
async function harvestFromModText(domain: string, displayName: string, budget: HarvestBudget): Promise<VersionObservation[]> {
    const query = `{ mods(filter:{gameDomainName:{value:"${domain}",op:EQUALS}}, count:${MOD_SAMPLE_SIZE}){ nodes { modId name version summary description } } }`;
    const cues = buildGameNameCues(displayName, domain);
    const modsPerLabel = new Map<string, Set<string>>();

    try {
        const data = await fetchGraphQL(query, budget);
        const nodes = data?.mods?.nodes || [];
        for (const mod of nodes) {
            // The mod's own version field is its release number by definition, so
            // it never votes on the game's, in any of the fields it appears in.
            const exclude = ownVersionExclusions(mod?.version);
            const text = `${mod?.name || ''} . ${mod?.summary || ''} . ${mod?.description || ''}`;
            const labels = extractCuedVersionCandidates(text, {cues, exclude});
            for (const label of labels) {
                const key = canonicalVersionKey(readVersionCore(label)?.core || label);
                if (!modsPerLabel.has(key)) modsPerLabel.set(key, new Set());
                modsPerLabel.get(key)!.add(`${mod?.modId ?? label}`);
            }
        }
    } catch (error) {
        dbg('Mod text harvest failed', domain, error);
        return [];
    }

    const observations: VersionObservation[] = [];
    for (const [label, mods] of modsPerLabel.entries()) {
        if (mods.size < MOD_CORROBORATION_FLOOR) continue;
        const observation = makeVersionObservation(label, 'MOD_TEXT', 0, mods.size);
        if (observation) observations.push(observation);
    }
    return observations;
}

// ── Steam, only behind a verified binding ────────────────────────────

/**
 * THE BINDING RULE, stated in full because a wrong bind is the worst failure
 * this pipeline has:
 *
 *   1. The store is searched for the game's catalog name.
 *   2. A result qualifies only if it is an app, its title carries the same
 *      numbers as the catalog name, and one title is the TAIL of the other -
 *      a store prefixes a franchise, it does not append one.
 *   3. The closest qualifying result wins, and a tie at the closest distance is
 *      refused rather than broken.
 *   4. The winner is then confirmed against the app's own Steam record, which
 *      must call itself a game, must not be a child of another app, and must
 *      carry a title that satisfies rule 2 as well.
 *
 * Anything short of all four REFUSES the bind. A refused bind skips sources A
 * and D for that game and says so; B and C still run. Nexus exposes no store
 * identifier of any kind, so this reconstruction is the only route there is, and
 * it is the same reconstruction on every machine.
 */
async function resolveStoreBinding(domain: string, displayName: string, budget: HarvestBudget, force: boolean): Promise<StoreBinding> {
    const key = `storeBind:${domain}`;
    if (!force) {
        const cached = await auxGet(key, STORE_BIND_TTL_MS);
        if (cached && typeof cached.verified === 'boolean') {
            if (!cached.verified) return {appId: null, verified: false, note: cached.note || ''};
            const info = await fetchSteamAppInfo(cached.appId, budget);
            if (info) return {appId: cached.appId, verified: true, note: cached.note || '', info};
        }
    }

    let candidate: any = null;
    try {
        candidate = await searchStoreApp(displayName, budget);
    } catch (error) {
        dbg('Store search failed', domain, error);
        return {appId: null, verified: false, note: t('background_storeNoteSearchFailed')};
    }

    if (!candidate?.id) {
        const binding = {
            appId: null,
            verified: false,
            note: t('background_storeNoteNoMatch')
        };
        await auxSet(key, {appId: null, verified: false, note: binding.note});
        return binding;
    }

    const appId = String(candidate.id);
    const info = await fetchSteamAppInfo(appId, budget);
    const confirmation = confirmStoreApp(displayName, appId, info);
    if (!confirmation.ok) {
        // A refusal is remembered only when it is a fact about the listing. An
        // endpoint that did not answer is remembered as nothing, or a minute of
        // Steam being down would skip store sources for a month.
        if (confirmation.settled) await auxSet(key, {appId: null, verified: false, note: confirmation.note});
        return {appId: null, verified: false, note: confirmation.note};
    }

    await auxSet(key, {appId, verified: true, note: ''});
    return {appId, verified: true, note: '', info};
}

async function searchStoreApp(name: string, budget: HarvestBudget): Promise<any | null> {
    if (!name) return null;
    budget.requests++;
    const url = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(name)}&cc=us&l=en`;
    const response = await fetchWithTimeout(url, {cache: 'no-store'}, STEAM_HTTP_TIMEOUT_MS);
    if (!response.ok) throw new Error(`Steam storesearch ${response.status}`);
    const data: any = await response.json();
    budget.answered++;
    const items = Array.isArray(data?.items) ? data.items : [];
    return pickStoreApp(name, items);
}

async function fetchSteamAppInfo(appId: string | null, budget: HarvestBudget): Promise<any | null> {
    if (!appId) return null;
    try {
        budget.requests++;
        const url = `https://api.steamcmd.net/v1/info/${encodeURIComponent(appId)}`;
        const response = await fetchWithTimeout(url, {cache: 'no-store'}, STEAM_HTTP_TIMEOUT_MS);
        if (!response.ok) return null;
        budget.answered++;
        return await response.json();
    } catch (error) {
        dbg('Steam app info failed', appId, error);
        return null;
    }
}

function confirmStoreApp(displayName: string, appId: string, info: any): {ok: boolean; settled: boolean; note: string} {
    const common = info?.data?.[appId]?.common;
    if (!common) {
        return {ok: false, settled: false, note: t('background_storeNoteRecordUnreadable')};
    }
    if (String(common.type || '').toLowerCase() !== 'game') {
        return {ok: false, settled: true, note: t('background_storeNoteNotAGame')};
    }
    if (common.parent) {
        return {ok: false, settled: true, note: t('background_storeNoteWrongApp')};
    }
    if (!matchStoreTitle(displayName, common.name)) {
        return {ok: false, settled: true, note: t('background_storeNoteDifferentGame')};
    }
    return {ok: true, settled: true, note: ''};
}

/**
 * Sources A and D together, off one verified app id: the branch names Steam
 * publishes and the titles of the publisher's own announcements. The news feed
 * is restricted to steam_community_announcements, because the unfiltered feed
 * mixes in press coverage whose article bodies are where every number that is
 * not a version lives.
 */
async function harvestFromStore(binding: StoreBinding, budget: HarvestBudget): Promise<VersionObservation[]> {
    const appId = binding.appId!;
    const info = binding.info ?? await fetchSteamAppInfo(appId, budget);

    let news: any = null;
    try {
        budget.requests++;
        const url = `https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=${encodeURIComponent(appId)}&count=${STEAM_NEWS_COUNT}&feeds=steam_community_announcements`;
        const response = await fetchWithTimeout(url, {cache: 'no-store'}, STEAM_HTTP_TIMEOUT_MS);
        if (response.ok) {
            news = await response.json();
            budget.answered++;
        }
    } catch (error) {
        dbg('Steam news failed', appId, error);
    }

    return extractSteamObservations(info, news);
}

/**
 * A branch key is a version only when, after one optional leading letter, it is
 * digits and dots and nothing else. That is structural and names no game: it
 * admits v1.2.10 and e1.7.0, and rejects public, beta, local, perf_test and
 * every launcher or feature branch alike. The list of literal branch names it
 * replaced had to grow every time a publisher invented a new one, and one of its
 * entries was specific to a single title.
 */
function extractSteamObservations(infoPayload: any, newsPayload: any): VersionObservation[] {
    const observations: VersionObservation[] = [];
    const VERSION_SHAPED_RE = /^[a-z]?\d+(?:\.\d+)+$/i;
    const SHAPED_RE = /^([a-z])?(\d+(?:[._]\d+)+)$/i;

    const readBranch = (keyRaw: string, time: number, description = ''): void => {
        const compact = keyRaw.trim().replace(/\s+/g, '');
        let candidate = '';

        // The branch key is the publisher naming its own build, so it is tried
        // first and whole. Only if the key is not version-shaped is the branch
        // description consulted, which is how a branch called "beta" described as
        // "Beta v1.4.5" still yields a build.
        const fromKey = SHAPED_RE.exec(compact);
        if (fromKey && VERSION_SHAPED_RE.test(compact.replace(/_/g, '.'))) {
            candidate = `${(fromKey[1] || '').toLowerCase()}${fromKey[2].replace(/_/g, '.')}`;
        } else {
            const fromDescription = /\b([a-z])?(\d+(?:\.\d+)+)\b/i.exec(String(description || ''));
            if (!fromDescription) return;
            candidate = `${(fromDescription[1] || '').toLowerCase()}${fromDescription[2]}`;
        }

        const observation = makeVersionObservation(candidate, 'STEAM_BRANCH', time);
        if (observation) observations.push(observation);
    };

    const visit = (obj: any): void => {
        if (!obj || typeof obj !== 'object') return;
        const branches = obj.branches || obj.Branches;
        if (branches && typeof branches === 'object') {
            Object.keys(branches).forEach(key => {
                const branch = branches[key];
                readBranch(key, Number(branch?.timeupdated || 0), branch?.description);
            });
        }
        Object.values(obj).forEach(visit);
    };

    visit(infoPayload);

    // Steam app info carries no version string field anywhere, only build ids, so
    // a number found loose in that payload is offered as a choice and never
    // trusted to grade a mod. It is kept because for a publisher who writes its
    // build into some other field it is the only thing there is.
    if (observations.length === 0) {
        const loose = new Set<string>();
        const searchAll = (obj: any): void => {
            if (typeof obj === 'string') {
                const matches = obj.match(/\b[ve]?(\d+\.\d+(?:\.\d+)+)\b/g);
                if (matches) matches.forEach(value => loose.add(value));
            } else if (obj && typeof obj === 'object') {
                Object.values(obj).forEach(searchAll);
            }
        };
        searchAll(infoPayload);
        loose.forEach(value => {
            const observation = makeVersionObservation(value, 'STEAM_NEWS');
            if (observation) observations.push(observation);
        });
    }

    const newsItems = newsPayload?.appnews?.newsitems;
    if (Array.isArray(newsItems)) {
        const NEWS_RE = /\b[ve]?(\d+\.\d+(?:\.\d+)+)\b/g;
        for (const item of newsItems) {
            // A title and a body are different kinds of evidence. "Update 1.6.640"
            // is the publisher naming a build; the body of the same post is prose
            // full of unrelated numbers.
            // Seconds, matching branch timeupdated. Milliseconds here sorted every
            // news-derived label above every real build.
            const time = Number(item?.date) || 0;
            const fromTitle = String(item?.title || '').match(NEWS_RE) || [];
            for (const value of fromTitle) {
                const observation = makeVersionObservation(value, 'STEAM_ANNOUNCEMENT', time);
                if (observation) observations.push(observation);
            }
            const fromBody = String(item?.contents || '').match(NEWS_RE) || [];
            for (const value of fromBody) {
                const observation = makeVersionObservation(value, 'STEAM_NEWS', time);
                if (observation) observations.push(observation);
            }
        }
    }

    return observations;
}

// ── What the rest of the worker reads ────────────────────────────────

/**
 * Runtime extension of what NMA knows: a game it has derived versions for stays
 * checkable between harvests, without an extension release and without a file.
 */
async function rememberLearnedVersions(gameDomain: string, versions: string[]): Promise<void> {
    const usable = versions.filter(version => {
        const parsed = parseVersion(version);
        return !!parsed && parsed.numbers.length >= 2;
    });
    if (usable.length === 0) return;

    const existing = await readLearnedVersions(gameDomain);
    const merged = Array.from(new Set([...usable, ...existing])).slice(0, MAX_LEARNED_VERSIONS);
    await auxSet(`knownVersions:${gameDomain}`, {versions: merged});
}

async function readLearnedVersions(gameDomain: string): Promise<string[]> {
    const entry = await auxGet(`knownVersions:${gameDomain}`);
    return Array.isArray(entry?.versions) ? entry.versions : [];
}

/**
 * The builds a verdict may be measured against. Cached reads only: a badge check
 * must never wait on a harvest, so a stale or missing list starts one in the
 * background and this call answers with what is already known.
 */
async function getAllowedVersionsFor(gameDomain: string): Promise<string[]> {
    let harvested: string[] = [];
    let learned: string[] = [];

    try {
        const harvest = await readHarvest(gameDomain);
        if (harvest) {
            harvested = harvest.entries
                .filter(entry => isCorroboratedOrigin(entry.origin))
                .map(entry => entry.core);
        }
        if (!isHarvestFresh(harvest)) scheduleHarvest(gameDomain);
        learned = await readLearnedVersions(gameDomain);
    } catch (_) { /* whatever resolved still stands on its own */ }

    return Array.from(new Set([...harvested, ...learned]));
}

/**
 * When a build's own release time is known, a file uploaded after it is real (if
 * weak) evidence. Returns null when nothing verifiable is known: an invented
 * date would manufacture confidence.
 */
async function getKnownVersionReleaseTime(gameDomain: string, version: string): Promise<number | null> {
    try {
        const harvest = await readHarvest(gameDomain);
        if (!harvest) return null;

        const target = readVersionCore(version);
        if (!target) return null;
        const key = canonicalVersionKey(target.core);

        for (const entry of harvest.entries) {
            if (entry.key !== key) continue;
            return entry.time > 0 ? entry.time * 1000 : null;
        }
    } catch (_) { /* ignore lookup errors */ }
    return null;
}

interface DerivedVersionsResponse {
    versions: Array<{version: string; label: string; sources: VersionOrigin[]; corroboration: number}>;
    requests: number;
    storeBound: boolean;
    harvestedAt: string | null;
    note: string;
}

/**
 * The generic answer: every version this installation can derive for one game,
 * ordered, deduplicated, each carrying the sources that produced it.
 */
async function resolveDerivedVersions(gameDomain: any, force = false, nameHint?: string): Promise<DerivedVersionsResponse> {
    const domain = validateGameDomain(gameDomain);
    if (!domain) {
        throw new NexusApiError({
            code: 'BAD_REQUEST',
            message: t('background_errorNoGameDomain'),
            retryable: false
        });
    }

    const harvest = await harvestGameVersions(domain, {force: force === true, nameHint});

    return {
        versions: harvest.entries.map(entry => ({
            version: entry.label,
            label: entry.label,
            sources: entry.sources,
            corroboration: entry.corroboration
        })),
        requests: harvest.requests,
        storeBound: harvest.storeBound,
        harvestedAt: harvest.harvestedAt ? new Date(harvest.harvestedAt).toISOString() : null,
        note: harvest.storeNote
    };
}

/**
 * The older Steam-shaped request, still answered. The app id it carries is a
 * hint and nothing more: it is re-verified like any other, so a binding stored
 * before the verification rule existed cannot smuggle another game's builds in.
 */
async function resolveGameVersions(_appId: string, gameDomain: any, force = false): Promise<DerivedVersionsResponse> {
    return resolveDerivedVersions(gameDomain, force);
}

/**
 * Name to store app id, refused when the evidence is only a fuzzy name match.
 * The popup stores whatever this returns, so returning an unverified id would
 * write a wrong binding into settings that every later harvest would trust.
 */
async function resolveSteamAppId(name: string): Promise<{appId: string; item: any; total: number}> {
    if (!name) throw new Error('Missing game name');
    const budget: HarvestBudget = {requests: 0, answered: 0};
    const pick = await searchStoreApp(name, budget);
    if (!pick?.id) {
        throw new NexusApiError({
            code: 'NOT_FOUND',
            message: t('background_errorNoStoreListing'),
            retryable: false
        });
    }

    const appId = String(pick.id);
    const info = await fetchSteamAppInfo(appId, budget);
    const confirmation = confirmStoreApp(name, appId, info);
    if (!confirmation.ok) {
        throw new NexusApiError({code: 'NOT_FOUND', message: confirmation.note, retryable: false});
    }

    return {appId, item: pick, total: 1};
}

async function fetchNexus(endpoint: string, apiKey: string): Promise<any> {     
    const headers: Record<string, string> = {
        apikey: apiKey,
        'Application-Name': APP_NAME,
        'Application-Version': APP_VERSION
    };

    let lastErr: any = null;

    for (let attempt = 0; attempt < MAX_API_ATTEMPTS; attempt++) {
        try {
            const response = await fetchWithTimeout(`${API_BASE}${endpoint}`, {headers}, DEFAULT_HTTP_TIMEOUT_MS);
            captureRateLimit(response);
            broadcastRateLimit();

            if (!response.ok) {
                const status = response.status;
                const text = await response.text();
                const retryAfterHeader = response.headers.get('retry-after');
                const retryAfterMs = retryAfterHeader ? parseInt(retryAfterHeader, 10) * 1000 : null;
                if (status === 429 && rateLimitRemaining === null) {
                    rateLimitRemaining = 0;
                }
                const failure = failureForHttpStatus(status, retryAfterMs, text);
                // A 4xx that is not a rate limit will fail identically on every
                // retry, and hammering a rejected key is how an account gets
                // temporarily banned.
                if (attempt < MAX_API_ATTEMPTS - 1 && failure.retryable) {
                    await sleep(backoffDelayMs(attempt, retryAfterMs));
                    continue;
                }
                throw new NexusApiError(failure);
            }

            return response.json();
        } catch (e: any) {
            lastErr = e;
            const failure = classifyFailure(e);
            // A timeout has already spent the caller's patience; retrying it
            // twice more turns a 30s wait into a 90s one.
            if (failure.code === 'TIMEOUT') throw e;
            if (!failure.retryable) throw e;
            if (attempt >= MAX_API_ATTEMPTS - 1) throw e;
            await sleep(backoffDelayMs(attempt, failure.retryAfterMs ?? null));
        }
    }

    throw lastErr || new NexusApiError({code: 'UNEXPECTED', message: 'Nexus API request failed', retryable: false});
}

/**
 * The keyed floor under source B, reached only when every keyless source came
 * back empty. It reads the FILES of the most downloaded mods, which the keyless
 * mod query cannot see, so it finds builds stated in a file name or a file
 * description rather than in a mod's own text.
 */
async function discoverVersionsFromNexus(gameDomain: string, allowedVersions: string[], budget: HarvestBudget): Promise<VersionObservation[]> {
    const {nexusApiKey} = await chrome.storage.local.get(['nexusApiKey']);
    if (!nexusApiKey) return [];

    try {
        budget.requests++;
        const topMods: any = await fetchNexus(`/games/${gameDomain}/mods.json?order=desc&sort=downloads`, nexusApiKey as string);
        budget.answered++;
        const modIds = (topMods || []).slice(0, 5).map((m: any) => m.mod_id);

        const modsPerToken = new Map<string, Set<string>>();

        for (const modId of modIds) {
            try {
                budget.requests++;
                const files: any = await fetchNexus(`/games/${gameDomain}/mods/${modId}/files.json`, nexusApiKey as string);
                (files.files || []).slice(0, 10).forEach((file: ModFile) => {
                    const blob = `${file.name} ${file.version} ${file.description}`;
                    // Discovery, not a verdict: this is the one place unknown
                    // builds are admitted, and corroboration replaces the
                    // allow-list as the filter.
                    const found = extractVersionTokens(blob, allowedVersions, {source: 'FILE_VERSION', allowUnknownBuilds: true});
                    found.forEach(entry => {
                        const token = entry.token.replace(/(?:\.x|[+*x])$/, '');
                        if (!token) return;
                        if (!modsPerToken.has(token)) modsPerToken.set(token, new Set());
                        modsPerToken.get(token)!.add(String(modId));
                    });
                });
            } catch (_) {}
        }

        const observations: VersionObservation[] = [];
        for (const [token, mods] of modsPerToken.entries()) {
            if (mods.size < MOD_CORROBORATION_FLOOR && !isKnownGameVersion(token, allowedVersions)) continue;
            const observation = makeVersionObservation(token, 'MOD_TEXT', 0, mods.size);
            if (observation) observations.push(observation);
        }
        return observations;
    } catch (e) {
        dbg('discoverVersionsFromNexus failed', e);
        return [];
    }
}

/**
 * The in-page escape hatch must reach the settings even when the reason the user
 * wants them is that the extension is switched off, and a page-initiated
 * window.open cannot do it because popup.html is deliberately not a
 * web-accessible resource. Shared by both routers: the content script's
 * request() prefers the port, so a handler on only one of them is unreachable.
 */
async function openSettingsSurface(): Promise<{opened: string}> {
    try {
        const maybe = (chrome.action as any)?.openPopup?.();
        if (maybe && typeof maybe.then === 'function') {
            await maybe;
            return {opened: 'popup'};
        }
        if (typeof (chrome.action as any)?.openPopup === 'function') {
            return {opened: 'popup'};
        }
    } catch (_) { /* falls through to a tab, which always works */ }

    await chrome.tabs.create({url: chrome.runtime.getURL('popup/popup.html')});
    return {opened: 'tab'};
}

function broadcastRateLimit(): void {
    const snapshot = getRateLimitSnapshot();

    // chrome.runtime.sendMessage reaches the popup and other extension pages but
    // never a content script, so the in-page readout only updates over the port.
    for (const port of connectedPorts) {
        try {
            port.postMessage({type: 'RATE_LIMIT_UPDATED', snapshot});
        } catch (_) {
            connectedPorts.delete(port);
        }
    }

    try {
        const maybe = chrome.runtime.sendMessage({type: 'RATE_LIMIT_UPDATED', snapshot});
        if (maybe && typeof maybe.then === 'function' && typeof maybe.catch === 'function') {
            maybe.catch(() => {});
        }
    } catch (_) { /* no extension page is listening */ }
}

/**
 * Nexus sends this header as a datetime, not an epoch. parseInt("2019-04-01...")
 * is 2019, which lands in 1970 and makes every wait compute to zero, so the
 * brake never engages and the message quotes a 1970 reset time. All-digit values
 * are still read as an epoch in seconds.
 */
function parseRateLimitReset(raw: string): number | null {
    const value = raw.trim();
    if (!value) return null;
    if (/^\d+$/.test(value)) {
        const seconds = parseInt(value, 10);
        return Number.isFinite(seconds) ? seconds * 1000 : null;
    }
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function captureRateLimit(response: Response): void {
    const remaining = response.headers.get('x-rl-daily-remaining') ?? response.headers.get('x-rl-remaining');
    if (remaining !== null) {
        const parsed = parseInt(remaining, 10);
        // NaN is not zero: an unreadable header means the count is unknown, and
        // `NaN > 0` is false, which would have applied the brake on nothing.
        rateLimitRemaining = Number.isFinite(parsed) ? parsed : null;
    }

    const reset = response.headers.get('x-rl-daily-reset') ?? response.headers.get('x-rl-reset');
    if (reset !== null) {
        rateLimitResetAtMs = parseRateLimitReset(reset);
    }
}

async function respectRateLimit(): Promise<void> {
    if (rateLimitRemaining === null || rateLimitRemaining > 0 || !rateLimitResetAtMs) return;

    const waitMs = Math.max(0, rateLimitResetAtMs - Date.now() + 1000);
    if (waitMs === 0) return;

    if (waitMs > MAX_RATE_LIMIT_WAIT_MS) {
        const snapshot = getRateLimitSnapshot();
        throw new NexusApiError({
            code: 'RATE_LIMITED',
            message: snapshot.resetAt
                ? t('background_errorRateLimitedUntil', [snapshot.resetAt])
                : t('background_errorRateLimitedShort'),
            retryable: true,
            retryAfterMs: waitMs,
            rateLimit: snapshot
        });
    }

    console.warn(`NMA extension: waiting ${waitMs}ms for rate limit reset.`);
    await sleep(waitMs);
}

async function isExtensionEnabled(): Promise<boolean> {
    try {
        const {extensionEnabled} = await chrome.storage.local.get(['extensionEnabled']);
        return extensionEnabled !== false;
    } catch (_) {
        return true;
    }
}

function getRateLimitSnapshot(): RateLimitSnapshot {
    return {
        remaining: rateLimitRemaining,
        resetAt: rateLimitResetAtMs ? new Date(rateLimitResetAtMs).toISOString() : null
    };
}

function parseRequirementsFromHTML(html: string): ModRequirement[] {
    const requirements: ModRequirement[] = [];
    // Deliberately wider than hasRecognisedRequirementsLayout's h3 anchor, which
    // still spells a bare `<h3>`. A bare `<h3>` with one hard-coded space made an
    // attribute or a line break enough to return zero rows while the guard still
    // recognized the page by one of its other anchors, and the empty parse then
    // reported itself as "this mod has no requirements". Widening the parser is
    // the safe direction; widening the guard would only hide more parse failures.
    const sectionRegex = /<h3[^>]*>\s*(?:Nexus|Off-site)\s+requirements\s*<\/h3>[\s\S]*?<table[^>]*>([\s\S]*?)<\/table>/gi;
    let sectionMatch;

    while ((sectionMatch = sectionRegex.exec(html)) !== null) {
        const tableContent = sectionMatch[1];
        const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
        let rowMatch;
        while ((rowMatch = rowRegex.exec(tableContent)) !== null) {
            const rowHtml = rowMatch[1];
            if (rowHtml.includes('<th')) continue;

            const nameMatch = rowHtml.match(/<td[^>]*class="table-require-name"[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
            const notesMatch = rowHtml.match(/<td[^>]*class="table-require-notes"[^>]*>([\s\S]*?)<\/td>/i);

            if (nameMatch) {
                let link = nameMatch[1].trim();
                if (link.startsWith('/')) {
                    link = 'https://www.nexusmods.com' + link;
                }
                requirements.push({
                    link_name: nameMatch[2].trim().replace(/<[^>]+>/g, '').replace(/\s+/g, ' '),
                    link: link,
                    notes: notesMatch ? notesMatch[1].trim().replace(/<[^>]+>/g, '').replace(/\s+/g, ' ') : ''
                });
            }
        }
    }
    return requirements;
}

