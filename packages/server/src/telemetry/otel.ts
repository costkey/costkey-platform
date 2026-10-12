/**
 * OpenTelemetry bridge mapping (raw telemetry contract, detail 9).
 *
 * The SDK bridges forward every OTel span as a CostKey span of kind `custom`
 * whose `attributes.otel` holds the raw OTel attributes, next to `otelKind`,
 * `otelName` and `otelScope`. This module reads the GenAI conventions out of
 * those attributes and decides the CostKey span kind, its display name and
 * the model and provider it names.
 *
 * Conventions recognised, in priority order:
 * - OpenTelemetry GenAI semantic conventions (`gen_ai.*`)
 * - OpenInference (`openinference.span.kind`, `tool.name`, `llm.model_name`)
 * - OpenLLMetry / Traceloop (`traceloop.span.kind`, `traceloop.entity.name`)
 * - Mastra (`mastra.span.type`, `@mastra/*` scopes)
 * - Vercel AI SDK (`ai.operationId`, `ai.toolCall.name`, `ai.model.id`)
 * - Pydantic AI / Logfire (`agent_name`, `gen_ai.tool.name`, `model_name`)
 *
 * Never derives usage or cost: in-process model calls are already captured by
 * transport patching, so `gen_ai.usage.*` stays a raw attribute only.
 */

export type OtelSpanKind = "agent" | "tool" | "step" | "retrieval" | "guardrail" | "handoff" | "chain" | "custom";

export type OtelConvention = "gen_ai" | "openinference" | "traceloop" | "mastra" | "vercel_ai" | "pydantic_ai";

/** The OTel fields of a CostKey span event, wherever the SDK put them. */
export interface OtelSpanInput {
  /** Raw OTel attributes. */
  attributes: Record<string, unknown>;
  /** OTel SpanKind: a number (JS SDK) or a name (Python SDK). */
  otelKind: number | string | null;
  otelName: string | null;
  otelScope: string | null;
}

export interface OtelSpanMapping {
  kind: OtelSpanKind;
  /** The agent or tool name, falling back to the OTel span name. */
  name: string | null;
  convention: OtelConvention | null;
  /** The raw operation the kind was derived from (`chat`, `AGENT`, `ai.toolCall`, ...). */
  operation: string | null;
  agentName: string | null;
  toolName: string | null;
  /** Kept as a raw attribute only; never priced. */
  model: string | null;
  provider: string | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function first(attributes: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = text(attributes[key]);
    if (value) return value;
  }
  return null;
}

/**
 * The OTel fields of a span event, or null when it did not come from an OTel
 * bridge. Accepts the documented shape (`attributes.otel`, `attributes.otelName`)
 * and, defensively, the same fields at the top level of the event.
 */
export function otelSpanInput(event: Record<string, unknown>): OtelSpanInput | null {
  const attributes = record(event["attributes"]) ?? {};
  const pick = (key: string): unknown => attributes[key] ?? event[key];
  const raw = record(pick("otel")) ?? record(pick("otelAttributes")) ?? record(pick("otel_attributes"));
  const otelName = text(pick("otelName") ?? pick("otel_name"));
  const scopeValue = pick("otelScope") ?? pick("otel_scope") ?? pick("otelScopeName") ?? pick("otel_scope_name");
  const otelScope = text(scopeValue) ?? text(record(scopeValue)?.["name"]);
  const kindValue = pick("otelKind") ?? pick("otel_kind");
  const otelKind = typeof kindValue === "number" && Number.isFinite(kindValue) ? kindValue : text(kindValue);
  if (!raw && !otelName && !otelScope && otelKind === null) return null;
  return { attributes: raw ?? {}, otelKind, otelName, otelScope };
}

// ── Kind tables ──

const GEN_AI_OPERATIONS: Record<string, OtelSpanKind> = {
  chat: "step",
  text_completion: "step",
  generate_content: "step",
  embeddings: "step",
  execute_tool: "tool",
  invoke_agent: "agent",
  create_agent: "agent",
  invoke_workflow: "chain",
};

const OPENINFERENCE_KINDS: Record<string, OtelSpanKind> = {
  AGENT: "agent",
  TOOL: "tool",
  CHAIN: "chain",
  LLM: "step",
  RETRIEVER: "retrieval",
  EMBEDDING: "step",
  RERANKER: "retrieval",
  GUARDRAIL: "guardrail",
  EVALUATOR: "custom",
  PROMPT: "step",
  UNKNOWN: "custom",
};

const TRACELOOP_KINDS: Record<string, OtelSpanKind> = {
  workflow: "chain",
  task: "step",
  agent: "agent",
  tool: "tool",
  unknown: "custom",
};

const MASTRA_TYPES: Record<string, OtelSpanKind> = {
  agent_run: "agent",
  tool_call: "tool",
  mcp_tool_call: "tool",
  workflow_run: "chain",
  llm_generation: "step",
  llm_step: "step",
  llm_chunk: "step",
  model_generation: "step",
  model_step: "step",
  model_chunk: "step",
  generic: "custom",
};

