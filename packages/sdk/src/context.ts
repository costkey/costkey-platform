import { randomBytes } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type {
  ContextCarrier,
  EventContext,
  ExecutionOptions,
  ExecutionLifecycle,
  TraceLifecycle,
  TraceOptions,
} from "./types.js";

const storage = new AsyncLocalStorage<EventContext>();
// A boundary owns a fresh identity by default. Explicit IDs (or an imported
// carrier outside a boundary) are the only way to join an existing identity.
const traceScopeOwned = new AsyncLocalStorage<boolean>();
const executionScopeOwned = new AsyncLocalStorage<boolean>();

/** Data emitted by a trace/execution boundary without coupling context to transport. */
export interface LifecycleRecord {
  entityType: "trace" | "execution";
  entityId: string;
  lifecycle: TraceLifecycle | ExecutionLifecycle;
  sequence: number;
  traceId?: string;
  traceName?: string;
  groupId?: string;
  groupName?: string;
  groupKind?: string;
  executionId?: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  errorType?: string;
  expectedItems?: number;
  completedItems?: number;
  failedItems?: number;
  configuration?: Record<string, unknown>;
  context: EventContext;
}

type LifecycleEmitter = (record: LifecycleRecord) => void;

let lifecycleEmitter: LifecycleEmitter | null = null;
const executionSequence = new Map<string, number>();
const traceSequence = new Map<string, number>();

/** Configure the process-local sink used by the public SDK facade. */
export function setLifecycleEmitter(emitter: LifecycleEmitter | null): void {
  lifecycleEmitter = emitter;
}

/** Reset process-local lifecycle ordering after a full SDK shutdown. */
export function resetLifecycleState(): void {
  executionSequence.clear();
  traceSequence.clear();
}

/**
 * Run a function with CostKey context. Any AI calls made inside
 * will be tagged with this context automatically.
 *
 * Contexts nest — inner contexts merge with outer contexts. A serialized
 * carrier returned by exportContext() is accepted for explicit handoffs.
 */
export function withContext<T>(
  context: EventContext | ContextCarrier | string,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  const parent = storage.getStore();
  const imported = normalizeContextInput(context);
  const merged = parent ? { ...parent, ...imported } : imported;
  return storage.run(merged, fn);
}

/**
 * Start one trace boundary. Trace identity is generated per invocation; it is
 * never derived from stack frames or a wall-clock bucket, so concurrent calls
 * through the same function cannot accidentally share a trace.
 */
export function startTrace<T>(
  options: TraceOptions = {},
  fn: () => T | Promise<T>,
): T | Promise<T> {
  const parent = storage.getStore() ?? {};
  const optionContext = options.context ? normalizeContextInput(options.context) : {};
  const requestedTraceId = nonEmpty(options.traceId) ?? nonEmpty(optionContext.traceId);
  const ownsTrace = traceScopeOwned.getStore() === true;
  const inheritedTraceId = ownsTrace ? undefined : nonEmpty(parent.traceId);
  const traceId = requestedTraceId ?? inheritedTraceId ?? generateId("tr");
  const context: EventContext = {
    ...parent,
    ...optionContext,
    traceId,
  };
  if (options.name !== undefined) context.traceName = options.name;

  // A downstream service can import a carrier and still call startTrace() as
  // a framework boundary. Joining an existing identity avoids emitting a
  // second root lifecycle or prematurely terminalizing the upstream trace.
  const joinsExistingTrace =
    !!parent.traceId &&
    ((requestedTraceId !== undefined && requestedTraceId === parent.traceId) ||
      (!ownsTrace && requestedTraceId === undefined));
  if (joinsExistingTrace) {
    return traceScopeOwned.run(true, () => storage.run(context, fn));
  }

  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const startSequence = traceSequence.get(traceId) ?? 0;
  traceSequence.set(traceId, startSequence + 2);
  emitLifecycle({
    entityType: "trace",
    entityId: traceId,
    lifecycle: "started",
    sequence: startSequence,
    traceId,
    traceName: context.traceName,
    startedAt,
    context,
  });

  return traceScopeOwned.run(true, () => runBoundary(
    context,
    fn,
    (lifecycle, error) => {
      const endedAt = new Date().toISOString();
      emitLifecycle({
        entityType: "trace",
        entityId: traceId,
        lifecycle,
        sequence: startSequence + 1,
        traceId,
        traceName: context.traceName,
        startedAt,
        endedAt,
        durationMs: Math.max(0, Date.now() - startedMs),
        errorType: lifecycle === "failed" ? errorType(error) : undefined,
        context,
      });
    },
  ));
}

