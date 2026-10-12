import { test } from "node:test";
import assert from "node:assert/strict";
import { SourceMapGenerator } from "source-map";
import type pg from "pg";
import { filterFrames, isInternalFrame } from "../ingest.js";
import { translateFrames } from "../sourcemap-resolver.js";
import { normalizeRawCallSite, sourceContextAt } from "../telemetry/callsite.js";

test("source context on SDK frames survives normalization and filtering", () => {
  const callSite = normalizeRawCallSite({
    raw: null,
    frames: [
      { functionName: "send", fileName: "/app/node_modules/openai/core.js", lineNumber: 1, columnNumber: 1 },
      {
        functionName: "summarize", fileName: "/app/src/summarize.ts", lineNumber: 12, columnNumber: 3,
        contextLine: "  const out = await openai.chat.completions.create(req);",
        preContext: ["export async function summarize(req) {", "  log(req);", ""],
        postContext: ["  return out;", "}"],
      },
      // Python sends snake case; extra lines beyond 3 and non-strings are dropped.
      {
        function_name: "main", file_name: "/app/main.py", line_number: 4,
        context_line: "x".repeat(900) + "\n", pre_context: ["a", "b", "c", "d", 5], post_context: "nope",
      },
    ],
  }, isInternalFrame)!;
  const kept = filterFrames(callSite.frames);
  assert.deepEqual(kept.map((frame) => frame.functionName), ["summarize", "main"]);
  assert.equal(kept[0]!.contextLine, "  const out = await openai.chat.completions.create(req);");
  assert.deepEqual(kept[0]!.preContext, ["export async function summarize(req) {", "  log(req);", ""]);
  assert.deepEqual(kept[0]!.postContext, ["  return out;", "}"]);
  assert.equal(kept[1]!.contextLine, "x".repeat(500));
  assert.deepEqual(kept[1]!.preContext, ["b", "c", "d"]);
  assert.deepEqual(kept[1]!.postContext, []);
  // A frame with no context gets no context keys at all.
  assert.equal("contextLine" in callSite.frames[0]!, false);
  // Round trip through JSON, as stored in events.call_site_frames.
  assert.deepEqual(JSON.parse(JSON.stringify(kept))[0].contextLine, kept[0]!.contextLine);
});

test("sourceContextAt slices three lines either side", () => {
  const text = ["l1", "l2", "l3", "l4", "l5\r", "l6", "l7", "l8"].join("\n");
  assert.deepEqual(sourceContextAt(text, 5), { contextLine: "l5", preContext: ["l2", "l3", "l4"], postContext: ["l6", "l7", "l8"] });
  assert.deepEqual(sourceContextAt(text, 1), { contextLine: "l1", preContext: [], postContext: ["l2", "l3", "l4"] });
  assert.equal(sourceContextAt(text, 99), null);
  assert.equal(sourceContextAt(text, 0), null);
});

function poolWith(fileName: string, map: string): pg.Pool {
  return { query: async () => ({ rows: [{ file_name: fileName, sourcemap_json: map }] }) } as unknown as pg.Pool;
}

test("sourcemap translation fills context from sourcesContent", async () => {
  const original = [
    "import { openai } from './client';",
    "",
    "export async function summarize(text: string) {",
    "  const prompt = `Summarize: ${text}`;",
    "  const res = await openai.chat.completions.create({ prompt });",
    "  return res.choices[0];",
    "}",
  ].join("\n");
  const gen = new SourceMapGenerator({ file: "main.js" });
  gen.addMapping({ generated: { line: 1, column: 200 }, original: { line: 5, column: 14 }, source: "src/summarize.ts", name: "summarize" });
  gen.setSourceContent("src/summarize.ts", original);
  const frames = [{
    functionName: "a", fileName: "https://app.example.com/assets/main.js", lineNumber: 1, columnNumber: 200,
    contextLine: "minified".repeat(10), preContext: [], postContext: [],
  }];
  const { translated, wasTranslated } = await translateFrames(
    poolWith("https://app.example.com/assets/main.js", gen.toString()), "p", "r1", frames,
  );
  assert.equal(wasTranslated, true);
  assert.equal(translated[0]!.fileName, "src/summarize.ts");
  assert.equal(translated[0]!.lineNumber, 5);
  assert.equal(translated[0]!.contextLine, "  const res = await openai.chat.completions.create({ prompt });");
  assert.deepEqual(translated[0]!.preContext, ["", "export async function summarize(text: string) {", "  const prompt = `Summarize: ${text}`;"]);
  assert.deepEqual(translated[0]!.postContext, ["  return res.choices[0];", "}"]);
});

test("sourcemap translation without sourcesContent drops the minified context", async () => {
  const gen = new SourceMapGenerator({ file: "main.js" });
  gen.addMapping({ generated: { line: 1, column: 10 }, original: { line: 3, column: 2 }, source: "src/a.ts" });
  const frames = [{ functionName: "a", fileName: "/srv/main.js", lineNumber: 1, columnNumber: 10, contextLine: "minified", preContext: [], postContext: [] }];
  const { translated } = await translateFrames(poolWith("/srv/main.js", gen.toString()), "p", "r1", frames);
  assert.equal(translated[0]!.fileName, "src/a.ts");
  assert.equal(translated[0]!.contextLine, undefined);
});
