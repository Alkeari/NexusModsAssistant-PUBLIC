// One request primitive with a mandatory timeout, request ids, cancellation and
// a bounded pending map. No call site can create a promise that never settles.

import {NmaError, ErrorCode, isRetryable} from './errors';
import {assertContextAlive, isContextAlive, isContextInvalidatedError, shutdownOrphan} from './context';
import { t } from '../i18n';

export {NmaError, isRetryable};
export type {ErrorCode};

const MAX_PENDING = 256;
const DEFAULT_TIMEOUT_MS = 15000;
const RECONNECT_DELAY_MS = 800;
const HEARTBEAT_MS = 25000;

interface Pending {
    resolve: (value: any) => void;
    reject: (err: NmaError) => void;
    timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, Pending>();
let port: chrome.runtime.Port | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let reqSeq = 0;
let intentionallyClosed = false;
let enabledCache: boolean | null = null;

// Must outlive teardown: this is how a disabled extension learns it was re-enabled.
try {
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes.extensionEnabled) return;
        enabledCache = changes.extensionEnabled.newValue !== false;
    });
} catch (_) { /* context already gone */ }

function isReceivingEndError(err: unknown): boolean {
    const msg = (err as Error)?.message || String(err || '');
    return msg.includes('Receiving end does not exist') || msg.includes('Could not establish connection');
}

const NON_IDEMPOTENT_TYPES: ReadonlySet<string> = new Set(['DOWNLOAD_MOD']);

export interface RequestOptions {
    timeoutMs?: number;
    signal?: AbortSignal;
    tries?: number;
    allowWhileDisabled?: boolean;
}

async function ensureEnabled(message: any, opts: RequestOptions): Promise<void> {
    if (opts.allowWhileDisabled || message?.type === 'PING') return;
    if (enabledCache === null) {
        const {extensionEnabled} = await chrome.storage.local.get(['extensionEnabled']);
        enabledCache = extensionEnabled !== false;
    }
    if (!enabledCache) {
        throw new NmaError('DISABLED', 'The extension is switched off.');
    }
}

export async function request<T>(message: Record<string, unknown>, opts: RequestOptions = {}): Promise<T> {
    // A timeout or a dropped port means "no answer", never "it did not happen".
    // The background starts the browser download before it replies and keeps no
    // dedupe, so a retried DOWNLOAD_MOD is a second copy of the file and a
    // second download-link call against the user's API allowance.
    const tries = NON_IDEMPOTENT_TYPES.has(String(message?.type ?? '')) ? 1 : (opts.tries ?? 3);
    let lastError: unknown = null;

    for (let attempt = 0; attempt < tries; attempt++) {
        // Before any chrome.* call, including the storage read below.
        assertContextAlive();
        try {
            await ensureEnabled(message, opts);
            return await sendOnce<T>(message, opts);
        } catch (err) {
            lastError = err;
            if (isContextInvalidatedError(err)) {
                throw new NmaError('CONTEXT_INVALID', 'Nexus Mods Assistant was updated. Reload this page to continue.');
            }
            if (!isRetryable(err) || attempt === tries - 1) throw err;
            await delay(200 * Math.pow(2, attempt), opts.signal);
            ensurePort();
        }
    }
    throw lastError || new NmaError('BACKGROUND_ERROR', t('content_errorUnknownMessaging'));
}

function sendOnce<T>(message: Record<string, unknown>, opts: RequestOptions): Promise<T> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (opts.signal?.aborted) return Promise.reject(new NmaError('CANCELED', 'Canceled before send.'));
    if (pending.size >= MAX_PENDING) {
        return Promise.reject(new NmaError('BACKGROUND_ERROR', t('content_errorTooManyRequests')));
    }

    const active = ensurePort();
    if (!active) return sendViaRuntime<T>(message, timeoutMs);

    const reqId = `r${Date.now()}_${++reqSeq}`;
    return new Promise<T>((resolve, reject) => {
        const onAbort = () => {
            pending.get(reqId)?.reject(new NmaError('CANCELED', 'Request canceled.'));
        };

        const settle = (fn: () => void) => {
            const entry = pending.get(reqId);
            if (!entry) return;
            clearTimeout(entry.timer);
            pending.delete(reqId);
            // A route signal outlives hundreds of requests, so a listener left
            // behind by every settled one is a leak the size of the grid.
            opts.signal?.removeEventListener('abort', onAbort);
            fn();
        };

        const timer = setTimeout(
            () => settle(() => reject(new NmaError('PORT_TIMEOUT', `Request timed out after ${timeoutMs}ms.`))),
            timeoutMs
        );

        pending.set(reqId, {
            resolve: value => settle(() => resolve(value)),
            reject: err => settle(() => reject(err)),
            timer
        });

        opts.signal?.addEventListener('abort', onAbort, {once: true});

        try {
            active.postMessage({...message, reqId});
        } catch (err) {
            pending.get(reqId)?.reject(new NmaError('PORT_DISCONNECTED', 'Port closed before send.', err));
        }
    });
}

