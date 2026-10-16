/**
 * Live refresh for a console query, without React so it can be tested on
 * its own. A query refetches every 10 s while the tab is visible, every 3 s
 * while its data says something is still running, pauses while the tab is
 * hidden and refetches at once when it comes back. After three failed
 * refreshes in a row it backs off to once a minute. A refresh never clears
 * what is on screen: data is only replaced by newer data.
 */

export const LIVE_INTERVAL_MS = 10_000;
export const LIVE_FAST_INTERVAL_MS = 3_000;
export const LIVE_BACKOFF_MS = 60_000;
export const LIVE_BACKOFF_AFTER = 3;
/** A refresh runs at least this often even with no new calls, so "last 15 minutes" still moves. */
export const LIVE_MAX_SKIP_MS = 60_000;
/** One version check serves every live query refreshing within this long. */
const VERSION_REUSE_MS = 5_000;

/**
 * What the data on screen was computed from: the project's latest call. A
 * refresh with nothing new skips its query, so a page of ten panels costs one
 * cheap check every 10 s instead of ten heavy queries.
 */
let versionSource: (() => Promise<string | null>) | null = null;
let versionCache: { value: string | null; at: number; pending: Promise<string | null> | null } = { value: null, at: -Infinity, pending: null };

export function setLiveVersionSource(source: (() => Promise<string | null>) | null): void {
  versionSource = source;
  versionCache = { value: null, at: -Infinity, pending: null };
}

async function currentVersion(now: number): Promise<string | null> {
  const source = versionSource;
  if (!source) return null;
  if (now - versionCache.at < VERSION_REUSE_MS) return versionCache.value;
  if (!versionCache.pending) {
    const cache = versionCache;
    cache.pending = source()
      .catch(() => null)
      .then((value) => { if (versionCache === cache) Object.assign(cache, { value, at: now, pending: null }); return value; });
  }
  return versionCache.pending;
}

export type LiveStatus = "loading" | "live" | "reconnecting" | "paused";

export interface LiveState<T> {
  data: T | null;
  error: string | null;
  /** True until the first load for this query finishes. */
  loading: boolean;
  /** When data last arrived. */
  updatedAt: number | null;
  /** Refreshes that failed in a row. */
  failures: number;
  status: LiveStatus;
}

export interface LiveEnvironment {
  visible(): boolean;
  onVisibilityChange(listener: () => void): () => void;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

export interface LiveOptions<T> {
  interval?: number;
  fastInterval?: number;
  /** Poll fast while this says the data is still changing (a run in progress). */
  isFast?: (data: T) => boolean;
  /** While true (the pointer is over a list), new data waits so rows don't move under it. */
  shouldDefer?: () => boolean;
  /** Seed with data already on screen, e.g. the previous period's while the next loads. */
  initialData?: T | null;
  environment?: LiveEnvironment;
}

export function browserEnvironment(): LiveEnvironment {
  const doc = typeof document === "undefined" ? null : document;
  return {
    visible: () => !doc || doc.visibilityState !== "hidden",
    onVisibilityChange: (listener) => {
      if (!doc?.addEventListener) return () => {};
      doc.addEventListener("visibilitychange", listener);
      return () => doc.removeEventListener("visibilitychange", listener);
    },
    setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
    clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
    now: () => Date.now(),
  };
}

export class LivePoller<T> {
  private state: LiveState<T>;
  private readonly listeners = new Set<(state: LiveState<T>) => void>();
  private timer: unknown = null;
  private generation = 0;
  private inFlight = false;
  private pending: T | null = null;
  private stopped = true;
  private unsubscribeVisibility: (() => void) | null = null;
  /** The version the data on screen was loaded at, and when. */
  private loadedVersion: string | null = null;
  private loadedAt = -Infinity;
  private forceNext = false;
  private readonly env: LiveEnvironment;

  private readonly load: () => Promise<T>;
  private readonly options: LiveOptions<T>;

  constructor(load: () => Promise<T>, options: LiveOptions<T> = {}) {
    this.load = load;
    this.options = options;
    this.env = options.environment ?? browserEnvironment();
    const data = options.initialData ?? null;
    this.state = { data, error: null, loading: true, updatedAt: null, failures: 0, status: "loading" };
  }

