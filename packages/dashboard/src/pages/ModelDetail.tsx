import { useState } from "react";
import { ArrowLeft } from "lucide-react";
import { Link, useParams } from "react-router-dom";
import { currentRouterPath } from "../basePath";
import { EmptyPanel, LoadingRows, MetricCard, Panel, StatusPill } from "../components/ConsolePrimitives";
import { LiveStatus } from "../components/LiveStatus";
import { LineChart, Pills } from "../components/OverviewBoard";
import { ProviderLogo } from "../components/ProviderLogo";
import { formatDateTime, formatDayDate, formatReportedAmount, providerName } from "../components/consoleFormatters";
import { billedUnitsText, cachedNote, cacheWriteText, formatHitRate, formatTokenCount, reasoningNote, type CallUsage } from "../components/tokenUsage";
import {
  catalogName, getModelDetail, longContextLine, pricingSourcesText, rateLines,
  type ModelDetail, type ModelOwner, type ModelRecentCall,
} from "../modelDetailApi";
import { formatDuration, formatTokens } from "../utils";
import { useInsightScope, useScopedLoad } from "./useInsightScope";
import "./ModelDetail.css";

type Money = (value: number | null | undefined) => string;

function decodeSplat(value: string | undefined): string {
  if (!value) return "";
  try { return decodeURIComponent(value); } catch { return value; }
}

function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}

/** The Usage card: tokens with what was cached, or the units a non-token model bills. Never "0 tokens" for a characters model. */
function usageCard(summary: ModelDetail["summary"] | undefined): { value: string; detail?: string } {
  if (!summary) return { value: "—" };
  const { usage, units } = summary;
  const tokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
  const billed = billedUnitsText(units);
  if (tokens > 0) {
    const detail = [`${formatTokenCount(usage.inputTokens)} in`, `${formatTokenCount(usage.outputTokens)} out`, cachedNote(usage), billed].filter(Boolean).join(" · ");
    return { value: `${formatTokens(tokens)} tokens`, detail };
  }
  if (billed) return { value: billed };
  return { value: "—", detail: summary.calls > 0 ? "No usage reported" : undefined };
}

function spendDetail(summary: ModelDetail["summary"] | undefined, money: Money): string | undefined {
  if (!summary || summary.calls === 0) return undefined;
  const parts = [summary.cost != null && summary.pricedCalls > 0 ? `${money(summary.cost / summary.pricedCalls)} per call` : null];
  if (summary.unpricedCalls > 0) parts.push(`${summary.unpricedCalls.toLocaleString()} unpriced`);
  return parts.filter(Boolean).join(" · ") || undefined;
}

/** A call's usage as the provider reported it. */
function callUsageText(call: ModelRecentCall): string {
  const tokens = [
    call.inputTokens != null ? `${formatTokens(call.inputTokens)} in` : null,
    call.outputTokens != null ? `${formatTokens(call.outputTokens)} out` : null,
    call.cacheReadTokens ? `${formatTokens(call.cacheReadTokens)} cached` : null,
  ].filter(Boolean);
  if ((call.inputTokens ?? 0) + (call.outputTokens ?? 0) > 0) return tokens.join(" · ");
  return billedUnitsText(call.units) || (tokens.length > 0 ? tokens.join(" · ") : "—");
}

function CallStatus({ call }: { call: ModelRecentCall }) {
  const { lifecycleState, errorType, statusCode } = call.status;
  if (!call.failed) return <StatusPill tone="good">Succeeded</StatusPill>;
  const reason = errorType ?? (statusCode != null && statusCode >= 400 ? `HTTP ${statusCode}` : null);
  return <>
    {lifecycleState === "cancelled" ? <StatusPill tone="warn">Cancelled</StatusPill> : <StatusPill tone="critical">Failed</StatusPill>}
    {reason && <small className="ck-table-sub ck-md-reason" title={reason}>{reason}</small>}
  </>;
}

type Measure = "spend" | "calls";

function SpendChart({ data, measure, money }: { data: ModelDetail; measure: Measure; money: Money }) {
  const buckets = data.series.map((point) => point.bucket);
  const spend = measure === "spend";
  return <div className="ck-md-chart">
    <LineChart
      buckets={buckets}
      unit={data.window.bucket}
      series={[{
        key: measure,
        label: spend ? "Spend" : "Calls",
        color: "#3a6db0",
        values: data.series.map((point) => spend ? point.cost : point.calls),
      }]}
      format={spend ? (value) => money(value) : (value) => Math.round(value).toLocaleString()}
      label={`${spend ? "Spend" : "Calls"} on ${data.model} over time`}
    />
  </div>;
}

