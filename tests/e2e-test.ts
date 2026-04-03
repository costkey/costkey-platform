/**
 * CostKey E2E Integration Test — Production Simulation
 *
 * Simulates "DocuProcess", a real AI-powered document pipeline with:
 * - Multiple providers (Anthropic, OpenAI, Google)
 * - Multiple features calling through shared wrappers
 * - Traced pipelines grouping related calls
 * - Context tagging
 * - Batch processing
 *
 * Run:
 *   npm i costkey @anthropic-ai/sdk openai @google/genai
 *
 *   ANTHROPIC_API_KEY=... \
 *   OPENAI_API_KEY=... \
 *   GOOGLE_API_KEY=... \
 *   COSTKEY_DSN=https://ck_...@app.costkey.dev/proj_... \
 *   npx tsx tests/e2e-test.ts
 */

// ── CostKey MUST init before any AI SDK imports ──
import { CostKey } from "costkey";

const DSN = process.env["COSTKEY_DSN"];
if (!DSN) { console.error("❌ Missing COSTKEY_DSN"); process.exit(1); }

const RELEASE = `e2e-${Date.now()}`;
CostKey.init({ dsn: DSN, debug: true, release: RELEASE });
console.log(`\n🔧 CostKey initialized (release: ${RELEASE})\n`);

// ── Import AI SDKs AFTER CostKey patches fetch ──
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { GoogleGenAI } from "@google/genai";

const ANTHROPIC_KEY = process.env["ANTHROPIC_API_KEY"] ?? "";
const OPENAI_KEY = process.env["OPENAI_API_KEY"] ?? "";
const GOOGLE_KEY = process.env["GOOGLE_API_KEY"] ?? "";

