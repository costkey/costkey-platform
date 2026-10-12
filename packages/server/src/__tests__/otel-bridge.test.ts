import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeAccountingEvent } from "../accounting.js";
import { stripSpanContent } from "../ingest.js";
import {
  capOtelAttributes,
  isOtelContentAttribute,
  mapOtelSpan,
  otelSpanInput,
  type OtelSpanInput,
} from "../telemetry/otel.js";

function input(attributes: Record<string, unknown>, otelName = "span", otelScope: string | null = null): OtelSpanInput {
  return { attributes, otelKind: 0, otelName, otelScope };
}

/** A span event as the JS bridge sends it (contract detail 9). */
function bridgeSpan(otel: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventType: "span",
    id: "a1b2c3d4e5f60718",
    traceId: "tr_1",
    parentSpanId: "0f1e2d3c4b5a6978",
    kind: "custom",
    name: "otel span name",
    status: "ok",
    timestamp: "2026-10-11T09:00:00.000Z",
    startedAt: "2026-10-11T09:00:00.000Z",
    endedAt: "2026-10-11T09:00:01.000Z",
    attributes: { otelKind: 1, otelName: "otel span name", otelScope: "test-scope", otel },
    ...extra,
  };
}

describe("OTel bridge: GenAI semantic conventions", () => {
  it("maps every gen_ai.operation.name", () => {
    const cases: Array<[string, string]> = [
      ["chat", "step"],
      ["text_completion", "step"],
      ["embeddings", "step"],
      ["execute_tool", "tool"],
      ["invoke_agent", "agent"],
      ["create_agent", "agent"],
    ];
    for (const [operation, kind] of cases) {
      const mapping = mapOtelSpan(input({ "gen_ai.operation.name": operation }));
      assert.equal(mapping.kind, kind, operation);
      assert.equal(mapping.convention, "gen_ai");
      assert.equal(mapping.operation, operation);
    }
  });

  it("names agents and tools after themselves and keeps the model and provider", () => {
    const agent = mapOtelSpan(input({
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.agent.name": "planner",
      "gen_ai.request.model": "gpt-4o",
      "gen_ai.provider.name": "openai",
    }, "invoke_agent planner"));
    assert.equal(agent.kind, "agent");
    assert.equal(agent.name, "planner");
    assert.equal(agent.model, "gpt-4o");
    assert.equal(agent.provider, "openai");

    const tool = mapOtelSpan(input({ "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "get_weather" }, "execute_tool get_weather"));
    assert.equal(tool.kind, "tool");
    assert.equal(tool.name, "get_weather");
  });

  it("prefers the response model and accepts the older gen_ai.system", () => {
    const chat = mapOtelSpan(input({
      "gen_ai.operation.name": "chat",
      "gen_ai.request.model": "gpt-4o",
      "gen_ai.response.model": "gpt-4o-2024-08-06",
      "gen_ai.system": "openai",
    }, "chat gpt-4o"));
    assert.equal(chat.kind, "step");
    assert.equal(chat.name, "chat gpt-4o");
    assert.equal(chat.model, "gpt-4o-2024-08-06");
    assert.equal(chat.provider, "openai");
  });

  it("guesses framework-specific operations by name (Strands, ADK)", () => {
    assert.equal(mapOtelSpan(input({ "gen_ai.operation.name": "execute_event_loop_cycle" })).kind, "step");
    assert.equal(mapOtelSpan(input({ "gen_ai.operation.name": "call_llm" })).kind, "step");
    assert.equal(mapOtelSpan(input({ "gen_ai.operation.name": "something_new" })).kind, "custom");
  });

  it("falls back to the OTel span name when an agent has no name", () => {
    const mapping = mapOtelSpan(input({ "gen_ai.operation.name": "invoke_agent" }, "invoke_agent"));
    assert.equal(mapping.kind, "agent");
    assert.equal(mapping.name, "invoke_agent");
  });
});

describe("OTel bridge: OpenInference", () => {
  it("maps every openinference.span.kind", () => {
    const cases: Array<[string, string]> = [
      ["AGENT", "agent"],
      ["TOOL", "tool"],
      ["CHAIN", "chain"],
      ["LLM", "step"],
      ["RETRIEVER", "retrieval"],
      ["EMBEDDING", "step"],
      ["RERANKER", "retrieval"],
      ["GUARDRAIL", "guardrail"],
    ];
    for (const [spanKind, kind] of cases) {
      const mapping = mapOtelSpan(input({ "openinference.span.kind": spanKind }));
      assert.equal(mapping.kind, kind, spanKind);
      assert.equal(mapping.convention, "openinference");
    }
  });

  it("reads tool.name and llm.model_name", () => {
    const tool = mapOtelSpan(input({ "openinference.span.kind": "TOOL", "tool.name": "search_docs" }, "tool"));
    assert.equal(tool.name, "search_docs");
    const llm = mapOtelSpan(input({ "openinference.span.kind": "LLM", "llm.model_name": "claude-sonnet-4-5", "llm.provider": "anthropic" }, "ChatAnthropic"));
    assert.equal(llm.kind, "step");
    assert.equal(llm.name, "ChatAnthropic");
    assert.equal(llm.model, "claude-sonnet-4-5");
    assert.equal(llm.provider, "anthropic");
  });
});

describe("OTel bridge: OpenLLMetry / Traceloop", () => {
  it("maps traceloop.span.kind and names spans after traceloop.entity.name", () => {
    const cases: Array<[string, string]> = [["workflow", "chain"], ["task", "step"], ["agent", "agent"], ["tool", "tool"]];
    for (const [spanKind, kind] of cases) {
      const mapping = mapOtelSpan(input({ "traceloop.span.kind": spanKind, "traceloop.entity.name": `my_${spanKind}` }, `my_${spanKind}.${spanKind}`));
      assert.equal(mapping.kind, kind, spanKind);
      assert.equal(mapping.name, `my_${spanKind}`);
      assert.equal(mapping.convention, "traceloop");
    }
  });

  it("treats an LLM span (llm.request.type) as a step", () => {
    const mapping = mapOtelSpan(input({ "llm.request.type": "chat", "gen_ai.system": "OpenAI", "gen_ai.request.model": "gpt-4o-mini" }, "openai.chat"));
    assert.equal(mapping.kind, "step");
    assert.equal(mapping.name, "openai.chat");
    assert.equal(mapping.model, "gpt-4o-mini");
  });
});

describe("OTel bridge: Pydantic AI / Logfire", () => {
  it("maps `agent run` and `running tool` spans", () => {
    const agent = mapOtelSpan(input({ agent_name: "support_agent", model_name: "gpt-4o" }, "agent run"));
    assert.equal(agent.kind, "agent");
    assert.equal(agent.name, "support_agent");
    assert.equal(agent.model, "gpt-4o");
    assert.equal(agent.convention, "pydantic_ai");

    const tool = mapOtelSpan(input({ "gen_ai.tool.name": "roulette_wheel", "gen_ai.tool.call.id": "call_1" }, "running tool"));
    assert.equal(tool.kind, "tool");
    assert.equal(tool.name, "roulette_wheel");
  });
});

describe("OTel bridge: Vercel AI SDK", () => {
  it("maps ai.operationId", () => {
    const root = mapOtelSpan(input({ "ai.operationId": "ai.generateText", "ai.telemetry.functionId": "summarize", "ai.model.id": "gpt-4o", "ai.model.provider": "openai.chat" }, "ai.generateText"));
    assert.equal(root.kind, "chain");
    assert.equal(root.name, "summarize");
    assert.equal(root.model, "gpt-4o");
    assert.equal(root.provider, "openai.chat");

    const step = mapOtelSpan(input({ "ai.operationId": "ai.generateText.doGenerate", "ai.model.id": "gpt-4o" }, "ai.generateText.doGenerate"));
    assert.equal(step.kind, "step");
    assert.equal(step.name, "ai.generateText.doGenerate");

    const tool = mapOtelSpan(input({ "ai.operationId": "ai.toolCall", "ai.toolCall.name": "weather", "ai.toolCall.id": "c1" }, "ai.toolCall"));
    assert.equal(tool.kind, "tool");
    assert.equal(tool.name, "weather");
    assert.equal(tool.convention, "vercel_ai");
  });

  it("names a root span without a functionId after the OTel span", () => {
    const root = mapOtelSpan(input({ "ai.operationId": "ai.streamText" }, "ai.streamText"));
    assert.equal(root.name, "ai.streamText");
  });
});

describe("OTel bridge: Mastra", () => {
  it("maps mastra.span.type", () => {
    const cases: Array<[string, string]> = [
      ["agent_run", "agent"], ["tool_call", "tool"], ["mcp_tool_call", "tool"],
      ["workflow_run", "chain"], ["workflow_step", "step"], ["llm_generation", "step"], ["generic", "custom"],
    ];
    for (const [type, kind] of cases) {
      assert.equal(mapOtelSpan(input({ "mastra.span.type": type })).kind, kind, type);
    }
    const agent = mapOtelSpan(input({ "mastra.span.type": "agent_run", "gen_ai.agent.name": "weatherAgent" }, "agent run: 'weatherAgent'"));
    assert.equal(agent.name, "weatherAgent");
    assert.equal(agent.convention, "mastra");
  });

  it("recognises legacy Mastra spans by scope and span name", () => {
    const mapping = mapOtelSpan(input({ componentName: "weatherAgent" }, "agent.generate", "@mastra/core"));
    assert.equal(mapping.kind, "agent");
    assert.equal(mapping.name, "weatherAgent");
  });
});

describe("OTel bridge: unrecognised spans", () => {
  it("become custom spans named after the OTel span", () => {
    const mapping = mapOtelSpan(input({ "http.method": "GET", "http.route": "/users" }, "GET /users"));
    assert.equal(mapping.kind, "custom");
    assert.equal(mapping.name, "GET /users");
    assert.equal(mapping.convention, null);
    assert.equal(mapping.model, null);
  });
});

describe("OTel bridge: span ingest", () => {
  it("maps kind, name and model attributes and keeps the hierarchy from the SDK's ids", () => {
    const normalized = normalizeAccountingEvent(bridgeSpan({
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.agent.name": "researcher",
      "gen_ai.request.model": "claude-sonnet-4-5",
      "gen_ai.provider.name": "anthropic",
    }, { name: "invoke_agent researcher" }));
    assert.equal(normalized.eventType, "span");
    assert.equal(normalized.spanId, "a1b2c3d4e5f60718");
    assert.equal(normalized.parentSpanId, "0f1e2d3c4b5a6978");
    assert.equal(normalized.traceId, "tr_1");
    assert.equal(normalized.spanKind, "agent");
    assert.equal(normalized.spanName, "researcher");
    const attributes = normalized.spanAttributes!;
    assert.equal(attributes["model"], "claude-sonnet-4-5");
    assert.equal(attributes["provider"], "anthropic");
    assert.equal(attributes["agentName"], "researcher");
    assert.equal(attributes["otelConvention"], "gen_ai");
    assert.equal(attributes["otelOperation"], "invoke_agent");
    assert.equal(attributes["otelScope"], "test-scope");
    assert.equal((attributes["otel"] as Record<string, unknown>)["gen_ai.agent.name"], "researcher");
  });

  it("maps the Python bridge shape (named otelKind, CostKey span ids)", () => {
    const normalized = normalizeAccountingEvent({
      eventType: "span",
      id: "sp_child",
      parentSpanId: "sp_parent",
      traceId: "tr_py",
      kind: "custom",
      name: "running tool",
      status: "ok",
      startedAt: "2026-10-11T09:00:00.000Z",
      attributes: {
        framework: "opentelemetry",
        otel: { "gen_ai.tool.name": "lookup", "gen_ai.tool.call.arguments": { $s: 40 } },
        otelKind: "INTERNAL",
        otelName: "running tool",
        otelScope: "pydantic-ai",
        otelTraceId: "0".repeat(32),
        otelSpanId: "1".repeat(16),
      },
    });
    assert.equal(normalized.spanKind, "tool");
    assert.equal(normalized.spanName, "lookup");
    assert.equal(normalized.parentSpanId, "sp_parent");
    assert.equal(normalized.spanAttributes!["otelKind"], "INTERNAL");
    assert.equal(normalized.spanAttributes!["framework"], "opentelemetry");
    assert.equal(normalized.spanAttributes!["otelSpanId"], "1".repeat(16));
  });

  it("accepts the OTel fields at the top level and an OTel parent id as a fallback", () => {
    const event = {
      eventType: "span",
      id: "abc",
      kind: "custom",
      name: "x",
      otel: { "openinference.span.kind": "RETRIEVER" },
      otelName: "retrieve",
      otelParentSpanId: "def",
    };
    assert.ok(otelSpanInput(event));
    const normalized = normalizeAccountingEvent(event);
    assert.equal(normalized.spanKind, "retrieval");
    assert.equal(normalized.spanName, "retrieve");
    assert.equal(normalized.parentSpanId, "def");
  });

  it("keeps a TS start event with no raw attributes as a custom span named after the OTel span", () => {
    const normalized = normalizeAccountingEvent({
      eventType: "span",
      id: "s1",
      kind: "custom",
      name: "chat gpt-4o",
      status: "running",
      attributes: { otelKind: 2, otelName: "chat gpt-4o", otelScope: "@opentelemetry/instrumentation-openai" },
    });
    assert.equal(normalized.spanKind, "custom");
    assert.equal(normalized.spanName, "chat gpt-4o");
    assert.equal(normalized.spanStatus, "running");
  });

  it("leaves a span the SDK already classified alone", () => {
    const normalized = normalizeAccountingEvent(bridgeSpan({ "gen_ai.operation.name": "chat" }, { kind: "judge" }));
    assert.equal(normalized.spanKind, "judge");
  });

  it("leaves non-OTel spans unchanged", () => {
    const normalized = normalizeAccountingEvent({
      eventType: "span", id: "s2", kind: "tool", name: "search", attributes: { query_count: 3 },
    });
    assert.equal(normalized.spanKind, "tool");
    assert.equal(normalized.spanName, "search");
    assert.deepEqual(normalized.spanAttributes, { query_count: 3 });
  });

  it("keeps raw attributes whole, mapping keys first", () => {
    const otel: Record<string, unknown> = {};
    for (let i = 0; i < 200; i += 1) otel[`custom.attribute.${i}`] = "v".repeat(60);
    otel["huge"] = "x".repeat(5_000);
    otel["gen_ai.operation.name"] = "execute_tool";
    otel["gen_ai.tool.name"] = "fetch_page";
    otel["gen_ai.usage.input_tokens"] = 12;
    const kept = capOtelAttributes(otel);
    assert.equal(Object.keys(kept)[0], "gen_ai.operation.name", "mapping keys come first");
    assert.equal(kept["gen_ai.tool.name"], "fetch_page");
    assert.equal(kept["gen_ai.usage.input_tokens"], 12);
    assert.equal(kept["huge"], "x".repeat(5_000), "nothing is cut");
    assert.equal(Object.keys(kept).length, Object.keys(otel).length);

    const normalized = normalizeAccountingEvent(bridgeSpan(otel));
    assert.equal(normalized.spanKind, "tool");
    assert.equal(normalized.spanName, "fetch_page");
    const stored = normalized.spanAttributes!["otel"] as Record<string, unknown>;
    assert.ok(stored, "raw OTel attributes are stored");
    assert.equal(stored["gen_ai.operation.name"], "execute_tool");
  });
});

describe("OTel bridge: never derives usage or cost", () => {
  it("keeps gen_ai.usage.* as raw attributes and sets no usage, model, units or amount", () => {
    const normalized = normalizeAccountingEvent(bridgeSpan({
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": "openai",
      "gen_ai.request.model": "gpt-4o",
      "gen_ai.response.model": "gpt-4o-2024-08-06",
      "gen_ai.usage.input_tokens": 1_200,
      "gen_ai.usage.output_tokens": 340,
      "gen_ai.usage.cost": 0.0123,
      "llm.token_count.total": 1_540,
      "ai.usage.promptTokens": 1_200,
    }));
    assert.equal(normalized.eventType, "span");
    assert.equal(normalized.spanKind, "step");
    // Nothing billable: the transport patch already recorded the model call.
    assert.equal(normalized.usage, null);
    assert.equal(normalized.model, null);
    assert.equal(normalized.requestModel, null);
    assert.equal(normalized.provider, "unknown");
    assert.equal(normalized.amount, null);
    assert.equal(normalized.amountPresent, false);
    assert.equal(normalized.unitKind, null);
    assert.equal(normalized.unitValue, null);
    // The values survive only as raw span attributes.
    const otel = normalized.spanAttributes!["otel"] as Record<string, unknown>;
    assert.equal(otel["gen_ai.usage.input_tokens"], 1_200);
    assert.equal(otel["gen_ai.usage.output_tokens"], 340);
    assert.equal(otel["gen_ai.usage.cost"], 0.0123);
    assert.equal(normalized.spanAttributes!["model"], "gpt-4o-2024-08-06");
    assert.ok(!Object.keys(normalized.spanAttributes!).some((key) => /usage|cost|tokens/i.test(key)));
  });
});

describe("OTel bridge: metadata-only privacy", () => {
  it("drops content-bearing raw OTel attributes and keeps counts and names", () => {
    const event = bridgeSpan({
      "gen_ai.operation.name": "chat",
      "gen_ai.request.model": "gpt-4o",
      "gen_ai.prompt.0.content": "secret prompt",
      "gen_ai.prompt.0.role": "user",
      "gen_ai.input.messages": "[{\"role\":\"user\"}]",
      "gen_ai.system_instructions": "be terse",
      "gen_ai.tool.call.arguments": "{\"q\":1}",
      "input.value": "hi",
      "ai.toolCall.args": "{}",
      "ai.response.text": "answer",
      tool_response: "result",
      "gen_ai.usage.input_tokens": 10,
      "llm.token_count.prompt": 10,
      "gen_ai.response.finish_reasons": ["stop"],
    });
    stripSpanContent(event);
    const otel = (event["attributes"] as Record<string, unknown>)["otel"] as Record<string, unknown>;
    assert.deepEqual(Object.keys(otel).sort(), [
      "gen_ai.operation.name",
      "gen_ai.prompt.0.role",
      "gen_ai.request.model",
      "gen_ai.response.finish_reasons",
      "gen_ai.usage.input_tokens",
      "llm.token_count.prompt",
    ]);
  });

  it("classifies content keys by their last segment", () => {
    assert.equal(isOtelContentAttribute("gen_ai.completion.0.content", "x"), true);
    assert.equal(isOtelContentAttribute("llm.output_messages.0.message.content", "x"), true);
    assert.equal(isOtelContentAttribute("gen_ai.response.model", "gpt-4o"), false);
    assert.equal(isOtelContentAttribute("gen_ai.usage.input_tokens", 4), false);
  });
});
