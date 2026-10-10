import { createHash } from "node:crypto";
import type { Request, Response, Router } from "express";
import { Router as createRouter } from "express";
import type pg from "pg";
import { chargesCte } from "./charge-cohort.js";
import { dispatchEnforcementNotification } from "./notifications.js";
import {
  InMemoryReservationStore,
  PostgresReservationStore,
  ReservationCapacityError,
  ReservationConflictError,
  SettlementConflictError,
  SettlementNotFoundError,
  type DecisionRecord,
  type ReservationLineInput,
  type ReservationOutcome,
  type ReservationRecord,
  type ReservationStore,
  type SettlementResult,
} from "./reservation.js";

export type PolicyCurrency = "USD" | "INR";
export type PolicyMode = "monitor" | "enforce";
export type PolicyStatus = "active" | "paused" | "archived";
export type PolicyUnit = "money" | "calls" | "tokens";
export type PolicyWindow =
  | "per_trace"
  | "per_execution"
  | "calendar_minute"
  | "calendar_day"
  | "calendar_month";
export type PolicyPeriodStart = "calendar" | "activation";

export const POLICY_SCOPE_KEYS = [
  "feature",
  "customer",
  "function",
  "provider",
  "model",
  "group",
  "agent",
  "tool",
] as const;
export type PolicyScopeKey = (typeof POLICY_SCOPE_KEYS)[number];
export type PolicyScope = Partial<Record<PolicyScopeKey, string>>;

export interface SpendingPolicy {
  id: string;
  projectId: string;
  name?: string | null;
  scope: PolicyScope;
  mode: PolicyMode;
  status: PolicyStatus;
  unit: PolicyUnit;
  allowance: number;
  currency?: PolicyCurrency;
  window: PolicyWindow;
  timezone: string;
  /** Calendar includes earlier observed charges; activation starts fresh only by explicit opt-in. */
  periodStart: PolicyPeriodStart;
  activatedAt?: string | null;
  /** Server-owned FX basis, USD -> policy currency. USD is always 1. */
  usdToPolicyCurrency?: number;
  fxSource?: string | null;
  fxAsOf?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  /** False only when a persisted row could not be normalized safely. */
  valid?: boolean;
  version?: number | null;
  capabilityReview?: ProviderAdmissionProof | Record<string, unknown> | null;
}

export interface ProviderUsageBounds {
  /** Upper bounds, not observed values. */
  maxInputTokens?: number | null;
  maxOutputTokens?: number | null;
  maxCacheReadTokens?: number | null;
  maxCacheCreationTokens?: number | null;
  maxImageOutputTokens?: number | null;
  maxAudioSeconds?: number | null;
  maxCharacters?: number | null;
  maxImages?: number | null;
}

export interface ProviderAdmissionProof {
  /** Server-owned capability result. Caller-supplied proof is never trusted. */
  supported: boolean;
  /** The registered adapter can ask for a pre-call decision for this endpoint. */
  admissionSupported: boolean;
  /** Server registry capability version, retained for audit. */
  capabilityVersion?: string;
  /** The server-side registry marked this request shape as supported. */
  verified: boolean;
  /** Distinguishes server evidence from an SDK assertion in review payloads. */
  source?: "server_registry";
}

export interface ProviderCapabilityDefinition {
  /** Canonical provider name emitted by the server-side provider registry. */
  provider: string;
  capabilityVersion: string;
  /** Optional model families. Omitted means the registered transport can
   * inspect any model; pricing still decides whether money is enforceable. */
  modelPatterns?: string[];
}

export interface ProviderCapabilityRegistry {
  /** Resolve capability without consulting caller-provided booleans. */
  verify(request: Pick<AdmissionRequest, "provider" | "model" | "providerRequest">): ProviderAdmissionProof | null;
  /** Produce review evidence for the console's policy activation screen. */
  review?(provider?: string | null, model?: string | null): Record<string, unknown>;
}

/**
 * Server-owned provider capability registry. This is deliberately separate
 * from the SDK extractor registry: an SDK may claim any integration payload,
 * but only this server registry can authorize an enforced decision. The DSN
 * boundary still cannot stop a process from bypassing CostKey and calling a
 * provider directly; it only refuses unknown transports at this decision hop.
 */
export class StaticProviderCapabilityRegistry implements ProviderCapabilityRegistry {
  private readonly definitions: ProviderCapabilityDefinition[];

  constructor(definitions: ProviderCapabilityDefinition[]) {
    this.definitions = definitions
      .map((definition) => ({
        provider: definition.provider.trim().toLowerCase(),
        capabilityVersion: definition.capabilityVersion.trim(),
        ...(definition.modelPatterns ? { modelPatterns: [...definition.modelPatterns] } : {}),
      }))
      .filter((definition) => definition.provider && definition.capabilityVersion);
  }

  verify(request: Pick<AdmissionRequest, "provider" | "model" | "providerRequest">): ProviderAdmissionProof | null {
    const provider = nonEmptyString(request.provider)?.toLowerCase();
    if (!provider) return null;
    const model = nonEmptyString(request.model);
    const definition = this.definitions.find((candidate) => {
      if (candidate.provider !== provider) return false;
      if (!candidate.modelPatterns || !model) return true;
      return candidate.modelPatterns.some((pattern) => matchesScopePattern(pattern, model));
    });
    if (!definition) return null;
    return {
      supported: true,
      admissionSupported: true,
      capabilityVersion: definition.capabilityVersion,
      verified: true,
      source: "server_registry",
    };
  }

  review(provider?: string | null, model?: string | null): Record<string, unknown> {
    const providerValue = nonEmptyString(provider)?.toLowerCase();
    if (!providerValue) {
      return {
        supported: true,
        admissionSupported: true,
        verified: true,
        capabilityVersion: "server-registry/all-known/1",
        source: "server_registry",
        note: "Known registered transports are eligible; unknown transports refuse at runtime.",
      };
    }
    const modelValue = nonEmptyString(model);
    const candidates = this.definitions.filter((candidate) => matchesScopePattern(providerValue, candidate.provider));
    if (candidates.length === 0) {
      return {
        supported: false,
        admissionSupported: false,
        verified: false,
        source: "server_registry",
        reason: `No server-registered provider capability matches ${providerValue}`,
      };
    }
    if (modelValue && candidates.every((candidate) => candidate.modelPatterns && !candidate.modelPatterns.some((pattern) => matchesScopePattern(pattern, modelValue)))) {
      return {
        supported: false,
        admissionSupported: false,
        verified: false,
        source: "server_registry",
        reason: `No server-registered model capability matches ${providerValue}/${modelValue}`,
      };
    }
    return {
      supported: true,
      admissionSupported: true,
      verified: true,
      capabilityVersion: candidates.length === 1
        ? candidates[0]!.capabilityVersion
        : `server-registry/${providerValue}/1`,
      source: "server_registry",
      provider: providerValue,
      ...(modelValue ? { model: modelValue } : {}),
    };
  }
}

/** Built-in server registry for transports supported by the shipped SDK. */
export const DEFAULT_PROVIDER_CAPABILITY_REGISTRY = new StaticProviderCapabilityRegistry([
  "openai", "anthropic", "google", "openrouter", "bedrock", "groq", "cerebras",
  "fireworks", "together", "xai", "mistral", "deepseek", "cohere", "perplexity",
].map((provider) => ({ provider, capabilityVersion: `server-registry/${provider}/1` })));

export interface AdmissionRequest {
  projectId: string;
  /** Caller-generated idempotency identity for one provider attempt. */
  admissionId: string;
  /** Stable provider request identity; duplicate values never authorize twice. */
  requestId?: string | null;
  provider: string;
  model?: string | null;
  traceId?: string | null;
  executionId?: string | null;
  scope?: PolicyScope;
  context?: Record<string, unknown>;
  integration?: ProviderAdmissionProof;
  usageBounds?: ProviderUsageBounds;
  /** Kept for diagnostics only. It is never used as the reservation amount. */
  claimedCostUsd?: number | null;
  /** Optional adapter-owned provider request shape for proof generation. */
  providerRequest?: unknown;
  now?: Date;
}

export interface ActualUsage {
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  audioSeconds?: number | null;
  characters?: number | null;
  images?: number | null;
}

export interface ObservedPolicyUsage {
  /** Stable event/charge identity; duplicates are no-ops. */
  observationId: string;
  policyId: string;
  windowKey: string;
  unit: PolicyUnit;
  currency?: PolicyCurrency;
  quantity: number | null;
  occurredAt?: Date;
  /** Existing provider event had no price/usage and must not become zero. */
  unknown?: boolean;
  limit: number;
}

export type ObservedUsageSource = (
  policy: SpendingPolicy,
  windowKey: string,
  request: AdmissionRequest,
) => ObservedPolicyUsage[] | Promise<ObservedPolicyUsage[]>;

export interface SettlementInput {
  projectId: string;
  reservationId: string;
  settlementId: string;
  outcome: ReservationOutcome;
  actualCostUsd?: number | null;
  actualUsage?: ActualUsage;
  /**
   * Server-side attestation of the provider result.  Public SDK payloads do
   * not get to populate this field: the HTTP adapter deliberately ignores any
   * similarly named request property.  Keeping the attestation separate from
   * the legacy client fields prevents a caller's `actualCostUsd` from being
   * mistaken for provider evidence and releasing a monetary reservation.
   */
  providerAttestation?: {
    source: "server";
    actualCostUsd?: number | null;
    actualUsage?: ActualUsage;
  };
  /** Explicitly false only when the provider call never started. */
  providerAttempted?: boolean;
  now?: Date;
}

export interface PolicyApplication {
  policyId: string;
  name?: string | null;
  mode: PolicyMode;
  unit: PolicyUnit;
  window: PolicyWindow;
  scope: PolicyScope;
  version?: number | null;
  result: "allow" | "monitor" | "refuse";
  quantity?: number;
}

export type AdmissionRefusalReason =
  | "budget_exhausted"
  | "price_unavailable"
  | "decision_unavailable"
  | "unsupported_integration"
  | "unbounded_request"
  | "missing_context"
  | "idempotency_conflict";

export interface AdmissionRefusal {
  decision: "refuse";
  replay: boolean;
  error: "COSTKEY_POLICY_REFUSED";
  reason: AdmissionRefusalReason;
  message: string;
  policyId?: string;
  policyVersion?: number | null;
  scope?: PolicyScope;
  allowance?: {
    amount: number;
    unit: PolicyUnit;
    currency?: PolicyCurrency;
    window: PolicyWindow;
    timezone: string;
  };
  window?: string;
  retryAt?: string | null;
  policies: PolicyApplication[];
}

