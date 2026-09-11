import type {NexusGame} from '../types';
import {compareVersions, parseVersion} from '../background/versions';
import {applyStaticStrings, t} from '../i18n';

const SCHEMA_VERSION = 3;
const TARGET_DEBOUNCE_MS = 500;
const EXCLUSION_DEBOUNCE_MS = 400;
const STEAM_VERSION_PREFIX = 'steamVersions:';

/**
 * Firefox grants host permissions on install but lets the user revoke them
 * afterwards. A revoked origin fails as an ordinary fetch rejection, which is
 * indistinguishable from a dead network unless this is checked.
 */
const REQUIRED_HOST_ORIGINS = [
    // The keyless version harvest reads GraphQL at api.nexusmods.com/v2/graphql,
    // which this origin already covers. api-router.nexusmods.com serves the same
    // schema and was listed here for a while, but nothing ever fetched it, so it
    // was an origin the extension asked for and never used.
    'https://api.nexusmods.com/*',
    'https://www.nexusmods.com/*'
];

/**
 * How a derived version is labeled in the list. The keys are the source codes
 * the background reports; an unrecognized code is rendered from its own text
 * rather than dropped, so a source added later still explains itself here.
 */
const SOURCE_LABELS: Record<string, string> = {
    ANNOUNCEMENT: t('popup_sourceStorePatchNote'),
    STEAM_ANNOUNCEMENT: t('popup_sourceStorePatchNote'),
    BRANCH: t('popup_sourceStoreBranch'),
    STEAM_BRANCH: t('popup_sourceStoreBranch'),
    NEWS: t('popup_sourceArticleText'),
    STEAM_NEWS: t('popup_sourceArticleText'),
    MOD_TEXT: t('popup_sourceModText'),
    MODS: t('popup_sourceModText'),
    COLLECTION: t('popup_sourceCollectionMetadata'),
    COLLECTIONS: t('popup_sourceCollectionMetadata')
};

const FAILURE_TEXT: Record<string, string> = {
    NO_API_KEY: t('popup_failureNoApiKey'),
    INVALID_KEY: t('popup_failureInvalidKey'),
    FORBIDDEN: t('popup_failureForbidden'),
    NOT_FOUND: t('popup_failureNotFound'),
    RATE_LIMITED: t('popup_failureRateLimited'),
    SERVER_ERROR: t('popup_failureServerError'),
    BAD_REQUEST: t('popup_failureBadRequest'),
    NOT_CONFIGURED: t('popup_failureNotConfigured'),
    UNSUPPORTED_GAME: t('popup_failureUnsupportedGame'),
    OFFLINE: t('popup_failureOffline'),
    HOST_PERMISSION_MISSING: t('popup_failureHostPermissionMissing'),
    TIMEOUT: t('popup_failureTimeout'),
    DISABLED: t('popup_failureDisabled'),
    NO_BACKGROUND: t('popup_failureNoBackground'),
    CANCELED: t('popup_failureCanceled'),
    // The transport codes declared in src/content/errors.ts, so a reason raised
    // there reads the same wherever it surfaces.
    PORT_TIMEOUT: t('popup_failureTimeout'),
    PORT_DISCONNECTED: t('popup_failureNoBackground'),
    RECEIVING_END: t('popup_failureNoBackground'),
    BACKGROUND_ERROR: t('popup_failureBackgroundError'),
    CONTEXT_INVALID: t('popup_failureContextInvalid')
};

interface SelectedGame {
    name: string;
    domain: string;
}

/**
 * One derived version and the sources that produced it. Nothing here is
 * authored: every field arrives from a harvest the background ran against
 * public endpoints, so any installation derives the same list.
 */
interface DerivedVersion {
    label: string;
    sources: string[];
    corroboration: number;
}

type HarvestState = 'IDLE' | 'RUNNING' | 'FOUND' | 'EMPTY' | 'FAILED';

