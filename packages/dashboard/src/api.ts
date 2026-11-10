import { appUrl } from "./basePath";
const API_BASE = appUrl("/api/v1");

export const UNAUTHENTICATED_EVENT = "costkey:unauthenticated";

function notifyUnauthenticated(): void {
  window.dispatchEvent(new Event(UNAUTHENTICATED_EVENT));
}

export interface Overview {
  total_calls: number;
  total_cost: number;
  known_cost?: number | null;
  observations?: number;
  priced_observations?: number;
  unpriced_count?: number;
  /** Calls with no cost whose model has no price: setting one prices them. */
  unpriced_no_price_count?: number;
  pricing_coverage?: number | null;
  average_cost_per_trace?: number | null;
  trace_count?: number;
  priced_trace_count?: number;
  forecast?: {
    status: "available" | "not_enough_history" | "incomplete_pricing" | "unavailable" | string;
    amount?: number | null;
    method?: string | null;
    completed_days?: number | null;
  } | null;
  total_input_tokens: number;
  total_output_tokens: number;
  avg_duration_ms: number;
  avg_ttft: number;
  avg_tps: number;
}

export interface ModelBreakdown {
  model: string;
  provider: string;
  calls: number;
  unpriced_calls?: number;
  cost: number;
  input_tokens: number;
  output_tokens: number;
  avg_duration_ms: number;
}

export interface ProviderBreakdown {
  provider: string;
  calls: number;
  cost: number;
}

export interface CallSite {
  call_site_key: string;
  file_name: string | null;
  function_name: string | null;
  line_number: number | null;
  provider: string;
  model: string;
  total_calls: number;
  total_cost_usd: number;
  priced_calls?: number;
  unpriced_calls?: number;
  pricing_coverage?: number | null;
  total_input_tokens: number;
  total_output_tokens: number;
  avg_duration_ms: number;
  avg_ttft: number | null;
  avg_tps: number | null;
  first_seen: string;
  last_seen: string;
}

export interface EventRow {
  /** How its cost adds up, line by line (call detail only). */
  cost_breakdown?: import("./modelDetailApi").CallCostBreakdown | null;
  /** For a call with no code of its own: the span it ran in and the code that opened it. */
  scope_site?: { span_id: string; kind: string; name: string; frames: import("./components/stackFrames").StackFrame[] } | null;
  id: string;
  timestamp: string;
  trace_id?: string | null;
  trace_name?: string | null;
  provider: string;
  model: string;
  request_model?: string | null;
  url: string;
  method: string;
  status_code: number;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  reasoning_tokens?: number | null;
  cache_read_tokens?: number | null;
  cache_creation_tokens?: number | null;
  image_output_tokens?: number | null;
  lifecycle_state?: string | null;
  lifecycle_error_type?: string | null;
  cost_usd: number | null;
  cost_basis?: "reported" | "estimated" | "unknown" | null;
  cost_source?: string | null;
  cost_currency?: string | null;
  content_status?: "captured" | "metadata_only" | "redacted" | "expired" | "not_available" | "unknown" | "restricted" | string | null;
  unit_kind?: string | null;
  unit_value?: number | null;
  unit?: string | null;
  aggregation?: string | null;
  duration_ms: number;
  streaming: boolean;
  ttft: number | null;
  tps: number | null;
  call_site_raw: string | null;
  call_site_frames: unknown[] | string | null;
  context: Record<string, unknown> | string | null;
  metadata?: Record<string, unknown> | string | null;
  system_prompt?: string | null;
  request_body?: string | null;
  response_body?: string | null;
  bl_function?: string | null;
  bl_file?: string | null;
  bl_line?: number | null;
  feature_source?: string | null;
  feature_mapping_id?: string | null;
  feature_original?: string | null;
}

export interface TrendBucket {
  bucket: string;
  calls: number;
  cost: number | null;
  observations?: number;
  unpriced_count?: number;
  coverage?: number | null;
  input_tokens: number;
  output_tokens: number;
  avg_duration_ms: number;
}

export interface Project {
  id: string;
  name: string;
  created_at: string;
  event_count: number;
  total_cost: number;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { credentials: "include" });
  if (res.status === 401) notifyUnauthenticated();
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json() as Promise<T>;
}

export async function getProjects(): Promise<{ projects: Project[] }> {
  return get("/projects");
}

export interface SummaryTopFeature {
  function_name: string | null;
  file_name: string | null;
  cost: number;
  calls: number;
  pct: number;
}

export interface SummaryRelease {
  release: string;
  calls: number;
  cost: number;
  tokens: number;
  first_seen: string;
  last_seen: string;
  cost_per_call: number;
  cost_change_pct: number | null;
}

export interface Summary {
  thisMonth: { cost: number; calls: number; tokens: number };
  lastMonth: { cost: number; calls: number; tokens: number };
  costChange: number;
  callsChange: number;
  topFeatures: SummaryTopFeature[];
  dailyAvg: number;
  projectedMonthly: number;
  byRelease: SummaryRelease[];
  costChangeFromPrevRelease: number | null;
}

export async function getSummary(projectId: string): Promise<Summary> {
  return get(`/projects/${projectId}/summary`);
}

export async function getOverview(
  projectId: string,
  from?: string,
  to?: string,
  environment?: string | string[],
): Promise<{
  overview: Overview;
  byModel: ModelBreakdown[];
  byProvider: ProviderBreakdown[];
}> {
  const params = new URLSearchParams();
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  if (Array.isArray(environment)) environment.forEach((value) => params.append("environment", value));
  else if (environment) params.set("environment", environment);
  const qs = params.toString() ? `?${params}` : "";
  return get(`/projects/${projectId}/overview${qs}`);
}

