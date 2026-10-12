/**
 * Turns a stored request/response pair into a structured view of the call:
 * system prompt, conversation, configuration and output. Pure, no React.
 *
 * Recognised shapes: OpenAI chat completions, OpenAI Responses, Anthropic
 * messages, Gemini generateContent, Bedrock Converse, ElevenLabs text to
 * speech and embeddings. Anything else is `raw`.
 */

export type ContentFormat =
  | "openai-chat"
  | "openai-responses"
  | "anthropic"
  | "gemini"
  | "bedrock"
  | "elevenlabs"
  | "embeddings"
  | "raw";

export type MessageRole = "user" | "assistant" | "tool" | "system" | "developer";
export type AttachmentType = "image" | "audio" | "file" | "document";

export type ContentPart =
  | { kind: "text"; text: string; refusal?: boolean }
  | { kind: "json"; value: unknown }
  | { kind: "toolCall"; id: string | null; name: string; args: unknown; resultIndex?: number | null }
  | { kind: "toolResult"; callId: string | null; name: string | null; content: ContentPart[]; isError?: boolean; callIndex?: number | null }
  | { kind: "attachment"; type: AttachmentType; mimeType: string | null; sizeBytes: number | null; name?: string | null; detail?: string | null }
  | { kind: "thinking"; text: string }
  | { kind: "redacted"; label: string }
  | { kind: "omitted"; chars: number | null }
  | { kind: "vectors"; count: number; dimensions: number | null };

export interface ContentMessage {
  role: MessageRole;
  /** 1-based position in the conversation. */
  index: number;
  parts: ContentPart[];
}

export interface ResponseFormat {
  kind: "json_schema" | "json" | "text";
  name?: string | null;
  fieldCount?: number;
  schema?: unknown;
}

export interface ContentConfig {
  model?: string | null;
  temperature?: number | null;
  topP?: number | null;
  maxTokens?: number | null;
  reasoningEffort?: string | null;
  thinkingBudget?: number | null;
  tools?: Array<{ name: string; description?: string | null }>;
  responseFormat?: ResponseFormat | null;
  /** Format-specific settings shown as plain chips. */
  extras?: Array<{ label: string; value: string }>;
}

export interface ContentOutput {
  parts: ContentPart[];
  finishReason?: string | null;
  /** Canonical keys where known: input, output, reasoning, cacheRead, cacheWrite, total. */
  usage?: Record<string, number>;
}

export interface CallContent {
  format: ContentFormat;
  system: string | null;
  messages: ContentMessage[];
  config: ContentConfig;
  output: ContentOutput | null;
  /** How many secret markers the server's redaction left in this content. */
  redactedCount: number;
}

export interface ParseHints {
  provider?: string | null;
  model?: string | null;
}

type Obj = Record<string, unknown>;

// ── Small readers ──

function asObj(value: unknown): Obj | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Obj : null;
}
function asArr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function maybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

/** A JSON object or array hidden in a string (optionally fenced as ```json). */
export function jsonFromText(text: string): unknown {
  let trimmed = text.trim();
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/i.exec(trimmed);
  if (fence) trimmed = fence[1]!.trim();
  if (!(trimmed.startsWith("{") && trimmed.endsWith("}")) && !(trimmed.startsWith("[") && trimmed.endsWith("]"))) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed !== null && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

// ── Redaction, base64 and skeleton markers ──

/** The marker `redactCapturedContent` writes on the server, plus common masks. */
export const REDACTION_INLINE = /\[REDACTED\]|<redacted>|\[redacted\]/g;
const REDACTED_WHOLE = /^(?:\[REDACTED\]|<redacted>|\[redacted\]|REDACTED|\*{3,}|sk-[A-Za-z0-9_-]*(?:\*{3,}|\.{3}|…)[A-Za-z0-9_-]*)$/;

export function isRedactedValue(value: string): boolean {
  return REDACTED_WHOLE.test(value.trim());
}

/** Splits text on inline redaction markers so a renderer can mark them. */
export function splitRedactions(text: string): Array<{ text: string; redacted: boolean }> {
  const out: Array<{ text: string; redacted: boolean }> = [];
  let last = 0;
  for (const match of text.matchAll(REDACTION_INLINE)) {
    const at = match.index ?? 0;
    if (at > last) out.push({ text: text.slice(last, at), redacted: false });
    out.push({ text: match[0], redacted: true });
    last = at + match[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), redacted: false });
  return out;
}

const DATA_URL = /data:([a-z]+\/[a-z0-9.+-]+)?(?:;[a-z0-9=.-]+)*;base64,([A-Za-z0-9+/=\s]+)/gi;
const BASE64_ONLY = /^[A-Za-z0-9+/\s]+={0,2}$/;

/** Bytes a base64 string decodes to. */
export function base64Bytes(data: string): number {
  const clean = data.replace(/\s+/g, "");
  const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
}

export function looksLikeBase64(value: string): boolean {
  return value.length >= 200 && !/\s{2,}/.test(value) && BASE64_ONLY.test(value) && !/^[a-z\s]+$/i.test(value);
}

function attachmentTypeOf(mime: string | null, fallback: AttachmentType): AttachmentType {
  if (!mime) return fallback;
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime === "application/pdf" || mime.startsWith("text/")) return "document";
  return "file";
}

/** A `{ "$s": n }`-style marker from the SDK's metadata capture. */
function skeletonMarker(value: unknown): ContentPart | null {
  const obj = asObj(value);
  if (!obj) return null;
  const keys = Object.keys(obj);
  if (keys.length !== 1) return null;
  if (keys[0] === "$s") return { kind: "omitted", chars: num(obj["$s"]) };
  if (keys[0] === "$bytes") return { kind: "attachment", type: "file", mimeType: null, sizeBytes: num(obj["$bytes"]) };
  if (keys[0] === "$trunc") return { kind: "omitted", chars: null };
  return null;
}

/** A string as parts: base64 becomes attachment chips, secret markers become redacted parts. */
function textParts(text: string, fallbackType: AttachmentType = "file"): ContentPart[] {
  if (isRedactedValue(text)) return [{ kind: "redacted", label: "Redacted" }];
  const whole = /^data:([a-z]+\/[a-z0-9.+-]+)?(?:;[a-z0-9=.-]+)*;base64,([A-Za-z0-9+/=\s]+)$/i.exec(text.trim());
  if (whole) {
    const mime = whole[1] ?? null;
    return [{ kind: "attachment", type: attachmentTypeOf(mime, fallbackType), mimeType: mime, sizeBytes: base64Bytes(whole[2]!) }];
  }
  if (looksLikeBase64(text.trim())) return [{ kind: "attachment", type: fallbackType, mimeType: null, sizeBytes: base64Bytes(text) }];
  const attachments: ContentPart[] = [];
  const cleaned = text.replace(DATA_URL, (_match, mime: string | undefined, data: string) => {
    const mimeType = mime ?? null;
    attachments.push({ kind: "attachment", type: attachmentTypeOf(mimeType, fallbackType), mimeType, sizeBytes: base64Bytes(data) });
    return "[attachment]";
  });
  return cleaned.trim() ? [{ kind: "text", text: cleaned }, ...attachments] : attachments;
}

