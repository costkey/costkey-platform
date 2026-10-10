import { Provider } from "../types.js";
import type { ProviderExtractor, NormalizedUsage, ExtractorCall } from "./types.js";
import { asCount, asRecord, succeeded, unitUsage } from "./units.js";

/** Search `type` values priced apart from a standard search. */
const SEARCH_TYPE_MODELS = new Map([
  ["instant", "search-instant"],
  ["deep", "search-deep"],
  ["deep-lite", "search-deep"],
  ["deep-reasoning", "search-deep-reasoning"],
]);

const DEFAULT_NUM_RESULTS = 10;

function operation(url: URL): string {
  const segments = url.pathname.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? "";
}

/**
 * Exa — api.exa.ai. Searches are priced per query and result count, contents
 * per page; every response also reports its exact `costDollars.total`.
 */
export const exaExtractor: ProviderExtractor = {
  provider: Provider.Exa,

  match(url: URL): boolean {
    return url.hostname === "api.exa.ai";
  },

  extractUsage(body: unknown, call?: ExtractorCall): NormalizedUsage | null {
    const response = asRecord(body);
    const costUsd = asCount(asRecord(response?.["costDollars"])?.["total"]);
    const units: Record<string, number> = {};
    if (succeeded(call)) {
      const op = operation(call.url);
      if (op === "search" || op === "findSimilar") {
        const requested = asCount(asRecord(call.requestBody)?.["numResults"]);
        units["searchQueries"] = 1;
        units["searchResults"] = requested != null && requested > 0 ? requested : DEFAULT_NUM_RESULTS;
      } else if (op === "contents" && Array.isArray(response?.["results"])) {
        units["pages"] = (response["results"] as unknown[]).length;
      }
    }
    return unitUsage(units, costUsd);
  },

  extractModel(requestBody: unknown, _responseBody: unknown, call?: ExtractorCall): string | null {
    if (!call) return null;
    const op = operation(call.url);
    if (op === "search") {
      const type = asRecord(requestBody)?.["type"];
      return (typeof type === "string" ? SEARCH_TYPE_MODELS.get(type) : undefined) ?? "search";
    }
    if (op === "findSimilar") return "find-similar";
    return op || null;
  },
};