document.addEventListener('DOMContentLoaded', () => {
    applyStaticStrings();

    const shell = document.querySelector('.shell') as HTMLElement;
    const enabledToggle = document.getElementById('extension-enabled-toggle') as HTMLInputElement;
    const versionDisplay = document.getElementById('version-display') as HTMLElement;

    const suggestedGameRow = document.getElementById('suggested-game-row') as HTMLElement;
    const suggestedGameText = document.getElementById('suggested-game-text') as HTMLElement;
    const useSuggestedGameBtn = document.getElementById('use-suggested-game-btn') as HTMLButtonElement;
    const gameSearchInput = document.getElementById('game-search') as HTMLInputElement;
    const gameSuggestions = document.getElementById('game-suggestions') as HTMLElement;
    const gameSearchNote = document.getElementById('game-search-note') as HTMLElement;
    const versionMinInput = document.getElementById('game-version-min') as HTMLInputElement;
    const versionMaxInput = document.getElementById('game-version-max') as HTMLInputElement;
    const versionSuggestions = document.getElementById('version-suggestions') as HTMLElement;
    const refreshVersionsBtn = document.getElementById('refresh-versions-btn') as HTMLButtonElement;
    const versionStatus = document.getElementById('version-status') as HTMLElement;
    const exclusionInput = document.getElementById('exclusion-input') as HTMLInputElement;
    const hideTranslationsCheckbox = document.getElementById('filter-hide-translations') as HTMLInputElement;
    const browseBtn = document.getElementById('browse-mods-btn') as HTMLButtonElement;
    const statusLabel = document.getElementById('launchpad-status') as HTMLElement;
    const targetNotice = document.getElementById('target-notice') as HTMLElement;

    const connectionConnected = document.getElementById('connection-connected') as HTMLElement;
    const connectionForm = document.getElementById('connection-form') as HTMLElement;
    const connectionStatus = document.getElementById('connection-status') as HTMLElement;
    const apiKeyDisplay = document.getElementById('api-key-display') as HTMLInputElement;
    const revealKeyBtn = document.getElementById('reveal-key-btn') as HTMLButtonElement;
    const changeKeyBtn = document.getElementById('change-key-btn') as HTMLButtonElement;
    const disconnectKeyBtn = document.getElementById('disconnect-key-btn') as HTMLButtonElement;
    const disconnectConfirm = document.getElementById('disconnect-confirm') as HTMLElement;
    const disconnectCancelBtn = document.getElementById('disconnect-cancel-btn') as HTMLButtonElement;
    const disconnectConfirmBtn = document.getElementById('disconnect-confirm-btn') as HTMLButtonElement;
    const apiKeyInput = document.getElementById('api-key-input') as HTMLInputElement;
    const saveApiKeyBtn = document.getElementById('save-api-key-btn') as HTMLButtonElement;
    const getApiKeyBtn = document.getElementById('get-api-key-btn') as HTMLButtonElement;
    const cancelKeyEditBtn = document.getElementById('cancel-key-edit-btn') as HTMLButtonElement;

    const downloadModeSelect = document.getElementById('download-mode') as HTMLSelectElement;
    const downloadsStatus = document.getElementById('downloads-status') as HTMLElement;
    const showOldFilesToggle = document.getElementById('show-old-files-toggle') as HTMLInputElement;
    const showUpdateFilesToggle = document.getElementById('show-update-files-toggle') as HTMLInputElement;
    const showOptionalFilesToggle = document.getElementById('show-optional-files-toggle') as HTMLInputElement;
    const showMiscFilesToggle = document.getElementById('show-misc-files-toggle') as HTMLInputElement;

    const authorizeSsoBtn = document.getElementById('authorize-sso-btn') as HTMLButtonElement;
    const ssoStatusLabel = document.getElementById('sso-status') as HTMLElement;

    const debugLoggingToggle = document.getElementById('debug-logging-toggle') as HTMLInputElement;
    const clearCacheBtn = document.getElementById('clear-cache-btn') as HTMLButtonElement;
    const advancedStatus = document.getElementById('advanced-status') as HTMLElement;

    versionDisplay.textContent = `v${chrome.runtime.getManifest().version}`;

    let allGames: NexusGame[] = [];
    let selectedGame: SelectedGame | null = null;
    let steamAppIdByDomain: Record<string, string> = {};
    let knownVersions: DerivedVersion[] = [];
    let harvestState: HarvestState = 'IDLE';
    let harvestNote = '';
    // The harvest that owns the current list. A slower answer for a game the
    // user has since moved off must not overwrite the newer one.
    let harvestToken = 0;
    // Opening the catalog with no version target is legitimate and must never
    // require typing one, so the first attempt explains and the second proceeds.
    let browseWithoutTargetArmed = false;
    let storedApiKey = '';
    let keyRevealed = false;
    let editingKey = false;
    let activeTabDomain = '';
    let activeSuggestionIndex = -1;
    let activeVersionTarget: 'min' | 'max' = 'min';
    let targetWriteTimer: number | null = null;
    let exclusionWriteTimer: number | null = null;
    // A <select> has no memory of what it showed before the change event, and a
    // rejected write has to put the visible value back where it was.
    let committedDownloadMode = 'MANUAL';
    // Assumed granted until a check says otherwise, so a browser without the
    // permissions API keeps reporting failures exactly as it does today.
    let hostPermissionsGranted = true;

    // An unhandled rejection here would leave a half-populated popup with no
    // explanation for why its controls do not reflect what is stored.
    init().catch(error => {
        setStatus(statusLabel, t('popup_settingsReadFailed', [failureText(error)]), true);
    });

    async function init(): Promise<void> {
        await migrateStorage();

        const stored = await chrome.storage.local.get([
            'nexusApiKey',
            'targetGameDomain',
            'targetVersion',
            'targetVersionEnd',
            'lastSelectedGame',
            'hideTranslations',
            'exclusionPhrases',
            'showOldFiles',
            'showUpdateFiles',
            'showOptionalFiles',
            'showMiscFiles',
            'downloadMode',
            'steamAppIdByDomain',
            'extensionEnabled',
            'nmaDebug'
        ]);

        const isEnabled = stored.extensionEnabled !== false;
        enabledToggle.checked = isEnabled;
        shell.classList.toggle('extension-disabled', !isEnabled);

        storedApiKey = (stored.nexusApiKey as string) || '';
        renderConnection();

        selectedGame = resolveStoredGame(stored.lastSelectedGame, stored.targetGameDomain);
        if (selectedGame) gameSearchInput.value = selectedGame.name;
        versionMinInput.value = (stored.targetVersion as string) || '';
        versionMaxInput.value = (stored.targetVersionEnd as string) || '';

        hideTranslationsCheckbox.checked = stored.hideTranslations ?? true;
        // The defaults are the content script's, from src/content/filters.ts: old
        // files off, the other three on. A popup that showed its own defaults
        // would report a file list the page does not have.
        showOldFilesToggle.checked = stored.showOldFiles === true;
        showUpdateFilesToggle.checked = stored.showUpdateFiles !== false;
        showOptionalFilesToggle.checked = stored.showOptionalFiles !== false;
        showMiscFilesToggle.checked = stored.showMiscFiles !== false;
        committedDownloadMode = stored.downloadMode === 'VORTEX' ? 'VORTEX' : 'MANUAL';
        downloadModeSelect.value = committedDownloadMode;
        debugLoggingToggle.checked = stored.nmaDebug === true;
        exclusionInput.value = (stored.exclusionPhrases as string) || '';
        steamAppIdByDomain = (stored.steamAppIdByDomain as Record<string, string>) || {};

        await markStandaloneWindow();
        await refreshHostPermissionState();
        await detectActiveTabGame();

        await loadGames();

        // Every game gets a harvest, with no typed input and no fixed list of
        // titles. The background serves a cached answer when it has one.
        if (selectedGame) await harvestVersions(false);

        await displayLastUpdated();
        await syncSsoButtonWithBackground();
    }

    // ── Storage schema ───────────────────────────────────────────────

    /**
     * A user upgrading from 2.x keeps their settings. The 2.x popup wrote the
     * live edits to lastVersion/lastVersionEnd and only published targetVersion
     * when Browse was pressed, so the newer key can be absent or older.
     */
    async function migrateStorage(): Promise<void> {
        const stored = await chrome.storage.local.get([
            'schemaVersion',
            'lastVersion',
            'lastVersionEnd',
            'lastSelectedGame',
            'targetGameDomain',
            'targetVersion',
            'targetVersionEnd',
            'lastUpdatedDays',
            'lastUpdatedStart',
            'lastUpdatedEnd'
        ]);

        if (stored.schemaVersion === SCHEMA_VERSION) return;

        const writes: Record<string, unknown> = {schemaVersion: SCHEMA_VERSION};
        const removals: string[] = [];

        if (!stored.targetVersion && stored.lastVersion) {
            writes.targetVersion = stored.lastVersion;
        }
        if (!stored.targetVersionEnd && stored.lastVersionEnd) {
            writes.targetVersionEnd = stored.lastVersionEnd;
        }
        if (!stored.targetGameDomain && (stored.lastSelectedGame as SelectedGame)?.domain) {
            writes.targetGameDomain = (stored.lastSelectedGame as SelectedGame).domain;
        }
        if ('lastVersion' in stored) removals.push('lastVersion');
        if ('lastVersionEnd' in stored) removals.push('lastVersionEnd');

        const legacyDays = Number(stored.lastUpdatedDays) || 0;
        if (legacyDays > 0 && !stored.lastUpdatedStart && !stored.lastUpdatedEnd) {
            const end = new Date();
            const start = new Date();
            start.setDate(end.getDate() - legacyDays);
            writes.lastUpdatedStart = toDateInputValue(start);
            writes.lastUpdatedEnd = toDateInputValue(end);
            writes.lastUpdatedDays = 0;
        }

        try {
            await chrome.storage.local.set(writes);
            if (removals.length) await chrome.storage.local.remove(removals);
        } catch (error) {
            setStatus(connectionStatus, t('popup_settingsUpdateFailed', [errorText(error)]), true);
        }
    }

    function toDateInputValue(date: Date): string {
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${date.getFullYear()}-${month}-${day}`;
    }

    async function saveSettings(items: Record<string, unknown>, statusEl: HTMLElement): Promise<boolean> {
        try {
            await chrome.storage.local.set(items);
            return true;
        } catch (error) {
            const text = errorText(error);
            setStatus(statusEl, /quota/i.test(text)
                ? t('popup_storageFull')
                : t('popup_settingSaveFailed', [text]), true);
            return false;
        }
    }

    // ── Connection ───────────────────────────────────────────────────

    function renderConnection(): void {
        const connected = !!storedApiKey && !editingKey;
        connectionConnected.classList.toggle('hidden', !connected);
        connectionForm.classList.toggle('hidden', connected);
        disconnectConfirm.classList.add('hidden');
        cancelKeyEditBtn.classList.toggle('hidden', !storedApiKey);

        keyRevealed = false;
        revealKeyBtn.textContent = t('popup_show');
        revealKeyBtn.setAttribute('aria-pressed', 'false');
        revealKeyBtn.setAttribute('aria-label', t('popup_revealKey'));
        revealKeyBtn.title = t('popup_revealKey');

        if (connected) {
            apiKeyDisplay.type = 'text';
            apiKeyDisplay.value = maskKey(storedApiKey);
        } else {
            // Hiding the row does not empty it. Opened as a standalone tab the
            // document can live for hours after Disconnect, so a revealed key
            // would sit in the DOM that whole time.
            apiKeyDisplay.value = '';
        }

        gameSearchNote.textContent = storedApiKey
            ? ''
            : t('popup_noKeyCatalogNote');
    }

    function maskKey(key: string): string {
        const dot = '•';
        if (key.length <= 8) return dot.repeat(8);
        return `${key.slice(0, 4)}${dot.repeat(12)}${key.slice(-4)}`;
    }

    revealKeyBtn.addEventListener('click', () => {
        keyRevealed = !keyRevealed;
        apiKeyDisplay.value = keyRevealed ? storedApiKey : maskKey(storedApiKey);
        revealKeyBtn.textContent = keyRevealed ? t('popup_hide') : t('popup_show');
        revealKeyBtn.setAttribute('aria-pressed', keyRevealed ? 'true' : 'false');
        const label = keyRevealed ? t('popup_hideKey') : t('popup_revealKey');
        revealKeyBtn.setAttribute('aria-label', label);
        revealKeyBtn.title = label;
    });

    changeKeyBtn.addEventListener('click', () => {
        editingKey = true;
        apiKeyInput.value = '';
        renderConnection();
        setStatus(connectionStatus, t('popup_pasteReplacementKey'));
        apiKeyInput.focus();
    });

    cancelKeyEditBtn.addEventListener('click', () => {
        editingKey = false;
        apiKeyInput.value = '';
        apiKeyInput.classList.remove('input-error');
        renderConnection();
        setStatus(connectionStatus, '');
    });

    disconnectKeyBtn.addEventListener('click', () => {
        disconnectConfirm.classList.remove('hidden');
        disconnectCancelBtn.focus();
    });

    disconnectCancelBtn.addEventListener('click', () => {
        disconnectConfirm.classList.add('hidden');
        disconnectKeyBtn.focus();
    });

    disconnectConfirmBtn.addEventListener('click', async () => {
        disconnectConfirmBtn.disabled = true;
        setStatus(connectionStatus, t('popup_disconnecting'));
        try {
            await chrome.storage.local.remove([
                'nexusApiKey',
                'gameListCache',
                'gameListTimestamp',
                'gameDomainToId',
                'steamAppIdByDomain'
            ]);
        } catch (error) {
            setStatus(connectionStatus, t('popup_keyClearFailed', [errorText(error)]), true);
            disconnectConfirmBtn.disabled = false;
            return;
        }
        const purged = await purgeCachedResponses();

        storedApiKey = '';
        editingKey = false;
        allGames = [];
        steamAppIdByDomain = {};
        disconnectConfirmBtn.disabled = false;
        renderConnection();
        // The derived version list is keyless, so disconnecting does not
        // invalidate it and it is deliberately left in place.
        await displayLastUpdated();
        const leftBehind: string[] = [];
        if (!purged.backgroundReached) leftBehind.push(t('popup_leftBehindBackground'));
        if (purged.localSweepFailed) leftBehind.push(t('popup_leftBehindSteamCache'));

        setStatus(
            connectionStatus,
            leftBehind.length === 0
                ? t('popup_keyRemoved')
                : t('popup_keyRemovedWithLeftovers', [leftBehind.join(t('popup_leftBehindSeparator'))]),
            leftBehind.length > 0
        );
    });

    saveApiKeyBtn.addEventListener('click', async () => {
        const key = apiKeyInput.value.trim();
        if (!key) {
            apiKeyInput.classList.add('input-error');
            setStatus(connectionStatus, t('popup_pasteKeyFirst'), true);
            apiKeyInput.focus();
            return;
        }

        const previousKey = storedApiKey;
        storedApiKey = key;
        const saved = await saveSettings({nexusApiKey: key}, connectionStatus);
        if (!saved) {
            storedApiKey = previousKey;
            return;
        }

        editingKey = false;
        apiKeyInput.value = '';
        apiKeyInput.classList.remove('input-error');
        renderConnection();
        setStatus(connectionStatus, t('popup_keySaved'));
        await loadGames(true);
    });

    apiKeyInput.addEventListener('keydown', (event: KeyboardEvent) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            saveApiKeyBtn.click();
        }
    });

    getApiKeyBtn.addEventListener('click', () => {
        openApiKeysAndScroll();
    });

    /**
     * The API keys page is served from next.nexusmods.com, which is NOT in this
     * extension's host permissions, and activeTab does not extend to a tab the
     * popup opened itself. So the injection below is refused by the browser
     * today and the Scroll-To-Text Fragment is what actually moves the page.
     * The injection is kept because it is the only thing that can highlight the
     * section if that origin is ever granted; adding it is a store-review
     * decision, not a code one. PRIVACY-POLICY.md states the same thing.
     */
    function openApiKeysAndScroll(): void {
        // Prefer Scroll-To-Text Fragment so the browser natively jumps to the phrase
        const base = 'https://next.nexusmods.com/settings/api-keys';
        const url = `${base}#:~:text=${encodeURIComponent('Personal API Key')}`;
        try {
            chrome.tabs.create({url, active: true}, (tab) => {
                if (!tab || !tab.id) return;
                const tabId = tab.id;

                const tryInject = (): void => {
                    try {
                        chrome.scripting.executeScript({
                            target: {tabId},
                            func: scrollToPersonalApiKey
                        }).catch(() => { /* next.nexusmods.com is not permitted; the text fragment still works */ });
                    } catch (_) { /* ignore */ }
                };

                const onUpdated = (updatedTabId: number, info: chrome.tabs.TabChangeInfo): void => {
                    if (updatedTabId === tabId && info.status === 'complete') {
                        chrome.tabs.onUpdated.removeListener(onUpdated);
                        setTimeout(tryInject, 250);
                        setTimeout(tryInject, 2000);
                    }
                };
                chrome.tabs.onUpdated.addListener(onUpdated);

                try {
                    chrome.tabs.get(tabId, t => {
                        if (chrome.runtime.lastError) return;
                        if (t && t.status === 'complete') {
                            chrome.tabs.onUpdated.removeListener(onUpdated);
                            setTimeout(tryInject, 250);
                            setTimeout(tryInject, 2000);
                        }
                    });
                } catch (_) { /* ignore */ }
            });
        } catch (_) {
            chrome.tabs.create({url});
        }
    }

    // This function runs in the context of the Settings page
    function scrollToPersonalApiKey(): boolean {
        const matchRe = /personal\s*api\s*key/i;
        const idCandidates = ['personal-api-key', 'personal_api_key', 'personalapikey', 'personal-key', 'apikey-personal'];

        function findTarget(): HTMLElement | null {
            for (const id of idCandidates) {
                const el = document.getElementById(id);
                if (el) return el;
            }
            const nodes = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,legend,label,div,span,section')) as HTMLElement[];
            const byText = nodes.find(n => matchRe.test(n.textContent || ''));
            if (byText) return byText;
            const attrs = Array.from(document.querySelectorAll('[aria-label],[data-testid],[data-qa]')) as HTMLElement[];
            const byAttr = attrs.find(n => matchRe.test(n.getAttribute('aria-label') || '')
                || matchRe.test(n.getAttribute('data-testid') || '')
                || matchRe.test(n.getAttribute('data-qa') || ''));
            return byAttr || null;
        }

        function highlightAndScroll(target: HTMLElement): void {
            const section = (target.closest('section,form,article,div') as HTMLElement) || target;
            section.style.scrollMarginTop = '80px';
            section.scrollIntoView({behavior: 'smooth', block: 'start'});
            try {
                const prevOutline = section.style.outline;
                section.style.outline = '3px solid rgba(255,218,0,0.8)';
                section.style.transition = 'outline 0.3s ease';
                setTimeout(() => { section.style.outline = prevOutline || ''; }, 2500);
            } catch (_) { /* ignore */ }
        }

        let attempts = 0;
        const maxAttempts = 20;
        const handle = setInterval(() => {
            attempts += 1;
            const tgt = findTarget();
            if (tgt) {
                clearInterval(handle);
                highlightAndScroll(tgt);
            } else if (attempts >= maxAttempts) {
                clearInterval(handle);
            }
        }, 200);
        return true;
    }

    // ── Target: game and version ─────────────────────────────────────

    function resolveStoredGame(lastSelected: any, targetDomain: any): SelectedGame | null {
        if (lastSelected && lastSelected.domain) {
            // The content script's setup dialog stores the domain as the name,
            // so a stored name equal to the domain is a placeholder, not a title.
            const stored = lastSelected.name === lastSelected.domain ? '' : lastSelected.name;
            return {name: stored || displayNameFor(lastSelected.domain), domain: lastSelected.domain};
        }
        if (typeof targetDomain === 'string' && targetDomain) {
            return {name: displayNameFor(targetDomain), domain: targetDomain};
        }
        return null;
    }

    /**
     * The Nexus catalog is the only source of a title, and it is fetched, not
     * authored. With no catalog entry the domain is shown as it is: a domain
     * is true, and a prettified guess at a title would not be.
     */
    function displayNameFor(domain: string): string {
        const known = allGames.find(g => g.domain_name === domain);
        return known?.name || domain;
    }

    async function detectActiveTabGame(): Promise<void> {
        activeTabDomain = await readActiveNexusDomain();
        updateSuggestedGameRow();
    }

    async function readActiveNexusDomain(): Promise<string> {
        try {
            const [active] = await chrome.tabs.query({active: true, currentWindow: true});
            const fromActive = gameDomainFromUrl(active?.url || '');
            if (fromActive) return fromActive;

            const nexusTabs = await chrome.tabs.query({url: 'https://www.nexusmods.com/*'});
            for (const tab of nexusTabs) {
                const domain = gameDomainFromUrl(tab.url || '');
                if (domain) return domain;
            }
        } catch (_) { /* no tab access; the manual path still works */ }
        return '';
    }

    function gameDomainFromUrl(url: string): string {
        if (!url) return '';
        try {
            const parsed = new URL(url);
            if (!/(^|\.)nexusmods\.com$/i.test(parsed.hostname)) return '';
            const parts = parsed.pathname.split('/').filter(Boolean);
            if (parts[0] === 'games' && parts[1]) return parts[1].toLowerCase();
            if (parts.length >= 2 && parts[1] === 'mods') return parts[0].toLowerCase();
            return '';
        } catch (_) {
            return '';
        }
    }

    function updateSuggestedGameRow(): void {
        const show = !!activeTabDomain && activeTabDomain !== selectedGame?.domain;
        suggestedGameRow.classList.toggle('hidden', !show);
        if (show) {
            suggestedGameText.textContent = t('popup_openTabIsGame', [displayNameFor(activeTabDomain)]);
        }
    }

    useSuggestedGameBtn.addEventListener('click', async () => {
        if (!activeTabDomain) return;
        await selectGame({name: displayNameFor(activeTabDomain), domain: activeTabDomain});
    });

    async function selectGame(game: SelectedGame): Promise<void> {
        const changedGame = game.domain !== selectedGame?.domain;
        selectedGame = game;
        gameSearchInput.value = game.name;
        gameSearchInput.classList.remove('input-error');
        clearSuggestions(gameSuggestions, gameSearchInput);
        updateSuggestedGameRow();

        if (changedGame) {
            // A version range from another game means nothing here, and leaving
            // it in place is how a stale ceiling survives a game switch.
            versionMinInput.value = '';
            versionMaxInput.value = '';
            knownVersions = [];
            harvestState = 'IDLE';
            harvestNote = '';
            disarmBrowseWithoutTarget();
            renderVersionState();
        }

        await commitTarget();
        await harvestVersions(false);
    }

    /**
     * The list can carry publisher branch names and numbers taken from article
     * text, which are not builds. Anything the version algebra cannot read would
     * make every mod that names a version read INCOMPATIBLE, so it must never
     * become the target, and the value picked here is announced because the user
     * did not type it.
     */
    async function prefillVersionFromKnown(): Promise<void> {
        if (versionMinInput.value.trim() || knownVersions.length === 0) return;

        const candidate = knownVersions.find(entry => parseVersion(entry.label) !== null)?.label;
        if (!candidate) {
            setStatus(statusLabel, t('popup_noReadableVersion'), true);
            return;
        }

        versionMinInput.value = candidate.replace(/^v/i, '');
        // Setting .value fires no input event, so the "open anyway" state it was
        // armed with would survive a version arriving and mislabel the button.
        disarmBrowseWithoutTarget();
        const applied = await commitTarget();
        if (applied && !targetNotice.textContent) {
            targetNotice.textContent = t('popup_startVersionFilled', [versionMinInput.value]);
        }
    }

    /**
     * isCompatible cannot express "refuse to judge": given max < min it answers
     * false for every mod, including one that names exactly one of the bounds, so
     * an inverted range badges a whole page INCOMPATIBLE with full confidence.
     * The two fields are collected here, so the guard belongs here.
     */
    function invertedRange(min: string, max: string): boolean {
        if (!min || !max) return false;
        // Only a pair this popup can read is judged. An unreadable field is a
        // different problem and must not be reported as this one.
        if (!parseVersion(min) || !parseVersion(max)) return false;
        return compareVersions(min, max) > 0;
    }

    function reportInvertedRange(min: string, max: string): void {
        versionMinInput.classList.add('input-error');
        versionMaxInput.classList.add('input-error');
        setStatus(statusLabel, t('popup_invertedRange', [max, min]), true);
    }

    async function commitTarget(): Promise<boolean> {
        if (targetWriteTimer !== null) {
            clearTimeout(targetWriteTimer);
            targetWriteTimer = null;
        }
        if (!selectedGame) {
            setStatus(statusLabel, t('popup_chooseGameFirstForVersion'));
            return false;
        }

        const min = versionMinInput.value.trim();
        const max = versionMaxInput.value.trim();
        if (invertedRange(min, max)) {
            reportInvertedRange(min, max);
            return false;
        }

        // schemaVersion is deliberately not written here: it is the sentinel
        // migrateStorage stamps once its own write succeeded, and stamping it
        // from anywhere else retires a migration that never ran.
        const saved = await saveSettings({
            targetGameDomain: selectedGame.domain,
            targetVersion: min,
            targetVersionEnd: max,
            lastSelectedGame: selectedGame
        }, statusLabel);

        if (saved) {
            versionMinInput.classList.remove('input-error');
            versionMaxInput.classList.remove('input-error');
            reportTargetReach();
        }
        return saved;
    }

    /**
     * Writing per keystroke would publish 1, 1., 1.3 to every open tab, so the
     * value is committed on a pause, on blur and on Enter.
     */
    function scheduleTargetCommit(): void {
        if (targetWriteTimer !== null) clearTimeout(targetWriteTimer);
        targetWriteTimer = window.setTimeout(() => {
            targetWriteTimer = null;
            commitTarget();
        }, TARGET_DEBOUNCE_MS);
    }

    // Closing the popup mid-debounce would otherwise drop the edit the user just
    // made, which is the exact "settings that never applied" defect. Best effort:
    // the write is handed to the storage layer, not to this document.
    window.addEventListener('pagehide', () => {
        if (targetWriteTimer !== null) commitTarget();
        flushExclusions();
    });

    function reportTargetReach(): void {
        if (activeTabDomain && selectedGame && activeTabDomain !== selectedGame.domain) {
            targetNotice.textContent = t('popup_savedTabMismatch', [displayNameFor(activeTabDomain)]);
            return;
        }
        targetNotice.textContent = '';
        setStatus(statusLabel, t('popup_saved'));
    }

    gameSearchInput.addEventListener('input', () => {
        gameSearchInput.classList.remove('input-error');
        const query = gameSearchInput.value.trim().toLowerCase();
        gameSuggestions.innerHTML = '';
        activeSuggestionIndex = -1;

        if (query.length < 2) {
            clearSuggestions(gameSuggestions, gameSearchInput);
            return;
        }

        const matches = allGames
            .filter(game => game.name.toLowerCase().includes(query))
            .slice(0, 30);

        if (matches.length === 0) {
            clearSuggestions(gameSuggestions, gameSearchInput);
            if (!storedApiKey) {
                setStatus(statusLabel, t('popup_gameListNeedsKey'));
            }
            return;
        }

        matches.forEach((game, index) => {
            const row = document.createElement('div');
            row.className = 'suggestion-item';
            row.id = `game-option-${index}`;
            row.setAttribute('role', 'option');
            row.setAttribute('aria-selected', 'false');
            row.dataset.gameName = game.name;
            row.dataset.gameDomain = game.domain_name;
            row.textContent = t('popup_gameSuggestionRow', [game.name, game.domain_name]);
            row.addEventListener('mousedown', (event: MouseEvent) => {
                event.preventDefault();
                selectGame({name: game.name, domain: game.domain_name});
            });
            gameSuggestions.appendChild(row);
        });
        gameSearchInput.setAttribute('aria-expanded', 'true');
    });

    gameSearchInput.addEventListener('keydown', (event: KeyboardEvent) => {
        handleSuggestionKeys(event, gameSuggestions, gameSearchInput, (item) => {
            const domain = item.dataset.gameDomain;
            if (domain) selectGame({name: item.dataset.gameName || domain, domain});
        });
    });

    gameSearchInput.addEventListener('blur', () => {
        setTimeout(() => {
            clearSuggestions(gameSuggestions, gameSearchInput);
            // This box searches; the target is what was chosen from it. Showing an
            // abandoned search term here reads as a selection that was never made.
            gameSearchInput.value = selectedGame ? selectedGame.name : '';
        }, 150);
    });

    versionMinInput.addEventListener('input', () => {
        versionMinInput.classList.remove('input-error');
        activeVersionTarget = 'min';
        disarmBrowseWithoutTarget();
        updateVersionSuggestions(versionMinInput.value);
        scheduleTargetCommit();
    });

    /** A typed or chosen version retires the "open anyway" state it explained. */
    function disarmBrowseWithoutTarget(): void {
        if (!browseWithoutTargetArmed) return;
        browseWithoutTargetArmed = false;
        browseBtn.textContent = t('popup_openCompatibleMods');
    }

    versionMaxInput.addEventListener('input', () => {
        versionMaxInput.classList.remove('input-error');
        activeVersionTarget = 'max';
        updateVersionSuggestions(versionMaxInput.value);
        scheduleTargetCommit();
    });

    versionMinInput.addEventListener('focus', () => {
        activeVersionTarget = 'min';
        updateVersionSuggestions(versionMinInput.value);
    });

    versionMaxInput.addEventListener('focus', () => {
        activeVersionTarget = 'max';
        updateVersionSuggestions(versionMaxInput.value);
    });

    [versionMinInput, versionMaxInput].forEach(input => {
        input.addEventListener('blur', () => {
            commitTarget();
            setTimeout(clearVersionSuggestions, 150);
        });
        input.addEventListener('keydown', (event: KeyboardEvent) => {
            const handled = handleSuggestionKeys(event, versionSuggestions, input, (item) => {
                applyVersionSuggestion(item.dataset.version || item.textContent || '');
            });
            if (!handled && event.key === 'Enter') {
                event.preventDefault();
                commitTarget();
            }
        });
    });

    refreshVersionsBtn.addEventListener('click', async () => {
        if (!selectedGame) {
            setStatus(statusLabel, t('popup_chooseGameFirstForHarvest'), true);
            gameSearchInput.focus();
            return;
        }
        await harvestVersions(true);
    });

    function updateVersionSuggestions(rawQuery: string): void {
        const query = String(rawQuery || '').trim().replace(/^v/i, '').toLowerCase();

        if (knownVersions.length === 0) {
            // A running, empty or failed harvest states itself in the same box,
            // so nothing is ever silently absent.
            renderVersionState();
            return;
        }

        versionSuggestions.innerHTML = '';
        activeSuggestionIndex = -1;

        let suggestions: DerivedVersion[];
        if (!query) {
            suggestions = knownVersions.slice(0, 20);
        } else {
            const clean = (entry: DerivedVersion) => entry.label.toLowerCase().replace(/^v/i, '');
            const starts = knownVersions.filter(entry => clean(entry).startsWith(query));
            const contains = knownVersions.filter(entry => !clean(entry).startsWith(query) && clean(entry).includes(query));
            suggestions = [...starts, ...contains].slice(0, 20);
        }

        suggestions.forEach((entry, index) => {
            const row = document.createElement('div');
            row.className = 'suggestion-item version-row';
            row.id = `version-option-${index}`;
            row.setAttribute('role', 'option');
            row.setAttribute('aria-selected', 'false');
            row.dataset.version = entry.label;

            const label = document.createElement('span');
            label.textContent = entry.label;
            row.appendChild(label);

            const provenance = provenanceText(entry);
            if (provenance) {
                const tag = document.createElement('span');
                tag.className = 'version-provenance';
                tag.textContent = provenance;
                row.appendChild(tag);
                row.setAttribute('aria-label', t('popup_versionOptionAriaLabel', [entry.label, provenance]));
            }

            row.addEventListener('mousedown', (event: MouseEvent) => {
                // mousedown so the value lands before the input blurs
                event.preventDefault();
                applyVersionSuggestion(entry.label);
            });
            versionSuggestions.appendChild(row);
        });

        versionSuggestions.setAttribute('aria-busy', 'false');
        const target = activeVersionTarget === 'max' ? versionMaxInput : versionMinInput;
        const other = activeVersionTarget === 'max' ? versionMinInput : versionMaxInput;
        target.setAttribute('aria-expanded', suggestions.length > 0 ? 'true' : 'false');
        other.setAttribute('aria-expanded', 'false');
    }

    /**
     * What a number came from, in the user's words. A wrong-looking version is
     * only diagnosable if the source that supplied it is on the row. A code this
     * popup does not recognize is rendered from its own text rather than hidden.
     */
    function provenanceText(entry: DerivedVersion): string {
        const labels = entry.sources
            .map(code => SOURCE_LABELS[code] || String(code).toLowerCase().replace(/_/g, ' '))
            .filter(Boolean);
        const unique = Array.from(new Set(labels));
        if (unique.length === 0) return '';
        const base = unique.slice(0, 2).join(' + ');
        return entry.corroboration > 1
            ? t('popup_provenanceCorroboration', [base, String(entry.corroboration)])
            : base;
    }

    /**
     * The one place that decides what the version box says when it holds no
     * options. "Still looking", "looked and found nothing" and "could not look"
     * are three different statements and must never collapse into a blank box.
     */
    function renderVersionState(): void {
        versionSuggestions.innerHTML = '';
        activeSuggestionIndex = -1;
        versionMinInput.setAttribute('aria-expanded', 'false');
        versionMaxInput.setAttribute('aria-expanded', 'false');
        versionSuggestions.setAttribute('aria-busy', harvestState === 'RUNNING' ? 'true' : 'false');

        if (harvestState === 'IDLE' || knownVersions.length > 0) {
            setStatus(versionStatus, harvestNote, harvestState === 'FAILED');
            return;
        }

        const note = document.createElement('div');
        note.className = 'suggestion-note';

        if (harvestState === 'RUNNING') {
            note.textContent = t('popup_derivingVersions');
        } else if (harvestState === 'FAILED') {
            note.className = 'suggestion-note error';
            note.textContent = t('popup_versionSearchIncomplete');
        } else {
            note.textContent = t('popup_noVersionsFound');
        }

        versionSuggestions.appendChild(note);
        setStatus(versionStatus, harvestNote, harvestState === 'FAILED');
    }

    function applyVersionSuggestion(value: string): void {
        const normalized = String(value || '').replace(/^v/i, '');
        const target = activeVersionTarget === 'max' ? versionMaxInput : versionMinInput;
        target.value = normalized;
        disarmBrowseWithoutTarget();
        clearVersionSuggestions();
        target.focus();
        commitTarget();
    }

    /**
     * Both version inputs point at one listbox, so both carry its ARIA state.
     * Closing the options restores the state note rather than leaving a blank
     * box: an unfinished or fruitless harvest stays visible after blur.
     */
    function clearVersionSuggestions(): void {
        clearSuggestions(versionSuggestions, versionMinInput);
        versionMaxInput.setAttribute('aria-expanded', 'false');
        versionMaxInput.removeAttribute('aria-activedescendant');
        renderVersionState();
    }

    function handleSuggestionKeys(
        event: KeyboardEvent,
        container: HTMLElement,
        input: HTMLInputElement,
        choose: (item: HTMLElement) => void
    ): boolean {
        const items = Array.from(container.querySelectorAll('.suggestion-item')) as HTMLElement[];
        if (items.length === 0) return false;

        if (event.key === 'ArrowDown') {
            event.preventDefault();
            activeSuggestionIndex = (activeSuggestionIndex + 1) % items.length;
            markActiveSuggestion(items, input);
            return true;
        }
        if (event.key === 'ArrowUp') {
            event.preventDefault();
            activeSuggestionIndex = (activeSuggestionIndex - 1 + items.length) % items.length;
            markActiveSuggestion(items, input);
            return true;
        }
        if (event.key === 'Enter' && activeSuggestionIndex >= 0 && activeSuggestionIndex < items.length) {
            event.preventDefault();
            choose(items[activeSuggestionIndex]);
            return true;
        }
        if (event.key === 'Escape') {
            clearSuggestions(container, input);
            return true;
        }
        return false;
    }

    function markActiveSuggestion(items: HTMLElement[], input: HTMLInputElement): void {
        items.forEach((el, index) => {
            const isActive = index === activeSuggestionIndex;
            el.classList.toggle('active', isActive);
            el.setAttribute('aria-selected', isActive ? 'true' : 'false');
            if (isActive) {
                input.setAttribute('aria-activedescendant', el.id);
                el.scrollIntoView({block: 'nearest'});
            }
        });
    }

    function clearSuggestions(container: HTMLElement, input: HTMLInputElement): void {
        container.innerHTML = '';
        activeSuggestionIndex = -1;
        input.setAttribute('aria-expanded', 'false');
        input.removeAttribute('aria-activedescendant');
    }

    // ── Filters and launch ───────────────────────────────────────────

    hideTranslationsCheckbox.addEventListener('change', () => {
        saveSettings({hideTranslations: hideTranslationsCheckbox.checked}, statusLabel);
    });

    const FILE_CATEGORY_TOGGLES: [HTMLInputElement, string][] = [
        [showOldFilesToggle, 'showOldFiles'],
        [showUpdateFilesToggle, 'showUpdateFiles'],
        [showOptionalFilesToggle, 'showOptionalFiles'],
        [showMiscFilesToggle, 'showMiscFiles']
    ];

    FILE_CATEGORY_TOGGLES.forEach(([toggle, key]) => {
        toggle.addEventListener('change', async () => {
            const saved = await saveSettings({[key]: toggle.checked}, downloadsStatus);
            // A tick that did not reach storage is a control that says one thing
            // and does another the next time a file list opens.
            if (!saved) toggle.checked = !toggle.checked;
        });
    });

    downloadModeSelect.addEventListener('change', async () => {
        const next = downloadModeSelect.value === 'VORTEX' ? 'VORTEX' : 'MANUAL';
        const saved = await saveSettings({downloadMode: next}, downloadsStatus);
        if (!saved) {
            downloadModeSelect.value = committedDownloadMode;
            return;
        }
        committedDownloadMode = next;
        setStatus(downloadsStatus, next === 'VORTEX'
            ? t('popup_downloadModeVortexSaved')
            : t('popup_downloadModeManualSaved'));
    });

    /**
     * Every write re-filters every open Nexus tab, so writing per keystroke
     * makes a listing flicker through a different hidden set for each letter.
     */
    exclusionInput.addEventListener('input', () => {
        if (exclusionWriteTimer !== null) clearTimeout(exclusionWriteTimer);
        exclusionWriteTimer = window.setTimeout(() => {
            exclusionWriteTimer = null;
            saveSettings({exclusionPhrases: exclusionInput.value}, statusLabel);
        }, EXCLUSION_DEBOUNCE_MS);
    });

    exclusionInput.addEventListener('blur', flushExclusions);

    function flushExclusions(): void {
        if (exclusionWriteTimer === null) return;
        clearTimeout(exclusionWriteTimer);
        exclusionWriteTimer = null;
        saveSettings({exclusionPhrases: exclusionInput.value}, statusLabel);
    }

    enabledToggle.addEventListener('change', async () => {
        const isEnabled = enabledToggle.checked;
        shell.classList.toggle('extension-disabled', !isEnabled);
        const saved = await saveSettings({extensionEnabled: isEnabled}, statusLabel);
        if (!saved) {
            enabledToggle.checked = !isEnabled;
            shell.classList.toggle('extension-disabled', isEnabled);
        }
    });

    debugLoggingToggle.addEventListener('change', async () => {
        const saved = await saveSettings({nmaDebug: debugLoggingToggle.checked}, advancedStatus);
        if (!saved) {
            debugLoggingToggle.checked = !debugLoggingToggle.checked;
            return;
        }
        // The worker reads this once at start-up, so an idle worker is already
        // going to restart and a busy one will not change mid-flight.
        advancedStatus.classList.remove('error');
        advancedStatus.textContent = debugLoggingToggle.checked
            ? t('popup_verboseLoggingOn')
            : t('popup_verboseLoggingOff');
    });

    browseBtn.addEventListener('click', async () => {
        setStatus(statusLabel, '');
        if (!selectedGame) {
            gameSearchInput.classList.add('input-error');
            setStatus(statusLabel, t('popup_chooseGameBeforeContinuing'), true);
            gameSearchInput.focus();
            return;
        }

        // A start version is filled in from the harvest whenever one could be
        // derived, so an empty box means nothing public names a version for this
        // game. Browsing must still work: it is explained once, then it opens.
        if (!versionMinInput.value.trim()) {
            if (!browseWithoutTargetArmed) {
                browseWithoutTargetArmed = true;
                browseBtn.textContent = t('popup_openWithoutVersionTarget');
                setStatus(statusLabel, t('popup_noStartVersionWarning'), true);
                versionMinInput.focus();
                return;
            }
            setStatus(statusLabel, '');
        }

        // Opening the catalog on an inverted range would badge every mod on it
        // INCOMPATIBLE, and the popup closes before the explanation can be read.
        const min = versionMinInput.value.trim();
        const max = versionMaxInput.value.trim();
        if (invertedRange(min, max)) {
            reportInvertedRange(min, max);
            versionMaxInput.focus();
            return;
        }

        await commitTarget();

        const baseUrl = `https://www.nexusmods.com/games/${selectedGame.domain}/mods`;
        const params = new URLSearchParams({sort: 'updatedAt'});
        if (hideTranslationsCheckbox.checked) {
            params.append('excludedTag', 'Translation');
        }

        chrome.tabs.create({url: `${baseUrl}?${params.toString()}`});
        window.close();
    });

    // ── Advanced ─────────────────────────────────────────────────────

    clearCacheBtn.addEventListener('click', async () => {
        clearCacheBtn.disabled = true;
        advancedStatus.classList.remove('error');
        advancedStatus.textContent = t('popup_clearing');

        const purged = await purgeCachedResponses();

        try {
            await chrome.storage.local.remove(['gameListCache', 'gameListTimestamp']);
        } catch (_) { /* removal cannot exceed quota, but a failure here is not fatal */ }

        await loadGames(true);

        const freedKb = Math.round(purged.bytesFreed / 1024);
        clearCacheBtn.disabled = false;

        // "Could not check" and "checked and found nothing" are different answers.
        if (!purged.backgroundReached) {
            setStatus(advancedStatus, purged.localSweepFailed
                ? t('popup_clearCacheBothFailed')
                : t('popup_clearCacheBackgroundFailed'), true);
            return;
        }

        if (purged.localSweepFailed) {
            setStatus(advancedStatus, purged.removed === 1
                ? t('popup_clearCacheSteamFailedOne', [String(freedKb)])
                : t('popup_clearCacheSteamFailed', [String(purged.removed), String(freedKb)]), true);
            return;
        }

        advancedStatus.classList.remove('error');
        advancedStatus.textContent = purged.removed
            ? (purged.removed === 1
                ? t('popup_clearCacheDoneOne', [String(freedKb)])
                : t('popup_clearCacheDone', [String(purged.removed), String(freedKb)]))
            : t('popup_clearCacheNothing');
        setTimeout(() => { displayLastUpdated(); }, 4000);
    });

    /**
     * The mod response cache lives under nmaCache: keys the background owns, so
     * it clears those. The Steam version cache is written at the top level and
     * has no owner, so the popup enumerates it here.
     */
    async function purgeCachedResponses(): Promise<{removed: number; bytesFreed: number; backgroundReached: boolean; localSweepFailed: boolean}> {
        let removed = 0;
        let bytesFreed = 0;
        let backgroundReached = false;
        let localSweepFailed = false;

        try {
            const res = await chrome.runtime.sendMessage({type: 'PURGE_CACHE'});
            if (res?.ok && res.result) {
                backgroundReached = true;
                removed += res.result.removed || 0;
                bytesFreed += res.result.bytesFreed || 0;
            }
        } catch (_) { /* background asleep or unreachable; the local sweep below still runs */ }

        try {
            const steamKeys = (await storageKeys()).filter(key => key.startsWith(STEAM_VERSION_PREFIX));
            if (steamKeys.length) {
                const entries = await chrome.storage.local.get(steamKeys);
                for (const key of steamKeys) {
                    bytesFreed += key.length + JSON.stringify(entries[key] ?? '').length;
                }
                await chrome.storage.local.remove(steamKeys);
                removed += steamKeys.length;
            }
        } catch (_) {
            // "Swept and found nothing" and "could not sweep" are different
            // answers, and only the caller can say so without overstating.
            localSweepFailed = true;
        }

        return {removed, bytesFreed, backgroundReached, localSweepFailed};
    }

    async function storageKeys(): Promise<string[]> {
        const local = chrome.storage.local as unknown as {
            getKeys?: () => Promise<string[]>;
            get: (keys: null) => Promise<Record<string, unknown>>;
        };
        if (typeof local.getKeys === 'function') {
            return local.getKeys();
        }
        return Object.keys(await local.get(null));
    }

    async function displayLastUpdated(): Promise<void> {
        const {gameListTimestamp} = await chrome.storage.local.get(['gameListTimestamp']);
        advancedStatus.classList.remove('error');
        if (!gameListTimestamp) {
            advancedStatus.textContent = storedApiKey ? t('popup_noGameListCached') : '';
            return;
        }

        const diffMs = Date.now() - Number(gameListTimestamp);
        const diffMins = Math.floor(diffMs / 60000);
        const diffHours = Math.floor(diffMs / 3600000);
        const diffDays = Math.floor(diffMs / 86400000);

        let timeAgo: string;
        if (diffDays > 0) {
            timeAgo = t(diffDays === 1 ? 'popup_timeAgoDay' : 'popup_timeAgoDays', [String(diffDays)]);
        } else if (diffHours > 0) {
            timeAgo = t(diffHours === 1 ? 'popup_timeAgoHour' : 'popup_timeAgoHours', [String(diffHours)]);
        } else if (diffMins > 0) {
            timeAgo = t(diffMins === 1 ? 'popup_timeAgoMinute' : 'popup_timeAgoMinutes', [String(diffMins)]);
        } else {
            timeAgo = t('popup_timeAgoJustNow');
        }
        advancedStatus.textContent = t('popup_gameListCached', [timeAgo]);
    }

    // ── Background data ──────────────────────────────────────────────

    async function loadGames(forceRefresh: boolean = false): Promise<void> {
        if (!storedApiKey) {
            allGames = [];
            return;
        }

        const {gameListCache, gameListTimestamp} = await chrome.storage.local.get(['gameListCache', 'gameListTimestamp']);
        const oneWeek = 7 * 24 * 60 * 60 * 1000;
        const now = Date.now();

        if (!forceRefresh && Array.isArray(gameListCache) && gameListTimestamp && now - gameListTimestamp < oneWeek) {
            allGames = gameListCache;
            refreshGameNameFromCatalogue();
            await displayLastUpdated();
            return;
        }

        try {
            await pingBackground();
            const games = unwrap(await messageWithRetry({type: 'GET_GAMES'}));
            if (!Array.isArray(games)) {
                throw new Error(t('popup_unexpectedGameList'));
            }
            allGames = games;
            await saveSettings({gameListCache: allGames, gameListTimestamp: now}, statusLabel);

            const mapping: Record<string, number> = {};
            allGames.forEach(game => {
                if (game.domain_name && game.game_id) mapping[game.domain_name] = game.game_id;
            });
            await saveSettings({gameDomainToId: mapping}, statusLabel);

            refreshGameNameFromCatalogue();
            setStatus(statusLabel, allGames.length === 1
                ? t('popup_loadedTitlesOne')
                : t('popup_loadedTitles', [String(allGames.length)]));
            await displayLastUpdated();
        } catch (error) {
            setStatus(statusLabel, t('popup_gameListFailure', [failureText(error)]), true);
        }
    }

    function refreshGameNameFromCatalogue(): void {
        const match = selectedGame ? allGames.find(game => game.domain_name === selectedGame?.domain) : undefined;
        if (selectedGame && match && match.name !== selectedGame.name) {
            selectedGame = {name: match.name, domain: selectedGame.domain};
            gameSearchInput.value = match.name;
        }
        // Runs even with nothing selected: the suggested-tab row names its game
        // from the same catalog, and it is shown precisely when the tab's game
        // is not the selected one.
        updateSuggestedGameRow();
    }

    // ── Version harvest ──────────────────────────────────────────────

    /**
     * Asks the background to derive this game's versions from public sources.
     * Nothing is bundled and nothing is per title: the same request is made for
     * every game, and a game with no public version data returns an empty list,
     * which is a finding rather than a fault.
     *
     * GET_GAME_VERSIONS is the generic request. A background that predates it
     * answers "Unknown type", and the older Steam-only path is used instead so
     * this surface never goes dark while the two sides are out of step.
     */
    async function harvestVersions(force: boolean): Promise<void> {
        if (!selectedGame) return;
        const game = selectedGame;
        const token = ++harvestToken;

        harvestState = 'RUNNING';
        harvestNote = force ? t('popup_searchingAgain') : t('popup_searching');
        refreshVersionsBtn.disabled = true;
        renderVersionState();

        try {
            await pingBackground();
            const result = await requestVersions(game, force);
            if (token !== harvestToken) return;

            knownVersions = normalizeVersions(result);
            harvestState = knownVersions.length > 0 ? 'FOUND' : 'EMPTY';
            harvestNote = harvestSummary(result, knownVersions.length);
        } catch (error) {
            if (token !== harvestToken) return;
            knownVersions = [];
            harvestState = 'FAILED';
            harvestNote = t('popup_versionSearchFailure', [failureText(error)]);
        } finally {
            if (token === harvestToken) refreshVersionsBtn.disabled = false;
        }

        if (token !== harvestToken) return;

        renderVersionState();
        if (document.activeElement === versionMinInput || document.activeElement === versionMaxInput) {
            updateVersionSuggestions((document.activeElement as HTMLInputElement).value);
        }
        await prefillVersionFromKnown();
    }

    async function requestVersions(game: SelectedGame, force: boolean): Promise<any> {
        try {
            return unwrap(await messageWithRetry({
                type: 'GET_GAME_VERSIONS',
                gameDomain: game.domain,
                name: game.name,
                force
            }));
        } catch (error) {
            if (!isUnknownMessageType(error)) throw error;
        }
        return legacySteamVersions(game, force);
    }

    /** The pre-harvest path, kept so an older background still fills the list. */
    async function legacySteamVersions(game: SelectedGame, force: boolean): Promise<any> {
        let appId = steamAppIdByDomain[game.domain];
        if (!appId) {
            const res = unwrap(await messageWithRetry({type: 'RESOLVE_STEAM_APP', name: game.name}));
            appId = res?.appId ? String(res.appId) : '';
            if (!appId) return {versions: []};
            steamAppIdByDomain[game.domain] = appId;
            await saveSettings({steamAppIdByDomain}, versionStatus);
        }
        return unwrap(await messageWithRetry({type: 'GET_STEAM_VERSIONS', appId, gameDomain: game.domain, force}));
    }

    function isUnknownMessageType(error: unknown): boolean {
        return /unknown type/i.test(errorText(error));
    }

    /**
     * Accepts either a plain list of labels or a list of records carrying their
     * sources, so the popup renders whatever detail the background has without
     * requiring it. Order is the background's: it is the only side that knows
     * which line is still being updated.
     */
    function normalizeVersions(result: any): DerivedVersion[] {
        const raw = Array.isArray(result?.versions) ? result.versions
            : Array.isArray(result?.entries) ? result.entries
                : Array.isArray(result) ? result : [];

        const byLabel = new Map<string, DerivedVersion>();

        const add = (value: unknown, fallbackSource: string): void => {
            const record = (value && typeof value === 'object') ? value as Record<string, unknown> : null;
            const label = String(record ? (record.version ?? record.label ?? record.value ?? '') : value).trim();
            if (!label) return;

            const declared = record ? (record.sources ?? record.source ?? record.origin) : null;
            const sources = (Array.isArray(declared) ? declared : declared ? [declared] : [])
                .map(code => String(code).trim().toUpperCase())
                .filter(Boolean);
            const count = Number(record?.corroboration ?? record?.count ?? 0);

            const existing = byLabel.get(label);
            if (existing) {
                sources.forEach(code => { if (!existing.sources.includes(code)) existing.sources.push(code); });
                existing.corroboration = Math.max(existing.corroboration, Number.isFinite(count) ? count : 0);
                return;
            }

            byLabel.set(label, {
                label,
                sources: sources.length ? sources : (fallbackSource ? [fallbackSource] : []),
                corroboration: Number.isFinite(count) && count > 0 ? count : 0
            });
        };

        raw.forEach((value: unknown) => add(value, ''));
        // The older shape kept article-body numbers in a separate list. They are
        // still shown, labeled as unverified, rather than dropped or promoted.
        if (Array.isArray(result?.unverified)) {
            result.unverified.forEach((value: unknown) => add(value, 'NEWS'));
        }

        return Array.from(byLabel.values());
    }

    /** A catalog cannot pluralize, so each count picks the sentence it fits. */
    function derivedText(count: number, sourceCount: number): string {
        if (sourceCount === 0) {
            return t(count === 1 ? 'popup_derivedOneVersion' : 'popup_derivedManyVersions', [String(count)]);
        }
        const substitutions: string[] = [String(count), String(sourceCount)];
        if (count === 1) {
            return sourceCount === 1
                ? t('popup_derivedOneVersionOneSource', substitutions)
                : t('popup_derivedOneVersionManySources', substitutions);
        }
        return sourceCount === 1
            ? t('popup_derivedManyVersionsOneSource', substitutions)
            : t('popup_derivedManyVersionsManySources', substitutions);
    }

    /**
     * The sentence under the list. It says how many versions were derived, from
     * how many sources, and how much the harvest cost, so a slow refresh is
     * explicable and an empty answer is never mistaken for a complete one.
     */
    function harvestSummary(result: any, count: number): string {
        const parts: string[] = [];

        if (count > 0) {
            const sources = new Set<string>();
            knownVersions.forEach(entry => entry.sources.forEach(code => sources.add(code)));
            parts.push(derivedText(count, sources.size));
        } else {
            parts.push(t('popup_noVersionsSummary'));
        }

        const requests = Number(result?.requests);
        if (Number.isFinite(requests) && requests > 0) {
            parts.push(t(requests === 1 ? 'popup_oneRequestThisRefresh' : 'popup_requestsThisRefresh', [String(requests)]));
        }

        // A refused store binding is the difference between "this publisher
        // states nothing" and "another game's numbers were nearly shown here".
        if (result?.storeBound === false || result?.appIdBound === false) {
            parts.push(t('popup_storeNotBound'));
        }

        if (typeof result?.note === 'string' && result.note.trim()) parts.push(result.note.trim());

        return parts.join(' ');
    }

    // ── SSO ──────────────────────────────────────────────────────────

    authorizeSsoBtn.addEventListener('click', startSsoFlow);

    async function syncSsoButtonWithBackground(): Promise<void> {
        try {
            const status = await chrome.runtime.sendMessage({type: 'GET_SSO_STATUS'});
            if (status?.phase === 'WAITING_FOR_APPROVAL' || status?.phase === 'CONNECTING') {
                showCancelSso();
                setSsoStatus(status.message);
            }
        } catch (_) { /* the background wakes on the first real request */ }
    }

    function setSsoStatus(message: string, isError: boolean = false): void {
        ssoStatusLabel.textContent = message;
        ssoStatusLabel.classList.toggle('error', isError);
    }

    function showCancelSso(): void {
        authorizeSsoBtn.textContent = t('popup_cancelSso');
        authorizeSsoBtn.removeEventListener('click', startSsoFlow);
        authorizeSsoBtn.addEventListener('click', cancelSsoFlow);
    }

    function startSsoFlow(): void {
        showCancelSso();
        setSsoStatus(t('popup_startingSso'));
        chrome.runtime.sendMessage({type: 'START_SSO'}).catch(() => {
            setSsoStatus(FAILURE_TEXT.NO_BACKGROUND, true);
            resetSsoButton();
        });
    }

    function cancelSsoFlow(): void {
        chrome.runtime.sendMessage({type: 'CANCEL_SSO'}).catch(() => { /* nothing to cancel if it is asleep */ });
        resetSsoButton();
        setSsoStatus(t('popup_ssoCanceled'));
    }

    function resetSsoButton(): void {
        authorizeSsoBtn.textContent = t('popup_authorizeSso');
        authorizeSsoBtn.disabled = false;
        authorizeSsoBtn.removeEventListener('click', cancelSsoFlow);
        authorizeSsoBtn.addEventListener('click', startSsoFlow);
    }

    chrome.runtime.onMessage.addListener((msg: any) => {
        if (msg?.type === 'SSO_STATUS_UPDATED' && msg.status) {
            setSsoStatus(msg.status.message, msg.status.isError);
            if (msg.status.phase === 'COMPLETE' || msg.status.phase === 'ERROR' || msg.status.phase === 'IDLE') {
                resetSsoButton();
            }
        }
    });

    // A second popup, an SSO completion or the background itself can change the
    // key underneath this view.
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;

        if (changes.nexusApiKey) {
            const next = (changes.nexusApiKey.newValue as string) || '';
            if (next !== storedApiKey) {
                storedApiKey = next;
                editingKey = false;
                renderConnection();
                if (next) {
                    setStatus(connectionStatus, t('popup_keyUpdated'));
                    loadGames(true);
                }
            }
        }

        if (changes.extensionEnabled) {
            const isEnabled = changes.extensionEnabled.newValue !== false;
            enabledToggle.checked = isEnabled;
            shell.classList.toggle('extension-disabled', !isEnabled);
        }

        // The on-page panel owns these same keys from the other side, and only a
        // differing value is assigned so the two surfaces cannot echo each other.
        // The text box is left alone entirely while it is being edited or has an
        // unwritten edit pending: the incoming value is older than what is typed.
        if (changes.exclusionPhrases && exclusionWriteTimer === null && document.activeElement !== exclusionInput) {
            const next = (changes.exclusionPhrases.newValue as string) || '';
            if (next !== exclusionInput.value) exclusionInput.value = next;
        }

        if (changes.showOldFiles) {
            const next = changes.showOldFiles.newValue === true;
            if (next !== showOldFilesToggle.checked) showOldFilesToggle.checked = next;
        }

        syncDefaultOnToggle(changes.showUpdateFiles, showUpdateFilesToggle);
        syncDefaultOnToggle(changes.showOptionalFiles, showOptionalFilesToggle);
        syncDefaultOnToggle(changes.showMiscFiles, showMiscFilesToggle);

        if (changes.downloadMode) {
            const next = changes.downloadMode.newValue === 'VORTEX' ? 'VORTEX' : 'MANUAL';
            committedDownloadMode = next;
            if (next !== downloadModeSelect.value) downloadModeSelect.value = next;
        }

        if (changes.hideTranslations) {
            const next = changes.hideTranslations.newValue !== false;
            if (next !== hideTranslationsCheckbox.checked) hideTranslationsCheckbox.checked = next;
        }
    });

    /** The three file categories the content script shows unless told otherwise. */
    function syncDefaultOnToggle(change: chrome.storage.StorageChange | undefined, toggle: HTMLInputElement): void {
        if (!change) return;
        const next = change.newValue !== false;
        if (next !== toggle.checked) toggle.checked = next;
    }

    // ── Messaging and failure reporting ──────────────────────────────

    function isReceivingEndError(err: unknown): boolean {
        const message = errorText(err);
        return message.includes('Receiving end does not exist') || message.includes('Could not establish connection');
    }

    async function pingBackground(timeoutMs: number = 800): Promise<boolean> {
        try {
            const res = await Promise.race([
                chrome.runtime.sendMessage({type: 'PING'}),
                new Promise<never>((_, reject) => setTimeout(() => reject(new Error('PING timeout')), timeoutMs))
            ]);
            return !!res;
        } catch (_) {
            return false;
        }
    }

    async function messageWithRetry(message: Record<string, unknown>, tries: number = 4, delayMs: number = 200): Promise<any> {
        let lastErr: unknown = null;
        for (let attempt = 0; attempt < tries; attempt++) {
            try {
                return await withTimeout(chrome.runtime.sendMessage(message), 20000);
            } catch (err) {
                lastErr = err;
                if (!isReceivingEndError(err) || attempt === tries - 1) {
                    throw err;
                }
                await new Promise(resolve => setTimeout(resolve, delayMs * Math.pow(2, attempt)));
                await pingBackground();
            }
        }
        throw lastErr || new Error('Unknown messaging error');
    }

    function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
        return Promise.race([
            promise,
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Request timed out')), timeoutMs))
        ]);
    }

    /**
     * The background answers errors in-band as {ok:false, error, failure:{code,
     * message, status}}, so they have to be re-thrown to be classified. Its
     * top-level `status` is the literal string 'FAILED', never an HTTP code:
     * the numeric one lives on `failure.status`.
     */
    function unwrap(response: any): any {
        if (response && typeof response === 'object' && !Array.isArray(response) && (response.error || response.ok === false)) {
            const failure = response.failure && typeof response.failure === 'object' ? response.failure : null;
            const error = new Error(failure?.message || response.error || t('popup_requestFailed')) as Error & {
                failureReason?: string;
                status?: number;
            };
            error.failureReason = failure?.code || response.failureReason || response.code || response.reason;
            const status = Number(failure?.status ?? response.status);
            if (Number.isFinite(status) && status > 0) error.status = status;
            throw error;
        }
        return response;
    }

    function errorText(err: unknown): string {
        if (!err) return '';
        if (typeof err === 'string') return err;
        return (err as Error).message || String(err);
    }

    /**
     * Consumes the background's machine-readable failure reason when one is
     * present, and falls back to the status code or the message text when it is
     * not. "Could not check" and "checked and found nothing" must not collapse
     * into the same sentence.
     */
    function failureText(err: unknown): string {
        const code = failureCode(err);
        if (code && FAILURE_TEXT[code]) return FAILURE_TEXT[code];
        const raw = errorText(err);
        if (!raw) return t('popup_unexpectedFailureNoDetail');
        // A classified failure already carries a sentence written for the user,
        // so labeling it "unexpected" would be the overstatement.
        if ((err as {failureReason?: string})?.failureReason) return raw;
        return t('popup_unexpectedFailure', [raw]);
    }

    async function refreshHostPermissionState(): Promise<void> {
        const api = (chrome as unknown as {
            permissions?: {contains?: (query: {origins: string[]}) => Promise<boolean>};
        }).permissions;
        if (!api?.contains) return;
        try {
            hostPermissionsGranted = await api.contains({origins: REQUIRED_HOST_ORIGINS});
        } catch (_) { /* keep the last known answer rather than guessing a new one */ }
    }

    // A mid-session revoke would otherwise leave this popup reporting a network
    // fault for the rest of its life.
    chrome.permissions?.onRemoved?.addListener(() => { refreshHostPermissionState(); });
    chrome.permissions?.onAdded?.addListener(() => { refreshHostPermissionState(); });

    /**
     * A refused host permission arrives as the same fetch rejection as a dead
     * network. Reporting it as OFFLINE sends the user to check a router that is
     * working, so the two are told apart before the sentence is chosen.
     */
    function offlineOrPermission(code: string): string {
        if (code !== 'OFFLINE') return code;
        return hostPermissionsGranted ? 'OFFLINE' : 'HOST_PERMISSION_MISSING';
    }

    function failureCode(err: unknown): string {
        const declared = String((err as {failureReason?: string})?.failureReason || '').toUpperCase();
        if (declared && FAILURE_TEXT[declared]) return offlineOrPermission(declared);

        const status = statusCodeOf(err, declared);
        if (status === 401) return 'INVALID_KEY';
        if (status === 403) return 'FORBIDDEN';
        if (status === 404) return 'NOT_FOUND';
        if (status === 429) return 'RATE_LIMITED';
        if (status && status >= 500) return 'SERVER_ERROR';

        const raw = errorText(err);
        if (/api key not found|configure an api key/i.test(raw)) return 'NO_API_KEY';
        if (/extension is disabled/i.test(raw)) return 'DISABLED';
        if (navigator.onLine === false) return 'OFFLINE';
        if (/failed to fetch|networkerror/i.test(raw)) return offlineOrPermission('OFFLINE');
        if (/timed out|timeout/i.test(raw)) return 'TIMEOUT';
        if (isReceivingEndError(err)) return 'NO_BACKGROUND';
        return '';
    }

    function statusCodeOf(err: unknown, declared: string): number {
        const direct = Number((err as {status?: number})?.status);
        if (Number.isFinite(direct) && direct > 0) return direct;

        const fromDeclared = declared.match(/(\d{3})/);
        if (fromDeclared) return Number(fromDeclared[1]);

        // Only a number the message presents as a status is read as one. A bare
        // three-digit number in prose ("Timed out after 500 ms", "Loaded 429
        // titles") is prose, and reading it as a status turns "could not ask"
        // into a claim about your key or about Nexus. The form the background
        // emits when it has a code and no classification, "(HTTP 503)", carries
        // the cue; a classified failure never reaches here at all.
        const fromMessage = errorText(err).match(/(?:HTTP|status(?:\s+code)?)[\s:=]*(\d{3})\b/i);
        return fromMessage ? Number(fromMessage[1]) : 0;
    }

    function setStatus(element: HTMLElement, message: string, isError: boolean = false): void {
        element.textContent = message;
        element.classList.toggle('error', isError && !!message);
    }

    /** Opened as a tab by the background's openPopup fallback rather than as the action popup. */
    async function markStandaloneWindow(): Promise<void> {
        try {
            const current = await chrome.tabs.getCurrent();
            if (current) document.body.classList.add('standalone');
        } catch (_) { /* running as the action popup */ }
    }
});
