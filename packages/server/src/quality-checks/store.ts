import { randomBytes } from "node:crypto";
import type pg from "pg";
import { decryptSecret, encryptSecret } from "../notifications.js";
import {
  DEFAULT_JUDGE_MODELS,
  isJudgeProvider,
  ruleById,
  templateById,
  type CheckKind,
  type JudgeProvider,
  type RuleId,
} from "./templates.js";

/** Quality check configuration: validation, storage and the API shape. */

export const MAX_CHECKS_PER_PROJECT = 50;
export const MAX_CHECK_NAME_CHARS = 120;
export const MAX_RUBRIC_CHARS = 8_000;
export const MAX_APPLIES_TO_NAMES = 50;

export interface QualityCheck {
  id: string;
  projectId: string;
  name: string;
  kind: CheckKind;
  template: string | null;
  rule: RuleId | null;
  target: number | null;
  rubric: string | null;
  judgeProvider: JudgeProvider | null;
  judgeModel: string | null;
  judgeKeyEncrypted: string | null;
  judgeKeyHint: string | null;
  appliesTo: "all" | "named";
  appliesToNames: string[];
  sampleRate: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export class CheckInputError extends Error {}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value ?? "");
}

export function rowToCheck(row: Record<string, unknown>): QualityCheck {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    name: String(row.name),
    kind: row.kind === "judge" ? "judge" : "rule",
    template: row.template == null ? null : String(row.template),
    rule: (row.rule == null ? null : String(row.rule)) as RuleId | null,
    target: row.target == null ? null : Number(row.target),
    rubric: row.rubric == null ? null : String(row.rubric),
    judgeProvider: isJudgeProvider(row.judge_provider) ? row.judge_provider : null,
    judgeModel: row.judge_model == null ? null : String(row.judge_model),
    judgeKeyEncrypted: row.judge_key_encrypted == null ? null : String(row.judge_key_encrypted),
    judgeKeyHint: row.judge_key_hint == null ? null : String(row.judge_key_hint),
    appliesTo: row.applies_to === "named" ? "named" : "all",
    appliesToNames: Array.isArray(row.applies_to_names) ? (row.applies_to_names as unknown[]).map(String) : [],
    sampleRate: Number(row.sample_rate ?? 100),
    enabled: row.enabled !== false,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

/** Encrypt a provider key; the hint keeps only the last four characters. */
export function sealJudgeKey(apiKey: string): { encrypted: string; hint: string } {
  const encrypted = encryptSecret(apiKey);
  if (!encrypted) throw new CheckInputError("API keys can't be stored: the server has no encryption key configured");
  return { encrypted, hint: apiKey.slice(-4) };
}

export function openJudgeKey(check: Pick<QualityCheck, "judgeKeyEncrypted">): string | null {
  return decryptSecret(check.judgeKeyEncrypted);
}

/** The check as the API shows it. The key itself never leaves the server. */
export function publicCheck(check: QualityCheck): Record<string, unknown> {
  return {
    id: check.id,
    name: check.name,
    kind: check.kind,
    template: check.template,
    rule: check.rule,
    target: check.target,
    rubric: check.rubric,
    judgeProvider: check.judgeProvider,
    judgeModel: check.judgeModel,
    hasKey: Boolean(check.judgeKeyEncrypted),
    keyHint: check.judgeKeyEncrypted ? check.judgeKeyHint : null,
    appliesTo: check.appliesTo,
    appliesToNames: check.appliesToNames,
    sampleRate: check.sampleRate,
    enabled: check.enabled,
    createdAt: check.createdAt,
    updatedAt: check.updatedAt,
  };
}

function textField(raw: unknown, field: string, max: number): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") throw new CheckInputError(`${field} must be text`);
  const value = raw.trim();
  if (value.length > max) throw new CheckInputError(`${field} must be ${max} characters or fewer`);
  return value;
}

export interface CheckInput {
  name?: string;
  kind?: CheckKind;
  template?: string | null;
  rule?: RuleId | null;
  target?: number | null;
  rubric?: string | null;
  judgeProvider?: JudgeProvider | null;
  judgeModel?: string | null;
  /** A new key to store, or null to remove the stored key. Undefined keeps it. */
  apiKey?: string | null;
  appliesTo?: "all" | "named";
  appliesToNames?: string[];
  sampleRate?: number;
  enabled?: boolean;
}

