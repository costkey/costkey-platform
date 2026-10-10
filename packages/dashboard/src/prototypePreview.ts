/*
 * The console prototype is the visual source of truth for the local design
 * preview.  This adapter deliberately lives at the browser boundary: the
 * production API helpers and authenticated application remain unchanged, but
 * an explicitly requested `?design=prototype` session receives the exact
 * synthetic fixture used by design/console-prototype.
 */
const MICRODOLLARS = 1_000_000;
const PROTOTYPE_PROJECT_ID = "proj_preview";
const PROTOTYPE_PROJECT_NAME = "Atlas";
const PROTOTYPE_ORG_ID = "org_preview";
const PROTOTYPE_ORG_NAME = "Northstar";
const PROTOTYPE_TIMEZONE = "Asia/Kolkata";
const PROTOTYPE_CURRENCY = "USD";
const PROTOTYPE_START = Date.UTC(2026, 8, 1, 0, 0, 0) - 330 * 60 * 1000;

interface PrototypeCall {
  name: string;
  cost: number | null;
  provider: string;
  model: string;
  function: string;
  start: number;
  duration: number;
  phase?: string;
  id: string;
  source?: string;
  basis?: string;
  http?: string;
  input?: number;
  output?: number;
  unit?: string;
  attempt?: number;
  operationId?: string;
  stepKey?: string;
}

interface PrototypeTrace {
  id: string;
  feature: string;
  cost: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  environment: string;
  customer: string;
  service: string;
  release: string;
  operation: string;
  duration: number;
  state: string;
  group: string | null;
  variant: string | null;
  calls: PrototypeCall[];
}

interface PrototypeWindow {
  from: string;
  to: string;
}

interface GroupValue {
  key: string;
  label: string;
  cost: number;
  observations: number;
  pricedObservations: number;
  traceIds: Set<string>;
  traces: PrototypeTrace[];
}

interface PreviewGlobal {
  __costkeyPrototypePreviewEnabled?: boolean;
  __costkeyPrototypeFetchInstalled?: boolean;
}

let TRACE_DATA: PrototypeTrace[] = [];

function parsePrototypeSource(source: string): PrototypeTrace[] {
  const parsedSource = source
    .replace(/^\s*const\s+TRACE_DATA\s*=\s*/, "")
    .replace(/;\s*$/, "");
  return JSON.parse(parsedSource) as PrototypeTrace[];
}

function previewGlobal(): PreviewGlobal {
  return window as unknown as PreviewGlobal;
}

function isRequested(): boolean {
  return new URLSearchParams(window.location.search).get("design") === "prototype"
    || import.meta.env.VITE_DESIGN_PREVIEW === "true";
}

export function isPrototypePreview(): boolean {
  return previewGlobal().__costkeyPrototypePreviewEnabled === true;
}

