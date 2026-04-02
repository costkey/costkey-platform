// CostKey End-to-End Test
// Run: npm i costkey @anthropic-ai/sdk openai
// Execute: ANTHROPIC_API_KEY=sk-ant-... OPENAI_API_KEY=sk-... COSTKEY_DSN=https://ck_...@app.costkey.dev/proj_... npx tsx tests/e2e-test.ts

import { CostKey } from "costkey";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const COSTKEY_DSN = process.env.COSTKEY_DSN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!COSTKEY_DSN) {
  console.error("Missing COSTKEY_DSN env var");
  process.exit(1);
}
if (!ANTHROPIC_API_KEY) {
  console.error("Missing ANTHROPIC_API_KEY env var");
  process.exit(1);
}
if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY env var");
  process.exit(1);
}

const timestamp = Date.now();
const RELEASE = `e2e-test-${timestamp}`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TestResult {
  name: string;
  passed: boolean;
  detail: string;
  durationMs: number;
}

const results: TestResult[] = [];
let debugLogs: string[] = [];

// Capture console.log/warn to detect SDK debug output (e.g. 202 responses)
const originalLog = console.log;
const originalWarn = console.warn;
console.log = (...args: unknown[]) => {
  const msg = args.map(String).join(" ");
  debugLogs.push(msg);
  originalLog(...args);
};
console.warn = (...args: unknown[]) => {
  const msg = args.map(String).join(" ");
  debugLogs.push(msg);
  originalWarn(...args);
};

async function runTest(
  name: string,
  fn: () => Promise<string>,
): Promise<void> {
  const start = performance.now();
  try {
    const detail = await fn();
    const durationMs = Math.round(performance.now() - start);
    results.push({ name, passed: true, detail, durationMs });
  } catch (err) {
    const durationMs = Math.round(performance.now() - start);
    const detail = err instanceof Error ? err.message : String(err);
    results.push({ name, passed: false, detail, durationMs });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// SDK Init
// ---------------------------------------------------------------------------

CostKey.init({
  dsn: COSTKEY_DSN,
  debug: true,
  release: RELEASE,
});

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ---------------------------------------------------------------------------
// Test 1: Basic Anthropic call
// ---------------------------------------------------------------------------

async function test1_anthropicBasic(): Promise<string> {
  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20250404",
    max_tokens: 20,
    messages: [{ role: "user", content: "Say hi in 3 words" }],
  });

  const text =
    response.content[0].type === "text" ? response.content[0].text : "";
  if (!text) throw new Error("Empty response from Anthropic");

  return `Model: claude-haiku-4-5 | Response: "${text.trim()}" | Tokens: ${response.usage.input_tokens}in/${response.usage.output_tokens}out`;
}

// ---------------------------------------------------------------------------
// Test 2: Basic OpenAI call
// ---------------------------------------------------------------------------

async function test2_openaiBasic(): Promise<string> {
  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    max_tokens: 20,
    messages: [{ role: "user", content: "Say hello in 3 words" }],
  });

  const text = response.choices[0]?.message?.content ?? "";
  if (!text) throw new Error("Empty response from OpenAI");

  const usage = response.usage;
  return `Model: gpt-4o-mini | Response: "${text.trim()}" | Tokens: ${usage?.prompt_tokens ?? "?"}in/${usage?.completion_tokens ?? "?"}out`;
}

// ---------------------------------------------------------------------------
// Test 3: Multiple call sites
// ---------------------------------------------------------------------------

async function searchDocuments(): Promise<string> {
  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20250404",
    max_tokens: 20,
    messages: [
      { role: "user", content: "Name one search engine in one word" },
    ],
  });
  return response.content[0].type === "text" ? response.content[0].text : "";
}

async function classifyIntent(): Promise<string> {
  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    max_tokens: 20,
    messages: [
      {
        role: "user",
        content: 'Classify this as greeting or question: "Hi there"',
      },
    ],
  });
  return response.choices[0]?.message?.content ?? "";
}

async function generateSummary(): Promise<string> {
  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20250404",
    max_tokens: 20,
    messages: [{ role: "user", content: "Summarize: The sky is blue." }],
  });
  return response.content[0].type === "text" ? response.content[0].text : "";
}

async function test3_multipleCallSites(): Promise<string> {
  const [r1, r2, r3] = await Promise.all([
    searchDocuments(),
    classifyIntent(),
    generateSummary(),
  ]);
  return `searchDocuments: "${r1.trim()}" | classifyIntent: "${r2.trim()}" | generateSummary: "${r3.trim()}"`;
}

