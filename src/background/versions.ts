import type { FoundEvidenceSource } from '../types';

/**
 * Pure version algebra and evidence extraction. No chrome.* access on purpose:
 * these are the functions a test runner can exercise directly, and they carry
 * the verdict the user acts on.
 */

export interface ParsedVersion {
    numbers: number[];
    /**
     * The components exactly as the author spelled them, zero padding included.
     * `numbers` drops the padding, so '2.01' and '2.1' are indistinguishable
     * there; every ordering decision reads these instead.
     */
    components: string[];
    wildcard: boolean;
    open: boolean;
    prerelease: string | null;
    /**
     * A hotfix letter attached to the last component with no separator, as CD
     * Projekt spells Cyberpunk 2.12a. It follows its bare build rather than
     * preceding it, which is the opposite of a pre-release suffix.
     */
    revision: string | null;
}

/**
 * `max: null` means unbounded above. A non-null `max` is a PREFIX and is
 * inclusive of everything that extends it, so `1.6` as an upper bound admits
 * `1.6.1170`. That is what kills the old synthetic `.999` ceiling.
 *
 * The `*Components` fields carry the same bounds with their zero padding intact.
 * They are optional: a spec built from numbers alone has no padding to preserve
 * and is compared exactly as before.
 */
export interface VersionRangeSpec {
    min: number[];
    max: number[] | null;
    minComponents?: string[];
    maxComponents?: string[] | null;
}

export interface VersionToken {
    text: string;
    token: string;
    source: FoundEvidenceSource;
    cued: boolean;
}

export interface ExtractOptions {
    source: FoundEvidenceSource;
    requireCue?: boolean;
    exclude?: Set<string>;
    cueLookBehind?: number;
    cueLookAhead?: number;
    /**
     * Accept tokens no known build confirms. This is the fail-open door and it
     * exists for version DISCOVERY only, never for a verdict: a caller using it
     * must apply its own corroboration before trusting the result.
     */
    allowUnknownBuilds?: boolean;
}

const RANGE_SEPARATOR = '(?:-|\\u2013|\\u2014|to|through)';
const CANDIDATE_PATTERN = '[ve]?\\d+(?:\\.\\d+){1,6}(?:[-_][a-z0-9][a-z0-9._-]*)?(?:\\.[x*]|[x*]|\\+)?';
const CANDIDATE_RE = new RegExp(`\\b${CANDIDATE_PATTERN}`, 'gi');
const RANGE_RE = new RegExp(`\\b[ve]?(\\d+(?:\\.\\d+){1,6})\\s*${RANGE_SEPARATOR}\\s*[ve]?(\\d+(?:\\.\\d+){1,6})\\b`, 'gi');
// Both ends carry at least two components, as RANGE_RE requires of the text this
// token was harvested from. A bare integer after the separator is a revision
// suffix - '1.5.97-1' is the first rebuild of 1.5.97 - and reading it as a range
// end inverted the range and made the token cover everything below 1.5.97.
const SINGLE_RANGE_RE = new RegExp(`^[ve]?(\\d+(?:\\.\\d+){1,6})\\s*${RANGE_SEPARATOR}\\s*[ve]?(\\d+(?:\\.\\d+){1,6})$`, 'i');

const CUE_RE = /(?:game\s*(?:version|build|patch|update)|runtime|for\s+(?:the\s+)?(?:game|patch|update|version)|requires?|required|compatible|compatibility|works\s+(?:with|on|for)|tested\s+(?:on|with|against)|built\s+(?:for|against)|supports?|patch\s*\d|update\s*\d|\be1\.|\bse\b|\bae\b|\bnext-?gen\b)/i;

const DEFAULT_CUE_LOOK_BEHIND = 60;
const DEFAULT_CUE_LOOK_AHEAD = 40;

