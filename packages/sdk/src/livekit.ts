import type { EventContext, RecordUsageEvent, UsageAmount, UsageUnits } from "./types.js";

/** Structural subset of LiveKit Agents' cumulative model-usage rows. */
export interface LiveKitModelUsage {
  type?: string;
  provider?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  inputCachedTokens?: number;
  inputCacheCreationTokens?: number;
  inputCachedAudioTokens?: number;
  inputCachedTextTokens?: number;
  inputCachedImageTokens?: number;
  inputAudioTokens?: number;
  inputTextTokens?: number;
  inputImageTokens?: number;
  outputAudioTokens?: number;
  outputTextTokens?: number;
  sessionDurationMs?: number;
  audioDurationMs?: number;
  charactersCount?: number;
  amount?: UsageAmount | number | null;
  cost?: UsageAmount | number | null;
  costUsd?: number | null;
  currency?: string;
  [key: string]: unknown;
}

export type LiveKitUsageComponent = "interruption" | "llm" | "stt" | "tts";

/** Structural subset of the documented `session_usage_updated` event. */
export interface LiveKitSessionUsageUpdatedEvent {
  type?: "session_usage_updated" | string;
  createdAt?: number | string;
  created_at?: number | string;
  usage?: {
    modelUsage?: readonly LiveKitModelUsage[];
    model_usage?: readonly LiveKitModelUsage[];
  };
  modelUsage?: readonly LiveKitModelUsage[];
  model_usage?: readonly LiveKitModelUsage[];
}

export interface LiveKitUsageOptions {
  sessionId: string;
  revision: number;
  conversationId?: string;
  traceId?: string;
  executionId?: string;
  groupName?: string;
  groupKind?: string;
  phase?: string;
  eventPrefix?: string;
  expectedComponents?: readonly string[];
  /** Explicitly select the session components that own the charge. */
  components?: readonly LiveKitUsageComponent[];
  /** Exclude components whose charge is supplied by another integration. */
  excludeComponents?: readonly LiveKitUsageComponent[];
}

/**
 * Convert one LiveKit cumulative session snapshot into one CostKey usage event
 * per deterministic provider/model component. This is an explicit callback
 * adapter: it does not intercept WebRTC/audio traffic or infer an invoice
 * amount.
 */
export async function recordLiveKitUsage(
  update: LiveKitSessionUsageUpdatedEvent,
  options: LiveKitUsageOptions,
): Promise<string[]> {
  const sessionId = nonEmpty(options?.sessionId);
  if (!sessionId) throw new TypeError("recordLiveKitUsage requires sessionId");
  if (!Number.isSafeInteger(options.revision) || options.revision < 0) {
    throw new RangeError("recordLiveKitUsage requires a non-negative revision");
  }

  const selection = normalizeComponentSelection(options);
  const rows = modelUsageRows(update).filter((row) => selection.allows(classifyComponent(row)));
  const groupedRows = aggregateModelUsageRows(rows);
  const expected = normalizeExpectedComponents(options.expectedComponents, selection);
  const observed = new Set<LiveKitUsageComponent>(groupedRows.map((group) => group.component));
  const coverage = expected.size > 0 || selection.selected !== null || selection.excluded.size > 0
    ? {
        expectedComponents: [...expected].sort(),
        observedComponents: [...observed].sort(),
        missingComponents: [...expected].filter((name) => !observed.has(name)).sort(),
        ...(selection.selected
          ? { selectedComponents: [...selection.selected].sort() }
          : {}),
        ...(selection.excluded.size > 0
          ? { excludedComponents: [...selection.excluded].sort() }
          : {}),
      }
    : undefined;
  const records: RecordUsageEvent[] = [];
  const prefix = nonEmpty(options.eventPrefix) ?? `livekit:${sessionId}`;

  for (const { row, component, provider, model } of groupedRows) {
    const componentId = `${prefix}:${component}:${provider}:${model ?? "unknown"}`;
    const billing = modelUsageBilling(row, component);
    const context: EventContext = {
      voiceSessionId: sessionId,
      ...(options.conversationId ? { conversationId: options.conversationId } : {}),
      ...(options.traceId ? { traceId: options.traceId } : {}),
      ...(options.executionId ? { executionId: options.executionId } : {}),
      ...(options.groupName ? { groupName: options.groupName } : {}),
      ...(options.groupKind ? { groupKind: options.groupKind } : {}),
      ...(options.phase ? { phase: options.phase } : {}),
    };
    const metadata = {
      livekit: {
        type: row.type ?? null,
        sessionId,
        revision: options.revision,
        ...(coverage ? { voiceCoverage: coverage } : {}),
      },
    };
    records.push({
      id: `${componentId}:r${options.revision}`,
      componentId,
      chargeId: componentId,
      provider,
      model,
      usage: modelUsageUnits(row),
      ...(billing.billingUnits ? { billingUnits: billing.billingUnits } : {}),
      ...(billing.unitKind ? { unitKind: billing.unitKind } : {}),
      ...(billing.unitValue === undefined ? {} : { unitValue: billing.unitValue }),
      ...(billing.unitKind ? { unit: billing.unitKind } : {}),
      ...modelUsageAmount(row),
      aggregation: "cumulative",
      revision: options.revision,
      context,
      timestamp: liveKitTimestamp(update),
      metadata,
    });
  }

  // Resolve the facade only when the adapter is called. A static import would
  // create an ESM cycle (`index -> livekit -> index`) and break packed-package
  // imports before the exported CostKey object is initialized.
  const { CostKey } = await import("./index.js");
  await Promise.all(records.map((record) => CostKey.recordUsage(record)));
  return records.map((record) => record.id);
}

