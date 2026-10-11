import { useEffect, useState, type ReactElement } from "react";
import { useSearchParams } from "react-router-dom";
import { ScopeToolbar, type Period } from "../components/ConsolePrimitives";
import { parsePeriod, periodDates, type ReportingFx } from "../components/consoleFormatters";
import { useAuth } from "../contexts/useAuth";
import type { InsightScope } from "../api";

/** Project, period and environment for an insight page, kept in the URL. */
export function useInsightScope(): {
  projectId: string | null;
  scope: InsightScope;
  scopeKey: string;
  currency: string;
  fx: ReportingFx | null | undefined;
  toolbar: ReactElement;
} {
  const { currentProjectId, projects, workspaceSettings, org } = useAuth();
  const [params, setParams] = useSearchParams();
  const projectId = currentProjectId ?? projects[0]?.id ?? null;
  const period = parsePeriod(params.get("period"));
  const environment = params.get("environment") ?? "all";
  const timezone = workspaceSettings?.timezone ?? org?.timezone ?? undefined;
  const { from, to } = periodDates(period === "custom" ? "mtd" : period, timezone ?? undefined);
  const scope = { from, to, environment };
  const update = (key: string, value: string | null) => setParams((current) => {
    if (value == null) current.delete(key); else current.set(key, value);
    return current;
  });
  const toolbar = <ScopeToolbar
    period={period as Period}
    onPeriodChange={(next) => update("period", next === "mtd" ? null : next)}
    environment={environment}
    onEnvironmentChange={(next) => update("environment", next === "all" ? null : next)}
  />;
  return {
    projectId,
    scope,
    scopeKey: [projectId ?? "", period, environment, from.slice(0, 13)].join("|"),
    currency: workspaceSettings?.reportingCurrency ?? "USD",
    fx: workspaceSettings?.fx,
    toolbar,
  };
}

/** Load once per scope; keeps the last result while a new one loads. */
export function useScopedLoad<T>(key: string | null, load: () => Promise<T>): { data: T | null; error: string | null; loading: boolean } {
  const [state, setState] = useState<{ key: string | null; data: T | null; error: string | null }>({ key: null, data: null, error: null });
  useEffect(() => {
    if (!key) return;
    let alive = true;
    load()
      .then((data) => { if (alive) setState({ key, data, error: null }); })
      .catch((error: unknown) => { if (alive) setState((current) => ({ key, data: current.data, error: error instanceof Error ? error.message : "Couldn't load this page." })); });
    return () => { alive = false; };
    // `load` closes over the same values as `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return { data: state.data, error: state.error, loading: state.key !== key };
}
