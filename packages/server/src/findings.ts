import { createHash } from "node:crypto";
import type pg from "pg";
import {
  aggregateForecastTraces,
  type ForecastTrace,
} from "./forecast.js";
import {
  chargesCte,
  loadCanonicalCharges,
  type CanonicalCharge,
} from "./charge-cohort.js";

export type FindingFamily =
  | "expensive_trace"
  | "increased_unit_cost"
  | "allowance_trajectory"
  | "coverage_deterioration";

export interface Finding {
  id: string;
  projectId: string;
  family: FindingFamily;
  state: "new" | "acknowledged" | "updated" | "no_longer_outside_threshold";
  scope: Record<string, unknown>;
  observedAt: string;
  lastSeenAt: string;
  baseline: Record<string, unknown> | null;
  evidence: Record<string, unknown>;
  nextActions: string[];
  occurrenceCount: number;
  acknowledgedAt?: string | null;
  acknowledgedBy?: string | null;
}

interface FindingCandidate {
  family: FindingFamily;
  scope: Record<string, unknown>;
  observedAt: string;
  baseline: Record<string, unknown> | null;
  evidence: Record<string, unknown>;
  nextActions: string[];
}

interface ExistingFinding {
  id: string;
  state: string;
  observed_at: string;
  occurrence_count: number;
  evidence: Record<string, unknown>;
}

export interface FindingThresholds {
  expensiveSample: number;
  expensiveMultiplier: number;
  expensiveMinAbsolute: number;
  unitSample: number;
  unitMinRelative: number;
  unitMinImpact: number;
  coverageMinDrop: number;
  allowanceMinRatio: number;
}

export const DEFAULT_FINDING_THRESHOLDS: FindingThresholds = {
  expensiveSample: 20,
  expensiveMultiplier: 3,
  expensiveMinAbsolute: 0.05,
  unitSample: 20,
  unitMinRelative: 0.5,
  unitMinImpact: 1,
  coverageMinDrop: 0.1,
  allowanceMinRatio: 0.8,
};

const DAY_MS = 24 * 60 * 60 * 1000;
const FINDING_WINDOW_DAYS = 30;
export const MAX_FINDING_CHARGES = 100_000;

function num(value: unknown): number {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
}