export const recordLiveKitSessionUsage = recordLiveKitUsage;

function modelUsageRows(update: LiveKitSessionUsageUpdatedEvent): LiveKitModelUsage[] {
  const nested = update?.usage?.modelUsage ?? update?.usage?.model_usage;
  const rows = nested ?? update?.modelUsage ?? update?.model_usage;
  return Array.isArray(rows)
    ? rows.filter((row): row is LiveKitModelUsage => !!row && typeof row === "object")
    : [];
}

interface LiveKitUsageGroup {
  component: LiveKitUsageComponent;
  provider: string;
  model: string | undefined;
  row: LiveKitModelUsage;
}

interface ComponentSelection {
  selected: Set<LiveKitUsageComponent> | null;
  excluded: Set<LiveKitUsageComponent>;
  allows(component: LiveKitUsageComponent): boolean;
}

function normalizeComponentSelection(options: LiveKitUsageOptions): ComponentSelection {
  const hasComponents = options.components !== undefined;
  const hasExcluded = options.excludeComponents !== undefined;
  if (hasComponents && hasExcluded) {
    throw new TypeError("recordLiveKitUsage accepts components or excludeComponents, not both");
  }
  const selected = hasComponents
    ? normalizeComponentSet(options.components, "components")
    : null;
  const excluded = hasExcluded
    ? normalizeComponentSet(options.excludeComponents, "excludeComponents")
    : new Set<LiveKitUsageComponent>();
  return {
    selected,
    excluded,
    allows(component): boolean {
      return (selected === null || selected.has(component)) && !excluded.has(component);
    },
  };
}

function normalizeExpectedComponents(
  values: readonly string[] | undefined,
  selection: ComponentSelection,
): Set<LiveKitUsageComponent> {
  const expected = normalizeComponentSet(values ?? [], "expectedComponents");
  if (selection.selected) {
    for (const component of expected) {
      if (!selection.selected.has(component)) expected.delete(component);
    }
  }
  for (const component of selection.excluded) expected.delete(component);
  return expected;
}

function normalizeComponentSet(
  values: readonly unknown[] | undefined,
  label: string,
): Set<LiveKitUsageComponent> {
  const result = new Set<LiveKitUsageComponent>();
  for (const value of values ?? []) {
    const component = normalizeComponentName(value);
    if (!component) throw new TypeError(`recordLiveKitUsage ${label} contains an unknown component`);
    result.add(component);
  }
  return result;
}

