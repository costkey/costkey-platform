import { test } from "node:test";
import assert from "node:assert/strict";
import { costFromRates, costLinesFromRates } from "../price-catalog/compute.js";

const luna = { input: 0.0000001, output: 0.0000005, cacheRead: 0.00000001, longContext: [{ threshold: 272_000, input: 0.0000002, output: 0.00000075, cacheRead: 0.00000002 }] };

test("a call's cost is its lines: uncached input, cached input and output at their rates", () => {
  const usage = { inputTokens: 4_376_102, outputTokens: 45_441, cacheReadTokens: 3_396_636 };
  const priced = costLinesFromRates(luna, usage, "openai", "gpt-6-luna")!;
  assert.deepEqual(priced.lines.map((line) => [line.component, line.quantity]), [["input", 979_466], ["cacheRead", 3_396_636], ["output", 45_441]]);
  // gpt-6-luna's long-context rates apply above 272K prompt tokens.
  assert.equal(priced.tier, 272_000);
  const sum = priced.lines.reduce((total, line) => total + line.cost, 0);
  assert.equal(Math.round(sum * 1e12) / 1e12, costFromRates(luna, usage, "openai", "gpt-6-luna"));
});

test("units are their own lines, and a missing rate still prices nothing", () => {
  const speech = costLinesFromRates({ perCharacter: 0.00018 }, { nativeUnits: { characters: 2_698 } }, "elevenlabs", "eleven_multilingual_v2")!;
  assert.deepEqual(speech.lines, [{ component: "characters", quantity: 2_698, rate: 0.00018, cost: 2_698 * 0.00018 }]);
  assert.equal(costLinesFromRates({ output: 0.000001 }, { inputTokens: 10, outputTokens: 5 }, "openai", "m"), null);
});
