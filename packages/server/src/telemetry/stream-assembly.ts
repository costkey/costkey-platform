/**
 * Streamed calls arrive with `responseBody = { "__costkey_stream__": [events] }`:
 * every parsed stream event, in order (SSE `data:` JSON, NDJSON lines, or
 * decoded Bedrock event-stream messages keyed by event type). SSE events with
 * an `event:` name come as `{ event, data }`.
 *
 * The console reads non-streaming response shapes, so ingest stores the
 * stream assembled into the provider's own non-streaming response. Content
 * only: usage and cost come from the telemetry envelope, not from here.
 */

export const STREAM_BODY_KEY = "__costkey_stream__";

export interface StreamHints {
  provider?: string | null;
  url?: string | null;
  model?: string | null;
}

type Rec = Record<string, unknown>;

const asRec = (value: unknown): Rec | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Rec : null;
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** The stream events of a `{ __costkey_stream__: [...] }` body, or null. */
export function streamEvents(body: unknown): unknown[] | null {
  const record = asRec(body);
  if (!record) return null;
  const events = record[STREAM_BODY_KEY];
  return Array.isArray(events) ? events : null;
}

/**
 * A response body as stored: an SDK stream wrapper becomes the assembled
 * provider response; any other body is returned unchanged.
 */
export function assembleStreamBody(body: unknown, hints: StreamHints = {}): unknown {
  const events = streamEvents(body);
  if (!events) return body;
  try {
    return assembleStream(events, hints);
  } catch {
    return body;
  }
}

/** One stream element with its event name (SSE `event:`, Bedrock key or payload `type`). */
interface StreamEvent {
  name: string | null;
  data: Rec;
}

const BEDROCK_CONVERSE_EVENTS = new Set(["messageStart", "contentBlockStart", "contentBlockDelta", "contentBlockStop", "messageStop"]);
const BEDROCK_KEYS = new Set([...BEDROCK_CONVERSE_EVENTS, "metadata", "chunk"]);

function normalize(element: unknown): StreamEvent | null {
  const record = asRec(element);
  if (!record) return null;
  const keys = Object.keys(record);
  // SSE event with a name: { event, data }.
  if (typeof record["event"] === "string" && "data" in record
    && keys.every((key) => key === "event" || key === "data" || key === "id" || key === "retry")) {
    const data = asRec(record["data"]);
    if (!data) return null;
    return { name: record["event"] as string, data };
  }
  // Bedrock event-stream message: { "<event-type>": payload }.
  if (keys.length === 1 && (BEDROCK_KEYS.has(keys[0]!) || /Exception$/i.test(keys[0]!))) {
    return { name: keys[0]!, data: asRec(record[keys[0]!]) ?? {} };
  }
  return { name: str(record["type"]), data: record };
}

function typeOf(event: StreamEvent): string | null {
  return str(event.data["type"]) ?? event.name;
}

/** Assemble a stream's events into the provider's non-streaming response shape. */
export function assembleStream(events: readonly unknown[], hints: StreamHints = {}): unknown {
  const normalized = events.map(normalize).filter((event): event is StreamEvent => event !== null);
  const unchanged = { [STREAM_BODY_KEY]: events };
  if (normalized.length === 0) return unchanged;

  // Bedrock InvokeModel streams: each message's bytes is the model's own stream
  // event. The SDK sends the payload (`{ bytes, p }`); `{ chunk: { bytes } }` is
  // the keyed form.
  if (normalized.some(isInvokeChunk)) {
    const decoded = normalized
      .filter(isInvokeChunk)
      .map((event) => decodeBytes(event.data["bytes"]))
      .filter((value) => value !== null);
    const assembled = decoded.length ? assembleStream(decoded, hints) : unchanged;
    return streamEvents(assembled) ? unchanged : assembled;
  }

  // Bedrock ConverseStream: keyed `{ contentBlockDelta: {...} }` or, as the SDK
  // sends it, the bare payload, recognised by its fields.
  if (normalized.some((event) => event.name !== null && BEDROCK_CONVERSE_EVENTS.has(event.name) && !("type" in event.data))) {
    return assembleBedrockConverse(normalized);
  }
  const converseUrl = hints.url ? /\/converse-stream\/?$/.test(safePath(hints.url)) : false;
  if (normalized.some((event) => isBareConverse(event) || (converseUrl && isConversePayload(event.data)))) {
    return assembleBedrockConverse(normalized.map(bareBedrockEvent));
  }

  const types = normalized.map(typeOf);
  if (types.some((type) => type?.startsWith("response."))) return assembleOpenAiResponses(normalized);
  if (types.some((type) => type === "message_start" || type === "content_block_start" || type === "content_block_delta" || type === "message_delta")) {
    return assembleAnthropic(normalized);
  }
  if (normalized.some((event) => Array.isArray(event.data["choices"]))) return assembleChatCompletions(normalized);
  if (normalized.some((event) => Array.isArray(event.data["candidates"]) || asRec(event.data["usageMetadata"]))) {
    return assembleGemini(normalized);
  }
  if (normalized.some((event) => typeof event.data["done"] === "boolean" && (asRec(event.data["message"]) || typeof event.data["response"] === "string"))) {
    return assembleOllama(normalized);
  }
  return unchanged;
}