// ---------------------------------------------------------------------------
// Test 4: Traced pipeline
// ---------------------------------------------------------------------------

async function test4_tracedPipeline(): Promise<string> {
  let traceResult = "";
  const traceId = randomBytes(16).toString("hex");

  await CostKey.withContext(
    { traceId, traceName: "e2e-traced-pipeline" },
    async () => {
      const r1 = await anthropic.messages.create({
        model: "claude-haiku-4-5-20250404",
        max_tokens: 20,
        messages: [{ role: "user", content: "Step 1: Say hello" }],
      });

      const r2 = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        max_tokens: 20,
        messages: [{ role: "user", content: "Step 2: Say goodbye" }],
      });

      const t1 =
        r1.content[0].type === "text" ? r1.content[0].text.trim() : "";
      const t2 = r2.choices[0]?.message?.content?.trim() ?? "";

      traceResult = `traceId: ${traceId} | step1: "${t1}" | step2: "${t2}"`;
    },
  );

  if (!traceResult) throw new Error("Trace produced no result");
  return traceResult;
}

// ---------------------------------------------------------------------------
// Test 5: Context tagging
// ---------------------------------------------------------------------------

async function test5_contextTagging(): Promise<string> {
  let tagResult = "";

  await CostKey.withContext(
    { team: "e2e-test", task: "context-tagging", userId: "test-user-42" },
    async () => {
      const ctx = CostKey.getCurrentContext();

      const response = await anthropic.messages.create({
        model: "claude-haiku-4-5-20250404",
        max_tokens: 20,
        messages: [{ role: "user", content: "Say 'tagged' in one word" }],
      });

      const text =
        response.content[0].type === "text"
          ? response.content[0].text.trim()
          : "";
      tagResult = `context: ${JSON.stringify(ctx)} | response: "${text}"`;
    },
  );

  if (!tagResult) throw new Error("Context tagging produced no result");
  return tagResult;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  originalLog("\n========================================");
  originalLog("  CostKey E2E Test Suite");
  originalLog(`  Server:  app.costkey.dev`);
  originalLog(`  Release: ${RELEASE}`);
  originalLog("========================================\n");

  // Run tests sequentially to keep output readable
  await runTest("Test 1: Basic Anthropic call", test1_anthropicBasic);
  await runTest("Test 2: Basic OpenAI call", test2_openaiBasic);
  await runTest("Test 3: Multiple call sites", test3_multipleCallSites);
  await runTest("Test 4: Traced pipeline", test4_tracedPipeline);
  await runTest("Test 5: Context tagging", test5_contextTagging);

  // Flush all events to the server
  originalLog("\n--- Flushing events to CostKey server ---");
  await CostKey.flush();

  // Wait for server-side processing
  originalLog("--- Waiting 5s for server processing ---\n");
  await sleep(5000);

  // Check debug logs for successful event delivery (202 responses)
  const ingestLogs = debugLogs.filter(
    (l) => l.includes("[costkey]") || l.includes("202") || l.includes("Ingest"),
  );
  const initLog = debugLogs.find((l) => l.includes("Initialized"));
  const errorLogs = debugLogs.filter(
    (l) =>
      (l.includes("[costkey]") && l.includes("Failed")) ||
      l.includes("Rate limited") ||
      l.includes("Ingest returned"),
  );

  // Print results
  originalLog("========================================");
  originalLog("  Results");
  originalLog("========================================\n");

  let passed = 0;
  let failed = 0;

  for (const r of results) {
    const icon = r.passed ? "\u2713" : "\u2717";
    const status = r.passed ? "PASS" : "FAIL";
    originalLog(`  ${icon} ${status}  ${r.name} (${r.durationMs}ms)`);
    if (r.passed) {
      originalLog(`          ${r.detail}`);
      passed++;
    } else {
      originalLog(`          Error: ${r.detail}`);
      failed++;
    }
    originalLog("");
  }

  originalLog("----------------------------------------");
  originalLog(`  SDK initialized: ${initLog ? "yes" : "no"}`);
  originalLog(`  SDK debug lines: ${ingestLogs.length}`);
  originalLog(
    `  Delivery errors: ${errorLogs.length === 0 ? "none" : errorLogs.length}`,
  );
  if (errorLogs.length > 0) {
    for (const e of errorLogs) {
      originalLog(`    -> ${e}`);
    }
  }
  originalLog(`  Total: ${passed} passed, ${failed} failed`);
  originalLog("========================================\n");

  await CostKey.shutdown();

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  originalLog("Fatal error:", err);
  process.exit(1);
});
