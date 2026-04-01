const API_BASE = "/api/v1";

export interface Overview {
  total_calls: number;
  total_cost: number;
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
  total_input_tokens: number;
  total_output_tokens: number;
  avg_duration_ms: number;
  avg_ttft: number | null;
  avg_tps: number | null;
  first_seen: string;
  last_seen: string;
}

export interface EventRow {
  id: string;
  timestamp: string;
  provider: string;
  model: string;
  url: string;
  method: string;
  status_code: number;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  cost_usd: number | null;
  duration_ms: number;
  streaming: boolean;
  ttft: number | null;
  tps: number | null;
  call_site_raw: string | null;
  call_site_frames: unknown[] | string | null;
  context: Record<string, unknown> | string | null;
  request_body?: string | null;
  response_body?: string | null;
}

export interface TrendBucket {
  bucket: string;
  calls: number;
  cost: number;
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
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json() as Promise<T>;
}

export async function getProjects(): Promise<{ projects: Project[] }> {
  return get("/projects");
}

export async function getOverview(
  projectId: string,
  from?: string,
  to?: string,
): Promise<{
  overview: Overview;
  byModel: ModelBreakdown[];
  byProvider: ProviderBreakdown[];
}> {
  const params = new URLSearchParams();
  if (from) params.set("from", from);
  if (to) params.set("to", to);
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
  opts?: { limit?: number; offset?: number; model?: string; provider?: string },
): Promise<{ events: EventRow[]; total: number }> {
  const params = new URLSearchParams();
  if (opts?.limit) params.set("limit", String(opts.limit));
  if (opts?.offset) params.set("offset", String(opts.offset));
  if (opts?.model) params.set("model", opts.model);
  if (opts?.provider) params.set("provider", opts.provider);
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
}

export interface TraceEvent {
  id: string;
  timestamp: string;
  provider: string;
  model: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  duration_ms: number;
  streaming: number;
  ttft: number | null;
  call_site_frames: string | null;
  context: string | null;
}

export async function getTraces(
  projectId: string,
  limit = 30,
): Promise<{ traces: Trace[]; total: number }> {
  return get(`/projects/${projectId}/traces?limit=${limit}`);
}

export async function getTrace(
  projectId: string,
  traceId: string,
): Promise<{ traceId: string; summary: Record<string, unknown>; events: TraceEvent[] }> {
  return get(`/projects/${projectId}/traces/${traceId}`);
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

export async function getTrends(
  projectId: string,
  bucket?: "hour" | "day",
  from?: string,
  to?: string,
): Promise<{ trends: TrendBucket[]; bucket: string }> {
  const params = new URLSearchParams();
  if (bucket) params.set("bucket", bucket);
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  const qs = params.toString() ? `?${params}` : "";
  return get(`/projects/${projectId}/trends${qs}`);
}