function safePath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function isInvokeChunk(event: StreamEvent): boolean {
  if (!("bytes" in event.data)) return false;
  return event.name === "chunk" || Object.keys(event.data).every((key) => key === "bytes" || key === "p");
}

/** Fields only a Converse stream payload carries. */
function isConversePayload(data: Rec): boolean {
  if ("type" in data || "choices" in data || "candidates" in data) return false;
  return typeof data["contentBlockIndex"] === "number" || typeof data["stopReason"] === "string"
    || (asRec(data["usage"]) !== null && asRec(data["metrics"]) !== null);
}

/** A Converse payload sent without its event-type key. */
function isBareConverse(event: StreamEvent): boolean {
  return event.name === null && isConversePayload(event.data);
}

function decodeBytes(value: unknown): unknown {
  if (asRec(value)) return value;
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(Buffer.from(value, "base64").toString("utf8")) as unknown;
  } catch {
    return null;
  }
}

/** A Converse payload with no event-type key: name it by its fields. */
function bareBedrockEvent(event: StreamEvent): StreamEvent {
  const data = event.data;
  const name = "start" in data ? "contentBlockStart"
    : "delta" in data ? "contentBlockDelta"
      : "stopReason" in data ? "messageStop"
        : "contentBlockIndex" in data ? "contentBlockStop"
          : "role" in data ? "messageStart"
            : "usage" in data || "metrics" in data ? "metadata"
              : event.name;
  return { name, data };
}

