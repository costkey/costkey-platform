import type pg from "pg";
import {
  eligibleCreditEstimate,
  type EligibleCreditEstimate,
} from "./credits.js";
import {
  loadDailyAggregates,
  loadCanonicalCharges,
  type CanonicalCharge,
  type DailyAggregateRow,
  type ChargeScope,
} from "./charge-cohort.js";

export type ForecastUnit = "operations" | "users" | "conversations";

/** The analytics input is intentionally additive to the shared charge scope. */
export interface ForecastScope extends ChargeScope {
  operations?: number | null;
  volume?: number | null;
  users?: number | null;
  conversations?: number | null;
  operationsPerUser?: number | null;
  /** @deprecated Conversation forecasts aggregate cost per conversation; this is ignored. */
  operationsPerConversation?: number | null;
  volumeUnit?: ForecastUnit | string | null;
  unit?: ForecastUnit | string | null;
  assumedCostPerOperation?: number | null;
  assumedCostPerUnit?: number | null;
  manualCostPerOperation?: number | null;
  targetPeriodDays?: number | null;
  currency?: string;
  accountScope?: string | null;
  cloudProject?: string | null;
  /** Workspace timezone. Kept on the request because the project scope owns it. */
  timezone?: string | null;
  workspaceTimezone?: string | null;
  /** Fixed calculation instant makes saved scenarios reproducible and testable. */
  asOf?: string | null;
  /** Opt in to a baseline made only from fully priced activity. */
  fullyPricedOnly?: boolean;
}

export interface ForecastResult {
  scope: ForecastScope;
  calculatedAt: string;
  calculation: {
    asOf: string;
    timezone: string;
    pricingBasis: "canonical_charge_cohort";
    observedWindow: { from: string; to: string };
    currentPaceWindow: { from: string; to: string; periodDays: number };
    cohortLimit: number;
    cohortTruncated: boolean;
  };
  observed: {
    costCurrency: "USD";
    from: string;
    to: string;
    /** Trace observations, never raw provider calls. */
    observations: number;
    pricedObservations: number;
    unpricedObservations: number;
    knownCost: number | null;
    pricingCoverage: number | null;
    meanCostPerOperation: number | null;
    chargeObservations: number;
    pricedCharges: number;
    unpricedCharges: number;
    traceObservations: number;
    fullyPricedTraces: number;
    incompleteTraces: number;
    excludedActivity: ExcludedActivity;
  };
  currentPace: {
    costCurrency: "USD";
    available: boolean;
    reason: string | null;
    completedElapsedDays: number;
    periodDays: number;
    knownCost: number | null;
    projectedCost: number | null;
    pricingCoverage: number | null;
    excludedUnpriced: number;
    method: string;
  };
  chosenScale: {
    costCurrency: "USD";
    available: boolean;
    automatic: boolean;
    reason: string | null;
    unit: ForecastUnit;
    volume: number | null;
    operations: number | null;
    operationsPerUser: number | null;
    costPerOperation: number | null;
    costPerUnit: number | null;
    projectedCost: number | null;
    sampleSize: number;
    requiredSampleSize: number;
    sampleSufficient: boolean;
    fullyPricedTraces: number;
    excludedUnpriced: number;
    excludedActivity: ExcludedActivity;
    selectionBiasWarning: boolean;
    pricingBasis: "canonical_charge_cohort" | "manual_assumption" | null;
    assumptions: {
      volumeOnly: boolean;
      manualCostPerUnit: number | null;
      targetPeriodDays: number | null;
      unitBasis: "operation" | "user" | "conversation";
      formula: string;
    };
  };
  cash: {
    available: boolean;
    reason: string | null;
    originalAmount: number | null;
    eligibleCredits: number | null;
    estimatedPayable: number | null;
    currency: string;
    /** Monetary calculations remain USD even when an eligible cash display is converted. */
    originalCurrency: "USD";
    byProvider: Record<string, { balance: number; eligible: number }>;
  };
}

export interface ExcludedActivity {
  unpricedTraceIds: string[];
  unpricedChargeCount: number;
  untracedChargeKeys: string[];
  unidentifiedConversationTraceIds: string[];
  count: number;
  reasons: string[];
}

