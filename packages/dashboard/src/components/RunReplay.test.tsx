import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import type { TraceEvent } from "../api";
import { RunReplay } from "./RunReplay";
import { actionFrom, actionTitle, buildReplay } from "./replayModel";

const T0 = Date.UTC(2026, 10, 10, 12, 0, 0);
const sha = (fill: string) => fill.repeat(64);

function call(index: number, fields: Partial<TraceEvent> = {}): TraceEvent {
  return {
    id: `ev_${index}`, timestamp: new Date(T0 + index * 1000).toISOString(), provider: "anthropic", model: "claude-sonnet-4-5",
    input_tokens: 1_000, output_tokens: 50, total_tokens: null, cost_usd: 0.01, duration_ms: 900,
    streaming: 0, ttft: null, tps: null, call_site_frames: null, context: null,
    ...fields,
  };
}

describe("replay model", () => {
  it("makes one step per call with a screenshot, framed on the newest image", () => {
    const steps = buildReplay([
      call(0),
      call(1, { screen_frames: [{ sha256: sha("a"), mediaType: "image/png", bytes: 10 }, { sha256: sha("b"), mediaType: "image/png", bytes: 12 }] }),
      call(2, { screen_frames: [{ sha256: sha("c"), mediaType: "image/png", bytes: 12 }], cost_usd: null }),
    ]);
    expect(steps.map((step) => [step.eventId, step.frame.sha256, step.callNumber])).toEqual([
      ["ev_1", sha("b"), 2],
      ["ev_2", sha("c"), 3],
    ]);
    // Cost so far counts every call, including the ones without screenshots.
    expect(steps[0]!.costSoFar).toBeCloseTo(0.02);
    expect(steps[1]!.cost).toBeNull();
    expect(steps[1]!.costSoFar).toBeCloseTo(0.02);
  });

  it("counts a failed call as no charge", () => {
    const [step] = buildReplay([call(0, { status_code: 500, lifecycle_state: "failed", cost_usd: 0.5, screen_frames: [{ sha256: sha("d"), mediaType: "image/png", bytes: 1 }] })]);
    expect(step!.failed).toBe(true);
    expect(step!.cost).toBe(0);
    expect(step!.costSoFar).toBe(0);
  });

  it("reads Anthropic and OpenAI computer actions from a kept response", () => {
    expect(actionFrom({ content: [{ type: "text", text: "Clicking" }, { type: "tool_use", name: "computer", input: { action: "left_click", coordinate: [412, 230] } }] }))
      .toEqual({ label: "left_click", x: 412, y: 230 });
    expect(actionFrom(JSON.stringify({ content: [{ type: "tool_use", input: { action: "type", text: "hello" } }] })))
      .toEqual({ label: "type", x: undefined, y: undefined, text: "hello" });
    expect(actionFrom({ output: [{ type: "reasoning" }, { type: "computer_call", action: { type: "click", x: 10, y: 20, button: "left" } }] }))
      .toEqual({ label: "click", x: 10, y: 20 });
    expect(actionFrom({ output: [{ type: "computer_call", action: { type: "keypress", keys: ["CTRL", "L"] } }] }))
      .toEqual({ label: "keypress", x: undefined, y: undefined, text: "CTRL+L" });
    expect(actionFrom(null)).toBeNull();
    expect(actionFrom("not json")).toBeNull();
    expect(actionTitle("left_click")).toBe("Left click");
  });
});

describe("run replay", () => {
  const render = (events: TraceEvent[], selectedId: string | null = null) => renderToString(createElement(RunReplay, {
    projectId: "proj_1", events, selectedId, onSelectCall: () => undefined, currency: "USD",
  })).replace(/<!-- -->/g, "");

  it("renders nothing for runs without screenshots", () => {
    expect(render([call(0), call(1)])).toBe("");
  });

  it("shows the current step, its frame, action and the run's cost so far", () => {
    const html = render([
      call(0, {
        screen_frames: [{ sha256: sha("e"), mediaType: "image/png", bytes: 10 }],
        response_body: { content: [{ type: "tool_use", input: { action: "left_click", coordinate: [5, 6] } }] },
      }),
      call(1, { screen_frames: [{ sha256: sha("f"), mediaType: "image/png", bytes: 10, omitted: "too_large" }] }),
    ]);
    expect(html).toContain("Replay");
    expect(html).toContain("Step 1 of 2");
    expect(html).toContain(`/api/v1/projects/proj_1/frames/${sha("e")}`);
    expect(html).toContain("Left click at 5, 6");
    expect(html).toContain("Run so far");
    // An oversized screenshot is listed but has no image.
    expect(html).not.toContain(`/frames/${sha("f")}`);
  });
});
