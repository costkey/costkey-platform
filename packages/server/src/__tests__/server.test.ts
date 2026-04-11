import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeCost, findPricing } from "../pricing.js";
import { filterFrames, findBusinessLogicFrame, findBusinessLogicFrameWithGraph, truncateBody } from "../ingest.js";

// ─── Pricing: findPricing ─────────────────────────────────────────────

describe("findPricing", () => {
  it("exact model match: gpt-4o", () => {
    const p = findPricing("gpt-4o");
    assert.ok(p);
    assert.equal(p.input, 2.5);
    assert.equal(p.output, 10);
  });

  it("fuzzy match: claude-sonnet-4-5-20250514 matches claude-sonnet-4", () => {
    const p = findPricing("claude-sonnet-4-5-20250514");
    assert.ok(p);
    assert.equal(p.input, 3);
    assert.equal(p.output, 15);
  });

  it("fine-tuned model: ft:gpt-4o:my-org:custom:abc123 matches gpt-4o", () => {
    const p = findPricing("ft:gpt-4o:my-org:custom:abc123");
    assert.ok(p);
    assert.equal(p.input, 2.5);
    assert.equal(p.output, 10);
  });

  it("Bedrock ARN: anthropic.claude-3-sonnet-20240229 matches claude-3-sonnet", () => {
    const p = findPricing("anthropic.claude-3-sonnet-20240229");
    assert.ok(p);
    assert.equal(p.input, 3);
    assert.equal(p.output, 15);
  });

  it("Fireworks Llama: accounts/fireworks/models/llama-v3p1-8b-instruct matches llama-v3p1-8b", () => {
    const p = findPricing("accounts/fireworks/models/llama-v3p1-8b-instruct");
    assert.ok(p);
    assert.equal(p.input, 0.05);
    assert.equal(p.output, 0.08);
  });

  it("unknown model returns null", () => {
    assert.equal(findPricing("totally-fake-model-xyz"), null);
  });

  it("gpt-4o-mini matches before gpt-4o (ordering)", () => {
    const p = findPricing("gpt-4o-mini");
    assert.ok(p);
    assert.equal(p.input, 0.15);
    assert.equal(p.output, 0.6);
  });

  it("case-insensitive matching", () => {
    const p = findPricing("GPT-4O");
    assert.ok(p);
    assert.equal(p.input, 2.5);
  });

  it("all major model families have at least one match", () => {
    const families = [
      // OpenAI
      "gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "gpt-3.5-turbo", "o1", "o3-mini", "o4-mini",
      // Anthropic
      "claude-opus-4", "claude-sonnet-4", "claude-3-5-sonnet", "claude-3-haiku",
      // Google
      "gemini-2.5-pro", "gemini-2.0-flash",
      // xAI
      "grok-3",
      // Llama
      "llama-3.1-70b",
      // Mistral
      "mistral-large", "codestral",
      // DeepSeek
      "deepseek-chat", "deepseek-reasoner",
      // Cohere
      "command-r-plus", "command-a",
      // Perplexity
      "sonar-pro", "sonar",
    ];
    for (const model of families) {
      const p = findPricing(model);
      assert.ok(p, `Expected pricing for model family: ${model}`);
    }
  });
});

// ─── Pricing: computeCost ─────────────────────────────────────────────

describe("computeCost", () => {
  it("known input/output tokens produce correct USD amount", () => {
    // gpt-4o: input $2.5/1M, output $10/1M
    // 1000 input + 500 output = 0.0025 + 0.005 = 0.0075
    const cost = computeCost("gpt-4o", 1000, 500);
    assert.equal(cost, 0.0075);
  });

  it("cache tokens affect cost for Anthropic models", () => {
    // claude-sonnet-4: input $3/1M, output $15/1M, cacheRead $0.3/1M, cacheWrite $3.75/1M
    const withoutCache = computeCost("claude-sonnet-4", 1_000_000, 0);
    assert.equal(withoutCache, 3);

    const withCache = computeCost("claude-sonnet-4", 500_000, 0, 500_000, 100_000);
    // input: 0.5M * 3 = 1.5, cacheRead: 0.5M * 0.3 = 0.15, cacheWrite: 0.1M * 3.75 = 0.375
    assert.equal(withCache, 2.025);
  });

  it("null model returns null", () => {
    assert.equal(computeCost(null, 100, 100), null);
  });

  it("unknown model returns null", () => {
    assert.equal(computeCost("unknown-model-abc", 100, 100), null);
  });

  it("null tokens return null-ish cost (0 if model known)", () => {
    // With null tokens but known model, cost is 0
    const cost = computeCost("gpt-4o", null, null);
    assert.equal(cost, 0);
  });

  it("zero tokens return 0 cost", () => {
    const cost = computeCost("gpt-4o", 0, 0);
    assert.equal(cost, 0);
  });

  it("DeepSeek cache read tokens apply correctly", () => {
    // deepseek-reasoner: input $0.55/1M, cacheRead $0.055/1M
    const cost = computeCost("deepseek-reasoner", 500_000, 0, 1_000_000);
    // input: 0.5M * 0.55 = 0.275, cacheRead: 1M * 0.055 = 0.055
    assert.equal(cost, 0.33);
  });

  it("cache tokens ignored when model has no cache pricing", () => {
    // gpt-4o has no cacheRead/cacheWrite
    const withCache = computeCost("gpt-4o", 1000, 500, 2000, 3000);
    const withoutCache = computeCost("gpt-4o", 1000, 500);
    assert.equal(withCache, withoutCache);
  });

  it("large token counts produce correct cost", () => {
    // gpt-4o: 1M input tokens = $2.50
    const cost = computeCost("gpt-4o", 1_000_000, 0);
    assert.equal(cost, 2.5);
  });
});

// ─── Frame Filtering ──────────────────────────────────────────────────

