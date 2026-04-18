/**
 * Budget rules: per-project, per-scope caps + alerts.
 *
 * A "rule" has an optional scope (model glob, function glob, or both) and
 * caps (daily/monthly USD, calls/tokens per minute). A call must satisfy
 * every matching rule — most-restrictive wins.
 *
 * Scope glob matching:
 *   scope_model: matches event.model via GLOB semantics
 *     (SQL: model LIKE translated-glob)
 *   scope_function: matches "<bl_file>:<bl_function>" via GLOB semantics
 *
 * NULL in either scope column means "match everything" on that axis. So a
 * rule with both NULLs is the classic project-wide rule.
 */

import type { Router, Request, Response } from "express";
import { Router as createRouter } from "express";
import type pg from "pg";
import { Resend } from "resend";
import { requireAuth } from "./auth.js";

// ─── SDK-facing router (auth key, no JWT) ─────────────────────────────

export function createSdkBudgetsRouter(pool: pg.Pool): Router {
  const router = createRouter();
  // GET /api/v1/sdk/budget/rules — called by SDK at init + on a poll
  router.get("/api/v1/sdk/budget/rules", async (req: Request, res: Response) => {
    try {
      const h = req.headers.authorization;
      if (!h?.startsWith("Bearer ")) {
        res.status(401).json({ error: "Missing or invalid authorization" });
        return;
      }
      const authKey = h.slice(7);
      const proj = await pool.query("SELECT id FROM projects WHERE auth_key = $1", [authKey]);
      if (proj.rows.length === 0) {
        res.status(401).json({ error: "Invalid auth key" });
        return;
      }
      const projectId = proj.rows[0].id;
      const r = await pool.query(
        `SELECT id, name, scope_model, scope_function,
                daily_usd, monthly_usd, calls_per_minute, tokens_per_minute,
                on_exceed, enabled
         FROM budget_rules
         WHERE project_id = $1 AND enabled = TRUE`,
        [projectId],
      );
      // Shape: camelCase for SDK ergonomics, coerce numeric strings.
      const rules = r.rows.map((x) => ({
        id: x.id,
        name: x.name,
        scopeModel: x.scope_model,
        scopeFunction: x.scope_function,
        dailyUsd: x.daily_usd != null ? Number(x.daily_usd) : null,
        monthlyUsd: x.monthly_usd != null ? Number(x.monthly_usd) : null,
        callsPerMinute: x.calls_per_minute,
        tokensPerMinute: x.tokens_per_minute,
        onExceed: x.on_exceed,
      }));
      // Very short cache + ETag-friendly headers. SDK polls every 5min.
      res.set("Cache-Control", "private, max-age=60");
      res.json({ rules, fetchedAt: new Date().toISOString() });
    } catch (err) {
      console.error("[costkey] GET sdk rules error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });
  return router;
}

const resend = new Resend(process.env["RESEND_API_KEY"]!);

function randomId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// ─── Glob → SQL LIKE translation ──────────────────────────────────────
// Supports `*` (zero+ chars) and `?` (exactly one char). Literal % and _
// in the input are escaped so they don't act as wildcards in LIKE.
function globToLike(glob: string): string {
  return glob
    .replace(/\\/g, "\\\\")
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_")
    .replace(/\*/g, "%")
    .replace(/\?/g, "_");
}

// ─── Validation ───────────────────────────────────────────────────────

const POLICIES = new Set(["throw", "warn", "block"]);

interface ParsedRule {
  name: string | null;
  scope_model: string | null;
  scope_function: string | null;
  daily_usd: number | null;
  monthly_usd: number | null;
  calls_per_minute: number | null;
  tokens_per_minute: number | null;
  on_exceed: string;
  alert_email: string | null;
  alert_webhook_url: string | null;
  alert_thresholds: number[];
  enabled: boolean;
}

function sanitizeRule(body: Record<string, unknown>): ParsedRule | { error: string } {
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
    return { error: "Caps must be non-negative numbers" };
  }
  if (daily == null && monthly == null && cpm == null && tpm == null) {
    return { error: "At least one cap (daily/monthly/calls/tokens) must be set" };
  }

  const onExceed = typeof body["onExceed"] === "string" ? body["onExceed"] : "warn";
  if (!POLICIES.has(onExceed)) return { error: `onExceed must be one of ${[...POLICIES].join(", ")}` };

  const thresholds = Array.isArray(body["alertThresholds"])
    ? body["alertThresholds"]
        .map((v) => Number(v))
        .filter((v) => Number.isFinite(v) && v > 0 && v <= 2)
        .sort((a, b) => a - b)
    : [0.5, 0.8, 1.0];
  if (thresholds.length === 0) return { error: "alertThresholds must include at least one value" };

  const str = (k: string, max = 200): string | null => {
    const v = body[k];
    if (typeof v !== "string") return null;
    const t = v.trim();
    if (t.length === 0) return null;
    if (t.length > max) return null;
    return t;
  };

  return {
    name: str("name", 80),
    scope_model: str("scopeModel"),
    scope_function: str("scopeFunction"),
    daily_usd: daily,
    monthly_usd: monthly,
    calls_per_minute: cpm != null ? Math.floor(cpm) : null,
    tokens_per_minute: tpm != null ? Math.floor(tpm) : null,
    on_exceed: onExceed,
    alert_email: str("alertEmail"),
    alert_webhook_url: str("alertWebhookUrl"),
    alert_thresholds: thresholds,
    enabled: body["enabled"] !== false,
  };
}

// ─── Spend query per rule ─────────────────────────────────────────────

async function getSpendForRule(
  pool: pg.Pool,
  projectId: string,
  scopeModel: string | null,
  scopeFunction: string | null,
): Promise<{ dailyUsd: number; monthlyUsd: number; callsLastMinute: number; tokensLastMinute: number }> {
  const wheres = ["project_id = $1"];
  const params: unknown[] = [projectId];
  let p = 1;

  if (scopeModel) {
    p++;
    params.push(globToLike(scopeModel));
    wheres.push(`model LIKE $${p} ESCAPE '\\'`);
  }
  if (scopeFunction) {
    p++;
    params.push(globToLike(scopeFunction));
    // Match against "bl_file:bl_function" OR just bl_function for convenience
    wheres.push(`(
      COALESCE(bl_file, '') || ':' || COALESCE(bl_function, '') LIKE $${p} ESCAPE '\\'
      OR COALESCE(bl_function, '') LIKE $${p} ESCAPE '\\'
    )`);
  }
  const whereSql = wheres.join(" AND ");

  const r = await pool.query(
    `SELECT
       COALESCE(SUM(CASE WHEN timestamp >= NOW() - INTERVAL '24 hours' THEN cost_usd END), 0)  AS daily_usd,
       COALESCE(SUM(CASE WHEN timestamp >= NOW() - INTERVAL '30 days'  THEN cost_usd END), 0)  AS monthly_usd,
       COALESCE(COUNT(*)          FILTER (WHERE timestamp >= NOW() - INTERVAL '1 minute'), 0) AS calls_last_minute,
       COALESCE(SUM(total_tokens) FILTER (WHERE timestamp >= NOW() - INTERVAL '1 minute'), 0) AS tokens_last_minute
     FROM events WHERE ${whereSql}`,
    params,
  );
  const row = r.rows[0] ?? {};
  return {
    dailyUsd: Number(row.daily_usd) || 0,
    monthlyUsd: Number(row.monthly_usd) || 0,
    callsLastMinute: Number(row.calls_last_minute) || 0,
    tokensLastMinute: Number(row.tokens_last_minute) || 0,
  };
}

function computeStatus(rule: BudgetRow, spend: Awaited<ReturnType<typeof getSpendForRule>>) {
  return {
    daily:   { spent: spend.dailyUsd,   limit: rule.daily_usd   != null ? Number(rule.daily_usd)   : null, pct: rule.daily_usd   ? spend.dailyUsd   / Number(rule.daily_usd)   : null },
    monthly: { spent: spend.monthlyUsd, limit: rule.monthly_usd != null ? Number(rule.monthly_usd) : null, pct: rule.monthly_usd ? spend.monthlyUsd / Number(rule.monthly_usd) : null },
    callsPerMinute:  { observed: spend.callsLastMinute,  limit: rule.calls_per_minute  ?? null },
    tokensPerMinute: { observed: spend.tokensLastMinute, limit: rule.tokens_per_minute ?? null },
  };
}

// ─── Dashboard routes ─────────────────────────────────────────────────

interface BudgetRow {
  id: string;
  project_id: string;
  name: string | null;
  scope_model: string | null;
  scope_function: string | null;
  daily_usd: number | null;
  monthly_usd: number | null;
  calls_per_minute: number | null;
  tokens_per_minute: number | null;
  on_exceed: string;
  alert_email: string | null;
  alert_webhook_url: string | null;
  alert_thresholds: number[];
  enabled: boolean;
}

export function createBudgetsRouter(pool: pg.Pool): Router {
  const router = createRouter();
  router.use(requireAuth);

  const ensureProjectInOrg = async (projectId: string, orgId: string): Promise<boolean> => {
    const r = await pool.query(`SELECT id FROM projects WHERE id = $1 AND org_id = $2`, [projectId, orgId]);
    return r.rows.length > 0;
  };

  const ensureRuleInOrg = async (ruleId: string, orgId: string): Promise<BudgetRow | null> => {
    const r = await pool.query(
      `SELECT br.* FROM budget_rules br
       JOIN projects p ON p.id = br.project_id
       WHERE br.id = $1 AND p.org_id = $2`,
      [ruleId, orgId],
    );
    return (r.rows[0] as BudgetRow | undefined) ?? null;
  };

  // List all rules for a project + live status per rule
  router.get("/api/v1/projects/:id/budget/rules", async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const id = req.params["id"] as string;
      if (!(await ensureProjectInOrg(id, user.orgId))) {
        res.status(404).json({ error: "Project not found" });
        return;
      }
      const r = await pool.query(
        `SELECT * FROM budget_rules WHERE project_id = $1 ORDER BY
           (scope_model IS NULL AND scope_function IS NULL) DESC,
           created_at ASC`,
        [id],
      );
      const rules = await Promise.all(r.rows.map(async (row: BudgetRow) => {
        const spend = await getSpendForRule(pool, row.project_id, row.scope_model, row.scope_function);
        return { ...row, status: computeStatus(row, spend) };
      }));
      res.json({ rules });
    } catch (err) {
      console.error("[costkey] GET rules error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Create a rule
  router.post("/api/v1/projects/:id/budget/rules", async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      if (user.role !== "owner" && user.role !== "admin") {
        res.status(403).json({ error: "Only owners and admins can create budget rules" });
        return;
      }
      const id = req.params["id"] as string;
      if (!(await ensureProjectInOrg(id, user.orgId))) {
        res.status(404).json({ error: "Project not found" });
        return;
      }
      const parsed = sanitizeRule(req.body ?? {});
      if ("error" in parsed) { res.status(400).json({ error: parsed.error }); return; }

      const ruleId = `rule_${randomId()}`;
      await pool.query(
        `INSERT INTO budget_rules (
           id, project_id, name, scope_model, scope_function,
           daily_usd, monthly_usd, calls_per_minute, tokens_per_minute,
           on_exceed, alert_email, alert_webhook_url, alert_thresholds, enabled
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          ruleId, id, parsed.name, parsed.scope_model, parsed.scope_function,
          parsed.daily_usd, parsed.monthly_usd, parsed.calls_per_minute, parsed.tokens_per_minute,
          parsed.on_exceed, parsed.alert_email, parsed.alert_webhook_url,
          parsed.alert_thresholds, parsed.enabled,
        ],
      );
      res.status(201).json({ id: ruleId });
    } catch (err) {
      console.error("[costkey] POST rule error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Update a rule
  router.put("/api/v1/projects/:id/budget/rules/:ruleId", async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      if (user.role !== "owner" && user.role !== "admin") {
        res.status(403).json({ error: "Only owners and admins can edit budget rules" });
        return;
      }
      const ruleId = req.params["ruleId"] as string;
      const existing = await ensureRuleInOrg(ruleId, user.orgId);
      if (!existing) { res.status(404).json({ error: "Rule not found" }); return; }

      const parsed = sanitizeRule(req.body ?? {});
      if ("error" in parsed) { res.status(400).json({ error: parsed.error }); return; }

      await pool.query(
        `UPDATE budget_rules SET
           name = $1, scope_model = $2, scope_function = $3,
           daily_usd = $4, monthly_usd = $5,
           calls_per_minute = $6, tokens_per_minute = $7,
           on_exceed = $8, alert_email = $9, alert_webhook_url = $10,
           alert_thresholds = $11, enabled = $12, updated_at = NOW()
         WHERE id = $13`,
        [
          parsed.name, parsed.scope_model, parsed.scope_function,
          parsed.daily_usd, parsed.monthly_usd,
          parsed.calls_per_minute, parsed.tokens_per_minute,
          parsed.on_exceed, parsed.alert_email, parsed.alert_webhook_url,
          parsed.alert_thresholds, parsed.enabled, ruleId,
        ],
      );
      res.json({ ok: true });
    } catch (err) {
      console.error("[costkey] PUT rule error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Delete a rule
  router.delete("/api/v1/projects/:id/budget/rules/:ruleId", async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      if (user.role !== "owner" && user.role !== "admin") {
        res.status(403).json({ error: "Only owners and admins can delete budget rules" });
        return;
      }
      const ruleId = req.params["ruleId"] as string;
      const existing = await ensureRuleInOrg(ruleId, user.orgId);
      if (!existing) { res.status(404).json({ error: "Rule not found" }); return; }
      await pool.query(`DELETE FROM budget_rules WHERE id = $1`, [ruleId]);
      res.json({ ok: true });
    } catch (err) {
      console.error("[costkey] DELETE rule error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Firing history (per-project — joined across all rules for that project)
  router.get("/api/v1/projects/:id/budget/firings", async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const id = req.params["id"] as string;
      if (!(await ensureProjectInOrg(id, user.orgId))) {
        res.status(404).json({ error: "Project not found" });
        return;
      }
      const r = await pool.query(
        `SELECT f.id, f.rule_id, f.scope, f.threshold, f.window_key, f.fired_at,
                f.spent_usd, f.limit_usd,
                r.name AS rule_name, r.scope_model, r.scope_function
         FROM budget_alert_firings f
         JOIN budget_rules r ON r.id = f.rule_id
         WHERE f.project_id = $1
         ORDER BY f.fired_at DESC
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

function describeScope(rule: BudgetRow): string {
  const bits: string[] = [];
  if (rule.scope_model)    bits.push(`model: ${rule.scope_model}`);
  if (rule.scope_function) bits.push(`function: ${rule.scope_function}`);
  if (bits.length === 0)   return "project-wide";
  return bits.join(" · ");
}

async function checkRule(pool: pg.Pool, rule: BudgetRow, projectName: string): Promise<void> {
  if (!rule.enabled) return;
  const spend = await getSpendForRule(pool, rule.project_id, rule.scope_model, rule.scope_function);

  const checks: Array<{ scope: "daily" | "monthly"; spent: number; limit: number }> = [];
  if (rule.daily_usd   && Number(rule.daily_usd)   > 0) checks.push({ scope: "daily",   spent: spend.dailyUsd,   limit: Number(rule.daily_usd) });
  if (rule.monthly_usd && Number(rule.monthly_usd) > 0) checks.push({ scope: "monthly", spent: spend.monthlyUsd, limit: Number(rule.monthly_usd) });

  for (const c of checks) {
    const pct = c.spent / c.limit;
    for (const threshold of rule.alert_thresholds) {
      if (pct < threshold) continue;
      const wk = windowKey(c.scope);
      const id = `bfire_${randomId()}`;
      const inserted = await pool.query(
        `INSERT INTO budget_alert_firings (id, rule_id, project_id, scope, threshold, window_key, spent_usd, limit_usd)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (rule_id, scope, threshold, window_key) DO NOTHING
         RETURNING id`,
        [id, rule.id, rule.project_id, c.scope, threshold, wk, c.spent, c.limit],
      );
      if (inserted.rows.length === 0) continue;

      const level = threshold >= 1.0 ? "critical" : threshold >= 0.8 ? "warn" : "info";
      const pctInt = Math.round(threshold * 100);
      const scopeDesc = describeScope(rule);
      const ruleLabel = rule.name ?? scopeDesc;
      const subject = `CostKey: ${projectName} [${ruleLabel}] at ${pctInt}% of ${c.scope} budget`;
      const body =
        `Project ${projectName}\nRule: ${ruleLabel} (${scopeDesc})\n\n` +
        `Spent $${c.spent.toFixed(2)} of $${c.limit.toFixed(2)} ${c.scope} budget (${Math.round(pct * 100)}%).\n` +
        `Threshold crossed: ${pctInt}%.\n\nDashboard: https://app.costkey.dev\n`;

      if (rule.alert_webhook_url) {
        try {
          await fetch(rule.alert_webhook_url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              text: subject + "\n" + body,
              level, scope: c.scope, threshold, pct, spent: c.spent, limit: c.limit,
              project: projectName, projectId: rule.project_id,
              ruleId: rule.id, ruleName: rule.name, ruleScope: scopeDesc,
            }),
          });
        } catch (err) { console.error(`[costkey] webhook alert failed for rule ${rule.id}:`, err); }
      }
      if (rule.alert_email) {
        try {
          await resend.emails.send({
            from: "CostKey Alerts <alerts@costkey.dev>",
            to: rule.alert_email,
            subject,
            text: body,
          });
        } catch (err) { console.error(`[costkey] email alert failed for rule ${rule.id}:`, err); }
      }
      console.log(`[costkey] budget alert: ${rule.project_id} [${ruleLabel}] ${c.scope} ${pctInt}% ($${c.spent.toFixed(2)}/$${c.limit.toFixed(2)})`);
    }
  }
}

export async function runBudgetChecks(pool: pg.Pool): Promise<void> {
  try {
    const r = await pool.query(
      `SELECT br.*, p.name AS project_name
       FROM budget_rules br
       JOIN projects p ON p.id = br.project_id
       WHERE br.enabled = TRUE`,
    );
    for (const row of r.rows) {
      await checkRule(pool, row, row.project_name);
    }
  } catch (err) {
    console.error("[costkey] budget checker error:", err);
  }
}

export function startBudgetChecker(pool: pg.Pool, intervalMs = 5 * 60 * 1000): NodeJS.Timeout {
  setTimeout(() => void runBudgetChecks(pool), 10_000);
  const timer = setInterval(() => void runBudgetChecks(pool), intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return timer;
}
