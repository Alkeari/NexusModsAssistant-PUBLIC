// Error taxonomy shared by messaging.ts, context.ts and report.ts.
// It lives in its own module because messaging and context each need it and
// importing one from the other would create a cycle.

export type ErrorCode =
    | 'PORT_DISCONNECTED'
    | 'PORT_TIMEOUT'
    | 'RECEIVING_END'
    | 'CONTEXT_INVALID'
    | 'CANCELED'
    | 'DISABLED'
    | 'BACKGROUND_ERROR';

export class NmaError extends Error {
    readonly code: ErrorCode;
    readonly detail: unknown;

    constructor(code: ErrorCode, message: string, detail?: unknown) {
        super(message);
        this.name = 'NmaError';
        this.code = code;
        this.detail = detail;
    }
}

const RETRYABLE: ReadonlySet<ErrorCode> = new Set(['PORT_DISCONNECTED', 'PORT_TIMEOUT', 'RECEIVING_END']);

export function isRetryable(err: unknown): boolean {
    return err instanceof NmaError && RETRYABLE.has(err.code);
}