/** Any value as parts: strings as text, objects as JSON, markers as chips. */
function valueParts(value: unknown): ContentPart[] {
  if (value === undefined || value === null) return [];
  if (typeof value === "string") {
    const parsed = jsonFromText(value);
    return parsed !== undefined ? [{ kind: "json", value: scrubValue(parsed) }] : textParts(value);
  }
  const marker = skeletonMarker(value);
  if (marker) return [marker];
  if (typeof value === "object") return [{ kind: "json", value: scrubValue(value) }];
  return [{ kind: "text", text: String(value) }];
}

/** Deep copy with base64 strings replaced by a short description. */
export function scrubValue(value: unknown, depth = 0): unknown {
  if (depth > 40) return value;
  if (typeof value === "string") {
    const whole = /^data:([a-z]+\/[a-z0-9.+-]+)?(?:;[a-z0-9=.-]+)*;base64,([A-Za-z0-9+/=\s]+)$/i.exec(value.trim());
    if (whole) return `[${whole[1] ?? "base64"} · ${formatBytes(base64Bytes(whole[2]!))}]`;
    if (looksLikeBase64(value.trim())) return `[base64 · ${formatBytes(base64Bytes(value))}]`;
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, depth + 1));
  const obj = asObj(value);
  if (!obj) return value;
  const out: Obj = {};
  for (const [key, child] of Object.entries(obj)) out[key] = scrubValue(child, depth + 1);
  return out;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`;
  return `${Math.round(bytes / (1024 * 104.8576)) / 10} MB`;
}

// ── JSON schema ──

/** Properties at every depth of a JSON schema (also Gemini's OpenAPI subset). */
export function countSchemaFields(schema: unknown, depth = 0): number {
  const obj = asObj(schema);
  if (!obj || depth > 40) return 0;
  let count = 0;
  const props = asObj(obj["properties"]);
  if (props) for (const child of Object.values(props)) count += 1 + countSchemaFields(child, depth + 1);
  for (const key of ["items", "additionalProperties", "not"]) {
    const child = obj[key];
    if (Array.isArray(child)) for (const item of child) count += countSchemaFields(item, depth + 1);
    else count += countSchemaFields(child, depth + 1);
  }
  for (const key of ["anyOf", "oneOf", "allOf", "prefixItems"]) {
    for (const item of asArr(obj[key])) count += countSchemaFields(item, depth + 1);
  }
  for (const key of ["$defs", "definitions"]) {
    const defs = asObj(obj[key]);
    if (defs) for (const def of Object.values(defs)) count += countSchemaFields(def, depth + 1);
  }
  return count;
}

export interface SchemaField {
  name: string;
  type: string;
  required: boolean;
  description: string | null;
  children: SchemaField[];
}

function schemaType(schema: Obj): string {
  const type = schema["type"];
  const base = Array.isArray(type) ? type.filter((t) => t !== "null").map(String).join(" | ") : typeof type === "string" ? type.toLowerCase() : "";
  if (base === "array") {
    const items = asObj(schema["items"]);
    const inner = items ? schemaType(items) : "";
    return inner ? `${inner}[]` : "array";
  }
  if (Array.isArray(schema["enum"])) return base ? `${base} enum` : "enum";
  if (!base && schema["$ref"]) return String(schema["$ref"]).split("/").pop() ?? "ref";
  if (!base && (schema["anyOf"] || schema["oneOf"])) {
    return asArr(schema["anyOf"] ?? schema["oneOf"]).map((item) => { const o = asObj(item); return o ? schemaType(o) : ""; }).filter((t) => t && t !== "null").join(" | ") || "any";
  }
  if (!base && schema["properties"]) return "object";
  return base || "any";
}

/** The schema as a tree of named fields for display. */
export function schemaFields(schema: unknown, depth = 0): SchemaField[] {
  const obj = asObj(schema);
  if (!obj || depth > 20) return [];
  const target = obj["type"] === "array" || obj["type"] === "ARRAY" ? asObj(obj["items"]) ?? obj : obj;
  const props = asObj(target["properties"]);
  if (!props) return [];
  const required = new Set(asArr(target["required"]).map(String));
  return Object.entries(props).map(([name, child]) => {
    const childObj = asObj(child) ?? {};
    return {
      name,
      type: schemaType(childObj),
      required: required.has(name),
      description: nonEmpty(childObj["description"]),
      children: schemaFields(childObj, depth + 1),
    };
  });
}

function schemaFormat(kind: ResponseFormat["kind"], name: string | null, schema: unknown): ResponseFormat {
  const format: ResponseFormat = { kind, name };
  if (schema !== undefined && schema !== null) {
    format.schema = schema;
    format.fieldCount = countSchemaFields(schema);
  }
  return format;
}

// ── Usage ──

const USAGE_KEYS: Record<string, string> = {
  prompt_tokens: "input", input_tokens: "input", promptTokenCount: "input", inputTokens: "input",
  completion_tokens: "output", output_tokens: "output", candidatesTokenCount: "output", outputTokens: "output",
  reasoning_tokens: "reasoning", thoughtsTokenCount: "reasoning",
  cached_tokens: "cacheRead", cache_read_input_tokens: "cacheRead", cachedContentTokenCount: "cacheRead", cacheReadInputTokens: "cacheRead", cacheReadInputTokenCount: "cacheRead",
  cache_creation_input_tokens: "cacheWrite", cacheWriteInputTokens: "cacheWrite", cacheWriteInputTokenCount: "cacheWrite",
  total_tokens: "total", totalTokenCount: "total", totalTokens: "total",
};

function usageOf(value: unknown): Record<string, number> | undefined {
  const obj = asObj(value);
  if (!obj) return undefined;
  const out: Record<string, number> = {};
  const visit = (node: Obj, prefix: string, depth: number) => {
    for (const [key, child] of Object.entries(node)) {
      const n = num(child);
      if (n !== null) {
        const canonical = USAGE_KEYS[key] ?? (prefix ? `${prefix}.${key}` : key);
        if (out[canonical] === undefined) out[canonical] = n;
      } else if (depth < 3 && asObj(child)) {
        visit(child as Obj, key, depth + 1);
      }
    }
  };
  visit(obj, "", 0);
  return Object.keys(out).length ? out : undefined;
}

// ── Shared assembly ──

class Builder {
  messages: ContentMessage[] = [];
  systemParts: string[] = [];

  push(role: MessageRole, parts: ContentPart[]): ContentMessage | null {
    if (!parts.length) return null;
    const message: ContentMessage = { role, index: this.messages.length + 1, parts };
    this.messages.push(message);
    return message;
  }

  /** Appends to the last message when it has the same role, else starts one. */
  append(role: MessageRole, parts: ContentPart[]): void {
    const last = this.messages[this.messages.length - 1];
    if (last && last.role === role) last.parts.push(...parts);
    else this.push(role, parts);
  }

  system(): string | null {
    const text = this.systemParts.filter((part) => part.trim()).join("\n\n");
    return text || null;
  }
}

function pairToolCalls(messages: ContentMessage[], output: ContentOutput | null): void {
  const calls: Array<{ part: Extract<ContentPart, { kind: "toolCall" }>; index: number; used: boolean }> = [];
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.kind === "toolCall") calls.push({ part, index: message.index, used: false });
    }
  }
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.kind !== "toolResult") continue;
      let match = part.callId ? calls.find((call) => call.part.id === part.callId) : undefined;
      // Gemini and some others pair by name and order.
      if (!match && part.name) match = calls.find((call) => !call.used && call.part.name === part.name && call.index < message.index);
      if (!match) continue;
      match.used = true;
      part.name = part.name ?? match.part.name;
      part.callId = part.callId ?? match.part.id;
      part.callIndex = match.index;
      match.part.resultIndex = message.index;
    }
  }
  for (const part of output?.parts ?? []) {
    if (part.kind === "toolCall") part.resultIndex = null;
  }
}

/** Output text that is JSON (or should be) becomes a JSON part. */
function structureOutput(output: ContentOutput | null, format: ResponseFormat | null | undefined): void {
  if (!output) return;
  const wantsJson = format?.kind === "json" || format?.kind === "json_schema";
  output.parts = output.parts.map((part) => {
    if (part.kind !== "text" || part.refusal) return part;
    const parsed = jsonFromText(part.text);
    if (parsed !== undefined && (wantsJson || /^\s*[{[]/.test(part.text) || /^\s*```/.test(part.text))) return { kind: "json", value: parsed };
    return part;
  });
}

