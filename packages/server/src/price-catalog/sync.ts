import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import type pg from "pg";
import { PriceCatalog, setPriceCatalog, getPriceCatalog } from "./catalog.js";
import { curatedPrices } from "./curated.js";
import { normalizeLiteLlm, normalizeModelsDev, normalizeOpenRouter, normalizeVercelGateway } from "./normalize.js";
import type { CatalogEntry, CatalogPrice, PriceRates, PriceSource } from "./types.js";

/** Public catalogs, in order of precedence. */
export const PRICE_SOURCES: Array<{ source: PriceSource; url: string; normalize: (json: unknown) => CatalogEntry[] }> = [
  { source: "litellm", url: "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json", normalize: normalizeLiteLlm },
  { source: "models_dev", url: "https://models.dev/api.json", normalize: normalizeModelsDev },
  { source: "openrouter", url: "https://openrouter.ai/api/v1/models", normalize: normalizeOpenRouter },
  { source: "vercel", url: "https://ai-gateway.vercel.sh/v1/models", normalize: normalizeVercelGateway },
];

const SNAPSHOT_URL = new URL("../../data/price-catalog.snapshot.json", import.meta.url);
/** The first version of a price applies to all history before it was seen. */
const EPOCH = "1970-01-01T00:00:00.000Z";
const SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;
const ON_DEMAND_COOLDOWN_MS = 30 * 60 * 1000;
const REPRICE_BATCH = 1000;
const REPRICE_LIMIT = 200_000;

export interface SourceOutcome {
  status: "ok" | "failed" | "rejected";
  entries: number;
  added: number;
  changed: number;
  error?: string;
}

