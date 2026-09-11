// One token that invalidates every in-flight response, timer and callback.
// Bumped by any event that changes what a verdict means: navigation, game
// change, version-range change, filter change, rescan, teardown.

export interface Epoch {
    readonly id: number;
    readonly gameDomain: string;
    readonly versionMin: string;
    readonly versionMax: string;
}

let current: Epoch = {id: 0, gameDomain: '', versionMin: '', versionMax: ''};

export function getEpoch(): Epoch {
    return current;
}

export function isCurrent(epoch: Epoch): boolean {
    return !!epoch && epoch.id === current.id;
}

export function bumpEpoch(patch: Partial<Omit<Epoch, 'id'>> = {}): Epoch {
    current = {
        id: current.id + 1,
        gameDomain: patch.gameDomain ?? current.gameDomain,
        versionMin: patch.versionMin ?? current.versionMin,
        versionMax: patch.versionMax ?? current.versionMax
    };
    return current;
}
