import type pg from "pg";
import type { RuleId } from "./templates.js";
import { ruleById } from "./templates.js";

/**
 * Built-in rule checks. They need no captured text: everything comes from the
 * calls and spans already stored for the run.
 */

export interface RunFacts {
  traceId: string;
  /** Root agent/workflow span name, then group name, then trace name. */
  runName: string | null;
  /** Every agent/workflow span name, group name and trace name in the run. */
  names: string[];
  calls: number;
  /** Calls that failed (>= 400) and were not followed by a successful retry. */
  failedCalls: number;
  /** Retry attempts: calls that name the attempt they replaced. */
  retries: number;
  spans: number;
  failedSpans: number;
  failedSpanNames: string[];
  runningSpans: number;
  toolSpans: number;
  failedToolSpans: number;
  traceFailed: boolean;
  /** Sum of priced calls, or null when nothing in the run is priced. */
  cost: number | null;
  unpricedCalls: number;
  durationMs: number | null;
  startedAt: string | null;
  endedAt: string | null;
}

export type RuleOutcome =
  | { kind: "score"; value: number; label: "pass" | "fail"; reason: string }
  | { kind: "skip"; reason: "not_applicable"; detail: string };

function plural(count: number, word: string, many = `${word}s`): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? word : many}`;
}

function round(value: number, places = 4): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function seconds(ms: number): string {
  const value = ms / 1000;
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)}s`;
}

function usd(value: number): string {
  if (value === 0) return "$0";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

/**
 * Score one rule against a run. Every rule scores in 0..1 where 1 is best and
 * sets an explicit pass/fail label, so the 0.5 pass line never overrides the
 * rule's own target.
 */
export function evaluateRule(rule: RuleId, facts: RunFacts, target: number | null): RuleOutcome {
  const definition = ruleById(rule);
  const limit = target ?? definition?.target?.default ?? 0;
  switch (rule) {
    case "run_succeeded": {
      const problems: string[] = [];
      if (facts.failedSpans > 0) {
        const names = facts.failedSpanNames.slice(0, 3).join(", ");
        problems.push(`${plural(facts.failedSpans, "failed span")}${names ? ` (${names})` : ""}`);
      }
      if (facts.failedCalls > 0) problems.push(plural(facts.failedCalls, "failed call"));
      if (problems.length === 0 && facts.traceFailed) problems.push("the run reported a failure");
      if (problems.length === 0) {
        return { kind: "score", value: 1, label: "pass", reason: `No failed spans or calls across ${plural(facts.calls, "call")}.` };
      }
      return { kind: "score", value: 0, label: "fail", reason: `Run failed: ${problems.join(" and ")}.` };
    }
    case "tool_errors": {
      if (facts.toolSpans === 0) return { kind: "skip", reason: "not_applicable", detail: "No tool calls in this run." };
      const share = facts.failedToolSpans / facts.toolSpans;
      const pass = share <= limit + 1e-12;
      return {
        kind: "score",
        value: round(1 - share),
        label: pass ? "pass" : "fail",
        reason: `${facts.failedToolSpans} of ${plural(facts.toolSpans, "tool call")} errored (${Math.round(share * 100)}%, limit ${Math.round(limit * 100)}%).`,
      };
    }
    case "retries": {
      if (facts.calls === 0) return { kind: "skip", reason: "not_applicable", detail: "No model calls in this run." };
      const pass = facts.retries <= limit;
      return {
        kind: "score",
        value: round(1 - Math.min(1, facts.retries / facts.calls)),
        label: pass ? "pass" : "fail",
        reason: `${plural(facts.retries, "retry", "retries")} across ${plural(facts.calls, "call")} (limit ${limit}).`,
      };
    }
    case "latency": {
      if (facts.durationMs == null) return { kind: "skip", reason: "not_applicable", detail: "The run has no recorded duration." };
      const targetMs = limit * 1000;
      const pass = facts.durationMs <= targetMs;
      return {
        kind: "score",
        value: pass || facts.durationMs <= 0 ? 1 : round(targetMs / facts.durationMs),
        label: pass ? "pass" : "fail",
        reason: `Took ${seconds(facts.durationMs)} against a target of ${seconds(targetMs)}.`,
      };
    }
    case "cost": {
      if (facts.cost == null) return { kind: "skip", reason: "not_applicable", detail: "No call in this run is priced yet." };
      const pass = facts.cost <= limit;
      const partial = facts.unpricedCalls > 0 ? ` ${plural(facts.unpricedCalls, "call")} not priced yet.` : "";
      return {
        kind: "score",
        value: pass || facts.cost <= 0 ? 1 : round(limit / facts.cost),
        label: pass ? "pass" : "fail",
        reason: `Cost ${usd(facts.cost)} against a target of ${usd(limit)}.${partial}`,
      };
    }
    default:
      return { kind: "skip", reason: "not_applicable", detail: "Unknown rule." };
  }
}

function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function iso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value) return new Date(value).toISOString();
  return null;
}

