import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer } from "node:http";
import {
  PolicyAdmissionService,
  PolicySettlementError,
  StaticPolicyCatalog,
  normalizeSpendingPolicy,
  policyWindowKey,
  type PricingQuote,
  type SpendingPolicy,
  type ObservedPolicyUsage,
  createSdkAdmissionRouter,
  createPostgresObservedUsageSource,
  StaticProviderCapabilityRegistry,
} from "../admission.js";
import { sanitizePolicy, workspaceFxForProject } from "../budgets.js";
import {
  InMemoryReservationStore,
  ReservationConflictError,
  SettlementConflictError,
} from "../reservation.js";

const NOW = new Date("2026-09-13T16:30:00.000Z");
const integration = {
  supported: true,
  admissionSupported: true,
  capabilityVersion: "test-provider/1",
  verified: true,
};

function callsPolicy(overrides: Partial<SpendingPolicy> = {}): SpendingPolicy {
  return {
    id: "policy-calls",
    projectId: "project-1",
    name: "shared calls",
    scope: {},
    mode: "enforce",
    status: "active",
    unit: "calls",
    allowance: 3,
    window: "calendar_day",
    timezone: "UTC",
    periodStart: "calendar",
    ...overrides,
  };
}

function service(
  policies: SpendingPolicy[],
  options: { pricing?: () => PricingQuote | null; observedUsage?: (policy: SpendingPolicy, windowKey: string) => ObservedPolicyUsage[] | Promise<ObservedPolicyUsage[]> } = {},
): PolicyAdmissionService {
  return new PolicyAdmissionService({
    catalog: new StaticPolicyCatalog(policies),
    store: new InMemoryReservationStore(),
    pricing: options.pricing,
    observedUsage: options.observedUsage
      ? (policy, windowKey) => options.observedUsage!(policy, windowKey)
      : undefined,
    clock: () => NOW,
    // Test-only server-owned registry entry. Request.integration remains an
    // untrusted caller assertion and is not used by the service.
    capabilities: new StaticProviderCapabilityRegistry([{ provider: "test-provider", capabilityVersion: "test-server/1" }]),
  });
}

function request(admissionId: string, overrides: Record<string, unknown> = {}) {
  return {
    projectId: "project-1",
    admissionId,
    requestId: `provider-${admissionId}`,
    provider: "test-provider",
    model: "test-model",
    integration,
    now: NOW,
    ...overrides,
  };
}

describe("F06 policy window identity", () => {
  it("does not turn a legacy alert rule into enforcement merely because the SDK installed", () => {
    assert.equal(normalizeSpendingPolicy({ id: "legacy", project_id: "project-1", daily_usd: 1, on_exceed: "block" }).mode, "monitor");
    assert.equal(normalizeSpendingPolicy({ id: "new", project_id: "project-1", allowance: 1, unit: "money", window: "calendar_day", mode: "enforce" }).mode, "enforce");
  });

  it("uses the configured calendar timezone instead of a rolling 24-hour window", () => {
    const at = new Date("2026-09-14T06:30:00.000Z");
    assert.equal(policyWindowKey({ window: "calendar_day", timezone: "America/Los_Angeles" }, at), "2026-09-13");
    assert.equal(policyWindowKey({ window: "calendar_day", timezone: "Asia/Kolkata" }, at), "2026-09-14");
    assert.equal(policyWindowKey({ window: "calendar_month", timezone: "America/Los_Angeles" }, at), "2026-09");
  });

  it("requires trace/execution identity for independent allowances", async () => {
    const admission = service([callsPolicy({ id: "trace-cap", allowance: 1, window: "per_trace" })]);
    const decision = await admission.admit(request("trace-missing"));
    assert.equal(decision.decision, "refuse");
    if (decision.decision === "refuse") assert.equal(decision.reason, "decision_unavailable");
  });
});

