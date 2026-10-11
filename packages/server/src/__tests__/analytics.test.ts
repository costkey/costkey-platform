import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  aggregateForecastTraces,
  calculateForecast,
  currentPaceWindow,
  MAX_FORECAST_CHARGES,
  MAX_FORECAST_WINDOW_DAYS,
  type ForecastScope,
} from "../forecast.js";
import {
  eligibleCreditEstimate,
  parseCreditInput,
} from "../credits.js";
import {
  expensiveTraceCandidates,
  increasedUnitCostCandidates,
  DEFAULT_FINDING_THRESHOLDS,
} from "../findings.js";
import type { CanonicalCharge } from "../charge-cohort.js";

type QueryResult = { rows: Array<Record<string, unknown>> };

class CanonicalPool {
  readonly queries: string[] = [];

  constructor(
    private readonly canonical: CanonicalCharge[],
    private readonly creditRows: Array<Record<string, unknown>> = [],
  ) {}

  async query(sql: string): Promise<QueryResult> {
    this.queries.push(sql);
    if (sql.includes("FROM credits")) return { rows: this.creditRows };
    if (sql.includes("WITH auto_raw") || sql.includes("WITH auto_charges")) return { rows: this.canonical as unknown as Array<Record<string, unknown>> };
    return { rows: [] };
  }
}

function charge(input: Partial<CanonicalCharge> & Pick<CanonicalCharge, "trace_id" | "timestamp">): CanonicalCharge {
  const { timestamp, trace_id, ...overrides } = input;
  return {
    project_id: "project",
    record_id: input.record_id ?? `${trace_id}-${timestamp}`,
    charge_key: input.charge_key ?? `${trace_id}-${timestamp}`,
    timestamp,
    provider: "openrouter",
    model: "model-a",
    request_model: null,
    pricing_id: null,
    cost_usd: 0.1,
    cost_basis: "reported",
    cost_source: "provider",
    cost_currency: "USD",
    duration_ms: 10,
    trace_id,
    trace_name: "search",
    context: { feature: "search", environment: "production" },
    service: null,
    release: null,
    execution_id: null,
    group_id: null,
    group_name: null,
    group_kind: null,
    phase: null,
    case_id: null,
    record_type: "call",
    input_tokens: null,
    output_tokens: null,
    total_tokens: null,
    unit_value: null,
    unit: null,
    unit_kind: null,
    revision: null,
    bl_file: null,
    bl_function: null,
    bl_line: null,
    ...overrides,
  };
}

function forecastScope(overrides: Partial<ForecastScope> = {}): ForecastScope {
  return {
    from: "2026-09-01T00:00:00.000Z",
    to: "2026-09-14T00:00:00.000Z",
    asOf: "2026-09-13T12:00:00.000Z",
    operations: 20,
    ...overrides,
  };
}

