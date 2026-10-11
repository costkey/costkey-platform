import { useEffect, useState } from "react";
import { ArrowRight, ChevronLeft, ChevronRight, CircleAlert, Download, Layers3, Users } from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";
import { getCostBreakdown, getCostContributor, type CostContributor, type CostDimension, type CostBreakdownResponse, type CostContributorDetailResponse, type CostContributorDistributionRow, type CostContributorHistoryRow, type CostContributorMetric, type CostContributorPolicyActions, type CostContributorTraceRow } from "../api";
import { useAuth } from "../contexts/useAuth";
import { Delta, EmptyPanel, LoadingRows, PageHeader, Panel, ScopeToolbar, StatusPill, type Period } from "../components/ConsolePrimitives";
import { dateInputToIso, formatAbsoluteDate, formatDateTime, formatPercent, formatReportedAmount, parsePeriod, periodDates, reportingCurrencyNote, type ReportingFx } from "../components/consoleFormatters";
import { isPrototypePreview } from "../prototypePreview";
import { prototypeRole, prototypeState, PrototypeStateNotice, PrototypeStatePanel } from "../components/PrototypeState";
import "./PrototypeRoute.css";
import { ProviderLabel } from "../components/ProviderLogo";

/** Agent and tool are context labels the SDK stamps on every call inside a span. */
type GroupBy = CostDimension | "agent" | "tool";

function apiGrouping(groupBy: GroupBy, contextKey: string | null | undefined): { groupBy: CostDimension; contextKey: string | undefined } {
  if (groupBy === "agent" || groupBy === "tool") return { groupBy: "context", contextKey: groupBy };
  return { groupBy, contextKey: contextKey ?? undefined };
}

interface CostRow {
  id: string;
  name: string;
  secondary: string;
  cost: number | null;
  observations: number;
  traces: number;
  unit: number | null;
  coverage: number | null;
  unpriced: number;
  changePct: number | null;
  inferred: boolean;
}

interface CostData {
  rows: CostRow[];
  total: number;
  limit: number;
  offset: number;
  knownCost: number | null;
  observations: number;
  runs: number;
  unpriced: number;
  coverage: number | null;
  availableDimensions: string[];
  contextKeys: string[];
  environmentOptions: string[];
}

const EMPTY_COST_DATA: CostData = { rows: [], total: 0, limit: 25, offset: 0, knownCost: null, observations: 0, runs: 0, unpriced: 0, coverage: null, availableDimensions: [], contextKeys: [], environmentOptions: [] };

interface FeatureMapping {
  id: string;
  feature: string;
  match: { provider?: string; model?: string; file?: string; function?: string; environment?: string; context?: Record<string, string> };
  enabled: boolean;
  created_at?: string;
}

function rowFromContributor(row: CostContributor): CostRow {
  const cost = row.known_cost !== undefined ? row.known_cost : row.cost;
  const observations = Number(row.observations ?? row.calls ?? 0) || 0;
  // The Traces column counts distinct traces; call-level groupings also fan out
  // into multiple calls per trace (prototype `by()` uses traceIds.size).
  const traces = Number((row as { trace_count?: unknown }).trace_count ?? observations) || 0;
  const unpriced = Number(row.unpriced_count) || 0;
  const unit = row.unit_cost == null ? (observations - unpriced > 0 && cost != null ? Number(cost) / (observations - unpriced) : null) : Number(row.unit_cost);
  const rawChange = row.change_pct == null ? null : Number(row.change_pct);
  const changePct = rawChange == null || !Number.isFinite(rawChange) ? null : Math.abs(rawChange) <= 1 ? rawChange * 100 : rawChange;
  const rawName = String(row.label ?? row.name ?? row.key ?? "(unassigned)");
  return { id: String(row.key ?? row.name ?? row.label ?? "unknown"), name: rawName === "(unassigned)" ? "Not labelled" : rawName, secondary: String(row.secondary ?? ""), cost: cost == null ? null : Number(cost), observations, traces, unit: Number.isFinite(Number(unit)) ? Number(unit) : null, coverage: row.coverage == null ? (observations > 0 ? (observations - unpriced) / observations : null) : Number(row.coverage), unpriced, changePct, inferred: row.inferred === true };
}

function formatPrototypeUnitCost(value: number | null, currency: string, fx?: ReportingFx | null): string {
  if (isPrototypePreview() && currency.toUpperCase() === "USD" && value != null && Number.isFinite(value)) return `$${value.toFixed(4)}`;
  return formatReportedAmount(value, currency, fx);
}

