import type pg from "pg";

export interface CreditInput {
  provider: string;
  accountScope: string;
  /** Provider project/account billing scope. */
  cloudProject: string;
  currency: string;
  originalAmount: number;
  balanceAmount: number;
  balanceAsOf: string;
  expiresAt?: string | null;
  eligibility?: Record<string, unknown>;
}

export interface CreditRow {
  id: string;
  project_id: string;
  provider: string;
  account_scope: string;
  cloud_project: string | null;
  currency: string;
  original_amount: number;
  balance_amount: number;
  balance_as_of: string;
  expires_at: string | null;
  eligibility: Record<string, unknown>;
  source: "user_supplied" | string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface EligibleCreditEstimate {
  available: boolean;
  reason: string | null;
  /** The forecast amount before credit is applied. */
  originalAmount: number | null;
  eligibleAmount: number | null;
  estimatedPayable: number | null;
  currency: string;
  byProvider: Record<string, { balance: number; eligible: number }>;
}

function finiteNonNegative(value: unknown): number | null {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function text(value: unknown, max = 120): string | null {
  if (typeof value !== "string") return null;
  const result = value.trim();
  return result.length > 0 && result.length <= max ? result : null;
}

function date(value: unknown): string | null {
  const result = text(value, 80);
  if (!result) return null;
  const parsed = new Date(result);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function object(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function list(value: unknown): string[] | null {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return null;
}

/**
 * Parse the manual, user-supplied credit form. The billing identity is
 * deliberately required so a credit cannot silently become workspace-wide.
 */
export function parseCreditInput(body: Record<string, unknown>): CreditInput | { error: string } {
  const provider = text(body["provider"]);
  const accountScope = text(body["accountScope"] ?? body["account_scope"] ?? body["account"]);
  const cloudProject = text(
    body["cloudProject"] ?? body["cloud_project"] ?? body["project"] ?? body["projectId"] ?? body["project_id"],
  );
  const currency = text(body["currency"], 12)?.toUpperCase();
  const originalAmount = finiteNonNegative(body["originalAmount"] ?? body["original_amount"] ?? body["amount"]);
  const balanceAmount = finiteNonNegative(body["balanceAmount"] ?? body["balance_amount"] ?? body["balance"]);
  const balanceAsOf = date(body["balanceAsOf"] ?? body["balance_as_of"] ?? body["asOf"] ?? body["as_of"]);
  const expiresAtValue = body["expiresAt"] ?? body["expires_at"] ?? body["expiry"];
  const expiresAt = expiresAtValue == null || expiresAtValue === "" ? null : date(expiresAtValue);
  if (!provider || !accountScope || !cloudProject || !currency || !/^[A-Z][A-Z0-9_-]{2,11}$/.test(currency)) {
    return { error: "provider, accountScope, cloudProject, and a valid currency are required" };
  }
  if (originalAmount === null || balanceAmount === null || !balanceAsOf) {
    return { error: "originalAmount, balanceAmount, and balanceAsOf are required" };
  }
  if (!("expiresAt" in body) && !("expires_at" in body) && !("expiry" in body)) {
    return { error: "expiresAt is required; use null for a non-expiring credit" };
  }
  if (expiresAtValue != null && expiresAtValue !== "" && !expiresAt) {
    return { error: "expiresAt must be a valid date" };
  }
  if (balanceAmount > originalAmount) return { error: "balanceAmount cannot exceed originalAmount" };
  const eligibilityValue = body["eligibility"];
  const eligibility = object(eligibilityValue);
  if (eligibilityValue != null && !eligibility) {
    return { error: "eligibility must be an object" };
  }
  if (!eligibility || Object.keys(eligibility).length === 0) {
    return { error: "eligibility restrictions are required" };
  }
  return {
    provider,
    accountScope,
    cloudProject,
    currency,
    originalAmount,
    balanceAmount,
    balanceAsOf,
    expiresAt,
    eligibility,
  };
}

function matchesAny(value: string | null, allowed: unknown): boolean {
  const values = list(allowed);
  if (!values) return false;
  return value !== null && values.some((item) => item === value);
}

function creditEligibilityMatches(
  credit: CreditRow,
  options: { provider: string; model: string | null; service: string | string[] | null; accountScope: string; cloudProject: string | null },
): boolean {
  if (credit.provider !== options.provider || credit.account_scope !== options.accountScope) return false;
  if (credit.cloud_project !== options.cloudProject) return false;
  const eligibility = object(credit.eligibility);
  if (!eligibility || Object.keys(eligibility).length === 0) return false;

  // Provider/account/project are explicit fields on every credit. Optional
  // restrictions narrow that scope; they never broaden it.
  const providers = eligibility["providers"] ?? eligibility["provider"];
  if (providers !== undefined && !matchesAny(options.provider, providers)) return false;
  const accounts = eligibility["accountScopes"] ?? eligibility["account_scope"] ?? eligibility["account"];
  if (accounts !== undefined && !matchesAny(options.accountScope, accounts)) return false;
  const projects = eligibility["cloudProjects"] ?? eligibility["cloud_project"] ?? eligibility["project"];
  if (projects !== undefined && !matchesAny(options.cloudProject, projects)) return false;
  const models = eligibility["models"] ?? eligibility["model"];
  if (models !== undefined && !matchesAny(options.model, models)) return false;
  const services = eligibility["services"] ?? eligibility["service"] ?? eligibility["routes"] ?? eligibility["route"];
  if (services !== undefined) {
    const requestedServices = list(options.service);
    const allowedServices = list(services);
    if (!requestedServices || !allowedServices || !requestedServices.some((requested) => allowedServices.includes(requested))) return false;
  }
  return true;
}

export async function listCredits(pool: pg.Pool, projectId: string): Promise<CreditRow[]> {
  const result = await pool.query(
    `SELECT id, project_id, provider, account_scope, cloud_project, currency,
            original_amount, balance_amount, balance_as_of, expires_at,
            eligibility, source, created_by, created_at, updated_at
     FROM credits WHERE project_id = $1 ORDER BY expires_at NULLS LAST, updated_at DESC`,
    [projectId],
  );
  return result.rows as CreditRow[];
}

export async function createCredit(
  pool: pg.Pool,
  projectId: string,
  input: CreditInput,
  id: string,
  createdBy: string | null,
): Promise<void> {
  await pool.query(
    `INSERT INTO credits (
       id, project_id, provider, account_scope, cloud_project, currency,
       original_amount, balance_amount, balance_as_of, expires_at,
       eligibility, source, created_by
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'user_supplied',$12)`,
    [id, projectId, input.provider, input.accountScope, input.cloudProject, input.currency,
      input.originalAmount, input.balanceAmount, input.balanceAsOf, input.expiresAt,
      JSON.stringify(input.eligibility ?? {}), createdBy],
  );
}

export async function updateCredit(
  pool: pg.Pool,
  projectId: string,
  creditId: string,
  input: CreditInput,
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE credits SET
       provider = $1, account_scope = $2, cloud_project = $3, currency = $4,
       original_amount = $5, balance_amount = $6, balance_as_of = $7,
       expires_at = $8, eligibility = $9, updated_at = NOW()
     WHERE id = $10 AND project_id = $11 RETURNING id`,
    [input.provider, input.accountScope, input.cloudProject, input.currency,
      input.originalAmount, input.balanceAmount, input.balanceAsOf, input.expiresAt,
      JSON.stringify(input.eligibility ?? {}), creditId, projectId],
  );
  return result.rows.length > 0;
}

export async function deleteCredit(pool: pg.Pool, projectId: string, creditId: string): Promise<boolean> {
  const result = await pool.query(
    "DELETE FROM credits WHERE id = $1 AND project_id = $2 RETURNING id",
    [creditId, projectId],
  );
  return result.rows.length > 0;
}

function unavailable(currency: string, reason: string): EligibleCreditEstimate {
  return {
    available: false,
    reason,
    originalAmount: null,
    eligibleAmount: null,
    estimatedPayable: null,
    currency,
    byProvider: {},
  };
}

/**
 * Estimate cash only for the explicitly selected provider/account/project.
 * Credits never alter canonical consumption totals and balances are capped at
 * the forecast amount, so overlapping grants cannot subtract twice.
 */
export async function eligibleCreditEstimate(
  pool: pg.Pool,
  projectId: string,
  amount: number,
  options: {
    provider?: string | null;
    model?: string | null;
    /** Explicit service/route context. Required when a credit restricts it. */
    service?: string | string[] | null;
    accountScope?: string | null;
    cloudProject?: string | null;
    currency?: string;
    at?: Date;
    until?: Date;
  } = {},
): Promise<EligibleCreditEstimate> {
  const currency = (options.currency ?? "USD").toUpperCase();
  if (!Number.isFinite(amount) || amount < 0) return unavailable(currency, "Cash estimate amount is invalid");
  const provider = text(options.provider);
  const accountScope = text(options.accountScope);
  const cloudProject = text(options.cloudProject);
  if (!provider || !accountScope || !cloudProject) {
    return unavailable(currency, "Cash estimate requires an explicit provider, account, and project scope");
  }
  const at = options.at ?? new Date();
  if (Number.isNaN(at.getTime())) return unavailable(currency, "Cash estimate date is invalid");
  const until = options.until ?? at;
  if (Number.isNaN(until.getTime()) || until < at) return unavailable(currency, "Cash estimate period is invalid");
  const rows = await listCredits(pool, projectId);
  const selected = rows.filter((row) => {
    if (!row || String(row.currency).toUpperCase() !== currency) return false;
    const balance = finiteNonNegative(row.balance_amount);
    const asOf = new Date(String(row.balance_as_of));
    if (balance === null || Number.isNaN(asOf.getTime()) || asOf > at) return false;
    if (row.expires_at) {
      const expiry = new Date(String(row.expires_at));
      if (Number.isNaN(expiry.getTime()) || expiry <= at) return false;
      if (expiry < until) return false;
    }
    return creditEligibilityMatches(row, {
      provider,
      model: text(options.model),
      service: options.service ?? null,
      accountScope,
      cloudProject,
    });
  });
  if (selected.length === 0) return unavailable(currency, "No eligible user-supplied credit balance for this provider/account/project scope");

  const byProvider: Record<string, { balance: number; eligible: number }> = {};
  let availableBalance = 0;
  for (const row of selected) {
    const balance = finiteNonNegative(row.balance_amount);
    if (balance === null) continue;
    const key = row.provider;
    const current = byProvider[key] ?? { balance: 0, eligible: 0 };
    current.balance += balance;
    byProvider[key] = current;
    availableBalance += balance;
  }
  if (availableBalance <= 0 && Object.keys(byProvider).length === 0) {
    return unavailable(currency, "Eligible credit balances are unknown");
  }
  const eligibleAmount = Math.min(amount, availableBalance);
  byProvider[provider].eligible = eligibleAmount;
  return {
    available: true,
    reason: null,
    originalAmount: amount,
    eligibleAmount,
    estimatedPayable: amount - eligibleAmount,
    currency,
    byProvider,
  };
}
