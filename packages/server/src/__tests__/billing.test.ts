import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveEventCost, resolveEventCostWithOverrides, resolveExplicitUsageCost } from "../billing.js";
import { computeCost } from "../pricing.js";
import type { CostKeyEvent } from "@costkey/shared";

test("old SDK raw OpenRouter billing overrides the token estimate including zero", () => {
  for (const cost of [0, 0.0013606]) {
    const event = {
      provider: "openrouter", model: "google/gemini-2.5-flash",
      usage: { inputTokens: 26749, outputTokens: 97 },
      responseBody: { usage: { cost } },
    } as CostKeyEvent;
    assert.equal(resolveEventCost(event), cost);
  }
});

test("mixed image output uses separate rates and unknown breakdown stays unpriced", () => {
  assert.equal(computeCost("google/gemini-3.1-flash-image", 1972, 1220), null);
  assert.equal(computeCost("google/gemini-3.1-flash-image", 1972, 1220, null, null, "openrouter", null, 1120), 0.068486);
  assert.equal(computeCost("text-embedding-3-small", 3, 0), 0.00000006);
});

test("legacy OpenRouter image events infer only exact image-token units", () => {
  const exact = {
    provider: "openrouter",
    model: "google/gemini-3.1-flash-image",
    usage: { inputTokens: 1_972, outputTokens: 1_120 },
    responseBody: { usage: { prompt_tokens: 1_972, completion_tokens: 1_120 } },
  } as CostKeyEvent;
  assert.equal(resolveEventCost(exact), 0.068186);

  const mixed = { ...exact, usage: { inputTokens: 1_972, outputTokens: 1_485 } } as CostKeyEvent;
  assert.equal(resolveEventCost(mixed), null);
});

test("invalid billing cannot turn a request into a negative charge", () => {
  const event = { provider: "openrouter", model: "unknown", usage: { costUsd: -1 }, costUsd: -1 } as CostKeyEvent;
  assert.equal(resolveEventCost(event), null);
  assert.equal(computeCost("gpt-4o", -1, 0), null);
});

test("unknown variants do not borrow their neighbouring model's price", () => {
  for (const model of ["gpt-4o-new-image", "google/gemini-3.8-flash:batch", "qwen-new-giant"]) {
    assert.equal(computeCost(model, 100, 100), null);
  }
  assert.equal(computeCost("gemini-2.5-pro", 200001, 1000), 0.5150025);
});

test("top-level SDK estimate does not masquerade as provider-reported cost", async () => {
  const pool = {
    async query(_sql: string, params: unknown[]) {
      const unit = String(params[3]);
      const rate = unit === "input_tokens" ? 0.1 : 0.2;
      return { rows: [{
        id: `price-${unit}`, project_id: "project", provider: "openai", account_scope: "acct",
        model: "gpt-4o", native_unit: unit, price_per_unit: rate, currency: "USD",
        effective_from: "2026-09-01T00:00:00.000Z", effective_to: null,
        source: "negotiated", version: 1, pricing_id: `negotiated-${unit}`,
        metadata: {}, revoked_at: null, created_by: null, updated_by: null,
        created_at: "2026-09-01T00:00:00.000Z", updated_at: "2026-09-01T00:00:00.000Z",
      }] };
    },
  };
  const result = await resolveEventCostWithOverrides(pool as never, "project", {
    provider: "openai", model: "gpt-4o", costUsd: 999,
    usage: { inputTokens: 10, outputTokens: 5 },
    context: { accountScope: "acct" }, timestamp: "2026-09-13T00:00:00.000Z",
  } as CostKeyEvent);
  assert.equal(result.cost, 2);
  assert.equal(result.basis, "estimated");
  assert.equal(result.source, "effective_price_override");
});

test("OpenRouter client-reported zero is never promoted to provider evidence", async () => {
  let queried = false;
  const pool = { async query() { queried = true; return { rows: [] }; } };
  const result = await resolveEventCostWithOverrides(pool as never, "project", {
    provider: "openrouter", model: "gpt-4o", costUsd: 999,
    usage: { inputTokens: 10, outputTokens: 5, costUsd: 0 },
    context: { accountScope: "acct" }, timestamp: "2026-09-13T00:00:00.000Z",
  } as CostKeyEvent);
  assert.equal(result.cost, 0.000075);
  assert.equal(result.basis, "estimated");
  assert.equal(result.source, "pricing_table");
  assert.equal(queried, true);
});

test("explicit DSN amount remains an untrusted estimate", async () => {
  const result = await resolveExplicitUsageCost({ query: async () => ({ rows: [] }) } as never, "project", {
    provider: "voice", model: null, timestamp: "2026-09-13T00:00:00.000Z",
  } as CostKeyEvent, {
    provider: "voice", model: null, unitKind: null, unitValue: null,
    currency: "USD", amount: 42, amountPresent: true, amountKind: "reported",
  });
  assert.equal(result.cost, 42);
  assert.equal(result.basis, "estimated");
  assert.equal(result.source, "client_reported");
});

