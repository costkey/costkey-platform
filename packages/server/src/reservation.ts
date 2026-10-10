import type pg from "pg";

/**
 * Reservation accounting is deliberately separate from policy matching.
 * A policy admission may reserve more than one line (for example a project
 * allowance and a model allowance), and every line must be committed or
 * rejected as one operation.
 */

export type ReservationOutcome = "success" | "failed" | "cancelled" | "unknown";
export type ReservationState = "reserved" | "unknown" | "settled" | "released";

export interface ReservationLineInput {
  policyId: string;
  windowKey: string;
  unit: "money" | "calls" | "tokens";
  currency?: "USD" | "INR";
  /** USD -> currency basis captured at admission (server-owned). */
  currencyRate?: number;
  currencySource?: string | null;
  currencyAsOf?: string | null;
  /** The server-verified quantity to hold. */
  quantity: number;
  /** Policy limit in the line's accounting currency/unit. */
  limit: number;
  /** Optional policy revision; policy edits are prospective while usage carries. */
  policyVersion?: string | number | null;
}

export interface ReservationLine extends ReservationLineInput {
  reservedQuantity: number;
  settledQuantity: number;
}

export interface ReservationRecord {
  reservationId: string;
  projectId: string;
  admissionId: string;
  requestId: string | null;
  fingerprint: string;
  state: ReservationState;
  reservedAt: string;
  settledAt: string | null;
  settlementId: string | null;
  /** Fingerprint of the accepted settlement payload, if any. */
  settlementFingerprint?: string | null;
  outcome: ReservationOutcome | null;
  lines: ReservationLine[];
}

export interface DecisionRecord {
  projectId: string;
  admissionId: string;
  requestId: string | null;
  fingerprint: string;
  decision: "allow" | "refuse";
  /** The limiting policy for a refusal; null for an allow spanning policies. */
  policyId?: string | null;
  policyVersion?: number | null;
  reservationId: string | null;
  refusal: {
    reason: string;
    policyId?: string;
    policyVersion?: number | null;
    message: string;
    retryAt?: string | null;
    scope?: unknown;
    allowance?: unknown;
    window?: unknown;
  } | null;
  createdAt: string;
}

export interface ReservationRequest {
  projectId: string;
  admissionId: string;
  requestId?: string | null;
  fingerprint: string;
  lines: ReservationLineInput[];
  now?: Date;
}

export interface ObservedReservationUsage {
  observationId: string;
  policyId: string;
  windowKey: string;
  unit: ReservationLineInput["unit"];
  currency?: ReservationLineInput["currency"];
  quantity: number | null;
  unknown?: boolean;
  limit: number;
  occurredAt?: Date;
}

export interface ReservationResult {
  reservation: ReservationRecord;
  replay: boolean;
}

export interface SettlementLineInput {
  policyId: string;
  /** Actual quantity in the policy line's unit/currency. */
  quantity: number;
}

export interface SettlementRequest {
  projectId: string;
  reservationId: string;
  settlementId: string;
  outcome: ReservationOutcome;
  actualLines?: SettlementLineInput[];
  /** Required false to release a failed/cancelled call without charges. */
  providerAttempted?: boolean;
  now?: Date;
  fingerprint?: string;
}

export interface SettlementResult {
  reservation: ReservationRecord;
  replay: boolean;
  /** Actual quantity over the reserved amount; the provider call already ran. */
  overrun: Array<{ policyId: string; quantity: number }>;
}

export interface ReservationStore {
  getDecision(projectId: string, admissionId: string, requestId?: string | null): Promise<DecisionRecord | null>;
  recordDecision(record: DecisionRecord): Promise<DecisionRecord>;
  reserve(request: ReservationRequest): Promise<ReservationResult>;
  settle(request: SettlementRequest): Promise<SettlementResult>;
  getReservation(projectId: string, reservationId: string): Promise<ReservationRecord | null>;
  /** Optional because old test doubles need not implement observed backfill. */
  recordObserved?(usage: ObservedReservationUsage): Promise<{ recorded: boolean }>;
}

export class ReservationConflictError extends Error {
  readonly code = "COSTKEY_RESERVATION_IDEMPOTENCY_CONFLICT";

  constructor(message: string) {
    super(message);
    this.name = "ReservationConflictError";
  }
}

export class ReservationCapacityError extends Error {
  readonly code = "COSTKEY_RESERVATION_CAPACITY";
  readonly policyId: string;
  readonly windowKey: string;
  readonly limit: number;
  readonly current: number;
  readonly requested: number;

  constructor(input: {
    policyId: string;
    windowKey: string;
    limit: number;
    current: number;
    requested: number;
  }) {
    super(`Policy ${input.policyId} has ${input.current} of ${input.limit} reserved/settled; ${input.requested} more is not available`);
    this.name = "ReservationCapacityError";
    this.policyId = input.policyId;
    this.windowKey = input.windowKey;
    this.limit = input.limit;
    this.current = input.current;
    this.requested = input.requested;
  }
}

export class SettlementConflictError extends Error {
  readonly code = "COSTKEY_SETTLEMENT_IDEMPOTENCY_CONFLICT";

  constructor(message: string) {
    super(message);
    this.name = "SettlementConflictError";
  }
}