function parseJsonOr(text: string): unknown {
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

// ── OpenAI Responses API ──

const RESPONSES_TERMINAL = new Set(["response.completed", "response.incomplete", "response.failed"]);

function assembleOpenAiResponses(events: StreamEvent[]): Rec {
  let terminal: Rec | null = null;
  let base: Rec | null = null;
  let error: Rec | null = null;
  const done = new Map<number, unknown>();
  // Text of items the stream never finished, by output index.
  const text = new Map<number, string>();
  for (const event of events) {
    const type = typeOf(event);
    const data = event.data;
    if (type && RESPONSES_TERMINAL.has(type) && asRec(data["response"])) terminal = asRec(data["response"]);
    else if ((type === "response.created" || type === "response.in_progress") && asRec(data["response"])) base = asRec(data["response"]);
    else if (type === "response.output_item.done" && asRec(data["item"])) {
      done.set(num(data["output_index"]) ?? done.size, data["item"]);
    } else if (type === "response.output_text.delta" && typeof data["delta"] === "string") {
      const index = num(data["output_index"]) ?? 0;
      text.set(index, (text.get(index) ?? "") + data["delta"]);
    } else if (type === "error") error = { code: data["code"] ?? null, message: data["message"] ?? null };
  }
  const doneItems = [...done.entries()].sort((a, b) => a[0] - b[0]).map(([, item]) => item);
  if (terminal) {
    const output = terminal["output"];
    return Array.isArray(output) && output.length === 0 && doneItems.length ? { ...terminal, output: doneItems } : terminal;
  }
  const items = new Map(done);
  for (const [index, delta] of text) {
    if (items.has(index)) continue;
    items.set(index, { type: "message", role: "assistant", status: "incomplete", content: [{ type: "output_text", text: delta, annotations: [] }] });
  }
  const output = [...items.entries()].sort((a, b) => a[0] - b[0]).map(([, item]) => item);
  const assembled: Rec = { ...(base ?? {}), output };
  if (error) assembled["error"] = error;
  return assembled;
}

// ── OpenAI Chat Completions (and compatible providers) ──

interface ToolCallAcc {
  id?: string;
  type?: string;
  name?: string;
  arguments: string;
}

interface ChoiceAcc {
  role: string | null;
  content: string | null;
  refusal: string | null;
  reasoning: Map<string, string>;
  toolCalls: Map<number, ToolCallAcc>;
  functionCall: { name?: string; arguments: string } | null;
  annotations: unknown[];
  text: string | null;
  finishReason: unknown;
  logprobs: unknown[];
}

function assembleChatCompletions(events: StreamEvent[]): Rec {
  const head: Rec = {};
  let usage: unknown;
  const choices = new Map<number, ChoiceAcc>();
  for (const { data } of events) {
    for (const key of ["id", "created", "model", "system_fingerprint", "service_tier", "provider"]) {
      if (head[key] === undefined && data[key] != null) head[key] = data[key];
    }
    if (asRec(data["usage"])) usage = data["usage"];
    if (!Array.isArray(data["choices"])) continue;
    for (const [position, raw] of data["choices"].entries()) {
      const choice = asRec(raw);
      if (!choice) continue;
      const index = num(choice["index"]) ?? position;
      let acc = choices.get(index);
      if (!acc) {
        acc = { role: null, content: null, refusal: null, reasoning: new Map(), toolCalls: new Map(), functionCall: null, annotations: [], text: null, finishReason: null, logprobs: [] };
        choices.set(index, acc);
      }
      if (choice["finish_reason"] != null) acc.finishReason = choice["finish_reason"];
      if (typeof choice["text"] === "string") acc.text = (acc.text ?? "") + choice["text"];
      const logprobs = asRec(choice["logprobs"]);
      if (logprobs && Array.isArray(logprobs["content"])) acc.logprobs.push(...logprobs["content"]);
      const delta = asRec(choice["delta"]) ?? asRec(choice["message"]);
      if (!delta) continue;
      if (typeof delta["role"] === "string" && delta["role"]) acc.role ??= delta["role"];
      if (typeof delta["content"] === "string") acc.content = (acc.content ?? "") + delta["content"];
      if (typeof delta["refusal"] === "string") acc.refusal = (acc.refusal ?? "") + delta["refusal"];
      for (const key of ["reasoning_content", "reasoning"]) {
        if (typeof delta[key] === "string") acc.reasoning.set(key, (acc.reasoning.get(key) ?? "") + delta[key]);
      }
      if (Array.isArray(delta["annotations"])) acc.annotations.push(...delta["annotations"]);
      const functionCall = asRec(delta["function_call"]);
      if (functionCall) {
        acc.functionCall ??= { arguments: "" };
        if (typeof functionCall["name"] === "string") acc.functionCall.name = (acc.functionCall.name ?? "") + functionCall["name"];
        if (typeof functionCall["arguments"] === "string") acc.functionCall.arguments += functionCall["arguments"];
      }
      if (!Array.isArray(delta["tool_calls"])) continue;
      for (const [callPosition, rawCall] of delta["tool_calls"].entries()) {
        const call = asRec(rawCall);
        if (!call) continue;
        const callIndex = num(call["index"]) ?? callPosition;
        let tool = acc.toolCalls.get(callIndex);
        if (!tool) {
          tool = { arguments: "" };
          acc.toolCalls.set(callIndex, tool);
        }
        if (typeof call["id"] === "string" && call["id"]) tool.id ??= call["id"];
        if (typeof call["type"] === "string" && call["type"]) tool.type ??= call["type"];
        const fn = asRec(call["function"]);
        if (!fn) continue;
        const name = str(fn["name"]);
        // OpenAI sends the name once; some compatible providers repeat it whole.
        if (name && tool.name !== name) tool.name = (tool.name ?? "") + name;
        const args = fn["arguments"];
        if (typeof args === "string") tool.arguments += args;
        else if (args != null && typeof args === "object") tool.arguments += JSON.stringify(args);
      }
    }
  }
  const assembled: Rec = { ...head, object: "chat.completion" };
  assembled["choices"] = [...choices.entries()].sort((a, b) => a[0] - b[0]).map(([index, acc]) => {
    const result: Rec = { index };
    if (acc.text !== null && acc.role === null && acc.content === null && acc.toolCalls.size === 0) {
      result["text"] = acc.text;
    } else {
      const message: Rec = { role: acc.role ?? "assistant", content: acc.content };
      if (acc.refusal !== null) message["refusal"] = acc.refusal;
      for (const [key, value] of acc.reasoning) message[key] = value;
      if (acc.annotations.length) message["annotations"] = acc.annotations;
      if (acc.toolCalls.size) {
        message["tool_calls"] = [...acc.toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, tool]) => ({
          id: tool.id ?? null,
          type: tool.type ?? "function",
          function: { name: tool.name ?? "", arguments: tool.arguments },
        }));
      }
      if (acc.functionCall) message["function_call"] = { name: acc.functionCall.name ?? "", arguments: acc.functionCall.arguments };
      result["message"] = message;
    }
    if (acc.logprobs.length) result["logprobs"] = { content: acc.logprobs };
    result["finish_reason"] = acc.finishReason ?? null;
    return result;
  });
  if (usage !== undefined) assembled["usage"] = usage;
  return assembled;
}

