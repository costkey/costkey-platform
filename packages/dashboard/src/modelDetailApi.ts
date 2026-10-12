import { UNAUTHENTICATED_EVENT, type BoardBucketUnit, type InsightScope, type TokenUsage } from "./api";
import { appUrl } from "./basePath";

/** Token rates are per 1M tokens; every other rate is per one unit. All in USD. */
export interface ModelPriceRates {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheWrite1h?: number;
  reasoning?: number;
  inputAudio?: number;
  outputAudio?: number;
  inputImage?: number;
  outputImage?: number;
  perCharacter?: number;
  perSecond?: number;
  perQuery?: number;
  perRequest?: number;
  perPage?: number;
  perCredit?: number;
  perInputImage?: number;
  perOutputImage?: number;
  searchPerQuery?: number;
  mapsPerQuery?: number;
  perExtraResult?: number;
}

export interface ModelCatalogPrice {
  source: "catalog";
  /** litellm, models_dev, openrouter or costkey. */
  catalogSource: string;
  match: string;
  provider: string;
  model: string;
  effectiveFrom: string;
  rates: ModelPriceRates;
  longContext: Array<{ threshold: number } & ModelPriceRates>;
}

export interface ModelPriceSource {
  /** estimated, reported, unknown, or failed (a failed call with no price). */
  basis: string;
  /** catalog:litellm, pricing_table, project_price, effective_price_override, client_reported, or null. */
  source: string | null;
  calls: number;
  cost: number | null;
}

export interface ModelRecentCall {
  id: string;
  timestamp: string | null;
  traceId: string | null;
  traceName: string | null;
  costUsd: number | null;
  costBasis: string | null;
  costSource: string | null;
  durationMs: number | null;
  /** As the provider reported them. */
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  units: Record<string, number>;
  failed: boolean;
  status: { lifecycleState: string | null; errorType: string | null; statusCode: number | null };
}

export interface ModelOwner {
  kind: "agent" | "workflow";
  name: string;
  runs: number;
  calls: number;
  cost: number | null;
}

export interface ModelDetail {
  provider: string;
  model: string;
  window: { from: string; to: string; environment: string | null; timezone: string; bucket: BoardBucketUnit };
  summary: {
    calls: number;
    failedCalls: number;
    cost: number | null;
    pricedCalls: number;
    unpricedCalls: number;
    usage: TokenUsage;
    /** Characters, audio seconds, images or searches, for models that bill them. */
    units: Record<string, number>;
    p50Ms: number | null;
    p95Ms: number | null;
  };
  series: Array<{ bucket: string; cost: number; calls: number }>;
  owners: ModelOwner[];
  recentCalls: ModelRecentCall[];
  price: { current: ModelCatalogPrice | null; sources: ModelPriceSource[] };
  cacheWrites: { total: number | null; fiveMinute: number | null; oneHour: number | null };
}

function scopeQuery(scope: InsightScope): URLSearchParams {
  const params = new URLSearchParams({ from: scope.from, to: scope.to });
  if (scope.environment && scope.environment !== "all") params.set("environment", scope.environment);
  return params;
}

export async function getModelDetail(projectId: string, provider: string, model: string, scope: InsightScope): Promise<ModelDetail> {
  const params = scopeQuery(scope);
  params.set("provider", provider);
  params.set("model", model);
  const res = await fetch(appUrl(`/api/v1/projects/${encodeURIComponent(projectId)}/model-detail?${params.toString()}`), { credentials: "include" });
  if (res.status === 401) window.dispatchEvent(new Event(UNAUTHENTICATED_EVENT));
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json() as Promise<ModelDetail>;
}

/* ── Price display ─────────────────────────────────────────────────── */

/** A list price in USD with as many decimals as a small rate needs: "$2.50", "$0.075", "$0.0006". */
export function formatRateUsd(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (value === 0) return "$0";
  const digits = Math.abs(value) >= 1 ? 2 : Math.min(8, Math.max(2, 3 - Math.floor(Math.log10(Math.abs(value)))));
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: digits }).format(value);
}

type RateKey = keyof ModelPriceRates;