export function parseVersion(raw: string | null | undefined): ParsedVersion | null {
    if (!raw) return null;
    let text = String(raw).trim().toLowerCase();
    if (!text) return null;

    let open = false;
    if (text.endsWith('+')) {
        open = true;
        text = text.slice(0, -1).trim();
    }

    text = text.replace(/^[ve](?=\d)/, '');

    let wildcard = false;
    const wildcardMatch = text.match(/\.?[x*]$/);
    if (wildcardMatch) {
        wildcard = true;
        text = text.slice(0, text.length - wildcardMatch[0].length);
    }

    // A build or pre-release suffix starts at the first separator and is never
    // numeric payload: '2.0.1-rc2' is 2.0.1, not 2.0.12.
    let prerelease: string | null = null;
    const separatorIndex = text.search(/[-_]/);
    if (separatorIndex >= 0) {
        prerelease = text.slice(separatorIndex + 1) || null;
        text = text.slice(0, separatorIndex);
    }

    if (text.endsWith('.')) text = text.slice(0, -1);

    let revision: string | null = null;
    const revisionMatch = text.match(/^(\d+(?:\.\d+)*?)([a-z])$/);
    if (revisionMatch) {
        text = revisionMatch[1];
        revision = revisionMatch[2];
    }

    if (!/^\d+(?:\.\d+)*$/.test(text)) return null;

    const components = text.split('.');
    const numbers = components.map(part => parseInt(part, 10));
    if (numbers.some(n => !Number.isFinite(n))) return null;

    return { numbers, components, wildcard, open, prerelease, revision };
}

export function formatVersionToken(parsed: ParsedVersion): string {
    let out = parsed.components.join('.');
    if (parsed.revision) out += parsed.revision;
    if (parsed.wildcard) out += '.x';
    if (parsed.open) out += '+';
    return out;
}

const PADDED_COMPONENT_RE = /^0\d/;

/**
 * Order two components of a version, the padding treated as meaning.
 *
 * Cyberpunk 2077 shipped 2.0, then 2.01, then 2.02, then 2.1. The padding is
 * what separates 2.01 from 2.1, so a padded component is a fixed-width
 * subdivision of the position it sits in, not an integer: read as decimal
 * fractions, .01 < .02 < .1 and the shipped order holds. Two unpadded
 * components stay integers, because 1.6.1170 really is a later Skyrim build
 * than 1.6.640 and .1170 < .640 would invert it. Only the mixed and padded
 * cases change, and the result is a total order: '0' below every padded
 * component, every padded component below every unpadded non-zero one.
 */
function compareComponent(a: string, b: string): number {
    if (!PADDED_COMPONENT_RE.test(a) && !PADDED_COMPONENT_RE.test(b)) {
        const left = parseInt(a, 10);
        const right = parseInt(b, 10);
        if (left > right) return 1;
        if (left < right) return -1;
        return 0;
    }

    const width = Math.max(a.length, b.length);
    const left = a.padEnd(width, '0');
    const right = b.padEnd(width, '0');
    if (left > right) return 1;
    if (left < right) return -1;
    return 0;
}

function compareComponentArrays(a: string[], b: string[]): number {
    const len = Math.max(a.length, b.length);
    for (let i = 0; i < len; i++) {
        const result = compareComponent(a[i] ?? '0', b[i] ?? '0');
        if (result !== 0) return result;
    }
    return 0;
}

function minComponentsOf(range: VersionRangeSpec): string[] {
    return range.minComponents ?? range.min.map(n => String(n));
}

function maxComponentsOf(range: VersionRangeSpec): string[] | null {
    if (range.max === null) return null;
    return range.maxComponents ?? range.max.map(n => String(n));
}

export function compareNumberArrays(a: number[], b: number[]): number {
    const len = Math.max(a.length, b.length);
    for (let i = 0; i < len; i++) {
        const left = a[i] ?? 0;
        const right = b[i] ?? 0;
        if (left > right) return 1;
        if (left < right) return -1;
    }
    return 0;
}

export function compareVersions(v1: string, v2: string): number {
    const a = parseVersion(v1);
    const b = parseVersion(v2);
    if (!a && !b) return 0;
    if (!a) return -1;
    if (!b) return 1;

    const numeric = compareComponentArrays(a.components, b.components);
    if (numeric !== 0) return numeric;

    // A hotfix letter follows its bare build: 2.12a is newer than 2.12.
    if (a.revision && !b.revision) return 1;
    if (!a.revision && b.revision) return -1;
    if (a.revision && b.revision && a.revision !== b.revision) {
        return a.revision > b.revision ? 1 : -1;
    }

    // A release outranks a pre-release of the same build: 1.5.97 > 1.5.97-beta.
    if (!a.prerelease && b.prerelease) return 1;
    if (a.prerelease && !b.prerelease) return -1;
    if (a.prerelease && b.prerelease) {
        if (a.prerelease > b.prerelease) return 1;
        if (a.prerelease < b.prerelease) return -1;
    }
    return 0;
}