describe("F09 forecast public seam", () => {
  it("keeps a multi-call trace as one business-unit observation", () => {
    const traces = aggregateForecastTraces([
      charge({ trace_id: "search-1", timestamp: "2026-09-10T00:00:00.000Z", cost_usd: 0.1, context: { feature: "search" } }),
      charge({ trace_id: "search-1", timestamp: "2026-09-10T00:00:01.000Z", cost_usd: 0.2, context: { feature: "search" } }),
      charge({ trace_id: "voice-1", timestamp: "2026-09-10T00:00:00.000Z", cost_usd: 0.3, context: { feature: "voice" } }),
    ]).traces;
    assert.equal(traces.length, 2);
    const search = traces.find((trace) => trace.traceId === "search-1");
    assert.equal(search?.chargeCount, 2);
    assert.equal(search?.fullyPriced, true);
    assert.ok(Math.abs((search?.knownCost ?? 0) - 0.3) < 1e-12);
  });

  it("counts fully priced traces, not calls, for the automatic sample", async () => {
    const rows = Array.from({ length: 20 }, (_, index) => charge({
      trace_id: index % 2 === 0 ? "trace-a" : "trace-b",
      timestamp: `2026-09-10T00:${String(index).padStart(2, "0")}:00.000Z`,
    }));
    const pool = new CanonicalPool(rows);
    const result = await calculateForecast(pool as never, "project", forecastScope());
    assert.equal(result.observed.observations, 2);
    assert.equal(result.observed.chargeObservations, 20);
    assert.equal(result.chosenScale.sampleSize, 2);
    assert.equal(result.chosenScale.automatic, false);
    assert.equal(result.chosenScale.available, false);
    assert.match(result.chosenScale.reason ?? "", /20 fully priced traces/);
    assert.equal(pool.queries.some((sql) => sql.includes("SUM(e.cost_usd)")), false);
  });

  it("treats nullable API fields as omitted while rejecting negative assumptions", async () => {
    const rows = Array.from({ length: 20 }, (_, index) => charge({
      trace_id: `trace-${index}`,
      timestamp: `2026-09-10T00:${String(index).padStart(2, "0")}:00.000Z`,
    }));
    const result = await calculateForecast(new CanonicalPool(rows) as never, "project", forecastScope({
      assumedCostPerOperation: null,
    }));
    assert.equal(result.chosenScale.available, true);
    await assert.rejects(
      () => calculateForecast(new CanonicalPool(rows) as never, "project", forecastScope({
        assumedCostPerOperation: -1,
      })),
      (error: unknown) => error instanceof Error && error.name === "ForecastInputError",
    );
  });

  it("blocks a baseline when one trace child is unpriced and reports the exclusion", async () => {
    const rows = Array.from({ length: 20 }, (_, index) => [
      charge({ trace_id: `trace-${index}`, timestamp: `2026-09-10T00:${String(index).padStart(2, "0")}:00.000Z` }),
      charge({ trace_id: `trace-${index}`, timestamp: `2026-09-10T01:${String(index).padStart(2, "0")}:00.000Z`, cost_usd: null }),
    ]).flat();
    const result = await calculateForecast(new CanonicalPool(rows) as never, "project", forecastScope());
    assert.equal(result.chosenScale.available, false);
    assert.equal(result.chosenScale.automatic, false);
    assert.equal(result.observed.incompleteTraces, 20);
    assert.equal(result.observed.excludedActivity.unpricedChargeCount, 20);
    assert.equal(result.chosenScale.excludedUnpriced, 20);
    assert.match(result.chosenScale.reason ?? "", /unknown prices|Insufficient observed sample/);
  });

  it("includes filtered voice components in a trace's cost once", async () => {
    const rows = Array.from({ length: 20 }, (_, index) => [
      charge({
        trace_id: `voice-${index}`,
        timestamp: `2026-09-10T00:${String(index).padStart(2, "0")}:00.000Z`,
        provider: "livekit",
        model: null,
        cost_usd: 0.01,
        context: { feature: "voice", environment: "production", conversationId: `conversation-${index}` },
      }),
      charge({
        trace_id: `voice-${index}`,
        timestamp: `2026-09-10T00:${String(index).padStart(2, "0")}:01.000Z`,
        provider: "tts",
        model: "speech",
        record_type: "usage",
        charge_key: `tts-${index}`,
        cost_usd: 0.02,
        context: { feature: "voice", environment: "production", conversationId: `conversation-${index}` },
      }),
    ]).flat();
    const result = await calculateForecast(
      new CanonicalPool(rows) as never,
      "project",
      forecastScope({ feature: "voice", operations: 100 }),
    );
    assert.equal(result.observed.observations, 20);
    assert.ok(Math.abs((result.observed.knownCost ?? 0) - 0.6) < 1e-9);
    assert.equal(result.chosenScale.automatic, true);
    assert.ok(Math.abs((result.chosenScale.costPerOperation ?? 0) - 0.03) < 1e-9);
    assert.ok(Math.abs((result.chosenScale.projectedCost ?? 0) - 3) < 1e-9);
  });

  it("requires operations per user and an identified unit for conversations", async () => {
    const rows = Array.from({ length: 20 }, (_, index) => charge({
      trace_id: `trace-${index}`,
      timestamp: `2026-09-10T00:${String(index).padStart(2, "0")}:00.000Z`,
    }));
    const pool = new CanonicalPool(rows);
    const users = await calculateForecast(pool as never, "project", forecastScope({
      operations: null,
      volumeUnit: "users",
      users: 10,
    }));
    assert.equal(users.chosenScale.available, false);
    assert.match(users.chosenScale.reason ?? "", /operationsPerUser/);

    const conversations = await calculateForecast(pool as never, "project", forecastScope({
      operations: null,
      volumeUnit: "conversations",
      conversations: 10,
    }));
    assert.equal(conversations.chosenScale.available, false);
    assert.match(conversations.chosenScale.reason ?? "", /conversation unit/);
  });

  it("aggregates three traces per conversation before scaling conversation volume", async () => {
    const rows = Array.from({ length: 20 }, (_, conversation) => [
      charge({
        trace_id: `conversation-${conversation}-turn-1`,
        timestamp: `2026-09-10T00:${String(conversation).padStart(2, "0")}:00.000Z`,
        cost_usd: 0.1,
        context: { feature: "chat", environment: "production", conversationId: `conversation-${conversation}` },
      }),
      charge({
        trace_id: `conversation-${conversation}-turn-2`,
        timestamp: `2026-09-10T01:${String(conversation).padStart(2, "0")}:00.000Z`,
        cost_usd: 0.2,
        context: { feature: "chat", environment: "production", conversationId: `conversation-${conversation}` },
      }),
      charge({
        trace_id: `conversation-${conversation}-turn-3`,
        timestamp: `2026-09-10T02:${String(conversation).padStart(2, "0")}:00.000Z`,
        cost_usd: 0.3,
        context: { feature: "chat", environment: "production", conversationId: `conversation-${conversation}` },
      }),
    ]).flat();
    const result = await calculateForecast(new CanonicalPool(rows) as never, "project", forecastScope({
      feature: "chat",
      operations: null,
      volumeUnit: "conversations",
      conversations: 10,
      operationsPerConversation: 3,
    }));
    assert.equal(result.chosenScale.sampleSize, 20);
    assert.equal(result.chosenScale.unit, "conversations");
    assert.ok(Math.abs((result.chosenScale.costPerUnit ?? 0) - 0.6) < 1e-9);
    assert.ok(Math.abs((result.chosenScale.projectedCost ?? 0) - 6) < 1e-9);
    assert.equal(result.chosenScale.assumptions.unitBasis, "conversation");
    assert.equal(result.chosenScale.assumptions.formula, "expected conversations × mean cost per conversation");
  });

  it("uses calendar period length and completed local days across DST", () => {
    const april = currentPaceWindow(new Date("2026-04-15T16:00:00.000Z"), "America/New_York");
    const may = currentPaceWindow(new Date("2026-05-15T16:00:00.000Z"), "America/New_York");
    assert.equal(april.periodDays, 30);
    assert.equal(may.periodDays, 31);
    assert.equal(april.completedElapsedDays, 14);
    assert.equal(may.completedElapsedDays, 14);
  });

  it("excludes the incomplete current local day from the pace average", async () => {
    const completed = Array.from({ length: 7 }, (_, index) => charge({
      trace_id: `completed-${index}`,
      timestamp: `2026-09-${String(index + 1).padStart(2, "0")}T12:00:00.000Z`,
      cost_usd: 0.1,
    }));
    const partial = charge({
      trace_id: "partial-current-day",
      timestamp: "2026-09-13T08:00:00.000Z",
      cost_usd: null,
    });
    const result = await calculateForecast(
      new CanonicalPool([...completed, partial]) as never,
      "project",
      forecastScope({ operations: null }),
    );
    assert.equal(result.observed.unpricedCharges, 1);
    assert.equal(result.currentPace.available, true);
    assert.equal(result.currentPace.excludedUnpriced, 0);
    assert.ok(Math.abs((result.currentPace.projectedCost ?? 0) - 1.75) < 1e-9);
  });

  it("rejects an inverted range instead of silently repairing it", async () => {
    await assert.rejects(
      () => calculateForecast(new CanonicalPool([]) as never, "project", forecastScope({
        from: "2026-09-14T00:00:00.000Z",
        to: "2026-09-01T00:00:00.000Z",
      })),
      (error: unknown) => error instanceof Error && error.name === "ForecastInputError",
    );
  });

  it("rejects an unbounded historical range and advertises the charge cap", async () => {
    const from = new Date("2025-01-01T00:00:00.000Z");
    const to = new Date(from.getTime() + (MAX_FORECAST_WINDOW_DAYS + 1) * 86_400_000);
    await assert.rejects(
      () => calculateForecast(new CanonicalPool([]) as never, "project", forecastScope({
        from: from.toISOString(), to: to.toISOString(),
      })),
      (error: unknown) => error instanceof Error && error.name === "ForecastInputError" && /cannot exceed/.test(error.message),
    );
    assert.equal(MAX_FORECAST_CHARGES, 100_000);
  });
});

