// An orphaned content script (extension updated or reloaded with a tab open)
// shuts down once, quietly, and tells the user how to get it back.

import {NmaError} from './errors';
import { t } from '../i18n';

type ShutdownHandler = (reason: string) => void;

let shutdownHandler: ShutdownHandler | null = null;
let shutdownRan = false;

export function setContextShutdownHandler(handler: ShutdownHandler): void {
    shutdownHandler = handler;
}

export function isContextAlive(): boolean {
    try {
        return !!chrome.runtime?.id;
    } catch (_) {
        return false;
    }
}

export function isContextInvalidatedError(err: unknown): boolean {
    const msg = (err as Error)?.message || String(err || '');
    return msg.includes('Extension context invalidated') || msg.includes('context invalidated');
}

export function assertContextAlive(): void {
    if (isContextAlive()) return;
    shutdownOrphan();
    throw new NmaError('CONTEXT_INVALID', 'Nexus Mods Assistant was updated. Reload this page to continue.');
}

export function shutdownOrphan(): void {
    // Every in-flight catch will try to run this; it must happen exactly once and stay quiet.
    if (shutdownRan) return;
    shutdownRan = true;
    console.info('NMA extension: context invalidated, shutting down.');
    try {
        if (shutdownHandler) shutdownHandler('extension context invalidated');
    } catch (err) {
        console.warn('NMA extension: shutdown after context loss threw', err);
    }
    showReloadNotice();
}

function showReloadNotice(): void {
    if (document.getElementById('nma-reload-notice')) return;

    const notice = document.createElement('div');
    notice.id = 'nma-reload-notice';
    notice.className = 'nma-notice nma-notice-info';

    const text = document.createElement('span');
    text.className = 'nma-notice-text';
    text.textContent = t('content_contextInvalidatedNotice');
    notice.appendChild(text);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'nma-notice-action';
    button.textContent = t('content_reloadPage');
    button.addEventListener('click', () => window.location.reload());
    notice.appendChild(button);

    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'nma-notice-dismiss';
    dismiss.setAttribute('aria-label', t('content_dismiss'));
    dismiss.textContent = '×';
    dismiss.addEventListener('click', () => notice.remove());
    notice.appendChild(dismiss);

    document.body.appendChild(notice);
}
