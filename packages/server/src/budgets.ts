/**
 * Per-project budgets and rate limits.
 *
 * - Stores config in project_budgets (one row per project).
 * - Exposes GET/PUT for dashboard config + GET /status for live spend bar.
 * - Runs a background checker every 5min that computes current spend per
 *   project, compares against thresholds, fires webhook + email alerts,
 *   deduped via budget_alert_firings so we don't spam.
 */

import type { Router, Request, Response } from "express";
import { Router as createRouter } from "express";
import type pg from "pg";
import { Resend } from "resend";
import { requireAuth } from "./auth.js";

const resend = new Resend(process.env["RESEND_API_KEY"]!);

function randomId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// ─── Validation ───────────────────────────────────────────────────────

const POLICIES = new Set(["throw", "warn", "block"]);

function sanitizeBudget(body: Record<string, unknown>): {
  daily_usd: number | null;
  monthly_usd: number | null;
  calls_per_minute: number | null;
  tokens_per_minute: number | null;
  on_exceed: string;
  alert_email: string | null;
  alert_webhook_url: string | null;
  alert_thresholds: number[];
  enabled: boolean;
} | { error: string } {
  const num = (k: string): number | null => {
    const v = body[k];
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return NaN as unknown as number;
    return n;
  };
  const daily = num("dailyUsd");
  const monthly = num("monthlyUsd");
  const cpm = num("callsPerMinute");
  const tpm = num("tokensPerMinute");
  if ([daily, monthly, cpm, tpm].some((v) => Number.isNaN(v))) {
    return { error: "Budget caps must be non-negative numbers" };
  }

  const onExceed = typeof body["onExceed"] === "string" ? body["onExceed"] : "warn";
  if (!POLICIES.has(onExceed)) return { error: `onExceed must be one of ${[...POLICIES].join(", ")}` };

  const thresholds = Array.isArray(body["alertThresholds"])
    ? body["alertThresholds"]
        .map((v) => Number(v))
        .filter((v) => Number.isFinite(v) && v > 0 && v <= 2)
        .sort((a, b) => a - b)
    : [0.5, 0.8, 1.0];
  if (thresholds.length === 0) return { error: "alertThresholds must include at least one value between 0 and 2" };

  const email = typeof body["alertEmail"] === "string" ? body["alertEmail"].trim() : "";
  const webhook = typeof body["alertWebhookUrl"] === "string" ? body["alertWebhookUrl"].trim() : "";

  return {
    daily_usd: daily,
    monthly_usd: monthly,
    calls_per_minute: cpm != null ? Math.floor(cpm) : null,
    tokens_per_minute: tpm != null ? Math.floor(tpm) : null,
    on_exceed: onExceed,
    alert_email: email || null,
    alert_webhook_url: webhook || null,
    alert_thresholds: thresholds,
    enabled: body["enabled"] !== false,
  };
}

// ─── Live-spend query (used by /status AND the checker) ───────────────

async function getSpend(pool: pg.Pool, projectId: string): Promise<{
  dailyUsd: number;
  monthlyUsd: number;
  callsLastMinute: number;
  tokensLastMinute: number;
}> {
  const r = await pool.query(
    `SELECT
       COALESCE(SUM(CASE WHEN timestamp >= NOW() - INTERVAL '24 hours' THEN cost_usd END), 0)  AS daily_usd,
       COALESCE(SUM(CASE WHEN timestamp >= NOW() - INTERVAL '30 days'  THEN cost_usd END), 0)  AS monthly_usd,
       COALESCE(COUNT(*)       FILTER (WHERE timestamp >= NOW() - INTERVAL '1 minute'), 0)      AS calls_last_minute,
       COALESCE(SUM(total_tokens) FILTER (WHERE timestamp >= NOW() - INTERVAL '1 minute'), 0)    AS tokens_last_minute
     FROM events WHERE project_id = $1`,
    [projectId],
  );
  const row = r.rows[0] ?? {};
  return {
    dailyUsd: Number(row.daily_usd) || 0,
    monthlyUsd: Number(row.monthly_usd) || 0,
    callsLastMinute: Number(row.calls_last_minute) || 0,
    tokensLastMinute: Number(row.tokens_last_minute) || 0,
  };
}

// ─── Dashboard + SDK routes ───────────────────────────────────────────