/**
 * Start one grouped-work invocation. The group name is stable across runs;
 * executionId is fresh unless supplied by an external runner.
 */
export function startExecution<T>(
  options: ExecutionOptions,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  if (!options || typeof options !== "object") {
    throw new TypeError("CostKey.startExecution() requires options");
  }
  const optionContext = options.context ? normalizeContextInput(options.context) : {};
  const groupName =
    nonEmpty(options.groupName) ??
    nonEmpty(options.name) ??
    nonEmpty(optionContext.groupName);
  if (!groupName) {
    throw new TypeError("CostKey.startExecution() requires a non-empty name");
  }
  if (
    options.expectedItems !== undefined &&
    (!Number.isSafeInteger(options.expectedItems) || options.expectedItems < 0)
  ) {
    throw new RangeError("CostKey.startExecution() expectedItems must be a non-negative integer");
  }
  for (const [label, value] of [
    ["completedItems", options.completedItems],
    ["failedItems", options.failedItems],
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw new RangeError(`CostKey.startExecution() ${label} must be a non-negative integer`);
    }
  }

  const parent = storage.getStore() ?? {};
  const ownsExecution = executionScopeOwned.getStore() === true;
  const explicitExecutionId =
    nonEmpty(options.executionId) ?? nonEmpty(optionContext.executionId);
  const inheritedExecutionId = ownsExecution ? undefined : nonEmpty(parent.executionId);
  const executionId =
    explicitExecutionId ??
    inheritedExecutionId ??
    generateId("ex");
  const groupKind = nonEmpty(options.kind) ?? "batch";
  const configuration = options.configuration === undefined
    ? undefined
    : toJsonSafe(options.configuration);
  const context: EventContext = {
    ...parent,
    ...optionContext,
    ...(options.groupId ? { groupId: options.groupId } : {}),
    groupName,
    groupKind,
    executionId,
    ...(options.datasetRevision ? { datasetRevision: options.datasetRevision } : {}),
    ...(options.caseId ? { caseId: options.caseId } : {}),
    ...(options.phase ? { phase: options.phase } : {}),
  };

  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const startSequence = executionSequence.get(executionId) ?? 0;
  executionSequence.set(executionId, startSequence + 2);
  emitLifecycle({
    entityType: "execution",
    entityId: executionId,
    lifecycle: "started",
    sequence: startSequence,
    traceId: context.traceId,
    traceName: context.traceName,
    groupId: context.groupId as string | undefined,
    groupName,
    groupKind,
    executionId,
    startedAt,
    expectedItems: options.expectedItems,
    completedItems: options.completedItems,
    failedItems: options.failedItems,
    configuration,
    context,
  });

  return executionScopeOwned.run(true, () => runBoundary(
    context,
    fn,
    (lifecycle, error) => {
      const endedAt = new Date().toISOString();
      emitLifecycle({
        entityType: "execution",
        entityId: executionId,
        lifecycle,
        sequence: startSequence + 1,
        traceId: context.traceId,
        traceName: context.traceName,
        groupId: context.groupId as string | undefined,
        groupName,
        groupKind,
        executionId,
        startedAt,
        endedAt,
        durationMs: Math.max(0, Date.now() - startedMs),
        errorType: lifecycle === "failed" ? errorType(error) : undefined,
        expectedItems: options.expectedItems,
        completedItems: options.completedItems,
        failedItems: options.failedItems,
        configuration,
        context,
      });
    },
  ));
}

/** Get the current context (from the nearest withContext scope). */
export function getCurrentContext(): EventContext {
  return { ...(storage.getStore() ?? {}) };
}

/** Get the current trace ID if inside a trace scope. */
export function getCurrentTraceId(): string | undefined {
  return storage.getStore()?.traceId;
}

/**
 * Return an explicit, allowlisted carrier for trusted service/queue handoff.
 * Arbitrary user labels intentionally stay process-local unless copied by the
 * caller into a new context at the destination.
 */
