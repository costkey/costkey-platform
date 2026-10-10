import { Link } from "react-router-dom";
import { getErrors } from "../api";
import { EmptyPanel, LoadingRows, MetricCard, PageHeader, Panel } from "../components/ConsolePrimitives";
import { formatDateTime, formatProviders, formatReportedAmount } from "../components/consoleFormatters";
import { useInsightScope, useScopedLoad } from "./useInsightScope";

const SPAN_KIND: Record<string, string> = { agent: "Agent", step: "Step", tool: "Tool", workflow: "Workflow", judge: "Judge", retrieval: "Retrieval", handoff: "Handoff", guardrail: "Guardrail" };

export default function Errors() {
  const { projectId, scope, scopeKey, currency, fx, toolbar } = useInsightScope();
  const { data, error, loading } = useScopedLoad(projectId ? `errors|${scopeKey}` : null, () => getErrors(projectId!, scope));
  const totals = data?.totals;
  const rate = totals && totals.calls > 0 ? totals.failedCalls / totals.calls : null;
  const empty = data && data.failedCalls.length === 0 && data.retries.length === 0 && data.failedSpans.length === 0;
  const traceLink = (traceId: string | null, label: string) => traceId ? <Link className="ck-table-link" to={`/traces/${encodeURIComponent(traceId)}`}>{label}</Link> : label;
  return <div className="ck-main-inner">
    <PageHeader title="Errors" actions={toolbar} />
    <div className="ck-metric-grid">
      <MetricCard icon="alert" label="Failed calls" value={(totals?.failedCalls ?? 0).toLocaleString()} tone={(totals?.failedCalls ?? 0) > 0 ? "warn" : "neutral"} detail={rate == null ? undefined : `${rate === 0 ? "0" : rate < 0.001 ? "<0.1" : (rate * 100).toFixed(1)}% of calls`} loading={loading && !data} />
      <MetricCard icon="activity" label="Retries" value={(totals?.retries ?? 0).toLocaleString()} loading={loading && !data} />
      <MetricCard icon="cost" label="Spent on failures and retries" value={formatReportedAmount(totals?.wastedCost ?? 0, currency, fx)} loading={loading && !data} />
    </div>
    {error && !data ? <Panel><EmptyPanel title="Couldn’t load errors" body={error} /></Panel>
      : loading && !data ? <Panel><LoadingRows count={6} columns={5} /></Panel>
        : empty ? <Panel><EmptyPanel illustration="first-light" title="No errors in this period" /></Panel>
          : <>
            {data!.failedCalls.length > 0 && <Panel title="Failed calls"><div className="ck-table-wrap"><table className="ck-table">
              <thead><tr><th>Model</th><th>Status</th><th className="numeric">Calls</th><th className="numeric hide-mobile">Runs</th><th className="hide-mobile">Last seen</th></tr></thead>
              <tbody>{data!.failedCalls.map((row) => <tr key={`${row.provider}/${row.model}/${row.statusCode}`}>
                <td className="primary-cell">{traceLink(row.sampleTraceId, row.model)}<small className="ck-table-sub">{formatProviders(row.provider)}</small></td>
                <td>{row.statusCode ?? "—"}</td>
                <td className="numeric">{row.calls.toLocaleString()}</td>
                <td className="numeric hide-mobile">{row.runs.toLocaleString()}</td>
                <td className="hide-mobile">{formatDateTime(row.lastSeen)}</td>
              </tr>)}</tbody>
            </table></div></Panel>}
            <div className="ck-content-grid">
              {data!.failedSpans.length > 0 && <Panel title="Failed steps"><div className="ck-table-wrap"><table className="ck-table">
                <thead><tr><th>Where</th><th>Error</th><th className="numeric">Times</th><th className="hide-mobile">Last seen</th></tr></thead>
                <tbody>{data!.failedSpans.map((row) => <tr key={`${row.kind}/${row.name}/${row.errorType}`}>
                  <td className="primary-cell">{traceLink(row.sampleTraceId, row.name)}<small className="ck-table-sub">{SPAN_KIND[row.kind] ?? row.kind}</small></td>
                  <td>{row.errorType ?? "—"}</td>
                  <td className="numeric">{row.failures.toLocaleString()}</td>
                  <td className="hide-mobile">{formatDateTime(row.lastSeen)}</td>
                </tr>)}</tbody>
              </table></div></Panel>}
              {data!.retries.length > 0 && <Panel title="Retries"><div className="ck-table-wrap"><table className="ck-table">
                <thead><tr><th>Model</th><th className="numeric">Retries</th><th className="numeric">Spend</th></tr></thead>
                <tbody>{data!.retries.map((row) => <tr key={`${row.provider}/${row.model}`}>
                  <td className="primary-cell">{row.model}<small className="ck-table-sub">{formatProviders(row.provider)}</small></td>
                  <td className="numeric">{row.retries.toLocaleString()}</td>
                  <td className="numeric">{row.cost == null ? "Unpriced" : formatReportedAmount(row.cost, currency, fx)}</td>
                </tr>)}</tbody>
              </table></div></Panel>}
            </div>
          </>}
  </div>;
}