test("explicit usage maps price every declared unit or stays unknown", async () => {
  const pool = {
    async query(_sql: string, params: unknown[]) {
      const unit = String(params[3]);
      return { rows: [{
        id: `price-${unit}`, project_id: "project", provider: "voice", account_scope: "acct",
        model: null, native_unit: unit, price_per_unit: unit === "input_tokens" ? 0.1 : 0.25, currency: "USD",
        effective_from: "2026-09-01T00:00:00.000Z", effective_to: null,
        source: "negotiated", version: 1, pricing_id: `rate-${unit}`,
        metadata: {}, revoked_at: null, created_by: null, updated_by: null,
        created_at: "2026-09-01T00:00:00.000Z", updated_at: "2026-09-01T00:00:00.000Z",
      }] };
    },
  };
  const input = await resolveExplicitUsageCost(pool as never, "project", {
    provider: "voice", model: null, usage: { inputTokens: 10 }, context: { accountScope: "acct" },
    timestamp: "2026-09-13T00:00:00.000Z",
  } as CostKeyEvent, {
    provider: "voice", model: null, unitKind: null, unitValue: null,
    currency: "USD", amount: null, amountPresent: false,
  });
  assert.equal(input.cost, 1);

  const ambiguous = await resolveExplicitUsageCost(pool as never, "project", {
    provider: "voice", model: null, usage: { inputTokens: 10, audioSeconds: 2 }, context: { accountScope: "acct" },
    timestamp: "2026-09-13T00:00:00.000Z",
  } as CostKeyEvent, {
    provider: "voice", model: null, unitKind: null, unitValue: null,
    currency: "USD", amount: null, amountPresent: false,
  });
  assert.equal(ambiguous.cost, null);
});

test("billingUnits wins over a display unit and missing component rates stay unknown", async () => {
  const pool = {
    async query(_sql: string, params: unknown[]) {
      const unit = String(params[3]);
      if (unit === "output_tokens") return { rows: [] };
      return { rows: [{
        id: "price-input", project_id: "project", provider: "voice", account_scope: "acct",
        model: null, native_unit: "input_tokens", price_per_unit: 0.1, currency: "USD",
        effective_from: "2026-09-01T00:00:00.000Z", effective_to: null,
        source: "negotiated", version: 1, pricing_id: "rate-input",
        metadata: {}, revoked_at: null, created_by: null, updated_by: null,
        created_at: "2026-09-01T00:00:00.000Z", updated_at: "2026-09-01T00:00:00.000Z",
      }] };
    },
  };
  const result = await resolveExplicitUsageCost(pool as never, "project", {
    provider: "voice", model: null, billingUnits: { inputTokens: 10, outputTokens: 5 },
    unitKind: "input_tokens", unitValue: 10, usage: { inputTokens: 10 },
    context: { accountScope: "acct" }, timestamp: "2026-09-13T00:00:00.000Z",
  } as CostKeyEvent, {
    provider: "voice", model: null, unitKind: "input_tokens", unitValue: 10,
    currency: "USD", amount: null, amountPresent: false,
  });
  assert.equal(result.cost, null);
});

test("billingUnits sums a compound explicit charge once", async () => {
  const pool = {
    async query(_sql: string, params: unknown[]) {
      const unit = String(params[3]);
      return { rows: [{
        id: `price-${unit}`, project_id: "project", provider: "voice", account_scope: "acct",
        model: null, native_unit: unit, price_per_unit: unit === "input_tokens" ? 0.1 : 0.25, currency: "USD",
        effective_from: "2026-09-01T00:00:00.000Z", effective_to: null,
        source: "negotiated", version: 1, pricing_id: `rate-${unit}`,
        metadata: {}, revoked_at: null, created_by: null, updated_by: null,
        created_at: "2026-09-01T00:00:00.000Z", updated_at: "2026-09-01T00:00:00.000Z",
      }] };
    },
  };
  const result = await resolveExplicitUsageCost(pool as never, "project", {
    provider: "voice", model: null, billingUnits: { inputTokens: 10, outputTokens: 5 },
    unitKind: "input_tokens", unitValue: 10, usage: { inputTokens: 10 },
    context: { accountScope: "acct" }, timestamp: "2026-09-13T00:00:00.000Z",
  } as CostKeyEvent, {
    provider: "voice", model: null, unitKind: "input_tokens", unitValue: 10,
    currency: "USD", amount: null, amountPresent: false,
  });
  assert.equal(result.cost, 2.25);
  assert.equal(result.pricingId, "rate-input_tokens,rate-output_tokens");
});