  get snapshot(): LiveState<T> {
    return this.state;
  }

  subscribe(listener: (state: LiveState<T>) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.unsubscribeVisibility = this.env.onVisibilityChange(() => this.visibilityChanged());
    void this.fetch();
  }

  stop(): void {
    this.stopped = true;
    this.generation += 1;
    this.clearTimer();
    this.unsubscribeVisibility?.();
    this.unsubscribeVisibility = null;
  }

  /** Refetch now, e.g. from a Refresh button. */
  refresh(): void {
    if (this.stopped) return;
    this.clearTimer();
    this.forceNext = true;
    void this.fetch();
  }

  private set(next: Partial<LiveState<T>>): void {
    this.state = { ...this.state, ...next };
    for (const listener of this.listeners) listener(this.state);
  }

  private clearTimer(): void {
    if (this.timer != null) this.env.clearTimeout(this.timer);
    this.timer = null;
  }

  private delay(): number {
    if (this.state.failures >= LIVE_BACKOFF_AFTER) return LIVE_BACKOFF_MS;
    const data = this.state.data;
    if (data != null && this.options.isFast?.(data)) return this.options.fastInterval ?? LIVE_FAST_INTERVAL_MS;
    return this.options.interval ?? LIVE_INTERVAL_MS;
  }

  private schedule(): void {
    this.clearTimer();
    if (this.stopped) return;
    if (!this.env.visible()) {
      if (this.state.status !== "loading") this.set({ status: "paused" });
      return;
    }
    this.timer = this.env.setTimeout(() => { this.timer = null; void this.fetch(); }, this.delay());
  }

  private visibilityChanged(): void {
    if (this.stopped) return;
    if (this.env.visible()) {
      // Back in view: catch up at once.
      this.clearTimer();
      this.forceNext = true;
      void this.fetch();
    } else {
      this.clearTimer();
      if (this.state.status !== "loading") this.set({ status: "paused" });
    }
  }

  private apply(data: T): void {
    this.pending = null;
    this.set({ data, error: null, loading: false, updatedAt: this.env.now(), failures: 0, status: "live" });
  }

  private applyWhenFree(data: T): void {
    if (!this.options.shouldDefer?.()) { this.apply(data); this.schedule(); return; }
    this.pending = data;
    // Try again shortly; the list stays still while the pointer is on it.
    this.timer = this.env.setTimeout(() => { this.timer = null; if (this.pending != null) this.applyWhenFree(this.pending); }, 1_000);
  }

  private async fetch(): Promise<void> {
    if (this.inFlight || this.stopped) return;
    if (!this.env.visible() && !this.state.loading) { this.schedule(); return; }
    this.inFlight = true;
    const generation = this.generation;
    const force = this.forceNext;
    this.forceNext = false;
    try {
      const now = this.env.now();
      const version = await currentVersion(now);
      if (generation !== this.generation || this.stopped) return;
      // Nothing new since this data was loaded: keep it, check again next time.
      const fast = this.state.data != null && Boolean(this.options.isFast?.(this.state.data));
      if (!force && !this.state.loading && !fast && version !== null && version === this.loadedVersion
        && now - this.loadedAt < LIVE_MAX_SKIP_MS && this.state.failures === 0) {
        this.schedule();
        return;
      }
      const data = await this.load();
      if (generation !== this.generation || this.stopped) return;
      this.loadedVersion = version;
      this.loadedAt = now;
      // The first load always shows; later ones wait for the pointer to leave.
      if (this.state.loading) { this.apply(data); this.schedule(); } else this.applyWhenFree(data);
    } catch (reason) {
      if (generation !== this.generation || this.stopped) return;
      const failures = this.state.failures + 1;
      const message = reason instanceof Error ? reason.message : "Couldn’t load this page.";
      // Keep what is on screen; say we are reconnecting.
      this.set({ error: message, loading: false, failures, status: "reconnecting" });
      this.schedule();
    } finally {
      if (generation === this.generation) this.inFlight = false;
    }
  }
}
