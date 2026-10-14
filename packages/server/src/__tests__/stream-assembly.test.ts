import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleStream, assembleStreamBody, STREAM_BODY_KEY } from "../telemetry/stream-assembly.js";

const sse = (event: string, data: Record<string, unknown>) => ({ event, data: { type: event, ...data } });

// ── OpenAI Responses ──

const responseItem = { id: "msg_1", type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: "You're up 4% this month.", annotations: [] }] };
const toolItem = { id: "fc_1", type: "function_call", status: "completed", call_id: "call_portfolio", name: "portfolio", arguments: "{\"range\":\"1m\"}" };

function responsesStream(withCompleted: boolean): unknown[] {
  const base = { id: "resp_1", object: "response", created_at: 1760000000, model: "gpt-5-mini", status: "in_progress", output: [] };
  const events: unknown[] = [
    sse("response.created", { sequence_number: 0, response: base }),
    sse("response.in_progress", { sequence_number: 1, response: base }),
    sse("response.output_item.added", { output_index: 0, item: { ...toolItem, status: "in_progress", arguments: "" } }),
    sse("response.function_call_arguments.delta", { output_index: 0, item_id: "fc_1", delta: "{\"range\":" }),
    sse("response.function_call_arguments.delta", { output_index: 0, item_id: "fc_1", delta: "\"1m\"}" }),
    sse("response.output_item.done", { output_index: 0, item: toolItem }),
    sse("response.output_item.added", { output_index: 1, item: { ...responseItem, status: "in_progress", content: [] } }),
    sse("response.output_text.delta", { output_index: 1, item_id: "msg_1", content_index: 0, delta: "You're up " }),
    sse("response.output_text.delta", { output_index: 1, item_id: "msg_1", content_index: 0, delta: "4% this month." }),
    sse("response.output_text.done", { output_index: 1, item_id: "msg_1", content_index: 0, text: "You're up 4% this month." }),
    sse("response.output_item.done", { output_index: 1, item: responseItem }),
  ];
  if (withCompleted) {
    events.push(sse("response.completed", {
      response: { ...base, status: "completed", output: [toolItem, responseItem], usage: { input_tokens: 120, output_tokens: 30, total_tokens: 150 } },
    }));
  }
  return events;
}

test("OpenAI Responses: the response.completed response is the body", () => {
  const assembled = assembleStream(responsesStream(true), { provider: "openai" }) as Record<string, unknown>;
  assert.equal(assembled["id"], "resp_1");
  assert.equal(assembled["status"], "completed");
  assert.deepEqual(assembled["output"], [toolItem, responseItem]);
  assert.deepEqual(assembled["usage"], { input_tokens: 120, output_tokens: 30, total_tokens: 150 });
});

test("OpenAI Responses: without response.completed the done items are the output", () => {
  const assembled = assembleStream(responsesStream(false)) as Record<string, unknown>;
  assert.equal(assembled["id"], "resp_1");
  assert.equal(assembled["model"], "gpt-5-mini");
  assert.deepEqual(assembled["output"], [toolItem, responseItem]);
});

test("OpenAI Responses: a stream cut before its message is done keeps the text", () => {
  const events = responsesStream(false).slice(0, 9);
  const assembled = assembleStream(events) as Record<string, unknown>;
  assert.deepEqual(assembled["output"], [toolItem, {
    type: "message", role: "assistant", status: "incomplete",
    content: [{ type: "output_text", text: "You're up 4% this month.", annotations: [] }],
  }]);
});

test("OpenAI Responses: an incomplete response is used when it is the last", () => {
  const events = [...responsesStream(false), sse("response.incomplete", {
    response: { id: "resp_1", object: "response", status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [toolItem] },
  })];
  const assembled = assembleStream(events) as Record<string, unknown>;
  assert.equal(assembled["status"], "incomplete");
  assert.deepEqual(assembled["output"], [toolItem]);
});

// ── Chat Completions ──

