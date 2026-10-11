import type pg from "pg";

/**
 * Turn a run's captured prompts, responses and tool payloads into a compact
 * transcript for a judge. Only reads what the project already stored under
 * text capture; a metadata-only project has nothing here.
 */

export interface RunTranscript {
  system: string | null;
  question: string | null;
  steps: string[];
  answer: string | null;
}

const MAX_SECTION_CHARS = 6_000;
const MAX_STEP_CHARS = 1_500;
const MAX_STEPS = 24;

function clip(value: string, max: number): string {
  const trimmed = value.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)} [truncated]`;
}

function parse(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}

function unwrapTruncated(value: unknown): unknown {
  if (value && typeof value === "object" && (value as Record<string, unknown>)["__costkey_truncated__"] === true) {
    return String((value as Record<string, unknown>)["preview"] ?? "");
  }
  return value;
}

/** Text from a message `content` in any of the OpenAI, Anthropic or Gemini shapes. */
export function contentText(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(contentText).filter(Boolean).join("\n");
  if (typeof content !== "object") return String(content);
  const part = content as Record<string, unknown>;
  if (typeof part["text"] === "string") return part["text"];
  if (part["type"] === "tool_use" || part["functionCall"] || part["function_call"]) {
    const call = (part["functionCall"] ?? part["function_call"] ?? part) as Record<string, unknown>;
    return `[tool call ${String(call["name"] ?? "tool")}] ${JSON.stringify(call["input"] ?? call["args"] ?? call["arguments"] ?? {})}`;
  }
  if (part["type"] === "tool_result" || part["functionResponse"]) {
    const result = (part["functionResponse"] ?? part) as Record<string, unknown>;
    return `[tool result] ${contentText(result["content"] ?? result["response"] ?? "")}`;
  }
  if (Array.isArray(part["parts"])) return contentText(part["parts"]);
  if ("content" in part) return contentText(part["content"]);
  if ("output_text" in part) return contentText(part["output_text"]);
  return "";
}

interface Message { role: string; text: string }

/** Messages from a request body: chat messages, Responses `input`, or Gemini `contents`. */
export function requestMessages(body: unknown): { system: string | null; messages: Message[] } {
  const value = unwrapTruncated(parse(body));
  if (typeof value === "string") return { system: null, messages: value ? [{ role: "user", text: value }] : [] };
  if (!value || typeof value !== "object") return { system: null, messages: [] };
  const request = value as Record<string, unknown>;
  const systemParts: string[] = [];
  if (request["system"] !== undefined) systemParts.push(contentText(request["system"]));
  if (typeof request["instructions"] === "string") systemParts.push(request["instructions"]);
  const systemInstruction = request["systemInstruction"] ?? request["system_instruction"];
  if (systemInstruction) systemParts.push(contentText(systemInstruction));
  const messages: Message[] = [];
  const raw = Array.isArray(request["messages"]) ? request["messages"]
    : Array.isArray(request["contents"]) ? request["contents"]
      : Array.isArray(request["input"]) ? request["input"]
        : typeof request["input"] === "string" ? [{ role: "user", content: request["input"] }]
          : typeof request["prompt"] === "string" ? [{ role: "user", content: request["prompt"] }]
            : [];
  for (const item of raw as unknown[]) {
    if (!item || typeof item !== "object") continue;
    const message = item as Record<string, unknown>;
    const role = String(message["role"] ?? message["type"] ?? "user");
    let text = contentText(message["content"] ?? message["parts"] ?? message["output"] ?? "");
    if (!text && Array.isArray(message["tool_calls"])) text = contentText((message["tool_calls"] as unknown[]).map((call) => ({ type: "tool_use", ...(call as Record<string, unknown>)["function"] as Record<string, unknown> })));
    if (role === "system" || role === "developer") { if (text) systemParts.push(text); continue; }
    if (text) messages.push({ role: role === "model" ? "assistant" : role, text });
  }
  const system = systemParts.filter(Boolean).join("\n").trim();
  return { system: system || null, messages };
}

/** The model's reply from a response body in the OpenAI, Anthropic or Gemini shapes. */
export function responseText(body: unknown): string {
  const value = unwrapTruncated(parse(body));
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const response = value as Record<string, unknown>;
  if (Array.isArray(response["choices"])) {
    return (response["choices"] as Array<Record<string, unknown>>).map((choice) => {
      const message = (choice["message"] ?? choice["delta"] ?? {}) as Record<string, unknown>;
      const text = contentText(message["content"] ?? choice["text"] ?? "");
      const tools = Array.isArray(message["tool_calls"])
        ? contentText((message["tool_calls"] as unknown[]).map((call) => ({ type: "tool_use", ...(call as Record<string, unknown>)["function"] as Record<string, unknown> })))
        : "";
      return [text, tools].filter(Boolean).join("\n");
    }).filter(Boolean).join("\n");
  }
  if (Array.isArray(response["candidates"])) {
    return (response["candidates"] as Array<Record<string, unknown>>).map((candidate) => contentText(candidate["content"])).filter(Boolean).join("\n");
  }
  if (typeof response["output_text"] === "string") return response["output_text"];
  if (Array.isArray(response["output"])) return contentText(response["output"]);
  if (Array.isArray(response["content"])) return contentText(response["content"]);
  if (typeof response["completion"] === "string") return response["completion"];
  if (typeof response["text"] === "string") return response["text"];
  return "";
}

function spanPayload(attributes: unknown, keys: string[]): string {
  if (!attributes || typeof attributes !== "object") return "";
  for (const [key, value] of Object.entries(attributes as Record<string, unknown>)) {
    const leaf = (key.split(".").pop() ?? key).toLowerCase();
    if (!keys.includes(leaf) || value == null) continue;
    return typeof value === "string" ? value : JSON.stringify(value);
  }
  return "";
}

/**
 * Build the transcript from stored calls and tool spans, or null when the run
 * has no captured text at all.
 */
export async function loadRunTranscript(pool: pg.Pool | pg.PoolClient, projectId: string, traceId: string): Promise<RunTranscript | null> {
  const [calls, spans] = await Promise.all([
    pool.query(
      `SELECT id, model, timestamp, system_prompt, request_body::text AS request_body, response_body::text AS response_body,
              metadata::text AS metadata
       FROM events
       WHERE project_id = $1 AND trace_id = $2 AND COALESCE(event_type, 'call') = 'call'
       ORDER BY timestamp ASC, id ASC
       LIMIT 200`,
      [projectId, traceId],
    ),
    pool.query(
      `SELECT name, kind, status, started_at, attributes
       FROM spans WHERE project_id = $1 AND trace_id = $2 AND kind = 'tool'
       ORDER BY started_at ASC NULLS LAST, id ASC
       LIMIT 100`,
      [projectId, traceId],
    ),
  ]);

  let system: string | null = null;
  let question: string | null = null;
  let answer: string | null = null;
  const steps: Array<{ at: number; text: string }> = [];
  const callRows = calls.rows as Array<Record<string, unknown>>;
  for (const [index, row] of callRows.entries()) {
    const metadata = parse(row.metadata) as Record<string, unknown> | null;
    const request = requestMessages(row.request_body ?? metadata?.["prompt"] ?? metadata?.["prompts"]);
    const reply = responseText(row.response_body ?? metadata?.["completion"] ?? metadata?.["response"]);
    const at = row.timestamp instanceof Date ? row.timestamp.getTime() : Date.parse(String(row.timestamp));
    if (!system) system = (typeof row.system_prompt === "string" && row.system_prompt.trim()) ? row.system_prompt : request.system;
    if (index === 0) {
      const firstUser = [...request.messages].reverse().find((message) => message.role === "user");
      question = firstUser?.text ?? null;
    } else {
      // Tool results the model saw on this turn are the run's retrieved context.
      for (const message of request.messages.slice(-4)) {
        if (message.role === "tool" || message.role === "function" || message.text.startsWith("[tool result]")) {
          steps.push({ at, text: `Tool result: ${clip(message.text, MAX_STEP_CHARS)}` });
        }
      }
    }
    if (reply) {
      if (index === callRows.length - 1) answer = reply;
      else steps.push({ at, text: `Model (${String(row.model ?? "model")}): ${clip(reply, MAX_STEP_CHARS)}` });
    }
  }
  for (const row of spans.rows as Array<Record<string, unknown>>) {
    const input = spanPayload(row.attributes, ["input", "args", "arguments"]);
    const output = spanPayload(row.attributes, ["output", "result"]);
    if (!input && !output) continue;
    const at = row.started_at instanceof Date ? row.started_at.getTime() : Date.parse(String(row.started_at ?? ""));
    const status = row.status === "error" ? " (errored)" : "";
    steps.push({
      at: Number.isFinite(at) ? at : Number.MAX_SAFE_INTEGER,
      text: clip(`Tool ${String(row.name)}${status}: ${input ? `input ${input}` : ""}${input && output ? "; " : ""}${output ? `output ${output}` : ""}`, MAX_STEP_CHARS),
    });
  }
  if (!system && !question && !answer && steps.length === 0) return null;
  return {
    system: system ? clip(system, MAX_SECTION_CHARS) : null,
    question: question ? clip(question, MAX_SECTION_CHARS) : null,
    steps: steps.sort((a, b) => a.at - b.at).slice(0, MAX_STEPS).map((step) => step.text),
    answer: answer ? clip(answer, MAX_SECTION_CHARS) : null,
  };
}

/** The user message a judge reads. */
export function formatTranscript(transcript: RunTranscript): string {
  const sections = [
    `## Instructions given to the agent\n${transcript.system ?? "(none captured)"}`,
    `## User request\n${transcript.question ?? "(not captured)"}`,
    `## Tool calls and retrieved context\n${transcript.steps.length ? transcript.steps.map((step, index) => `${index + 1}. ${step}`).join("\n") : "(none)"}`,
    `## Final answer\n${transcript.answer ?? "(not captured)"}`,
  ];
  return sections.join("\n\n");
}
