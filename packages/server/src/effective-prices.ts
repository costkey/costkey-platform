import { randomBytes } from "node:crypto";
import type pg from "pg";
import { reconcileDailyCostAggregates } from "./accounting.js";

export type EffectivePriceSource = "user_supplied" | "negotiated" | "provider_documentation";
export type EffectivePriceRole = "owner" | "admin" | "developer" | "viewer" | string;

export interface EffectivePriceInput {
  provider: string;
  accountScope: string;
  model?: string | null;
  nativeUnit: string;
  pricePerUnit: number;
  currency: string;
  effectiveFrom: string;
  effectiveTo?: string | null;
  source: EffectivePriceSource | string;
  version: number;
  pricingId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface EffectivePriceRow extends EffectivePriceInput {
  id: string;
  projectId: string;
  model: string | null;
  effectiveTo: string | null;
  pricingId: string | null;
  metadata: Record<string, unknown>;
  createdBy: string | null;
  updatedBy: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EffectivePriceQuery {
  provider: string;
  accountScope: string;
  model?: string | null;
  nativeUnit: string;
  currency?: string;
  at?: Date | string;
}

export interface EffectivePriceMatch {
  id: string;
  pricingId: string;
  pricePerUnit: number;
  currency: string;
  source: EffectivePriceSource | string;
  version: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  basis: "effective_price_override";
}

export interface EffectiveCostInput {
  reportedCost: number | null | undefined;
  usageValue: number | null | undefined;
  usageCurrency?: string | null;
  price: EffectivePriceMatch | null;
}

export interface EffectiveCost {
  cost: number | null;
  basis: "reported" | "estimated" | "unknown";
  source: string | null;
  pricingId: string | null;
}

export class EffectivePriceInputError extends Error {
  readonly code = "invalid_effective_price";
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = "EffectivePriceInputError";
  }
}

export class EffectivePriceConflictError extends Error {
  readonly code = "effective_price_conflict";
  readonly status = 409;

  constructor(message: string) {
    super(message);
    this.name = "EffectivePriceConflictError";
  }
}

export class EffectivePricePermissionError extends Error {
  readonly code = "effective_price_forbidden";
  readonly status = 403;

  constructor(message = "Only owners and admins can manage effective prices") {
    super(message);
    this.name = "EffectivePricePermissionError";
  }
}

function text(value: unknown, label: string, max = 160): string {
  if (typeof value !== "string") throw new EffectivePriceInputError(`${label} is required`);
  const result = value.trim();
  if (!result || result.length > max) throw new EffectivePriceInputError(`${label} is required and must be at most ${max} characters`);
  return result;
}

function optionalText(value: unknown, label: string, max = 160): string | null {
  if (value === null || value === undefined || value === "") return null;
  return text(value, label, max);
}

function dateValue(value: unknown, label: string, required: boolean): string | null {
  if (value === null || value === undefined || value === "") {
    if (required) throw new EffectivePriceInputError(`${label} is required`);
    return null;
  }
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new EffectivePriceInputError(`${label} must be a valid ISO date`);
  return date.toISOString();
}

function finiteNonNegative(value: unknown, label: string): number {
  if (typeof value === "boolean" || value === null || value === undefined || value === "") {
    throw new EffectivePriceInputError(`${label} must be a finite non-negative number`);
  }
  const result = Number(value);
  if (!Number.isFinite(result) || result < 0) throw new EffectivePriceInputError(`${label} must be a finite non-negative number`);
  return result;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value === "boolean" || value === null || value === undefined || value === "") {
    throw new EffectivePriceInputError(`${label} must be a positive integer`);
  }
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result <= 0) throw new EffectivePriceInputError(`${label} must be a positive integer`);
  return result;
}

const SOURCES = new Set<EffectivePriceSource>([
  "user_supplied", "negotiated", "provider_documentation",
]);

function sourceValue(value: unknown): EffectivePriceSource | string {
  const source = text(value, "source", 80);
  if (!SOURCES.has(source as EffectivePriceSource) && !/^[a-z][a-z0-9_-]{0,79}$/.test(source)) {
    throw new EffectivePriceInputError("source must be a stable identifier");
  }
  return source;
}