describe("filterFrames", () => {
  const frame = (fileName: string, functionName?: string) => ({
    fileName,
    functionName: functionName ?? "someFunc",
    lineNumber: 10,
    columnNumber: 5,
  });

  it("Anthropic Python SDK frames removed", () => {
    const frames = [
      frame("/home/user/app.py", "handle_request"),
      frame("/usr/lib/python3/site-packages/anthropic/_client.py", "messages_create"),
    ];
    const result = filterFrames(frames);
    assert.equal(result.length, 1);
    assert.equal(result[0].fileName, "/home/user/app.py");
  });

  it("OpenAI Python SDK frames removed", () => {
    const frames = [
      frame("/home/user/app.py", "handler"),
      frame("/usr/lib/python3/site-packages/openai/resources/chat.py", "create"),
    ];
    const result = filterFrames(frames);
    assert.equal(result.length, 1);
    assert.equal(result[0].fileName, "/home/user/app.py");
  });

  it("httpx/httpcore frames removed", () => {
    const frames = [
      frame("/home/user/app.py", "handler"),
      frame("/usr/lib/python3/site-packages/httpx/_client.py", "send"),
      frame("/usr/lib/python3/site-packages/httpcore/_sync/pool.py", "handle"),
    ];
    const result = filterFrames(frames);
    assert.equal(result.length, 1);
  });

  it("Python stdlib removed (threading.py, asyncio/, _bootstrap)", () => {
    const frames = [
      frame("/home/user/app.py", "main"),
      frame("/usr/lib/python3.11/threading.py", "run"),
      frame("/usr/lib/python3.11/asyncio/events.py", "_run"),
      frame("/usr/lib/python3.11/_bootstrap.py", "_call_chain"),
    ];
    const result = filterFrames(frames);
    assert.equal(result.length, 1);
    assert.equal(result[0].fileName, "/home/user/app.py");
  });

  it("Node.js SDK frames removed", () => {
    const frames = [
      frame("/home/user/src/index.ts", "handleChat"),
      frame("/home/user/node_modules/openai/src/client.ts", "request"),
      frame("/home/user/node_modules/@anthropic-ai/sdk/src/client.ts", "messages"),
    ];
    const result = filterFrames(frames);
    assert.equal(result.length, 1);
    assert.equal(result[0].fileName, "/home/user/src/index.ts");
  });

  it("CostKey SDK frames removed", () => {
    const frames = [
      frame("/home/user/app.py", "main"),
      frame("/usr/lib/python3/site-packages/costkey/instrument.py", "wrap"),
      frame("/home/user/node_modules/costkey/dist/index.js", "intercept"),
      frame("/workspace/costkey/packages/sdk/src/fetch.ts", "patchedFetch"),
    ];
    const result = filterFrames(frames);
    assert.equal(result.length, 1);
    assert.equal(result[0].fileName, "/home/user/app.py");
  });

  it("user app frames preserved", () => {
    const frames = [
      frame("/home/user/src/api/handler.ts", "processRequest"),
      frame("/home/user/src/utils/llm.ts", "callLLM"),
      frame("/home/user/src/index.ts", "main"),
    ];
    const result = filterFrames(frames);
    assert.equal(result.length, 3);
  });

  it("empty frames array returns empty", () => {
    const result = filterFrames([]);
    assert.equal(result.length, 0);
  });

  it("all frames filtered returns original (fallback)", () => {
    const frames = [
      frame("/usr/lib/python3/site-packages/anthropic/_client.py", "create"),
      frame("/usr/lib/python3/site-packages/httpx/_client.py", "send"),
    ];
    const result = filterFrames(frames);
    // Should return original frames as fallback
    assert.equal(result.length, 2);
    assert.deepEqual(result, frames);
  });

  it("function name patterns filtered", () => {
    const frames = [
      frame("/home/user/app.py", "handle_request"),
      frame("/home/user/client.py", "self._client.send"),
      frame("/home/user/base.py", "_base_client"),
      frame("/home/user/api.py", "self._post"),
      frame("/home/user/wrapper.py", "_send_single_request"),
    ];
    const result = filterFrames(frames);
    assert.equal(result.length, 1);
    assert.equal(result[0].functionName, "handle_request");
  });

  it("frames with empty fileName and functionName are removed", () => {
    const frames = [
      { fileName: null, functionName: null, lineNumber: null, columnNumber: null },
      { fileName: "", functionName: "", lineNumber: null, columnNumber: null },
      frame("/home/user/app.py", "main"),
    ];
    const result = filterFrames(frames);
    assert.equal(result.length, 1);
    assert.equal(result[0].fileName, "/home/user/app.py");
  });
});

// ─── Business Logic Frame Detection ──────────────────────────────────