function sendViaRuntime<T>(message: Record<string, unknown>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            reject(new NmaError('PORT_TIMEOUT', `Request timed out after ${timeoutMs}ms.`));
        }, timeoutMs);

        const finish = (fn: () => void) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            fn();
        };

        try {
            chrome.runtime.sendMessage(message)
                .then(res => finish(() => resolve(res as T)))
                .catch(err => finish(() => reject(toNmaError(err))));
        } catch (err) {
            finish(() => reject(toNmaError(err)));
        }
    });
}

function toNmaError(err: unknown): NmaError {
    if (err instanceof NmaError) return err;
    if (isContextInvalidatedError(err)) {
        return new NmaError('CONTEXT_INVALID', 'Nexus Mods Assistant was updated. Reload this page to continue.');
    }
    if (isReceivingEndError(err)) {
        return new NmaError('RECEIVING_END', 'Lost contact with the extension background.', err);
    }
    return new NmaError('BACKGROUND_ERROR', (err as Error)?.message || String(err || t('content_errorBackground')), err);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        // The signal belongs to the route and outlives this delay, so the
        // listener is removed on both exits rather than only on abort.
        const onAbort = () => {
            clearTimeout(timer);
            reject(new NmaError('CANCELED', 'Request canceled.'));
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        signal?.addEventListener('abort', onAbort, {once: true});
    });
}

function ensurePort(): chrome.runtime.Port | null {
    if (port) return port;
    if (intentionallyClosed || !isContextAlive()) return null;

    try {
        const opened = chrome.runtime.connect({name: 'nma-port'});
        port = opened;
        if (reconnectTimer !== null) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }

        opened.onMessage.addListener(msg => {
            const {reqId, ok, result, error} = msg || {};
            // Unsolicited pushes carry no reqId. chrome.runtime.sendMessage does
            // not reach a content script, so the port is the only way in.
            if (!reqId && msg?.type === 'RATE_LIMIT_UPDATED' && msg.snapshot) {
                document.dispatchEvent(new CustomEvent('nma:rate-limit', {detail: msg.snapshot}));
                return;
            }
            if (!reqId) return;
            const entry = pending.get(reqId);
            if (!entry) return;
            if (ok === false) entry.reject(new NmaError('BACKGROUND_ERROR', error || t('content_errorBackground'), msg));
            else entry.resolve(result !== undefined ? result : msg);
        });

        opened.onDisconnect.addListener(() => {
            // A late disconnect from an orphaned port must not tear down the live one.
            if (port !== opened) return;
            port = null;
            rejectAllPending(new NmaError('PORT_DISCONNECTED', 'Background connection dropped.'));
            scheduleReconnect();
        });

        startHeartbeat();
        return opened;
    } catch (_) {
        port = null;
        return null;
    }
}

function startHeartbeat(): void {
    if (heartbeatTimer) return;
    heartbeatTimer = setInterval(() => {
        // An orphaned tab finds out on its own rather than waiting for the user
        // to touch a control that then fails.
        if (!isContextAlive()) {
            stopHeartbeat();
            shutdownOrphan();
            return;
        }
        // A hidden tab has no reason to keep the service worker awake.
        if (document.hidden || !port) return;
        try {
            port.postMessage({type: 'PING'});
        } catch (_) { /* the disconnect handler owns recovery */ }
    }, HEARTBEAT_MS);
}

function stopHeartbeat(): void {
    if (!heartbeatTimer) return;
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
}

function scheduleReconnect(): void {
    if (reconnectTimer !== null || intentionallyClosed) return;
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (isContextAlive() && !intentionallyClosed) ensurePort();
    }, RECONNECT_DELAY_MS);
}

export function rejectAllPending(err: NmaError): void {
    for (const entry of Array.from(pending.values())) entry.reject(err);
    pending.clear();
}

export function closePort(): void {
    // Reverses everything ensurePort acquired. Without this the module stays
    // "phantom connected": a heartbeat posting into a dead port forever.
    intentionallyClosed = true;
    const open = port;
    port = null;
    stopHeartbeat();
    if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    rejectAllPending(new NmaError('CANCELED', 'Connection closed.'));
    if (open) {
        try {
            open.disconnect();
        } catch (_) { /* ignore */ }
    }
}

// ── Legacy-named helpers kept so existing call sites stay valid ──────