export function versionRangeFromToken(token: string | null | undefined): VersionRangeSpec | null {
    if (!token) return null;
    const text = String(token).trim().toLowerCase();
    if (!text) return null;

    const rangeMatch = SINGLE_RANGE_RE.exec(text);
    if (rangeMatch) {
        const low = parseVersion(rangeMatch[1]);
        const high = parseVersion(rangeMatch[2]);
        if (!low || !high) return null;
        return {
            min: low.numbers,
            max: high.numbers,
            minComponents: low.components,
            maxComponents: high.components
        };
    }

    const parsed = parseVersion(text);
    if (!parsed) return null;
    if (parsed.open) {
        return { min: parsed.numbers, max: null, minComponents: parsed.components, maxComponents: null };
    }
    return {
        min: parsed.numbers,
        max: parsed.numbers,
        minComponents: parsed.components,
        maxComponents: parsed.components
    };
}

function comparePrefix(prefix: string[], full: string[]): number {
    return compareComponentArrays(prefix, full.slice(0, prefix.length));
}

export function rangesOverlap(a: VersionRangeSpec, b: VersionRangeSpec): boolean {
    const aMin = minComponentsOf(a);
    const bMin = minComponentsOf(b);
    const aMax = maxComponentsOf(a);
    const bMax = maxComponentsOf(b);

    // An end below its own start is not a range. Overlap is the permissive
    // answer, so answering it for an inverted range turns a typo or a misread
    // token into a green badge rather than a refusal.
    if (aMax !== null && comparePrefix(aMax, aMin) < 0) return false;
    if (bMax !== null && comparePrefix(bMax, bMin) < 0) return false;

    const aStartsBelowBTop = bMax === null || comparePrefix(bMax, aMin) >= 0;
    const bStartsBelowATop = aMax === null || comparePrefix(aMax, bMin) >= 0;
    return aStartsBelowBTop && bStartsBelowATop;
}

export function isCompatible(modVersion: string, userMin: string, userMax: string): boolean {
    const modRange = versionRangeFromToken(modVersion);
    if (!modRange) return false;

    const lower = versionRangeFromToken(userMin);
    const upper = versionRangeFromToken(userMax || userMin);
    if (!lower || !upper) return false;

    return rangesOverlap(modRange, {
        min: lower.min,
        max: upper.max,
        minComponents: lower.minComponents,
        maxComponents: upper.maxComponents
    });
}

/**
 * Fail CLOSED. An empty allow-list means NMA has no version data for this game,
 * which is not the same as every number being a game version.
 */
export function isKnownGameVersion(token: string, allowedVersions: string[]): boolean {
    if (!allowedVersions || allowedVersions.length === 0) return false;

    const parsed = parseVersion(token);
    if (!parsed) return false;
    if (parsed.numbers.length < 2) return false;

    return allowedVersions.some(candidate => {
        const known = parseVersion(candidate);
        if (!known) return false;
        if (parsed.components.length > known.components.length) return false;
        return compareComponentArrays(parsed.components, known.components.slice(0, parsed.components.length)) === 0;
    });
}

function hasCue(text: string, start: number, end: number, lookBehind: number, lookAhead: number): boolean {
    const before = text.slice(Math.max(0, start - lookBehind), start);
    const after = text.slice(end, end + lookAhead);
    return CUE_RE.test(before) || CUE_RE.test(after);
}

/**
 * Harvest game-version candidates from one blob of text. Every candidate must
 * carry at least two numeric components and match a known build, so bare
 * integers, prose ranges ("1 to 5 minutes") and dates cannot become verdicts.
 */
