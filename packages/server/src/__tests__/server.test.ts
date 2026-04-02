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

  it("all frames same file returns frame[0]", () => {
    const frames = [
      frame("client.py", "call_api", 10),
      frame("client.py", "wrapper", 50),
      frame("client.py", "init", 100),
    ];
    const result = findBusinessLogicFrame(frames);
    assert.equal(result.functionName, "call_api");
    assert.equal(result.lineNumber, 10);
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
    assert.equal(result.fileName, "/app/handler.py");
    assert.equal(result.functionName, "process");
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
