import { type ReactElement, type ReactNode } from "react";
import { useLiveQuery, type LiveQuery } from "../hooks/useLiveQuery";
import type { LiveOptions } from "../hooks/liveQuery";

type LiveQueryOptions<T> = Omit<LiveOptions<T>, "initialData" | "environment">;
import { useSearchParams } from "react-router-dom";
import { ScopeToolbar, type Period } from "../components/ConsolePrimitives";
import { isoToZonedInput, parsePeriod, periodDates, zonedInputToIso, type ReportingFx } from "../components/consoleFormatters";
import { compareRange, compareText, deployPair, parseCompare, releaseWindow, type CompareTo } from "../components/compareScope";
import { ReleaseLink } from "../components/Releases";
import { shortRelease, useReleases } from "../components/releasesModel";
import { PrototypeIcon } from "../components/PrototypeIcon";
import { useAuth } from "../contexts/useAuth";
import type { InsightScope } from "../api";

const PERIODS: Period[] = ["1h", "today", "24h", "7d", "30d", "mtd", "custom"];

/** What the page compares with, when Compare is on. */
export interface InsightComparison {
  scope: InsightScope;
  /** Cache key for loads of the comparison scope. */
  key: string;
  /** "the day before", or the base deploy as a link. */
  against: ReactNode;
  /** Totals (runs, calls, spend) only compare across windows of the same length. */
  totalsComparable: boolean;
}

/** Project, period, environment and comparison for an insight page, kept in the URL. */
export function useInsightScope(options: { compare?: boolean } = {}): {
  projectId: string | null;
  scope: InsightScope;
  scopeKey: string;
  currency: string;
  fx: ReportingFx | null | undefined;
  toolbar: ReactElement;
  comparison: InsightComparison | null;
} {
  const { currentProjectId, projects, workspaceSettings, org } = useAuth();
  const [params, setParams] = useSearchParams();
  const projectId = currentProjectId ?? projects[0]?.id ?? null;
  const period = parsePeriod(params.get("period"));
  const environment = params.get("environment") ?? "all";
  const timezone = workspaceSettings?.timezone ?? org?.timezone ?? undefined;
  const compareTo: CompareTo = options.compare ? parseCompare(params.get("compare")) : "off";
  const { releases, loaded: releasesLoaded } = useReleases(options.compare ? projectId : null, environment);

  // A custom range is two instants in the URL; it defaults to the last 24 hours.
  const customFrom = params.get("from");
  const customTo = params.get("to");
  const customValid = period === "custom" && customFrom && customTo && !Number.isNaN(Date.parse(customFrom)) && !Number.isNaN(Date.parse(customTo)) && Date.parse(customFrom) < Date.parse(customTo);
  const { from, to } = customValid
    ? { from: new Date(customFrom!).toISOString(), to: new Date(customTo!).toISOString() }
    : periodDates(period === "custom" ? "24h" : period, timezone ?? undefined);
  const base: InsightScope = { from, to, environment };

  const update = (change: (next: URLSearchParams) => void) => setParams((current) => { change(current); return current; });
  const set = (key: string, value: string | null) => update((query) => { if (value == null) query.delete(key); else query.set(key, value); });

  // Comparing deploys narrows this period to the newest deploy in it.
  const pair = compareTo === "deploy" ? deployPair(releases, base, params.get("base")) : null;
  const scope: InsightScope = pair ? { ...base, release: pair.current.release } : base;
  let comparison: InsightComparison | null = null;
  if (pair) {
    const window = releaseWindow(pair.base);
    comparison = {
      scope: { ...window, environment, release: pair.base.release },
      key: `deploy|${pair.base.release}|${window.from.slice(0, 16)}`,
      against: <>on <ReleaseLink release={pair.base.release} info={pair.base} /></>,
      totalsComparable: false,
    };
  } else if (compareTo !== "off" && compareTo !== "deploy") {
    const range = compareRange(base, compareTo);
    if (range) comparison = { scope: { ...range, environment }, key: `${compareTo}|${range.from.slice(0, 13)}`, against: compareText(compareTo), totalsComparable: true };
  }

  const deployDetail: ReactNode = compareTo !== "deploy" ? null
    : pair ? <span className="ck-deploy-compare">
      <ReleaseLink release={pair.current.release} info={pair.current} className="is-current" />
      <span className="ck-deploy-vs">vs</span>
      <span className="ck-pill-select ck-deploy-base"><select aria-label="Compare with deploy" value={pair.base.release} onChange={(event) => set("base", event.target.value)}>
        {releases.filter((item) => item.release !== pair.current.release).slice(0, 30).map((item) => <option key={item.release} value={item.release}>{shortRelease(item.release)} · {new Date(item.firstSeen).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: timezone ?? undefined })}</option>)}
      </select><PrototypeIcon name="down" size={12} /></span>
    </span>
    : releasesLoaded ? <span className="ck-deploy-compare ck-deploy-none">One deploy in this period</span> : null;

  const toolbar = <ScopeToolbar
    period={period as Period}
    periods={PERIODS}
    onPeriodChange={(next) => update((query) => {
      if (next === "mtd") query.delete("period"); else query.set("period", next);
      if (next === "custom") {
        // Start from what's on screen, so switching to custom doesn't jump.
        query.set("from", from);
        query.set("to", to);
      } else { query.delete("from"); query.delete("to"); }
    })}
    customTime
    customFrom={isoToZonedInput(from, timezone)}
    customTo={isoToZonedInput(to, timezone)}
    onCustomRangeChange={(nextFrom, nextTo) => update((query) => {
      const fromIso = zonedInputToIso(nextFrom, timezone);
      const toIso = zonedInputToIso(nextTo, timezone);
      if (fromIso) query.set("from", fromIso);
      if (toIso) query.set("to", toIso);
    })}
    environment={environment}
    onEnvironmentChange={(next) => set("environment", next === "all" ? null : next)}
    compare={options.compare ? {
      value: compareTo,
      onChange: (next) => update((query) => { if (next === "off") query.delete("compare"); else query.set("compare", next); query.delete("base"); }),
      deployAvailable: !releasesLoaded || releases.length > 1,
      detail: deployDetail,
    } : undefined}
  />;
  return {
    projectId,
    scope,
    scopeKey: [projectId ?? "", period, environment, from.slice(0, 16), period === "custom" ? to.slice(0, 16) : "", scope.release ?? ""].join("|"),
    currency: workspaceSettings?.reportingCurrency ?? "USD",
    fx: workspaceSettings?.fx,
    toolbar,
    comparison,
  };
}

/**
 * Load per scope and keep it current (every 10 s while the tab is visible).
 * The last result stays on screen while a new one loads.
 */
export function useScopedLoad<T>(key: string | null, load: () => Promise<T>, options: LiveQueryOptions<T> = {}): LiveQuery<T> {
  return useLiveQuery(key, load, options);
}
