import { describe, expect, it } from "vitest";
import type { TraceEvent, TraceSpan } from "../api";
import { axisTicks, barGeometry, buildTimeline, FALLBACK_COLOR, providerColor, providerShares, shortRunId, timelineUsageText } from "./runTimelineModel";

const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);

function call(fields: Partial<TraceEvent> & { at?: number }): TraceEvent {
  const { at = 0, ...rest } = fields;
  return {
    id: `ev_${at}`, timestamp: new Date(T0 + at).toISOString(), provider: "openai", model: "gpt-5",
    input_tokens: null, output_tokens: null, total_tokens: null, cost_usd: 0.001, duration_ms: 100,
    streaming: 0, ttft: null, tps: null, call_site_frames: null, context: null,
    ...rest,
  };
}

const span = (id: string, name: string): TraceSpan => ({ id, parent_span_id: null, kind: "tool", name, status: "ok", error_type: null, started_at: null, ended_at: null, duration_ms: null, attributes: null, execution_id: null });

describe("bar geometry", () => {
  it("places a bar at its start offset and sizes it to its duration", () => {
    expect(barGeometry(T0 + 2_200, 2_400, T0, 6_800)).toEqual({ left: 32.35, width: 35.29 });
  });

  it("starts the first call at zero and stops a bar at the lane's end", () => {
    expect(barGeometry(T0, 1_000, T0, 4_000)).toEqual({ left: 0, width: 25 });
    expect(barGeometry(T0 + 3_000, 5_000, T0, 4_000)).toEqual({ left: 75, width: 25 });
  });

  it("draws nothing when the run has no length or the call no time", () => {
    expect(barGeometry(T0, 1_000, T0, 0)).toEqual({ left: 0, width: 0 });
    expect(barGeometry(Number.NaN, 1_000, T0, 4_000)).toEqual({ left: 0, width: 0 });
  });
});

describe("axis ticks", () => {
  it("ticks a 6.8 s run every 2 s, like the landing page", () => {
    expect(axisTicks(6_800)).toEqual([
      { at: 0, label: "0 s" },
      { at: 29.41, label: "2 s" },
      { at: 58.82, label: "4 s" },
      { at: 88.24, label: "6 s" },
    ]);
  });

  it("uses milliseconds for short runs and minutes for long ones", () => {
    expect(axisTicks(900).map((tick) => tick.label)).toEqual(["0 s", "200 ms", "400 ms", "600 ms", "800 ms"]);
    expect(axisTicks(5 * 60_000).map((tick) => tick.label)).toEqual(["0 s", "2 min", "4 min"]);
  });

  it("never draws more than four steps", () => {
    for (const span of [1, 37, 999, 1_001, 12_345, 59_000, 61_000, 7_200_000, 50_000_000]) {
      expect(axisTicks(span).length).toBeLessThanOrEqual(5);
      expect(axisTicks(span).length).toBeGreaterThanOrEqual(1);
    }
  });

  it("has no ticks for a run with no length", () => {
    expect(axisTicks(0)).toEqual([]);
  });
});

describe("provider shares", () => {
  it("splits the priced cost by provider, largest first", () => {
    const shares = providerShares([
      { provider: "anthropic", cost: 0.0123 },
      { provider: "openai", cost: 0.0001 },
      { provider: "elevenlabs", cost: 0.0183 },
      { provider: "anthropic", cost: 0.0010 },
    ]);
    expect(shares.map((share) => [share.provider, share.label])).toEqual([["elevenlabs", "58%"], ["anthropic", "42%"], ["openai", "<1%"]]);
    expect(shares.reduce((sum, share) => sum + share.share, 0)).toBeCloseTo(100);
  });

  it("leaves unpriced and free calls out", () => {
    expect(providerShares([{ provider: "openai", cost: null }, { provider: "google", cost: 0 }, { provider: "anthropic", cost: 0.01 }]))
      .toEqual([{ provider: "anthropic", cost: 0.01, share: 100, label: "100%" }]);
    expect(providerShares([{ provider: "openai", cost: null }])).toEqual([]);
  });
});

describe("timeline rows", () => {
  it("lists calls in start order and spans the axis from first start to last end", () => {
    const timeline = buildTimeline([call({ at: 2_000, duration_ms: 500 }), call({ at: 0, duration_ms: 1_000 }), call({ at: 1_000, duration_ms: 3_000 })]);
    expect(timeline.calls.map((row) => row.startMs - T0)).toEqual([0, 1_000, 2_000]);
    expect(timeline.startMs).toBe(T0);
    expect(timeline.spanMs).toBe(4_000);
  });

  it("names a call by its function, else its span, else its model", () => {
    const spans = [span("sp_1", "lookupPolicy")];
    const rows = buildTimeline([
      call({ at: 0, bl_function: "draftReply", span_id: "sp_1" }),
      call({ at: 1, span_id: "sp_1" }),
      call({ at: 2, model: "nova-3" }),
    ], spans).calls;
    expect(rows.map((row) => row.name)).toEqual(["draftReply", "lookupPolicy", "nova-3"]);
    expect(rows[2].detail).not.toContain("nova-3");
  });

  it("reads usage as total tokens, else billed units", () => {
    expect(timelineUsageText(call({ provider: "anthropic", model: "claude-sonnet-4-5", input_tokens: 3_800, output_tokens: 380 }))).toBe("4,180 tokens");
    expect(timelineUsageText(call({ provider: "elevenlabs", model: "eleven_v3", native_units: { characters: 1_840 } }))).toBe("1,840 characters");
    expect(timelineUsageText(call({ provider: "deepgram", model: "nova-3", native_units: { audioSeconds: 192 } }))).toBe("192 s audio");
    expect(timelineUsageText(call({}))).toBe("");
  });

  it("marks failed calls and keeps unpriced ones unpriced", () => {
    const rows = buildTimeline([
      call({ at: 0, status_code: 429, cost_usd: null }),
      call({ at: 1, lifecycle_state: "failed", lifecycle_error_type: "ReadTimeout" }),
      call({ at: 2, cost_usd: null }),
    ]).calls;
    expect(rows.map((row) => row.failure?.label ?? null)).toEqual(["Failed", "Failed", null]);
    expect(rows[2].cost).toBeNull();
  });
});

describe("provider colours and run ids", () => {
  it("uses the landing colours and falls back to the chart colour", () => {
    expect(providerColor("anthropic")).toBe("#c4704f");
    expect(providerColor("Gemini")).toBe("#4285f4");
    expect(providerColor("vertexai")).toBe("#4285f4");
    expect(providerColor("mistral")).toBe(FALLBACK_COLOR);
  });

  it("shortens a run id past its prefix", () => {
    expect(shortRunId("tr_demo_t6b2v56bkj")).toBe("t6b2v5");
    expect(shortRunId("150630dab0744c86")).toBe("150630");
  });
});