// ── Anthropic messages ──

interface BlockAcc {
  block: Rec;
  json: string | null;
}

function finishBlock(acc: BlockAcc): void {
  if (acc.json === null) return;
  acc.block["input"] = parseJsonOr(acc.json);
  acc.json = null;
}

function assembleAnthropic(events: StreamEvent[]): Rec {
  let message: Rec = { type: "message", role: "assistant" };
  const blocks = new Map<number, BlockAcc>();
  let usage: Rec | null = null;
  let error: unknown;
  for (const event of events) {
    const type = typeOf(event);
    const data = event.data;
    if (type === "message_start") {
      const start = asRec(data["message"]);
      if (start) {
        message = { ...message, ...start };
        usage = asRec(start["usage"]) ? { ...(start["usage"] as Rec) } : usage;
      }
    } else if (type === "content_block_start") {
      const index = num(data["index"]) ?? blocks.size;
      const block = { ...(asRec(data["content_block"]) ?? {}) };
      const usesInput = "input" in block && (block["type"] === "tool_use" || block["type"] === "server_tool_use" || block["type"] === "mcp_tool_use");
      blocks.set(index, { block, json: usesInput ? "" : null });
    } else if (type === "content_block_delta") {
      const index = num(data["index"]) ?? blocks.size - 1;
      let acc = blocks.get(index);
      const delta = asRec(data["delta"]) ?? {};
      if (!acc) {
        acc = { block: { type: delta["type"] === "thinking_delta" ? "thinking" : delta["type"] === "input_json_delta" ? "tool_use" : "text" }, json: null };
        blocks.set(index, acc);
      }
      const block = acc.block;
      switch (delta["type"]) {
        case "text_delta":
          block["text"] = (str(block["text"]) ?? "") + (str(delta["text"]) ?? "");
          break;
        case "input_json_delta":
          acc.json = (acc.json ?? "") + (str(delta["partial_json"]) ?? "");
          break;
        case "thinking_delta":
          block["thinking"] = (str(block["thinking"]) ?? "") + (str(delta["thinking"]) ?? "");
          break;
        case "signature_delta":
          block["signature"] = (str(block["signature"]) ?? "") + (str(delta["signature"]) ?? "");
          break;
        case "citations_delta":
          block["citations"] = [...(Array.isArray(block["citations"]) ? block["citations"] : []), delta["citation"]];
          break;
        default:
          break;
      }
    } else if (type === "content_block_stop") {
      const acc = blocks.get(num(data["index"]) ?? -1);
      if (acc) finishBlock(acc);
    } else if (type === "message_delta") {
      const delta = asRec(data["delta"]) ?? {};
      for (const [key, value] of Object.entries(delta)) message[key] = value;
      const deltaUsage = asRec(data["usage"]);
      if (deltaUsage) {
        usage = { ...(usage ?? {}) };
        for (const [key, value] of Object.entries(deltaUsage)) if (value != null) usage[key] = value;
      }
    } else if (type === "error") {
      error = data["error"] ?? data;
    }
  }
  for (const acc of blocks.values()) finishBlock(acc);
  message["content"] = [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, acc]) => acc.block);
  if (!("stop_reason" in message)) message["stop_reason"] = null;
  if (usage) message["usage"] = usage;
  if (error !== undefined) message["error"] = error;
  return message;
}

