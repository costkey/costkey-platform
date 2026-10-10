import { costFromRates } from "./compute.js";
import { modelCandidates, normalizeModelId, stripModelVersion } from "./normalize.js";
import type { CatalogCost, CatalogMatch, CatalogPrice, MatchKind, PricedUsage, PriceRates, PriceSource } from "./types.js";

const SOURCE_RANK: Record<PriceSource, number> = { costkey: 0, litellm: 1, models_dev: 2, openrouter: 3 };
const AZURE_HOST = /(\.openai\.azure\.com|\.cognitiveservices\.azure\.com|\.services\.ai\.azure\.com|\.models\.ai\.azure\.com)$/;

function key(provider: string, model: string): string {
  return `${provider}\u0000${model}`;
}

const COMPARED_RATES = ["input", "output", "perCharacter", "perSecond", "perQuery", "perCredit", "perRequest"] as const;

/** Two prices agree when every rate both publish is within 10%. */
function agrees(a: PriceRates, b: PriceRates): boolean {
  let compared = 0;
  for (const field of COMPARED_RATES) {
    const x = a[field];
    const y = b[field];
    if (x === undefined || y === undefined) continue;
    compared++;
    const high = Math.max(x, y);
    if (high > 0 && Math.abs(x - y) / high > 0.1) return false;
  }
  return compared > 0;
}

/** A $0 token price with nothing else billed: usually a placeholder, not a free model. */
function isZeroPlaceholder(rates: PriceRates): boolean {
  return (rates.input ?? 0) === 0 && (rates.output ?? 0) === 0
    && COMPARED_RATES.every((field) => (rates[field] ?? 0) === 0);
}

function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try { return new URL(url).hostname.toLowerCase(); } catch { return null; }
}

/** The catalog providers whose list price applies to a call, most specific first. */
export function providerChain(provider: string, url?: string | null): string[] {
  const host = hostOf(url);
  switch (provider) {
    case "openai": return host && AZURE_HOST.test(host) ? ["azure", "openai"] : ["openai"];
    case "azure": return ["azure", "openai"];
    case "google": return host?.endsWith("aiplatform.googleapis.com") ? ["vertex", "google"] : ["google", "vertex"];
    case "vertex": return ["vertex", "google"];
    default: return [provider];
  }
}

/** The vendor that publishes a model's list price, from its name. */
export function modelVendor(model: string): { vendor: string; model: string } | null {
  let name = normalizeModelId(model).replace(/^(us|eu|apac|global|in|jp|au|ca|us-gov)\./, "");
  const prefixed = name.match(/^([a-z0-9-]+)[./](.+)$/);
  if (prefixed && ["openai", "anthropic", "google", "x-ai", "xai", "deepseek", "mistral", "mistralai", "cohere", "perplexity"].includes(prefixed[1]!)) {
    name = prefixed[2]!;
  }
  const vendor =
    /^(gpt-|o\d|chatgpt-|text-embedding-3|text-embedding-ada|whisper|tts-|dall-e|gpt-image|omni-moderation|codex|computer-use)/.test(name) ? "openai"
      : /^claude/.test(name) ? "anthropic"
        : /^(gemini|gemma|imagen|veo)/.test(name) ? "google"
          : /^grok/.test(name) ? "xai"
            : /^deepseek/.test(name) ? "deepseek"
              : /^(mistral|mixtral|codestral|ministral|pixtral|magistral|devstral|voxtral)/.test(name) ? "mistral"
                : /^(command|embed-|rerank-)/.test(name) ? "cohere"
                  : /^sonar/.test(name) ? "perplexity"
                    : null;
  return vendor ? { vendor, model: name } : null;
}

export class PriceCatalog {
  private readonly exact = new Map<string, CatalogPrice[]>();
  private readonly undated = new Map<string, CatalogPrice[]>();
  private readonly prices: CatalogPrice[];
  readonly size: number;

  constructor(prices: CatalogPrice[], readonly loadedAt: Date = new Date()) {
    this.prices = prices;
    for (const price of prices) {
      push(this.exact, key(price.provider, price.model), price);
      const base = stripModelVersion(price.model);
      if (base !== price.model) push(this.undated, key(price.provider, base), price);
    }
    this.size = prices.length;
  }

  private live(list: CatalogPrice[], at: Date): CatalogPrice[] {
    const time = at.getTime();
    const live = list.filter((price) => Date.parse(price.effectiveFrom) <= time && (!price.effectiveTo || time < Date.parse(price.effectiveTo)));
    // A call before the first known price still gets the earliest version.
    return live.length > 0 ? live : list;
  }

