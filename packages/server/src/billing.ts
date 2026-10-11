import type { CostKeyEvent } from "@costkey/shared";
import type pg from "pg";
import { applyEffectivePrice, resolveEffectivePrice } from "./effective-prices.js";
import { computeCost, inferImageOutputTokens } from "./pricing.js";
import { getPriceCatalog, providerChain } from "./price-catalog/catalog.js";
import { costFromRates } from "./price-catalog/compute.js";
import { requestPriceRefresh } from "./price-catalog/sync.js";
import type { PriceRates, PricedUsage } from "./price-catalog/types.js";

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

/** Project price units and the catalog rate each one sets. */
const PROJECT_PRICE_RATES: Record<string, keyof PriceRates> = {
  input_tokens: "input", output_tokens: "output", cache_read_tokens: "cacheRead",
  cache_creation_tokens: "cacheWrite", image_output_tokens: "outputImage",
  characters: "perCharacter", audio_seconds: "perSecond", search_queries: "perQuery",
  credits: "perCredit", pages: "perPage", images: "perOutputImage", requests: "perRequest",
  grounding_requests: "searchPerQuery", maps_grounding_requests: "mapsPerQuery",
};

interface ProjectPriceRow {
  id: string;
  provider: string;
  model: string | null;
  nativeUnit: string;
  pricePerUnit: number;
  pricingId: string;
  effectiveFrom: number;
  effectiveTo: number | null;
  revokedAt: number | null;
}

const PROJECT_PRICE_TTL_MS = 30_000;
const projectPriceCache = new Map<string, { loadedAt: number; rows: ProjectPriceRow[] }>();

const projectAliasCache = new Map<string, { loadedAt: number; aliases: Map<string, string> }>();

/** Drop cached project prices and aliases after one is created, changed or removed. */
export function invalidateProjectPrices(projectId: string): void {
  projectPriceCache.delete(projectId);
  projectAliasCache.delete(projectId);
}

/** The catalog model a project prices one of its own model names as. */
async function projectAlias(pool: pg.Pool | pg.PoolClient, projectId: string, provider: string, model: string | null): Promise<string | null> {
  if (!model) return null;
  let cached = projectAliasCache.get(projectId);
  if (!cached || Date.now() - cached.loadedAt >= PROJECT_PRICE_TTL_MS) {
    const result = await pool.query(
      "SELECT provider, model, target_model FROM model_aliases WHERE project_id = $1",
      [projectId],
    ).catch((error: { code?: string }) => {
      if (error.code === "42P01") return { rows: [] as Array<Record<string, unknown>> };
      throw error;
    });
    cached = {
      loadedAt: Date.now(),
      aliases: new Map((result.rows as Array<Record<string, unknown>>).map((row) => [`${String(row.provider).toLowerCase()}\u0000${String(row.model).toLowerCase()}`, String(row.target_model)])),
    };
    projectAliasCache.set(projectId, cached);
  }
  return cached.aliases.get(`${provider.toLowerCase()}\u0000${model.toLowerCase()}`) ?? null;
}

/** Prices a project set for every call (account scope `*`), cached briefly. */
async function projectPrices(pool: pg.Pool | pg.PoolClient, projectId: string): Promise<ProjectPriceRow[]> {
  const cached = projectPriceCache.get(projectId);
  if (cached && Date.now() - cached.loadedAt < PROJECT_PRICE_TTL_MS) return cached.rows;
  const result = await pool.query(
    `SELECT id, provider, model, native_unit, price_per_unit, pricing_id, version,
            effective_from, effective_to, revoked_at
     FROM effective_prices
     WHERE project_id = $1 AND account_scope = '*' AND currency = 'USD'`,
    [projectId],
  ).catch((error: { code?: string }) => {
    if (error.code === "42P01") return { rows: [] as Array<Record<string, unknown>> };
    throw error;
  });
  const rows = (result.rows as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id),
    provider: String(row.provider).toLowerCase(),
    model: row.model == null ? null : String(row.model).toLowerCase(),
    nativeUnit: String(row.native_unit),
    pricePerUnit: Number(row.price_per_unit),
    pricingId: row.pricing_id ? String(row.pricing_id) : `${row.id}@v${row.version}`,
    effectiveFrom: new Date(row.effective_from as string).getTime(),
    effectiveTo: row.effective_to ? new Date(row.effective_to as string).getTime() : null,
    revokedAt: row.revoked_at ? new Date(row.revoked_at as string).getTime() : null,
  }));
  projectPriceCache.set(projectId, { loadedAt: Date.now(), rows });
  return rows;
}