// ── Gemini generateContent ──

function isPlainText(part: Rec): boolean {
  return typeof part["text"] === "string"
    && Object.keys(part).every((key) => key === "text" || key === "thought" || key === "thoughtSignature" || key === "thought_signature");
}

function assembleGemini(events: StreamEvent[]): Rec {
  const assembled: Rec = {};
  const candidates = new Map<number, { candidate: Rec; role: unknown; parts: Rec[] }>();
  for (const { data } of events) {
    for (const [key, value] of Object.entries(data)) {
      if (key === "candidates" || value == null) continue;
      assembled[key] = value; // usageMetadata, modelVersion, responseId, promptFeedback: the last wins
    }
    if (!Array.isArray(data["candidates"])) continue;
    for (const [position, raw] of data["candidates"].entries()) {
      const candidate = asRec(raw);
      if (!candidate) continue;
      const index = num(candidate["index"]) ?? position;
      let acc = candidates.get(index);
      if (!acc) {
        acc = { candidate: {}, role: undefined, parts: [] };
        candidates.set(index, acc);
      }
      for (const [key, value] of Object.entries(candidate)) {
        if (key !== "content" && value != null) acc.candidate[key] = value; // finishReason, safetyRatings, grounding: the last wins
      }
      const content = asRec(candidate["content"]);
      if (!content) continue;
      if (content["role"] != null) acc.role = content["role"];
      for (const rawPart of Array.isArray(content["parts"]) ? content["parts"] : []) {
        const part = asRec(rawPart);
        if (!part) continue;
        const last = acc.parts[acc.parts.length - 1];
        if (last && isPlainText(last) && isPlainText(part) && Boolean(last["thought"]) === Boolean(part["thought"])) {
          const merged: Rec = { ...last, ...part, text: (last["text"] as string) + (part["text"] as string) };
          acc.parts[acc.parts.length - 1] = merged;
        } else {
          acc.parts.push({ ...part });
        }
      }
    }
  }
  const usage = assembled["usageMetadata"];
  delete assembled["usageMetadata"];
  const result: Rec = {
    candidates: [...candidates.entries()].sort((a, b) => a[0] - b[0]).map(([index, acc]) => {
      const content: Rec = { parts: acc.parts };
      if (acc.role !== undefined) content["role"] = acc.role;
      return { content, ...acc.candidate, index };
    }),
  };
  if (usage !== undefined) result["usageMetadata"] = usage;
  return { ...result, ...assembled };
}

// ── Bedrock ConverseStream ──

interface ConverseBlockAcc {
  kind: "text" | "toolUse" | "reasoning" | "other";
  text: string;
  toolUse: Rec | null;
  input: string;
  signature: string | null;
  redacted: string | null;
  citations: unknown[];
  other: Rec | null;
}