function PricePanel({ data, money }: { data: ModelDetail; money: Money }) {
  const price = data.price.current;
  const usage = data.summary.usage;
  const sources = pricingSourcesText(data.price.sources);
  const writes: CallUsage = { ...usage, cacheWriteTokens: data.cacheWrites.total, cacheWrite5mTokens: data.cacheWrites.fiveMinute, cacheWrite1hTokens: data.cacheWrites.oneHour };
  const cacheReported = usage.cacheReadTokens != null || data.cacheWrites.total != null;
  return <dl className="ck-definition-list ck-md-price">
    <div><dt>List price</dt><dd>{price ? `${catalogName(price.catalogSource)} catalog, since ${formatDayDate(price.effectiveFrom)}` : "Not in the price catalog"}</dd></div>
    {price && rateLines(price.rates).map((line) => <div key={line.key}><dt>{line.label}</dt><dd>{line.value}</dd></div>)}
    {price && price.longContext.map((tier) => {
      const line = longContextLine(tier);
      return <div key={tier.threshold}><dt>{line.label}</dt><dd>{line.value}</dd></div>;
    })}
    {sources && <div><dt>Calls in this period</dt><dd>{sources}</dd></div>}
    {data.summary.unpricedCalls > 0 && <div><dt>Unpriced</dt><dd>{plural(data.summary.unpricedCalls, "call has", "calls have")} no price yet</dd></div>}
    {cacheReported && <div><dt>Cache hit rate</dt><dd>{formatHitRate(usage.cacheHitRate)}{usage.cacheReadTokens ? ` (${formatTokenCount(usage.cacheReadTokens)} cached)` : ""}</dd></div>}
    {data.cacheWrites.total != null && <div><dt>Cache writes</dt><dd>{cacheWriteText(writes)}</dd></div>}
    {usage.cacheSavings != null && usage.cacheSavings > 0 && <div><dt>Saved by cache</dt><dd>{money(usage.cacheSavings)}</dd></div>}
    {usage.reasoningTokens != null && usage.reasoningTokens > 0 && <div><dt>Reasoning</dt><dd>{reasoningNote(usage)} of {formatTokenCount(usage.outputTokens)} output</dd></div>}
  </dl>;
}

function OwnersTable({ owners, money }: { owners: ModelOwner[]; money: Money }) {
  const search = window.location.search;
  return <div className="ck-table-wrap"><table className="ck-table">
    <thead><tr><th>Name</th><th className="hide-mobile">Kind</th><th className="numeric">Runs</th><th className="numeric">Calls</th><th className="numeric">Spend</th></tr></thead>
    <tbody>{owners.map((owner) => <tr key={`${owner.kind}/${owner.name}`} className="ck-md-row-link">
      <td className="primary-cell"><Link className="ck-table-link ck-md-stretch" to={`/${owner.kind === "agent" ? "agents" : "workflows"}/${encodeURIComponent(owner.name)}${search}`}>{owner.name}</Link><small className="ck-table-sub ck-md-mobile-only">{owner.kind === "agent" ? "Agent" : "Workflow"}</small></td>
      <td className="hide-mobile">{owner.kind === "agent" ? "Agent" : "Workflow"}</td>
      <td className="numeric">{owner.runs.toLocaleString()}</td>
      <td className="numeric">{owner.calls.toLocaleString()}</td>
      <td className="numeric">{money(owner.cost)}</td>
    </tr>)}</tbody>
  </table></div>;
}

function RecentCallsTable({ calls, money }: { calls: ModelRecentCall[]; money: Money }) {
  return <div className="ck-table-wrap"><table className="ck-table">
    <thead><tr><th>Time</th><th className="hide-mobile">Run</th><th className="numeric hide-mobile" title="As the provider reported it">Usage</th><th className="numeric hide-mobile">Duration</th><th>Status</th><th className="numeric">Cost</th></tr></thead>
    <tbody>{calls.map((call) => {
      const when = formatDateTime(call.timestamp);
      return <tr key={call.id} className={call.traceId ? "ck-md-row-link" : undefined}>
        <td className="primary-cell ck-md-nowrap">{call.traceId
          ? <Link className="ck-table-link ck-md-stretch" to={`/traces/${encodeURIComponent(call.traceId)}?call=${encodeURIComponent(call.id)}`} state={{ returnTo: currentRouterPath() }}>{when}</Link>
          : when}</td>
        <td className="hide-mobile ck-md-run" title={call.traceName ?? call.traceId ?? undefined}>{call.traceName ?? call.traceId ?? "—"}</td>
        <td className="numeric hide-mobile">{callUsageText(call)}</td>
        <td className="numeric hide-mobile">{call.durationMs == null ? "—" : formatDuration(call.durationMs)}</td>
        <td><CallStatus call={call} /></td>
        <td className="numeric">{call.costUsd == null ? (call.failed ? "No charge" : "Unpriced") : money(call.costUsd)}</td>
      </tr>;
    })}</tbody>
  </table></div>;
}