const chunk = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  id: "chatcmpl-1", object: "chat.completion.chunk", created: 1760000000, model: "gpt-4o-mini-2024-07-18", system_fingerprint: "fp_1",
  choices: [{ index: 0, delta, logprobs: null, finish_reason: null, ...extra }],
});

test("Chat Completions: text deltas become one message", () => {
  const events = [
    chunk({ role: "assistant", content: "", refusal: null }),
    chunk({ content: "Hello" }),
    chunk({ content: ", Naman." }),
    chunk({}, { finish_reason: "stop" }),
    { id: "chatcmpl-1", object: "chat.completion.chunk", created: 1760000000, model: "gpt-4o-mini-2024-07-18", choices: [], usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 } },
  ];
  assert.deepEqual(assembleStream(events), {
    id: "chatcmpl-1", created: 1760000000, model: "gpt-4o-mini-2024-07-18", system_fingerprint: "fp_1", object: "chat.completion",
    choices: [{ index: 0, message: { role: "assistant", content: "Hello, Naman." }, finish_reason: "stop" }],
    usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 },
  });
});

test("Chat Completions: tool calls split over chunks are merged by index", () => {
  const events = [
    chunk({ role: "assistant", content: null }),
    chunk({ tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "get_weather", arguments: "" } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: "{\"city\":" } }] }),
    chunk({ tool_calls: [{ index: 1, id: "call_b", type: "function", function: { name: "get_time", arguments: "" } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: "\"Bengaluru\"}" } }] }),
    chunk({ tool_calls: [{ index: 1, function: { arguments: "{\"tz\":\"IST\"}" } }] }),
    chunk({}, { finish_reason: "tool_calls" }),
  ];
  const assembled = assembleStream(events) as { choices: Array<Record<string, unknown>> };
  assert.deepEqual(assembled.choices, [{
    index: 0,
    message: {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "call_a", type: "function", function: { name: "get_weather", arguments: "{\"city\":\"Bengaluru\"}" } },
        { id: "call_b", type: "function", function: { name: "get_time", arguments: "{\"tz\":\"IST\"}" } },
      ],
    },
    finish_reason: "tool_calls",
  }]);
});

test("Chat Completions: compatible providers (DeepSeek reasoning, repeated tool names)", () => {
  const events = [
    { id: "x", model: "deepseek-reasoner", choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "Think" } }] },
    { id: "x", model: "deepseek-reasoner", choices: [{ index: 0, delta: { reasoning_content: "ing." } }] },
    { id: "x", model: "deepseek-reasoner", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "t1", function: { name: "search", arguments: "{\"q\"" } }] } }] },
    { id: "x", model: "deepseek-reasoner", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: "search", arguments: ":1}" } }] } }] },
    { id: "x", model: "deepseek-reasoner", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 3, completion_tokens: 5 } },
  ];
  const message = (assembleStream(events) as { choices: Array<{ message: Record<string, unknown> }> }).choices[0]!.message;
  assert.equal(message["reasoning_content"], "Thinking.");
  assert.deepEqual(message["tool_calls"], [{ id: "t1", type: "function", function: { name: "search", arguments: "{\"q\":1}" } }]);
});

// ── Anthropic ──