function assembleBedrockConverse(events: StreamEvent[]): Rec {
  let role = "assistant";
  const blocks = new Map<number, ConverseBlockAcc>();
  const result: Rec = {};
  const block = (index: number): ConverseBlockAcc => {
    let acc = blocks.get(index);
    if (!acc) {
      acc = { kind: "text", text: "", toolUse: null, input: "", signature: null, redacted: null, citations: [], other: null };
      blocks.set(index, acc);
    }
    return acc;
  };
  for (const { name, data } of events) {
    if (name === "messageStart") {
      if (typeof data["role"] === "string") role = data["role"];
    } else if (name === "contentBlockStart") {
      const acc = block(num(data["contentBlockIndex"]) ?? blocks.size);
      const start = asRec(data["start"]) ?? {};
      const toolUse = asRec(start["toolUse"]);
      if (toolUse) {
        acc.kind = "toolUse";
        acc.toolUse = { ...toolUse };
      } else if (Object.keys(start).length) {
        acc.kind = "other";
        acc.other = { ...start };
      }
    } else if (name === "contentBlockDelta") {
      const acc = block(num(data["contentBlockIndex"]) ?? Math.max(0, blocks.size - 1));
      const delta = asRec(data["delta"]) ?? {};
      if (typeof delta["text"] === "string") acc.text += delta["text"];
      const toolUse = asRec(delta["toolUse"]);
      if (toolUse) {
        acc.kind = "toolUse";
        acc.toolUse ??= {};
        if (typeof toolUse["input"] === "string") acc.input += toolUse["input"];
      }
      const reasoning = asRec(delta["reasoningContent"]);
      if (reasoning) {
        acc.kind = "reasoning";
        if (typeof reasoning["text"] === "string") acc.text += reasoning["text"];
        if (typeof reasoning["signature"] === "string") acc.signature = (acc.signature ?? "") + reasoning["signature"];
        if (typeof reasoning["redactedContent"] === "string") acc.redacted = (acc.redacted ?? "") + reasoning["redactedContent"];
      }
      if (delta["citation"] != null) acc.citations.push(delta["citation"]);
    } else if (name === "messageStop") {
      for (const [key, value] of Object.entries(data)) if (key !== "p") result[key] = value;
    } else if (name === "metadata") {
      for (const [key, value] of Object.entries(data)) if (key !== "p") result[key] = value;
    } else if (name && /Exception$/i.test(name)) {
      result["error"] = { type: name, ...data };
    }
  }
  const content = [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, acc]) => {
    if (acc.kind === "toolUse") return { toolUse: { ...acc.toolUse, input: parseJsonOr(acc.input) } };
    if (acc.kind === "reasoning") {
      if (acc.redacted !== null && !acc.text) return { reasoningContent: { redactedContent: acc.redacted } };
      const reasoningText: Rec = { text: acc.text };
      if (acc.signature !== null) reasoningText["signature"] = acc.signature;
      return { reasoningContent: { reasoningText } };
    }
    if (acc.kind === "other" && acc.other) return acc.other;
    const text: Rec = { text: acc.text };
    if (acc.citations.length) text["citations"] = acc.citations;
    return text;
  });
  const { stopReason, ...rest } = result;
  return { output: { message: { role, content } }, stopReason: stopReason ?? null, ...rest };
}

// ── Ollama native (NDJSON) ──

function assembleOllama(events: StreamEvent[]): Rec {
  let last: Rec = {};
  let content = "";
  let thinking: string | null = null;
  let response: string | null = null;
  let role: unknown = "assistant";
  let chat = false;
  const toolCalls: unknown[] = [];
  for (const { data } of events) {
    last = data;
    const message = asRec(data["message"]);
    if (message) {
      chat = true;
      if (typeof message["role"] === "string" && message["role"]) role = message["role"];
      if (typeof message["content"] === "string") content += message["content"];
      if (typeof message["thinking"] === "string") thinking = (thinking ?? "") + message["thinking"];
      if (Array.isArray(message["tool_calls"])) toolCalls.push(...message["tool_calls"]);
    }
    if (typeof data["response"] === "string") response = (response ?? "") + data["response"];
  }
  if (!chat) return { ...last, response: response ?? "" };
  const message: Rec = { role, content };
  if (thinking !== null) message["thinking"] = thinking;
  if (toolCalls.length) message["tool_calls"] = toolCalls;
  return { ...last, message };
}