function countRedactions(content: Omit<CallContent, "redactedCount">): number {
  let count = 0;
  const visitText = (text: string) => { count += (text.match(REDACTION_INLINE) ?? []).length; };
  const visitValue = (value: unknown, depth: number): void => {
    if (depth > 40) return;
    if (typeof value === "string") {
      if (isRedactedValue(value)) count += 1;
      else visitText(value);
    } else if (Array.isArray(value)) value.forEach((item) => visitValue(item, depth + 1));
    else if (asObj(value)) Object.values(value as Obj).forEach((item) => visitValue(item, depth + 1));
  };
  const visitParts = (parts: ContentPart[]): void => {
    for (const part of parts) {
      if (part.kind === "text" || part.kind === "thinking") visitText(part.text);
      else if (part.kind === "redacted" && part.label === "Redacted") count += 1;
      else if (part.kind === "json") visitValue(part.value, 0);
      else if (part.kind === "toolCall") visitValue(part.args, 0);
      else if (part.kind === "toolResult") visitParts(part.content);
    }
  };
  if (content.system) visitText(content.system);
  content.messages.forEach((message) => visitParts(message.parts));
  if (content.output) visitParts(content.output.parts);
  return count;
}

function finish(format: ContentFormat, builder: Builder, config: ContentConfig, output: ContentOutput | null): CallContent {
  pairToolCalls(builder.messages, output);
  structureOutput(output, config.responseFormat);
  const content = { format, system: builder.system(), messages: builder.messages, config: cleanConfig(config), output };
  return { ...content, redactedCount: countRedactions(content) };
}

function cleanConfig(config: ContentConfig): ContentConfig {
  const out: ContentConfig = {};
  for (const [key, value] of Object.entries(config) as Array<[keyof ContentConfig, unknown]>) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value) && value.length === 0) continue;
    (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

function toolCallPart(id: unknown, name: unknown, args: unknown): ContentPart {
  return { kind: "toolCall", id: nonEmpty(id), name: nonEmpty(name) ?? "tool", args: scrubValue(maybeJson(args)) };
}

function toolList(items: unknown[], read: (item: Obj) => { name: unknown; description?: unknown } | null): Array<{ name: string; description?: string | null }> {
  const out: Array<{ name: string; description?: string | null }> = [];
  for (const item of items) {
    const obj = asObj(item);
    if (!obj) continue;
    const tool = read(obj);
    const name = tool ? nonEmpty(tool.name) : null;
    if (name) out.push({ name, description: nonEmpty(tool?.description) });
  }
  return out;
}

// ── OpenAI chat completions ──

function openAiChatPart(item: unknown): ContentPart[] {
  if (typeof item === "string") return textParts(item);
  const part = asObj(item);
  if (!part) return [];
  const type = str(part["type"]);
  if (type === "text" || type === "input_text" || type === "output_text") return textParts(str(part["text"]) ?? "");
  if (type === "refusal") return [{ kind: "text", text: str(part["refusal"]) ?? "", refusal: true }];
  if (type === "image_url" || type === "input_image") {
    const image = part["image_url"];
    const url = str(asObj(image)?.["url"]) ?? str(image) ?? "";
    if (url.startsWith("data:")) return textParts(url, "image");
    return [{ kind: "attachment", type: "image", mimeType: null, sizeBytes: null, name: url ? shortUrl(url) : nonEmpty(part["file_id"]), detail: nonEmpty(asObj(image)?.["detail"] ?? part["detail"]) }];
  }
  if (type === "input_audio") {
    const audio = asObj(part["input_audio"]) ?? part;
    const data = str(audio["data"]);
    const fmt = nonEmpty(audio["format"]);
    return [{ kind: "attachment", type: "audio", mimeType: fmt ? `audio/${fmt}` : null, sizeBytes: data ? base64Bytes(data) : null }];
  }
  if (type === "file" || type === "input_file") {
    const file = asObj(part["file"]) ?? part;
    const data = str(file["file_data"]);
    const dataMime = data ? /^data:([^;,]+)/.exec(data)?.[1] ?? null : null;
    const name = nonEmpty(file["filename"]) ?? nonEmpty(file["file_id"]) ?? (str(file["file_url"]) ? shortUrl(str(file["file_url"])!) : null);
    const payload = data?.includes(",") ? data.slice(data.indexOf(",") + 1) : data;
    return [{ kind: "attachment", type: dataMime === "application/pdf" || name?.toLowerCase().endsWith(".pdf") ? "document" : "file", mimeType: dataMime, sizeBytes: payload ? base64Bytes(payload) : null, name }];
  }
  return valueParts(part);
}

function shortUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split("/").filter(Boolean).pop();
    return last ? `${parsed.hostname}/…/${last}` : parsed.hostname;
  } catch {
    return url.length > 60 ? `${url.slice(0, 57)}...` : url;
  }
}

