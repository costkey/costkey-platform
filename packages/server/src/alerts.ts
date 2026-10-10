import type { Router } from "express";
import { Router as createRouter } from "express";
import type pg from "pg";
import { requireAuth } from "./auth.js";
import {
  canAccessProject,
  normalizeRole,
  roleCanManageWorkspace,
} from "./permissions.js";
import { decryptSecret, dispatchWebhook, encryptSecret, isSafeWebhookUrl } from "./notifications.js";

function randomId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function createAlertsRouter(pool: pg.Pool): Router {
  const router = createRouter();
  router.use(requireAuth);

  // GET /api/v1/alerts — list alerts for org
  router.get("/api/v1/alerts", async (req, res) => {
    try {
      const user = (req as any).user;
      const result = await pool.query(
        `SELECT a.*, p.name as project_name
        FROM alerts a
        LEFT JOIN projects p ON p.id = a.project_id
        WHERE a.org_id = $1
          AND (a.project_id IS NULL OR $2 IN ('owner', 'admin') OR EXISTS (
            SELECT 1 FROM project_memberships pm
            WHERE pm.project_id = a.project_id AND pm.user_id = $3
          ))
        ORDER BY a.created_at DESC`,
        [user.orgId, normalizeRole(user.role), user.id],
      );
      res.json({ alerts: result.rows });
    } catch (err) {
      console.error("[costkey] API error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/v1/alerts — create alert
  router.post("/api/v1/alerts", async (req, res) => {
    try {
      const user = (req as any).user;
      if (!roleCanManageWorkspace(user.role)) {
        res.status(403).json({ error: "Only owners and admins can manage alerts" });
        return;
      }
      const { projectId, type, threshold, channel, webhookUrl } = req.body as {
        projectId?: string;
        type: string;
        threshold: number;
        channel?: string;
        webhookUrl?: string;
        webhookSecret?: string;
      };

      if (!type || threshold == null) {
        res.status(400).json({ error: "Missing type or threshold" });
        return;
      }
      if (typeof threshold !== "number" || !Number.isFinite(threshold) || threshold < 0) {
        res.status(400).json({ error: "threshold must be a non-negative number" });
        return;
      }
      if (channel && !["webhook", "email"].includes(channel)) {
        res.status(400).json({ error: "channel must be webhook or email" });
        return;
      }
      if (webhookUrl && !isSafeWebhookUrl(webhookUrl)) {
        res.status(400).json({ error: "Webhook URL is invalid or targets a private host" });
        return;
      }

      const validTypes = ["daily_cost", "hourly_cost", "cost_spike", "call_count"];
      if (!validTypes.includes(type)) {
        res.status(400).json({ error: `Invalid type. Valid: ${validTypes.join(", ")}` });
        return;
      }

      // If project-scoped, verify project belongs to org
      if (projectId) {
        const proj = await pool.query(
          "SELECT id FROM projects WHERE id = $1 AND org_id = $2",
          [projectId, user.orgId],
        );
        if (proj.rows.length === 0) {
          res.status(404).json({ error: "Project not found" });
          return;
        }
      }

      if (projectId && !await canAccessProject(pool, user, projectId)) {
        res.status(404).json({ error: "Project not found" });
        return;
      }

      const webhookSecret = typeof (req.body as Record<string, unknown>)?.webhookSecret === "string"
        ? (req.body as Record<string, unknown>).webhookSecret as string
        : "";
      if (webhookUrl && webhookSecret && webhookSecret.length < 16) {
        res.status(400).json({ error: "webhookSecret must be at least 16 characters" });
        return;
      }
      const encryptedSecret = webhookSecret ? encryptSecret(webhookSecret) : null;
      if (webhookSecret && !encryptedSecret) {
        res.status(503).json({ error: "Webhook secret storage is not configured" });
        return;
      }

      const id = `alert_${randomId()}`;
      await pool.query(
        `INSERT INTO alerts (id, org_id, project_id, type, threshold, channel, webhook_url, webhook_secret_ciphertext)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, user.orgId, projectId ?? null, type, threshold, channel ?? "webhook", webhookUrl ?? null, encryptedSecret],
      );

      res.status(201).json({ id, type, threshold, channel: channel ?? "webhook", webhookConfigured: Boolean(webhookUrl && encryptedSecret) });
    } catch (err) {
      console.error("[costkey] API error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // PATCH /api/v1/alerts/:alertId — update alert
  router.patch("/api/v1/alerts/:alertId", async (req, res) => {
    try {
      const user = (req as any).user;
      if (!roleCanManageWorkspace(user.role)) {
        res.status(403).json({ error: "Only owners and admins can manage alerts" });
        return;
      }
      const { alertId } = req.params;
      const { threshold, enabled, webhookUrl, webhookSecret } = req.body as {
        threshold?: number; enabled?: boolean; webhookUrl?: string; webhookSecret?: string;
      };

      const updates: string[] = [];
      const params: unknown[] = [];
      let idx = 1;

      if (threshold != null) { updates.push(`threshold = $${idx++}`); params.push(threshold); }
      if (enabled != null) { updates.push(`enabled = $${idx++}`); params.push(enabled); }
      if (webhookUrl != null) { updates.push(`webhook_url = $${idx++}`); params.push(webhookUrl); }
      if (webhookSecret != null) {
        if (webhookSecret.length < 16) { res.status(400).json({ error: "webhookSecret must be at least 16 characters" }); return; }
        const encryptedSecret = encryptSecret(webhookSecret);
        if (!encryptedSecret) { res.status(503).json({ error: "Webhook secret storage is not configured" }); return; }
        updates.push(`webhook_secret_ciphertext = $${idx++}`); params.push(encryptedSecret);
      }
      if (webhookUrl != null && !isSafeWebhookUrl(webhookUrl)) {
        res.status(400).json({ error: "Webhook URL is invalid or targets a private host" });
        return;
      }

      if (updates.length === 0) {
        res.status(400).json({ error: "Nothing to update" });
        return;
      }

      params.push(alertId, user.orgId);
      await pool.query(
        `UPDATE alerts SET ${updates.join(", ")} WHERE id = $${idx++} AND org_id = $${idx}`,
        params,
      );

      res.json({ ok: true });
    } catch (err) {
      console.error("[costkey] API error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // DELETE /api/v1/alerts/:alertId
  router.delete("/api/v1/alerts/:alertId", async (req, res) => {
    try {
      const user = (req as any).user;
      if (!roleCanManageWorkspace(user.role)) {
        res.status(403).json({ error: "Only owners and admins can manage alerts" });
        return;
      }
      await pool.query(
        "DELETE FROM alerts WHERE id = $1 AND org_id = $2",
        [req.params.alertId, user.orgId],
      );
      res.json({ ok: true });
    } catch (err) {
      console.error("[costkey] API error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/v1/alerts/history — recent alert triggers
  router.get("/api/v1/alerts/history", async (req, res) => {
    try {
      const user = (req as any).user;
      const result = await pool.query(
        `SELECT ah.*, a.type, a.threshold, p.name as project_name
        FROM alert_history ah
        JOIN alerts a ON a.id = ah.alert_id
        LEFT JOIN projects p ON p.id = a.project_id
        WHERE a.org_id = $1
          AND (a.project_id IS NULL OR $2 IN ('owner', 'admin') OR EXISTS (
            SELECT 1 FROM project_memberships pm WHERE pm.project_id = a.project_id AND pm.user_id = $3
          ))
        ORDER BY ah.triggered_at DESC
        LIMIT 50`,
        [user.orgId, normalizeRole(user.role), user.id],
      );
      res.json({ history: result.rows });
    } catch (err) {
      console.error("[costkey] API error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}

/**
 * Alert check engine — runs periodically to check thresholds.
 * Call this on a timer (e.g., every 5 minutes).
 */
export async function checkAlerts(pool: pg.Pool): Promise<void> {
  try {
    const alerts = await pool.query(
      "SELECT a.*, p.name as project_name FROM alerts a LEFT JOIN projects p ON p.id = a.project_id WHERE a.enabled = true",
    );

    for (const alert of alerts.rows) {
      let currentValue: number | null = null;

      if (alert.type === "daily_cost") {
        const result = await pool.query(
          `SELECT COALESCE(SUM(cost_usd), 0) as total
          FROM events
          WHERE project_id = COALESCE($1, project_id)
            AND timestamp >= NOW() - INTERVAL '24 hours'
            ${alert.project_id ? "" : "AND project_id IN (SELECT id FROM projects WHERE org_id = $2)"}`,
          alert.project_id ? [alert.project_id] : [alert.project_id, alert.org_id],
        );
        currentValue = parseFloat(result.rows[0].total);
      } else if (alert.type === "hourly_cost") {
        const result = await pool.query(
          `SELECT COALESCE(SUM(cost_usd), 0) as total
          FROM events
          WHERE project_id = COALESCE($1, project_id)
            AND timestamp >= NOW() - INTERVAL '1 hour'
            ${alert.project_id ? "" : "AND project_id IN (SELECT id FROM projects WHERE org_id = $2)"}`,
          alert.project_id ? [alert.project_id] : [alert.project_id, alert.org_id],
        );
        currentValue = parseFloat(result.rows[0].total);
      } else if (alert.type === "call_count") {
        const result = await pool.query(
          `SELECT COUNT(*)::int AS total
           FROM events
           WHERE project_id = COALESCE($1, project_id)
             AND timestamp >= NOW() - INTERVAL '24 hours'
             ${alert.project_id ? "" : "AND project_id IN (SELECT id FROM projects WHERE org_id = $2)"}`,
          alert.project_id ? [alert.project_id] : [alert.project_id, alert.org_id],
        );
        currentValue = Number(result.rows[0]?.total ?? 0);
      }

      if (currentValue != null && currentValue >= alert.threshold) {
        // Check if we already triggered recently (within 1 hour)
        const recent = await pool.query(
          "SELECT id FROM alert_history WHERE alert_id = $1 AND triggered_at >= NOW() - INTERVAL '1 hour'",
          [alert.id],
        );
        if (recent.rows.length > 0) continue; // Already triggered

        const histId = `ah_${randomId()}`;
        const message = `${alert.type} threshold exceeded: $${currentValue.toFixed(4)} >= $${alert.threshold} ${alert.project_name ? `(${alert.project_name})` : "(all projects)"}`;

        await pool.query(
          "INSERT INTO alert_history (id, alert_id, value, message) VALUES ($1, $2, $3, $4)",
          [histId, alert.id, currentValue, message],
        );

        // Deliver only a signed, metadata-only notification. A missing secret
        // or provider is recorded as suppressed; it is never reported as sent.
        if (alert.webhook_url) {
          const delivery = process.env["NODE_ENV"] !== "production"
            && process.env["COSTKEY_ALLOW_EXTERNAL_NOTIFICATIONS"] !== "true"
            && process.env["COSTKEY_NOTIFICATION_SINK"] !== "memory"
            ? { status: "suppressed" as const, error: "External notification delivery is disabled", deliveryId: histId }
            : await dispatchWebhook(
            alert.webhook_url,
            alert.webhook_secret_ciphertext ? decryptSecret(alert.webhook_secret_ciphertext) : null,
            {
              eventType: "policy_warning",
              alertType: alert.type,
              orgId: alert.org_id,
              projectId: alert.project_id,
              threshold: alert.threshold,
              currentValue,
              message,
              project: alert.project_name,
              triggeredAt: new Date().toISOString(),
            },
            histId,
          );
          if (delivery.status !== "sent") console.warn(`[costkey] Alert webhook ${delivery.status}: ${delivery.error ?? "not delivered"}`);
        }

        console.log(`[costkey] Alert triggered: ${message}`);
      }
    }
  } catch (err) {
    console.error("[costkey] Alert check error:", err);
  }
}
