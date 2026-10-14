import { describe, expect, it } from "vitest";
import type { TraceEvent } from "../api";
import { runCallSites, runLabel, siteLocation } from "./runCallSites";

const call = (fields: Partial<TraceEvent>): TraceEvent => ({ id: "c", timestamp: "2026-10-12T05:00:00.000Z", provider: "openai", model: "gpt-4o", input_tokens: null, output_tokens: null, total_tokens: null, cost_usd: null, duration_ms: 1, streaming: 0, ttft: null, tps: null, call_site_frames: null, context: null, ...fields });

describe("run call sites", () => {
  it("groups calls by where they ran and sorts by cost", () => {
    const sites = runCallSites([
      call({ id: "a", bl_function: "summarize", bl_file: "src/search.ts", bl_line: 47, cost_usd: 0.01 }),
      call({ id: "b", bl_function: "summarize", bl_file: "src/search.ts", bl_line: 47, cost_usd: 0.03 }),
      call({ id: "c", bl_function: "speak", bl_file: "src/tts.ts", bl_line: 9, provider: "elevenlabs", model: "eleven_multilingual_v2", cost_usd: 0.159 }),
      call({ id: "d", cost_usd: 1 }),
    ]);
    expect(sites.map((site) => [site.functionName, site.calls, site.cost, site.firstCallId])).toEqual([
      ["speak", 1, 0.159, "c"],
      ["summarize", 2, 0.04, "b"],
    ]);
    expect(siteLocation(sites[1])).toBe("src/search.ts:47");
  });

  it("doesn't count a failed call without a price as unpriced", () => {
    const [site] = runCallSites([call({ id: "t", bl_function: "speak", lifecycle_state: "failed", lifecycle_error_type: "ReadTimeout" })]);
    expect(site.unpriced).toBe(0);
  });

  it("reads the feature and release from the run, then from its calls' context", () => {
    const events = [call({ context: JSON.stringify({ feature: "generated-media-tts", release: "v1.4.0" }) })];
    expect(runLabel({}, events, "feature")).toBe("generated-media-tts");
    expect(runLabel({ feature: "search" }, events, "feature")).toBe("search");
    expect(runLabel({}, events, "release")).toBe("v1.4.0");
    expect(runLabel({}, [call({})], "release")).toBeNull();
  });
});