function metadataValue(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return {};
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { throw new EffectivePriceInputError("metadata must be an object"); }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new EffectivePriceInputError("metadata must be an object");
  }
  return value as Record<string, unknown>;
}

/** Normalize an override without fuzzy model aliases or implicit dates. */
export function normalizeEffectivePriceInput(input: EffectivePriceInput): EffectivePriceInput {
  const provider = text(input.provider, "provider", 120);
  const accountScope = text(input.accountScope, "accountScope", 160);
  const model = optionalText(input.model, "model", 200);
  if (model && /[*?]/.test(model)) throw new EffectivePriceInputError("model must be an exact identifier; wildcards are not allowed");
  const nativeUnit = text(input.nativeUnit, "nativeUnit", 80).toLowerCase();
  if (!/^[a-z][a-z0-9_.:-]{0,79}$/.test(nativeUnit)) {
    throw new EffectivePriceInputError("nativeUnit must be a stable exact identifier");
  }
  const pricePerUnit = finiteNonNegative(input.pricePerUnit, "pricePerUnit");
  const currency = text(input.currency, "currency", 12).toUpperCase();
  if (!/^[A-Z][A-Z0-9_-]{2,11}$/.test(currency)) throw new EffectivePriceInputError("currency must be a valid identifier");
  const effectiveFrom = dateValue(input.effectiveFrom, "effectiveFrom", true)!;
  const effectiveTo = dateValue(input.effectiveTo, "effectiveTo", false);
  if (effectiveTo && new Date(effectiveTo) <= new Date(effectiveFrom)) {
    throw new EffectivePriceInputError("effectiveTo must be later than effectiveFrom");
  }
  const source = sourceValue(input.source);
  const version = positiveInteger(input.version, "version");
  const pricingId = optionalText(input.pricingId, "pricingId", 160);
  return {
    provider,
    accountScope,
    model,
    nativeUnit,
    pricePerUnit,
    currency,
    effectiveFrom,
    effectiveTo,
    source,
    version,
    pricingId,
    metadata: metadataValue(input.metadata),
  };
}

function toDate(value: string | Date): Date | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function sameText(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a ?? null) === (b ?? null);
}

/** Two exact scopes overlap when their model selectors and half-open dates do. */
export function effectivePriceScopesOverlap(
  a: EffectivePriceInput & { revokedAt?: string | null },
  b: EffectivePriceInput & { revokedAt?: string | null },
): boolean {
  if (a.provider !== b.provider || a.accountScope !== b.accountScope
    || (a.nativeUnit ?? "").toLowerCase() !== (b.nativeUnit ?? "").toLowerCase()
    || a.currency.toUpperCase() !== b.currency.toUpperCase()) return false;
  const modelsOverlap = sameText(a.model ?? null, b.model ?? null)
    || a.model == null || b.model == null;
  if (!modelsOverlap) return false;
  const aFrom = toDate(a.effectiveFrom);
  const bFrom = toDate(b.effectiveFrom);
  const aTo = [a.effectiveTo, a.revokedAt]
    .filter((value): value is string => Boolean(value))
    .map((value) => toDate(value))
    .filter((value): value is Date => Boolean(value))
    .sort((left, right) => left.getTime() - right.getTime())[0] ?? null;
  const bTo = [b.effectiveTo, b.revokedAt]
    .filter((value): value is string => Boolean(value))
    .map((value) => toDate(value))
    .filter((value): value is Date => Boolean(value))
    .sort((left, right) => left.getTime() - right.getTime())[0] ?? null;
  if (!aFrom || !bFrom) return false;
  return (!aTo || bFrom < aTo) && (!bTo || aFrom < bTo);
}

function rowInput(row: Record<string, unknown>): EffectivePriceInput {
  return normalizeEffectivePriceInput({
    provider: String(row.provider),
    accountScope: String(row.account_scope),
    model: row.model == null ? null : String(row.model),
    nativeUnit: String(row.native_unit),
    pricePerUnit: row.price_per_unit as number,
    currency: String(row.currency),
    effectiveFrom: String(row.effective_from),
    effectiveTo: row.effective_to == null ? null : String(row.effective_to),
    source: String(row.source),
    version: row.version as number,
    pricingId: row.pricing_id == null ? null : String(row.pricing_id),
    metadata: row.metadata as Record<string, unknown> | undefined,
  });
}

