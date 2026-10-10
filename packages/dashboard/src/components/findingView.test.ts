import { describe, expect, it } from "vitest";
import type { FindingResponse } from "../api";
import { formatCost } from "../utils";
import { formatProviders } from "./consoleFormatters";
import { findingTitle, findingView } from "./findingView";

const money = (value: number | null | undefined) => formatCost(value ?? null);

function finding(partial: Partial<FindingResponse>): FindingResponse {
  return { id: "f1", family: "increased_unit_cost", state: "open", scope: {}, observedAt: "2026-10-01T00:00:00.000Z", lastSeenAt: "2026-10-01T00:00:00.000Z", baseline: null, evidence: {}, nextActions: [], ...partial };
}

describe("findingView", () => {
  it("reads the previous unit cost and counts from the server baseline", () => {
    const view = findingView(finding({
      scope: { feature: "search" },
      baseline: { previousCount: 160, previousUnitCost: 0.08, previousCost: 12.8 },
      evidence: { currentCount: 200, currentUnitCost: 0.14, currentCost: 28, relativeDifference: 0.75, supportingTraceIds: { current: ["a"], previous: ["b"] } },
    }), money);
    expect(view.title).toBe("search costs more per run");
    expect(view.summary).toContain("up from $0.0800 (75% more), across 200 runs");
    expect(view.metrics[0]).toMatchObject({ value: "$0.1400", detail: "Before: $0.0800" });
    expect(view.facts[1].value).toBe("160 runs · $12.80");
    expect(view.traceIds).toEqual(["a", "b"]);
  });

  it("names coverage and budget findings in plain words", () => {
    expect(findingTitle(finding({ family: "coverage_deterioration", evidence: { pricingDrop: 0.3, attributionDrop: 0 } }))).toBe("Fewer calls have a price");
    expect(findingTitle(finding({ family: "allowance_trajectory", evidence: { policyName: "Monthly budget", highestRatio: 1.1 } }))).toBe("Monthly budget reached its limit");
  });
});

describe("formatters", () => {
  it("keeps sub-dollar costs at four decimals and dollars at cents", () => {
    expect(formatCost(0.0158)).toBe("$0.0158");
    expect(formatCost(0.02)).toBe("$0.0200");
    expect(formatCost(248.6)).toBe("$248.60");
    expect(formatCost(12400)).toBe("$12,400.00");
    expect(formatCost(null)).toBe("Unpriced");
  });

  it("spells provider names properly", () => {
    expect(formatProviders("anthropic,openai")).toBe("Anthropic, OpenAI");
    expect(formatProviders("")).toBe("—");
  });
});
