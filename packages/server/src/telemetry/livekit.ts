/**
 * LiveKit session usage, processed on the server. The SDK sends the raw
 * `session_usage_updated` model-usage rows (as a skeleton: identity strings
 * such as type/provider/model/currency are allowlisted) with the session id
 * and snapshot revision; the server classifies each row as an STT, LLM, TTS
 * or interruption component, sums rows of one component/provider/model,
 * converts units and emits one cumulative usage event per component, exactly
 * as `recordLiveKitUsage` did in SDK 0.6.
 *
 * Wire shape (any event type; recognized by `telemetry.source`):
 *
 *   { id, timestamp, context?, telemetry: { v: 1, source: "livekit", livekit: {
 *       sessionId, revision, update | rows, createdAt?, eventPrefix?,
 *       components? | excludeComponents?, expectedComponents?,
 *       conversationId?, traceId?, executionId?, groupName?, groupKind?, phase?,
 *       datasetRevision?, caseId?, declaredAmounts?, declaredPricingIds?, declaredBillingUnits? } } }
 */
import { InvalidAccountingEventError } from "../accounting.js";
import { asObject, asRecord, items, nonEmpty, str, type Rec } from "./skeleton.js";

export type LiveKitComponent = "interruption" | "llm" | "stt" | "tts";

/** A LiveKit payload the server can't expand; only that event is rejected. */
export class LiveKitPayloadError extends InvalidAccountingEventError {}

const IDENTITY_KEYS = new Set(["type", "provider", "model", "amount", "cost", "costUsd", "cost_usd", "currency"]);
const ROW_ID_KEYS = new Set([
  "id", "usage_id", "usageId", "component_id", "componentId", "request_id", "requestId",
  "provider_request_id", "providerRequestId", "providerName", "provider_name", "modelName", "model_name",
]);

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

export function isLiveKitTelemetry(event: Rec): boolean {
  const telemetry = asRecord(event["telemetry"]);
  return !!telemetry && telemetry["source"] === "livekit";
}

function normalizeComponentName(value: unknown): LiveKitComponent | undefined {
  const normalized = typeof value === "string" ? value.trim().toLowerCase().replace(/[-\s]/g, "_") : "";
  if (["interruption", "eot"].includes(normalized)) return "interruption";
  if (["llm", "llm_usage", "language_model"].includes(normalized)) return "llm";
  if (["stt", "stt_usage", "speech_to_text"].includes(normalized)) return "stt";
  if (["tts", "tts_usage", "text_to_speech"].includes(normalized)) return "tts";
  return undefined;
}

function componentSet(values: unknown, label: string): Set<LiveKitComponent> {
  const result = new Set<LiveKitComponent>();
  const list = typeof values === "string" ? [values] : items(values) ?? [];
  for (const value of list) {
    const component = normalizeComponentName(value);
    if (!component) throw new LiveKitPayloadError(`livekit ${label} contains an unknown component`);
    result.add(component);
  }
  return result;
}

/**
 * The row's component. LiveKit rows carry a `type` (llm_usage, stt_usage,
 * tts_usage, interruption_usage); without one, fields decide: characters
 * mean TTS, an audio duration with output audio tokens TTS, an audio
 * duration or input audio tokens STT, anything else an LLM.
 */
export function classifyRow(row: Rec): LiveKitComponent {
  const type = String(str(row["type"]) ?? "").toLowerCase();
  if (type.includes("interruption") || type.includes("eot")) return "interruption";
  if (type.includes("tts")) return "tts";
  if (type.includes("stt")) return "stt";
  if (type.includes("llm")) return "llm";
  const has = (...keys: string[]) => keys.some((key) => row[key] !== undefined);
  if (has("charactersCount", "characters_count")) return "tts";
  const audio = has("audioDurationMs", "audio_duration_ms", "audioDuration", "audio_duration");
  if (audio && has("outputAudioTokens", "output_audio_tokens")) return "tts";
  if (audio) return "stt";
  return "llm";
}

/**
 * Rows with an explicit component: `{components: {stt, llm, tts}}` maps
 * (Python 0.6), else the model-usage list (`usage.modelUsage`,
 * `usage.model_usage`, `modelUsage`, `model_usage`, or `rows`).
 */
