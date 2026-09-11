// One registry that owns every node, listener, timer and observer the extension
// adds to the page, and releases them in reverse acquisition order.

type Disposer = () => void;

export interface Scope {
    readonly name: string;
    readonly signal: AbortSignal;
    readonly alive: boolean;
    own(disposer: Disposer): void;
    interval(fn: () => void, ms: number): void;
    timeout(fn: () => void, ms: number): void;
    frame(fn: () => void): void;
    listen(target: EventTarget, type: string, fn: any, opts?: AddEventListenerOptions): void;
    observe(observer: MutationObserver | IntersectionObserver | ResizeObserver): void;
    mount(node: Element): void;
    child(name: string): Scope;
    dispose(): void;
}

class ScopeImpl implements Scope {
    private disposers: Disposer[] = [];
    private controller = new AbortController();
    private disposed = false;

    constructor(readonly name: string) {}

    get signal(): AbortSignal {
        return this.controller.signal;
    }

    get alive(): boolean {
        return !this.disposed;
    }

    own(disposer: Disposer): void {
        if (this.disposed) {
            disposer();
            return;
        }
        this.disposers.push(disposer);
    }

    interval(fn: () => void, ms: number): void {
        if (this.disposed) return;
        const id = setInterval(() => {
            if (!this.disposed) fn();
        }, ms);
        this.own(() => clearInterval(id));
    }

    timeout(fn: () => void, ms: number): void {
        if (this.disposed) return;
        const id = setTimeout(() => {
            if (!this.disposed) fn();
        }, ms);
        this.own(() => clearTimeout(id));
    }

    frame(fn: () => void): void {
        if (this.disposed) return;
        const id = requestAnimationFrame(() => {
            if (!this.disposed) fn();
        });
        this.own(() => cancelAnimationFrame(id));
    }

    listen(target: EventTarget, type: string, fn: any, opts: AddEventListenerOptions = {}): void {
        if (this.disposed) return;
        target.addEventListener(type, fn, {...opts, signal: this.controller.signal});
    }

    observe(observer: MutationObserver | IntersectionObserver | ResizeObserver): void {
        this.own(() => observer.disconnect());
    }

    mount(node: Element): void {
        this.own(() => node.remove());
    }

    child(name: string): Scope {
        if (this.disposed) {
            const dead = new ScopeImpl(`${this.name}/${name}`);
            dead.dispose();
            return dead;
        }
        const scope = new ScopeImpl(`${this.name}/${name}`);
        const release = () => scope.dispose();
        this.own(release);
        // A child that dies before its parent must take its own entry off the
        // parent's list. Without this a surface that re-mounts on every health
        // tick grows the route scope by one dead disposer every 1.5 seconds.
        scope.own(() => {
            if (this.disposed) return;
            const index = this.disposers.indexOf(release);
            if (index >= 0) this.disposers.splice(index, 1);
        });
        return scope;
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.controller.abort();
        // Release in reverse acquisition order so a child never outlives the node it was attached to.
        for (let i = this.disposers.length - 1; i >= 0; i--) {
            try {
                this.disposers[i]();
            } catch (err) {
                console.warn('NMA extension: disposer threw', this.name, err);
            }
        }
        this.disposers.length = 0;
    }
}

export function createScope(name: string): Scope {
    return new ScopeImpl(name);
}

export interface Surface {
    readonly id: string;
    isMounted(): boolean;
    mount(scope: Scope): void;
}

const mounted = new Map<string, {scope: Scope; surface: Surface}>();

export function mountSurface(surface: Surface, parent: Scope): void {
    const existing = mounted.get(surface.id);
    if (existing) {
        // Liveness, not reference: a detached surface must not block a rebuild.
        if (existing.scope.alive && existing.surface.isMounted()) return;
        existing.scope.dispose();
        mounted.delete(surface.id);
    }
    const scope = parent.child(surface.id);
    mounted.set(surface.id, {scope, surface});
    try {
        surface.mount(scope);
    } catch (err) {
        // A surface that threw mid-mount is not mounted; releasing here keeps the guard honest.
        scope.dispose();
        mounted.delete(surface.id);
        throw err;
    }
    if (!surface.isMounted()) {
        scope.dispose();
        mounted.delete(surface.id);
    }
}

export function isSurfaceMounted(id: string): boolean {
    const entry = mounted.get(id);
    return !!entry && entry.scope.alive && entry.surface.isMounted();
}

export function unmountSurface(id: string): void {
    const entry = mounted.get(id);
    if (!entry) return;
    mounted.delete(id);
    entry.scope.dispose();
}

export function unmountAllSurfaces(): void {
    for (const id of Array.from(mounted.keys())) unmountSurface(id);
}
