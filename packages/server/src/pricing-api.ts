import { randomBytes } from "node:crypto";
import { Router, type Request, type Response } from "express";
import type pg from "pg";
import { requireAuth } from "./auth.js";
import { invalidateProjectPrices } from "./billing.js";
import { createEffectivePrice, EffectivePriceConflictError, EffectivePriceInputError, EffectivePricePermissionError, updateEffectivePrice } from "./effective-prices.js";
import { orgScope } from "./middleware.js";
import { roleCanManageWorkspace } from "./permissions.js";
import { getPriceCatalog, modelVendor, providerChain } from "./price-catalog/catalog.js";
import { ensurePriceCatalogSchema, priceCatalogEnabled, PRICE_SOURCES, repriceUnpricedEvents, syncPriceCatalog } from "./price-catalog/sync.js";
import type { PriceRates } from "./price-catalog/types.js";

/** Rates a person can set for a model, and the effective-price unit each one writes. */
const RATE_FIELDS: Record<string, { unit: string; scale: number }> = {
  inputPerMillion: { unit: "input_tokens", scale: 1 / 1_000_000 },
  outputPerMillion: { unit: "output_tokens", scale: 1 / 1_000_000 },
  cachedInputPerMillion: { unit: "cache_read_tokens", scale: 1 / 1_000_000 },
  cacheWritePerMillion: { unit: "cache_creation_tokens", scale: 1 / 1_000_000 },
  perThousandCharacters: { unit: "characters", scale: 1 / 1000 },
  perMinute: { unit: "audio_seconds", scale: 1 / 60 },
  perCredit: { unit: "credits", scale: 1 },
  perThousandQueries: { unit: "search_queries", scale: 1 / 1000 },
  perThousandPages: { unit: "pages", scale: 1 / 1000 },
  perImage: { unit: "images", scale: 1 },
  perRequest: { unit: "requests", scale: 1 },
};

const SYNC_COOLDOWN_MS = 10 * 60 * 1000;
let lastManualSync = 0;

function actor(req: Request): { id: string | null; role: string } {
  const user = ((req as unknown as { user?: { id?: string; role?: string } }).user ?? {});
  return { id: user.id ?? null, role: user.role ?? "viewer" };
}

function text(value: unknown, max = 200): string | null {
  return typeof value === "string" && value.trim() && value.trim().length <= max ? value.trim() : null;
}

/** Display rates per million tokens / per thousand units. */
function displayRates(rates: PriceRates): Record<string, number> {
  const out: Record<string, number> = {};
  if (rates.input !== undefined) out["inputPerMillion"] = rates.input * 1_000_000;
  if (rates.output !== undefined) out["outputPerMillion"] = rates.output * 1_000_000;
  if (rates.cacheRead !== undefined) out["cachedInputPerMillion"] = rates.cacheRead * 1_000_000;
  if (rates.perCharacter !== undefined) out["perThousandCharacters"] = rates.perCharacter * 1000;
  if (rates.perSecond !== undefined) out["perMinute"] = rates.perSecond * 60;
  if (rates.perQuery !== undefined) out["perThousandQueries"] = rates.perQuery * 1000;
  if (rates.perCredit !== undefined) out["perCredit"] = rates.perCredit;
  if (rates.perPage !== undefined) out["perThousandPages"] = rates.perPage * 1000;
  if (rates.perRequest !== undefined) out["perRequest"] = rates.perRequest;
  return out;
}