function useCostData(projectId: string | null, groupBy: GroupBy, period: Period, reload: number, timezone?: string | null, contextKey?: string | null, environment?: string, groupValue?: string | null, scopeOverride?: { from: string; to: string } | null, limit = 25, offset = 0) {
  const overrideFrom = scopeOverride?.from;
  const overrideTo = scopeOverride?.to;
  const requestKey = [projectId ?? "none", groupBy, groupValue ?? "", period, reload, timezone ?? "", contextKey ?? "", environment ?? "all", overrideFrom ?? "", overrideTo ?? "", limit, offset].join("\u0001");
  const [state, setState] = useState<{ key: string; data: CostData; error: string | null }>({ key: "", data: EMPTY_COST_DATA, error: null });
  const contextReady = groupBy !== "context" || Boolean(contextKey);
  const loading = Boolean(projectId) && contextReady && state.key !== requestKey;
  const data = state.key === requestKey ? state.data : EMPTY_COST_DATA;
  const contextKeys = state.data.contextKeys;
  const error = state.key === requestKey ? state.error : null;
  useEffect(() => {
    if (!projectId || (groupBy === "context" && !contextKey)) return;
    let cancelled = false;
    const { from, to } = overrideFrom && overrideTo ? { from: overrideFrom, to: overrideTo } : periodDates(period, timezone ?? undefined);
    const api = apiGrouping(groupBy, contextKey);
    getCostBreakdown(projectId, { groupBy: api.groupBy, groupValue: groupValue ?? undefined, from, to, contextKey: api.contextKey, environment: environment && environment !== "all" ? environment : undefined, limit, offset }).then((result: CostBreakdownResponse) => {
      if (cancelled) return;
      const rows = (result.contributors ?? []).map(rowFromContributor).sort((a, b) => (b.cost ?? -1) - (a.cost ?? -1));
      const totals = result.totals ?? {};
      const availableDimensions = (result.availableDimensions ?? []).map(String);
      const contextKeys = result.availableFilters?.contextKeys ?? availableDimensions.filter((dimension) => dimension.startsWith("context:")).map((dimension) => dimension.slice("context:".length));
      const total = result.total == null ? rows.length : Number(result.total) || 0;
      setState({ key: requestKey, data: { rows, total, limit, offset, knownCost: totals.known_cost == null ? null : Number(totals.known_cost), observations: Number(totals.observations) || rows.reduce((sum, row) => sum + row.observations, 0), runs: Number((totals as { trace_count?: unknown }).trace_count) || 0, unpriced: Number(totals.unpriced_count) || rows.reduce((sum, row) => sum + row.unpriced, 0), coverage: totals.coverage == null ? null : Number(totals.coverage), availableDimensions, contextKeys, environmentOptions: result.availableFilters?.environments ?? [] }, error: null });
    }).catch((reason: unknown) => { if (!cancelled) setState({ key: requestKey, data: EMPTY_COST_DATA, error: reason instanceof Error ? reason.message : "Could not load cost breakdown" }); });
    return () => { cancelled = true; };
  }, [projectId, groupBy, groupValue, period, reload, timezone, contextKey, environment, requestKey, overrideFrom, overrideTo, limit, offset]);
  const environmentOptions = state.data.environmentOptions;
  return { data, loading, error, contextKeys, environmentOptions };
}

function GroupSelector({ value, onChange, available }: { value: GroupBy; onChange: (value: GroupBy) => void; available: string[] }) {
  const options: Array<{ value: GroupBy; label: string }> = [{ value: "feature", label: "Feature" }, { value: "function", label: "Function" }, { value: "model", label: "Model" }, { value: "provider", label: "Provider" }, { value: "customer", label: "Customer" }, { value: "agent", label: "Agent" }, { value: "tool", label: "Tool" }, { value: "context", label: "Custom label" }];
  const hasContext = available.some((dimension) => dimension === "context" || dimension.startsWith("context:"));
  return <label className="ck-group-selector"><span className="sr-only">Group costs by</span><select id="cost-group" className="ck-select" style={{ width: 190 }} value={value} onChange={(event) => onChange(event.target.value as GroupBy)}>{options.map((option) => { const supported = option.value === "context" ? hasContext : option.value === "agent" || option.value === "tool" ? available.includes(`context:${option.value}`) : available.length === 0 || available.includes(option.value); return <option key={option.value} value={option.value} disabled={available.length > 0 && !supported}>{option.label}{available.length > 0 && !supported ? " (no data yet)" : ""}</option>; })}</select></label>;
}

function ContextKeySelector({ value, onChange, contextKeys }: { value: string | null; onChange: (value: string | null) => void; contextKeys: string[] }) {
  return <div className="ck-filter-group"><label className="ck-filter-label" htmlFor="cost-context-key">Label</label><select id="cost-context-key" className="ck-select" value={value ?? ""} onChange={(event) => onChange(event.target.value || null)} disabled={contextKeys.length === 0}><option value="">{contextKeys.length === 0 ? "No custom labels yet" : "Choose a label"}</option>{contextKeys.map((key) => <option key={key} value={key}>{key}</option>)}</select></div>;
}

function CostTable({ rows, totalCost, currency, fx, groupBy, contextKey, projectId, scopeSearch, onSelect }: { rows: CostRow[]; totalCost: number | null; currency: string; fx?: ReportingFx | null; groupBy: GroupBy; contextKey: string | null; projectId: string; scopeSearch: string; onSelect: (row: CostRow) => void }) {
  const groupLabel = groupBy === "context" ? "Label" : groupBy.charAt(0).toUpperCase() + groupBy.slice(1);
  return <div className="ck-table-wrap"><table className="ck-table ck-costs-table" style={{ lineHeight: 1.3 }}><thead><tr><th>{groupLabel}</th><th className="numeric">Cost ({currency})</th><th className="numeric ck-cost-hide-mobile">Share</th><th className="numeric ck-cost-hide-mobile">Runs</th><th className="numeric ck-cost-hide-mobile">Per run</th></tr></thead><tbody>{rows.map((row) => { const contributorParams = new URLSearchParams(scopeSearch.replace(/^\?/, "")); const linkGrouping = apiGrouping(groupBy, contextKey); contributorParams.set("type", linkGrouping.groupBy); contributorParams.set("name", row.id); if (linkGrouping.contextKey) contributorParams.set("contextKey", linkGrouping.contextKey); else contributorParams.delete("contextKey"); contributorParams.set("project", projectId); return <tr key={row.id} style={{ lineHeight: 1.3 }}><td className="primary-cell" style={{ paddingTop: 11, paddingBottom: 11 }}><Link className="ck-table-link" to={`/contributor?${contributorParams.toString()}`} state={{ from: `/costs${scopeSearch}` }} onClick={() => onSelect(row)}>{groupBy === "provider" ? <ProviderLabel provider={row.id} size={14} /> : row.name}</Link>{row.name !== "Not labelled" && (row.secondary || row.inferred) && <div className="muted">{row.secondary}{row.inferred ? `${row.secondary ? " · " : ""}inferred` : ""}</div>}</td><td className="numeric ck-cost-cell" style={{ paddingTop: 11, paddingBottom: 11 }}>{row.cost == null ? "Unpriced" : formatReportedAmount(row.cost, currency, fx)}</td><td className="numeric ck-cost-hide-mobile" style={{ paddingTop: 11, paddingBottom: 11 }}>{totalCost && row.cost != null ? formatPercent(row.cost / totalCost * 100) : "—"}</td><td className="numeric ck-cost-hide-mobile" style={{ paddingTop: 11, paddingBottom: 11 }}>{row.traces.toLocaleString()}{row.unpriced > 0 ? <span className="muted"> · {row.unpriced} unpriced</span> : null}</td><td className="numeric ck-cost-hide-mobile" style={{ paddingTop: 11, paddingBottom: 11 }}>{row.unit == null ? "—" : formatPrototypeUnitCost(row.unit, currency, fx)}</td></tr>; })}</tbody></table></div>;
}