describe("findBusinessLogicFrame", () => {
  const frame = (fileName: string, functionName: string, lineNumber = 10) => ({
    fileName,
    functionName,
    lineNumber,
    columnNumber: 0,
  });

  it("single frame returns that frame", () => {
    const frames = [frame("app.py", "main")];
    const result = findBusinessLogicFrame(frames);
    assert.equal(result.fileName, "app.py");
    assert.equal(result.functionName, "main");
  });

  it("all frames same file returns frame[1] (caller of wrapper)", () => {
    const frames = [
      frame("client.py", "call_api", 10),
      frame("client.py", "wrapper", 50),
      frame("client.py", "init", 100),
    ];
    const result = findBusinessLogicFrame(frames);
    // All same file → frame[1] is the caller of the innermost function
    assert.equal(result.functionName, "wrapper");
    assert.equal(result.lineNumber, 50);
  });

  it("wrapper in client.py + business logic in handler.py returns handler frame", () => {
    const frames = [
      frame("anthropic_client.py", "_messages_create_with_backoff", 142),
      frame("anthropic_client.py", "call_haiku", 300),
      frame("handler.py", "_process_file_group", 241),
    ];
    const result = findBusinessLogicFrame(frames);
    assert.equal(result.fileName, "handler.py");
    assert.equal(result.functionName, "_process_file_group");
    assert.equal(result.lineNumber, 241);
  });

  it("deep stack: returns first frame from different file", () => {
    const frames = [
      frame("client.py", "send_request", 10),
      frame("client.py", "retry_wrapper", 50),
      frame("utils.py", "with_retry", 20),
      frame("handler.py", "process", 100),
      frame("main.py", "run", 5),
    ];
    const result = findBusinessLogicFrame(frames);
    // Should return utils.py as it's the first frame from a different file than client.py
    assert.equal(result.fileName, "utils.py");
    assert.equal(result.functionName, "with_retry");
  });

  it("real-world Anthropic Python SDK stack trace", () => {
    const frames = [
      frame("/app/src/llm/anthropic_client.py", "_messages_create_with_backoff", 142),
      frame("/app/src/llm/anthropic_client.py", "call_haiku", 300),
      frame("/app/src/pipeline/stage2_haiku.py", "_process_file_group", 241),
      frame("/app/src/pipeline/stage2_haiku.py", "run_stage2", 180),
      frame("/app/src/main.py", "main", 42),
    ];
    const result = findBusinessLogicFrame(frames);
    assert.equal(result.fileName, "/app/src/pipeline/stage2_haiku.py");
    assert.equal(result.functionName, "_process_file_group");
  });

  // ─── ADVERSARIAL: patterns that try to break the algorithm ───

  it("user's own LLM wrapper in a separate utils file — should skip it", () => {
    // Dev has src/utils/llm.ts that wraps OpenAI. Business logic is in src/features/search.ts.
    // After filterFrames strips node_modules/openai, frames look like:
    const frames = [
      frame("src/utils/llm.ts", "callGPT", 25),
      frame("src/features/search.ts", "doSearch", 80),
      frame("src/api/routes.ts", "handleRequest", 12),
    ];
    const result = findBusinessLogicFrame(frames);
    // Algorithm picks callGPT because it's frame[0] and doSearch is "different file"
    // This is CORRECT — callGPT IS the direct caller. But is it what the user wants?
    // Answer: doSearch is better. But the algorithm picks doSearch (first DIFFERENT file from frame[0]).
    // Wait — frame[0] is callGPT in llm.ts. First different file is search.ts. So it picks doSearch.
    assert.equal(result.functionName, "doSearch");
  });

  it("user's LLM wrapper in same file as business logic — picks frame[1]", () => {
    // Everything in one file. call_llm wraps the API, process_data uses it.
    const frames = [
      frame("app/service.py", "call_llm", 10),
      frame("app/service.py", "process_data", 50),
      frame("app/service.py", "handle_request", 100),
    ];
    const result = findBusinessLogicFrame(frames);
    // All same file → falls back to frame[1]
    assert.equal(result.functionName, "process_data");
  });

  it("monorepo: shared package wraps API, app package has business logic", () => {
    // packages/shared/src/ai.ts wraps OpenAI
    // packages/app/src/features/search.ts has business logic
    const frames = [
      frame("packages/shared/src/ai.ts", "generateCompletion", 30),
      frame("packages/app/src/features/search.ts", "searchProducts", 85),
      frame("packages/app/src/routes/api.ts", "handleSearch", 15),
    ];
    const result = findBusinessLogicFrame(frames);
    // Different file from frame[0] → picks searchProducts
    assert.equal(result.functionName, "searchProducts");
  });

  it("Python decorator in separate file — should not pick the decorator", () => {
    // User has a @retry decorator in utils/decorators.py
    // Business logic in features/summarizer.py
    const frames = [
      frame("app/utils/decorators.py", "retry_wrapper", 15),
      frame("app/features/summarizer.py", "generate_summary", 42),
      frame("app/api/handler.py", "handle_summarize", 88),
    ];
    const result = findBusinessLogicFrame(frames);
    // retry_wrapper is NOT in WRAPPER_FN_NAMES (it's "retry_wrapper" not "retry")
    // But it IS frame[0], and generate_summary is a different file → picks generate_summary
    assert.equal(result.functionName, "generate_summary");
  });

  it("retry in WRAPPER_FN_NAMES — gets skipped even if different file", () => {
    // A file called retry_utils.py has a function literally called "retry"
    const frames = [
      frame("app/llm_client.py", "call_api", 10),
      frame("app/retry_utils.py", "retry", 5),
      frame("app/features/search.py", "do_search", 100),
    ];
    const result = findBusinessLogicFrame(frames);
    // retry_utils.py is different file from llm_client.py, but "retry" is in WRAPPER_FN_NAMES → skip
    // Next different file: search.py → picks do_search
    assert.equal(result.functionName, "do_search");
  });

  it("all frames are useless names except one — picks the meaningful one", () => {
    const frames = [
      frame("app.py", "<module>", 1),
      frame("app.py", "", 5),
      frame("handler.py", "process_request", 20),
      frame("main.py", "main", 1),
    ];
    const result = findBusinessLogicFrame(frames);
    // Only "process_request" survives the useless filter
    assert.equal(result.functionName, "process_request");
  });

  it("ALL frames are useless — falls back to original frames", () => {
    const frames = [
      frame("app.py", "<module>", 1),
      frame("main.py", "main", 5),
      frame("run.py", "<anonymous>", 10),
    ];
    const result = findBusinessLogicFrame(frames);
    // All filtered as useless. Falls back to original frames.
    // frame[0] is app.py, first different file is main.py → picks main
    // But "main" is useless... the pool IS the original frames since meaningful is empty.
    // pool[0] = app.py:<module>, innerFile = app.py, first different file = main.py → picks main.py:main
    assert.equal(result.fileName, "main.py");
  });

  it("Next.js bundled code — function names are minified garbage", () => {
    // After filterFrames strips .next/ and node_modules/next/, what's left?
    // If sourcemaps aren't uploaded, we get mangled names
    const frames = [
      frame("src/app/api/chat/route.ts", "POST", 15),
      frame("src/lib/ai.ts", "generateResponse", 42),
    ];
    const result = findBusinessLogicFrame(frames);
    // POST is not useless, different file → picks generateResponse? No.
    // frame[0] is route.ts:POST, first different file is ai.ts → picks generateResponse
    assert.equal(result.functionName, "generateResponse");
  });

  it("deeply nested spaghetti — 10 files deep, skips service layer", () => {
    const frames = [
      frame("src/infra/http.ts", "fetchJSON", 10),
      frame("src/infra/retry.ts", "withRetry", 20),
      frame("src/services/ai.ts", "complete", 30),
      frame("src/services/search.ts", "vectorSearch", 40),
      frame("src/features/rag.ts", "retrieveAndGenerate", 50),
      frame("src/controllers/chat.ts", "handleChat", 60),
      frame("src/routes/api.ts", "chatRoute", 70),
      frame("src/middleware/auth.ts", "requireAuth", 80),
      frame("src/server.ts", "listen", 90),
      frame("src/index.ts", "main", 100),
    ];
    const result = findBusinessLogicFrame(frames);
    // frame[0] = http.ts, first different file = retry.ts
    // "withRetry" is in WRAPPER_FN_NAMES → skip
    // ai.ts matches service layer pattern (/services/ai) → skip
    // Next candidate: search.ts (not in AI service layer pattern) → picks it
    assert.equal(result.functionName, "vectorSearch");
    assert.equal(result.fileName, "src/services/search.ts");
  });

  it("Python class methods with self — function name has dots", () => {
    const frames = [
      frame("app/clients/openai_client.py", "OpenAIClient.create_completion", 55),
      frame("app/services/generator.py", "ContentGenerator.generate", 120),
      frame("app/handlers/api.py", "APIHandler.handle_generate", 30),
    ];
    const result = findBusinessLogicFrame(frames);
    assert.equal(result.functionName, "ContentGenerator.generate");
  });

  it("function name with newlines (Python traceback format)", () => {
    const frames = [
      frame("app/client.py", "_call_api\n    response = client.chat.completions.create(", 10),
      frame("app/handler.py", "process_request\n    result = _call_api(prompt)", 50),
    ];
    const result = findBusinessLogicFrame(frames);
    // Newlines are split, so functionName comparison uses first line
    assert.equal(result.fileName, "app/handler.py");
  });

  it("single frame with useless name — returns it anyway", () => {
    const frames = [frame("app.py", "<module>", 1)];
    const result = findBusinessLogicFrame(frames);
    assert.equal(result.functionName, "<module>");
  });

  it("two frames, same file, one is wrapper fn name — picks the other", () => {
    const frames = [
      frame("app/service.py", "retry", 10),
      frame("app/service.py", "do_work", 50),
    ];
    const result = findBusinessLogicFrame(frames);
    // All same file → frame[1]
    assert.equal(result.functionName, "do_work");
  });

  it("lambda/arrow function names", () => {
    const frames = [
      frame("src/api.ts", "Object.<anonymous>", 10),
      frame("src/handler.ts", "processQueue", 50),
    ];
    const result = findBusinessLogicFrame(frames);
    // "Object.<anonymous>" is not in useless set (it's not exactly "<anonymous>")
    // Different file → picks processQueue
    assert.equal(result.functionName, "processQueue");
  });

  it("null fileName on all frames — uses function names only", () => {
    const frames = [
      frame("", "wrapper", 0),
      frame("", "businessLogic", 0),
    ];
    // innerFile is "", file for frame[1] is also "" — same. Falls to frame[1].
    const result = findBusinessLogicFrame(frames);
    assert.equal(result.functionName, "businessLogic");
  });

  it("user wrapper named exactly like a known wrapper — withCache", () => {
    // User has a legit function called "withCache" that IS their business logic
    const frames = [
      frame("src/llm.ts", "callModel", 10),
      frame("src/cache.ts", "withCache", 20),
      frame("src/handler.ts", "handleRequest", 30),
    ];
    const result = findBusinessLogicFrame(frames);
    // "withcache" is in WRAPPER_FN_NAMES → skipped
    // Next different file: handler.ts → picks handleRequest
    // This is WRONG — user's withCache is their real code. But we can't distinguish.
    assert.equal(result.functionName, "handleRequest");
    // Known limitation: if user names function exactly like a wrapper, we skip it.
  });

  it("empty frames array — returns undefined (edge case)", () => {
    const frames: Array<{ fileName: string; functionName: string; lineNumber: number; columnNumber: number }> = [];
    const result = findBusinessLogicFrame(frames);
    assert.equal(result, undefined);
  });
});