function projectRates(rows: ProjectPriceRow[], provider: string, model: string | null, at: number): { rates: PriceRates; pricingId: string; effectiveFrom: string } | null {
  const lowerModel = model?.toLowerCase() ?? null;
  const live = rows.filter((row) => row.provider === provider.toLowerCase()
    && (row.model === null || row.model === lowerModel)
    && row.effectiveFrom <= at && (row.effectiveTo === null || at < row.effectiveTo)
    && (row.revokedAt === null || at < row.revokedAt)
    && PROJECT_PRICE_RATES[row.nativeUnit] !== undefined);
  if (live.length === 0) return null;
  // A model-specific price beats a provider-wide one for the same unit.
  live.sort((a, b) => (a.model === null ? 1 : 0) - (b.model === null ? 1 : 0) || b.effectiveFrom - a.effectiveFrom);
  const rates: PriceRates = {};
  const ids = new Set<string>();
  let effectiveFrom = Number.POSITIVE_INFINITY;
  for (const row of live) {
    const field = PROJECT_PRICE_RATES[row.nativeUnit]!;
    if ((rates as Record<string, unknown>)[field] !== undefined) continue;
    (rates as Record<string, unknown>)[field] = row.pricePerUnit;
    ids.add(row.pricingId);
    effectiveFrom = Math.min(effectiveFrom, row.effectiveFrom);
  }
  return { rates, pricingId: [...ids].sort().join(","), effectiveFrom: new Date(effectiveFrom).toISOString() };
}

export interface CallPricingInput {
  provider: string;
  url?: string | null;
  model: string | null;
  requestModel?: string | null;
  timestamp?: string | null;
  usage: PricedUsage;
}

export interface ServerPrice {
  cost: number;
  source: string;
  pricingId: string | null;
  pricingDate: string | null;
}

/**
 * Price a call from server-owned prices, most specific first: a price the
 * project set, the synced catalog, then the built-in table.
 */
export async function priceCall(pool: pg.Pool | pg.PoolClient, projectId: string, rawInput: CallPricingInput): Promise<ServerPrice | null> {
  // DeepSeek reports no cache writes: SDK 0.6 rows carry its cache-miss
  // tokens (ordinary input, already in inputTokens) as cache creation.
  const input: CallPricingInput = rawInput.provider === "deepseek" && rawInput.usage.cacheCreationTokens != null
    ? { ...rawInput, usage: { ...rawInput.usage, cacheCreationTokens: null } }
    : rawInput;
  const at = input.timestamp ? new Date(input.timestamp).getTime() : Date.now();
  const usageProvider = providerChain(input.provider, input.url)[0] ?? input.provider;
  const model = input.model ?? input.requestModel ?? null;
  const rows = await projectPrices(pool, projectId);
  const names = [...new Set([input.model, input.requestModel].filter((name): name is string => Boolean(name)))];
  for (const name of names.length > 0 ? names : [null]) {
    const project = projectRates(rows, input.provider, name, Number.isNaN(at) ? Date.now() : at);
    if (!project) continue;
    const cost = costFromRates(project.rates, input.usage, usageProvider, model ?? "");
    if (cost !== null) return { cost, source: "project_price", pricingId: project.pricingId, pricingDate: project.effectiveFrom };
  }
  const catalog = getPriceCatalog();
  const alias = await projectAlias(pool, projectId, input.provider, input.model) ?? await projectAlias(pool, projectId, input.provider, input.requestModel ?? null);
  const lookupModel = alias ?? input.model;
  const lookupRequestModel = alias ? null : input.requestModel;
  // DeepSeek's direct API changes price by time of day; the built-in table
  // carries that schedule, so it goes first there.
  const deepSeekDirect = input.provider === "deepseek";
  const fromCatalog = () => {
    const priced = catalog.price({ provider: input.provider, url: input.url, model: lookupModel, requestModel: lookupRequestModel, at: input.timestamp, usage: input.usage });
    return priced ? { cost: priced.cost, source: `catalog:${priced.source}`, pricingId: priced.priceId, pricingDate: priced.effectiveFrom } : null;
  };
  if (!deepSeekDirect) {
    const priced = fromCatalog();
    if (priced) return priced;
  }
  for (const name of [lookupModel, lookupRequestModel]) {
    if (!name) continue;
    const estimate = computeCost(
      name, input.usage.inputTokens ?? null, input.usage.outputTokens ?? null,
      input.usage.cacheReadTokens, input.usage.cacheCreationTokens, input.provider,
      input.timestamp, input.usage.imageOutputTokens, input.usage.nativeUnits?.["cacheCreation1hTokens"] ?? null,
    );
    if (estimate !== null) return { cost: estimate, source: "pricing_table", pricingId: null, pricingDate: null };
  }
  return deepSeekDirect ? fromCatalog() : null;
}

function numberOrNull(value: unknown): number | null {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : null;
}

