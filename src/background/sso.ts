import type { SsoPhase, SsoStatus } from '../types';
import { t } from '../i18n';

const SSO_WS_URL = 'wss://sso.nexusmods.com';
const SSO_APP_SLUG = 'alkeari-nexusmodsassistant';
const MAX_RECONNECT = 5;

let ssoSocket: WebSocket | null = null;
let ssoPhase: SsoPhase = 'IDLE';
let ssoMessage = '';
let reconnectAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function uuidv4(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}

function setPhase(phase: SsoPhase, message: string, isError = false): void {
    ssoPhase = phase;
    ssoMessage = message;
    broadcastSsoStatus();
}

function broadcastSsoStatus(): void {
    chrome.runtime.sendMessage({
        type: 'SSO_STATUS_UPDATED',
        status: getSsoStatus()
    }).catch(() => {});
}

export function getSsoStatus(): SsoStatus {
    return {
        phase: ssoPhase,
        message: ssoMessage,
        isError: ssoPhase === 'ERROR'
    };
}

export async function startSso(): Promise<void> {
    // Clean up any existing connection
    cleanupSocket();
    clearReconnectTimer();
    reconnectAttempt = 0;

    // Get or create UUID, get stored token
    let stored: Record<string, any> = {};
    try {
        stored = await chrome.storage.session.get(['nma_sso_uuid', 'nma_sso_token']);
    } catch (_) {}

    let uuid = stored.nma_sso_uuid;
    if (!uuid) {
        uuid = uuidv4();
        try {
            await chrome.storage.session.set({ nma_sso_uuid: uuid });
        } catch (_) {}
    }

    const token = stored.nma_sso_token || null;

    connectWebSocket(uuid, token);
}

function connectWebSocket(uuid: string, token: string | null): void {
    setPhase('CONNECTING', t('background_ssoConnecting'));

    try {
        const socket = new WebSocket(SSO_WS_URL);
        ssoSocket = socket;

        socket.addEventListener('open', () => {
            if (ssoSocket !== socket) return;
            const payload = { id: uuid, token, protocol: 2 };
            try {
                socket.send(JSON.stringify(payload));
                setPhase('WAITING_FOR_APPROVAL', t('background_ssoWaitingApproval'));

                // Only open the auth tab on first connect (not reconnects)
                if (reconnectAttempt === 0) {
                    openSsoAuthTab(uuid);
                }
            } catch (_) {
                setPhase('ERROR', t('background_ssoHandshakeFailed'));
                cleanupSocket();
            }
        });

        socket.addEventListener('message', (event) => handleSsoMessage(event, socket));

        socket.addEventListener('error', () => {
            if (ssoSocket !== socket) return;
            // error is followed by close, so let close handler deal with reconnection
        });

        socket.addEventListener('close', () => {
            if (ssoSocket !== socket) return;
            ssoSocket = null;

            // If we were waiting for approval, attempt reconnection
            if (ssoPhase === 'WAITING_FOR_APPROVAL') {
                attemptReconnect(uuid);
            }
        });
    } catch (error: any) {
        setPhase('ERROR', error?.message || t('background_ssoConnectionFailed'));
    }
}

async function handleSsoMessage(event: MessageEvent, socket: WebSocket): Promise<void> {
    if (ssoSocket !== socket) return;

    try {
        const payload = JSON.parse(event.data);
        if (!payload.success) {
            throw new Error(payload.error || t('background_ssoRejected'));
        }

        const data = payload.data || {};

        if (data.connection_token) {
            try {
                await chrome.storage.session.set({ nma_sso_token: data.connection_token });
            } catch (_) {}
            setPhase('WAITING_FOR_APPROVAL', t('background_ssoConnectionReady'));
        }

        if (data.api_key) {
            await chrome.storage.local.set({ nexusApiKey: data.api_key });
            setPhase('COMPLETE', t('background_ssoComplete'));
            cleanupSocket();
            clearReconnectTimer();
            // Clear session storage for SSO
            try {
                await chrome.storage.session.remove(['nma_sso_uuid', 'nma_sso_token']);
            } catch (_) {}
        }
    } catch (error: any) {
        setPhase('ERROR', error?.message || t('background_ssoUnexpectedResponse'));
        cleanupSocket();
    }
}

async function attemptReconnect(uuid: string): Promise<void> {
    reconnectAttempt++;
    if (reconnectAttempt > MAX_RECONNECT) {
        setPhase('ERROR', t('background_ssoLostConnection'));
        return;
    }

    const delay = Math.pow(2, reconnectAttempt - 1) * 1000; // 1s, 2s, 4s, 8s, 16s
    setPhase('WAITING_FOR_APPROVAL', t('background_ssoReconnecting', [String(reconnectAttempt), String(MAX_RECONNECT)]));

    reconnectTimer = setTimeout(async () => {
        reconnectTimer = null;
        let token: string | null = null;
        try {
            const stored = await chrome.storage.session.get(['nma_sso_token']);
            token = stored.nma_sso_token || null;
        } catch (_) {}
        connectWebSocket(uuid, token);
    }, delay);
}

function openSsoAuthTab(uuid: string): void {
    const params = new URLSearchParams({
        id: uuid,
        application: SSO_APP_SLUG
    });
    const url = `https://www.nexusmods.com/sso?${params.toString()}`;
    chrome.tabs.create({ url });
}

export function cancelSso(): void {
    cleanupSocket();
    clearReconnectTimer();
    reconnectAttempt = 0;
    setPhase('IDLE', t('background_ssoCanceled'));
    // Clear session storage
    chrome.storage.session.remove(['nma_sso_uuid', 'nma_sso_token']).catch(() => {});
}

function cleanupSocket(): void {
    if (ssoSocket) {
        try {
            ssoSocket.close();
        } catch (_) {}
        ssoSocket = null;
    }
}

function clearReconnectTimer(): void {
    if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
}