describe("F06 shared admission", () => {
  it("atomically admits only the shared allowance under parallel workers", async () => {
    const admission = service([callsPolicy()]);
    const decisions = await Promise.all(
      Array.from({ length: 20 }, (_, i) => admission.admit(request(`parallel-${i}`))),
    );
    assert.equal(decisions.filter((decision) => decision.decision === "allow").length, 3);
    assert.equal(decisions.filter((decision) => decision.decision === "refuse" && decision.reason === "budget_exhausted").length, 17);
  });

  it("requires every applicable enforced policy to allow the call", async () => {
    const admission = service([
      callsPolicy({ id: "project-cap", allowance: 2 }),
      callsPolicy({ id: "model-cap", allowance: 1, scope: { model: "test-*" } }),
    ]);
    const first = await admission.admit(request("all-1"));
    const second = await admission.admit(request("all-2"));
    assert.equal(first.decision, "allow");
    assert.equal(second.decision, "refuse");
    if (second.decision === "refuse") assert.equal(second.policyId, "model-cap");
  });

  it("does not enforce monitor-only policies even when integration proof is absent", async () => {
    const admission = service([callsPolicy({ mode: "monitor", allowance: 0 })]);
    const decision = await admission.admit(request("monitor", { integration: undefined }));
    assert.equal(decision.decision, "allow");
    if (decision.decision === "allow") assert.equal(decision.enforcementApplied, false);
  });

  it("refuses an unknown provider even when the caller self-asserts capability", async () => {
    const admission = service([callsPolicy({ allowance: 1 })]);
    const decision = await admission.admit(request("unregistered-provider", {
      provider: "unregistered-provider",
      integration: { supported: true, admissionSupported: true, verified: true, capabilityVersion: "attacker/1" },
    }));
    assert.equal(decision.decision, "refuse");
    if (decision.decision === "refuse") assert.equal(decision.reason, "unsupported_integration");
  });

  it("replays duplicate admission/request identities without another reservation", async () => {
    const admission = service([callsPolicy({ allowance: 1 })]);
    const first = await admission.admit(request("same", { requestId: "provider-same" }));
    const replayByAdmission = await admission.admit(request("same", { requestId: "provider-same" }));
    const replayByRequest = await admission.admit(request("different-admission", { requestId: "provider-same" }));
    assert.equal(first.decision, "allow");
    assert.equal(replayByAdmission.decision, "allow");
    assert.equal(replayByAdmission.replay, true);
    if (replayByAdmission.decision === "allow") assert.equal(replayByAdmission.providerCallAllowed, false);
    assert.equal(replayByRequest.decision, "allow");
    assert.equal(replayByRequest.replay, true);
    const exhausted = await admission.admit(request("fresh"));
    assert.equal(exhausted.decision, "refuse");
  });

  it("refuses a reused admission identity with different request data", async () => {
    const admission = service([callsPolicy({ allowance: 2 })]);
    await admission.admit(request("conflict"));
    await assert.rejects(
      admission.admit(request("conflict", { model: "different-model" })),
      (error: unknown) => error instanceof Error && error.name === "CostKeyPolicyIdempotencyError",
    );
  });
});

