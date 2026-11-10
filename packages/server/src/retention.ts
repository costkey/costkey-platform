import type { Request, Response, Router } from "express";
import { Router as createRouter } from "express";
import type pg from "pg";
import { requireAuth } from "./auth.js";
import { roleCanManageWorkspace } from "./permissions.js";
import { purgeExpiredFrames } from "./frames.js";

export interface RetentionResult {
  runId: string;
  redactedBodies: number;
  deletedEvents: number;
  deletedAggregates: number;
  deletedUsageComponents: number;
  deletedTraces: number;
  deletedExecutions: number;
  /** Screen capture frames older than body retention. */
  deletedFrames?: number;
  blockedProjects?: string[];
  completedAt: string;
}

function randomId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `ret_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function scrubJsonExpression(column: string): string {
  return `CASE
    WHEN ${column} IS NULL THEN NULL
    WHEN jsonb_typeof(${column}) <> 'object' THEN '{}'::jsonb
    ELSE (
      SELECT COALESCE(jsonb_object_agg(entry.key, entry.value), '{}'::jsonb)
      FROM jsonb_each(${column}) AS entry(key, value)
      WHERE lower(entry.key) IN (
        'environment', 'service', 'release', 'operation', 'feature', 'function',
        'functionname', 'group', 'groupname', 'grouptype', 'executionid',
        'execution_id', 'phase', 'caseid', 'case_id', 'datasetrevision',
        'dataset_revision', 'customer', 'customerid', 'customer_id',
        'traceid', 'trace_id', 'tracename', 'trace_name', 'runtime', 'task'
      )
        AND jsonb_typeof(entry.value) IN ('string', 'number', 'boolean', 'null')
    )
  END`;
}

function dateOnly(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

async function oldRowKinds(
  client: pg.PoolClient,
  projectId: string,
  bodyCutoff: Date,
  metadataCutoff: Date,
  rawTelemetryPresent = "",
): Promise<{ body: boolean; detail: boolean }> {
  const result = await client.query(
    `SELECT
       EXISTS (
         SELECT 1 FROM events e
         WHERE project_id = $1 AND timestamp < $2
           AND (request_body IS NOT NULL OR response_body IS NOT NULL OR system_prompt IS NOT NULL ${rawTelemetryPresent}
             OR metadata IS NOT NULL OR context IS NOT NULL OR configuration IS NOT NULL OR usage_event IS NOT NULL)
         UNION ALL
         SELECT 1 FROM usage_components
         WHERE project_id = $1 AND observed_at < $2 AND (metadata IS NOT NULL OR context IS NOT NULL)
         UNION ALL
         SELECT 1 FROM traces
         WHERE project_id = $1 AND COALESCE(ended_at, started_at, created_at) < $2 AND context IS NOT NULL
         UNION ALL
         SELECT 1 FROM executions
         WHERE project_id = $1 AND COALESCE(ended_at, started_at, created_at) < $2 AND (configuration IS NOT NULL OR context IS NOT NULL)
         UNION ALL
         SELECT 1 FROM groups
         WHERE project_id = $1 AND updated_at < $2 AND metadata IS NOT NULL
       ) AS body,
       EXISTS (
         SELECT 1 FROM events WHERE project_id = $1 AND timestamp < $3
         UNION ALL SELECT 1 FROM usage_components WHERE project_id = $1 AND observed_at < $3
         UNION ALL SELECT 1 FROM traces WHERE project_id = $1 AND COALESCE(ended_at, started_at, created_at) < $3
         UNION ALL SELECT 1 FROM executions WHERE project_id = $1 AND COALESCE(ended_at, started_at, created_at) < $3
       ) AS detail`,
    [projectId, bodyCutoff, metadataCutoff],
  );
  return {
    body: Boolean(result.rows[0]?.body),
    detail: Boolean(result.rows[0]?.detail),
  };
}

/**
 * Purge primary detail only after accounting's durable aggregate fence. The
 * transaction takes the same project advisory lock that the aggregator must
 * take while publishing its checkpoint; source_created_before keeps a late
 * backfill from being deleted until a later checkpoint includes it.
 */
export async function runRetention(pool: pg.Pool, now = new Date(), orgId?: string): Promise<RetentionResult> {
  const runId = randomId();
  await pool.query("INSERT INTO retention_runs(id, org_id, started_at) VALUES ($1, $2, $3)", [runId, orgId ?? null, now]);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Resolve through the active search_path so isolated acceptance schemas
    // and the production public schema use the same fence logic.
    const aggregateTable = await client.query("SELECT to_regclass('daily_cost_aggregates') AS table_name");
    const checkpointTable = await client.query("SELECT to_regclass('daily_cost_aggregate_checkpoints') AS table_name");
    const changeTable = await client.query("SELECT to_regclass('accounting_changed_periods') AS table_name");
    const rollupReadable = Boolean((await client.query("SELECT to_regclass('daily_lens_aggregates') AS table_name")).rows[0]?.table_name);
    const contentStatusColumn = await client.query(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = 'events' AND column_name = 'content_status'
       ) AS available`,
    );
    // Raw SDK telemetry (SDK 0.7 schema) is purged with bodies, like metadata.
    const rawTelemetryColumn = await client.query(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = 'events' AND column_name = 'raw_telemetry'
       ) AS available`,
    );
    const rawTelemetrySet = rawTelemetryColumn.rows[0]?.available ? "raw_telemetry = NULL," : "";
    const rawTelemetryPresent = rawTelemetryColumn.rows[0]?.available ? "OR e.raw_telemetry IS NOT NULL" : "";
    const aggregateAvailable = Boolean(aggregateTable.rows[0]?.table_name);
    const checkpointAvailable = Boolean(checkpointTable.rows[0]?.table_name);
    // A period whose change the rollup has not taken in yet keeps its detail.
    const changeTracked = Boolean(changeTable.rows[0]?.table_name);
    const eventsSettled = changeTracked
      ? `AND NOT EXISTS (SELECT 1 FROM accounting_changed_periods c WHERE c.project_id = events.project_id
           AND c.period_start = date_bin('15 minutes', events.timestamp, TIMESTAMPTZ '2000-01-01 00:00:00+00'))`
      : "";
    const usageSettled = changeTracked
      ? `AND NOT EXISTS (SELECT 1 FROM accounting_changed_periods c WHERE c.project_id = usage_components.project_id
           AND c.period_start = date_bin('15 minutes', COALESCE(usage_components.accounting_at, usage_components.observed_at), TIMESTAMPTZ '2000-01-01 00:00:00+00'))`
      : "";
    const contentStatusAvailable = Boolean(contentStatusColumn.rows[0]?.available);
    const expiredStatusSet = contentStatusAvailable
      ? `, content_status = CASE
           WHEN COALESCE(e.content_status, 'unknown') NOT IN ('redacted', 'deleted_by_user')
             AND (e.request_body IS NOT NULL OR e.response_body IS NOT NULL OR e.system_prompt IS NOT NULL
               OR COALESCE(e.metadata ? 'prompt', FALSE)
               OR COALESCE(e.metadata ? 'prompts', FALSE)
               OR COALESCE(e.metadata ? 'completion', FALSE)
               OR COALESCE(e.metadata ? 'response', FALSE)
               OR (e.content_status = 'captured' AND e.metadata IS NOT NULL))
           THEN 'expired' ELSE e.content_status END`
      : "";

    const projects = await client.query(
      `SELECT p.id, s.body_retention_days, s.metadata_retention_days, s.aggregate_retention_days
       FROM projects p JOIN project_settings s ON s.project_id = p.id
       ${orgId ? "WHERE p.org_id = $1" : ""}
       ORDER BY p.id`,
      orgId ? [orgId] : [],
    );
    let redactedBodies = 0;
    let deletedEvents = 0;
    let deletedAggregates = 0;
    let deletedUsageComponents = 0;
    let deletedTraces = 0;
    let deletedExecutions = 0;
    const blockedProjects: string[] = [];

    for (const project of projects.rows as Array<{ id: string; body_retention_days: number; metadata_retention_days: number; aggregate_retention_days: number }>) {
      const metadataCutoff = new Date(now.getTime() - Number(project.metadata_retention_days) * 86_400_000);
      const bodyCutoff = new Date(now.getTime() - Number(project.body_retention_days) * 86_400_000);
      const aggregateCutoff = new Date(now.getTime() - Number(project.aggregate_retention_days) * 86_400_000);
      const kinds = await oldRowKinds(client, project.id, bodyCutoff, metadataCutoff, rawTelemetryPresent);
      const aggregateOld = aggregateAvailable
        && Boolean((await client.query("SELECT EXISTS (SELECT 1 FROM daily_cost_aggregates WHERE project_id = $1 AND day < $2::date) AS found", [project.id, aggregateCutoff])).rows[0]?.found);
      if (!kinds.body && !kinds.detail && !aggregateOld) {
        continue;
      }

      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`retention:${project.id}`]);
      let sourceFence = now;
      let canPurgeDetail = false;
      if (kinds.detail || aggregateOld) {
        if (!aggregateAvailable || !checkpointAvailable) {
          blockedProjects.push(project.id);
        } else {
          const checkpointResult = await client.query(
            `SELECT through_day, source_created_before
             FROM daily_cost_aggregate_checkpoints
             WHERE project_id = $1 FOR SHARE`,
            [project.id],
          );
          const checkpoint = checkpointResult.rows[0] as { through_day?: string; source_created_before?: string } | undefined;
          if (!checkpoint?.through_day || !checkpoint.source_created_before
            || new Date(`${dateOnly(checkpoint.through_day)}T00:00:00.000Z`) < new Date(`${metadataCutoff.toISOString().slice(0, 10)}T00:00:00.000Z`)) {
            blockedProjects.push(project.id);
          } else {
            sourceFence = new Date(checkpoint.source_created_before);
            canPurgeDetail = true;
          }
        }
      }

      const bodyResult = kinds.body ? await client.query(
        `UPDATE events e
         SET request_body = NULL,
             response_body = NULL,
             system_prompt = NULL,
             ${rawTelemetrySet}
             metadata = CASE WHEN e.metadata IS NULL THEN NULL ELSE '{}'::jsonb END,
             configuration = NULL,
             context = ${scrubJsonExpression("e.context")}${expiredStatusSet}
         WHERE e.project_id = $1
           AND e.timestamp < $2
           AND e.created_at < $3
           -- Only rows the scrub still changes: a scrubbed row is never rewritten again.
           AND (e.request_body IS NOT NULL OR e.response_body IS NOT NULL OR e.system_prompt IS NOT NULL
             ${rawTelemetryPresent}
             OR (e.metadata IS NOT NULL AND e.metadata <> '{}'::jsonb) OR e.configuration IS NOT NULL
             OR e.context IS DISTINCT FROM ${scrubJsonExpression("e.context")})`,
        [project.id, bodyCutoff, sourceFence],
      ) : { rowCount: 0 };
      redactedBodies += bodyResult.rowCount ?? 0;

      const usageMetadataScrub = `CASE
               WHEN u.metadata IS NULL OR jsonb_typeof(u.metadata) <> 'object' THEN u.metadata
               WHEN u.metadata ? 'metadata' THEN jsonb_set(u.metadata, '{metadata}', ${scrubJsonExpression("u.metadata->'metadata'")}, TRUE)
               ELSE u.metadata
             END`;
      const usageBodyResult = kinds.body ? await client.query(
        `UPDATE usage_components u
         SET metadata = ${usageMetadataScrub},
             context = ${scrubJsonExpression("u.context")}
         WHERE u.project_id = $1 AND u.observed_at < $2 AND u.created_at < $3
           AND (u.metadata IS DISTINCT FROM ${usageMetadataScrub}
             OR u.context IS DISTINCT FROM ${scrubJsonExpression("u.context")})`,
        [project.id, bodyCutoff, sourceFence],
      ) : { rowCount: 0 };
      redactedBodies += usageBodyResult.rowCount ?? 0;

      const traceBodyResult = kinds.body ? await client.query(
        `UPDATE traces t SET context = ${scrubJsonExpression("t.context")}
         WHERE t.project_id = $1 AND COALESCE(t.ended_at, t.started_at, t.created_at) < $2
           AND t.created_at < $3 AND t.context IS NOT NULL`,
        [project.id, bodyCutoff, sourceFence],
      ) : { rowCount: 0 };
      redactedBodies += traceBodyResult.rowCount ?? 0;
      const executionBodyResult = kinds.body ? await client.query(
        `UPDATE executions e
         SET configuration = NULL, context = ${scrubJsonExpression("e.context")}
         WHERE e.project_id = $1 AND COALESCE(e.ended_at, e.started_at, e.created_at) < $2
           AND e.created_at < $3 AND (e.configuration IS NOT NULL OR e.context IS NOT NULL)`,
        [project.id, bodyCutoff, sourceFence],
      ) : { rowCount: 0 };
      redactedBodies += executionBodyResult.rowCount ?? 0;
      const groupBodyResult = kinds.body ? await client.query(
        `UPDATE groups g SET metadata = NULL, updated_at = NOW()
         WHERE g.project_id = $1 AND g.updated_at < $2 AND g.metadata IS NOT NULL`,
        [project.id, bodyCutoff],
      ) : { rowCount: 0 };
      redactedBodies += groupBodyResult.rowCount ?? 0;

      const eventResult = canPurgeDetail && kinds.detail ? await client.query(
        `DELETE FROM events
         WHERE project_id = $1 AND timestamp < $2 AND created_at < $3 ${eventsSettled}`,
        [project.id, metadataCutoff, sourceFence],
      ) : { rowCount: 0 };
      deletedEvents += eventResult.rowCount ?? 0;
      const usageResult = canPurgeDetail && kinds.detail ? await client.query(
        `DELETE FROM usage_components
         WHERE project_id = $1 AND observed_at < $2 AND created_at < $3 ${usageSettled}`,
        [project.id, metadataCutoff, sourceFence],
      ) : { rowCount: 0 };
      deletedUsageComponents += usageResult.rowCount ?? 0;
      if (canPurgeDetail && kinds.detail && changeTracked) {
        // The rollup scheduler never rebuilds a day this purge may have reached.
        await client.query(
          `UPDATE daily_cost_aggregate_checkpoints
           SET purged_before = GREATEST(COALESCE(purged_before, '-infinity'::timestamptz), $2)
           WHERE project_id = $1`,
          [project.id, metadataCutoff],
        );
      }
      const traceResult = canPurgeDetail && kinds.detail ? await client.query(
        `DELETE FROM traces
         WHERE project_id = $1 AND COALESCE(ended_at, started_at, created_at) < $2 AND created_at < $3`,
        [project.id, metadataCutoff, sourceFence],
      ) : { rowCount: 0 };
      deletedTraces += traceResult.rowCount ?? 0;
      const executionResult = canPurgeDetail && kinds.detail ? await client.query(
        `DELETE FROM executions
         WHERE project_id = $1 AND COALESCE(ended_at, started_at, created_at) < $2 AND created_at < $3`,
        [project.id, metadataCutoff, sourceFence],
      ) : { rowCount: 0 };
      deletedExecutions += executionResult.rowCount ?? 0;
      const aggregateResult = canPurgeDetail && aggregateOld ? await client.query(
        `DELETE FROM daily_cost_aggregates
         WHERE project_id = $1 AND day < $2::date - $3::integer`,
        [project.id, now, Number(project.aggregate_retention_days)],
      ) : { rowCount: 0 };
      deletedAggregates += aggregateResult.rowCount ?? 0;
      if (canPurgeDetail && aggregateOld && rollupReadable) {
        // A day past its aggregate retention is no longer answered by the rollup.
        for (const table of ["daily_lens_aggregates", "daily_rollup_days"]) {
          await client.query(
            `DELETE FROM ${table} WHERE project_id = $1 AND day < $2::date - $3::integer`,
            [project.id, now, Number(project.aggregate_retention_days)],
          );
        }
      }
    }

    const completedAt = new Date().toISOString();
    await client.query(
      `UPDATE retention_runs
       SET completed_at = $1, redacted_bodies = $2, deleted_events = $3
       WHERE id = $4`,
      [completedAt, redactedBodies, deletedEvents, runId],
    );
    await client.query("COMMIT");
    if (blockedProjects.length > 0) {
      await client.query("UPDATE retention_runs SET error = $1 WHERE id = $2", [
        `Aggregate checkpoint incomplete for project(s): ${blockedProjects.join(", ")}`,
        runId,
      ]);
    }
    // Frames are screen content: they follow body retention.
    const deletedFrames = await purgeExpiredFrames(pool, now, orgId).catch((error) => {
      console.warn("[costkey] Frame retention failed:", error instanceof Error ? error.message : error);
      return 0;
    });
    return { runId, redactedBodies, deletedEvents, deletedAggregates, deletedUsageComponents, deletedTraces, deletedExecutions, deletedFrames, blockedProjects, completedAt };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    await pool.query(
      "UPDATE retention_runs SET completed_at = $1, error = $2 WHERE id = $3",
      [new Date().toISOString(), error instanceof Error ? error.message.slice(0, 500) : "Retention failed", runId],
    ).catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export function createRetentionRouter(pool: pg.Pool): Router {
  const router = createRouter();
  router.use("/api", requireAuth);

  router.get("/api/v1/retention/status", async (req: Request, res: Response) => {
    try {
      const user = (req as Request & { user?: { orgId: string } }).user;
      const result = await pool.query(
        `SELECT id, started_at, completed_at, redacted_bodies, deleted_events, error
         FROM retention_runs WHERE org_id = $1 ORDER BY started_at DESC LIMIT 1`,
        [user?.orgId],
      );
      res.json({ latestRun: result.rows[0] ?? null });
    } catch (error) {
      console.error("[costkey] Retention status error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.post("/api/v1/retention/run", async (req: Request, res: Response) => {
    try {
      const user = (req as Request & { user?: { orgId: string; role: string } }).user;
      if (!user) { res.status(401).json({ error: "Authentication required" }); return; }
      if (!roleCanManageWorkspace(user.role)) {
        res.status(403).json({ error: "Only owners and admins can run retention" }); return;
      }
      const result = await runRetention(pool, new Date(), user.orgId);
      res.json(result);
    } catch (error) {
      console.error("[costkey] Retention run error:", error);
      res.status(500).json({ error: "Retention run failed" });
    }
  });

  return router;
}