export function ModelDetailPage() {
  const params = useParams();
  const provider = decodeSplat(params["provider"]);
  const model = decodeSplat(params["*"]);
  const { projectId, scope, scopeKey, currency, fx, toolbar } = useInsightScope();
  const { data, error, loading, status, updatedAt, refresh } = useScopedLoad(
    projectId && provider && model ? `model|${provider}|${model}|${scopeKey}` : null,
    () => getModelDetail(projectId!, provider, model, scope),
  );
  const money: Money = (value) => value == null ? "Unpriced" : formatReportedAmount(value, currency, fx);
  const summary = data?.summary;
  const first = loading && !data;
  const empty = Boolean(data && data.summary.calls === 0);
  const usage = usageCard(summary);
  const [measure, setMeasure] = useState<Measure>("spend");
  return <div className="ck-main-inner">
    <Link className="ck-back-link" to={`/models${window.location.search}`}><ArrowLeft size={13} /> Models</Link>
    <div className="ck-page-header">
      <div className="min-w-0">
        <h1 className="ck-page-title ck-md-title"><ProviderLogo provider={provider} size={26} /><span>{model || "Model"}</span></h1>
        <p className="ck-page-description">{providerName(provider)}</p>
      </div>
      <div className="ck-page-actions"><LiveStatus status={status} updatedAt={updatedAt} onRefresh={refresh} />{toolbar}</div>
    </div>
    {error && !data ? <Panel><EmptyPanel title="Couldn’t load this model" body={error} /></Panel> : <>
      <div className="ck-metric-grid ck-metric-grid-4 ck-md-metrics">
        <MetricCard icon="cost" label="Spend" value={summary ? summary.cost == null && summary.calls === 0 ? formatReportedAmount(0, currency, fx) : money(summary.cost) : "—"} detail={spendDetail(summary, money)} loading={first} />
        <MetricCard icon="trace" label="Calls" value={(summary?.calls ?? 0).toLocaleString()} detail={summary && summary.calls > 0 ? summary.failedCalls > 0 ? `${summary.failedCalls.toLocaleString()} failed` : "None failed" : undefined} tone={summary && summary.failedCalls > 0 ? "warn" : "neutral"} loading={first} />
        <MetricCard icon="model" label="Usage" value={usage.value} detail={usage.detail} loading={first} />
        <MetricCard icon="clock" label="Latency p50" value={summary?.p50Ms == null ? "—" : formatDuration(summary.p50Ms)} detail={summary?.p95Ms == null ? undefined : `p95 ${formatDuration(summary.p95Ms)}`} loading={first} />
      </div>
      <Panel title="Spend over time" subtitle={data ? `Per ${data.window.bucket}, ${data.window.timezone} time` : undefined} actions={data && !empty ? <Pills label="Measure" value={measure} onChange={setMeasure} options={[{ value: "spend", label: "Spend" }, { value: "calls", label: "Calls" }]} /> : undefined}>
        {first ? <div className="ck-md-chart"><LoadingRows count={4} columns={1} /></div> : data && !empty ? <SpendChart data={data} measure={measure} money={money} /> : <EmptyPanel title="No calls to this model in this period" />}
      </Panel>
      <Panel title="Price" subtitle="List price and how calls in this period got their cost">
        {first ? <LoadingRows count={4} columns={2} /> : data ? <PricePanel data={data} money={money} /> : null}
      </Panel>
      <Panel title="Used by" subtitle={data && data.owners.length > 0 ? "Agents and workflows that call this model, by spend" : undefined}>
        {first ? <LoadingRows count={3} columns={4} /> : (data?.owners.length ?? 0) === 0 ? <EmptyPanel title="No agents or workflows in this period" body={empty ? undefined : "Calls outside a run aren’t counted here."} /> : <OwnersTable owners={data!.owners} money={money} />}
      </Panel>
      <Panel title="Recent calls" subtitle={data && data.recentCalls.length > 0 ? `Latest ${data.recentCalls.length} in this period` : undefined}>
        {first ? <LoadingRows count={5} columns={5} /> : (data?.recentCalls.length ?? 0) === 0 ? <EmptyPanel title="No calls in this period" /> : <RecentCallsTable calls={data!.recentCalls} money={money} />}
      </Panel>
    </>}
  </div>;
}
