# Changelog

What changed in Nexus Mods Assistant, newest first. Only changes you can actually notice are
listed. This file is the source for the release notes published on the Nexus Mods page and the
store listings.

## Unreleased

- Changed: Borders and washes on the injected panels use the palette's own translucent values, so a
  border no longer reads brighter than the one beside it.

## v3.4.0

### Nexus Mods Assistant
- Added: Version lists are now built automatically for any game on Nexus Mods, not just a handful. Nothing is shipped with the extension, so the list is worked out from public sources every time and is the same on any machine.
- Added: Versions are sorted newest at the top, oldest at the bottom, which is the way round it should have been.
- Added: Every compatibility verdict now says how confident it is and what it was based on. Hover a badge and it tells you which file, changelog or description it read.
- Added: A "likely compatible" verdict for when the evidence is real but inferred, so a guess no longer looks the same as a match.
- Added: A "not set up" state, so a fresh install no longer marks every mod as failed before you have configured anything.
- Added: The popup can show, replace or disconnect your stored API key, and clearing cached data reports how much it actually reclaimed.
- Added: Your file selections survive a page reload, and download mode is reachable from the popup.
- Added: The Update, Optional and Miscellaneous file toggles actually filter the file list now, which is what they always claimed to do.
- Changed: The API key is optional. Browsing, filtering, and setting a target game and version all work without one, and the popup says plainly what a key adds.
- Changed: A game with no version information available anywhere says so, rather than looking broken.
- Fixed: Badges are judged against the game you are looking at, not whichever game was last set in the popup.
- Fixed: A mod's own release number is no longer mistaken for a game version.
- Fixed: Build numbers that differ only by a leading zero, such as 2.01 and 2.1, are no longer treated as the same build.
- Fixed: The same build no longer appears twice under two spellings, and a version like v1.2.10 sorts above v1.2.9 instead of below it.
- Fixed: Saving your game and version no longer fails silently when browser storage is full, and the cache is bounded so it stops filling up in the first place.
- Fixed: Refreshing a page no longer leaves more than one control panel behind, and the panel can no longer vanish for the rest of the session.
- Fixed: A failed download tells you it failed instead of quietly doing nothing.
- Fixed: Turning the extension off actually stops it and puts the page back.
- Fixed: An invalid key, a rate limit, a server error and no connection now read differently instead of all saying the same thing.

## v3.4.0 - 2026-09-06

- Added: The extension speaks 21 languages besides English and follows the one your browser is set to: Czech, Danish, Dutch, Finnish, French, German, Hungarian, Italian, Japanese, Korean, Norwegian, Polish, Portuguese (Brazil and Portugal), Russian, Simplified and Traditional Chinese, Spanish, Swedish, Turkish and Ukrainian.
- Changed: Nexus's own file category names stay in English in every language, so they still match the headings on the page you are reading them beside.
- Fixed: Counts that could be one no longer read "Loaded 1 titles" or "Cleared 1 cached entries".
- Fixed: The amount of space freed is now shown when clearing a single cached entry, where it was blank.

## v3.3.0

### Nexus Mods Assistant
- Added: Version lists are now built automatically for any game on Nexus Mods, not just a handful. Nothing is shipped with the extension, so the list is worked out from public sources every time and is the same on any machine.
- Added: Versions are sorted newest at the top, oldest at the bottom, which is the way round it should have been.
- Added: Every compatibility verdict now says how confident it is and what it was based on. Hover a badge and it tells you which file, changelog or description it read.
- Added: A "likely compatible" verdict for when the evidence is real but inferred, so a guess no longer looks the same as a match.
- Added: A "not set up" state, so a fresh install no longer marks every mod as failed before you have configured anything.
- Added: The popup can show, replace or disconnect your stored API key, and clearing cached data reports how much it actually reclaimed.
- Added: Your file selections survive a page reload, and download mode is reachable from the popup.
- Added: The Update, Optional and Miscellaneous file toggles actually filter the file list now, which is what they always claimed to do.
- Changed: The API key is optional. Browsing, filtering, and setting a target game and version all work without one, and the popup says plainly what a key adds.
- Changed: A game with no version information available anywhere says so, rather than looking broken.
- Fixed: Badges are judged against the game you are looking at, not whichever game was last set in the popup.
- Fixed: A mod's own release number is no longer mistaken for a game version.
- Fixed: Build numbers that differ only by a leading zero, such as 2.01 and 2.1, are no longer treated as the same build.
- Fixed: The same build no longer appears twice under two spellings, and a version like v1.2.10 sorts above v1.2.9 instead of below it.
- Fixed: Saving your game and version no longer fails silently when browser storage is full, and the cache is bounded so it stops filling up in the first place.
- Fixed: Refreshing a page no longer leaves more than one control panel behind, and the panel can no longer vanish for the rest of the session.
- Fixed: A failed download tells you it failed instead of quietly doing nothing.
- Fixed: Turning the extension off actually stops it and puts the page back.
- Fixed: An invalid key, a rate limit, a server error and no connection now read differently instead of all saying the same thing.

## v3.3.0 - 2026-09-04

- Changed: The popup and the on-page panels have square corners and no drop shadows.
- Changed: Borders and fills are solid grays instead of see-through white, so edges read cleanly on any page.
- Changed: Text falls back to a monospace font rather than a sans-serif one.

## v3.2.9 - 2026-08-14

- Added: Compatibility verdicts now show how confident they are and what evidence they were based on
- Added: A "likely compatible" verdict, so an inferred match no longer looks like a confirmed one
- Added: A "not set up" state, so a fresh install no longer reports every mod as failed
- Changed: Version lists are worked out automatically for every game on Nexus Mods, not just a handful, and come out the same on any machine
- Changed: The Nexus API key is now optional. Browsing, filtering, and choosing a game and version all work without one
- Changed: Versions are listed newest first in true release order, with duplicate and near-duplicate builds merged
- Changed: The popup can show, replace or disconnect your API key, and reports how much space clearing the cache reclaimed
- Changed: File selections survive a page reload, and download mode is reachable from the popup
- Fixed: Compatibility is judged against the game you are viewing, not whichever one was last set in the popup
- Fixed: The Update, Optional and Miscellaneous toggles now actually filter the file list
- Fixed: Saving your game and version no longer fails silently when browser storage is full
- Fixed: Refreshing a page no longer leaves duplicate panels behind, and the panel no longer vanishes for the rest of the session
- Fixed: A failed download now says so, and turning the extension off fully stops it and restores the page
- Removed: An unused host permission

## v3.1.0 - 2026-08-13

- Added: Compatibility verdicts gained confidence levels and evidence sources
- Changed: The Nexus API key became optional
- Fixed: Compatibility is judged against the game on screen, not the last one set
- Fixed: Settings no longer break when browser storage is full
