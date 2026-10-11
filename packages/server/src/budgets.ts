/**
 * Budget rules: per-project, per-scope caps + alerts.
 *
 * A "rule" has an optional scope (model glob, function glob, or both) and
 * caps (daily/monthly USD, calls/tokens per minute). A call must satisfy
 * every matching rule — most-restrictive wins.
 *
 * Scope glob matching:
 *   scope_model: matches event.model via GLOB semantics
 *     (SQL: model LIKE translated-glob)
 *   scope_function: matches "<bl_file>:<bl_function>" via GLOB semantics
 *
 * NULL in either scope column means "match everything" on that axis. So a
 * rule with both NULLs is the classic project-wide rule.
 */

import { createHash } from "node:crypto";
import type { Router, Request, Response } from "express";
import { Router as createRouter } from "express";
import type pg from "pg";
import { Resend } from "resend";
import { requireAuth } from "./auth.js";
import { createPostgresObservedUsageSource, DEFAULT_PROVIDER_CAPABILITY_REGISTRY, isIdentityWindow, normalizeScopeValue, normalizeSpendingPolicy, perCallUsageSummary, POLICY_SCOPE_KEYS, POLICY_SCOPE_MAX_VALUE_LENGTH, POLICY_SCOPE_MAX_VALUES, policyScopeClauses, policyWindowKey, scopeValues, type AdmissionRequest, type PolicyCurrency, type PolicyMode, type PolicyScope, type PolicyUnit, type PolicyWindow, type SpendingPolicy } from "./admission.js";
import { PostgresReservationStore } from "./reservation.js";
import { dispatchEnforcementNotification, dispatchFindingNotification, dispatchPolicyWarning, dispatchWebhook, isSafeWebhookUrl } from "./notifications.js";
import { publicAppUrl } from "./public-url.js";
export { ensurePolicySchema } from "./policy-storage.js";

// F06/DX09 pre-call enforcement is exposed from its own module so platform
// startup can mount it exactly once beside this legacy budget/alert router.
export {
  createSdkAdmissionRouter,
  createAdmissionRouter,
  createInMemoryPolicyAdmissionService,
  AdmissionService,
  PolicyAdmissionService,
  PostgresPolicyAdmissionService,
  PolicyRefusalError,
  PolicyIdempotencyError,
  PolicyDecisionUnavailableError,
  PolicySettlementError,
  PolicyObservedUsageError,
  normalizeSpendingPolicy,
  policyWindowKey,
  verifyProviderCostBound,
  DEFAULT_PROVIDER_CAPABILITY_REGISTRY,
  StaticProviderCapabilityRegistry,
} from "./admission.js";
export type {
  AdmissionRequest,
  AdmissionDecision,
  AdmissionAllowed,
  AdmissionRefusal,
  SpendingPolicy,
  PolicyScope,
  PolicyUnit,
  PolicyWindow,
  ProviderAdmissionProof,
  ProviderCapabilityDefinition,
  ProviderCapabilityRegistry,
  ProviderUsageBounds,
  ObservedPolicyUsage,
  SettlementInput,
} from "./admission.js";

// ─── SDK-facing router (auth key, no JWT) ─────────────────────────────