function CostPagination({ offset, limit, total, onOffsetChange, onLimitChange }: { offset: number; limit: number; total: number; onOffsetChange: (offset: number) => void; onLimitChange: (limit: number) => void }) {
  if (total <= 0) return null;
  if (total <= limit) return null;
  const first = offset + 1;
  const last = Math.min(offset + limit, total);
  const canPrevious = offset > 0;
  const canNext = last < total;
  return <nav className="ck-pagination" aria-label="Pages"><span>Showing {first}–{last} of {total.toLocaleString()}</span><div><label className="ck-pagination-size">Rows <select className="ck-select" value={limit} onChange={(event) => onLimitChange(Number(event.target.value))}><option value={25}>25</option><option value={50}>50</option><option value={100}>100</option></select></label><button className="ck-button ck-button-quiet" type="button" aria-label="Previous page" disabled={!canPrevious} onClick={() => onOffsetChange(Math.max(0, offset - limit))}><ChevronLeft size={13} /> Previous</button><span className="ck-pagination-page">Page {Math.floor(offset / limit) + 1} of {Math.max(1, Math.ceil(total / limit))}</span><button className="ck-button ck-button-quiet" type="button" aria-label="Next page" disabled={!canNext} onClick={() => onOffsetChange(offset + limit)}>Next <ChevronRight size={13} /></button></div></nav>;
}

function metricAmount(metric: CostContributorMetric | undefined, currency: string, fx?: ReportingFx | null): string {
  return metric?.known_cost == null ? "Unpriced" : formatReportedAmount(metric.known_cost, currency, fx);
}

function ContributorSummary({ summary, baseline, currency, fx }: { summary?: CostContributorMetric; baseline?: CostContributorMetric; currency: string; fx?: ReportingFx | null }) {
  if (!summary) return <p className="ck-table-note" style={{ borderTop: 0 }}>No summary for this period yet.</p>;
  return <div className="ck-contributor-detail-section"><div className="ck-inspector-section-title"><span>Summary</span><span>{summary.period ? `${formatDateTime(summary.period.from)} → ${formatDateTime(summary.period.to)}` : "Selected period"}</span></div><div className="ck-contributor-summary-grid"><div><span className="ck-overline">Spend</span><strong>{metricAmount(summary, currency, fx)}</strong></div><div><span className="ck-overline">Calls</span><strong>{summary.observations.toLocaleString()}</strong></div><div><span className="ck-overline">Per {summary.unit_basis === "trace" ? "run" : summary.unit_basis || "run"}</span><strong>{summary.unit_cost == null ? "Unpriced" : formatReportedAmount(summary.unit_cost, currency, fx)}</strong></div><div><span className="ck-overline">Priced</span><strong>{summary.coverage == null ? "—" : `${Math.round(summary.coverage * 100)}%`}</strong></div></div>{baseline && <div className="ck-contributor-baseline"><div><span className="ck-overline">Previous period</span><strong>{metricAmount(baseline, currency, fx)}</strong><small>{baseline.period ? `${formatDateTime(baseline.period.from)} → ${formatDateTime(baseline.period.to)}` : "Same length, just before"}</small></div><div><span className="ck-overline">Per run then</span><strong>{baseline.unit_cost == null ? "Unpriced" : formatReportedAmount(baseline.unit_cost, currency, fx)}</strong></div><div><span className="ck-overline">Change</span><strong>{baseline.change_pct == null ? "No earlier period" : <Delta value={baseline.change_pct} comparison="before" />}</strong><small>{baseline.change_abs == null ? "" : `${formatReportedAmount(Math.abs(baseline.change_abs), currency, fx)} ${baseline.change_abs >= 0 ? "more" : "less"}`}</small></div></div>}</div>;
}

function DistributionBlock({ title, rows, currency, fx }: { title: string; rows?: CostContributorDistributionRow[]; currency: string; fx?: ReportingFx | null }) {
  if (!rows || rows.length === 0) return null;
  return <div className="ck-contributor-related-block"><div className="ck-inspector-section-title"><span>{title}</span></div><div className="ck-component-list">{rows.slice(0, 8).map((item) => <div className="ck-component-row" key={`${title}-${item.key}`}><span>{item.label}</span><span>{item.known_cost == null ? "Unpriced" : formatReportedAmount(item.known_cost, currency, fx)} · {item.observations.toLocaleString()} call{item.observations === 1 ? "" : "s"}</span></div>)}</div>{rows.length > 8 && <p className="ck-table-note" style={{ borderTop: 0, paddingLeft: 0, paddingRight: 0 }}>Top 8 shown.</p>}</div>;
}

