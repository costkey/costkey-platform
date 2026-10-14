import { useEffect, useRef, useState } from "react";
import { LivePoller, type LiveOptions, type LiveState } from "./liveQuery";

export interface LiveQuery<T> extends LiveState<T> {
  refresh: () => void;
}

/**
 * One query that stays current: loads when `key` changes, then refreshes
 * every 10 s while the tab is visible (3 s while `isFast` says the data is
 * still changing). Data on screen is kept while a new key loads and across
 * refreshes, so nothing flickers. `key` null means nothing to load.
 */
export function useLiveQuery<T>(key: string | null, load: () => Promise<T>, options: Omit<LiveOptions<T>, "initialData" | "environment"> = {}): LiveQuery<T> {
  const loadRef = useRef(load);
  loadRef.current = load;
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const pollerRef = useRef<LivePoller<T> | null>(null);
  const [state, setState] = useState<{ key: string | null; live: LiveState<T> }>({ key: null, live: { data: null, error: null, loading: true, updatedAt: null, failures: 0, status: "loading" } });

  useEffect(() => {
    if (!key) return;
    const poller = new LivePoller<T>(() => loadRef.current(), {
      isFast: (data) => optionsRef.current.isFast?.(data) ?? false,
      shouldDefer: () => optionsRef.current.shouldDefer?.() ?? false,
      interval: optionsRef.current.interval,
      fastInterval: optionsRef.current.fastInterval,
    });
    pollerRef.current = poller;
    const unsubscribe = poller.subscribe((live) => setState({ key, live }));
    poller.start();
    return () => { unsubscribe(); poller.stop(); if (pollerRef.current === poller) pollerRef.current = null; };
  }, [key]);

  const current = state.key === key;
  return {
    // A new key keeps the last data on screen until its own arrives.
    data: state.live.data,
    error: current ? state.live.error : null,
    loading: Boolean(key) && (!current || state.live.loading),
    updatedAt: current ? state.live.updatedAt : null,
    failures: current ? state.live.failures : 0,
    status: current ? state.live.status : "loading",
    refresh: () => pollerRef.current?.refresh(),
  };
}

/** Ids that arrived on a refresh (not on the first load), for a brief highlight. */
export function useNewIds(ids: string[], holdMs = 2_500): ReadonlySet<string> {
  const known = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const signature = ids.join("\u0000");
  useEffect(() => {
    const current = new Set(signature ? signature.split("\u0000") : []);
    if (known.current == null) { known.current = current; return; }
    const added = [...current].filter((id) => !known.current!.has(id));
    for (const id of current) known.current.add(id);
    if (added.length === 0) return;
    setFresh(new Set(added));
    const timer = window.setTimeout(() => setFresh(new Set()), holdMs);
    return () => window.clearTimeout(timer);
  }, [signature, holdMs]);
  return fresh;
}

/** Whether the pointer is over an element; lists hold new rows meanwhile. */
export function usePointerHold(): { held: () => boolean; bind: { onPointerEnter: () => void; onPointerLeave: () => void } } {
  const inside = useRef(false);
  return {
    held: () => inside.current,
    bind: { onPointerEnter: () => { inside.current = true; }, onPointerLeave: () => { inside.current = false; } },
  };
}
