import { describe, expect, it } from "vitest";
import { formatRate, formatRateUsd, longContextLine, modelPath, pricedHow, pricingSourcesText, rateLines } from "./modelDetailApi";

describe("model price display", () => {
  it("shows token rates per 1M tokens and unit rates per a readable quantity", () => {
    expect(formatRate("input", 2.5)).toBe("$2.50 per 1M input tokens");
    expect(formatRate("cacheRead", 0.3)).toBe("$0.30 per 1M cached input tokens");
    expect(formatRate("perCharacter", 0.00018)).toBe("$0.18 per 1K characters");
    expect(formatRate("perSecond", 0.0001)).toBe("$0.006 per minute");
    expect(formatRate("searchPerQuery", 0.035)).toBe("$35.00 per 1K web searches");
    expect(formatRate("perOutputImage", 0.04)).toBe("$0.04 per image");
  });

  it("keeps enough decimals for small rates", () => {
    expect(formatRateUsd(15)).toBe("$15.00");
    expect(formatRateUsd(0.075)).toBe("$0.075");
    expect(formatRateUsd(0.0006)).toBe("$0.0006");
    expect(formatRateUsd(1234.5)).toBe("$1,234.50");
    expect(formatRateUsd(0)).toBe("$0");
  });

  it("lists only the rates a price has, in reading order", () => {
    expect(rateLines({ output: 15, input: 3, cacheWrite1h: 6 })).toEqual([
      { key: "input", label: "Input", value: "$3.00 per 1M input tokens" },
      { key: "output", label: "Output", value: "$15.00 per 1M output tokens" },
      { key: "cacheWrite1h", label: "Cache write, 1 hour", value: "$6.00 per 1M cache write tokens" },
    ]);
    expect(rateLines({ perCharacter: 0.00018 })).toEqual([{ key: "perCharacter", label: "Characters", value: "$0.18 per 1K characters" }]);
    expect(rateLines(null)).toEqual([]);
  });

  it("describes long context tiers", () => {
    expect(longContextLine({ threshold: 200_000, input: 6, output: 22.5 })).toEqual({ label: "Above 200K prompt tokens", value: "$6.00 input, $22.50 output per 1M tokens" });
  });
});

describe("how calls were priced", () => {
  it("names each source in plain words", () => {
    expect(pricedHow("estimated", "catalog:litellm")).toBe("priced from the catalog (LiteLLM)");
    expect(pricedHow("estimated", "pricing_table")).toBe("priced from the built-in price table");
    expect(pricedHow("estimated", "project_price")).toBe("priced from your project prices");
    expect(pricedHow("reported", "openrouter")).toBe("reported by the provider");
    expect(pricedHow("unpriced", null)).toBe("with no price");
    expect(pricedHow("unknown", null)).toBe("priced, source not recorded");
    expect(pricedHow("failed", null)).toBe("failed with no charge");
  });

  it("sums sources into one sentence, largest first", () => {
    expect(pricingSourcesText([
      { basis: "reported", source: null, calls: 2, cost: 0.1 },
      { basis: "estimated", source: "catalog:litellm", calls: 40, cost: 1 },
      { basis: "estimated", source: "catalog:litellm", calls: 1, cost: 0.01 },
    ])).toBe("41 calls priced from the catalog (LiteLLM), 2 reported by the provider");
    expect(pricingSourcesText([{ basis: "estimated", source: "client_reported", calls: 1, cost: 0.1 }])).toBe("1 call priced by your app");
    expect(pricingSourcesText([])).toBe("");
  });
});

describe("model links", () => {
  it("keeps slashes in a model name as path segments", () => {
    expect(modelPath("fireworks", "accounts/fireworks/models/llama v3")).toBe("/models/fireworks/accounts/fireworks/models/llama%20v3");
  });
});
