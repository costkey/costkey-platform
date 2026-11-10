import { Router as createRouter, type Request, type Response, type Router } from "express";
import { randomBytes } from "node:crypto";
import type pg from "pg";
import { requireAuth } from "./auth.js";
import { assertProjectAccess, roleCanReadContent } from "./permissions.js";

/**
 * Labelled datasets: calls a person picked from runs and labelled ("good",
 * "wrong click", …), with the call's input, its original output and the
 * screenshot the model saw, kept as cases for evals. Items copy the content
 * from the call when it was kept, so a dataset outlives body retention until
 * someone removes the item or deletes captured content.
 */

const MAX_LABEL = 60;
const MAX_NOTE = 2000;
const MAX_EXPECTED_BYTES = 16 * 1024;
const MAX_NAME = 80;

type User = { id: string; orgId: string; role: string };

export async function ensureDatasetsSchema(client: pg.Pool | pg.PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS datasets (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT,
      revision INTEGER NOT NULL DEFAULT 1,
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (project_id, name)
    );
    CREATE TABLE IF NOT EXISTS dataset_items (
      id TEXT PRIMARY KEY,
      dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      source_event_id TEXT NOT NULL,
      trace_id TEXT,
      provider TEXT,
      model TEXT,
      input JSONB,
      output JSONB,
      frame_sha256 TEXT,
      label TEXT NOT NULL,
      expected JSONB,
      note TEXT,
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (dataset_id, source_event_id)
    );
    CREATE INDEX IF NOT EXISTS idx_dataset_items_dataset ON dataset_items(dataset_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_dataset_items_event ON dataset_items(project_id, source_event_id);
    CREATE INDEX IF NOT EXISTS idx_dataset_items_frame ON dataset_items(project_id, frame_sha256) WHERE frame_sha256 IS NOT NULL;
  `);
}

function id(prefix: string): string {
  return `${prefix}_${randomBytes(10).toString("hex")}`;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function cleanText(value: unknown, field: string, max: number, required: boolean): string | null {
  if (value === undefined || value === null || value === "") {
    if (required) throw new HttpError(400, `${field} is required`);
    return null;
  }
  if (typeof value !== "string") throw new HttpError(400, `${field} must be text`);
  const text = value.trim();
  if (!text && required) throw new HttpError(400, `${field} is required`);
  if (text.length > max) throw new HttpError(400, `${field} is limited to ${max} characters`);
  return text || null;
}

function cleanExpected(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const json = JSON.stringify(value);
  if (json.length > MAX_EXPECTED_BYTES) throw new HttpError(400, "expected is limited to 16 KB");
  return json;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value ?? null;
  try { return JSON.parse(value); } catch { return value; }
}

/** The newest uploaded screenshot in a call's frame list. */
function newestFrame(frames: unknown): string | null {
  const list = Array.isArray(parseJson(frames)) ? parseJson(frames) as Array<Record<string, unknown>> : [];
  for (let index = list.length - 1; index >= 0; index--) {
    const ref = list[index];
    if (ref && typeof ref.sha256 === "string" && ref.omitted === undefined) return ref.sha256;
  }
  return null;
}

/** Signed-in, on the project, and allowed to read captured content (Developers and above). */
async function contentUser(pool: pg.Pool, req: Request): Promise<{ user: User; projectId: string }> {
  const user = (req as Request & { user?: User }).user!;
  const projectId = String(req.params.projectId);
  await assertProjectAccess(pool, user, projectId);
  if (!roleCanReadContent(user.role)) throw new HttpError(403, "Datasets hold captured content, which Viewers can't open");
  return { user, projectId };
}

function datasetRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    revision: Number(row.revision),
    itemCount: Number(row.item_count ?? 0),
    labels: row.labels ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.eval_runs === undefined ? {} : {
      evalRuns: Number(row.eval_runs ?? 0),
      covers: Array.isArray(row.covers) ? row.covers : [],
      lastEval: row.last_eval_id ? {
        executionId: row.last_eval_id,
        name: row.last_eval_name ?? null,
        configuration: row.last_eval_configuration ?? null,
        startedAt: row.last_eval_started_at ?? null,
        passed: Number(row.last_eval_passed ?? 0),
        failed: Number(row.last_eval_failed ?? 0),
      } : null,
    }),
  };
}

function itemRow(row: Record<string, unknown>, withContent = false): Record<string, unknown> {
  return {
    id: row.id,
    sourceEventId: row.source_event_id,
    traceId: row.trace_id ?? null,
    provider: row.provider ?? null,
    model: row.model ?? null,
    label: row.label,
    note: row.note ?? null,
    expected: row.expected ?? null,
    frameSha256: row.frame_sha256 ?? null,
    hasInput: row.input !== null && row.input !== undefined || row.has_input === true,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(withContent ? { input: row.input ?? null, output: row.output ?? null } : {}),
  };
}

async function loadDataset(pool: pg.Pool, projectId: string, datasetId: string): Promise<Record<string, unknown>> {
  const result = await pool.query(
    `SELECT d.*, (SELECT COUNT(*) FROM dataset_items i WHERE i.dataset_id = d.id) AS item_count,
            (SELECT COALESCE(jsonb_object_agg(label, n), '{}'::jsonb)
               FROM (SELECT label, COUNT(*) AS n FROM dataset_items i WHERE i.dataset_id = d.id GROUP BY label) l) AS labels
     FROM datasets d WHERE d.project_id = $1 AND d.id = $2`,
    [projectId, datasetId],
  );
  if (!result.rows[0]) throw new HttpError(404, "Dataset not found");
  return result.rows[0] as Record<string, unknown>;
}

async function bump(pool: pg.Pool, datasetId: string): Promise<void> {
  await pool.query("UPDATE datasets SET revision = revision + 1, updated_at = NOW() WHERE id = $1", [datasetId]);
}

function handle(fn: (req: Request, res: Response) => Promise<void>) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      await fn(req, res);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : (error as Error & { status?: number }).status;
      if (status) { res.status(status).json({ error: (error as Error).message }); return; }
      if ((error as { code?: string }).code === "23505") { res.status(409).json({ error: "A dataset with that name already exists" }); return; }
      console.error("[costkey] Dataset error:", error);
      res.status(500).json({ error: "Dataset request failed" });
    }
  };
}

export function createDatasetsRouter(pool: pg.Pool): Router {
  const router = createRouter();
  const base = "/api/v1/projects/:projectId/datasets";

  router.get(base, requireAuth, handle(async (req, res) => {
    const { projectId } = await contentUser(pool, req);
    const result = await pool.query(
      `SELECT d.*, COALESCE(c.n, 0) AS item_count, COALESCE(c.labels, '{}'::jsonb) AS labels,
              COALESCE(f.covers, '[]'::jsonb) AS covers, COALESCE(ev.runs, 0) AS eval_runs,
              last.id AS last_eval_id, last.name AS last_eval_name, last.configuration AS last_eval_configuration,
              last.started_at AS last_eval_started_at, lv.passed AS last_eval_passed, lv.failed AS last_eval_failed
       FROM datasets d
       LEFT JOIN LATERAL (
         SELECT SUM(n) AS n, jsonb_object_agg(label, n) AS labels
         FROM (SELECT label, COUNT(*) AS n FROM dataset_items i WHERE i.dataset_id = d.id GROUP BY label) l
       ) c ON TRUE
       -- Up to three screenshots to show on the list.
       LEFT JOIN LATERAL (
         SELECT jsonb_agg(frame_sha256) AS covers
         FROM (SELECT frame_sha256 FROM dataset_items i WHERE i.dataset_id = d.id AND frame_sha256 IS NOT NULL ORDER BY created_at LIMIT 3) x
       ) f ON TRUE
       LEFT JOIN LATERAL (
         SELECT COUNT(*) AS runs FROM executions x WHERE x.project_id = d.project_id AND starts_with(x.dataset_revision, d.id || '@')
       ) ev ON TRUE
       LEFT JOIN LATERAL (
         SELECT x.id, x.name, x.configuration, x.started_at FROM executions x
         WHERE x.project_id = d.project_id AND starts_with(x.dataset_revision, d.id || '@')
         ORDER BY x.started_at DESC NULLS LAST LIMIT 1
       ) last ON TRUE
       LEFT JOIN LATERAL (
         SELECT COUNT(*) FILTER (WHERE s.value >= 1) AS passed, COUNT(*) FILTER (WHERE s.value < 1) AS failed
         FROM scores s WHERE last.id IS NOT NULL AND s.project_id = d.project_id AND starts_with(s.id, 'eval_' || last.id || '_')
       ) lv ON TRUE
       WHERE d.project_id = $1
       ORDER BY d.updated_at DESC`,
      [projectId],
    );
    res.json({ datasets: result.rows.map((row) => datasetRow(row as Record<string, unknown>)) });
  }));

  router.post(base, requireAuth, handle(async (req, res) => {
    const { user, projectId } = await contentUser(pool, req);
    const name = cleanText(req.body?.name, "name", MAX_NAME, true)!;
    const description = cleanText(req.body?.description, "description", MAX_NOTE, false);
    const datasetId = id("ds");
    await pool.query(
      "INSERT INTO datasets (id, project_id, name, description, created_by) VALUES ($1, $2, $3, $4, $5)",
      [datasetId, projectId, name, description, user.id],
    );
    res.status(201).json({ dataset: datasetRow(await loadDataset(pool, projectId, datasetId)) });
  }));

  router.get(`${base}/:datasetId`, requireAuth, handle(async (req, res) => {
    const { projectId } = await contentUser(pool, req);
    const dataset = await loadDataset(pool, projectId, String(req.params.datasetId));
    const items = await pool.query(
      `SELECT id, source_event_id, trace_id, provider, model, label, note, expected, frame_sha256,
              (input IS NOT NULL) AS has_input, output, created_at, updated_at
       FROM dataset_items WHERE dataset_id = $1 ORDER BY created_at ASC, id ASC`,
      [dataset.id],
    );
    // The output (not the input, which can be large) lets the console show each call's action.
    res.json({
      dataset: datasetRow(dataset),
      items: items.rows.map((row) => ({ ...itemRow({ ...row, input: null } as Record<string, unknown>), output: (row as { output?: unknown }).output ?? null })),
    });
  }));

  router.patch(`${base}/:datasetId`, requireAuth, handle(async (req, res) => {
    const { projectId } = await contentUser(pool, req);
    const dataset = await loadDataset(pool, projectId, String(req.params.datasetId));
    const name = req.body?.name === undefined ? dataset.name : cleanText(req.body.name, "name", MAX_NAME, true);
    const description = req.body?.description === undefined ? dataset.description : cleanText(req.body.description, "description", MAX_NOTE, false);
    await pool.query("UPDATE datasets SET name = $1, description = $2, updated_at = NOW() WHERE id = $3", [name, description, dataset.id]);
    res.json({ dataset: datasetRow(await loadDataset(pool, projectId, String(dataset.id))) });
  }));

  router.delete(`${base}/:datasetId`, requireAuth, handle(async (req, res) => {
    const { projectId } = await contentUser(pool, req);
    const dataset = await loadDataset(pool, projectId, String(req.params.datasetId));
    await pool.query("DELETE FROM datasets WHERE id = $1", [dataset.id]);
    res.status(204).end();
  }));

  // Add a call to a dataset, or relabel it when it's already there.
  router.post(`${base}/:datasetId/items`, requireAuth, handle(async (req, res) => {
    const { user, projectId } = await contentUser(pool, req);
    const dataset = await loadDataset(pool, projectId, String(req.params.datasetId));
    const eventId = cleanText(req.body?.eventId, "eventId", 200, true)!;
    const label = cleanText(req.body?.label, "label", MAX_LABEL, true)!;
    const note = cleanText(req.body?.note, "note", MAX_NOTE, false);
    const expected = cleanExpected(req.body?.expected);
    const event = await pool.query(
      `SELECT id, trace_id, provider, model, request_body, response_body, frames
       FROM events WHERE project_id = $1 AND id = $2 AND COALESCE(event_type, 'call') = 'call'`,
      [projectId, eventId],
    );
    const call = event.rows[0] as Record<string, unknown> | undefined;
    if (!call) throw new HttpError(404, "Call not found");
    const input = call.request_body == null ? null : JSON.stringify(parseJson(call.request_body));
    const output = call.response_body == null ? null : JSON.stringify(parseJson(call.response_body));
    const inserted = await pool.query(
      `INSERT INTO dataset_items (id, dataset_id, project_id, source_event_id, trace_id, provider, model,
                                  input, output, frame_sha256, label, expected, note, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12::jsonb, $13, $14)
       ON CONFLICT (dataset_id, source_event_id) DO UPDATE
         SET label = EXCLUDED.label, note = EXCLUDED.note,
             expected = COALESCE(EXCLUDED.expected, dataset_items.expected), updated_at = NOW()
       RETURNING *, (xmax = 0) AS created`,
      [id("dsi"), dataset.id, projectId, eventId, call.trace_id ?? null, call.provider ?? null, call.model ?? null,
        input, output, newestFrame(call.frames), label, expected, note, user.id],
    );
    await bump(pool, String(dataset.id));
    const row = inserted.rows[0] as Record<string, unknown>;
    res.status(row.created ? 201 : 200).json({ item: itemRow(row) });
  }));

  router.patch(`${base}/:datasetId/items/:itemId`, requireAuth, handle(async (req, res) => {
    const { projectId } = await contentUser(pool, req);
    const dataset = await loadDataset(pool, projectId, String(req.params.datasetId));
    const current = await pool.query("SELECT * FROM dataset_items WHERE dataset_id = $1 AND id = $2", [dataset.id, String(req.params.itemId)]);
    const row = current.rows[0] as Record<string, unknown> | undefined;
    if (!row) throw new HttpError(404, "Item not found");
    const label = req.body?.label === undefined ? row.label : cleanText(req.body.label, "label", MAX_LABEL, true);
    const note = req.body?.note === undefined ? row.note : cleanText(req.body.note, "note", MAX_NOTE, false);
    const expected = req.body?.expected === undefined ? (row.expected == null ? null : JSON.stringify(row.expected)) : cleanExpected(req.body.expected);
    const updated = await pool.query(
      "UPDATE dataset_items SET label = $1, note = $2, expected = $3::jsonb, updated_at = NOW() WHERE id = $4 RETURNING *",
      [label, note, expected, row.id],
    );
    await bump(pool, String(dataset.id));
    res.json({ item: itemRow(updated.rows[0] as Record<string, unknown>) });
  }));

  router.delete(`${base}/:datasetId/items/:itemId`, requireAuth, handle(async (req, res) => {
    const { projectId } = await contentUser(pool, req);
    const dataset = await loadDataset(pool, projectId, String(req.params.datasetId));
    const deleted = await pool.query("DELETE FROM dataset_items WHERE dataset_id = $1 AND id = $2", [dataset.id, String(req.params.itemId)]);
    if (!deleted.rowCount) throw new HttpError(404, "Item not found");
    await bump(pool, String(dataset.id));
    res.status(204).end();
  }));

  // Every item with its content, one JSON object per line.
  router.get(`${base}/:datasetId/export`, requireAuth, handle(async (req, res) => {
    const { projectId } = await contentUser(pool, req);
    const dataset = await loadDataset(pool, projectId, String(req.params.datasetId));
    const items = await pool.query("SELECT * FROM dataset_items WHERE dataset_id = $1 ORDER BY created_at ASC, id ASC", [dataset.id]);
    const safeName = String(dataset.name).replace(/[^a-z0-9._-]+/gi, "-").slice(0, 60) || "dataset";
    res.set({
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Content-Disposition": `attachment; filename="${safeName}.jsonl"`,
    });
    res.send(items.rows.map((row) => JSON.stringify(itemRow(row as Record<string, unknown>, true))).join("\n") + (items.rows.length ? "\n" : ""));
  }));

  // Eval runs against this dataset: executions whose dataset revision names it
  // (CostKey.runEval sends "<datasetId>@<revision>"), with their cost and verdicts.
  router.get(`${base}/:datasetId/evals`, requireAuth, handle(async (req, res) => {
    const { projectId } = await contentUser(pool, req);
    const dataset = await loadDataset(pool, projectId, String(req.params.datasetId));
    const runs = await pool.query(
      `WITH runs AS (
         SELECT id, name, configuration, dataset_revision, state, started_at, ended_at
         FROM executions
         WHERE project_id = $1 AND starts_with(dataset_revision, $2 || '@')
       ), calls AS (
         SELECT e.execution_id, COUNT(DISTINCT e.case_id) AS cases, SUM(e.cost_usd) AS cost
         FROM events e JOIN runs r ON r.id = e.execution_id
         WHERE e.project_id = $1 AND COALESCE(e.event_type, 'call') = 'call'
         GROUP BY e.execution_id
       ), original AS (
         SELECT c.execution_id, SUM(src.cost_usd) AS original_cost
         FROM (SELECT DISTINCT e.execution_id, e.case_id FROM events e JOIN runs r ON r.id = e.execution_id
               WHERE e.project_id = $1 AND e.case_id IS NOT NULL) c
         JOIN dataset_items di ON di.id = c.case_id AND di.dataset_id = $2
         JOIN events src ON src.project_id = $1 AND src.id = di.source_event_id
         GROUP BY c.execution_id
       ), verdicts AS (
         SELECT r.id AS execution_id,
                COUNT(*) FILTER (WHERE s.value >= 1) AS passed,
                COUNT(*) FILTER (WHERE s.value < 1) AS failed
         FROM runs r JOIN scores s ON s.project_id = $1 AND starts_with(s.id, 'eval_' || r.id || '_')
         GROUP BY r.id
       )
       SELECT r.*, COALESCE(c.cases, 0) AS cases, c.cost, o.original_cost,
              COALESCE(v.passed, 0) AS passed, COALESCE(v.failed, 0) AS failed
       FROM runs r
       LEFT JOIN calls c ON c.execution_id = r.id
       LEFT JOIN original o ON o.execution_id = r.id
       LEFT JOIN verdicts v ON v.execution_id = r.id
       ORDER BY r.started_at DESC NULLS LAST
       LIMIT 50`,
      [projectId, dataset.id],
    );
    res.json({
      runs: runs.rows.map((row) => ({
        executionId: row.id,
        name: row.name,
        configuration: row.configuration ?? null,
        datasetRevision: row.dataset_revision,
        state: row.state,
        startedAt: row.started_at,
        endedAt: row.ended_at,
        cases: Number(row.cases),
        passed: Number(row.passed),
        failed: Number(row.failed),
        cost: row.cost == null ? null : Number(row.cost),
        originalCost: row.original_cost == null ? null : Number(row.original_cost),
      })),
    });
  }));

  // One eval run, case by case: the labelled call next to what the candidate did.
  router.get(`${base}/:datasetId/evals/:executionId`, requireAuth, handle(async (req, res) => {
    const { projectId } = await contentUser(pool, req);
    const dataset = await loadDataset(pool, projectId, String(req.params.datasetId));
    const executionId = String(req.params.executionId);
    const run = await pool.query(
      `SELECT id, name, configuration, dataset_revision, state, started_at, ended_at FROM executions
       WHERE project_id = $1 AND id = $2 AND starts_with(dataset_revision, $3 || '@')`,
      [projectId, executionId, dataset.id],
    );
    if (!run.rows[0]) throw new HttpError(404, "Eval run not found");
    const cases = await pool.query(
      `WITH candidate AS (
         SELECT e.case_id, MIN(e.trace_id) AS trace_id, SUM(e.cost_usd) AS cost, COUNT(*) AS calls,
                (ARRAY_AGG(e.response_body ORDER BY e.timestamp DESC))[1] AS response_body
         FROM events e
         WHERE e.project_id = $1 AND e.execution_id = $2 AND e.case_id IS NOT NULL
           AND COALESCE(e.event_type, 'call') = 'call'
         GROUP BY e.case_id
       )
       SELECT di.id, di.label, di.note, di.frame_sha256, di.output, di.source_event_id, di.trace_id AS source_trace_id,
              src.cost_usd AS original_cost, src.model AS original_model,
              c.trace_id, c.cost, c.calls, c.response_body,
              s.value AS score, s.comment AS reason
       FROM candidate c
       JOIN dataset_items di ON di.id = c.case_id AND di.dataset_id = $3
       LEFT JOIN events src ON src.project_id = $1 AND src.id = di.source_event_id
       LEFT JOIN scores s ON s.project_id = $1 AND s.id = 'eval_' || $2 || '_' || di.id
       ORDER BY di.created_at ASC, di.id ASC`,
      [projectId, executionId, dataset.id],
    );
    const row = run.rows[0] as Record<string, unknown>;
    res.json({
      run: { executionId: row.id, name: row.name, configuration: row.configuration ?? null, datasetRevision: row.dataset_revision, state: row.state, startedAt: row.started_at, endedAt: row.ended_at },
      cases: cases.rows.map((item) => ({
        itemId: item.id,
        label: item.label,
        note: item.note ?? null,
        frameSha256: item.frame_sha256 ?? null,
        sourceEventId: item.source_event_id,
        sourceTraceId: item.source_trace_id ?? null,
        originalModel: item.original_model ?? null,
        originalCost: item.original_cost == null ? null : Number(item.original_cost),
        originalOutput: item.output ?? null,
        traceId: item.trace_id,
        calls: Number(item.calls),
        cost: item.cost == null ? null : Number(item.cost),
        candidateOutput: parseJson(item.response_body),
        pass: item.score == null ? null : Number(item.score) >= 1,
        reason: item.reason ?? null,
      })),
    });
  }));

  // Which datasets a call is already in, for the "Add to dataset" control.
  router.get("/api/v1/projects/:projectId/dataset-items", requireAuth, handle(async (req, res) => {
    const { projectId } = await contentUser(pool, req);
    const eventId = typeof req.query.eventId === "string" ? req.query.eventId : "";
    if (!eventId) throw new HttpError(400, "eventId is required");
    const items = await pool.query(
      `SELECT i.id, i.dataset_id, d.name AS dataset_name, i.label, i.note
       FROM dataset_items i JOIN datasets d ON d.id = i.dataset_id
       WHERE i.project_id = $1 AND i.source_event_id = $2 ORDER BY d.name`,
      [projectId, eventId],
    );
    res.json({ items: items.rows.map((row) => ({ id: row.id, datasetId: row.dataset_id, datasetName: row.dataset_name, label: row.label, note: row.note ?? null })) });
  }));

  return router;
}

/** "Delete stored prompts" also clears the content items copied from calls. */
export async function clearDatasetContent(pool: pg.Pool, projectId: string): Promise<number> {
  const result = await pool.query(
    "UPDATE dataset_items SET input = NULL, output = NULL, updated_at = NOW() WHERE project_id = $1 AND (input IS NOT NULL OR output IS NOT NULL)",
    [projectId],
  );
  return result.rowCount ?? 0;
}
