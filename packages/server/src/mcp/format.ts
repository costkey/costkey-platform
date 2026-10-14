/**
 * Compact text for coding agents: money, durations, times, source locations,
 * and prompt/response bodies trimmed to a budget. Agents read every character
 * we send, so nothing here pads or repeats.
 */

export type Row = Record<string, unknown>;

export function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export function usd(value: unknown): string {
  const amount = num(value);
  if (amount === null) return "unpriced";
  if (amount === 0) return "$0";
  const abs = Math.abs(amount);
  const sign = amount < 0 ? "-" : "";
  if (abs < 0.0001) return `${sign}<$0.0001`;
  if (abs < 1) return `${sign}$${abs.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`;
  return `${sign}$${abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function signedUsd(value: unknown): string {
  const amount = num(value);
  if (amount === null) return "n/a";
  return amount > 0 ? `+${usd(amount)}` : usd(amount);
}

export function pct(value: unknown): string {
  const amount = num(value);
  if (amount === null) return "n/a";
  return `${amount > 0 ? "+" : ""}${amount.toFixed(Math.abs(amount) < 10 ? 1 : 0)}%`;
}

export function duration(value: unknown): string {
  const ms = num(value);
  if (ms === null) return "n/a";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return minutes < 60 ? `${minutes}m ${seconds}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function count(value: unknown): string {
  const amount = num(value);
  return amount === null ? "n/a" : Math.round(amount).toLocaleString("en-US");
}

export function ago(value: unknown, now = Date.now()): string {
  const time = value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(time)) return "time unknown";
  const seconds = Math.round((now - time) / 1000);
  if (seconds < 0) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

/** "2026-10-14 10:22:03Z (3m ago)". */
export function when(value: unknown): string {
  const time = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  if (!time || Number.isNaN(time.getTime())) return "time unknown";
  return `${time.toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z")} (${ago(time)})`;
}

/** "src/agents/summarize.ts:42 summarize()" from a call's attributed frame. */
export function location(file: unknown, line: unknown, fn: unknown): string | null {
  const path = str(file);
  const name = str(fn);
  if (!path && !name) return null;
  const at = path ? `${path}${num(line) ? `:${num(line)}` : ""}` : null;
  return [at, name ? `${name.split("\n")[0]}()` : null].filter(Boolean).join(" ");
}

/** Cut text to `max` characters, saying how much was left out. */
export function trim(text: string, max: number): string {
  if (max <= 0) return `[${text.length.toLocaleString("en-US")} chars omitted]`;
  if (text.length <= max) return text;
  const head = Math.max(0, max - 40);
  return `${text.slice(0, head)}… [${(text.length - head).toLocaleString("en-US")} more chars]`;
}

const DATA_URL = /data:([a-z]+\/[a-z0-9.+-]+);base64,[A-Za-z0-9+/=]{64,}/gi;
const LONG_BASE64 = /^[A-Za-z0-9+/=\r\n]{512,}$/;

function sizeOf(base64Length: number): string {
  const bytes = Math.round(base64Length * 0.75);
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Images, audio and other base64 payloads as a short marker. */
export function stripBinary(text: string): string {
  const withoutDataUrls = text.replace(DATA_URL, (match, mime: string) => `[${mime} base64, ${sizeOf(match.length)} omitted]`);
  return LONG_BASE64.test(withoutDataUrls.trim()) ? `[base64, ${sizeOf(withoutDataUrls.length)} omitted]` : withoutDataUrls;
}

/** A JSON value with binary payloads replaced, for a raw fallback. */
export function scrub(value: unknown, depth = 0): unknown {
  if (depth > 12) return "[nested too deep]";
  if (typeof value === "string") return stripBinary(value);
  if (Array.isArray(value)) return value.map((item) => scrub(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if ((key === "data" || key === "b64_json" || key === "image_url" || key === "inlineData" || key === "inline_data")
      && typeof entry === "string" && entry.length > 256) {
      result[key] = `[base64, ${sizeOf(entry.length)} omitted]`;
      continue;
    }
    result[key] = scrub(entry, depth + 1);
  }
  return result;
}

export function compactJson(value: unknown, max: number): string {
  let text: string;
  try { text = JSON.stringify(scrub(value)); } catch { text = String(value); }
  return trim(text ?? "", max);
}

function asObject(value: unknown): Row | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : null;
}

function parsedBody(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (!text.startsWith("{") && !text.startsWith("[")) return value;
  try { return JSON.parse(text); } catch { return value; }
}

function argsText(value: unknown): string {
  if (typeof value === "string") return value;
  try { return JSON.stringify(scrub(value)); } catch { return String(value); }
}

/** One content part (any provider) as text. */
function partText(part: unknown): string {
  if (typeof part === "string") return stripBinary(part);
  const item = asObject(part);
  if (!item) return "";
  const type = String(item["type"] ?? "");
  if (typeof item["text"] === "string") return stripBinary(item["text"]);
  if (type === "image_url" || type === "image" || type === "input_image" || item["image_url"] || item["inlineData"] || item["inline_data"]) {
    const inline = asObject(item["inlineData"] ?? item["inline_data"]);
    return `[image${inline?.["mimeType"] ? ` ${String(inline["mimeType"])}` : ""}]`;
  }
  if (type === "input_audio" || type === "audio") return "[audio]";
  if (type === "file" || type === "input_file" || type === "document") return "[file]";
  if (type === "tool_use" || type === "function_call") return `[tool call ${String(item["name"] ?? "?")}(${argsText(item["input"] ?? item["arguments"] ?? {})})]`;
  if (type === "tool_result" || type === "function_call_output") {
    const content = item["content"] ?? item["output"];
    return `[tool result${item["is_error"] ? " (error)" : ""}] ${Array.isArray(content) ? content.map(partText).join(" ") : typeof content === "string" ? content : argsText(content)}`;
  }
  if (type === "thinking" || type === "reasoning" || type === "redacted_thinking") return "[thinking]";
  const call = asObject(item["functionCall"] ?? item["function_call"]);
  if (call) return `[tool call ${String(call["name"] ?? "?")}(${argsText(call["args"] ?? call["arguments"] ?? {})})]`;
  const response = asObject(item["functionResponse"] ?? item["function_response"]);
  if (response) return `[tool result ${String(response["name"] ?? "")}] ${argsText(response["response"] ?? {})}`;
  return compactJson(item, 400);
}

function contentText(content: unknown): string {
  if (typeof content === "string") return stripBinary(content);
  if (Array.isArray(content)) return content.map(partText).filter(Boolean).join("\n");
  if (content == null) return "";
  return partText(content);
}

export interface Message { role: string; text: string }
export interface Conversation { system: string | null; messages: Message[] }

function openAiToolCalls(message: Row): string[] {
  const calls = Array.isArray(message["tool_calls"]) ? message["tool_calls"] as unknown[] : [];
  return calls.map((raw) => {
    const call = asObject(raw);
    const fn = asObject(call?.["function"]);
    return `[tool call ${String(fn?.["name"] ?? call?.["name"] ?? "?")}(${argsText(fn?.["arguments"] ?? {})})]`;
  });
}

/** The system prompt and messages of a request, for OpenAI, Anthropic, Gemini and OpenAI Responses bodies. */
export function conversationFrom(requestBody: unknown, systemPrompt?: unknown, metadata?: unknown): Conversation | null {
  const body = asObject(parsedBody(requestBody));
  const systemParts: string[] = [];
  if (str(systemPrompt)) systemParts.push(String(systemPrompt));
  const messages: Message[] = [];
  if (body) {
    if (typeof body["system"] === "string") systemParts.push(body["system"]);
    else if (Array.isArray(body["system"])) systemParts.push(contentText(body["system"]));
    if (typeof body["instructions"] === "string") systemParts.push(body["instructions"]);
    const systemInstruction = asObject(body["systemInstruction"] ?? body["system_instruction"]);
    if (systemInstruction) systemParts.push(contentText(systemInstruction["parts"]));
    if (Array.isArray(body["messages"])) {
      for (const raw of body["messages"] as unknown[]) {
        const message = asObject(raw);
        if (!message) continue;
        const role = String(message["role"] ?? "user");
        const text = [contentText(message["content"]), ...openAiToolCalls(message)].filter(Boolean).join("\n");
        if ((role === "system" || role === "developer") && messages.length === 0) { systemParts.push(text); continue; }
        messages.push({ role: role === "tool" ? `tool${message["name"] ? ` ${String(message["name"])}` : ""}` : role, text });
      }
    } else if (Array.isArray(body["contents"])) {
      for (const raw of body["contents"] as unknown[]) {
        const content = asObject(raw);
        if (!content) { if (typeof raw === "string") messages.push({ role: "user", text: raw }); continue; }
        messages.push({ role: String(content["role"] ?? "user"), text: contentText(content["parts"]) });
      }
    } else if (body["input"] !== undefined) {
      const input = body["input"];
      if (typeof input === "string") messages.push({ role: "user", text: input });
      else if (Array.isArray(input)) {
        for (const raw of input) {
          const item = asObject(raw);
          if (!item) { if (typeof raw === "string") messages.push({ role: "user", text: raw }); continue; }
          if (item["role"]) {
            const role = String(item["role"]);
            const text = contentText(item["content"]);
            if ((role === "system" || role === "developer") && messages.length === 0) { systemParts.push(text); continue; }
            messages.push({ role, text });
          } else {
            messages.push({ role: item["type"] === "function_call_output" ? "tool" : "assistant", text: partText(item) });
          }
        }
      }
    } else if (typeof body["prompt"] === "string") {
      messages.push({ role: "user", text: body["prompt"] });
    }
  }
  // Calls captured without a body may still carry normalized prompts.
  const meta = asObject(metadata);
  if (messages.length === 0 && meta && Array.isArray(meta["prompts"])) {
    for (const raw of meta["prompts"] as unknown[]) {
      const prompt = asObject(raw);
      if (!prompt) continue;
      const role = String(prompt["role"] ?? "user");
      const text = contentText(prompt["content"]);
      if (role === "system" && messages.length === 0) systemParts.push(text);
      else messages.push({ role, text });
    }
  }
  const system = systemParts.map((part) => part.trim()).filter(Boolean).join("\n\n") || null;
  if (!system && messages.length === 0) return null;
  return { system, messages };
}

/** The model's answer, or the provider's error, from a response body. */
export function responseText(responseBody: unknown): string | null {
  const body = parsedBody(responseBody);
  if (typeof body === "string") return stripBinary(body);
  const root = asObject(body);
  if (!root) return null;
  const error = asObject(root["error"]);
  if (error) return `[error${error["type"] ? ` ${String(error["type"])}` : ""}${error["code"] ? ` ${String(error["code"])}` : ""}] ${String(error["message"] ?? compactJson(error, 500))}`;
  if (typeof root["error"] === "string") return `[error] ${root["error"]}`;
  const parts: string[] = [];
  if (Array.isArray(root["choices"])) {
    for (const raw of root["choices"] as unknown[]) {
      const choice = asObject(raw);
      if (!choice) continue;
      const message = asObject(choice["message"] ?? choice["delta"]);
      if (message) parts.push([contentText(message["content"]), ...openAiToolCalls(message)].filter(Boolean).join("\n"));
      else if (typeof choice["text"] === "string") parts.push(choice["text"]);
      if (choice["finish_reason"] && choice["finish_reason"] !== "stop") parts.push(`[finish_reason: ${String(choice["finish_reason"])}]`);
    }
  } else if (Array.isArray(root["content"])) {
    parts.push(contentText(root["content"]));
    if (root["stop_reason"] && root["stop_reason"] !== "end_turn") parts.push(`[stop_reason: ${String(root["stop_reason"])}]`);
  } else if (Array.isArray(root["candidates"])) {
    for (const raw of root["candidates"] as unknown[]) {
      const candidate = asObject(raw);
      parts.push(contentText(asObject(candidate?.["content"])?.["parts"]));
      if (candidate?.["finishReason"] && candidate["finishReason"] !== "STOP") parts.push(`[finishReason: ${String(candidate["finishReason"])}]`);
    }
  } else if (Array.isArray(root["output"])) {
    for (const raw of root["output"] as unknown[]) {
      const item = asObject(raw);
      if (!item) continue;
      if (item["type"] === "message") parts.push(contentText(item["content"]));
      else parts.push(partText(item));
    }
  } else if (typeof root["output_text"] === "string") {
    parts.push(root["output_text"]);
  } else if (typeof root["text"] === "string") {
    parts.push(root["text"]);
  } else if (Array.isArray(root["data"])) {
    // Embeddings and images: the shape, not the vectors.
    return `[${(root["data"] as unknown[]).length} item${(root["data"] as unknown[]).length === 1 ? "" : "s"} returned]`;
  }
  const text = parts.filter(Boolean).join("\n").trim();
  return text || null;
}

/**
 * The conversation as text: the system prompt, then the last `lastN`
 * messages, saying how many earlier ones were left out. Each part is trimmed
 * so the whole stays inside `budget` characters.
 */
export function renderConversation(conversation: Conversation, budget: number, lastN: number): string {
  const kept = conversation.messages.slice(-lastN);
  const omitted = conversation.messages.length - kept.length;
  const pieces = (conversation.system ? 1 : 0) + kept.length;
  const share = Math.max(160, Math.floor(budget / Math.max(1, pieces)));
  const lines: string[] = [];
  if (conversation.system) lines.push(`[system] ${trim(conversation.system, Math.min(share, Math.floor(budget * 0.4)))}`);
  if (omitted > 0) lines.push(`… ${omitted} earlier message${omitted === 1 ? "" : "s"} omitted (include "messages" to see all)`);
  for (const message of kept) lines.push(`[${message.role}] ${trim(message.text || "(empty)", share)}`);
  return lines.join("\n");
}

export interface Frame {
  functionName?: string | null;
  fileName?: string | null;
  lineNumber?: number | null;
  contextLine?: string | null;
  preContext?: string[] | null;
  postContext?: string[] | null;
}

const INSTALLED = /(?:^|[\\/])(?:site-packages|dist-packages|node_modules)[\\/]|^node:|^internal\//;

export function isInAppFrame(frame: Frame): boolean {
  const file = frame.fileName ?? "";
  return Boolean(file) && !INSTALLED.test(file);
}

/** A frame with the recorded source around its line, numbered as in the file. */
export function renderFrame(frame: Frame, withSource: boolean): string {
  const head = location(frame.fileName, frame.lineNumber, frame.functionName) ?? "(unknown frame)";
  if (!withSource || typeof frame.contextLine !== "string") return head;
  const line = num(frame.lineNumber);
  const pre = Array.isArray(frame.preContext) ? frame.preContext.filter((item): item is string => typeof item === "string") : [];
  const post = Array.isArray(frame.postContext) ? frame.postContext.filter((item): item is string => typeof item === "string") : [];
  const numbered = (text: string, offset: number, mark: boolean) => {
    const number = line === null ? "" : String(line + offset);
    return `  ${mark ? ">" : " "} ${number.padStart(5)} | ${text}`;
  };
  return [
    head,
    ...pre.map((text, index) => numbered(text, index - pre.length, false)),
    numbered(frame.contextLine, 0, true),
    ...post.map((text, index) => numbered(text, index + 1, false)),
  ].join("\n");
}
