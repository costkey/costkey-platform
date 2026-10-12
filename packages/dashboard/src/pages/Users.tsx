import { useEffect, useState } from "react";
import { ArrowLeft, Search } from "lucide-react";
import { Link, useParams } from "react-router-dom";
import type { TokenUsage } from "../api";
import { currentRouterPath } from "../basePath";
import { EmptyPanel, LoadingRows, MetricCard, PageHeader, Panel, StatusPill } from "../components/ConsolePrimitives";
import { LiveStatus } from "../components/LiveStatus";
import { LineChart } from "../components/OverviewBoard";
import { ProviderLabel } from "../components/ProviderLogo";
import { UserId } from "../components/UserId";
import { formatDateTime, formatReportedAmount } from "../components/consoleFormatters";
import { billedUnitsText, formatTokenCount } from "../components/tokenUsage";
import { getUserDetail, getUsers, type UserDetail, type UserRow, type UserRun } from "../usersApi";
import { formatDuration } from "../utils";
import { useInsightScope, useScopedLoad } from "./useInsightScope";
import "./Users.css";

type Money = (value: number | null | undefined) => string;

function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}

/** Path to a user's page, keeping period and environment. */
function userPath(userId: string): string {
  return `/users/${encodeURIComponent(userId)}${window.location.search}`;
}