export async function getCallSites(
  projectId: string,
  sort?: string,
  limit?: number,
): Promise<{ callSites: CallSite[] }> {
  const params = new URLSearchParams();
  if (sort) params.set("sort", sort);
  if (limit) params.set("limit", String(limit));
  const qs = params.toString() ? `?${params}` : "";
  return get(`/projects/${projectId}/call-sites${qs}`);
}

export async function getEvents(
  projectId: string,
  opts?: { limit?: number; offset?: number; sort?: TraceSort; model?: string | string[]; provider?: string | string[]; fn?: string | string[]; function?: string | string[]; customer?: string | string[]; feature?: string | string[]; environment?: string | string[]; lifecycle?: string | string[]; accounting?: string | string[]; status?: string | string[]; coverage?: string | string[]; q?: string; from?: string; to?: string; groupBy?: "context"; contextKey?: string; contextValue?: string | string[] },
): Promise<{ events: EventRow[]; total: number }> {
  const params = new URLSearchParams();
  if (opts?.limit) params.set("limit", String(opts.limit));
  if (opts?.offset) params.set("offset", String(opts.offset));
  if (opts?.sort) params.set("sort", opts.sort);
  const appendValues = (key: string, value: string | string[] | undefined): void => {
    if (Array.isArray(value)) value.forEach((item) => params.append(key, item));
    else if (value) params.set(key, value);
  };
  appendValues("model", opts?.model);
  appendValues("provider", opts?.provider);
  appendValues("fn", opts?.fn);
  appendValues("function", opts?.function);
  appendValues("customer", opts?.customer);
  appendValues("feature", opts?.feature);
  appendValues("environment", opts?.environment);
  appendValues("lifecycle", opts?.lifecycle);
  appendValues("accounting", opts?.accounting);
  appendValues("status", opts?.status);
  appendValues("coverage", opts?.coverage);
  if (opts?.groupBy) params.set("groupBy", opts.groupBy);
  if (opts?.contextKey) params.set("contextKey", opts.contextKey);
  appendValues("contextValue", opts?.contextValue);
  if (opts?.q) params.set("q", opts.q);
  if (opts?.from) params.set("from", opts.from);
  if (opts?.to) params.set("to", opts.to);
  const qs = params.toString() ? `?${params}` : "";
  return get(`/projects/${projectId}/events${qs}`);
}

export async function getEvent(
  projectId: string,
  eventId: string,
): Promise<{ event: EventRow }> {
  return get(`/projects/${projectId}/events/${eventId}`);
}

export interface Trace {
  trace_id: string;
  trace_name: string | null;
  call_count: number;
  total_cost: number;
  total_input_tokens: number;
  total_output_tokens: number;
  started_at: string;
  ended_at: string;
  total_duration_ms: number;
  models: string;
  providers: string;
  elapsed_ms?: number | null;
  feature?: string | null;
  environment?: string | null;
  execution_id?: string | null;
  group_id?: string | null;
  known_cost?: number | null;
  unpriced_count?: number;
  pricing_coverage?: number | null;
  execution_state?: string | null;
  accounting_state?: string | null;
  customer?: string | null;
  agent?: string | null;
  user_id?: string | null;
  conversation_id?: string | null;
  agent_count?: number;
  step_count?: number;
  /** Attempts of the same work item (context.work_id): a failed attempt a later one completed is retried. */
  retry?: RunRetry | null;
  tool_count?: number;
  span_error?: boolean;
}

export type SpanKind = "agent" | "step" | "tool" | "workflow" | "task" | "judge" | "retrieval" | "handoff" | "guardrail" | "chain" | "custom";

/** An agent, step or tool span inside a run. Calls link to it by span_id. */
export interface TraceSpan {
  id: string;
  parent_span_id: string | null;
  kind: SpanKind;
  name: string;
  status: "running" | "ok" | "error" | "cancelled";
  error_type: string | null;
  started_at: string | null;
  ended_at: string | null;
  duration_ms: number | null;
  attributes: Record<string, unknown> | null;
  execution_id: string | null;
}

export interface TraceEvent {
  id: string;
  timestamp: string;
  provider: string;
  model: string;
  request_model?: string | null;
  event_type?: string | null;
  source?: string | null;
  attempt_id?: string | null;
  span_id?: string | null;
  native_units?: Record<string, number> | null;
  parent_event_id?: string | null;
  charge_id?: string | null;
  cost_basis?: "reported" | "estimated" | "unknown" | null;
  cost_source?: string | null;
  cost_currency?: string | null;
  content_status?: "captured" | "metadata_only" | "redacted" | "expired" | "not_available" | "unknown" | "restricted" | string | null;
  unit_kind?: string | null;
  unit_value?: number | null;
  unit?: string | null;
  aggregation?: string | null;
  url?: string | null;
  method?: string | null;
  status_code?: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  reasoning_tokens?: number | null;
  cache_read_tokens?: number | null;
  cache_creation_tokens?: number | null;
  /** What cache hits saved on this call in USD; null when its price can't be checked. */
  cache_saved_usd?: number | null;
  /** How the call ended: "failed" or "cancelled" with an error name such as ReadTimeout or http_429. */
  lifecycle_state?: string | null;
  lifecycle_error_type?: string | null;
  lifecycle_at?: string | null;
  cost_usd: number | null;
  duration_ms: number;
  streaming: number;
  ttft: number | null;
  tps: number | null;
  call_site_frames: string | null;
  context: string | null;
  call_site_raw?: string | null;
  bl_function?: string | null;
  bl_file?: string | null;
  bl_line?: number | null;
  feature_source?: string | null;
  feature_mapping_id?: string | null;
  feature_original?: string | null;
  /** Screen capture: the images this call's request carried, newest last. */
  screen_frames?: FrameRef[] | null;
  request_body?: unknown;
  response_body?: unknown;
}