export function createSdkBudgetsRouter(pool: pg.Pool): Router {
  const router = createRouter();
  // GET /api/v1/sdk/budget/rules — called by SDK at init + on a poll
  router.get("/api/v1/sdk/budget/rules", async (req: Request, res: Response) => {
    try {
      const h = req.headers.authorization;
      if (!h?.startsWith("Bearer ")) {
        res.status(401).json({ error: "Missing or invalid authorization" });
        return;
      }
      const authKey = h.slice(7);
      const proj = await pool.query("SELECT id FROM projects WHERE auth_key = $1", [authKey]);
      if (proj.rows.length === 0) {
        res.status(401).json({ error: "Invalid auth key" });
        return;
      }
      const projectId = proj.rows[0].id;
      const r = await pool.query(
        `SELECT id, name, scope_model, scope_function,
                daily_usd, monthly_usd, calls_per_minute, tokens_per_minute,
                on_exceed, enabled
         FROM budget_rules
         WHERE project_id = $1 AND enabled = TRUE`,
        [projectId],
      );
      // Shape: camelCase for SDK ergonomics, coerce numeric strings.
      const rules = r.rows.map((x) => ({
        id: x.id,
        name: x.name,
        scopeModel: x.scope_model,
        scopeFunction: x.scope_function,
        dailyUsd: x.daily_usd != null ? Number(x.daily_usd) : null,
        monthlyUsd: x.monthly_usd != null ? Number(x.monthly_usd) : null,
        callsPerMinute: x.calls_per_minute,
        tokensPerMinute: x.tokens_per_minute,
        onExceed: x.on_exceed,
      }));
      // Very short cache + ETag-friendly headers. SDK polls every 5min.
      res.set("Cache-Control", "private, max-age=60");
      res.json({ rules, fetchedAt: new Date().toISOString() });
    } catch (err) {
      console.error("[costkey] GET sdk rules error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });
  return router;
}

let resend: Resend | null = null;

function getResend(): Resend {
  return resend ??= new Resend(process.env["RESEND_API_KEY"] ?? "");
}

function randomId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// ─── Glob → SQL LIKE translation ──────────────────────────────────────
// Supports `*` (zero+ chars) and `?` (exactly one char). Literal % and _
// in the input are escaped so they don't act as wildcards in LIKE.
function globToLike(glob: string): string {
  return glob
    .replace(/\\/g, "\\\\")
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_")
    .replace(/\*/g, "%")
    .replace(/\?/g, "_");
}

// ─── Validation ───────────────────────────────────────────────────────

const POLICIES = new Set(["throw", "warn", "block"]);

interface ParsedRule {
  name: string | null;
  scope_model: string | null;
  scope_function: string | null;
  daily_usd: number | null;
  monthly_usd: number | null;
  calls_per_minute: number | null;
  tokens_per_minute: number | null;
  on_exceed: string;
  alert_email: string | null;
  alert_webhook_url: string | null;
  alert_thresholds: number[];
  enabled: boolean;
}

function sanitizeRule(body: Record<string, unknown>): ParsedRule | { error: string } {
  const num = (k: string): number | null => {
    const v = body[k];
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return NaN as unknown as number;
    return n;
  };
  const daily = num("dailyUsd");
  const monthly = num("monthlyUsd");
  const cpm = num("callsPerMinute");
  const tpm = num("tokensPerMinute");
  if ([daily, monthly, cpm, tpm].some((v) => Number.isNaN(v))) {
    return { error: "Caps must be non-negative numbers" };
  }
  if (daily == null && monthly == null && cpm == null && tpm == null) {
    return { error: "At least one cap (daily/monthly/calls/tokens) must be set" };
  }

  const onExceed = typeof body["onExceed"] === "string" ? body["onExceed"] : "warn";
  if (!POLICIES.has(onExceed)) return { error: `onExceed must be one of ${[...POLICIES].join(", ")}` };

  const thresholds = Array.isArray(body["alertThresholds"])
    ? body["alertThresholds"]
        .map((v) => Number(v))
        .filter((v) => Number.isFinite(v) && v > 0 && v <= 2)
        .sort((a, b) => a - b)
    : [0.5, 0.8, 1.0];
  if (thresholds.length === 0) return { error: "alertThresholds must include at least one value" };

  const str = (k: string, max = 200): string | null => {
    const v = body[k];
    if (typeof v !== "string") return null;
    const t = v.trim();
    if (t.length === 0) return null;
    if (t.length > max) return null;
    return t;
  };

  const alertWebhookUrl = str("alertWebhookUrl");
  if (alertWebhookUrl && !isSafeWebhookUrl(alertWebhookUrl)) {
    return { error: "alertWebhookUrl must be an http(s) URL without credentials and must not target a private host" };
  }

  return {
    name: str("name", 80),
    scope_model: str("scopeModel"),
    scope_function: str("scopeFunction"),
    daily_usd: daily,
    monthly_usd: monthly,
    calls_per_minute: cpm != null ? Math.floor(cpm) : null,
    tokens_per_minute: tpm != null ? Math.floor(tpm) : null,
    on_exceed: onExceed,
    alert_email: str("alertEmail"),
    alert_webhook_url: alertWebhookUrl,
    alert_thresholds: thresholds,
    enabled: body["enabled"] !== false,
  };
}

// ─── Canonical F06 policy validation ─────────────────────────────────

interface ParsedPolicy {
  name: string | null;
  scope: PolicyScope;
  mode: PolicyMode;
  status: "active" | "paused" | "archived";
  unit: PolicyUnit;
  allowance: number;
  currency: PolicyCurrency | null;
  window_kind: PolicyWindow;
  timezone: string;
  period_start_mode: "calendar" | "activation";
  activated_at: string | null;
  usd_to_policy_currency: number | null;
  fx_rate: number | null;
  fx_source: string | null;
  fx_as_of: string | null;
  fx_client_claim_ignored: boolean;
  capability_review: Record<string, unknown> | null;
}

export interface WorkspaceFxSnapshot {
  available: boolean;
  rate: number | null;
  source: string | null;
  asOf: string | null;
}

const POLICY_UNITS = new Set<PolicyUnit>(["money", "calls", "tokens"]);
const POLICY_WINDOWS = new Set<PolicyWindow>([
  "per_trace", "per_execution", "per_call", "calendar_minute", "calendar_day", "calendar_month",
]);

const PER_CALL_USAGE_LOOKBACK_MS = 24 * 60 * 60 * 1000;
// Covers one checker interval past the hour so a late-hour call is not missed.
const PER_CALL_WARNING_LOOKBACK_MS = 65 * 60 * 1000;

function finitePolicyNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function isValidTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

async function workspaceFxForProject(pool: pg.Pool, projectId: string): Promise<WorkspaceFxSnapshot> {
  const result = await pool.query(
    `SELECT ws.reporting_currency, ws.fx_rate, ws.fx_source, ws.fx_as_of
     FROM workspace_settings ws
     JOIN projects p ON p.org_id = ws.org_id
     WHERE p.id = $1`,
    [projectId],
  );
  const row = result.rows[0] as Record<string, unknown> | undefined;
  const reportingCurrency = String(row?.reporting_currency ?? "USD").toUpperCase();
  if (reportingCurrency === "USD") return { available: true, rate: 1, source: "native USD", asOf: null };
  const rate = finitePolicyNumber(row?.fx_rate);
  const source = typeof row?.fx_source === "string" && row.fx_source.trim() ? row.fx_source.trim() : null;
  const rawAsOf = row?.fx_as_of;
  const parsedAsOf = rawAsOf instanceof Date ? rawAsOf : rawAsOf == null ? null : new Date(String(rawAsOf));
  const asOf = parsedAsOf && Number.isFinite(parsedAsOf.getTime()) ? parsedAsOf.toISOString() : null;
  const dated = parsedAsOf && Number.isFinite(parsedAsOf.getTime()) && parsedAsOf.getTime() <= Date.now() + 5 * 60 * 1000;
  return {
    available: reportingCurrency === "INR" && rate != null && rate > 0 && source != null && asOf != null && Boolean(dated),
    rate,
    source,
    asOf,
  };
}

async function workspaceTimezoneForProject(pool: pg.Pool, projectId: string): Promise<string> {
  const result = await pool.query(
    `SELECT ws.timezone
     FROM workspace_settings ws
     JOIN projects p ON p.org_id = ws.org_id
     WHERE p.id = $1`,
    [projectId],
  );
  const timezone = typeof result.rows[0]?.timezone === "string" ? result.rows[0].timezone.trim() : "";
  return timezone && isValidTimezone(timezone) ? timezone : "UTC";
}

function policyScope(body: Record<string, unknown>): PolicyScope | { error: string } {
  const raw = body["scope"];
  const source = typeof raw === "string" ? (() => { try { return JSON.parse(raw) as unknown; } catch { return {}; } })() : raw;
  const scope = source !== null && typeof source === "object" && !Array.isArray(source)
    ? source as Record<string, unknown>
    : {};
  const aliases: Record<string, string[]> = {
    feature: ["feature", "scopeFeature"],
    customer: ["customer", "scopeCustomer"],
    function: ["function", "scopeFunction"],
    provider: ["provider", "scopeProvider"],
    model: ["model", "scopeModel"],
    group: ["group", "scopeGroup"],
    agent: ["agent", "scopeAgent"],
    tool: ["tool", "scopeTool"],
    user: ["user", "scopeUser"],
    workflow: ["workflow", "scopeWorkflow"],
  };
  const result: PolicyScope = {};
  for (const field of POLICY_SCOPE_KEYS) {
    const candidates = aliases[field];
    const raw = candidates.map((key) => scope[key] ?? body[key])
      .find((candidate) => (typeof candidate === "string" && candidate.trim()) || Array.isArray(candidate));
    if (raw === undefined) continue;
    if (Array.isArray(raw) && raw.some((entry) => typeof entry !== "string")) return { error: `scope.${field} values must be strings` };
    const value = normalizeScopeValue(raw);
    if (!value) continue;
    const values = scopeValues(value);
    if (values.length > POLICY_SCOPE_MAX_VALUES) return { error: `scope.${field} allows at most ${POLICY_SCOPE_MAX_VALUES} values` };
    if (values.some((entry) => entry.length > POLICY_SCOPE_MAX_VALUE_LENGTH)) return { error: `scope.${field} values must be at most ${POLICY_SCOPE_MAX_VALUE_LENGTH} characters` };
    result[field] = value;
  }
  return result;
}

function serverCapabilityReview(scope: PolicyScope): Record<string, unknown> {
  // Capability evidence is derived only from the server registry and the
  // policy's provider/model scope. A request-body capabilityReview is never
  // used as authorization material. A group is reviewable only if every
  // member is.
  const unavailable = {
    supported: false,
    admissionSupported: false,
    verified: false,
    source: "server_registry",
    reason: "Server provider capability review is unavailable",
  };
  const providers: Array<string | null> = scopeValues(scope.provider).length ? scopeValues(scope.provider) : [null];
  const models: Array<string | null> = scopeValues(scope.model).length ? scopeValues(scope.model) : [null];
  const reviews = providers.flatMap((provider) => models.map((model) => DEFAULT_PROVIDER_CAPABILITY_REGISTRY.review?.(provider, model) ?? unavailable));
  return reviews.find((review) => !capabilityAllowsEnforcement(review)) ?? reviews[0] ?? unavailable;
}

function capabilityAllowsEnforcement(capability: Record<string, unknown>): boolean {
  return capability.supported === true
    && capability.admissionSupported === true
    && capability.verified === true
    && capability.source === "server_registry";
}

function hasWildcard(value: string): boolean {
  return value.includes("*") || value.includes("?");
}

function scopesMayOverlap(left: PolicyScope, right: PolicyScope): boolean {
  for (const field of POLICY_SCOPE_KEYS) {
    const a = scopeValues(left[field]);
    const b = scopeValues(right[field]);
    if (a.length === 0 || b.length === 0) continue;
    if (a.some(hasWildcard) || b.some(hasWildcard) || a.some((value) => b.includes(value))) continue;
    return false;
  }
  return true;
}

async function overlappingPolicyReview(pool: pg.Pool, projectId: string, scope: PolicyScope): Promise<Array<Record<string, unknown>>> {
  try {
    const result = await pool.query(
      `SELECT id, name, scope, mode, unit, allowance, currency,
              window_kind, timezone, policy_version
       FROM spending_policies
       WHERE project_id = $1 AND COALESCE(status, 'active') IN ('active', 'paused')
       ORDER BY id ASC`,
      [projectId],
    );
    return result.rows
      .map((row) => {
        const normalized = normalizeSpendingPolicy(row as Record<string, unknown>);
        return { row: row as Record<string, unknown>, policy: normalized };
      })
      .filter(({ policy }) => scopesMayOverlap(scope, policy.scope))
      .map(({ row, policy }) => ({
        id: policy.id,
        name: policy.name,
        scope: policy.scope,
        mode: policy.mode,
        unit: policy.unit,
        allowance: policy.allowance,
        currency: policy.unit === "money" ? policy.currency ?? "USD" : null,
        window: policy.window,
        timezone: policy.timezone,
        policyVersion: policy.version ?? null,
        explanation: "This active policy may also apply; every matching enforced policy must allow the call.",
      }));
  } catch (error) {
    if ((error as { code?: string })?.code === "42P01") return [];
    throw error;
  }
}

function sanitizePolicy(body: Record<string, unknown>, workspaceFx?: WorkspaceFxSnapshot, workspaceTimezone = "UTC"): ParsedPolicy | { error: string; status?: number } {
  const modeValue = String(body["mode"] ?? "monitor").toLowerCase();
  if (modeValue !== "monitor" && modeValue !== "enforce") return { error: "mode must be monitor or enforce" };
  const mode = modeValue as PolicyMode;
  const statusValue = String(body["status"] ?? (body["enabled"] === false ? "paused" : "active")).toLowerCase();
  if (statusValue !== "active" && statusValue !== "paused" && statusValue !== "archived") return { error: "status must be active, paused, or archived" };

  const unitValue = String(body["unit"] ?? "money").toLowerCase() as PolicyUnit;
  if (!POLICY_UNITS.has(unitValue)) return { error: "unit must be money, calls, or tokens" };
  const windowValue = String(body["window"] ?? body["windowKind"] ?? body["window_kind"] ?? "calendar_day").toLowerCase() as PolicyWindow;
  if (!POLICY_WINDOWS.has(windowValue)) return { error: "window must be per_trace, per_execution, per_call, calendar_minute, calendar_day, or calendar_month" };
  if (windowValue === "per_call" && unitValue === "calls") return { error: "a per_call policy must cap money or tokens" };

  const allowance = finitePolicyNumber(body["allowance"] ?? body["limit"] ?? body["limitAmount"]);
  if (allowance == null) return { error: "allowance must be a finite non-negative number" };
  const currencyValue = String(body["currency"] ?? (unitValue === "money" ? "USD" : "")).toUpperCase();
  const currency = unitValue === "money" ? currencyValue as PolicyCurrency : null;
  if (unitValue === "money" && currency !== "USD" && currency !== "INR") return { error: "money policy currency must be USD or INR" };
  const timezone = typeof body["timezone"] === "string" && body["timezone"].trim() ? body["timezone"].trim() : workspaceTimezone;
  if (!isValidTimezone(timezone)) return { error: "timezone must be a valid IANA timezone" };
  const periodStartValue = String(body["periodStart"] ?? body["period_start_mode"] ?? body["windowStartMode"] ?? "calendar").toLowerCase();
  if (periodStartValue !== "calendar" && periodStartValue !== "activation") return { error: "periodStart must be calendar or activation" };
  let activatedAt: string | null = null;
  if (periodStartValue === "activation") {
    const rawActivatedAt = body["activatedAt"] ?? body["activated_at"];
    const parsedActivatedAt = rawActivatedAt == null ? new Date() : new Date(String(rawActivatedAt));
    if (!Number.isFinite(parsedActivatedAt.getTime())) return { error: "activatedAt must be a valid date" };
    activatedAt = parsedActivatedAt.toISOString();
  }
  const clientFx = finitePolicyNumber(body["usdToPolicyCurrency"] ?? body["usd_to_policy_currency"] ?? body["fxRate"] ?? body["fx_rate"]);
  const fx = unitValue === "money" && currency === "INR" ? workspaceFx?.rate ?? null : null;
  const fxSource = unitValue === "money" && currency === "INR" ? workspaceFx?.source ?? null : null;
  const fxAsOf = unitValue === "money" && currency === "INR" ? workspaceFx?.asOf ?? null : null;
  if (unitValue === "money" && currency === "INR" && (!workspaceFx?.available || fx == null || fx <= 0 || !fxSource || !fxAsOf)) {
    return { error: "INR policy requires an available dated workspace FX basis", status: 409 };
  }

  const scope = policyScope(body);
  if ("error" in scope) return { error: String(scope.error) };
  // Deliberately discard body capability claims. The route derives a review
  // from the server registry after validation and persists that evidence for
  // the policy version when enforcement is activated.
  return {
    name: typeof body["name"] === "string" && body["name"].trim() ? body["name"].trim().slice(0, 80) : null,
    scope,
    mode,
    status: statusValue as ParsedPolicy["status"],
    unit: unitValue,
    allowance,
    currency,
    window_kind: windowValue,
    timezone,
    period_start_mode: periodStartValue as "calendar" | "activation",
    activated_at: activatedAt,
    usd_to_policy_currency: fx,
    fx_rate: fx,
    fx_source: fxSource,
    fx_as_of: fxAsOf,
    fx_client_claim_ignored: clientFx != null,
    capability_review: null,
  };
}

function persistedFxAvailable(policy: SpendingPolicy, at = Date.now()): boolean {
  if (policy.currency !== "INR") return true;
  if (policy.usdToPolicyCurrency == null || !Number.isFinite(policy.usdToPolicyCurrency) || policy.usdToPolicyCurrency <= 0) return false;
  if (!policy.fxSource || !policy.fxAsOf) return false;
  const asOf = new Date(policy.fxAsOf).getTime();
  return Number.isFinite(asOf) && asOf <= at + 5 * 60 * 1000;
}

function publicPolicy(row: Record<string, unknown>): Record<string, unknown> {
  const policy = normalizeSpendingPolicy(row);
  const capability = policy.capabilityReview as Record<string, unknown> | null | undefined;
  return {
    id: policy.id,
    projectId: policy.projectId,
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
    usdToPolicyCurrency: policy.usdToPolicyCurrency ?? null,
    fx: policy.currency === "INR"
      ? { available: persistedFxAvailable(policy), rate: policy.usdToPolicyCurrency ?? null, source: policy.fxSource ?? null, asOf: policy.fxAsOf ?? null }
      : { available: true, rate: 1, source: "native USD", asOf: null },
    policyVersion: policy.version ?? null,
    // Never present a client/legacy capability claim as trusted review
    // evidence. The admission service re-checks the server registry anyway.
    capability: capability?.source === "server_registry" ? capability : null,
    createdAt: policy.createdAt ?? null,
    updatedAt: policy.updatedAt ?? null,
  };
}

async function publicPolicyWithUsage(pool: pg.Pool, row: Record<string, unknown>): Promise<Record<string, unknown>> {
  const policy = normalizeSpendingPolicy(row);
  let usage: Record<string, unknown> = {
    windowKey: null,
    settled: null,
    reserved: null,
    observed: null,
    unknown: null,
    inFlight: null,
    committed: null,
    remaining: null,
    overage: null,
  };
  const canonical = row["window_kind"] !== undefined
    || row["period_start_mode"] !== undefined
    || row["policy_version"] !== undefined;
  if (!canonical) {
    return {
      ...publicPolicy(row),
      usage: {
        ...usage,
        note: "Legacy monitor rule; shared reservation usage is unavailable until this policy is explicitly migrated.",
      },
    };
  }
  if (policy.window === "per_call") {
    // Nothing accumulates; show the largest call in the last day instead.
    try {
      const to = new Date();
      const since = new Date(to.getTime() - PER_CALL_USAGE_LOOKBACK_MS);
      const summary = await perCallUsageSummary(pool, policy, since, to);
      usage = { ...usage, observed: summary.largest, largestCall: summary.largest, overLimit: summary.overLimit, since: since.toISOString() };
    } catch (error) {
      if ((error as { code?: string })?.code !== "42P01") throw error;
    }
    return { ...publicPolicy(row), usage };
  }
  try {
    let windowKey: string | null = null;
    if (!isIdentityWindow(policy.window)) {
      try {
        windowKey = policyWindowKey(policy, new Date());
      } catch {
        return {
          ...publicPolicy(row),
          usage: { ...usage, note: "Policy timezone/window is invalid; admission is fail-closed." },
        };
      }
    }
    if (!windowKey) {
      return {
        ...publicPolicy(row),
        usage: {
          ...usage,
          note: "Per-trace/per-execution usage requires the matching identity; no pooled total is shown.",
        },
      };
    }
    const result = windowKey
      ? await pool.query(
          `SELECT COALESCE(SUM(settled_quantity), 0) AS settled,
                  COALESCE(SUM(reserved_quantity), 0) AS reserved,
                  COALESCE(SUM(observed_quantity), 0) AS observed,
                  COALESCE(SUM(unknown_observations), 0) AS unknown
           FROM policy_window_usage
           WHERE policy_id = $1 AND window_key = $2`,
          [policy.id, windowKey],
        )
      : await pool.query(
          `SELECT COALESCE(SUM(settled_quantity), 0) AS settled,
                  COALESCE(SUM(reserved_quantity), 0) AS reserved
           FROM policy_window_usage WHERE policy_id = $1`,
          [policy.id],
        );
    const settled = Number(result.rows[0]?.settled);
    const reserved = Number(result.rows[0]?.reserved);
    const observed = Number(result.rows[0]?.observed);
    const knownSettled = Number.isFinite(settled) ? settled : null;
    const knownReserved = Number.isFinite(reserved) ? reserved : null;
    const knownObserved = Number.isFinite(observed) ? observed : null;
    const unknown = Number(result.rows[0]?.unknown);
    const knownUnknown = Number.isFinite(unknown) ? unknown : null;
    usage = {
      windowKey,
      settled: knownSettled,
      reserved: knownReserved,
      observed: knownObserved,
      unknown: knownUnknown,
      inFlight: knownReserved,
      committed: knownSettled != null && knownReserved != null ? knownSettled + knownReserved : null,
      remaining: knownSettled != null && knownReserved != null && knownObserved != null && knownUnknown === 0
        ? Math.max(0, policy.allowance - knownSettled - knownReserved - knownObserved)
        : null,
      overage: knownSettled != null && knownReserved != null && knownObserved != null && knownUnknown === 0
        ? Math.max(0, knownSettled + knownReserved + knownObserved - policy.allowance)
        : null,
      ...(knownUnknown != null && knownUnknown > 0 ? { status: "partial", note: "Some observed usage has no reliable quantity/price; admission fails closed." } : {}),
    };
  } catch (error) {
    if ((error as { code?: string })?.code !== "42P01") throw error;
  }
  return { ...publicPolicy(row), usage };
}

function scopedEventWhere(projectId: string, scope: PolicyScope): { sql: string; params: unknown[] } {
  const params: unknown[] = [projectId];
  const clauses = ["project_id = $1", ...policyScopeClauses(scope, params)];
  return { sql: clauses.join(" AND "), params };
}

async function seedPolicyObservedUsage(pool: pg.Pool, row: Record<string, unknown>): Promise<number> {
  const policy = normalizeSpendingPolicy(row);
  if (isIdentityWindow(policy.window)) return 0;
  // Activation-start policies still backfill post-activation charges. The
  // observed source applies the explicit cutoff; only a malformed activation
  // row is skipped here (admission itself fails closed for that row).
  if (policy.periodStart === "activation"
    && (!policy.activatedAt || !Number.isFinite(new Date(policy.activatedAt).getTime()))) return 0;
  const windowKey = policyWindowKey(policy, new Date());
  const request: AdmissionRequest = {
    projectId: policy.projectId,
    admissionId: `policy-baseline:${policy.id}:${windowKey}`,
    provider: "observed",
    model: null,
    now: new Date(),
  };
  const observations = await createPostgresObservedUsageSource(pool)(policy, windowKey, request);
  // Resuming or editing re-reads the whole window; skip what's already
  // recorded with one lookup instead of a transaction per observation.
  const existing = await pool.query(
    "SELECT observation_id, quantity, unknown FROM policy_observations WHERE policy_id = $1 AND window_key = $2",
    [policy.id, windowKey],
  );
  const known = new Map(existing.rows.map((row) => [String(row.observation_id), { quantity: row.quantity == null ? null : Number(row.quantity), unknown: Boolean(row.unknown) }]));
  const store = new PostgresReservationStore(pool);
  let recorded = 0;
  for (const observation of observations) {
    const quantity = observation.quantity;
    const prior = known.get(observation.observationId);
    if (prior && prior.quantity === (quantity ?? null) && prior.unknown === (observation.unknown ?? quantity == null)) continue;
    const result = await store.recordObserved?.({
      observationId: observation.observationId,
      policyId: observation.policyId,
      windowKey: observation.windowKey,
      unit: observation.unit,
      currency: observation.currency,
      quantity,
      unknown: observation.unknown ?? quantity == null,
      limit: observation.limit,
      occurredAt: observation.occurredAt,
    });
    if (result?.recorded) recorded += 1;
  }
  return recorded;
}

export { sanitizePolicy, publicPolicy, publicPolicyWithUsage, scopedEventWhere, workspaceFxForProject };

/**
 * Deliver one durable, idempotent warning for each canonical policy/window /
 * threshold. This intentionally uses shared policy usage, not legacy
 * budget_rules, and skips a window whose unknown exposure makes a percentage
 * untrustworthy. Notification failures are isolated from admission and are
 * reported by the caller's scheduler.
 */
function canonicalPolicyFindingId(projectId: string, policyId: string): string {
  const scope = JSON.stringify({ dimension: "policy", value: policyId });
  return `find_${createHash("sha256").update(`${projectId}\u0000allowance_trajectory\u0000${scope}`).digest("hex").slice(0, 24)}`;
}

async function persistCanonicalPolicyFinding(
  pool: pg.Pool,
  policy: SpendingPolicy,
  orgId: string,
  exposure: number,
  ratio: number,
  windowKey: string,
): Promise<void> {
  const findingId = canonicalPolicyFindingId(policy.projectId, policy.id);
  const scope = { dimension: "policy", value: policy.id };
  const evidence = {
    policyName: policy.name ?? null,
    committedUsage: exposure,
    allowance: policy.allowance,
    highestRatio: ratio,
    windowKey,
    policyVersion: policy.version ?? null,
    basis: "policy_window_usage",
  };
  try {
    await pool.query(
      `INSERT INTO findings (
         id, project_id, family, scope, state, observed_at, last_seen_at,
         baseline, evidence, next_actions
       ) VALUES ($1,$2,'allowance_trajectory',$3::jsonb,'new',NOW(),NOW(),NULL,$4::jsonb,$5::jsonb)
       ON CONFLICT (project_id, family, scope) DO UPDATE SET
         state = CASE WHEN findings.state = 'no_longer_outside_threshold' THEN 'new'
                      WHEN findings.state = 'acknowledged' THEN 'updated'
                      ELSE findings.state END,
         last_seen_at = NOW(), evidence = EXCLUDED.evidence,
         next_actions = EXCLUDED.next_actions,
         occurrence_count = findings.occurrence_count + 1,
         updated_at = NOW()`,
      [findingId, policy.projectId, JSON.stringify(scope), JSON.stringify(evidence), JSON.stringify([
        ratio >= 1 ? "Inspect policy decisions" : "Review allowance scope and trajectory",
      ])],
    );
  } catch (error) {
    if ((error as { code?: string })?.code === "42P01") return;
    throw error;
  }
  // Notification outbox dedupe is keyed by finding identity; changing the
  // evidence does not create duplicate deliveries during each checker tick.
  try {
    await dispatchFindingNotification(pool, {
      orgId,
      projectId: policy.projectId,
      findingId,
      title: ratio >= 1 ? "A spending policy allowance was reached" : "A spending policy allowance is nearing its limit",
      message: `Policy ${policy.name ?? policy.id} has committed exposure at ${Math.round(ratio * 100)}% of its allowance.`,
      evidence: {
        policyId: policy.id,
        allowance: policy.allowance,
        observedUsage: exposure,
        threshold: ratio >= 1 ? 1 : 0.8,
        windowKey,
        status: "warning",
        basis: "policy_window_usage",
      },
    });
  } catch (error) {
    console.error(`[costkey] canonical policy finding notification failed for ${policy.id}:`, error);
  }
}

/**
 * A per-call cap warns through the same outbox as window thresholds. The
 * window key is the UTC hour of the latest offending call, so the outbox
 * dedupe sends at most one warning per policy per hour.
 */
async function warnPerCallOverages(pool: pg.Pool, policy: SpendingPolicy, orgId: string): Promise<void> {
  const now = new Date();
  let summary;
  try {
    summary = await perCallUsageSummary(pool, policy, new Date(now.getTime() - PER_CALL_WARNING_LOOKBACK_MS), now);
  } catch (error) {
    if ((error as { code?: string })?.code === "42P01") return;
    throw error;
  }
  if (summary.overLimit === 0 || !summary.lastOverAt) return;
  try {
    await dispatchPolicyWarning(pool, {
      orgId,
      projectId: policy.projectId,
      policyId: policy.id,
      threshold: 1,
      windowKey: `call:${summary.lastOverAt.toISOString().slice(0, 13)}`,
      allowance: policy.allowance,
      observedUsage: summary.largest ?? policy.allowance,
    });
  } catch (error) {
    console.error(`[costkey] per-call policy warning dispatch failed for ${policy.id}:`, error);
  }
}

export async function runCanonicalPolicyWarnings(pool: pg.Pool): Promise<void> {
  let rows: Array<Record<string, unknown>>;
  try {
    const result = await pool.query(
      `SELECT sp.*, p.org_id
       FROM spending_policies sp
       JOIN projects p ON p.id = sp.project_id
       WHERE COALESCE(sp.status, 'active') = 'active'`,
    );
    rows = result.rows as Array<Record<string, unknown>>;
  } catch (error) {
    if ((error as { code?: string })?.code === "42P01") return;
    throw error;
  }

  for (const row of rows) {
    const policy = normalizeSpendingPolicy(row);
    if (!policy.id || !policy.projectId || policy.valid === false
      || !Number.isFinite(policy.allowance) || policy.allowance < 0) continue;
    if (policy.window === "per_call") {
      await warnPerCallOverages(pool, policy, String(row.org_id ?? ""));
      continue;
    }
    if (isIdentityWindow(policy.window)) continue;
    let currentWindow: string;
    try {
      currentWindow = policyWindowKey(policy, new Date());
    } catch {
      continue;
    }
    let usageResult;
    try {
      usageResult = await pool.query(
        `SELECT settled_quantity, reserved_quantity, observed_quantity, unknown_observations
         FROM policy_window_usage
         WHERE policy_id = $1 AND window_key = $2`,
        [policy.id, currentWindow],
      );
    } catch (error) {
      if ((error as { code?: string })?.code === "42P01") return;
      throw error;
    }
    const usageRow = usageResult.rows[0] as Record<string, unknown> | undefined;
    if (!usageRow) continue;
    const settled = Number(usageRow.settled_quantity);
    const reserved = Number(usageRow.reserved_quantity);
    const observed = Number(usageRow.observed_quantity);
    const unknown = Number(usageRow.unknown_observations);
    if (![settled, reserved, observed, unknown].every(Number.isFinite) || unknown > 0) continue;
    const exposure = settled + reserved + observed;
    const ratio = policy.allowance === 0 ? (exposure > 0 ? Infinity : 0) : exposure / policy.allowance;
    if (ratio >= 0.8) {
      // JSONB cannot represent Infinity; retain the exceeded state as a
      // finite 1.0 while the warning threshold still records 100%.
      await persistCanonicalPolicyFinding(pool, policy, String(row.org_id ?? ""), exposure, Number.isFinite(ratio) ? ratio : 1, currentWindow);
    }
    for (const threshold of [0.8, 1] as const) {
      if (ratio < threshold) continue;
      try {
        await dispatchPolicyWarning(pool, {
          orgId: String(row.org_id ?? ""),
          projectId: policy.projectId,
          policyId: policy.id,
          threshold,
          windowKey: currentWindow,
          allowance: policy.allowance,
          // The warning describes committed exposure (observed + settled +
          // in-flight), while the UI still displays each component separately.
          observedUsage: exposure,
        });
      } catch (error) {
        console.error(`[costkey] canonical policy warning dispatch failed for ${policy.id}:`, error);
      }
    }
  }
}

// ─── Spend query per rule ─────────────────────────────────────────────

async function getSpendForRule(
  pool: pg.Pool,
  projectId: string,
  scopeModel: string | null,
  scopeFunction: string | null,
): Promise<{ dailyUsd: number; monthlyUsd: number; callsLastMinute: number; tokensLastMinute: number }> {
  const wheres = ["project_id = $1"];
  const params: unknown[] = [projectId];
  let p = 1;

  if (scopeModel) {
    p++;
    params.push(globToLike(scopeModel));
    wheres.push(`model LIKE $${p} ESCAPE '\\'`);
  }
  if (scopeFunction) {
    p++;
    params.push(globToLike(scopeFunction));
    // Match against "bl_file:bl_function" OR just bl_function for convenience
    wheres.push(`(
      COALESCE(bl_file, '') || ':' || COALESCE(bl_function, '') LIKE $${p} ESCAPE '\\'
      OR COALESCE(bl_function, '') LIKE $${p} ESCAPE '\\'
    )`);
  }
  const whereSql = wheres.join(" AND ");

  const r = await pool.query(
    `SELECT
       COALESCE(SUM(CASE WHEN timestamp >= NOW() - INTERVAL '24 hours' THEN cost_usd END), 0)  AS daily_usd,
       COALESCE(SUM(CASE WHEN timestamp >= NOW() - INTERVAL '30 days'  THEN cost_usd END), 0)  AS monthly_usd,
       COALESCE(COUNT(*)          FILTER (WHERE timestamp >= NOW() - INTERVAL '1 minute'), 0) AS calls_last_minute,
       COALESCE(SUM(total_tokens) FILTER (WHERE timestamp >= NOW() - INTERVAL '1 minute'), 0) AS tokens_last_minute
     FROM events WHERE ${whereSql}`,
    params,
  );
  const row = r.rows[0] ?? {};
  return {
    dailyUsd: Number(row.daily_usd) || 0,
    monthlyUsd: Number(row.monthly_usd) || 0,
    callsLastMinute: Number(row.calls_last_minute) || 0,
    tokensLastMinute: Number(row.tokens_last_minute) || 0,
  };
}

function computeStatus(rule: BudgetRow, spend: Awaited<ReturnType<typeof getSpendForRule>>) {
  return {
    daily:   { spent: spend.dailyUsd,   limit: rule.daily_usd   != null ? Number(rule.daily_usd)   : null, pct: rule.daily_usd   ? spend.dailyUsd   / Number(rule.daily_usd)   : null },
    monthly: { spent: spend.monthlyUsd, limit: rule.monthly_usd != null ? Number(rule.monthly_usd) : null, pct: rule.monthly_usd ? spend.monthlyUsd / Number(rule.monthly_usd) : null },
    callsPerMinute:  { observed: spend.callsLastMinute,  limit: rule.calls_per_minute  ?? null },
    tokensPerMinute: { observed: spend.tokensLastMinute, limit: rule.tokens_per_minute ?? null },
  };
}

// ─── Dashboard routes ─────────────────────────────────────────────────

interface BudgetRow {
  id: string;
  project_id: string;
  name: string | null;
  scope_model: string | null;
  scope_function: string | null;
  daily_usd: number | null;
  monthly_usd: number | null;
  calls_per_minute: number | null;
  tokens_per_minute: number | null;
  on_exceed: string;
  alert_email: string | null;
  alert_webhook_url: string | null;
  alert_thresholds: number[];
  enabled: boolean;
}

export function createBudgetsRouter(pool: pg.Pool): Router {
  const router = createRouter();
  // Scope auth to dashboard budget paths. A router-level middleware would
  // also 401 the DSN-authenticated /api/v1/sdk/* routes mounted beside this
  // router when Express walks past a non-matching child route.
  router.use("/api/v1/projects/:id/budget", requireAuth);

  const ensureProjectInOrg = async (projectId: string, orgId: string): Promise<boolean> => {
    const r = await pool.query(`SELECT id FROM projects WHERE id = $1 AND org_id = $2`, [projectId, orgId]);
    return r.rows.length > 0;
  };

  const ensureRuleInOrg = async (ruleId: string, orgId: string): Promise<BudgetRow | null> => {
    const r = await pool.query(
      `SELECT br.* FROM budget_rules br
       JOIN projects p ON p.id = br.project_id
       WHERE br.id = $1 AND p.org_id = $2`,
      [ruleId, orgId],
    );
    return (r.rows[0] as BudgetRow | undefined) ?? null;
  };

  const ensurePolicyInOrg = async (policyId: string, orgId: string): Promise<Record<string, unknown> | null> => {
    const r = await pool.query(
      `SELECT sp.* FROM spending_policies sp
       JOIN projects p ON p.id = sp.project_id
       WHERE sp.id = $1 AND p.org_id = $2`,
      [policyId, orgId],
    );
    if (r.rows[0]) return r.rows[0] as Record<string, unknown>;
    try {
      const legacy = await pool.query(
        `SELECT br.* FROM budget_rules br
         JOIN projects p ON p.id = br.project_id
         WHERE br.id = $1 AND p.org_id = $2`,
        [policyId, orgId],
      );
      return (legacy.rows[0] as Record<string, unknown> | undefined) ?? null;
    } catch (error) {
      if ((error as { code?: string })?.code === "42P01") return null;
      throw error;
    }
  };

  // Canonical F06 policy list. Legacy /budget/rules remains available for
  // migration, but admission reads this table so the visible policy and the
  // server decision have one source of truth.
  router.get("/api/v1/projects/:id/budget/policies", async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const id = req.params["id"] as string;
      if (!(await ensureProjectInOrg(id, user.orgId))) {
        res.status(404).json({ error: "Project not found" });
        return;
      }
      let canonicalRows: Array<Record<string, unknown>> = [];
      try {
        const result = await pool.query(
          `SELECT * FROM spending_policies WHERE project_id = $1 ORDER BY created_at ASC, id ASC`,
          [id],
        );
        canonicalRows = result.rows as Array<Record<string, unknown>>;
      } catch (error) {
        if ((error as { code?: string })?.code !== "42P01") throw error;
      }
      let legacyRows: Array<Record<string, unknown>> = [];
      try {
        const legacy = await pool.query(
          `SELECT * FROM budget_rules WHERE project_id = $1 AND enabled = TRUE ORDER BY created_at ASC, id ASC`,
          [id],
        );
        legacyRows = legacy.rows as Array<Record<string, unknown>>;
      } catch (error) {
        if ((error as { code?: string })?.code !== "42P01") throw error;
      }
      const seen = new Set(canonicalRows.map((row) => String(row.id ?? row.policy_id ?? "")));
      const rows = [...canonicalRows, ...legacyRows.filter((row) => !seen.has(String(row.id ?? row.rule_id ?? "")))];
      const policies = await Promise.all(rows.map((row) => publicPolicyWithUsage(pool, row)));
      res.json({ policies });
    } catch (err) {
      console.error("[costkey] GET policies error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Capability/scope preview is deliberately read-only. It does not reserve,
  // activate, or mutate a policy; a call must still pass live admission.
  router.post("/api/v1/projects/:id/budget/policies/preview", async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const id = req.params["id"] as string;
      if (!(await ensureProjectInOrg(id, user.orgId))) {
        res.status(404).json({ error: "Project not found" });
        return;
      }
      const fx = await workspaceFxForProject(pool, id);
      const parsed = sanitizePolicy(req.body ?? {}, fx, await workspaceTimezoneForProject(pool, id));
      if ("error" in parsed) { res.status(parsed.status ?? 400).json({ error: parsed.error, ...(parsed.status === 409 ? { reason: "decision_unavailable", fx } : {}) }); return; }
      const capability = serverCapabilityReview(parsed.scope);
      const scopeFilter = scopedEventWhere(id, parsed.scope);
      const matching = await pool.query(
        `SELECT COUNT(*)::int AS observations,
                COUNT(*) FILTER (WHERE cost_usd IS NOT NULL)::int AS priced_observations
         FROM events WHERE ${scopeFilter.sql}
           AND COALESCE(event_type, 'call') = 'call'`,
        scopeFilter.params,
      );
      const row = matching.rows[0] ?? {};
      const wildcardFields = Object.entries(parsed.scope)
        .filter(([, value]) => !Array.isArray(value) && hasWildcard(value))
        .map(([field]) => field);
      res.json({
        policy: { projectId: id, ...parsed },
        capability,
        fx: parsed.unit === "money" && parsed.currency === "INR" ? fx : { available: true, rate: 1, source: "native USD", asOf: null },
        fxClientClaimIgnored: parsed.fx_client_claim_ignored,
        matchingHistory: {
          observations: Number(row.observations) || 0,
          pricedObservations: Number(row.priced_observations) || 0,
          scope: parsed.scope,
          note: "Preview history is observational; admission re-evaluates live context and shared reservations.",
        },
        scopeReview: {
          scope: parsed.scope,
          wildcardFields,
          matchDescription: Object.keys(parsed.scope).length === 0
            ? "Project-wide; every supported provider/model can match at runtime."
            : "A call matches when every configured scope dimension matches its known context.",
          overlappingPolicies: await overlappingPolicyReview(pool, id, parsed.scope),
        },
      });
    } catch (err) {
      console.error("[costkey] POST policy preview error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.post("/api/v1/projects/:id/budget/policies", async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      if (user.role !== "owner" && user.role !== "admin") {
        res.status(403).json({ error: "Only owners and admins can create spending policies" });
        return;
      }
      const id = req.params["id"] as string;
      if (!(await ensureProjectInOrg(id, user.orgId))) {
        res.status(404).json({ error: "Project not found" });
        return;
      }
      const fx = await workspaceFxForProject(pool, id);
      const parsed = sanitizePolicy(req.body ?? {}, fx, await workspaceTimezoneForProject(pool, id));
      if ("error" in parsed) { res.status(parsed.status ?? 400).json({ error: parsed.error, ...(parsed.status === 409 ? { reason: "decision_unavailable", fx } : {}) }); return; }
      const capability = serverCapabilityReview(parsed.scope);
      if (parsed.mode === "enforce" && !capabilityAllowsEnforcement(capability)) {
        res.status(409).json({ error: "Enforcement is unavailable for this provider scope", reason: "unsupported_integration", capability });
        return;
      }
      parsed.capability_review = parsed.mode === "enforce" ? capability : null;
      const policyId = `policy_${randomId()}`;
      const inserted = await pool.query(
        `INSERT INTO spending_policies (
           id, project_id, name, scope, mode, status, unit, allowance,
           currency, window_kind, timezone, period_start_mode, activated_at,
           usd_to_policy_currency, fx_rate, fx_source, fx_as_of,
           capability_review
         ) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb)
         RETURNING *`,
        [policyId, id, parsed.name, JSON.stringify(parsed.scope), parsed.mode, parsed.status,
         parsed.unit, parsed.allowance, parsed.currency, parsed.window_kind, parsed.timezone,
         parsed.period_start_mode, parsed.activated_at,
         parsed.usd_to_policy_currency, parsed.fx_rate, parsed.fx_source, parsed.fx_as_of,
         parsed.capability_review ? JSON.stringify(parsed.capability_review) : null],
      );
      const insertedRow = inserted.rows[0] as Record<string, unknown> | undefined;
      if (!insertedRow) { res.status(500).json({ error: "Policy was not created" }); return; }
      await seedPolicyObservedUsage(pool, insertedRow);
      res.status(201).json({ id: policyId, policy: await publicPolicyWithUsage(pool, insertedRow) });
    } catch (err) {
      console.error("[costkey] POST policy error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.get("/api/v1/projects/:id/budget/policies/:policyId", async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const id = req.params["id"] as string;
      const policyId = req.params["policyId"] as string;
      if (!(await ensureProjectInOrg(id, user.orgId))) {
        res.status(404).json({ error: "Project not found" });
        return;
      }
      const row = await ensurePolicyInOrg(policyId, user.orgId);
      if (!row || String(row.project_id) !== id) { res.status(404).json({ error: "Policy not found" }); return; }
      const serialized = await publicPolicyWithUsage(pool, row);
      res.json({ policy: serialized, capability: serialized["capability"] ?? null });
    } catch (err) {
      console.error("[costkey] GET policy error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  const updateCanonicalPolicy = async (req: Request, res: Response): Promise<void> => {
    try {
      const user = (req as any).user;
      if (user.role !== "owner" && user.role !== "admin") {
        res.status(403).json({ error: "Only owners and admins can edit spending policies" });
        return;
      }
      const id = req.params["id"] as string;
      const policyId = req.params["policyId"] as string;
      if (!(await ensureProjectInOrg(id, user.orgId))) { res.status(404).json({ error: "Project not found" }); return; }
      const existing = await ensurePolicyInOrg(policyId, user.orgId);
      if (!existing || String(existing.project_id) !== id) { res.status(404).json({ error: "Policy not found" }); return; }
      const body = req.method === "PATCH" ? { ...existing, ...req.body, scope: req.body?.scope ?? existing.scope, mode: req.body?.mode ?? existing.mode, unit: req.body?.unit ?? existing.unit, allowance: req.body?.allowance ?? existing.allowance, window: req.body?.window ?? existing.window_kind, timezone: req.body?.timezone ?? existing.timezone, periodStart: req.body?.periodStart ?? existing.period_start_mode, activatedAt: req.body?.activatedAt ?? existing.activated_at, currency: req.body?.currency ?? existing.currency, usdToPolicyCurrency: req.body?.usdToPolicyCurrency ?? existing.usd_to_policy_currency, capabilityReview: req.body?.capabilityReview ?? existing.capability_review, status: req.body?.status ?? (req.body?.enabled === false ? "paused" : req.body?.enabled === true ? "active" : existing.status) } : req.body ?? {};
      const fx = await workspaceFxForProject(pool, id);
      const parsed = sanitizePolicy(body, fx, await workspaceTimezoneForProject(pool, id));
      if ("error" in parsed) { res.status(parsed.status ?? 400).json({ error: parsed.error, ...(parsed.status === 409 ? { reason: "decision_unavailable", fx } : {}) }); return; }
      const capability = serverCapabilityReview(parsed.scope);
      if (parsed.mode === "enforce" && !capabilityAllowsEnforcement(capability)) {
        res.status(409).json({ error: "Enforcement is unavailable for this provider scope", reason: "unsupported_integration", capability });
        return;
      }
      parsed.capability_review = parsed.mode === "enforce" ? capability : null;
      const result = await pool.query(
        `UPDATE spending_policies SET
           name = $1, scope = $2::jsonb, mode = $3, status = $4,
           unit = $5, allowance = $6, currency = $7, window_kind = $8,
           timezone = $9, period_start_mode = $10, activated_at = $11,
           usd_to_policy_currency = $12, fx_rate = $13, fx_source = $14, fx_as_of = $15,
           capability_review = $16::jsonb,
           policy_version = COALESCE(policy_version, 1) + 1,
           updated_at = NOW()
         WHERE id = $17 AND project_id = $18
         RETURNING *`,
        [parsed.name, JSON.stringify(parsed.scope), parsed.mode, parsed.status, parsed.unit,
         parsed.allowance, parsed.currency, parsed.window_kind, parsed.timezone,
         parsed.period_start_mode, parsed.activated_at, parsed.usd_to_policy_currency,
         parsed.fx_rate, parsed.fx_source, parsed.fx_as_of,
         parsed.capability_review ? JSON.stringify(parsed.capability_review) : null,
         policyId, id],
      );
      if (!result.rows[0]) { res.status(404).json({ error: "Policy not found" }); return; }
      // A paused or archived policy checks nothing; resuming seeds the window.
      if (parsed.status === "active") await seedPolicyObservedUsage(pool, result.rows[0] as Record<string, unknown>);
      res.json({ policy: await publicPolicyWithUsage(pool, result.rows[0] as Record<string, unknown>) });
    } catch (err) {
      console.error("[costkey] UPDATE policy error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  };
  router.put("/api/v1/projects/:id/budget/policies/:policyId", updateCanonicalPolicy);
  router.patch("/api/v1/projects/:id/budget/policies/:policyId", updateCanonicalPolicy);

  router.get("/api/v1/projects/:id/budget/policies/:policyId/decisions", async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const id = req.params["id"] as string;
      const policyId = req.params["policyId"] as string;
      if (!(await ensureProjectInOrg(id, user.orgId))) { res.status(404).json({ error: "Project not found" }); return; }
      const policy = await ensurePolicyInOrg(policyId, user.orgId);
      if (!policy || String(policy.project_id) !== id) { res.status(404).json({ error: "Policy not found" }); return; }
      const result = await pool.query(
        `SELECT d.id, d.project_id, d.policy_id, d.policy_version,
                d.admission_id, d.request_id, d.decision, d.refusal,
                d.reservation_id, d.created_at,
                r.state AS reservation_state, r.outcome AS reservation_outcome,
                r.settled_at
         FROM policy_decisions d
         LEFT JOIN policy_reservations r
           ON r.project_id = d.project_id AND r.reservation_id = d.reservation_id
         WHERE d.project_id = $1 AND d.policy_id = $2
         ORDER BY d.created_at DESC LIMIT 100`,
        [id, policyId],
      );
      res.json({ decisions: result.rows });
    } catch (err) {
      console.error("[costkey] GET policy decisions error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.delete("/api/v1/projects/:id/budget/policies/:policyId", async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      if (user.role !== "owner" && user.role !== "admin") { res.status(403).json({ error: "Only owners and admins can archive spending policies" }); return; }
      const id = req.params["id"] as string;
      const policyId = req.params["policyId"] as string;
      if (!(await ensureProjectInOrg(id, user.orgId))) { res.status(404).json({ error: "Project not found" }); return; }
      const result = await pool.query(
        `UPDATE spending_policies SET status = 'archived', updated_at = NOW()
         WHERE id = $1 AND project_id = $2 RETURNING *`,
        [policyId, id],
      );
      if (!result.rows[0]) { res.status(404).json({ error: "Policy not found" }); return; }
      res.json({ policy: await publicPolicyWithUsage(pool, result.rows[0]) });
    } catch (err) {
      console.error("[costkey] ARCHIVE policy error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // List all rules for a project + live status per rule
  router.get("/api/v1/projects/:id/budget/rules", async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const id = req.params["id"] as string;
      if (!(await ensureProjectInOrg(id, user.orgId))) {
        res.status(404).json({ error: "Project not found" });
        return;
      }
      const r = await pool.query(
        `SELECT * FROM budget_rules WHERE project_id = $1 ORDER BY
           (scope_model IS NULL AND scope_function IS NULL) DESC,
           created_at ASC`,
        [id],
      );
      const rules = await Promise.all(r.rows.map(async (row: BudgetRow) => {
        const spend = await getSpendForRule(pool, row.project_id, row.scope_model, row.scope_function);
        return { ...row, status: computeStatus(row, spend) };
      }));
      res.json({ rules });
    } catch (err) {
      console.error("[costkey] GET rules error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Create a rule
  router.post("/api/v1/projects/:id/budget/rules", async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      if (user.role !== "owner" && user.role !== "admin") {
        res.status(403).json({ error: "Only owners and admins can create budget rules" });
        return;
      }
      const id = req.params["id"] as string;
      if (!(await ensureProjectInOrg(id, user.orgId))) {
        res.status(404).json({ error: "Project not found" });
        return;
      }
      const parsed = sanitizeRule(req.body ?? {});
      if ("error" in parsed) { res.status(400).json({ error: parsed.error }); return; }

      const ruleId = `rule_${randomId()}`;
      await pool.query(
        `INSERT INTO budget_rules (
           id, project_id, name, scope_model, scope_function,
           daily_usd, monthly_usd, calls_per_minute, tokens_per_minute,
           on_exceed, alert_email, alert_webhook_url, alert_thresholds, enabled
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          ruleId, id, parsed.name, parsed.scope_model, parsed.scope_function,
          parsed.daily_usd, parsed.monthly_usd, parsed.calls_per_minute, parsed.tokens_per_minute,
          parsed.on_exceed, parsed.alert_email, parsed.alert_webhook_url,
          parsed.alert_thresholds, parsed.enabled,
        ],
      );
      res.status(201).json({ id: ruleId });
    } catch (err) {
      console.error("[costkey] POST rule error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Update a rule
  router.put("/api/v1/projects/:id/budget/rules/:ruleId", async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      if (user.role !== "owner" && user.role !== "admin") {
        res.status(403).json({ error: "Only owners and admins can edit budget rules" });
        return;
      }
      const ruleId = req.params["ruleId"] as string;
      const existing = await ensureRuleInOrg(ruleId, user.orgId);
      if (!existing) { res.status(404).json({ error: "Rule not found" }); return; }

      const parsed = sanitizeRule(req.body ?? {});
      if ("error" in parsed) { res.status(400).json({ error: parsed.error }); return; }

      await pool.query(
        `UPDATE budget_rules SET
           name = $1, scope_model = $2, scope_function = $3,
           daily_usd = $4, monthly_usd = $5,
           calls_per_minute = $6, tokens_per_minute = $7,
           on_exceed = $8, alert_email = $9, alert_webhook_url = $10,
           alert_thresholds = $11, enabled = $12, updated_at = NOW()
         WHERE id = $13`,
        [
          parsed.name, parsed.scope_model, parsed.scope_function,
          parsed.daily_usd, parsed.monthly_usd,
          parsed.calls_per_minute, parsed.tokens_per_minute,
          parsed.on_exceed, parsed.alert_email, parsed.alert_webhook_url,
          parsed.alert_thresholds, parsed.enabled, ruleId,
        ],
      );
      res.json({ ok: true });
    } catch (err) {
      console.error("[costkey] PUT rule error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Delete a rule
  router.delete("/api/v1/projects/:id/budget/rules/:ruleId", async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      if (user.role !== "owner" && user.role !== "admin") {
        res.status(403).json({ error: "Only owners and admins can delete budget rules" });
        return;
      }
      const ruleId = req.params["ruleId"] as string;
      const existing = await ensureRuleInOrg(ruleId, user.orgId);
      if (!existing) { res.status(404).json({ error: "Rule not found" }); return; }
      await pool.query(`DELETE FROM budget_rules WHERE id = $1`, [ruleId]);
      res.json({ ok: true });
    } catch (err) {
      console.error("[costkey] DELETE rule error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Firing history (per-project — joined across all rules for that project)
  router.get("/api/v1/projects/:id/budget/firings", async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const id = req.params["id"] as string;
      if (!(await ensureProjectInOrg(id, user.orgId))) {
        res.status(404).json({ error: "Project not found" });
        return;
      }
      const r = await pool.query(
        `SELECT f.id, f.rule_id, f.scope, f.threshold, f.window_key, f.fired_at,
                f.spent_usd, f.limit_usd,
                r.name AS rule_name, r.scope_model, r.scope_function
         FROM budget_alert_firings f
         JOIN budget_rules r ON r.id = f.rule_id
         WHERE f.project_id = $1
         ORDER BY f.fired_at DESC
         LIMIT 50`,
        [id],
      );
      res.json({ firings: r.rows });
    } catch (err) {
      console.error("[costkey] GET firings error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}

// ─── Background checker ───────────────────────────────────────────────

function windowKey(scope: "daily" | "monthly"): string {
  const d = new Date();
  return scope === "daily"
    ? `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`
    : `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function describeScope(rule: BudgetRow): string {
  const bits: string[] = [];
  if (rule.scope_model)    bits.push(`model: ${rule.scope_model}`);
  if (rule.scope_function) bits.push(`function: ${rule.scope_function}`);
  if (bits.length === 0)   return "project-wide";
  return bits.join(" · ");
}

async function checkRule(pool: pg.Pool, rule: BudgetRow, projectName: string): Promise<void> {
  if (!rule.enabled) return;
  const spend = await getSpendForRule(pool, rule.project_id, rule.scope_model, rule.scope_function);

  const checks: Array<{ scope: "daily" | "monthly"; spent: number; limit: number }> = [];
  if (rule.daily_usd   && Number(rule.daily_usd)   > 0) checks.push({ scope: "daily",   spent: spend.dailyUsd,   limit: Number(rule.daily_usd) });
  if (rule.monthly_usd && Number(rule.monthly_usd) > 0) checks.push({ scope: "monthly", spent: spend.monthlyUsd, limit: Number(rule.monthly_usd) });

  for (const c of checks) {
    const pct = c.spent / c.limit;
    for (const threshold of rule.alert_thresholds) {
      if (pct < threshold) continue;
      const wk = windowKey(c.scope);
      const id = `bfire_${randomId()}`;
      const inserted = await pool.query(
        `INSERT INTO budget_alert_firings (id, rule_id, project_id, scope, threshold, window_key, spent_usd, limit_usd)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (rule_id, scope, threshold, window_key) DO NOTHING
         RETURNING id`,
        [id, rule.id, rule.project_id, c.scope, threshold, wk, c.spent, c.limit],
      );
      if (inserted.rows.length === 0) continue;

      const level = threshold >= 1.0 ? "critical" : threshold >= 0.8 ? "warn" : "info";
      const pctInt = Math.round(threshold * 100);
      const scopeDesc = describeScope(rule);
      const ruleLabel = rule.name ?? scopeDesc;
      const subject = `CostKey: ${projectName} [${ruleLabel}] at ${pctInt}% of ${c.scope} budget`;
      const body =
        `Project ${projectName}\nRule: ${ruleLabel} (${scopeDesc})\n\n` +
        `Spent $${c.spent.toFixed(2)} of $${c.limit.toFixed(2)} ${c.scope} budget (${Math.round(pct * 100)}%).\n` +
        `Threshold crossed: ${pctInt}%.\n\nDashboard: ${publicAppUrl()}\n`;

      if (rule.alert_webhook_url) {
        try {
          const delivery = await dispatchWebhook(
            rule.alert_webhook_url,
            process.env["COSTKEY_LEGACY_WEBHOOK_SECRET"] ?? null,
            {
              eventType: "budget_alert",
              orgId: "legacy",
              projectId: rule.project_id,
              title: subject,
              message: body,
              scope: { scope: c.scope, level, ruleId: rule.id, ruleName: rule.name, ruleScope: scopeDesc },
              evidence: { threshold, pct, spent: c.spent, limit: c.limit, project: projectName },
            },
            `budget_${rule.id}_${wk}_${threshold}`,
          );
          if (delivery.status === "failed") {
            console.error(`[costkey] webhook alert failed for rule ${rule.id}:`, delivery.error ?? "delivery failed");
          } else if (delivery.status === "suppressed") {
            console.warn(`[costkey] webhook alert suppressed for rule ${rule.id}:`, delivery.error ?? "delivery suppressed");
          }
        } catch (err) { console.error(`[costkey] webhook alert failed for rule ${rule.id}:`, err); }
      }
      if (rule.alert_email) {
        try {
          await getResend().emails.send({
            from: "CostKey Alerts <alerts@costkey.dev>",
            to: rule.alert_email,
            subject,
            text: body,
          });
        } catch (err) { console.error(`[costkey] email alert failed for rule ${rule.id}:`, err); }
      }
      console.log(`[costkey] budget alert: ${rule.project_id} [${ruleLabel}] ${c.scope} ${pctInt}% ($${c.spent.toFixed(2)}/$${c.limit.toFixed(2)})`);
    }
  }
}

export async function runBudgetChecks(pool: pg.Pool): Promise<void> {
  try {
    const r = await pool.query(
      `SELECT br.*, p.name AS project_name
       FROM budget_rules br
       JOIN projects p ON p.id = br.project_id
       WHERE br.enabled = TRUE`,
    );
    for (const row of r.rows) {
      await checkRule(pool, row, row.project_name);
    }
  } catch (err) {
    console.error("[costkey] budget checker error:", err);
  }
  try {
    await runCanonicalPolicyWarnings(pool);
  } catch (err) {
    // Policy warnings are an outbox side effect. Never turn a notification
    // failure into a policy/admission failure or suppress legacy checks.
    console.error("[costkey] canonical policy checker error:", err);
  }
}

export function startBudgetChecker(pool: pg.Pool, intervalMs = 5 * 60 * 1000): NodeJS.Timeout {
  setTimeout(() => void runBudgetChecks(pool), 10_000);
  const timer = setInterval(() => void runBudgetChecks(pool), intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return timer;
}