describe("F10 credit eligibility public seam", () => {
  it("caps overlapping eligible credits and never combines another provider", async () => {
    const rows = [
      {
        id: "a", provider: "openrouter", account_scope: "acct", cloud_project: "billing-project",
        currency: "USD", balance_amount: 5, balance_as_of: "2026-09-01T00:00:00Z", expires_at: "2026-10-01T00:00:00Z", eligibility: { providers: ["openrouter"] },
      },
      {
        id: "b", provider: "openrouter", account_scope: "acct", cloud_project: "billing-project",
        currency: "USD", balance_amount: 7, balance_as_of: "2026-09-01T00:00:00Z", expires_at: "2026-10-01T00:00:00Z", eligibility: { providers: ["openrouter"] },
      },
      {
        id: "c", provider: "other-provider", account_scope: "acct", cloud_project: "billing-project",
        currency: "USD", balance_amount: 100, balance_as_of: "2026-09-01T00:00:00Z", expires_at: "2026-10-01T00:00:00Z", eligibility: { providers: ["other-provider"] },
      },
    ];
    const estimate = await eligibleCreditEstimate(new CanonicalPool([], rows) as never, "project", 10, {
      provider: "openrouter",
      accountScope: "acct",
      cloudProject: "billing-project",
      at: new Date("2026-09-13T00:00:00Z"),
    });
    assert.equal(estimate.available, true);
    assert.equal(estimate.originalAmount, 10);
    assert.equal(estimate.eligibleAmount, 10);
    assert.equal(estimate.estimatedPayable, 0);
    assert.deepEqual(estimate.byProvider, { openrouter: { balance: 12, eligible: 10 } });
  });

  it("requires an explicit matching service for service-restricted credits", async () => {
    const rows = [{
      id: "service-credit", provider: "openrouter", account_scope: "acct", cloud_project: "billing-project",
      currency: "USD", balance_amount: 10, balance_as_of: "2026-09-01T00:00:00Z", expires_at: null,
      eligibility: { services: ["voice.route"] },
    }];
    const pool = new CanonicalPool([], rows);
    const missing = await eligibleCreditEstimate(pool as never, "project", 4, {
      provider: "openrouter", accountScope: "acct", cloudProject: "billing-project",
    });
    assert.equal(missing.available, false);
    const mismatch = await eligibleCreditEstimate(pool as never, "project", 4, {
      provider: "openrouter", accountScope: "acct", cloudProject: "billing-project", service: "chat.route",
    });
    assert.equal(mismatch.available, false);
    const matching = await eligibleCreditEstimate(pool as never, "project", 4, {
      provider: "openrouter", accountScope: "acct", cloudProject: "billing-project", service: "voice.route",
    });
    assert.equal(matching.available, true);
    assert.equal(matching.eligibleAmount, 4);
  });

  it("threads service context through the forecast cash estimate", async () => {
    const rows = Array.from({ length: 20 }, (_, index) => charge({
      trace_id: `service-trace-${index}`,
      timestamp: `2026-09-10T00:${String(index).padStart(2, "0")}:00.000Z`,
      context: { feature: "voice", environment: "production", service: "voice.route" },
    }));
    const credit = [{
      id: "forecast-service-credit", provider: "openrouter", account_scope: "acct", cloud_project: "billing-project",
      currency: "USD", balance_amount: 10, balance_as_of: "2026-09-01T00:00:00Z", expires_at: null,
      eligibility: { services: ["voice.route"] },
    }];
    const base = { operations: 10, provider: "openrouter", accountScope: "acct", cloudProject: "billing-project", service: "voice.route" };
    const matching = await calculateForecast(new CanonicalPool(rows, credit) as never, "project", forecastScope(base));
    assert.equal(matching.cash.available, true);
    const missing = await calculateForecast(new CanonicalPool(rows, credit) as never, "project", forecastScope({ ...base, service: undefined }));
    assert.equal(missing.cash.available, false);
    assert.match(missing.cash.reason ?? "", /No eligible|requires an explicit/);
  });

  it("requires explicit provider/account/project and keeps malformed dates unavailable", async () => {
    const parsed = parseCreditInput({
      provider: "openrouter", account: "acct", currency: "USD",
      amount: 10, balance: 10, asOf: "2026-09-01T00:00:00Z", expiresAt: null,
    });
    assert.equal("error" in parsed, true);
    const estimate = await eligibleCreditEstimate(new CanonicalPool([], [{
      id: "bad", provider: "openrouter", account_scope: "acct", cloud_project: "billing-project",
      currency: "USD", balance_amount: 10, balance_as_of: "not-a-date", expires_at: null, eligibility: { providers: ["openrouter"] },
    }]) as never, "project", 10, {
      provider: "openrouter", accountScope: "acct", cloudProject: "billing-project",
    });
    assert.equal(estimate.available, false);
    assert.match(estimate.reason ?? "", /No eligible|unknown/);
  });

  it("does not spend a credit that expires before the forecast horizon", async () => {
    const estimate = await eligibleCreditEstimate(new CanonicalPool([], [{
      id: "soon", provider: "openrouter", account_scope: "acct", cloud_project: "billing-project",
      currency: "USD", balance_amount: 10, balance_as_of: "2026-09-01T00:00:00Z",
      expires_at: "2026-09-20T00:00:00Z", eligibility: { providers: ["openrouter"] },
    }]) as never, "project", 10, {
      provider: "openrouter", accountScope: "acct", cloudProject: "billing-project",
      at: new Date("2026-09-13T00:00:00Z"), until: new Date("2026-10-01T00:00:00Z"),
    });
    assert.equal(estimate.available, false);
  });
});