/** One image a call sent to the model; the bytes are fetched by hash. */
export interface FrameRef {
  sha256: string;
  mediaType: string;
  bytes: number;
  omitted?: "too_large";
}

/** Where the console reads a stored frame (same-origin, signed-in). */
export function frameUrl(projectId: string, sha256: string): string {
  return `${API_BASE}/projects/${encodeURIComponent(projectId)}/frames/${encodeURIComponent(sha256)}`;
}

/** A browser replay (@costkey/replay): one recording per page, each page's rrweb events in order. */
export interface TraceReplay {
  recordings: Array<{ id: string; startedAt: string | null; endedAt: string | null; events: unknown[] }>;
  truncated: boolean;
}

export async function getTraceReplay(projectId: string, traceId: string): Promise<TraceReplay> {
  return get(`/projects/${encodeURIComponent(projectId)}/traces/${encodeURIComponent(traceId)}/replay`);
}

/** Absolute, because the replay iframe resolves URLs against about:blank. */
export function replayAssetUrl(projectId: string, sha256: string): string {
  const path = `${API_BASE}/projects/${encodeURIComponent(projectId)}/replay-assets/${encodeURIComponent(sha256)}`;
  return typeof window === "undefined" ? path : new URL(path, window.location.href).href;
}

export interface TraceQuery {
  limit?: number;
  offset?: number;
  sort?: TraceSort;
  q?: string;
  from?: string;
  to?: string;
  environment?: string | string[];
  lifecycle?: string | string[];
  accounting?: string | string[];
  status?: string | string[];
  coverage?: string | string[];
  provider?: string | string[];
  model?: string | string[];
  function?: string | string[];
  customer?: string | string[];
  feature?: string | string[];
  groupBy?: "context";
  contextKey?: string;
  contextValue?: string | string[];
  /** Only runs that made at least one model call. */
  withCalls?: boolean;
}

export type TraceSort = "newest" | "cost_desc" | "duration_desc" | "calls_desc";

export interface TraceFilterOption { value: string; count?: number; }
export type TraceFilterDimension = "provider" | "model" | "feature" | "function" | "customer" | "environment" | "lifecycle" | "accounting" | "status" | "coverage" | `context:${string}`;
export interface TraceFilterOptionsResponse {
  scope?: Record<string, unknown>;
  options?: Partial<Record<TraceFilterDimension, TraceFilterOption[]>>;
  availableFilters?: {
    providers?: string[];
    models?: string[];
    environments?: string[];
    features?: string[];
    customers?: string[];
    functions?: string[];
    lifecycles?: string[];
    accounting?: string[];
    coverage?: string[];
    statuses?: string[];
    contextKeys?: string[];
    contexts?: Record<string, { values?: string[]; counts?: Record<string, number> }>;
    counts?: Record<string, Record<string, number>>;
    countUnits?: Record<string, string>;
  };
  complete?: boolean;
  nextCursor?: string | null;
  limit?: number;
  offset?: number;
}

export function normalizeTraceFilterOptions(result: TraceFilterOptionsResponse): TraceFilterOptionsResponse {
  const filters = result.availableFilters ?? {};
  const optionsFor = (dimension: string, values?: string[]): TraceFilterOption[] | undefined => values?.map((value) => ({ value, count: filters.counts?.[dimension]?.[value] }));
  const optionsByDimension: Partial<Record<TraceFilterDimension, TraceFilterOption[]>> = {
    provider: optionsFor("provider", filters.providers),
    model: optionsFor("model", filters.models),
    environment: optionsFor("environment", filters.environments),
    feature: optionsFor("feature", filters.features),
    customer: optionsFor("customer", filters.customers),
    function: optionsFor("function", filters.functions),
    lifecycle: optionsFor("lifecycle", filters.lifecycles),
    accounting: optionsFor("accounting", filters.accounting),
    coverage: optionsFor("coverage", filters.coverage),
    status: optionsFor("status", filters.statuses),
  };
  for (const [key, context] of Object.entries(filters.contexts ?? {})) {
    optionsByDimension[`context:${key}` as TraceFilterDimension] = (context.values ?? []).map((value) => ({ value, count: context.counts?.[value] }));
  }
  return { ...result, options: optionsByDimension };
}

export async function getTraceFilterOptions(projectId: string, options: { from: string; to: string; q?: string; search?: string; offset?: number; limit?: number } ): Promise<TraceFilterOptionsResponse> {
  const params = new URLSearchParams({ from: options.from, to: options.to, dimensions: "provider,model,feature,function,customer,environment,lifecycle,accounting,status,coverage", limit: String(options.limit ?? 100), offset: String(options.offset ?? 0) });
  if (options.q) params.set("q", options.q);
  if (options.search) params.set("search", options.search);
  const result = await get<Omit<TraceFilterOptionsResponse, "options"> & { availableFilters?: TraceFilterOptionsResponse["availableFilters"] }>(`/projects/${projectId}/filter-options?${params.toString()}`);
  return normalizeTraceFilterOptions(result);
}