export function extractVersionTokens(text: string | null | undefined, allowedVersions: string[], options: ExtractOptions): VersionToken[] {
    if (!text) return [];

    const sanitized = String(text).replace(/<[^>]+>/g, ' ');
    const requireCue = options.requireCue === true;
    const allowUnknownBuilds = options.allowUnknownBuilds === true;
    const exclude = options.exclude;
    const lookBehind = options.cueLookBehind ?? DEFAULT_CUE_LOOK_BEHIND;
    const lookAhead = options.cueLookAhead ?? DEFAULT_CUE_LOOK_AHEAD;

    const byToken = new Map<string, VersionToken>();

    // The cores are the mod's own release numbers as ownVersionExclusions() in
    // background.ts spells them, which is parseVersion().numbers joined, so they
    // stay spelled that way here. A hit is the mod talking about itself only when
    // EVERY number in it is one of them: a range with one foreign endpoint still
    // says something about the game.
    const accept = (raw: string, normalized: string, numericCores: string[], cued: boolean): void => {
        if (exclude && numericCores.length > 0 && numericCores.every(core => exclude.has(core))) return;
        const existing = byToken.get(normalized);
        if (existing && (existing.cued || !cued)) return;
        byToken.set(normalized, { text: raw.trim(), token: normalized, source: options.source, cued });
    };

    RANGE_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = RANGE_RE.exec(sanitized)) !== null) {
        const low = parseVersion(match[1]);
        const high = parseVersion(match[2]);
        if (!low || !high) continue;
        if (!allowUnknownBuilds && (!isKnownGameVersion(match[1], allowedVersions) || !isKnownGameVersion(match[2], allowedVersions))) continue;
        const cued = hasCue(sanitized, match.index, match.index + match[0].length, lookBehind, lookAhead);
        if (requireCue && !cued) continue;
        accept(
            match[0],
            `${low.components.join('.')}-${high.components.join('.')}`,
            [low.numbers.join('.'), high.numbers.join('.')],
            cued
        );
    }

    CANDIDATE_RE.lastIndex = 0;
    while ((match = CANDIDATE_RE.exec(sanitized)) !== null) {
        const raw = match[0];
        const parsed = parseVersion(raw);
        if (!parsed) continue;
        if (!allowUnknownBuilds && !isKnownGameVersion(raw, allowedVersions)) continue;

        const end = match.index + raw.length;
        const cued = hasCue(sanitized, match.index, end, lookBehind, lookAhead);
        if (requireCue && !cued) continue;

        // "1.6.640 or later" is an open range the author stated in prose.
        const following = sanitized.slice(end, end + 24).toLowerCase();
        const open = parsed.open || /^\s*(?:\+|and newer|or newer|or higher|or later|and later|and above|or above)/.test(following);

        accept(raw, formatVersionToken({ ...parsed, open }), [parsed.numbers.join('.')], cued);
    }

    return Array.from(byToken.values());
}

// ── Harvest algebra ──────────────────────────────────────────────────
//
// Everything below is derivation, not authorship. Each function takes text that
// arrived from a public endpoint and decides what, if anything, it says about a
// game build. Nothing here names a game, and nothing here has a table of games
// in it, so every installation reaches the same answer from the same inputs.

/**
 * Where one observation of a build came from. STEAM_NEWS is the body of an
 * article rather than its title and corroborates nothing on its own, which is
 * why it is the only origin excluded from `isCorroboratedOrigin`.
 */
export type VersionOrigin =
    | 'STEAM_BRANCH'
    | 'STEAM_ANNOUNCEMENT'
    | 'STEAM_NEWS'
    | 'COLLECTION'
    | 'MOD_TEXT';

export interface VersionObservation {
    label: string;
    core: string;
    prefix: string;
    /** Seconds, matching Steam's own branch and news timestamps. 0 when unknown. */
    time: number;
    origin: VersionOrigin;
    /** How many independent things said this, for sources that can count. */
    corroboration: number;
}

export interface DerivedVersionEntry {
    label: string;
    core: string;
    key: string;
    prefix: string;
    time: number;
    origin: VersionOrigin;
    sources: VersionOrigin[];
    corroboration: number;
}

const ORIGIN_TRUST: Record<VersionOrigin, number> = {
    STEAM_BRANCH: 3,
    STEAM_ANNOUNCEMENT: 3,
    COLLECTION: 2,
    MOD_TEXT: 2,
    STEAM_NEWS: 0
};

/** A build the extension may judge a mod against, as opposed to merely offer. */
export function isCorroboratedOrigin(origin: VersionOrigin): boolean {
    return (ORIGIN_TRUST[origin] ?? 0) > 0;
}

const OBSERVATION_RE = /^([a-z])?(\d+(?:\.\d+){1,4})$/i;
const MAX_COMPONENT_DIGITS = 8;

/**
 * The structural gate every harvested string passes through, driven by the
 * values these endpoints really carry.
 *
 * Rejected: '' and anything with no dot; '0.0.1.3' and its family, because a
 * build whose major and minor are both zero names no release in any scheme seen
 * and is a revision counter typed into a version field; '1.4.15.0-VR' and
 * '1.2.72.0-VR', because a suffix bound into the token with a hyphen names a
 * platform variant, not the build the game ships under; anything past five
 * components or eight digits in a component, which is an id rather than a build.
 *
 * Normalized: '1.3.3389 rev40' keeps '1.3.3389', because whitespace separates a
 * version from its annotation. A second version-shaped word rejects the whole
 * value instead: that field holds a range or a list and cannot be read as one
 * build without guessing which end is meant.
 */