/** Everything the rules (and applies-to matching) need about one run. */
export async function loadRunFacts(pool: pg.Pool | pg.PoolClient, projectId: string, traceId: string): Promise<RunFacts | null> {
  // A single client runs one query at a time; a pool can run them together.
  const all = "release" in pool
    ? async <T,>(queries: Array<() => Promise<T>>) => { const out: T[] = []; for (const query of queries) out.push(await query()); return out; }
    : <T,>(queries: Array<() => Promise<T>>) => Promise.all(queries.map((query) => query()));
  const [calls, spans, trace] = await all([
    () => pool.query(
      `WITH c AS (
         SELECT id, status_code, parent_event_id, cost_usd, timestamp, duration_ms, group_name, trace_name,
                NULLIF(context->>'agent', '') AS agent
         FROM events
         WHERE project_id = $1 AND trace_id = $2 AND COALESCE(event_type, 'call') = 'call'
       )
       SELECT COUNT(*)::int AS calls,
              COUNT(*) FILTER (WHERE COALESCE(c.status_code, 200) >= 400 AND NOT EXISTS (
                SELECT 1 FROM c retry WHERE retry.parent_event_id = c.id AND COALESCE(retry.status_code, 200) < 400
              ))::int AS failed_calls,
              COUNT(*) FILTER (WHERE c.parent_event_id IS NOT NULL)::int AS retries,
              SUM(c.cost_usd) AS cost,
              COUNT(*) FILTER (WHERE c.cost_usd IS NULL)::int AS unpriced,
              MIN(c.timestamp) AS started_at,
              MAX(c.timestamp + COALESCE(c.duration_ms, 0) * INTERVAL '1 millisecond') AS ended_at,
              ARRAY_REMOVE(ARRAY_AGG(DISTINCT c.group_name), NULL) AS group_names,
              ARRAY_REMOVE(ARRAY_AGG(DISTINCT c.trace_name), NULL) AS trace_names,
              ARRAY_REMOVE(ARRAY_AGG(DISTINCT c.agent), NULL) AS agents
       FROM c`,
      [projectId, traceId],
    ),
    () => pool.query(
      `SELECT id, parent_span_id, kind, name, status, started_at, ended_at
       FROM spans WHERE project_id = $1 AND trace_id = $2
       ORDER BY (parent_span_id IS NULL) DESC, started_at ASC NULLS LAST, id`,
      [projectId, traceId],
    ),
    () => pool.query(
      "SELECT trace_name, state, started_at, ended_at FROM traces WHERE project_id = $1 AND id = $2",
      [projectId, traceId],
    ),
  ]);
  const callRow = (calls.rows[0] ?? {}) as Record<string, unknown>;
  const spanRows = spans.rows as Array<Record<string, unknown>>;
  const traceRow = trace.rows[0] as Record<string, unknown> | undefined;
  const callCount = num(callRow.calls) ?? 0;
  if (callCount === 0 && spanRows.length === 0 && !traceRow) return null;

  const named = spanRows.filter((span) => span.kind === "agent" || span.kind === "workflow");
  const root = named.find((span) => span.parent_span_id == null) ?? named[0];
  const groupNames = (callRow.group_names as string[] | null) ?? [];
  const traceNames = (callRow.trace_names as string[] | null) ?? [];
  const agents = (callRow.agents as string[] | null) ?? [];
  const traceName = typeof traceRow?.trace_name === "string" && traceRow.trace_name ? traceRow.trace_name : traceNames[0] ?? null;
  const runName = root ? String(root.name) : groupNames[0] ?? traceName;
  const names = [...new Set([
    ...named.map((span) => String(span.name)),
    ...groupNames,
    ...traceNames,
    ...agents,
    ...(traceName ? [traceName] : []),
  ].filter((name) => name.length > 0))];

  const failed = spanRows.filter((span) => span.status === "error");
  const tools = spanRows.filter((span) => span.kind === "tool");
  const spanStarts = spanRows.map((span) => iso(span.started_at)).filter((value): value is string => value !== null);
  const spanEnds = spanRows.map((span) => iso(span.ended_at)).filter((value): value is string => value !== null);
  const rootStart = root ? iso(root.started_at) : null;
  const rootEnd = root ? iso(root.ended_at) : null;
  const starts = [iso(callRow.started_at), ...spanStarts, iso(traceRow?.started_at)].filter((value): value is string => value !== null);
  const ends = [iso(callRow.ended_at), ...spanEnds, iso(traceRow?.ended_at)].filter((value): value is string => value !== null);
  const startedAt = rootStart ?? (starts.length ? starts.reduce((a, b) => (a < b ? a : b)) : null);
  const endedAt = rootEnd ?? (ends.length ? ends.reduce((a, b) => (a > b ? a : b)) : null);
  const durationMs = startedAt && endedAt ? Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)) : null;
  const pricedCost = num(callRow.cost);

  return {
    traceId,
    runName: runName ?? null,
    names,
    calls: callCount,
    failedCalls: num(callRow.failed_calls) ?? 0,
    retries: num(callRow.retries) ?? 0,
    spans: spanRows.length,
    failedSpans: failed.length,
    failedSpanNames: [...new Set(failed.map((span) => String(span.name)))],
    runningSpans: spanRows.filter((span) => span.status === "running").length,
    toolSpans: tools.length,
    failedToolSpans: tools.filter((span) => span.status === "error").length,
    traceFailed: traceRow?.state === "failed",
    cost: pricedCost,
    unpricedCalls: num(callRow.unpriced) ?? 0,
    durationMs,
    startedAt,
    endedAt,
  };
}

/** Applies-to: every run, or runs whose agent/workflow/group/trace name is listed. */
export function checkAppliesToRun(appliesTo: string, names: string[], facts: Pick<RunFacts, "names">): boolean {
  if (appliesTo !== "named") return true;
  const wanted = new Set(names);
  return facts.names.some((name) => wanted.has(name));
}