export function exportContext(options?: { keys?: readonly string[] }): ContextCarrier {
  const current = storage.getStore() ?? {};
  const carrier: Record<string, string | number | boolean> = {};
  const keys = options?.keys
    ? [...options.keys]
    : CONTEXT_CARRIER_KEYS;
  for (const requestedKey of keys) {
    if (!CONTEXT_CARRIER_KEYS.includes(requestedKey as keyof ContextCarrier)) {
      throw new TypeError(`context key is not exportable: ${requestedKey}`);
    }
    const key = requestedKey as keyof ContextCarrier;
    const value = current[key];
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      carrier[key] = value;
    }
  }
  return carrier as ContextCarrier;
}

/**
 * Convenience form for explicitly attaching a carrier to a trusted request.
 * The SDK never adds these headers to arbitrary application requests.
 */
export function exportContextHeaders(options?: { keys?: readonly string[] }): Record<string, string> {
  return { "x-costkey-context": JSON.stringify(exportContext(options)) };
}

/** Parse a carrier received from an explicitly trusted service/queue handoff. */
export function importContext(input: unknown): EventContext {
  return normalizeContextInput(input as EventContext | ContextCarrier | string);
}

function runBoundary<T>(
  context: EventContext,
  fn: () => T | Promise<T>,
  onTerminal: (lifecycle: TraceLifecycle, error?: unknown) => void,
): T | Promise<T> {
  let result: T | Promise<T>;
  try {
    result = storage.run(context, fn);
  } catch (error) {
    onTerminal(isCancellation(error) ? "cancelled" : "failed", error);
    throw error;
  }

  if (isPromiseLike<T>(result)) {
    return Promise.resolve(result).then(
      (value) => {
        onTerminal("completed");
        return value;
      },
      (error) => {
        onTerminal(isCancellation(error) ? "cancelled" : "failed", error);
        throw error;
      },
    );
  }

  onTerminal("completed");
  return result;
}

function emitLifecycle(record: LifecycleRecord): void {
  try {
    lifecycleEmitter?.({ ...record, context: { ...record.context } });
  } catch {
    // Telemetry must never change the callback's result or error.
  }
}

function normalizeContextInput(input: EventContext | ContextCarrier | string): EventContext {
  let value: unknown = input;
  let explicitCarrier = typeof input === "string";
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return {};
    }
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const object = value as Record<string, unknown>;
  if (object["context"] && typeof object["context"] === "object") {
    value = object["context"];
    explicitCarrier = true;
  }

  const result: EventContext = {};
  for (const [key, candidate] of Object.entries(value as Record<string, unknown>)) {
    const canonicalKey = CONTEXT_ALIASES[key] ?? key;
    if (explicitCarrier && !CONTEXT_CARRIER_KEYS.includes(canonicalKey as keyof ContextCarrier)) continue;
    if (canonicalKey !== key && Object.prototype.hasOwnProperty.call(value, canonicalKey)) continue;
    if (
      typeof candidate === "string" ||
      typeof candidate === "number" ||
      typeof candidate === "boolean"
    ) {
      result[canonicalKey] = candidate;
    }
  }
  return result;
}

function nonEmpty(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function generateId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return !!value && typeof value === "object" && typeof (value as Promise<T>).then === "function";
}

function isCancellation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: unknown; code?: unknown };
  return candidate.name === "AbortError" || candidate.code === "ABORT_ERR";
}

function errorType(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const name = (error as { name?: unknown }).name;
  return typeof name === "string" && name ? name : "Error";
}

function toJsonSafe(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  try {
    const parsed = JSON.parse(JSON.stringify(value)) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

const CONTEXT_CARRIER_KEYS: Array<keyof ContextCarrier> = [
  "traceId",
  "traceName",
  "groupId",
  "groupName",
  "groupKind",
  "executionId",
  "feature",
  "customer",
  "customerId",
  "environment",
  "service",
  "release",
  "function",
  "operation",
  "phase",
  "caseId",
  "datasetRevision",
  "conversationId",
  "voiceSessionId",
];

const CONTEXT_ALIASES: Record<string, keyof EventContext> = {
  trace_id: "traceId",
  trace_name: "traceName",
  group_id: "groupId",
  group_name: "groupName",
  group_kind: "groupKind",
  execution_id: "executionId",
  dataset_revision: "datasetRevision",
  case_id: "caseId",
  conversation_id: "conversationId",
  voice_session_id: "voiceSessionId",
};
