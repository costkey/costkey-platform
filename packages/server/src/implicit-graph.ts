/**
 * Implicit Call Graph — builds function-level scoring from accumulated event data.
 *
 * Instead of requiring users to upload call graph data, we derive it from
 * the stack traces we already collect at ingest time. For each function seen
 * in stack frames, we track:
 *
 *   - How often it appears (frequency)
 *   - Where it sits in the stack (avg position, normalized 0-1)
 *   - How many distinct call sites it appears with (diversity)
 *
 * Score formula (lower = more likely business logic):
 *
 *   score = (frequency_pct * 3) + (edge_penalty * 4) + (diversity_pct * 3)
 *
 *   - frequency_pct: percentile rank of how often this function appears.
 *     High frequency = utility/wrapper code, not unique business logic.
 *   - edge_penalty: how close to the edges of the stack (0.0 or 1.0) this
 *     function typically sits. Frames near position 0 are SDK wrappers,
 *     frames near the end are entry points (main, router). Business logic
 *     lives in the middle.
 *   - diversity_pct: percentile rank of how many unique call sites this
 *     function co-occurs with. High diversity = generic utility.
 *
 * The result is a graph compatible with findBusinessLogicFrameWithGraph().
 */

import type pg from "pg";

export interface ImplicitGraphEntry {
  score: number;
  fan_in: number;
  calls_ai: boolean;
}

/**
 * Upsert frame stats for all frames in a stack trace.
 * Called at ingest time for each event. Tracks per-function position
 * and frequency — the minimum data needed to compute scores.
 */
export async function updateFrameStats(
  client: pg.PoolClient,
  projectId: string,
  frames: Array<{ fileName: string | null; functionName: string | null; lineNumber: number | null }>,
  callSiteKey: string,
): Promise<void> {
  if (frames.length === 0) return;

  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const file = f.fileName ?? "";
    const fn = (f.functionName ?? "").split("\n")[0].trim();
    if (!file && !fn) continue;

    await client.query(
      `INSERT INTO frame_stats (project_id, file_name, function_name, total_seen, position_sum, stack_depth_sum, distinct_call_sites)
       VALUES ($1, $2, $3, 1, $4, $5, 1)
       ON CONFLICT (project_id, file_name, function_name) DO UPDATE SET
         total_seen = frame_stats.total_seen + 1,
         position_sum = frame_stats.position_sum + EXCLUDED.position_sum,
         stack_depth_sum = frame_stats.stack_depth_sum + EXCLUDED.stack_depth_sum`,
      [projectId, file, fn, i, frames.length],
    );
  }

  // Update distinct_call_sites count for each function in this trace.
  // We track this separately so the upsert above stays fast (no JSON merging).
  // Use a temp table pattern: count distinct call_site_keys per function across events.
  // For now, we approximate: increment distinct_call_sites if this call_site_key
  // hasn't been seen before for this function. We track this via a lightweight
  // frame_stats_callsites junction table.
  for (const f of frames) {
    const file = f.fileName ?? "";
    const fn = (f.functionName ?? "").split("\n")[0].trim();
    if (!file && !fn) continue;

    await client.query(
      `INSERT INTO frame_stats_callsites (project_id, file_name, function_name, call_site_key)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING`,
      [projectId, file, fn, callSiteKey],
    );
  }
}

/**
 * Build an implicit call graph for a project from accumulated frame_stats.
 * Returns a graph compatible with findBusinessLogicFrameWithGraph().
 */
export async function buildImplicitGraph(
  pool: pg.Pool,
  projectId: string,
): Promise<Record<string, ImplicitGraphEntry>> {
  const result = await pool.query<{
    file_name: string;
    function_name: string;
    total_seen: number;
    position_sum: number;
    stack_depth_sum: number;
    distinct_sites: string; // bigint comes as string
  }>(
    `SELECT fs.file_name, fs.function_name, fs.total_seen, fs.position_sum, fs.stack_depth_sum,
            COUNT(fsc.call_site_key)::text AS distinct_sites
     FROM frame_stats fs
     LEFT JOIN frame_stats_callsites fsc
       ON fs.project_id = fsc.project_id
       AND fs.file_name = fsc.file_name
       AND fs.function_name = fsc.function_name
     WHERE fs.project_id = $1
     GROUP BY fs.project_id, fs.file_name, fs.function_name, fs.total_seen, fs.position_sum, fs.stack_depth_sum`,
    [projectId],
  );

  if (result.rows.length === 0) return {};

  return computeScores(result.rows);
}