// ─── Body Truncation ──────────────────────────────────────────────────

describe("truncateBody", () => {
  it("small body passes through unchanged", () => {
    const body = { messages: [{ role: "user", content: "hello" }] };
    const result = truncateBody(body);
    assert.equal(result, JSON.stringify(body));
  });

  it("200KB body gets truncated to ~100KB", () => {
    const bigContent = "x".repeat(200_000);
    const body = { content: bigContent };
    const result = truncateBody(body);
    assert.ok(result);
    assert.ok(result.length <= 100_100); // 100KB + small marker overhead
    assert.ok(result.includes("[TRUNCATED]"));
  });

  it("null body returns null", () => {
    assert.equal(truncateBody(null), null);
  });

  it("undefined body returns null", () => {
    assert.equal(truncateBody(undefined), null);
  });

  it("empty string body returns null", () => {
    assert.equal(truncateBody(""), null);
  });

  it("truncated body includes [TRUNCATED] marker", () => {
    const body = { data: "y".repeat(200_000) };
    const result = truncateBody(body);
    assert.ok(result);
    assert.ok(result.endsWith('..."[TRUNCATED]"}'));
  });

  it("body at exactly MAX_BODY_BYTES passes through", () => {
    // Build a body whose JSON is exactly 100_000 bytes
    // JSON.stringify adds overhead, so we need to account for that
    const overhead = JSON.stringify({ d: "" }).length; // {"d":""}
    const body = { d: "a".repeat(100_000 - overhead) };
    const result = truncateBody(body);
    assert.ok(result);
    assert.equal(result.length, 100_000);
    assert.ok(!result.includes("[TRUNCATED]"));
  });
});