function contentParts(content: unknown, partReader: (item: unknown) => ContentPart[]): ContentPart[] {
  if (content === undefined || content === null) return [];
  if (typeof content === "string") return textParts(content);
  const marker = skeletonMarker(content);
  if (marker) return [marker];
  if (Array.isArray(content)) return content.flatMap(partReader);
  return partReader(content);
}

function openAiResponseFormat(format: unknown): ResponseFormat | null {
  const obj = asObj(format);
  if (!obj) return null;
  const type = str(obj["type"]);
  if (type === "json_schema") {
    const spec = asObj(obj["json_schema"]) ?? obj;
    return schemaFormat("json_schema", nonEmpty(spec["name"]), spec["schema"]);
  }
  if (type === "json_object") return { kind: "json" };
  if (type === "text") return { kind: "text" };
  return null;
}

function parseOpenAiChat(input: Obj | null, output: Obj | null, hints: ParseHints): CallContent {
  const builder = new Builder();
  for (const raw of asArr(input?.["messages"])) {
    const message = asObj(raw);
    if (!message) continue;
    const role = str(message["role"]) ?? "user";
    const content = contentParts(message["content"], openAiChatPart);
    if (role === "system") {
      builder.systemParts.push(content.map(partText).join("\n"));
      continue;
    }
    if (role === "tool" || role === "function") {
      builder.push("tool", [{ kind: "toolResult", callId: nonEmpty(message["tool_call_id"]), name: nonEmpty(message["name"]), content: toolResultContent(message["content"], openAiChatPart) }]);
      continue;
    }
    const parts = [...content];
    if (role === "assistant") parts.push(...openAiAssistantExtras(message));
    builder.push(role === "developer" ? "developer" : role === "assistant" ? "assistant" : "user", parts);
  }
  const tools = toolList(asArr(input?.["tools"]), (tool) => {
    const fn = asObj(tool["function"]);
    return fn ? { name: fn["name"], description: fn["description"] } : { name: tool["name"] ?? tool["type"], description: tool["description"] };
  });
  tools.push(...toolList(asArr(input?.["functions"]), (fn) => ({ name: fn["name"], description: fn["description"] })));
  const config: ContentConfig = {
    model: nonEmpty(input?.["model"]) ?? nonEmpty(output?.["model"]) ?? hints.model ?? null,
    temperature: num(input?.["temperature"]),
    topP: num(input?.["top_p"]),
    maxTokens: num(input?.["max_completion_tokens"]) ?? num(input?.["max_tokens"]),
    reasoningEffort: nonEmpty(input?.["reasoning_effort"]) ?? nonEmpty(asObj(input?.["reasoning"])?.["effort"]),
    tools,
    responseFormat: openAiResponseFormat(input?.["response_format"]),
  };
  let result: ContentOutput | null = null;
  if (output) {
    const choice = asObj(asArr(output["choices"])[0]);
    const message = asObj(choice?.["message"]) ?? asObj(choice?.["delta"]);
    const parts = message ? [...contentParts(message["content"], openAiChatPart), ...openAiAssistantExtras(message)] : [];
    if (!message && str(choice?.["text"])) parts.push(...textParts(str(choice?.["text"])!));
    if (message && str(message["reasoning_content"])) parts.unshift({ kind: "thinking", text: str(message["reasoning_content"])! });
    result = { parts, finishReason: nonEmpty(choice?.["finish_reason"]), usage: usageOf(output["usage"]) };
  }
  return finish("openai-chat", builder, config, result);
}

function openAiAssistantExtras(message: Obj): ContentPart[] {
  const parts: ContentPart[] = [];
  const refusal = nonEmpty(message["refusal"]);
  if (refusal) parts.push({ kind: "text", text: refusal, refusal: true });
  for (const raw of asArr(message["tool_calls"])) {
    const call = asObj(raw);
    const fn = asObj(call?.["function"]);
    if (call) parts.push(toolCallPart(call["id"], fn?.["name"] ?? call["type"], fn?.["arguments"] ?? call["custom"]));
  }
  const legacy = asObj(message["function_call"]);
  if (legacy) parts.push(toolCallPart(null, legacy["name"], legacy["arguments"]));
  const audio = asObj(message["audio"]);
  if (audio) {
    const data = str(audio["data"]);
    parts.push({ kind: "attachment", type: "audio", mimeType: null, sizeBytes: data ? base64Bytes(data) : null });
    if (nonEmpty(audio["transcript"])) parts.push({ kind: "text", text: str(audio["transcript"])! });
  }
  return parts;
}

function toolResultContent(content: unknown, reader: (item: unknown) => ContentPart[]): ContentPart[] {
  if (typeof content === "string") return valueParts(content);
  return contentParts(content, reader);
}

function partText(part: ContentPart): string {
  if (part.kind === "text" || part.kind === "thinking") return part.text;
  if (part.kind === "redacted") return "[REDACTED]";
  if (part.kind === "json") return JSON.stringify(part.value, null, 2);
  return "";
}

// ── OpenAI Responses ──

function parseOpenAiResponses(input: Obj | null, output: Obj | null, hints: ParseHints): CallContent {
  const builder = new Builder();
  const instructions = input?.["instructions"];
  if (typeof instructions === "string") builder.systemParts.push(instructions);
  else if (Array.isArray(instructions)) readResponsesItems(instructions, builder);
  const rawInput = input?.["input"];
  if (typeof rawInput === "string") builder.push("user", textParts(rawInput));
  else readResponsesItems(asArr(rawInput), builder);
  const text = asObj(input?.["text"]);
  const tools = toolList(asArr(input?.["tools"]), (tool) => ({ name: tool["name"] ?? tool["server_label"] ?? tool["type"], description: tool["description"] }));
  const config: ContentConfig = {
    model: nonEmpty(input?.["model"]) ?? nonEmpty(output?.["model"]) ?? hints.model ?? null,
    temperature: num(input?.["temperature"]),
    topP: num(input?.["top_p"]),
    maxTokens: num(input?.["max_output_tokens"]),
    reasoningEffort: nonEmpty(asObj(input?.["reasoning"])?.["effort"]),
    tools,
    responseFormat: openAiResponseFormat(text?.["format"]),
  };
  let result: ContentOutput | null = null;
  if (output) {
    const parts: ContentPart[] = [];
    for (const raw of asArr(output["output"])) parts.push(...responsesItemParts(asObj(raw)).parts);
    if (!parts.length && nonEmpty(output["output_text"])) parts.push(...textParts(str(output["output_text"])!));
    const status = nonEmpty(output["status"]);
    const incomplete = nonEmpty(asObj(output["incomplete_details"])?.["reason"]);
    const error = nonEmpty(asObj(output["error"])?.["message"]);
    if (error) parts.push({ kind: "text", text: error, refusal: true });
    result = { parts, finishReason: incomplete ?? status, usage: usageOf(output["usage"]) };
  }
  return finish("openai-responses", builder, config, result);
}

