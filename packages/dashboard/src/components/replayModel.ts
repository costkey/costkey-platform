import type { FrameRef, TraceEvent } from "../api";
import { callFailure } from "./callOutcome";

/**
 * Run replay, kept free of React: one step per call that sent the model a
 * screenshot. The step's frame is the newest image in that call's request
 * (what the model was looking at), and its action is what the model chose in
 * the response, when the response body was kept.
 */

export interface ReplayAction {
  /** "left_click", "click", "type", "scroll", "key", … as the provider named it. */
  label: string;
  /** Where on the frame, in the screenshot's own pixels. */
  x?: number;
  y?: number;
  /** Typed text or key names, when the action has them. */
  text?: string;
}

export interface ReplayStep {
  eventId: string;
  /** Position among the run's calls (1-based), for "call 4 of 12". */
  callNumber: number;
  frame: FrameRef;
  model: string;
  durationMs: number;
  /** This call's cost; null when it couldn't be priced. */
  cost: number | null;
  /** Failed calls cost nothing. */
  failed: boolean;
  /** Known cost of every call up to and including this one. */
  costSoFar: number;
  action: ReplayAction | null;
}

function frameOf(event: TraceEvent): FrameRef | null {
  const frames = Array.isArray(event.frames) ? event.frames : [];
  for (let index = frames.length - 1; index >= 0; index--) {
    const ref = frames[index];
    if (ref && typeof ref.sha256 === "string") return ref;
  }
  return null;
}

export function buildReplay(events: TraceEvent[]): ReplayStep[] {
  const steps: ReplayStep[] = [];
  let costSoFar = 0;
  events.forEach((event, index) => {
    const failed = callFailure(event) !== null;
    const cost = failed ? 0 : event.cost_usd == null ? null : Number(event.cost_usd);
    if (cost != null && Number.isFinite(cost)) costSoFar += cost;
    const frame = frameOf(event);
    if (!frame) return;
    steps.push({
      eventId: event.id,
      callNumber: index + 1,
      frame,
      model: event.model,
      durationMs: Number(event.duration_ms) || 0,
      cost,
      failed,
      costSoFar,
      action: actionFrom(event.response_body),
    });
  });
  return steps;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** The computer action a response asked for: Anthropic's computer tool or OpenAI's computer_call. */
export function actionFrom(body: unknown): ReplayAction | null {
  let parsed = body;
  if (typeof parsed === "string") {
    try { parsed = JSON.parse(parsed); } catch { return null; }
  }
  const response = record(parsed);
  if (!response) return null;
  // Anthropic: content[] → { type: "tool_use", input: { action, coordinate, text } }
  if (Array.isArray(response["content"])) {
    for (const block of response["content"]) {
      const item = record(block);
      const input = record(item?.["input"]);
      if (item?.["type"] !== "tool_use" || !input || typeof input["action"] !== "string") continue;
      const coordinate = Array.isArray(input["coordinate"]) ? input["coordinate"] : [];
      return {
        label: input["action"],
        x: finite(coordinate[0]),
        y: finite(coordinate[1]),
        ...(typeof input["text"] === "string" ? { text: input["text"] } : {}),
      };
    }
  }
  // OpenAI Responses: output[] → { type: "computer_call", action: { type, x, y, text, keys } }
  if (Array.isArray(response["output"])) {
    for (const entry of response["output"]) {
      const item = record(entry);
      const action = record(item?.["action"]);
      if (item?.["type"] !== "computer_call" || !action || typeof action["type"] !== "string") continue;
      const keys = Array.isArray(action["keys"]) ? action["keys"].filter((key): key is string => typeof key === "string").join("+") : "";
      const text = typeof action["text"] === "string" ? action["text"] : keys || undefined;
      return { label: action["type"], x: finite(action["x"]), y: finite(action["y"]), ...(text ? { text } : {}) };
    }
  }
  return null;
}

/** "left_click" → "Left click". */
export function actionTitle(label: string): string {
  const words = label.replace(/[_-]+/g, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : label;
}
