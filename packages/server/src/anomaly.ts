/**
 * Anomaly detection engine.
 *
 * Compares recent call site behavior against rolling baselines.
 * Detects cost spikes, token inflation, and latency degradation
 * at the per-function level — not just global thresholds.
 *
 * Algorithm:
 *   baseline = 7-day rolling average (per call site, per model)
 *   recent   = last 1 hour
 *   anomaly  = recent.avg > baseline.avg * multiplier
 *
 * Runs on a timer (every 5 minutes). Stores detected anomalies.
 * Fires webhooks for matching alert configs.
 */
import type pg from "pg";

export interface Anomaly {
  id: string;
  projectId: string;
  callSiteKey: string;
  functionName: string | null;
  fileName: string | null;
  model: string | null;
  type: "cost_spike" | "token_spike" | "latency_spike";
  baselineValue: number;
  currentValue: number;
  multiplier: number;
  detectedAt: string;
  resolved: boolean;
}

function randomId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// Ensure anomalies table exists
export async function initAnomalyTable(pool: pg.Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS anomalies (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      call_site_key TEXT,
      function_name TEXT,
      file_name TEXT,
      model TEXT,
      type TEXT NOT NULL,
      baseline_value DOUBLE PRECISION,
      current_value DOUBLE PRECISION,
      multiplier DOUBLE PRECISION,
      detected_at TIMESTAMPTZ DEFAULT NOW(),
      resolved BOOLEAN DEFAULT FALSE,
      resolved_at TIMESTAMPTZ,
      notified BOOLEAN DEFAULT FALSE
    );
    CREATE INDEX IF NOT EXISTS idx_anomalies_project ON anomalies(project_id, detected_at DESC);
  `);
}

/**
 * Run anomaly detection for all projects.
 * Called on a timer (every 5 minutes).
 */
export async function detectAnomalies(pool: pg.Pool): Promise<Anomaly[]> {
  const detected: Anomaly[] = [];

  try {
    // Get all active projects
    const projects = await pool.query("SELECT id FROM projects");

    for (const project of projects.rows) {
      const projectId = project.id;

      // Get 7-day baselines per call site
      const baselines = await pool.query(`
        SELECT
          call_site_key,
          function_name,
          file_name,
          model,
          AVG(cost_per_call) as baseline_cost,
          AVG(tokens_per_call) as baseline_tokens,
          AVG(avg_duration) as baseline_latency,
          SUM(call_count) as total_calls
        FROM (
          SELECT
            COALESCE(
              (SELECT cs.call_site_key FROM call_site_stats cs
               WHERE cs.project_id = e.project_id
               LIMIT 1), 'unknown'
            ) as call_site_key,
            call_site_raw,
            model,
            COUNT(*) as call_count,
            AVG(cost_usd) as cost_per_call,
            AVG(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)) as tokens_per_call,
            AVG(duration_ms) as avg_duration
          FROM events e
          WHERE project_id = $1
            AND timestamp >= NOW() - INTERVAL '7 days'
            AND timestamp < NOW() - INTERVAL '1 hour'
          GROUP BY call_site_raw, model, e.project_id
        ) baseline
        GROUP BY call_site_key, function_name, file_name, model
        HAVING SUM(call_count) >= 10
      `, [projectId]);

      // Skip projects with no baseline data
      if (baselines.rows.length === 0) continue;

      // For a simpler and more reliable approach, compare per-function baselines
      // Get 7-day baseline per function
      const fnBaselines = await pool.query(`
        SELECT
          function_name,
          file_name,
          AVG(cost_usd) as baseline_cost,
          AVG(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)) as baseline_tokens,
          AVG(duration_ms) as baseline_latency,
          COUNT(*) as total_calls
        FROM events e
        JOIN LATERAL (
          SELECT (call_site_frames->0->>'functionName') as fn,
                 (call_site_frames->0->>'fileName') as f
        ) parsed ON TRUE
        WHERE project_id = $1
          AND timestamp >= NOW() - INTERVAL '7 days'
          AND timestamp < NOW() - INTERVAL '1 hour'
          AND call_site_frames IS NOT NULL
        GROUP BY parsed.fn, parsed.f
        HAVING COUNT(*) >= 10
      `, [projectId]);

      // Get last-hour stats per function
      const recent = await pool.query(`
        SELECT
          (call_site_frames->0->>'functionName') as function_name,
          (call_site_frames->0->>'fileName') as file_name,
          AVG(cost_usd) as recent_cost,
          AVG(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)) as recent_tokens,
          AVG(duration_ms) as recent_latency,
          COUNT(*) as recent_calls
        FROM events
        WHERE project_id = $1
          AND timestamp >= NOW() - INTERVAL '1 hour'
          AND call_site_frames IS NOT NULL
        GROUP BY (call_site_frames->0->>'functionName'), (call_site_frames->0->>'fileName')
        HAVING COUNT(*) >= 3
      `, [projectId]);

      // Compare recent vs baseline
      for (const r of recent.rows) {
        const baseline = fnBaselines.rows.find(
          (b: any) => b.function_name === r.function_name && b.file_name === r.file_name
        );
        if (!baseline) continue;

        const checks: Array<{
          type: "cost_spike" | "token_spike" | "latency_spike";
          baselineVal: number;
          recentVal: number;
          threshold: number;
        }> = [
          { type: "cost_spike", baselineVal: parseFloat(baseline.baseline_cost), recentVal: parseFloat(r.recent_cost), threshold: 3 },
          { type: "token_spike", baselineVal: parseFloat(baseline.baseline_tokens), recentVal: parseFloat(r.recent_tokens), threshold: 2.5 },
          { type: "latency_spike", baselineVal: parseFloat(baseline.baseline_latency), recentVal: parseFloat(r.recent_latency), threshold: 3 },
        ];

        for (const check of checks) {
          if (check.baselineVal <= 0) continue;
          const multiplier = check.recentVal / check.baselineVal;

          if (multiplier >= check.threshold) {
            // Check if we already have an unresolved anomaly for this
            const existing = await pool.query(
              `SELECT id FROM anomalies
               WHERE project_id = $1 AND function_name = $2 AND type = $3 AND resolved = FALSE`,
              [projectId, r.function_name, check.type],
            );

            if (existing.rows.length > 0) continue; // Already tracked

            const anomaly: Anomaly = {
              id: `anom_${randomId()}`,
              projectId,
              callSiteKey: `${r.file_name}:${r.function_name}`,
              functionName: r.function_name,
              fileName: r.file_name,
              model: null,
              type: check.type,
              baselineValue: Math.round(check.baselineVal * 10000) / 10000,
              currentValue: Math.round(check.recentVal * 10000) / 10000,
              multiplier: Math.round(multiplier * 10) / 10,
              detectedAt: new Date().toISOString(),
              resolved: false,
            };

            await pool.query(
              `INSERT INTO anomalies (id, project_id, call_site_key, function_name, file_name, model, type, baseline_value, current_value, multiplier)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
              [anomaly.id, anomaly.projectId, anomaly.callSiteKey, anomaly.functionName, anomaly.fileName, anomaly.model, anomaly.type, anomaly.baselineValue, anomaly.currentValue, anomaly.multiplier],
            );

            detected.push(anomaly);
            console.log(`[costkey] Anomaly: ${anomaly.functionName}() ${anomaly.type} — ${anomaly.multiplier}x baseline (${anomaly.baselineValue} → ${anomaly.currentValue})`);
          }
        }
      }

      // Auto-resolve anomalies that are no longer active
      await pool.query(`
        UPDATE anomalies SET resolved = TRUE, resolved_at = NOW()
        WHERE project_id = $1
          AND resolved = FALSE
          AND detected_at < NOW() - INTERVAL '2 hours'
      `, [projectId]);
    }

    // Fire webhooks for new anomalies
    if (detected.length > 0) {
      await fireAnomalyWebhooks(pool, detected);
    }
  } catch (err) {
    console.error("[costkey] Anomaly detection error:", err);
  }

  return detected;
}

