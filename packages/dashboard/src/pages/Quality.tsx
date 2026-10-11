import { Link, useSearchParams } from "react-router-dom";
import { getQualitySummary, type QualitySummary } from "../api";
import { EmptyPanel, LoadingRows, MetricCard, PageHeader, Panel, StatusPill } from "../components/ConsolePrimitives";
import { formatDateTime, formatReportedAmount, type ReportingFx } from "../components/consoleFormatters";
import { formatDuration } from "../utils";
import { useInsightScope, useScopedLoad } from "./useInsightScope";
import { ProviderLabel } from "../components/ProviderLogo";

type View = "runs" | "models" | "failures";
const VIEWS: Array<{ id: View; label: string }> = [
  { id: "runs", label: "Agents & workflows" },
  { id: "models", label: "Models" },
  { id: "failures", label: "Failed runs" },
];

function rate(part: number, whole: number): string {
  if (whole === 0) return "—";
  const value = part / whole;
  return value === 0 ? "0%" : value < 0.01 ? "<1%" : `${Math.round(value * 100)}%`;
}

function RatePill({ part, whole }: { part: number; whole: number }) {
  if (part === 0) return <>{rate(part, whole)}</>;
  return <StatusPill tone={part / whole >= 0.1 ? "critical" : "warn"} icon={false}>{rate(part, whole)}</StatusPill>;
}

function Owners({ data, currency, fx, onOpen }: { data: QualitySummary; currency: string; fx?: ReportingFx | null; onOpen: (name: string) => void }) {
  if (data.owners.length === 0) return <EmptyPanel illustration="first-light" title="No runs in this period" />;
  return <div className="ck-table-wrap"><table className="ck-table ck-table-clickable">
    <thead><tr><th>Agent or workflow</th><th className="numeric">Runs</th><th className="numeric">Failed</th><th className="numeric hide-mobile">Judged failing</th><th className="numeric hide-mobile">Failed calls</th><th className="numeric hide-mobile">Retries</th><th className="numeric">Wasted</th></tr></thead>
    <tbody>{data.owners.map((row) => <tr key={`${row.kind}/${row.name}`} tabIndex={0} onClick={() => onOpen(row.name)} onKeyDown={(event) => { if (event.key === "Enter") onOpen(row.name); }}>
      <td className="primary-cell">{row.name}<small className="ck-table-sub">{row.kind === "agent" ? "Agent" : "Workflow"}</small></td>
      <td className="numeric">{row.runs.toLocaleString()}</td>
      <td className="numeric"><RatePill part={row.failedRuns} whole={row.runs} /></td>
      <td className="numeric hide-mobile">{row.judgedRuns === 0 ? "—" : rate(row.judgedFailed, row.judgedRuns)}</td>
      <td className="numeric hide-mobile">{row.failedCalls.toLocaleString()}</td>
      <td className="numeric hide-mobile">{row.retries.toLocaleString()}</td>
      <td className="numeric">{row.wastedCost > 0 ? formatReportedAmount(row.wastedCost, currency, fx) : "—"}</td>
    </tr>)}</tbody>
  </table></div>;
}

function Models({ data, currency, fx }: { data: QualitySummary; currency: string; fx?: ReportingFx | null }) {
  if (data.models.length === 0) return <EmptyPanel title="No model calls in this period" />;
  return <div className="ck-table-wrap"><table className="ck-table">
    <thead><tr><th>Model</th><th className="numeric">Calls</th><th className="numeric">Failed</th><th className="hide-mobile">Errors</th><th className="numeric hide-mobile">Retries</th><th className="numeric hide-mobile">p95</th><th className="numeric">Wasted</th></tr></thead>
    <tbody>{data.models.map((row) => <tr key={`${row.provider}/${row.model}`}>
      <td className="primary-cell">{row.model}<small className="ck-table-sub"><ProviderLabel provider={row.provider} size={12} /></small></td>
      <td className="numeric">{row.calls.toLocaleString()}</td>
      <td className="numeric"><RatePill part={row.failedCalls} whole={row.calls} /></td>
      <td className="hide-mobile">{row.statusCodes.length ? row.statusCodes.join(", ") : "—"}</td>
      <td className="numeric hide-mobile">{row.retries.toLocaleString()}</td>
      <td className="numeric hide-mobile">{row.p95Ms == null ? "—" : formatDuration(row.p95Ms)}</td>
      <td className="numeric">{row.wastedCost > 0 ? formatReportedAmount(row.wastedCost, currency, fx) : "—"}</td>
    </tr>)}</tbody>
  </table></div>;
}