export async function getTraces(
  projectId: string,
  options: number | TraceQuery = 30,
): Promise<{ traces: Trace[]; total: number }> {
  const params = new URLSearchParams();
  const query = typeof options === "number" ? { limit: options } : options;
  if (query.limit) params.set("limit", String(query.limit));
  if (query.offset) params.set("offset", String(query.offset));
  if (query.sort) params.set("sort", query.sort);
  if (query.q) params.set("q", query.q);
  if (query.from) params.set("from", query.from);
  if (query.to) params.set("to", query.to);
  if (query.withCalls) params.set("withCalls", "1");
  const appendValues = (key: string, value: string | string[] | undefined): void => {
    if (Array.isArray(value)) value.forEach((item) => params.append(key, item));
    else if (value) params.set(key, value);
  };
  appendValues("environment", query.environment);
  appendValues("lifecycle", query.lifecycle);
  appendValues("accounting", query.accounting);
  appendValues("status", query.status);
  appendValues("coverage", query.coverage);
  appendValues("provider", query.provider);
  appendValues("model", query.model);
  appendValues("function", query.function);
  appendValues("customer", query.customer);
  appendValues("feature", query.feature);
  if (query.groupBy) params.set("groupBy", query.groupBy);
  if (query.contextKey) params.set("contextKey", query.contextKey);
  appendValues("contextValue", query.contextValue);
  const qs = params.toString() ? `?${params}` : "";
  return get(`/projects/${projectId}/traces${qs}`);
}

export async function getTrace(
  projectId: string,
  traceId: string,
): Promise<{ traceId: string; summary: Record<string, unknown>; events: TraceEvent[]; usageComponents?: UsageComponent[]; spans?: TraceSpan[] }> {
  return get(`/projects/${projectId}/traces/${traceId}`);
}

export interface UsageComponent {
  id: string;
  charge_id?: string | null;
  component_id?: string | null;
  provider?: string | null;
  model?: string | null;
  unit_kind?: string | null;
  unit_value?: number | null;
  unit?: string | null;
  amount?: number | null;
  currency?: string | null;
  amount_kind?: string | null;
  aggregation?: string | null;
  phase?: string | null;
  observed_at?: string | null;
}

export type CostDimension = "feature" | "function" | "customer" | "model" | "provider" | "context";

export interface CostContributor {
  key?: string | null;
  label?: string | null;
  name?: string | null;
  secondary?: string | null;
  cost?: number | null;
  known_cost?: number | null;
  observations?: number | null;
  calls?: number | null;
  priced_observations?: number | null;
  unpriced_count?: number | null;
  coverage?: number | null;
  unit_cost?: number | null;
  change_abs?: number | null;
  change_pct?: number | null;
  inferred?: boolean;
}

export interface CostBreakdownResponse {
  scope?: Record<string, unknown>;
  groupBy?: CostDimension;
  totals?: {
    known_cost?: number | null;
    observations?: number | null;
    priced_observations?: number | null;
    unpriced_count?: number | null;
    coverage?: number | null;
  };
  contributors?: CostContributor[];
  total?: number;
  limit?: number;
  offset?: number;
  availableDimensions?: Array<CostDimension | string>;
  availableFilters?: {
    providers?: string[];
    models?: string[];
    environments?: string[];
    features?: string[];
    customers?: string[];
    functions?: string[];
    contextKeys?: string[];
  };
  message?: string;
}

export async function getCostBreakdown(
  projectId: string,
  options: { groupBy: CostDimension; from: string; to: string; environment?: string | string[]; q?: string; groupValue?: string; contextKey?: string; contextValue?: string; limit?: number; offset?: number },
): Promise<CostBreakdownResponse> {
  const params = new URLSearchParams({ groupBy: options.groupBy, from: options.from, to: options.to });
  if (Array.isArray(options.environment)) options.environment.forEach((value) => params.append("environment", value));
  else if (options.environment) params.set("environment", options.environment);
  if (options.q) params.set("q", options.q);
  if (options.groupValue) params.set("groupValue", options.groupValue);
  if (options.contextKey) params.set("contextKey", options.contextKey);
  if (options.contextValue) params.set("contextValue", options.contextValue);
  if (options.limit != null) params.set("limit", String(options.limit));
  if (options.offset != null) params.set("offset", String(options.offset));
  return get(`/projects/${projectId}/costs?${params.toString()}`);
}

export interface CostContributorHistoryRow {
  day: string;
  observations: number;
  known_cost: number | null;
  unpriced_count: number;
  coverage: number | null;
}

export interface CostContributorMetric {
  known_cost: number | null;
  observations: number;
  priced_observations: number;
  unpriced_count: number;
  coverage: number | null;
  call_count: number;
  trace_count: number;
  fully_priced_trace_count: number;
  fully_priced_trace_cost: number | null;
  mean_cost_per_trace: number | null;
  untraced_usage_count: number;
  untraced_usage_cost: number | null;
  unit_cost?: number | null;
  unit_basis?: string | null;
  period?: { from: string; to: string };
  change_abs?: number | null;
  change_pct?: number | null;
}

export interface CostContributorDistributionRow {
  key: string;
  label: string;
  observations: number;
  priced_observations: number;
  unpriced_count: number;
  known_cost: number | null;
  coverage: number | null;
}