function fromRow(row: Record<string, unknown>): EffectivePriceRow {
  const input = rowInput(row);
  return {
    ...input,
    id: String(row.id),
    projectId: String(row.project_id),
    model: input.model ?? null,
    effectiveTo: input.effectiveTo ?? null,
    pricingId: input.pricingId ?? null,
    metadata: input.metadata ?? {},
    createdBy: row.created_by == null ? null : String(row.created_by),
    updatedBy: row.updated_by == null ? null : String(row.updated_by),
    revokedAt: row.revoked_at == null ? null : String(row.revoked_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function selectSql(): string {
  return `SELECT ep.id, ep.project_id, ep.provider, ep.account_scope, ep.model,
                 ep.native_unit, ep.price_per_unit, ep.currency,
                 ep.effective_from, ep.effective_to, ep.source, ep.version,
                 ep.revoked_at, ep.pricing_id, ep.metadata, ep.created_by, ep.updated_by,
                 ep.created_at, ep.updated_at
          FROM effective_prices ep`;
}

function actorId(actor: { id?: string | null; role: EffectivePriceRole }): string | null {
  return actor.id ?? null;
}

function pricingLockKey(projectId: string, input: EffectivePriceInput): string {
  return JSON.stringify([projectId, input.provider, input.accountScope, input.model ?? "*", input.nativeUnit, input.currency]);
}

async function nextServerVersion(
  client: pg.Pool | pg.PoolClient,
  projectId: string,
  input: EffectivePriceInput,
): Promise<number> {
  // Serialize version allocation independently of overlap validation. The
  // unique index remains the final database fence if an old installation is
  // concurrently upgraded while this transaction is running.
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [pricingLockKey(projectId, input)]);
  const result = await client.query(
    `SELECT COALESCE(MAX(version), 0) + 1 AS next_version
     FROM effective_prices
     WHERE project_id = $1 AND provider = $2 AND account_scope = $3
       AND native_unit = $4 AND currency = $5
       AND model IS NOT DISTINCT FROM $6`,
    [projectId, input.provider, input.accountScope, input.nativeUnit, input.currency, input.model],
  );
  const version = Number(result.rows?.[0]?.next_version ?? 1);
  return Number.isSafeInteger(version) && version > 0 ? version : 1;
}

async function inTransaction<T>(pool: pg.Pool, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const connect = (pool as unknown as { connect?: () => Promise<pg.PoolClient> }).connect;
  if (!connect) {
    // Test doubles and read-only adapters may expose only query(). Production
    // pools use the transaction path below to close the overlap/write race.
    return work(pool as unknown as pg.PoolClient);
  }
  const client = await connect.call(pool);
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export function assertCanManageEffectivePrices(role: EffectivePriceRole): void {
  const normalized = String(role).toLowerCase();
  if (normalized !== "owner" && normalized !== "admin") throw new EffectivePricePermissionError();
}

async function overlappingRows(
  pool: pg.Pool | pg.PoolClient,
  projectId: string,
  input: EffectivePriceInput,
  excludeId?: string,
): Promise<EffectivePriceRow[]> {
  const params: unknown[] = [projectId, input.provider, input.accountScope, input.nativeUnit, input.currency];
  let sql = `${selectSql()}
    WHERE ep.project_id = $1 AND ep.provider = $2 AND ep.account_scope = $3
      AND ep.native_unit = $4 AND ep.currency = $5`;
  if (excludeId) {
    params.push(excludeId);
    sql += ` AND ep.id <> $${params.length}`;
  }
  const result = await pool.query(sql, params);
  return (result.rows ?? []).map((row) => fromRow(row as Record<string, unknown>));
}

async function assertNoOverlap(
  pool: pg.Pool | pg.PoolClient,
  projectId: string,
  input: EffectivePriceInput,
  excludeId?: string,
): Promise<void> {
  const rows = await overlappingRows(pool, projectId, input, excludeId);
  for (const row of rows) {
    if (row.model === (input.model ?? null) && row.version >= input.version) {
      throw new EffectivePriceConflictError(
        `Effective price version must increase within ${input.provider}/${input.accountScope}/${input.nativeUnit}`,
      );
    }
    if (effectivePriceScopesOverlap(row, input)) {
      throw new EffectivePriceConflictError(
        `Effective price overlaps ${row.id} for ${input.provider}/${input.accountScope}/${input.nativeUnit}`,
      );
    }
  }
}

export async function listEffectivePrices(pool: pg.Pool, projectId: string): Promise<EffectivePriceRow[]> {
  const result = await pool.query(
    `${selectSql()} WHERE ep.project_id = $1 ORDER BY ep.provider, ep.account_scope, ep.native_unit, ep.effective_from DESC, ep.version DESC`,
    [projectId],
  );
  return (result.rows ?? []).map((row) => fromRow(row as Record<string, unknown>));
}

export async function createEffectivePrice(
  pool: pg.Pool,
  projectId: string,
  rawInput: EffectivePriceInput,
  id: string,
  actor: { id?: string | null; role: EffectivePriceRole },
): Promise<void> {
  assertCanManageEffectivePrices(actor.role);
  let input = normalizeEffectivePriceInput(rawInput);
  await inTransaction(pool, async (client) => {
    input = { ...input, version: await nextServerVersion(client, projectId, input) };
    await assertNoOverlap(client, projectId, input);
    await client.query(
      `INSERT INTO effective_prices (
         id, project_id, provider, account_scope, model, native_unit,
         price_per_unit, currency, effective_from, effective_to, source,
         version, pricing_id, metadata, created_by, updated_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15)`,
      [id, projectId, input.provider, input.accountScope, input.model, input.nativeUnit,
        input.pricePerUnit, input.currency, input.effectiveFrom, input.effectiveTo,
        input.source, input.version, input.pricingId, JSON.stringify(input.metadata ?? {}), actorId(actor)],
    );
  });
}

/**
 * Add a new immutable version and close the previous row at its start. The
 * old row remains queryable for historical reconstruction.
 */
export async function updateEffectivePrice(
  pool: pg.Pool,
  projectId: string,
  priceId: string,
  rawInput: EffectivePriceInput,
  actor: { id?: string | null; role: EffectivePriceRole },
  replacementId = `price_${randomBytes(12).toString("hex")}`,
): Promise<string | null> {
  assertCanManageEffectivePrices(actor.role);
  return inTransaction(pool, async (client) => {
    const existingResult = await client.query(`${selectSql()} WHERE ep.project_id = $1 AND ep.id = $2 FOR UPDATE`, [projectId, priceId]);
    if (!existingResult.rows?.[0]) return null;
    const existing = fromRow(existingResult.rows[0] as Record<string, unknown>);
    let input = normalizeEffectivePriceInput(rawInput);
    if (input.provider !== existing.provider || input.accountScope !== existing.accountScope
      || input.model !== existing.model || input.nativeUnit !== existing.nativeUnit
      || input.currency !== existing.currency) {
      throw new EffectivePriceInputError("An update cannot change the pricing scope; create a separate rate instead");
    }
    if (new Date(input.effectiveFrom) <= new Date(existing.effectiveFrom)) {
      throw new EffectivePriceInputError("A new effective-price version must start after the prior version");
    }
    input = { ...input, version: await nextServerVersion(client, projectId, input) };
    await assertNoOverlap(client, projectId, input, priceId);
    await client.query(
      `UPDATE effective_prices ep
       SET effective_to = CASE
             WHEN ep.effective_to IS NULL OR ep.effective_to > $1 THEN $1
             ELSE ep.effective_to
           END,
           updated_by = $2, updated_at = NOW()
       WHERE ep.project_id = $3 AND ep.id = $4
         AND ep.effective_from < $1`,
      [input.effectiveFrom, actorId(actor), projectId, priceId],
    );
    await client.query(
      `INSERT INTO effective_prices (
         id, project_id, provider, account_scope, model, native_unit,
         price_per_unit, currency, effective_from, effective_to, source,
         version, pricing_id, metadata, created_by, updated_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15)`,
      [replacementId, projectId, input.provider, input.accountScope, input.model, input.nativeUnit,
        input.pricePerUnit, input.currency, input.effectiveFrom, input.effectiveTo,
        input.source, input.version, input.pricingId, JSON.stringify(input.metadata ?? {}), actorId(actor)],
    );
    return replacementId;
  });
}

/** Delete is a revocation: close the interval and retain the audit row. */
export async function deleteEffectivePrice(
  pool: pg.Pool,
  projectId: string,
  priceId: string,
  actor: { id?: string | null; role: EffectivePriceRole },
  at = new Date(),
): Promise<boolean> {
  assertCanManageEffectivePrices(actor.role);
  if (Number.isNaN(at.getTime())) throw new EffectivePriceInputError("revocation date is invalid");
  const result = await pool.query(
    `UPDATE effective_prices ep
     SET revoked_at = $1,
         updated_by = $2, updated_at = NOW()
     WHERE ep.project_id = $3 AND ep.id = $4
     RETURNING ep.id`,
    [at.toISOString(), actorId(actor), projectId, priceId],
  );
  return (result.rows ?? []).length > 0;
}

export async function resolveEffectivePrice(
  pool: pg.Pool | pg.PoolClient,
  projectId: string,
  rawQuery: EffectivePriceQuery,
): Promise<EffectivePriceMatch | null> {
  const provider = text(rawQuery.provider, "provider", 120);
  const accountScope = text(rawQuery.accountScope, "accountScope", 160);
  const model = optionalText(rawQuery.model, "model", 200);
  if (model && /[*?]/.test(model)) return null;
  const nativeUnit = text(rawQuery.nativeUnit, "nativeUnit", 80).toLowerCase();
  const currency = (rawQuery.currency ?? "USD").toUpperCase();
  const at = toDate(rawQuery.at ?? new Date());
  if (!at || !/^[A-Z][A-Z0-9_-]{2,11}$/.test(currency)) return null;
  const result = await pool.query(
    `${selectSql()}
     WHERE ep.project_id = $1 AND ep.provider = $2 AND ep.account_scope = $3
       AND ep.native_unit = $4 AND ep.currency = $5
       AND ep.effective_from <= $6
       AND (ep.effective_to IS NULL OR $6 < ep.effective_to)
       AND (ep.revoked_at IS NULL OR $6 < ep.revoked_at)
       AND (ep.model = $7 OR ep.model IS NULL)
     ORDER BY CASE WHEN ep.model IS NULL THEN 1 ELSE 0 END,
              ep.effective_from DESC, ep.version DESC`,
    [projectId, provider, accountScope, nativeUnit, currency, at.toISOString(), model],
  );
  const rows = (result.rows ?? []).map((row) => fromRow(row as Record<string, unknown>));
  if (rows.length !== 1) return null;
  const row = rows[0];
  return {
    id: row.id,
    pricingId: row.pricingId ?? `${row.id}@v${row.version}`,
    pricePerUnit: row.pricePerUnit,
    currency: row.currency,
    source: row.source,
    version: row.version,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
    basis: "effective_price_override",
  };
}

interface HistoricalRepriceResult {
  updatedCount: number;
  reconciledDays: string[];
  hasMore: boolean;
}

const REPRICE_BATCH_SIZE = 500;

function accountScopeSql(alias: string): string {
  return `COALESCE(${alias}.context->>'accountScope', ${alias}.context->>'account_scope', ${alias}.context->>'billingAccount', ${alias}.context->>'billing_account')`;
}

function localDay(value: unknown, timezone: string): string | null {
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  return year && month && day ? `${year}-${month}-${day}` : null;
}

function eventUnits(row: Record<string, unknown>): Array<{ unit: string; value: number }> {
  const fields: Array<[string, unknown]> = [
    ["input_tokens", row.input_tokens],
    ["output_tokens", row.output_tokens],
    ["reasoning_tokens", row.reasoning_tokens],
    ["cache_read_tokens", row.cache_read_tokens],
    ["cache_creation_tokens", row.cache_creation_tokens],
    ["image_output_tokens", row.image_output_tokens],
  ];
  return fields.filter(([, value]) => typeof value === "number" && Number.isFinite(value) && value >= 0)
    .map(([unit, value]) => ({ unit, value: value as number }));
}

/**
 * Reprice a bounded batch of historical unknown observations after a new
 * effective price becomes active. Provider-reported amounts are excluded and
 * every observed billable unit must resolve before an event is updated.
 */
export async function repriceHistoricalForEffectivePrice(
  pool: pg.Pool,
  projectId: string,
  priceId: string,
): Promise<HistoricalRepriceResult> {
  const client = await pool.connect();
  let updatedCount = 0;
  const days = new Set<string>();
  let hasMore = false;
  let timezone = "UTC";
  try {
    await client.query("BEGIN");
    const priceResult = await client.query(`${selectSql()} WHERE ep.project_id = $1 AND ep.id = $2 FOR UPDATE`, [projectId, priceId]);
    if (!priceResult.rows?.[0]) {
      await client.query("ROLLBACK");
      return { updatedCount: 0, reconciledDays: [], hasMore: false };
    }
    const price = fromRow(priceResult.rows[0] as Record<string, unknown>);
    const settings = await client.query(
      `SELECT COALESCE(ws.timezone, 'UTC') AS timezone
       FROM projects p LEFT JOIN workspace_settings ws ON ws.org_id = p.org_id
       WHERE p.id = $1`,
      [projectId],
    ).catch(() => ({ rows: [] as Array<{ timezone?: string }> }));
    timezone = String(settings.rows[0]?.timezone ?? "UTC");
    try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(); } catch { timezone = "UTC"; }
    const eventCandidates = await client.query(
      `SELECT e.id, e.timestamp, e.provider, e.model, e.cost_usd,
              e.input_tokens, e.output_tokens, e.reasoning_tokens,
              e.cache_read_tokens, e.cache_creation_tokens, e.image_output_tokens
       FROM events e
       WHERE e.project_id = $1
         AND e.cost_usd IS NULL
         AND COALESCE(e.cost_basis, 'unknown') <> 'reported'
         AND e.provider = $2
         AND ${accountScopeSql("e")} = $3
         AND ($4::text IS NULL OR e.model = $4)
         AND e.timestamp >= $5
         AND (e.timestamp < $6 OR $6 IS NULL)
         AND NOT (e.provider = 'openrouter' AND jsonb_typeof(e.response_body->'usage'->'cost') = 'number')
         AND e.id >= ''
       ORDER BY e.id ASC
       LIMIT $7`,
      [projectId, price.provider, price.accountScope, price.model, price.effectiveFrom, price.effectiveTo, REPRICE_BATCH_SIZE],
    );
    if (eventCandidates.rows.length === REPRICE_BATCH_SIZE) hasMore = true;
    for (const raw of eventCandidates.rows as Array<Record<string, unknown>>) {
      const units = eventUnits(raw);
      if (!units.some((unit) => unit.unit === price.nativeUnit)) continue;
      const matches = await Promise.all(units.map(async (unit) => ({
        unit,
        match: await resolveEffectivePrice(client, projectId, {
          provider: price.provider,
          accountScope: price.accountScope,
          model: price.model,
          nativeUnit: unit.unit,
          currency: "USD",
          at: raw.timestamp as string,
        }),
      })));
      if (matches.some((item) => item.match === null)) continue;
      let cost = 0;
      const ids = new Set<string>();
      let pricingDate: string | null = null;
      for (const item of matches) {
        const amount = item.unit.value * (item.match?.pricePerUnit ?? 0);
        if (!Number.isFinite(amount) || amount < 0) { cost = NaN; break; }
        cost += amount;
        if (item.match?.pricingId) ids.add(item.match.pricingId);
        if (item.match?.effectiveFrom && (!pricingDate || item.match.effectiveFrom < pricingDate)) pricingDate = item.match.effectiveFrom;
      }
      if (!Number.isFinite(cost)) continue;
      const updated = await client.query(
        `UPDATE events
         SET cost_usd = $1, cost_basis = 'estimated', cost_source = 'effective_price_override',
             pricing_id = $2, pricing_date = $3, cost_currency = 'USD'
         WHERE project_id = $4 AND id = $5 AND cost_usd IS NULL
         RETURNING timestamp`,
        [cost, [...ids].sort().join(",") || `${price.id}@v${price.version}`, pricingDate, projectId, raw.id],
      );
      if (updated.rows.length > 0) {
        updatedCount++;
        const day = localDay(updated.rows[0].timestamp, timezone);
        if (day) days.add(day);
      }
    }

    const usageCandidates = await client.query(
      `SELECT u.id, u.observed_at, u.accounting_at, u.provider, u.model, u.unit_kind, u.unit_value
       FROM usage_components u
       WHERE u.project_id = $1 AND u.amount IS NULL AND u.active = TRUE
         AND UPPER(u.currency) = 'USD' AND u.provider = $2
         AND ${accountScopeSql("u")} = $3
         AND ($4::text IS NULL OR u.model = $4)
         AND COALESCE(u.accounting_at, u.observed_at) >= $5
         AND (COALESCE(u.accounting_at, u.observed_at) < $6 OR $6 IS NULL)
         AND u.unit_kind = $7 AND u.unit_value IS NOT NULL
       ORDER BY u.id ASC LIMIT $8`,
      [projectId, price.provider, price.accountScope, price.model, price.effectiveFrom, price.effectiveTo, price.nativeUnit, REPRICE_BATCH_SIZE],
    );
    if (usageCandidates.rows.length === REPRICE_BATCH_SIZE) hasMore = true;
    const amount = (price.pricePerUnit * 1);
    for (const raw of usageCandidates.rows as Array<Record<string, unknown>>) {
      const units = Number(raw.unit_value);
      const cost = units * amount;
      if (!Number.isFinite(cost) || cost < 0) continue;
      const updated = await client.query(
        `UPDATE usage_components
         SET amount = $1, amount_kind = 'estimated', pricing_id = $2, updated_at = NOW()
         WHERE project_id = $3 AND id = $4 AND amount IS NULL AND active = TRUE
         RETURNING COALESCE(accounting_at, observed_at) AS accounted_at`,
        [cost, price.pricingId ?? `${price.id}@v${price.version}`, projectId, raw.id],
      );
      if (updated.rows.length > 0) {
        updatedCount++;
        const day = localDay(updated.rows[0].accounted_at, timezone);
        if (day) days.add(day);
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  const reconciledDays = [...days].sort();
  for (const day of reconciledDays) {
    await reconcileDailyCostAggregates(pool, projectId, day, { advanceCheckpoint: false }).catch((error) => {
      const code = (error as { code?: string }).code;
      if (code !== "42P01" && code !== "42703") throw error;
    });
  }
  return { updatedCount, reconciledDays, hasMore };
}

/** Preserve provider-reported charges; use an override only for unknown cost. */
export function applyEffectivePrice(input: EffectiveCostInput): EffectiveCost {
  if (input.reportedCost !== null && input.reportedCost !== undefined) {
    if (Number.isFinite(input.reportedCost) && input.reportedCost >= 0) {
      return { cost: input.reportedCost, basis: "reported", source: "provider", pricingId: null };
    }
    return { cost: null, basis: "unknown", source: null, pricingId: null };
  }
  const usage = input.usageValue;
  if (!input.price || usage === null || usage === undefined || !Number.isFinite(usage) || usage < 0) {
    return { cost: null, basis: "unknown", source: null, pricingId: null };
  }
  if (input.usageCurrency && input.usageCurrency.toUpperCase() !== input.price.currency.toUpperCase()) {
    return { cost: null, basis: "unknown", source: null, pricingId: null };
  }
  const cost = usage * input.price.pricePerUnit;
  if (!Number.isFinite(cost) || cost < 0) return { cost: null, basis: "unknown", source: null, pricingId: null };
  return {
    cost,
    basis: "estimated",
    source: input.price.source,
    pricingId: input.price.pricingId,
  };
}