function PolicyContext({ actions }: { actions?: CostContributorPolicyActions }) {
  const policies = actions?.policies ?? [];
  const decisions = actions?.decisions ?? [];
  const firings = [...(actions?.firings ?? []), ...(actions?.legacyFirings ?? [])];
  if (policies.length === 0 && decisions.length === 0 && firings.length === 0) return <p className="ck-table-note" style={{ borderTop: 0 }}>No budget covers this yet.</p>;
  return <div className="ck-contributor-policy-context">{policies.length > 0 && <div><div className="ck-inspector-section-title"><span>Budgets that apply</span></div><div className="ck-component-list">{policies.slice(0, 6).map((policy) => <div className="ck-component-row" key={String(policy["id"] ?? policy["policy_id"] ?? policy["name"])}><span>{String(policy["name"] ?? policy["id"] ?? "Policy")}</span><span>{String(policy["mode"] ?? "unknown")} · {String(policy["status"] ?? "unknown")}</span></div>)}</div></div>}{decisions.length > 0 && <div><div className="ck-inspector-section-title"><span>Calls stopped or allowed</span></div><div className="ck-component-list">{decisions.slice(0, 6).map((decision, index) => <div className="ck-component-row" key={`${String(decision["policy_id"] ?? "policy")}-${String(decision["created_at"] ?? index)}`}><span>{String(decision["decision"] ?? "unknown")} · {String(decision["policy_id"] ?? "policy")}</span><span>{decision["created_at"] ? formatAbsoluteDate(String(decision["created_at"])) : "Time unavailable"}</span></div>)}</div></div>}{firings.length > 0 && <div><div className="ck-inspector-section-title"><span>Alerts sent</span></div><div className="ck-component-list">{firings.slice(0, 6).map((firing, index) => <div className="ck-component-row" key={`${String(firing["rule_id"] ?? firing["policy_id"] ?? "warning")}-${String(firing["fired_at"] ?? index)}`}><span>{String(firing["scope"] ?? firing["rule_id"] ?? "Budget alert")}</span><span>{firing["fired_at"] ? formatAbsoluteDate(String(firing["fired_at"])) : "Time unavailable"}</span></div>)}</div></div>}</div>;
}