const results: { name: string; pass: boolean; detail: string }[] = [];
function log(name: string, pass: boolean, detail: string) {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? "✅" : "❌"} ${name} — ${detail}`);
}

// ════════════════════════════════════════════════════════
// AI Client Layer (wrappers — should NOT show in dashboard)
// ════════════════════════════════════════════════════════

async function callClaude(prompt: string, maxTokens = 50): Promise<string> {
  const client = new Anthropic({ apiKey: ANTHROPIC_KEY });
  const r = await client.messages.create({
    model: "claude-haiku-4-5-20251001", max_tokens: maxTokens,
    messages: [{ role: "user", content: prompt }],
  });
  return r.content[0].type === "text" ? r.content[0].text : "";
}

async function callGPT(prompt: string, maxTokens = 50): Promise<string> {
  const client = new OpenAI({ apiKey: OPENAI_KEY });
  const r = await client.chat.completions.create({
    model: "gpt-4o-mini", max_tokens: maxTokens,
    messages: [{ role: "user", content: prompt }],
  });
  return r.choices[0]?.message?.content ?? "";
}

async function callGemini(prompt: string): Promise<string> {
  const ai = new GoogleGenAI({ apiKey: GOOGLE_KEY });
  const r = await ai.models.generateContent({ model: "gemini-2.5-flash", contents: prompt });
  return r.text ?? "";
}

// ════════════════════════════════════════════════════════
// Feature Layer (business logic — SHOULD show in dashboard)
// ════════════════════════════════════════════════════════

async function classifyDocument(text: string): Promise<string> {
  return callClaude(`Classify this text into one category (legal, medical, financial). Reply with just the category.\n\n"${text}"`);
}

async function extractInvoiceData(invoiceText: string): Promise<string> {
  return callGPT(`Extract total amount and vendor from this invoice as JSON.\n\n"${invoiceText}"`);
}

async function summarizeDocument(text: string): Promise<string> {
  return callGemini(`Summarize in one sentence: "${text}"`);
}

async function searchDocuments(query: string): Promise<string> {
  const category = await callClaude(`Classify this query: "${query}". Reply with one word.`);
  const results = await callGPT(`List 3 document titles about "${query}" in "${category}". One per line.`);
  return results;
}

async function processNewDocument(docText: string): Promise<void> {
  const traceId = `trace_${Date.now()}`;
  await CostKey.withContext({ traceId, traceName: "process-document" }, async () => {
    const cat = await classifyDocument(docText);
    console.log(`     Classified: ${cat.trim()}`);
    const summary = await summarizeDocument(docText);
    console.log(`     Summary: ${summary.trim().substring(0, 60)}...`);
    const data = await extractInvoiceData(docText);
    console.log(`     Extracted: ${data.trim().substring(0, 60)}...`);
  });
}

async function batchClassify(docs: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const doc of docs) out.push(await classifyDocument(doc));
  return out;
}

// ════════════════════════════════════════════════════════
// Test Runner
// ════════════════════════════════════════════════════════

async function runTests() {
  const has = { anthropic: !!ANTHROPIC_KEY, openai: !!OPENAI_KEY, google: !!GOOGLE_KEY };
  console.log("📋 Providers: " +
    `Anthropic=${has.anthropic ? "✅" : "⏭️"} ` +
    `OpenAI=${has.openai ? "✅" : "⏭️"} ` +
    `Google=${has.google ? "✅" : "⏭️"}\n`);

  // Test 1: Anthropic
  if (has.anthropic) {
    console.log("── Test 1: Anthropic (classifyDocument) ──");
    try {
      const r = await classifyDocument("Patient with acute bronchitis prescribed antibiotics.");
      log("Anthropic call", r.length > 0, `"${r.trim()}"`);
    } catch (e: any) { log("Anthropic call", false, e.message); }
  }

  // Test 2: OpenAI
  if (has.openai) {
    console.log("\n── Test 2: OpenAI (extractInvoiceData) ──");
    try {
      const r = await extractInvoiceData("Invoice #1234 from Acme Corp. Total: $5,432.10.");
      log("OpenAI call", r.length > 0, `"${r.trim().substring(0, 80)}"`);
    } catch (e: any) { log("OpenAI call", false, e.message); }
  }

  // Test 3: Gemini
  if (has.google) {
    console.log("\n── Test 3: Gemini (summarizeDocument) ──");
    try {
      const r = await summarizeDocument("Q3 earnings show 23% revenue increase driven by AI search reducing support tickets by 40%.");
      log("Gemini call", r.length > 0, `"${r.trim().substring(0, 80)}"`);
    } catch (e: any) { log("Gemini call", false, e.message); }
  }

  // Test 4: Multi-provider
  if (has.anthropic && has.openai) {
    console.log("\n── Test 4: Multi-provider (searchDocuments) ──");
    try {
      const r = await searchDocuments("medical malpractice liability");
      log("Multi-provider", r.length > 0, `${r.split("\n").filter(l => l.trim()).length} results`);
    } catch (e: any) { log("Multi-provider", false, e.message); }
  }

  // Test 5: Traced pipeline
  if (has.anthropic && has.openai && has.google) {
    console.log("\n── Test 5: Traced pipeline (processNewDocument) ──");
    try {
      await processNewDocument("Invoice #5678 from GlobalTech. AI consulting Q1 2026. Total: $12,750. Net 30.");
      log("Traced pipeline", true, "3 calls grouped");
    } catch (e: any) { log("Traced pipeline", false, e.message); }
  }

  // Test 6: Batch
  if (has.anthropic) {
    console.log("\n── Test 6: Batch (3x classifyDocument) ──");
    try {
      const cats = await batchClassify([
        "Defendant failed to file motion within statutory deadline.",
        "BP 140/90. Recommend ACE inhibitor therapy.",
        "Q3 revenue exceeded projections by 15%.",
      ]);
      log("Batch classify", cats.length === 3, cats.map(c => c.trim()).join(", "));
    } catch (e: any) { log("Batch classify", false, e.message); }
  }

  // Test 7: Context tags
  if (has.anthropic) {
    console.log("\n── Test 7: Context tags ──");
    try {
      await CostKey.withContext({ team: "search", feature: "autocomplete", userId: "user_42" }, async () => {
        await callClaude("Complete: 'how to file a'");
      });
      log("Context tags", true, "team=search, feature=autocomplete");
    } catch (e: any) { log("Context tags", false, e.message); }
  }

  // ── Flush ──
  console.log("\n⏳ Flushing...");
  await CostKey.flush();
  console.log("⏳ Waiting 5s for server...\n");
  await new Promise(r => setTimeout(r, 5000));

  // ── Summary ──
  console.log("═".repeat(50));
  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass).length;
  for (const r of results) console.log(`  ${r.pass ? "✅" : "❌"} ${r.name}`);
  console.log(`\n  ${passed} passed, ${failed} failed`);
  console.log(`  Release: ${RELEASE}`);
  console.log(`  Check dashboard now!`);
  console.log("═".repeat(50));
  if (failed > 0) process.exit(1);
}

runTests().catch(e => { console.error("Fatal:", e); process.exit(1); })
  .finally(() => setTimeout(() => process.exit(0), 2000));