describe("DX09 conservative monetary admission", () => {
  const quote: PricingQuote = {
    currency: "USD",
    inputUsdPerMillion: 2.5,
    outputUsdPerMillion: 10,
    basis: "test-catalog:gpt-4o",
  };

  it("ignores a caller-claimed amount and refuses an unbounded request", async () => {
    const admission = service([
      {
        ...callsPolicy({ id: "money", unit: "money", allowance: 1, currency: "USD" }),
      },
    ], { pricing: () => quote });
    const decision = await admission.admit(request("unbounded", { claimedCostUsd: 0, usageBounds: {} }));
    assert.equal(decision.decision, "refuse");
    if (decision.decision === "refuse") assert.equal(decision.reason, "unbounded_request");
  });

  it("refuses unknown server pricing even when the SDK claims a bound", async () => {
    const admission = service([
      { ...callsPolicy({ id: "money", unit: "money", allowance: 0.0002, currency: "USD" }) },
    ], { pricing: () => null });
    const decision = await admission.admit(request("unknown-price", {
      claimedCostUsd: 0.001,
      usageBounds: { maxInputTokens: 100, maxOutputTokens: 100 },
    }));
    assert.equal(decision.decision, "refuse");
    if (decision.decision === "refuse") assert.equal(decision.reason, "price_unavailable");
  });

  it("reserves a verified upper bound, settles actual cost, and exposes overrun", async () => {
    const admission = service([
      { ...callsPolicy({ id: "money", unit: "money", allowance: 0.02, currency: "USD" }) },
    ], { pricing: () => quote });
    const allowed = await admission.admit(request("priced", {
      usageBounds: { maxInputTokens: 1_000, maxOutputTokens: 1_000 },
    }));
    assert.equal(allowed.decision, "allow");
    if (allowed.decision !== "allow" || !allowed.reservationId) throw new Error("expected reservation");
    const settled = await admission.settle({
      projectId: "project-1",
      reservationId: allowed.reservationId,
      settlementId: "settlement-priced",
      outcome: "success",
      actualCostUsd: 0.013,
      providerAttestation: { source: "server", actualCostUsd: 0.013 },
      providerAttempted: true,
      now: NOW,
    });
    assert.equal(settled.reservation.state, "settled");
    assert.equal(settled.overrun.length, 1);
  });

  it("carries preactivation observed spend into a calendar allowance unless activation start is explicit", async () => {
    const observedUsage = async (policy: SpendingPolicy, windowKey: string): Promise<ObservedPolicyUsage[]> => [{
      observationId: "preactivation-call",
      policyId: policy.id,
      windowKey,
      unit: "money",
      currency: "USD",
      quantity: 0.9,
      limit: policy.allowance,
      occurredAt: new Date("2026-09-13T14:00:00.000Z"),
    }];
    const calendar = service([
      callsPolicy({ id: "calendar-money", unit: "money", allowance: 1, currency: "USD" }),
    ], { pricing: () => ({ currency: "USD", inputUsdPerMillion: 1, outputUsdPerMillion: 1, basis: "test" }), observedUsage });
    const refused = await calendar.admit(request("after-observed", {
      usageBounds: { maxInputTokens: 100_000, maxOutputTokens: 100_000 },
    }));
    assert.equal(refused.decision, "refuse");
    if (refused.decision === "refuse") assert.equal(refused.reason, "budget_exhausted");

    const activation = service([
      callsPolicy({ id: "activation-money", unit: "money", allowance: 1, currency: "USD", periodStart: "activation", activatedAt: "2026-09-13T15:00:00.000Z" }),
    ], { pricing: () => ({ currency: "USD", inputUsdPerMillion: 1, outputUsdPerMillion: 1, basis: "test" }), observedUsage });
    const allowed = await activation.admit(request("activation-fresh", {
      usageBounds: { maxInputTokens: 100_000, maxOutputTokens: 100_000 },
    }));
    assert.equal(allowed.decision, "allow");
  });

  it("counts post-activation observations without carrying pre-activation spend", async () => {
    const observedUsage = async (policy: SpendingPolicy, windowKey: string): Promise<ObservedPolicyUsage[]> => [
      {
        observationId: "activation-before",
        policyId: policy.id,
        windowKey,
        unit: "money",
        currency: "USD",
        quantity: 0.9,
        occurredAt: new Date("2026-09-13T14:00:00.000Z"),
        limit: policy.allowance,
      },
      {
        observationId: "activation-after",
        policyId: policy.id,
        windowKey,
        unit: "money",
        currency: "USD",
        quantity: 0.2,
        occurredAt: new Date("2026-09-13T15:30:00.000Z"),
        limit: policy.allowance,
      },
    ];
    const admission = service([
      callsPolicy({
        id: "activation-post",
        unit: "money",
        allowance: 0.5,
        currency: "USD",
        periodStart: "activation",
        activatedAt: "2026-09-13T15:00:00.000Z",
      }),
    ], { pricing: () => ({ currency: "USD", inputUsdPerMillion: 1, outputUsdPerMillion: 1, basis: "test" }), observedUsage });
    const allowed = await admission.admit(request("activation-post", {
      usageBounds: { maxInputTokens: 100_000, maxOutputTokens: 100_000 },
    }));
    assert.equal(allowed.decision, "allow");
    // The 0.9 pre-activation observation is ignored; the 0.2 post-activation
    // observation plus this request's 0.2 bound remains within 0.5.
    const next = await admission.admit(request("activation-post-next", {
      usageBounds: { maxInputTokens: 100_000, maxOutputTokens: 100_000 },
    }));
    assert.equal(next.decision, "refuse");
    if (next.decision === "refuse") assert.equal(next.reason, "budget_exhausted");
  });

  it("deduplicates observed charge identity and rejects conflicting replays", async () => {
    const store = new InMemoryReservationStore();
    const observed = {
      observationId: "event-1",
      policyId: "policy-1",
      windowKey: "2026-09-13",
      unit: "money" as const,
      currency: "USD" as const,
      quantity: 0.9,
      limit: 1,
    };
    assert.equal((await store.recordObserved(observed)).recorded, true);
    assert.equal((await store.recordObserved(observed)).recorded, false);
    await assert.rejects(
      store.recordObserved({ ...observed, quantity: 0.8 }),
      /reused with different content/,
    );
    const unknownId = { ...observed, observationId: "event-unknown", quantity: null, unknown: true };
    assert.equal((await store.recordObserved(unknownId)).recorded, true);
    assert.equal((await store.recordObserved({ ...unknownId, quantity: 0.1, unknown: false })).recorded, true);
  });

  it("uses the dated workspace FX snapshot instead of a caller-claimed INR rate", () => {
    const parsed = sanitizePolicy({
      name: "INR cap",
      unit: "money",
      allowance: 800,
      currency: "INR",
      window: "calendar_day",
      usdToPolicyCurrency: 1,
    }, {
      available: true,
      rate: 80,
      source: "workspace-manual",
      asOf: "2026-09-12T00:00:00.000Z",
    });
    assert.equal("error" in parsed, false);
    if (!("error" in parsed)) {
      assert.equal(parsed.fx_rate, 80);
      assert.equal(parsed.usd_to_policy_currency, 80);
      assert.equal(parsed.fx_source, "workspace-manual");
      assert.equal(parsed.fx_as_of, "2026-09-12T00:00:00.000Z");
      assert.equal(parsed.fx_client_claim_ignored, true);
    }
  });

  it("uses the workspace timezone when a policy omits its own calendar timezone", () => {
    const parsed = sanitizePolicy({ unit: "calls", allowance: 1, window: "calendar_day" }, undefined, "Asia/Kolkata");
    assert.equal("error" in parsed, false);
    if (!("error" in parsed)) assert.equal(parsed.timezone, "Asia/Kolkata");
  });

  it("converts an observed INR charge exactly once", async () => {
    const fakePool = {
      query: async (sql: string) => {
        if (!sql.includes("SELECT c.record_id, c.charge_key, c.timestamp")) throw new Error(`unexpected query: ${sql}`);
        return { rows: [{ record_id: "observed-inr", charge_key: "observed-inr", timestamp: NOW, record_type: "call", cost_usd: 0.9, cost_currency: "USD", total_tokens: null, input_tokens: null, output_tokens: null, unit_value: null, unit: null, unit_kind: null, explicit_amount: null, explicit_currency: null }] };
      },
    } as unknown as import("pg").Pool;
    const policy = callsPolicy({
      id: "inr-observed",
      unit: "money",
      allowance: 100,
      currency: "INR",
      usdToPolicyCurrency: 80,
      fxSource: "workspace-manual",
      fxAsOf: "2026-09-12T00:00:00.000Z",
    });
    const observations = await createPostgresObservedUsageSource(fakePool)(policy, "2026-09-13", request("observed-inr"));
    assert.equal(observations.length, 1);
    assert.equal(observations[0]?.quantity, 72);
  });

  it("loads FX from the org workspace row with numeric-string/date driver values", async () => {
    const fakePool = {
      query: async () => ({ rows: [{ reporting_currency: "INR", fx_rate: "80", fx_source: "rbi", fx_as_of: new Date("2026-09-12T00:00:00.000Z") }] }),
    } as unknown as import("pg").Pool;
    const fx = await workspaceFxForProject(fakePool, "project-1");
    assert.deepEqual(fx, { available: true, rate: 80, source: "rbi", asOf: "2026-09-12T00:00:00.000Z" });
  });

  it("refuses INR policy activation when workspace FX is missing or undated", () => {
    const parsed = sanitizePolicy({ unit: "money", allowance: 800, currency: "INR", window: "calendar_day", usdToPolicyCurrency: 80 }, {
      available: false,
      rate: 80,
      source: null,
      asOf: null,
    });
    assert.equal("error" in parsed, true);
    if ("error" in parsed) assert.equal(parsed.status, 409);
  });

  it("does not enforce a persisted INR rate without its source/as-of provenance", async () => {
    const admission = service([
      callsPolicy({ id: "inr-no-provenance", unit: "money", allowance: 80, currency: "INR" }),
    ], { pricing: () => quote });
    const decision = await admission.admit(request("inr-no-provenance", {
      usageBounds: { maxInputTokens: 100, maxOutputTokens: 100 },
    }));
    assert.equal(decision.decision, "refuse");
    if (decision.decision === "refuse") assert.equal(decision.reason, "decision_unavailable");
  });

  it("keeps changed workspace FX as a prospective policy-version snapshot", () => {
    const prior = normalizeSpendingPolicy({ id: "inr-policy", project_id: "project-1", mode: "enforce", unit: "money", allowance: 800, currency: "INR", window_kind: "calendar_day", timezone: "UTC", policy_version: 1, fx_rate: 80, fx_source: "workspace-manual", fx_as_of: "2026-09-12T00:00:00.000Z" });
    const next = normalizeSpendingPolicy({ id: "inr-policy", project_id: "project-1", mode: "enforce", unit: "money", allowance: 800, currency: "INR", window_kind: "calendar_day", timezone: "UTC", policy_version: 2, fx_rate: 82, fx_source: "workspace-manual", fx_as_of: "2026-09-13T00:00:00.000Z" });
    assert.equal(prior.usdToPolicyCurrency, 80);
    assert.equal(next.usdToPolicyCurrency, 82);
    assert.equal(prior.version, 1);
    assert.equal(next.version, 2);
  });
});

