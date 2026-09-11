// One error channel for the whole content script. The distinction that must
// survive every layer: UNKNOWN means "we looked and the mod does not say",
// FAILED means "we could not look".

import {NmaError, ErrorCode} from './errors';
import { t } from '../i18n';

export type Level = 'info' | 'warn' | 'error';

export interface Notice {
    readonly level: Level;
    readonly code: string;
    readonly message: string;
    readonly detail?: string;
    readonly action?: {label: string; run: () => void};
}

export interface Failure {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
}

// These tables hold catalog keys rather than text: they are built when the
// module is evaluated, and the lookup has to happen when a message is rendered.
const HTTP_MESSAGE_KEYS: Record<number, string> = {
    401: 'content_errorKeyRejected',
    403: 'content_errorForbidden',
    404: 'content_errorNotFound',
    429: 'content_errorRateLimited',
    500: 'content_errorNexusDown',
    502: 'content_errorNexusDown',
    503: 'content_errorNexusDown'
};

function httpMessage(status: number): string {
    const key = HTTP_MESSAGE_KEYS[status];
    return key ? t(key) : '';
}

const CODE_MESSAGE_KEYS: Partial<Record<ErrorCode, string>> = {
    PORT_TIMEOUT: 'content_errorPortTimeout',
    PORT_DISCONNECTED: 'content_errorNoBackground',
    RECEIVING_END: 'content_errorNoBackground',
    CONTEXT_INVALID: 'content_errorContextInvalid',
    DISABLED: 'content_errorDisabled',
    CANCELED: 'content_errorCanceled'
};

const SHORT_LABEL_KEYS: Record<string, string> = {
    HTTP_401: 'content_shortKeyRejected',
    HTTP_403: 'content_shortAccessRefused',
    HTTP_404: 'content_shortNotAvailable',
    HTTP_429: 'content_shortRateLimited',
    HTTP_500: 'content_shortNexusDown',
    HTTP_502: 'content_shortNexusDown',
    HTTP_503: 'content_shortNexusDown',
    OFFLINE: 'content_shortOffline',
    PORT_TIMEOUT: 'content_shortTimedOut',
    PORT_DISCONNECTED: 'content_shortNoBackground',
    RECEIVING_END: 'content_shortNoBackground',
    CONTEXT_INVALID: 'content_shortNeedsReload',
    DISABLED: 'content_shortSwitchedOff',
    CANCELED: 'content_shortCanceled',
    BACKGROUND_ERROR: 'content_shortCheckFailed',
    UNEXPECTED: 'content_shortCheckFailed',
    // The background's own FailureCode set. It travels beside every error that
    // crosses the port, and a rejected key must not read like a rate limit.
    RATE_LIMITED: 'content_shortRateLimited',
    INVALID_KEY: 'content_shortKeyRejected',
    FORBIDDEN: 'content_shortAccessRefused',
    NOT_FOUND: 'content_shortNotAvailable',
    SERVER_ERROR: 'content_shortNexusDown',
    BAD_REQUEST: 'content_shortRequestRefused',
    TIMEOUT: 'content_shortTimedOut',
    NOT_CONFIGURED: 'content_shortNotSetUp',
    GAME_MISMATCH: 'content_shortOtherGame',
    // Every game is supported. This code means no version could be derived for
    // this one yet, which is a gap in public data and not a refusal.
    UNSUPPORTED_GAME: 'content_shortNoVersionDerived',
    STALE_REQUEST: 'content_shortSuperseded',
    LAYOUT_UNRECOGNIZED: 'content_shortPageNotRecognized'
};

interface BackgroundFailure {
    code?: string;
    message?: string;
    retryable?: boolean;
    status?: number;
}

function backgroundFailure(detail: unknown): BackgroundFailure | null {
    const failure = (detail as {failure?: BackgroundFailure})?.failure;
    return failure && typeof failure.code === 'string' ? failure : null;
}

// A number only means an HTTP status when something around it says so. A bare
// three digits in prose is as likely a mod's own title, a file size or a duration,
// and reading one as a status turns "could not look" into a claim about the mod.
// The last three patterns are the background's own throw sites, which label the
// status rather than spell HTTP: background.ts:727, :866, :1593 and :1633.
const STATUS_PATTERNS: readonly RegExp[] = [
    /\bNexus API (\d{3})\b/,
    /\bHTTP\/?[\d.]*\s*(\d{3})\b/i,
    /\bstatus(?:\s+code)?\s*[:=]?\s*(\d{3})\b/i,
    /\bDownload popup (\d{3})\b/,
    /\bmod page for requirements: (\d{3})\b/,
    /\b(?:Steam storesearch|SteamCMD) (\d{3})\b/
];

function statusFromMessage(raw: string): number | null {
    for (const pattern of STATUS_PATTERNS) {
        const match = raw.match(pattern);
        if (match) return parseInt(match[1], 10);
    }
    return null;
}