function money(value: number | null | undefined): number | null {
  return value == null ? null : value / MICRODOLLARS;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function totalCost(traces: PrototypeTrace[]): number {
  return sum(traces.map((trace) => trace.cost));
}

function totalCalls(traces: PrototypeTrace[]): number {
  return sum(traces.map((trace) => trace.calls.length));
}

function totalInput(traces: PrototypeTrace[]): number {
  return sum(traces.flatMap((trace) => trace.calls.map((call) => call.input ?? 0)));
}

function totalOutput(traces: PrototypeTrace[]): number {
  return sum(traces.flatMap((trace) => trace.calls.map((call) => call.output ?? 0)));
}

function localTimestamp(trace: PrototypeTrace, offsetSeconds = 0): string {
  const offset = (((trace.day - 1) * 24 + trace.hour) * 60 + trace.minute) * 60 + trace.second;
  return new Date(PROTOTYPE_START + (offset + offsetSeconds) * 1000).toISOString();
}

function traceWindow(trace: PrototypeTrace): PrototypeWindow {
  return { from: localTimestamp(trace), to: localTimestamp(trace, trace.duration) };
}

function functionParts(value: string): { name: string; file: string | null } {
  const [name, ...rest] = value.split(" · ");
  return { name: name || value, file: rest.length > 0 ? rest.join(" · ") : null };
}

function traceMatches(trace: PrototypeTrace, url: URL): boolean {
  const query = url.searchParams.get("q") ?? url.searchParams.get("query");
  const haystack = [
    trace.id,
    trace.feature,
    trace.customer,
    trace.service,
    trace.release,
    trace.operation,
    trace.group ?? "",
    ...trace.calls.flatMap((call) => [call.id, call.name, call.provider, call.model, call.function]),
  ].join(" ").toLowerCase();
  if (query && !haystack.includes(query.toLowerCase())) return false;

  const exactTraceFilters: Array<[string, (trace: PrototypeTrace) => string | null]> = [
    ["feature", (item) => item.feature],
    ["customer", (item) => item.customer],
    ["service", (item) => item.service],
    ["release", (item) => item.release],
    ["group", (item) => item.group],
    ["operation", (item) => item.operation],
  ];
  for (const [key, getValue] of exactTraceFilters) {
    const values = url.searchParams.getAll(key).flatMap((value) => value.split("|"));
    if (values.length > 0 && !values.some((value) => getValue(trace) === value)) return false;
  }

  const environmentValues = url.searchParams.getAll("environment").flatMap((value) => value.split("|"));
  if (environmentValues.length > 0 && !environmentValues.includes("all") && !environmentValues.includes(trace.environment)) return false;

  for (const key of ["provider", "model", "function"] as const) {
    const values = url.searchParams.getAll(key).flatMap((value) => value.split("|"));
    if (values.length > 0 && !trace.calls.some((call) => values.includes(call[key]))) return false;
  }

  const statusValues = url.searchParams.getAll("status").flatMap((value) => value.split("|"));
  if (statusValues.length > 0 && !statusValues.includes(trace.state.toLowerCase()) && !statusValues.includes(trace.state)) return false;
  return true;
}

function filteredTraces(url: URL): PrototypeTrace[] {
  return TRACE_DATA.filter((trace) => traceMatches(trace, url));
}

function filteredCalls(trace: PrototypeTrace, url: URL): PrototypeCall[] {
  const keys: Array<"provider" | "model" | "function"> = ["provider", "model", "function"];
  return trace.calls.filter((call) => keys.every((key) => {
    const values = url.searchParams.getAll(key).flatMap((value) => value.split("|"));
    return values.length === 0 || values.includes(call[key]);
  }));
}

function traceRecord(trace: PrototypeTrace, calls = trace.calls): Record<string, unknown> {
  const { from, to } = traceWindow(trace);
  const cost = sum(calls.map((call) => call.cost ?? 0));
  const input = sum(calls.map((call) => call.input ?? 0));
  const output = sum(calls.map((call) => call.output ?? 0));
  return {
    trace_id: trace.id,
    trace_name: trace.id,
    call_count: calls.length,
    total_cost: money(cost) ?? 0,
    known_cost: money(cost),
    total_input_tokens: input,
    total_output_tokens: output,
    started_at: from,
    ended_at: to,
    total_duration_ms: trace.duration * 1000,
    elapsed_ms: trace.duration * 1000,
    models: [...new Set(calls.map((call) => call.model))].join(","),
    providers: [...new Set(calls.map((call) => call.provider))].join(","),
    feature: trace.feature,
    customer: trace.customer,
    environment: trace.environment,
    execution_id: trace.group ? `execution-${trace.group.replaceAll(/[^a-zA-Z0-9]+/g, "-").toLowerCase()}` : null,
    group_id: trace.group,
    unpriced_count: calls.filter((call) => call.cost == null).length,
    pricing_coverage: calls.length > 0 ? calls.filter((call) => call.cost != null).length / calls.length : null,
    execution_state: trace.state.toLowerCase(),
    accounting_state: calls.some((call) => call.cost == null) ? "partial" : "complete",
  };
}

function eventRecord(trace: PrototypeTrace, call: PrototypeCall): Record<string, unknown> {
  const parts = functionParts(call.function);
  const timestamp = localTimestamp(trace, call.start);
  const input = call.input ?? null;
  const output = call.output ?? null;
  const context = {
    feature: trace.feature,
    customer: trace.customer,
    environment: trace.environment,
    service: trace.service,
    release: trace.release,
    operation: trace.operation,
    ...(trace.group ? { group: trace.group } : {}),
    ...(trace.variant ? { variant: trace.variant } : {}),
    ...(call.stepKey ? { stepKey: call.stepKey } : {}),
  };
  const frame = { functionName: parts.name, fileName: parts.file, lineNumber: parts.name === "build_context" ? 148 : 42 };
  return {
    id: call.id,
    timestamp,
    trace_id: trace.id,
    trace_name: trace.id,
    provider: call.provider,
    model: call.model,
    request_model: call.model,
    event_type: "call",
    source: call.source ?? "Mapped location",
    attempt_id: call.attempt && call.attempt > 1 ? String(call.attempt) : null,
    parent_event_id: call.attempt && call.attempt > 1 ? call.operationId ? `${trace.id}:c4` : null : null,
    cost_basis: call.cost == null ? "unknown" : call.basis === "Reported" ? "reported" : "estimated",
    cost_source: call.cost == null ? null : "Synthetic fixture rate",
    cost_currency: PROTOTYPE_CURRENCY,
    content_status: "captured",
    unit_kind: call.unit ?? "tokens",
    unit_value: call.unit ? call.input ?? null : null,
    unit: call.unit ?? "tokens",
    aggregation: "component",
    url: `https://api.${call.provider.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}.example/v1/chat/completions`,
    method: "POST",
    status_code: Number(call.http ?? 200),
    input_tokens: input,
    output_tokens: output,
    total_tokens: input == null && output == null ? null : (input ?? 0) + (output ?? 0),
    cost_usd: money(call.cost),
    duration_ms: call.duration * 1000,
    streaming: 0,
    ttft: null,
    tps: null,
    call_site_raw: call.function,
    call_site_frames: JSON.stringify([frame]),
    context: JSON.stringify(context),
    metadata: JSON.stringify({ fixture: "CostKey design prototype", callName: call.name, phase: call.phase ?? null }),
    system_prompt: "You summarize retrieved context. Keep citations and do not invent missing values.",
    request_body: JSON.stringify({ model: call.model, messages: [{ role: "user", content: call.name }] }),
    response_body: JSON.stringify({ output: "Synthetic design-preview response." }),
    bl_function: parts.name,
    bl_file: parts.file,
    bl_line: frame.lineNumber,
    feature_source: "mapped",
    feature_mapping_id: null,
    feature_original: trace.feature,
  };
}

function eventRecords(traces: PrototypeTrace[]): Record<string, unknown>[] {
  return traces.flatMap((trace) => trace.calls.map((call) => eventRecord(trace, call)));
}

function groupValues(traces: PrototypeTrace[], groupBy: string, url: URL): GroupValue[] {
  const groups = new Map<string, GroupValue>();
  const callLevel = ["function", "model", "provider"].includes(groupBy);
  for (const trace of traces) {
    const calls = callLevel ? filteredCalls(trace, url) : trace.calls;
    if (calls.length === 0) continue;
    if (callLevel) {
      for (const call of calls) {
        const key = call[groupBy as "function" | "model" | "provider"] || "Unassigned";
        const existing = groups.get(key) ?? { key, label: key, cost: 0, observations: 0, pricedObservations: 0, traceIds: new Set<string>(), traces: [] };
        existing.cost += call.cost ?? 0;
        existing.observations += 1;
        if (call.cost != null) existing.pricedObservations += 1;
        existing.traceIds.add(trace.id);
        if (!existing.traces.some((item) => item.id === trace.id)) existing.traces.push(trace);
        groups.set(key, existing);
      }
    } else {
      const key = (trace[groupBy as keyof PrototypeTrace] as string | null | undefined) || "Unassigned";
      const existing = groups.get(key) ?? { key, label: key, cost: 0, observations: 0, pricedObservations: 0, traceIds: new Set<string>(), traces: [] };
      existing.cost += sum(calls.map((call) => call.cost ?? 0));
      existing.observations += 1;
      if (calls.every((call) => call.cost != null)) existing.pricedObservations += 1;
      existing.traceIds.add(trace.id);
      existing.traces.push(trace);
      groups.set(key, existing);
    }
  }
  return [...groups.values()].sort((left, right) => right.cost - left.cost || left.label.localeCompare(right.label));
}

function contributorRecord(group: GroupValue, groupBy: string, previous: GroupValue | undefined): Record<string, unknown> {
  const traceLevel = !["function", "model", "provider"].includes(groupBy);
  const previousCost = previous ? money(previous.cost) : null;
  const currentCost = money(group.cost);
  const traces = group.traceIds.size;
  const priorMean = previous && previous.traceIds.size > 0 ? previous.cost / previous.traceIds.size : null;
  const currentMean = traces > 0 ? group.cost / traces : null;
  return {
    key: group.key,
    label: group.label,
    name: group.label,
    secondary: group.label === "Unassigned" ? null : null,
    cost_currency: PROTOTYPE_CURRENCY,
    known_cost: currentCost,
    cost: currentCost,
    observations: group.observations,
    calls: group.observations,
    priced_observations: group.pricedObservations,
    unpriced_count: group.observations - group.pricedObservations,
    coverage: group.observations > 0 ? group.pricedObservations / group.observations : null,
    trace_count: traces,
    fully_priced_trace_count: traceLevel ? group.pricedObservations : traces,
    fully_priced_trace_cost: currentCost,
    mean_cost_per_trace: currentMean == null ? null : money(currentMean),
    mean_cost_per_charge: group.observations > 0 ? money(group.cost / group.observations) : null,
    unit_cost: currentMean == null ? null : money(currentMean),
    unit_basis: traceLevel ? "trace" : "charge",
    unit_label: traceLevel ? "per trace" : "per call",
    previous_known_cost: previousCost,
    change_abs: currentCost != null && previousCost != null ? currentCost - previousCost : null,
    change_pct: currentMean != null && priorMean != null && priorMean > 0 ? (currentMean / priorMean - 1) * 100 : null,
  };
}

function availableFilters(traces: PrototypeTrace[]): Record<string, unknown> {
  const calls = traces.flatMap((trace) => trace.calls);
  const unique = (values: string[]): string[] => [...new Set(values.filter(Boolean))].sort();
  return {
    providers: unique(calls.map((call) => call.provider)),
    models: unique(calls.map((call) => call.model)),
    environments: unique(traces.map((trace) => trace.environment)),
    features: unique(traces.map((trace) => trace.feature)),
    customers: unique(traces.map((trace) => trace.customer)),
    functions: unique(calls.map((call) => call.function)),
    lifecycles: unique(traces.map((trace) => trace.state.toLowerCase())),
    accounting: ["complete", "partial"],
    coverage: ["priced", "unpriced"],
    statuses: unique(traces.map((trace) => trace.state.toLowerCase())),
    contextKeys: ["feature", "customer", "environment", "service", "release", "operation", "group", "variant"],
    counts: {},
  };
}

function trends(traces: PrototypeTrace[]): Record<string, unknown>[] {
  return Array.from({ length: 20 }, (_, index) => {
    const day = index + 1;
    const dayTraces = traces.filter((trace) => trace.day === day);
    return {
      bucket: `2026-09-${String(day).padStart(2, "0")}T00:00:00.000Z`,
      calls: totalCalls(dayTraces),
      cost: money(totalCost(dayTraces)),
      observations: dayTraces.length,
      unpriced_count: dayTraces.flatMap((trace) => trace.calls).filter((call) => call.cost == null).length,
      coverage: 1,
      input_tokens: totalInput(dayTraces),
      output_tokens: totalOutput(dayTraces),
      avg_duration_ms: dayTraces.length > 0 ? sum(dayTraces.map((trace) => trace.duration * 1000)) / dayTraces.length : 0,
    };
  });
}

function overview(): Record<string, unknown> {
  const traces = TRACE_DATA;
  const calls = totalCalls(traces);
  const cost = money(totalCost(traces)) ?? 0;
  return {
    total_calls: calls,
    total_cost: cost,
    known_cost: cost,
    observations: traces.length,
    priced_observations: calls,
    unpriced_count: 0,
    pricing_coverage: 1,
    trace_count: traces.length,
    priced_trace_count: traces.length,
    total_input_tokens: totalInput(traces),
    total_output_tokens: totalOutput(traces),
    avg_duration_ms: calls > 0 ? sum(traces.flatMap((trace) => trace.calls.map((call) => call.duration * 1000))) / calls : 0,
    avg_ttft: 0,
    avg_tps: 0,
    average_cost_per_trace: traces.length > 0 ? cost / traces.length : null,
  };
}

function summary(): Record<string, unknown> {
  const thisMonthCost = money(totalCost(TRACE_DATA)) ?? 0;
  const thisMonthCalls = totalCalls(TRACE_DATA);
  const thisMonthTokens = totalInput(TRACE_DATA) + totalOutput(TRACE_DATA);
  const previousTraces = TRACE_DATA.filter((trace) => trace.day >= 7 && trace.day <= 13);
  const previousCost = money(totalCost(previousTraces)) ?? 0;
  return {
    thisMonth: { cost: thisMonthCost, calls: thisMonthCalls, tokens: thisMonthTokens },
    lastMonth: { cost: previousCost, calls: totalCalls(previousTraces), tokens: totalInput(previousTraces) + totalOutput(previousTraces) },
    costChange: previousCost > 0 ? ((thisMonthCost - previousCost) / previousCost) * 100 : 0,
    callsChange: 0,
    topFeatures: groupValues(TRACE_DATA, "feature", new URL("http://prototype.local")).slice(0, 5).map((group) => ({ function_name: group.label, file_name: null, cost: money(group.cost) ?? 0, calls: group.observations, pct: thisMonthCost > 0 ? (group.cost / totalCost(TRACE_DATA)) * 100 : 0 })),
    dailyAvg: thisMonthCost / 20,
    projectedMonthly: thisMonthCost * 30 / 20,
    byRelease: [],
    costChangeFromPrevRelease: null,
  };
}

function policyRecords(): Array<Record<string, unknown>> {
  return [
    { id: "project", project_id: PROTOTYPE_PROJECT_ID, name: "Atlas monthly allowance", scope: { project: "Atlas" }, mode: "monitor", status: "active", unit: "money", allowance: 400, currency: "USD", window: "calendar_month", timezone: PROTOTYPE_TIMEZONE, usage: { observed: 248.6, committed: 0, remaining: 151.4, coverage: 1 } },
    { id: "search", project_id: PROTOTYPE_PROJECT_ID, name: "Search monthly allowance", scope: { feature: "Search" }, mode: "monitor", status: "active", unit: "money", allowance: 200, currency: "USD", window: "calendar_month", timezone: PROTOTYPE_TIMEZONE, usage: { observed: 142.8, committed: 0, remaining: 57.2, coverage: 1 } },
    { id: "job", project_id: PROTOTYPE_PROJECT_ID, name: "Nightly document allowance", scope: { group: "nightly-document-import" }, mode: "enforce", status: "active", unit: "money", allowance: 6, currency: "USD", window: "per_execution", timezone: PROTOTYPE_TIMEZONE, usage: { observed: 6.18, committed: 0, remaining: 0, coverage: 1 } },
    { id: "voice", project_id: PROTOTYPE_PROJECT_ID, name: "Voice calls per conversation", scope: { feature: "Voice assistance" }, mode: "monitor", status: "active", unit: "calls", allowance: 20, currency: null, window: "per_trace", timezone: PROTOTYPE_TIMEZONE, usage: { observed: 8, committed: 0, remaining: 12, coverage: 1 } },
  ];
}

function findingRecord(): Record<string, unknown> {
  const affected = TRACE_DATA.filter((trace) => trace.day >= 14 && trace.environment === "Production" && trace.feature === "Search" && trace.operation === "search.retrieve").slice(0, 200).map((trace) => trace.id);
  return {
    id: "finding-search-unit-cost",
    projectId: PROTOTYPE_PROJECT_ID,
    family: "increased_unit_cost",
    state: "open",
    scope: { feature: "Search", environment: "Production", operation: "search.retrieve" },
    observedAt: "2026-09-20T14:33:00.000Z",
    lastSeenAt: "2026-09-20T14:33:00.000Z",
    baseline: { unitCost: 0.08, traceCount: 160 },
    evidence: {
      currentUnitCost: 0.14,
      previousUnitCost: 0.08,
      absoluteDifference: 0.06,
      currentTraceCount: 200,
      previousTraceCount: 160,
      currentTraces: 200,
      previousTraces: 160,
      currentPricingCoverage: 1,
      pricedCoverage: 1,
      affectedTraceIds: affected,
      supportingTraceIds: ["search-request-1042"],
      // The overview teaser treats this legacy field as the observed unit
      // value. Keep it at $0.12 so its delta renders as the prototype's
      // canonical +$0.06; the drawer uses currentUnitCost ($0.14) and still
      // retains the full trace-level evidence separately.
      traceCost: 0.12,
    },
    nextActions: ["Compare equal-duration traces", "Inspect model, release, and retry composition"],
    occurrenceCount: 1,
    acknowledgedAt: null,
    acknowledgedBy: null,
  };
}

function executions(): Array<Record<string, unknown>> {
  const executionRows = [
    { id: "nightly-search-quality-20", group: "nightly-search-quality / 20 Sep", day: 20, amount: 5.22, outcome: "completed", completed: 100, failed: 0 },
    { id: "nightly-search-quality-19", group: "nightly-search-quality / 19 Sep", day: 19, amount: 5.4, outcome: "completed", completed: 98, failed: 2 },
  ];
  return executionRows.map((row) => ({
    id: row.id,
    project_id: PROTOTYPE_PROJECT_ID,
    group_id: row.group,
    name: row.group,
    kind: "evaluation",
    state: row.outcome,
    execution_state: row.outcome,
    started_at: `2026-09-${String(row.day).padStart(2, "0")}T02:00:00.000Z`,
    ended_at: `2026-09-${String(row.day).padStart(2, "0")}T02:00:05.400Z`,
    elapsed_ms: 5400,
    observations: 100,
    call_count: row.day === 19 ? 300 : 300,
    known_cost: row.amount,
    unpriced_count: 0,
    pricing_coverage: 1,
    accounting_state: "complete",
    expected_items: 100,
    completed_items: row.completed,
    failed_items: row.failed,
    phases: { Generation: { knownCost: row.day === 19 ? 4 : 3.9, observations: 100, unpricedCount: 0 }, Scoring: { knownCost: row.day === 19 ? 1.2 : 1.12, observations: 100, unpricedCount: 0 }, Retrieval: { knownCost: 0.2, observations: 100, unpricedCount: 0 } },
    configuration: { examples: 50, variants: "A and B" },
    dataset_revision: "2026.09",
    service: "search-api",
    release: "2026.09.18",
  }));
}

function executionDetail(id: string): Record<string, unknown> {
  const execution = executions().find((item) => item.id === id) ?? executions()[0];
  const memberTraces = TRACE_DATA.filter((trace) => trace.group === execution.group_id).slice(0, 100);
  return {
    execution,
    traces: memberTraces.map((trace) => ({ trace_id: trace.id, trace_name: trace.id, call_count: trace.calls.length, started_at: localTimestamp(trace), ended_at: localTimestamp(trace, trace.duration) })),
    phases: Object.entries(execution.phases as Record<string, Record<string, unknown>>).map(([phase, value]) => ({ phase, observations: Number(value.observations ?? 0), known_cost: value.knownCost as number | null, unpriced_count: Number(value.unpricedCount ?? 0) })),
  };
}

function contributorDetail(url: URL, dimension: string, value: string): Record<string, unknown> {
  const scopedUrl = new URL(url.toString());
  scopedUrl.searchParams.delete("feature");
  scopedUrl.searchParams.delete("function");
  scopedUrl.searchParams.delete("model");
  scopedUrl.searchParams.delete("provider");
  scopedUrl.searchParams.delete("customer");
  scopedUrl.searchParams.delete("service");
  const groups = groupValues(filteredTraces(scopedUrl), dimension, scopedUrl);
  const group = groups.find((item) => item.key === value) ?? groups.find((item) => item.label.toLowerCase() === value.toLowerCase());
  if (!group) return { dimension, value, history: [], traces: [], summary: null, distributions: {} };
  const history = Array.from({ length: 20 }, (_, index) => {
    const dayTraces = group.traces.filter((trace) => trace.day === index + 1);
    const dayCalls = ["function", "model", "provider"].includes(dimension) ? dayTraces.flatMap((trace) => filteredCalls(trace, scopedUrl).filter((call) => call[dimension as "function" | "model" | "provider"] === value)) : dayTraces.flatMap((trace) => trace.calls);
    const known = sum(dayCalls.map((call) => call.cost ?? 0));
    return { day: `2026-09-${String(index + 1).padStart(2, "0")}`, observations: dayCalls.length, known_cost: money(known), unpriced_count: dayCalls.filter((call) => call.cost == null).length, coverage: dayCalls.length > 0 ? dayCalls.filter((call) => call.cost != null).length / dayCalls.length : null };
  }).filter((row) => row.observations > 0);
  const traceRows = group.traces.map((trace) => {
    const calls = ["function", "model", "provider"].includes(dimension) ? filteredCalls(trace, scopedUrl).filter((call) => call[dimension as "function" | "model" | "provider"] === value) : trace.calls;
    return { trace_id: trace.id, trace_name: trace.id, call_count: calls.length, known_cost: money(sum(calls.map((call) => call.cost ?? 0))), unpriced_count: calls.filter((call) => call.cost == null).length, started_at: localTimestamp(trace) };
  }).filter((trace) => trace.call_count > 0);
  const summaryRecord = contributorRecord(group, dimension, undefined);
  const relatedFunctions = groupValues(group.traces, "function", new URL("http://prototype.local"));
  return {
    dimension,
    value,
    history,
    traces: traceRows,
    summary: summaryRecord,
    distributions: { functions: relatedFunctions.map((item) => contributorRecord(item, "function", undefined)) },
    related: { functions: relatedFunctions.map((item) => contributorRecord(item, "function", undefined)) },
  };
}

function forecast(url: URL): Record<string, unknown> {
  const dashboardRequest = window.location.pathname === "/" || window.location.pathname === "/overview";
  const dimension = url.searchParams.get("groupBy") ?? (url.searchParams.has("feature") ? "feature" : dashboardRequest ? null : "feature");
  const value = url.searchParams.get("groupValue") ?? url.searchParams.get("feature") ?? (dashboardRequest ? null : "Search");
  const scoped = new URL(url.toString());
  if (dimension && value) scoped.searchParams.set(dimension, value);
  const selected = filteredTraces(scoped);
  const traces = selected.length > 0 ? selected : dimension === null ? TRACE_DATA : TRACE_DATA.filter((trace) => trace.feature === "Search");
  const known = money(totalCost(traces)) ?? 0;
  const count = traces.length;
  const mean = count > 0 ? known / count : null;
  const projected = mean == null ? null : mean * 50_000;
  const result = {
    scope: { ...(dimension ? { groupBy: dimension, groupValue: value } : {}), timezone: PROTOTYPE_TIMEZONE },
    calculatedAt: "2026-09-20T14:33:00.000Z",
    currentPace: { available: true, reason: null, completedElapsedDays: 20, periodDays: 30, knownCost: known, projectedCost: known * 30 / 20, pricingCoverage: 1, excludedUnpriced: 0, method: "At current pace" },
    observed: { observations: count, pricedObservations: count, unpricedObservations: 0, meanCostPerOperation: mean, fullyPricedTraces: count, incompleteTraces: 0, knownCost: known, pricingCoverage: 1, traceObservations: count },
    chosenScale: { available: true, automatic: true, reason: null, unit: "operations", volume: 50_000, operations: 50_000, operationsPerUser: null, costPerOperation: mean, costPerUnit: mean, projectedCost: projected, sampleSize: count, requiredSampleSize: 20, sampleSufficient: count >= 20, fullyPricedTraces: count, excludedUnpriced: 0, selectionBiasWarning: false, pricingBasis: "Synthetic fixture rate", unitBasis: "trace", formula: `${mean ?? 0} × 50000`, assumptions: { volumeOnly: true, manualCostPerUnit: null, targetPeriodDays: 30, unitBasis: "trace", formula: `${mean ?? 0} × volume` } },
    cash: {
      available: false,
      reason: "No user-supplied credits",
      originalAmount: projected,
      eligibleCredits: null,
      estimatedPayable: null,
      currency: "USD",
      byProvider: {
        OpenAI: { balance: 4089.95, eligible: 4089.95 },
        Anthropic: { balance: 1860.05, eligible: 1860.05 },
      },
    },
    calculation: { timezone: PROTOTYPE_TIMEZONE, pricingBasis: "estimated", observedWindow: { from: "2026-09-01T00:00:00.000Z", to: "2026-09-20T23:59:59.000Z" } },
  };
  return result;
}

function projectDetail(): Record<string, unknown> {
  return { project: { id: PROTOTYPE_PROJECT_ID, name: PROTOTYPE_PROJECT_NAME, description: "Synthetic design prototype project", created_at: "2026-09-01T00:00:00.000Z", capture_mode: "metadata", body_capture_enabled: true, redaction_enabled: true, body_retention_days: 7, metadata_retention_days: 30, aggregate_retention_days: 395, source_access_enabled: true }, canManage: true };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

function readBody(init?: RequestInit): Promise<unknown> {
  if (!init?.body) return Promise.resolve(null);
  if (typeof init.body !== "string") return Promise.resolve(null);
  try { return Promise.resolve(JSON.parse(init.body)); } catch { return Promise.resolve(null); }
}

async function previewResponse(input: RequestInfo | URL, init?: RequestInit): Promise<Response | null> {
  const requestUrl = new URL(input instanceof Request ? input.url : String(input), window.location.origin);
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const pathname = requestUrl.pathname;

  if (pathname === "/auth/me") {
    return jsonResponse({ authenticated: true, user: { id: "user_preview", email: "alex@example.com", name: "Alex Morgan", orgId: PROTOTYPE_ORG_ID, role: "owner", analyticsId: null }, org: { id: PROTOTYPE_ORG_ID, name: PROTOTYPE_ORG_NAME, slug: "northstar", timezone: PROTOTYPE_TIMEZONE, analyticsId: null }, projects: [{ id: PROTOTYPE_PROJECT_ID, name: PROTOTYPE_PROJECT_NAME, authKey: "ck_preview_dsn", createdAt: "2026-09-01T00:00:00.000Z" }], members: [{ id: "user_preview", email: "alex@example.com", name: "Alex Morgan", role: "owner" }, { id: "user_jordan", email: "jordan@example.com", name: "Jordan Lee", role: "admin" }, { id: "user_riley", email: "riley@example.com", name: "Riley Chen", role: "developer" }, { id: "user_taylor", email: "taylor@example.com", name: "Taylor Park", role: "viewer" }] });
  }
  if (pathname.startsWith("/auth/")) return method === "POST" ? jsonResponse({ ok: true }) : jsonResponse({ ok: true });
  if (!pathname.startsWith("/api/v1/")) return null;

  const body = await readBody(init);
  const projectMatch = pathname.match(/^\/api\/v1\/projects\/([^/]+)(?:\/(.*))?$/);
  const projectId = projectMatch?.[1] ? decodeURIComponent(projectMatch[1]) : PROTOTYPE_PROJECT_ID;
  const suffix = projectMatch?.[2] ?? "";
  if (pathname === "/api/v1/projects") return jsonResponse({ projects: [{ id: PROTOTYPE_PROJECT_ID, name: PROTOTYPE_PROJECT_NAME, created_at: "2026-09-01T00:00:00.000Z", event_count: totalCalls(TRACE_DATA), total_cost: money(totalCost(TRACE_DATA)) }] });
  if (pathname === "/api/v1/workspace/settings") return jsonResponse({ settings: { timezone: PROTOTYPE_TIMEZONE, reportingCurrency: PROTOTYPE_CURRENCY, fx: { available: false, rate: null, source: null, asOf: null }, updatedAt: "2026-09-01T00:00:00.000Z" }, canManage: true });
  if (pathname === "/api/v1/workspace/closure-impact") return jsonResponse({ impact: { projectCount: 1, eventCount: totalCalls(TRACE_DATA), capturedBodyCount: totalCalls(TRACE_DATA), hasActiveSubscription: true } });
  if (pathname === "/api/v1/notifications/preferences") return jsonResponse({ preferences: { weeklySummaryEnabled: true, findingsEnabled: false, thresholdsEnabled: true, enforcementEnabled: true, receiptsEnabled: false } });
  if (pathname === "/api/v1/notifications/destinations") return jsonResponse({ destinations: [] });
  if (pathname === "/api/v1/notifications/deliveries") return jsonResponse({ deliveries: [] });
  if (pathname === "/api/v1/team/invites") return jsonResponse({ invites: [] });
  if (pathname === "/api/v1/retention/status") return jsonResponse({ latestRun: null });
  if (pathname === "/api/v1/subscription") return jsonResponse({ subscription: { status: "active", plan: "workspace", amount: 10, currency: "USD" } });
  if (pathname === "/api/v1/subscription/invoices") return jsonResponse({ invoices: [] });

  if (suffix === "summary") return jsonResponse(summary());
  if (suffix === "overview") return jsonResponse({ overview: overview(), byModel: [], byProvider: [] });
  if (suffix === "trends") return jsonResponse({ trends: trends(TRACE_DATA), bucket: "day", range: requestUrl.searchParams.get("range") ?? "mtd", byModel: {} });
  if (suffix === "health") return jsonResponse({ status: "active", lastEventAt: "2026-09-20T09:02:00.000Z", eventsLastHour: null, hints: [] });
  if (suffix === "attribution-health") return jsonResponse({ status: "healthy", mappings: 3, unmapped: 1 });
  if (suffix === "filter-options") return jsonResponse({ availableFilters: availableFilters(TRACE_DATA), complete: true, nextCursor: null });
  if (suffix === "call-sites") {
    const values = groupValues(TRACE_DATA, "function", requestUrl);
    return jsonResponse({ callSites: values.slice(0, 100).map((group) => { const parts = functionParts(group.label); return { call_site_key: group.key, file_name: parts.file, function_name: parts.name, line_number: 42, provider: "Mixed", model: "Mixed", total_calls: group.observations, total_cost_usd: money(group.cost), priced_calls: group.pricedObservations, unpriced_calls: group.observations - group.pricedObservations, pricing_coverage: group.observations > 0 ? group.pricedObservations / group.observations : null, total_input_tokens: 0, total_output_tokens: 0, avg_duration_ms: 0, avg_ttft: null, avg_tps: null, first_seen: "2026-09-01T00:00:00.000Z", last_seen: "2026-09-20T23:59:59.000Z" }; }) });
  }
  if (suffix === "events") {
    const events = eventRecords(filteredTraces(requestUrl));
    const offset = Number(requestUrl.searchParams.get("offset") ?? 0) || 0;
    const limit = Number(requestUrl.searchParams.get("limit") ?? 50) || 50;
    return jsonResponse({ events: events.slice(offset, offset + limit), total: events.length });
  }
  if (suffix.startsWith("events/")) {
    const id = decodeURIComponent(suffix.slice("events/".length));
    const event = eventRecords(TRACE_DATA).find((candidate) => candidate.id === id);
    return event ? jsonResponse({ event }) : jsonResponse({ error: "Event not found" }, 404);
  }
  if (suffix === "traces") {
    const traces = filteredTraces(requestUrl);
    const sort = requestUrl.searchParams.get("sort");
    const sorted = [...traces].sort((left, right) => sort === "cost_desc" ? right.cost - left.cost : sort === "duration_desc" ? right.duration - left.duration : sort === "calls_desc" ? right.calls.length - left.calls.length : TRACE_DATA.indexOf(left) - TRACE_DATA.indexOf(right));
    const offset = Number(requestUrl.searchParams.get("offset") ?? 0) || 0;
    const limit = Number(requestUrl.searchParams.get("limit") ?? 50) || 50;
    return jsonResponse({ traces: sorted.slice(offset, offset + limit).map((trace) => traceRecord(trace)), total: sorted.length });
  }
  if (suffix.startsWith("traces/")) {
    const id = decodeURIComponent(suffix.slice("traces/".length));
    const trace = TRACE_DATA.find((item) => item.id === id);
    if (!trace) return jsonResponse({ error: "Trace not found" }, 404);
    const events = trace.calls.map((call) => eventRecord(trace, call));
    return jsonResponse({ traceId: trace.id, summary: { ...traceRecord(trace), trace_id: trace.id, trace_name: trace.id, operation_name: trace.operation, name: trace.operation, service: trace.service, release: trace.release, context_summary: trace.id === "search-request-1042" ? "Context summary + retry" : null, feature_source: "mapped" }, events, usageComponents: trace.calls.filter((call) => call.unit).map((call) => ({ id: call.id, provider: call.provider, model: call.model, unit_kind: call.unit, unit_value: call.input ?? null, unit: call.unit, amount: money(call.cost), currency: PROTOTYPE_CURRENCY, amount_kind: "estimated", aggregation: "component", phase: call.phase ?? null, observed_at: localTimestamp(trace, call.start) })) });
  }
  if (suffix === "costs") {
    const groupBy = requestUrl.searchParams.get("groupBy") ?? "feature";
    const groups = groupValues(filteredTraces(requestUrl), groupBy, requestUrl);
    const groupValue = requestUrl.searchParams.get("groupValue");
    const visible = groupValue ? groups.filter((group) => group.key === groupValue) : groups;
    const previous = new URL(requestUrl.toString());
    const previousGroups = groupValues(TRACE_DATA.filter((trace) => trace.day >= 7 && trace.day <= 13), groupBy, previous);
    const contributors = visible.map((group) => contributorRecord(group, groupBy, previousGroups.find((item) => item.key === group.key)));
    return jsonResponse({ scope: { projectId, groupBy }, groupBy, costCurrency: PROTOTYPE_CURRENCY, from: "2026-09-01T00:00:00.000Z", to: "2026-09-20T23:59:59.000Z", totals: { known_cost: money(totalCost(filteredTraces(requestUrl))), cost_currency: PROTOTYPE_CURRENCY, observations: contributors.reduce((value, item) => value + Number(item.observations ?? 0), 0), priced_observations: contributors.reduce((value, item) => value + Number(item.priced_observations ?? 0), 0), unpriced_count: 0, coverage: 1, trace_count: filteredTraces(requestUrl).length, fully_priced_trace_count: filteredTraces(requestUrl).length, unit_basis: "trace" }, contributors, availableDimensions: ["feature", "function", "customer", "model", "provider", "context:environment"], availableFilters: availableFilters(TRACE_DATA), total: contributors.length });
  }
  if (suffix.startsWith("costs/contributors/")) {
    const [, , dimension, ...valueParts] = suffix.split("/");
    return jsonResponse(contributorDetail(requestUrl, dimension ?? "feature", decodeURIComponent(valueParts.join("/"))));
  }
  if (suffix === "forecast") return jsonResponse({ forecast: forecast(requestUrl) });
  if (suffix === "forecast/scenarios") return jsonResponse({ scenarios: [] });
  if (suffix === "findings") return jsonResponse({ findings: [findingRecord()] });
  if (suffix.startsWith("findings/")) return jsonResponse({ finding: findingRecord() });
  if (suffix === "budget/policies") return jsonResponse({ policies: policyRecords() });
  if (suffix.startsWith("budget/policies/") && suffix.endsWith("/decisions")) return jsonResponse({ decisions: [{ id: "decision-job-20", decision: "refuse", admission_id: "admission-eval-20", reason: "Allowance exhausted", created_at: "2026-09-20T02:14:08.000Z" }] });
  if (suffix.startsWith("budget/policies/")) {
    const id = suffix.slice("budget/policies/".length);
    const policy = policyRecords().find((item) => item.id === id) ?? policyRecords()[0];
    return jsonResponse({ policy });
  }
  if (suffix === "executions") return jsonResponse({ executions: executions(), total: executions().length });
  if (suffix.startsWith("executions/")) return jsonResponse(executionDetail(decodeURIComponent(suffix.slice("executions/".length))));
  if (suffix === "features") return jsonResponse({ features: [] });
  if (suffix === "providers") return jsonResponse({ providers: [] });
  if (suffix === "feature-mappings") return jsonResponse({ mappings: [] });
  if (suffix === "finding-thresholds") return jsonResponse({ projectId, thresholds: { expensiveSample: 20, expensiveMultiplier: 3, expensiveMinAbsolute: 0.05, unitSample: 20, unitMinRelative: 0.5, unitMinImpact: 1, coverageMinDrop: 0.2, allowanceMinRatio: 0.8 }, defaults: { expensiveSample: 20, expensiveMultiplier: 3, expensiveMinAbsolute: 0.05, unitSample: 20, unitMinRelative: 0.5, unitMinImpact: 1, coverageMinDrop: 0.2, allowanceMinRatio: 0.8 } });
  if (suffix.startsWith("sourcemaps/")) return jsonResponse({ release: suffix.slice("sourcemaps/".length), sourcemaps: [{ id: "map-preview", file_name: "search-api.map", created_at: "2026-09-01T00:00:00.000Z", size_bytes: 12_800 }] });
  if (suffix === "privacy") return jsonResponse({ settings: { captureMode: "metadata", bodyCaptureEnabled: true, redactionEnabled: true, bodyRetentionDays: 7, metadataRetentionDays: 30, aggregateRetentionDays: 395, sourceAccessEnabled: true }, canManage: true });
  if (suffix === "credits") return jsonResponse({ credits: [] });
  if (suffix === "effective-prices") return jsonResponse({ prices: [] });
  if (suffix === "projects" || suffix === "") return jsonResponse(projectDetail());
  if (method !== "GET" && method !== "HEAD") {
    await Promise.resolve(body);
    return jsonResponse({ ok: true, projectId, id: "preview-write", policy: policyRecords()[0] });
  }
  if (pathname.endsWith("/export")) return jsonResponse({ ok: true, synthetic: true });
  return jsonResponse({});
}

export async function installPrototypePreview(): Promise<void> {
  if (!isRequested()) return;
  const globals = previewGlobal();
  globals.__costkeyPrototypePreviewEnabled = true;
  if (globals.__costkeyPrototypeFetchInstalled) return;
  const nativeFetch = window.fetch.bind(window);
  const fixtureResponse = await nativeFetch("/__costkey/prototype-data.js");
  if (!fixtureResponse.ok) throw new Error(`CostKey design fixture unavailable (${fixtureResponse.status})`);
  TRACE_DATA = parsePrototypeSource(await fixtureResponse.text());
  globals.__costkeyPrototypeFetchInstalled = true;
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const response = await previewResponse(input, init);
    return response ?? nativeFetch(input, init);
  };
}

export { PROTOTYPE_PROJECT_ID, TRACE_DATA };
