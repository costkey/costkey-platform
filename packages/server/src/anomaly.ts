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
import { withMigrationLock } from "./db.js";

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
  await withMigrationLock(pool, (client) => client.query(`
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
    -- Repeat-detection tracking so the same anomaly UPDATES in place
    -- instead of inserting new rows every 5min (which is what caused the
    -- alert-list spam).
    ALTER TABLE anomalies ADD COLUMN IF NOT EXISTS first_detected_at TIMESTAMPTZ;
    ALTER TABLE anomalies ADD COLUMN IF NOT EXISTS occurrence_count INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE anomalies ADD COLUMN IF NOT EXISTS dismissed BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE anomalies ADD COLUMN IF NOT EXISTS dismissed_at TIMESTAMPTZ;
    -- Backfill first_detected_at for existing rows
    UPDATE anomalies SET first_detected_at = detected_at WHERE first_detected_at IS NULL;
  `));
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

      // Quick check: does the project have enough recent events for anomaly detection?
      const baselineCheck = await pool.query(`
        SELECT COUNT(*) as cnt FROM events
        WHERE project_id = $1
          AND timestamp >= NOW() - INTERVAL '7 days'
          AND timestamp < NOW() - INTERVAL '1 hour'
      `, [projectId]);

      // Skip projects with no baseline data
      if (parseInt(baselineCheck.rows[0].cnt) < 10) continue;

      // Use the already-computed bl_function/bl_file (set at ingest via
      // findBusinessLogicFrameWithGraph + filterCtx). Reading those is
      // infinitely more accurate than re-parsing raw frame[0] which is
      // typically an SDK wrapper. Also skip NULL attributions — lumping
      // them produces meaningless baselines and duplicate alerts because
      // SQL's NULL-equality isn't reflexive.
      const fnBaselines = await pool.query(`
        SELECT
          bl_function as function_name,
          bl_file as file_name,
          AVG(cost_usd) as baseline_cost,
          AVG(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)) as baseline_tokens,
          AVG(duration_ms) as baseline_latency,
          COUNT(*) as total_calls
        FROM events
        WHERE project_id = $1
          AND timestamp >= NOW() - INTERVAL '7 days'
          AND timestamp < NOW() - INTERVAL '1 hour'
          AND bl_function IS NOT NULL
          AND bl_function <> ''
        GROUP BY bl_function, bl_file
        HAVING COUNT(*) >= 10
      `, [projectId]);

      // Get last-hour stats per function (same filter: bl_function required)
      const recent = await pool.query(`
        SELECT
          bl_function as function_name,
          bl_file as file_name,
          AVG(cost_usd) as recent_cost,
          AVG(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)) as recent_tokens,
          AVG(duration_ms) as recent_latency,
          COUNT(*) as recent_calls
        FROM events
        WHERE project_id = $1
          AND timestamp >= NOW() - INTERVAL '1 hour'
          AND bl_function IS NOT NULL
          AND bl_function <> ''
        GROUP BY bl_function, bl_file
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
            const baselineRounded = Math.round(check.baselineVal * 10000) / 10000;
            const currentRounded = Math.round(check.recentVal * 10000) / 10000;
            const multiplierRounded = Math.round(multiplier * 10) / 10;

            // Upsert: one row per (project, fn, file, type) while unresolved.
            // Re-detection updates current_value / multiplier / last_detected_at
            // and bumps occurrence_count instead of inserting duplicates. Also
            // un-dismisses if the user previously dismissed but the anomaly
            // is actively new-multiplier-higher (e.g. got worse).
            const existing = await pool.query(
              `SELECT id, dismissed, multiplier FROM anomalies
               WHERE project_id = $1
                 AND function_name = $2
                 AND file_name IS NOT DISTINCT FROM $3
                 AND type = $4
                 AND resolved = FALSE`,
              [projectId, r.function_name, r.file_name, check.type],
            );

            if (existing.rows.length > 0) {
              const row = existing.rows[0];
              // If the user dismissed AND the multiplier hasn't materially
              // increased, keep it dismissed — don't nag.
              const prevMult = parseFloat(row.multiplier);
              const materiallyWorse = multiplierRounded > prevMult * 1.25; // 25% worse
              const shouldUnDismiss = row.dismissed && materiallyWorse;

              await pool.query(
                `UPDATE anomalies
                 SET current_value = $1,
                     multiplier = $2,
                     detected_at = NOW(),
                     occurrence_count = occurrence_count + 1,
                     dismissed = CASE WHEN $3 THEN FALSE ELSE dismissed END,
                     dismissed_at = CASE WHEN $3 THEN NULL ELSE dismissed_at END
                 WHERE id = $4`,
                [currentRounded, multiplierRounded, shouldUnDismiss, row.id],
              );
              continue; // Not a new detection — don't webhook-spam
            }

            const anomaly: Anomaly = {
              id: `anom_${randomId()}`,
              projectId,
              callSiteKey: `${r.file_name}:${r.function_name}`,
              functionName: r.function_name,
              fileName: r.file_name,
              model: null,
              type: check.type,
              baselineValue: baselineRounded,
              currentValue: currentRounded,
              multiplier: multiplierRounded,
              detectedAt: new Date().toISOString(),
              resolved: false,
            };

            await pool.query(
              `INSERT INTO anomalies (
                 id, project_id, call_site_key, function_name, file_name, model,
                 type, baseline_value, current_value, multiplier,
                 first_detected_at, occurrence_count
               ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), 1)`,
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
 * API: Get anomalies for a project. Dismissed anomalies are hidden by default
 * so a user's "X" click in the banner actually persists across page loads.
 */
export async function getAnomalies(
  pool: pg.Pool,
  projectId: string,
  includeResolved = false,
  includeDismissed = false,
): Promise<Anomaly[]> {
  const conditions = ["project_id = $1"];
  if (!includeResolved) conditions.push("resolved = FALSE");
  if (!includeDismissed) conditions.push("dismissed = FALSE");
  const result = await pool.query(
    `SELECT * FROM anomalies
     WHERE ${conditions.join(" AND ")}
     ORDER BY detected_at DESC
     LIMIT 50`,
    [projectId],
  );
  return result.rows;
}

/**
 * Mark an anomaly as user-dismissed. Stays dismissed until either:
 *   (a) the anomaly auto-resolves (falls out of detection), or
 *   (b) the multiplier gets materially worse (>25% higher than when dismissed).
 */
export async function dismissAnomaly(
  pool: pg.Pool,
  projectId: string,
  anomalyId: string,
): Promise<boolean> {
  const r = await pool.query(
    `UPDATE anomalies SET dismissed = TRUE, dismissed_at = NOW()
     WHERE id = $1 AND project_id = $2
     RETURNING id`,
    [anomalyId, projectId],
  );
  return r.rows.length > 0;
}