test("Anthropic: text and a tool_use block assemble into one message", () => {
  const events = [
    sse("message_start", { message: { id: "msg_01", type: "message", role: "assistant", model: "claude-sonnet-4-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 472, output_tokens: 2 } } }),
    sse("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }),
    sse("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "Need the " } }),
    sse("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "weather." } }),
    sse("content_block_delta", { index: 0, delta: { type: "signature_delta", signature: "sig==" } }),
    sse("content_block_stop", { index: 0 }),
    sse("content_block_start", { index: 1, content_block: { type: "text", text: "" } }),
    { event: "ping", data: { type: "ping" } },
    sse("content_block_delta", { index: 1, delta: { type: "text_delta", text: "Let me check " } }),
    sse("content_block_delta", { index: 1, delta: { type: "text_delta", text: "the weather." } }),
    sse("content_block_stop", { index: 1 }),
    sse("content_block_start", { index: 2, content_block: { type: "tool_use", id: "toolu_01", name: "get_weather", input: {} } }),
    sse("content_block_delta", { index: 2, delta: { type: "input_json_delta", partial_json: "" } }),
    sse("content_block_delta", { index: 2, delta: { type: "input_json_delta", partial_json: "{\"location\": \"San Fra" } }),
    sse("content_block_delta", { index: 2, delta: { type: "input_json_delta", partial_json: "ncisco, CA\"}" } }),
    sse("content_block_stop", { index: 2 }),
    sse("message_delta", { delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 89 } }),
    sse("message_stop", {}),
  ];
  assert.deepEqual(assembleStream(events, { provider: "anthropic" }), {
    id: "msg_01", type: "message", role: "assistant", model: "claude-sonnet-4-5",
    content: [
      { type: "thinking", thinking: "Need the weather.", signature: "sig==" },
      { type: "text", text: "Let me check the weather." },
      { type: "tool_use", id: "toolu_01", name: "get_weather", input: { location: "San Francisco, CA" } },
    ],
    stop_reason: "tool_use", stop_sequence: null,
    usage: { input_tokens: 472, output_tokens: 89 },
  });
});

// ── Gemini ──

test("Gemini: chunks merge text parts and keep function calls and the last usage", () => {
  const usage = (out: number) => ({ promptTokenCount: 8, candidatesTokenCount: out, totalTokenCount: 8 + out });
  const events = [
    { candidates: [{ content: { role: "model", parts: [{ text: "The capital " }] }, index: 0 }], usageMetadata: usage(2), modelVersion: "gemini-2.5-flash", responseId: "r1" },
    { candidates: [{ content: { role: "model", parts: [{ text: "of France is Paris." }] }, index: 0 }], usageMetadata: usage(7), modelVersion: "gemini-2.5-flash", responseId: "r1" },
    { candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "lookup", args: { city: "Paris" } } }] }, index: 0 }], usageMetadata: usage(12), modelVersion: "gemini-2.5-flash", responseId: "r1" },
    { candidates: [{ content: { role: "model", parts: [{ text: "" }] }, finishReason: "STOP", index: 0 }], usageMetadata: usage(14), modelVersion: "gemini-2.5-flash", responseId: "r1" },
  ];
  assert.deepEqual(assembleStream(events, { provider: "google" }), {
    candidates: [{
      content: { parts: [{ text: "The capital of France is Paris." }, { functionCall: { name: "lookup", args: { city: "Paris" } } }, { text: "" }], role: "model" },
      finishReason: "STOP",
      index: 0,
    }],
    usageMetadata: usage(14),
    modelVersion: "gemini-2.5-flash",
    responseId: "r1",
  });
});

// ── Bedrock ──

test("Bedrock ConverseStream: text and tool use assemble into a Converse response", () => {
  const events = [
    { messageStart: { role: "assistant" } },
    { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "Checking your " } } },
    { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "balance." } } },
    { contentBlockStop: { contentBlockIndex: 0 } },
    { contentBlockStart: { contentBlockIndex: 1, start: { toolUse: { toolUseId: "tooluse_1", name: "balance" } } } },
    { contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: "{\"account\":" } } } },
    { contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: "\"savings\"}" } } } },
    { contentBlockStop: { contentBlockIndex: 1 } },
    { messageStop: { stopReason: "tool_use" } },
    { metadata: { usage: { inputTokens: 40, outputTokens: 12, totalTokens: 52 }, metrics: { latencyMs: 812 } } },
  ];
  assert.deepEqual(assembleStream(events, { provider: "bedrock" }), {
    output: { message: { role: "assistant", content: [
      { text: "Checking your balance." },
      { toolUse: { toolUseId: "tooluse_1", name: "balance", input: { account: "savings" } } },
    ] } },
    stopReason: "tool_use",
    usage: { inputTokens: 40, outputTokens: 12, totalTokens: 52 },
    metrics: { latencyMs: 812 },
  });
});

