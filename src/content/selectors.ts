// Every Nexus DOM selector lives here. When Nexus ships a layout change this is
// the only file that needs editing, and checkLayout() is what turns "the site
// changed" into something the user can be told instead of silence.
//
// Verified against .REFERENCE/"Mount & Blade II_ Bannerlord Mods - Nexus Mods.html":
// that capture is pre-hydration, so 'grid', 'pageHeader' and the skeleton test are
// confirmed against real markup; the per-card selectors could not be, because the
// capture contains no rendered tiles.

const SPECS = {
    grid: {
        name: 'grid',
        candidates: ['div.mods-grid', 'main .mods-grid', '[data-testid="mods-grid"]'],
        required: true
    },
    card: {
        name: 'card',
        candidates: ['[data-e2eid="mod-tile"]', '[data-testid="mod-tile"]', 'div[class*="mod-tile"]', ':scope > div'],
        required: true
    },
    modLink: {
        name: 'modLink',
        candidates: ['a[href*="/mods/"]'],
        required: true
    },
    cardCategory: {
        name: 'cardCategory',
        candidates: ['[data-e2eid="mod-tile-category"]'],
        required: false
    },
    cardUpdated: {
        name: 'cardUpdated',
        candidates: ['[data-e2eid="mod-tile-updated"] time[datetime]', 'time[datetime]'],
        required: false
    },
    cardHero: {
        name: 'cardHero',
        candidates: [':scope > div.relative'],
        required: false
    },
    pageHeader: {
        name: 'pageHeader',
        candidates: ['header.sticky', 'header'],
        required: false
    },
    detailHeader: {
        name: 'detailHeader',
        candidates: ['.modpage .primary-info', '#content'],
        required: false
    },
    detailTitleTarget: {
        name: 'detailTitleTarget',
        candidates: ['.modpage .primary-info', '.page-title'],
        required: false
    },
    requirementTable: {
        name: 'requirementTable',
        candidates: ['.accordion .desc-table'],
        required: false
    }
} as const;

type SpecKey = keyof typeof SPECS;

const health = new Map<string, boolean>();

function queryOne(root: ParentNode, key: SpecKey): Element | null {
    for (const candidate of SPECS[key].candidates) {
        const found = root.querySelector(candidate);
        if (found) {
            health.set(key, true);
            return found;
        }
    }
    health.set(key, false);
    return null;
}

function queryAll(root: ParentNode, key: SpecKey): Element[] {
    for (const candidate of SPECS[key].candidates) {
        const found = Array.from(root.querySelectorAll(candidate));
        if (found.length > 0) {
            health.set(key, true);
            return found;
        }
    }
    health.set(key, false);
    return [];
}

export const GRID_SELECTORS = SPECS.grid.candidates;
export const CARD_SELECTORS = SPECS.card.candidates;

export function findGrid(): HTMLElement | null {
    return queryOne(document, 'grid') as HTMLElement | null;
}

export function findCards(grid: ParentNode): HTMLElement[] {
    return queryAll(grid, 'card') as HTMLElement[];
}

export function modLink(card: ParentNode): HTMLAnchorElement | null {
    return queryOne(card, 'modLink') as HTMLAnchorElement | null;
}

export function extractModId(href: string | null): string | null {
    const match = (href || '').match(/\/mods\/(\d+)/);
    return match ? match[1] : null;
}

export function pageGameDomain(): string {
    return window.location.pathname.split('/')[2] || '';
}

// Both URL shapes are live: /games/<domain>/mods/<id> is what this extension is
// injected into, and /<domain>/mods/<id> is the legacy one still used by links
// inside mod descriptions. Splitting on '/' answered "games" for the first.
export function extractGameDomain(href: string | null): string | null {
    if (!href) return null;
    let pathname = String(href);
    try {
        pathname = new URL(href, window.location.href).pathname;
    } catch (_) {
        // Not parseable as a URL; the raw string is matched instead.
    }
    const match = pathname.match(/^\/(?:games\/)?([^/]+)\/mods\/\d+/);
    return match ? match[1] : null;
}

export function isSkeletonGrid(grid: Element): boolean {
    // SSR skeleton cards carry no mod links; real cards always do.
    return !grid.querySelector(SPECS.modLink.candidates[0]);
}

export function pageHeaderOffset(): number {
    const header = queryOne(document, 'pageHeader') as HTMLElement | null;
    return header?.offsetHeight || 56;
}

export function cardUpdatedAt(card: ParentNode): number | null {
    const raw = queryOne(card, 'cardUpdated')?.getAttribute('datetime');
    if (!raw) return null;
    const ms = new Date(raw).getTime();
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

// null means the tile exposes no category element at all, which is a different
// statement from "the category is not a translation" and has to stay tellable:
// the translation filter refuses to act on the first rather than guessing.
export function cardCategoryText(card: ParentNode): string | null {
    const element = queryOne(card, 'cardCategory');
    if (!element) return null;
    return (element.textContent || '').trim();
}

export function badgeMountPoint(card: HTMLElement): HTMLElement {
    const block = queryOne(card, 'cardCategory')?.closest('div') as HTMLElement | null;
    const parent = block?.parentElement as HTMLElement | null;
    // The dedup query is card-scoped, so the mount must be provably inside the card.
    if (parent && card.contains(parent) && parent !== card) return parent;
    return card;
}

export function badgeAnchorSibling(card: HTMLElement): HTMLElement | null {
    const block = queryOne(card, 'cardCategory')?.closest('div') as HTMLElement | null;
    if (!block || !card.contains(block)) return null;
    return block;
}

export function selectionMountPoint(card: HTMLElement): HTMLElement {
    return (queryOne(card, 'cardHero') as HTMLElement | null) || card;
}

export function findDetailHeader(): HTMLElement | null {
    return queryOne(document, 'detailHeader') as HTMLElement | null;
}

export function findDetailTitleTarget(): HTMLElement | null {
    return queryOne(document, 'detailTitleTarget') as HTMLElement | null;
}

export function findRequirementTables(): HTMLElement[] {
    return queryAll(document, 'requirementTable') as HTMLElement[];
}

export interface LayoutReport {
    readonly ok: boolean;
    readonly brokenRequired: string[];
    readonly brokenOptional: string[];
}

export function checkLayout(grid: HTMLElement | null): LayoutReport {
    const brokenRequired: string[] = [];
    const brokenOptional: string[] = [];

    if (!grid) return {ok: false, brokenRequired: ['grid'], brokenOptional};

    const cards = findCards(grid);
    if (cards.length === 0) return {ok: false, brokenRequired: ['card'], brokenOptional};

    const sample = cards[0];
    modLink(sample);
    cardUpdatedAt(sample);
    queryOne(sample, 'cardCategory');

    for (const key of Object.keys(SPECS) as SpecKey[]) {
        if (health.get(key) !== false) continue;
        if (SPECS[key].required) brokenRequired.push(key);
        else brokenOptional.push(key);
    }
    return {ok: brokenRequired.length === 0, brokenRequired, brokenOptional};
}