function responsesItemParts(item: Obj | null): { role: MessageRole | "system" | null; parts: ContentPart[] } {
  if (!item) return { role: null, parts: [] };
  const type = str(item["type"]);
  const role = str(item["role"]);
  if (role || type === "message") {
    const parts = contentParts(item["content"], openAiChatPart);
    const mapped: MessageRole = role === "assistant" ? "assistant" : role === "developer" ? "developer" : role === "system" ? "system" : "user";
    return { role: mapped, parts };
  }
  if (type === "function_call" || type === "custom_tool_call") {
    return { role: "assistant", parts: [toolCallPart(item["call_id"] ?? item["id"], item["name"], item["arguments"] ?? item["input"])] };
  }
  if (type === "function_call_output" || type === "custom_tool_call_output") {
    return { role: "tool", parts: [{ kind: "toolResult", callId: nonEmpty(item["call_id"]), name: null, content: toolResultContent(item["output"], openAiChatPart) }] };
  }
  if (type === "reasoning") {
    const summary = asArr(item["summary"]).map((s) => str(asObj(s)?.["text"]) ?? "").filter(Boolean).join("\n\n");
    const content = asArr(item["content"]).map((s) => str(asObj(s)?.["text"]) ?? "").filter(Boolean).join("\n\n");
    const text = summary || content;
    return { role: "assistant", parts: text ? [{ kind: "thinking", text }] : [] };
  }
  if (type && type.endsWith("_call")) {
    const { id, type: _type, status: _status, ...rest } = item;
    void _type; void _status;
    return { role: "assistant", parts: [toolCallPart(item["call_id"] ?? id, type.replace(/_call$/, ""), Object.keys(rest).length ? rest : null)] };
  }
  if (type && type.endsWith("_call_output")) {
    return { role: "tool", parts: [{ kind: "toolResult", callId: nonEmpty(item["call_id"]), name: null, content: valueParts(item["output"]) }] };
  }
  if (type === "item_reference") return { role: null, parts: [] };
  return { role: "user", parts: valueParts(item) };
}

function readResponsesItems(items: unknown[], builder: Builder): void {
  for (const raw of items) {
    const { role, parts } = responsesItemParts(asObj(raw));
    if (!role) continue;
    if (role === "system") builder.systemParts.push(parts.map(partText).join("\n"));
    else if (role === "assistant") builder.append("assistant", parts);
    else builder.push(role, parts);
  }
}

// ── Anthropic ──

function anthropicBlock(item: unknown): ContentPart[] {
  if (typeof item === "string") return textParts(item);
  const block = asObj(item);
  if (!block) return [];
  const type = str(block["type"]);
  if (type === "text") return textParts(str(block["text"]) ?? "");
  if (type === "thinking") return [{ kind: "thinking", text: str(block["thinking"]) ?? "" }];
  if (type === "redacted_thinking") return [{ kind: "redacted", label: "Reasoning hidden by the provider" }];
  if (type === "image" || type === "document") {
    const source = asObj(block["source"]) ?? {};
    const mime = nonEmpty(source["media_type"]);
    const data = str(source["data"]);
    const sourceType = str(source["type"]);
    const name = nonEmpty(block["title"]) ?? (str(source["url"]) ? shortUrl(str(source["url"])!) : nonEmpty(source["file_id"]));
    if (sourceType === "text" && data) {
      return [{ kind: "attachment", type: "document", mimeType: mime ?? "text/plain", sizeBytes: data.length, name }];
    }
    return [{ kind: "attachment", type: type === "image" ? "image" : "document", mimeType: mime, sizeBytes: data && sourceType === "base64" ? base64Bytes(data) : null, name }];
  }
  if (type === "tool_use" || type === "server_tool_use" || type === "mcp_tool_use") return [toolCallPart(block["id"], block["name"], block["input"])];
  if (type === "tool_result" || type === "mcp_tool_result" || (type && type.endsWith("_tool_result"))) {
    return [{ kind: "toolResult", callId: nonEmpty(block["tool_use_id"]), name: null, content: toolResultContent(block["content"], anthropicBlock), isError: block["is_error"] === true }];
  }
  return valueParts(block);
}

function anthropicSystem(system: unknown): string | null {
  if (typeof system === "string") return system;
  const texts = asArr(system).map((block) => str(asObj(block)?.["text"]) ?? str(block) ?? "").filter(Boolean);
  return texts.length ? texts.join("\n\n") : null;
}

function parseAnthropic(input: Obj | null, output: Obj | null, hints: ParseHints): CallContent {
  const builder = new Builder();
  const system = anthropicSystem(input?.["system"]);
  if (system) builder.systemParts.push(system);
  for (const raw of asArr(input?.["messages"])) {
    const message = asObj(raw);
    if (!message) continue;
    const parts = contentParts(message["content"], anthropicBlock);
    const role = str(message["role"]);
    if (role === "assistant") builder.push("assistant", parts);
    else if (parts.length && parts.every((part) => part.kind === "toolResult")) builder.push("tool", parts);
    else builder.push("user", parts);
  }
  const thinking = asObj(input?.["thinking"]);
  const outputConfig = asObj(input?.["output_config"]);
  const outputFormat = asObj(input?.["output_format"]) ?? asObj(outputConfig?.["format"]);
  const config: ContentConfig = {
    model: nonEmpty(input?.["model"]) ?? nonEmpty(output?.["model"]) ?? hints.model ?? null,
    temperature: num(input?.["temperature"]),
    topP: num(input?.["top_p"]),
    maxTokens: num(input?.["max_tokens"]),
    reasoningEffort: nonEmpty(outputConfig?.["effort"]) ?? (thinking?.["type"] === "adaptive" ? "adaptive" : null),
    thinkingBudget: thinking?.["type"] === "enabled" ? num(thinking["budget_tokens"]) : null,
    tools: toolList(asArr(input?.["tools"]), (tool) => ({ name: tool["name"] ?? tool["type"], description: tool["description"] })),
    responseFormat: outputFormat
      ? (outputFormat["type"] === "json_schema" ? schemaFormat("json_schema", nonEmpty(outputFormat["name"]), outputFormat["schema"]) : openAiResponseFormat(outputFormat))
      : null,
  };
  let result: ContentOutput | null = null;
  if (output) {
    result = {
      parts: contentParts(output["content"], anthropicBlock),
      finishReason: nonEmpty(output["stop_reason"]),
      usage: usageOf(output["usage"]),
    };
  }
  return finish("anthropic", builder, config, result);
}

// ── Gemini ──