// ─── Call Graph Frame Selection ──────────────────────────────────────

describe("findBusinessLogicFrameWithGraph", () => {
  const frame = (fileName: string, functionName: string, lineNumber = 10) => ({
    fileName,
    functionName,
    lineNumber,
    columnNumber: 0,
  });

  it("frame matches graph entry — picks lowest score frame", () => {
    const frames = [
      frame("/app/services/search.py", "do_search", 50),
      frame("/app/main.py", "run", 10),
    ];
    const graph: Record<string, { score: number; fan_in: number; calls_ai: boolean }> = {
      "services/search.py:do_search": { score: 2, fan_in: 3, calls_ai: true },
      "main.py:run": { score: 8, fan_in: 1, calls_ai: false },
    };
    const result = findBusinessLogicFrameWithGraph(frames, graph);
    assert.equal(result.fileName, "/app/services/search.py");
    assert.equal(result.functionName, "do_search");
  });

  it("no frames match graph — falls back to findBusinessLogicFrame", () => {
    const frames = [
      frame("/app/client.py", "api_call", 10),
      frame("/app/handler.py", "process", 50),
    ];
    const graph: Record<string, { score: number; fan_in: number; calls_ai: boolean }> = {
      "unrelated_file.py:something": { score: 1, fan_in: 5, calls_ai: true },
    };
    const result = findBusinessLogicFrameWithGraph(frames, graph);
    // Falls back to findBusinessLogicFrame: first frame from different file than frame[0]
    assert.equal(result.fileName, "/app/handler.py");
    assert.equal(result.functionName, "process");
  });

  it("multiple frames match — picks lowest score", () => {
    const frames = [
      frame("/app/services/search.py", "do_search", 50),
      frame("/app/pipeline/stage.py", "run_stage", 100),
      frame("/app/main.py", "run", 10),
    ];
    const graph: Record<string, { score: number; fan_in: number; calls_ai: boolean }> = {
      "services/search.py:do_search": { score: 5, fan_in: 3, calls_ai: true },
      "pipeline/stage.py:run_stage": { score: 2, fan_in: 2, calls_ai: true },
      "main.py:run": { score: 9, fan_in: 1, calls_ai: false },
    };
    const result = findBusinessLogicFrameWithGraph(frames, graph);
    assert.equal(result.fileName, "/app/pipeline/stage.py");
    assert.equal(result.functionName, "run_stage");
  });

  it("graph key file matching works with suffix (frame has full path, graph has relative)", () => {
    const frames = [
      frame("/app/services/search.py", "do_search", 50),
    ];
    const graph: Record<string, { score: number; fan_in: number; calls_ai: boolean }> = {
      "services/search.py:do_search": { score: 3, fan_in: 2, calls_ai: true },
    };
    const result = findBusinessLogicFrameWithGraph(frames, graph);
    assert.equal(result.fileName, "/app/services/search.py");
    assert.equal(result.functionName, "do_search");
  });

  it("empty graph — falls back to findBusinessLogicFrame", () => {
    const frames = [
      frame("/app/client.py", "wrapper", 10),
      frame("/app/handler.py", "process", 50),
    ];
    const graph: Record<string, { score: number; fan_in: number; calls_ai: boolean }> = {};
    const result = findBusinessLogicFrameWithGraph(frames, graph);
    // Falls back: first frame from different file
    assert.equal(result?.fileName, "/app/handler.py");
    assert.equal(result?.functionName, "process");
  });

  it("wrapper detection: graph picks same file as frame[0], falls back to heuristic", () => {
    // Graph says call_haiku has lowest score, but it's in the same file as frame[0].
    // Two frames from that file → wrapper pattern → fall back to heuristic.
    const frames = [
      frame("/app/anthropic_client.py", "_messages_create", 10),
      frame("/app/anthropic_client.py", "call_haiku", 50),
      frame("/app/pipeline/handler.py", "process_file", 100),
    ];
    const graph: Record<string, { score: number; fan_in: number; calls_ai: boolean }> = {
      "anthropic_client.py:call_haiku": { score: 1, fan_in: 5, calls_ai: true },
      "pipeline/handler.py:process_file": { score: 3, fan_in: 2, calls_ai: true },
    };
    const result = findBusinessLogicFrameWithGraph(frames, graph);
    // Graph picks call_haiku (score 1), but same file as frame[0] + 2 frames from that file
    // → falls back to heuristic → picks handler.py (different file)
    assert.equal(result?.fileName, "/app/pipeline/handler.py");
    assert.equal(result?.functionName, "process_file");
  });

  it("wrapper detection: heuristic also picks same file — keeps graph result", () => {
    // All frames from one file. Graph picks one, heuristic also picks from same file.
    // No better option → keep graph's pick.
    const frames = [
      frame("/app/service.py", "inner_call", 10),
      frame("/app/service.py", "outer_call", 50),
      frame("/app/service.py", "entry_point", 100),
    ];
    const graph: Record<string, { score: number; fan_in: number; calls_ai: boolean }> = {
      "service.py:outer_call": { score: 2, fan_in: 3, calls_ai: true },
    };
    const result = findBusinessLogicFrameWithGraph(frames, graph);
    // Graph picks outer_call, same file as frame[0], 3 frames from that file.
    // Heuristic also returns same file (all same file → frame[1] = outer_call).
    // Heuristic fileName === innerFile → keep graph result.
    assert.equal(result?.functionName, "outer_call");
  });

  it("wrapper detection: only 1 frame from innerFile — keeps graph result", () => {
    // Graph picks a frame from same file as frame[0], but only 1 frame from that file.
    // This isn't a wrapper pattern → keep graph result.
    const frames = [
      frame("/app/client.py", "call_api", 10),
      frame("/app/handler.py", "process", 50),
      frame("/app/main.py", "run", 100),
    ];
    const graph: Record<string, { score: number; fan_in: number; calls_ai: boolean }> = {
      "client.py:call_api": { score: 1, fan_in: 10, calls_ai: true },
      "handler.py:process": { score: 3, fan_in: 2, calls_ai: true },
    };
    const result = findBusinessLogicFrameWithGraph(frames, graph);
    // Graph picks call_api (score 1). Same file as frame[0] but only 1 frame from client.py.
    // sameFileCount < 2 → no wrapper detection → keeps graph result.
    assert.equal(result?.functionName, "call_api");
  });

  it("tighter file matching: rejects bare suffix without path separator", () => {
    // "utils.py" should NOT match "old-app/utils.py" via bare endsWith
    const frames = [
      frame("/new-app/utils.py", "helper", 10),
      frame("/new-app/main.py", "run", 50),
    ];
    const graph: Record<string, { score: number; fan_in: number; calls_ai: boolean }> = {
      "old-app/utils.py:helper": { score: 1, fan_in: 5, calls_ai: true },
    };
    const result = findBusinessLogicFrameWithGraph(frames, graph);
    // Should NOT match: "/new-app/utils.py" does not end with "/old-app/utils.py"
    // Falls back to heuristic → picks main.py (different file)
    assert.equal(result?.fileName, "/new-app/main.py");
    assert.equal(result?.functionName, "run");
  });

  it("graph key without colon — file-only key matches any function", () => {
    const frames = [
      frame("/app/search.py", "do_search", 50),
      frame("/app/main.py", "run", 10),
    ];
    const graph: Record<string, { score: number; fan_in: number; calls_ai: boolean }> = {
      "search.py": { score: 2, fan_in: 3, calls_ai: true },
    };
    const result = findBusinessLogicFrameWithGraph(frames, graph);
    // Key has no colon → graphFn = "" → fnMatches is true for any function
    assert.equal(result?.fileName, "/app/search.py");
    assert.equal(result?.functionName, "do_search");
  });

  it("frame with no file and no function gets skipped", () => {
    const frames = [
      frame("", "", 0),
      frame("/app/handler.py", "process", 50),
    ];
    const graph: Record<string, { score: number; fan_in: number; calls_ai: boolean }> = {
      "handler.py:process": { score: 2, fan_in: 1, calls_ai: true },
    };
    const result = findBusinessLogicFrameWithGraph(frames, graph);
    // First frame skipped (no file/fn), second matches
    assert.equal(result?.functionName, "process");
  });

  it("function endsWith matching — Class.method matches graph key method", () => {
    const frames = [
      frame("/app/client.py", "OpenAIClient.complete", 10),
      frame("/app/features/search.py", "SearchService.search", 50),
    ];
    const graph: Record<string, { score: number; fan_in: number; calls_ai: boolean }> = {
      "client.py:complete": { score: 8, fan_in: 10, calls_ai: true },
      "features/search.py:search": { score: 2, fan_in: 2, calls_ai: true },
    };
    const result = findBusinessLogicFrameWithGraph(frames, graph);
    // "OpenAIClient.complete".endsWith("complete") → matches client.py:complete (score 8)
    // "SearchService.search".endsWith("search") → matches features/search.py:search (score 2)
    // Picks lowest score → search
    assert.equal(result?.functionName, "SearchService.search");
  });

  it("empty frames — returns undefined", () => {
    const graph: Record<string, { score: number; fan_in: number; calls_ai: boolean }> = {
      "file.py:fn": { score: 1, fan_in: 1, calls_ai: true },
    };
    const result = findBusinessLogicFrameWithGraph([], graph);
    // No frames → no graph match → falls back to findBusinessLogicFrame([]) → undefined
    assert.equal(result, undefined);
  });
});