/** How each rate reads: its label, the quantity it is quoted per, and the scale from the stored per-unit rate. */
const RATE_WORDS: Array<{ key: RateKey; label: string; per: string; scale: number }> = [
  { key: "input", label: "Input", per: "1M input tokens", scale: 1 },
  { key: "output", label: "Output", per: "1M output tokens", scale: 1 },
  { key: "cacheRead", label: "Cached input", per: "1M cached input tokens", scale: 1 },
  { key: "cacheWrite", label: "Cache write, 5 min", per: "1M cache write tokens", scale: 1 },
  { key: "cacheWrite1h", label: "Cache write, 1 hour", per: "1M cache write tokens", scale: 1 },
  { key: "reasoning", label: "Reasoning", per: "1M reasoning tokens", scale: 1 },
  { key: "inputAudio", label: "Audio input", per: "1M audio input tokens", scale: 1 },
  { key: "outputAudio", label: "Audio output", per: "1M audio output tokens", scale: 1 },
  { key: "inputImage", label: "Image input", per: "1M image input tokens", scale: 1 },
  { key: "outputImage", label: "Image output", per: "1M image output tokens", scale: 1 },
  { key: "perCharacter", label: "Characters", per: "1K characters", scale: 1_000 },
  { key: "perSecond", label: "Audio", per: "minute", scale: 60 },
  { key: "perQuery", label: "Searches", per: "1K searches", scale: 1_000 },
  { key: "searchPerQuery", label: "Web search", per: "1K web searches", scale: 1_000 },
  { key: "mapsPerQuery", label: "Maps grounding", per: "1K requests", scale: 1_000 },
  { key: "perExtraResult", label: "Extra results", per: "result", scale: 1 },
  { key: "perRequest", label: "Requests", per: "1K requests", scale: 1_000 },
  { key: "perPage", label: "Pages", per: "1K pages", scale: 1_000 },
  { key: "perCredit", label: "Credits", per: "credit", scale: 1 },
  { key: "perInputImage", label: "Input images", per: "image", scale: 1 },
  { key: "perOutputImage", label: "Images", per: "image", scale: 1 },
];

/** One rate in words: "$2.50 per 1M input tokens", "$0.18 per 1K characters". */
export function formatRate(key: RateKey, value: number): string {
  const words = RATE_WORDS.find((item) => item.key === key);
  if (!words) return formatRateUsd(value);
  return `${formatRateUsd(value * words.scale)} per ${words.per}`;
}

/** The rates a price lists, in reading order, for a definition list. */
export function rateLines(rates: ModelPriceRates | null | undefined): Array<{ key: RateKey; label: string; value: string }> {
  if (!rates) return [];
  return RATE_WORDS
    .filter((item) => typeof rates[item.key] === "number" && Number.isFinite(rates[item.key]))
    .map((item) => ({ key: item.key, label: item.label, value: formatRate(item.key, rates[item.key]!) }));
}

/** "Above 200K prompt tokens": the rates that replace the base ones past a prompt size. */
export function longContextLine(tier: { threshold: number } & ModelPriceRates): { label: string; value: string } {
  const size = tier.threshold >= 1_000 && tier.threshold % 1_000 === 0 ? `${(tier.threshold / 1_000).toLocaleString("en-US")}K` : tier.threshold.toLocaleString("en-US");
  const parts = [
    tier.input != null ? `${formatRateUsd(tier.input)} input` : null,
    tier.output != null ? `${formatRateUsd(tier.output)} output` : null,
    tier.cacheRead != null ? `${formatRateUsd(tier.cacheRead)} cached` : null,
  ].filter(Boolean);
  return { label: `Above ${size} prompt tokens`, value: `${parts.join(", ")} per 1M tokens` };
}

const CATALOG_NAMES: Record<string, string> = { litellm: "LiteLLM", models_dev: "models.dev", openrouter: "OpenRouter", costkey: "CostKey" };

/** A price catalog by name: "LiteLLM", "models.dev". */
export function catalogName(source: string): string {
  return CATALOG_NAMES[source] ?? source;
}

/** How a call got its cost, as the end of "41 calls ...". */
export function pricedHow(basis: string, source: string | null): string {
  if (basis === "reported") return "reported by the provider";
  if (basis === "failed") return "failed with no charge";
  if (basis === "unpriced") return "with no price";
  if (source?.startsWith("catalog:")) return `priced from the catalog (${catalogName(source.slice("catalog:".length))})`;
  switch (source) {
    case "pricing_table": return "priced from the built-in price table";
    case "project_price": return "priced from your project prices";
    case "effective_price_override": return "priced from a price override";
    case "client_reported": return "priced by your app";
    case null: return "priced, source not recorded";
    default: return `priced from ${source}`;
  }
}

/** "41 calls priced from the catalog (LiteLLM), 2 reported by the provider". */
export function pricingSourcesText(sources: ModelPriceSource[]): string {
  const counts = new Map<string, number>();
  for (const row of sources) {
    if (row.calls <= 0) continue;
    const how = pricedHow(row.basis, row.source);
    counts.set(how, (counts.get(how) ?? 0) + row.calls);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([how, calls], index) => `${calls.toLocaleString("en-US")}${index === 0 ? ` ${calls === 1 ? "call" : "calls"}` : ""} ${how}`)
    .join(", ");
}

/** What a model page's link looks like: `/models/<provider>/<model>`, slashes in the model kept. */
export function modelPath(provider: string, model: string): string {
  return `/models/${encodeURIComponent(provider)}/${model.split("/").map(encodeURIComponent).join("/")}`;
}