export function nmaConnectPort(): void {
    intentionallyClosed = false;
    ensurePort();
}

export function nmaDisconnectPort(): void {
    closePort();
}

export function nmaRejectAllPending(reason = 'Request canceled'): void {
    rejectAllPending(new NmaError('CANCELED', reason));
}

export function nmaToDateInputValue(d: Date): string {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

export function nmaGenerateRouteToken(): string {
    return `t${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

export function nmaNotifyRouteToken(routeToken: string): void {
    if (!routeToken) return;
    request({type: 'SET_ROUTE_TOKEN', token: routeToken}, {timeoutMs: 3000, tries: 1, allowWhileDisabled: true})
        .catch(() => { /* the next request re-announces the token */ });
}

// ── Concurrency limiter ──────────────────────────────────────────────

const MAX_INFLIGHT = 6;
const REQUIREMENTS_MAX_INFLIGHT = 3;

// The grid and a mod's requirements compete for the same background worker, and
// a requirements list is one burst of a dozen checks. Sharing one queue let that
// burst take every slot, so the tiles the user is actually looking at sat on
// "Checking compatibility..." until it drained. Separate lanes, separate caps.
export const COMPAT_LANE = 'compat';
export const REQUIREMENTS_LANE = 'requirements';

interface Lane {
    readonly limit: number;
    readonly live: Set<symbol>;
    readonly queue: Array<{run: () => void; reject: (err: NmaError) => void}>;
}

const lanes = new Map<string, Lane>();
const shared = new Map<string, Promise<any>>();

function laneFor(name: string): Lane {
    let lane = lanes.get(name);
    if (!lane) {
        lane = {
            limit: name === REQUIREMENTS_LANE ? REQUIREMENTS_MAX_INFLIGHT : MAX_INFLIGHT,
            live: new Set<symbol>(),
            queue: []
        };
        lanes.set(name, lane);
    }
    return lane;
}

export function runLimited<T>(key: string, job: () => Promise<T>, laneName: string = COMPAT_LANE): Promise<T> {
    // Dedup stays global: a requirement and a tile asking about the same mod in
    // the same epoch are one question, whichever lane asked first.
    const existing = shared.get(key);
    if (existing) return existing as Promise<T>;

    const lane = laneFor(laneName);
    const promise = new Promise<T>((resolve, reject) => {
        const token = Symbol(key);
        const run = () => {
            lane.live.add(token);
            job().then(resolve, reject).finally(() => {
                // The token is removed by whoever added it, so the count cannot go negative.
                lane.live.delete(token);
                const next = lane.queue.shift();
                if (next) next.run();
            });
        };
        if (lane.live.size < lane.limit) run();
        else lane.queue.push({run, reject});
    });

    shared.set(key, promise);
    // Released on every exit, not only on the job running to completion: a job
    // rejected while still queued would otherwise leave its key in the map for
    // the life of the page, poisoning every later call with the same key. The
    // catch is also what stops a rejection nobody has subscribed to yet from
    // surfacing as unhandled.
    promise
        .catch(() => { /* every caller attaches its own handler */ })
        .finally(() => {
            if (shared.get(key) === promise) shared.delete(key);
        });
    return promise;
}

export function cancelQueued(reason = 'Navigation changed'): void {
    // Drain and reject, every lane. Never truncate a queue of unsettled promises.
    for (const lane of lanes.values()) {
        for (const job of lane.queue.splice(0)) job.reject(new NmaError('CANCELED', reason));
    }
}

export function resetCompatQueue(): void {
    cancelQueued('Navigation changed');
}

export function setCompatQueueGate(_gate: symbol): void {
    // The epoch carried on each request is the gate now. Kept so existing
    // call sites keep compiling while they migrate.
}

// ── Rate limit broadcast ─────────────────────────────────────────────

// Unreachable as written: chrome.runtime.sendMessage from the background reaches
// extension pages, never a content script, so the port branch above is the only
// channel that delivers this. Kept, but it is not a second supported route in.
try {
    chrome.runtime.onMessage.addListener(msg => {
        if (msg?.type === 'RATE_LIMIT_UPDATED' && msg.snapshot) {
            document.dispatchEvent(new CustomEvent('nma:rate-limit', {detail: msg.snapshot}));
        }
    });
} catch (_) { /* context already gone */ }

// ── Compatibility wrapper over request() ─────────────────────────────

export async function nmaMessageWithRetry(message: any, tries = 3, _delayMs = 200): Promise<any> {
    const timeoutMs = message?.type === 'CHECK_MOD'
        ? (message.priority === 'HIGH' ? 60000 : 180000)
        : 30000;
    return request(message, {tries, timeoutMs});
}
