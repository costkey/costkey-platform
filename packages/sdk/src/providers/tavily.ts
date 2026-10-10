import { Provider } from "../types.js";
import type { ProviderExtractor, NormalizedUsage, ExtractorCall } from "./types.js";
import { asCount, asRecord, succeeded, unitUsage } from "./units.js";

function operation(url: URL): string {
  const segments = url.pathname.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? "";
}

/**
 * Tavily — api.tavily.com. Searches are priced per query by depth; every
 * endpoint reports `usage.credits` when the request sets `include_usage`.
 */
export const tavilyExtractor: ProviderExtractor = {
  provider: Provider.Tavily,

  match(url: URL): boolean {
    return url.hostname === "api.tavily.com";
  },

  extractUsage(body: unknown, call?: ExtractorCall): NormalizedUsage | null {
    if (!succeeded(call)) return null;
    const units: Record<string, number> = {};
    if (operation(call.url) === "search") units["searchQueries"] = 1;
    const credits = asCount(asRecord(asRecord(body)?.["usage"])?.["credits"]);
    if (credits != null) units["credits"] = credits;
    return unitUsage(units);
  },

  extractModel(requestBody: unknown, _responseBody: unknown, call?: ExtractorCall): string | null {
    if (!call) return null;
    const op = operation(call.url);
    if (op === "search") {
      return asRecord(requestBody)?.["search_depth"] === "advanced" ? "search-advanced" : "search";
    }
    return op || null;
  },
};
