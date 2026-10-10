import { createHash } from "node:crypto";
import type pg from "pg";
import { chargesCte } from "./charge-cohort.js";

/**
 * Small server-side normalizer for the additive accounting envelope.
 * Deliberately accepts unknown records so old SDK payloads remain ingestible
 * while the shared package evolves its public types.
 */
export type AccountingEvent = Record<string, unknown>;

export type EventType = "call" | "lifecycle" | "usage" | "span";
export type SpanStatus = "running" | "ok" | "error" | "cancelled";
export type LifecycleState = "started" | "completed" | "failed" | "cancelled";
export type AccountingState = "complete" | "partial" | "pending";

export function accountingLockKey(projectId: string): string {
  return `retention:${projectId}`;
}

export class AccountingConflictError extends Error {
  readonly code = "accounting_conflict";

  constructor(message: string) {
    super(message);
    this.name = "AccountingConflictError";
  }
}

export class InvalidAccountingEventError extends Error {
  readonly code: string = "invalid_accounting_event";

  constructor(message: string) {
    super(message);
    this.name = "InvalidAccountingEventError";
  }
}

/** A newer SDK sent an event kind this server does not know; only that event is skipped. */
export class UnsupportedEventTypeError extends InvalidAccountingEventError {
  override readonly code = "unsupported_event_type";
}

export interface NormalizedAccountingEvent {
  eventType: EventType;
  source: "auto" | "explicit";
  entityType: "trace" | "execution" | null;
  entityId: string | null;
  traceId: string | null;
  traceName: string | null;
  executionId: string | null;
  groupId: string | null;
  groupName: string | null;
  groupKind: string;
  lifecycle: LifecycleState | null;
  sequence: number | null;
  lifecycleAt: string;
  startedAt: string | null;
  endedAt: string | null;
  errorType: string | null;
  expectedItems: number | null;
  completedItems: number | null;
  failedItems: number | null;
  phase: string | null;
  configuration: Record<string, unknown> | null;
  datasetRevision: string | null;
  caseId: string | null;
  context: Record<string, unknown> | null;
  component: string;
  componentId: string | null;
  callerId: string | null;
  chargeId: string | null;
  provider: string;
  model: string | null;
  requestModel: string | null;
  unitKind: string | null;
  unitValue: number | null;
  unit: string | null;
  amount: number | null;
  amountPresent: boolean;
  currency: string;
  amountKind: "reported" | "estimated";
  aggregation: "delta" | "cumulative";
  revision: number | null;
  pricingId: string | null;
  usage: Record<string, number | null> | null;
  metadata: unknown;
  /** The span a call ran inside, or the span itself for span events. */
  spanId: string | null;
  parentSpanId: string | null;
  spanKind: string | null;
  spanName: string | null;
  spanStatus: SpanStatus | null;
  spanAttributes: Record<string, unknown> | null;
}

function objectValue(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function optionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const result = value.trim();
  return result.length > 0 ? result : null;
}

function optionalNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const result = typeof value === "number" ? value : Number(value);
  return Number.isFinite(result) ? result : null;
}

function optionalInteger(value: unknown): number | null {
  const result = optionalNumber(value);
  return result !== null && Number.isInteger(result) ? result : null;
}

function normaliseLifecycle(value: unknown): LifecycleState | null {
  const state = optionalString(value);
  return state === "started" || state === "completed" || state === "failed" || state === "cancelled"
    ? state
    : null;
}

function normalizeKind(value: unknown): string {
  const kind = optionalString(value)?.toLowerCase();
  return kind && /^[a-z][a-z0-9_-]{0,40}$/.test(kind) ? kind : "other";
}

