import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveEventCost } from "../billing.js";
import { computeCost } from "../pricing.js";
import type { CostKeyEvent } from "@costkey/shared";

test("old SDK raw OpenRouter billing overrides the token estimate including zero", () => {
  for (const cost of [0, 0.0013606]) {
    const event = {
      provider: "openrouter", model: "google/gemini-2.5-flash",
      usage: { inputTokens: 26749, outputTokens: 97 },
      responseBody: { usage: { cost } },
    } as CostKeyEvent;
    assert.equal(resolveEventCost(event), cost);
  }
});

test("mixed image output uses separate rates and unknown breakdown stays unpriced", () => {
  assert.equal(computeCost("google/gemini-3.1-flash-image", 1972, 1220), null);
  assert.equal(computeCost("google/gemini-3.1-flash-image", 1972, 1220, null, null, "openrouter", null, 1120), 0.068486);
  assert.equal(computeCost("text-embedding-3-small", 3, 0), 0.00000006);
});

test("legacy OpenRouter image events infer only exact image-token units", () => {
  const exact = {
    provider: "openrouter",
    model: "google/gemini-3.1-flash-image",
    usage: { inputTokens: 1_972, outputTokens: 1_120 },
    responseBody: { usage: { prompt_tokens: 1_972, completion_tokens: 1_120 } },
  } as CostKeyEvent;
  assert.equal(resolveEventCost(exact), 0.068186);

  const mixed = { ...exact, usage: { inputTokens: 1_972, outputTokens: 1_485 } } as CostKeyEvent;
  assert.equal(resolveEventCost(mixed), null);
});

test("invalid billing cannot turn a request into a negative charge", () => {
  const event = { provider: "openrouter", model: "unknown", usage: { costUsd: -1 }, costUsd: -1 } as CostKeyEvent;
  assert.equal(resolveEventCost(event), null);
  assert.equal(computeCost("gpt-4o", -1, 0), null);
});

test("unknown variants do not borrow their neighbouring model's price", () => {
  for (const model of ["gpt-4o-new-image", "google/gemini-3.8-flash:batch", "qwen-new-giant"]) {
    assert.equal(computeCost(model, 100, 100), null);
  }
  assert.equal(computeCost("gemini-2.5-pro", 200001, 1000), 0.5150025);
});
