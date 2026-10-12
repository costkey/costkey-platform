import { describe, expect, it } from "vitest";
import { cacheWriteText, callUsage, callUsageLine, cachedNote, formatHitRate, formatTokenCount, reasoningNote, sumUsage } from "./tokenUsage";

const call = (fields: Record<string, unknown>) => ({ provider: "openai", model: "gpt-4o", input_tokens: null, output_tokens: null, ...fields }) as Parameters<typeof callUsage>[0];

describe("call usage", () => {
  it("adds Anthropic cache reads and writes to the input count", () => {
    const usage = callUsage(call({ provider: "anthropic", model: "claude-sonnet-4-5", input_tokens: 1_000, cache_read_tokens: 3_000, cache_creation_tokens: 500, output_tokens: 200 }));
    expect(usage.inputTokens).toBe(4_500);
    expect(usage.cacheReadTokens).toBe(3_000);
    expect(usage.cacheWriteTokens).toBe(500);
    expect(usage.cacheHitRate).toBeCloseTo(3_000 / 4_500);
  });

  it("keeps OpenAI cached tokens inside the input count and reasoning inside output", () => {
    const usage = callUsage(call({ input_tokens: 2_000, cache_read_tokens: 1_000, output_tokens: 300, reasoning_tokens: 100 }));
    expect(usage.inputTokens).toBe(2_000);
    expect(usage.cacheHitRate).toBe(0.5);
    expect(usage.outputTokens).toBe(300);
    expect(usage.reasoningTokens).toBe(100);
  });

  it("adds Gemini thinking to output", () => {
    expect(callUsage(call({ provider: "google", model: "gemini-2.5-flash", input_tokens: 500, output_tokens: 100, reasoning_tokens: 50 })).outputTokens).toBe(150);
  });

  it("has no hit rate when the provider reports no cache field", () => {
    const usage = callUsage(call({ provider: "google", model: "gemini-2.5-flash", input_tokens: 500, output_tokens: 100 }));
    expect(usage.cacheHitRate).toBeNull();
    expect(usage.cacheReadTokens).toBeNull();
    expect(formatHitRate(usage.cacheHitRate)).toBe("—");
    expect(cachedNote(usage)).toBe("");
  });

  it("reports a real 0% when the provider said zero tokens were cached", () => {
    const usage = callUsage(call({ input_tokens: 800, cache_read_tokens: 0, output_tokens: 10 }));
    expect(formatHitRate(usage.cacheHitRate)).toBe("0.0%");
    expect(callUsageLine(usage)).toBe("800 in · 10 out");
  });

  it("ignores DeepSeek cache writes, which old SDKs filled with cache misses", () => {
    expect(callUsage(call({ provider: "deepseek", model: "deepseek-chat", input_tokens: 1_000, cache_read_tokens: 400, cache_creation_tokens: 600 })).cacheWriteTokens).toBeNull();
  });

  it("splits 5 minute and 1 hour cache writes when reported", () => {
    const usage = callUsage(call({ provider: "anthropic", model: "claude-opus-5", input_tokens: 10, cache_creation_tokens: 3_000, native_units: { cacheCreation5mTokens: 1_000, cacheCreation1hTokens: 2_000 } }));
    expect(cacheWriteText(usage)).toBe("3,000 (1,000 for 5 min, 2,000 for 1 hour)");
  });
});

describe("run usage", () => {
  it("sums calls and recomputes the hit rate over the whole prompt", () => {
    const total = sumUsage([
      callUsage(call({ provider: "anthropic", model: "claude-sonnet-4-5", input_tokens: 1_000, cache_read_tokens: 3_000, cache_creation_tokens: 500, output_tokens: 200, cache_saved_usd: 0.0081 })),
      callUsage(call({ input_tokens: 2_000, cache_read_tokens: 1_000, output_tokens: 300, reasoning_tokens: 100, cache_saved_usd: 0.00125 })),
      callUsage(call({ provider: "google", model: "gemini-2.5-flash", input_tokens: 500, output_tokens: 100, reasoning_tokens: 50 })),
    ]);
    expect(total.inputTokens).toBe(7_000);
    expect(total.cacheReadTokens).toBe(4_000);
    expect(formatHitRate(total.cacheHitRate)).toBe("57.1%");
    expect(total.outputTokens).toBe(650);
    expect(reasoningNote(total)).toBe("150 reasoning");
    expect(total.cacheSavings).toBeCloseTo(0.00935);
  });

  it("hides savings when one cache hit couldn't be checked", () => {
    const total = sumUsage([
      callUsage(call({ input_tokens: 2_000, cache_read_tokens: 1_000, cache_saved_usd: 0.001 })),
      callUsage(call({ input_tokens: 2_000, cache_read_tokens: 1_000, cache_saved_usd: null })),
    ]);
    expect(total.cacheSavings).toBeNull();
  });

  it("shows dashes for a run with no reported usage", () => {
    const total = sumUsage([]);
    expect(formatTokenCount(total.inputTokens)).toBe("—");
    expect(formatHitRate(total.cacheHitRate)).toBe("—");
    expect(cacheWriteText(total)).toBe("—");
  });

  it("formats large counts with the token formatter", () => {
    expect(formatTokenCount(1_250_000)).toBe("1.3M");
    expect(formatTokenCount(45_200)).toBe("45.2k");
  });
});