export class SettlementNotFoundError extends Error {
  readonly code = "COSTKEY_SETTLEMENT_NOT_FOUND";

  constructor(message: string) {
    super(message);
    this.name = "SettlementNotFoundError";
  }
}

function clone<T>(value: T): T {
  // Public records only contain JSON data. Cloning prevents callers from
  // mutating the ledger while a later settlement is being evaluated.
  return JSON.parse(JSON.stringify(value)) as T;
}

function requireFiniteQuantity(quantity: number, name: string): void {
  if (!Number.isFinite(quantity) || quantity < 0) {
    throw new TypeError(`${name} must be a finite non-negative number`);
  }
}

function reservationKey(projectId: string, admissionId: string): string {
  return `${projectId}\u0000${admissionId}`;
}

function requestKey(projectId: string, requestId: string): string {
  return `${projectId}\u0000${requestId}`;
}

function settlementPayloadFingerprint(request: SettlementRequest): string {
  return request.fingerprint ?? JSON.stringify({
    outcome: request.outcome,
    actualLines: request.actualLines ?? [],
    providerAttempted: request.providerAttempted ?? null,
  });
}

function settlementNeedsReconciliation(
  request: SettlementRequest,
  record: ReservationRecord,
  actual: Map<string, number>,
): boolean {
  if (request.outcome === "success") return record.lines.some((line) => !actual.has(line.policyId));
  if (request.outcome === "failed" || request.outcome === "cancelled") {
    return request.providerAttempted !== false && record.lines.some((line) => !actual.has(line.policyId));
  }
  return false;
}

/**
 * A small serialized critical section for deterministic local tests.
 *
 * ponytail: one process-wide lock is intentionally test-only; production
 * uses Postgres row locks through PostgresReservationStore. Do not use this
 * implementation as a worker-local enforcement pool.
 */
class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(fn: () => Promise<T> | T): Promise<T> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => { release = resolve; });
    const previous = this.tail;
    this.tail = next;
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

interface UsageCell {
  policyId: string;
  windowKey: string;
  unit: ReservationLineInput["unit"];
  currency: ReservationLineInput["currency"];
  limit: number;
  reserved: number;
  settled: number;
  observed: number;
  unknown: number;
}

/**
 * In-memory implementation used by public-seam tests and local development.
 * It has the same idempotency and no-TTL semantics as the database adapter.
 */
export class InMemoryReservationStore implements ReservationStore {
  private readonly mutex = new AsyncMutex();
  private readonly decisions = new Map<string, DecisionRecord>();
  private readonly decisionsByRequest = new Map<string, DecisionRecord>();
  private readonly reservations = new Map<string, ReservationRecord>();
  private readonly usage = new Map<string, UsageCell>();
  private readonly observedIds = new Set<string>();
  private readonly observedPayloads = new Map<string, { quantity: number | null; unknown: boolean }>();

  async getDecision(projectId: string, admissionId: string, requestId?: string | null): Promise<DecisionRecord | null> {
    return this.mutex.run(() => {
      const byAdmission = this.decisions.get(reservationKey(projectId, admissionId));
      if (byAdmission) return clone(byAdmission);
      if (requestId) return clone(this.decisionsByRequest.get(requestKey(projectId, requestId)) ?? null);
      return null;
    });
  }

  async recordDecision(record: DecisionRecord): Promise<DecisionRecord> {
    return this.mutex.run(() => {
      const key = reservationKey(record.projectId, record.admissionId);
      const existing = this.decisions.get(key);
      if (existing) {
        if (existing.fingerprint !== record.fingerprint) {
          throw new ReservationConflictError(`Admission ${record.admissionId} was already used with different input`);
        }
        return clone(existing);
      }
      if (record.requestId) {
        const requestExisting = this.decisionsByRequest.get(requestKey(record.projectId, record.requestId));
        if (requestExisting) {
          if (requestExisting.fingerprint !== record.fingerprint) {
            throw new ReservationConflictError(`Request ${record.requestId} was already used with different input`);
          }
          return clone(requestExisting);
        }
        this.decisionsByRequest.set(requestKey(record.projectId, record.requestId), clone(record));
      }
      this.decisions.set(key, clone(record));
      return clone(record);
    });
  }

