import { describe, expect, it } from "vitest";
import { normalizeTraceFilterOptions } from "./api";

describe("trace filter options", () => {
  it("normalizes every final dimension with server counts", () => {
    const result = normalizeTraceFilterOptions({
      availableFilters: {
        providers: ["openai"],
        models: ["gpt-4o"],
        environments: ["production"],
        features: ["Search"],
        customers: ["customer-1"],
        functions: ["src/search.ts:run"],
        lifecycles: ["completed"],
        accounting: ["partial"],
        coverage: ["unpriced"],
        statuses: ["200"],
        counts: {
          provider: { openai: 3 },
          lifecycle: { completed: 2 },
          accounting: { partial: 1 },
          coverage: { unpriced: 1 },
        },
        contexts: { tenant: { values: ["acme"], counts: { acme: 4 } } },
      },
      complete: true,
    });

    expect(result.options?.provider).toEqual([{ value: "openai", count: 3 }]);
    expect(result.options?.lifecycle).toEqual([{ value: "completed", count: 2 }]);
    expect(result.options?.accounting).toEqual([{ value: "partial", count: 1 }]);
    expect(result.options?.coverage).toEqual([{ value: "unpriced", count: 1 }]);
    expect(result.options?.["context:tenant"]).toEqual([{ value: "acme", count: 4 }]);
  });
});