function geminiPart(item: unknown): ContentPart[] {
  if (typeof item === "string") return textParts(item);
  const part = asObj(item);
  if (!part) return [];
  if (typeof part["text"] === "string") {
    return part["thought"] === true ? [{ kind: "thinking", text: part["text"] as string }] : textParts(part["text"] as string);
  }
  const inline = asObj(part["inlineData"] ?? part["inline_data"]);
  if (inline) {
    const mime = nonEmpty(inline["mimeType"] ?? inline["mime_type"]);
    const data = str(inline["data"]);
    return [{ kind: "attachment", type: attachmentTypeOf(mime, "file"), mimeType: mime, sizeBytes: data ? base64Bytes(data) : null }];
  }
  const file = asObj(part["fileData"] ?? part["file_data"]);
  if (file) {
    const mime = nonEmpty(file["mimeType"] ?? file["mime_type"]);
    const uri = str(file["fileUri"] ?? file["file_uri"]);
    return [{ kind: "attachment", type: attachmentTypeOf(mime, "file"), mimeType: mime, sizeBytes: null, name: uri ? shortUrl(uri) : null }];
  }
  const call = asObj(part["functionCall"] ?? part["function_call"]);
  if (call) return [toolCallPart(call["id"], call["name"], call["args"])];
  const response = asObj(part["functionResponse"] ?? part["function_response"]);
  if (response) {
    return [{ kind: "toolResult", callId: nonEmpty(response["id"]), name: nonEmpty(response["name"]), content: valueParts(response["response"]) }];
  }
  const code = asObj(part["executableCode"] ?? part["executable_code"]);
  if (code) return [toolCallPart(null, "code_execution", code["code"])];
  const codeResult = asObj(part["codeExecutionResult"] ?? part["code_execution_result"]);
  if (codeResult) return [{ kind: "toolResult", callId: null, name: "code_execution", content: valueParts(codeResult["output"]) }];
  return valueParts(part);
}

function geminiContentParts(content: unknown): ContentPart[] {
  const obj = asObj(content);
  if (obj) return contentParts(obj["parts"], geminiPart);
  return contentParts(content, geminiPart);
}

function parseGemini(input: Obj | null, output: Obj | null, hints: ParseHints): CallContent {
  const builder = new Builder();
  const genConfig = asObj(input?.["generationConfig"] ?? input?.["generation_config"] ?? input?.["config"]);
  const systemInstruction = input?.["systemInstruction"] ?? input?.["system_instruction"] ?? genConfig?.["systemInstruction"] ?? genConfig?.["system_instruction"];
  if (typeof systemInstruction === "string") builder.systemParts.push(systemInstruction);
  else if (systemInstruction) builder.systemParts.push(geminiContentParts(systemInstruction).map(partText).join("\n"));
  const contents = input?.["contents"];
  const list = typeof contents === "string" ? [{ role: "user", parts: [{ text: contents }] }] : Array.isArray(contents) ? contents : contents ? [contents] : [];
  for (const raw of list) {
    if (typeof raw === "string") {
      builder.push("user", textParts(raw));
      continue;
    }
    const content = asObj(raw);
    if (!content) continue;
    const parts = geminiContentParts(content);
    const role = str(content["role"]);
    if (role === "model") builder.push("assistant", parts);
    else if (role === "function" || role === "tool" || (parts.length && parts.every((part) => part.kind === "toolResult"))) builder.push("tool", parts);
    else builder.push("user", parts);
  }
  const thinkingConfig = asObj(genConfig?.["thinkingConfig"] ?? genConfig?.["thinking_config"]);
  const schema = genConfig?.["responseJsonSchema"] ?? genConfig?.["response_json_schema"] ?? genConfig?.["responseSchema"] ?? genConfig?.["response_schema"];
  const mime = nonEmpty(genConfig?.["responseMimeType"] ?? genConfig?.["response_mime_type"]);
  const tools: Array<{ name: string; description?: string | null }> = [];
  for (const raw of asArr(input?.["tools"] ?? genConfig?.["tools"])) {
    const tool = asObj(raw);
    if (!tool) continue;
    const declarations = asArr(tool["functionDeclarations"] ?? tool["function_declarations"]);
    if (declarations.length) tools.push(...toolList(declarations, (fn) => ({ name: fn["name"], description: fn["description"] })));
    else for (const key of Object.keys(tool)) tools.push({ name: key });
  }
  const config: ContentConfig = {
    model: nonEmpty(input?.["model"]) ?? hints.model ?? nonEmpty(output?.["modelVersion"]) ?? null,
    temperature: num(genConfig?.["temperature"]),
    topP: num(genConfig?.["topP"] ?? genConfig?.["top_p"]),
    maxTokens: num(genConfig?.["maxOutputTokens"] ?? genConfig?.["max_output_tokens"]),
    reasoningEffort: nonEmpty(thinkingConfig?.["thinkingLevel"] ?? thinkingConfig?.["thinking_level"]),
    thinkingBudget: num(thinkingConfig?.["thinkingBudget"] ?? thinkingConfig?.["thinking_budget"]),
    tools,
    responseFormat: schema ? schemaFormat("json_schema", null, schema) : mime === "application/json" ? { kind: "json" } : null,
  };
  let result: ContentOutput | null = null;
  if (output) {
    const candidate = asObj(asArr(output["candidates"])[0]);
    const blocked = nonEmpty(asObj(output["promptFeedback"])?.["blockReason"]);
    result = {
      parts: geminiContentParts(candidate?.["content"]),
      finishReason: nonEmpty(candidate?.["finishReason"] ?? candidate?.["finish_reason"]) ?? blocked,
      usage: usageOf(output["usageMetadata"] ?? output["usage_metadata"]),
    };
  }
  return finish("gemini", builder, config, result);
}

// ── Bedrock Converse ──

function bedrockBlock(item: unknown): ContentPart[] {
  const block = asObj(item);
  if (!block) return typeof item === "string" ? textParts(item) : [];
  if (typeof block["text"] === "string") return textParts(block["text"] as string);
  if (block["json"] !== undefined) return [{ kind: "json", value: scrubValue(block["json"]) }];
  for (const type of ["image", "document", "video", "audio"] as const) {
    const media = asObj(block[type]);
    if (!media) continue;
    const format = nonEmpty(media["format"]);
    const source = asObj(media["source"]);
    const bytes = source?.["bytes"];
    const size = typeof bytes === "string" ? base64Bytes(bytes) : num(asObj(bytes)?.["$bytes"]);
    const mime = format ? `${type === "document" ? "application" : type}/${format}` : null;
    return [{ kind: "attachment", type: type === "video" ? "file" : type, mimeType: mime, sizeBytes: size, name: nonEmpty(media["name"]) }];
  }
  const toolUse = asObj(block["toolUse"]);
  if (toolUse) return [toolCallPart(toolUse["toolUseId"], toolUse["name"], toolUse["input"])];
  const toolResult = asObj(block["toolResult"]);
  if (toolResult) {
    return [{ kind: "toolResult", callId: nonEmpty(toolResult["toolUseId"]), name: null, content: contentParts(toolResult["content"], bedrockBlock), isError: toolResult["status"] === "error" }];
  }
  const reasoning = asObj(block["reasoningContent"]);
  if (reasoning) {
    const text = str(asObj(reasoning["reasoningText"])?.["text"]);
    return text ? [{ kind: "thinking", text }] : [{ kind: "redacted", label: "Reasoning hidden by the provider" }];
  }
  if (block["cachePoint"]) return [];
  return valueParts(block);
}