function Failures({ data, currency, fx }: { data: QualitySummary; currency: string; fx?: ReportingFx | null }) {
  if (data.failures.length === 0) return <EmptyPanel title="No failed runs" />;
  return <div className="ck-table-wrap"><table className="ck-table">
    <thead><tr><th>When</th><th>Agent or workflow</th><th>What went wrong</th><th className="numeric">Cost</th></tr></thead>
    <tbody>{data.failures.map((row) => <tr key={row.traceId}>
      <td className="primary-cell"><Link className="ck-table-link" to={`/traces/${encodeURIComponent(row.traceId)}`}>{formatDateTime(row.startedAt)}</Link></td>
      <td>{row.name}</td>
      <td>{row.reasons.join(" · ")}{row.detail && <small className="ck-table-sub">{row.detail}</small>}</td>
      <td className="numeric">{row.cost == null ? "Unpriced" : formatReportedAmount(row.cost, currency, fx)}</td>
    </tr>)}</tbody>
  </table></div>;
}

export default function Quality() {
  const { projectId, scope, scopeKey, currency, fx, toolbar } = useInsightScope();
  const [params, setParams] = useSearchParams();
  const view = (VIEWS.find((item) => item.id === params.get("view"))?.id ?? "runs") as View;
  const owner = params.get("owner");
  const { data, error, loading } = useScopedLoad(projectId ? `quality|${scopeKey}|${owner ?? ""}` : null, () => getQualitySummary(projectId!, scope, owner));
  const totals = data?.totals;
  const setView = (next: View, nextOwner: string | null = null) => setParams((current) => {
    if (next === "runs") current.delete("view"); else current.set("view", next);
    if (nextOwner) current.set("owner", nextOwner); else current.delete("owner");
    return current;
  });
  return <div className="ck-main-inner">
    <PageHeader title="Quality" actions={toolbar} />
    <div className="ck-metric-grid">
      <MetricCard icon="alert" label="Failed runs" value={totals ? rate(totals.failedRuns, totals.runs) : "—"} tone={(totals?.failedRuns ?? 0) > 0 ? "warn" : "neutral"} detail={totals ? `${totals.failedRuns.toLocaleString()} of ${totals.runs.toLocaleString()} runs` : undefined} loading={loading && !data} />
      <MetricCard icon="activity" label="Failed calls" value={totals ? rate(totals.failedCalls, totals.calls) : "—"} detail={totals ? `${totals.failedCalls.toLocaleString()} failed · ${totals.retries.toLocaleString()} retries` : undefined} loading={loading && !data} />
      <MetricCard icon="cost" label="Wasted" value={formatReportedAmount(totals?.wastedCost ?? 0, currency, fx)} loading={loading && !data} />
    </div>
    <div className="ck-tabs ck-page-tabs" role="tablist" aria-label="Quality views">{VIEWS.map((item) => <button key={item.id} className={`ck-tab ${view === item.id ? "active" : ""}`} role="tab" aria-selected={view === item.id} type="button" onClick={() => setView(item.id)}>{item.label}</button>)}</div>
    <Panel key={`${view}|${owner ?? ""}`} className="ck-view" title={view === "failures" && owner ? owner : undefined} actions={view === "failures" && owner ? <button className="ck-button ck-button-quiet" type="button" onClick={() => setView("failures")}>All runs</button> : undefined}>
      {error && !data ? <EmptyPanel title="Couldn’t load quality" body={error} />
        : loading && !data ? <LoadingRows count={6} columns={6} />
          : view === "runs" ? <Owners data={data!} currency={currency} fx={fx} onOpen={(name) => setView("failures", name)} />
            : view === "models" ? <Models data={data!} currency={currency} fx={fx} />
              : <Failures data={data!} currency={currency} fx={fx} />}
    </Panel>
  </div>;
}
