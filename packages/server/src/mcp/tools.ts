/**
 * The CostKey MCP tools. Each one reads the same REST routes as the console
 * (through RestClient, with the caller's token) and answers in compact text:
 * one item per few lines, with file:line where known and a console link.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { WorkspaceRole } from "../permissions.js";
import { ApiError, type QueryValue, type RestClient } from "./client.js";
import {
  ago,
  compactJson,
  conversationFrom,
  count,
  duration,
  isInAppFrame,
  location,
  num,
  pct,
  renderConversation,
  renderFrame,
  responseText,
  signedUsd,
  str,
  trim,
  usd,
  when,
  type Frame,
  type Row,
} from "./format.js";

export interface ToolContext {
  api: RestClient;
  role: WorkspaceRole;
  /** The console's public URL, for links: PUBLIC_URL with its base path. */
  appUrl: string;
  /** The projects the token is limited to, or null. */
  tokenProjectIds: string[] | null;
}

interface Project {
  id: string;
  name: string;
  captureMode?: string;
  bodyCaptureEnabled?: boolean;
  sourceAccessEnabled?: boolean;
  event_count?: number;
}

class ToolInputError extends Error {}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

// ── Shared inputs ────────────────────────────────────────────────────────

const projectInput = z.string().optional()
  .describe("Project id or name. Leave out when you can read only one project; list_projects shows them.");
const sinceInput = z.string().optional()
  .describe('How far back to look, e.g. "5m", "2h", "24h", "7d". Ignored when from is given.');
const fromInput = z.string().optional().describe("Start of the window, ISO 8601. Overrides since.");
const toInput = z.string().optional().describe("End of the window, ISO 8601. Defaults to now.");
const limitInput = (fallback: number, max: number) => z.number().int().min(1).max(max).optional()
  .describe(`How many items to return (default ${fallback}, at most ${max}).`);
const offsetInput = z.number().int().min(0).optional().describe("Skip this many items, for the next page. Each list says the next offset.");

// ── Small helpers ────────────────────────────────────────────────────────

function text(value: string, isError = false): CallToolResult {
  return { content: [{ type: "text", text: value }], ...(isError ? { isError: true } : {}) };
}

const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

export function timeWindow(args: { since?: string; from?: string; to?: string }, defaultSince: string): { from: string; to: string; label: string } {
  const now = Date.now();
  if (args.from) {
    const from = Date.parse(args.from);
    const to = args.to ? Date.parse(args.to) : now;
    if (!Number.isFinite(from) || !Number.isFinite(to)) throw new ToolInputError("from and to must be ISO 8601 dates, e.g. 2026-10-14T09:00:00Z.");
    if (from >= to) throw new ToolInputError("from must be before to.");
    return { from: new Date(from).toISOString(), to: new Date(to).toISOString(), label: `${new Date(from).toISOString()} to ${args.to ? new Date(to).toISOString() : "now"}` };
  }
  const since = (args.since ?? defaultSince).trim().toLowerCase();
  const match = /^(\d+(?:\.\d+)?)\s*(s|m|h|d|w)$/.exec(since);
  if (!match) throw new ToolInputError(`since must look like "10m", "24h" or "7d" (got "${args.since}").`);
  const span = Number(match[1]) * UNIT_MS[match[2]!]!;
  // The window ends a minute ahead so calls stamped by a slightly fast clock are included.
  return { from: new Date(now - span).toISOString(), to: new Date(now + 60_000).toISOString(), label: `last ${since}` };
}

function link(ctx: ToolContext, path: string, query: Record<string, string | null | undefined> = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value) params.set(key, value);
  const search = params.toString();
  return `${ctx.appUrl}${path}${search ? `?${search}` : ""}`;
}

function callLink(ctx: ToolContext, projectId: string, call: Row): string {
  const traceId = str(call["trace_id"]);
  return traceId
    ? link(ctx, `/traces/${encodeURIComponent(traceId)}`, { project: projectId, call: String(call["id"]) })
    : link(ctx, "/traces", { tab: "calls", q: String(call["id"]), project: projectId });
}

function runLink(ctx: ToolContext, projectId: string, traceId: string): string {
  return link(ctx, `/traces/${encodeURIComponent(traceId)}`, { project: projectId });
}

/** Why file/function and prompts are hidden on this project for this caller, or null when visible. */
function contentHiddenReason(ctx: ToolContext, project: Project): string | null {
  if (ctx.role === "viewer") return "your role (Viewer) doesn't include prompts, responses or code locations";
  if (project.sourceAccessEnabled === false) return "this project has code and content access turned off (Settings, Privacy & data)";
  return null;
}

const HTTP_REASON = (code: number) => (code === 429 ? "Rate limited (429)" : `HTTP ${code}`);

/** How a call failed, in words, or null when it succeeded. Same rules as the console. */
export function callFailure(call: Row): string | null {
  const state = String(call["lifecycle_state"] ?? "").toLowerCase();
  const status = num(call["status_code"]);
  const failedState = state === "failed" || state === "cancelled" || state === "canceled";
  const httpFailed = status !== null && status >= 400;
  if (!failedState && !httpFailed) return null;
  const name = String(call["lifecycle_error_type"] ?? "").trim();
  const http = /^http_(\d{3})$/i.exec(name);
  let reason: string | null = null;
  if (http) reason = HTTP_REASON(Number(http[1]));
  else if (/timeout|timedout|timed_out/i.test(name)) reason = num(call["duration_ms"]) ? `Timed out after ${duration(call["duration_ms"])}` : "Timed out";
  else if (/^(connecterror|connectionerror|apiconnectionerror|connecttimeout|econnrefused|enotfound)$/i.test(name)) reason = "Couldn't connect";
  else if (name) reason = name;
  else if (httpFailed) reason = HTTP_REASON(status!);
  const label = state.startsWith("cancel") ? "CANCELLED" : "FAILED";
  return reason ? `${label}: ${reason}` : label;
}

function tokensText(call: Row): string | null {
  const input = num(call["input_tokens"]);
  const output = num(call["output_tokens"]);
  if (input !== null || output !== null) return `${count(input ?? 0)} in / ${count(output ?? 0)} out tok`;
  if (num(call["total_tokens"]) !== null) return `${count(call["total_tokens"])} tok`;
  if (num(call["unit_value"]) !== null) return `${count(call["unit_value"])} ${String(call["unit"] ?? "units")}`;
  return null;
}

function callCost(call: Row): string {
  if (num(call["cost_usd"]) !== null) return usd(call["cost_usd"]);
  return callFailure(call) ? "no charge" : "unpriced";
}

function contextValue(call: Row, key: string): string | null {
  const context = call["context"];
  if (!context || typeof context !== "object") return null;
  const value = (context as Row)[key];
  return typeof value === "string" || typeof value === "number" ? String(value) : null;
}

function joinParts(parts: Array<string | number | null | undefined | false>): string {
  return parts.filter((part): part is string => typeof part === "string" && part.length > 0).join(" · ");
}

async function listProjects(ctx: ToolContext): Promise<Project[]> {
  const body = await ctx.api.get<{ projects?: Project[] }>("/api/v1/projects");
  return Array.isArray(body.projects) ? body.projects : [];
}