/** Validate a create (no `existing`) or a partial update of `existing`. */
export function parseCheckInput(body: unknown, existing?: QualityCheck): CheckInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new CheckInputError("Send the check as a JSON object");
  const raw = body as Record<string, unknown>;
  const input: CheckInput = {};

  const kind = raw["kind"] ?? existing?.kind;
  if (kind !== "judge" && kind !== "rule") throw new CheckInputError("kind must be judge or rule");
  if (existing && kind !== existing.kind) throw new CheckInputError("A check's kind can't change. Create a new check instead");
  input.kind = kind;

  const name = textField(raw["name"], "Name", MAX_CHECK_NAME_CHARS);
  if (name !== undefined) {
    if (!name) throw new CheckInputError("Give the check a name");
    input.name = name;
  }

  if (kind === "rule") {
    const ruleRaw = raw["rule"] ?? existing?.rule;
    const rule = ruleById(ruleRaw);
    if (!rule) throw new CheckInputError("Pick a rule");
    input.rule = rule.id;
    if (raw["target"] !== undefined || !existing || rule.id !== existing.rule) {
      const targetRaw = raw["target"] ?? null;
      if (!rule.target) input.target = null;
      else if (targetRaw === null || targetRaw === "") input.target = rule.target.default;
      else {
        const target = Number(targetRaw);
        if (!Number.isFinite(target) || target < rule.target.min || target > rule.target.max) {
          throw new CheckInputError(`${rule.target.label} must be between ${rule.target.min} and ${rule.target.max}`);
        }
        input.target = target;
      }
    }
    if (!existing && input.name === undefined) input.name = rule.name;
  } else {
    if (raw["template"] !== undefined) {
      if (raw["template"] !== null && raw["template"] !== "custom" && !templateById(raw["template"])) throw new CheckInputError("Unknown template");
      input.template = raw["template"] === null || raw["template"] === "custom" ? null : String(raw["template"]);
    }
    const template = templateById(input.template ?? existing?.template);
    const rubric = textField(raw["rubric"], "Rubric", MAX_RUBRIC_CHARS);
    if (rubric !== undefined) input.rubric = rubric;
    else if (!existing) input.rubric = template?.rubric;
    if (!existing && !input.rubric) throw new CheckInputError("Write a rubric for the judge");
    if (existing && input.rubric === "") throw new CheckInputError("Write a rubric for the judge");
    if (!existing && input.name === undefined && template) input.name = template.name;

    const providerRaw = raw["judgeProvider"] ?? existing?.judgeProvider ?? "openai";
    if (!isJudgeProvider(providerRaw)) throw new CheckInputError("The judge provider must be OpenAI, Anthropic or Google");
    if (raw["judgeProvider"] !== undefined || !existing) input.judgeProvider = providerRaw;
    const model = textField(raw["judgeModel"], "Judge model", 120);
    if (model !== undefined) {
      if (!model || !/^[A-Za-z0-9._:/@-]+$/.test(model)) throw new CheckInputError("Enter a judge model id, such as gpt-4o-mini");
      input.judgeModel = model;
    } else if (!existing) input.judgeModel = DEFAULT_JUDGE_MODELS[providerRaw];

    if (raw["apiKey"] === null) input.apiKey = null;
    else if (raw["apiKey"] !== undefined) {
      if (typeof raw["apiKey"] !== "string") throw new CheckInputError("The API key must be text");
      const key = raw["apiKey"].trim();
      if (key.length > 0) {
        if (key.length < 8 || key.length > 512 || /\s/.test(key)) throw new CheckInputError("That doesn't look like an API key");
        input.apiKey = key;
      }
    }
  }
  if (!existing && !input.name) throw new CheckInputError("Give the check a name");

  if (raw["appliesTo"] !== undefined) {
    if (raw["appliesTo"] !== "all" && raw["appliesTo"] !== "named") throw new CheckInputError("appliesTo must be all or named");
    input.appliesTo = raw["appliesTo"];
  }
  if (raw["appliesToNames"] !== undefined) {
    if (!Array.isArray(raw["appliesToNames"])) throw new CheckInputError("appliesToNames must be a list");
    const names = [...new Set((raw["appliesToNames"] as unknown[])
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => item.length > 0 && item.length <= 200))];
    if (names.length > MAX_APPLIES_TO_NAMES) throw new CheckInputError(`List at most ${MAX_APPLIES_TO_NAMES} agents or workflows`);
    input.appliesToNames = names;
  }
  const appliesTo = input.appliesTo ?? existing?.appliesTo ?? "all";
  const appliesToNames = input.appliesToNames ?? existing?.appliesToNames ?? [];
  if (appliesTo === "named" && appliesToNames.length === 0) throw new CheckInputError("Name at least one agent or workflow, or apply the check to all runs");

  if (raw["sampleRate"] !== undefined) {
    const rate = Number(raw["sampleRate"]);
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) throw new CheckInputError("Sample rate must be between 0 and 100");
    input.sampleRate = Math.round(rate * 100) / 100;
  }
  if (raw["enabled"] !== undefined) {
    if (typeof raw["enabled"] !== "boolean") throw new CheckInputError("enabled must be true or false");
    input.enabled = raw["enabled"];
  }
  return input;
}

export async function listChecks(pool: pg.Pool | pg.PoolClient, projectId: string): Promise<QualityCheck[]> {
  const result = await pool.query("SELECT * FROM quality_checks WHERE project_id = $1 ORDER BY created_at, id", [projectId]);
  return (result.rows as Array<Record<string, unknown>>).map(rowToCheck);
}