/**
 * Compute scores from raw frame stats. Exported for testing.
 */
export function computeScores(
  rows: Array<{
    file_name: string;
    function_name: string;
    total_seen: number;
    position_sum: number;
    stack_depth_sum: number;
    distinct_sites: string;
  }>,
): Record<string, ImplicitGraphEntry> {
  if (rows.length === 0) return {};

  const metrics = rows.map(row => {
    const avgPosition = row.total_seen > 0 ? row.position_sum / row.total_seen : 0;
    const avgDepth = row.total_seen > 0 ? row.stack_depth_sum / row.total_seen : 1;
    // Normalize position to 0-1 (0 = innermost/SDK, 1 = outermost/entry)
    const normalizedPos = avgDepth > 1 ? avgPosition / (avgDepth - 1) : 0.5;

    const key = row.function_name
      ? `${row.file_name}:${row.function_name}`
      : row.file_name;

    return {
      key,
      frequency: row.total_seen,
      normalizedPos,
      diversity: parseInt(row.distinct_sites) || 0,
    };
  });

  const n = metrics.length;

  // Compute percentile ranks (0-1) for frequency and diversity
  const byFreq = [...metrics].sort((a, b) => a.frequency - b.frequency);
  const byDiv = [...metrics].sort((a, b) => a.diversity - b.diversity);

  const freqRank = new Map<string, number>();
  const divRank = new Map<string, number>();
  const denom = n > 1 ? n - 1 : 1;
  for (let i = 0; i < n; i++) {
    freqRank.set(byFreq[i].key, i / denom);
    divRank.set(byDiv[i].key, i / denom);
  }

  const graph: Record<string, ImplicitGraphEntry> = {};

  for (const m of metrics) {
    const frequencyPct = freqRank.get(m.key) ?? 0;
    const diversityPct = divRank.get(m.key) ?? 0;

    // Edge penalty: 0.0 at the ideal position, 1.0 at edges (0.0 or 1.0).
    // Business logic typically sits ~60% up the stack (above SDK wrappers,
    // below entry points). Real stacks: [SDK, wrapper, service, FEATURE, main].
    // Position 3/5 = 0.6 normalized = ideal.
    const IDEAL_POSITION = 0.6;
    const edgePenalty = Math.abs(m.normalizedPos - IDEAL_POSITION) / Math.max(IDEAL_POSITION, 1 - IDEAL_POSITION);

    // Score: lower = more likely business logic
    // Weights: edge position (4), frequency (3), diversity (3) — out of 10
    const score = (frequencyPct * 3) + (edgePenalty * 4) + (diversityPct * 3);

    graph[m.key] = {
      score: Math.round(score * 100) / 100,
      fan_in: m.diversity,
      calls_ai: m.normalizedPos < 0.3,
    };
  }

  return graph;
}

// ─── In-memory cache ─────────────────────────────────────────────────

const implicitGraphCache = new Map<string, {
  graph: Record<string, ImplicitGraphEntry>;
  builtAt: number;
}>();

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Get the implicit graph for a project, building/caching as needed.
 * Returns null if no frame_stats data exists yet.
 */
export async function getImplicitGraph(
  pool: pg.Pool,
  projectId: string,
): Promise<Record<string, ImplicitGraphEntry> | null> {
  const cached = implicitGraphCache.get(projectId);
  if (cached && Date.now() - cached.builtAt < CACHE_TTL_MS) {
    return Object.keys(cached.graph).length > 0 ? cached.graph : null;
  }

  const graph = await buildImplicitGraph(pool, projectId);
  implicitGraphCache.set(projectId, { graph, builtAt: Date.now() });

  return Object.keys(graph).length > 0 ? graph : null;
}

/**
 * Invalidate the cached implicit graph for a project.
 * Called after ingest batches to force rebuild on next access.
 */
export function invalidateImplicitGraph(projectId: string): void {
  implicitGraphCache.delete(projectId);
}
