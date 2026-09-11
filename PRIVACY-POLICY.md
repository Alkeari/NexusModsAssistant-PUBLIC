# Privacy Policy

Effective date: 2026-08-13

Applies to: Nexus Mods Assistant 3.2.9 and later, on Chrome and Firefox.

## Who we are

"Nexus Mods Assistant" is a browser extension that annotates Nexus Mods listing
pages with compatibility assessments, filters results, and starts mod downloads.
It runs entirely in your browser. It is published by Alkeari Labs LLC.

## Summary

- There is no Alkeari server. Nothing is sent to us, because there is nowhere to
  send it.
- There is no telemetry, no analytics, no crash reporting, and no advertising or
  tracking code of any kind.
- Nothing is sold, shared, or transferred to a third party for their own
  purposes.
- Your Nexus Mods API key is stored in `chrome.storage.local` on your machine and
  is sent to exactly one place: `https://api.nexusmods.com`.
- The extension also caches the Nexus API's replies on your machine, so it does
  not ask the same question twice. That cache is public mod metadata, it is
  size-limited, it expires, and you can erase it from the popup.
- Everything the extension stores can be erased by removing the extension.

## The API key

The API key is optional. Browsing, filtering, choosing a target game and reading
the game version list all work without one, because those read public data that
Nexus serves unauthenticated. A key is what unlocks per-mod compatibility checks,
file lists and downloads. You supply it. You can either paste one you generated at
`https://next.nexusmods.com/settings/api-keys`, or authorize the extension
through Nexus Mods Single Sign-On, which hands the key back over
`wss://sso.nexusmods.com`.

- The key is stored under the `nexusApiKey` entry in `chrome.storage.local`.
- It is sent only as the `apikey` request header to `https://api.nexusmods.com/v1`,
  which is the API it authenticates. The extension also reads public game and
  version data from `https://api.nexusmods.com/v2/graphql`, and those requests
  carry no key and identify nobody.
- The background service worker reads it to make those requests. The popup also
  reads it back, so it can show you that a key is stored. It is displayed masked,
  and revealed in full only while you hold the **Show** button state on.
- You can remove it at any time with **Disconnect** in the popup, which erases
  the key and every cached Nexus response from this browser in one action.
- It is never written into page content, never sent to any site's DOM, never
  logged to a remote service, and never included in any request to Steam or to
  any other host.
- During Single Sign-On, a randomly generated connection UUID and the returned
  connection token are held in `chrome.storage.session`, which the browser clears
  when the browsing session ends. They are removed as soon as the handshake
  completes or is cancelled.

Revoke the key at any time from your Nexus Mods account settings. Removing the
extension erases the extension's copy along with everything else it stored.

## What is stored on your device

All of this lives in `chrome.storage.local` unless noted. None of it leaves your
machine except as described under "Who we talk to".

### Your credentials

| Data | Purpose |
|---|---|
| `nexusApiKey` | Authenticates requests to the Nexus Mods API |
| `nma_sso_uuid`, `nma_sso_token` (session storage) | The in-progress Single Sign-On handshake |

### Your settings

| Data | Purpose |
|---|---|
| `targetGameDomain`, `targetVersion`, `targetVersionEnd` | The game and game-version range you are checking mods against |
| `lastSelectedGame` | The last game you picked, so the popup reopens where you left it |
| `lastVersion`, `lastVersionEnd` | A second copy of the version range. Version 2.x wrote only these; on first run of 3.x their values are migrated into the target keys above and the two entries are deleted. The in-page setup dialog still writes them alongside the target keys, so they can reappear after that migration |
| `extensionEnabled` | Whether the extension is switched on |
| `panelCollapsed` | Whether you collapsed the on-page filter bar |
| `exclusionPhrases` | Your comma-separated list of keywords to hide mods by name |
| `hideTranslations` | Whether to exclude translation mods when opening a listing |
| `showOldFiles`, `showUpdateFiles`, `showOptionalFiles`, `showMiscFiles` | Which file categories to show in file lists |
| `lastUpdatedStart`, `lastUpdatedEnd` | Your Last Updated date-range filter |
| `lastUpdatedDays` | A legacy version of the same filter, migrated to the range above and then zeroed |
| `downloadMode` | Whether downloads go to your browser or to your mod manager |
| `nmaDebug` | Whether verbose console logging is enabled |
| `schemaVersion` | Which layout this stored data uses, so a future version can migrate it |