describe("F05 findings public seam", () => {
  it("requires 20 comparable prior traces and records factual threshold evidence", () => {
    const previous = Array.from({ length: 20 }, (_, index) => charge({
      trace_id: `previous-${index}`,
      timestamp: `2026-09-02T00:${String(index).padStart(2, "0")}:00.000Z`,
      cost_usd: 0.1,
      release: "v1",
    }));
    const candidate = charge({
      trace_id: "current-expensive",
      timestamp: "2026-09-12T00:00:00.000Z",
      cost_usd: 0.4,
      charge_key: "current-expensive-call",
      release: "v2",
    });
    const traces = aggregateForecastTraces([...previous, candidate]).traces;
    const findings = expensiveTraceCandidates(traces, new Date("2026-09-13T00:00:00.000Z"));
    assert.equal(findings.length, 1);
    assert.deepEqual(findings[0]?.evidence["thresholds"], { multiplier: 3, minimumAbsolute: 0.05 });
    assert.deepEqual(findings[0]?.evidence["sampleSufficiency"], { available: 20, required: 20, sufficient: true });
    assert.equal((findings[0]?.evidence["supportingTraceIds"] as string[]).length, 20);
    assert.equal((findings[0]?.evidence["observedDifferences"] as Record<string, unknown>).releaseChanged, true);
    assert.equal(Object.prototype.hasOwnProperty.call(findings[0]?.evidence ?? {}, "possibleCause"), false);
  });

  it("uses project-provided finding thresholds without changing the default contract", () => {
    const previous = Array.from({ length: 2 }, (_, index) => charge({
      trace_id: `threshold-previous-${index}`,
      timestamp: `2026-09-02T00:0${index}:00.000Z`,
      cost_usd: 0.1,
    }));
    const candidate = charge({ trace_id: "threshold-current", timestamp: "2026-09-12T00:00:00.000Z", cost_usd: 0.2 });
    const custom = { ...DEFAULT_FINDING_THRESHOLDS, expensiveSample: 2, expensiveMultiplier: 1.5, expensiveMinAbsolute: 0 };
    const findings = expensiveTraceCandidates(aggregateForecastTraces([...previous, candidate]).traces, new Date("2026-09-13T00:00:00.000Z"), custom);
    assert.equal(findings.length, 1);
    assert.deepEqual(findings[0]?.evidence["thresholds"], { multiplier: 1.5, minimumAbsolute: 0 });
  });

  it("compares equal-duration trace cohorts for increased unit cost", () => {
    const previous = Array.from({ length: 20 }, (_, index) => charge({
      trace_id: `previous-${index}`,
      timestamp: `2026-09-${String(1 + Math.floor(index / 3)).padStart(2, "0")}T00:${String(index % 60).padStart(2, "0")}:00.000Z`,
      cost_usd: 0.1,
    }));
    const current = Array.from({ length: 20 }, (_, index) => charge({
      trace_id: `current-${index}`,
      timestamp: `2026-09-${String(8 + Math.floor(index / 3)).padStart(2, "0")}T00:${String(index % 60).padStart(2, "0")}:00.000Z`,
      cost_usd: 0.2,
    }));
    const traces = aggregateForecastTraces([...previous, ...current]).traces;
    const findings = increasedUnitCostCandidates(traces, new Date("2026-09-15T00:00:00.000Z"));
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.evidence["currentCount"], 20);
    assert.equal(findings[0]?.baseline?.["previousCount"], 20);
    assert.equal(findings[0]?.evidence["relativeDifference"], 1);
  });
});