  async reserve(request: ReservationRequest): Promise<ReservationResult> {
    return this.mutex.run(() => {
      if (!request.projectId || !request.admissionId || !request.fingerprint) {
        throw new TypeError("projectId, admissionId and fingerprint are required");
      }
      const key = reservationKey(request.projectId, request.admissionId);
      const existing = this.reservations.get(key);
      if (existing) {
        if (existing.fingerprint !== request.fingerprint) {
          throw new ReservationConflictError(`Admission ${request.admissionId} was already reserved with different input`);
        }
        return { reservation: clone(existing), replay: true };
      }
      if (request.requestId) {
        const duplicate = [...this.reservations.values()].find(
          (row) => row.projectId === request.projectId && row.requestId === request.requestId,
        );
        if (duplicate) {
          if (duplicate.fingerprint !== request.fingerprint) {
            throw new ReservationConflictError(`Request ${request.requestId} was already reserved with different input`);
          }
          return { reservation: clone(duplicate), replay: true };
        }
      }

      // Collapse duplicate policy/window lines before checking capacity. This
      // keeps one admission atomic even when a caller accidentally repeats a
      // policy in its request.
      const aggregated = new Map<string, ReservationLineInput>();
      for (const line of request.lines) {
        const key = `${line.policyId}\u0000${line.windowKey}`;
        const existing = aggregated.get(key);
        if (!existing) aggregated.set(key, { ...line });
        else {
          if (existing.unit !== line.unit || existing.currency !== line.currency || existing.limit !== line.limit) {
            throw new ReservationConflictError(`Conflicting accounting definitions for policy ${line.policyId}/${line.windowKey}`);
          }
          existing.quantity += line.quantity;
        }
      }

      const lines = [...aggregated.values()].map((line) => {
        if (!line.policyId || !line.windowKey) throw new TypeError("reservation policyId and windowKey are required");
        requireFiniteQuantity(line.quantity, "reservation quantity");
        requireFiniteQuantity(line.limit, "reservation limit");
        const usageKey = `${line.policyId}\u0000${line.windowKey}`;
        let cell = this.usage.get(usageKey);
        if (!cell) {
          cell = {
            policyId: line.policyId,
            windowKey: line.windowKey,
            unit: line.unit,
            currency: line.currency,
            limit: line.limit,
            reserved: 0,
            settled: 0,
            observed: 0,
            unknown: 0,
          };
          this.usage.set(usageKey, cell);
        } else if (cell.unit !== line.unit || cell.currency !== line.currency) {
          throw new ReservationConflictError(`Accounting definition changed for policy ${line.policyId}/${line.windowKey}`);
        } else if (cell.limit !== line.limit) {
          // Policy edits apply prospectively. Existing settled/in-flight usage
          // carries into the new limit; it is not an idempotency conflict.
          cell.limit = line.limit;
        }
        const current = cell.reserved + cell.settled + cell.observed;
        if (current + line.quantity > cell.limit + 1e-12) {
          throw new ReservationCapacityError({
            policyId: line.policyId,
            windowKey: line.windowKey,
            limit: cell.limit,
            current,
            requested: line.quantity,
          });
        }
        return { input: line, cell };
      });

      for (const { input, cell } of lines) cell.reserved += input.quantity;
      const now = (request.now ?? new Date()).toISOString();
      const record: ReservationRecord = {
        reservationId: makeReservationId(),
        projectId: request.projectId,
        admissionId: request.admissionId,
        requestId: request.requestId ?? null,
        fingerprint: request.fingerprint,
        state: "reserved",
        reservedAt: now,
        settledAt: null,
        settlementId: null,
        settlementFingerprint: null,
        outcome: null,
        lines: lines.map(({ input }) => ({
          ...input,
          reservedQuantity: input.quantity,
          settledQuantity: 0,
        })),
      };
      this.reservations.set(key, record);
      return { reservation: clone(record), replay: false };
    });
  }

  async settle(request: SettlementRequest): Promise<SettlementResult> {
    return this.mutex.run(() => {
      const payloadFingerprint = settlementPayloadFingerprint(request);
      const record = [...this.reservations.values()].find(
        (candidate) => candidate.projectId === request.projectId && candidate.reservationId === request.reservationId,
      );
      if (!record) throw new SettlementNotFoundError(`Reservation ${request.reservationId} was not found`);

      // An "unknown" outcome is provisional. A later reconciler may submit a
      // different settlement id with the verified result; the same provisional
      // id/content still replays idempotently.
      if (record.settlementId && !(record.state === "unknown" && record.settlementId !== request.settlementId)) {
        if (record.settlementId !== request.settlementId) {
          throw new SettlementConflictError(`Reservation ${request.reservationId} already has a different settlement`);
        }
        if (record.settlementFingerprint && payloadFingerprint !== record.settlementFingerprint) {
          throw new SettlementConflictError(`Settlement ${request.settlementId} was reused with different content`);
        }
        return { reservation: clone(record), replay: true, overrun: [] };
      }

      if (request.outcome === "unknown") {
        // Unknown means the provider outcome/price is not reconciled yet. Keep
        // the reservation held; a TTL here would turn uncertainty into spend.
        record.state = "unknown";
        record.outcome = "unknown";
        record.settlementId = request.settlementId;
        record.settlementFingerprint = payloadFingerprint;
        record.settledAt = null;
        return { reservation: clone(record), replay: false, overrun: [] };
      }

      const actual = new Map<string, number>();
      for (const line of request.actualLines ?? []) {
        requireFiniteQuantity(line.quantity, "settlement quantity");
        if (actual.has(line.policyId)) throw new SettlementConflictError(`Settlement repeats policy ${line.policyId}`);
        actual.set(line.policyId, line.quantity);
      }
      if (settlementNeedsReconciliation(request, record, actual)) {
        record.state = "unknown";
        record.outcome = "unknown";
        record.settlementId = request.settlementId;
        record.settlementFingerprint = payloadFingerprint;
        record.settledAt = null;
        return { reservation: clone(record), replay: false, overrun: [] };
      }
      const overrun: Array<{ policyId: string; quantity: number }> = [];

      for (const line of record.lines) {
        const cell = this.usage.get(`${line.policyId}\u0000${line.windowKey}`);
        if (!cell) throw new SettlementNotFoundError(`Usage cell for policy ${line.policyId} was not found`);
        const reserved = line.reservedQuantity;
        const quantity = actual.get(line.policyId) ?? 0;
        if (quantity > reserved + 1e-12) overrun.push({ policyId: line.policyId, quantity: quantity - reserved });
        // Floating token-price amounts can leave a tiny negative residue
        // (e.g. 0.3 - 0.1 - 0.2). Clamp before the DB CHECK sees it.
        const remainingReserved = cell.reserved - reserved;
        cell.reserved = Math.abs(remainingReserved) < 1e-12 ? 0 : Math.max(0, remainingReserved);
        cell.settled += quantity;
        line.settledQuantity = quantity;
        line.reservedQuantity = 0;
      }

      record.state = request.outcome === "success" ? "settled" : "released";
      record.outcome = request.outcome;
      record.settlementId = request.settlementId;
      record.settlementFingerprint = payloadFingerprint;
      record.settledAt = (request.now ?? new Date()).toISOString();
      return { reservation: clone(record), replay: false, overrun };
    });
  }

