import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import type { QualityCheckWithStats, RuleDefinition } from "../qualityChecksApi";
import {
  appliesToLabel,
  applyProvider,
  applyRule,
  applyTemplate,
  emptyForm,
  formFromCheck,
  formToPayload,
  formatAverage,
  formatPassRate,
  formatSampleRate,
  keyPlaceholder,
  kindLabel,
  parseNames,
  runStateView,
  statusView,
  targetToInput,
  type FormCatalog,
} from "./qualityChecksModel";
import { ChecksTable } from "./QualityChecks";
import { RunCheckList } from "./RunQualityChecks";

const rules: RuleDefinition[] = [
  { id: "run_succeeded", name: "Run succeeded", description: "", target: null },
  { id: "tool_errors", name: "Tool errors", description: "", target: { unit: "share", label: "Most tool errors allowed", default: 0, min: 0, max: 1 } },
  { id: "latency", name: "Latency", description: "", target: { unit: "seconds", label: "Target in seconds", default: 30, min: 0.001, max: 86_400 } },
];
const catalog: FormCatalog = {
  templates: [
    { id: "answered", name: "Answered the question", description: "", rubric: "Did it answer?" },
    { id: "safety", name: "Safety", description: "", rubric: "Is it safe?" },
  ],
  rules,
  providers: [{ id: "openai", defaultModel: "gpt-4o-mini" }, { id: "anthropic", defaultModel: "claude-haiku-4-5" }, { id: "google", defaultModel: "gemini-2.5-flash" }],
};

function check(overrides: Partial<QualityCheckWithStats> = {}): QualityCheckWithStats {
  return {
    id: "qc_1", name: "Answered the question", kind: "judge", template: "answered", rule: null, target: null,
    rubric: "Did it answer?", judgeProvider: "openai", judgeModel: "gpt-4o-mini", hasKey: true, keyHint: "1234",
    appliesTo: "all", appliesToNames: [], sampleRate: 100, enabled: true, createdAt: "", updatedAt: "",
    status: "active", lastError: null,
    stats: { scored: 10, passRate: 0.8, avg: 0.756, lastScoredAt: null, queued: 0, backfilling: 0, failed: 0, needsCapture: 0 },
    ...overrides,
  };
}

describe("quality check labels", () => {
  it("formats rates, averages and sampling in plain words", () => {
    expect(formatPassRate(0.8)).toBe("80%");
    expect(formatPassRate(0.004)).toBe("<1%");
    expect(formatPassRate(null)).toBe("No results");
    expect(formatAverage(0.756)).toBe("0.76");
    expect(formatSampleRate(100)).toBe("Every run");
    expect(formatSampleRate(12.5)).toBe("12.5% of runs");
    expect(kindLabel(check())).toBe("Rubric · OpenAI gpt-4o-mini");
    expect(kindLabel(check({ kind: "rule" }))).toBe("Rule");
    expect(appliesToLabel(check({ appliesTo: "named", appliesToNames: ["a", "b", "c", "d"] }))).toBe("a, b and 2 more");
    expect(appliesToLabel(check())).toBe("All runs");
  });

  it("explains why a check or a run result isn't scoring", () => {
    expect(statusView(check({ status: "needs_capture" })).label).toBe("Needs prompt capture");
    expect(statusView(check({ status: "needs_key" })).tone).toBe("warn");
    expect(statusView(check({ status: "error", lastError: "The judge provider rejected the API key (401)" })).hint).toMatch(/401/);
    expect(statusView(check({ status: "paused" })).label).toBe("Off");
    expect(runStateView({ state: "passed" })).toEqual({ tone: "good", label: "Passed" });
    expect(runStateView({ state: "not_sampled" }).label).toBe("Not sampled");
    expect(runStateView({ state: "needs_capture" }).label).toBe("Needs prompt capture");
  });

  it("never uses em or en dashes in copy", () => {
    const states = ["passed", "failed", "queued", "error", "needs_capture", "needs_key", "no_text", "not_applicable", "not_sampled", "paused", "waiting"] as const;
    const copy = [
      ...states.map((state) => runStateView({ state }).label),
      ...(["active", "paused", "needs_capture", "needs_key", "error"] as const).map((status) => `${statusView(check({ status })).label} ${statusView(check({ status })).hint ?? ""}`),
      formatPassRate(null), formatAverage(null), keyPlaceholder(null),
    ].join(" ");
    expect(copy).not.toMatch(/[–—]/);
  });
});

