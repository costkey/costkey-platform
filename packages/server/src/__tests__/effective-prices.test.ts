import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  EffectivePriceConflictError,
  EffectivePriceInputError,
  EffectivePricePermissionError,
  applyEffectivePrice,
  assertCanManageEffectivePrices,
  createEffectivePrice,
  effectivePriceScopesOverlap,
  normalizeEffectivePriceInput,
  resolveEffectivePrice,
  type EffectivePriceInput,
} from "../effective-prices.js";

function input(overrides: Partial<EffectivePriceInput> = {}): EffectivePriceInput {
  return {
    provider: "openrouter",
    accountScope: "acct-1",
    model: "google/gemini-3.1-flash-image",
    nativeUnit: "image_output_tokens",
    pricePerUnit: 0.01,
    currency: "USD",
    effectiveFrom: "2026-09-01T00:00:00Z",
    effectiveTo: "2026-10-01T00:00:00Z",
    source: "user_supplied",
    version: 1,
    pricingId: "manual-image-v1",
    metadata: { note: "fixture" },
    ...overrides,
  };
}

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "price-1",
    project_id: "project",
    provider: "openrouter",
    account_scope: "acct-1",
    model: "google/gemini-3.1-flash-image",
    native_unit: "image_output_tokens",
    price_per_unit: 0.01,
    currency: "USD",
    effective_from: "2026-09-01T00:00:00Z",
    effective_to: "2026-10-01T00:00:00Z",
    source: "user_supplied",
    version: 1,
    pricing_id: "manual-image-v1",
    metadata: { note: "fixture" },
    created_by: "owner",
    updated_by: "owner",
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
    ...overrides,
  };
}

describe("F10 effective-price contract", () => {
  it("requires exact scopes, dated intervals, and non-negative rates", () => {
    assert.deepEqual(normalizeEffectivePriceInput(input({ pricePerUnit: 0 })).pricePerUnit, 0);
    assert.throws(() => normalizeEffectivePriceInput(input({ model: "gemini-*" })), EffectivePriceInputError);
    assert.throws(() => normalizeEffectivePriceInput(input({ effectiveTo: "2026-08-01T00:00:00Z" })), EffectivePriceInputError);
    assert.throws(() => normalizeEffectivePriceInput(input({ pricePerUnit: -1 })), EffectivePriceInputError);
  });

  it("rejects overlapping exact and broad model rules but permits adjacent periods", () => {
    assert.equal(effectivePriceScopesOverlap(input(), input({ version: 2 })), true);
    assert.equal(effectivePriceScopesOverlap(input(), input({ model: null, version: 2 })), true);
    assert.equal(effectivePriceScopesOverlap(input(), input({ model: "other-model", version: 2 })), false);
    assert.equal(effectivePriceScopesOverlap(input(), input({ effectiveFrom: "2026-10-01T00:00:00Z", effectiveTo: null, version: 2 })), false);
  });

  it("keeps provider-reported amounts authoritative and applies rates only to unknown cost", () => {
    const price = {
      id: "p", pricingId: "manual-v1", pricePerUnit: 0.25, currency: "USD",
      source: "user_supplied", version: 1, effectiveFrom: "2026-09-01T00:00:00Z", effectiveTo: null,
      basis: "effective_price_override" as const,
    };
    assert.deepEqual(applyEffectivePrice({ reportedCost: 0, usageValue: 10, price }), {
      cost: 0, basis: "reported", source: "provider", pricingId: null,
    });
    assert.deepEqual(applyEffectivePrice({ reportedCost: null, usageValue: 10, price }), {
      cost: 2.5, basis: "estimated", source: "user_supplied", pricingId: "manual-v1",
    });
    assert.equal(applyEffectivePrice({ reportedCost: -1, usageValue: 10, price }).cost, null);
    assert.equal(applyEffectivePrice({ reportedCost: null, usageValue: null, price }).cost, null);
  });

  it("resolves only an exact active dated rule and leaves ambiguous history unknown", async () => {
    const pool = {
      query: async (_sql: string, params: unknown[]) => ({
        rows: new Date(String(params[5])).getTime() >= new Date("2026-10-01T00:00:00Z").getTime() ? [] : [row()],
      }),
    };
    const resolved = await resolveEffectivePrice(pool as never, "project", {
      provider: "openrouter",
      accountScope: "acct-1",
      model: "google/gemini-3.1-flash-image",
      nativeUnit: "image_output_tokens",
      currency: "USD",
      at: "2026-09-13T00:00:00Z",
    });
    assert.equal(resolved?.pricingId, "manual-image-v1");
    const expired = await resolveEffectivePrice(pool as never, "project", {
      provider: "openrouter", accountScope: "acct-1", model: "google/gemini-3.1-flash-image",
      nativeUnit: "image_output_tokens", currency: "USD", at: "2026-10-01T00:00:00Z",
    });
    assert.equal(expired, null);
    const ambiguous = await resolveEffectivePrice({ query: async () => ({ rows: [row(), row({ id: "price-2", version: 2 })] }) } as never, "project", {
      provider: "openrouter", accountScope: "acct-1", model: "google/gemini-3.1-flash-image",
      nativeUnit: "image_output_tokens", currency: "USD", at: "2026-09-13T00:00:00Z",
    });
    assert.equal(ambiguous, null);
  });

  it("enforces Owner/Admin management and rejects existing overlap before insert", async () => {
    assert.doesNotThrow(() => assertCanManageEffectivePrices("owner"));
    assert.doesNotThrow(() => assertCanManageEffectivePrices("admin"));
    assert.throws(() => assertCanManageEffectivePrices("developer"), EffectivePricePermissionError);
    const statements: string[] = [];
    const pool = {
      query: async (sql: string) => {
        statements.push(sql);
        return { rows: sql.includes("FROM effective_prices") ? [row()] : [] };
      },
    };
    await assert.rejects(
      () => createEffectivePrice(pool as never, "project", input({ version: 2 }), "price-2", { role: "owner" }),
      EffectivePriceConflictError,
    );
    assert.equal(statements.some((sql) => sql.includes("INSERT INTO effective_prices")), false);
  });

  it("assigns the next monotonic version on the server", async () => {
    let insertParams: unknown[] | undefined;
    const pool = {
      query: async (sql: string, params: unknown[] = []) => {
        if (sql.includes("MAX(version)")) return { rows: [{ next_version: 8 }] };
        if (sql.includes("INSERT INTO effective_prices")) { insertParams = params; return { rows: [] }; }
        if (sql.includes("FROM effective_prices")) return { rows: [] };
        return { rows: [] };
      },
    };
    await createEffectivePrice(pool as never, "project", input({ version: 1 }), "price-server-version", { role: "owner" });
    assert.equal(insertParams?.[11], 8, "client-supplied version must not control history");
  });
});