export interface AdmissionAllowed {
  decision: "allow";
  replay: boolean;
  reservationId: string | null;
  reservation: ReservationRecord | null;
  policies: PolicyApplication[];
  /** False means no enforced policy matched; monitor mode never blocks. */
  enforcementApplied: boolean;
  /** A replay is an idempotency acknowledgement, not permission for a second provider attempt. */
  providerCallAllowed: boolean;
}

export type AdmissionDecision = AdmissionAllowed | AdmissionRefusal;

export interface PricingQuote {
  currency: "USD";
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  cacheReadUsdPerMillion?: number;
  cacheWriteUsdPerMillion?: number;
  imageOutputUsdPerMillion?: number;
  audioUsdPerSecond?: number;
  charactersUsdPerMillion?: number;
  imagesUsdPerImage?: number;
  /** False means the quote has a known gap and cannot back enforcement. */
  complete?: boolean;
  basis: string;
}

export type PricingResolver = (
  provider: string,
  model: string,
  at: Date,
) => PricingQuote | null | Promise<PricingQuote | null>;

export type BoundVerification =
  | { ok: true; upperBoundUsd: number; basis: string }
  | {
      ok: false;
      reason: "price_unavailable" | "unbounded_request" | "unsupported_integration";
      message: string;
    };

export interface PolicyCatalog {
  list(projectId: string): Promise<SpendingPolicy[]>;
}

export class AdmissionInputError extends Error {
  readonly code = "COSTKEY_ADMISSION_INPUT";

  constructor(message: string) {
    super(message);
    this.name = "AdmissionInputError";
  }
}

export class PolicyRefusalError extends Error {
  readonly code = "COSTKEY_POLICY_REFUSED";
  readonly reason: AdmissionRefusalReason;
  readonly policyId?: string;
  readonly policyVersion?: number | null;
  readonly scope?: PolicyScope;
  readonly allowance?: AdmissionRefusal["allowance"];
  readonly window?: string;
  readonly retryAt?: string | null;
  readonly replay: boolean;
  readonly policies: PolicyApplication[];

  constructor(refusal: AdmissionRefusal) {
    super(refusal.message);
    this.name = "CostKeyPolicyRefusalError";
    this.reason = refusal.reason;
    this.policyId = refusal.policyId;
    this.policyVersion = refusal.policyVersion;
    this.scope = refusal.scope;
    this.allowance = refusal.allowance;
    this.window = refusal.window;
    this.retryAt = refusal.retryAt;
    this.replay = refusal.replay;
    this.policies = refusal.policies;
  }

  toJSON(): AdmissionRefusal {
    return {
      decision: "refuse",
      replay: this.replay,
      error: "COSTKEY_POLICY_REFUSED",
      reason: this.reason,
      message: this.message,
      ...(this.policyId ? { policyId: this.policyId } : {}),
      ...(this.policyVersion !== undefined ? { policyVersion: this.policyVersion } : {}),
      ...(this.scope ? { scope: this.scope } : {}),
      ...(this.allowance ? { allowance: this.allowance } : {}),
      ...(this.window ? { window: this.window } : {}),
      ...(this.retryAt !== undefined ? { retryAt: this.retryAt } : {}),
      policies: this.policies,
    };
  }
}

export class PolicyIdempotencyError extends Error {
  readonly code = "COSTKEY_POLICY_IDEMPOTENCY_CONFLICT";

  constructor(message: string) {
    super(message);
    this.name = "CostKeyPolicyIdempotencyError";
  }
}

export class PolicySettlementError extends Error {
  readonly code = "COSTKEY_POLICY_SETTLEMENT";
  readonly reason: "price_unavailable" | "decision_unavailable";

  constructor(reason: PolicySettlementError["reason"], message: string) {
    super(message);
    this.name = "CostKeyPolicySettlementError";
    this.reason = reason;
  }
}

export class PolicyDecisionUnavailableError extends Error {
  readonly code = "COSTKEY_POLICY_DECISION_UNAVAILABLE";

  constructor(message = "Shared policy accounting is unavailable") {
    super(message);
    this.name = "CostKeyPolicyDecisionUnavailableError";
  }
}

export class PolicyObservedUsageError extends Error {
  readonly code = "COSTKEY_POLICY_OBSERVED_USAGE";
  readonly reason: "price_unavailable" | "decision_unavailable";

  constructor(reason: PolicyObservedUsageError["reason"], message: string) {
    super(message);
    this.name = "CostKeyPolicyObservedUsageError";
    this.reason = reason;
  }
}