export interface CostContributorPolicyActions {
  policies?: Array<Record<string, unknown>>;
  decisions?: Array<Record<string, unknown>>;
  firings?: Array<Record<string, unknown>>;
  legacyRules?: Array<Record<string, unknown>>;
  legacyFirings?: Array<Record<string, unknown>>;
}

export interface CostContributorDetailResponse {
  dimension: CostDimension;
  value: string;
  history: CostContributorHistoryRow[];
  traces: CostContributorTraceRow[];
  summary?: CostContributorMetric;
  baseline?: CostContributorMetric;
  distributions?: Partial<Record<"providers" | "models" | "services" | "releases" | "functions" | "features", CostContributorDistributionRow[]>>;
  related?: Partial<Record<"providers" | "models" | "services" | "releases" | "functions" | "features", CostContributorDistributionRow[]>>;
  policyActions?: CostContributorPolicyActions;
}

export interface CostContributorTraceRow {
  trace_id: string;
  trace_name: string | null;
  call_count: number;
  known_cost: number | null;
  unpriced_count: number;
  started_at: string;
}

export async function getCostContributor(
  projectId: string,
  dimension: CostDimension,
  contributor: string,
  options: { from?: string; to?: string; environment?: string; contextKey?: string } = {},
): Promise<CostContributorDetailResponse> {
  const params = new URLSearchParams();
  if (options.from) params.set("from", options.from);
  if (options.to) params.set("to", options.to);
  if (options.environment) params.set("environment", options.environment);
  if (options.contextKey) params.set("contextKey", options.contextKey);
  const qs = params.toString() ? `?${params}` : "";
  return get(`/projects/${projectId}/costs/contributors/${dimension}/${encodeURIComponent(contributor)}${qs}`);
}

export interface ForecastResponse {
  scope?: Record<string, unknown>;
  calculatedAt?: string;
  currentPace?: {
    available: boolean;
    reason: string | null;
    completedElapsedDays: number;
    periodDays: number;
    knownCost: number | null;
    projectedCost: number | null;
    pricingCoverage: number | null;
    excludedUnpriced: number;
    method: string;
  };
  observed?: {
    observations: number;
    pricedObservations: number;
    unpricedObservations: number;
    meanCostPerOperation: number | null;
    fullyPricedTraces: number;
    incompleteTraces: number;
    knownCost?: number | null;
    pricingCoverage?: number | null;
    traceObservations?: number;
    excludedActivity?: { count: number; reasons: string[] };
  };
  chosenScale?: {
    available: boolean;
    automatic: boolean;
    reason: string | null;
    unit: string;
    volume: number | null;
    operations: number | null;
    operationsPerUser: number | null;
    costPerOperation: number | null;
    costPerUnit: number | null;
    projectedCost: number | null;
    sampleSize: number;
    requiredSampleSize: number;
    sampleSufficient: boolean;
    fullyPricedTraces: number;
    excludedUnpriced: number;
    selectionBiasWarning: boolean;
    pricingBasis: string | null;
    unitBasis?: string | null;
    formula?: string | null;
    assumptions?: {
      volumeOnly: boolean;
      manualCostPerUnit: number | null;
      targetPeriodDays: number | null;
      unitBasis?: string | null;
      formula?: string | null;
    };
  };
  cash?: { available: boolean; reason: string | null; originalAmount: number | null; eligibleCredits: number | null; estimatedPayable: number | null; currency: string; byProvider?: Record<string, { balance: number; eligible: number }> };
  calculation?: { timezone?: string; pricingBasis?: string; observedWindow?: { from: string; to: string } };
}

export async function getForecast(
  projectId: string,
  options: { from?: string; to?: string; timezone?: string; groupBy?: CostDimension; groupValue?: string; contextKey?: string; contextValue?: string | string[]; environment?: string | string[] } = {},
): Promise<{ forecast: ForecastResponse }> {
  const params = new URLSearchParams();
  if (options.from) params.set("from", options.from);
  if (options.to) params.set("to", options.to);
  if (options.timezone) params.set("timezone", options.timezone);
  if (options.groupBy) params.set("groupBy", options.groupBy);
  if (options.groupValue) params.set("groupValue", options.groupValue);
  if (options.contextKey) params.set("contextKey", options.contextKey);
  if (Array.isArray(options.contextValue)) options.contextValue.forEach((value) => params.append("contextValue", value));
  else if (options.contextValue) params.set("contextValue", options.contextValue);
  if (Array.isArray(options.environment)) options.environment.forEach((value) => params.append("environment", value));
  else if (options.environment) params.set("environment", options.environment);
  const query = params.toString() ? `?${params.toString()}` : "";
  return get(`/projects/${projectId}/forecast${query}`);
}

export async function calculateForecast(
  projectId: string,
  scope: Record<string, unknown>,
): Promise<{ forecast: ForecastResponse }> {
  const response = await fetch(`${API_BASE}/projects/${projectId}/forecast`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(scope),
  });
  if (response.status === 401) notifyUnauthenticated();
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `API error: ${response.status}`);
  }
  return response.json() as Promise<{ forecast: ForecastResponse }>;
}

export async function saveForecastScenario(
  projectId: string,
  payload: { name: string; scope: Record<string, unknown>; assumptions?: Record<string, unknown>; shared?: boolean },
): Promise<{ id: string; scenario: ForecastResponse }> {
  const response = await fetch(`${API_BASE}/projects/${projectId}/forecast/scenarios`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (response.status === 401) notifyUnauthenticated();
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `API error: ${response.status}`);
  }
  return response.json() as Promise<{ id: string; scenario: ForecastResponse }>;
}