export interface SyncResult {
  runId: string | null;
  status: "ok" | "partial" | "failed" | "skipped";
  sources: Record<string, SourceOutcome>;
  added: number;
  changed: number;
  repriced: number;
  disagreements: number;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function entryHash(entry: CatalogEntry): string {
  return hash(stable({ model: entry.model, mode: entry.mode, rates: entry.rates }));
}

function priceId(entry: CatalogEntry, effectiveFrom: string): string {
  return `mp_${hash(`${entry.source}|${entry.provider}|${entry.sourceKey}|${effectiveFrom}`).slice(0, 24)}`;
}

function enabled(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  return !["0", "off", "false", "no"].includes(value.toLowerCase());
}

/** Catalog loading is off in tests unless asked for, so cost assertions stay deterministic. */
export function priceCatalogEnabled(): boolean {
  return enabled("COSTKEY_PRICE_CATALOG", process.env["NODE_ENV"] !== "test");
}

export function priceSyncEnabled(): boolean {
  return priceCatalogEnabled() && enabled("COSTKEY_PRICE_SYNC", true);
}

/**
 * Model prices synced from public catalogs. Every version is kept: a changed
 * price closes the old row and opens a new one, so a call is priced at the
 * rate in force when it happened and retired models keep pricing history.
 */
export async function ensurePriceCatalogSchema(pool: pg.Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS model_prices (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      source_key TEXT NOT NULL,
      mode TEXT,
      rates JSONB NOT NULL,
      rates_hash TEXT NOT NULL,
      effective_from TIMESTAMPTZ NOT NULL,
      effective_to TIMESTAMPTZ,
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_model_prices_version ON model_prices(source, provider, source_key, effective_from);
    CREATE INDEX IF NOT EXISTS idx_model_prices_lookup ON model_prices(provider, model);
    CREATE TABLE IF NOT EXISTS pricing_sync_runs (
      id TEXT PRIMARY KEY,
      trigger TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      sources JSONB NOT NULL DEFAULT '{}'::jsonb,
      added INTEGER NOT NULL DEFAULT 0,
      changed INTEGER NOT NULL DEFAULT 0,
      repriced INTEGER NOT NULL DEFAULT 0,
      disagreements INTEGER NOT NULL DEFAULT 0,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at TIMESTAMPTZ
    );
    -- A project's own name for a model (an Azure deployment, a proxy route)
    -- priced as a catalog model.
    CREATE TABLE IF NOT EXISTS model_aliases (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      target_model TEXT NOT NULL,
      created_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (project_id, provider, model)
    );
  `);
}

/** Load every stored price version into memory. */
export async function loadPriceCatalog(pool: pg.Pool): Promise<PriceCatalog> {
  const result = await pool.query(
    `SELECT id, source, provider, model, source_key, mode, rates, effective_from, effective_to
     FROM model_prices`,
  );
  const prices: CatalogPrice[] = result.rows.map((row) => ({
    id: String(row.id),
    source: row.source as PriceSource,
    provider: String(row.provider),
    model: String(row.model),
    sourceKey: String(row.source_key),
    mode: row.mode == null ? null : String(row.mode),
    rates: (typeof row.rates === "string" ? JSON.parse(row.rates) : row.rates) as PriceRates,
    effectiveFrom: new Date(row.effective_from).toISOString(),
    effectiveTo: row.effective_to ? new Date(row.effective_to).toISOString() : null,
  }));
  const catalog = new PriceCatalog([...curatedPrices(), ...prices]);
  setPriceCatalog(catalog);
  return catalog;
}

/**
 * Write one source's entries. New keys start at the epoch; a changed price
 * closes the old version and opens a new one from now, so calls are always
 * priced at the rate in force when they happened.
 */
async function writeSource(client: pg.PoolClient, source: PriceSource, entries: CatalogEntry[], now: string): Promise<{ added: number; changed: number }> {
  const existing = await client.query(
    `SELECT id, provider, source_key, rates_hash FROM model_prices
     WHERE source = $1 AND effective_to IS NULL`,
    [source],
  );
  const live = new Map<string, { id: string; hash: string }>();
  for (const row of existing.rows) live.set(`${row.provider}\u0000${row.source_key}`, { id: String(row.id), hash: String(row.rates_hash) });

  const inserts: Array<{ entry: CatalogEntry; hash: string; effectiveFrom: string }> = [];
  const closeIds: string[] = [];
  const seenIds: string[] = [];
  const keys = new Set<string>();
  let added = 0;
  let changed = 0;
  for (const entry of entries) {
    const mapKey = `${entry.provider}\u0000${entry.sourceKey}`;
    if (keys.has(mapKey)) continue;
    keys.add(mapKey);
    const digest = entryHash(entry);
    const current = live.get(mapKey);
    if (!current) {
      inserts.push({ entry, hash: digest, effectiveFrom: EPOCH });
      added++;
    } else if (current.hash !== digest) {
      closeIds.push(current.id);
      inserts.push({ entry, hash: digest, effectiveFrom: now });
      changed++;
    } else {
      seenIds.push(current.id);
    }
  }
  if (closeIds.length > 0) {
    await client.query("UPDATE model_prices SET effective_to = $2 WHERE id = ANY($1::text[])", [closeIds, now]);
  }
  if (seenIds.length > 0) {
    await client.query("UPDATE model_prices SET last_seen_at = $2 WHERE id = ANY($1::text[])", [seenIds, now]);
  }
  for (let offset = 0; offset < inserts.length; offset += 2000) {
    const batch = inserts.slice(offset, offset + 2000);
    await client.query(
      `INSERT INTO model_prices (id, source, provider, model, source_key, mode, rates, rates_hash, effective_from, last_seen_at)
       SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::jsonb[], $8::text[], $9::timestamptz[], $10::timestamptz[])
       ON CONFLICT (source, provider, source_key, effective_from) DO NOTHING`,
      [
        batch.map((item) => priceId(item.entry, item.effectiveFrom)),
        batch.map(() => source),
        batch.map((item) => item.entry.provider),
        batch.map((item) => item.entry.model),
        batch.map((item) => item.entry.sourceKey),
        batch.map((item) => item.entry.mode),
        batch.map((item) => JSON.stringify(item.entry.rates)),
        batch.map((item) => item.hash),
        batch.map((item) => item.effectiveFrom),
        batch.map(() => now),
      ],
    );
  }
  return { added, changed };
}

/** Count models two sources price more than 10% apart on input or output. */
function countDisagreements(entriesBySource: Map<PriceSource, CatalogEntry[]>): number {
  const reference = new Map<string, PriceRates>();
  for (const entry of entriesBySource.get("litellm") ?? []) reference.set(`${entry.provider}\u0000${entry.model}`, entry.rates);
  let count = 0;
  for (const entry of entriesBySource.get("models_dev") ?? []) {
    const other = reference.get(`${entry.provider}\u0000${entry.model}`);
    if (!other) continue;
    const apart = (a?: number, b?: number) => a !== undefined && b !== undefined && Math.max(a, b) > 0 && Math.abs(a - b) / Math.max(a, b) > 0.1;
    if (apart(entry.rates.input, other.input) || apart(entry.rates.output, other.output)) count++;
  }
  return count;
}

async function fetchSource(url: string, fetchImpl: typeof fetch): Promise<unknown> {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(30_000), headers: { "User-Agent": "costkey-price-sync" } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

let syncing: Promise<SyncResult> | null = null;

/** Pull every source, store new and changed prices, then price what was unpriced. */
export async function syncPriceCatalog(
  pool: pg.Pool,
  options: { trigger: string; fetchImpl?: typeof fetch; payloads?: Partial<Record<PriceSource, unknown>> } = { trigger: "manual" },
): Promise<SyncResult> {
  if (syncing) return syncing;
  syncing = runSync(pool, options).finally(() => { syncing = null; });
  return syncing;
}

async function runSync(
  pool: pg.Pool,
  options: { trigger: string; fetchImpl?: typeof fetch; payloads?: Partial<Record<PriceSource, unknown>> },
): Promise<SyncResult> {
  const client = await pool.connect();
  const result: SyncResult = { runId: null, status: "skipped", sources: {}, added: 0, changed: 0, repriced: 0, disagreements: 0 };
  try {
    const lock = await client.query("SELECT pg_try_advisory_lock(hashtextextended('costkey_price_catalog_sync', 0)) AS locked");
    if (!lock.rows[0]?.locked) return result;
    try {
      const runId = `psr_${randomBytes(12).toString("hex")}`;
      result.runId = runId;
      await client.query("INSERT INTO pricing_sync_runs (id, trigger) VALUES ($1, $2)", [runId, options.trigger]);
      const now = new Date().toISOString();
      const entriesBySource = new Map<PriceSource, CatalogEntry[]>();
      for (const { source, url, normalize } of PRICE_SOURCES) {
        try {
          const payload = options.payloads?.[source] ?? await fetchSource(url, options.fetchImpl ?? fetch);
          const entries = normalize(payload);
          const stored = await client.query(
            "SELECT COUNT(*)::int AS count FROM model_prices WHERE source = $1 AND effective_to IS NULL",
            [source],
          );
          const previous = Number(stored.rows[0]?.count ?? 0);
          // A feed that suddenly lost most of its models is broken, not a
          // mass retirement; keep the last good prices.
          if (entries.length === 0 || (previous > 100 && entries.length < previous * 0.5)) {
            result.sources[source] = { status: "rejected", entries: entries.length, added: 0, changed: 0, error: `only ${entries.length} prices, had ${previous}` };
            continue;
          }
          entriesBySource.set(source, entries);
          await client.query("BEGIN");
          const written = await writeSource(client, source, entries, now);
          await client.query("COMMIT");
          result.sources[source] = { status: "ok", entries: entries.length, ...written };
          result.added += written.added;
          result.changed += written.changed;
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          result.sources[source] = { status: "failed", entries: 0, added: 0, changed: 0, error: error instanceof Error ? error.message.slice(0, 300) : "failed" };
        }
      }
      result.disagreements = countDisagreements(entriesBySource);
      const outcomes = Object.values(result.sources);
      result.status = outcomes.every((outcome) => outcome.status === "ok") ? "ok" : outcomes.some((outcome) => outcome.status === "ok") ? "partial" : "failed";
      await loadPriceCatalog(pool);
      if (result.added + result.changed > 0) result.repriced = await repriceUnpricedEvents(pool);
      await client.query(
        `UPDATE pricing_sync_runs
         SET finished_at = NOW(), status = $2, sources = $3::jsonb, added = $4, changed = $5, repriced = $6, disagreements = $7
         WHERE id = $1`,
        [runId, result.status, JSON.stringify(result.sources), result.added, result.changed, result.repriced, result.disagreements],
      );
      return result;
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtextextended('costkey_price_catalog_sync', 0))").catch(() => undefined);
    }
  } finally {
    client.release();
  }
}

/**
 * Seed the catalog from the snapshot shipped with the server: every source
 * when it is empty, and a source this release adds (Vercel's gateway, say)
 * when the catalog has never had it, so its prices apply from the deploy
 * rather than the next sync.
 */
export async function importSnapshotSources(pool: pg.Pool): Promise<number> {
  const present = await pool.query<{ source: string }>("SELECT DISTINCT source FROM model_prices");
  const known = new Set(present.rows.map((row) => row.source));
  let snapshot: { entries?: CatalogEntry[] };
  try {
    snapshot = JSON.parse(await readFile(SNAPSHOT_URL, "utf8")) as { entries?: CatalogEntry[] };
  } catch {
    return 0;
  }
  const bySource = new Map<PriceSource, CatalogEntry[]>();
  for (const entry of snapshot.entries ?? []) {
    if (known.has(entry.source)) continue;
    const list = bySource.get(entry.source) ?? [];
    list.push(entry);
    bySource.set(entry.source, list);
  }
  if (bySource.size === 0) return 0;
  const client = await pool.connect();
  let added = 0;
  try {
    await client.query("BEGIN");
    const now = new Date().toISOString();
    for (const [source, entries] of bySource) added += (await writeSource(client, source, entries, now)).added;
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  return added;
}

/** A local calendar day for an instant, in a workspace timezone. */
function localDay(value: unknown, timezone: string): string | null {
  const date = new Date(value as string);
  if (Number.isNaN(date.getTime())) return null;
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

/**
 * Price calls stored without a price, using the current catalog and project
 * prices. Provider-reported costs are never touched.
 */
export async function repriceUnpricedEvents(pool: pg.Pool, options: { projectId?: string } = {}): Promise<number> {
  const { priceStoredCall } = await import("../billing.js");
  const { reconcileDailyCostAggregates } = await import("../accounting.js");
  let after: [string, string] = ["", ""];
  let updated = 0;
  const days = new Map<string, Set<string>>();
  const timezones = new Map<string, string>();
  for (let scanned = 0; scanned < REPRICE_LIMIT; scanned += REPRICE_BATCH) {
    const rows = await pool.query(
      `SELECT e.project_id, e.id, e.timestamp, e.provider, e.url, e.model, e.request_model, e.context,
              e.input_tokens, e.output_tokens, e.reasoning_tokens, e.cache_read_tokens,
              e.cache_creation_tokens, e.image_output_tokens, e.native_units,
              e.bl_function, e.bl_file, e.bl_line
       FROM events e
       WHERE e.cost_usd IS NULL
         AND COALESCE(e.event_type, 'call') = 'call'
         AND COALESCE(e.cost_basis, 'unknown') <> 'reported'
         AND (e.model IS NOT NULL OR e.request_model IS NOT NULL)
         AND ($1::text IS NULL OR e.project_id = $1)
         AND (e.project_id, e.id) > ($2, $3)
       ORDER BY e.project_id, e.id
       LIMIT ${REPRICE_BATCH}`,
      [options.projectId ?? null, after[0], after[1]],
    );
    if (rows.rows.length === 0) break;
    const last = rows.rows[rows.rows.length - 1];
    after = [String(last.project_id), String(last.id)];
    const priced: Array<{ projectId: string; id: string; cost: number; source: string; pricingId: string | null; pricingDate: string | null; timestamp: unknown; callSite: string | null; model: string }> = [];
    for (const row of rows.rows) {
      const resolved = await priceStoredCall(pool, row as Record<string, unknown>);
      if (!resolved) continue;
      priced.push({
        projectId: String(row.project_id), id: String(row.id), cost: resolved.cost, source: resolved.source,
        pricingId: resolved.pricingId, pricingDate: resolved.pricingDate, timestamp: row.timestamp,
        callSite: row.bl_function ? `${row.bl_file ?? "unknown"}:${row.bl_function}:${row.bl_line ?? 0}` : null,
        model: row.model ?? "unknown",
      });
    }
    if (priced.length > 0) {
      const result = await pool.query(
        `UPDATE events e
         SET cost_usd = v.cost, cost_basis = 'estimated', cost_source = v.source,
             pricing_id = v.pricing_id, pricing_date = v.pricing_date, cost_currency = 'USD'
         FROM unnest($1::text[], $2::text[], $3::float8[], $4::text[], $5::text[], $6::timestamptz[])
              AS v(project_id, id, cost, source, pricing_id, pricing_date)
         WHERE e.project_id = v.project_id AND e.id = v.id AND e.cost_usd IS NULL
         RETURNING e.project_id, e.id`,
        [
          priced.map((item) => item.projectId), priced.map((item) => item.id), priced.map((item) => item.cost),
          priced.map((item) => item.source), priced.map((item) => item.pricingId), priced.map((item) => item.pricingDate),
        ],
      );
      const applied = new Set(result.rows.map((row) => `${row.project_id}\u0000${row.id}`));
      const callSites = new Map<string, { projectId: string; callSite: string; model: string; cost: number; count: number }>();
      for (const item of priced) {
        if (!applied.has(`${item.projectId}\u0000${item.id}`)) continue;
        updated++;
        if (!timezones.has(item.projectId)) {
          const tz = await pool.query(
            `SELECT COALESCE(ws.timezone, 'UTC') AS timezone FROM projects p
             LEFT JOIN workspace_settings ws ON ws.org_id = p.org_id WHERE p.id = $1`,
            [item.projectId],
          ).catch(() => ({ rows: [] as Array<{ timezone?: string }> }));
          timezones.set(item.projectId, String(tz.rows[0]?.timezone ?? "UTC"));
        }
        const day = localDay(item.timestamp, timezones.get(item.projectId) ?? "UTC");
        if (day) {
          const set = days.get(item.projectId) ?? new Set<string>();
          set.add(day);
          days.set(item.projectId, set);
        }
        if (item.callSite) {
          const siteKey = `${item.projectId}\u0000${item.callSite}\u0000${item.model}`;
          const site = callSites.get(siteKey) ?? { projectId: item.projectId, callSite: item.callSite, model: item.model, cost: 0, count: 0 };
          site.cost += item.cost;
          site.count += 1;
          callSites.set(siteKey, site);
        }
      }
      if (callSites.size > 0) {
        const sites = [...callSites.values()];
        await pool.query(
          `UPDATE call_site_stats s
           SET total_cost_usd = s.total_cost_usd + v.cost,
               priced_calls = s.priced_calls + v.count,
               unpriced_calls = GREATEST(0, s.unpriced_calls - v.count)
           FROM unnest($1::text[], $2::text[], $3::text[], $4::float8[], $5::int[]) AS v(project_id, call_site_key, model, cost, count)
           WHERE s.project_id = v.project_id AND s.call_site_key = v.call_site_key AND s.model = v.model`,
          [sites.map((site) => site.projectId), sites.map((site) => site.callSite), sites.map((site) => site.model), sites.map((site) => site.cost), sites.map((site) => site.count)],
        ).catch((error) => console.error("[costkey] Call-site reprice error:", error));
      }
    }
    if (rows.rows.length < REPRICE_BATCH) break;
  }
  for (const [projectId, set] of days) {
    for (const day of [...set].sort()) {
      await reconcileDailyCostAggregates(pool, projectId, day, { advanceCheckpoint: false }).catch((error) => {
        const code = (error as { code?: string }).code;
        if (code !== "42P01" && code !== "42703") console.error("[costkey] Daily aggregate reprice error:", error);
      });
    }
  }
  if (updated > 0) console.log(`[costkey] Priced ${updated} previously unpriced calls`);
  return updated;
}

let lastOnDemand = 0;

/**
 * A call arrived for a model the catalog doesn't know. New models usually
 * land in the public catalogs within hours, so check again (at most every
 * 30 minutes); the sync reprices the call once a price appears.
 */
export function requestPriceRefresh(pool: pg.Pool): void {
  if (!priceSyncEnabled()) return;
  const now = Date.now();
  if (now - lastOnDemand < ON_DEMAND_COOLDOWN_MS) return;
  lastOnDemand = now;
  void syncPriceCatalog(pool, { trigger: "unpriced_model" }).catch((error) => console.error("[costkey] Price sync error:", error));
}

/** Pick up prices another instance synced. */
export async function refreshPriceCatalogIfChanged(pool: pg.Pool): Promise<void> {
  if (!priceCatalogEnabled()) return;
  const latest = await pool.query("SELECT MAX(created_at) AS latest, COUNT(*)::int AS count FROM model_prices");
  const latestAt = latest.rows[0]?.latest ? new Date(latest.rows[0].latest).getTime() : 0;
  const catalog = getPriceCatalog();
  if (latestAt > catalog.loadedAt.getTime() || Number(latest.rows[0]?.count ?? 0) + curatedPrices().length !== catalog.size) await loadPriceCatalog(pool);
}

/** Boot: seed from the snapshot if needed, load, and keep the catalog fresh. */
export async function initPriceCatalog(pool: pg.Pool, options: { schedule: boolean }): Promise<NodeJS.Timeout | null> {
  if (!priceCatalogEnabled()) return null;
  await ensurePriceCatalogSchema(pool);
  const imported = await importSnapshotSources(pool);
  const catalog = await loadPriceCatalog(pool);
  console.log(`[costkey] Price catalog: ${catalog.size} prices${imported ? ` (${imported} from the bundled snapshot)` : ""}`);
  // Calls that arrived before the catalog loaded (or before this deploy
  // knew their model) are priced now, in the background.
  void repriceUnpricedEvents(pool).catch((error) => console.error("[costkey] Reprice error:", error));
  if (!options.schedule || !priceSyncEnabled()) return null;
  const last = await pool.query("SELECT MAX(finished_at) AS finished FROM pricing_sync_runs WHERE status IN ('ok', 'partial')");
  const finished = last.rows[0]?.finished ? new Date(last.rows[0].finished).getTime() : 0;
  if (Date.now() - finished > SYNC_INTERVAL_MS) {
    void syncPriceCatalog(pool, { trigger: "startup" }).catch((error) => console.error("[costkey] Price sync error:", error));
  }
  const timer = setInterval(() => {
    void syncPriceCatalog(pool, { trigger: "schedule" }).catch((error) => console.error("[costkey] Price sync error:", error));
  }, SYNC_INTERVAL_MS);
  timer.unref();
  return timer;
}