function ContributorDetail({ row, onClose, groupBy, contextKey, environment, projectId, period, timezone, currency, fx, scopeOverride }: { row: CostRow; onClose: () => void; groupBy: GroupBy; contextKey?: string | null; environment?: string; projectId: string; period: Period; timezone?: string | null; currency: string; fx?: ReportingFx | null; scopeOverride?: { from: string; to: string } | null }) {
  const overrideFrom = scopeOverride?.from;
  const overrideTo = scopeOverride?.to;
  const requestKey = [projectId, groupBy, contextKey ?? "", environment ?? "all", row.id, period, timezone ?? "", overrideFrom ?? "", overrideTo ?? ""].join("\u0001");
  const [state, setState] = useState<{ key: string; history: CostContributorHistoryRow[]; traces: CostContributorTraceRow[]; detail: CostContributorDetailResponse | null }>({ key: "", history: [], traces: [], detail: null });
  const loading = state.key !== requestKey;
  const history = state.key === requestKey ? state.history : [];
  const traces = state.key === requestKey ? state.traces : [];
  const detail = state.key === requestKey ? state.detail : null;
  useEffect(() => {
    let cancelled = false;
    const { from, to } = overrideFrom && overrideTo ? { from: overrideFrom, to: overrideTo } : periodDates(period, timezone ?? undefined);
    const api = apiGrouping(groupBy, contextKey);
    getCostContributor(projectId, api.groupBy, row.id, { from, to, contextKey: api.contextKey, environment: environment && environment !== "all" ? environment : undefined }).then((result) => { if (!cancelled) setState({ key: requestKey, history: result.history ?? [], traces: result.traces ?? [], detail: result }); }).catch(() => { if (!cancelled) setState({ key: requestKey, history: [], traces: [], detail: null }); });
    return () => { cancelled = true; };
  }, [projectId, groupBy, contextKey, environment, row.id, period, timezone, requestKey, overrideFrom, overrideTo]);
  const maxHistory = Math.max(...history.map((item) => Number(item.known_cost) || 0), 0.0001);
  const scopeParams = new URLSearchParams();
  scopeParams.set("project", projectId);
  if (scopeOverride) { scopeParams.set("from", scopeOverride.from); scopeParams.set("to", scopeOverride.to); }
  else scopeParams.set("period", period);
  if (environment && environment !== "all") scopeParams.set("environment", environment);
  const traceParams = new URLSearchParams(scopeParams);
  if (groupBy === "context" && contextKey) {
    traceParams.set("groupBy", "context");
    traceParams.set("contextKey", contextKey);
    traceParams.set("contextValue", row.id);
  } else traceParams.set(groupBy, row.id);
  const forecastParams = new URLSearchParams(scopeParams);
  forecastParams.set("groupBy", groupBy); forecastParams.set("groupValue", row.id);
  if (contextKey) forecastParams.set("contextKey", contextKey);
  const budgetParams = new URLSearchParams(scopeParams);
  budgetParams.set("scopeDimension", groupBy); budgetParams.set("scopeValue", row.id);
  if (detail) {
    return <div className="ck-contributor-drawer"><div className="ck-contributor-drawer-header"><div><h3>{row.name}</h3><p>{groupBy === "context" ? "Custom label" : groupBy.charAt(0).toUpperCase() + groupBy.slice(1)}{row.secondary ? ` · ${row.secondary}` : ""}</p></div><button className="ck-button ck-button-quiet" type="button" onClick={onClose}>Close</button></div><ContributorSummary summary={detail.summary} baseline={detail.baseline} currency={currency} fx={fx} /><div className="ck-contributor-detail-section"><div className="ck-inspector-section-title"><span>Runs</span><span>{traces.length} shown</span></div>{traces.length === 0 ? <p className="ck-table-note" style={{ borderTop: 0 }}>No runs in this period.</p> : <div className="ck-mini-traces">{traces.slice(0, 8).map((trace) => <Link key={trace.trace_id} className="ck-mini-trace" to={`/traces/${encodeURIComponent(trace.trace_id)}?project=${encodeURIComponent(projectId)}`}><span>{trace.trace_name || trace.trace_id}<small>{trace.call_count.toLocaleString()} calls</small></span><strong>{trace.known_cost == null ? "Unpriced" : formatReportedAmount(trace.known_cost, currency, fx)}</strong></Link>)}</div>}</div><div className="ck-contributor-detail-section"><div className="ck-inspector-section-title"><span>Daily cost</span><span>Last {Math.min(history.length, 14)} days</span></div>{history.length === 0 ? <p className="ck-table-note" style={{ borderTop: 0 }}>No daily history yet.</p> : <div className="ck-mini-history">{history.slice(-14).map((item) => <div className="ck-mini-history-row" key={item.day}><span>{formatDateTime(item.day)}</span><span className="ck-mini-history-bar"><i style={{ width: `${Math.max(2, (Number(item.known_cost) || 0) / maxHistory * 100)}%` }} /></span><strong>{item.known_cost == null ? "Unpriced" : formatReportedAmount(item.known_cost, currency, fx)}</strong></div>)}</div>}</div><div className="ck-contributor-detail-section"><div className="ck-inspector-section-title"><span>Breakdown</span></div><div className="ck-contributor-related-grid"><DistributionBlock title="Providers" rows={detail.distributions?.providers} currency={currency} fx={fx} /><DistributionBlock title="Models" rows={detail.distributions?.models} currency={currency} fx={fx} /><DistributionBlock title="Services" rows={detail.distributions?.services} currency={currency} fx={fx} /><DistributionBlock title="Releases" rows={detail.distributions?.releases} currency={currency} fx={fx} /><DistributionBlock title="Features" rows={detail.related?.features ?? detail.distributions?.features} currency={currency} fx={fx} /><DistributionBlock title="Functions" rows={detail.related?.functions ?? detail.distributions?.functions} currency={currency} fx={fx} /></div></div><div className="ck-contributor-detail-section"><div className="ck-inspector-section-title"><span>Budgets</span></div><PolicyContext actions={detail.policyActions} /></div><div className="ck-contributor-detail-actions"><Link className="ck-button ck-button-secondary" to={`/traces?${traceParams.toString()}`}>View these runs <ArrowRight size={13} /></Link><Link className="ck-button ck-button-secondary" to={`/forecast?${forecastParams.toString()}`}>Estimate at scale <ArrowRight size={13} /></Link><Link className="ck-button ck-button-secondary" to={`/budgets?${budgetParams.toString()}`}>Set a budget <ArrowRight size={13} /></Link></div></div>;
  }
  return <div className="ck-contributor-drawer"><div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}><div><h3>{row.name}</h3><p>{groupBy === "context" ? "Custom label" : groupBy.charAt(0).toUpperCase() + groupBy.slice(1)}{row.secondary ? ` · ${row.secondary}` : ""}</p></div><button className="ck-button ck-button-quiet" type="button" onClick={onClose}>Close</button></div><div className="ck-contributor-grid"><div className="ck-contributor-stat"><span className="ck-overline">Spend</span><strong>{row.cost == null ? "Unpriced" : formatReportedAmount(row.cost, currency, fx)}</strong></div><div className="ck-contributor-stat"><span className="ck-overline">Calls</span><strong>{row.observations.toLocaleString()}</strong></div><div className="ck-contributor-stat"><span className="ck-overline">Priced</span><strong>{row.coverage == null ? "—" : `${Math.round(row.coverage * 100)}%`}</strong></div></div>{loading ? <div style={{ marginTop: 15 }}><LoadingRows count={3} columns={2} /></div> : history.length > 0 && <div className="ck-mini-history"><div className="ck-overline">Daily cost</div>{history.slice(-14).map((item) => <div className="ck-mini-history-row" key={item.day}><span>{formatDateTime(item.day)}</span><span className="ck-mini-history-bar"><i style={{ width: `${Math.max(2, (Number(item.known_cost) || 0) / maxHistory * 100)}%` }} /></span><strong>{item.known_cost == null ? "Unpriced" : formatReportedAmount(item.known_cost, currency, fx)}</strong></div>)}</div>}{!loading && traces.length > 0 && <div className="ck-mini-traces"><div className="ck-overline">Runs</div>{traces.slice(0, 5).map((trace) => <Link key={trace.trace_id} className="ck-mini-trace" to={`/traces/${encodeURIComponent(trace.trace_id)}?project=${encodeURIComponent(projectId)}`}><span>{trace.trace_name || trace.trace_id}</span><strong>{trace.known_cost == null ? "Unpriced" : formatReportedAmount(trace.known_cost, currency, fx)}</strong></Link>)}</div>}<div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 15 }}><Link className="ck-button ck-button-secondary" to={`/traces?${traceParams.toString()}`}>View these runs <ArrowRight size={13} /></Link><Link className="ck-button ck-button-secondary" to={`/forecast?${forecastParams.toString()}`}>Estimate at scale <ArrowRight size={13} /></Link><Link className="ck-button ck-button-secondary" to={`/budgets?${budgetParams.toString()}`}>Set a budget <ArrowRight size={13} /></Link></div></div>;
}

