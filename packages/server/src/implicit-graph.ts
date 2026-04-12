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
 * Batch upsert frame stats for ALL events in an ingest batch.
 * Called once per batch (not per event) with 2 SQL queries total,
 * regardless of how many events or frames are in the batch.
 */
export async function updateFrameStatsBatch(
  client: pg.PoolClient,
  projectId: string,
  batch: Array<{
    frames: Array<{ fileName: string | null; functionName: string | null; lineNumber: number | null }>;
    callSiteKey: string;
  }>,
): Promise<void> {
  // Collect all frames across all events into parallel arrays
  const files: string[] = [];
  const fns: string[] = [];
  const positions: number[] = [];
  const depths: number[] = [];
  // For call site associations: file, fn, callSiteKey
  const csFiles: string[] = [];
  const csFns: string[] = [];
  const csKeys: string[] = [];

  for (const entry of batch) {
    const depth = entry.frames.length;
    for (let i = 0; i < entry.frames.length; i++) {
      const file = entry.frames[i].fileName ?? "";
      const fn = (entry.frames[i].functionName ?? "").split("\n")[0].trim();
      if (!file && !fn) continue;
      files.push(file);
      fns.push(fn);
      positions.push(i);
      depths.push(depth);
      csFiles.push(file);
      csFns.push(fn);
      csKeys.push(entry.callSiteKey);
    }
  }

  if (files.length === 0) return;

  // Query 1: batch upsert all frame stats using unnest
  // Groups duplicates within the batch so each (file, fn) gets correct totals
  await client.query(
    `INSERT INTO frame_stats (project_id, file_name, function_name, total_seen, position_sum, stack_depth_sum, distinct_call_sites)
     SELECT $1, f, n, COUNT(*)::int, SUM(p)::int, SUM(d)::int, 0
     FROM unnest($2::text[], $3::text[], $4::int[], $5::int[]) AS t(f, n, p, d)
     GROUP BY f, n
     ON CONFLICT (project_id, file_name, function_name) DO UPDATE SET
       total_seen = frame_stats.total_seen + EXCLUDED.total_seen,
       position_sum = frame_stats.position_sum + EXCLUDED.position_sum,
       stack_depth_sum = frame_stats.stack_depth_sum + EXCLUDED.stack_depth_sum`,
    [projectId, files, fns, positions, depths],
  );

  // Query 2: batch upsert call site associations
  await client.query(
    `INSERT INTO frame_stats_callsites (project_id, file_name, function_name, call_site_key)
     SELECT DISTINCT $1, f, n, k
     FROM unnest($2::text[], $3::text[], $4::text[]) AS t(f, n, k)
     ON CONFLICT DO NOTHING`,
    [projectId, csFiles, csFns, csKeys],
  );
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
 * Compute tied-rank percentiles: equal values get the same rank (the average
 * of their positions). Returns a Map from key to percentile (0-1).
 */
function tiedRankPercentile<T extends { key: string }>(
  items: T[],
  getValue: (item: T) => number,
): Map<string, number> {
  const sorted = [...items].sort((a, b) => getValue(a) - getValue(b));
  const n = sorted.length;
  const denom = n > 1 ? n - 1 : 1;
  const ranks = new Map<string, number>();

  let i = 0;
  while (i < n) {
    // Find the run of tied values
    let j = i;
    while (j < n && getValue(sorted[j]) === getValue(sorted[i])) j++;
    // Average rank for the tied group
    const avgRank = (i + j - 1) / 2;
    for (let k = i; k < j; k++) {
      ranks.set(sorted[k].key, avgRank / denom);
    }
    i = j;
  }

  return ranks;
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
    const rawPos = avgDepth > 1 ? avgPosition / (avgDepth - 1) : 0.5;
    const normalizedPos = Math.max(0, Math.min(1, rawPos));

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

  // Compute tied-rank percentiles: equal values get the same rank
  const freqRank = tiedRankPercentile(metrics, m => m.frequency);
  const divRank = tiedRankPercentile(metrics, m => m.diversity);

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
