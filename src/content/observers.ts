// Visibility helpers. Every listener registered here is owned by a scope, so a
// route change or a teardown removes it instead of leaving a duplicate behind.

import {Scope} from './lifecycle';
import {
    GRID_SELECTORS, CARD_SELECTORS,
    findGrid, findCards, isSkeletonGrid
} from './selectors';

export {GRID_SELECTORS, CARD_SELECTORS};

const pendingHidden = new Set<HTMLElement>();
const pendingLowTimers = new WeakMap();

let onCardBecameVisible: ((card: HTMLElement, generation: number) => void) | null = null;
let accelerationScope: Scope | null = null;

export function initObservers(callback: (card: HTMLElement, generation: number) => void): void {
    onCardBecameVisible = callback;
}

// ── pendingHidden helpers ────────────────────────────────────────────

export function addPendingHidden(card): void {
    pendingHidden.add(card);
}

export function removePendingHidden(card): void {
    pendingHidden.delete(card);
}

export function clearPendingHidden(): void {
    pendingHidden.clear();
}

export function getPendingHiddenCount(): number {
    return pendingHidden.size;
}

export function resetScrollState(): void {
    // Releases the listeners as well as the flag. Clearing the flag alone is what
    // used to guarantee a duplicate scroll handler on the next attach.
    accelerationScope?.dispose();
    accelerationScope = null;
}

// ── pendingLowTimers helpers ─────────────────────────────────────────

export function getPendingLowTimer(card) {
    return pendingLowTimers.get(card);
}

export function clearPendingLowTimer(card): void {
    const t = pendingLowTimers.get(card);
    if (t) {
        clearTimeout(t);
        pendingLowTimers.delete(card);
    }
}

// ── Grid / card finders ──────────────────────────────────────────────

export function findModGrid() {
    return findGrid();
}

export function collectCards(grid) {
    return findCards(grid);
}

export function isGridSkeleton(grid): boolean {
    return isSkeletonGrid(grid);
}

// ── Visibility check ─────────────────────────────────────────────────

export function isCardVisible(card): boolean {
    const rect = card.getBoundingClientRect();
    const vw = window.innerWidth || document.documentElement.clientWidth;
    const vh = window.innerHeight || document.documentElement.clientHeight;
    const horiz = rect.right > 0 && rect.left < vw;
    const vert = rect.bottom > 0 && rect.top < vh;
    return horiz && vert;
}

// ── Scroll / resize acceleration ─────────────────────────────────────

export function ensureScrollAcceleration(scope?: Scope): void {
    if (accelerationScope?.alive) return;
    if (!scope) return;

    const owned = scope.child('scroll-acceleration');
    accelerationScope = owned;

    let scheduled = false;
    const sweep = () => {
        if (scheduled) return;
        scheduled = true;
        owned.frame(() => {
            scheduled = false;
            accelerateVisibleHidden();
        });
    };

    // Resize and zoom expose cards without a scroll event; without this they pulse forever.
    owned.listen(window, 'scroll', sweep, {passive: true});
    owned.listen(window, 'resize', sweep, {passive: true});
    owned.own(() => {
        pendingHidden.clear();
        if (accelerationScope === owned) accelerationScope = null;
    });
}

export function accelerateVisibleHidden(): void {
    if (pendingHidden.size === 0) return;
    for (const card of Array.from(pendingHidden)) {
        if (!card.isConnected) {
            pendingHidden.delete(card);
            continue;
        }
        if (!isCardVisible(card)) continue;
        pendingHidden.delete(card);
        clearPendingLowTimer(card);
        const gen = Number(card.dataset.nmaProcessed || 0);
        if (onCardBecameVisible) {
            onCardBecameVisible(card, gen);
        }
    }
}

// ── Vestigial helper, kept until the developer rules on it ───────────

export function scheduleHiddenFetch(card, _generation): void {
    // Registers the card for scroll promotion. Hidden cards are deliberately not
    // auto-enqueued: that is what keeps API usage proportional to what is read.
    pendingHidden.add(card);
}