export function readVersionCore(raw: string | null | undefined): {prefix: string; core: string; label: string} | null {
    if (raw === null || raw === undefined) return null;
    const text = String(raw).replace(/\s+/g, ' ').trim();
    if (!text) return null;

    const words = text.split(' ');
    for (const word of words.slice(1)) {
        if (/\d+\.\d/.test(word)) return null;
    }

    const shaped = OBSERVATION_RE.exec(words[0]);
    if (!shaped) return null;

    const core = shaped[2];
    const components = core.split('.');
    if (components.length > 5) return null;
    if (components.some(part => part.length > MAX_COMPONENT_DIGITS)) return null;
    if (Number(components[0]) === 0 && Number(components[1]) === 0) return null;

    const prefix = (shaped[1] || '').toLowerCase();
    return {prefix, core, label: prefix ? `${prefix}${core}` : core};
}

/**
 * The identity two spellings of one build share.
 *
 * A trailing all-zero component is dropped, down to a floor of two, so the
 * '1.6.640.0' a collection records and the '1.6.640' a publisher announces are
 * one build rather than two rows in the same list. Zero is what a fixed-width
 * field is padded with; it is not a build number in any scheme observed. The
 * floor keeps '2.0' whole, and a terminal component that is not zero is never
 * touched, so '4.1.1.7398727' keys as itself and merges with nothing.
 */
export function canonicalVersionKey(core: string): string {
    const parts = String(core || '').split('.');
    while (parts.length > 2 && /^0+$/.test(parts[parts.length - 1])) parts.pop();
    return parts.join('.').toLowerCase();
}

export function makeVersionObservation(
    raw: string | null | undefined,
    origin: VersionOrigin,
    time: number = 0,
    corroboration: number = 1
): VersionObservation | null {
    const read = readVersionCore(raw);
    if (!read) return null;
    return {
        label: read.label,
        core: read.core,
        prefix: read.prefix,
        time: Number.isFinite(time) && time > 0 ? time : 0,
        origin,
        corroboration: Number.isFinite(corroboration) && corroboration > 0 ? corroboration : 1
    };
}

/**
 * Collapse every observation of one build into a single row, then order the
 * rows. Both halves are the behavior the Steam extractor already had, kept
 * exactly: one build cannot appear twice under two spellings, the spelling the
 * publisher used as a branch name wins, an article body never displaces a
 * published build, and the ordering groups version lines, puts the line that is
 * still being updated first, and runs newest-first inside each line.
 */
export function mergeVersionObservations(observations: VersionObservation[]): DerivedVersionEntry[] {
    const byKey = new Map<string, DerivedVersionEntry>();

    for (const item of observations) {
        if (!item) continue;
        const key = canonicalVersionKey(item.core);
        const prev = byKey.get(key);
        if (!prev) {
            byKey.set(key, {
                label: item.label,
                core: item.core,
                key,
                prefix: item.prefix,
                time: item.time,
                origin: item.origin,
                sources: [item.origin],
                corroboration: item.corroboration
            });
            continue;
        }

        if (!prev.sources.includes(item.origin)) prev.sources.push(item.origin);
        prev.corroboration += item.corroboration;

        const takesOver = (!prev.prefix && !!item.prefix)
            || (ORIGIN_TRUST[item.origin] > ORIGIN_TRUST[prev.origin])
            || (prev.origin === item.origin && item.time > prev.time);
        if (!takesOver) continue;

        prev.label = item.label;
        prev.core = item.core;
        prev.prefix = item.prefix;
        prev.time = item.time;
        prev.origin = item.origin;
    }

    const entries = Array.from(byKey.values());
    for (const entry of entries) {
        entry.sources.sort((a, b) => (ORIGIN_TRUST[b] - ORIGIN_TRUST[a]) || (a < b ? -1 : a > b ? 1 : 0));
    }

    const lineRecency = new Map<string, number>();
    for (const entry of entries) {
        const line = entry.prefix || '';
        lineRecency.set(line, Math.max(lineRecency.get(line) ?? 0, entry.time));
    }

    entries.sort((a, b) => {
        // A row nothing corroborates sorts below every row something does, whatever
        // its number. Consumers read this list top-down and the first readable row
        // becomes the version the user is judged against, so a number lifted from an
        // article body outranking a published build turns prose into a verdict: an
        // announcement body naming 2021.12.22 or 2.7.5 sorts above every real build
        // of those two games and grades every mod on the page against it.
        const trustedA = isCorroboratedOrigin(a.origin) ? 1 : 0;
        const trustedB = isCorroboratedOrigin(b.origin) ? 1 : 0;
        if (trustedA !== trustedB) return trustedB - trustedA;

        const lineA = a.prefix || '';
        const lineB = b.prefix || '';
        if (lineA !== lineB) {
            const recencyA = lineRecency.get(lineA) ?? 0;
            const recencyB = lineRecency.get(lineB) ?? 0;
            // Only when both lines are dated. Undated lines fall through to the
            // version comparison rather than being ranked on a missing zero.
            if (recencyA !== recencyB && recencyA > 0 && recencyB > 0) {
                return recencyB - recencyA;
            }
        }
        const byVersion = compareVersions(b.core, a.core);
        if (byVersion !== 0) return byVersion;
        return b.time - a.time;
    });

    return entries;
}

