import { describe, expect, it } from "vitest";
import { costLineWords, otherCostLabel } from "./modelDetailApi";

describe("cost breakdown words", () => {
  it("reads token lines per 1M tokens and unit lines per their unit", () => {
    expect(costLineWords({ component: "cacheRead", quantity: 3_396_636, rate: 0.00000001, cost: 0.034 })).toEqual({ label: "Cached input", quantity: "3,396,636 tokens", rate: "$0.01 per 1M cached input tokens" });
    expect(costLineWords({ component: "input", quantity: 979_466, rate: 0.0000001, cost: 0.098 }).rate).toBe("$0.10 per 1M input tokens");
    expect(costLineWords({ component: "characters", quantity: 2_698, rate: 0.00018, cost: 0.4856 })).toEqual({ label: "Characters", quantity: "2,698 characters", rate: "$0.18 per 1K characters" });
    expect(costLineWords({ component: "output", quantity: 10, rate: 0.00000075, cost: 0, tier: 272_000 }).label).toBe("Output, above 272K prompt tokens");
  });

  it("says how cost priced another way came about", () => {
    expect(otherCostLabel("reported", "client_reported")).toBe("Reported by the provider");
    expect(otherCostLabel("estimated", "effective_price_override")).toBe("Priced from a price override");
  });
});