export interface ForecastScenarioRow {
  id: string;
  name: string;
  scope: Record<string, unknown> | string;
  assumptions: Record<string, unknown> | string;
  result: ForecastResponse | string;
  shared: boolean;
  calculated_at: string;
  updated_at?: string;
}

export async function listForecastScenarios(projectId: string): Promise<{ scenarios: ForecastScenarioRow[] }> {
  return get(`/projects/${projectId}/forecast/scenarios`);
}

export interface FindingResponse {
  id: string;
  projectId?: string;
  family: string;
  state: string;
  scope: Record<string, unknown>;
  observedAt: string;
  lastSeenAt: string;
  baseline: Record<string, unknown> | null;
  evidence: Record<string, unknown>;
  nextActions: string[];
  occurrenceCount?: number;
  acknowledgedAt?: string | null;
  acknowledgedBy?: string | null;
}

export async function getFinding(projectId: string, findingId: string): Promise<{ finding: FindingResponse }> {
  return get(`/projects/${projectId}/findings/${encodeURIComponent(findingId)}`);
}

export async function acknowledgeFinding(projectId: string, findingId: string): Promise<{ ok: boolean; state: string }> {
  const response = await fetch(`${API_BASE}/projects/${projectId}/findings/${encodeURIComponent(findingId)}/acknowledge`, { method: "POST", credentials: "include" });
  if (response.status === 401) notifyUnauthenticated();
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `API error: ${response.status}`);
  }
  return response.json() as Promise<{ ok: boolean; state: string }>;
}

export interface FeatureCallSite {
  call_site_key: string;
  file_name: string | null;
  function_name: string | null;
  line_number: number | null;
  total_calls: number;
  total_cost_usd: number;
  total_input_tokens: number;
  total_output_tokens: number;
  avg_duration_ms: number;
}

export interface FeatureChainFrame {
  functionName: string;
  fileName: string | null;
  lineNumber: number | null;
}

export interface FeatureChain {
  frames: FeatureChainFrame[];
  callSiteKey: string;
}

export interface Feature {
  rootFunction: string;
  rootFile: string | null;
  rootLine: number | null;
  callSites: FeatureCallSite[];
  totalCost: number;
  totalCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  avgDuration: number;
  chains: FeatureChain[];
}

export async function getFeatures(
  projectId: string,
): Promise<{ features: Feature[] }> {
  return get(`/projects/${projectId}/features`);
}

export interface HealthHint {
  type: string;
  message: string;
  link: string;
}

export interface PipelineHealth {
  status: "active" | "idle" | "inactive" | "no_data";
  lastEventAt: string | null;
  eventsLastHour: number;
  /** Calls in the last hour that failed or were cancelled (light mode). */
  failedLastHour?: number;
  hints?: HealthHint[];
}

/** `light` skips the hint scans; the sidebar's live dot polls it. */
export async function getHealth(projectId: string, light = false): Promise<PipelineHealth> {
  return get(`/projects/${projectId}/health${light ? "?light=1" : ""}`);
}

// ── Custom Providers ──

export interface CustomProvider {
  id: string;
  name: string;
  hostname: string;
  usage_input_path: string;
  usage_output_path: string;
  model_path: string;
  enabled: boolean;
  created_at: string;
}