function rowsOf(livekit: Rec): Array<{ component: LiveKitComponent; row: Rec }> {
  const update = asObject(livekit["update"]) ?? {};
  // `livekit.components` as an array is the component selection, not rows.
  const mapping = asObject(update["components"]) ?? (Array.isArray(livekit["components"]) ? null : asObject(livekit["components"]));
  if (mapping) {
    const found: Array<{ component: LiveKitComponent; row: Rec }> = [];
    for (const [key, value] of Object.entries(mapping)) {
      const component = normalizeComponentName(key) ?? normalizeComponentName(key.replace(/Usage$/, ""));
      if (!component) continue;
      for (const row of Array.isArray(value) ? items(value) ?? [] : [value]) {
        const record = asObject(row);
        if (record) found.push({ component, row: record });
      }
    }
    if (found.length > 0) return found;
  }
  const usage = asObject(update["usage"]);
  const list = items(livekit["rows"])
    ?? items(usage?.["modelUsage"]) ?? items(usage?.["model_usage"])
    ?? items(update["modelUsage"]) ?? items(update["model_usage"]) ?? [];
  return list
    .map((row) => asObject(row))
    .filter((row): row is Rec => row !== null)
    .map((row) => ({ component: classifyRow(row), row }));
}

/** Native units in CostKey's names: durations to seconds (ms keys divided), characters. */
export function rowUnits(row: Rec): Record<string, number> | null {
  const units: Record<string, number> = {};
  for (const [key, value] of Object.entries(row)) {
    if (IDENTITY_KEYS.has(key) || ROW_ID_KEYS.has(key) || !finite(value)) continue;
    if (key === "audioDurationMs" || key === "audio_duration_ms") units["audioSeconds"] = value / 1_000;
    else if (key === "audioDuration" || key === "audio_duration") units["audioSeconds"] = value;
    else if (key === "sessionDurationMs" || key === "session_duration_ms") units["sessionSeconds"] = value / 1_000;
    else if (key === "sessionDuration" || key === "session_duration") units["sessionSeconds"] = value;
    else if (key === "charactersCount" || key === "characters_count") units["characters"] = value;
    else units[key] = value;
  }
  return Object.keys(units).length > 0 ? units : null;
}

const BILLING_ALIASES: Record<string, string> = {
  inputCachedTokens: "cache_read_tokens",
  inputCacheCreationTokens: "cache_creation_tokens",
  input_cached_tokens: "cache_read_tokens",
  input_cache_creation_tokens: "cache_creation_tokens",
  audioSeconds: "audio_seconds",
  sessionSeconds: "session_seconds",
  characters: "characters",
  numRequests: "requests",
  totalRequests: "requests",
  total_requests: "requests",
};

function billingUnitName(key: string): string {
  return BILLING_ALIASES[key] ?? key.replace(/[A-Z]/g, (character) => `_${character.toLowerCase()}`);
}

function billingPreference(component: LiveKitComponent): string[] {
  switch (component) {
    case "tts": return ["characters", "audio_seconds", "output_tokens", "input_tokens", "total_tokens"];
    case "stt": return ["audio_seconds", "output_tokens", "input_tokens", "total_tokens"];
    case "llm": return ["session_seconds", "total_tokens", "input_tokens", "output_tokens"];
    case "interruption": return ["requests"];
  }
}

function unitFamily(unit: string): "tokens" | "time" | "other" {
  const lower = unit.toLowerCase();
  if (lower.includes("token")) return "tokens";
  if (/(second|minute|hour|duration)/.test(lower)) return "time";
  return "other";
}

/**
 * The billing-vocabulary unit map and, when one unit is the whole charge, its
 * kind and value. LLM rows with several units have no single unit kind; the
 * map is authoritative. Rows mixing unit families (tokens plus seconds) are
 * not a billable selection: the map is withheld and the component flagged.
 */
function rowBilling(units: Record<string, number> | null, component: LiveKitComponent): {
  billingUnits?: Record<string, number>; unitKind?: string; unitValue?: number; selectionRequired?: boolean;
} {
  if (!units) return {};
  const billingUnits: Record<string, number> = {};
  for (const [key, value] of Object.entries(units)) {
    const unit = billingUnitName(key);
    if (unit === "total_tokens" && (billingUnits["input_tokens"] !== undefined || billingUnits["output_tokens"] !== undefined)) continue;
    billingUnits[unit] = value;
  }
  if (billingUnits["input_tokens"] !== undefined || billingUnits["output_tokens"] !== undefined) delete billingUnits["total_tokens"];
  const count = Object.keys(billingUnits).length;
  const preferred = component === "llm" && count > 1
    ? undefined
    : billingPreference(component).map((unit) => [unit, billingUnits[unit]] as const).find(([, value]) => typeof value === "number");
  if (new Set(Object.keys(billingUnits).map(unitFamily)).size > 1 && !preferred) {
    return { selectionRequired: true };
  }
  return {
    ...(count > 0 ? { billingUnits } : {}),
    ...(preferred ? { unitKind: preferred[0], unitValue: preferred[1] } : {}),
  };
}