### Caches

Every entry here is public information already visible on nexusmods.com or Steam.
None of it identifies you. All of it is disposable, and "Clear cached Nexus data"
in the popup's Advanced settings erases the lot. If a key is connected, that
button then asks Nexus for the list of games again straight away, so
`gameListCache` refills immediately; nothing else is re-fetched until you browse.

| Data | Purpose |
|---|---|
| `nmaCache:<endpoint>` | Cached Nexus Mods API replies, one per endpoint: mod details, file lists, changelogs, and parsed requirement lists for mods you have browsed. Expires after 12 hours, swept at most once an hour while the extension is awake, and capped at 4 MB with oldest-first eviction |
| `nmaAux:<key>` | Small, long-lived lookups that are not Nexus mod data: Steam build lists (`nmaAux:steamVersions:<appId>`) and the game versions learned while browsing (`nmaAux:knownVersions:<domain>`). Expires after 30 days, capped at 256 KB and 64 entries |
| `gameListCache`, `gameListTimestamp` | The list of games Nexus supports, and when it was fetched. Refreshed weekly |
| `gameDomainToId` | Maps a Nexus game domain to its numeric Nexus game id |
| `steamAppIdByDomain` | Maps a Nexus game domain to a Steam app ID so game versions can be looked up |
| `steamVersions:<appId>` | The same game version history, written at the top level by installs older than 3.1.0. The first time 3.1.0 or later reads one it is moved into `nmaAux:`, or deleted outright if it has already expired, and any left over are erased by "Clear cached Nexus data" |

There is no account, no profile, and no identifier that follows you between
installs. Nothing here is personal data beyond the API key, which identifies your
Nexus Mods account to Nexus Mods, who issued it.

## Who we talk to

The extension makes requests to these hosts and no others. Every one of them
except the Single Sign-On socket is declared in the manifest as a host
permission, so the full list is visible before you install.

| Host | What is sent | Why |
|---|---|---|
| `https://api.nexusmods.com` | Your API key, plus the game domain and mod IDs on the page you are viewing | Mod details, file lists, changelogs, download links, and the list of Nexus games |
| `https://www.nexusmods.com` | Ordinary page requests for a mod's page and its download dialog, using the cookies your browser already has for the site | Reading a mod's requirements table, reading version metadata a mod page publishes, and obtaining the single-use download link a non-Premium account needs |
| `wss://sso.nexusmods.com` | A randomly generated connection UUID and the extension's application slug | Optional Single Sign-On, only when you start it |
| `https://api.steampowered.com` | A Steam app ID | Public game news feed, used to derive game version history |
| `https://store.steampowered.com` | A game name | Public store search, used to find the Steam app ID for a game |
| `https://api.steamcmd.net` | A Steam app ID | Public build and version metadata for that game |

The requests to `www.nexusmods.com` carry your existing nexusmods.com cookies,
exactly as a normal page load in the same browser would, because Nexus only
serves a download link to a logged-in session. The extension does not read,
store, or transmit those cookies. It never sends them anywhere except back to
nexusmods.com.

The Steam requests carry no credentials and no identifier for you. They contain a
game name or a numeric app ID, nothing else.

There is no other network activity. No file is fetched from any content delivery
network, no font or script is loaded from a third party, and no code is
downloaded and executed at runtime.

## Page access

The content script runs only on `https://www.nexusmods.com/games/*/mods*`, which
covers a game's mod listing and the individual mod pages under it. It reads mod
IDs, mod names, listing metadata and, on a mod's own page, the requirements
table, in order to draw compatibility badges and apply your filters. It does not
transmit page content anywhere, and it does not run on any other site.