// U+0300 to U+036F, built from code points so no combining character has to be
// written into this file to be matched.
const COMBINING_MARKS = new RegExp('[' + String.fromCharCode(0x300) + '-' + String.fromCharCode(0x36f) + ']', 'g');

/** Lowercase, accent-folded, separator-free. Both sides of every name test use it. */
function foldName(value: string | null | undefined): string {
    return String(value || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(COMBINING_MARKS, '')
        .replace(/&/g, 'and')
        .replace(/[^a-z0-9]+/g, '');
}

function titleTokens(value: string | null | undefined): string[] {
    return String(value || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(COMBINING_MARKS, '')
        .replace(/&/g, ' and ')
        .split(/[^a-z0-9]+/)
        .filter(Boolean);
}

const MIN_CUE_LENGTH = 4;
const DEFAULT_CUE_GAP = 12;
const DEFAULT_NAME_CUE_LOOK_BEHIND = 64;

/**
 * The cue a mod author writes before a game version, derived from the game's own
 * catalog entry: "MOD BMW XM FOR RIMWORLD 1.6" states a build only because the
 * game's name sits in front of the number.
 *
 * The first word of the name is added as well, but only when the domain agrees
 * that the name opens with it, because a series title carries its distinctive
 * word first and mod authors write that word alone: "Skyrim 1.6.1170" for a game
 * catalogued as "Skyrim Special Edition". Nothing here is written down per game;
 * both inputs arrive from the same public query.
 */
export function buildGameNameCues(name: string | null | undefined, domain: string | null | undefined): string[] {
    const cues = new Set<string>();
    const add = (value: string): void => {
        const cue = foldName(value);
        if (cue.length >= MIN_CUE_LENGTH) cues.add(cue);
    };

    add(name);
    add(domain);

    const tokens = titleTokens(name);
    const foldedDomain = foldName(domain);
    if (tokens.length > 1 && tokens[0].length >= 5 && foldedDomain.startsWith(tokens[0])) {
        add(tokens[0]);
    }

    return Array.from(cues);
}

export interface CuedScanOptions {
    cues: string[];
    /** Numeric cores the caller already knows are not game versions. */
    exclude?: Set<string>;
    lookBehind?: number;
    /** Folded characters allowed between the end of a cue and the number. */
    maxGap?: number;
    /** Whether the generic phrasing cues ("requires", "game version") also count. */
    allowGenericCue?: boolean;
}

function windowCarriesCue(before: string, cues: string[], maxGap: number): boolean {
    const folded = foldName(before);
    if (!folded) return false;
    for (const cue of cues) {
        const at = folded.lastIndexOf(cue);
        if (at >= 0 && folded.length - (at + cue.length) <= maxGap) return true;
    }
    return false;
}

/**
 * Harvest build numbers out of free mod text.
 *
 * The text is scanned WHOLE. Splitting it into sentences first is the trap that
 * cost a full pass of this work: a version contains '.', so splitting on '.'
 * tears "1.6" into "1" and "6" and every game yields nothing. Each match instead
 * takes a sliding window of the characters in front of it and asks whether a cue
 * ends inside that window.
 */
export function extractCuedVersionCandidates(text: string | null | undefined, options: CuedScanOptions): string[] {
    if (!text) return [];

    const sanitized = String(text).replace(/<[^>]+>/g, ' ');
    const cues = (options.cues || []).map(foldName).filter(cue => cue.length >= MIN_CUE_LENGTH);
    const lookBehind = options.lookBehind ?? DEFAULT_NAME_CUE_LOOK_BEHIND;
    const maxGap = options.maxGap ?? DEFAULT_CUE_GAP;
    const allowGenericCue = options.allowGenericCue !== false;

    const found = new Set<string>();

    CANDIDATE_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = CANDIDATE_RE.exec(sanitized)) !== null) {
        const cleaned = match[0].replace(/(?:\.[x*]|[x*]|\+)$/i, '');
        const read = readVersionCore(cleaned);
        if (!read) continue;

        const parsed = parseVersion(cleaned);
        if (parsed && options.exclude && options.exclude.has(parsed.numbers.join('.'))) continue;

        const before = sanitized.slice(Math.max(0, match.index - lookBehind), match.index);
        if (!windowCarriesCue(before, cues, maxGap) && !(allowGenericCue && CUE_RE.test(before))) continue;

        found.add(read.label);
    }

    return Array.from(found);
}