export async function getCheck(pool: pg.Pool | pg.PoolClient, projectId: string, checkId: string): Promise<QualityCheck | null> {
  const result = await pool.query("SELECT * FROM quality_checks WHERE project_id = $1 AND id = $2", [projectId, checkId]);
  return result.rows[0] ? rowToCheck(result.rows[0] as Record<string, unknown>) : null;
}

function uniqueViolation(error: unknown): boolean {
  return (error as { code?: string }).code === "23505";
}

export async function createCheck(pool: pg.Pool, projectId: string, input: CheckInput, userId: string | null): Promise<QualityCheck> {
  const count = await pool.query("SELECT COUNT(*)::int AS n FROM quality_checks WHERE project_id = $1", [projectId]);
  if (Number(count.rows[0]?.n ?? 0) >= MAX_CHECKS_PER_PROJECT) throw new CheckInputError(`A project can have at most ${MAX_CHECKS_PER_PROJECT} checks`);
  const key = input.apiKey ? sealJudgeKey(input.apiKey) : null;
  const id = `qc_${randomBytes(8).toString("hex")}`;
  try {
    const result = await pool.query(
      `INSERT INTO quality_checks (
         id, project_id, name, kind, template, rule, target, rubric, judge_provider, judge_model,
         judge_key_encrypted, judge_key_hint, applies_to, applies_to_names, sample_rate, enabled, created_by, updated_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$17)
       RETURNING *`,
      [
        id, projectId, input.name, input.kind, input.kind === "judge" ? input.template ?? null : null,
        input.kind === "rule" ? input.rule : null, input.kind === "rule" ? input.target ?? null : null,
        input.kind === "judge" ? input.rubric ?? null : null,
        input.kind === "judge" ? input.judgeProvider ?? null : null,
        input.kind === "judge" ? input.judgeModel ?? null : null,
        key?.encrypted ?? null, key?.hint ?? null,
        input.appliesTo ?? "all", input.appliesToNames ?? [], input.sampleRate ?? 100, input.enabled ?? true, userId,
      ],
    );
    return rowToCheck(result.rows[0] as Record<string, unknown>);
  } catch (error) {
    if (uniqueViolation(error)) throw new CheckInputError("A check with that name already exists");
    throw error;
  }
}

export async function updateCheck(pool: pg.Pool, existing: QualityCheck, input: CheckInput, userId: string | null): Promise<QualityCheck> {
  const sets: string[] = [];
  const params: unknown[] = [existing.projectId, existing.id];
  const set = (column: string, value: unknown) => { params.push(value); sets.push(`${column} = $${params.length}`); };
  if (input.name !== undefined) set("name", input.name);
  if (input.template !== undefined) set("template", input.template);
  if (input.rule !== undefined) set("rule", input.rule);
  if (input.target !== undefined) set("target", input.target);
  if (input.rubric !== undefined) set("rubric", input.rubric);
  if (input.judgeProvider !== undefined) set("judge_provider", input.judgeProvider);
  if (input.judgeModel !== undefined) set("judge_model", input.judgeModel);
  if (input.apiKey === null) { set("judge_key_encrypted", null); set("judge_key_hint", null); }
  else if (input.apiKey !== undefined) {
    const key = sealJudgeKey(input.apiKey);
    set("judge_key_encrypted", key.encrypted);
    set("judge_key_hint", key.hint);
  }
  if (input.appliesTo !== undefined) set("applies_to", input.appliesTo);
  if (input.appliesToNames !== undefined) set("applies_to_names", input.appliesToNames);
  if (input.sampleRate !== undefined) set("sample_rate", input.sampleRate);
  if (input.enabled !== undefined) set("enabled", input.enabled);
  set("updated_by", userId);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `UPDATE quality_checks SET ${sets.join(", ")}, updated_at = NOW()
       WHERE project_id = $1 AND id = $2 RETURNING *`,
      params,
    );
    if (input.name !== undefined && input.name !== existing.name) {
      // Keep this check's past scores under its current name.
      await client.query(
        "UPDATE scores SET name = $3 WHERE project_id = $1 AND left(id, length($2)) = $2",
        [existing.projectId, scoreIdPrefix(existing.id), input.name],
      );
    }
    await client.query("COMMIT");
    return rowToCheck(result.rows[0] as Record<string, unknown>);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (uniqueViolation(error)) throw new CheckInputError("A check with that name already exists");
    throw error;
  } finally {
    client.release();
  }
}

export async function deleteCheck(pool: pg.Pool, projectId: string, checkId: string): Promise<boolean> {
  const result = await pool.query("DELETE FROM quality_checks WHERE project_id = $1 AND id = $2", [projectId, checkId]);
  return (result.rowCount ?? 0) > 0;
}

/** Every score a check writes has this id prefix, so one run has one score per check. */
export function scoreIdPrefix(checkId: string): string {
  return `qc:${checkId}:`;
}

export function scoreIdFor(checkId: string, traceId: string): string {
  return `${scoreIdPrefix(checkId)}${traceId}`;
}