export interface ForecastTrace {
  traceId: string;
  traceName: string | null;
  feature: string | null;
  environment: string | null;
  function: string | null;
  customer: string | null;
  service: string | null;
  release: string | null;
  conversationId: string | null;
  knownCost: number | null;
  chargeCount: number;
  pricedChargeCount: number;
  unpricedChargeCount: number;
  fullyPriced: boolean;
  startedAt: string;
  endedAt: string;
  providers: string[];
  models: string[];
  contextKeys?: string[];
  attemptCount: number;
}

export class ForecastInputError extends Error {
  readonly code = "invalid_forecast_scope";
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = "ForecastInputError";
  }
}

const REQUIRED_SAMPLE_SIZE = 20;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Keep a forecast request bounded even for very high-volume projects. */
export const MAX_FORECAST_WINDOW_DAYS = 395;
export const MAX_FORECAST_CHARGES = 100_000;

function dateValue(value: unknown): Date | null {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== "string" && typeof value !== "number") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function finite(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function nonNegative(value: unknown): number | null {
  const number = finite(value);
  return number !== null && number >= 0 ? number : null;
}

function numericCost(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function chargeTimestamp(charge: CanonicalCharge): Date | null {
  return dateValue(charge.timestamp);
}

function contextValue(charge: CanonicalCharge, key: string): string | null {
  const context = charge.context;
  if (!context || typeof context !== "object") return null;
  const value = context[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function conversationId(charge: CanonicalCharge): string | null {
  for (const key of [
    "conversationId", "conversation_id", "sessionId", "session_id", "conversation", "session",
  ]) {
    const value = contextValue(charge, key);
    if (value) return value;
  }
  return null;
}

function functionName(charge: CanonicalCharge): string | null {
  const file = charge.bl_file?.trim() ?? "";
  const fn = charge.bl_function?.trim() ?? "";
  if (!file && !fn) return null;
  return `${file}:${fn}`;
}

function addSet(target: Set<string>, value: string | null | undefined): void {
  if (value) target.add(value);
}

function minDate(current: Date | null, candidate: Date): Date {
  return current && current < candidate ? current : candidate;
}

function maxDate(current: Date | null, candidate: Date): Date {
  return current && current > candidate ? current : candidate;
}

function traceKey(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Aggregate one canonical cohort into trace observations. Exported for seam tests. */
export function aggregateForecastTraces(charges: CanonicalCharge[]): {
  traces: ForecastTrace[];
  untracedCharges: CanonicalCharge[];
} {
  const grouped = new Map<string, CanonicalCharge[]>();
  const untracedCharges: CanonicalCharge[] = [];
  for (const charge of charges) {
    const id = traceKey(charge.trace_id);
    if (!id) {
      untracedCharges.push(charge);
      continue;
    }
    const existing = grouped.get(id);
    if (existing) existing.push(charge);
    else grouped.set(id, [charge]);
  }

  const traces: ForecastTrace[] = [];
  for (const [traceId, items] of grouped) {
    let knownCost = 0;
    let pricedChargeCount = 0;
    let unpricedChargeCount = 0;
    let started: Date | null = null;
    let ended: Date | null = null;
    const providers = new Set<string>();
    const models = new Set<string>();
    const contextKeys = new Set<string>();
    const attempts = new Set<string>();
    let traceName: string | null = null;
    let feature: string | null = null;
    let environment: string | null = null;
    let customer: string | null = null;
    let service: string | null = null;
    let release: string | null = null;
    let fn: string | null = null;
    let conversation: string | null = null;

    for (const charge of items) {
      const timestamp = chargeTimestamp(charge);
      if (timestamp) {
        started = minDate(started, timestamp);
        const duration = finite(charge.duration_ms);
        const end = duration !== null ? new Date(timestamp.getTime() + Math.max(0, duration)) : timestamp;
        ended = maxDate(ended, end);
      }
      const cost = numericCost(charge.cost_usd);
      if (cost === null) unpricedChargeCount += 1;
      else {
        pricedChargeCount += 1;
        knownCost += cost;
      }
      addSet(providers, charge.provider);
      addSet(models, charge.model);
      if (charge.context && typeof charge.context === "object") {
        for (const key of Object.keys(charge.context)) {
          if (!/prompt|body|secret|token|password|credential/i.test(key)) contextKeys.add(key);
        }
      }
      addSet(attempts, charge.record_type === "call" ? charge.charge_key : null);
      traceName ??= charge.trace_name;
      feature ??= contextValue(charge, "feature");
      environment ??= contextValue(charge, "environment");
      customer ??= contextValue(charge, "customer");
      service ??= charge.service ?? contextValue(charge, "service");
      release ??= charge.release ?? contextValue(charge, "release");
      fn ??= functionName(charge);
      conversation ??= conversationId(charge);
    }
    const fallback = started ?? new Date(0);
    const finalEnd = ended ?? fallback;
    traces.push({
      traceId,
      traceName,
      feature,
      environment,
      function: fn,
      customer,
      service,
      release,
      conversationId: conversation,
      knownCost: pricedChargeCount > 0 ? knownCost : null,
      chargeCount: items.length,
      pricedChargeCount,
      unpricedChargeCount,
      fullyPriced: items.length > 0 && unpricedChargeCount === 0,
      startedAt: fallback.toISOString(),
      endedAt: finalEnd.toISOString(),
      providers: [...providers].sort(),
      models: [...models].sort(),
      contextKeys: [...contextKeys].sort(),
      attemptCount: attempts.size || items.filter((item) => item.record_type === "call").length,
    });
  }
  traces.sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.traceId.localeCompare(b.traceId));
  return { traces, untracedCharges };
}

function excludedActivity(
  traces: ForecastTrace[],
  untracedCharges: CanonicalCharge[],
): ExcludedActivity {
  const incomplete = traces.filter((trace) => !trace.fullyPriced);
  const unpricedTraceIds = incomplete.map((trace) => trace.traceId).sort();
  const unpricedChargeCount = incomplete.reduce((sum, trace) => sum + trace.unpricedChargeCount, 0);
  const untracedChargeKeys = untracedCharges.map((charge) => charge.charge_key).sort();
  const reasons: string[] = [];
  if (unpricedTraceIds.length > 0) reasons.push("unknown prices in one or more trace children");
  if (untracedChargeKeys.length > 0) reasons.push("billable activity has no trace identity");
  return {
    unpricedTraceIds,
    unpricedChargeCount,
    untracedChargeKeys,
    unidentifiedConversationTraceIds: [],
    count: unpricedTraceIds.length + untracedChargeKeys.length,
    reasons,
  };
}

function calendarParts(at: Date, timezone: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const value = (type: string): number => Number(parts.find((part) => part.type === type)?.value);
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    second: value("second"),
  };
}

function validateTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
  } catch {
    throw new ForecastInputError(`Invalid workspace timezone: ${timezone}`);
  }
}

function localOffsetMilliseconds(at: Date, timezone: string): number {
  const parts = calendarParts(at, timezone);
  const wall = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return wall - at.getTime();
}

/** Convert a local wall-clock midnight to UTC, including DST transitions. */
export function zonedMidnight(year: number, month: number, day: number, timezone: string): Date {
  let guess = Date.UTC(year, month - 1, day);
  for (let index = 0; index < 4; index += 1) {
    const next = Date.UTC(year, month - 1, day) - localOffsetMilliseconds(new Date(guess), timezone);
    if (next === guess) break;
    guess = next;
  }
  return new Date(guess);
}

function calendarDayNumber(year: number, month: number, day: number): number {
  return Math.floor(Date.UTC(year, month - 1, day) / DAY_MS);
}

export interface CurrentPaceWindow {
  from: Date;
  completedTo: Date;
  periodEnd: Date;
  periodDays: number;
  completedElapsedDays: number;
}

export function currentPaceWindow(asOf: Date, timezone: string): CurrentPaceWindow {
  validateTimezone(timezone);
  const local = calendarParts(asOf, timezone);
  const from = zonedMidnight(local.year, local.month, 1, timezone);
  const nextMonth = local.month === 12
    ? { year: local.year + 1, month: 1 }
    : { year: local.year, month: local.month + 1 };
  const periodEnd = zonedMidnight(nextMonth.year, nextMonth.month, 1, timezone);
  const completedTo = zonedMidnight(local.year, local.month, local.day, timezone);
  const startDay = calendarDayNumber(local.year, local.month, 1);
  const currentDay = calendarDayNumber(local.year, local.month, local.day);
  const periodDays = calendarDayNumber(nextMonth.year, nextMonth.month, 1) - startDay;
  return {
    from,
    completedTo,
    periodEnd,
    periodDays,
    completedElapsedDays: Math.max(0, currentDay - startDay),
  };
}

function periodBounds(scope: ForecastScope, asOf: Date): { from: Date; to: Date } {
  const hasFrom = scope.from !== undefined && scope.from !== null && scope.from !== "";
  const hasTo = scope.to !== undefined && scope.to !== null && scope.to !== "";
  const from = hasFrom ? dateValue(scope.from) : new Date(asOf.getTime() - 30 * DAY_MS);
  const to = hasTo ? dateValue(scope.to) : asOf;
  if ((hasFrom && !from) || (hasTo && !to)) throw new ForecastInputError("from and to must be valid ISO dates");
  if (!from || !to || from >= to) throw new ForecastInputError("Forecast range must satisfy from < to");
  if (to.getTime() - from.getTime() > MAX_FORECAST_WINDOW_DAYS * DAY_MS) {
    throw new ForecastInputError(`Forecast range cannot exceed ${MAX_FORECAST_WINDOW_DAYS} days`);
  }
  return { from, to };
}

function validateTargetPeriodDays(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const days = finite(value);
  if (days === null || days <= 0) throw new ForecastInputError("targetPeriodDays must be greater than zero");
  return days;
}

function inWindow(charge: CanonicalCharge, from: Date, to: Date): boolean {
  const timestamp = chargeTimestamp(charge);
  return Boolean(timestamp && timestamp >= from && timestamp < to);
}

function sumKnown(charges: CanonicalCharge[]): { known: number | null; priced: number; unpriced: number } {
  let known = 0;
  let priced = 0;
  let unpriced = 0;
  for (const charge of charges) {
    const cost = numericCost(charge.cost_usd);
    if (cost === null) unpriced += 1;
    else {
      priced += 1;
      known += cost;
    }
  }
  return { known: priced > 0 ? known : null, priced, unpriced };
}

function sumDailyKnown(rows: DailyAggregateRow[]): { known: number | null; priced: number; unpriced: number; observations: number } {
  let known = 0;
  let priced = 0;
  let unpriced = 0;
  let observations = 0;
  for (const row of rows) {
    known += Number(row.known_cost_usd ?? 0);
    priced += Number(row.priced_observations ?? 0);
    unpriced += Number(row.unpriced_observations ?? 0);
    observations += Number(row.observations ?? 0);
  }
  return { known: priced > 0 ? known : null, priced, unpriced, observations };
}

interface VolumeSelection {
  unit: ForecastUnit;
  volume: number | null;
  operations: number | null;
  operationsPerUser: number | null;
  error: string | null;
}

function selectVolume(scope: ForecastScope): VolumeSelection {
  const rawUnit = scope.volumeUnit ?? scope.unit ?? (
    scope.users !== null && scope.users !== undefined ? "users"
      : scope.conversations !== null && scope.conversations !== undefined ? "conversations" : "operations"
  );
  const unit = rawUnit === "operations" || rawUnit === "users" || rawUnit === "conversations" ? rawUnit : null;
  if (!unit) return { unit: "operations", volume: null, operations: null, operationsPerUser: null, error: "volumeUnit must be operations, users, or conversations" };

  if (unit === "operations") {
    const value = nonNegative(scope.operations ?? scope.volume);
    return {
      unit,
      volume: value,
      operations: value,
      operationsPerUser: null,
      error: value === null ? "Enter a non-negative operation volume" : null,
    };
  }
  if (unit === "users") {
    const users = nonNegative(scope.users ?? scope.volume);
    const operationsPerUser = nonNegative(scope.operationsPerUser);
    if (users === null) return { unit, volume: null, operations: null, operationsPerUser, error: "Enter a non-negative user volume" };
    if (operationsPerUser === null) return { unit, volume: users, operations: null, operationsPerUser, error: "Users-based forecasts require operationsPerUser" };
    return { unit, volume: users, operations: users * operationsPerUser, operationsPerUser, error: null };
  }
  const conversations = nonNegative(scope.conversations ?? scope.volume);
  if (conversations === null) return { unit, volume: null, operations: null, operationsPerUser: null, error: "Enter a non-negative conversation volume" };
  return { unit, volume: conversations, operations: null, operationsPerUser: null, error: null };
}

function mean(values: number[]): number | null {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function conversationUnits(traces: ForecastTrace[]): {
  units: ForecastTrace[][];
  unidentified: string[];
} {
  const byConversation = new Map<string, ForecastTrace[]>();
  const unidentified: string[] = [];
  for (const trace of traces) {
    if (!trace.conversationId) {
      unidentified.push(trace.traceId);
      continue;
    }
    const existing = byConversation.get(trace.conversationId);
    if (existing) existing.push(trace);
    else byConversation.set(trace.conversationId, [trace]);
  }
  return { units: [...byConversation.values()], unidentified: unidentified.sort() };
}

function unavailableCredit(currency: string, reason: string): EligibleCreditEstimate {
  return {
    available: false,
    reason,
    originalAmount: null,
    eligibleAmount: null,
    estimatedPayable: null,
    currency,
    byProvider: {},
  };
}

function chargeScope(scope: ForecastScope): ChargeScope {
  const {
    operations: _operations,
    volume: _volume,
    users: _users,
    conversations: _conversations,
    operationsPerUser: _operationsPerUser,
    operationsPerConversation: _operationsPerConversation,
    volumeUnit: _volumeUnit,
    unit: _unit,
    assumedCostPerOperation: _assumedCostPerOperation,
    assumedCostPerUnit: _assumedCostPerUnit,
    manualCostPerOperation: _manualCostPerOperation,
    targetPeriodDays: _targetPeriodDays,
    currency: _currency,
    accountScope: _accountScope,
    cloudProject: _cloudProject,
    timezone: _timezone,
    workspaceTimezone: _workspaceTimezone,
    asOf: _asOf,
    fullyPricedOnly: _fullyPricedOnly,
    ...rest
  } = scope;
  return { ...rest, from: null, to: null };
}

function traceCost(trace: ForecastTrace): number | null {
  return trace.fullyPriced ? trace.knownCost : null;
}

function singleScopeValue(value: string | string[] | null | undefined): string | null {
  if (typeof value === "string") return value;
  return Array.isArray(value) && value.length === 1 ? value[0] : null;
}

function singleModel(charges: CanonicalCharge[]): string | null {
  const models = new Set(charges.map((charge) => charge.model).filter((model): model is string => Boolean(model)));
  return models.size === 1 ? [...models][0] : null;
}

/** Calculate both forecast types from one canonical, filtered charge cohort. */
export async function calculateForecast(
  pool: pg.Pool,
  projectId: string,
  incomingScope: ForecastScope = {},
): Promise<ForecastResult> {
  const asOf = dateValue(incomingScope.asOf) ?? new Date();
  if (incomingScope.asOf !== undefined && incomingScope.asOf !== null && !dateValue(incomingScope.asOf)) {
    throw new ForecastInputError("asOf must be a valid ISO date");
  }
  const timezone = incomingScope.timezone ?? incomingScope.workspaceTimezone ?? "UTC";
  validateTimezone(timezone);
  const bounds = periodBounds(incomingScope, asOf);
  const targetPeriodDays = validateTargetPeriodDays(incomingScope.targetPeriodDays);
  const scope: ForecastScope = {
    ...incomingScope,
    from: bounds.from.toISOString(),
    to: bounds.to.toISOString(),
    asOf: asOf.toISOString(),
    timezone,
  };

  const pace = currentPaceWindow(asOf, timezone);
  // One canonical read keeps trace, pace, explicit usage and exclusions on the same basis.
  const canonicalScope = chargeScope(scope);
  const loadedFrom = new Date(Math.min(bounds.from.getTime(), pace.from.getTime()));
  const loadedTo = new Date(Math.max(bounds.to.getTime(), pace.completedTo.getTime()));
  const loadedCharges = await loadCanonicalCharges(pool, projectId, {
    ...canonicalScope,
    from: loadedFrom.toISOString(),
    to: loadedTo.toISOString(),
  }, { limit: MAX_FORECAST_CHARGES + 1, order: "desc" });
  const cohortTruncated = loadedCharges.length > MAX_FORECAST_CHARGES;
  // Keep the newest bounded cohort. Reverse it back to the canonical
  // chronological order expected by trace aggregation and evidence links.
  const charges = loadedCharges.slice(0, MAX_FORECAST_CHARGES).reverse();
  const canReadAggregateStore = typeof (pool as unknown as { connect?: unknown }).connect === "function";
  const [observedAggregateRows, paceAggregateRows] = canReadAggregateStore
    ? await Promise.all([
      loadDailyAggregates(pool, projectId, { ...canonicalScope, from: bounds.from.toISOString(), to: bounds.to.toISOString(), timezone }, timezone),
      loadDailyAggregates(pool, projectId, { ...canonicalScope, from: pace.from.toISOString(), to: pace.completedTo.toISOString(), timezone }, timezone),
    ])
    : [[], []];
  const observedCharges = charges.filter((charge) => inWindow(charge, bounds.from, bounds.to));
  const { traces: observedTraces, untracedCharges } = aggregateForecastTraces(observedCharges);
  const observedExclusions = excludedActivity(observedTraces, untracedCharges);
  const observedDetailTotals = sumKnown(observedCharges);
  const observedDailyTotals = sumDailyKnown(observedAggregateRows);
  const observedTotals = {
    known: observedDetailTotals.known == null && observedDailyTotals.known == null
      ? null : (observedDetailTotals.known ?? 0) + (observedDailyTotals.known ?? 0),
    priced: observedDetailTotals.priced + observedDailyTotals.priced,
    unpriced: observedDetailTotals.unpriced + observedDailyTotals.unpriced,
  };
  if (observedAggregateRows.length > 0) observedExclusions.reasons.push("part of this period is aggregate-only history; trace evidence is unavailable");
  const fullyPricedObserved = observedTraces.filter((trace) => trace.fullyPriced);
  const observedTraceCosts = fullyPricedObserved
    .map(traceCost)
    .filter((cost): cost is number => cost !== null);

  const completedCharges = charges.filter((charge) => inWindow(charge, pace.from, pace.completedTo));
  const paceDetailTotals = sumKnown(completedCharges);
  const paceDailyTotals = sumDailyKnown(paceAggregateRows);
  const paceTotals = {
    known: paceDetailTotals.known == null && paceDailyTotals.known == null
      ? null : (paceDetailTotals.known ?? 0) + (paceDailyTotals.known ?? 0),
    priced: paceDetailTotals.priced + paceDailyTotals.priced,
    unpriced: paceDetailTotals.unpriced + paceDailyTotals.unpriced,
  };
  const paceObservations = completedCharges.length + paceDailyTotals.observations;
  const currentPaceAvailable = !cohortTruncated
    && pace.completedElapsedDays >= 7
    && paceObservations > 0
    && paceTotals.unpriced === 0
    && paceTotals.known !== null;
  const currentPaceProjected = currentPaceAvailable
    ? (paceTotals.known! / pace.completedElapsedDays) * pace.periodDays
    : null;
  const currentPaceReason = currentPaceAvailable
    ? null
    : pace.completedElapsedDays < 7
      ? "Current-pace projection becomes available after 7 completed days"
      : paceTotals.unpriced > 0
      ? "Current-pace projection is unavailable while completed days contain unknown prices"
      : cohortTruncated
        ? `Forecast cohort exceeded the ${MAX_FORECAST_CHARGES.toLocaleString()} charge safety limit; narrow the range`
      : "No fully priced completed-day activity";

  const volume = selectVolume(scope);
  const allObservedIncomplete = observedTraces.filter((trace) => !trace.fullyPriced);
  const pricedOnly = scope.fullyPricedOnly === true;
  let sampleUnits: ForecastTrace[] | ForecastTrace[][] = fullyPricedObserved;
  let sampleCosts: number[] = observedTraceCosts;
  let unidentifiedConversationTraceIds: string[] = [];
  let excluded = observedExclusions;

  if (volume.unit === "conversations") {
    const conversations = conversationUnits(observedTraces);
    unidentifiedConversationTraceIds = conversations.unidentified;
    const complete = conversations.units.filter((unit) => unit.every((trace) => trace.fullyPriced));
    sampleUnits = complete;
    sampleCosts = complete.map((unit) => unit.reduce((sum, trace) => sum + (trace.knownCost ?? 0), 0));
    excluded = {
      ...observedExclusions,
      unidentifiedConversationTraceIds,
      count: observedExclusions.count + unidentifiedConversationTraceIds.length,
      reasons: unidentifiedConversationTraceIds.length > 0
        ? [...observedExclusions.reasons, "conversation volume requires an identified conversation unit"]
        : observedExclusions.reasons,
    };
  }

  const sampleSize = sampleUnits.length;
  const sampleSufficient = sampleSize >= REQUIRED_SAMPLE_SIZE;
  const manualInput = incomingScope.assumedCostPerUnit
    ?? incomingScope.assumedCostPerOperation
    ?? incomingScope.manualCostPerOperation;
  const manualProvided = manualInput !== undefined && manualInput !== null;
  const manualCost = nonNegative(manualInput);
  if (manualProvided && manualCost === null) {
    throw new ForecastInputError("assumed cost must be a non-negative number");
  }
  const hasAggregateOnlyHistory = observedAggregateRows.length > 0;
  const hasIncomplete = cohortTruncated || allObservedIncomplete.length > 0 || untracedCharges.length > 0
    || hasAggregateOnlyHistory
    || unidentifiedConversationTraceIds.length > 0;
  const automaticAllowed = sampleSufficient && (!hasIncomplete || pricedOnly);
  const baselineCost = mean(sampleCosts);
  const chosenCost = manualCost ?? baselineCost;
  const automatic = manualCost === null && automaticAllowed && baselineCost !== null;
  const chosenUnitCost = manualCost ?? baselineCost;
  const chosenOperations = volume.operations;
  const chosenProjected = volume.error || chosenUnitCost === null
    ? null
    : volume.unit === "conversations"
      ? volume.volume! * chosenUnitCost
      : chosenOperations === null
        ? null
        : chosenOperations * chosenUnitCost;
  let chosenReason: string | null = null;
  if (volume.error) chosenReason = volume.error;
  else if (cohortTruncated) chosenReason = `Forecast cohort exceeded the ${MAX_FORECAST_CHARGES.toLocaleString()} charge safety limit; narrow the range`;
  else if (volume.unit === "conversations" && unidentifiedConversationTraceIds.length > 0) {
    chosenReason = "Conversation forecasts require an identified conversation unit for every baseline trace";
  }
  else if (chosenCost === null) chosenReason = "Insufficient observed sample; enter an assumed cost per operation";
  else if (manualCost === null && hasIncomplete && !pricedOnly) {
    chosenReason = "Automatic projection is unavailable while selected activity has unknown prices; filter to fully priced traces or enter an assumed cost";
  } else if (manualCost === null && !sampleSufficient) {
    chosenReason = `Automatic projection requires ${REQUIRED_SAMPLE_SIZE} fully priced ${volume.unit === "conversations" ? "conversation units" : "traces"}`;
  }
  const chosenAvailable = chosenProjected !== null
    && (automatic || manualCost !== null)
    && (volume.unit !== "conversations" || unidentifiedConversationTraceIds.length === 0);

  const currency = (incomingScope.currency ?? "USD").toUpperCase();
  const cashAmount = chosenAvailable ? chosenProjected : currentPaceProjected;
  const selectedProvider = singleScopeValue(incomingScope.provider);
  const selectedService = singleScopeValue(incomingScope.service);
  const creditModel = singleScopeValue(incomingScope.model) ?? (
    selectedProvider ? singleModel(observedCharges) : null
  );
  const cashUntil = chosenAvailable && targetPeriodDays !== null
    ? new Date(asOf.getTime() + targetPeriodDays * DAY_MS)
    : pace.periodEnd;
  const credit = cashAmount === null
    ? unavailableCredit(currency, "Cash estimate requires an available forecast")
    : await eligibleCreditEstimate(pool, projectId, cashAmount, {
      provider: selectedProvider,
      model: creditModel,
      service: selectedService,
      accountScope: incomingScope.accountScope ?? null,
      cloudProject: incomingScope.cloudProject ?? null,
      currency,
      at: asOf,
      until: cashUntil,
    });

  return {
    scope,
    calculatedAt: asOf.toISOString(),
    calculation: {
      asOf: asOf.toISOString(),
      timezone,
      pricingBasis: "canonical_charge_cohort",
      observedWindow: { from: bounds.from.toISOString(), to: bounds.to.toISOString() },
      currentPaceWindow: {
        from: pace.from.toISOString(),
        to: pace.completedTo.toISOString(),
        periodDays: pace.periodDays,
      },
      cohortLimit: MAX_FORECAST_CHARGES,
      cohortTruncated,
    },
    observed: {
      costCurrency: "USD",
      from: bounds.from.toISOString(),
      to: bounds.to.toISOString(),
      observations: observedTraces.length,
      pricedObservations: fullyPricedObserved.length,
      unpricedObservations: allObservedIncomplete.length,
      knownCost: observedTotals.known,
      pricingCoverage: observedTraces.length > 0 ? fullyPricedObserved.length / observedTraces.length : null,
      meanCostPerOperation: mean(observedTraceCosts),
      chargeObservations: observedCharges.length + observedDailyTotals.observations,
      pricedCharges: observedTotals.priced,
      unpricedCharges: observedTotals.unpriced,
      traceObservations: observedTraces.length,
      fullyPricedTraces: fullyPricedObserved.length,
      incompleteTraces: allObservedIncomplete.length,
      excludedActivity: observedExclusions,
    },
    currentPace: {
      costCurrency: "USD",
      available: currentPaceAvailable,
      reason: currentPaceReason,
      completedElapsedDays: pace.completedElapsedDays,
      periodDays: pace.periodDays,
      knownCost: paceTotals.known,
      projectedCost: currentPaceProjected,
      pricingCoverage: paceObservations > 0 ? paceTotals.priced / paceObservations : null,
      excludedUnpriced: paceTotals.unpriced,
      method: `Completed elapsed-day average in ${timezone} multiplied by calendar-period days`,
    },
    chosenScale: {
      costCurrency: "USD",
      available: chosenAvailable,
      automatic,
      reason: chosenAvailable ? null : chosenReason,
      unit: volume.unit,
      volume: volume.volume,
      operations: chosenOperations,
      operationsPerUser: volume.operationsPerUser,
      costPerOperation: chosenUnitCost,
      costPerUnit: chosenUnitCost,
      projectedCost: chosenAvailable ? chosenProjected : null,
      sampleSize,
      requiredSampleSize: REQUIRED_SAMPLE_SIZE,
      sampleSufficient,
      fullyPricedTraces: fullyPricedObserved.length,
      excludedUnpriced: excluded.unpricedTraceIds.length,
      excludedActivity: excluded,
      selectionBiasWarning: excluded.count > 0,
      pricingBasis: chosenAvailable ? (automatic ? "canonical_charge_cohort" : "manual_assumption") : null,
      assumptions: {
        volumeOnly: manualCost === null,
        manualCostPerUnit: manualCost,
        targetPeriodDays,
        unitBasis: volume.unit === "conversations" ? "conversation" : volume.unit === "users" ? "user" : "operation",
        formula: volume.unit === "conversations"
          ? "expected conversations × mean cost per conversation"
          : volume.unit === "users"
            ? "expected users × operations per user × mean cost per operation"
            : "expected operations × mean cost per operation",
      },
    },
    cash: {
      available: credit.available && cashAmount !== null,
      reason: cashAmount === null ? "Cash estimate requires an available forecast" : credit.reason,
      originalAmount: cashAmount === null ? null : credit.originalAmount,
      eligibleCredits: cashAmount === null ? null : credit.eligibleAmount,
      estimatedPayable: cashAmount === null ? null : credit.estimatedPayable,
      currency: credit.currency,
      originalCurrency: "USD",
      byProvider: credit.byProvider,
    },
  };
}
