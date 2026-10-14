import { type ReactElement } from "react";
import { useLiveQuery, type LiveQuery } from "../hooks/useLiveQuery";
import type { LiveOptions } from "../hooks/liveQuery";

type LiveQueryOptions<T> = Omit<LiveOptions<T>, "initialData" | "environment">;
import { useSearchParams } from "react-router-dom";
import { ScopeToolbar, type Period } from "../components/ConsolePrimitives";
import { isoToZonedInput, parsePeriod, periodDates, zonedInputToIso, type ReportingFx } from "../components/consoleFormatters";
import { useReleases } from "../components/releasesModel";
import { useAuth } from "../contexts/useAuth";
import type { InsightScope } from "../api";

/** The time picker's quick picks on insight pages. */
export const INSIGHT_PERIODS: Period[] = ["15m", "1h", "3h", "12h", "24h", "3d", "7d", "30d", "90d", "today", "mtd"];

/** Project, time range and environment for an insight page, kept in the URL. */
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
  const { releases, loaded } = useReleases(projectId, environment);
  const latest = releases[0] ?? null;

  // A custom range is two instants in the URL; "since the last deploy" starts at its first call.
  const customFrom = params.get("from");
  const customTo = params.get("to");
  const customValid = period === "custom" && customFrom && customTo && !Number.isNaN(Date.parse(customFrom)) && !Number.isNaN(Date.parse(customTo)) && Date.parse(customFrom) < Date.parse(customTo);
  const rolling = periodDates(period === "custom" || period === "deploy" ? "24h" : period, timezone ?? undefined);
  const { from, to } = customValid
    ? { from: new Date(customFrom!).toISOString(), to: new Date(customTo!).toISOString() }
    : period === "deploy" && latest ? { from: latest.firstSeen, to: rolling.to } : rolling;
  const scope: InsightScope = { from, to, environment };

  const update = (change: (next: URLSearchParams) => void) => setParams((current) => { change(current); return current; });
  const toolbar = <ScopeToolbar
    period={period as Period}
    periods={INSIGHT_PERIODS}
    customRelative
    deploy={{ release: latest, loaded }}
    timezone={timezone}
    onPeriodChange={(next) => update((query) => {
      if (next === "mtd") query.delete("period"); else query.set("period", next);
      query.delete("from");
      query.delete("to");
    })}
    customTime
    customFrom={isoToZonedInput(from, timezone)}
    customTo={isoToZonedInput(to, timezone)}
    onCustomRangeChange={(nextFrom, nextTo) => update((query) => {
      const fromIso = zonedInputToIso(nextFrom, timezone);
      const toIso = zonedInputToIso(nextTo, timezone);
      if (!fromIso || !toIso) return;
      query.set("period", "custom");
      query.set("from", fromIso);
      query.set("to", toIso);
    })}
    environment={environment}
    onEnvironmentChange={(next) => update((query) => { if (next === "all") query.delete("environment"); else query.set("environment", next); })}
  />;
  return {
    projectId,
    scope,
    // Rolling windows move with the clock; the key moves once a minute so loads stay steady.
    scopeKey: [projectId ?? "", period, environment, from.slice(0, 16), period === "custom" ? to.slice(0, 16) : ""].join("|"),
    currency: workspaceSettings?.reportingCurrency ?? "USD",
    fx: workspaceSettings?.fx,
    toolbar,
  };
}

/**
 * Load per scope and keep it current (every 10 s while the tab is visible).
 * The last result stays on screen while a new one loads.
 */
export function useScopedLoad<T>(key: string | null, load: () => Promise<T>, options: LiveQueryOptions<T> = {}): LiveQuery<T> {
  return useLiveQuery(key, load, options);
}