describe("quality check form", () => {
  it("fills a judge from a template and keeps a custom name when switching", () => {
    const form = emptyForm("judge", catalog);
    expect(form.name).toBe("Answered the question");
    expect(form.model).toBe("gpt-4o-mini");
    const safety = applyTemplate(form, "safety", catalog);
    expect([safety.name, safety.rubric]).toEqual(["Safety", "Is it safe?"]);
    const renamed = applyTemplate({ ...form, name: "My judge" }, "safety", catalog);
    expect(renamed.name).toBe("My judge");
    expect(applyProvider(form, "anthropic", catalog).model).toBe("claude-haiku-4-5");
    expect(applyProvider({ ...form, model: "gpt-4.1" }, "anthropic", catalog).model).toBe("gpt-4.1");
  });

  it("builds payloads and validates input", () => {
    const form = { ...emptyForm("judge", catalog), apiKey: "  sk-test-123456  ", appliesTo: "named" as const, names: "support-agent, research-agent\nsupport-agent", sampleRate: "25" };
    const built = formToPayload(form, catalog);
    expect(built).toEqual({ payload: {
      name: "Answered the question", kind: "judge", appliesTo: "named", appliesToNames: ["support-agent", "research-agent"], sampleRate: 25, enabled: true,
      template: "answered", rubric: "Did it answer?", judgeProvider: "openai", judgeModel: "gpt-4o-mini", apiKey: "sk-test-123456",
    } });
    expect(formToPayload({ ...form, name: " " }, catalog)).toEqual({ error: "Give the check a name." });
    expect(formToPayload({ ...form, sampleRate: "101" }, catalog)).toHaveProperty("error");
    expect(formToPayload({ ...form, names: "" }, catalog)).toHaveProperty("error");
    expect(formToPayload({ ...form, apiKey: "short" }, catalog)).toEqual({ error: "That doesn't look like an API key." });
    expect(formToPayload({ ...form, rubric: "" }, catalog)).toEqual({ error: "Write a rubric for the judge." });
    expect(parseNames("a, b,\n a")).toEqual(["a", "b"]);
  });

  it("keeps the saved key unless a new one is typed or removal is asked for", () => {
    const saved = check();
    const form = formFromCheck(saved, catalog);
    expect(form.apiKey).toBe("");
    const keep = formToPayload(form, catalog, saved);
    expect("payload" in keep && "apiKey" in keep.payload).toBe(false);
    expect("payload" in keep && keep.payload.kind).toBeUndefined();
    const removed = formToPayload({ ...form, removeKey: true }, catalog, saved);
    expect("payload" in removed && removed.payload.apiKey).toBeNull();
    expect(keyPlaceholder(saved)).toBe("Saved key ending 1234");
    expect(keyPlaceholder({ hasKey: false, keyHint: null })).toBe("Paste an API key");
  });

  it("converts rule targets between percent and fraction", () => {
    const form = applyRule(emptyForm("rule", catalog), "tool_errors", catalog);
    expect(form.name).toBe("Tool errors");
    expect(targetToInput(rules[1], 0.25)).toBe("25");
    const built = formToPayload({ ...form, target: "10" }, catalog);
    expect("payload" in built && built.payload.target).toBe(0.1);
    expect(formToPayload({ ...form, target: "150" }, catalog)).toEqual({ error: "Most tool errors allowed must be between 0 and 100." });
    const latency = applyRule(form, "latency", catalog);
    expect([latency.name, latency.target]).toEqual(["Latency", "30"]);
    const plain = formToPayload(emptyForm("rule", catalog), catalog);
    expect("payload" in plain && [plain.payload.rule, plain.payload.target]).toEqual(["run_succeeded", null]);
  });
});

describe("quality check views", () => {
  it("renders the checks table with actions only for managers", () => {
    const rows = [check(), check({ id: "qc_2", name: "Run succeeded", kind: "rule", status: "needs_capture", stats: { ...check().stats, passRate: null, avg: null, scored: 0 } })];
    const managed = renderToString(createElement(ChecksTable, { checks: rows, canManage: true }));
    expect(managed).toContain("Run on recent runs");
    expect(managed).toContain("80%");
    expect(managed).toContain("Needs prompt capture");
    const viewer = renderToString(createElement(ChecksTable, { checks: rows, canManage: false }));
    expect(viewer).not.toContain("Run on recent runs");
    expect(viewer).not.toContain("Turn off");
  });

  it("renders a run's results with score, label and reason", () => {
    const markup = renderToString(createElement(RunCheckList, { results: [
      { checkId: "a", name: "Faithfulness", kind: "judge", state: "failed", score: 0.2, label: "ungrounded", reason: "Cites a price the tool never returned.", detail: null, evaluatedAt: null },
      { checkId: "b", name: "Tool choice", kind: "judge", state: "needs_capture", score: null, label: null, reason: null, detail: null, evaluatedAt: null },
    ] }));
    expect(markup).toContain("0.20");
    expect(markup).toContain("ungrounded");
    expect(markup).toContain("Cites a price the tool never returned.");
    expect(markup).toContain("Needs prompt capture");
  });
});