export interface StoreTitleMatch {
    /** How many words the longer title carries in front of the shorter one. */
    extras: number;
}

/**
 * Decide whether a store listing and a catalog entry name the same product.
 *
 * Two conditions, both structural. The shorter word list must be the TAIL of the
 * longer one: a store prefixes a franchise ("The Elder Scrolls V: Skyrim Special
 * Edition" for "Skyrim Special Edition"), while a trailing qualifier is a
 * different product every time, which is what keeps "RimWorld - Odyssey" and
 * "Skyrim Special Edition: Creation Kit" out. And both titles must carry the
 * same numbers, which is what refuses "DiRT 2" against "DiRT Rally 2.0" and
 * "DiRT 3" - the bind that harvested another game's version list.
 */
export function matchStoreTitle(gameName: string | null | undefined, storeName: string | null | undefined): StoreTitleMatch | null {
    const a = titleTokens(gameName);
    const b = titleTokens(storeName);
    if (a.length === 0 || b.length === 0) return null;

    const numerals = (tokens: string[]): string => tokens.filter(token => /^\d+$/.test(token)).sort().join('.');
    if (numerals(a) !== numerals(b)) return null;

    const short = a.length <= b.length ? a : b;
    const long = a.length <= b.length ? b : a;
    const offset = long.length - short.length;
    for (let i = 0; i < short.length; i++) {
        if (short[i] !== long[offset + i]) return null;
    }

    return {extras: offset};
}

/**
 * The one store listing that names this game, or null.
 *
 * Only entries the store itself calls an app are considered, the closest match
 * wins, and a tie at the closest distance is refused rather than broken: two
 * listings equally close is ambiguity, and a wrong bind produces a complete,
 * plausible, entirely wrong version list, which is far worse than none.
 */
export function pickStoreApp<T extends {name?: string; type?: string}>(gameName: string | null | undefined, candidates: T[]): T | null {
    const scored: Array<{item: T; extras: number}> = [];
    for (const candidate of candidates || []) {
        const type = String((candidate as any)?.type || 'app').toLowerCase();
        if (type !== 'app') continue;
        const match = matchStoreTitle(gameName, (candidate as any)?.name);
        if (match) scored.push({item: candidate, extras: match.extras});
    }
    if (scored.length === 0) return null;

    let best = scored[0];
    let tied = false;
    for (const entry of scored.slice(1)) {
        if (entry.extras < best.extras) {
            best = entry;
            tied = false;
        } else if (entry.extras === best.extras) {
            tied = true;
        }
    }
    return tied ? null : best.item;
}

export function normalizeVersionForDisplay(version: string | null | undefined): string | null {
    if (!version) return null;
    // Collapse a repeated prefix letter before anything else. A build that has
    // been through both a source that spells it "v1.4.0" and one that prepends
    // its own "v" arrives here as "vv1.4.0", and displaying that as a distinct
    // version is how one build came to appear twice in the list.
    const trimmed = String(version).replace(/\s+/g, '').replace(/^([ve])\1+/i, '$1');
    if (!trimmed) return null;
    const low = trimmed.toLowerCase();
    return (low.startsWith('v') || low.startsWith('e')) ? trimmed : `v${trimmed}`;
}
