import type { CostKeyEvent } from "@costkey/shared";
import type pg from "pg";
import { applyEffectivePrice, resolveEffectivePrice } from "./effective-prices.js";
import { computeCost, inferImageOutputTokens } from "./pricing.js";

function record(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return {}; }
  }
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

export function validCost(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Read a legacy OpenRouter amount before body truncation discards it.
 *
 * This is deliberately only an extraction helper.  DSN payloads are
 * client-controlled, so callers must never label the returned value as
 * provider-attested or use it to release a monetary reservation.
 */
export function openRouterReportedCost(provider: string, responseBody: unknown): number | null {
  if (provider !== "openrouter") return null;
  const value = record(record(responseBody).usage).cost;
  return validCost(value) ? value : null;
}

function openRouterImageOutputTokens(provider: string, responseBody: unknown): number | null {
  if (provider !== "openrouter") return null;
  const usage = record(record(responseBody).usage);
  const details = record(usage.completion_tokens_details ?? usage.output_tokens_details);
  for (const value of [
    details.image_tokens,
    details.image_output_tokens,
    usage.image_tokens,
    usage.image_output_tokens,
    usage.native_tokens_completion_images,
  ]) {
    if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  }
  return null;
}

export function resolveEventCost(event: CostKeyEvent): number | null {
  // Provider-native OpenRouter billing is authoritative, including an
  // explicit zero. It must be read before static pricing so a known provider
  // amount is never replaced by a token estimate.
  const reported = openRouterReportedCost(event.provider, event.responseBody);
  if (reported !== null) return reported;
  const usageCost = validCost(event.usage?.costUsd) ? event.usage.costUsd : null;
  if (usageCost !== null) return usageCost;
  const imageOutputTokens = event.usage?.imageOutputTokens
    ?? openRouterImageOutputTokens(event.provider, event.responseBody)
    ?? inferImageOutputTokens(event.model, event.usage?.outputTokens ?? null);
  const estimate = computeCost(
    event.model, event.usage?.inputTokens ?? null, billableOutputTokens(event),
    event.usage?.cacheReadTokens, event.usage?.cacheCreationTokens, event.provider,
    event.timestamp, imageOutputTokens,
  );
  // The amount may be retained as a clearly labelled estimate for old events
  // whose server pricing is unavailable, but it is never provider evidence.
  return estimate ?? (validCost(event.costUsd) ? event.costUsd : null);
}

/**
 * Gemini reports thinking tokens separately from candidate (output) tokens
 * but bills them at the output rate. Other providers already include
 * reasoning in their output count.
 */
export function billableOutputTokens(event: { provider?: string | null; model?: string | null; usage?: { outputTokens?: number | null; reasoningTokens?: number | null } | null }): number | null {
  const output = event.usage?.outputTokens ?? null;
  const reasoning = event.usage?.reasoningTokens ?? null;
  const gemini = event.provider === "google" || (event.model ?? "").toLowerCase().includes("gemini");
  if (!gemini || reasoning == null || reasoning <= 0) return output;
  return (output ?? 0) + reasoning;
}

export interface ResolvedEventCost {
  cost: number | null;
  basis: "reported" | "estimated" | "unknown";
  source: string | null;
  pricingId: string | null;
  pricingDate: string | null;
}

function contextValue(event: CostKeyEvent, ...keys: string[]): string | null {
  const raw = event as unknown as Record<string, unknown>;
  for (const key of keys) {
    const value = raw[key] ?? event.context?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function nativeUsageValue(event: CostKeyEvent, unitKind: string | null, unitValue: number | null): Array<{ unit: string; value: number }> {
  const raw = event as unknown as Record<string, unknown>;
  const billingUnits = raw["billingUnits"] ?? raw["billing_units"];
  const read = (source: unknown): Array<{ unit: string; value: number }> => {
    if (!source || typeof source !== "object" || Array.isArray(source)) return [];
    const values: Array<{ unit: string; value: number }> = [];
    for (const [rawUnit, rawValue] of Object.entries(source as Record<string, unknown>)) {
      if (rawValue === null || rawValue === undefined) continue;
      if (typeof rawValue !== "number" || !Number.isFinite(rawValue) || rawValue < 0) continue;
      const unit = rawUnit.replace(/[A-Z]/g, (character) => `_${character.toLowerCase()}`);
      values.push({ unit, value: rawValue });
    }
    const hasParts = values.some((item) => item.unit === "input_tokens") || values.some((item) => item.unit === "output_tokens");
    return hasParts ? values.filter((item) => item.unit !== "total_tokens") : values;
  };
  if (billingUnits) return read(billingUnits);
  if (unitKind && unitValue !== null && Number.isFinite(unitValue) && unitValue >= 0) {
    return [{ unit: unitKind, value: unitValue }];
  }
  const normalized = read(raw["usage"] ?? raw["nativeUsage"] ?? raw["native_usage"]);
  // An unlabelled multi-unit explicit payload is not a billing contract. A
  // caller must provide billingUnits or a single unitKind/value pair.
  return normalized.length === 1 ? normalized : [];
}

function providerUsageValues(event: CostKeyEvent): Array<{ unit: string; value: number }> {
  const raw = event as unknown as Record<string, unknown>;
  const source = raw["billingUnits"] ?? raw["billing_units"] ?? raw["usage"] ?? raw["nativeUsage"] ?? raw["native_usage"];
  if (!source || typeof source !== "object" || Array.isArray(source)) return [];
  const values: Array<{ unit: string; value: number }> = [];
  for (const [rawUnit, rawValue] of Object.entries(source as Record<string, unknown>)) {
    if (rawValue === null || rawValue === undefined || typeof rawValue !== "number" || !Number.isFinite(rawValue) || rawValue < 0) continue;
    const unit = rawUnit.replace(/[A-Z]/g, (character) => `_${character.toLowerCase()}`);
    if (unit !== "total_tokens") values.push({ unit, value: rawValue });
  }
  return values;
}

function usageUnitFamily(unit: string): "tokens" | "time" | "other" {
  if (unit.includes("token")) return "tokens";
  if (/(second|minute|hour|millisecond|duration)/.test(unit)) return "time";
  return "other";
}

function hasAmbiguousUsageFamilies(units: Array<{ unit: string; value: number }>): boolean {
  return new Set(units.map((item) => usageUnitFamily(item.unit))).size > 1;
}

function hasInvalidCallUsage(event: CostKeyEvent): boolean {
  const usage = event.usage as unknown as Record<string, unknown> | null | undefined;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return false;
  for (const key of ["inputTokens", "outputTokens", "reasoningTokens", "cacheReadTokens", "cacheCreationTokens", "imageOutputTokens"]) {
    const value = usage[key];
    if (value !== undefined && value !== null
      && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) return true;
  }
  return false;
}

const BILLABLE_PROVIDER_UNITS = new Set([
  "input_tokens", "output_tokens", "reasoning_tokens", "cache_read_tokens",
  "cache_creation_tokens", "image_output_tokens",
]);

/**
 * Resolve dated account rates only when an explicit account scope is present.
 * Every value arriving through the DSN is untrusted.  Server-owned effective
 * prices/static pricing win; a client amount is retained only as an explicit
 * `estimated/client_reported` fallback when no server pricing is available.
 */
export async function resolveEventCostWithOverrides(
  pool: pg.Pool,
  projectId: string,
  event: CostKeyEvent,
): Promise<ResolvedEventCost> {
  const raw = event as unknown as Record<string, unknown>;
  const rawUsage = raw["usage"] && typeof raw["usage"] === "object" ? raw["usage"] as Record<string, unknown> : {};
  if (hasInvalidCallUsage(event)) {
    return { cost: null, basis: "unknown", source: null, pricingId: null, pricingDate: null };
  }
  const accountScope = contextValue(event, "accountScope", "account_scope", "billingAccount", "billing_account");
  if (accountScope && event.model && event.usage) {
    const components = providerUsageValues(event)
      .filter((component) => BILLABLE_PROVIDER_UNITS.has(component.unit));
    if (components.length > 0) {
      const matches = await Promise.all(components.map(async (component) => {
        const price = await resolveEffectivePrice(pool, projectId, {
          provider: event.provider,
          accountScope,
          model: event.model,
          nativeUnit: component.unit,
          currency: "USD",
          at: event.timestamp,
        });
        return { component, price };
      }));
      if (matches.every((match) => match.price !== null)) {
        let cost = 0;
        let pricingId: string | null = null;
        let pricingDate: string | null = null;
        for (const match of matches) {
          const applied = applyEffectivePrice({ reportedCost: null, usageValue: match.component.value, usageCurrency: "USD", price: match.price });
          if (applied.cost === null) return { cost: null, basis: "unknown", source: null, pricingId: null, pricingDate: null };
          cost += applied.cost;
          pricingId ??= applied.pricingId;
          pricingDate ??= match.price?.effectiveFrom ?? null;
        }
        return { cost, basis: "estimated", source: "effective_price_override", pricingId, pricingDate };
      }
    }
  }

  const imageOutputTokens = event.usage?.imageOutputTokens
    ?? openRouterImageOutputTokens(event.provider, event.responseBody)
    ?? inferImageOutputTokens(event.model, event.usage?.outputTokens ?? null);
  const serverEstimate = computeCost(
    event.model, event.usage?.inputTokens ?? null, billableOutputTokens(event),
    event.usage?.cacheReadTokens, event.usage?.cacheCreationTokens, event.provider,
    event.timestamp, imageOutputTokens,
  );
  if (serverEstimate !== null) {
    return {
      cost: serverEstimate,
      basis: "estimated",
      source: "pricing_table",
      pricingId: null,
      pricingDate: null,
    };
  }

  const clientEstimate = validCost(raw["costUsd"])
    ? raw["costUsd"] as number
    : validCost(rawUsage["costUsd"])
      ? rawUsage["costUsd"] as number
      : openRouterReportedCost(event.provider, event.responseBody);
  return {
    cost: clientEstimate,
    basis: clientEstimate === null ? "unknown" : "estimated",
    source: clientEstimate === null ? null : "client_reported",
    pricingId: null,
    pricingDate: null,
  };
}

export async function resolveExplicitUsageCost(
  pool: pg.Pool,
  projectId: string,
  event: CostKeyEvent,
  usage: { provider: string; model: string | null; unitKind: string | null; unitValue: number | null; currency: string; amount: number | null; amountPresent: boolean; amountKind?: "reported" | "estimated" },
): Promise<ResolvedEventCost> {
  if (usage.amountPresent) {
    return usage.amount === null
      ? { cost: null, basis: "unknown", source: null, pricingId: null, pricingDate: null }
        : usage.currency.toUpperCase() === "USD"
        ? {
          cost: usage.amount,
          // DSN usage amounts are caller-supplied even when the caller labels
          // them "reported". Keep the amount only as a visible estimate.
          basis: "estimated",
          source: "client_reported",
          pricingId: null,
          pricingDate: null,
        }
        : { cost: null, basis: "unknown", source: null, pricingId: null, pricingDate: null };
  }
  if (usage.currency.toUpperCase() !== "USD") {
    return { cost: null, basis: "unknown", source: null, pricingId: null, pricingDate: null };
  }
  const accountScope = contextValue(event, "accountScope", "account_scope", "billingAccount", "billing_account");
  if (!accountScope) {
    return { cost: null, basis: "unknown", source: null, pricingId: null, pricingDate: null };
  }
  const units = nativeUsageValue(event, usage.unitKind, usage.unitValue);
  // A map containing token and time/other families is ambiguous without an
  // explicit unit declaration, so keep it unknown rather than guessing
  // whether one unit is a bundle or a separate charge.
  const rawEvent = event as unknown as Record<string, unknown>;
  if (units.length === 0 || (!usage.unitKind && hasAmbiguousUsageFamilies(units)
    && !rawEvent["billingUnits"] && !rawEvent["billing_units"])) {
    return { cost: null, basis: "unknown", source: null, pricingId: null, pricingDate: null };
  }
  const matches = await Promise.all(units.map(async (item) => ({
    item,
    price: await resolveEffectivePrice(pool, projectId, {
      provider: usage.provider,
      accountScope,
      model: usage.model,
      nativeUnit: item.unit,
      currency: "USD",
      at: event.timestamp,
    }),
  })));
  if (matches.some((item) => item.price === null)) {
    // A usage payload may contain several incompatible units. Do not charge
    // only the subset that happened to have a matching rate.
    return { cost: null, basis: "unknown", source: null, pricingId: null, pricingDate: null };
  }
  let cost = 0;
  const pricingIds = new Set<string>();
  let pricingDate: string | null = null;
  for (const match of matches) {
    const applied = applyEffectivePrice({ reportedCost: null, usageValue: match.item.value, usageCurrency: "USD", price: match.price });
    if (applied.cost === null) return { cost: null, basis: "unknown", source: null, pricingId: null, pricingDate: null };
    cost += applied.cost;
    if (applied.pricingId) pricingIds.add(applied.pricingId);
    if (match.price?.effectiveFrom && (!pricingDate || match.price.effectiveFrom < pricingDate)) pricingDate = match.price.effectiveFrom;
  }
  return {
    cost,
    basis: "estimated",
    source: "effective_price_override",
    pricingId: pricingIds.size > 0 ? [...pricingIds].sort().join(",") : null,
    pricingDate,
  };
}