export async function getCustomProviders(
  projectId: string,
): Promise<{ providers: CustomProvider[] }> {
  const res = await fetch(`${API_BASE}/projects/${projectId}/providers`, { credentials: "include" });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

export async function createCustomProvider(
  projectId: string,
  data: { name: string; hostname: string; usageInputPath?: string; usageOutputPath?: string; modelPath?: string },
): Promise<CustomProvider> {
  const res = await fetch(`${API_BASE}/projects/${projectId}/providers`, {
    method: "POST", credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

export async function updateCustomProvider(
  projectId: string,
  providerId: string,
  data: Partial<{ name: string; hostname: string; usageInputPath: string; usageOutputPath: string; modelPath: string; enabled: boolean }>,
): Promise<void> {
  const res = await fetch(`${API_BASE}/projects/${projectId}/providers/${providerId}`, {
    method: "PATCH", credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
}

export async function deleteCustomProvider(
  projectId: string,
  providerId: string,
): Promise<void> {
  const res = await fetch(`${API_BASE}/projects/${projectId}/providers/${providerId}`, {
    method: "DELETE", credentials: "include",
  });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
}

export type TimeRange = "24h" | "mtd" | "7d" | "30d" | "custom" | "3m" | "6m" | "1y";

export async function getTrends(
  projectId: string,
  bucket?: "hour" | "day",
  range?: TimeRange,
  groupBy?: "model",
  options: { from?: string; to?: string; environment?: string | string[] } = {},
): Promise<{ trends: TrendBucket[]; bucket: string; range: string; byModel?: Record<string, Array<{ bucket: string; cost: number | null; unpriced_count?: number }>> }> {
  const params = new URLSearchParams();
  if (bucket) params.set("bucket", bucket);
  if (range) params.set("range", range);
  if (groupBy) params.set("groupBy", groupBy);
  if (options.from) params.set("from", options.from);
  if (options.to) params.set("to", options.to);
  if (Array.isArray(options.environment)) options.environment.forEach((value) => params.append("environment", value));
  else if (options.environment) params.set("environment", options.environment);
  const qs = params.toString() ? `?${params}` : "";
  return get(`/projects/${projectId}/trends${qs}`);
}

// ── Insights ──

export interface InsightsModule {
  module: string;
  calls: number;
  cost: number;
  tokens: number;
  functions: number;
}

export interface InsightsModuleTrend {
  day: string;
  module: string;
  cost: number;
  calls: number;
}

export interface InsightsHotspot {
  function: string;
  file: string;
  calls: number;
  cost: number;
  avgCost: number;
  tokens: number;
  prevCost: number;
  costChange: number | null;
}

export interface InsightsData {
  range: string;
  totals: { calls: number; cost: number; tokens: number };
  modules: InsightsModule[];
  moduleTrends: InsightsModuleTrend[];
  context: Record<string, Array<{ value: string; calls: number; cost: number; tokens: number }>>;
  hotspots: InsightsHotspot[];
}

export async function getInsights(projectId: string, range?: TimeRange): Promise<InsightsData> {
  const params = new URLSearchParams();
  if (range) params.set("range", range);
  const qs = params.toString() ? `?${params}` : "";
  return get(`/projects/${projectId}/insights${qs}`);
}

/**
 * Token usage as the server reads it across providers: input counts the whole
 * prompt with cache included, output includes reasoning. Cache fields are null
 * when no call reported one.
 */
export interface TokenUsage {
  inputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  cacheHitRate: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  /** USD saved by cache hits; only set when every hit was priced from a list price we could check. */
  cacheSavings?: number | null;
}

export interface RunGroup {
  name: string;
  runs: number;
  cost: number | null;
  costPerRun: number | null;
  /** Spend over successful runs: what each success really costs, failures included. */
  costPerSuccess?: number | null;
  partlyPricedRuns: number;
  calls: number;
  p50Ms: number | null;
  p95Ms: number | null;
  failedRuns: number;
  /** Failed attempts that a later attempt of the same work item completed. */
  retriedRuns?: number;
  avgSteps: number | null;
  avgTools: number | null;
  lastRun: string | null;
  usage?: TokenUsage;
}

/** How a run relates to other attempts of the same work item. */
export interface RunRetry {
  workId: string | null;
  attempt: number;
  attempts?: number;
  retried: boolean;
  succeededBy: string | null;
  succeededOnAttempt: number | null;
  willRetry: boolean;
  errorType: string | null;
}

export interface AgentRun {
  traceId: string;
  startedAt: string;
  cost: number | null;
  unpriced: number;
  calls: number;
  steps: number;
  tools: number;
  failed: boolean;
  durationMs: number | null;
  userId: string | null;
  usage?: TokenUsage;
  retry?: RunRetry;
}

export interface AgentDetail {
  agent: RunGroup;
  runs: AgentRun[];
  /** Which page of runs this is: `total` runs in the period, newest first. */
  runsPage?: { offset: number; limit: number; total: number };
  tools: Array<{ name: string; calls: number; avgMs: number | null; failed: number; cost: number | null }>;
  models: Array<{ model: string; provider: string; calls: number; cost: number | null; usage?: TokenUsage; units?: Record<string, number> }>;
  subagents: Array<{ name: string; runs: number }>;
  /** Top users by spend: context.customer or userId on the runs' calls. */
  users?: Array<{ userId: string; runs: number; calls: number; cost: number | null; failedRuns: number; lastRun: string | null; usage?: TokenUsage; units?: Record<string, number> }>;
}

export interface ErrorSummary {
  totals: { calls: number; failedCalls: number; retries: number; wastedCost: number };
  failedCalls: Array<{ provider: string; model: string; statusCode: number | null; calls: number; runs: number; cost: number | null; lastSeen: string; sampleTraceId: string | null }>;
  retries: Array<{ model: string; provider: string; retries: number; cost: number | null; lastSeen: string }>;
  failedSpans: Array<{ kind: string; name: string; errorType: string | null; failures: number; lastSeen: string; sampleTraceId: string | null }>;
}

export interface InsightScope {
  from: string;
  to: string;
  environment?: string;
  /** One release (deploy) only. */
  release?: string;
}

function scopeQuery(scope: InsightScope): string {
  const params = new URLSearchParams({ from: scope.from, to: scope.to });
  if (scope.environment && scope.environment !== "all") params.set("environment", scope.environment);
  if (scope.release) params.set("release", scope.release);
  return params.toString();
}

export function getWorkflows(projectId: string, scope: InsightScope): Promise<{ workflows: RunGroup[] }> {
  return get(`/projects/${encodeURIComponent(projectId)}/workflows?${scopeQuery(scope)}`);
}

export function getAgents(projectId: string, scope: InsightScope): Promise<{ agents: RunGroup[] }> {
  return get(`/projects/${encodeURIComponent(projectId)}/agents?${scopeQuery(scope)}`);
}

/** A page of runs: `limit` newest from `offset`. */
export interface RunsPage { offset?: number; limit?: number }

function pageQuery(page?: RunsPage): string {
  return `${page?.offset ? `&offset=${page.offset}` : ""}${page?.limit ? `&limit=${page.limit}` : ""}`;
}

export function getAgentDetail(projectId: string, name: string, scope: InsightScope, page?: RunsPage): Promise<AgentDetail> {
  return get(`/projects/${encodeURIComponent(projectId)}/agents/${encodeURIComponent(name)}?${scopeQuery(scope)}${pageQuery(page)}`);
}

/** A workflow's page: the same shape as an agent's. */
export function getWorkflowDetail(projectId: string, name: string, scope: InsightScope, page?: RunsPage): Promise<AgentDetail> {
  return get(`/projects/${encodeURIComponent(projectId)}/workflows/${encodeURIComponent(name)}?${scopeQuery(scope)}${pageQuery(page)}`);
}

export function getErrors(projectId: string, scope: InsightScope): Promise<ErrorSummary> {
  return get(`/projects/${encodeURIComponent(projectId)}/errors?${scopeQuery(scope)}`);
}

export interface TabModel {
  model: string;
  provider: string;
  calls: number;
  runs: number;
  cost: number | null;
  topOwners: string[];
  usage?: TokenUsage;
  /** Characters, audio seconds, images or searches, for models that bill them. */
  units?: Record<string, number>;
}

export function getTabModels(projectId: string, kind: "agent" | "workflow", scope: InsightScope): Promise<{ models: TabModel[] }> {
  return get(`/projects/${encodeURIComponent(projectId)}/insights/models?kind=${kind}&${scopeQuery(scope)}`);
}

export interface BudgetPolicy {
  id: string;
  name?: string | null;
  scope?: Record<string, string | string[]>;
  mode: "monitor" | "enforce";
  status: "active" | "paused" | "archived";
  unit: "money" | "calls" | "tokens";
  allowance: number;
  currency?: string | null;
  window: string;
  usage?: { observed?: number | null } | null;
}

export function getBudgetPolicies(projectId: string): Promise<{ policies: BudgetPolicy[] }> {
  return get(`/projects/${encodeURIComponent(projectId)}/budget/policies`);
}

export interface QualitySummary {
  totals: { runs: number; failedRuns: number; calls: number; failedCalls: number; retries: number; wastedCost: number; judgedRuns?: number; judgedFailed?: number; p50Ms?: number | null; p95Ms?: number | null };
  owners: Array<{ name: string; kind: "agent" | "workflow"; runs: number; failedRuns: number; judgedRuns: number; judgedFailed: number; failedCalls: number; retries: number; toolFailures: number; wastedCost: number }>;
  models: Array<{ model: string; provider: string; calls: number; failedCalls: number; retries: number; p95Ms: number | null; wastedCost: number; statusCodes: number[] }>;
  failures: Array<{ traceId: string; name: string; kind: "agent" | "workflow"; startedAt: string; cost: number | null; reasons: string[]; detail: string | null }>;
}

export function getQualitySummary(projectId: string, scope: InsightScope, owner?: string | null): Promise<QualitySummary> {
  return get(`/projects/${encodeURIComponent(projectId)}/quality/summary?${scopeQuery(scope)}${owner ? `&owner=${encodeURIComponent(owner)}` : ""}`);
}

export type BoardBucketUnit = "hour" | "day";

export interface OverviewBoardLatency {
  count: number;
  p50Ms: number | null;
  p95Ms: number | null;
  series: Array<{ bucket: string; count: number; p50Ms: number | null; p95Ms: number | null }>;
}

export interface OverviewBoardCount { name: string; runs: number; calls: number }

export interface OverviewBoardUsage { name: string; runs: number; input: number; output: number; cost: number | null; unpriced: number; units?: Record<string, number> }

/** The Overview board: runs, scores, model tokens, agent usage, volume and latency for one window and the one before it. */
export interface OverviewBoard {
  window: { from: string; to: string; environment: string | null; timezone: string; bucket: BoardBucketUnit };
  previous: { from: string; to: string };
  buckets: string[];
  runs: { current: { runs: number; agentRuns: number }; previous: { runs: number; agentRuns: number } };
  scores: {
    current: { avg: number | null; count: number; allCount: number };
    previous: { avg: number | null; count: number; allCount: number };
    checks: Array<{ name: string; avg: number | null; count: number; runs: number; unitScale: boolean; series: Array<{ bucket: string; avg: number | null; count: number }> }>;
  };
  /** Every model with calls in the period, whatever it bills; `units` holds characters, audio seconds, images or searches. */
  models: Array<{ provider: string | null; model: string; calls: number; input: number | null; output: number | null; cacheRead: number | null; cacheWrite: number | null; cost: number | null; unpriced: number; units?: Record<string, number> }>;
  /** Billed units other than tokens, for this period and the one before. */
  units?: { current: Record<string, number>; previous: Record<string, number> };
  agents: OverviewBoardUsage[];
  workflows?: OverviewBoardUsage[];
  volume: { agents: OverviewBoardCount[]; workflows: OverviewBoardCount[]; tools: OverviewBoardCount[] };
  latency: { agents: OverviewBoardLatency; workflows: OverviewBoardLatency; tools: OverviewBoardLatency };
}

export function getOverviewBoard(projectId: string, scope: InsightScope): Promise<OverviewBoard> {
  return get(`/projects/${encodeURIComponent(projectId)}/insights/board?${scopeQuery(scope)}`);
}

/** A deploy: the release the SDK sent, linked to its commit when the repository is known. */
export interface Release {
  release: string;
  commit: string | null;
  repository: string | null;
  commitUrl: string | null;
  firstSeen: string;
  lastSeen: string;
  calls: number;
}

export function getReleases(projectId: string, environment?: string): Promise<{ repository: string | null; releases: Release[] }> {
  const params = new URLSearchParams();
  if (environment && environment !== "all") params.set("environment", environment);
  const qs = params.toString();
  return get(`/projects/${encodeURIComponent(projectId)}/releases${qs ? `?${qs}` : ""}`);
}
