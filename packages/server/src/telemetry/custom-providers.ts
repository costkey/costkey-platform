import type pg from "pg";
import type { ServerExtractor } from "./types.js";
import { asObject, nonEmpty, num, readPath, str } from "./skeleton.js";

/**
 * Custom provider extractors are server config (the custom_providers table):
 * a hostname plus JSON paths to the input/output token counts and the model.
 * They apply after every built-in, so a configured host can't take over a
 * known provider.
 */
export interface CustomProviderConfig {
  id: string;
  name: string | null;
  hostname: string;
  usageInputPath: string | null;
  usageOutputPath: string | null;
  modelPath: string | null;
}

export function customExtractor(config: CustomProviderConfig): ServerExtractor | null {
  const hostname = config.hostname.trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0] ?? "";
  if (!hostname) return null;
  return {
    provider: nonEmpty(config.name) ?? hostname,
    match(url) {
      if (hostname.startsWith("*.")) return url.hostname.endsWith(hostname.slice(1));
      return url.hostname === hostname || url.host === hostname;
    },
    extractUsage(body) {
      const inputTokens = num(readPath(body, config.usageInputPath));
      const outputTokens = num(readPath(body, config.usageOutputPath));
      if (inputTokens == null && outputTokens == null) return null;
      return {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens != null && outputTokens != null ? inputTokens + outputTokens : null,
        reasoningTokens: null,
        cacheReadTokens: null,
        cacheCreationTokens: null,
      };
    },
    extractModel(requestBody, responseBody) {
      // Only an allowlisted string survives the skeleton (a path ending in `model`).
      return nonEmpty(readPath(responseBody, config.modelPath))
        ?? nonEmpty(readPath(requestBody, config.modelPath))
        ?? str(asObject(responseBody)?.["model"])
        ?? str(asObject(requestBody)?.["model"]);
    },
  };
}

const TTL_MS = 30_000;
const cache = new Map<string, { loadedAt: number; extractors: ServerExtractor[] }>();

/** A project's enabled custom provider extractors, cached briefly. */
export async function projectCustomExtractors(pool: pg.Pool | pg.PoolClient, projectId: string): Promise<ServerExtractor[]> {
  const cached = cache.get(projectId);
  if (cached && Date.now() - cached.loadedAt < TTL_MS) return cached.extractors;
  const result = await pool.query(
    `SELECT id, name, hostname, usage_input_path, usage_output_path, model_path
     FROM custom_providers WHERE project_id = $1 AND enabled = TRUE
     ORDER BY created_at ASC`,
    [projectId],
  ).catch((error: { code?: string }) => {
    if (error.code === "42P01") return { rows: [] as Array<Record<string, unknown>> };
    throw error;
  });
  const extractors = (result.rows as Array<Record<string, unknown>>)
    .map((row) => customExtractor({
      id: String(row.id),
      name: row.name == null ? null : String(row.name),
      hostname: String(row.hostname ?? ""),
      usageInputPath: row.usage_input_path == null ? null : String(row.usage_input_path),
      usageOutputPath: row.usage_output_path == null ? null : String(row.usage_output_path),
      modelPath: row.model_path == null ? null : String(row.model_path),
    }))
    .filter((extractor): extractor is ServerExtractor => extractor !== null);
  cache.set(projectId, { loadedAt: Date.now(), extractors });
  return extractors;
}

/** Drop a project's cached custom providers after one changes. */
export function invalidateCustomExtractors(projectId: string): void {
  cache.delete(projectId);
}