/** A name-based guess for an operation no table lists (`execute_event_loop_cycle`, `call_llm`, ...). */
function kindFromWords(operation: string): OtelSpanKind | null {
  const value = operation.toLowerCase();
  if (value.includes("handoff")) return "handoff";
  if (value.includes("guardrail")) return "guardrail";
  if (value.includes("tool")) return "tool";
  if (value.includes("agent")) return "agent";
  if (value.includes("retriev") || value.includes("rerank")) return "retrieval";
  if (value.includes("workflow") || value.includes("chain")) return "chain";
  if (/(^|[^a-z])(llm|chat|completion|generate|embed|step|cycle)/.test(value)) return "step";
  return null;
}

function vercelKind(operationId: string): OtelSpanKind {
  if (operationId === "ai.toolCall" || operationId.endsWith(".toolCall")) return "tool";
  if (/\.do(Generate|Stream|Embed)$/.test(operationId)) return "step";
  // ai.generateText, ai.streamText, ai.generateObject, ai.embedMany: an orchestration of steps.
  return "chain";
}

function isMastraScope(scope: string | null): boolean {
  return !!scope && (scope.startsWith("@mastra/") || scope.toLowerCase().startsWith("mastra"));
}

const MODEL_KEYS = [
  "gen_ai.response.model",
  "gen_ai.request.model",
  "llm.model_name",
  "ai.response.model",
  "ai.model.id",
  "model_name",
] as const;

const PROVIDER_KEYS = [
  "gen_ai.provider.name",
  "gen_ai.system",
  "llm.provider",
  "llm.system",
  "ai.model.provider",
] as const;

const AGENT_NAME_KEYS = ["gen_ai.agent.name", "agent_name", "agent.name", "mastra.agent.name"] as const;
const TOOL_NAME_KEYS = ["gen_ai.tool.name", "tool.name", "ai.toolCall.name", "tool_name", "mastra.tool.name"] as const;

interface KindDecision {
  kind: OtelSpanKind;
  convention: OtelConvention | null;
  operation: string | null;
}

function decideKind(input: OtelSpanInput): KindDecision {
  const a = input.attributes;
  const operation = text(a["gen_ai.operation.name"]);
  if (operation) {
    const kind = GEN_AI_OPERATIONS[operation.toLowerCase()] ?? kindFromWords(operation) ?? "custom";
    return { kind, convention: "gen_ai", operation };
  }
  const openInference = text(a["openinference.span.kind"]);
  if (openInference) {
    return { kind: OPENINFERENCE_KINDS[openInference.toUpperCase()] ?? "custom", convention: "openinference", operation: openInference };
  }
  const traceloop = text(a["traceloop.span.kind"]);
  if (traceloop) {
    return { kind: TRACELOOP_KINDS[traceloop.toLowerCase()] ?? "custom", convention: "traceloop", operation: traceloop };
  }
  const mastra = text(a["mastra.span.type"]);
  if (mastra) {
    const type = mastra.toLowerCase();
    const kind = MASTRA_TYPES[type] ?? (type.startsWith("workflow_") ? "step" : kindFromWords(type)) ?? "custom";
    return { kind, convention: "mastra", operation: mastra };
  }
  const vercel = text(a["ai.operationId"]);
  if (vercel) return { kind: vercelKind(vercel), convention: "vercel_ai", operation: vercel };
  // Traceloop LLM spans carry `llm.request.type` (chat, completion, embedding) and no span kind.
  const llmRequestType = text(a["llm.request.type"]);
  if (llmRequestType) return { kind: "step", convention: "traceloop", operation: llmRequestType };
  // Older Pydantic AI and Logfire spans: `agent run` with agent_name, `running tool` with gen_ai.tool.name.
  if (first(a, TOOL_NAME_KEYS)) return { kind: "tool", convention: a["tool.name"] !== undefined ? "openinference" : "pydantic_ai", operation: null };
  if (first(a, AGENT_NAME_KEYS)) return { kind: "agent", convention: "pydantic_ai", operation: null };
  if (isMastraScope(input.otelScope) && input.otelName) {
    const kind = kindFromWords(input.otelName);
    if (kind) return { kind, convention: "mastra", operation: null };
  }
  if (first(a, MODEL_KEYS) && (first(a, PROVIDER_KEYS) || Object.keys(a).some((key) => key.startsWith("gen_ai.")))) {
    return { kind: "step", convention: "gen_ai", operation: null };
  }
  return { kind: "custom", convention: null, operation: null };
}

/** Map an OTel span to a CostKey span kind, display name, model and provider. */
export function mapOtelSpan(input: OtelSpanInput): OtelSpanMapping {
  const a = input.attributes;
  const { kind, convention, operation } = decideKind(input);
  const agentName = first(a, AGENT_NAME_KEYS)
    ?? (kind === "agent" ? first(a, ["traceloop.entity.name", "componentName"]) : null);
  const toolName = first(a, TOOL_NAME_KEYS)
    ?? (kind === "tool" ? first(a, ["traceloop.entity.name", "componentName"]) : null);
  let name: string | null;
  if (kind === "agent") name = agentName;
  else if (kind === "tool") name = toolName;
  else if (kind === "chain" && convention === "vercel_ai") name = first(a, ["ai.telemetry.functionId", "resource.name"]);
  else if (convention === "traceloop") name = first(a, ["traceloop.entity.name"]);
  else name = null;
  return {
    kind,
    name: name ?? input.otelName,
    convention,
    operation,
    agentName,
    toolName,
    model: first(a, MODEL_KEYS),
    provider: first(a, PROVIDER_KEYS),
  };
}

