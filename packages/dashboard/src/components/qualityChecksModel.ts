import type {
  CheckPayload,
  JudgeProvider,
  JudgeTemplate,
  QualityCheck,
  QualityCheckWithStats,
  RuleDefinition,
  RuleId,
  RunCheckResult,
} from "../qualityChecksApi";

/** Pure helpers for the Quality checks screens: labels, form state and payloads. */

export type Tone = "good" | "warn" | "critical" | "info" | "neutral";

export const PROVIDER_LABELS: Record<JudgeProvider, string> = { openai: "OpenAI", anthropic: "Anthropic", google: "Google" };

export function formatPassRate(rate: number | null): string {
  if (rate == null) return "No results";
  if (rate > 0 && rate < 0.01) return "<1%";
  return `${Math.round(rate * 100)}%`;
}

export function formatAverage(avg: number | null): string {
  return avg == null ? "No results" : avg.toFixed(2);
}

export function formatSampleRate(rate: number): string {
  return rate >= 100 ? "Every run" : rate <= 0 ? "No runs" : `${Number(rate.toFixed(2))}% of runs`;
}

export function kindLabel(check: Pick<QualityCheck, "kind" | "judgeProvider" | "judgeModel">): string {
  if (check.kind === "rule") return "Rule";
  const provider = check.judgeProvider ? PROVIDER_LABELS[check.judgeProvider] : "Judge";
  return `Rubric · ${provider}${check.judgeModel ? ` ${check.judgeModel}` : ""}`;
}

export function appliesToLabel(check: Pick<QualityCheck, "appliesTo" | "appliesToNames">): string {
  if (check.appliesTo !== "named" || check.appliesToNames.length === 0) return "All runs";
  const shown = check.appliesToNames.slice(0, 2).join(", ");
  const more = check.appliesToNames.length - 2;
  return more > 0 ? `${shown} and ${more} more` : shown;
}

export function statusView(check: Pick<QualityCheckWithStats, "status" | "lastError">): { tone: Tone; label: string; hint: string | null } {
  switch (check.status) {
    case "paused": return { tone: "neutral", label: "Off", hint: null };
    case "needs_capture": return { tone: "warn", label: "Needs prompt capture", hint: "Rubric checks read prompts and responses. Turn on text capture for this project in Settings, Data." };
    case "needs_key": return { tone: "warn", label: "Add an API key", hint: "Edit the check and add a key for the judge provider." };
    case "error": return { tone: "critical", label: "Errors", hint: check.lastError };
    default: return { tone: "good", label: "On", hint: null };
  }
}

export function runStateView(result: Pick<RunCheckResult, "state">): { tone: Tone; label: string } {
  switch (result.state) {
    case "passed": return { tone: "good", label: "Passed" };
    case "failed": return { tone: "critical", label: "Failed" };
    case "scored": return { tone: "info", label: "Scored" };
    case "queued": return { tone: "info", label: "Queued" };
    case "error": return { tone: "critical", label: "Couldn't run" };
    case "needs_capture": return { tone: "warn", label: "Needs prompt capture" };
    case "needs_key": return { tone: "warn", label: "Add an API key" };
    case "no_text": return { tone: "neutral", label: "No text captured" };
    case "not_applicable": return { tone: "neutral", label: "Not applicable" };
    case "not_sampled": return { tone: "neutral", label: "Not sampled" };
    case "paused": return { tone: "neutral", label: "Check is off" };
    default: return { tone: "neutral", label: "Waiting for the run to finish" };
  }
}

export interface CheckForm {
  kind: "judge" | "rule";
  template: string;
  name: string;
  rubric: string;
  provider: JudgeProvider;
  model: string;
  /** A new key typed by the user. Empty keeps the saved key. */
  apiKey: string;
  removeKey: boolean;
  rule: RuleId;
  target: string;
  appliesTo: "all" | "named";
  names: string;
  sampleRate: string;
  enabled: boolean;
}

export interface FormCatalog {
  templates: JudgeTemplate[];
  rules: RuleDefinition[];
  providers: Array<{ id: JudgeProvider; defaultModel: string }>;
}

function defaultModel(catalog: FormCatalog, provider: JudgeProvider): string {
  return catalog.providers.find((item) => item.id === provider)?.defaultModel ?? "";
}

/** Rule targets are stored as fractions for shares and shown as percentages. */
export function targetToInput(rule: RuleDefinition | undefined, target: number | null): string {
  if (!rule?.target) return "";
  const value = target ?? rule.target.default;
  return rule.target.unit === "share" ? String(Math.round(value * 10_000) / 100) : String(value);
}

export function emptyForm(kind: "judge" | "rule", catalog: FormCatalog): CheckForm {
  const template = catalog.templates[0];
  const rule = catalog.rules[0];
  return {
    kind,
    template: template?.id ?? "custom",
    name: kind === "judge" ? template?.name ?? "" : rule?.name ?? "",
    rubric: template?.rubric ?? "",
    provider: "openai",
    model: defaultModel(catalog, "openai"),
    apiKey: "",
    removeKey: false,
    rule: rule?.id ?? "run_succeeded",
    target: targetToInput(rule, null),
    appliesTo: "all",
    names: "",
    sampleRate: "100",
    enabled: true,
  };
}