function parseBedrock(input: Obj | null, output: Obj | null, hints: ParseHints): CallContent {
  const builder = new Builder();
  const system = asArr(input?.["system"]).map((block) => str(asObj(block)?.["text"]) ?? "").filter(Boolean);
  if (system.length) builder.systemParts.push(system.join("\n\n"));
  for (const raw of asArr(input?.["messages"])) {
    const message = asObj(raw);
    if (!message) continue;
    const parts = contentParts(message["content"], bedrockBlock);
    if (message["role"] === "assistant") builder.push("assistant", parts);
    else if (parts.length && parts.every((part) => part.kind === "toolResult")) builder.push("tool", parts);
    else builder.push("user", parts);
  }
  const inference = asObj(input?.["inferenceConfig"]);
  const extra = asObj(input?.["additionalModelRequestFields"]);
  const thinking = asObj(extra?.["thinking"]) ?? asObj(extra?.["reasoning_config"]);
  const toolConfig = asObj(input?.["toolConfig"]);
  const config: ContentConfig = {
    model: nonEmpty(input?.["modelId"]) ?? hints.model ?? null,
    temperature: num(inference?.["temperature"]),
    topP: num(inference?.["topP"]),
    maxTokens: num(inference?.["maxTokens"]),
    thinkingBudget: num(thinking?.["budget_tokens"]),
    reasoningEffort: nonEmpty(asObj(extra?.["reasoningConfig"])?.["maxReasoningEffort"]),
    tools: toolList(asArr(toolConfig?.["tools"]), (tool) => {
      const spec = asObj(tool["toolSpec"]);
      return spec ? { name: spec["name"], description: spec["description"] } : null;
    }),
  };
  let result: ContentOutput | null = null;
  if (output) {
    result = {
      parts: contentParts(asObj(asObj(output["output"])?.["message"])?.["content"], bedrockBlock),
      finishReason: nonEmpty(output["stopReason"]),
      usage: usageOf(output["usage"]),
    };
  }
  return finish("bedrock", builder, config, result);
}

// ── ElevenLabs ──

const ELEVEN_FORMATS: Record<string, string> = { mp3: "audio/mpeg", pcm: "audio/pcm", ulaw: "audio/basic", alaw: "audio/alaw", opus: "audio/opus", wav: "audio/wav" };

function parseElevenLabs(input: Obj | null, output: unknown, hints: ParseHints): CallContent {
  const builder = new Builder();
  const text = str(input?.["text"]);
  if (text !== null) builder.push("user", textParts(text));
  for (const raw of asArr(input?.["$multipart"])) {
    const part = asObj(raw);
    if (!part) continue;
    const mime = nonEmpty(part["contentType"]);
    if (mime || part["bytes"] !== undefined) builder.append("user", [{ kind: "attachment", type: attachmentTypeOf(mime, "audio"), mimeType: mime, sizeBytes: num(part["bytes"]) }]);
  }
  const voice = asObj(input?.["voice_settings"]);
  const extras: Array<{ label: string; value: string }> = [];
  const outputFormat = nonEmpty(input?.["output_format"]);
  if (outputFormat) extras.push({ label: "Format", value: outputFormat });
  if (num(voice?.["stability"]) !== null) extras.push({ label: "Stability", value: String(voice!["stability"]) });
  if (num(voice?.["similarity_boost"]) !== null) extras.push({ label: "Similarity", value: String(voice!["similarity_boost"]) });
  if (num(voice?.["style"]) !== null) extras.push({ label: "Style", value: String(voice!["style"]) });
  if (num(voice?.["speed"]) !== null) extras.push({ label: "Speed", value: String(voice!["speed"]) });
  const language = nonEmpty(input?.["language_code"]);
  if (language) extras.push({ label: "Language", value: language });
  const config: ContentConfig = { model: nonEmpty(input?.["model_id"]) ?? hints.model ?? null, extras };
  const mime = outputFormat ? ELEVEN_FORMATS[outputFormat.split("_")[0]!] ?? null : "audio/mpeg";
  const out = asObj(output);
  const parts: ContentPart[] = [];
  if (out && typeof out["text"] === "string" && !out["audio_base64"]) {
    parts.push(...textParts(out["text"] as string));
  } else if (out && typeof out["audio_base64"] === "string") {
    parts.push({ kind: "attachment", type: "audio", mimeType: mime, sizeBytes: base64Bytes(out["audio_base64"] as string), detail: outputFormat });
  } else if (typeof output === "string" && output.length) {
    parts.push({ kind: "attachment", type: "audio", mimeType: mime, sizeBytes: looksLikeBase64(output) ? base64Bytes(output) : output.length, detail: outputFormat });
  } else {
    parts.push({ kind: "attachment", type: "audio", mimeType: mime, sizeBytes: num(out?.["$bytes"]), detail: outputFormat });
  }
  return finish("elevenlabs", builder, config, { parts });
}

// ── Embeddings ──

function vectorLength(vector: unknown): number | null {
  if (typeof vector === "string") return null;
  const values = Array.isArray(vector) ? vector : asArr(asObj(vector)?.["values"]);
  if (!values.length) return null;
  let length = 0;
  for (const value of values) {
    const more = num(asObj(value)?.["$more"]);
    length += more ?? 1;
  }
  return length;
}

function parseEmbeddings(input: Obj | null, output: Obj | null, hints: ParseHints): CallContent {
  const builder = new Builder();
  const rawInput = input?.["input"] ?? input?.["texts"] ?? input?.["inputs"];
  const texts: ContentPart[] = [];
  const items = typeof rawInput === "string" ? [rawInput] : asArr(rawInput);
  const geminiParts = asArr(asObj(input?.["content"])?.["parts"]);
  for (const item of [...items, ...geminiParts].slice(0, 50)) {
    if (typeof item === "string") texts.push(...textParts(item));
    else if (asObj(item) && typeof asObj(item)!["text"] === "string") texts.push(...textParts(asObj(item)!["text"] as string));
    else if (typeof item === "number") { texts.push({ kind: "text", text: `${items.length} tokens` }); break; }
    else texts.push(...valueParts(item));
  }
  const total = items.length + geminiParts.length;
  if (total > 50) texts.push({ kind: "text", text: `and ${total - 50} more inputs` });
  builder.push("user", texts);
  const extras: Array<{ label: string; value: string }> = [];
  const dims = num(input?.["dimensions"] ?? input?.["output_dimensionality"] ?? input?.["outputDimensionality"]);
  if (dims !== null) extras.push({ label: "Dimensions", value: String(dims) });
  const encoding = nonEmpty(input?.["encoding_format"]);
  if (encoding) extras.push({ label: "Encoding", value: encoding });
  const config: ContentConfig = { model: nonEmpty(input?.["model"]) ?? nonEmpty(output?.["model"]) ?? hints.model ?? null, extras };
  let result: ContentOutput | null = null;
  if (output) {
    let vectors: unknown[] = [];
    if (Array.isArray(output["data"])) vectors = output["data"].map((row) => asObj(row)?.["embedding"]);
    else if (Array.isArray(output["embeddings"])) vectors = output["embeddings"];
    else if (asObj(output["embeddings"]) && Array.isArray(asObj(output["embeddings"])!["float"])) vectors = asObj(output["embeddings"])!["float"] as unknown[];
    else if (output["embedding"]) vectors = [output["embedding"]];
    const moreRows = vectors.reduce<number>((sum, row) => sum + (num(asObj(row)?.["$more"]) ?? 0), 0);
    const real = vectors.filter((row) => !(asObj(row) && num(asObj(row)!["$more"]) !== null));
    result = {
      parts: [{ kind: "vectors", count: real.length + moreRows, dimensions: real.length ? vectorLength(real[0]) : null }],
      usage: usageOf(output["usage"] ?? output["meta"]),
    };
  }
  return finish("embeddings", builder, config, result);
}

