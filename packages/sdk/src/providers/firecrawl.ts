import { Provider } from "../types.js";
import type { ProviderExtractor, NormalizedUsage, ExtractorCall } from "./types.js";
import { asCount, asRecord, succeeded, unitUsage } from "./units.js";

const DEFAULT_SEARCH_LIMIT = 5;

/**
 * The endpoint after the version segment: /v2/scrape → scrape,
 * /v2/batch/scrape → batch-scrape. Anything after it (a job id) marks a
 * status request for an async job.
 */
function endpoint(url: URL): { model: string | null; job: boolean } {
  const segments = url.pathname.split("/").filter(Boolean);
  const version = segments.findIndex((segment) => /^v\d+$/.test(segment));
  const rest = version >= 0 ? segments.slice(version + 1) : segments;
  if (rest.length === 0) return { model: null, job: false };
  const width = rest[0] === "batch" && rest.length > 1 ? 2 : 1;
  return { model: rest.slice(0, width).join("-"), job: rest.length > width };
}

/**
 * Firecrawl — api.firecrawl.dev. Bills credits, reported as `creditsUsed`
 * (top level, or on the scraped document's metadata).
 */
export const firecrawlExtractor: ProviderExtractor = {
  provider: Provider.Firecrawl,

  match(url: URL): boolean {
    return url.hostname === "api.firecrawl.dev";
  },

  extractUsage(body: unknown, call?: ExtractorCall): NormalizedUsage | null {
    if (!succeeded(call)) return null;
    const response = asRecord(body);
    if (response?.["success"] === false) return null;
    const { model, job } = endpoint(call.url);
    const data = asRecord(response?.["data"]);
    const reported =
      asCount(response?.["creditsUsed"]) ??
      asCount(asRecord(data?.["metadata"])?.["creditsUsed"]) ??
      asCount(data?.["creditsUsed"]);

    const units: Record<string, number> = {};
    if (job) {
      // Crawl, batch-scrape and extract status polls report the job's running
      // total. Count it once: on the completed status, not on later pages.
      if (reported != null && response?.["status"] === "completed" && !call.url.searchParams.has("skip")) {
        units["credits"] = reported;
      }
    } else {
      const credits = reported ?? (model === "scrape" || model === "map" ? 1 : null);
      if (credits != null) units["credits"] = credits;
      if (model === "search") {
        const limit = asCount(asRecord(call.requestBody)?.["limit"]);
        units["searchQueries"] = 1;
        units["searchResults"] = limit != null && limit > 0 ? limit : DEFAULT_SEARCH_LIMIT;
      }
    }
    return unitUsage(units);
  },

  extractModel(_requestBody: unknown, _responseBody: unknown, call?: ExtractorCall): string | null {
    return call ? endpoint(call.url).model : null;
  },
};
