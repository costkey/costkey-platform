import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, CircleAlert, Pin, Share } from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";
import {
  calculateForecast,
  getForecast,
  listForecastScenarios,
  saveForecastScenario,
  type ForecastResponse,
  type ForecastScenarioRow,
} from "../api";
import { useAuth } from "../contexts/useAuth";
import {
  EmptyPanel,
  Illustration,
  LoadingRows,
  PageHeader,
  Panel,
  StatusPill,
  type Period,
} from "../components/ConsolePrimitives";
import { formatCurrencyAmount, formatDateTime, formatReportedAmount, periodDates, type ReportingFx } from "../components/consoleFormatters";
import { isPrototypePreview } from "../prototypePreview";
import { PrototypeIcon } from "../components/PrototypeIcon";
import { prototypeRole, prototypeState, PrototypeStateNotice, PrototypeStatePanel } from "../components/PrototypeState";
import "./PrototypeRoute.css";

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return null; }
}

function formatPrototypeUsd(value: number | null | undefined, currency: string, fx?: ReportingFx | null): string {
  if (!isPrototypePreview() || currency.toUpperCase() !== "USD") return formatReportedAmount(value, currency, fx);
  if (value == null || !Number.isFinite(Number(value))) return "Unavailable";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value));
}

function scopeFromQuery(params: URLSearchParams, period: Period, timezone?: string | null): Record<string, unknown> {
  const dates = periodDates(period, timezone ?? undefined);
  const scope: Record<string, unknown> = {
    from: params.get("from") ?? dates.from,
    to: params.get("to") ?? dates.to,
    timezone: timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
  const environment = params.get("environment");
  if (environment && environment !== "all") scope.environment = environment;
  const dimensionKeys = ["feature", "function", "customer", "provider", "model", "group"] as const;
  const groupBy = params.get("groupBy") ?? dimensionKeys.find((key) => params.has(key)) ?? null;
  const groupValue = params.get("groupValue") ?? (groupBy ? params.get(groupBy) : null);
  if (groupBy && groupValue) {
    scope.groupBy = groupBy;
    scope.groupValue = groupValue;
  }
  const contextKey = params.get("contextKey");
  const contextValues = params.getAll("contextValue");
  if (contextKey && contextValues.length > 0) {
    scope.groupBy = "context";
    scope.contextKey = contextKey;
    scope.contextValue = contextValues;
  }
  return scope;
}

const UNIT_LABEL: Record<"operations" | "users" | "conversations", { plural: string; singular: string }> = {
  operations: { plural: "runs", singular: "run" },
  users: { plural: "users", singular: "user" },
  conversations: { plural: "conversations", singular: "conversation" },
};

/** Design-language state card: "At this pace, about $372.90." */
function PaceCard({ forecast, budget, currency, fx, monthToDate }: { forecast: ForecastResponse | null; budget: number | null; currency: string; fx?: ReportingFx | null; monthToDate: boolean }) {
  const pace = forecast?.currentPace;
  const amount = (value: number | null | undefined) => formatReportedAmount(value, currency, fx);
  const month = new Date().toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });
  let title = "Not enough history yet";
  let body = "We need a few complete days of runs before we can estimate the month.";
  if (!monthToDate) {
    title = "Month-end estimate";
    body = "Switch the period to Month to date to see where this month is heading.";
  } else if (pace?.available && pace.projectedCost != null) {
    title = `At this pace, about ${amount(pace.projectedCost)}.`;
    body = budget == null
      ? `That’s your estimated spend by the end of ${month}, based on ${pace.completedElapsedDays} complete day${pace.completedElapsedDays === 1 ? "" : "s"}.`
      : pace.projectedCost <= budget
        ? `Your estimated ${month} spend is below your ${amount(budget)} budget.`
        : `That’s ${amount(pace.projectedCost - budget)} over your ${amount(budget)} budget by the end of ${month}.`;
  } else if (pace?.reason === "incomplete_pricing") {
    body = "Some calls have no price yet, so we won’t guess the month-end total.";
  }
  return (
    <section className="ck-panel ck-pace-card">
      <Illustration name="a-little-ahead" width={200} />
      <div>
        <div className="ck-state-kicker">This month</div>
        <h2>{title}</h2>
        <p>{body}</p>
        
      </div>
    </section>
  );
}