The extension does not read, modify or transmit anything you type into
nexusmods.com, and it does not touch your Nexus Mods account settings.

### What the popup reads about your tabs

Every time you open the popup, it looks at the address of your active tab. If
that is not a Nexus Mods game page, it then asks the browser for your open
`https://www.nexusmods.com/*` tabs and looks at their addresses too. It stops at
the first one that names a game.

All it keeps is the game slug from that address, for example
`skyrimspecialedition`, and it keeps it only in the popup's memory for as long as
the popup is open, so it can offer you "Use this game". The addresses themselves
are discarded within that one call, and an address that is not a nexusmods.com
game page is discarded without being used at all. Page titles and the rest of
each tab's record are never read. Nothing here is stored, and nothing here is
transmitted anywhere.

Opening the popup counts as invoking the extension, which is what grants the
`activeTab` permission, so the address of the tab you are looking at is readable
whatever site it is on. Whatever it is, it is read once, checked for a
nexusmods.com game page, and dropped. For your other tabs the browser withholds
the address unless the extension already holds permission for that site, which
here means only `www.nexusmods.com`.

## Downloads

When you start a download in Manual mode, the extension calls
`chrome.downloads.download` with a link obtained from the Nexus Mods API. The
file goes to your normal download location.

When you start a download in Vortex mode, the extension opens an `nxm://` link,
which your operating system passes to whichever mod manager registered that
protocol. Nothing is sent to us and nothing is sent to any third party; the link
identifies a Nexus game, mod and file.

The extension does not read your download history and does not touch files you
downloaded by other means.

## Permissions and why each exists

| Permission | Why |
|---|---|
| `storage` | Hold your API key, preferences, and caches locally, including the session storage used during Single Sign-On |
| `downloads` | Start a mod download when you click one |
| `scripting` | Declared so the popup can scroll to and highlight the Personal API Key section of the Nexus Mods API settings page it opens for you. That page is served from `next.nexusmods.com`, which is deliberately **not** in the host permission list below, so the browser refuses the injection and no script is placed on any page. What actually moves the page is the browser's own text-fragment link. The permission grants no access on its own |
| `activeTab` | Declared alongside `scripting`, and granted by the browser when you open the popup. It is why the popup can read the address of the tab you are looking at whatever site it is on, as described under Page access. No feature depends on it: an address that is not a nexusmods.com game page is dropped |
| `alarms` | Wake the background worker periodically to sweep expired cache entries and to keep in-flight work alive |
| Host permission: `api.nexusmods.com` | The Nexus Mods API |
| Host permission: `www.nexusmods.com` | The listing pages the extension annotates, and the mod pages it reads requirements and download links from |
| Host permission: `store.steampowered.com`, `api.steampowered.com`, `api.steamcmd.net` | Public game version lookups |

## Children

This extension is not directed at children and collects nothing that would
identify anyone.

## Third parties

Requests to Nexus Mods and to Steam are governed by their own privacy policies.
This policy covers only what this extension does.

- Nexus Mods: <https://help.nexusmods.com/article/18-privacy-policy>
- Valve / Steam: <https://store.steampowered.com/privacy_agreement/>

## Your choices

- Switch the extension off entirely with the power toggle in the popup. Off means
  no requests and no page changes.
- Erase every cache with **Clear cached Nexus data** in the popup's Advanced
  settings. It reports what it removed.
- Erase the stored key and every cached Nexus response together with
  **Disconnect** in the popup's Connection section.
- Revoke your API key at any time in your Nexus Mods account settings.
- Remove the extension. The browser erases everything it stored.

## Changes

Material changes to this policy will be noted in
[CHANGELOG.md](CHANGELOG.md) alongside the version that introduced them, and the
effective date at the top of this file will change.

## Contact

- GitHub: [Alkeari](https://github.com/Alkeari)