function normalizeUsage(value: unknown): Record<string, number | null> | null {
  const raw = objectValue(value);
  const entries = Object.entries(raw)
    .map(([key, item]) => {
      if (item === null) return [key, null] as const;
      if (typeof item !== "number" || !Number.isFinite(item) || item < 0) {
        throw new InvalidAccountingEventError(`usage.${key} must be a finite non-negative number`);
      }
      return [key, item] as const;
    });
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

function isoOrNow(value: unknown, fallback: string): string {
  const candidate = optionalString(value);
  if (!candidate) return fallback;
  const date = new Date(candidate);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

/** Canonicalize old aliases and the current SDK event envelope. */
export function normalizeAccountingEvent(event: AccountingEvent): NormalizedAccountingEvent {
  const context = objectValue(event["context"]);
  const nestedLifecycle = objectValue(event["lifecycle"]);
  const nestedUsage = objectValue(event["usageEvent"] ?? event["usage_event"]);
  const eventTypeValue = event["eventType"] ?? event["event_type"];
  const rawEventType = optionalString(eventTypeValue);
  if (eventTypeValue !== undefined && rawEventType !== "call" && rawEventType !== "lifecycle" && rawEventType !== "usage" && rawEventType !== "span") {
    throw new UnsupportedEventTypeError(`eventType ${String(rawEventType ?? eventTypeValue)} is not supported`);
  }
  const eventType: EventType = rawEventType === "lifecycle" || rawEventType === "usage" || rawEventType === "span"
    ? rawEventType
    : "call";
  const sourceValue = optionalString(event["source"]);
  const source: "auto" | "explicit" = sourceValue === "explicit" ? "explicit" : "auto";

  const entityTypeValue = optionalString(event["entityType"] ?? event["entity_type"]);
  const entityType: NormalizedAccountingEvent["entityType"] = entityTypeValue === "trace" || entityTypeValue === "execution"
    ? entityTypeValue
    : null;
  const entityId = optionalString(event["entityId"] ?? event["entity_id"]);
  const traceId = optionalString(
    event["traceId"] ?? event["trace_id"] ?? context["traceId"] ?? context["trace_id"]
      ?? (entityType === "trace" ? entityId : undefined),
  );
  const traceName = optionalString(
    event["traceName"] ?? event["trace_name"] ?? context["traceName"] ?? context["trace_name"],
  );
  const executionId = optionalString(
    event["executionId"] ?? event["execution_id"] ?? context["executionId"] ?? context["execution_id"]
      ?? (entityType === "execution" ? entityId : undefined),
  );
  const groupName = optionalString(
    event["groupName"] ?? event["group_name"] ?? context["groupName"] ?? context["group_name"]
      ?? context["group"],
  );
  const groupKind = normalizeKind(event["groupKind"] ?? event["group_kind"] ?? context["groupKind"] ?? context["group_kind"]);
  const lifecycle = normaliseLifecycle(
    typeof event["lifecycle"] === "string" ? event["lifecycle"] : nestedLifecycle["state"],
  );
  const timestamp = isoOrNow(event["timestamp"], new Date().toISOString());
  const lifecycleAt = isoOrNow(
    event["lifecycleAt"] ?? event["lifecycle_at"] ?? nestedLifecycle["at"] ?? event["timestamp"],
    timestamp,
  );
  const startedAt = optionalString(event["startedAt"] ?? event["started_at"])
    ?? (lifecycle === "started" ? lifecycleAt : null);
  const endedAt = optionalString(event["endedAt"] ?? event["ended_at"])
    ?? (lifecycle === "completed" || lifecycle === "failed" || lifecycle === "cancelled" ? lifecycleAt : null);

  const amountObject = objectValue(event["amount"] ?? nestedUsage["amount"]);
  const amountFromCostAlias = !Object.prototype.hasOwnProperty.call(event, "amount")
    && Object.prototype.hasOwnProperty.call(event, "costUsd")
    && event["costUsd"] !== null
    && event["costUsd"] !== undefined;
  const amountPresent = Object.prototype.hasOwnProperty.call(event, "amount")
    || Object.prototype.hasOwnProperty.call(nestedUsage, "amount")
    || amountFromCostAlias;
  const rawAmountValue = Object.prototype.hasOwnProperty.call(event, "amount")
    ? typeof event["amount"] === "number" ? event["amount"] : amountObject["value"]
    : amountFromCostAlias
      ? event["costUsd"]
      : nestedUsage["amount"];
  const amountValue = amountPresent ? optionalNumber(rawAmountValue) : null;
  const explicitNullAmount = (Object.prototype.hasOwnProperty.call(event, "amount") && event["amount"] === null)
    || (Object.prototype.hasOwnProperty.call(nestedUsage, "amount") && nestedUsage["amount"] === null)
    || (amountFromCostAlias && event["costUsd"] === null);
  if (amountPresent && !explicitNullAmount && (typeof rawAmountValue !== "number" || !Number.isFinite(rawAmountValue) || rawAmountValue < 0)) {
    throw new InvalidAccountingEventError("amount.value must be a finite non-negative number");
  }
  const usageObject = eventType === "usage"
    ? normalizeUsage(event["usage"])
    : null;
  const unitValue = optionalNumber(
    event["unitValue"] ?? event["unit_value"] ?? nestedUsage["unitValue"] ?? nestedUsage["unit_value"],
  );
  const rawUnitValue = event["unitValue"] ?? event["unit_value"] ?? nestedUsage["unitValue"] ?? nestedUsage["unit_value"];
  const currency = (
    optionalString(amountObject["currency"])
      ?? optionalString(nestedUsage["currency"])
      ?? optionalString(event["currency"])
      ?? "USD"
  ).toUpperCase();
  const amountKindValue = optionalString(event["amountKind"] ?? event["amount_kind"] ?? nestedUsage["amountKind"]);
  const aggregationValue = optionalString(event["aggregation"] ?? nestedUsage["aggregation"]);
  const revision = optionalInteger(event["revision"] ?? nestedUsage["revision"]);
  const sequence = optionalInteger(event["sequence"]);
  const componentId = optionalString(event["componentId"] ?? event["component_id"] ?? nestedUsage["componentId"]);
  const callerId = optionalString(event["callerId"] ?? event["caller_id"] ?? nestedUsage["callerId"] ?? nestedUsage["caller_id"]);
  const chargeId = optionalString(event["chargeId"] ?? event["charge_id"] ?? nestedUsage["chargeId"])
    ?? (eventType === "usage" ? componentId : optionalString(event["id"]));

  const configuration = objectValue(event["configuration"]);
  const normalized: NormalizedAccountingEvent = {
    eventType,
    source,
    entityType,
    entityId,
    traceId,
    traceName,
    executionId,
    groupId: optionalString(event["groupId"] ?? event["group_id"] ?? context["groupId"] ?? context["group_id"]),
    groupName,
    groupKind,
    lifecycle,
    sequence,
    lifecycleAt,
    startedAt: startedAt ? isoOrNow(startedAt, timestamp) : null,
    endedAt: endedAt ? isoOrNow(endedAt, timestamp) : null,
    errorType: optionalString(event["errorType"] ?? event["error_type"] ?? nestedLifecycle["errorType"]),
    expectedItems: optionalInteger(event["expectedItems"] ?? event["expected_items"] ?? nestedLifecycle["expectedItems"]),
    completedItems: optionalInteger(event["completedItems"] ?? event["completed_items"] ?? nestedLifecycle["completedItems"]),
    failedItems: optionalInteger(event["failedItems"] ?? event["failed_items"] ?? nestedLifecycle["failedItems"]),
    phase: optionalString(event["phase"]),
    configuration: Object.keys(configuration).length > 0 ? configuration : null,
    datasetRevision: optionalString(event["datasetRevision"] ?? event["dataset_revision"]),
    caseId: optionalString(event["caseId"] ?? event["case_id"]),
    context: Object.keys(context).length > 0 ? context : null,
    component: optionalString(event["component"] ?? nestedUsage["component"]) ?? "custom",
    componentId,
    callerId,
    chargeId,
    provider: optionalString(event["provider"] ?? nestedUsage["provider"]) ?? "unknown",
    model: optionalString(event["model"] ?? nestedUsage["model"]),
    requestModel: optionalString(event["requestModel"] ?? event["request_model"]),
    unitKind: optionalString(event["unitKind"] ?? event["unit_kind"] ?? nestedUsage["unitKind"] ?? nestedUsage["unit_kind"]),
    unitValue,
    unit: optionalString(event["unit"] ?? nestedUsage["unit"]),
    amount: amountValue,
    amountPresent,
    currency,
    amountKind: amountKindValue === "estimated" ? "estimated" : "reported",
    aggregation: aggregationValue === "cumulative" ? "cumulative" : "delta",
    revision,
    pricingId: optionalString(event["pricingId"] ?? event["pricing_id"] ?? nestedUsage["pricingId"]),
    usage: usageObject,
    metadata: event["metadata"] ?? null,
    spanId: eventType === "span"
      ? optionalString(event["id"])
      : optionalString(event["spanId"] ?? event["span_id"] ?? context["spanId"] ?? context["span_id"]),
    parentSpanId: eventType === "span"
      ? optionalString(event["parentSpanId"] ?? event["parent_span_id"])
      : null,
    spanKind: eventType === "span" ? normalizeSpanKind(event["kind"] ?? event["spanKind"] ?? event["span_kind"]) : null,
    spanName: eventType === "span" ? optionalString(event["name"] ?? event["spanName"] ?? event["span_name"]) : null,
    spanStatus: eventType === "span" ? normalizeSpanStatus(event["status"]) : null,
    spanAttributes: eventType === "span" ? spanAttributes(event["attributes"]) : null,
  };
  if (!optionalString(event["id"])) {
    throw new InvalidAccountingEventError(`${eventType} requires id`);
  }
  if (normalized.eventType === "lifecycle") {
    if (!event["timestamp"] || Number.isNaN(new Date(String(event["timestamp"])).getTime())) {
      throw new InvalidAccountingEventError("lifecycle requires a valid timestamp");
    }
    if (!normalized.entityType || !normalized.entityId) {
      throw new InvalidAccountingEventError("lifecycle requires entityType and entityId");
    }
    if (!normalized.lifecycle) {
      throw new InvalidAccountingEventError("lifecycle requires started, completed, failed, or cancelled state");
    }
    if (event["sequence"] !== undefined && (typeof event["sequence"] !== "number"
      || normalized.sequence === null || !Number.isSafeInteger(normalized.sequence) || normalized.sequence < 0)) {
      throw new InvalidAccountingEventError("lifecycle sequence must be a safe non-negative integer");
    }
  }
  if (normalized.eventType === "span") {
    if (!normalized.spanName) throw new InvalidAccountingEventError("span requires name");
    if (normalized.parentSpanId === normalized.spanId) throw new InvalidAccountingEventError("span cannot be its own parent");
    // A span without explicit bounds starts at its timestamp.
    if (!normalized.startedAt) normalized.startedAt = timestamp;
  }
  if (normalized.eventType === "usage") {
    if (!event["timestamp"] || Number.isNaN(new Date(String(event["timestamp"])).getTime())) {
      throw new InvalidAccountingEventError("usage requires a valid timestamp");
    }
    if (!normalized.componentId) throw new InvalidAccountingEventError("usage requires componentId");
    const rawRevision = event["revision"] ?? nestedUsage["revision"];
    if (typeof rawRevision !== "number" || revision === null || !Number.isSafeInteger(revision) || revision < 0) {
      throw new InvalidAccountingEventError("usage requires a safe non-negative integer revision");
    }
    if (aggregationValue !== "delta" && aggregationValue !== "cumulative") {
      throw new InvalidAccountingEventError("usage requires aggregation delta or cumulative");
    }
    if (!/^[A-Z][A-Z0-9_-]{2,9}$/.test(currency)) {
      throw new InvalidAccountingEventError("usage amount currency must be an ISO-like code");
    }
    if (rawUnitValue !== undefined && (typeof rawUnitValue !== "number"
      || unitValue === null || unitValue < 0 || !Number.isFinite(unitValue))) {
      throw new InvalidAccountingEventError("usage unitValue must be a finite non-negative number");
    }
  }
  return normalized;
}

const SPAN_KINDS = new Set(["agent", "step", "tool", "workflow", "task", "judge", "retrieval", "handoff", "guardrail", "chain", "custom"]);

function normalizeSpanKind(value: unknown): string {
  const kind = optionalString(value)?.toLowerCase();
  return kind && SPAN_KINDS.has(kind) ? kind : "custom";
}

function normalizeSpanStatus(value: unknown): SpanStatus {
  const status = optionalString(value)?.toLowerCase();
  if (status === "ok" || status === "completed" || status === "success") return "ok";
  if (status === "error" || status === "failed") return "error";
  if (status === "cancelled" || status === "canceled") return "cancelled";
  return "running";
}

const MAX_SPAN_ATTRIBUTES_BYTES = 8_192;

/** Keep span attributes small and flat enough to store on every span. */
function spanAttributes(value: unknown): Record<string, unknown> | null {
  const raw = objectValue(value);
  const entries = Object.entries(raw).filter(([key]) => /^[A-Za-z0-9_.:-]{1,64}$/.test(key));
  if (entries.length === 0) return null;
  const result: Record<string, unknown> = {};
  let size = 2;
  for (const [key, item] of entries) {
    const encoded = JSON.stringify(item ?? null);
    if (encoded === undefined) continue;
    const clipped = encoded.length > 2_048 && typeof item === "string" ? item.slice(0, 2_000) : item;
    const length = key.length + Math.min(encoded.length, 2_048) + 4;
    if (size + length > MAX_SPAN_ATTRIBUTES_BYTES) break;
    if (encoded.length > 2_048 && typeof item !== "string") continue;
    result[key] = clipped;
    size += length;
  }
  return Object.keys(result).length > 0 ? result : null;
}

export function stableGroupId(projectId: string, name: string, kind: string): string {
  const digest = createHash("sha256").update(`${projectId}\u0000${kind}\u0000${name}`).digest("hex").slice(0, 24);
  return `grp_${digest}`;
}

function stableJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object" || Array.isArray(value)) return JSON.stringify(value);
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function payloadHash(event: AccountingEvent, normalized: NormalizedAccountingEvent): string {
  return createHash("sha256").update(stableJson({
    eventType: normalized.eventType,
    componentId: normalized.componentId,
    chargeId: normalized.chargeId,
    provider: normalized.provider,
    model: normalized.model,
    phase: normalized.phase,
    usage: normalized.usage,
    billingUnits: event["billingUnits"] ?? event["billing_units"] ?? null,
    amount: normalized.amountPresent ? { value: normalized.amount, currency: normalized.currency } : undefined,
    unitKind: normalized.unitKind,
    unitValue: normalized.unitValue,
    unit: normalized.unit,
    amountKind: normalized.amountKind,
    aggregation: normalized.aggregation,
    revision: normalized.revision,
    pricingId: normalized.pricingId,
    metadata: event["metadata"] ?? null,
  })).digest("hex");
}

function asClient(client: pg.Pool | pg.PoolClient): pg.Pool | pg.PoolClient {
  return client;
}

async function upsertGroup(
  client: pg.Pool | pg.PoolClient,
  projectId: string,
  normalized: NormalizedAccountingEvent,
): Promise<string | null> {
  if (!normalized.groupName && !normalized.groupId) return null;
  const requestedId = normalized.groupId ?? stableGroupId(projectId, normalized.groupName ?? "unnamed", normalized.groupKind);
  const groupName = normalized.groupName ?? requestedId;
  // Groups are unique by id and by (name, kind). An SDK may mint a new id for
  // a name that already exists, so reuse whichever row already owns either.
  const existing = await asClient(client).query(
    `SELECT id FROM groups
      WHERE project_id = $1 AND (id = $2 OR (name = $3 AND kind = $4))
      ORDER BY (id = $2) DESC
      LIMIT 1`,
    [projectId, requestedId, groupName, normalized.groupKind],
  );
  const existingId = (existing.rows[0] as { id: string } | undefined)?.id;
  if (existingId) {
    await asClient(client).query(
      `UPDATE groups SET
         metadata = COALESCE($3, metadata),
         updated_at = NOW()
       WHERE project_id = $1 AND id = $2`,
      [projectId, existingId, normalized.configuration ? JSON.stringify(normalized.configuration) : null],
    );
    return existingId;
  }
  await asClient(client).query(
    `INSERT INTO groups (id, project_id, name, kind, metadata)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT DO NOTHING`,
    [requestedId, projectId, groupName, normalized.groupKind, normalized.configuration ? JSON.stringify(normalized.configuration) : null],
  );
  const winner = await asClient(client).query(
    `SELECT id FROM groups WHERE project_id = $1 AND (id = $2 OR (name = $3 AND kind = $4)) ORDER BY (id = $2) DESC LIMIT 1`,
    [projectId, requestedId, groupName, normalized.groupKind],
  );
  return (winner.rows[0] as { id: string } | undefined)?.id ?? requestedId;
}

async function upsertSpan(
  client: pg.Pool | pg.PoolClient,
  projectId: string,
  normalized: NormalizedAccountingEvent,
): Promise<void> {
  if (!normalized.spanId || !normalized.spanName) return;
  await asClient(client).query(
    `INSERT INTO spans (
       id, project_id, trace_id, parent_span_id, execution_id, kind, name, status,
       error_type, started_at, ended_at, attributes, context, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())
     ON CONFLICT (project_id, id) DO UPDATE SET
       trace_id = COALESCE(EXCLUDED.trace_id, spans.trace_id),
       parent_span_id = COALESCE(EXCLUDED.parent_span_id, spans.parent_span_id),
       execution_id = COALESCE(EXCLUDED.execution_id, spans.execution_id),
       kind = CASE WHEN EXCLUDED.kind = 'custom' THEN spans.kind ELSE EXCLUDED.kind END,
       name = EXCLUDED.name,
       status = CASE
         WHEN EXCLUDED.status = 'running' AND spans.status <> 'running' THEN spans.status
         ELSE EXCLUDED.status END,
       error_type = COALESCE(EXCLUDED.error_type, spans.error_type),
       started_at = CASE
         WHEN EXCLUDED.started_at IS NULL THEN spans.started_at
         WHEN spans.started_at IS NULL THEN EXCLUDED.started_at
         ELSE LEAST(spans.started_at, EXCLUDED.started_at) END,
       ended_at = CASE
         WHEN EXCLUDED.ended_at IS NULL THEN spans.ended_at
         WHEN spans.ended_at IS NULL THEN EXCLUDED.ended_at
         ELSE GREATEST(spans.ended_at, EXCLUDED.ended_at) END,
       attributes = CASE
         WHEN EXCLUDED.attributes IS NULL THEN spans.attributes
         ELSE COALESCE(spans.attributes, '{}'::jsonb) || EXCLUDED.attributes END,
       context = COALESCE(EXCLUDED.context, spans.context),
       updated_at = NOW()`,
    [
      normalized.spanId,
      projectId,
      normalized.traceId,
      normalized.parentSpanId,
      normalized.executionId,
      normalized.spanKind ?? "custom",
      normalized.spanName,
      normalized.spanStatus ?? "running",
      normalized.errorType,
      normalized.startedAt,
      normalized.endedAt,
      normalized.spanAttributes ? JSON.stringify(normalized.spanAttributes) : null,
      normalized.context ? JSON.stringify(normalized.context) : null,
    ],
  );
}

async function upsertTrace(
  client: pg.Pool | pg.PoolClient,
  projectId: string,
  normalized: NormalizedAccountingEvent,
  timestamp: string,
  durationMs: number | null,
  groupId: string | null,
): Promise<void> {
  if (!normalized.traceId) return;
  const endFromCall = durationMs !== null && durationMs >= 0
    ? new Date(new Date(timestamp).getTime() + durationMs).toISOString()
    : null;
  const explicitLifecycle = normalized.eventType === "lifecycle" && normalized.entityType === "trace";
  const startAt = normalized.startedAt ?? (explicitLifecycle && normalized.lifecycle !== "started" ? null : timestamp);
  const endAt = normalized.endedAt ?? endFromCall;
  const state = explicitLifecycle ? normalized.lifecycle ?? "started" : "unknown";
  const lifecycleAt = explicitLifecycle ? normalized.lifecycleAt : null;
  await asClient(client).query(
    `INSERT INTO traces (
       id, project_id, trace_name, execution_id, group_id, state,
       lifecycle_at, lifecycle_sequence, error_type, started_at, ended_at, lifecycle_source,
       context, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())
     ON CONFLICT (project_id, id) DO UPDATE SET
       trace_name = COALESCE(EXCLUDED.trace_name, traces.trace_name),
       execution_id = COALESCE(EXCLUDED.execution_id, traces.execution_id),
       group_id = COALESCE(EXCLUDED.group_id, traces.group_id),
       started_at = CASE
         WHEN EXCLUDED.started_at IS NULL THEN traces.started_at
         WHEN traces.started_at IS NULL THEN EXCLUDED.started_at
         ELSE LEAST(traces.started_at, EXCLUDED.started_at) END,
       ended_at = CASE
         WHEN EXCLUDED.ended_at IS NULL THEN traces.ended_at
         WHEN traces.ended_at IS NULL THEN EXCLUDED.ended_at
         ELSE GREATEST(traces.ended_at, EXCLUDED.ended_at) END,
       state = CASE
         WHEN EXCLUDED.lifecycle_at IS NULL THEN traces.state
         WHEN traces.lifecycle_at IS NULL
           OR EXCLUDED.lifecycle_at > traces.lifecycle_at
           OR (EXCLUDED.lifecycle_at = traces.lifecycle_at
             AND COALESCE(EXCLUDED.lifecycle_sequence, -1) >= COALESCE(traces.lifecycle_sequence, -1)) THEN EXCLUDED.state
         ELSE traces.state END,
       lifecycle_at = CASE
         WHEN EXCLUDED.lifecycle_at IS NULL THEN traces.lifecycle_at
         WHEN traces.lifecycle_at IS NULL
           OR EXCLUDED.lifecycle_at > traces.lifecycle_at
           OR (EXCLUDED.lifecycle_at = traces.lifecycle_at
             AND COALESCE(EXCLUDED.lifecycle_sequence, -1) >= COALESCE(traces.lifecycle_sequence, -1)) THEN EXCLUDED.lifecycle_at
         ELSE traces.lifecycle_at END,
       lifecycle_sequence = CASE
         WHEN EXCLUDED.lifecycle_at IS NULL THEN traces.lifecycle_sequence
         WHEN traces.lifecycle_at IS NULL
           OR EXCLUDED.lifecycle_at > traces.lifecycle_at
           OR (EXCLUDED.lifecycle_at = traces.lifecycle_at
             AND COALESCE(EXCLUDED.lifecycle_sequence, -1) >= COALESCE(traces.lifecycle_sequence, -1)) THEN EXCLUDED.lifecycle_sequence
         ELSE traces.lifecycle_sequence END,
       error_type = CASE
         WHEN EXCLUDED.lifecycle_at IS NULL THEN traces.error_type
         WHEN traces.lifecycle_at IS NULL
           OR EXCLUDED.lifecycle_at > traces.lifecycle_at
           OR (EXCLUDED.lifecycle_at = traces.lifecycle_at
             AND COALESCE(EXCLUDED.lifecycle_sequence, -1) >= COALESCE(traces.lifecycle_sequence, -1)) THEN EXCLUDED.error_type
         ELSE traces.error_type END,
       lifecycle_source = CASE WHEN EXCLUDED.lifecycle_at IS NOT NULL THEN 'explicit' ELSE traces.lifecycle_source END,
       context = COALESCE(EXCLUDED.context, traces.context),
       updated_at = NOW()`,
    [
      normalized.traceId,
      projectId,
      normalized.traceName,
      normalized.executionId,
      groupId,
      state,
      lifecycleAt,
      normalized.sequence,
      normalized.errorType,
      startAt,
      endAt,
      explicitLifecycle ? "explicit" : "observed",
      normalized.context ? JSON.stringify(normalized.context) : null,
    ],
  );
}

async function upsertExecution(
  client: pg.Pool | pg.PoolClient,
  projectId: string,
  normalized: NormalizedAccountingEvent,
  timestamp: string,
  durationMs: number | null,
  groupId: string | null,
): Promise<void> {
  if (!normalized.executionId) return;
  const endFromCall = durationMs !== null && durationMs >= 0
    ? new Date(new Date(timestamp).getTime() + durationMs).toISOString()
    : null;
  const explicitLifecycle = normalized.eventType === "lifecycle" && normalized.entityType === "execution";
  const startAt = normalized.startedAt ?? (explicitLifecycle && normalized.lifecycle !== "started" ? null : timestamp);
  const state = explicitLifecycle ? normalized.lifecycle ?? "started" : "unknown";
  const lifecycleAt = explicitLifecycle ? normalized.lifecycleAt : null;
  await asClient(client).query(
     `INSERT INTO executions (
       id, project_id, group_id, name, kind, state, lifecycle_at, lifecycle_sequence, error_type,
       started_at, ended_at, expected_items, completed_items, failed_items,
       accounting_state, configuration, dataset_revision, context, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'pending',$15,$16,$17,NOW())
     ON CONFLICT (project_id, id) DO UPDATE SET
       group_id = COALESCE(EXCLUDED.group_id, executions.group_id),
       name = COALESCE(EXCLUDED.name, executions.name),
       kind = COALESCE(EXCLUDED.kind, executions.kind),
       started_at = CASE
         WHEN EXCLUDED.started_at IS NULL THEN executions.started_at
         WHEN executions.started_at IS NULL THEN EXCLUDED.started_at
         ELSE LEAST(executions.started_at, EXCLUDED.started_at) END,
       ended_at = CASE
         WHEN EXCLUDED.ended_at IS NULL THEN executions.ended_at
         WHEN executions.ended_at IS NULL THEN EXCLUDED.ended_at
         ELSE GREATEST(executions.ended_at, EXCLUDED.ended_at) END,
       expected_items = COALESCE(EXCLUDED.expected_items, executions.expected_items),
       completed_items = COALESCE(EXCLUDED.completed_items, executions.completed_items),
       failed_items = COALESCE(EXCLUDED.failed_items, executions.failed_items),
       state = CASE
         WHEN EXCLUDED.lifecycle_at IS NULL THEN executions.state
         WHEN executions.lifecycle_at IS NULL
           OR EXCLUDED.lifecycle_at > executions.lifecycle_at
           OR (EXCLUDED.lifecycle_at = executions.lifecycle_at
             AND COALESCE(EXCLUDED.lifecycle_sequence, -1) >= COALESCE(executions.lifecycle_sequence, -1)) THEN EXCLUDED.state
         ELSE executions.state END,
       lifecycle_at = CASE
         WHEN EXCLUDED.lifecycle_at IS NULL THEN executions.lifecycle_at
         WHEN executions.lifecycle_at IS NULL
           OR EXCLUDED.lifecycle_at > executions.lifecycle_at
           OR (EXCLUDED.lifecycle_at = executions.lifecycle_at
             AND COALESCE(EXCLUDED.lifecycle_sequence, -1) >= COALESCE(executions.lifecycle_sequence, -1)) THEN EXCLUDED.lifecycle_at
         ELSE executions.lifecycle_at END,
       lifecycle_sequence = CASE
         WHEN EXCLUDED.lifecycle_at IS NULL THEN executions.lifecycle_sequence
         WHEN executions.lifecycle_at IS NULL
           OR EXCLUDED.lifecycle_at > executions.lifecycle_at
           OR (EXCLUDED.lifecycle_at = executions.lifecycle_at
             AND COALESCE(EXCLUDED.lifecycle_sequence, -1) >= COALESCE(executions.lifecycle_sequence, -1)) THEN EXCLUDED.lifecycle_sequence
         ELSE executions.lifecycle_sequence END,
       error_type = CASE
         WHEN EXCLUDED.lifecycle_at IS NULL THEN executions.error_type
         WHEN executions.lifecycle_at IS NULL
           OR EXCLUDED.lifecycle_at > executions.lifecycle_at
           OR (EXCLUDED.lifecycle_at = executions.lifecycle_at
             AND COALESCE(EXCLUDED.lifecycle_sequence, -1) >= COALESCE(executions.lifecycle_sequence, -1)) THEN EXCLUDED.error_type
         ELSE executions.error_type END,
       configuration = COALESCE(EXCLUDED.configuration, executions.configuration),
       dataset_revision = COALESCE(EXCLUDED.dataset_revision, executions.dataset_revision),
       context = COALESCE(EXCLUDED.context, executions.context),
       updated_at = NOW()`,
    [
      normalized.executionId,
      projectId,
      groupId,
      normalized.groupName,
      normalized.groupKind,
      state,
      lifecycleAt,
      normalized.sequence,
      normalized.errorType,
      startAt,
      normalized.endedAt ?? endFromCall,
      normalized.expectedItems,
      normalized.completedItems,
      normalized.failedItems,
      normalized.configuration ? JSON.stringify(normalized.configuration) : null,
      normalized.datasetRevision,
      normalized.context ? JSON.stringify(normalized.context) : null,
    ],
  );
}

/**
 * Persist trace/execution identity and explicit usage metadata after the
 * canonical event row has been inserted. Returns whether a usage row was
 * inserted or updated; duplicate deliveries are intentionally no-ops.
 */
export async function recordAccountingEvent(
  client: pg.Pool | pg.PoolClient,
  projectId: string,
  event: AccountingEvent,
): Promise<void> {
  const normalized = normalizeAccountingEvent(event);
  const timestamp = isoOrNow(event["timestamp"], new Date().toISOString());
  const durationMs = optionalNumber(event["durationMs"] ?? event["duration_ms"]);
  const groupId = await upsertGroup(client, projectId, normalized);
  const eventId = optionalString(event["id"]);
  if (groupId && normalized.groupId && groupId !== normalized.groupId && eventId && normalized.eventType !== "span") {
    // Keep the stored event on the canonical group so rollups stay joined.
    await asClient(client).query(
      "UPDATE events SET group_id = $3 WHERE project_id = $1 AND id = $2",
      [projectId, eventId, groupId],
    );
  }

  if (normalized.eventType === "span") {
    await upsertSpan(client, projectId, normalized);
    await upsertTrace(client, projectId, normalized, normalized.startedAt ?? timestamp, null, groupId);
    if (normalized.executionId) await upsertExecution(client, projectId, normalized, normalized.startedAt ?? timestamp, null, groupId);
    return;
  }

  await upsertTrace(client, projectId, normalized, timestamp, durationMs, groupId);
  await upsertExecution(client, projectId, normalized, timestamp, durationMs, groupId);

  if (normalized.eventType !== "usage") return;
  if (!eventId) throw new AccountingConflictError("usage event requires id");
  const chargeId = normalized.chargeId ?? normalized.componentId ?? eventId;
  if (normalized.revision !== null && normalized.revision < 0) {
    throw new AccountingConflictError("usage revision must be non-negative");
  }
  const hash = payloadHash(event, normalized);
  let accountingAt = timestamp;
  const existingRevision = await asClient(client).query(
    `SELECT id, payload_hash, aggregation, revision, amount, currency,
            unit_kind, unit_value, unit
     FROM usage_components
     WHERE project_id = $1 AND charge_id = $2 AND revision IS NOT DISTINCT FROM $3
     LIMIT 1`,
    [projectId, chargeId, normalized.revision],
  );
  if (existingRevision.rows.length > 0) {
    const existing = existingRevision.rows[0] as Record<string, unknown>;
    if (existing.payload_hash !== hash || existing.aggregation !== normalized.aggregation) {
      throw new AccountingConflictError(`conflicting usage revision for charge ${chargeId}`);
    }
    return;
  }

  if (normalized.aggregation === "cumulative" && normalized.revision !== null) {
    const latest = await asClient(client).query(
      `SELECT revision, accounting_at, observed_at FROM usage_components
       WHERE project_id = $1 AND charge_id = $2 AND aggregation = 'cumulative'
       ORDER BY revision DESC NULLS LAST, observed_at DESC
       LIMIT 1`,
      [projectId, chargeId],
    );
    const latestRevision = optionalInteger(latest.rows[0]?.revision);
    if (latestRevision !== null && normalized.revision < latestRevision) return;
    const priorAccountingAt = latest.rows[0]?.accounting_at ?? latest.rows[0]?.observed_at;
    accountingAt = priorAccountingAt instanceof Date
      ? priorAccountingAt.toISOString()
      : optionalString(priorAccountingAt) ?? timestamp;
    await asClient(client).query(
      `UPDATE usage_components SET active = FALSE, updated_at = NOW()
       WHERE project_id = $1 AND charge_id = $2 AND aggregation = 'cumulative'`,
      [projectId, chargeId],
    );
  }

  try {
    await asClient(client).query(
      `INSERT INTO usage_components (
       id, project_id, charge_id, component_id, trace_id, execution_id,
       caller_id, context, group_id, phase, component, provider, model, unit_kind, unit_value,
       unit, amount, currency, amount_kind, aggregation, revision,
       pricing_id, observed_at, accounting_at, metadata, payload_hash, active, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,TRUE,NOW())
     ON CONFLICT (project_id, id) DO NOTHING`,
      [
        eventId,
        projectId,
        chargeId,
        normalized.componentId,
        normalized.traceId,
        normalized.executionId,
        normalized.callerId,
        normalized.context ? JSON.stringify(normalized.context) : null,
        groupId,
        normalized.phase,
        normalized.component,
        normalized.provider,
        normalized.model,
        normalized.unitKind,
        normalized.unitValue,
        normalized.unit,
        normalized.amountPresent ? normalized.amount : null,
        normalized.currency,
        // Every amount arriving through the DSN is caller-supplied. Preserve
        // it only as an estimate; a request-body `amountKind: "reported"`
        // cannot become provider-attested financial evidence.
        normalized.amountPresent ? "estimated" : normalized.amountKind,
        normalized.aggregation,
      normalized.revision,
      normalized.pricingId,
      timestamp,
        accountingAt,
        JSON.stringify({
          usage: normalized.usage,
          billingUnits: event["billingUnits"] ?? event["billing_units"] ?? null,
          pricingId: normalized.pricingId,
          metadata: normalized.metadata,
        }),
        hash,
      ],
    );
  } catch (error) {
    // Concurrent deliveries can race between the revision read and insert.
    // The unique project/charge/revision index is authoritative; re-read the
    // winner and accept only an identical payload.
    const code = (error as { code?: string }).code;
    if (code !== "23505") throw error;
    const winner = await asClient(client).query(
      `SELECT payload_hash, aggregation FROM usage_components
       WHERE project_id = $1 AND charge_id = $2 AND revision = $3 LIMIT 1`,
      [projectId, chargeId, normalized.revision],
    );
    const row = winner.rows[0] as Record<string, unknown> | undefined;
    if (!row || row.payload_hash !== hash || row.aggregation !== normalized.aggregation) {
      throw new AccountingConflictError(`conflicting usage revision for charge ${chargeId}`);
    }
  }
}

export function accountingState(pricedCount: number, unpricedCount: number, pendingCount = 0): AccountingState {
  if (pendingCount > 0) return "pending";
  if (unpricedCount > 0) return "partial";
  return pricedCount > 0 ? "complete" : "pending";
}

export function percentage(numerator: number, denominator: number): number | null {
  return denominator > 0 ? Math.round((numerator / denominator) * 10000) / 10000 : null;
}

/**
 * Reconcile one completed workspace-local day into durable dimensions before retention
 * removes detail. This is intentionally explicit and rerunnable: late price
 * corrections update the rollup while preserving the same accounting day.
 */
export async function reconcileDailyCostAggregates(
  pool: pg.Pool,
  projectId: string,
  day: string,
): Promise<number> {
  const start = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime())) throw new InvalidAccountingEventError("day must be an ISO date");
  const client = await pool.connect();
  let aggregateRows = 0;
  let timezone = "UTC";
  try {
    await client.query("BEGIN");
    // Share the retention advisory fence with purge. Ingest takes the same
    // lock, so the checkpoint's source_created_before covers every write it
    // can possibly purge.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [accountingLockKey(projectId)]);
    const timezoneResult = await client.query(
      `SELECT COALESCE(ws.timezone, 'UTC') AS timezone
       FROM projects p LEFT JOIN workspace_settings ws ON ws.org_id = p.org_id
       WHERE p.id = $1`,
      [projectId],
    ).catch(() => ({ rows: [] as Array<{ timezone?: string }> }));
    timezone = String(timezoneResult.rows[0]?.timezone ?? "UTC");
    try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(); }
    catch { timezone = "UTC"; }
    await client.query("DELETE FROM daily_cost_aggregates WHERE project_id = $1 AND day = $2", [projectId, day]);
    const rollup = await client.query(
      `${chargesCte()},
       scoped AS (
         SELECT c.*,
                COALESCE(c.context->>'environment', '(unassigned)') AS environment,
                COALESCE(c.context->>'feature', '(unassigned)') AS feature,
                CASE WHEN c.bl_file IS NULL AND c.bl_function IS NULL THEN '(unassigned)'
                     WHEN NULLIF(c.context->>'service', '') IS NULL THEN COALESCE(NULLIF(c.bl_file || ':' || c.bl_function, ':'), '(unassigned)')
                     ELSE (c.context->>'service') || ':' || COALESCE(NULLIF(c.bl_file || ':' || c.bl_function, ':'), '(unassigned)') END AS function_key,
                COALESCE(c.context->>'customer', '(unassigned)') AS customer,
                COALESCE(NULLIF(c.service, ''), NULLIF(c.context->>'service', ''), '(unassigned)') AS service_key,
                COALESCE(NULLIF(c.release, ''), NULLIF(c.context->>'release', ''), '(unassigned)') AS release_key,
                COALESCE(NULLIF(c.provider, ''), '(unknown)') AS provider_key,
                COALESCE(NULLIF(c.model, ''), '(unknown)') AS model_key
         FROM charges c
         WHERE c.project_id = $1
           AND (c.timestamp AT TIME ZONE $3::text) >= $2::date
           AND (c.timestamp AT TIME ZONE $3::text) < ($2::date + INTERVAL '1 day')
       ), trace_groups AS (
         SELECT environment, feature, function_key, customer, service_key, release_key, provider_key, model_key, trace_id,
                BOOL_AND(cost_usd IS NOT NULL) AS fully_priced,
                SUM(cost_usd) FILTER (WHERE cost_usd IS NOT NULL) AS trace_cost
         FROM scoped
         WHERE trace_id IS NOT NULL
         GROUP BY environment, feature, function_key, customer, service_key, release_key, provider_key, model_key, trace_id
       ), trace_summary AS (
         SELECT environment, feature, function_key, customer, service_key, release_key, provider_key, model_key,
                COUNT(*)::int AS trace_count,
                COUNT(*) FILTER (WHERE fully_priced)::int AS fully_priced_trace_count,
                SUM(trace_cost) FILTER (WHERE fully_priced) AS fully_priced_trace_cost_usd
         FROM trace_groups
         GROUP BY environment, feature, function_key, customer, service_key, release_key, provider_key, model_key
       ), grouped AS (
         SELECT environment, feature, function_key, customer, service_key, release_key, provider_key, model_key,
                SUM(cost_usd) FILTER (WHERE cost_usd IS NOT NULL) AS known_cost_usd,
                COUNT(*)::int AS observations,
                COUNT(*) FILTER (WHERE record_type = 'call')::int AS call_count,
                COUNT(*) FILTER (WHERE cost_usd IS NOT NULL)::int AS priced_observations,
                COUNT(*) FILTER (WHERE cost_usd IS NULL)::int AS unpriced_observations,
                COUNT(*) FILTER (WHERE cost_usd IS NOT NULL AND cost_basis = 'reported')::int AS reported_observations,
                COUNT(*) FILTER (WHERE cost_usd IS NOT NULL AND cost_basis = 'estimated')::int AS estimated_observations,
                COUNT(*) FILTER (WHERE cost_usd IS NULL OR cost_basis NOT IN ('reported','estimated'))::int AS unknown_observations,
                COALESCE(SUM(input_tokens), 0)::bigint AS input_tokens,
                COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens
         FROM scoped
         GROUP BY environment, feature, function_key, customer, service_key, release_key, provider_key, model_key
       )
       INSERT INTO daily_cost_aggregates (
         project_id, day, timezone, environment, feature, function_key, customer, service, release,
         provider, model, known_cost_usd, observations, call_count, priced_observations,
         unpriced_observations, trace_count, fully_priced_trace_count,
         fully_priced_trace_cost_usd,
         reported_observations, estimated_observations, unknown_observations,
         input_tokens, output_tokens, reconciled_at, updated_at
       )
       SELECT $1, $2::date, $3::text, g.environment, g.feature, g.function_key, g.customer,
              g.service_key, g.release_key, g.provider_key, g.model_key, g.known_cost_usd, g.observations, g.call_count,
              g.priced_observations, g.unpriced_observations,
              COALESCE(ts.trace_count, 0), COALESCE(ts.fully_priced_trace_count, 0),
              ts.fully_priced_trace_cost_usd,
              g.reported_observations, g.estimated_observations, g.unknown_observations,
              g.input_tokens, g.output_tokens, NOW(), NOW()
       FROM grouped g
       LEFT JOIN trace_summary ts USING (environment, feature, function_key, customer, service_key, release_key, provider_key, model_key)
       RETURNING environment, feature, function_key, customer, provider, model`,
      [projectId, day, timezone],
    );
    aggregateRows = rollup.rowCount ?? 0;
    await client.query(
      `INSERT INTO daily_cost_aggregate_checkpoints (
         project_id, through_day, source_created_before, generation, completed_at
       ) VALUES ($1,$2,NOW(),1,NOW())
       ON CONFLICT (project_id) DO UPDATE SET
         through_day = GREATEST(daily_cost_aggregate_checkpoints.through_day, EXCLUDED.through_day),
         source_created_before = GREATEST(daily_cost_aggregate_checkpoints.source_created_before, EXCLUDED.source_created_before),
         generation = daily_cost_aggregate_checkpoints.generation + 1,
         completed_at = NOW()`,
      [projectId, day],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return aggregateRows;
}