// ── Storage ──

/** Keys the mapping reads; they survive the size cap first. */
const PRIORITY_KEYS = new Set<string>([
  "gen_ai.operation.name", "openinference.span.kind", "traceloop.span.kind", "traceloop.entity.name",
  "mastra.span.type", "ai.operationId", "ai.telemetry.functionId", "llm.request.type",
  ...MODEL_KEYS, ...PROVIDER_KEYS, ...AGENT_NAME_KEYS, ...TOOL_NAME_KEYS,
]);

/**
 * The raw OTel attributes, mapping and usage keys first, then the rest in
 * order. Kept whole (prompts and completions included) unless a caller asks
 * for a byte limit.
 */
export function capOtelAttributes(attributes: Record<string, unknown>, maxBytes = Number.POSITIVE_INFINITY): Record<string, unknown> {
  const keys = Object.keys(attributes);
  const rank = (key: string): number => PRIORITY_KEYS.has(key) ? 0 : key.startsWith("gen_ai.usage.") || key.startsWith("llm.token_count.") ? 1 : 2;
  const ordered = keys.map((key, index) => ({ key, index })).sort((x, y) => rank(x.key) - rank(y.key) || x.index - y.index);
  const result: Record<string, unknown> = {};
  let size = 2;
  for (const { key } of ordered) {
    const encoded = JSON.stringify(attributes[key] ?? null);
    if (encoded === undefined) continue;
    const length = JSON.stringify(key).length + encoded.length + 2;
    if (size + length > maxBytes) continue;
    result[key] = attributes[key];
    size += length;
  }
  return result;
}

/**
 * The span attributes to store for an OTel span: the mapped fields first (so
 * they survive the span attribute cap), then the capped raw attributes, then
 * whatever else the SDK sent.
 */
export function otelSpanAttributes(
  sent: Record<string, unknown>,
  input: OtelSpanInput,
  mapping: OtelSpanMapping,
): Record<string, unknown> {
  const mapped: Record<string, unknown> = {};
  if (mapping.convention) mapped["otelConvention"] = mapping.convention;
  if (mapping.operation) mapped["otelOperation"] = mapping.operation;
  if (mapping.agentName) mapped["agentName"] = mapping.agentName;
  if (mapping.toolName) mapped["toolName"] = mapping.toolName;
  if (mapping.model) mapped["model"] = mapping.model;
  if (mapping.provider) mapped["provider"] = mapping.provider;
  if (input.otelName) mapped["otelName"] = input.otelName;
  if (input.otelKind !== null) mapped["otelKind"] = input.otelKind;
  if (input.otelScope) mapped["otelScope"] = input.otelScope;
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(sent)) {
    if (key in mapped || key === "otel" || key === "otelAttributes" || key === "otel_attributes") continue;
    rest[key] = value;
  }
  return {
    ...mapped,
    ...(Object.keys(input.attributes).length > 0 ? { otel: capOtelAttributes(input.attributes) } : {}),
    ...rest,
  };
}

// ── Privacy ──

const CONTENT_WORDS = new Set([
  "input", "inputs", "output", "outputs", "prompt", "prompts", "completion", "completions",
  "message", "messages", "content", "contents", "arguments", "args", "result", "results",
  "response", "text", "instructions", "query", "object", "value", "document", "documents",
  "toolcalls", "choice", "choices", "events", "parts", "values", "embedding", "embeddings", "reasoning",
]);

/**
 * True for an OTel attribute that holds content: its last non-numeric key
 * segment names content (`gen_ai.prompt.0.content`, `input.value`,
 * `ai.toolCall.args`, `tool_response`) and its value is not a number or flag
 * (`gen_ai.usage.input_tokens` and `llm.token_count.prompt` stay).
 */
export function isOtelContentAttribute(key: string, value: unknown): boolean {
  if (typeof value === "number" || typeof value === "boolean" || value === null || value === undefined) return false;
  const segments = key.split(".").filter((segment) => segment && !/^\d+$/.test(segment));
  const leaf = segments[segments.length - 1];
  if (!leaf) return false;
  return leaf.toLowerCase().split(/[_-]/).some((word) => CONTENT_WORDS.has(word));
}

/** Metadata-only projects: drop content-bearing raw OTel attributes in place. */
export function stripOtelContent(attributes: Record<string, unknown>): void {
  for (const field of ["otel", "otelAttributes", "otel_attributes"]) {
    const raw = record(attributes[field]);
    if (!raw) continue;
    for (const key of Object.keys(raw)) {
      if (isOtelContentAttribute(key, raw[key])) delete raw[key];
    }
  }
}