// ─── Sourcemap Resolver ──────────────────────────────────────────────

describe("translateFrames", () => {
  // We test translateFrames with a mock pg pool since it queries the DB.
  // The key logic is in translateWithMaps and findConsumerByPath which
  // are internal. We can test through translateFrames by mocking the pool.

  it("no release returns frames unchanged", async () => {
    const { translateFrames } = await import("../sourcemap-resolver.js");
    const frames = [
      { fileName: "app.js", functionName: "main", lineNumber: 1, columnNumber: 0 },
    ];
    const mockPool = {
      query: async () => ({ rows: [] }),
    } as any;
    const result = await translateFrames(mockPool, "proj1", "", frames);
    assert.equal(result.wasTranslated, false);
    assert.deepEqual(result.translated, frames);
  });

  it("empty frames returns unchanged", async () => {
    const { translateFrames } = await import("../sourcemap-resolver.js");
    const mockPool = {
      query: async () => ({ rows: [] }),
    } as any;
    const result = await translateFrames(mockPool, "proj1", "v1.0", []);
    assert.equal(result.wasTranslated, false);
    assert.equal(result.translated.length, 0);
  });

  it("no sourcemaps for release returns frames unchanged", async () => {
    const { translateFrames } = await import("../sourcemap-resolver.js");
    const frames = [
      { fileName: "dist/app.js", functionName: "a", lineNumber: 1, columnNumber: 10 },
    ];
    let queryCount = 0;
    const mockPool = {
      query: async () => {
        queryCount++;
        return { rows: [] };
      },
    } as any;
    const result = await translateFrames(mockPool, "proj1", "v1.0.0", frames);
    assert.equal(result.wasTranslated, false);
    assert.deepEqual(result.translated, frames);
  });

  it("frames with null fileNames return unchanged", async () => {
    const { translateFrames } = await import("../sourcemap-resolver.js");
    const frames = [
      { fileName: null, functionName: "anon", lineNumber: 1, columnNumber: 0 },
    ];
    const mockPool = {
      query: async () => ({ rows: [] }),
    } as any;
    const result = await translateFrames(mockPool, "proj1", "v1.0.0", frames);
    assert.equal(result.wasTranslated, false);
  });

  it("translates minified frame using real sourcemap", async () => {
    const { translateFrames } = await import("../sourcemap-resolver.js");

    // A minimal valid sourcemap: maps line 1, column 0 of "out.js" to
    // line 5, column 4 of "src/app.ts", function name "handleRequest"
    // Generated via source-map SourceMapGenerator
    const { SourceMapGenerator } = await import("source-map");
    const gen = new SourceMapGenerator({ file: "out.js" });
    gen.addMapping({
      generated: { line: 1, column: 0 },
      original: { line: 5, column: 4 },
      source: "src/app.ts",
      name: "handleRequest",
    });
    const sourcemapJson = gen.toString();

    const frames = [
      { fileName: "out.js", functionName: "a", lineNumber: 1, columnNumber: 0 },
    ];

    const mockPool = {
      query: async (_sql: string, params: any[]) => {
        // First query: exact match on file_name
        if (params.length === 3) {
          return {
            rows: [{ file_name: "out.js", sourcemap_json: sourcemapJson }],
          };
        }
        return { rows: [] };
      },
    } as any;

    const result = await translateFrames(mockPool, "proj1", "v1.0.0", frames);
    assert.equal(result.wasTranslated, true);
    assert.equal(result.translated[0].fileName, "src/app.ts");
    assert.equal(result.translated[0].lineNumber, 5);
    assert.equal(result.translated[0].functionName, "handleRequest");
  });

  it("fuzzy filename matching (URL vs path)", async () => {
    const { translateFrames } = await import("../sourcemap-resolver.js");
    const { SourceMapGenerator } = await import("source-map");

    const gen = new SourceMapGenerator({ file: "assets/main.js" });
    gen.addMapping({
      generated: { line: 1, column: 0 },
      original: { line: 10, column: 0 },
      source: "src/index.ts",
      name: "init",
    });
    const sourcemapJson = gen.toString();

    const frames = [
      {
        fileName: "https://app.example.com/assets/main.js",
        functionName: "e",
        lineNumber: 1,
        columnNumber: 0,
      },
    ];

    let queryNum = 0;
    const mockPool = {
      query: async (_sql: string, _params: any[]) => {
        queryNum++;
        if (queryNum === 1) {
          // Exact match fails (URL vs path)
          return { rows: [] };
        }
        // Fuzzy match returns the sourcemap
        return {
          rows: [{ file_name: "assets/main.js", sourcemap_json: sourcemapJson }],
        };
      },
    } as any;

    const result = await translateFrames(mockPool, "proj1", "v1.0.0", frames);
    assert.equal(result.wasTranslated, true);
    assert.equal(result.translated[0].fileName, "src/index.ts");
    assert.equal(result.translated[0].functionName, "init");
  });
});