/** A row's amount (`amount`, `cost`, `costUsd`, as a number or `{value, currency}`). */
function rowAmount(row: Rec): { value: number; currency: string } | undefined {
  const candidate = row["amount"] ?? row["cost"] ?? row["costUsd"] ?? row["cost_usd"];
  const currency = (value: unknown): string => nonEmpty(value) ?? nonEmpty(row["currency"]) ?? "USD";
  if (finite(candidate)) return { value: candidate, currency: currency(undefined) };
  const object = asObject(candidate);
  const value = object?.["value"] ?? object?.["amount"];
  if (object && finite(value)) return { value, currency: currency(object["currency"]) };
  return undefined;
}

/** Sum rows of one component/provider/model: numeric fields add, amounts add when every row has one in one currency. */
function mergeRows(rows: Rec[], provider: string, model: string | undefined): Rec {
  const type = rows.map((row) => nonEmpty(row["type"])).filter((value): value is string => !!value).sort()[0];
  const merged: Rec = { ...(type ? { type } : {}), provider, ...(model ? { model } : {}) };
  const keys = new Set<string>();
  for (const row of rows) {
    for (const [key, value] of Object.entries(row)) {
      if (!IDENTITY_KEYS.has(key) && !ROW_ID_KEYS.has(key) && finite(value)) keys.add(key);
    }
  }
  for (const key of [...keys].sort()) {
    const values = rows.map((row) => row[key]).filter(finite);
    if (values.length > 0) merged[key] = values.reduce((sum, value) => sum + value, 0);
  }
  const amounts = rows.map(rowAmount);
  const first = amounts[0];
  if (first && amounts.every((amount) => amount && amount.currency.toUpperCase() === first.currency.toUpperCase())) {
    merged["amount"] = { value: amounts.reduce((sum, amount) => sum + amount!.value, 0), currency: first.currency };
  }
  return merged;
}

function declared(map: unknown, componentId: string, component: string, provider: string, model: string | undefined): unknown {
  const record = asObject(map);
  if (!record) return undefined;
  for (const key of [componentId, `${component}:${provider}:${model ?? "unknown"}`, component]) {
    if (Object.prototype.hasOwnProperty.call(record, key)) return record[key];
  }
  return undefined;
}