async function fireAnomalyWebhooks(pool: pg.Pool, anomalies: Anomaly[]): Promise<void> {
  // Group by project
  const byProject = new Map<string, Anomaly[]>();
  for (const a of anomalies) {
    const list = byProject.get(a.projectId) ?? [];
    list.push(a);
    byProject.set(a.projectId, list);
  }

  for (const [projectId, projectAnomalies] of byProject) {
    // Find alerts configured for this project with type "cost_spike"
    const alerts = await pool.query(
      `SELECT webhook_url FROM alerts
       WHERE (project_id = $1 OR project_id IS NULL)
         AND enabled = TRUE
         AND webhook_url IS NOT NULL
         AND type = 'cost_spike'`,
      [projectId],
    );

    // Also find org-level alerts
    const orgAlerts = await pool.query(
      `SELECT a.webhook_url FROM alerts a
       JOIN projects p ON p.org_id = a.org_id
       WHERE p.id = $1
         AND a.enabled = TRUE
         AND a.webhook_url IS NOT NULL
         AND a.project_id IS NULL`,
      [projectId],
    );

    const webhookUrls = new Set([
      ...alerts.rows.map((r: any) => r.webhook_url),
      ...orgAlerts.rows.map((r: any) => r.webhook_url),
    ]);

    for (const url of webhookUrls) {
      try {
        const typeLabels = { cost_spike: "Cost", token_spike: "Token", latency_spike: "Latency" };

        await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "anomaly_detected",
            anomalies: projectAnomalies.map((a) => ({
              function: `${a.functionName}()`,
              file: a.fileName,
              type: typeLabels[a.type] ?? a.type,
              baseline: a.baselineValue,
              current: a.currentValue,
              multiplier: `${a.multiplier}x`,
              detectedAt: a.detectedAt,
            })),
            summary: `${projectAnomalies.length} anomal${projectAnomalies.length === 1 ? "y" : "ies"} detected`,
            timestamp: new Date().toISOString(),
          }),
        });
      } catch (err) {
        console.error("[costkey] Anomaly webhook failed:", err);
      }
    }
  }
}

/**
 * API: Get anomalies for a project.
 */
export async function getAnomalies(pool: pg.Pool, projectId: string, includeResolved = false): Promise<Anomaly[]> {
  const result = await pool.query(
    `SELECT * FROM anomalies
     WHERE project_id = $1 ${includeResolved ? "" : "AND resolved = FALSE"}
     ORDER BY detected_at DESC
     LIMIT 50`,
    [projectId],
  );
  return result.rows;
}