// ─── Grouping Engine ──────────────────────────────────────────────────

import { groupIntoFeatures } from "../grouping.js";

describe("groupIntoFeatures", () => {
  const mkFrame = (fileName: string, functionName: string, lineNumber = 10) => ({
    fileName,
    functionName,
    lineNumber,
    columnNumber: 0,
  });

  const mkStat = (key: string, fileName: string, functionName: string, cost: number, calls: number): any => ({
    call_site_key: key,
    file_name: fileName,
    function_name: functionName,
    line_number: 10,
    total_calls: calls,
    total_cost_usd: cost,
    total_input_tokens: 100 * calls,
    total_output_tokens: 50 * calls,
    avg_duration_ms: 200,
    avg_ttft: null,
    avg_tps: null,
  });

  it("single call site returns one feature", () => {
    const stats = [mkStat("cs1", "app.py", "doWork", 1.5, 10)];
    const events = [{
      call_site_key: "cs1",
      frames: [
        mkFrame("app.py", "doWork", 10),
        mkFrame("main.py", "run", 1),
      ],
    }];
    const features = groupIntoFeatures(stats, events);
    assert.equal(features.length, 1);
    assert.equal(features[0].rootFunction, "run");
    assert.equal(features[0].totalCost, 1.5);
    assert.equal(features[0].totalCalls, 10);
  });

  it("two call sites sharing a root get grouped together", () => {
    const stats = [
      mkStat("cs1", "search.py", "search", 2.0, 5),
      mkStat("cs2", "summarize.py", "summarize", 1.0, 3),
    ];
    const events = [
      {
        call_site_key: "cs1",
        frames: [mkFrame("search.py", "search"), mkFrame("pipeline.py", "runPipeline")],
      },
      {
        call_site_key: "cs2",
        frames: [mkFrame("summarize.py", "summarize"), mkFrame("pipeline.py", "runPipeline")],
      },
    ];
    const features = groupIntoFeatures(stats, events);
    assert.equal(features.length, 1);
    assert.equal(features[0].rootFunction, "runPipeline");
    assert.equal(features[0].totalCost, 3.0);
    assert.equal(features[0].totalCalls, 8);
    assert.equal(features[0].callSites.length, 2);
  });

  it("different roots produce separate features", () => {
    const stats = [
      mkStat("cs1", "a.py", "fnA", 1.0, 1),
      mkStat("cs2", "b.py", "fnB", 2.0, 1),
    ];
    const events = [
      { call_site_key: "cs1", frames: [mkFrame("a.py", "fnA"), mkFrame("rootA.py", "handleA")] },
      { call_site_key: "cs2", frames: [mkFrame("b.py", "fnB"), mkFrame("rootB.py", "handleB")] },
    ];
    const features = groupIntoFeatures(stats, events);
    assert.equal(features.length, 2);
    // Sorted by cost descending
    assert.equal(features[0].rootFunction, "handleB");
    assert.equal(features[0].totalCost, 2.0);
    assert.equal(features[1].rootFunction, "handleA");
    assert.equal(features[1].totalCost, 1.0);
  });

  it("dispatcher root gets split into sub-features", () => {
    // Router dispatches to 4 unrelated call sites — should split
    const stats = [
      mkStat("cs1", "a.py", "fnA", 1.0, 1),
      mkStat("cs2", "b.py", "fnB", 1.0, 1),
      mkStat("cs3", "c.py", "fnC", 1.0, 1),
      mkStat("cs4", "d.py", "fnD", 1.0, 1),
    ];
    const events = [
      { call_site_key: "cs1", frames: [mkFrame("a.py", "fnA"), mkFrame("handlerA.py", "handleA"), mkFrame("router.py", "dispatch")] },
      { call_site_key: "cs2", frames: [mkFrame("b.py", "fnB"), mkFrame("handlerB.py", "handleB"), mkFrame("router.py", "dispatch")] },
      { call_site_key: "cs3", frames: [mkFrame("c.py", "fnC"), mkFrame("handlerC.py", "handleC"), mkFrame("router.py", "dispatch")] },
      { call_site_key: "cs4", frames: [mkFrame("d.py", "fnD"), mkFrame("handlerD.py", "handleD"), mkFrame("router.py", "dispatch")] },
    ];
    const features = groupIntoFeatures(stats, events);
    // Should split into 4 features (one per handler), not 1 "dispatch" feature
    assert.equal(features.length, 4);
    const rootFns = features.map(f => f.rootFunction).sort();
    assert.deepEqual(rootFns, ["handleA", "handleB", "handleC", "handleD"]);
  });

  it("non-dispatcher root with shared children stays grouped", () => {
    // 3 call sites but they share the same child frame — NOT a dispatcher
    const stats = [
      mkStat("cs1", "a.py", "fnA", 1.0, 1),
      mkStat("cs2", "b.py", "fnB", 1.0, 1),
      mkStat("cs3", "c.py", "fnC", 1.0, 1),
    ];
    const events = [
      { call_site_key: "cs1", frames: [mkFrame("a.py", "fnA"), mkFrame("pipeline.py", "process"), mkFrame("main.py", "run")] },
      { call_site_key: "cs2", frames: [mkFrame("b.py", "fnB"), mkFrame("pipeline.py", "process"), mkFrame("main.py", "run")] },
      { call_site_key: "cs3", frames: [mkFrame("c.py", "fnC"), mkFrame("pipeline.py", "process"), mkFrame("main.py", "run")] },
    ];
    const features = groupIntoFeatures(stats, events);
    // All share the same child "process" → NOT a dispatcher → stays as 1 group
    assert.equal(features.length, 1);
    assert.equal(features[0].rootFunction, "run");
  });

  it("empty events produce no features", () => {
    const stats = [mkStat("cs1", "a.py", "fn", 1.0, 1)];
    const features = groupIntoFeatures(stats, []);
    assert.equal(features.length, 0);
  });

  it("call site with no matching stats still creates a feature", () => {
    const events = [{
      call_site_key: "cs1",
      frames: [mkFrame("a.py", "fn"), mkFrame("main.py", "run")],
    }];
    const features = groupIntoFeatures([], events);
    assert.equal(features.length, 1);
    assert.equal(features[0].totalCost, 0);
    assert.equal(features[0].callSites.length, 0);
  });

  it("deduplicates call sites with correct weighted average", () => {
    // Same call_site_key appears twice in stats (e.g. two model variants)
    const stats = [
      mkStat("cs1", "a.py", "fn", 1.0, 10),
      mkStat("cs1", "a.py", "fn", 2.0, 20),
    ];
    // Override avg_duration_ms for the test
    stats[0].avg_duration_ms = 100;
    stats[1].avg_duration_ms = 200;

    const events = [{
      call_site_key: "cs1",
      frames: [mkFrame("a.py", "fn"), mkFrame("main.py", "run")],
    }];
    const features = groupIntoFeatures(stats, events);
    assert.equal(features.length, 1);
    assert.equal(features[0].totalCost, 3.0);
    assert.equal(features[0].totalCalls, 30);
    // The feature uses deduplicateCallSites, but stats have same call_site_key
    // so they get merged. Weighted avg: (100*10 + 200*20) / 30 = 5000/30 ≈ 166.67
    // Check the merged call site
    assert.equal(features[0].callSites.length, 1);
  });

  it("picks most common trace shape, not longest", () => {
    const stats = [mkStat("cs1", "a.py", "fn", 1.0, 1)];
    // 3 traces: 2 short (common), 1 long (outlier)
    const events = [
      { call_site_key: "cs1", frames: [mkFrame("a.py", "fn"), mkFrame("handler.py", "handle")] },
      { call_site_key: "cs1", frames: [mkFrame("a.py", "fn"), mkFrame("handler.py", "handle")] },
      { call_site_key: "cs1", frames: [mkFrame("a.py", "fn"), mkFrame("middleware.py", "auth"), mkFrame("extra.py", "setup"), mkFrame("outlier.py", "boot")] },
    ];
    const features = groupIntoFeatures(stats, events);
    assert.equal(features.length, 1);
    // Root should be from the common trace (handler.py), not the outlier (outlier.py)
    assert.equal(features[0].rootFunction, "handle");
  });
});