  /**
   * Choose between sources: the most recent version of each listing, $0
   * placeholders dropped when a source has a real price, then the price most
   * sources agree on (the vendor's own listing votes too). Curated prices
   * always win; ties go to source precedence.
   */
  private pick(list: CatalogPrice[] | undefined, provider: string, at: Date, voters: CatalogPrice[] = []): CatalogPrice | null {
    if (!list?.length) return null;
    const latest = new Map<string, CatalogPrice>();
    for (const price of [...this.live(list, at)].sort((a, b) => Date.parse(b.effectiveFrom) - Date.parse(a.effectiveFrom))) {
      const id = `${price.source}\u0000${price.provider}\u0000${price.sourceKey}`;
      if (!latest.has(id)) latest.set(id, price);
    }
    let candidates = [...latest.values()];
    const curated = candidates.find((price) => price.source === "costkey");
    if (curated) return curated;
    const real = candidates.filter((price) => !isZeroPlaceholder(price.rates));
    if (real.length > 0) candidates = real;
    if (candidates.length === 1) return candidates[0]!;
    const electorate = [...candidates, ...this.live(voters, at)];
    const votes = (price: CatalogPrice) => electorate.filter((other) => other !== price && agrees(price.rates, other.rates)).length;
    const rank = (price: CatalogPrice) => provider === "openrouter" && price.source === "openrouter" ? -1 : SOURCE_RANK[price.source];
    return candidates.sort((a, b) => votes(b) - votes(a) || rank(a) - rank(b))[0] ?? null;
  }

  lookup(provider: string, model: string, at: Date, allowUndated: boolean): CatalogPrice | null {
    const vendor = modelVendor(model);
    const voters = vendor && vendor.vendor !== provider ? this.exact.get(key(vendor.vendor, vendor.model)) ?? [] : [];
    return this.pick(this.exact.get(key(provider, model)), provider, at, voters)
      ?? (allowUndated ? this.pick(this.undated.get(key(provider, model)), provider, at, voters) : null);
  }

  resolve(input: { provider: string; url?: string | null; model?: string | null; requestModel?: string | null; at?: Date | string | null }): CatalogMatch | null {
    const at = input.at ? new Date(input.at) : new Date();
    const when = Number.isNaN(at.getTime()) ? new Date() : at;
    const chain = providerChain(input.provider, input.url);
    const names = [...new Set([input.model, input.requestModel].filter((name): name is string => typeof name === "string" && name.trim().length > 0))];
    for (const name of names) {
      const candidates = modelCandidates(name);
      for (const [index, provider] of chain.entries()) {
        for (const candidate of candidates) {
          const price = this.lookup(provider, candidate.model, when, candidate.match === "undated");
          if (price) return { price, match: index === 0 ? candidate.match : "first_party" };
        }
      }
    }
    for (const name of names) {
      const vendor = modelVendor(name);
      if (!vendor || chain.includes(vendor.vendor)) continue;
      for (const candidate of modelCandidates(vendor.model)) {
        const price = this.lookup(vendor.vendor, candidate.model, when, candidate.match === "undated");
        if (price) return { price, match: "inferred" as MatchKind };
      }
    }
    return null;
  }

  /** Current prices whose model contains `query`, one per provider and model. */
  search(providers: string[], query: string, limit: number): CatalogPrice[] {
    const wanted = new Set(providers);
    const now = new Date();
    const seen = new Set<string>();
    const out: CatalogPrice[] = [];
    const matches = this.prices
      .filter((price) => (wanted.size === 0 || wanted.has(price.provider)) && price.model.includes(query) && !price.effectiveTo)
      .sort((a, b) => Number(!a.model.startsWith(query)) - Number(!b.model.startsWith(query)) || a.model.length - b.model.length || a.model.localeCompare(b.model));
    for (const price of matches) {
      const id = key(price.provider, price.model);
      if (seen.has(id)) continue;
      seen.add(id);
      const best = this.lookup(price.provider, price.model, now, false);
      if (best) out.push(best);
      if (out.length >= limit) break;
    }
    return out;
  }

  /** Price a call. Null when the model isn't listed or a billed component has no rate. */
  price(input: { provider: string; url?: string | null; model?: string | null; requestModel?: string | null; at?: Date | string | null; usage: PricedUsage }): CatalogCost | null {
    const match = this.resolve(input);
    if (!match) return null;
    const usageProvider = providerChain(input.provider, input.url)[0] ?? input.provider;
    const cost = costFromRates(match.price.rates, input.usage, usageProvider, input.model ?? input.requestModel ?? match.price.model);
    if (cost === null) return null;
    return { cost, priceId: match.price.id, source: match.price.source, match: match.match, effectiveFrom: match.price.effectiveFrom };
  }
}

function push(map: Map<string, CatalogPrice[]>, mapKey: string, price: CatalogPrice): void {
  const list = map.get(mapKey);
  if (list) list.push(price);
  else map.set(mapKey, [price]);
}

let current = new PriceCatalog([], new Date(0));

export function getPriceCatalog(): PriceCatalog {
  return current;
}

export function setPriceCatalog(catalog: PriceCatalog): void {
  current = catalog;
}