export function formFromCheck(check: QualityCheck, catalog: FormCatalog): CheckForm {
  const rule = catalog.rules.find((item) => item.id === check.rule);
  return {
    kind: check.kind,
    template: check.template ?? "custom",
    name: check.name,
    rubric: check.rubric ?? "",
    provider: check.judgeProvider ?? "openai",
    model: check.judgeModel ?? defaultModel(catalog, check.judgeProvider ?? "openai"),
    apiKey: "",
    removeKey: false,
    rule: check.rule ?? "run_succeeded",
    target: targetToInput(rule, check.target),
    appliesTo: check.appliesTo,
    names: check.appliesToNames.join(", "),
    sampleRate: String(check.sampleRate),
    enabled: check.enabled,
  };
}

/** Picking a template fills the name and rubric; the user can still edit both. */
export function applyTemplate(form: CheckForm, templateId: string, catalog: FormCatalog): CheckForm {
  const template = catalog.templates.find((item) => item.id === templateId);
  if (!template) return { ...form, template: "custom" };
  const previous = catalog.templates.find((item) => item.id === form.template);
  const keepName = form.name.trim() && form.name !== previous?.name;
  return { ...form, template: template.id, rubric: template.rubric, name: keepName ? form.name : template.name };
}

export function applyRule(form: CheckForm, ruleId: RuleId, catalog: FormCatalog): CheckForm {
  const rule = catalog.rules.find((item) => item.id === ruleId);
  const previous = catalog.rules.find((item) => item.id === form.rule);
  const keepName = form.name.trim() && form.name !== previous?.name;
  return { ...form, rule: ruleId, target: targetToInput(rule, null), name: keepName ? form.name : rule?.name ?? form.name };
}

export function applyProvider(form: CheckForm, provider: JudgeProvider, catalog: FormCatalog): CheckForm {
  const wasDefault = !form.model.trim() || catalog.providers.some((item) => item.defaultModel === form.model);
  return { ...form, provider, model: wasDefault ? defaultModel(catalog, provider) : form.model };
}

export function parseNames(raw: string): string[] {
  return [...new Set(raw.split(/[,\n]/).map((item) => item.trim()).filter(Boolean))];
}

/**
 * Validate the form and build the request body. For an edit, `existing` is the
 * saved check; a blank key keeps the saved key.
 */
export function formToPayload(form: CheckForm, catalog: FormCatalog, existing?: QualityCheck | null): { payload: CheckPayload } | { error: string } {
  const name = form.name.trim();
  if (!name) return { error: "Give the check a name." };
  if (name.length > 120) return { error: "Keep the name to 120 characters or fewer." };
  const sampleRate = Number(form.sampleRate);
  if (form.sampleRate.trim() === "" || !Number.isFinite(sampleRate) || sampleRate < 0 || sampleRate > 100) return { error: "Sample rate must be between 0 and 100." };
  const names = parseNames(form.names);
  if (form.appliesTo === "named" && names.length === 0) return { error: "Name at least one agent or workflow, or apply the check to all runs." };
  const payload: CheckPayload = {
    name,
    appliesTo: form.appliesTo,
    appliesToNames: form.appliesTo === "named" ? names : [],
    sampleRate,
    enabled: form.enabled,
  };
  if (!existing) payload.kind = form.kind;
  if (form.kind === "rule") {
    const rule = catalog.rules.find((item) => item.id === form.rule);
    if (!rule) return { error: "Pick a rule." };
    payload.rule = rule.id;
    if (rule.target) {
      const raw = Number(form.target);
      if (form.target.trim() === "" || !Number.isFinite(raw)) return { error: `${rule.target.label} must be a number.` };
      const target = rule.target.unit === "share" ? raw / 100 : raw;
      if (target < rule.target.min || target > rule.target.max) {
        const [min, max] = rule.target.unit === "share" ? [rule.target.min * 100, rule.target.max * 100] : [rule.target.min, rule.target.max];
        return { error: `${rule.target.label} must be between ${min} and ${max}.` };
      }
      payload.target = target;
    } else {
      payload.target = null;
    }
    return { payload };
  }
  const rubric = form.rubric.trim();
  if (!rubric) return { error: "Write a rubric for the judge." };
  const model = form.model.trim();
  if (!model) return { error: "Enter a judge model." };
  payload.template = form.template === "custom" ? null : form.template;
  payload.rubric = rubric;
  payload.judgeProvider = form.provider;
  payload.judgeModel = model;
  const key = form.apiKey.trim();
  if (key) {
    if (key.length < 8 || /\s/.test(key)) return { error: "That doesn't look like an API key." };
    payload.apiKey = key;
  } else if (form.removeKey && existing?.hasKey) {
    payload.apiKey = null;
  }
  return { payload };
}

/** What the key field shows once a key is saved. The key itself never comes back. */
export function keyPlaceholder(check: Pick<QualityCheck, "hasKey" | "keyHint"> | null | undefined): string {
  if (!check?.hasKey) return "Paste an API key";
  return check.keyHint ? `Saved key ending ${check.keyHint}` : "Key saved";
}
