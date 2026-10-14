import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import type { TraceEvent } from "../api";
import { RunTimeline } from "./RunTimeline";

const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);

function call(index: number, fields: Partial<TraceEvent> = {}): TraceEvent {
  return {
    id: `ev_${index}`, timestamp: new Date(T0 + index * 100).toISOString(), provider: "anthropic", model: "claude-sonnet-4-5",
    input_tokens: 1_000, output_tokens: 200, total_tokens: null, cost_usd: 0.002, duration_ms: 400,
    streaming: 0, ttft: null, tps: null, call_site_frames: null, context: null, bl_function: `step${index}`,
    ...fields,
  };
}

function render(events: TraceEvent[], unpriced = 0): string {
  return renderToString(createElement(RunTimeline, {
    traceId: "tr_4b1a9c77", runName: "voice-support", events, spans: [], runCost: 0.0432, unpriced, runDurationMs: 6_800,
    selectedId: "ev_1", onSelectCall: () => undefined, currency: "USD",
  }));
}

describe("run timeline", () => {
  it("heads the run like the landing page and lists each call with its usage", () => {
    const html = render([call(0), call(1, { provider: "elevenlabs", model: "eleven_v3", input_tokens: null, output_tokens: null, native_units: { characters: 1_840 } })]);
    expect(html).toContain("voice-support");
    expect(html).toContain("Run 4b1a9c · 2 calls · 2 providers");
    expect(html).toContain("Whole run");
    expect(html).toContain("claude-sonnet-4-5 · 1,200 tokens");
    expect(html).toContain("eleven_v3 · 1,840 characters");
    expect(html).toContain("ElevenLabs");
    expect(html).toMatch(/aria-pressed="true"/);
  });

  it("marks failed calls and shows unpriced ones as Unpriced", () => {
    const html = render([call(0, { status_code: 500, cost_usd: null }), call(1, { cost_usd: null })], 1);
    expect(html).toContain("is-failed");
    expect(html).toContain("Failed");
    expect(html).toContain("No charge");
    expect(html).toContain("Unpriced");
    expect(html).toContain("1 unpriced");
  });

  it("shows the first 40 calls of a long run", () => {
    const html = render(Array.from({ length: 55 }, (_, index) => call(index)));
    expect(html.match(/class="ck-tl-row/g)).toHaveLength(40);
    expect(html).toContain("Show all 55 calls");
  });

  it("keeps em and en dashes out of its copy", () => {
    const html = render([call(0, { duration_ms: 0, cost_usd: null, status_code: 429 }), call(1, { provider: "", model: "" })]);
    expect(html).not.toMatch(/[–—]/);
  });
});