function normalizeComponentName(value: unknown): LiveKitUsageComponent | undefined {
  const normalized = typeof value === "string"
    ? value.trim().toLowerCase().replace(/[-\s]/g, "_")
    : "";
  if (["interruption", "eot"].includes(normalized)) return "interruption";
  if (["llm", "llm_usage", "language_model"].includes(normalized)) return "llm";
  if (["stt", "stt_usage", "speech_to_text"].includes(normalized)) return "stt";
  if (["tts", "tts_usage", "text_to_speech"].includes(normalized)) return "tts";
  return undefined;
}

function aggregateModelUsageRows(rows: LiveKitModelUsage[]): LiveKitUsageGroup[] {
  const groups = new Map<string, {
    component: LiveKitUsageComponent;
    provider: string;
    model: string | undefined;
    rows: LiveKitModelUsage[];
  }>();
  for (const row of rows) {
    const component = classifyComponent(row);
    const provider = nonEmpty(row.provider) ?? "livekit";
    const model = nonEmpty(row.model);
    const key = JSON.stringify([component, provider, model ?? ""]);
    const existing = groups.get(key);
    if (existing) existing.rows.push(row);
    else groups.set(key, { component, provider, model, rows: [row] });
  }

  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, group]) => ({
      component: group.component,
      provider: group.provider,
      model: group.model,
      row: mergeModelUsageRows(group.rows, group.provider, group.model),
    }));
}

function mergeModelUsageRows(
  rows: LiveKitModelUsage[],
  provider: string,
  model: string | undefined,
): LiveKitModelUsage {
  const type = rows
    .map((row) => nonEmpty(row.type))
    .filter((value): value is string => value !== undefined)
    .sort()[0];
  const merged: LiveKitModelUsage = {
    ...(type ? { type } : {}),
    provider,
    ...(model ? { model } : {}),
  };
  const numericKeys = new Set<string>();
  for (const row of rows) {
    for (const [key, value] of Object.entries(row)) {
      if (IDENTITY_KEYS.has(key) || typeof value !== "number" || !Number.isFinite(value) || value < 0) continue;
      numericKeys.add(key);
    }
  }
  for (const key of [...numericKeys].sort()) {
    const values = rows
      .map((row) => row[key])
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0);
    if (values.length > 0) merged[key] = values.reduce((sum, value) => sum + value, 0);
  }
  const amount = aggregateAmount(rows);
  if (amount) merged.amount = amount;
  return merged;
}

function aggregateAmount(rows: LiveKitModelUsage[]): UsageAmount | undefined {
  const values = rows.map((row) => {
    const candidate = row.amount ?? row.cost ?? row.costUsd;
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0) {
      return { value: candidate, currency: nonEmpty(row.currency) ?? "USD" };
    }
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      const object = candidate as unknown as Record<string, unknown>;
      const value = object["value"] ?? object["amount"];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
        return { value, currency: nonEmpty(object["currency"]) ?? nonEmpty(row.currency) ?? "USD" };
      }
    }
    return undefined;
  });
  if (values.some((value) => value === undefined)) return undefined;
  const first = values[0];
  if (!first || values.some((value) => value!.currency.toUpperCase() !== first.currency.toUpperCase())) return undefined;
  return {
    value: values.reduce((sum, value) => sum + value!.value, 0),
    currency: first.currency,
  };
}

function classifyComponent(row: LiveKitModelUsage): LiveKitUsageComponent {
  const type = String(row.type ?? "").toLowerCase();
  if (type.includes("interruption") || type.includes("eot")) return "interruption";
  if (type.includes("tts") || row.charactersCount !== undefined || row["characters_count"] !== undefined) return "tts";
  if (type.includes("stt") || row.audioDurationMs !== undefined || row["audio_duration_ms"] !== undefined) return "stt";
  return "llm";
}

function modelUsageUnits(row: LiveKitModelUsage): UsageUnits | null {
  const units: UsageUnits = {};
  for (const [key, value] of Object.entries(row)) {
    if (IDENTITY_KEYS.has(key) || typeof value !== "number" || !Number.isFinite(value) || value < 0) continue;
    if (key === "audioDurationMs" || key === "audio_duration_ms") {
      units.audioSeconds = value / 1_000;
    } else if (key === "sessionDurationMs" || key === "session_duration_ms") {
      units.sessionSeconds = value / 1_000;
    } else if (key === "charactersCount" || key === "characters_count") {
      units.characters = value;
    } else {
      units[key] = value;
    }
  }
  return Object.keys(units).length > 0 ? units : null;
}

