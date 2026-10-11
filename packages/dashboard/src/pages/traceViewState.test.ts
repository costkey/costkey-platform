import { describe, expect, it } from "vitest";
import { restoreTraceView, serializeTraceView } from "./traceViewState";

describe("saved trace view state", () => {
  it("round-trips search, period, sort, and every cohort filter", () => {
    const input = {
      tab: "traces" as const,
      query: "invoice",
      period: "30d" as const,
      from: null,
      to: null,
      sort: "cost_desc",
      filters: {
        provider: ["openai", "anthropic"], model: ["gpt-4o"], feature: ["Search"], function: ["src/search.ts:run"],
        customer: ["customer-1"], environment: ["production"], lifecycle: ["completed"], accounting: ["partial"],
      },
    };
    expect(restoreTraceView(serializeTraceView(input))).toEqual({ ...input, filters: input.filters });
  });

  it("reads legacy status and coverage aliases", () => {
    const restored = restoreTraceView({ tab: "calls", q: "call_1", status: ["completed"], coverage: ["partial"] });
    expect(restored.filters).toEqual(expect.objectContaining({ lifecycle: ["completed"], accounting: ["partial"] }));
    expect(restored.from).toBeNull();
  });
});
