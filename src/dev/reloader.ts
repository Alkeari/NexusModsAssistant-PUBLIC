declare const __NMA_DEV_PORT__: number;

const NMA_DEV_RELOAD = "NMA_DEV_RELOAD";
const ENDPOINT = "http://127.0.0.1:" + __NMA_DEV_PORT__ + "/build-id";
const ALARM_NAME = "nma-dev-reload";
const STATE_KEY = "nmaDevBuildId";
const POLL_MS = 2000;
const TAB_MATCH = "https://www.nexusmods.com/games/*/mods*";

function isDevelopmentBuild(): boolean {
    const versionName = chrome.runtime.getManifest().version_name;
    return typeof versionName === "string" && versionName.endsWith("-dev");
}

async function checkForNewBuild(): Promise<void> {
    let buildId: string;
    try {
        const res = await fetch(ENDPOINT, { cache: "no-store", signal: AbortSignal.timeout(2000) });
        if (!res.ok) {
            return;
        }
        buildId = (await res.text()).trim();
    } catch {
        return;
    }
    if (!buildId) {
        return;
    }

    const stored = await chrome.storage.session.get(STATE_KEY);
    const known = stored[STATE_KEY] as string | undefined;

    if (!known) {
        await chrome.storage.session.set({ [STATE_KEY]: buildId });
        return;
    }
    if (known === buildId) {
        return;
    }

    console.log(NMA_DEV_RELOAD, "build", known, "->", buildId);
    await chrome.storage.session.set({ [STATE_KEY]: buildId });
    const tabs = await chrome.tabs.query({ url: TAB_MATCH });
    // Tabs must be reloaded first: runtime.reload() tears the worker down immediately
    // and any pending tab reloads are lost.
    await Promise.all(tabs.map((tab) => (tab.id ? chrome.tabs.reload(tab.id) : Promise.resolve())));
    chrome.runtime.reload();
}

if (isDevelopmentBuild()) {
    // Two pollers on purpose: the interval gives a 2 second edit-to-reload loop while the
    // worker is awake, the alarm is the only thing that can wake it once it is not.
    setInterval(() => {
        void checkForNewBuild();
    }, POLL_MS);
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: 0.05 });
    chrome.alarms.onAlarm.addListener((alarm) => {
        if (alarm.name === ALARM_NAME) {
            void checkForNewBuild();
        }
    });
    void checkForNewBuild();
}