describe("reservation settlement safety", () => {
  it("does not release ambiguous failed work and allows explicit no-start release", async () => {
    const admission = service([callsPolicy({ allowance: 1 })]);
    const allowed = await admission.admit(request("failure"));
    if (allowed.decision !== "allow" || !allowed.reservationId) throw new Error("expected reservation");
    await assert.rejects(
      admission.settle({
        projectId: "project-1",
        reservationId: allowed.reservationId,
        settlementId: "ambiguous-failure",
        outcome: "failed",
        now: NOW,
      }),
      (error: unknown) => error instanceof PolicySettlementError && error.reason === "decision_unavailable",
    );
    const stillHeld = await admission.admit(request("still-held"));
    assert.equal(stillHeld.decision, "refuse");
    await admission.settle({
      projectId: "project-1",
      reservationId: allowed.reservationId,
      settlementId: "not-started",
      outcome: "failed",
      providerAttempted: false,
      now: NOW,
    });
    const available = await admission.admit(request("after-release"));
    assert.equal(available.decision, "allow");
  });

  it("keeps unknown reservations held until a later verified settlement", async () => {
    const admission = service([
      { ...callsPolicy({ id: "money", unit: "money", allowance: 0.0002, currency: "USD" }) },
    ], { pricing: () => ({ currency: "USD", inputUsdPerMillion: 1, outputUsdPerMillion: 1, basis: "test" }) });
    const allowed = await admission.admit(request("unknown-settle", {
      usageBounds: { maxInputTokens: 100, maxOutputTokens: 100 },
    }));
    if (allowed.decision !== "allow" || !allowed.reservationId) throw new Error("expected reservation");
    const unknown = await admission.settle({
      projectId: "project-1",
      reservationId: allowed.reservationId,
      settlementId: "provisional",
      outcome: "unknown",
      now: NOW,
    });
    assert.equal(unknown.reservation.state, "unknown");
    const held = await admission.admit(request("held-by-unknown", {
      usageBounds: { maxInputTokens: 100, maxOutputTokens: 100 },
    }));
    assert.equal(held.decision, "refuse");
    const final = await admission.settle({
      projectId: "project-1",
      reservationId: allowed.reservationId,
      settlementId: "reconciled",
      outcome: "success",
      actualCostUsd: 0.0001,
      providerAttestation: { source: "server", actualCostUsd: 0.0001 },
      providerAttempted: true,
      now: NOW,
    });
    assert.equal(final.reservation.state, "settled");
  });

  it("does not release a monetary reservation from a client-only actual cost", async () => {
    const admission = service([
      { ...callsPolicy({ id: "money-client", unit: "money", allowance: 0.0002, currency: "USD" }) },
    ], { pricing: () => ({ currency: "USD", inputUsdPerMillion: 1, outputUsdPerMillion: 1, basis: "test" }) });
    const allowed = await admission.admit(request("unattested-settle", {
      usageBounds: { maxInputTokens: 100, maxOutputTokens: 100 },
    }));
    if (allowed.decision !== "allow" || !allowed.reservationId) throw new Error("expected reservation");
    await assert.rejects(
      admission.settle({
        projectId: "project-1",
        reservationId: allowed.reservationId,
        settlementId: "untrusted-client-cost",
        outcome: "success",
        actualCostUsd: 0,
        providerAttempted: true,
        now: NOW,
      }),
      (error: unknown) => error instanceof PolicySettlementError && error.reason === "price_unavailable",
    );
    const stillHeld = await admission.admit(request("unattested-still-held", {
      usageBounds: { maxInputTokens: 100, maxOutputTokens: 100 },
    }));
    assert.equal(stillHeld.decision, "refuse");
  });

  it("rejects conflicting final settlement payloads and direct reservation conflicts", async () => {
    const store = new InMemoryReservationStore();
    const first = await store.reserve({
      projectId: "project-1",
      admissionId: "direct",
      requestId: "provider-direct",
      fingerprint: "fingerprint-a",
      lines: [{ policyId: "p", windowKey: "2026-09-13", unit: "calls", quantity: 1, limit: 2 }],
      now: NOW,
    });
    await assert.rejects(
      store.reserve({
        projectId: "project-1",
        admissionId: "direct",
        requestId: "provider-direct",
        fingerprint: "fingerprint-b",
        lines: [{ policyId: "p", windowKey: "2026-09-13", unit: "calls", quantity: 1, limit: 2 }],
        now: NOW,
      }),
      ReservationConflictError,
    );
    await store.settle({
      projectId: "project-1",
      reservationId: first.reservation.reservationId,
      settlementId: "settlement-a",
      outcome: "success",
      actualLines: [{ policyId: "p", quantity: 1 }],
      fingerprint: "settlement-fingerprint-a",
      now: NOW,
    });
    await assert.rejects(
      store.settle({
        projectId: "project-1",
        reservationId: first.reservation.reservationId,
        settlementId: "settlement-a",
        outcome: "success",
        actualLines: [{ policyId: "p", quantity: 2 }],
        fingerprint: "settlement-fingerprint-b",
        now: NOW,
      }),
      SettlementConflictError,
    );
  });

  it("keeps a direct store reservation provisional when a final line is missing", async () => {
    const store = new InMemoryReservationStore();
    const created = await store.reserve({
      projectId: "project-1",
      admissionId: "partial-settlement",
      fingerprint: "admission",
      lines: [
        { policyId: "money", windowKey: "2026-09-13", unit: "money", currency: "USD", quantity: 0.5, limit: 1 },
        { policyId: "calls", windowKey: "2026-09-13", unit: "calls", quantity: 1, limit: 2 },
      ],
      now: NOW,
    });
    const provisional = await store.settle({
      projectId: "project-1",
      reservationId: created.reservation.reservationId,
      settlementId: "partial",
      outcome: "success",
      actualLines: [{ policyId: "money", quantity: 0.25 }],
      now: NOW,
    });
    assert.equal(provisional.reservation.state, "unknown");
    const reconciled = await store.settle({
      projectId: "project-1",
      reservationId: created.reservation.reservationId,
      settlementId: "complete",
      outcome: "success",
      actualLines: [
        { policyId: "money", quantity: 0.25 },
        { policyId: "calls", quantity: 1 },
      ],
      now: NOW,
    });
    assert.equal(reconciled.reservation.state, "settled");
  });

  it("carries usage when a policy limit changes prospectively", async () => {
    const store = new InMemoryReservationStore();
    await store.reserve({
      projectId: "project-1",
      admissionId: "limit-old",
      fingerprint: "old",
      lines: [{ policyId: "p", windowKey: "2026-09-13", unit: "calls", quantity: 1, limit: 2 }],
      now: NOW,
    });
    const edited = await store.reserve({
      projectId: "project-1",
      admissionId: "limit-new",
      fingerprint: "new",
      lines: [{ policyId: "p", windowKey: "2026-09-13", unit: "calls", quantity: 1, limit: 3 }],
      now: NOW,
    });
    assert.equal(edited.replay, false);
    const tooMuch = store.reserve({
      projectId: "project-1",
      admissionId: "limit-over",
      fingerprint: "over",
      lines: [{ policyId: "p", windowKey: "2026-09-13", unit: "calls", quantity: 1, limit: 2 }],
      now: NOW,
    });
    await assert.rejects(tooMuch);
  });
});

describe("DX09 SDK HTTP seam", () => {
  it("authenticates the DSN project and returns a typed refusal without touching provider traffic", async () => {
    const serviceInstance = service([callsPolicy({ allowance: 0 })]);
    const fakePool = {
      query: async (sql: string) => sql.includes("projects") ? { rows: [{ id: "project-1" }] } : { rows: [] },
    } as unknown as import("pg").Pool;
    const app = express();
    app.use(express.json());
    app.use(createSdkAdmissionRouter(fakePool, { service: serviceInstance }));
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/sdk/policy/admit`, {
        method: "POST",
        headers: { Authorization: "Bearer project-secret", "Content-Type": "application/json" },
        body: JSON.stringify({
          admissionId: "http-refusal",
          requestId: "provider-http-refusal",
          provider: "test-provider",
          model: "test-model",
          integration,
        }),
      });
      const body = await response.json() as Record<string, unknown>;
      assert.equal(response.status, 429);
      assert.equal(body.error, "COSTKEY_POLICY_REFUSED");
      assert.equal(body.reason, "budget_exhausted");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