export function createPricingRouter(pool: pg.Pool): Router {
  const router = Router();
  let schema: Promise<void> | null = null;
  const ready = () => (schema ??= ensurePriceCatalogSchema(pool).catch((error) => { schema = null; throw error; }));

  router.use("/api/v1/pricing", requireAuth);
  router.use("/api/v1/projects/:projectId/pricing", requireAuth, orgScope(pool));

  router.get("/api/v1/pricing/catalog", async (_req: Request, res: Response) => {
    try {
      await ready();
      const last = await pool.query(
        `SELECT id, trigger, status, sources, added, changed, repriced, disagreements, started_at, finished_at
         FROM pricing_sync_runs WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1`,
      );
      const catalog = getPriceCatalog();
      res.json({
        enabled: priceCatalogEnabled(),
        prices: catalog.size,
        loadedAt: catalog.loadedAt.getTime() > 0 ? catalog.loadedAt.toISOString() : null,
        sources: PRICE_SOURCES.map(({ source, url }) => ({ source, url })),
        lastSync: last.rows[0] ?? null,
      });
    } catch (error) {
      console.error("[costkey] Price catalog status error:", error);
      res.status(500).json({ error: "Couldn't read the price catalog" });
    }
  });

  router.post("/api/v1/pricing/catalog/sync", async (req: Request, res: Response) => {
    if (!roleCanManageWorkspace(actor(req).role)) { res.status(403).json({ error: "Only owners and admins can refresh prices" }); return; }
    if (!priceCatalogEnabled()) { res.status(409).json({ error: "The price catalog is turned off on this server" }); return; }
    if (Date.now() - lastManualSync < SYNC_COOLDOWN_MS) { res.status(429).json({ error: "Prices were refreshed a few minutes ago" }); return; }
    lastManualSync = Date.now();
    try {
      await ready();
      res.json(await syncPriceCatalog(pool, { trigger: "manual" }));
    } catch (error) {
      console.error("[costkey] Manual price sync error:", error);
      res.status(500).json({ error: "Couldn't refresh prices" });
    }
  });

  /** Catalog models a project model can be priced as. */
  router.get("/api/v1/pricing/models", (req: Request, res: Response) => {
    const provider = text(req.query["provider"], 80) ?? "";
    const query = (text(req.query["q"], 120) ?? "").toLowerCase();
    const chain = provider ? providerChain(provider) : [];
    const vendor = query ? modelVendor(query)?.vendor : undefined;
    const providers = [...new Set([...chain, ...(vendor ? [vendor] : [])])];
    const models = getPriceCatalog().search(providers, query, 20).map((price) => ({
      provider: price.provider, model: price.model, source: price.source, rates: displayRates(price.rates),
    }));
    res.json({ models });
  });

  router.get("/api/v1/projects/:projectId/pricing/unpriced", async (req: Request, res: Response) => {
    try {
      const days = Math.min(365, Math.max(1, Number(req.query["days"]) || 90));
      const result = await pool.query(
        `SELECT e.provider, COALESCE(e.model, e.request_model) AS model,
                COUNT(*)::int AS calls, MIN(e.timestamp) AS first_seen, MAX(e.timestamp) AS last_seen,
                BOOL_OR(COALESCE(e.input_tokens, 0) + COALESCE(e.output_tokens, 0) > 0) AS has_tokens,
                ARRAY_REMOVE(ARRAY_AGG(DISTINCT u.units), NULL) AS unit_sets
         FROM events e
         LEFT JOIN LATERAL (
           SELECT string_agg(k, ',' ORDER BY k) AS units
           FROM jsonb_object_keys(CASE WHEN jsonb_typeof(e.native_units) = 'object' THEN e.native_units ELSE '{}'::jsonb END) k
         ) u ON TRUE
         WHERE e.project_id = $1 AND e.cost_usd IS NULL
           AND COALESCE(e.event_type, 'call') = 'call'
           AND e.timestamp >= NOW() - ($2::int * INTERVAL '1 day')
         GROUP BY 1, 2
         ORDER BY calls DESC
         LIMIT 50`,
        [req.params["projectId"], days],
      );
      res.json({
        models: result.rows.map((row) => ({
          provider: row.provider,
          model: row.model,
          calls: row.calls,
          firstSeen: row.first_seen,
          lastSeen: row.last_seen,
          units: [...new Set([
            ...(row.has_tokens ? ["tokens"] : []),
            ...((row.unit_sets ?? []) as string[]).flatMap((set) => set.split(",")).filter((unit) => unit !== "searchResults"),
          ])],
        })),
      });
    } catch (error) {
      console.error("[costkey] Unpriced models error:", error);
      res.status(500).json({ error: "Couldn't list unpriced models" });
    }
  });

  /** Price a project's model as a catalog model (an Azure deployment name, a proxy route). */
  router.post("/api/v1/projects/:projectId/pricing/aliases", async (req: Request, res: Response) => {
    const projectId = req.params["projectId"] as string;
    if (!roleCanManageWorkspace(actor(req).role)) { res.status(403).json({ error: "Only owners and admins can set prices" }); return; }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const provider = text(body["provider"], 80);
    const model = text(body["model"]);
    const targetModel = text(body["targetModel"]);
    if (!provider || !model || !targetModel) { res.status(400).json({ error: "provider, model and targetModel are required" }); return; }
    if (!getPriceCatalog().resolve({ provider, model: targetModel })) { res.status(400).json({ error: `${targetModel} has no catalog price` }); return; }
    try {
      await ready();
      await pool.query(
        `INSERT INTO model_aliases (project_id, provider, model, target_model, created_by)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (project_id, provider, model) DO UPDATE SET target_model = EXCLUDED.target_model, created_by = EXCLUDED.created_by, created_at = NOW()`,
        [projectId, provider, model, targetModel, actor(req).id],
      );
      invalidateProjectPrices(projectId);
      res.json({ provider, model, targetModel, repriced: await repriceUnpricedEvents(pool, { projectId }) });
    } catch (error) {
      console.error("[costkey] Model alias error:", error);
      res.status(500).json({ error: "Couldn't save the model mapping" });
    }
  });

  /** Set a project's own rates for a model; history without a price is repriced. */
  router.post("/api/v1/projects/:projectId/pricing/rates", async (req: Request, res: Response) => {
    const projectId = req.params["projectId"] as string;
    const who = actor(req);
    if (!roleCanManageWorkspace(who.role)) { res.status(403).json({ error: "Only owners and admins can set prices" }); return; }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const provider = text(body["provider"], 80);
    const model = text(body["model"]);
    const rates = body["rates"] && typeof body["rates"] === "object" ? body["rates"] as Record<string, unknown> : {};
    const entries = Object.entries(rates)
      .filter(([field, value]) => RATE_FIELDS[field] && value !== null && value !== "" && value !== undefined)
      .map(([field, value]) => ({ field, value: Number(value) }));
    if (!provider || !model) { res.status(400).json({ error: "provider and model are required" }); return; }
    if (entries.length === 0 || entries.some((entry) => !Number.isFinite(entry.value) || entry.value < 0)) {
      res.status(400).json({ error: "Enter at least one rate, as a number zero or above" });
      return;
    }
    // Cached input is billed at the input rate unless a rate is given.
    if (entries.some((entry) => entry.field === "inputPerMillion") && !entries.some((entry) => entry.field === "cachedInputPerMillion")) {
      entries.push({ field: "cachedInputPerMillion", value: entries.find((entry) => entry.field === "inputPerMillion")!.value });
    }
    try {
      const existing = await pool.query(
        `SELECT id, native_unit FROM effective_prices
         WHERE project_id = $1 AND provider = $2 AND account_scope = '*' AND model = $3
           AND currency = 'USD' AND revoked_at IS NULL AND effective_to IS NULL`,
        [projectId, provider, model],
      );
      const current = new Map(existing.rows.map((row) => [String(row.native_unit), String(row.id)]));
      const now = new Date().toISOString();
      for (const entry of entries) {
        const spec = RATE_FIELDS[entry.field]!;
        const input = {
          provider, accountScope: "*", model, nativeUnit: spec.unit, pricePerUnit: entry.value * spec.scale,
          currency: "USD", source: "user_supplied", version: 1, metadata: { setFrom: "unpriced_models" },
        };
        const previous = current.get(spec.unit);
        // The first price covers all history; a later change starts now.
        if (previous) await updateEffectivePrice(pool, projectId, previous, { ...input, effectiveFrom: now }, who);
        else await createEffectivePrice(pool, projectId, { ...input, effectiveFrom: "1970-01-01T00:00:00.000Z" }, `price_${randomBytes(12).toString("hex")}`, who);
      }
      invalidateProjectPrices(projectId);
      res.json({ provider, model, repriced: await repriceUnpricedEvents(pool, { projectId }) });
    } catch (error) {
      if (error instanceof EffectivePriceInputError || error instanceof EffectivePriceConflictError || error instanceof EffectivePricePermissionError) {
        res.status(error.status).json({ error: error.message, code: error.code });
        return;
      }
      console.error("[costkey] Project rates error:", error);
      res.status(500).json({ error: "Couldn't save the rates" });
    }
  });

  return router;
}