function EmptyGrouping({ groupBy, available }: { groupBy: GroupBy; available: string[] }) {
  const label = groupBy === "customer" ? "customer" : groupBy === "context" ? "custom label" : groupBy;
  void available;
  return <EmptyPanel title={`Nothing labelled by ${label} yet`} body={groupBy === "customer" ? "Send a customer ID with each run from the SDK and spend will split by customer here." : "Spend still counts in every total. Add this label in the SDK to split costs this way."} action={<Link className="ck-button ck-button-secondary" to="/traces">View runs <ArrowRight size={13} /></Link>} icon={groupBy === "customer" ? <Users size={18} /> : <Layers3 size={18} />} />;
}

function FeatureMappingManager({ projectId, period, timezone, environment, currency, fx, canEdit }: { projectId: string; period: Period; timezone?: string | null; environment?: string; currency: string; fx?: ReportingFx | null; canEdit: boolean }) {
  const [mappings, setMappings] = useState<FeatureMapping[]>([]);
  const [open, setOpen] = useState(false);
  const [feature, setFeature] = useState("");
  const [functionPattern, setFunctionPattern] = useState("");
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [preview, setPreview] = useState<{ mappingId: string; matchedCount: number; knownCost: number | null; unpricedCount: number } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/v1/projects/${projectId}/feature-mappings`, { credentials: "include" }).then(async (response) => { if (!response.ok) return; const result = await response.json() as { mappings?: FeatureMapping[] }; if (!cancelled) setMappings(result.mappings ?? []); }).catch(() => {});
    return () => { cancelled = true; };
  }, [projectId]);
  async function create(): Promise<void> {
    if (!feature.trim() || (!functionPattern.trim() && !provider.trim() && !model.trim())) { setMessage("Add a feature name and at least one thing to match on."); return; }
    setSaving(true); setMessage(null);
    try {
      const response = await fetch(`/api/v1/projects/${projectId}/feature-mappings`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ feature: feature.trim(), match: { function: functionPattern.trim() || undefined, provider: provider.trim() || undefined, model: model.trim() || undefined } }) });
      const result = await response.json() as FeatureMapping & { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Couldn’t save this rule");
      const mapping: FeatureMapping = { id: result.id, feature: result.feature ?? feature.trim(), match: result.match ?? {}, enabled: true };
      setMappings((current) => [...current, mapping]);
      const dates = periodDates(period, timezone ?? undefined);
      const previewResponse = await fetch(`/api/v1/projects/${projectId}/feature-mappings/${encodeURIComponent(mapping.id)}/preview?from=${encodeURIComponent(dates.from)}&to=${encodeURIComponent(dates.to)}${environment && environment !== "all" ? `&environment=${encodeURIComponent(environment)}` : ""}`, { credentials: "include" });
      if (previewResponse.ok) { const previewData = await previewResponse.json() as { preview?: { matchedCount: number; knownCost: number | null; unpricedCount: number } }; if (previewData.preview) setPreview({ mappingId: mapping.id, ...previewData.preview }); }
      setFeature(""); setFunctionPattern(""); setProvider(""); setModel("");
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : "Couldn’t save this rule"); } finally { setSaving(false); }
  }
  async function applyHistory(): Promise<void> {
    if (!preview) return;
    setSaving(true); setMessage(null);
    try {
      const dates = periodDates(period, timezone ?? undefined);
      const response = await fetch(`/api/v1/projects/${projectId}/feature-mappings/${encodeURIComponent(preview.mappingId)}/apply`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: true, from: dates.from, to: dates.to, environment: environment && environment !== "all" ? environment : undefined }) });
      const result = await response.json() as { matchedCount?: number; error?: string };
      if (!response.ok) throw new Error(result.error ?? "Couldn’t label past calls");
      setMessage(`${(result.matchedCount ?? preview.matchedCount).toLocaleString()} past calls labelled. Totals are unchanged.`); setPreview(null);
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : "Couldn’t label past calls"); } finally { setSaving(false); }
  }
  async function toggle(mapping: FeatureMapping): Promise<void> {
    const response = await fetch(`/api/v1/projects/${projectId}/feature-mappings/${encodeURIComponent(mapping.id)}`, { method: "PATCH", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: !mapping.enabled }) });
    if (response.ok) setMappings((current) => current.map((item) => item.id === mapping.id ? { ...item, enabled: !item.enabled } : item));
  }
  return <div className="ck-feature-labels"><Panel title="Feature label rules" actions={canEdit ? <button className="ck-button ck-button-secondary sm" type="button" onClick={() => setOpen((value) => !value)}>{open ? "Cancel" : "Add a rule"}</button> : <span className="ck-table-note" style={{ border: 0, padding: 0 }}>View only</span>}>
    {open && canEdit && <div className="ck-form"><div className="ck-form-grid"><div className="ck-form-field"><label htmlFor="mapping-feature">Feature name</label><input id="mapping-feature" className="ck-input" value={feature} onChange={(event) => setFeature(event.target.value)} placeholder="Search" /></div><div className="ck-form-field"><label htmlFor="mapping-function">Function pattern</label><input id="mapping-function" className="ck-input" value={functionPattern} onChange={(event) => setFunctionPattern(event.target.value)} placeholder="search*" /></div><div className="ck-form-field"><label htmlFor="mapping-provider">Provider <span className="muted">(optional)</span></label><input id="mapping-provider" className="ck-input" value={provider} onChange={(event) => setProvider(event.target.value)} placeholder="openai" /></div><div className="ck-form-field"><label htmlFor="mapping-model">Model <span className="muted">(optional)</span></label><input id="mapping-model" className="ck-input" value={model} onChange={(event) => setModel(event.target.value)} placeholder="gpt-4o*" /></div></div><div className="ck-form-footer"><button className="ck-button ck-button-primary" type="button" onClick={() => void create()} disabled={saving}>{saving ? "Saving" : "Save rule"}</button></div></div>}
    {preview && <div className="ck-alert" style={{ margin: "0 16px 14px" }}><CircleAlert size={14} /><div><strong>{preview.matchedCount.toLocaleString()} past calls match</strong> ({preview.knownCost == null ? "unpriced" : formatReportedAmount(preview.knownCost, currency, fx)}{preview.unpricedCount > 0 ? `, ${preview.unpricedCount} unpriced` : ""}). Label them too? Totals won’t change. <button className="ck-button ck-button-secondary sm" type="button" onClick={() => void applyHistory()} disabled={saving} style={{ marginLeft: 8 }}>{saving ? "Labelling" : "Label past calls"}</button></div></div>}
    {message && <p className="ck-table-note" role="status">{message}</p>}
    {mappings.length === 0 ? <div className="ck-table-note" style={{ borderTop: 0 }}>No rules yet.</div> : <div className="ck-mapping-list">{mappings.map((mapping) => <div className="ck-mapping-row" key={mapping.id}><div><strong>{mapping.feature}</strong><span>{Object.entries(mapping.match).map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`).join(" · ")}</span></div><StatusPill tone={mapping.enabled ? "good" : "neutral"}>{mapping.enabled ? "Active" : "Paused"}</StatusPill>{canEdit && <button className="ck-button ck-button-quiet" type="button" onClick={() => void toggle(mapping)}>{mapping.enabled ? "Pause" : "Turn on"}</button>}</div>)}</div>}
  </Panel></div>;
}