function finiteCost(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function asDate(value: unknown): Date | null {
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

function stableJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object" || Array.isArray(value)) return JSON.stringify(value);
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function findingId(projectId: string, family: FindingFamily, scope: Record<string, unknown>): string {
  return `find_${createHash("sha256").update(`${projectId}\u0000${family}\u0000${stableJson(scope)}`).digest("hex").slice(0, 24)}`;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function iso(value: Date): string {
  return value.toISOString();
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return (value ?? fallback) as T;
}

function currentWindow(observedAt: Date): { currentStart: Date; previousStart: Date } {
  const currentStart = new Date(observedAt.getTime() - 7 * DAY_MS);
  const previousStart = new Date(observedAt.getTime() - 14 * DAY_MS);
  return { currentStart, previousStart };
}

function within(trace: ForecastTrace, from: Date, to: Date): boolean {
  const started = asDate(trace.startedAt);
  return Boolean(started && started >= from && started < to);
}

function sameComparableScope(a: ForecastTrace, b: ForecastTrace): boolean {
  return a.feature === b.feature
    && a.environment === b.environment
    && a.function === b.function
    && a.traceName === b.traceName;
}

function traceCost(trace: ForecastTrace): number | null {
  return trace.fullyPriced ? finiteCost(trace.knownCost) : null;
}

function traceDifferences(current: ForecastTrace, baseline: ForecastTrace[]): Record<string, unknown> {
  const baselineModels = new Set(baseline.flatMap((item) => item.models));
  const baselineProviders = new Set(baseline.flatMap((item) => item.providers));
  const baselineServices = new Set(baseline.map((item) => item.service).filter((value): value is string => Boolean(value)));
  const baselineReleases = new Set(baseline.map((item) => item.release).filter((value): value is string => Boolean(value)));
  const baselineContextKeys = new Set(baseline.flatMap((item) => item.contextKeys ?? []));
  const baselineAttempts = baseline.map((item) => item.attemptCount);
  return {
    observedModels: current.models,
    observedProviders: current.providers,
    observedService: current.service,
    observedRelease: current.release,
    observedAttemptCount: current.attemptCount,
    baselineModels: [...baselineModels].sort(),
    baselineProviders: [...baselineProviders].sort(),
    baselineServices: [...baselineServices].sort(),
    baselineReleases: [...baselineReleases].sort(),
    observedContextKeys: current.contextKeys ?? [],
    baselineContextKeys: [...baselineContextKeys].sort(),
    changedContextKeys: (current.contextKeys ?? []).filter((key) => !baselineContextKeys.has(key)),
    baselineMedianAttemptCount: median(baselineAttempts),
    modelChanged: current.models.some((model) => !baselineModels.has(model)),
    providerChanged: current.providers.some((provider) => !baselineProviders.has(provider)),
    serviceChanged: current.service !== null && !baselineServices.has(current.service),
    releaseChanged: current.release !== null && !baselineReleases.has(current.release),
    attemptCountChanged: current.attemptCount !== median(baselineAttempts),
  };
}

function traceScope(trace: ForecastTrace): Record<string, unknown> {
  return {
    traceId: trace.traceId,
    traceName: trace.traceName,
    feature: trace.feature,
    environment: trace.environment,
    function: trace.function,
  };
}

function traceIds(traces: ForecastTrace[]): string[] {
  return traces.map((trace) => trace.traceId).sort();
}

function sampleSufficiency(available: number, required: number): Record<string, unknown> {
  return { available, required, sufficient: available >= required };
}

function traceRows(charges: CanonicalCharge[]): ForecastTrace[] {
  return aggregateForecastTraces(charges).traces;
}

function thresholdNumber(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function thresholdInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function thresholdsFromRow(row: Record<string, unknown> | undefined): FindingThresholds {
  return {
    expensiveSample: thresholdInteger(row?.expensive_sample, DEFAULT_FINDING_THRESHOLDS.expensiveSample, 1, 1_000),
    expensiveMultiplier: thresholdNumber(row?.expensive_multiplier, DEFAULT_FINDING_THRESHOLDS.expensiveMultiplier, 1, 100),
    expensiveMinAbsolute: thresholdNumber(row?.expensive_min_absolute, DEFAULT_FINDING_THRESHOLDS.expensiveMinAbsolute, 0, 1_000_000),
    unitSample: thresholdInteger(row?.unit_sample, DEFAULT_FINDING_THRESHOLDS.unitSample, 1, 1_000),
    unitMinRelative: thresholdNumber(row?.unit_min_relative, DEFAULT_FINDING_THRESHOLDS.unitMinRelative, 0, 100),
    unitMinImpact: thresholdNumber(row?.unit_min_impact, DEFAULT_FINDING_THRESHOLDS.unitMinImpact, 0, 1_000_000),
    coverageMinDrop: thresholdNumber(row?.coverage_min_drop, DEFAULT_FINDING_THRESHOLDS.coverageMinDrop, 0, 1),
    allowanceMinRatio: thresholdNumber(row?.allowance_min_ratio, DEFAULT_FINDING_THRESHOLDS.allowanceMinRatio, 0, 1),
  };
}

/** Read project finding sensitivity without changing state. */
export async function loadFindingThresholds(
  pool: pg.Pool | pg.PoolClient,
  projectId: string,
): Promise<FindingThresholds> {
  try {
    const table = await pool.query("SELECT to_regclass('finding_thresholds') AS table_name");
    if (!table.rows?.[0]?.table_name) return { ...DEFAULT_FINDING_THRESHOLDS };
    const result = await pool.query(
      `SELECT expensive_sample, expensive_multiplier, expensive_min_absolute,
              unit_sample, unit_min_relative, unit_min_impact,
              coverage_min_drop, allowance_min_ratio
       FROM finding_thresholds WHERE project_id = $1`,
      [projectId],
    );
    return thresholdsFromRow(result.rows?.[0] as Record<string, unknown> | undefined);
  } catch (error) {
    // The additive table may not exist during a rolling upgrade. A caller
    // still gets deterministic safe defaults; no request should fail merely
    // because threshold storage has not reached this process yet.
    const code = (error as { code?: string }).code;
    if (code === "42P01" || code === "42703") return { ...DEFAULT_FINDING_THRESHOLDS };
    throw error;
  }
}

interface FindingChargeWindow {
  charges: CanonicalCharge[];
  observedAt: Date;
  truncated: boolean;
}

/**
 * Load only the windows needed by findings and cap returned charges. The
 * latest timestamp query keeps the comparison boundary independent of an
 * arbitrary process clock when delayed telemetry arrives.
 */
async function loadFindingChargeWindow(
  pool: pg.Pool | pg.PoolClient,
  projectId: string,
): Promise<FindingChargeWindow> {
  // The latest call or usage record; building every charge to read one timestamp scanned all of them.
  const latest = await pool.query(
    `SELECT GREATEST(
       (SELECT MAX(e.timestamp) FROM events e WHERE e.project_id = $1 AND COALESCE(e.event_type, 'call') = 'call'),
       (SELECT MAX(COALESCE(u.accounting_at, u.observed_at)) FROM usage_components u WHERE u.project_id = $1)
     ) AS latest_timestamp`,
    [projectId],
  );
  const latestTimestamp = asDate(latest.rows?.[0]?.latest_timestamp);
  const observedAt = latestTimestamp ? new Date(latestTimestamp.getTime() + 1) : new Date();
  const from = new Date(observedAt.getTime() - FINDING_WINDOW_DAYS * DAY_MS);
  const loaded = await loadCanonicalCharges(pool, projectId, { from: from.toISOString(), to: observedAt.toISOString() }, { limit: MAX_FINDING_CHARGES + 1, order: "desc" });
  const truncated = loaded.length > MAX_FINDING_CHARGES;
  return {
    charges: loaded.slice(0, MAX_FINDING_CHARGES).reverse(),
    observedAt,
    truncated,
  };
}

export function expensiveTraceCandidates(
  traces: ForecastTrace[],
  observedAt: Date,
  thresholds: FindingThresholds = DEFAULT_FINDING_THRESHOLDS,
): FindingCandidate[] {
  const { currentStart, previousStart } = currentWindow(observedAt);
  const current = traces.filter((trace) => within(trace, currentStart, observedAt));
  const baseline = traces.filter((trace) => within(trace, previousStart, currentStart));
  const candidates: FindingCandidate[] = [];
  for (const candidate of current) {
    const currentCost = traceCost(candidate);
    if (currentCost === null) continue;
    const comparable = baseline.filter((trace) => trace.fullyPriced && sameComparableScope(candidate, trace));
    if (comparable.length < thresholds.expensiveSample) continue;
    const priorMedian = median(comparable.map((trace) => traceCost(trace)!));
    if (currentCost < priorMedian * thresholds.expensiveMultiplier || currentCost < priorMedian + thresholds.expensiveMinAbsolute) continue;
    candidates.push({
      family: "expensive_trace",
      scope: traceScope(candidate),
      observedAt: candidate.startedAt,
      baseline: {
        comparableTraces: comparable.length,
        medianCost: priorMedian,
        windowStart: iso(previousStart),
        windowEnd: iso(currentStart),
      },
      evidence: {
        traceCost: currentCost,
        absoluteDifference: currentCost - priorMedian,
        relativeDifference: priorMedian > 0 ? currentCost / priorMedian - 1 : null,
        thresholds: { multiplier: thresholds.expensiveMultiplier, minimumAbsolute: thresholds.expensiveMinAbsolute },
        sampleSufficiency: sampleSufficiency(comparable.length, thresholds.expensiveSample),
        pricedOnly: true,
        affectedTraceIds: [candidate.traceId],
        supportingTraceIds: traceIds(comparable),
        observedDifferences: traceDifferences(candidate, comparable),
      },
      nextActions: ["Inspect contributing calls", "Compare model, retry, and context changes"],
    });
  }
  return candidates;
}

function scopeKey(trace: ForecastTrace): string {
  return stableJson({
    feature: trace.feature,
    environment: trace.environment,
    function: trace.function,
    traceName: trace.traceName,
  });
}

function distribution(traces: ForecastTrace[]): Record<string, unknown> {
  const models = new Map<string, number>();
  const providers = new Map<string, number>();
  let attempts = 0;
  for (const trace of traces) {
    for (const model of trace.models) models.set(model, (models.get(model) ?? 0) + 1);
    for (const provider of trace.providers) providers.set(provider, (providers.get(provider) ?? 0) + 1);
    attempts += trace.attemptCount;
  }
  return {
    models: Object.fromEntries([...models.entries()].sort(([a], [b]) => a.localeCompare(b))),
    providers: Object.fromEntries([...providers.entries()].sort(([a], [b]) => a.localeCompare(b))),
    totalAttempts: attempts,
  };
}

export function increasedUnitCostCandidates(
  traces: ForecastTrace[],
  observedAt: Date,
  thresholds: FindingThresholds = DEFAULT_FINDING_THRESHOLDS,
): FindingCandidate[] {
  const { currentStart, previousStart } = currentWindow(observedAt);
  const buckets = new Map<string, { sample: ForecastTrace; current: ForecastTrace[]; previous: ForecastTrace[] }>();
  for (const trace of traces) {
    const key = scopeKey(trace);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { sample: trace, current: [], previous: [] };
      buckets.set(key, bucket);
    }
    if (within(trace, currentStart, observedAt)) bucket.current.push(trace);
    else if (within(trace, previousStart, currentStart)) bucket.previous.push(trace);
  }
  const candidates: FindingCandidate[] = [];
  for (const bucket of buckets.values()) {
    const current = bucket.current.filter((trace) => trace.fullyPriced && traceCost(trace) !== null);
    const previous = bucket.previous.filter((trace) => trace.fullyPriced && traceCost(trace) !== null);
    if (current.length < thresholds.unitSample || previous.length < thresholds.unitSample) continue;
    const currentCost = current.reduce((sum, trace) => sum + traceCost(trace)!, 0);
    const previousCost = previous.reduce((sum, trace) => sum + traceCost(trace)!, 0);
    const currentUnit = currentCost / current.length;
    const previousUnit = previousCost / previous.length;
    const relative = previousUnit > 0 ? currentUnit / previousUnit - 1 : null;
    const passesRelative = previousUnit === 0 ? currentUnit > 0 : relative! >= thresholds.unitMinRelative;
    if (!passesRelative || currentCost - previousCost < thresholds.unitMinImpact) continue;
    const scope = {
      dimension: "trace",
      feature: bucket.sample.feature,
      environment: bucket.sample.environment,
      function: bucket.sample.function,
      traceName: bucket.sample.traceName,
    };
    candidates.push({
      family: "increased_unit_cost",
      scope,
      observedAt: iso(observedAt),
      baseline: {
        previousCount: previous.length,
        previousUnitCost: previousUnit,
        previousCost,
        windowStart: iso(previousStart),
        windowEnd: iso(currentStart),
      },
      evidence: {
        currentCount: current.length,
        currentUnitCost: currentUnit,
        currentCost,
        absoluteDifference: currentUnit - previousUnit,
        relativeDifference: relative,
        activityChange: current.length - previous.length,
        thresholds: { minimumRelative: thresholds.unitMinRelative, minimumImpact: thresholds.unitMinImpact },
        sampleSufficiency: {
          current: sampleSufficiency(current.length, thresholds.unitSample),
          previous: sampleSufficiency(previous.length, thresholds.unitSample),
        },
        supportingTraceIds: { current: traceIds(current), previous: traceIds(previous) },
        observedDistributions: { current: distribution(current), previous: distribution(previous) },
        excludedUnpriced: {
          current: bucket.current.length - current.length,
          previous: bucket.previous.length - previous.length,
        },
      },
      nextActions: ["Compare equal-duration traces", "Inspect model, release, and retry composition"],
    });
  }
  return candidates;
}

function hasAttribution(charge: CanonicalCharge): boolean {
  const context = charge.context;
  const feature = context && typeof context["feature"] === "string" ? context["feature"] : null;
  const customer = context && typeof context["customer"] === "string" ? context["customer"] : null;
  return Boolean(charge.bl_file || charge.bl_function || feature || customer);
}

export function coverageCandidates(
  charges: CanonicalCharge[],
  observedAt: Date,
  thresholds: FindingThresholds = DEFAULT_FINDING_THRESHOLDS,
): FindingCandidate[] {
  const currentStart = new Date(observedAt.getTime() - DAY_MS);
  const previousStart = new Date(observedAt.getTime() - 2 * DAY_MS);
  const current = charges.filter((charge) => {
    const timestamp = asDate(charge.timestamp);
    return Boolean(timestamp && timestamp >= currentStart && timestamp < observedAt);
  });
  const previous = charges.filter((charge) => {
    const timestamp = asDate(charge.timestamp);
    return Boolean(timestamp && timestamp >= previousStart && timestamp < currentStart);
  });
  if (current.length === 0 || previous.length === 0) return [];
  const currentPriced = current.filter((charge) => finiteCost(charge.cost_usd) !== null).length;
  const previousPriced = previous.filter((charge) => finiteCost(charge.cost_usd) !== null).length;
  const currentAttributed = current.filter(hasAttribution).length;
  const previousAttributed = previous.filter(hasAttribution).length;
  const currentPricingCoverage = currentPriced / current.length;
  const previousPricingCoverage = previousPriced / previous.length;
  const currentAttributionCoverage = currentAttributed / current.length;
  const previousAttributionCoverage = previousAttributed / previous.length;
  const pricingDrop = previousPricingCoverage - currentPricingCoverage;
  const attributionDrop = previousAttributionCoverage - currentAttributionCoverage;
  if (pricingDrop < thresholds.coverageMinDrop && attributionDrop < thresholds.coverageMinDrop) return [];
  const affected = current.filter((charge) => finiteCost(charge.cost_usd) === null || !hasAttribution(charge));
  return [{
    family: "coverage_deterioration",
    scope: { dimension: "project" },
    observedAt: iso(observedAt),
    baseline: {
      previousPricingCoverage,
      previousAttributionCoverage,
      previousTotal: previous.length,
      windowStart: iso(previousStart),
      windowEnd: iso(currentStart),
    },
    evidence: {
      currentPricingCoverage,
      currentAttributionCoverage,
      currentTotal: current.length,
      unpricedCount: current.length - currentPriced,
      unattributedCount: current.length - currentAttributed,
      pricingDrop,
      attributionDrop,
      thresholds: { minimumDrop: thresholds.coverageMinDrop },
      sampleSufficiency: sampleSufficiency(current.length, 1),
      affectedChargeKeys: affected.map((charge) => charge.charge_key).sort(),
      affectedTraceIds: affected.map((charge) => charge.trace_id).filter((id): id is string => Boolean(id)).sort(),
      basis: "canonical_charge_cohort",
    },
    nextActions: pricingDrop >= attributionDrop
      ? ["Check supported model pricing", "Inspect unpriced calls"]
      : ["Check context and source attribution", "Inspect unassigned calls"],
  }];
}

function globMatch(pattern: unknown, value: string | null): boolean {
  if (pattern === null || pattern === undefined || pattern === "") return true;
  if (typeof pattern !== "string" || value === null) return false;
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`).test(value);
}

function ruleMatches(rule: Record<string, unknown>, charge: CanonicalCharge): boolean {
  return globMatch(rule.scope_model, charge.model)
    && globMatch(rule.scope_function, charge.bl_file || charge.bl_function
      ? `${charge.bl_file ?? ""}:${charge.bl_function ?? ""}` : null);
}

export async function allowanceCandidates(
  pool: pg.Pool | pg.PoolClient,
  projectId: string,
  charges: CanonicalCharge[],
  observedAt: Date,
  thresholds: FindingThresholds = DEFAULT_FINDING_THRESHOLDS,
): Promise<FindingCandidate[]> {
  const result = await pool.query(
    `SELECT br.id AS rule_id, br.name AS rule_name,
            br.scope_model, br.scope_function,
            br.daily_usd, br.monthly_usd
     FROM budget_rules br
     WHERE br.project_id = $1 AND br.enabled = TRUE
       AND (br.daily_usd IS NOT NULL OR br.monthly_usd IS NOT NULL)`,
    [projectId],
  );
  const candidates: FindingCandidate[] = [];
  for (const row of result.rows ?? []) {
    const rule = row as Record<string, unknown>;
    const matching = charges.filter((charge) => ruleMatches(rule, charge));
    const dailyStart = new Date(observedAt.getTime() - DAY_MS);
    const monthlyStart = new Date(observedAt.getTime() - 30 * DAY_MS);
    const dailyCharges = matching.filter((charge) => {
      const timestamp = asDate(charge.timestamp);
      return Boolean(timestamp && timestamp >= dailyStart && timestamp < observedAt);
    });
    const monthlyCharges = matching.filter((charge) => {
      const timestamp = asDate(charge.timestamp);
      return Boolean(timestamp && timestamp >= monthlyStart && timestamp < observedAt);
    });
    const known = (items: CanonicalCharge[]): number => items.reduce((sum, charge) => sum + (finiteCost(charge.cost_usd) ?? 0), 0);
    const unknown = (items: CanonicalCharge[]): number => items.filter((charge) => finiteCost(charge.cost_usd) === null).length;
    const dailyLimit = finiteCost(rule.daily_usd);
    const monthlyLimit = finiteCost(rule.monthly_usd);
    const dailySpend = known(dailyCharges);
    const monthlySpend = known(monthlyCharges);
    const dailyRatio = dailyLimit === null ? 0 : dailyLimit === 0 ? (dailySpend > 0 ? Infinity : 0) : dailySpend / dailyLimit;
    const monthlyRatio = monthlyLimit === null ? 0 : monthlyLimit === 0 ? (monthlySpend > 0 ? Infinity : 0) : monthlySpend / monthlyLimit;
    const highestRatio = Math.max(dailyRatio, monthlyRatio);
    if (highestRatio < thresholds.allowanceMinRatio) continue;
    candidates.push({
      family: "allowance_trajectory",
      scope: { dimension: "policy", value: String(rule.rule_id) },
      observedAt: iso(observedAt),
      baseline: null,
      evidence: {
        policyName: rule.rule_name ?? null,
        dailySpend,
        dailyLimit,
        monthlySpend,
        monthlyLimit,
        highestRatio,
        sampleSufficiency: sampleSufficiency(matching.length, 1),
        unknownDailyCharges: unknown(dailyCharges),
        unknownMonthlyCharges: unknown(monthlyCharges),
        thresholds: { minimumRatio: thresholds.allowanceMinRatio },
        supportingTraceIds: traceIds(traceRows(matching)),
        basis: "canonical_charge_cohort",
      },
      nextActions: [highestRatio >= 1 ? "Inspect policy decisions" : "Review allowance scope and trajectory"],
    });
  }
  return candidates;
}

function chronologyFor(
  candidate: FindingCandidate,
  previous: ExistingFinding | undefined,
): Record<string, unknown> {
  const oldEvidence = previous?.evidence ?? {};
  const oldChronology = parseJson<Record<string, unknown>>(oldEvidence["chronology"], {});
  const events = Array.isArray(oldChronology["events"])
    ? oldChronology["events"].filter((item) => item && typeof item === "object")
    : [];
  const lastEvent = events[events.length - 1] as Record<string, unknown> | undefined;
  if (!lastEvent || lastEvent["observedAt"] !== candidate.observedAt) {
    events.push({ observedAt: candidate.observedAt, state: previous?.state ?? "new" });
  }
  return {
    firstObservedAt: previous?.observed_at ?? candidate.observedAt,
    lastObservedAt: candidate.observedAt,
    occurrenceCount: (previous?.occurrence_count ?? 0) + 1,
    events: events.slice(-50),
  };
}

async function loadExistingFindings(pool: pg.Pool | pg.PoolClient, projectId: string): Promise<ExistingFinding[]> {
  const result = await pool.query(
    `SELECT f.id, f.state, f.observed_at, f.occurrence_count, f.evidence
     FROM findings f WHERE f.project_id = $1`,
    [projectId],
  );
  return (result.rows ?? []).map((row) => ({
    id: String(row.id),
    state: String(row.state),
    observed_at: String(row.observed_at),
    occurrence_count: num(row.occurrence_count),
    evidence: parseJson<Record<string, unknown>>(row.evidence, {}) ?? {},
  }));
}

async function persistFinding(
  pool: pg.Pool | pg.PoolClient,
  projectId: string,
  candidate: FindingCandidate,
  previous: ExistingFinding | undefined,
): Promise<void> {
  const id = findingId(projectId, candidate.family, candidate.scope);
  const evidence = {
    ...candidate.evidence,
    chronology: chronologyFor(candidate, previous),
  };
  await pool.query(
    `INSERT INTO findings (
       id, project_id, family, scope, state, observed_at, last_seen_at,
       baseline, evidence, next_actions, occurrence_count
     ) VALUES ($1,$2,$3,$4,'new',$5,$5,$6,$7,$8,1)
     ON CONFLICT (id) DO UPDATE SET
       last_seen_at = EXCLUDED.last_seen_at,
       baseline = EXCLUDED.baseline,
       evidence = EXCLUDED.evidence,
       next_actions = EXCLUDED.next_actions,
       occurrence_count = findings.occurrence_count + 1,
       state = CASE
         WHEN findings.state = 'acknowledged' THEN 'updated'
         WHEN findings.state = 'no_longer_outside_threshold' THEN 'new'
         ELSE findings.state
       END,
       updated_at = NOW()`,
    [id, projectId, candidate.family, JSON.stringify(candidate.scope), candidate.observedAt,
      candidate.baseline ? JSON.stringify(candidate.baseline) : null,
      JSON.stringify(evidence), JSON.stringify(candidate.nextActions)],
  );
}

async function markNoLongerOutsideThreshold(
  pool: pg.Pool | pg.PoolClient,
  projectId: string,
  previous: ExistingFinding[],
  seen: Set<string>,
  observedAt: Date,
): Promise<void> {
  for (const finding of previous) {
    if (seen.has(finding.id) || finding.state === "no_longer_outside_threshold") continue;
    const evidence = {
      ...finding.evidence,
      chronology: {
        ...(parseJson<Record<string, unknown>>(finding.evidence["chronology"], {}) ?? {}),
        noLongerOutsideThresholdAt: iso(observedAt),
      },
    };
    await pool.query(
      `UPDATE findings f
       SET state = 'no_longer_outside_threshold', evidence = $1, updated_at = NOW()
       WHERE f.id = $2 AND f.project_id = $3`,
      [JSON.stringify(evidence), finding.id, projectId],
    );
  }
}

/** Compute and persist factual findings for one project from the canonical cohort. */
export async function refreshFindings(pool: pg.Pool | pg.PoolClient, projectId: string): Promise<void> {
  const thresholds = await loadFindingThresholds(pool, projectId);
  const window = await loadFindingChargeWindow(pool, projectId);
  const { charges, observedAt } = window;
  const traces = traceRows(charges);
  const candidates = [
    ...expensiveTraceCandidates(traces, observedAt, thresholds),
    ...increasedUnitCostCandidates(traces, observedAt, thresholds),
    ...coverageCandidates(charges, observedAt, thresholds),
    ...await allowanceCandidates(pool, projectId, charges, observedAt, thresholds),
  ];
  if (window.truncated) {
    // A capped refresh must not silently look complete. Keep existing
    // findings readable, but annotate any newly persisted evidence with the
    // bounded-cohort warning below via a dedicated synthetic coverage note.
    for (const candidate of candidates) {
      candidate.evidence = {
        ...candidate.evidence,
        cohortBound: { maxCharges: MAX_FINDING_CHARGES, truncated: true },
      };
    }
  }
  const previous = await loadExistingFindings(pool, projectId);
  const previousById = new Map(previous.map((finding) => [finding.id, finding]));
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const id = findingId(projectId, candidate.family, candidate.scope);
    seen.add(id);
    await persistFinding(pool, projectId, candidate, previousById.get(id));
  }
  await markNoLongerOutsideThreshold(pool, projectId, previous, seen, observedAt);
}

const scheduledRefreshes = new Map<string, NodeJS.Timeout>();

async function refreshFindingsLocked(pool: pg.Pool, projectId: string): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const lock = await client.query(
      "SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS acquired",
      [`findings:${projectId}`],
    );
    if (!lock.rows[0]?.acquired) {
      await client.query("ROLLBACK");
      return false;
    }
    await refreshFindings(client, projectId);
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Debounce refreshes caused by a burst of calls/components for one project. */
export function scheduleFindingsRefresh(pool: pg.Pool, projectId: string, delayMs = 1000): void {
  const prior = scheduledRefreshes.get(projectId);
  if (prior) clearTimeout(prior);
  const timer = setTimeout(() => {
    scheduledRefreshes.delete(projectId);
    lastIngestRefreshAt.set(projectId, Date.now());
    void refreshFindingsLocked(pool, projectId).then((acquired) => {
      if (!acquired) scheduleFindingsRefresh(pool, projectId, delayMs);
    }).catch((error) => {
      console.error("[costkey] Background findings refresh error:", error instanceof Error ? error.message : error);
    });
  }, Math.max(0, delayMs));
  timer.unref();
  scheduledRefreshes.set(projectId, timer);
}

/** The most a project's findings are recomputed because calls keep arriving. */
const INGEST_REFRESH_INTERVAL_MS = 60_000;
const lastIngestRefreshAt = new Map<string, number>();

/**
 * Refresh findings after new calls, at most once a minute per project. A
 * refresh rebuilds the window's charges; started after every batch, a
 * project that sends calls every few seconds kept one running all the time,
 * and the console's own requests waited behind it.
 */
export function scheduleFindingsRefreshAfterIngest(pool: pg.Pool, projectId: string): void {
  // A refresh already waiting will include these calls.
  if (scheduledRefreshes.has(projectId)) return;
  const sinceLast = Date.now() - (lastIngestRefreshAt.get(projectId) ?? 0);
  scheduleFindingsRefresh(pool, projectId, Math.max(1000, INGEST_REFRESH_INTERVAL_MS - sinceLast));
}

/** Refresh every project with captured activity for a periodic worker. */
/** The latest call each project's findings were refreshed at, in this process. */
const lastRefreshedAt = new Map<string, string>();

async function latestChargeAt(pool: pg.Pool, projectId: string): Promise<string | null> {
  const result = await pool.query(
    `SELECT GREATEST(
       (SELECT MAX(e.timestamp) FROM events e WHERE e.project_id = $1),
       (SELECT MAX(COALESCE(u.accounting_at, u.observed_at)) FROM usage_components u WHERE u.project_id = $1)
     ) AS latest`,
    [projectId],
  );
  const latest = result.rows?.[0]?.latest;
  return latest == null ? null : new Date(latest).toISOString();
}

export async function refreshAllFindings(pool: pg.Pool): Promise<{ refreshed: number; skipped: number; failed: number }> {
  const projects = await pool.query(
    `SELECT DISTINCT p.id
     FROM projects p
     WHERE EXISTS (SELECT 1 FROM events e WHERE e.project_id = p.id)
        OR EXISTS (SELECT 1 FROM usage_components u WHERE u.project_id = p.id)`,
  );
  let refreshed = 0;
  let skipped = 0;
  let failed = 0;
  for (const row of projects.rows ?? []) {
    try {
      // Findings only change with new calls: skip a project with none since its last refresh.
      const projectId = String(row.id);
      const latest = await latestChargeAt(pool, projectId);
      if (latest !== null && lastRefreshedAt.get(projectId) === latest) { skipped++; continue; }
      if (await refreshFindingsLocked(pool, projectId)) {
        refreshed++;
        if (latest !== null) lastRefreshedAt.set(projectId, latest);
      } else skipped++;
    } catch (error) {
      failed++;
      console.error("[costkey] Periodic findings refresh error:", error instanceof Error ? error.message : error);
    }
  }
  return { refreshed, skipped, failed };
}

function toFinding(row: Record<string, unknown>): Finding {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    family: row.family as FindingFamily,
    state: row.state as Finding["state"],
    scope: parseJson<Record<string, unknown>>(row.scope, {}),
    observedAt: String(row.observed_at),
    lastSeenAt: String(row.last_seen_at),
    baseline: parseJson<Record<string, unknown> | null>(row.baseline, null),
    evidence: parseJson<Record<string, unknown>>(row.evidence, {}) ?? {},
    nextActions: parseJson<string[]>(row.next_actions, []),
    occurrenceCount: num(row.occurrence_count),
    acknowledgedAt: row.acknowledged_at == null ? null : String(row.acknowledged_at),
    acknowledgedBy: row.acknowledged_by == null ? null : String(row.acknowledged_by),
  };
}

export async function listFindings(
  pool: pg.Pool,
  projectId: string,
  includeAcknowledged = true,
): Promise<Finding[]> {
  const stateClause = includeAcknowledged ? "" : "AND f.state IN ('new', 'updated')";
  const result = await pool.query(
    `SELECT f.id, f.project_id, f.family, f.scope, f.state, f.observed_at, f.last_seen_at,
            f.baseline, f.evidence, f.next_actions, f.occurrence_count,
            f.acknowledged_at, f.acknowledged_by
     FROM findings f WHERE f.project_id = $1 ${stateClause}
     ORDER BY f.last_seen_at DESC LIMIT 100`,
    [projectId],
  );
  return (result.rows ?? []).map((row) => toFinding(row as Record<string, unknown>));
}

export async function getFinding(pool: pg.Pool, projectId: string, findingIdValue: string): Promise<Finding | null> {
  const result = await pool.query(
    `SELECT f.id, f.project_id, f.family, f.scope, f.state, f.observed_at, f.last_seen_at,
            f.baseline, f.evidence, f.next_actions, f.occurrence_count,
            f.acknowledged_at, f.acknowledged_by
     FROM findings f WHERE f.project_id = $1 AND f.id = $2`,
    [projectId, findingIdValue],
  );
  return result.rows?.[0] ? toFinding(result.rows[0] as Record<string, unknown>) : null;
}

export async function acknowledgeFinding(
  pool: pg.Pool,
  projectId: string,
  findingIdValue: string,
  userId: string | null,
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE findings f
     SET state = 'acknowledged', acknowledged_at = NOW(), acknowledged_by = $1, updated_at = NOW()
     WHERE f.id = $2 AND f.project_id = $3
     RETURNING id`,
    [userId, findingIdValue, projectId],
  );
  return (result.rows ?? []).length > 0;
}