function ForecastResultCard({ forecast, currency, fx, operations, unit, projectId, period, forcedAmount, blocked, stale, calculating }: { forecast: ForecastResponse | null; currency: string; fx?: ReportingFx | null; operations: string; unit: "operations" | "users" | "conversations"; projectId: string; period: Period; forcedAmount?: number | null; blocked?: boolean; stale: boolean; calculating: boolean }) {
  const chosen = forecast?.chosenScale;
  const cash = forecast?.cash;
  const cashAmount = (value: number | null): string => cash?.currency && cash.currency !== "USD" ? formatCurrencyAmount(value, cash.currency) : formatReportedAmount(value, currency, fx);
  const displayAmount = (value: number | null | undefined): string => formatPrototypeUsd(value, currency, fx);
  const labels = UNIT_LABEL[unit];
  const volume = Number(operations || 0);
  const amount = blocked ? null : forcedAmount ?? (chosen?.available && chosen.projectedCost != null ? chosen.projectedCost : null);
  if (blocked) return <div className="prototype-forecast-result-stack">
    <section className="ck-panel prototype-forecast-estimate">
      <div className="prototype-forecast-result-body">
        <div className="ck-metric-label">Estimated cost</div>
        <h2>We can’t estimate this yet</h2>
        <p className="muted mt16">Some calls in this period have no price. Scaling up only the priced ones would understate the cost.</p>
        <div className="mt24"><Link className="ck-button ck-button-secondary" to={`/traces?project=${encodeURIComponent(projectId)}&period=${encodeURIComponent(period)}&accounting=partial`}>See unpriced runs</Link></div>
      </div>
    </section>
  </div>;
  const perUnit = chosen?.costPerOperation ?? forecast?.observed?.meanCostPerOperation ?? null;
  return <div className="prototype-forecast-result-stack">
    <section className="ck-panel prototype-forecast-estimate">
      <div className="prototype-forecast-result-body">
        <div className="ck-metric-label"><span>Estimated cost</span><PrototypeIcon name="telescope" size={16} /></div>
        <div className={`ck-metric-value prototype-forecast-total ${stale ? "is-stale" : ""}`}>{calculating ? "Estimating…" : amount == null ? "—" : `About ${displayAmount(amount)}`}</div>
        <p className="ck-panel-subtitle prototype-forecast-caption">{amount == null ? (chosen?.reason ? "Not enough priced runs to estimate this yet." : "Enter a volume to see an estimate.") : `For ${volume.toLocaleString()} ${volume === 1 ? labels.singular : labels.plural}${perUnit != null ? `, at ${formatReportedAmount(perUnit, currency, fx)} per ${labels.singular}` : ""}.`}</p>
        
        
        {chosen?.selectionBiasWarning && <div className="ck-alert prototype-forecast-warning"><CircleAlert size={14} /><div>Runs with missing prices were left out, so this may run a little low.</div></div>}
        
        {cash?.available && <details className="prototype-explain"><summary>Credits and what you’d pay</summary><div className="prototype-cloud-body">{cash ? <dl className="ck-definition-list"><div><dt>Before credits</dt><dd>{cashAmount(cash.originalAmount)}</dd></div><div><dt>Credits that apply</dt><dd>{cashAmount(cash.eligibleCredits)}</dd></div><div><dt>You’d pay</dt><dd>{cashAmount(cash.estimatedPayable)}</dd></div>{!cash.available && cash.reason && <div><dt>Note</dt><dd>{cash.reason}</dd></div>}</dl> : <><p className="ck-panel-subtitle">Have provider or cloud credits? Add them to see what you’d actually pay.</p><Link className="ck-text-link" to={`/settings?section=pricing&state=credit-form&project=${encodeURIComponent(projectId)}`}>Add credits <ArrowRight size={12} /></Link></>}</div></details>}
      </div>
    </section>
  </div>;
}