/** Price a stored call row (used to reprice calls that arrived unpriced). */
export async function priceStoredCall(pool: pg.Pool, row: Record<string, unknown>): Promise<ServerPrice | null> {
  const provider = String(row.provider ?? "unknown");
  const model = row.model == null ? null : String(row.model);
  const nativeUnits = typeof row.native_units === "string" ? JSON.parse(row.native_units) : row.native_units;
  const outputTokens = numberOrNull(row.output_tokens);
  const usage: PricedUsage = {
    inputTokens: numberOrNull(row.input_tokens),
    outputTokens: billableOutputTokens({ provider, model, usage: { outputTokens, reasoningTokens: numberOrNull(row.reasoning_tokens) } }),
    reasoningTokens: numberOrNull(row.reasoning_tokens),
    cacheReadTokens: numberOrNull(row.cache_read_tokens),
    cacheCreationTokens: numberOrNull(row.cache_creation_tokens),
    imageOutputTokens: numberOrNull(row.image_output_tokens) ?? inferImageOutputTokens(model, outputTokens),
    nativeUnits: nativeUnits && typeof nativeUnits === "object" ? nativeUnits as Record<string, number> : null,
  };
  const hasUsage = [usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheCreationTokens].some((value) => (value ?? 0) > 0)
    || Object.keys(usage.nativeUnits ?? {}).length > 0;
  if (!hasUsage) return null;
  const timestamp = row.timestamp instanceof Date ? row.timestamp.toISOString() : row.timestamp == null ? null : String(row.timestamp);
  return priceCall(pool, String(row.project_id), {
    provider, url: row.url == null ? null : String(row.url), model,
    requestModel: row.request_model == null ? null : String(row.request_model), timestamp, usage,
  });
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
  const nativeUnits = event.usage?.nativeUnits && typeof event.usage.nativeUnits === "object" ? event.usage.nativeUnits : null;
  const requestModel = typeof raw["requestModel"] === "string" ? raw["requestModel"] as string
    : typeof raw["request_model"] === "string" ? raw["request_model"] as string : null;
  const hasUsage = event.usage != null && ([event.usage.inputTokens, event.usage.outputTokens, event.usage.cacheReadTokens, event.usage.cacheCreationTokens].some((value) => (value ?? 0) > 0)
    || Object.keys(nativeUnits ?? {}).length > 0);
  if (hasUsage) {
    const serverPrice = await priceCall(pool, projectId, {
      provider: event.provider, url: event.url, model: event.model, requestModel, timestamp: event.timestamp,
      usage: {
        inputTokens: event.usage?.inputTokens ?? null,
        outputTokens: billableOutputTokens(event),
        reasoningTokens: event.usage?.reasoningTokens ?? null,
        cacheReadTokens: event.usage?.cacheReadTokens ?? null,
        cacheCreationTokens: event.usage?.cacheCreationTokens ?? null,
        imageOutputTokens,
        nativeUnits,
      },
    });
    if (serverPrice) return { ...serverPrice, basis: "estimated" };
    // A model no price list knows yet: check the catalogs again soon. The
    // sync reprices this call once a price appears.
    requestPriceRefresh(pool as pg.Pool);
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

/** Explicit usage unit names mapped onto the call usage the catalog prices. */
const EXPLICIT_UNITS: Record<string, { token?: keyof PricedUsage; native?: string }> = {
  input_tokens: { token: "inputTokens" }, prompt_tokens: { token: "inputTokens" }, llm_prompt_tokens: { token: "inputTokens" },
  output_tokens: { token: "outputTokens" }, completion_tokens: { token: "outputTokens" }, llm_completion_tokens: { token: "outputTokens" },
  cache_read_tokens: { token: "cacheReadTokens" }, llm_prompt_cached_tokens: { token: "cacheReadTokens" },
  cache_creation_tokens: { token: "cacheCreationTokens" },
  characters: { native: "characters" }, tts_characters: { native: "characters" }, tts_characters_count: { native: "characters" },
  audio_seconds: { native: "audioSeconds" }, seconds: { native: "audioSeconds" }, audio_duration: { native: "audioSeconds" },
  stt_audio_duration: { native: "audioSeconds" }, tts_audio_duration: { native: "audioSeconds" },
  search_queries: { native: "searchQueries" }, queries: { native: "searchQueries" },
  credits: { native: "credits" }, pages: { native: "pages" }, images: { native: "images" }, requests: { native: "requests" },
};

async function priceExplicitUsage(
  pool: pg.Pool,
  projectId: string,
  event: CostKeyEvent,
  usage: { provider: string; model: string | null },
  units: Array<{ unit: string; value: number }>,
): Promise<ServerPrice | null> {
  if (units.length === 0) return null;
  const priced: PricedUsage = { nativeUnits: {} };
  for (const { unit, value } of units) {
    const target = EXPLICIT_UNITS[unit];
    if (!target) return null;
    if (target.token) (priced as Record<string, unknown>)[target.token] = value;
    else priced.nativeUnits![target.native!] = value;
  }
  return priceCall(pool, projectId, { provider: usage.provider, model: usage.model, timestamp: event.timestamp, usage: priced });
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
  const catalogPrice = async (): Promise<ResolvedEventCost> => {
    const priced = await priceExplicitUsage(pool, projectId, event, usage, nativeUsageValue(event, usage.unitKind, usage.unitValue));
    return priced ? { ...priced, basis: "estimated" } : { cost: null, basis: "unknown", source: null, pricingId: null, pricingDate: null };
  };
  if (!accountScope) return catalogPrice();
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
    return catalogPrice();
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
