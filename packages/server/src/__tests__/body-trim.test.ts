import { test } from "node:test";
import assert from "node:assert/strict";
import { closePartialJson, repairTruncatedEnvelope } from "../body-trim.js";
import { truncateBody } from "../ingest.js";

test("bodies are stored whole, however large", () => {
  const body = { model: "gpt-6-luna", instructions: "x".repeat(300_000), input: [{ role: "user", content: "hi" }] };
  assert.equal(truncateBody(body), JSON.stringify(body));
});

test("a cut-off JSON text closes at its last complete value", () => {
  assert.deepEqual(closePartialJson('{"model":"m","input":[{"role":"user","content":"What is'), { model: "m", input: [{ role: "user", content: "What is…" }] });
  assert.deepEqual(closePartialJson('{"a":1,"tools":[{"name":"t","parameters":{"type":"obj'), { a: 1, tools: [{ name: "t", parameters: { type: "obj…" } }] });
  assert.deepEqual(closePartialJson('{"a":"x","b'), { a: "x" });
  assert.deepEqual(closePartialJson('{"a":"x\\'), { a: "x…" });
  assert.deepEqual(closePartialJson('{"a":12,"b":3'), { a: 12 });
  assert.equal(closePartialJson('{"'), null);
});

test("a stored slice becomes the request it came from, marked as cut", () => {
  const full = JSON.stringify({ model: "m", instructions: "You are Dash.", input: [{ role: "user", content: "How rich am i" }], tools: [{ name: "a" }, { name: "b", parameters: { type: "object" } }] });
  const envelope = { __costkey_truncated__: true, original_bytes: full.length, notice: "[TRUNCATED]", preview: full.slice(0, full.length - 20) };
  const repaired = repairTruncatedEnvelope(envelope) as Record<string, unknown>;
  assert.equal(repaired["instructions"], "You are Dash.");
  assert.deepEqual(repaired["input"], [{ role: "user", content: "How rich am i" }]);
  assert.deepEqual(repaired["__costkey_trimmed__"], { original_bytes: full.length, cut_at_end: true });
  assert.equal(repairTruncatedEnvelope({ model: "m" }), null);
});