/** The project a tool reads: the one named, else the only one this caller can read. */
/** One project by id, from the cheap detail route; null when it isn't readable. */
async function projectById(ctx: ToolContext, id: string): Promise<Project | null> {
  try {
    const body = await ctx.api.get<{ project?: Row }>(`/api/v1/projects/${encodeURIComponent(id)}`);
    const row = body.project;
    if (!row) return null;
    return {
      id: String(row["id"]),
      name: String(row["name"] ?? row["id"]),
      captureMode: str(row["capture_mode"]) ?? undefined,
      bodyCaptureEnabled: row["body_capture_enabled"] === true,
      sourceAccessEnabled: row["source_access_enabled"] === true,
    };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

async function resolveProject(ctx: ToolContext, requested: string | undefined): Promise<Project> {
  // The project list counts every project's calls; skip it when the id is known.
  const knownId = requested?.trim() || (ctx.tokenProjectIds?.length === 1 ? ctx.tokenProjectIds[0] : undefined);
  if (knownId) {
    const project = await projectById(ctx, knownId);
    if (project) return project;
  }
  const projects = await listProjects(ctx);
  const names = () => projects.map((project) => `"${project.name}" (${project.id})`).join(", ");
  if (projects.length === 0) throw new ToolInputError("No projects are available to this token.");
  if (!requested?.trim()) {
    if (projects.length === 1) return projects[0]!;
    throw new ToolInputError(`Pass project: you can read ${projects.length} projects: ${names()}.`);
  }
  const wanted = requested.trim();
  const byId = projects.find((project) => project.id === wanted);
  if (byId) return byId;
  const byName = projects.filter((project) => project.name.toLowerCase() === wanted.toLowerCase());
  if (byName.length === 1) return byName[0]!;
  if (byName.length > 1) throw new ToolInputError(`More than one project is named "${wanted}". Pass the id: ${byName.map((project) => project.id).join(", ")}.`);
  throw new ToolInputError(`No project "${wanted}" here. Projects you can read: ${names()}.`);
}

function pageNote(shown: number, offset: number, total: number | null): string {
  if (shown === 0) return "";
  if (total === null) return `Showing ${offset + 1}–${offset + shown}.`;
  const more = offset + shown < total;
  return `Showing ${offset + 1}–${offset + shown} of ${count(total)}.${more ? ` Next page: offset=${offset + shown}.` : ""}`;
}

/** "summarize" → functionName, "src/a.ts:summarize" → the console's file:function key. */
function functionQuery(fn: string | undefined): Record<string, QueryValue> {
  if (!fn?.trim()) return {};
  return fn.includes(":") ? { function: fn.trim() } : { functionName: fn.trim() };
}

function statusQuery(status: string | undefined): Record<string, QueryValue> {
  if (!status?.trim()) return {};
  const items = status.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
  const query: Record<string, QueryValue> = {};
  const codes: number[] = [];
  for (const item of items) {
    if (item === "failed" || item === "error" || item === "errors") query["outcome"] = "failed";
    else if (/^[1-5]xx$/.test(item)) { const base = Number(item[0]) * 100; for (let code = base; code < base + 100; code++) codes.push(code); }
    else if (/^\d{3}$/.test(item)) codes.push(Number(item));
    else throw new ToolInputError(`status must be "failed", HTTP codes like "429,500", or "5xx" (got "${item}").`);
  }
  if (codes.length > 0) query["status"] = codes;
  return query;
}

function renderCallItem(ctx: ToolContext, project: Project, call: Row, index: number): string {
  const failure = callFailure(call);
  const model = [str(call["provider"]), str(call["model"]) ?? str(call["request_model"])].filter(Boolean).join("/");
  const head = joinParts([`${index}. ${String(call["id"])}`, ago(call["timestamp"]), model || null, failure ?? (num(call["status_code"]) ? `HTTP ${call["status_code"]}` : null)]);
  const second = joinParts([
    location(call["bl_file"], call["bl_line"], call["bl_function"]),
    tokensText(call),
    callCost(call),
    num(call["duration_ms"]) !== null ? duration(call["duration_ms"]) : null,
    call["parent_event_id"] ? `retry of ${String(call["parent_event_id"])}` : null,
  ]);
  const traceId = str(call["trace_id"]);
  const third = joinParts([
    traceId ? `run ${traceId}${str(call["trace_name"]) ? ` (${String(call["trace_name"])})` : ""}` : null,
    contextValue(call, "feature") ? `feature ${contextValue(call, "feature")}` : null,
    contextValue(call, "environment") ? `env ${contextValue(call, "environment")}` : null,
    str(call["release"]) ?? contextValue(call, "release") ? `release ${str(call["release"]) ?? contextValue(call, "release")}` : null,
  ]);
  return [head, second && `   ${second}`, third && `   ${third}`, `   ${callLink(ctx, project.id, call)}`].filter(Boolean).join("\n");
}

// ── Tools ────────────────────────────────────────────────────────────────

async function listProjectsTool(ctx: ToolContext): Promise<string> {
  const projects = await listProjects(ctx);
  if (projects.length === 0) return "No projects are available to this token.";
  const lines = [`${projects.length} project${projects.length === 1 ? "" : "s"} you can read (your role: ${ctx.role}${ctx.tokenProjectIds ? "; this token is limited to these" : ""}):`];
  for (const project of projects) {
    const capture = project.captureMode === "metadata" || project.bodyCaptureEnabled === false ? "metadata only (no prompts/responses)" : "prompts and responses captured";
    lines.push(`- ${project.name} (${project.id}) · ${capture}${project.sourceAccessEnabled === false ? " · code and content access off" : ""} · ${count(project.event_count ?? 0)} calls recorded`);
  }
  lines.push("", 'Pass project="<name or id>" to the other tools when you can read more than one.');
  return lines.join("\n");
}

interface FindCallsArgs {
  project?: string; since?: string; from?: string; to?: string; file?: string; function?: string; feature?: string;
  model?: string; provider?: string; environment?: string; release?: string; status?: string; trace_id?: string;
  search?: string; sort?: "newest" | "cost" | "duration"; limit?: number; offset?: number;
}

async function findCallsTool(ctx: ToolContext, args: FindCallsArgs): Promise<string> {
  const project = await resolveProject(ctx, args.project);
  const hidden = contentHiddenReason(ctx, project);
  if (hidden && (args.file || args.function)) throw new ToolInputError(`Can't filter by file or function: ${hidden}.`);
  const window = args.trace_id && !args.since && !args.from ? timeWindow({ since: "30d" }, "30d") : timeWindow(args, "24h");
  const limit = args.limit ?? 20;
  const offset = args.offset ?? 0;
  const body = await ctx.api.get<{ events?: Row[]; total?: number }>(`/api/v1/projects/${encodeURIComponent(project.id)}/events`, {
    from: window.from, to: window.to,
    file: args.file, ...functionQuery(args.function),
    feature: args.feature, model: args.model, provider: args.provider, environment: args.environment,
    release: args.release, traceId: args.trace_id, q: args.search,
    ...statusQuery(args.status),
    sort: args.sort === "cost" ? "cost_desc" : args.sort === "duration" ? "duration_desc" : "newest",
    limit, offset,
  });
  const events = Array.isArray(body.events) ? body.events : [];
  const total = num(body.total);
  const filters = joinParts([
    args.file && `file ${args.file}`, args.function && `function ${args.function}`, args.feature && `feature ${args.feature}`,
    args.model && `model ${args.model}`, args.provider && `provider ${args.provider}`, args.environment && `env ${args.environment}`,
    args.release && `release ${args.release}`, args.status && `status ${args.status}`, args.trace_id && `run ${args.trace_id}`,
    args.search && `matching "${args.search}"`,
  ]);
  const header = `${count(total ?? events.length)} call${total === 1 ? "" : "s"} in ${project.name} · ${window.label}${filters ? ` · ${filters}` : ""} · ${args.sort === "cost" ? "most expensive" : args.sort === "duration" ? "slowest" : "newest"} first`;
  if (events.length === 0) {
    return `${header}\nNo calls matched.${args.file ? " File matches the recorded path exactly or by its ending (e.g. \"agents/summarize.ts\")." : ""} Try a longer since, or fewer filters.`;
  }
  const lines = [header];
  if (hidden) lines.push(`(File/function hidden: ${hidden}.)`);
  lines.push("");
  events.forEach((call, index) => lines.push(renderCallItem(ctx, project, call, offset + index + 1)));
  lines.push("", pageNote(events.length, offset, total), "Use get_call with a call id for its prompt, response, stack and cost breakdown.");
  return lines.filter((line, index, all) => !(line === "" && all[index - 1] === "")).join("\n");
}

const TOKEN_COMPONENTS = new Set(["input", "output", "cacheRead", "cacheWrite", "cacheWrite1h", "imageOutput", "reasoning", "audioInput", "audioOutput"]);

function costLines(call: Row): string[] {
  const breakdown = call["cost_breakdown"] as Row | null | undefined;
  const lines: string[] = [];
  const cost = num(call["cost_usd"]);
  const basis = String(call["cost_basis"] ?? "unknown");
  const source = str(call["cost_source"]);
  if (cost === null) {
    lines.push(callFailure(call)
      ? "Cost: no charge (the call failed and the provider reported no cost)"
      : `Cost: unpriced (no price for ${str(call["model"]) ?? "this model"} yet; set one in Settings, Prices & credits)`);
    return lines;
  }
  const how = basis === "reported" ? "reported by the provider"
    : source?.startsWith("catalog:") ? `estimated from the price catalog (${source.slice(8)})`
      : source === "explicit" || source === "client_reported" ? "reported by your code"
        : source ? `estimated (${source})` : basis === "estimated" ? "estimated from list prices" : basis;
  lines.push(`Cost: ${usd(cost)} · ${how}${str(call["pricing_id"]) ? ` · price ${String(call["pricing_id"])}` : ""}`);
  if (breakdown && breakdown["kind"] === "catalog" && Array.isArray(breakdown["lines"])) {
    for (const raw of breakdown["lines"] as Row[]) {
      const component = String(raw["component"] ?? "");
      const rate = num(raw["rate"]) ?? 0;
      const perUnit = TOKEN_COMPONENTS.has(component) ? `${usd(rate * 1_000_000)}/M tok` : `${usd(rate)}/${component}`;
      lines.push(`  ${component} ${count(raw["quantity"])} × ${perUnit} = ${usd(raw["cost"])}`);
    }
  }
  if (num(call["cache_saved_usd"])) lines.push(`  cache saved ${usd(call["cache_saved_usd"])}`);
  return lines;
}

async function bodyUnavailable(ctx: ToolContext, project: Project, call: Row, which: "request" | "response"): Promise<string> {
  const status = String(call["content_status"] ?? "unknown");
  const hidden = contentHiddenReason(ctx, project);
  if (status === "restricted" || hidden) return `Hidden: ${hidden ?? "you can't read content on this project"}.`;
  if (status === "metadata_only") return "Not captured: this project records metadata only. Turn on body capture in Settings, Privacy & data.";
  if (status === "expired") {
    let days: number | null = null;
    try {
      const detail = await ctx.api.get<{ project?: Row }>(`/api/v1/projects/${encodeURIComponent(project.id)}`);
      days = num(detail.project?.["body_retention_days"]);
    } catch { /* the retention period is a detail */ }
    return `Expired: removed by the project's ${days ? `${days}-day ` : ""}body retention.`;
  }
  if (status === "redacted") return "Redacted by the project's privacy settings.";
  if (status === "not_available") return `Not available: the SDK sent no ${which} body for this call.`;
  return `No ${which} body was recorded for this call.`;
}

interface GetCallArgs { project?: string; call_id: string; include?: Array<"messages" | "raw" | "frames" | "metadata">; max_chars?: number }

async function getCallTool(ctx: ToolContext, args: GetCallArgs): Promise<string> {
  const project = await resolveProject(ctx, args.project);
  const include = new Set(args.include ?? []);
  const budget = args.max_chars ?? 4000;
  const { event: call } = await ctx.api.get<{ event: Row }>(`/api/v1/projects/${encodeURIComponent(project.id)}/events/${encodeURIComponent(args.call_id)}`);
  const failure = callFailure(call);
  const traceId = str(call["trace_id"]);
  const lines: string[] = [];
  lines.push(`# Call ${String(call["id"])}${failure ? ` · ${failure}` : num(call["status_code"]) ? ` · HTTP ${call["status_code"]}` : ""}`);
  lines.push(joinParts([`Project ${project.name}`, when(call["timestamp"])]));
  lines.push(`Console: ${callLink(ctx, project.id, call)}`);
  lines.push("");
  const requested = str(call["request_model"]);
  const model = str(call["model"]);
  lines.push(`Model: ${[str(call["provider"]), model ?? requested].filter(Boolean).join("/")}${requested && model && requested !== model ? ` (requested ${requested})` : ""}${call["streaming"] ? " · streamed" : ""}`);
  const statusBits = joinParts([
    num(call["status_code"]) !== null ? `HTTP ${call["status_code"]}` : "no HTTP status recorded",
    str(call["lifecycle_state"]) ? `lifecycle ${call["lifecycle_state"]}${str(call["lifecycle_error_type"]) ? ` (${call["lifecycle_error_type"]})` : ""}` : null,
  ]);
  lines.push(`Status: ${statusBits}`);
  const tokenBits = joinParts([
    num(call["input_tokens"]) !== null && `${count(call["input_tokens"])} in`,
    num(call["output_tokens"]) !== null && `${count(call["output_tokens"])} out`,
    num(call["reasoning_tokens"]) && `${count(call["reasoning_tokens"])} reasoning`,
    num(call["cache_read_tokens"]) && `${count(call["cache_read_tokens"])} cache read`,
    num(call["cache_creation_tokens"]) && `${count(call["cache_creation_tokens"])} cache write`,
    num(call["unit_value"]) !== null && num(call["input_tokens"]) === null && `${count(call["unit_value"])} ${String(call["unit"] ?? "units")}`,
  ]);
  lines.push(`Usage: ${tokenBits || "not reported"}`);
  lines.push(...costLines(call));
  lines.push(`Latency: ${joinParts([duration(call["duration_ms"]), num(call["ttft"]) !== null && `first token ${duration(call["ttft"])}`, num(call["tps"]) !== null && `${Math.round(num(call["tps"])!)} tok/s`])}`);
  const runBits = joinParts([
    traceId ? `run ${traceId}${str(call["trace_name"]) ? ` (${String(call["trace_name"])})` : ""}` : "not part of a run",
    contextValue(call, "feature") && `feature ${contextValue(call, "feature")}`,
    contextValue(call, "environment") && `env ${contextValue(call, "environment")}`,
    (str(call["release"]) ?? contextValue(call, "release")) && `release ${str(call["release"]) ?? contextValue(call, "release")}`,
    contextValue(call, "customer") && `customer ${contextValue(call, "customer")}`,
    str(call["phase"]) && `phase ${call["phase"]}`,
  ]);
  lines.push(`Context: ${runBits}`);

  // Retries: what this call retried, and what retried it.
  const retryLines: string[] = [];
  if (str(call["parent_event_id"])) retryLines.push(`This call is a retry of ${String(call["parent_event_id"])}.`);
  if (traceId) {
    try {
      const timestamp = Date.parse(String(call["timestamp"]));
      const siblings = await ctx.api.get<{ events?: Row[] }>(`/api/v1/projects/${encodeURIComponent(project.id)}/events`, {
        traceId, limit: 200, from: Number.isFinite(timestamp) ? new Date(timestamp - 60_000).toISOString() : undefined,
      });
      for (const retry of (siblings.events ?? []).filter((event) => event["parent_event_id"] === call["id"])) {
        retryLines.push(`Retried as ${String(retry["id"])} (${callFailure(retry) ?? (num(retry["status_code"]) ? `HTTP ${retry["status_code"]}` : "succeeded")}).`);
      }
    } catch { /* retries are a detail */ }
  }
  if (retryLines.length > 0) lines.push(`Retries: ${retryLines.join(" ")}`);

  // Code: where the call was made, with the source the SDK recorded.
  const hidden = contentHiddenReason(ctx, project);
  lines.push("", "## Call site");
  if (hidden) {
    lines.push(`Hidden: ${hidden}.`);
  } else {
    const site = location(call["bl_file"], call["bl_line"], call["bl_function"]);
    if (site) lines.push(`Attributed to ${site}`);
    const frames = (Array.isArray(call["call_site_frames"]) ? call["call_site_frames"] : []) as Frame[];
    const shown = include.has("frames") ? frames : frames.filter(isInAppFrame).slice(0, 5);
    if (shown.length > 0) {
      lines.push(include.has("frames") ? `Stack (${frames.length} frames):` : `Stack (your code, ${shown.length} of ${frames.length} frames; include "frames" for all):`);
      shown.forEach((frame, index) => lines.push(renderFrame(frame, isInAppFrame(frame) && (include.has("frames") ? index < 8 : index < 3))));
    } else if (frames.length > 0) {
      lines.push(`No frames from your code; ${frames.length} library frames (include "frames" to see them).`);
    } else if (!site) {
      lines.push("No stack was recorded for this call.");
    }
    const scope = call["scope_site"] as Row | null | undefined;
    if (scope && Array.isArray(scope["frames"])) {
      const scopeFrames = (scope["frames"] as Frame[]).filter(isInAppFrame).slice(0, 3);
      if (scopeFrames.length > 0) {
        lines.push(`Made on a framework task; the code that opened its ${String(scope["kind"] ?? "span")} "${String(scope["name"] ?? "")}":`);
        scopeFrames.forEach((frame, index) => lines.push(renderFrame(frame, index === 0)));
      }
    }
  }

  // Prompt and response, trimmed.
  const conversation = conversationFrom(call["request_body"], call["system_prompt"], call["metadata"]);
  const lastN = include.has("messages") ? Number.MAX_SAFE_INTEGER : 6;
  lines.push("", `## Prompt${conversation ? ` (${conversation.system ? "system + " : ""}${conversation.messages.length} message${conversation.messages.length === 1 ? "" : "s"})` : ""}`);
  if (conversation) lines.push(renderConversation(conversation, Math.floor(budget * 0.6), lastN));
  else if (call["request_body"] != null) lines.push(compactJson(call["request_body"], Math.floor(budget * 0.6)));
  else lines.push(await bodyUnavailable(ctx, project, call, "request"));
  lines.push("", "## Response");
  const answer = responseText(call["response_body"]);
  if (answer) lines.push(trim(answer, Math.floor(budget * 0.4)));
  else if (call["response_body"] != null) lines.push(compactJson(call["response_body"], Math.floor(budget * 0.4)));
  else lines.push(failure ? `${await bodyUnavailable(ctx, project, call, "response")} The call failed: ${failure.replace(/^[A-Z]+: ?/, "") || "no reason recorded"}.` : await bodyUnavailable(ctx, project, call, "response"));
  if (include.has("raw")) {
    lines.push("", "## Raw request", call["request_body"] == null ? "(none)" : compactJson(call["request_body"], budget));
    lines.push("", "## Raw response", call["response_body"] == null ? "(none)" : compactJson(call["response_body"], budget));
  }
  if (include.has("metadata") && call["metadata"] && typeof call["metadata"] === "object") {
    lines.push("", "## Metadata", compactJson(call["metadata"], Math.floor(budget / 2)));
  }
  return lines.join("\n");
}

function runState(trace: Row, rootFailed = false): string {
  const execution = String(trace["execution_state"] ?? "").toLowerCase();
  const retry = trace["retry"] as Row | null | undefined;
  if (retry?.["retried"]) return `attempt failed${retry["errorType"] ? ` (${String(retry["errorType"])})` : ""}, attempt ${String(retry["succeededOnAttempt"] ?? 2)} succeeded as ${String(retry["succeededBy"] ?? "?")}`;
  if (execution === "failed" || execution === "error") return `FAILED${retry?.["errorType"] ? ` (${String(retry["errorType"])})` : ""}${retry?.["willRetry"] ? ", will retry" : ""}`;
  if (execution === "cancelled" || execution === "canceled") return "CANCELLED";
  if (execution === "running" || execution === "started" || execution === "in_progress") return "running";
  if (rootFailed) return "FAILED (the run's root span errored)";
  if (trace["span_error"] === true) return "finished, a step errored";
  return "succeeded";
}

function runCost(trace: Row): string {
  if (num(trace["call_count"]) === 0) return "no model calls";
  const cost = num(trace["known_cost"] ?? trace["total_cost"]);
  const unpriced = num(trace["unpriced_count"]) ?? 0;
  if (cost === null) return "unpriced";
  return `${usd(cost)}${unpriced > 0 ? ` + ${unpriced} unpriced` : ""}`;
}

interface FindRunsArgs {
  project?: string; since?: string; from?: string; to?: string; failed_only?: boolean; feature?: string; function?: string;
  file?: string; model?: string; environment?: string; release?: string; search?: string; include_idle?: boolean;
  sort?: "newest" | "cost" | "duration" | "calls"; limit?: number; offset?: number;
}

async function findRunsTool(ctx: ToolContext, args: FindRunsArgs): Promise<string> {
  const project = await resolveProject(ctx, args.project);
  const hidden = contentHiddenReason(ctx, project);
  if (hidden && (args.file || args.function)) throw new ToolInputError(`Can't filter by file or function: ${hidden}.`);
  const window = timeWindow(args, "24h");
  const limit = args.limit ?? 20;
  const offset = args.offset ?? 0;
  const body = await ctx.api.get<{ traces?: Row[]; total?: number }>(`/api/v1/projects/${encodeURIComponent(project.id)}/traces`, {
    from: window.from, to: window.to,
    outcome: args.failed_only ? "failed" : undefined,
    // Runs that made no model calls are hidden unless asked for, as in the console; a failed one always shows.
    withCalls: args.failed_only || args.include_idle ? undefined : "1",
    feature: args.feature, file: args.file, ...functionQuery(args.function), model: args.model,
    environment: args.environment, release: args.release, q: args.search,
    sort: args.sort === "cost" ? "cost_desc" : args.sort === "duration" ? "duration_desc" : args.sort === "calls" ? "calls_desc" : "newest",
    limit, offset,
  });
  const traces = Array.isArray(body.traces) ? body.traces : [];
  const total = num(body.total);
  const header = `${count(total ?? traces.length)} ${args.failed_only ? "failed " : ""}run${total === 1 ? "" : "s"} in ${project.name} · ${window.label}`;
  if (traces.length === 0) return `${header}\nNo runs matched.`;
  const lines = [header, ""];
  traces.forEach((trace, index) => {
    const traceId = String(trace["trace_id"]);
    lines.push(joinParts([`${offset + index + 1}. ${traceId}${str(trace["trace_name"]) ? ` "${String(trace["trace_name"])}"` : ""}`, ago(trace["started_at"]), runState(trace), duration(trace["elapsed_ms"]), `${count(trace["call_count"])} call${num(trace["call_count"]) === 1 ? "" : "s"}`, runCost(trace)]));
    const detail = joinParts([
      str(trace["agent"]) && `agent ${trace["agent"]}`,
      num(trace["step_count"]) ? `${count(trace["step_count"])} steps` : null,
      num(trace["tool_count"]) ? `${count(trace["tool_count"])} tools` : null,
      str(trace["feature"]) && `feature ${trace["feature"]}`,
      str(trace["environment"]) && `env ${trace["environment"]}`,
      str(trace["release"]) && `release ${trace["release"]}`,
      str(trace["models"]) && `models ${trace["models"]}`,
    ]);
    if (detail) lines.push(`   ${detail}`);
    lines.push(`   ${runLink(ctx, project.id, traceId)}`);
  });
  lines.push("", pageNote(traces.length, offset, total), "Use get_run with a run id to see it as a tree with the first failure marked.");
  return lines.join("\n");
}

export interface TreeNode {
  kind: "span" | "call";
  id: string;
  start: number;
  row: Row;
  children: TreeNode[];
  failed: boolean;
  cost: number;
  unpriced: number;
}

function startOf(value: unknown): number {
  const time = typeof value === "string" ? Date.parse(value) : value instanceof Date ? value.getTime() : NaN;
  return Number.isFinite(time) ? time : Number.MAX_SAFE_INTEGER;
}

/** Spans nested by parent, each call under the span it ran in, in start order. */
export function buildRunTree(spans: Row[], calls: Row[]): TreeNode[] {
  const nodes = new Map<string, TreeNode>();
  for (const span of spans) {
    nodes.set(String(span["id"]), { kind: "span", id: String(span["id"]), start: startOf(span["started_at"]), row: span, children: [], failed: String(span["status"] ?? "") === "error", cost: 0, unpriced: 0 });
  }
  const roots: TreeNode[] = [];
  for (const node of nodes.values()) {
    const parent = str(node.row["parent_span_id"]);
    const parentNode = parent ? nodes.get(parent) : undefined;
    if (parentNode && parentNode !== node) parentNode.children.push(node);
    else roots.push(node);
  }
  for (const call of calls) {
    const cost = num(call["cost_usd"]);
    const node: TreeNode = { kind: "call", id: String(call["id"]), start: startOf(call["timestamp"]), row: call, children: [], failed: callFailure(call) !== null, cost: cost ?? 0, unpriced: cost === null && !callFailure(call) ? 1 : 0 };
    const span = str(call["span_id"]);
    const parent = span ? nodes.get(span) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const settle = (node: TreeNode): void => {
    node.children.sort((a, b) => a.start - b.start);
    for (const child of node.children) {
      settle(child);
      node.cost += child.cost;
      node.unpriced += child.unpriced;
    }
  };
  roots.sort((a, b) => a.start - b.start);
  for (const root of roots) settle(root);
  return roots;
}

/** The earliest node that failed on its own, by start time. */
export function firstFailure(roots: TreeNode[]): TreeNode | null {
  let first: TreeNode | null = null;
  // A span that errored because something inside it failed is not where it started.
  const failsInside = (node: TreeNode): boolean => node.children.some((child) => child.failed || failsInside(child));
  const visit = (node: TreeNode) => {
    if (node.failed && !(node.kind === "span" && failsInside(node)) && (!first || node.start < first.start)) first = node;
    node.children.forEach(visit);
  };
  roots.forEach(visit);
  return first;
}

function renderNode(node: TreeNode, depth: number, first: TreeNode | null, out: string[]): void {
  const indent = "  ".repeat(depth);
  const mark = node === first ? "  ← first failure" : "";
  if (node.kind === "span") {
    const row = node.row;
    const status = String(row["status"] ?? "");
    out.push(`${indent}${String(row["kind"] ?? "span")} ${String(row["name"] ?? row["id"])} · ${status === "error" ? `ERROR${str(row["error_type"]) ? ` ${row["error_type"]}` : ""}` : status || "ok"} · ${duration(row["duration_ms"])}${node.cost || node.unpriced ? ` · ${usd(node.cost)}${node.unpriced ? ` + ${node.unpriced} unpriced` : ""}` : ""}${mark}`);
  } else {
    const call = node.row;
    const model = str(call["model"]) ?? str(call["request_model"]) ?? str(call["provider"]) ?? "call";
    out.push(`${indent}call ${model} · ${callFailure(call) ?? (num(call["status_code"]) ? `HTTP ${call["status_code"]}` : "ok")} · ${duration(call["duration_ms"])} · ${callCost(call)}${tokensText(call) ? ` · ${tokensText(call)}` : ""}${location(call["bl_file"], call["bl_line"], call["bl_function"]) ? ` · ${location(call["bl_file"], call["bl_line"], call["bl_function"])}` : ""}${call["parent_event_id"] ? ` · retry of ${String(call["parent_event_id"])}` : ""} · ${node.id}${mark}`);
  }
  for (const child of node.children) renderNode(child, depth + 1, first, out);
}

interface GetRunArgs { project?: string; run_id: string; max_lines?: number }

async function getRunTool(ctx: ToolContext, args: GetRunArgs): Promise<string> {
  const project = await resolveProject(ctx, args.project);
  const base = `/api/v1/projects/${encodeURIComponent(project.id)}`;
  const detail = await ctx.api.get<{ summary: Row; events?: Row[]; spans?: Row[] }>(`${base}/traces/${encodeURIComponent(args.run_id)}`);
  let checks: Row[] = [];
  try {
    const result = await ctx.api.get<{ results?: Row[] }>(`${base}/quality/runs/${encodeURIComponent(args.run_id)}/checks`);
    checks = Array.isArray(result.results) ? result.results : [];
  } catch { /* checks are optional */ }
  const summary = detail.summary ?? {};
  const calls = (detail.events ?? []).filter((event) => (event["event_type"] ?? "call") === "call");
  const spans = detail.spans ?? [];
  const roots = buildRunTree(spans, calls);
  const rootFailed = roots.some((root) => root.kind === "span" && root.failed);
  const lines: string[] = [];
  lines.push(`# Run ${args.run_id}${str(summary["trace_name"]) ? ` "${String(summary["trace_name"])}"` : ""} · ${runState(summary, rootFailed)}`);
  lines.push(joinParts([`Project ${project.name}`, when(summary["started_at"]), duration(summary["elapsed_ms"]), `${count(summary["call_count"])} calls`, runCost(summary)]));
  const context = joinParts([
    str(summary["agent"]) && `agent ${summary["agent"]}`, str(summary["feature"]) && `feature ${summary["feature"]}`,
    str(summary["environment"]) && `env ${summary["environment"]}`, str(summary["release"]) && `release ${summary["release"]}`,
    str(summary["customer"]) && `customer ${summary["customer"]}`, str(summary["execution_id"]) && `execution ${summary["execution_id"]}`,
  ]);
  if (context) lines.push(context);
  lines.push(`Console: ${runLink(ctx, project.id, args.run_id)}`);
  const failedCalls = calls.filter((call) => callFailure(call));
  if (failedCalls.length > 0) lines.push(`${failedCalls.length} of ${calls.length} calls failed.`);
  lines.push("");
  const first = firstFailure(roots);
  const tree: string[] = [];
  for (const root of roots) renderNode(root, 0, first, tree);
  const maxLines = args.max_lines ?? 150;
  lines.push("## Tree (agent → step → tool → call; call ids work with get_call)");
  lines.push(...tree.slice(0, maxLines));
  if (tree.length > maxLines) lines.push(`… ${tree.length - maxLines} more lines (raise max_lines to see them)`);
  if (tree.length === 0) lines.push("No spans or calls recorded in this run.");
  if (first) {
    const row = first.row;
    lines.push("", `First failure: ${first.kind === "call" ? `call ${first.id} (${callFailure(row)})${location(row["bl_file"], row["bl_line"], row["bl_function"]) ? ` at ${location(row["bl_file"], row["bl_line"], row["bl_function"])}` : ""}. get_call call_id="${first.id}" shows its prompt, response and stack.` : `${String(row["kind"] ?? "span")} ${String(row["name"] ?? first.id)}${str(row["error_type"]) ? ` raised ${row["error_type"]}` : " errored"}.`}`);
  }
  if (checks.length > 0) {
    lines.push("", "## Quality checks");
    for (const check of checks) {
      const state = String(check["state"] ?? "");
      lines.push(`- ${String(check["name"])} (${String(check["kind"] ?? "check")}): ${state.toUpperCase()}${num(check["score"]) !== null ? ` · score ${num(check["score"])!.toFixed(2)}` : ""}${str(check["reason"]) ? ` · ${trim(String(check["reason"]), 300)}` : ""}${str(check["detail"]) ? ` · ${trim(String(check["detail"]), 200)}` : ""}`);
    }
  }
  return lines.join("\n");
}

interface RecentErrorsArgs { project?: string; since?: string; from?: string; to?: string; environment?: string; limit?: number }

async function recentErrorsTool(ctx: ToolContext, args: RecentErrorsArgs): Promise<string> {
  const project = await resolveProject(ctx, args.project);
  const window = timeWindow(args, "24h");
  const limit = args.limit ?? 10;
  const base = `/api/v1/projects/${encodeURIComponent(project.id)}`;
  const query = { from: window.from, to: window.to, environment: args.environment };
  const [errors, quality, latest] = await Promise.all([
    ctx.api.get<{ totals?: Row; failedCalls?: Row[]; failedSpans?: Row[]; retries?: Row[] }>(`${base}/errors`, query),
    ctx.api.get<{ totals?: Row; owners?: Row[]; failures?: Row[] }>(`${base}/quality/summary`, query).catch(() => null),
    ctx.api.get<{ events?: Row[]; total?: number }>(`${base}/events`, { ...query, outcome: "failed", limit: 5 }),
  ]);
  const totals = errors.totals ?? {};
  const qualityTotals = quality?.totals ?? {};
  const failedCallTotal = num(latest.total) ?? num(totals["failedCalls"]) ?? 0;
  const lines: string[] = [];
  const callRate = num(totals["calls"]) ? ` of ${count(totals["calls"])} (${((failedCallTotal / num(totals["calls"])!) * 100).toFixed(1)}%)` : "";
  lines.push(`Errors in ${project.name} · ${window.label}${args.environment ? ` · env ${args.environment}` : ""}`);
  lines.push(joinParts([
    `${count(failedCallTotal)} failed calls${callRate}`,
    num(totals["retries"]) ? `${count(totals["retries"])} retries` : null,
    num(totals["wastedCost"]) ? `${usd(totals["wastedCost"])} spent on failed calls and retries` : null,
    num(qualityTotals["runs"]) ? `${count(qualityTotals["failedRuns"])} of ${count(qualityTotals["runs"])} runs failed` : null,
  ]));
  const failedCalls = (errors.failedCalls ?? []).slice(0, limit);
  if (failedCalls.length > 0) {
    lines.push("", "Failed calls by model and status:");
    for (const row of failedCalls) {
      lines.push(`- ${[str(row["provider"]), str(row["model"])].filter(Boolean).join("/")} · ${num(row["statusCode"]) ? HTTP_REASON(num(row["statusCode"])!) : "error"} · ${count(row["calls"])} calls in ${count(row["runs"])} runs · last ${ago(row["lastSeen"])}${str(row["sampleTraceId"]) ? ` · sample run ${row["sampleTraceId"]}` : ""}`);
    }
  }
  const spans = (errors.failedSpans ?? []).slice(0, limit);
  if (spans.length > 0) {
    lines.push("", "Failed steps and tools:");
    for (const row of spans) {
      lines.push(`- ${String(row["kind"] ?? "span")} ${String(row["name"])}${str(row["errorType"]) ? ` · ${row["errorType"]}` : ""} · ${count(row["failures"])} failures · last ${ago(row["lastSeen"])}${str(row["sampleTraceId"]) ? ` · sample run ${row["sampleTraceId"]}` : ""}`);
    }
  }
  const owners = (quality?.owners ?? []).filter((row) => num(row["failedRuns"])).slice(0, limit);
  if (owners.length > 0) {
    lines.push("", "Failing agents and workflows:");
    for (const row of owners) {
      lines.push(`- ${String(row["name"])} (${String(row["kind"])}) · ${count(row["failedRuns"])} of ${count(row["runs"])} runs failed${num(row["toolFailures"]) ? ` · ${count(row["toolFailures"])} with a failed tool` : ""}${num(row["judgedFailed"]) ? ` · ${count(row["judgedFailed"])} judged failing` : ""}`);
    }
  }
  const failures = (quality?.failures ?? []).slice(0, limit);
  if (failures.length > 0) {
    lines.push("", "Latest failed runs:");
    for (const row of failures) {
      const reasons = Array.isArray(row["reasons"]) ? (row["reasons"] as unknown[]).map(String).join(", ") : "";
      lines.push(`- ${String(row["traceId"])} ${String(row["name"] ?? "")} · ${ago(row["startedAt"])} · ${reasons}${str(row["detail"]) ? ` · "${trim(String(row["detail"]), 160)}"` : ""}`);
    }
  }
  const latestCalls = latest.events ?? [];
  if (latestCalls.length > 0) {
    lines.push("", "Latest failed calls:");
    for (const call of latestCalls) {
      lines.push(`- ${joinParts([String(call["id"]), ago(call["timestamp"]), [str(call["provider"]), str(call["model"])].filter(Boolean).join("/"), callFailure(call), location(call["bl_file"], call["bl_line"], call["bl_function"]), str(call["trace_id"]) && `run ${call["trace_id"]}`])}`);
    }
  }
  if (failedCallTotal === 0 && spans.length === 0 && failures.length === 0) lines.push("", "No failed calls, steps or runs in this window.");
  else lines.push("", "Next: get_run run_id=… for a run tree, get_call call_id=… for a call's prompt and stack, or find_calls status=failed for more.");
  return lines.join("\n");
}

type GroupBy = "feature" | "function" | "model" | "provider" | "release" | "customer";

interface CostBreakdownArgs {
  project?: string; group_by?: GroupBy; since?: string; from?: string; to?: string; environment?: string;
  feature?: string; model?: string; release?: string; limit?: number; offset?: number;
}

async function costBreakdownTool(ctx: ToolContext, args: CostBreakdownArgs): Promise<string> {
  const project = await resolveProject(ctx, args.project);
  const groupBy = args.group_by ?? "feature";
  const hidden = contentHiddenReason(ctx, project);
  if (hidden && groupBy === "function") throw new ToolInputError(`Can't group by function: ${hidden}.`);
  const window = timeWindow(args, "7d");
  const limit = args.limit ?? 15;
  const offset = args.offset ?? 0;
  const base = `/api/v1/projects/${encodeURIComponent(project.id)}`;
  const body = await ctx.api.get<{ totals?: Row; contributors?: Row[]; total?: number }>(`${base}/costs`, {
    from: window.from, to: window.to,
    groupBy: groupBy === "release" ? "context" : groupBy,
    contextKey: groupBy === "release" ? "release" : undefined,
    environment: args.environment, feature: args.feature, model: args.model, release: args.release,
    limit, offset,
  });
  const totals = body.totals ?? {};
  const rows = body.contributors ?? [];
  const lines: string[] = [];
  const priced = num(totals["coverage"]);
  lines.push(`Cost by ${groupBy} in ${project.name} · ${window.label}, compared with the same length of time before`);
  lines.push(joinParts([
    `Total ${usd(totals["known_cost"])}`,
    `${count(totals["observations"])} charges`,
    num(totals["trace_count"]) ? `${count(totals["trace_count"])} runs` : null,
    num(totals["unpriced_count"]) ? `${count(totals["unpriced_count"])} unpriced (${priced !== null ? `${Math.round(priced * 100)}% priced` : "partly priced"})` : null,
  ]));
  if (rows.length === 0) {
    lines.push("No spend in this window.");
  } else {
    lines.push("");
    rows.forEach((row, index) => {
      const label = String(row["label"] ?? row["key"] ?? "(unassigned)");
      const previous = num(row["previous_known_cost"]);
      const change = previous !== null && num(row["known_cost"]) !== null ? ` (before ${usd(previous)}, ${signedUsd(row["change_abs"])})` : previous === null && num(row["known_cost"]) ? " (new this period)" : "";
      lines.push(`${offset + index + 1}. ${label} · ${usd(row["known_cost"])}${change} · ${count(row["call_count"] ?? row["observations"])} calls${num(row["unpriced_count"]) ? ` · ${count(row["unpriced_count"])} unpriced` : ""}${num(row["unit_cost"]) !== null ? ` · ${usd(row["unit_cost"])} ${String(row["unit_label"] ?? "per run")}${num(row["change_pct"]) !== null ? ` (${pct(row["change_pct"])})` : ""}` : ""}`);
    });
    lines.push("", pageNote(rows.length, offset, num(body.total)));
  }
  if (groupBy === "release") {
    try {
      const summary = await ctx.api.get<{ byRelease?: Row[]; releaseComparison?: Row }>(`${base}/summary`);
      const releases = (summary.byRelease ?? []).slice(0, 10);
      if (releases.length > 0) {
        lines.push("", "This month vs last month, by release:");
        for (const row of releases) {
          lines.push(`- ${String(row["release"] ?? "(none)")} · ${num(row["known_cost"]) === null && num(row["priced_observations"]) ? "partly priced" : usd(row["known_cost"])} · ${count(row["calls"])} calls${row["comparison_available"] ? ` · ${signedUsd(row["change_abs"])} (${pct(row["change_pct"])})` : ""}`);
        }
        const comparison = summary.releaseComparison ?? {};
        if (!comparison["available"] && str(comparison["reason"])) lines.push(`(${String(comparison["reason"])}.)`);
      }
    } catch { /* the monthly comparison is extra */ }
  }
  lines.push(`Console: ${link(ctx, "/costs", { project: project.id, groupBy: groupBy === "release" ? "context" : groupBy, contextKey: groupBy === "release" ? "release" : null })}`);
  return lines.join("\n");
}

interface HotCallSitesArgs { project?: string; sort?: "cost" | "latency" | "calls"; limit?: number }

async function hotCallSitesTool(ctx: ToolContext, args: HotCallSitesArgs): Promise<string> {
  const project = await resolveProject(ctx, args.project);
  const sort = args.sort ?? "cost";
  const limit = args.limit ?? 15;
  const body = await ctx.api.get<{ callSites?: Row[] }>(`/api/v1/projects/${encodeURIComponent(project.id)}/call-sites`, {
    sort: sort === "latency" ? "avg_duration_ms" : sort === "calls" ? "total_calls" : "total_cost_usd",
    limit,
  });
  const sites = body.callSites ?? [];
  const hidden = contentHiddenReason(ctx, project);
  const lines = [`Call sites in ${project.name} by ${sort === "latency" ? "average latency" : sort === "calls" ? "call count" : "total cost"}, over all recorded calls`];
  if (hidden) lines.push(`(File/function hidden: ${hidden}.)`);
  if (sites.length === 0) return `${lines.join("\n")}\nNo call sites recorded yet.`;
  lines.push("");
  sites.forEach((site, index) => {
    const where = location(site["file_name"], site["line_number"], site["function_name"]) ?? "(location hidden)";
    lines.push(`${index + 1}. ${where} · ${[str(site["provider"]), str(site["model"])].filter(Boolean).join("/")}`);
    lines.push(`   ${joinParts([
      `${count(site["total_calls"])} calls`,
      `${usd(site["total_cost_usd"])} total`,
      num(site["unpriced_calls"]) ? `${count(site["unpriced_calls"])} unpriced` : null,
      `avg ${duration(site["avg_duration_ms"])}`,
      num(site["avg_ttft"]) ? `first token ${duration(site["avg_ttft"])}` : null,
      `${count(site["total_input_tokens"])} in / ${count(site["total_output_tokens"])} out tok`,
      `last ${ago(site["last_seen"])}`,
    ])}`);
    const file = str(site["file_name"]);
    const fn = str(site["function_name"]);
    if (file || fn) lines.push(`   ${link(ctx, "/traces", { tab: "calls", function: `${file ?? ""}:${fn ?? ""}`, project: project.id })}`);
  });
  lines.push("", 'Use find_calls file="<path>" to see the calls from one site.');
  return lines.join("\n");
}

// ── Registration ─────────────────────────────────────────────────────────

function wrap<A>(ctx: ToolContext, run: (ctx: ToolContext, args: A) => Promise<string>) {
  return async (args: A): Promise<CallToolResult> => {
    try {
      return text(await run(ctx, args));
    } catch (error) {
      if (error instanceof ToolInputError) return text(error.message, true);
      if (error instanceof ApiError) {
        if (error.status === 404) return text(`Not found: ${error.message}. Check the id, or that it belongs to a project this token can read.`, true);
        if (error.status === 403) return text(`Not allowed: ${error.message}.`, true);
        if (error.status === 429) return text("Rate limited: too many requests with this token. Wait a minute and try again.", true);
        if (error.status === 401) return text("This token is invalid, expired or revoked. Create a new one in Settings, Coding agents.", true);
        return text(`CostKey returned an error (${error.status}): ${error.message}`, true);
      }
      console.error("[costkey] MCP tool error:", error);
      return text("CostKey couldn't answer that. Try again.", true);
    }
  };
}

export const SERVER_INSTRUCTIONS = `CostKey records every LLM call an app makes: model, tokens, cost, latency, status, the code that made it (file:line with source), and, where the project captures them, the prompt and response. Calls group into runs (traces): one execution of an agent or job, with its steps and tools.

To debug: recent_errors for what is failing; find_calls to list calls from a file, function, feature or model in a time window (status="failed" for failures); get_call for one call's prompt, response, stack and cost breakdown; find_runs and get_run to see a run as a tree with the first failure marked. For cost: cost_breakdown (group_by release to compare releases) and hot_call_sites.

Every tool takes an optional project (name or id). Ids in one tool's output (call ids, run ids) are the inputs to the others. Each item has a console link to show the user.`;

export function registerTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool("list_projects", {
    title: "List projects",
    description: "List the CostKey projects this token can read, with whether each captures prompts/responses. Use first when a tool asks for a project.",
    inputSchema: {},
    annotations: { title: "List projects", ...READ_ONLY },
  }, wrap(ctx, (context) => listProjectsTool(context)));

  server.registerTool("find_calls", {
    title: "Find LLM calls",
    description: "List LLM calls (one provider request each), newest first, filtered by time window, source file, function, feature, model, provider, environment, release, status or run. Use it for questions like \"what did src/agents/summarize.ts call in the last 5 minutes?\" or \"which calls failed with 429?\". Returns call ids (for get_call), run ids (for get_run), file:line, tokens, cost, latency and a console link per call.",
    inputSchema: {
      project: projectInput,
      since: sinceInput, from: fromInput, to: toInput,
      file: z.string().optional().describe('Source file that made the call: the recorded path or its ending, e.g. "src/agents/summarize.ts" or "summarize.py".'),
      function: z.string().optional().describe('Function name that made the call ("summarize", "Summarizer.run"), or "file:function".'),
      feature: z.string().optional().describe("Feature the call is attributed to."),
      model: z.string().optional().describe('Model, e.g. "gpt-4o-mini".'),
      provider: z.string().optional().describe('Provider, e.g. "openai", "anthropic".'),
      environment: z.string().optional().describe('Environment, e.g. "production".'),
      release: z.string().optional().describe("Release or version the app reported."),
      status: z.string().optional().describe('"failed" for failed or cancelled calls, or HTTP codes: "429", "500,503", "5xx".'),
      trace_id: z.string().optional().describe("Only calls in this run (searches the last 30 days unless since/from is given)."),
      search: z.string().optional().describe("Free text matched against ids, run name, model, feature, customer and code location."),
      sort: z.enum(["newest", "cost", "duration"]).optional().describe("newest (default), cost (most expensive first) or duration (slowest first)."),
      limit: limitInput(20, 100),
      offset: offsetInput,
    },
    annotations: { title: "Find LLM calls", ...READ_ONLY },
  }, wrap(ctx, findCallsTool));

  server.registerTool("get_call", {
    title: "Get one call",
    description: "Everything about one LLM call: model, status and error, tokens, cost and how it was priced, latency and time to first token, release, retries, the stack of your code that made it with source lines, and the prompt (system prompt plus the last messages) and response, trimmed. Says so explicitly when a body was not captured, expired or is hidden for your role. Takes a call id from find_calls, get_run or recent_errors.",
    inputSchema: {
      project: projectInput,
      call_id: z.string().describe("The call id."),
      include: z.array(z.enum(["messages", "raw", "frames", "metadata"])).optional()
        .describe('Expand: "messages" every message instead of the last 6, "raw" the raw request and response JSON, "frames" every stack frame including libraries, "metadata" the call metadata.'),
      max_chars: z.number().int().min(500).max(50_000).optional().describe("Character budget for prompt and response text (default 4000)."),
    },
    annotations: { title: "Get one call", ...READ_ONLY },
  }, wrap(ctx, getCallTool));

  server.registerTool("find_runs", {
    title: "Find runs",
    description: "List runs (traces: one execution of an agent, workflow or job, with its calls, steps and tools), newest first, with status, duration, call count and cost. failed_only=true for runs that went wrong: ended failed, a step or tool errored, or a call failed without a successful retry. Returns run ids for get_run.",
    inputSchema: {
      project: projectInput,
      since: sinceInput, from: fromInput, to: toInput,
      failed_only: z.boolean().optional().describe("Only runs that went wrong: ended failed, a step or tool errored, or a call failed and wasn't retried successfully."),
      feature: z.string().optional().describe("Feature the run is attributed to."),
      file: z.string().optional().describe("Source file that made the run's calls (path or its ending)."),
      function: z.string().optional().describe("Function that made the run's calls."),
      model: z.string().optional().describe("Runs that used this model."),
      environment: z.string().optional().describe("Environment."),
      release: z.string().optional().describe("Release."),
      search: z.string().optional().describe("Free text matched against run id, run name, model, feature and customer."),
      include_idle: z.boolean().optional().describe("Also list runs that made no model calls (hidden by default)."),
      sort: z.enum(["newest", "cost", "duration", "calls"]).optional().describe("newest (default), cost, duration or calls."),
      limit: limitInput(20, 100),
      offset: offsetInput,
    },
    annotations: { title: "Find runs", ...READ_ONLY },
  }, wrap(ctx, findRunsTool));

  server.registerTool("get_run", {
    title: "Get a run as a tree",
    description: "One run as an indented tree (agent → step → tool → call) with each node's status, duration and cost, the first failure marked, and the run's quality check results. Call ids in the tree work with get_call.",
    inputSchema: {
      project: projectInput,
      run_id: z.string().describe("The run (trace) id."),
      max_lines: z.number().int().min(10).max(1000).optional().describe("Most tree lines to return (default 150)."),
    },
    annotations: { title: "Get a run as a tree", ...READ_ONLY },
  }, wrap(ctx, getRunTool));

  server.registerTool("recent_errors", {
    title: "Recent errors",
    description: "What is failing in a time window (default 24h): failed calls grouped by model and HTTP status, failed steps and tools, failing agents and workflows, the latest failed runs with their reasons, and the latest failed calls with file:line. Each group has a sample run id for get_run.",
    inputSchema: {
      project: projectInput,
      since: sinceInput, from: fromInput, to: toInput,
      environment: z.string().optional().describe("Environment."),
      limit: limitInput(10, 50),
    },
    annotations: { title: "Recent errors", ...READ_ONLY },
  }, wrap(ctx, recentErrorsTool));

  server.registerTool("cost_breakdown", {
    title: "Cost breakdown",
    description: "Spend in a time window (default 7d) grouped by feature, function, model, provider, release or customer, each compared with the period of the same length just before. Use group_by=release to answer \"did my change make it more expensive?\" (also shows this month vs last month by release).",
    inputSchema: {
      project: projectInput,
      group_by: z.enum(["feature", "function", "model", "provider", "release", "customer"]).optional().describe("Default feature."),
      since: sinceInput, from: fromInput, to: toInput,
      environment: z.string().optional().describe("Environment."),
      feature: z.string().optional().describe("Only this feature."),
      model: z.string().optional().describe("Only this model."),
      release: z.string().optional().describe("Only this release."),
      limit: limitInput(15, 100),
      offset: offsetInput,
    },
    annotations: { title: "Cost breakdown", ...READ_ONLY },
  }, wrap(ctx, costBreakdownTool));

  server.registerTool("hot_call_sites", {
    title: "Hot call sites",
    description: "The places in your code (file:line, function) that make LLM calls, ranked by total cost, average latency or call count, with model, tokens and when each was last seen. Use find_calls with the file to drill in.",
    inputSchema: {
      project: projectInput,
      sort: z.enum(["cost", "latency", "calls"]).optional().describe("cost (default), latency or calls."),
      limit: limitInput(15, 100),
    },
    annotations: { title: "Hot call sites", ...READ_ONLY },
  }, wrap(ctx, hotCallSitesTool));
}