/** Tokens in and out, or the units a non-token model bills. Never "0 tokens" for a characters-only user. */
function usageText(usage: TokenUsage | undefined, units: Record<string, number> | undefined): { value: string; detail: string } {
  const tokens = (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
  const billed = billedUnitsText(units);
  if (tokens > 0) return { value: `${formatTokenCount(tokens)} tokens`, detail: billed };
  return { value: billed || "—", detail: "" };
}

function shareText(cost: number | null, total: number | null): string {
  if (cost == null || total == null || total <= 0) return "—";
  const share = cost / total;
  if (share > 0 && share < 0.01) return "<1%";
  return `${Math.round(share * 100)}%`;
}

/* ── Users list ───────────────────────────────────────────────────── */

function UsersTable({ users, totalCost, money }: { users: UserRow[]; totalCost: number | null; money: Money }) {
  return <div className="ck-table-wrap"><table className="ck-table">
    <thead><tr>
      <th>User</th>
      <th className="numeric">Runs</th>
      <th className="numeric hide-mobile">Calls</th>
      <th className="numeric hide-mobile" title="Tokens in and out, or the units a model bills">Usage</th>
      <th className="numeric">Spend</th>
      <th className="numeric" title="Share of all spend in this period"><span className="ck-users-label-long">Share of spend</span><span className="ck-users-label-short">Share</span></th>
      <th className="hide-mobile">Agents and workflows</th>
    </tr></thead>
    <tbody>{users.map((user) => {
      const usage = usageText(user.usage, user.units);
      return <tr key={user.userId} className="ck-users-row">
        <td className="primary-cell"><UserId id={user.userId} to={userPath(user.userId)} linkClassName="ck-table-link ck-users-stretch" />{user.lastRun && <small className="ck-table-sub">Last run {formatDateTime(user.lastRun)}</small>}</td>
        <td className="numeric">{user.runs.toLocaleString()}</td>
        <td className="numeric hide-mobile">{user.calls.toLocaleString()}</td>
        <td className="numeric hide-mobile ck-users-nowrap">{usage.value}{usage.detail && <small className="ck-table-sub">{usage.detail}</small>}</td>
        <td className="numeric">{money(user.cost)}</td>
        <td className="numeric">{shareText(user.cost, totalCost)}</td>
        <td className="hide-mobile"><div className="ck-users-owners" title={user.agents.join(", ")}>{user.agents.join(", ") || "—"}</div></td>
      </tr>;
    })}</tbody>
  </table></div>;
}

export function UsersPage() {
  const { projectId, scope, scopeKey, currency, fx, toolbar } = useInsightScope();
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(draft.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [draft]);
  const { data, error, loading, status, updatedAt, refresh } = useScopedLoad(
    projectId ? `users|${scopeKey}|${query}` : null,
    () => getUsers(projectId!, scope, query),
  );
  const money: Money = (value) => value == null ? "Unpriced" : formatReportedAmount(value, currency, fx);
  const users = data?.users ?? [];
  const missing = data?.totals.runsWithoutUser ?? 0;
  return <div className="ck-main-inner">
    <PageHeader title="Users" actions={<><LiveStatus status={status} updatedAt={updatedAt} onRefresh={refresh} />{toolbar}</>} />
    <Panel>
      <div className="ck-users-toolbar">
        <label className="ck-users-search">
          <Search size={14} aria-hidden="true" />
          <input type="search" aria-label="Search user ids" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Search user id" autoComplete="off" spellCheck={false} />
        </label>
      </div>
      {error && !data ? <EmptyPanel title="Couldn’t load users" body={error} />
        : loading && !data ? <LoadingRows count={6} columns={5} />
        : users.length === 0 ? <EmptyPanel title={query ? `No user ids match “${query}”.` : "No runs with a user id in this period."} />
        : <UsersTable users={users} totalCost={data!.totals.cost} money={money} />}
      {missing > 0 && <p className="ck-table-note">{plural(missing, "run has", "runs have")} no user id. Send context.customer or userId with your calls.</p>}
    </Panel>
  </div>;
}

/* ── User detail ──────────────────────────────────────────────────── */

function OwnersTable({ owners, money }: { owners: UserDetail["owners"]; money: Money }) {
  const search = window.location.search;
  return <div className="ck-table-wrap"><table className="ck-table">
    <thead><tr><th>Name</th><th className="hide-mobile">Kind</th><th className="numeric">Runs</th><th className="numeric">Spend</th></tr></thead>
    <tbody>{owners.map((owner) => <tr key={`${owner.kind}/${owner.name}`} className="ck-users-row">
      <td className="primary-cell"><Link className="ck-table-link ck-users-stretch" to={`/${owner.kind === "agent" ? "agents" : "workflows"}/${encodeURIComponent(owner.name)}${search}`}>{owner.name}</Link><small className="ck-table-sub ck-users-mobile-only">{owner.kind === "agent" ? "Agent" : "Workflow"}</small></td>
      <td className="hide-mobile">{owner.kind === "agent" ? "Agent" : "Workflow"}</td>
      <td className="numeric">{owner.runs.toLocaleString()}</td>
      <td className="numeric">{money(owner.cost)}</td>
    </tr>)}</tbody>
  </table></div>;
}

function ModelsTable({ models, money }: { models: UserDetail["models"]; money: Money }) {
  const search = window.location.search;
  return <div className="ck-table-wrap"><table className="ck-table">
    <thead><tr><th>Model</th><th className="numeric">Calls</th><th className="numeric hide-mobile" title="Tokens in and out, or the units the model bills">Usage</th><th className="numeric">Spend</th></tr></thead>
    <tbody>{models.map((model) => {
      const usage = usageText(model.usage, model.units);
      const key = `${model.provider ?? ""}/${model.model}`;
      return <tr key={key} className={model.provider ? "ck-users-row" : undefined}>
        <td className="primary-cell">{model.provider
          ? <Link className="ck-table-link ck-users-stretch" to={`/models/${encodeURIComponent(model.provider)}/${encodeURIComponent(model.model)}${search}`}>{model.model}</Link>
          : model.model}{model.provider && <small className="ck-table-sub"><ProviderLabel provider={model.provider} size={12} /></small>}</td>
        <td className="numeric">{model.calls.toLocaleString()}</td>
        <td className="numeric hide-mobile ck-users-nowrap">{usage.value}{usage.detail && <small className="ck-table-sub">{usage.detail}</small>}</td>
        <td className="numeric">{money(model.cost)}</td>
      </tr>;
    })}</tbody>
  </table></div>;
}

function RunStatus({ run }: { run: UserRun }) {
  if (run.retry?.retried) return <StatusPill tone="warn">Retried</StatusPill>;
  if (run.failed) return <StatusPill tone="critical">Failed</StatusPill>;
  return <StatusPill tone="good">Done</StatusPill>;
}

function RunsTable({ runs, money }: { runs: UserRun[]; money: Money }) {
  return <div className="ck-table-wrap"><table className="ck-table">
    <thead><tr><th>Started</th><th className="hide-mobile">Agent or workflow</th><th className="numeric hide-mobile">Calls</th><th className="numeric hide-mobile">Usage</th><th className="numeric hide-mobile">Time</th><th>Status</th><th className="numeric">Cost</th></tr></thead>
    <tbody>{runs.map((run) => {
      const usage = usageText(run.usage, undefined);
      return <tr key={run.traceId} className="ck-users-row">
        <td className="primary-cell ck-users-nowrap"><Link className="ck-table-link ck-users-stretch" to={`/traces/${encodeURIComponent(run.traceId)}`} state={{ returnTo: currentRouterPath() }}>{formatDateTime(run.startedAt)}</Link><small className="ck-table-sub ck-users-mobile-only">{run.name}</small></td>
        <td className="hide-mobile"><div className="ck-users-owners" title={run.name}>{run.name}</div></td>
        <td className="numeric hide-mobile">{run.calls.toLocaleString()}</td>
        <td className="numeric hide-mobile ck-users-nowrap">{usage.value}</td>
        <td className="numeric hide-mobile">{run.durationMs == null ? "—" : formatDuration(run.durationMs)}</td>
        <td><RunStatus run={run} /></td>
        <td className="numeric">{money(run.cost)}</td>
      </tr>;
    })}</tbody>
  </table></div>;
}

function decodeParam(value: string | undefined): string {
  if (!value) return "";
  try { return decodeURIComponent(value); } catch { return value; }
}

export function UserDetailPage() {
  const params = useParams();
  const userId = decodeParam(params["userId"]);
  const { projectId, scope, scopeKey, currency, fx, toolbar } = useInsightScope();
  const { data, error, loading, status, updatedAt, refresh } = useScopedLoad(
    projectId && userId ? `user|${userId}|${scopeKey}` : null,
    () => getUserDetail(projectId!, userId, scope),
  );
  const money: Money = (value) => value == null ? "Unpriced" : formatReportedAmount(value, currency, fx);
  const summary = data?.summary;
  const first = loading && !data;
  const empty = Boolean(data && data.summary.runs === 0);
  const usage = usageText(summary?.usage, summary?.units);
  const tokenDetail = summary && (summary.usage.inputTokens ?? 0) + (summary.usage.outputTokens ?? 0) > 0
    ? [`${formatTokenCount(summary.usage.inputTokens)} in`, `${formatTokenCount(summary.usage.outputTokens)} out`, usage.detail].filter(Boolean).join(", ")
    : undefined;
  const runDetail = summary && (summary.failedRuns > 0 || summary.retriedRuns > 0)
    ? [summary.failedRuns > 0 ? `${summary.failedRuns.toLocaleString()} failed` : null, summary.retriedRuns > 0 ? `${summary.retriedRuns.toLocaleString()} retried` : null].filter(Boolean).join(", ")
    : summary && summary.runs > 0 ? "None failed" : undefined;
  return <div className="ck-main-inner">
    <Link className="ck-back-link" to={`/users${window.location.search}`}><ArrowLeft size={13} /> Users</Link>
    <div className="ck-page-header">
      <div className="min-w-0">
        <h1 className="ck-page-title ck-users-title"><UserId id={userId} length={18} /></h1>
      </div>
      <div className="ck-page-actions"><LiveStatus status={status} updatedAt={updatedAt} onRefresh={refresh} />{toolbar}</div>
    </div>
    {error && !data ? <Panel><EmptyPanel title="Couldn’t load this user" body={error} /></Panel> : <>
      <div className="ck-metric-grid ck-metric-grid-4 ck-users-metrics">
        <MetricCard icon="cost" label="Spend" value={summary ? summary.cost == null && summary.runs === 0 ? formatReportedAmount(0, currency, fx) : money(summary.cost) : "—"} detail={summary && summary.runs > 0 && summary.cost != null ? `${money(summary.cost / summary.runs)} per run` : undefined} loading={first} />
        <MetricCard icon="trace" label="Runs" value={(summary?.runs ?? 0).toLocaleString()} detail={runDetail} tone={summary && summary.failedRuns > 0 ? "warn" : "neutral"} loading={first} />
        <MetricCard icon="model" label="Usage" value={usage.value} detail={tokenDetail} loading={first} />
        <MetricCard icon="clock" label="Last run" value={summary?.lastRun ? formatDateTime(summary.lastRun) : "—"} detail={summary?.firstRun && summary.firstRun !== summary.lastRun ? `First ${formatDateTime(summary.firstRun)}` : undefined} loading={first} />
      </div>
      <Panel title="Spend over time" subtitle={data ? `Per day, ${data.window.timezone} time` : undefined}>
        {first ? <div className="ck-users-chart"><LoadingRows count={4} columns={1} /></div>
          : data && !empty ? <div className="ck-users-chart"><LineChart
            buckets={data.series.map((point) => point.bucket)}
            unit="day"
            series={[{ key: "spend", label: "Spend", color: "#3a6db0", values: data.series.map((point) => point.cost) }]}
            format={(value) => money(value)}
            label={`Spend for ${userId} over time`}
          /></div>
          : <EmptyPanel title="No runs for this user in this period." />}
      </Panel>
      <Panel title="Agents and workflows" subtitle={data && data.owners.length > 0 ? "By spend" : undefined}>
        {first ? <LoadingRows count={3} columns={4} /> : (data?.owners.length ?? 0) === 0 ? <EmptyPanel title="No agents or workflows in this period." /> : <OwnersTable owners={data!.owners} money={money} />}
      </Panel>
      <Panel title="Models" subtitle={data && data.models.length > 0 ? "By spend" : undefined}>
        {first ? <LoadingRows count={3} columns={4} /> : (data?.models.length ?? 0) === 0 ? <EmptyPanel title="No model calls in this period." /> : <ModelsTable models={data!.models} money={money} />}
      </Panel>
      <Panel title="Runs" subtitle={data && data.runs.length > 0 ? `Latest ${data.runs.length.toLocaleString()} in this period` : undefined}>
        {first ? <LoadingRows count={5} columns={5} /> : (data?.runs.length ?? 0) === 0 ? <EmptyPanel title="No runs in this period." /> : <RunsTable runs={data!.runs} money={money} />}
      </Panel>
    </>}
  </div>;
}
