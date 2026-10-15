# Nexus Mods Assistant

Every mod tile on Nexus Mods gets a compatibility verdict for the game version you actually play, so you can filter a catalog page down to what will run and download the survivors in one pass instead of one tab at a time.

> **Chrome, Edge and other Chromium browsers, and Firefox 140 or later.**

---

## Availability

- [Nexus Mods](https://www.nexusmods.com/site/mods/1588)
- [Chrome Web Store](https://chromewebstore.google.com/detail/hflkcljgifgjdlpgibmldlpkpjhjdddf)
- [Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/nexus-mods-assistant/)

## What It Does

- **A compatibility verdict on every mod tile** - and on a mod's own page, beside the title and as a column in its requirements table, each requirement checked on its own.
  - **Six verdicts** Compatible, Likely compatible, Incompatible, No version info, Couldn't check, and Not set up.
  - **The evidence, in the tooltip** what the verdict matched on, and whether the match was exact or inferred.
  - **Worked out, not looked up** Nexus publishes no supported-version field, so it reads the mod's version, summary, description, changelogs, file names and upload dates.
- **Filter the grid down to what will run** - a toggle per verdict hides the rest. "Not set up" has no toggle on purpose: a tile the extension has not judged is never hidden by a filter.
- **And filter it by everything else** - a keyword exclusion box, a Last Updated range, file category toggles, pagination, refresh and a download mode selector. Keywords, dates and collapsed state persist.
- **A file list per mod without leaving the page** - grouped by Main, Update, Optional, Miscellaneous and Old, each entry showing version, size and upload date. Your selection survives a reload.
- **Bulk download** - take the mods you ticked, or every tile left after filtering. The button becomes Stop mid-run, though files already started finish.
- **Requirements handled before the download, not after it** - a mod's requirements are shown with their own verdicts, and you install with them, without them, or skip the mod.
- **Two download modes** - Manual resolves a direct link through the Nexus API or your logged-in session and hands it to the browser. Vortex emits an `nxm://` link for whatever mod manager registered it.
- **Game version lists are derived, never shipped** - built at run time from the publisher's Steam patch notes and branches, SteamCMD, and the versions authors and collections state on Nexus itself.
- **Nothing phones home** - no telemetry, no analytics, no server of the author's. It talks to Nexus Mods and to Steam's public endpoints, with your own key or session, and to nothing else.

---

## Requirements

- Chrome, Edge or another Chromium browser, or Firefox 140 or later.
- A Nexus Mods account, to generate a key and to download anything.
- A Nexus Mods Personal API Key, optional: it is what unlocks the verdicts, file lists, requirement lookups and downloads.
- Vortex or Mod Organizer 2, optional, and only if you use the Vortex download mode.

Without a key you can still enable the extension, set a target game and version, use the filter bar, and target the game whose page you already have open. On Firefox the add-on declares that it handles sign-in data, meaning your API key, which Firefox shows you at install.

## Installation

1. Open the extension, set your target game and its version range, and add your Nexus API key if you have one.
2. Open any Nexus Mods game's mods page. The filter bar appears above the grid and every tile gets a verdict.

## Configuration

Everything lives in the popup. There is no separate options page and no keyboard shortcuts, and a change applies the next time a mods page renders.

- **Power toggle** in the header switches the whole extension off: no bars, no badges, no requests.
- **Target game and version range**, with an optional end version, plus a one-click suggestion from the page you have open.
- **Nexus API key**: paste one or press Authorize SSO, then Reveal, Replace or Disconnect it.
- **Download mode**, Manual or Vortex, kept in step with the on-page selector.
- **File list toggles** for Old, Update, Optional and Miscellaneous, also kept in step with the on-page panel.
- **Exclude mods containing**, the same keyword list as the on-page box, and **Exclude translations**, which adds Nexus's own translation filter when you open a listing.
- **Refresh versions** re-fetches build numbers for the selected game and ignores the cache.
- **Verbose console logging**, off by default, and **Clear cached Nexus data**, which purges the stored game list and cached responses.

## Compatibility

- **Where it runs.** Only on `nexusmods.com/games/<game>/mods` pages: the catalog listing and an individual mod's own page.
- **Every game, no allowlist.** A game with no publicly stated version anywhere gets no derived list, and the extension says so rather than inventing one.
- **What it talks to.** Nexus Mods, meaning its API, its website and its sign-on service, and Steam's public store, news and SteamCMD endpoints. Nothing else.
- **Vortex mode needs a mod manager.** Vortex or Mod Organizer 2 must already be registered for `nxm://` links, or the link goes nowhere.
- **Free accounts still work.** Nexus limits API-generated download links to Premium members. Without one the extension falls back to the mod's own download page, and tells you when that fails.
- **Upgrading from 2.x.** Your target game, version range and date filter carry over the first time the popup opens.
- Not affiliated with, endorsed by, or connected to Nexus Mods, Valve, or any game publisher.

## Support

- Include the version from the popup header, your browser and its version, the exact page URL, and what you expected against what happened.

A layout report is far more useful with the URL: Nexus serves different markup to different pages and accounts.

## License

License terms are in the [Alkeari License Agreement](https://gist.github.com/Alkeari/2c6ec0cdf3dafee375b1a00b28ca190a).
