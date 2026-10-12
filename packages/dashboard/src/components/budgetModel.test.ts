import { describe, expect, it } from "vitest";
import type { Budget } from "../budgetsApi";
import { actionText, budgetEditorHref, budgetHealth, budgetsFor, coversText, formatBudgetAmount, healthCounts, healthView, limitInUsd, projectMoneyBudget, sortBudgets } from "./budgetModel";

function budget(overrides: Partial<Budget> = {}): Budget {
  return { id: "b", name: "Budget", scope: {}, mode: "monitor", status: "active", unit: "money", allowance: 100, currency: "USD", window: "calendar_month", usage: { observed: 10 }, forecast: { periodStart: null, periodEnd: null, projected: 30, health: "on_track" }, ...overrides };
}

describe("budget list", () => {
  it("reads health from the forecast, and from usage on an older server", () => {
    expect(budgetHealth(budget({ forecast: { periodStart: null, periodEnd: null, projected: 140, health: "at_risk" } }))).toBe("at_risk");
    expect(budgetHealth(budget({ forecast: null, usage: { observed: 120 } }))).toBe("over");
    expect(budgetHealth(budget({ forecast: null, usage: { observed: 85 } }))).toBe("at_risk");
    expect(budgetHealth(budget({ forecast: null, usage: { observed: 5 } }))).toBe("on_track");
    expect(budgetHealth(budget({ status: "paused" }))).toBe("paused");
  });

  it("names statuses in plain words with a tone", () => {
    expect(healthView(budget({ forecast: { periodStart: null, periodEnd: null, projected: null, health: "over" } }))).toMatchObject({ tone: "critical", label: "Over" });
    expect(healthView(budget({ forecast: { periodStart: null, periodEnd: null, projected: null, health: "at_risk" } }))).toMatchObject({ tone: "warn", label: "At risk" });
    expect(healthView(budget())).toMatchObject({ tone: "good", label: "On track" });
    expect(healthView(budget({ window: "per_trace", usage: null, forecast: { periodStart: null, periodEnd: null, projected: null, health: "no_data" } })).label).toBe("Each run");
  });

  it("lists the most urgent first and leaves deleted budgets out", () => {
    const list = [
      budget({ id: "ok", name: "A" }),
      budget({ id: "gone", status: "archived" }),
      budget({ id: "over", name: "B", forecast: { periodStart: null, periodEnd: null, projected: null, health: "over" } }),
      budget({ id: "risk", name: "C", forecast: { periodStart: null, periodEnd: null, projected: null, health: "at_risk" } }),
    ];
    expect(sortBudgets(list).map((item) => item.id)).toEqual(["over", "risk", "ok"]);
    expect(healthCounts(list)).toMatchObject({ over: 1, at_risk: 1, on_track: 1 });
  });

  it("says what a budget covers and what happens at the limit", () => {
    expect(coversText(budget())).toEqual({ kind: "Whole project", value: null });
    expect(coversText(budget({ scope: { project: "p1" } }))).toEqual({ kind: "Whole project", value: null });
    expect(coversText(budget({ scope: { agent: "support-agent" } }))).toEqual({ kind: "Agent", value: "support-agent" });
    expect(coversText(budget({ scope: { feature: ["a", "b", "c"] } }))).toEqual({ kind: "Feature", value: "a, b +1" });
    expect(actionText(budget({ mode: "enforce" })).label).toBe("Kill switch");
    expect(actionText(budget()).label).toBe("Alert only");
  });

  it("formats amounts in the budget's own unit", () => {
    expect(formatBudgetAmount(budget(), 12.5)).toBe("$12.50");
    expect(formatBudgetAmount(budget({ unit: "calls", currency: null }), 1200)).toBe("1,200 calls");
    expect(formatBudgetAmount(budget({ unit: "tokens", currency: null }), 2_500_000)).toMatch(/tokens$/);
    expect(formatBudgetAmount(budget(), null)).toBe("—");
  });
});

describe("budgets where they apply", () => {
  const list = [
    budget({ id: "agent", scope: { agent: "support-agent" } }),
    budget({ id: "group", scope: { feature: ["search", "answer"] } }),
    budget({ id: "pattern", scope: { model: "gpt-4o*" } }),
    budget({ id: "both", scope: { feature: "search", customer: "acme" } }),
  ];
  it("finds the budget for one agent, feature or model, including groups and patterns", () => {
    expect(budgetsFor(list, "agent", "support-agent").map((item) => item.id)).toEqual(["agent"]);
    expect(budgetsFor(list, "feature", "answer").map((item) => item.id)).toEqual(["group"]);
    expect(budgetsFor(list, "model", "gpt-4o-mini").map((item) => item.id)).toEqual(["pattern"]);
    expect(budgetsFor(list, "customer", "acme")).toEqual([]);
  });

  it("picks the whole-project money budget for the chart and converts INR to USD", () => {
    expect(projectMoneyBudget([...list, budget({ id: "daily", window: "calendar_day" }), budget({ id: "monthly" })])?.id).toBe("monthly");
    expect(projectMoneyBudget(list)).toBeNull();
    expect(limitInUsd(budget({ currency: "INR", allowance: 8800, usdToPolicyCurrency: 88 }))).toBe(100);
    expect(limitInUsd(budget({ currency: "INR", allowance: 8800, usdToPolicyCurrency: null }))).toBeNull();
  });

  it("opens the editor pre-filled with the scope", () => {
    expect(budgetEditorHref("p1", { dimension: "agent", name: "support agent" })).toBe("/policy-edit?project=p1&scopeDimension=agent&scopeValue=support+agent");
    expect(budgetEditorHref("p1", { id: "b1" })).toBe("/policy-edit?project=p1&id=b1");
  });
});
