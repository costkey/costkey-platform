import type pg from "pg";
import { filterFrames, findBusinessLogicFrame } from "./ingest.js";
import type { StackFrame } from "@costkey/shared";

/**
 * Where a call came from, when its own stack doesn't say.
 *
 * Frameworks such as the OpenAI Agents SDK make model calls on their own
 * tasks: the call's stack holds only library code and the process entry point
 * (uvicorn.run in __main__.py). The SDKs send, raw, the stack where each span
 * was opened; such a call is attributed to the nearest span around it that
 * was opened in the caller's own code.
 */

export interface ScopeSite {
  spanId: string;
  kind: string;
  name: string;
  frames: StackFrame[];
  frame: StackFrame;
}

type Db = pg.Pool | pg.PoolClient;

/** Keep a span's opening stack, filtered the way a call's is. Kept from its first delivery. */
export async function storeSpanSite(db: Db, projectId: string, spanId: string, rawFrames: unknown): Promise<StackFrame[] | null> {
  if (!Array.isArray(rawFrames) || rawFrames.length === 0) return null;
  const frames = filterFrames(rawFrames as StackFrame[]);
  if (frames.length === 0) return null;
  await db.query(
    "UPDATE spans SET call_site_frames = $3::jsonb WHERE project_id = $1 AND id = $2 AND call_site_frames IS NULL",
    [projectId, spanId, JSON.stringify(frames)],
  );
  return frames;
}

/** The nearest span around `spanId` (itself included) opened in the caller's own code. */
export async function scopeSite(db: Db, projectId: string, spanId: string | null | undefined): Promise<ScopeSite | null> {
  if (!spanId) return null;
  const chain = await db.query<{ id: string; kind: string; name: string; call_site_frames: StackFrame[] | null; depth: number }>(
    `WITH RECURSIVE chain AS (
       SELECT id, parent_span_id, kind, name, call_site_frames, 0 AS depth FROM spans WHERE project_id = $1 AND id = $2
       UNION ALL
       SELECT s.id, s.parent_span_id, s.kind, s.name, s.call_site_frames, chain.depth + 1
       FROM spans s JOIN chain ON s.project_id = $1 AND s.id = chain.parent_span_id
       WHERE chain.depth < 32
     )
     SELECT id, kind, name, call_site_frames, depth FROM chain WHERE call_site_frames IS NOT NULL ORDER BY depth`,
    [projectId, spanId],
  );
  for (const row of chain.rows) {
    const frames = Array.isArray(row.call_site_frames) ? row.call_site_frames : [];
    const frame = findBusinessLogicFrame(frames);
    if (frame) return { spanId: row.id, kind: row.kind, name: row.name, frames, frame };
  }
  return null;
}

/**
 * Calls already stored inside this span (or spans under it) that have no
 * code of their own take the span's. Calls under a nearer span with code keep
 * theirs: only calls with no name yet are touched.
 */
export async function attributeCallsToSpan(db: Db, projectId: string, spanId: string): Promise<number> {
  const site = await scopeSite(db, projectId, spanId);
  if (!site || site.spanId !== spanId) return 0;
  const result = await db.query(
    `WITH RECURSIVE tree AS (
       SELECT id, 0 AS depth FROM spans WHERE project_id = $1 AND id = $2
       UNION ALL
       SELECT s.id, tree.depth + 1 FROM spans s JOIN tree ON s.project_id = $1 AND s.parent_span_id = tree.id
       WHERE tree.depth < 32
     )
     UPDATE events e SET bl_function = $3, bl_file = $4, bl_line = $5
      WHERE e.project_id = $1 AND COALESCE(e.event_type, 'call') = 'call' AND e.bl_function IS NULL
        AND e.span_id IN (SELECT id FROM tree)`,
    [projectId, spanId, firstLine(site.frame.functionName), site.frame.fileName ?? null, site.frame.lineNumber ?? null],
  );
  return result.rowCount ?? 0;
}

export function firstLine(name: string | null | undefined): string | null {
  return (name ?? "").split("\n")[0]?.trim() || null;
}