function recordKey(projectId: string, admissionId: string): string {
  return `${projectId}\u0000${admissionId}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function dateString(value: unknown): string | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  return nonEmptyString(value);
}

function finiteNonNegative(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return asRecord(value);
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return {};
  }
}

function aliasValue(source: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null) return source[key];
  }
  return undefined;
}

function normalizeUnit(value: unknown): PolicyUnit | null {
  const unit = String(value ?? "").toLowerCase();
  if (unit === "money" || unit === "usd" || unit === "inr" || unit === "amount") return "money";
  if (unit === "calls" || unit === "call" || unit === "requests") return "calls";
  if (unit === "tokens" || unit === "token") return "tokens";
  return null;
}

function normalizeWindow(value: unknown): PolicyWindow | null {
  const window = String(value ?? "").toLowerCase();
  if (["trace", "per_trace", "per-trace"].includes(window)) return "per_trace";
  if (["execution", "per_execution", "per-execution"].includes(window)) return "per_execution";
  if (["minute", "rolling_minute", "calendar_minute", "calls_per_minute", "tokens_per_minute"].includes(window)) return "calendar_minute";
  if (["day", "daily", "calendar_day"].includes(window)) return "calendar_day";
  if (["month", "monthly", "calendar_month"].includes(window)) return "calendar_month";
  return null;
}

function normalizeMode(value: unknown, row: Record<string, unknown>): PolicyMode {
  const mode = String(value ?? "").toLowerCase();
  if (mode === "enforce" || mode === "enforced" || mode === "block" || row.enforced === true) return "enforce";
  // Legacy on_exceed is alert configuration, not an enforcement opt-in. The
  // default remains monitor; installing the SDK never changes old rules.
  return "monitor";
}

function normalizeStatus(value: unknown, row: Record<string, unknown>): PolicyStatus {
  if (row.archived === true || String(value).toLowerCase() === "archived") return "archived";
  if (row.enabled === false || String(value).toLowerCase() === "paused") return "paused";
  return "active";
}

export function normalizeSpendingPolicy(row: Record<string, unknown>): SpendingPolicy {
  const scopeRaw = parseJsonObject(row.scope);
  const scope: PolicyScope = {};
  for (const key of POLICY_SCOPE_KEYS) {
    const value = nonEmptyString(aliasValue(scopeRaw, key, key === "function" ? "functionName" : key));
    if (value) scope[key] = value;
  }
  const legacyScope: Array<[PolicyScopeKey, string[]]> = [
    ["feature", ["scope_feature", "feature_id"]],
    ["customer", ["scope_customer", "customer_id"]],
    ["function", ["scope_function", "function_glob", "function_name"]],
    ["provider", ["scope_provider"]],
    ["model", ["scope_model", "model_glob"]],
    ["group", ["scope_group", "group_name"]],
    ["agent", ["scope_agent", "agent_name"]],
    ["tool", ["scope_tool", "tool_name"]],
  ];
  for (const [key, aliases] of legacyScope) {
    if (!scope[key]) {
      const value = nonEmptyString(aliasValue(row, ...aliases));
      if (value) scope[key] = value;
    }
  }

  const daily = finiteNonNegative(aliasValue(row, "dailyUsd", "daily_usd"));
  const monthly = finiteNonNegative(aliasValue(row, "monthlyUsd", "monthly_usd"));
  const cpm = finiteNonNegative(aliasValue(row, "callsPerMinute", "calls_per_minute"));
  const tpm = finiteNonNegative(aliasValue(row, "tokensPerMinute", "tokens_per_minute"));
  const rawUnit = aliasValue(row, "unit", "allowance_unit");
  const normalizedUnit = normalizeUnit(rawUnit);
  const unit = normalizedUnit ?? (tpm != null ? "tokens" : cpm != null ? "calls" : "money");
  const rawWindow = aliasValue(row, "window", "window_kind", "period", "reset");
  const normalizedWindow = normalizeWindow(rawWindow);
  const window = normalizedWindow
    ?? (daily != null ? "calendar_day" : monthly != null ? "calendar_month" : "calendar_minute");
  const allowanceInput = aliasValue(
    row,
    "allowance",
    "limit",
    "limit_amount",
    "amount",
    unit === "tokens" ? "tokens_per_minute" : unit === "calls" ? "calls_per_minute" : window === "calendar_month" ? "monthly_usd" : "daily_usd",
  );
  const parsedAllowance = finiteNonNegative(allowanceInput);
  const allowance = parsedAllowance ?? 0;
  const currencyValue = String(aliasValue(row, "currency", "allowance_currency", "reporting_currency") ?? "USD").toUpperCase();
  const currency: PolicyCurrency = currencyValue === "INR" ? "INR" : "USD";
  const timezone = nonEmptyString(aliasValue(row, "timezone", "reset_timezone")) ?? "UTC";
  const periodStartValue = String(aliasValue(row, "periodStart", "period_start", "period_start_mode", "window_start_mode") ?? "calendar").toLowerCase();
  const periodStart: PolicyPeriodStart = periodStartValue === "activation" ? "activation" : "calendar";
  const activatedAt = dateString(aliasValue(row, "activatedAt", "activated_at"));
  const projectIdValue = nonEmptyString(aliasValue(row, "projectId", "project_id"));
  const idValue = nonEmptyString(aliasValue(row, "id", "policy_id", "rule_id"));
  const projectId = projectIdValue ?? "";
  const id = idValue ?? "";
  const fx = finiteNonNegative(aliasValue(row, "usdToPolicyCurrency", "usd_to_policy_currency", "conversion_rate"));
  const fxRate = finiteNonNegative(aliasValue(row, "fxRate", "fx_rate"));
  const effectiveFx = fxRate ?? fx;
  const fxSource = nonEmptyString(aliasValue(row, "fxSource", "fx_source"));
  const fxAsOf = dateString(aliasValue(row, "fxAsOf", "fx_as_of"));
  const version = finiteNonNegative(aliasValue(row, "version", "policy_version"));
  return {
    id,
    projectId,
    name: nonEmptyString(aliasValue(row, "name", "policy_name")),
    scope,
    mode: normalizeMode(aliasValue(row, "mode", "enforcement_mode"), row),
    status: normalizeStatus(aliasValue(row, "status", "state"), row),
    unit,
    allowance: unit === "tokens" && tpm != null && rawUnit == null ? tpm : unit === "calls" && cpm != null && rawUnit == null ? cpm : allowance,
    currency,
    window,
    timezone,
    periodStart,
    activatedAt,
    ...(effectiveFx != null ? { usdToPolicyCurrency: effectiveFx } : {}),
    ...(fxSource != null ? { fxSource } : {}),
    ...(fxAsOf != null ? { fxAsOf } : {}),
    ...(version != null ? { version } : {}),
    ...(row.capability_review != null || row.capabilityReview != null
      ? { capabilityReview: parseJsonObject(row.capability_review ?? row.capabilityReview) }
      : {}),
    createdAt: dateString(aliasValue(row, "createdAt", "created_at")),
    updatedAt: dateString(aliasValue(row, "updatedAt", "updated_at")),
    valid: normalizedUnit != null || rawUnit == null
      ? (normalizedWindow != null || rawWindow == null)
        && (currencyValue === "USD" || currencyValue === "INR")
        && (periodStartValue === "calendar" || periodStartValue === "activation")
        && (parsedAllowance != null || daily != null || monthly != null || cpm != null || tpm != null)
        && projectIdValue != null
        && idValue != null
      : false,
  };
}

export class StaticPolicyCatalog implements PolicyCatalog {
  private readonly policies: SpendingPolicy[];

  constructor(policies: Array<SpendingPolicy | Record<string, unknown>>) {
    this.policies = policies.map((row) => normalizeSpendingPolicy(row as Record<string, unknown>));
  }

  async list(projectId: string): Promise<SpendingPolicy[]> {
    return this.policies.filter((policy) => policy.projectId === projectId).map((policy) => ({
      ...policy,
      scope: { ...policy.scope },
    }));
  }
}

export class PostgresPolicyCatalog implements PolicyCatalog {
  constructor(private readonly pool: pg.Pool) {}

  async list(projectId: string): Promise<SpendingPolicy[]> {
    let canonical: SpendingPolicy[];
    try {
      const result = await this.pool.query(
        `SELECT * FROM spending_policies
         WHERE project_id = $1 AND COALESCE(status, 'active') IN ('active', 'paused')
         ORDER BY id ASC`,
        [projectId],
      );
      canonical = result.rows.map((row) => normalizeSpendingPolicy(row));
    } catch (error) {
      // Existing installations may only have legacy budget_rules until the
      // accounting migration is applied. Preserve monitor/explicit block
      // behavior, but still route enforce requests through the shared ledger.
      if ((error as { code?: string })?.code !== "42P01") throw error;
      const legacy = await this.pool.query(
        `SELECT * FROM budget_rules WHERE project_id = $1 AND enabled = TRUE ORDER BY id ASC`,
        [projectId],
      );
      return legacy.rows.map((row) => normalizeSpendingPolicy(row));
    }
    // During the additive rollout both tables may exist. Keep old rules
    // visible until the console has migrated them; a canonical id wins if a
    // row was explicitly mirrored by a migration. A new installation may
    // omit the legacy table entirely.
    try {
      const legacy = await this.pool.query(
        `SELECT * FROM budget_rules WHERE project_id = $1 AND enabled = TRUE ORDER BY id ASC`,
        [projectId],
      );
      const seen = new Set(canonical.map((policy) => policy.id));
      return [...canonical, ...legacy.rows
        .map((row) => normalizeSpendingPolicy(row))
        .filter((policy) => !seen.has(policy.id))];
    } catch (error) {
      if ((error as { code?: string })?.code !== "42P01") throw error;
      return canonical;
    }
  }
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [key, stableValue(entry)]));
  }
  return value;
}

export function admissionFingerprint(request: AdmissionRequest): string {
  const comparable = {
    projectId: request.projectId,
    requestId: request.requestId ?? null,
    provider: request.provider,
    model: request.model ?? null,
    traceId: request.traceId ?? null,
    executionId: request.executionId ?? null,
    scope: request.scope ?? {},
    context: request.context ?? {},
    integration: request.integration ?? null,
    usageBounds: request.usageBounds ?? null,
    providerRequest: request.providerRequest ?? null,
  };
  return createHash("sha256").update(JSON.stringify(stableValue(comparable))).digest("hex");
}

export function settlementFingerprint(input: SettlementInput): string {
  return createHash("sha256").update(JSON.stringify(stableValue({
    reservationId: input.reservationId,
    settlementId: input.settlementId,
    outcome: input.outcome,
    actualCostUsd: input.actualCostUsd ?? null,
    actualUsage: input.actualUsage ?? null,
    providerAttestation: input.providerAttestation ?? null,
    providerAttempted: input.providerAttempted ?? null,
  }))).digest("hex");
}

function validTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}

function localDateParts(at: Date, timezone: string): Record<string, string> {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  return Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
}

/** Return a calendar/identity key, never a rolling-24-hour approximation. */
export function policyWindowKey(
  policy: Pick<SpendingPolicy, "window" | "timezone">,
  at: Date,
  identity?: { traceId?: string | null; executionId?: string | null },
): string {
  if (!validTimezone(policy.timezone)) throw new AdmissionInputError(`Invalid policy timezone: ${policy.timezone}`);
  if (policy.window === "per_trace") {
    if (!identity?.traceId) throw new AdmissionInputError("A per-trace policy requires traceId at admission");
    return `trace:${identity.traceId}`;
  }
  if (policy.window === "per_execution") {
    if (!identity?.executionId) throw new AdmissionInputError("A per-execution policy requires executionId at admission");
    return `execution:${identity.executionId}`;
  }
  const local = localDateParts(at, policy.timezone);
  const date = `${local.year}-${local.month}-${local.day}`;
  if (policy.window === "calendar_month") return `${local.year}-${local.month}`;
  if (policy.window === "calendar_day") return date;
  return `${date}T${local.hour}:${local.minute}`;
}

export interface PolicyWindowBounds {
  from: Date | null;
  to: Date | null;
}

/** Exact UTC bounds for a policy window, found through the same timezone key. */
export function policyWindowBounds(
  policy: Pick<SpendingPolicy, "window" | "timezone">,
  at: Date,
  identity?: { traceId?: string | null; executionId?: string | null },
): PolicyWindowBounds {
  if (policy.window === "per_trace" || policy.window === "per_execution") return { from: null, to: null };
  const current = policyWindowKey(policy, at);
  const minute = 60_000;
  const maxMinutes = policy.window === "calendar_month" ? 46 * 24 * 60 : policy.window === "calendar_day" ? 3 * 24 * 60 : 3;
  const inWindow = (time: number) => policyWindowKey(policy, new Date(time)) === current;
  // Window keys only change once in each direction, so the edges can be
  // found by bisecting minutes instead of formatting every minute in a month.
  const edge = (inside: number, outside: number): number => {
    if (inWindow(outside)) return outside;
    while (Math.abs(outside - inside) > minute) {
      const mid = inside + Math.trunc((outside - inside) / minute / 2) * minute;
      if (inWindow(mid)) inside = mid;
      else outside = mid;
    }
    return outside;
  };
  const start = Math.floor(at.getTime() / minute) * minute;
  const before = edge(start, start - maxMinutes * minute);
  const from = inWindow(before) ? before : before + minute;
  const to = edge(Math.max(start, from), from + (maxMinutes + 1) * minute);
  return { from: new Date(from), to: new Date(to) };
}

function globToRegExp(pattern: string): RegExp {
  let source = "^";
  for (const char of pattern) {
    if (char === "*") source += ".*";
    else if (char === "?") source += ".";
    else source += /[\\^$+?.()|{}[\]]/.test(char) ? `\\${char}` : char;
  }
  return new RegExp(`${source}$`, "i");
}

function matchesScopePattern(pattern: string, actual: string): boolean {
  try {
    return globToRegExp(pattern).test(actual);
  } catch {
    return false;
  }
}

function requestScope(request: AdmissionRequest): PolicyScope {
  const scope: PolicyScope = { ...(request.scope ?? {}) };
  const context = asRecord(request.context);
  const aliases: Record<PolicyScopeKey, string[]> = {
    feature: ["feature", "featureName"],
    customer: ["customer", "customerId"],
    function: ["function", "functionName", "scopeFunction"],
    provider: ["provider"],
    model: ["model"],
    group: ["group", "groupName", "executionGroup"],
    agent: ["agent", "agentName"],
    tool: ["tool", "toolName"],
  };
  for (const key of POLICY_SCOPE_KEYS) {
    if (scope[key]) continue;
    for (const alias of aliases[key]) {
      const value = nonEmptyString(context[alias]);
      if (value) {
        scope[key] = value;
        break;
      }
    }
  }
  if (!scope.provider) scope.provider = nonEmptyString(request.provider) ?? undefined;
  if (!scope.model) scope.model = nonEmptyString(request.model) ?? undefined;
  return scope;
}

type ScopeMatch = "match" | "no-match" | "unknown";

function matchScope(policy: SpendingPolicy, request: AdmissionRequest): ScopeMatch {
  const actual = requestScope(request);
  for (const key of POLICY_SCOPE_KEYS) {
    const pattern = policy.scope[key];
    if (!pattern) continue;
    const value = actual[key];
    if (!value) return "unknown";
    if (!matchesScopePattern(pattern, value)) return "no-match";
  }
  return "match";
}

function globLike(pattern: string): string {
  return pattern
    .replace(/\\/g, "\\\\")
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_")
    .replace(/\*/g, "%")
    .replace(/\?/g, "_");
}

function observedCanonicalScope(policy: SpendingPolicy, projectId: string): { clauses: string[]; params: unknown[] } {
  const clauses = ["c.project_id = $1"];
  const params: unknown[] = [projectId];
  let index = 1;
  const add = (expression: string, value: string): void => {
    index += 1;
    clauses.push(`${expression} LIKE $${index} ESCAPE '\\'`);
    params.push(globLike(value));
  };
  if (policy.scope.feature) add("COALESCE(c.context->>'feature', '')", policy.scope.feature);
  if (policy.scope.customer) add("COALESCE(c.context->>'customer', c.context->>'customerId', '')", policy.scope.customer);
  if (policy.scope.function) {
    index += 1;
    params.push(globLike(policy.scope.function));
    clauses.push(`(COALESCE(c.bl_file, '') || ':' || COALESCE(c.bl_function, '') LIKE $${index} ESCAPE '\\' OR COALESCE(c.bl_function, '') LIKE $${index} ESCAPE '\\')`);
  }
  if (policy.scope.provider) add("COALESCE(c.provider, '')", policy.scope.provider);
  if (policy.scope.model) add("COALESCE(c.model, '')", policy.scope.model);
  if (policy.scope.group) add("COALESCE(c.group_name, c.context->>'group', '')", policy.scope.group);
  if (policy.scope.agent) add("COALESCE(c.context->>'agent', '')", policy.scope.agent);
  if (policy.scope.tool) add("COALESCE(c.context->>'tool', '')", policy.scope.tool);
  return { clauses, params };
}

/**
 * Default observed-charge source for the Pg service. It reads the canonical
 * reconciled charge cohort (automatic calls plus active/delta explicit usage)
 * and preserves unknown cost/usage as unknown instead of coercing it to zero.
 */
export function createPostgresObservedUsageSource(pool: pg.Pool): ObservedUsageSource {
  return async (policy, windowKey, request) => {
    let bounds: PolicyWindowBounds;
    try {
      bounds = policyWindowBounds(policy, request.now ?? new Date(), { traceId: request.traceId, executionId: request.executionId });
    } catch {
      return [];
    }
    const scoped = observedCanonicalScope(policy, request.projectId);
    const clauses = [...scoped.clauses];
    const params = [...scoped.params];
    let index = params.length;
    if (policy.window === "per_trace") {
      index += 1;
      clauses.push(`c.trace_id = $${index}`);
      params.push(request.traceId ?? "");
    } else if (policy.window === "per_execution") {
      index += 1;
      clauses.push(`c.execution_id = $${index}`);
      params.push(request.executionId ?? "");
    } else if (bounds.from && bounds.to) {
      index += 1;
      clauses.push(`c.timestamp >= $${index}`);
      params.push(bounds.from.toISOString());
      index += 1;
      clauses.push(`c.timestamp < $${index}`);
      params.push(new Date(Math.min(bounds.to.getTime(), (request.now ?? new Date()).getTime() + 1)).toISOString());
    }
    // An activation-start policy is explicit opt-in: retain only observed
    // charges that happened at/after its activation instant. Calendar-start
    // policies intentionally have no such cutoff and carry prior spend in
    // the current calendar window.
    if (policy.periodStart === "activation") {
      const activatedAt = policy.activatedAt ? new Date(policy.activatedAt) : null;
      if (activatedAt && Number.isFinite(activatedAt.getTime())) {
        index += 1;
        clauses.push(`c.timestamp >= $${index}`);
        params.push(activatedAt.toISOString());
      }
    }
    // An admitted SDK attempt is settled separately. Exclude its automatic
    // event from the canonical backfill so late ingest cannot count the same
    // charge again. `charges` already reconciles automatic calls with active
    // explicit usage (and handles cumulative revisions/delta identities).
    index += 1;
    clauses.push(`NOT EXISTS (
      SELECT 1
      FROM events admitted
      JOIN policy_reservations r ON r.project_id = admitted.project_id
      WHERE admitted.project_id = c.project_id
        AND COALESCE(admitted.charge_id, admitted.id) = c.charge_key
        AND (r.admission_id = admitted.attempt_id OR r.request_id = admitted.attempt_id)
        AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(r.lines) reservation_line
          WHERE reservation_line->>'policyId' = $${index}
        )
    )`);
    params.push(policy.id);
    const result = await pool.query(
      `${chargesCte()}
       SELECT c.record_id, c.charge_key, c.timestamp, c.record_type,
              c.cost_usd, c.cost_currency, c.total_tokens,
              c.input_tokens, c.output_tokens, c.unit_value, c.unit,
              c.unit_kind, u.amount AS explicit_amount,
              u.currency AS explicit_currency
       FROM charges c
       LEFT JOIN usage_components u
         ON c.record_type = 'usage'
        AND u.project_id = c.project_id AND u.id = c.record_id
       WHERE ${clauses.join(" AND ")}
       ORDER BY c.timestamp ASC, c.record_id ASC`,
      params,
    );
    return result.rows.map((row) => {
      const cost = row.cost_usd == null ? null : Number(row.cost_usd);
      const explicitAmount = row.explicit_amount == null ? null : Number(row.explicit_amount);
      const explicitCurrency = row.explicit_currency == null ? null : String(row.explicit_currency).toUpperCase();
      const tokens = row.total_tokens != null
        ? Number(row.total_tokens)
        : row.input_tokens != null && row.output_tokens != null
          ? Number(row.input_tokens) + Number(row.output_tokens)
          : null;
      const recordType = String(row.record_type ?? "call");
      const explicitUnit = row.unit_value == null ? null : Number(row.unit_value);
      const unitKind = String(row.unit_kind ?? row.unit ?? "").toLowerCase();
      const tokenUnit = unitKind === "token" || unitKind === "tokens"
        || unitKind === "input_tokens" || unitKind === "output_tokens";
      const nativeTokens = recordType === "usage" && tokenUnit
        ? explicitUnit
        : tokens;
      const usdQuantity = policy.unit === "calls"
        ? recordType === "call" ? 1 : null
        : policy.unit === "tokens"
          ? Number.isFinite(nativeTokens) && nativeTokens != null && nativeTokens >= 0 ? nativeTokens : null
          : Number.isFinite(cost) && cost != null && cost >= 0
            ? cost
            : Number.isFinite(explicitAmount) && explicitAmount != null && explicitAmount >= 0 && explicitCurrency === "USD"
              ? explicitAmount
              : null;
      let quantity = usdQuantity;
      if (policy.unit === "money" && explicitCurrency === policy.currency && Number.isFinite(explicitAmount) && explicitAmount != null && explicitAmount >= 0) {
        // Preserve an explicit provider amount in its native policy currency.
        // The canonical CTE intentionally leaves non-USD `cost_usd` NULL.
        quantity = explicitAmount;
      } else if (policy.unit === "money" && policy.currency === "INR") {
        quantity = usdQuantity != null && policy.usdToPolicyCurrency != null
          ? usdQuantity * policy.usdToPolicyCurrency
          : null;
      }
      return {
        // Charge identity, rather than whichever event revision currently
        // wins the CTE, keeps late pricing corrections idempotent.
        observationId: String(row.charge_key ?? row.record_id),
        policyId: policy.id,
        windowKey,
        unit: policy.unit,
        ...(policy.unit === "money" ? { currency: policy.currency ?? "USD" } : {}),
        // `quantity` is already in the policy currency above. Do not apply
        // the INR FX snapshot a second time here; a second multiplication
        // would turn a $0.90 observed charge into 0.90*80*80 INR.
        quantity,
        unknown: quantity == null,
        limit: policy.allowance,
        occurredAt: row.timestamp instanceof Date ? row.timestamp : new Date(String(row.timestamp)),
      } satisfies ObservedPolicyUsage;
    });
  };
}

function normalizeBounds(request: AdmissionRequest): ProviderUsageBounds {
  const raw = asRecord(request.usageBounds);
  const fromProviderRequest = asRecord(request.providerRequest);
  const read = (...keys: string[]): number | null | undefined => {
    const value = aliasValue(raw, ...keys);
    if (value !== undefined) return value as number | null;
    const nested = aliasValue(fromProviderRequest, ...keys);
    return nested === undefined ? undefined : nested as number | null;
  };
  return {
    maxInputTokens: read("maxInputTokens", "max_input_tokens", "inputTokens", "input_tokens"),
    maxOutputTokens: read("maxOutputTokens", "max_output_tokens", "max_tokens", "max_completion_tokens", "outputTokens", "output_tokens"),
    maxCacheReadTokens: read("maxCacheReadTokens", "max_cache_read_tokens"),
    maxCacheCreationTokens: read("maxCacheCreationTokens", "max_cache_creation_tokens"),
    maxImageOutputTokens: read("maxImageOutputTokens", "max_image_output_tokens", "imageOutputTokens", "image_output_tokens"),
    maxAudioSeconds: read("maxAudioSeconds", "max_audio_seconds", "audioSeconds", "audio_seconds"),
    maxCharacters: read("maxCharacters", "max_characters", "characters"),
    maxImages: read("maxImages", "max_images", "images"),
  };
}

function boundValue(value: number | null | undefined, name: string): BoundVerification | number {
  if (value == null) return { ok: false, reason: "unbounded_request", message: `${name} upper bound is required for enforced monetary admission` };
  if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    return { ok: false, reason: "unbounded_request", message: `${name} upper bound must be finite and non-negative` };
  }
  return value;
}

/**
 * Verify an upper bound from a registered provider adapter and server pricing.
 * `claimedCostUsd` is intentionally absent: client-computed currency amounts
 * cannot establish a hard bound for an external provider call.
 */
export async function verifyProviderCostBound(
  request: AdmissionRequest,
  resolvePricing: PricingResolver | undefined,
  capabilities: ProviderCapabilityRegistry = DEFAULT_PROVIDER_CAPABILITY_REGISTRY,
): Promise<BoundVerification> {
  const serverCapability = capabilities.verify(request);
  if (!serverCapability?.supported || !serverCapability.admissionSupported || !serverCapability.verified) {
    return {
      ok: false,
      reason: "unsupported_integration",
      message: "This provider transport is not registered for enforced admission",
    };
  }
  const provider = nonEmptyString(request.provider);
  const model = nonEmptyString(request.model);
  if (!provider || !model) return { ok: false, reason: "price_unavailable", message: "Provider and model are required for enforced monetary admission" };
  if (!resolvePricing) return { ok: false, reason: "price_unavailable", message: "No server pricing verifier is available" };
  const quote = await resolvePricing(provider, model, request.now ?? new Date());
  if (!quote || quote.currency !== "USD" || quote.complete === false || !nonEmptyString(quote.basis)) {
    return { ok: false, reason: "price_unavailable", message: `No complete server pricing basis is available for ${provider}/${model}` };
  }
  for (const [value, name] of [
    [quote.inputUsdPerMillion, "input price"],
    [quote.outputUsdPerMillion, "output price"],
  ] as Array<[number, string]>) {
    if (!Number.isFinite(value) || value < 0) return { ok: false, reason: "price_unavailable", message: `Invalid ${name} in server pricing basis` };
  }
  const bounds = normalizeBounds(request);
  const input = boundValue(bounds.maxInputTokens, "maxInputTokens");
  if (typeof input !== "number") return input;
  const outputResult = bounds.maxOutputTokens == null && quote.outputUsdPerMillion === 0
    ? 0
    : boundValue(bounds.maxOutputTokens, "maxOutputTokens");
  if (typeof outputResult !== "number") return outputResult;
  let amount = (input * Math.max(
    quote.inputUsdPerMillion,
    quote.cacheReadUsdPerMillion ?? 0,
    quote.cacheWriteUsdPerMillion ?? 0,
  ) + outputResult * quote.outputUsdPerMillion) / 1_000_000;

  if (bounds.maxCacheReadTokens != null) {
    const cacheRead = boundValue(bounds.maxCacheReadTokens, "maxCacheReadTokens");
    if (typeof cacheRead !== "number") return cacheRead;
    amount += cacheRead * (quote.cacheReadUsdPerMillion ?? Math.max(quote.inputUsdPerMillion, quote.outputUsdPerMillion)) / 1_000_000;
  }
  if (bounds.maxCacheCreationTokens != null) {
    const cacheWrite = boundValue(bounds.maxCacheCreationTokens, "maxCacheCreationTokens");
    if (typeof cacheWrite !== "number") return cacheWrite;
    amount += cacheWrite * (quote.cacheWriteUsdPerMillion ?? Math.max(quote.inputUsdPerMillion, quote.outputUsdPerMillion)) / 1_000_000;
  }
  if (quote.imageOutputUsdPerMillion != null) {
    const image = boundValue(bounds.maxImageOutputTokens, "maxImageOutputTokens");
    if (typeof image !== "number") return image;
    if (!Number.isFinite(quote.imageOutputUsdPerMillion) || quote.imageOutputUsdPerMillion < 0) {
      return { ok: false, reason: "price_unavailable", message: "Invalid image pricing basis" };
    }
    amount += image * quote.imageOutputUsdPerMillion / 1_000_000;
  }
  if (bounds.maxAudioSeconds != null) {
    const audio = boundValue(bounds.maxAudioSeconds, "maxAudioSeconds");
    if (typeof audio !== "number") return audio;
    if (quote.audioUsdPerSecond == null) return { ok: false, reason: "price_unavailable", message: "Audio pricing is not available for enforced admission" };
    amount += audio * quote.audioUsdPerSecond;
  }
  if (bounds.maxCharacters != null) {
    const chars = boundValue(bounds.maxCharacters, "maxCharacters");
    if (typeof chars !== "number") return chars;
    if (quote.charactersUsdPerMillion == null) return { ok: false, reason: "price_unavailable", message: "Character pricing is not available for enforced admission" };
    amount += chars * quote.charactersUsdPerMillion / 1_000_000;
  }
  if (bounds.maxImages != null) {
    const images = boundValue(bounds.maxImages, "maxImages");
    if (typeof images !== "number") return images;
    if (quote.imagesUsdPerImage == null) return { ok: false, reason: "price_unavailable", message: "Image request pricing is not available for enforced admission" };
    amount += images * quote.imagesUsdPerImage;
  }
  if (!Number.isFinite(amount) || amount < 0) return { ok: false, reason: "price_unavailable", message: "Server could not establish a finite monetary upper bound" };
  return { ok: true, upperBoundUsd: amount, basis: quote.basis };
}

function quantityForPolicy(
  policy: SpendingPolicy,
  request: AdmissionRequest,
  monetaryUpperBoundUsd: number | null,
  at = request.now ?? new Date(),
): { quantity: number; currency?: PolicyCurrency; currencyRate?: number; currencySource?: string | null; currencyAsOf?: string | null } | { reason: AdmissionRefusalReason; message: string } {
  if (policy.unit === "money") {
    if (monetaryUpperBoundUsd == null) return { reason: "price_unavailable", message: "A monetary upper bound is required for an enforced money policy" };
    const rate = policy.currency === "USD" || policy.currency == null
      ? 1
      : policy.usdToPolicyCurrency;
    if (rate == null || !Number.isFinite(rate) || rate <= 0) return { reason: "decision_unavailable", message: `No server conversion basis is available for ${policy.currency} allowance` };
    if (policy.currency === "INR" && (!policy.fxSource || !policy.fxAsOf || !Number.isFinite(new Date(policy.fxAsOf).getTime()) || new Date(policy.fxAsOf).getTime() > at.getTime() + 5 * 60 * 1000)) {
      return { reason: "decision_unavailable", message: "INR enforcement requires a dated server FX source and as-of snapshot" };
    }
    return {
      quantity: monetaryUpperBoundUsd * rate,
      currency: policy.currency ?? "USD",
      currencyRate: rate,
      currencySource: policy.fxSource ?? (policy.currency === "USD" ? "native USD" : null),
      currencyAsOf: policy.fxAsOf ?? null,
    };
  }
  if (policy.unit === "calls") return { quantity: 1 };
  const bounds = normalizeBounds(request);
  const input = bounds.maxInputTokens;
  const output = bounds.maxOutputTokens;
  if (input == null || output == null || !Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) {
    return { reason: "unbounded_request", message: "Token allowance requires finite input and output upper bounds" };
  }
  return { quantity: input + output };
}

function allowanceSnapshot(policy: SpendingPolicy): AdmissionRefusal["allowance"] {
  return {
    amount: policy.allowance,
    unit: policy.unit,
    ...(policy.unit === "money" ? { currency: policy.currency ?? "USD" } : {}),
    window: policy.window,
    timezone: policy.timezone,
  };
}

function nextWindowStart(policy: SpendingPolicy, now: Date): string | null {
  if (policy.window === "per_trace" || policy.window === "per_execution") return null;
  try {
    const current = policyWindowKey(policy, now);
    const maxMinutes = policy.window === "calendar_month" ? 45 * 24 * 60 : policy.window === "calendar_day" ? 3 * 24 * 60 : 3;
    let candidate = new Date(Math.floor(now.getTime() / 60_000) * 60_000 + 60_000);
    for (let minute = 0; minute <= maxMinutes; minute++, candidate = new Date(candidate.getTime() + 60_000)) {
      if (policyWindowKey(policy, candidate) !== current) return candidate.toISOString();
    }
    return null;
  } catch {
    return null;
  }
}

function application(policy: SpendingPolicy, result: PolicyApplication["result"], quantity?: number): PolicyApplication {
  return {
    policyId: policy.id,
    name: policy.name,
    mode: policy.mode,
    unit: policy.unit,
    window: policy.window,
    scope: { ...policy.scope },
    version: policy.version ?? null,
    result,
    ...(quantity == null ? {} : { quantity }),
  };
}

function refusalFor(
  policy: SpendingPolicy | undefined,
  reason: AdmissionRefusalReason,
  message: string,
  now: Date,
  policies: PolicyApplication[],
  replay = false,
): AdmissionRefusal {
  let window: string | undefined;
  if (policy) {
    try {
      // Identity windows cannot be rendered without their identity; the
      // policy/allowance snapshot still explains the refusal.
      if (policy.window !== "per_trace" && policy.window !== "per_execution") {
        window = policyWindowKey(policy, now);
      } else {
        window = policy.window;
      }
    } catch {
      window = undefined;
    }
  }
  return {
    decision: "refuse",
    replay,
    error: "COSTKEY_POLICY_REFUSED",
    reason,
    message,
    ...(policy ? {
      policyId: policy.id,
      policyVersion: policy.version ?? null,
      scope: { ...policy.scope },
      allowance: allowanceSnapshot(policy),
      ...(window ? { window } : {}),
      retryAt: reason === "budget_exhausted" ? nextWindowStart(policy, now) : null,
    } : {}),
    policies,
  };
}

function decisionRecordFor(
  request: AdmissionRequest,
  fingerprint: string,
  decision: AdmissionDecision,
  now: Date,
): DecisionRecord {
  return {
    projectId: request.projectId,
    admissionId: request.admissionId,
    requestId: request.requestId ?? null,
    fingerprint,
    decision: decision.decision,
    policyId: decision.decision === "refuse" ? decision.policyId ?? null : null,
    policyVersion: decision.decision === "refuse" ? decision.policyVersion ?? null : null,
    reservationId: decision.decision === "allow" ? decision.reservationId : null,
    refusal: decision.decision === "refuse" ? {
      reason: decision.reason,
      policyId: decision.policyId,
      policyVersion: decision.policyVersion,
      message: decision.message,
      retryAt: decision.retryAt,
      scope: decision.scope,
      allowance: decision.allowance,
      window: decision.window,
    } : null,
    createdAt: now.toISOString(),
  };
}

function decisionFromRecord(record: DecisionRecord, policies: PolicyApplication[], replay: boolean): AdmissionDecision {
  if (record.decision === "refuse") {
    const refusal: NonNullable<DecisionRecord["refusal"]> = record.refusal ?? {
      reason: "decision_unavailable",
      message: "The earlier policy decision was incomplete",
    };
    return {
      decision: "refuse",
      replay,
      error: "COSTKEY_POLICY_REFUSED",
      reason: refusal.reason as AdmissionRefusalReason,
      message: refusal.message,
      ...(refusal.policyId ? { policyId: refusal.policyId } : {}),
      ...(refusal.policyId && refusal.policyVersion !== undefined ? { policyVersion: refusal.policyVersion } : {}),
      ...(refusal.scope ? { scope: refusal.scope as PolicyScope } : {}),
      ...(refusal.allowance ? { allowance: refusal.allowance as AdmissionRefusal["allowance"] } : {}),
      ...(typeof refusal.window === "string" ? { window: refusal.window } : {}),
      ...(refusal.retryAt !== undefined ? { retryAt: refusal.retryAt } : {}),
      policies,
    };
  }
  return {
    decision: "allow",
    replay,
    reservationId: record.reservationId,
    reservation: null,
    policies,
    enforcementApplied: Boolean(record.reservationId),
    providerCallAllowed: false,
  };
}

export interface PolicyAdmissionServiceOptions {
  catalog: PolicyCatalog;
  store: ReservationStore;
  pricing?: PricingResolver;
  observedUsage?: ObservedUsageSource;
  clock?: () => Date;
  /** Server-owned provider capability registry; never sourced from request JSON. */
  capabilities?: ProviderCapabilityRegistry;
}

export class PolicyAdmissionService {
  private readonly clock: () => Date;
  private readonly capabilities: ProviderCapabilityRegistry;

  constructor(private readonly options: PolicyAdmissionServiceOptions) {
    this.clock = options.clock ?? (() => new Date());
    this.capabilities = options.capabilities ?? DEFAULT_PROVIDER_CAPABILITY_REGISTRY;
  }

  private async saveDecision(record: DecisionRecord): Promise<void> {
    try {
      await this.options.store.recordDecision(record);
    } catch (error) {
      throw new PolicyDecisionUnavailableError(error instanceof Error ? error.message : undefined);
    }
  }

  private async settleStore(input: Parameters<ReservationStore["settle"]>[0]): Promise<SettlementResult> {
    try {
      return await this.options.store.settle(input);
    } catch (error) {
      if (error instanceof SettlementConflictError || error instanceof SettlementNotFoundError) throw error;
      throw new PolicyDecisionUnavailableError(error instanceof Error ? error.message : undefined);
    }
  }

  async recordObserved(input: ObservedPolicyUsage): Promise<{ recorded: boolean }> {
    if (input.quantity == null && !input.unknown) {
      throw new PolicySettlementError(
        input.unit === "money" ? "price_unavailable" : "decision_unavailable",
        "Observed usage remains unknown and cannot be treated as zero",
      );
    }
    if (!this.options.store.recordObserved) throw new PolicyDecisionUnavailableError("Observed policy accounting is unavailable");
    try {
      return await this.options.store.recordObserved({
        observationId: input.observationId,
        policyId: input.policyId,
        windowKey: input.windowKey,
        unit: input.unit,
        currency: input.currency,
        quantity: input.quantity,
        unknown: input.unknown,
        limit: input.limit,
        occurredAt: input.occurredAt,
      });
    } catch (error) {
      if (error instanceof ReservationConflictError || error instanceof SettlementNotFoundError) throw error;
      throw new PolicyDecisionUnavailableError(error instanceof Error ? error.message : undefined);
    }
  }

  private async backfillObserved(policy: SpendingPolicy, windowKey: string, request: AdmissionRequest): Promise<void> {
    if (!this.options.observedUsage) return;
    const activationAt = policy.periodStart === "activation"
      ? policy.activatedAt ? new Date(policy.activatedAt) : null
      : null;
    if (policy.periodStart === "activation" && (!activationAt || !Number.isFinite(activationAt.getTime()))) {
      throw new PolicyDecisionUnavailableError(`Activation-start policy ${policy.id} has no valid activation timestamp`);
    }
    let observations: ObservedPolicyUsage[];
    try {
      observations = await this.options.observedUsage(policy, windowKey, request);
    } catch (error) {
      throw new PolicyDecisionUnavailableError(error instanceof Error ? error.message : undefined);
    }
    for (const observation of observations) {
      if (observation.policyId !== policy.id || observation.windowKey !== windowKey || observation.unit !== policy.unit) {
        throw new PolicyDecisionUnavailableError("Observed usage source returned a mismatched policy identity");
      }
      if (activationAt && observation.occurredAt) {
        const occurredAt = observation.occurredAt instanceof Date ? observation.occurredAt : new Date(observation.occurredAt);
        if (!Number.isFinite(occurredAt.getTime())) {
          throw new PolicyDecisionUnavailableError("Observed usage source returned an invalid occurrence timestamp");
        }
        if (occurredAt.getTime() < activationAt.getTime()) continue;
      }
      if (observation.quantity == null) {
        throw new PolicyObservedUsageError(
          policy.unit === "money" ? "price_unavailable" : "decision_unavailable",
          `Observed ${policy.unit} usage is unknown for ${policy.id}; enforced admission cannot assume zero`,
        );
      }
      await this.recordObserved(observation);
    }
  }

  async listPolicies(projectId: string): Promise<SpendingPolicy[]> {
    try {
      return await this.options.catalog.list(projectId);
    } catch (error) {
      throw new PolicyDecisionUnavailableError(error instanceof Error ? error.message : undefined);
    }
  }

  async admit(input: AdmissionRequest): Promise<AdmissionDecision> {
    const now = input.now instanceof Date ? new Date(input.now.getTime()) : this.clock();
    if (!Number.isFinite(now.getTime())) throw new AdmissionInputError("Admission time must be a valid date");
    const request = { ...input, now };
    if (!request.projectId || !request.admissionId || !request.provider) throw new AdmissionInputError("projectId, admissionId and provider are required");
    const fingerprint = admissionFingerprint(request);
    let previous: DecisionRecord | null;
    try {
      previous = await this.options.store.getDecision(request.projectId, request.admissionId, request.requestId);
    } catch (error) {
      throw new PolicyDecisionUnavailableError(error instanceof Error ? error.message : undefined);
    }
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new PolicyIdempotencyError("Admission identity was reused with different request data");
      let policies: SpendingPolicy[];
      try {
        policies = await this.options.catalog.list(request.projectId);
      } catch (error) {
        throw new PolicyDecisionUnavailableError(error instanceof Error ? error.message : undefined);
      }
      return decisionFromRecord(previous, policies.map((policy) => application(
        policy,
        previous.refusal?.policyId === policy.id ? "refuse" : policy.mode === "monitor" ? "monitor" : "allow",
      )), true);
    }

    let policies: SpendingPolicy[];
    try {
      policies = await this.options.catalog.list(request.projectId);
    } catch (error) {
      throw new PolicyDecisionUnavailableError(error instanceof Error ? error.message : undefined);
    }
    const applications: PolicyApplication[] = [];
    const enforced: Array<{ policy: SpendingPolicy; quantity: number; currency?: PolicyCurrency; currencyRate?: number; currencySource?: string | null; currencyAsOf?: string | null; windowKey: string }> = [];
    let monetaryUpperBound: number | null = null;
    let monetaryVerification: BoundVerification | null = null;

    for (const policy of policies) {
      if (policy.status !== "active") continue;
      if (policy.valid === false || policy.projectId !== request.projectId || !policy.id || !validTimezone(policy.timezone) || !Number.isFinite(policy.allowance) || policy.allowance < 0) {
        if (policy.mode === "enforce") {
          const refusal = refusalFor(policy, "decision_unavailable", "The policy has an invalid allowance or timezone", request.now!, applications);
          await this.saveDecision(decisionRecordFor(request, fingerprint, refusal, request.now!));
          return refusal;
        }
        continue;
      }
      const match = matchScope(policy, request);
      if (match === "no-match") continue;
      if (match === "unknown") {
        if (policy.mode !== "enforce") {
          applications.push(application(policy, "monitor"));
          continue;
        }
        const refusal = refusalFor(policy, "missing_context", "All policy scope context must be known before an enforced call", request.now!, applications);
        await this.saveDecision(decisionRecordFor(request, fingerprint, refusal, request.now!));
        return refusal;
      }
      if (policy.mode === "monitor") {
        applications.push(application(policy, "monitor"));
        continue;
      }

      const serverCapability = this.capabilities.verify(request);
      if (!serverCapability?.supported || !serverCapability.admissionSupported || !serverCapability.verified) {
        const refusal = refusalFor(policy, "unsupported_integration", "This provider transport is not registered for enforced admission", request.now!, [...applications, application(policy, "refuse")]);
        await this.saveDecision(decisionRecordFor(request, fingerprint, refusal, request.now!));
        return refusal;
      }
      if (policy.unit === "money" && monetaryVerification == null) {
        try {
          monetaryVerification = await verifyProviderCostBound(request, this.options.pricing, this.capabilities);
        } catch (error) {
          throw new PolicyDecisionUnavailableError(error instanceof Error ? error.message : undefined);
        }
        if (!monetaryVerification.ok) {
          const refusal = refusalFor(policy, monetaryVerification.reason, monetaryVerification.message, request.now!, [...applications, application(policy, "refuse")]);
          await this.saveDecision(decisionRecordFor(request, fingerprint, refusal, request.now!));
          return refusal;
        }
        monetaryUpperBound = monetaryVerification.upperBoundUsd;
      }
      const quantity = quantityForPolicy(policy, request, monetaryUpperBound);
      if ("reason" in quantity) {
        const refusal = refusalFor(policy, quantity.reason, quantity.message, request.now!, [...applications, application(policy, "refuse")]);
        await this.saveDecision(decisionRecordFor(request, fingerprint, refusal, request.now!));
        return refusal;
      }
      let windowKey: string;
      try {
        windowKey = policyWindowKey(policy, request.now!, { traceId: request.traceId, executionId: request.executionId });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Policy window identity is unavailable";
        const refusal = refusalFor(policy, "decision_unavailable", message, request.now!, [...applications, application(policy, "refuse")]);
        await this.saveDecision(decisionRecordFor(request, fingerprint, refusal, request.now!));
        return refusal;
      }
      try {
        await this.backfillObserved(policy, windowKey, request);
      } catch (error) {
        if (error instanceof PolicyObservedUsageError || error instanceof PolicyDecisionUnavailableError) {
          const reason = error instanceof PolicyObservedUsageError ? error.reason : "decision_unavailable";
          const refusal = refusalFor(policy, reason, error.message, request.now!, [...applications, application(policy, "refuse")]);
          await this.saveDecision(decisionRecordFor(request, fingerprint, refusal, request.now!));
          return refusal;
        }
        throw error;
      }
      if (quantity.quantity > policy.allowance + 1e-12) {
        const refusal = refusalFor(policy, "budget_exhausted", "The call's verified upper bound exceeds this policy allowance", request.now!, [...applications, application(policy, "refuse", quantity.quantity)]);
        await this.saveDecision(decisionRecordFor(request, fingerprint, refusal, request.now!));
        return refusal;
      }
      applications.push(application(policy, "allow", quantity.quantity));
      enforced.push({ policy, quantity: quantity.quantity, currency: quantity.currency, currencyRate: quantity.currencyRate, currencySource: quantity.currencySource, currencyAsOf: quantity.currencyAsOf, windowKey });
    }

    let reservation: ReservationRecord | null = null;
    let replay = false;
    if (enforced.length > 0) {
      const lines: ReservationLineInput[] = enforced.map(({ policy, quantity, currency, currencyRate, currencySource, currencyAsOf, windowKey }) => ({
        policyId: policy.id,
        windowKey,
        unit: policy.unit,
        ...(currency ? { currency } : {}),
        ...(currencyRate == null ? {} : { currencyRate }),
        ...(currencySource == null ? {} : { currencySource }),
        ...(currencyAsOf == null ? {} : { currencyAsOf }),
        ...(policy.version == null ? {} : { policyVersion: policy.version }),
        quantity,
        limit: policy.allowance,
      }));
      try {
        const reserved = await this.options.store.reserve({
          projectId: request.projectId,
          admissionId: request.admissionId,
          requestId: request.requestId,
          fingerprint,
          lines,
          now: request.now,
        });
        reservation = reserved.reservation;
        replay = reserved.replay;
      } catch (error) {
        if (error instanceof ReservationCapacityError) {
          const refusing = policies.find((policy) => policy.id === error.policyId);
          const refusal = refusalFor(refusing, "budget_exhausted", "The shared allowance is exhausted by settled and in-flight work", request.now!, [...applications.map((item) => item.policyId === error.policyId ? { ...item, result: "refuse" as const } : item)]);
          await this.saveDecision(decisionRecordFor(request, fingerprint, refusal, request.now!));
          return refusal;
        }
        if (error instanceof ReservationConflictError) throw new PolicyIdempotencyError(error.message);
        throw new PolicyDecisionUnavailableError(error instanceof Error ? error.message : undefined);
      }
    }
    const allowed: AdmissionAllowed = {
      decision: "allow",
      replay,
      reservationId: reservation?.reservationId ?? null,
      reservation,
      policies: applications,
      enforcementApplied: enforced.length > 0,
      providerCallAllowed: !replay,
    };
    try {
      await this.saveDecision(decisionRecordFor(request, fingerprint, allowed, request.now!));
    } catch (error) {
      throw new PolicyDecisionUnavailableError(error instanceof Error ? error.message : undefined);
    }
    return allowed;
  }

  async admitOrThrow(request: AdmissionRequest): Promise<AdmissionAllowed> {
    const decision = await this.admit(request);
    if (decision.decision === "refuse") throw new PolicyRefusalError(decision);
    return decision;
  }

  async settle(input: SettlementInput): Promise<SettlementResult> {
    const now = input.now instanceof Date ? new Date(input.now.getTime()) : this.clock();
    if (!Number.isFinite(now.getTime())) throw new AdmissionInputError("Settlement time must be a valid date");
    const record = await this.options.store.getReservation(input.projectId, input.reservationId);
    if (!record) throw new SettlementNotFoundError(`Reservation ${input.reservationId} was not found`);
    if (!input.settlementId) throw new AdmissionInputError("settlementId is required");
    if (!["success", "failed", "cancelled", "unknown"].includes(input.outcome)) throw new AdmissionInputError("Unsupported settlement outcome");
    if (input.outcome === "unknown") {
      return this.settleStore({
        projectId: input.projectId,
        reservationId: input.reservationId,
        settlementId: input.settlementId,
        outcome: "unknown",
        now,
        providerAttempted: input.providerAttempted,
        fingerprint: settlementFingerprint(input),
      });
    }

    const actualLines: Array<{ policyId: string; quantity: number }> = [];
    const canReleaseWithoutProviderCharge = input.providerAttempted === false;
    if (canReleaseWithoutProviderCharge && input.actualCostUsd != null && input.actualCostUsd !== 0) {
      throw new PolicySettlementError("decision_unavailable", "providerAttempted=false cannot carry a non-zero provider charge");
    }
    if (!canReleaseWithoutProviderCharge && input.providerAttempted !== true) {
      throw new PolicySettlementError("decision_unavailable", "Provider outcome is ambiguous; report providerAttempted=false only when the call never started, otherwise settle verified usage/cost or report unknown");
    }
    for (const line of record.lines) {
      let quantity = 0;
      if (!canReleaseWithoutProviderCharge) {
        if (line.unit === "money") {
          const attestedCostUsd = input.providerAttestation?.source === "server"
            ? input.providerAttestation.actualCostUsd
            : null;
          if (attestedCostUsd == null || !Number.isFinite(attestedCostUsd) || attestedCostUsd < 0) {
            throw new PolicySettlementError("price_unavailable", "A provider-attempted monetary settlement requires a finite server-attested provider cost; client-reported actuals cannot release the reservation; report unknown to retain it");
          }
          const policyCurrency = line.currency ?? "USD";
          const rate = line.currencyRate ?? (policyCurrency === "USD" ? 1 : undefined);
          // The reservation line is already in policy currency. INR settlement
          // needs the exact server FX basis captured at admission.
          if (rate == null || !Number.isFinite(rate) || rate <= 0) throw new PolicySettlementError("decision_unavailable", "Settlement currency conversion basis is unavailable");
          quantity = attestedCostUsd * rate;
        } else if (line.unit === "calls") {
          quantity = 1;
        } else {
          const usage = input.providerAttestation?.source === "server"
            ? input.providerAttestation.actualUsage?.totalTokens ?? (
              input.providerAttestation.actualUsage?.inputTokens != null && input.providerAttestation.actualUsage?.outputTokens != null
                ? input.providerAttestation.actualUsage.inputTokens + input.providerAttestation.actualUsage.outputTokens
                : null
            )
            : null;
          if (usage == null || !Number.isFinite(usage) || usage < 0) throw new PolicySettlementError("decision_unavailable", "A provider-attempted token settlement requires server-attested observed token usage");
          quantity = usage;
        }
      }
      actualLines.push({ policyId: line.policyId, quantity });
    }
    return this.settleStore({
      projectId: input.projectId,
      reservationId: input.reservationId,
      settlementId: input.settlementId,
      outcome: input.outcome,
      actualLines,
      now,
      providerAttempted: input.providerAttempted,
      fingerprint: settlementFingerprint(input),
    });
  }
}

/** A safe default resolver for the current server catalogue. */
export function createServerPricingResolver(): PricingResolver {
  return async (provider, model, at) => {
    // Dynamic import avoids making pricing -> ingest -> admission cycles when
    // the ingestion worker records a late settlement.
    const pricing = await import("./pricing.js");
    const found = pricing.findPricing(model) as unknown as Record<string, unknown> | null;
    if (!found || provider !== "deepseek") {
      // The synced catalog prices models the built-in table doesn't know.
      const [{ getPriceCatalog }, { maxTokenRates }] = await Promise.all([import("./price-catalog/catalog.js"), import("./price-catalog/compute.js")]);
      const match = getPriceCatalog().resolve({ provider, model, at });
      if (match && match.price.rates.input !== undefined && match.price.rates.output !== undefined) {
        const rates = maxTokenRates(match.price.rates);
        return {
          currency: "USD",
          inputUsdPerMillion: rates.input * 1_000_000,
          outputUsdPerMillion: rates.output * 1_000_000,
          ...(rates.cacheRead === undefined ? {} : { cacheReadUsdPerMillion: rates.cacheRead * 1_000_000 }),
          ...(rates.cacheWrite === undefined ? {} : { cacheWriteUsdPerMillion: rates.cacheWrite * 1_000_000 }),
          ...(rates.outputImage === undefined ? {} : { imageOutputUsdPerMillion: rates.outputImage * 1_000_000 }),
          basis: `catalog:${match.price.source}:${match.price.sourceKey}:${at.toISOString().slice(0, 10)}`,
        };
      }
    }
    if (!found) return null;
    const peak = asRecord(found.peak);
    const offPeak = asRecord(found.offPeak);
    const maxRate = (key: string): number | undefined => {
      const values = [found[key], peak[key], offPeak[key]].filter((value): value is number => typeof value === "number" && Number.isFinite(value));
      return values.length ? Math.max(...values) : undefined;
    };
    return {
      currency: "USD",
      inputUsdPerMillion: maxRate("input") ?? 0,
      outputUsdPerMillion: maxRate("output") ?? 0,
      ...(maxRate("cacheRead") == null ? {} : { cacheReadUsdPerMillion: maxRate("cacheRead") }),
      ...(maxRate("cacheWrite") == null ? {} : { cacheWriteUsdPerMillion: maxRate("cacheWrite") }),
      ...(maxRate("imageOutput") == null ? {} : { imageOutputUsdPerMillion: maxRate("imageOutput") }),
      basis: `server-pricing:${provider}/${model}:${at.toISOString().slice(0, 10)}`,
    };
  };
}

export class PostgresPolicyAdmissionService extends PolicyAdmissionService {
  constructor(pool: pg.Pool, options: { pricing?: PricingResolver; clock?: () => Date; observedUsage?: ObservedUsageSource; capabilities?: ProviderCapabilityRegistry } = {}) {
    super({
      catalog: new PostgresPolicyCatalog(pool),
      store: new PostgresReservationStore(pool),
      pricing: options.pricing ?? createServerPricingResolver(),
      observedUsage: options.observedUsage ?? createPostgresObservedUsageSource(pool),
      clock: options.clock,
      capabilities: options.capabilities,
    });
  }
}

function authKeyFrom(req: Request): string | null {
  const header = req.headers.authorization;
  return header?.startsWith("Bearer ") ? header.slice(7) : null;
}

async function projectForAuth(pool: pg.Pool, req: Request): Promise<string | null> {
  const authKey = authKeyFrom(req);
  if (!authKey) return null;
  const result = await pool.query("SELECT id FROM projects WHERE auth_key = $1", [authKey]);
  return result.rows[0]?.id ? String(result.rows[0].id) : null;
}

function refusalStatus(reason: AdmissionRefusalReason): number {
  if (reason === "budget_exhausted") return 429;
  if (reason === "idempotency_conflict") return 409;
  if (reason === "unsupported_integration" || reason === "price_unavailable" || reason === "unbounded_request" || reason === "decision_unavailable" || reason === "missing_context") return 503;
  return 409;
}

function serializeError(error: unknown): { status: number; body: Record<string, unknown> } {
  if (error instanceof PolicyRefusalError) return { status: refusalStatus(error.reason), body: error.toJSON() as unknown as Record<string, unknown> };
  if (error instanceof PolicyIdempotencyError || error instanceof ReservationConflictError || error instanceof SettlementConflictError) {
    return { status: 409, body: { error: "COSTKEY_POLICY_IDEMPOTENCY_CONFLICT", reason: "idempotency_conflict", message: error.message } };
  }
  if (error instanceof PolicySettlementError) return { status: 503, body: { error: "COSTKEY_POLICY_SETTLEMENT", reason: error.reason, message: error.message } };
  if (error instanceof PolicyObservedUsageError) return { status: 503, body: { error: error.code, reason: error.reason, message: error.message } };
  if (error instanceof PolicyDecisionUnavailableError) return { status: 503, body: { error: error.code, reason: "decision_unavailable", message: "Shared policy accounting is unavailable" } };
  if (error instanceof SettlementNotFoundError) return { status: 404, body: { error: "COSTKEY_POLICY_SETTLEMENT", reason: "decision_unavailable", message: error.message } };
  if (error instanceof AdmissionInputError) return { status: 400, body: { error: error.code, message: error.message } };
  return { status: 503, body: { error: "COSTKEY_POLICY_DECISION_UNAVAILABLE", reason: "decision_unavailable", message: "Shared policy accounting is unavailable" } };
}

async function notifyPolicyRefusal(
  pool: pg.Pool,
  projectId: string,
  refusal: AdmissionRefusal,
  body: Record<string, unknown>,
): Promise<void> {
  // Refusal notifications are a durable, idempotent outbox side effect. A
  // replay is already recorded and must not enqueue another notification.
  if (refusal.replay || !refusal.policyId) return;
  try {
    const project = await pool.query("SELECT org_id FROM projects WHERE id = $1", [projectId]);
    const orgId = project.rows[0]?.org_id;
    if (!orgId) return;
    await dispatchEnforcementNotification(pool, {
      orgId: String(orgId),
      projectId,
      policyId: refusal.policyId,
      traceId: nonEmptyString(aliasValue(body, "traceId", "trace_id")),
      reason: refusal.reason,
      message: refusal.message,
      windowKey: typeof refusal.window === "string" ? refusal.window : null,
    });
  } catch (error) {
    // A channel/outbox outage must not alter the typed policy decision. The
    // scheduler's retry path owns eventual notification recovery.
    if ((error as { code?: string })?.code === "42P01"
      || (error as { code?: string })?.code === "42703") return;
    console.error(`[costkey] policy refusal notification failed for ${projectId}/${refusal.policyId}:`, error);
  }
}

function bodyAsAdmission(projectId: string, body: Record<string, unknown>): AdmissionRequest {
  const integration = asRecord(aliasValue(body, "integration", "capability"));
  return {
    projectId,
    admissionId: String(body.admissionId ?? body.admission_id ?? ""),
    requestId: nonEmptyString(aliasValue(body, "requestId", "request_id")),
    provider: String(body.provider ?? ""),
    model: nonEmptyString(body.model),
    traceId: nonEmptyString(aliasValue(body, "traceId", "trace_id")),
    executionId: nonEmptyString(aliasValue(body, "executionId", "execution_id")),
    scope: parseJsonObject(body.scope) as PolicyScope,
    context: asRecord(body.context),
    integration: {
      supported: integration.supported === true,
      admissionSupported: integration.admissionSupported === true || integration.admission_supported === true,
      capabilityVersion: nonEmptyString(aliasValue(integration, "capabilityVersion", "capability_version")) ?? undefined,
      verified: integration.verified === true,
    },
    usageBounds: parseJsonObject(aliasValue(body, "usageBounds", "usage_bounds", "request")) as ProviderUsageBounds,
    claimedCostUsd: finiteNonNegative(aliasValue(body, "claimedCostUsd", "claimed_cost_usd", "costUpperBoundUsd")),
    providerRequest: body.providerRequest ?? body.provider_request,
  };
}

export interface SdkAdmissionRouterOptions {
  service?: PolicyAdmissionService;
}

/**
 * DSN-authenticated pre-call and settlement routes. They are intentionally
 * separate from async event ingest: admission failures are typed and must be
 * visible to the application, while telemetry remains best-effort. A project
 * DSN authenticates this CostKey decision endpoint; it cannot prevent a
 * customer, compromised process, or another integration from bypassing the
 * SDK and calling a provider directly. This is not a gateway hard ceiling.
 */
export function createSdkAdmissionRouter(pool: pg.Pool, options: SdkAdmissionRouterOptions = {}): Router {
  const router = createRouter();
  const service = options.service ?? new PostgresPolicyAdmissionService(pool);
  router.use((_req, res, next) => {
    // Admission/settlement responses are one-shot authorization state, never
    // cacheable policy metadata.
    res.set("Cache-Control", "no-store");
    next();
  });

  router.get("/api/v1/sdk/policy/policies", async (req: Request, res: Response) => {
    try {
      const projectId = await projectForAuth(pool, req);
      if (!projectId) {
        res.status(401).json({ error: "Missing or invalid authorization" });
        return;
      }
      const policies = await service.listPolicies(projectId);
      res.json({
        policies: policies.map((policy) => ({
          id: policy.id,
          name: policy.name,
          scope: policy.scope,
          mode: policy.mode,
          status: policy.status,
          unit: policy.unit,
          allowance: policy.allowance,
          currency: policy.unit === "money" ? policy.currency ?? "USD" : null,
          window: policy.window,
          timezone: policy.timezone,
          periodStart: policy.periodStart,
          activatedAt: policy.activatedAt ?? null,
          policyVersion: policy.version ?? null,
        })),
        fetchedAt: new Date().toISOString(),
      });
    } catch (error) {
      const serialized = serializeError(error);
      res.status(serialized.status).json(serialized.body);
    }
  });

  router.post("/api/v1/sdk/policy/admit", async (req: Request, res: Response) => {
    try {
      const projectId = await projectForAuth(pool, req);
      if (!projectId) {
        res.status(401).json({ error: "Missing or invalid authorization" });
        return;
      }
      const body = asRecord(req.body);
      if (body.projectId != null && String(body.projectId) !== projectId) {
        res.status(403).json({ error: "Auth key does not match project" });
        return;
      }
      const decision = await service.admit(bodyAsAdmission(projectId, body));
      if (decision.decision === "refuse") {
        await notifyPolicyRefusal(pool, projectId, decision, body);
        if (decision.retryAt) {
          const retryAfter = Math.max(0, Math.ceil((new Date(decision.retryAt).getTime() - Date.now()) / 1000));
          res.set("Retry-After", String(retryAfter));
        }
        res.status(refusalStatus(decision.reason)).json(decision);
        return;
      }
      res.status(200).json(decision);
    } catch (error) {
      const serialized = serializeError(error);
      if (serialized.status >= 500 && !(error instanceof PolicyRefusalError)) console.error("[costkey] policy admission error:", error);
      res.status(serialized.status).json(serialized.body);
    }
  });

  router.post("/api/v1/sdk/policy/settle", async (req: Request, res: Response) => {
    try {
      const projectId = await projectForAuth(pool, req);
      if (!projectId) {
        res.status(401).json({ error: "Missing or invalid authorization" });
        return;
      }
      const body = asRecord(req.body);
      const outcome = String(body.outcome ?? "") as ReservationOutcome;
      const result = await service.settle({
        projectId,
        reservationId: String(body.reservationId ?? body.reservation_id ?? ""),
        settlementId: String(body.settlementId ?? body.settlement_id ?? ""),
        outcome,
        actualCostUsd: finiteNonNegative(aliasValue(body, "actualCostUsd", "actual_cost_usd")),
        actualUsage: asRecord(aliasValue(body, "actualUsage", "actual_usage")) as ActualUsage,
        // Only the test acceptance harness has a server-controlled provider
        // result. Production SDK requests remain fail-closed until a trusted
        // provider reconciliation path supplies an attestation.
        ...(process.env["NODE_ENV"] === "test"
          && process.env["ACCEPTANCE_BASE_URL"]
          && process.env["ACCEPTANCE_DATABASE_URL"]
          ? {
            providerAttestation: {
              source: "server" as const,
              actualCostUsd: finiteNonNegative(aliasValue(body, "actualCostUsd", "actual_cost_usd")),
              actualUsage: asRecord(aliasValue(body, "actualUsage", "actual_usage")) as ActualUsage,
            },
          }
          : {}),
        providerAttempted: body.providerAttempted === true || body.provider_attempted === true
          ? true
          : body.providerAttempted === false || body.provider_attempted === false
            ? false
            : undefined,
      });
      res.status(200).json(result);
    } catch (error) {
      const serialized = serializeError(error);
      if (serialized.status >= 500 && !(error instanceof PolicySettlementError)) console.error("[costkey] policy settlement error:", error);
      res.status(serialized.status).json(serialized.body);
    }
  });

  // Explicit failed/cancelled release; this is not a TTL cleanup endpoint.
  router.post("/api/v1/sdk/policy/release", async (req: Request, res: Response) => {
    try {
      // A public DSN cannot prove that a provider call never started. Keep
      // this compatibility seam available only to the disposable acceptance
      // harness; production clients must report unknown and await server-side
      // reconciliation instead of self-releasing an enforced reservation.
      const localAcceptance = process.env["NODE_ENV"] === "test"
        && Boolean(process.env["ACCEPTANCE_BASE_URL"])
        && Boolean(process.env["ACCEPTANCE_DATABASE_URL"]);
      if (!localAcceptance) {
        res.status(404).json({ error: "Not found" });
        return;
      }
      const projectId = await projectForAuth(pool, req);
      if (!projectId) {
        res.status(401).json({ error: "Missing or invalid authorization" });
        return;
      }
      const body = asRecord(req.body);
      const result = await service.settle({
        projectId,
        reservationId: String(body.reservationId ?? body.reservation_id ?? ""),
        settlementId: String(body.settlementId ?? body.settlement_id ?? ""),
        outcome: body.outcome === "cancelled" ? "cancelled" : "failed",
        providerAttempted: false,
      });
      res.status(200).json(result);
    } catch (error) {
      const serialized = serializeError(error);
      res.status(serialized.status).json(serialized.body);
    }
  });
  return router;
}

/** Short aliases for platform wiring and consumers that call this a policy router. */
export const createAdmissionRouter = createSdkAdmissionRouter;
export const AdmissionService = PolicyAdmissionService;

export {
  InMemoryReservationStore,
  PostgresReservationStore,
  InMemoryReservationLedger,
  PostgresReservationLedger,
  ReservationCapacityError,
  ReservationConflictError,
  SettlementConflictError,
  SettlementNotFoundError,
} from "./reservation.js";
export type {
  DecisionRecord,
  ReservationLine,
  ReservationLineInput,
  ReservationRecord,
  ReservationStore,
  SettlementResult,
} from "./reservation.js";

/** Convenience factory for local public-seam tests. */
export function createInMemoryPolicyAdmissionService(
  policies: Array<SpendingPolicy | Record<string, unknown>>,
  options: { pricing?: PricingResolver; observedUsage?: ObservedUsageSource; clock?: () => Date; capabilities?: ProviderCapabilityRegistry } = {},
): PolicyAdmissionService {
  return new PolicyAdmissionService({
    catalog: new StaticPolicyCatalog(policies),
    store: new InMemoryReservationStore(),
    pricing: options.pricing,
    observedUsage: options.observedUsage,
    clock: options.clock,
    capabilities: options.capabilities,
  });
}