export default function Forecast() {
  const { currentProjectId, projects, org, workspaceSettings, user, setCurrentProjectId } = useAuth();
  const projectId = currentProjectId ?? projects[0]?.id ?? null;
  const [params, setParams] = useSearchParams();
  const sharedProjectId = params.get("project");
  const previewState = params.get("state");
  const previewLoading = previewState === "loading";
  const previewEmpty = previewState === "empty";
  const previewError = previewState === "error" ? "The captured baseline could not be refreshed. No scenario was saved." : null;
  const [period, setPeriod] = useState<Period>(params.get("period") === "7d" ? "7d" : params.get("period") === "30d" ? "30d" : "mtd");
  const [forecast, setForecast] = useState<ForecastResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [calculating, setCalculating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [operations, setOperations] = useState("50000");
  const [unit, setUnit] = useState<"operations" | "users" | "conversations">("operations");
  const [operationsPerUser, setOperationsPerUser] = useState("10");
  const [manualCost, setManualCost] = useState("");
  const [targetDays, setTargetDays] = useState("30");
  const [saveName, setSaveName] = useState("");
  const [showSaveForm, setShowSaveForm] = useState(false);
  const [savedId, setSavedId] = useState<string | null>(params.get("scenario"));
  const [resultInputKey, setResultInputKey] = useState<string | null>(null);
  const [visibility, setVisibility] = useState<"private" | "workspace">("private");
  const [scenarios, setScenarios] = useState<ForecastScenarioRow[]>([]);
  const [shareFallback, setShareFallback] = useState<string | null>(null);
  const [budget, setBudget] = useState<number | null>(null);
  const autoCalculatedFor = useRef<string | null>(null);
  const workspaceTimezone = workspaceSettings?.timezone ?? org?.timezone;
  const reportingCurrency = workspaceSettings?.reportingCurrency ?? "USD";
  const fx = workspaceSettings?.fx;
  const prototype = isPrototypePreview();
  const baseScope = scopeFromQuery(params, period, workspaceTimezone);
  const paramGroupBy = params.get("groupBy") ?? ["feature", "function", "customer", "provider", "model", "group"].find((key) => params.has(key)) ?? null;
  const paramGroupValue = params.get("groupValue") ?? (paramGroupBy ? params.get(paramGroupBy) : null);
  // The design fixture opens the forecast scoped to Search; mirror that default in preview mode only.
  const scopeIsDefault = prototype && paramGroupBy == null && paramGroupValue == null;
  const groupBy = paramGroupBy ?? (scopeIsDefault ? "feature" : null);
  const groupValue = paramGroupValue ?? (scopeIsDefault ? "Search" : null);
  const requestedFrom = params.get("from");
  const requestedTo = params.get("to");
  const scopeOverride = requestedFrom && requestedTo && Number.isFinite(new Date(requestedFrom).getTime()) && Number.isFinite(new Date(requestedTo).getTime()) && new Date(requestedFrom) < new Date(requestedTo) ? { from: requestedFrom, to: requestedTo } : null;
  // Scope identity without the live "to" timestamp, which moves every render.
  const scopeSignature = JSON.stringify({ params: [...params.entries()].filter(([key]) => key !== "scenario" && key !== "state"), period, timezone: workspaceTimezone ?? null });
  const currentInputKey = JSON.stringify({ scope: scopeSignature, unit, operations, operationsPerUser, manualCost, targetDays });
  const resultIsStale = resultInputKey !== null && resultInputKey !== currentInputKey;

  useEffect(() => {
    if (sharedProjectId && projects.some((project) => project.id === sharedProjectId) && sharedProjectId !== currentProjectId) setCurrentProjectId(sharedProjectId);
  }, [sharedProjectId, projects, currentProjectId, setCurrentProjectId]);

  useEffect(() => {
    if (!projectId || (sharedProjectId && projects.some((project) => project.id === sharedProjectId) && sharedProjectId !== currentProjectId)) return;
    let cancelled = false;
    setLoading(true); setError(null);
    getForecast(projectId, scopeFromQuery(params, period, workspaceTimezone)).then((result) => { if (!cancelled) setForecast(result.forecast); }).catch((reason: unknown) => { if (!cancelled) setError(reason instanceof Error ? reason.message : "Could not load forecast"); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [projectId, params, period, workspaceTimezone, sharedProjectId, projects, currentProjectId]);

  useEffect(() => {
    if (!projectId) return;
    listForecastScenarios(projectId).then((result) => setScenarios(result.scenarios ?? [])).catch(() => setScenarios([]));
  }, [projectId, savedId]);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    fetch(`/api/v1/projects/${projectId}/budget/policies`, { credentials: "include" })
      .then(async (response) => response.ok ? response.json() as Promise<{ policies?: Array<{ status: string; unit: string; window: string; allowance: number; scope?: Record<string, string> | null }> }> : { policies: [] })
      .then((result) => {
        if (cancelled) return;
        // Only a whole-project monthly money budget is comparable to the projection.
        const monthly = (result.policies ?? []).find((policy) => policy.status === "active" && policy.unit === "money" && policy.window === "calendar_month"
          && Object.keys(policy.scope ?? {}).every((key) => key === "project"));
        setBudget(monthly ? Number(monthly.allowance) || null : null);
      })
      .catch(() => { if (!cancelled) setBudget(null); });
    return () => { cancelled = true; };
  }, [projectId]);

  async function calculate(): Promise<void> {
    if (!projectId) return;
    const calculatedInputKey = currentInputKey;
    setCalculating(true); setError(null); setSavedId(null); setShareFallback(null);
    try {
      const result = await calculateForecast(projectId, {
        ...baseScope,
        volumeUnit: unit,
        operations: unit === "operations" ? Number(operations) : undefined,
        users: unit === "users" ? Number(operations) : undefined,
        conversations: unit === "conversations" ? Number(operations) : undefined,
        operationsPerUser: unit === "users" ? Number(operationsPerUser) : undefined,
        assumedCostPerOperation: manualCost ? Number(manualCost) : undefined,
        targetPeriodDays: Number(targetDays),
      });
      setForecast(result.forecast);
      setResultInputKey(calculatedInputKey);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Couldn’t estimate this. Try again."); } finally { setCalculating(false); }
  }

  // Estimate the default volume as soon as the baseline loads, so the result
  // card never shows a number that belongs to a different question.
  useEffect(() => {
    if (!projectId || loading || !forecast?.observed?.observations || autoCalculatedFor.current === scopeSignature || params.get("scenario")) return;
    autoCalculatedFor.current = scopeSignature;
    void calculate();
    // calculate reads the current inputs; it should run once per scope.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, loading, forecast, scopeSignature]);

  // Inputs re-estimate on their own once typing settles; there is no Estimate button.
  useEffect(() => {
    if (!resultIsStale || calculating || !Number(operations) || Number(operations) <= 0) return;
    const timer = window.setTimeout(() => { void calculate(); }, 450);
    return () => window.clearTimeout(timer);
    // calculate reads the current inputs captured by currentInputKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentInputKey, resultIsStale, calculating]);

  async function save(): Promise<void> {
    if (!projectId || !saveName.trim() || !forecast || resultIsStale) return;
    try {
      const result = await saveForecastScenario(projectId, {
        name: saveName.trim(),
        scope: baseScope,
        shared: visibility === "workspace",
        assumptions: {
          volumeUnit: unit,
          volume: Number(operations),
          operations: unit === "operations" ? Number(operations) : undefined,
          users: unit === "users" ? Number(operations) : undefined,
          conversations: unit === "conversations" ? Number(operations) : undefined,
          operationsPerUser: unit === "users" ? Number(operationsPerUser) : undefined,
          assumedCostPerOperation: manualCost ? Number(manualCost) : undefined,
          targetPeriodDays: Number(targetDays),
        },
      });
      setSavedId(result.id); setSaveName(""); setShowSaveForm(false);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Couldn’t save this scenario."); }
  }

  function share(): void {
    if (!savedId) return;
    const url = new URL(window.location.href);
    url.searchParams.set("scenario", savedId); url.searchParams.set("project", projectId);
    const value = url.toString();
    setShareFallback(null);
    void navigator.clipboard.writeText(value).catch(() => setShareFallback(value));
  }

  const openScenario = useCallback((scenario: ForecastScenarioRow): void => {
    const assumptions = parseJson(scenario.assumptions);
    const result = parseJson(scenario.result) as ForecastResponse | null;
    let scenarioUnit: typeof unit = "operations";
    let scenarioOperations = "50000";
    let scenarioOperationsPerUser = "10";
    let scenarioManualCost = "";
    let scenarioTargetDays = "30";
    if (assumptions && typeof assumptions === "object") {
      const input = assumptions as Record<string, unknown>;
      if (input["volumeUnit"] === "operations" || input["volumeUnit"] === "users" || input["volumeUnit"] === "conversations") scenarioUnit = input["volumeUnit"];
      const storedVolume = input["volume"] ?? input[scenarioUnit] ?? input["operations"];
      if (typeof storedVolume === "number") scenarioOperations = String(storedVolume);
      if (typeof input["operationsPerUser"] === "number") scenarioOperationsPerUser = String(input["operationsPerUser"]);
      if (typeof input["assumedCostPerOperation"] === "number") scenarioManualCost = String(input["assumedCostPerOperation"]);
      if (typeof input["targetPeriodDays"] === "number") scenarioTargetDays = String(input["targetPeriodDays"]);
    }
    setOperations(scenarioOperations);
    setUnit(scenarioUnit);
    setOperationsPerUser(scenarioOperationsPerUser);
    setManualCost(scenarioManualCost);
    setTargetDays(scenarioTargetDays);
    if (result) setForecast(result);
    setResultInputKey(JSON.stringify({ scope: scopeSignature, unit: scenarioUnit, operations: scenarioOperations, operationsPerUser: scenarioOperationsPerUser, manualCost: scenarioManualCost, targetDays: scenarioTargetDays }));
    setSavedId(scenario.id); setVisibility(scenario.shared ? "workspace" : "private");
  }, [scopeSignature]);

  useEffect(() => {
    const scenarioId = params.get("scenario");
    if (!scenarioId || !scenarios.length) return;
    const scenario = scenarios.find((item) => item.id === scenarioId);
    if (scenario) openScenario(scenario);
    // A saved scenario is opened only when the authenticated API returns it.
  }, [scenarios, params, openScenario]);

  if (!projectId) return <div className="ck-main-inner"><PageHeader title="Forecasts" /><Panel><EmptyPanel illustration="a-little-ahead" title="Forecasts need a few runs first" action={<Link className="ck-button ck-button-primary" to="/onboarding">Connect a project</Link>} /></Panel></div>;
  if (sharedProjectId && projects.some((project) => project.id === sharedProjectId) && sharedProjectId !== currentProjectId) return <div className="ck-main-inner"><PageHeader title="Opening shared scenario" /><Panel><LoadingRows count={5} columns={3} /></Panel></div>;
  const explicitState = prototypeState(params);
  const effectiveRole = prototypeRole(params, user?.role ?? "viewer");
  // Sparse renders the inline manual-estimate variant (prototype), not the
  // shared full-page empty treatment.
  const namedState = prototype && explicitState === "sparse" ? null : PrototypeStatePanel({ state: explicitState, family: "Forecast", title: explicitState === "error" ? "Couldn’t load the forecast" : undefined, backHref: "/overview", retryHref: `/forecast${window.location.search}`, loadingRows: 5 });
  if (namedState) return namedState;

  const updatePeriod = (next: Period): void => {
    if (next === "custom") {
      const dates = periodDates("30d", workspaceTimezone ?? undefined);
      setPeriod(next);
      setParams((current) => { current.set("period", "custom"); current.set("from", dates.from); current.set("to", dates.to); return current; });
      return;
    }
    setPeriod(next);
    setParams((current) => { current.set("period", next); current.delete("from"); current.delete("to"); return current; });
  };
  // Preview-only cohort states mirror the prototype's inline variants.
  const previewPartial = prototype && explicitState === "partial";
  const previewSparse = prototype && explicitState === "sparse";
  const previewAssumedCost = manualCost.trim() ? manualCost : "0.119";
  const previewSparseAmount = previewSparse ? Number(operations || 0) * Number(previewAssumedCost) : null;
  const filterLabel = !scopeIsDefault && groupBy && groupValue ? `${groupBy[0].toUpperCase()}${groupBy.slice(1)}: ${groupValue}` : null;
  const selectedPeriod = scopeOverride ? "custom" : period;
  const estimateActions = <>
    <button className="ck-button ck-button-secondary" type="button" onClick={() => setShowSaveForm(true)} disabled={!forecast?.chosenScale?.available || resultIsStale}><Pin size={14} /> Save scenario</button>
    {savedId && <button className="ck-button ck-button-secondary" type="button" onClick={share} disabled={resultIsStale}><Share size={14} /> {shareFallback ? "Try copy again" : "Copy link"}</button>}
  </>;
  const labels = UNIT_LABEL[unit];
  return (
    <div className="ck-main-inner prototype-forecast-route">
      <PageHeader title="Forecasts" actions={estimateActions} />
      {filterLabel && <div className="ck-filter-chips"><StatusPill tone="info" icon={false}>{filterLabel}</StatusPill><button className="ck-button ck-button-quiet sm" type="button" onClick={() => setParams((current) => { current.delete("groupBy"); current.delete("groupValue"); ["feature", "function", "customer", "provider", "model", "group"].forEach((key) => current.delete(key)); return current; })}>Clear</button></div>}
      <PrototypeStateNotice state={explicitState} family="forecast" role={effectiveRole} />
      {showSaveForm && <Panel title="Save this scenario"><form className="ck-form-footer" onSubmit={(event) => { event.preventDefault(); void save(); }}><input className="ck-input" aria-label="Scenario name" value={saveName} onChange={(event) => setSaveName(event.target.value)} placeholder="Scenario name" required /><select className="ck-select" aria-label="Scenario access" value={visibility} onChange={(event) => setVisibility(event.target.value as typeof visibility)}><option value="private">Only me</option><option value="workspace" disabled={effectiveRole === "viewer"}>Whole workspace</option></select><button className="ck-button ck-button-primary" type="submit" disabled={!saveName.trim() || effectiveRole === "viewer" && visibility === "workspace"}>Save</button><button className="ck-button ck-button-quiet" type="button" onClick={() => setShowSaveForm(false)}>Cancel</button></form></Panel>}
      {!loading && !previewLoading && <PaceCard forecast={previewEmpty ? null : forecast} budget={budget} currency={reportingCurrency} fx={fx} monthToDate={selectedPeriod === "mtd"} />}
      <div className="ck-content-grid prototype-forecast-grid">
        <Panel title="What would more usage cost?">
          <div className="ck-form">
            <div className="ck-form-grid grid grid-cols-1 md:grid-cols-2">
              <div className="ck-form-field"><label htmlFor="forecast-unit">Measure in</label><span className="ck-form-select-wrap"><select id="forecast-unit" className="ck-select" value={unit} onChange={(event) => setUnit(event.target.value as typeof unit)}><option value="operations">Runs</option><option value="users">Users</option><option value="conversations">Conversations</option></select><PrototypeIcon name="down" size={14} /></span></div>
              <div className="ck-form-field"><label htmlFor="forecast-timeframe">Average from</label><span className="ck-form-select-wrap"><select id="forecast-timeframe" className="ck-select" value={selectedPeriod} onChange={(event) => updatePeriod(event.target.value as Period)}><option value="mtd">{prototype ? "October 2026" : "Month to date"}</option><option value="7d">Last 7 days</option><option value="30d">Last 30 days</option><option value="24h">Last 24 hours</option><option value="custom">Custom range</option></select><PrototypeIcon name="down" size={14} /></span></div>
            </div>
            <div className="ck-form-field"><label htmlFor="forecast-volume">How many {labels.plural}?</label><input id="forecast-volume" className="ck-input" type="number" min="1" step="1" value={operations} onChange={(event) => setOperations(event.target.value)} />{unit === "users" && <label className="ck-inline-field" htmlFor="forecast-ops-user">Runs per user <input id="forecast-ops-user" className="ck-input" type="number" min="1" step="1" value={operationsPerUser} onChange={(event) => setOperationsPerUser(event.target.value)} /></label>}{unit === "conversations" && <small>Uses the conversation label your app sends with each run.</small>}</div>
            <details className="ck-form-section"><summary>Adjust assumptions</summary><div className="ck-form-section-copy"><div className="ck-form-field" style={{ marginTop: 12 }}><label htmlFor="forecast-manual">Cost per {labels.singular} ({reportingCurrency})</label><input id="forecast-manual" className="ck-input" type="number" min="0" step="0.0001" value={manualCost} onChange={(event) => setManualCost(event.target.value)} placeholder="Use my average" /></div><div className="ck-form-grid" style={{ marginTop: 12 }}><div className="ck-form-field"><label htmlFor="forecast-days">Over how many days</label><input id="forecast-days" className="ck-input" type="number" min="1" value={targetDays} onChange={(event) => setTargetDays(event.target.value)} /></div></div></div></details>
            
            {(error || previewError) && <div className="ck-form-error" role="alert">{previewError ?? error}</div>}
          </div>
        </Panel>
        <div className="ck-stack">
          {previewSparse && <div className="ck-alert ck-alert-warning" role="status"><CircleAlert size={14} /><div><strong>Not enough runs to average yet.</strong> The estimate below uses your assumed ${Number(previewAssumedCost).toFixed(4)} per run.</div></div>}
          {previewSparse && <div className="ck-form-field"><label htmlFor="forecast-assumed">Cost per run (USD)</label><input id="forecast-assumed" className="ck-input" type="number" min="0" step="0.001" value={manualCost || "0.119"} onChange={(event) => setManualCost(event.target.value)} /><small>Your assumption, not measured.</small></div>}
          {loading || previewLoading ? <Panel title="Estimated cost"><LoadingRows count={5} columns={2} /></Panel> : <ForecastResultCard forecast={previewEmpty ? null : forecast} currency={reportingCurrency} fx={fx} operations={operations} unit={unit} projectId={projectId} period={selectedPeriod} forcedAmount={previewSparseAmount} blocked={previewPartial} stale={resultIsStale} calculating={calculating} />}
        </div>
      </div>
      {shareFallback && <label className="ck-share-fallback" style={{ marginTop: 14 }}>Copy this link<input readOnly value={shareFallback} onFocus={(event) => event.currentTarget.select()} /></label>}
      <details className="prototype-saved-scenarios"><summary>Saved scenarios{scenarios.length > 0 ? ` (${scenarios.length})` : ""}</summary>{scenarios.length === 0 ? <p className="ck-table-note" style={{ borderTop: 0 }}>No saved scenarios yet.</p> : <div className="ck-saved-scenarios">{scenarios.map((scenario) => <button className="ck-saved-scenario" type="button" key={scenario.id} onClick={() => openScenario(scenario)}><span><strong>{scenario.name}</strong><small>{scenario.shared ? "Whole workspace" : "Only me"} · {formatDateTime(scenario.updated_at || scenario.calculated_at)}</small></span><ArrowRight size={13} /></button>)}</div>}</details>
    </div>
  );
}