  async getReservation(projectId: string, reservationId: string): Promise<ReservationRecord | null> {
    return this.mutex.run(() => {
      for (const row of this.reservations.values()) {
        if (row.projectId === projectId && row.reservationId === reservationId) return clone(row);
      }
      return null;
    });
  }

  /** Test-only inspection; it does not participate in admission decisions. */
  async recordObserved(usage: ObservedReservationUsage): Promise<{ recorded: boolean }> {
    return this.mutex.run(() => {
      if (!usage.observationId || !usage.policyId || !usage.windowKey) throw new TypeError("observed usage identity is required");
      if (usage.quantity == null) {
        if (!usage.unknown) throw new TypeError("unknown observed usage must be explicitly marked unknown");
      } else {
        requireFiniteQuantity(usage.quantity, "observed quantity");
      }
      requireFiniteQuantity(usage.limit, "observed limit");
      const observedKey = `${usage.policyId}\u0000${usage.windowKey}\u0000${usage.observationId}`;
      if (this.observedIds.has(observedKey)) {
        const prior = this.observedPayloads.get(observedKey);
        if (prior && (prior.quantity !== usage.quantity || prior.unknown !== (usage.unknown === true))) {
          if (prior.unknown && usage.quantity != null && usage.unknown !== true) {
            const cell = this.usage.get(`${usage.policyId}\u0000${usage.windowKey}`);
            if (!cell) throw new SettlementNotFoundError(`Usage cell for policy ${usage.policyId}/${usage.windowKey} was not found`);
            cell.unknown = Math.max(0, cell.unknown - 1);
            cell.observed += usage.quantity;
            this.observedPayloads.set(observedKey, { quantity: usage.quantity, unknown: false });
            return { recorded: true };
          }
          throw new ReservationConflictError(`Observed usage ${usage.observationId} was reused with different content`);
        }
        return { recorded: false };
      }
      const usageKey = `${usage.policyId}\u0000${usage.windowKey}`;
      let cell = this.usage.get(usageKey);
      if (!cell) {
        cell = {
          policyId: usage.policyId,
          windowKey: usage.windowKey,
          unit: usage.unit,
          currency: usage.currency,
          limit: usage.limit,
          reserved: 0,
          settled: 0,
          observed: 0,
          unknown: 0,
        };
        this.usage.set(usageKey, cell);
      } else {
        if (cell.unit !== usage.unit || cell.currency !== usage.currency) throw new ReservationConflictError(`Accounting definition changed for policy ${usage.policyId}/${usage.windowKey}`);
        cell.limit = usage.limit;
      }
      if (usage.quantity == null) cell.unknown += 1;
      else cell.observed += usage.quantity;
      this.observedIds.add(observedKey);
      this.observedPayloads.set(observedKey, { quantity: usage.quantity, unknown: usage.unknown === true });
      return { recorded: true };
    });
  }

  /** Test-only inspection; it does not participate in admission decisions. */
  async getUsage(policyId: string, windowKey: string): Promise<{ reserved: number; settled: number; observed: number; unknown: number } | null> {
    return this.mutex.run(() => {
      const cell = this.usage.get(`${policyId}\u0000${windowKey}`);
      return cell ? { reserved: cell.reserved, settled: cell.settled, observed: cell.observed, unknown: cell.unknown } : null;
    });
  }
}