test("Bedrock InvokeModel stream of Claude: decoded chunks assemble as Anthropic", () => {
  const events = [
    { chunk: { bytes: { type: "message_start", message: { id: "msg_b", role: "assistant", model: "claude-3-haiku", content: [], usage: { input_tokens: 5, output_tokens: 1 } } } } },
    { chunk: { bytes: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } } },
    { chunk: { bytes: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } } } },
    { chunk: { bytes: Buffer.from(JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " there" } })).toString("base64") } },
    { chunk: { bytes: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } } } },
  ];
  const assembled = assembleStream(events) as Record<string, unknown>;
  assert.deepEqual(assembled["content"], [{ type: "text", text: "Hi there" }]);
  assert.equal(assembled["stop_reason"], "end_turn");
});

test("Bedrock ConverseStream: bare payloads (no event-type key) are recognised by their fields", () => {
  const events = [
    { role: "assistant", p: "abcd" },
    { contentBlockIndex: 0, delta: { text: "Checking your " }, p: "abcdefgh" },
    { contentBlockIndex: 0, delta: { text: "balance." }, p: "ab" },
    { contentBlockIndex: 0, p: "abc" },
    { contentBlockIndex: 1, start: { toolUse: { toolUseId: "tooluse_1", name: "balance" } }, p: "a" },
    { contentBlockIndex: 1, delta: { toolUse: { input: "{\"account\":\"savings\"}" } }, p: "abcd" },
    { contentBlockIndex: 1, p: "ab" },
    { stopReason: "tool_use", p: "abcdef" },
    { usage: { inputTokens: 40, outputTokens: 12, totalTokens: 52 }, metrics: { latencyMs: 812 }, p: "abc" },
  ];
  assert.deepEqual(assembleStream(events), {
    output: { message: { role: "assistant", content: [
      { text: "Checking your balance." },
      { toolUse: { toolUseId: "tooluse_1", name: "balance", input: { account: "savings" } } },
    ] } },
    stopReason: "tool_use",
    usage: { inputTokens: 40, outputTokens: 12, totalTokens: 52 },
    metrics: { latencyMs: 812 },
  });
});

test("Bedrock InvokeModel stream: bare { bytes, p } payloads assemble as the model's own stream", () => {
  const events = [
    { bytes: { type: "message_start", message: { id: "msg_c", role: "assistant", model: "claude-3-haiku", content: [], usage: { input_tokens: 5, output_tokens: 1 } } }, p: "abc" },
    { bytes: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, p: "a" },
    { bytes: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } }, p: "abcd" },
    { bytes: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }, p: "ab" },
  ];
  const assembled = assembleStream(events) as Record<string, unknown>;
  assert.deepEqual(assembled["content"], [{ type: "text", text: "Hello" }]);
  assert.equal(assembled["stop_reason"], "end_turn");
  assert.deepEqual(assembled["usage"], { input_tokens: 5, output_tokens: 2 });
});

// ── Unknown ──

test("an unrecognised stream is kept as its events", () => {
  const events = [{ token: "a" }, { token: "b" }, "stray"];
  assert.deepEqual(assembleStream(events), { [STREAM_BODY_KEY]: events });
  assert.deepEqual(assembleStream([]), { [STREAM_BODY_KEY]: [] });
});

test("only stream wrappers are assembled", () => {
  const body = { output_text: "Quite." };
  assert.equal(assembleStreamBody(body), body);
  // A streamed request answered with one plain JSON document (an error) is not wrapped.
  const error = { error: { type: "rate_limit_error", message: "Slow down" } };
  assert.equal(assembleStreamBody(error), error);
  assert.deepEqual(assembleStreamBody({ [STREAM_BODY_KEY]: [] }), { [STREAM_BODY_KEY]: [] });
  assert.equal(assembleStreamBody(null), null);
  assert.deepEqual(assembleStreamBody({ [STREAM_BODY_KEY]: [chunk({ content: "ok" })] }), {
    id: "chatcmpl-1", created: 1760000000, model: "gpt-4o-mini-2024-07-18", system_fingerprint: "fp_1", object: "chat.completion",
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: null }],
  });
});
