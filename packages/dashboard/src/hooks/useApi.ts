import { useState, useEffect } from "react";
import {
  getSummary,
  getOverview,
  getCallSites,
  getEvents,
  getTrends,
  getFeatures,
  getTraces,
  type Summary,
  type Overview,
  type ModelBreakdown,
  type ProviderBreakdown,
  type CallSite,
  type EventRow,
  type TrendBucket,
  type Feature,
  type Trace,
} from "../api";

interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [state, setState] = useState<AsyncState<T>>({
    data: null,
    loading: true,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));
    fn()
      .then((data) => {
        if (!cancelled) setState({ data, loading: false, error: null });
      })
      .catch((err) => {
        if (!cancelled)
          setState({ data: null, loading: false, error: String(err) });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return state;
}

export function useSummary(projectId: string) {
  return useAsync(() => getSummary(projectId), [projectId]);
}

export function useOverview(projectId: string) {
  return useAsync(
    () =>
      getOverview(projectId).then((r) => ({
        overview: r.overview,
        byModel: r.byModel,
        byProvider: r.byProvider,
      })),
    [projectId]
  );
}

export function useCallSites(projectId: string) {
  return useAsync(
    () => getCallSites(projectId, "total_cost_usd", 30).then((r) => r.callSites),
    [projectId]
  );
}

export function useEvents(projectId: string, limit = 20) {
  return useAsync(
    () => getEvents(projectId, { limit }).then((r) => r.events),
    [projectId, limit]
  );
}

export function useTrends(projectId: string, range: "mtd" | "7d" | "30d" | "3m" | "6m" | "1y" = "mtd") {
  return useAsync(
    () => getTrends(projectId, "day", range).then((r) => r.trends),
    [projectId, range]
  );
}

export function useTraces(projectId: string) {
  return useAsync(
    () => getTraces(projectId, 30).then((r) => r.traces),
    [projectId]
  );
}

export function useFeatures(projectId: string) {
  return useAsync(
    () => getFeatures(projectId).then((r) => r.features),
    [projectId]
  );
}

export type {
  Summary,
  Overview,
  ModelBreakdown,
  ProviderBreakdown,
  CallSite,
  EventRow,
  TrendBucket,
  Feature,
  Trace,
};