function makeReservationId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `res_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function mapRow(row: Record<string, unknown>): ReservationRecord {
  const lines = Array.isArray(row.lines) ? row.lines : [];
  return {
    reservationId: String(row.reservation_id ?? row.reservationId),
    projectId: String(row.project_id ?? row.projectId),
    admissionId: String(row.admission_id ?? row.admissionId),
    requestId: row.request_id == null ? null : String(row.request_id),
    fingerprint: String(row.fingerprint),
    state: String(row.state ?? "reserved") as ReservationState,
    reservedAt: new Date(String(row.reserved_at ?? row.reservedAt)).toISOString(),
    settledAt: row.settled_at == null ? null : new Date(String(row.settled_at)).toISOString(),
    settlementId: row.settlement_id == null ? null : String(row.settlement_id),
    settlementFingerprint: (row.settlement_fingerprint ?? row.settlementFingerprint) == null ? null : String(row.settlement_fingerprint ?? row.settlementFingerprint),
    outcome: row.outcome == null ? null : String(row.outcome) as ReservationOutcome,
    lines: lines.map((line) => ({
      policyId: String((line as Record<string, unknown>).policyId ?? (line as Record<string, unknown>).policy_id),
      windowKey: String((line as Record<string, unknown>).windowKey ?? (line as Record<string, unknown>).window_key),
      unit: String((line as Record<string, unknown>).unit) as ReservationLine["unit"],
      currency: (line as Record<string, unknown>).currency == null ? undefined : String((line as Record<string, unknown>).currency) as ReservationLine["currency"],
      currencyRate: (line as Record<string, unknown>).currencyRate == null ? undefined : Number((line as Record<string, unknown>).currencyRate),
      currencySource: (line as Record<string, unknown>).currencySource == null && (line as Record<string, unknown>).currency_source == null
        ? undefined
        : String((line as Record<string, unknown>).currencySource ?? (line as Record<string, unknown>).currency_source),
      currencyAsOf: (line as Record<string, unknown>).currencyAsOf == null && (line as Record<string, unknown>).currency_as_of == null
        ? undefined
        : String((line as Record<string, unknown>).currencyAsOf ?? (line as Record<string, unknown>).currency_as_of),
      policyVersion: ((line as Record<string, unknown>).policyVersion ?? (line as Record<string, unknown>).policy_version) as string | number | null | undefined,
      quantity: Number((line as Record<string, unknown>).quantity),
      limit: Number((line as Record<string, unknown>).limit),
      reservedQuantity: Number((line as Record<string, unknown>).reservedQuantity ?? (line as Record<string, unknown>).reserved_quantity ?? 0),
      settledQuantity: Number((line as Record<string, unknown>).settledQuantity ?? (line as Record<string, unknown>).settled_quantity ?? 0),
    })),
  };
}

/**
 * Database-backed reservation store. The accounting migration owns the exact
 * table definitions; this adapter is intentionally explicit about the SQL
 * contract instead of silently falling back to a process-local map.
 */
export class PostgresReservationStore implements ReservationStore {
  constructor(private readonly pool: pg.Pool) {}

  async getDecision(projectId: string, admissionId: string, requestId?: string | null): Promise<DecisionRecord | null> {
    const result = await this.pool.query(
      `SELECT project_id, admission_id, request_id, fingerprint, decision,
              policy_id, policy_version, reservation_id, refusal, created_at
       FROM policy_decisions
       WHERE project_id = $1 AND (admission_id = $2 OR ($3::text IS NOT NULL AND request_id = $3))
       ORDER BY created_at DESC LIMIT 1`,
      [projectId, admissionId, requestId ?? null],
    );
    return result.rows[0] ? mapDecisionRow(result.rows[0]) : null;
  }

  async recordDecision(record: DecisionRecord): Promise<DecisionRecord> {
    const result = await this.pool.query(
      `INSERT INTO policy_decisions (
         project_id, admission_id, request_id, fingerprint, decision,
         policy_id, policy_version, reservation_id, refusal, created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT DO NOTHING
       RETURNING project_id, admission_id, request_id, fingerprint, decision,
                 policy_id, policy_version, reservation_id, refusal, created_at`,
      [record.projectId, record.admissionId, record.requestId, record.fingerprint,
       record.decision, record.policyId ?? null, record.policyVersion ?? null,
       record.reservationId, record.refusal ? JSON.stringify(record.refusal) : null, record.createdAt],
    );
    const savedRow = result.rows[0] ?? (await this.pool.query(
      `SELECT project_id, admission_id, request_id, fingerprint, decision,
              policy_id, policy_version, reservation_id, refusal, created_at
       FROM policy_decisions
       WHERE project_id = $1 AND (admission_id = $2 OR ($3::text IS NOT NULL AND request_id = $3))
       ORDER BY created_at ASC LIMIT 1`,
      [record.projectId, record.admissionId, record.requestId],
    )).rows[0];
    if (!savedRow) throw new ReservationConflictError(`Admission ${record.admissionId} could not be recorded`);
    const saved = mapDecisionRow(savedRow);
    if (saved.fingerprint !== record.fingerprint) {
      throw new ReservationConflictError(`Admission ${record.admissionId} was already used with different input`);
    }
    return saved;
  }

  async reserve(request: ReservationRequest): Promise<ReservationResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      // Serialize the logical provider-attempt identity before the read. The
      // unique constraints remain the durable guard, while this advisory lock
      // makes duplicate requests deterministic even during first-row creation.
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtext($1))`,
        [`admission:${request.projectId}:${request.admissionId}`],
      );
      if (request.requestId) {
        await client.query(
          `SELECT pg_advisory_xact_lock(hashtext($1))`,
          [`request:${request.projectId}:${request.requestId}`],
        );
      }

      // The unique admission key is the final guard against a duplicate
      // authorization when two SDK requests race.
      const existing = await client.query(
        `SELECT * FROM policy_reservations
         WHERE project_id = $1 AND admission_id = $2
         FOR UPDATE`,
        [request.projectId, request.admissionId],
      );
      if (existing.rows[0]) {
        const saved = mapRow(existing.rows[0]);
        if (saved.fingerprint !== request.fingerprint) {
          throw new ReservationConflictError(`Admission ${request.admissionId} was already reserved with different input`);
        }
        await client.query("COMMIT");
        return { reservation: saved, replay: true };
      }
      if (request.requestId) {
        const duplicate = await client.query(
          `SELECT * FROM policy_reservations
           WHERE project_id = $1 AND request_id = $2
           FOR UPDATE`,
          [request.projectId, request.requestId],
        );
        if (duplicate.rows[0]) {
          const saved = mapRow(duplicate.rows[0]);
          if (saved.fingerprint !== request.fingerprint) {
            throw new ReservationConflictError(`Request ${request.requestId} was already reserved with different input`);
          }
          await client.query("COMMIT");
          return { reservation: saved, replay: true };
        }
      }

      const aggregated = new Map<string, ReservationLineInput>();
      for (const line of request.lines) {
        const key = `${line.policyId}\u0000${line.windowKey}`;
        const existing = aggregated.get(key);
        if (!existing) aggregated.set(key, { ...line });
        else {
          if (existing.unit !== line.unit || existing.currency !== line.currency || existing.limit !== line.limit) {
            throw new ReservationConflictError(`Conflicting accounting definitions for policy ${line.policyId}/${line.windowKey}`);
          }
          existing.quantity += line.quantity;
        }
      }
      const ordered = [...aggregated.values()].sort((a, b) => a.policyId.localeCompare(b.policyId) || a.windowKey.localeCompare(b.windowKey));
      for (const line of ordered) {
        requireFiniteQuantity(line.quantity, "reservation quantity");
        requireFiniteQuantity(line.limit, "reservation limit");
        await client.query(
          `INSERT INTO policy_window_usage (
             policy_id, window_key, unit, currency, limit_quantity,
             reserved_quantity, settled_quantity, observed_quantity
           ) VALUES ($1,$2,$3,$4,$5,0,0,0)
           ON CONFLICT (policy_id, window_key) DO NOTHING`,
          [line.policyId, line.windowKey, line.unit, line.currency ?? null, line.limit],
        );
        const usage = await client.query(
          `SELECT unit, currency, limit_quantity, reserved_quantity, settled_quantity, observed_quantity
           FROM policy_window_usage
           WHERE policy_id = $1 AND window_key = $2
           FOR UPDATE`,
          [line.policyId, line.windowKey],
        );
        const row = usage.rows[0];
        if (!row) throw new Error(`Policy usage row ${line.policyId}/${line.windowKey} disappeared`);
        const current = Number(row.reserved_quantity) + Number(row.settled_quantity) + Number(row.observed_quantity ?? 0);
        if (row.unit !== line.unit || (row.currency ?? null) !== (line.currency ?? null)) {
          throw new ReservationConflictError(`Accounting definition changed for policy ${line.policyId}/${line.windowKey}`);
        }
        // The current policy limit is prospective. Existing settled and
        // in-flight quantities remain in the usage row when the limit changes.
        await client.query(
          `UPDATE policy_window_usage SET limit_quantity = $3
           WHERE policy_id = $1 AND window_key = $2`,
          [line.policyId, line.windowKey, line.limit],
        );
        const effectiveLimit = line.limit;
        if (current + line.quantity > effectiveLimit + 1e-12) {
          throw new ReservationCapacityError({ policyId: line.policyId, windowKey: line.windowKey, limit: effectiveLimit, current, requested: line.quantity });
        }
        await client.query(
          `UPDATE policy_window_usage
           SET reserved_quantity = reserved_quantity + $3
           WHERE policy_id = $1 AND window_key = $2`,
          [line.policyId, line.windowKey, line.quantity],
        );
      }

      const reservationId = makeReservationId();
      const now = (request.now ?? new Date()).toISOString();
      const record: ReservationRecord = {
        reservationId,
        projectId: request.projectId,
        admissionId: request.admissionId,
        requestId: request.requestId ?? null,
        fingerprint: request.fingerprint,
        state: "reserved",
        reservedAt: now,
        settledAt: null,
        settlementId: null,
        settlementFingerprint: null,
        outcome: null,
        lines: ordered.map((line) => ({ ...line, reservedQuantity: line.quantity, settledQuantity: 0 })),
      };
      const inserted = await client.query(
        `INSERT INTO policy_reservations (
           reservation_id, project_id, admission_id, request_id, fingerprint,
           state, reserved_at, lines
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
         ON CONFLICT DO NOTHING
         RETURNING *`,
        [record.reservationId, record.projectId, record.admissionId, record.requestId,
         record.fingerprint, record.state, record.reservedAt, JSON.stringify(record.lines)],
      );
      if (inserted.rows.length === 0) {
        // Another transaction won the same admission identity after our
        // initial read. Roll back the usage increments, then replay its row.
        await client.query("ROLLBACK");
        const replayQuery = request.requestId
          ? await this.pool.query(
              `SELECT * FROM policy_reservations
               WHERE project_id = $1 AND (admission_id = $2 OR request_id = $3)
               ORDER BY reserved_at ASC LIMIT 1`,
              [request.projectId, request.admissionId, request.requestId],
            )
          : await this.pool.query(
              `SELECT * FROM policy_reservations
               WHERE project_id = $1 AND admission_id = $2`,
              [request.projectId, request.admissionId],
            );
        const replayed = replayQuery.rows[0] ? mapRow(replayQuery.rows[0]) : null;
        if (!replayed) throw new ReservationConflictError(`Admission ${request.admissionId} raced and could not be replayed`);
        if (replayed.fingerprint !== request.fingerprint) throw new ReservationConflictError(`Admission ${request.admissionId} was already reserved with different input`);
        return { reservation: replayed, replay: true };
      }
      await client.query("COMMIT");
      return { reservation: record, replay: false };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async settle(request: SettlementRequest): Promise<SettlementResult> {
    const client = await this.pool.connect();
    try {
      const payloadFingerprint = settlementPayloadFingerprint(request);
      await client.query("BEGIN");
      const found = await client.query(
        `SELECT * FROM policy_reservations
         WHERE project_id = $1 AND reservation_id = $2
         FOR UPDATE`,
        [request.projectId, request.reservationId],
      );
      if (!found.rows[0]) throw new SettlementNotFoundError(`Reservation ${request.reservationId} was not found`);
      const record = mapRow(found.rows[0]);
      if (record.settlementId && !(record.state === "unknown" && record.settlementId !== request.settlementId)) {
        if (record.settlementId !== request.settlementId) throw new SettlementConflictError(`Reservation ${request.reservationId} already has a different settlement`);
        if (record.settlementFingerprint && payloadFingerprint !== record.settlementFingerprint) {
          throw new SettlementConflictError(`Settlement ${request.settlementId} was reused with different content`);
        }
        await client.query("COMMIT");
        return { reservation: record, replay: true, overrun: [] };
      }

      if (request.outcome === "unknown") {
        await client.query(
          `UPDATE policy_reservations
           SET state = 'unknown', outcome = 'unknown', settlement_id = $3,
               settlement_fingerprint = $4
           WHERE project_id = $1 AND reservation_id = $2`,
          [request.projectId, request.reservationId, request.settlementId, payloadFingerprint],
        );
        await client.query("COMMIT");
        record.state = "unknown";
        record.outcome = "unknown";
        record.settlementId = request.settlementId;
        record.settlementFingerprint = payloadFingerprint;
        return { reservation: record, replay: false, overrun: [] };
      }

      const actual = new Map<string, number>();
      for (const line of request.actualLines ?? []) {
        requireFiniteQuantity(line.quantity, "settlement quantity");
        if (actual.has(line.policyId)) throw new SettlementConflictError(`Settlement repeats policy ${line.policyId}`);
        actual.set(line.policyId, line.quantity);
      }
      if (settlementNeedsReconciliation(request, record, actual)) {
        await client.query(
          `UPDATE policy_reservations
           SET state = 'unknown', outcome = 'unknown', settlement_id = $3,
               settlement_fingerprint = $4
           WHERE project_id = $1 AND reservation_id = $2`,
          [request.projectId, request.reservationId, request.settlementId, payloadFingerprint],
        );
        await client.query("COMMIT");
        record.state = "unknown";
        record.outcome = "unknown";
        record.settlementId = request.settlementId;
        record.settlementFingerprint = payloadFingerprint;
        return { reservation: record, replay: false, overrun: [] };
      }
      const overrun: Array<{ policyId: string; quantity: number }> = [];
      for (const line of record.lines) {
        const quantity = actual.get(line.policyId) ?? 0;
        if (quantity > line.reservedQuantity + 1e-12) overrun.push({ policyId: line.policyId, quantity: quantity - line.reservedQuantity });
        const updatedUsage = await client.query(
          `UPDATE policy_window_usage
           SET reserved_quantity = CASE
             WHEN ABS(reserved_quantity - $3) < 1e-12 THEN 0
             ELSE GREATEST(0, reserved_quantity - $3)
           END,
               settled_quantity = settled_quantity + $4
           WHERE policy_id = $1 AND window_key = $2`,
          [line.policyId, line.windowKey, line.reservedQuantity, quantity],
        );
        if (updatedUsage.rowCount !== 1) throw new SettlementNotFoundError(`Usage cell for policy ${line.policyId}/${line.windowKey} was not found`);
        line.settledQuantity = quantity;
        line.reservedQuantity = 0;
      }
      const state = request.outcome === "success" ? "settled" : "released";
      const settledAt = (request.now ?? new Date()).toISOString();
      await client.query(
        `UPDATE policy_reservations
         SET state = $3, outcome = $4, settlement_id = $5,
             settlement_fingerprint = $6, settled_at = $7, lines = $8::jsonb
         WHERE project_id = $1 AND reservation_id = $2`,
        [request.projectId, request.reservationId, state, request.outcome, request.settlementId,
         payloadFingerprint, settledAt, JSON.stringify(record.lines)],
      );
      await client.query("COMMIT");
      record.state = state;
      record.outcome = request.outcome;
      record.settlementId = request.settlementId;
      record.settlementFingerprint = payloadFingerprint;
      record.settledAt = settledAt;
      return { reservation: record, replay: false, overrun };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async getReservation(projectId: string, reservationId: string): Promise<ReservationRecord | null> {
    const result = await this.pool.query(
      `SELECT * FROM policy_reservations WHERE project_id = $1 AND reservation_id = $2`,
      [projectId, reservationId],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  async recordObserved(usage: ObservedReservationUsage): Promise<{ recorded: boolean }> {
    if (usage.quantity == null) {
      if (!usage.unknown) throw new TypeError("unknown observed usage must be explicitly marked unknown");
    } else {
      requireFiniteQuantity(usage.quantity, "observed quantity");
    }
    requireFiniteQuantity(usage.limit, "observed limit");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO policy_window_usage (
           policy_id, window_key, unit, currency, limit_quantity,
           reserved_quantity, settled_quantity, observed_quantity
         ) VALUES ($1,$2,$3,$4,$5,0,0,0)
         ON CONFLICT (policy_id, window_key) DO NOTHING`,
        [usage.policyId, usage.windowKey, usage.unit, usage.currency ?? null, usage.limit],
      );
      const usageRow = await client.query(
        `SELECT unit, currency FROM policy_window_usage
         WHERE policy_id = $1 AND window_key = $2 FOR UPDATE`,
        [usage.policyId, usage.windowKey],
      );
      if (!usageRow.rows[0]) throw new SettlementNotFoundError(`Usage cell for policy ${usage.policyId}/${usage.windowKey} was not found`);
      if (usageRow.rows[0].unit !== usage.unit || (usageRow.rows[0].currency ?? null) !== (usage.currency ?? null)) {
        throw new ReservationConflictError(`Accounting definition changed for policy ${usage.policyId}/${usage.windowKey}`);
      }
      const inserted = await client.query(
        `INSERT INTO policy_observations (
           observation_id, policy_id, window_key, quantity, unknown, occurred_at
         ) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (policy_id, window_key, observation_id) DO NOTHING
         RETURNING observation_id`,
        [usage.observationId, usage.policyId, usage.windowKey, usage.quantity, usage.unknown === true, (usage.occurredAt ?? new Date()).toISOString()],
      );
      if (inserted.rows.length === 0) {
        const prior = await client.query(
          `SELECT quantity, unknown FROM policy_observations
           WHERE policy_id = $1 AND window_key = $2 AND observation_id = $3`,
          [usage.policyId, usage.windowKey, usage.observationId],
        );
        const priorRow = prior.rows[0];
        if (priorRow && ((priorRow.quantity == null ? null : Number(priorRow.quantity)) !== usage.quantity || Boolean(priorRow.unknown) !== (usage.unknown === true))) {
          const priorUnknown = Boolean(priorRow.unknown) && priorRow.quantity == null;
          if (!(priorUnknown && usage.quantity != null && usage.unknown !== true)) {
            throw new ReservationConflictError(`Observed usage ${usage.observationId} was reused with different content`);
          }
          await client.query(
            `UPDATE policy_observations SET quantity = $4, unknown = FALSE
             WHERE policy_id = $1 AND window_key = $2 AND observation_id = $3`,
            [usage.policyId, usage.windowKey, usage.observationId, usage.quantity],
          );
          await client.query(
            `UPDATE policy_window_usage
             SET unknown_observations = GREATEST(0, unknown_observations - 1),
                 observed_quantity = observed_quantity + $4,
                 limit_quantity = $3
             WHERE policy_id = $1 AND window_key = $2`,
            [usage.policyId, usage.windowKey, usage.limit, usage.quantity],
          );
          await client.query("COMMIT");
          return { recorded: true };
        }
        await client.query("COMMIT");
        return { recorded: false };
      }
      await client.query(
        `UPDATE policy_window_usage
         SET limit_quantity = $3,
             -- The untyped CASE literals otherwise make pg infer $4 as int4
             -- from the unknown-observations branch. Observed money/token
             -- quantities are double precision and must retain fractional
             -- values (for example an observed cost of 4.8).
             observed_quantity = observed_quantity + CASE WHEN $5::boolean THEN 0::double precision ELSE $4::double precision END,
             unknown_observations = unknown_observations + CASE WHEN $5::boolean THEN 1 ELSE 0 END
         WHERE policy_id = $1 AND window_key = $2`,
        [usage.policyId, usage.windowKey, usage.limit, usage.quantity ?? 0, usage.unknown === true],
      );
      await client.query("COMMIT");
      return { recorded: true };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

export const InMemoryReservationLedger = InMemoryReservationStore;
export const PostgresReservationLedger = PostgresReservationStore;

function mapDecisionRow(row: Record<string, unknown>): DecisionRecord {
  let refusal: DecisionRecord["refusal"] = null;
  if (row.refusal != null) {
    refusal = typeof row.refusal === "string" ? JSON.parse(row.refusal) as DecisionRecord["refusal"] : row.refusal as DecisionRecord["refusal"];
  }
  return {
    projectId: String(row.project_id),
    admissionId: String(row.admission_id),
    requestId: row.request_id == null ? null : String(row.request_id),
    fingerprint: String(row.fingerprint),
    decision: String(row.decision) as DecisionRecord["decision"],
    policyId: row.policy_id == null ? null : String(row.policy_id),
    policyVersion: row.policy_version == null ? null : Number(row.policy_version),
    reservationId: row.reservation_id == null ? null : String(row.reservation_id),
    refusal,
    createdAt: new Date(String(row.created_at)).toISOString(),
  };
}