// ── Detection ──

function hasBedrockBlocks(messages: unknown[]): boolean {
  return messages.some((raw) => asArr(asObj(raw)?.["content"]).some((block) => {
    const obj = asObj(block);
    return !!obj && obj["type"] === undefined && ("text" in obj || "toolUse" in obj || "toolResult" in obj || "image" in obj || "document" in obj);
  }));
}

function hasAnthropicBlocks(messages: unknown[]): boolean {
  return messages.some((raw) => asArr(asObj(raw)?.["content"]).some((block) => {
    const type = str(asObj(block)?.["type"]);
    return type === "tool_use" || type === "tool_result" || type === "thinking" || type === "redacted_thinking" || type === "document"
      || (type === "image" && !!asObj(asObj(block)?.["source"]));
  }));
}

function hasOpenAiChatSignals(messages: unknown[]): boolean {
  return messages.some((raw) => {
    const message = asObj(raw);
    if (!message) return false;
    if (message["role"] === "system" || message["role"] === "developer" || message["role"] === "tool") return true;
    if (message["tool_calls"] || message["tool_call_id"]) return true;
    return asArr(message["content"]).some((part) => {
      const type = str(asObj(part)?.["type"]);
      return type === "image_url" || type === "input_audio" || type === "file";
    });
  });
}

const EMBED_MODEL = /embed/i;

export function detectFormat(input: unknown, output: unknown, hints: ParseHints = {}): ContentFormat {
  const req = asObj(input);
  const res = asObj(output);
  const provider = (hints.provider ?? "").toLowerCase();
  const model = String(req?.["model"] ?? req?.["model_id"] ?? hints.model ?? "");
  const messages = asArr(req?.["messages"]);

  // Response shapes are the most specific.
  if (res) {
    if (Array.isArray(res["data"]) && res["data"].some((row) => asObj(row)?.["embedding"] !== undefined)) return "embeddings";
    if ((res["embedding"] && !res["choices"]) || (res["embeddings"] && !res["candidates"])) return "embeddings";
    if (Array.isArray(res["candidates"]) || res["usageMetadata"] || res["usage_metadata"]) return "gemini";
    if (asObj(res["output"]) && asObj(asObj(res["output"])!["message"])) return "bedrock";
    if (res["object"] === "response" || (Array.isArray(res["output"]) && (res["status"] !== undefined || res["output"].some((item) => asObj(item)?.["type"])))) return "openai-responses";
    if (Array.isArray(res["choices"])) return "openai-chat";
    if (res["type"] === "message" && Array.isArray(res["content"])) return "anthropic";
    if (res["stop_reason"] !== undefined && Array.isArray(res["content"])) return "anthropic";
    if (res["stopReason"] !== undefined) return "bedrock";
  }

  if (req) {
    if (req["contents"] !== undefined || req["systemInstruction"] || req["system_instruction"] || req["generationConfig"]) return "gemini";
    if (req["inferenceConfig"] || req["toolConfig"] || (messages.length && hasBedrockBlocks(messages)) || (Array.isArray(req["system"]) && req["system"].some((b) => asObj(b) && asObj(b)!["type"] === undefined && typeof asObj(b)!["text"] === "string"))) return "bedrock";
    if (messages.length || req["system"] !== undefined) {
      if (req["anthropic_version"] || req["system"] !== undefined || hasAnthropicBlocks(messages) || req["stop_sequences"] || asObj(req["thinking"])) return "anthropic";
      if (hasOpenAiChatSignals(messages) || req["response_format"] || req["max_completion_tokens"] || req["tool_choice"] === "auto") return "openai-chat";
      if (provider.includes("anthropic") || provider.includes("claude")) return "anthropic";
      if (provider.includes("bedrock")) return "bedrock";
      return "openai-chat";
    }
    if (typeof req["text"] === "string" && (req["model_id"] !== undefined || req["voice_settings"] !== undefined || provider.includes("eleven"))) return "elevenlabs";
    if (Array.isArray(req["$multipart"]) && provider.includes("eleven")) return "elevenlabs";
    const embedInput = req["input"] ?? req["texts"];
    if (embedInput !== undefined) {
      if (EMBED_MODEL.test(model) || provider.includes("voyage") || provider.includes("cohere") || req["encoding_format"] || req["dimensions"]) return "embeddings";
      if (req["instructions"] !== undefined || Array.isArray(req["input"]) && req["input"].some((item) => asObj(item))) return "openai-responses";
      if (Array.isArray(embedInput) && embedInput.every((item) => typeof item === "string")) return "embeddings";
      return "openai-responses";
    }
    if (asObj(req["content"]) && asArr(asObj(req["content"])!["parts"]).length && EMBED_MODEL.test(model)) return "embeddings";
    if (provider.includes("eleven")) return "elevenlabs";
  }
  return "raw";
}

function coerce(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

export function parseCallContent(input: unknown, output: unknown, hints: ParseHints = {}): CallContent {
  const req = coerce(input);
  const res = coerce(output);
  const format = detectFormat(req, res, hints);
  const reqObj = asObj(req);
  const resObj = asObj(res);
  switch (format) {
    case "openai-chat": return parseOpenAiChat(reqObj, resObj, hints);
    case "openai-responses": return parseOpenAiResponses(reqObj, resObj, hints);
    case "anthropic": return parseAnthropic(reqObj, resObj, hints);
    case "gemini": return parseGemini(reqObj, resObj, hints);
    case "bedrock": return parseBedrock(reqObj, resObj, hints);
    case "elevenlabs": return parseElevenLabs(reqObj, res, hints);
    case "embeddings": return parseEmbeddings(reqObj, resObj, hints);
    default: return { format: "raw", system: null, messages: [], config: {}, output: null, redactedCount: 0 };
  }
}