export function createBudgetsRouter(pool: pg.Pool): Router {
  const router = createRouter();
  router.use(requireAuth);

  const ensureProjectInOrg = async (projectId: string, orgId: string): Promise<boolean> => {
    const r = await pool.query(`SELECT id FROM projects WHERE id = $1 AND org_id = $2`, [projectId, orgId]);
    return r.rows.length > 0;
  };

  // GET /api/v1/projects/:id/budget — config + computed status
  router.get("/api/v1/projects/:id/budget", async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const id = req.params["id"] as string;
      if (!(await ensureProjectInOrg(id, user.orgId))) {
        res.status(404).json({ error: "Project not found" });
        return;
      }
      const cfgR = await pool.query(`SELECT * FROM project_budgets WHERE project_id = $1`, [id]);
      const cfg = cfgR.rows[0] ?? null;
      const spend = await getSpend(pool, id);
      res.json({
        config: cfg,
        status: {
          daily:   { spent: spend.dailyUsd,   limit: cfg?.daily_usd   ?? null, pct: cfg?.daily_usd   ? spend.dailyUsd   / Number(cfg.daily_usd)   : null },
          monthly: { spent: spend.monthlyUsd, limit: cfg?.monthly_usd ?? null, pct: cfg?.monthly_usd ? spend.monthlyUsd / Number(cfg.monthly_usd) : null },
          callsPerMinute:  { observed: spend.callsLastMinute,  limit: cfg?.calls_per_minute  ?? null },
          tokensPerMinute: { observed: spend.tokensLastMinute, limit: cfg?.tokens_per_minute ?? null },
        },
      });
    } catch (err) {
      console.error("[costkey] GET budget error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // PUT /api/v1/projects/:id/budget — upsert config (owner/admin)
  router.put("/api/v1/projects/:id/budget", async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      if (user.role !== "owner" && user.role !== "admin") {
        res.status(403).json({ error: "Only owners and admins can edit budgets" });
        return;
      }
      const id = req.params["id"] as string;
      if (!(await ensureProjectInOrg(id, user.orgId))) {
        res.status(404).json({ error: "Project not found" });
        return;
      }
      const parsed = sanitizeBudget(req.body ?? {});
      if ("error" in parsed) {
        res.status(400).json({ error: parsed.error });
        return;
      }
      await pool.query(
        `INSERT INTO project_budgets (
           project_id, daily_usd, monthly_usd, calls_per_minute, tokens_per_minute,
           on_exceed, alert_email, alert_webhook_url, alert_thresholds, enabled, updated_at
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
         ON CONFLICT (project_id) DO UPDATE SET
           daily_usd = EXCLUDED.daily_usd,
           monthly_usd = EXCLUDED.monthly_usd,
           calls_per_minute = EXCLUDED.calls_per_minute,
           tokens_per_minute = EXCLUDED.tokens_per_minute,
           on_exceed = EXCLUDED.on_exceed,
           alert_email = EXCLUDED.alert_email,
           alert_webhook_url = EXCLUDED.alert_webhook_url,
           alert_thresholds = EXCLUDED.alert_thresholds,
           enabled = EXCLUDED.enabled,
           updated_at = NOW()`,
        [
          id, parsed.daily_usd, parsed.monthly_usd,
          parsed.calls_per_minute, parsed.tokens_per_minute,
          parsed.on_exceed, parsed.alert_email, parsed.alert_webhook_url,
          parsed.alert_thresholds, parsed.enabled,
        ],
      );
      res.json({ ok: true });
    } catch (err) {
      console.error("[costkey] PUT budget error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // DELETE /api/v1/projects/:id/budget — remove config entirely
  router.delete("/api/v1/projects/:id/budget", async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      if (user.role !== "owner" && user.role !== "admin") {
        res.status(403).json({ error: "Only owners and admins can delete budgets" });
        return;
      }
      const id = req.params["id"] as string;
      if (!(await ensureProjectInOrg(id, user.orgId))) {
        res.status(404).json({ error: "Project not found" });
        return;
      }
      await pool.query(`DELETE FROM project_budgets WHERE project_id = $1`, [id]);
      res.json({ ok: true });
    } catch (err) {
      console.error("[costkey] DELETE budget error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/v1/projects/:id/budget/firings — alert history
  router.get("/api/v1/projects/:id/budget/firings", async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const id = req.params["id"] as string;
      if (!(await ensureProjectInOrg(id, user.orgId))) {
        res.status(404).json({ error: "Project not found" });
        return;
      }
      const r = await pool.query(
        `SELECT id, scope, threshold, window_key, fired_at, spent_usd, limit_usd
         FROM budget_alert_firings
         WHERE project_id = $1
         ORDER BY fired_at DESC
         LIMIT 50`,
        [id],
      );
      res.json({ firings: r.rows });
    } catch (err) {
      console.error("[costkey] GET firings error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}

// ─── Background checker ───────────────────────────────────────────────

function windowKey(scope: "daily" | "monthly"): string {
  const d = new Date();
  return scope === "daily"
    ? `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`
    : `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

interface BudgetRow {
  project_id: string;
  daily_usd: number | null;
  monthly_usd: number | null;
  alert_email: string | null;
  alert_webhook_url: string | null;
  alert_thresholds: number[];
  enabled: boolean;
}

async function checkProject(pool: pg.Pool, b: BudgetRow, projectName: string): Promise<void> {
  if (!b.enabled) return;
  const spend = await getSpend(pool, b.project_id);

  const checks: Array<{
    scope: "daily" | "monthly";
    spent: number;
    limit: number;
  }> = [];
  if (b.daily_usd && b.daily_usd > 0)   checks.push({ scope: "daily",   spent: spend.dailyUsd,   limit: Number(b.daily_usd) });
  if (b.monthly_usd && b.monthly_usd > 0) checks.push({ scope: "monthly", spent: spend.monthlyUsd, limit: Number(b.monthly_usd) });

  for (const c of checks) {
    const pct = c.spent / c.limit;
    // Walk thresholds ascending; we may cross several between checks.
    for (const threshold of b.alert_thresholds) {
      if (pct < threshold) continue;
      const wk = windowKey(c.scope);
      const id = `bfire_${randomId()}`;
      const inserted = await pool.query(
        `INSERT INTO budget_alert_firings (id, project_id, scope, threshold, window_key, spent_usd, limit_usd)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (project_id, scope, threshold, window_key) DO NOTHING
         RETURNING id`,
        [id, b.project_id, c.scope, threshold, wk, c.spent, c.limit],
      );
      if (inserted.rows.length === 0) continue; // already fired this window

      // Fire notifications
      const level = threshold >= 1.0 ? "critical" : threshold >= 0.8 ? "warn" : "info";
      const pctInt = Math.round(threshold * 100);
      const subject = `CostKey: ${projectName} at ${pctInt}% of ${c.scope} budget`;
      const body =
        `Project ${projectName} has spent $${c.spent.toFixed(2)} of its $${c.limit.toFixed(2)} ${c.scope} budget (${Math.round(pct * 100)}%).\n\n` +
        `Threshold crossed: ${pctInt}%. Dashboard: https://app.costkey.dev\n`;

      if (b.alert_webhook_url) {
        try {
          await fetch(b.alert_webhook_url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              text: subject + "\n" + body,
              level, scope: c.scope, threshold, pct, spent: c.spent, limit: c.limit,
              project: projectName, projectId: b.project_id,
            }),
          });
        } catch (err) {
          console.error(`[costkey] webhook alert failed for ${b.project_id}:`, err);
        }
      }
      if (b.alert_email) {
        try {
          await resend.emails.send({
            from: "CostKey Alerts <alerts@costkey.dev>",
            to: b.alert_email,
            subject,
            text: body,
          });
        } catch (err) {
          console.error(`[costkey] email alert failed for ${b.project_id}:`, err);
        }
      }
      console.log(`[costkey] budget alert fired: ${b.project_id} ${c.scope} ${pctInt}% ($${c.spent.toFixed(2)}/$${c.limit.toFixed(2)})`);
    }
  }
}

/** Runs the threshold check for every project with a budget. */
export async function runBudgetChecks(pool: pg.Pool): Promise<void> {
  try {
    const r = await pool.query(
      `SELECT b.*, p.name AS project_name
       FROM project_budgets b
       JOIN projects p ON p.id = b.project_id
       WHERE b.enabled = TRUE`,
    );
    for (const row of r.rows) {
      await checkProject(pool, row, row.project_name);
    }
  } catch (err) {
    console.error("[costkey] budget checker error:", err);
  }
}

/** Start the recurring checker. Safe to call once at server boot. */
export function startBudgetChecker(pool: pg.Pool, intervalMs = 5 * 60 * 1000): NodeJS.Timeout {
  // Kick off one immediate check (~10s after boot) so admins don't wait 5min
  setTimeout(() => void runBudgetChecks(pool), 10_000);
  const timer = setInterval(() => void runBudgetChecks(pool), intervalMs);
  // Don't keep the event loop alive just for this
  if (typeof timer.unref === "function") timer.unref();
  return timer;
}