interface ModelUsageBilling {
  billingUnits?: UsageUnits;
  unitKind?: string;
  unitValue?: number;
}

function modelUsageBilling(row: LiveKitModelUsage, component: LiveKitUsageComponent): ModelUsageBilling {
  const usage = modelUsageUnits(row);
  if (!usage) return {};
  const billingUnits: UsageUnits = {};
  for (const [key, value] of Object.entries(usage)) {
    if (value === null || typeof value !== "number") continue;
    const nativeUnit = billingUnitName(key);
    if (nativeUnit === "total_tokens"
      && (billingUnits.input_tokens !== undefined || billingUnits.output_tokens !== undefined)) continue;
    billingUnits[nativeUnit] = value;
  }
  const billableUnitCount = Object.values(billingUnits)
    .filter((value): value is number => typeof value === "number")
    .length;
  // LLM snapshots commonly contain both input and output token totals. Do not
  // advertise one as the whole charge; the billingUnits map is authoritative
  // for multi-unit rows and lets the server price each compatible unit.
  const preferred = component === "llm" && billableUnitCount > 1
    ? undefined
    : billingUnitPreference(component)
      .map((unit) => [unit, billingUnits[unit]] as const)
      .find(([, value]) => typeof value === "number");
  const unitKind = preferred?.[0];
  return {
    billingUnits: Object.keys(billingUnits).length > 0 ? billingUnits : undefined,
    ...(unitKind ? { unitKind, unitValue: preferred?.[1] ?? undefined } : {}),
  };
}

function billingUnitPreference(component: LiveKitUsageComponent): string[] {
  switch (component) {
    case "tts":
      return ["characters", "audio_seconds", "output_tokens", "input_tokens", "total_tokens"];
    case "stt":
      return ["audio_seconds", "output_tokens", "input_tokens", "total_tokens"];
    case "llm":
      return ["session_seconds", "total_tokens", "input_tokens", "output_tokens"];
    case "interruption":
      return ["requests"];
  }
}

function billingUnitName(key: string): string {
  const aliases: Record<string, string> = {
    inputCachedTokens: "cache_read_tokens",
    inputCacheCreationTokens: "cache_creation_tokens",
    input_cached_tokens: "cache_read_tokens",
    input_cache_creation_tokens: "cache_creation_tokens",
    audioSeconds: "audio_seconds",
    audio_duration_ms: "audio_seconds",
    sessionSeconds: "session_seconds",
    session_duration_ms: "session_seconds",
    characters: "characters",
    charactersCount: "characters",
    characters_count: "characters",
    numRequests: "requests",
    totalRequests: "requests",
  };
  if (aliases[key]) return aliases[key];
  return key.replace(/[A-Z]/g, (character) => `_${character.toLowerCase()}`);
}

function modelUsageAmount(row: LiveKitModelUsage): {
  amount?: UsageAmount | number | null;
  costUsd?: number | null;
  currency?: string;
} {
  const candidate = row.amount ?? row.cost ?? row.costUsd ?? row["cost_usd"];
  if (candidate == null) return {};
  if (typeof candidate === "number") {
    return { amount: { value: candidate, currency: nonEmpty(row.currency) ?? "USD" } };
  }
  if (typeof candidate === "object" && !Array.isArray(candidate)) {
    const amount = candidate as unknown as Record<string, unknown>;
    const value = amount["value"] ?? amount["amount"];
    const currency = nonEmpty(amount["currency"]) ?? nonEmpty(row.currency) ?? "USD";
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return { amount: { value, currency } };
    }
  }
  return {};
}

function liveKitTimestamp(update: LiveKitSessionUsageUpdatedEvent): string | undefined {
  const createdAt = update?.createdAt ?? update?.created_at;
  if (typeof createdAt === "string") {
    const parsed = new Date(createdAt);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
  }
  if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) return undefined;
  const milliseconds = createdAt > 100_000_000_000 ? createdAt : createdAt * 1_000;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

const IDENTITY_KEYS = new Set([
  "type",
  "provider",
  "model",
  "amount",
  "cost",
  "costUsd",
  "currency",
]);