export default function Costs({ defaultGroup = "feature", title = "Costs" }: { defaultGroup?: GroupBy; title?: string } = {}) {
  const { currentProjectId, projects, user, org, workspaceSettings } = useAuth();
  const projectId = currentProjectId ?? projects[0]?.id ?? null;
  const [searchParams, setSearchParams] = useSearchParams();
  const environment = searchParams.get("environment") ?? "all";
  const period = parsePeriod(searchParams.get("period"));
  const requestedFrom = searchParams.get("from");
  const requestedTo = searchParams.get("to");
  const scopeOverride = requestedFrom && requestedTo && Number.isFinite(new Date(requestedFrom).getTime()) && Number.isFinite(new Date(requestedTo).getTime()) && new Date(requestedFrom) < new Date(requestedTo) ? { from: requestedFrom, to: requestedTo } : null;
  const requestedGroupBy = searchParams.get("groupBy");
  const groupBy: GroupBy = requestedGroupBy === "function" || requestedGroupBy === "customer" || requestedGroupBy === "model" || requestedGroupBy === "provider" || requestedGroupBy === "context" || requestedGroupBy === "agent" || requestedGroupBy === "tool" ? requestedGroupBy : defaultGroup;
  const groupValue = searchParams.get("groupValue");
  const contextKey = searchParams.get("contextKey");
  const requestedLimit = Number(searchParams.get("limit"));
  const pageSize = requestedLimit === 50 || requestedLimit === 100 ? requestedLimit : 25;
  const requestedOffset = Number(searchParams.get("offset"));
  const offset = Number.isFinite(requestedOffset) && requestedOffset >= 0 ? Math.floor(requestedOffset / pageSize) * pageSize : 0;
  const [selected, setSelected] = useState<CostRow | null>(null);
  const [reload, setReload] = useState(0);
  const resource = useCostData(projectId, groupBy, period, reload, workspaceSettings?.timezone ?? org?.timezone, contextKey, environment, groupValue, scopeOverride, pageSize, offset);
  const { data } = resource;
  const availableDimensions = data.availableDimensions.length > 0 ? data.availableDimensions : resource.contextKeys.map((key) => `context:${key}`);
  const reportingCurrency = workspaceSettings?.reportingCurrency ?? "USD";
  const fx = workspaceSettings?.fx;
  const currencyNote = reportingCurrencyNote(reportingCurrency, fx);
  const toolbarPeriod: Period = scopeOverride ? "custom" : period;
  const timezone = workspaceSettings?.timezone ?? org?.timezone;
  const changePeriod = (next: Period): void => {
    if (next === "custom") {
      const dates = periodDates("30d", timezone ?? undefined);
      setSelected(null);
      setSearchParams((current) => { current.set("period", "custom"); current.set("from", dates.from); current.set("to", dates.to); current.delete("offset"); return current; });
      return;
    }
    setSelected(null);
    setSearchParams((current) => { current.set("period", next); current.delete("from"); current.delete("to"); current.delete("offset"); return current; });
  };
  const changeCustomRange = (from: string, to: string): void => {
    const nextFrom = dateInputToIso(from, timezone ?? undefined);
    const nextTo = dateInputToIso(to, timezone ?? undefined, true);
    if (!nextFrom || !nextTo || new Date(nextFrom) >= new Date(nextTo)) return;
    setSelected(null);
    setSearchParams((current) => { current.set("period", "custom"); current.set("from", nextFrom); current.set("to", nextTo); current.delete("offset"); return current; });
  };
  if (!projectId) return <div className="ck-main-inner"><PageHeader title={title} /><Panel><EmptyPanel illustration="first-light" title="Ready for your first run" body="Connect a project to start." action={<Link className="ck-button ck-button-primary" to="/onboarding">Connect a project</Link>} /></Panel></div>;
  const explicitState = prototypeState(searchParams);
  const effectiveRole = prototypeRole(searchParams, user?.role ?? "viewer");
  const namedState = PrototypeStatePanel({ state: explicitState, family: "Costs", backHref: "/overview", retryHref: `/costs${window.location.search}`, loadingRows: 7 });
  if (namedState) return namedState;
  const environmentOptions = [{ value: "all", label: "All environments" }, ...resource.environmentOptions.filter((value) => value !== "all" && value !== environment).map((value) => ({ value, label: value })), ...(environment !== "all" ? [{ value: environment, label: environment }] : [])];
  const scopeLinkParams = new URLSearchParams({ project: projectId });
  if (scopeOverride) { scopeLinkParams.set("period", "custom"); scopeLinkParams.set("from", scopeOverride.from); scopeLinkParams.set("to", scopeOverride.to); }
  else scopeLinkParams.set("period", period);
  if (environment !== "all") scopeLinkParams.set("environment", environment);
  const scopeLink = `?${scopeLinkParams.toString()}`;
  return <div className="ck-main-inner prototype-costs-route"><PageHeader title={title} actions={<><ScopeToolbar period={toolbarPeriod} onPeriodChange={changePeriod} customFrom={scopeOverride?.from} customTo={scopeOverride?.to} onCustomRangeChange={changeCustomRange} environment={environment} onEnvironmentChange={(next) => setSearchParams((current) => { if (next === "all") current.delete("environment"); else current.set("environment", next); current.delete("offset"); return current; })} environmentOptions={environmentOptions} currency={reportingCurrency} currencyNote={currencyNote} timezone={timezone ?? undefined} /><a className="ck-button ck-button-secondary" href={`/api/v1/projects/${encodeURIComponent(projectId)}/export?format=csv&includeContent=false`}><Download size={14} aria-hidden="true" /> Export CSV</a></>} />
    <div className="ck-cost-group-row"><span className="ck-cost-group-label">Split by</span><GroupSelector value={groupBy} onChange={(next) => { setSearchParams((current) => { current.set("groupBy", next); if (next !== "context") { current.delete("groupValue"); current.delete("contextKey"); } current.delete("offset"); return current; }); setSelected(null); }} available={availableDimensions} />{groupBy === "context" && <ContextKeySelector value={contextKey} onChange={(next) => { setSelected(null); setSearchParams((current) => { if (next) current.set("contextKey", next); else current.delete("contextKey"); current.delete("offset"); return current; }); }} contextKeys={resource.contextKeys} />}</div>
    <PrototypeStateNotice state={explicitState} family="cost breakdown" role={effectiveRole} onRetry={() => setReload((value) => value + 1)} />
    {resource.error && <div className="ck-alert" style={{ marginBottom: 18 }}><CircleAlert size={15} aria-hidden="true" /><div><strong>Couldn’t load this breakdown.</strong> {resource.error}</div></div>}
    {resource.loading ? <Panel><LoadingRows count={7} columns={6} /></Panel> : groupBy === "context" && !contextKey ? <Panel><EmptyPanel title={resource.contextKeys.length > 0 ? "Choose a label" : "No custom labels yet"} body={resource.contextKeys.length > 0 ? "Pick one of your custom labels above to split costs by its values." : "Send your own labels (like team or plan) with each run from the SDK, then split costs by them here."} action={<Link className="ck-button ck-button-secondary" to={`/traces${scopeLink}`}>View runs <ArrowRight size={13} /></Link>} icon={<Layers3 size={18} />} /></Panel> : data.rows.length === 0 ? <Panel><EmptyGrouping groupBy={groupBy} available={availableDimensions} /></Panel> : <><Panel title={`Spend by ${groupBy === "context" ? "custom label" : groupBy}`} subtitle={`${data.knownCost == null ? "Unpriced" : formatReportedAmount(data.knownCost, reportingCurrency, fx)} · ${data.runs.toLocaleString()} runs${data.unpriced > 0 ? ` · ${data.unpriced.toLocaleString()} unpriced calls` : ""}`}><CostTable rows={data.rows} totalCost={data.knownCost} currency={reportingCurrency} fx={fx} groupBy={groupBy} contextKey={contextKey} projectId={projectId} scopeSearch={scopeLink} onSelect={setSelected} /><CostPagination offset={data.offset} limit={data.limit} total={data.total} onOffsetChange={(nextOffset) => setSearchParams((current) => { current.set("offset", String(nextOffset)); current.set("limit", String(pageSize)); return current; })} onLimitChange={(nextLimit) => setSearchParams((current) => { current.set("limit", String(nextLimit)); current.delete("offset"); return current; })} /></Panel>{selected && <ContributorDetail row={selected} contextKey={contextKey} environment={environment} scopeOverride={scopeOverride} currency={reportingCurrency} fx={fx} projectId={projectId} period={period} timezone={workspaceSettings?.timezone ?? org?.timezone} groupBy={groupBy} onClose={() => setSelected(null)} />}{groupBy === "feature" && <FeatureMappingManager projectId={projectId} period={period} timezone={workspaceSettings?.timezone ?? org?.timezone} environment={environment} currency={reportingCurrency} fx={workspaceSettings?.fx} canEdit={effectiveRole === "owner" || effectiveRole === "admin" || effectiveRole === "developer"} />}</>}
  </div>;
}