function timestampOf(livekit: Rec, fallback: unknown): string | undefined {
  const update = asObject(livekit["update"]);
  const createdAt = livekit["createdAt"] ?? livekit["created_at"] ?? update?.["createdAt"] ?? update?.["created_at"];
  if (typeof createdAt === "string") {
    const parsed = new Date(createdAt);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  if (typeof createdAt === "number" && Number.isFinite(createdAt)) {
    // Python LiveKit uses epoch seconds; JS uses epoch milliseconds.
    const date = new Date(createdAt > 100_000_000_000 ? createdAt : createdAt * 1_000);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return typeof fallback === "string" ? fallback : undefined;
}

const CONTEXT_FIELDS = ["conversationId", "traceId", "executionId", "groupName", "groupKind", "phase", "datasetRevision", "caseId"];

/**
 * Expand one raw LiveKit telemetry event into the per-component cumulative
 * usage events the server stores. Throws LiveKitPayloadError for a payload
 * missing its session id or revision.
 */
export function expandLiveKitEvent(event: Rec): Rec[] {
  const telemetry = asRecord(event["telemetry"]) ?? {};
  const livekit = asObject(telemetry["livekit"]) ?? {};
  const sessionId = nonEmpty(livekit["sessionId"] ?? livekit["session_id"] ?? event["voiceSessionId"]);
  if (!sessionId) throw new LiveKitPayloadError("livekit usage requires sessionId");
  const revision = livekit["revision"] ?? event["revision"];
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) {
    throw new LiveKitPayloadError("livekit usage requires a non-negative integer revision");
  }
  if (livekit["components"] !== undefined && Array.isArray(livekit["components"]) && livekit["excludeComponents"] !== undefined) {
    throw new LiveKitPayloadError("livekit usage accepts components or excludeComponents, not both");
  }
  const selected = Array.isArray(livekit["components"]) ? componentSet(livekit["components"], "components") : null;
  const excluded = componentSet(livekit["excludeComponents"] ?? livekit["exclude_components"] ?? [], "excludeComponents");
  const allows = (component: LiveKitComponent): boolean => (selected === null || selected.has(component)) && !excluded.has(component);

  const groups = new Map<string, { component: LiveKitComponent; provider: string; model: string | undefined; rows: Rec[] }>();
  for (const { component, row } of rowsOf(livekit)) {
    if (!allows(component)) continue;
    const provider = nonEmpty(row["provider"]) ?? "livekit";
    const model = nonEmpty(row["model"]) ?? undefined;
    const key = JSON.stringify([component, provider, model ?? ""]);
    const group = groups.get(key);
    if (group) group.rows.push(row);
    else groups.set(key, { component, provider, model, rows: [row] });
  }

  const expected = componentSet(livekit["expectedComponents"] ?? livekit["expected_components"] ?? [], "expectedComponents");
  for (const component of [...expected]) if (!allows(component)) expected.delete(component);
  const observed = new Set([...groups.values()].map((group) => group.component));
  const coverage = expected.size > 0 || selected !== null || excluded.size > 0
    ? {
        expectedComponents: [...expected].sort(),
        observedComponents: [...observed].sort(),
        missingComponents: [...expected].filter((name) => !observed.has(name)).sort(),
        ...(selected ? { selectedComponents: [...selected].sort() } : {}),
        ...(excluded.size > 0 ? { excludedComponents: [...excluded].sort() } : {}),
      }
    : undefined;

  const prefix = nonEmpty(livekit["eventPrefix"] ?? livekit["event_prefix"]) ?? `livekit:${sessionId}`;
  const baseContext = asRecord(event["context"]) ?? {};
  const timestamp = timestampOf(livekit, event["timestamp"]);
  const out: Rec[] = [];
  for (const [, group] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const { component, provider, model } = group;
    const row = mergeRows(group.rows, provider, model);
    const componentId = `${prefix}:${component}:${provider}:${model ?? "unknown"}`;
    const units = rowUnits(row);
    const amount = (row["amount"] as { value: number; currency: string } | undefined)
      ?? (() => {
        const value = declared(livekit["declaredAmounts"], componentId, component, provider, model);
        return finite(value) ? { value, currency: "USD", declared: true } : undefined;
      })();
    const explicitBilling = asObject(declared(livekit["declaredBillingUnits"], componentId, component, provider, model));
    const billing = explicitBilling
      ? { billingUnits: Object.fromEntries(Object.entries(explicitBilling).filter(([, value]) => finite(value))) as Record<string, number> }
      : rowBilling(units, component);
    const pricingId = nonEmpty(declared(livekit["declaredPricingIds"], componentId, component, provider, model));
    const context: Rec = { ...baseContext, voiceSessionId: sessionId };
    for (const field of CONTEXT_FIELDS) {
      const value = nonEmpty(livekit[field]);
      if (value) context[field] = value;
    }
    if (billing.selectionRequired && !amount) {
      context["voiceBilling"] = { status: "selection_required", componentId, reason: "mixed_native_unit_families" };
    }
    out.push({
      id: `${componentId}:r${revision}`,
      timestamp,
      eventType: "usage",
      source: "explicit",
      component: componentId,
      componentId,
      chargeId: componentId,
      revision,
      aggregation: "cumulative",
      provider,
      model: model ?? null,
      usage: units,
      nativeUsage: units,
      ...(billing.billingUnits ? { billingUnits: billing.billingUnits } : {}),
      ...(billing.unitKind ? { unitKind: billing.unitKind, unit: billing.unitKind, unitValue: billing.unitValue } : {}),
      ...(amount ? { amount: { value: amount.value, currency: amount.currency }, currency: amount.currency } : { currency: "USD" }),
      ...("declared" in (amount ?? {}) ? { amountKind: "estimated" } : {}),
      ...(pricingId ? { pricingId } : {}),
      traceId: context["traceId"],
      executionId: context["executionId"],
      context,
      metadata: {
        livekit: {
          type: row["type"] ?? null,
          sessionId,
          revision,
          ...(coverage ? { voiceCoverage: coverage } : {}),
        },
      },
      url: "",
      method: "POST",
      statusCode: null,
      durationMs: 0,
      streaming: false,
      streamTiming: null,
      callSite: null,
    });
  }
  return out;
}