export function classifyError(err: unknown): Failure {
    const raw = (err as Error)?.message || String(err || '');

    if (err instanceof NmaError) {
        // The background answers in-band as {ok:false, error, failure:{...}}, and
        // messaging.ts hands that whole message over as detail. The structured
        // cause is the only thing that tells a rejected key from a rate limit,
        // so it is read before any guess at the text.
        const failure = backgroundFailure(err.detail);
        if (failure) {
            return {
                code: failure.code as string,
                message: failure.message || (failure.status ? httpMessage(failure.status) : '') || err.message,
                retryable: failure.retryable === true
            };
        }

        const detailStatus = (err.detail as {status?: number})?.status;
        const status = typeof detailStatus === 'number' ? detailStatus : statusFromMessage(raw);
        if (status && HTTP_MESSAGE_KEYS[status]) {
            return {code: `HTTP_${status}`, message: httpMessage(status), retryable: status >= 500 || status === 429};
        }
        const codeKey = CODE_MESSAGE_KEYS[err.code];
        return {
            code: err.code,
            message: codeKey ? t(codeKey) : err.message,
            retryable: err.code === 'PORT_TIMEOUT' || err.code === 'PORT_DISCONNECTED' || err.code === 'RECEIVING_END'
        };
    }

    const status = statusFromMessage(raw);
    if (status && HTTP_MESSAGE_KEYS[status]) {
        return {code: `HTTP_${status}`, message: httpMessage(status), retryable: status >= 500 || status === 429};
    }
    if (raw.includes('Failed to fetch') || raw.includes('NetworkError')) {
        return {code: 'OFFLINE', message: t('content_errorOffline'), retryable: true};
    }
    // Last resort, and English-only by nature: it matches the background's own sentence, which is
    // now translated. The case it is meant to catch is already handled above by the structured
    // NOT_CONFIGURED failure the background sends in-band, which is read before any guess at text.
    // This stays for an error that arrives as a bare string with no code, and it is the reason the
    // background's classifyFailure keeps its own English marker literal rather than translating it.
    if (raw.includes('API key not found')) {
        return {code: 'NO_API_KEY', message: t('content_errorNoApiKey'), retryable: false};
    }
    if (!raw) {
        return {code: 'UNEXPECTED', message: t('content_errorUnexpected'), retryable: false};
    }
    return {code: 'UNEXPECTED', message: raw, retryable: false};
}

export function shortFailureLabel(failure: Failure): string {
    return t(SHORT_LABEL_KEYS[failure.code] || 'content_shortCheckFailed');
}

const NOTICE_HOST_ID = 'nma-notice-host';
const shown = new Set<string>();

export function reportToUser(notice: Notice): void {
    // The same cause fires once per tile; the user needs it once per page.
    if (shown.has(notice.code)) return;
    shown.add(notice.code);

    const host = ensureNoticeHost();
    const row = document.createElement('div');
    row.className = `nma-notice nma-notice-${notice.level}`;
    row.dataset.noticeCode = notice.code;

    const text = document.createElement('span');
    text.className = 'nma-notice-text';
    text.textContent = notice.message;
    row.appendChild(text);

    if (notice.detail) {
        const detail = document.createElement('span');
        detail.className = 'nma-notice-detail';
        detail.textContent = notice.detail;
        row.appendChild(detail);
    }

    if (notice.action) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'nma-notice-action';
        button.textContent = notice.action.label;
        button.addEventListener('click', notice.action.run);
        row.appendChild(button);
    }

    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'nma-notice-dismiss';
    dismiss.setAttribute('aria-label', t('content_dismiss'));
    dismiss.textContent = '×';
    dismiss.addEventListener('click', () => {
        row.remove();
        shown.delete(notice.code);
    });
    row.appendChild(dismiss);

    host.appendChild(row);
}

export function clearNotices(): void {
    shown.clear();
    document.getElementById(NOTICE_HOST_ID)?.remove();
}

// These describe the extension's own configuration, not the page, so they
// survive an in-site navigation. VORTEX_HANDOFF is here for a second reason:
// its emitter has a once-per-session gate of its own, so dropping it on a route
// change would not let it re-fire, it would silence the caveat for good.
// Every other notice is a claim about the page that produced it and must not
// outlive it.
const SESSION_SCOPED_CODES: ReadonlySet<string> = new Set(['NO_API_KEY', 'NOT_TARGETED', 'VORTEX_HANDOFF']);

export function forgetRouteNotices(): void {
    for (const code of Array.from(shown)) {
        if (SESSION_SCOPED_CODES.has(code)) continue;
        forgetNotice(code);
    }
}

export function forgetNotice(code: string): void {
    shown.delete(code);
    document.querySelectorAll(`#${NOTICE_HOST_ID} [data-notice-code="${code}"]`).forEach(el => el.remove());
}

function ensureNoticeHost(): HTMLElement {
    const existing = document.getElementById(NOTICE_HOST_ID);
    if (existing?.isConnected) return existing;
    existing?.remove();
    const host = document.createElement('div');
    host.id = NOTICE_HOST_ID;
    host.setAttribute('role', 'status');
    document.body.appendChild(host);
    return host;
}
