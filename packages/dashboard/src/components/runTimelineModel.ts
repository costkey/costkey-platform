import type { TraceEvent, TraceSpan } from "../api";
import { callFailure, type CallFailure } from "./callOutcome";
import { providerId } from "./ProviderLogo";
import { spanTitle } from "./runTreeModel";
import { billedUnitsText, callUsage } from "./tokenUsage";

/**
 * The run timeline's layout, kept free of React: which calls it lists, where
 * each bar sits on the time axis, the axis ticks, and each provider's share of
 * what the run cost.
 */

/** Rows shown before "Show all N calls". */
export const TIMELINE_PREVIEW = 40;

/** Provider colours on the timeline, close to the landing page's. */
const PROVIDER_COLOR: Record<string, string> = {
  anthropic: "#c4704f",
  openai: "#10a37f",
  google: "#4285f4",
  gemini: "#4285f4",
  vertex: "#4285f4",
  elevenlabs: "#2b2b2b",
  deepgram: "#1d8a5b",
  tavily: "#6c5ce7",
};

export const FALLBACK_COLOR = "var(--ck-chart, #476d9c)";

export function providerColor(provider: string | null | undefined): string {
  return PROVIDER_COLOR[providerId(provider)] ?? FALLBACK_COLOR;
}

export interface TimelineCall {
  id: string;
  event: TraceEvent;
  /** Provider id as the logos and colours know it ("google" for "gemini"). */
  provider: string;
  name: string;
  /** "claude-sonnet-4-5 · 4,180 tokens", without the model when it is already the name. */
  detail: string;
  startMs: number;
  durationMs: number;
  /** Null when the call has no price. */
  cost: number | null;
  failure: CallFailure | null;
}

export interface Timeline {
  calls: TimelineCall[];
  /** When the first call started, in epoch ms. */
  startMs: number;
  /** From the first call's start to the last call's end. */
  spanMs: number;
  providers: string[];
}

function finite(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** The function that made the call, else the span or tool it ran in, else the model. */
export function timelineCallName(event: Pick<TraceEvent, "bl_function" | "span_id" | "model">, spansById: ReadonlyMap<string, TraceSpan>): string {
  const fn = event.bl_function?.trim();
  if (fn) return fn;
  const span = event.span_id ? spansById.get(event.span_id) : undefined;
  const spanName = span ? spanTitle(span).trim() : "";
  if (spanName) return spanName;
  return event.model?.trim() || "Recorded call";
}

/** What the call used: "4,180 tokens" (input and output), else its billed units. */
export function timelineUsageText(event: TraceEvent): string {
  const usage = callUsage(event);
  if (usage.inputTokens != null || usage.outputTokens != null) {
    return `${Math.round((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)).toLocaleString("en-US")} tokens`;
  }
  const units = billedUnitsText(event.native_units);
  if (units) return units;
  const total = finite(event.total_tokens);
  if (total != null && total > 0) return `${Math.round(total).toLocaleString("en-US")} tokens`;
  const value = finite(event.unit_value);
  if (value != null) return `${value.toLocaleString("en-US")} ${event.unit_kind || event.unit || "units"}`;
  return "";
}

/** A call failed when it ended in an error or the provider answered 400 or above. */
function timelineFailure(event: TraceEvent): CallFailure | null {
  const failure = callFailure(event);
  if (failure) return failure;
  return event.lifecycle_error_type ? { label: "Failed", reason: null } : null;
}

/** The run's calls in start order, on one time axis. */
export function buildTimeline(events: TraceEvent[], spans: TraceSpan[] = []): Timeline {
  const spansById = new Map(spans.map((span) => [span.id, span]));
  const calls = events
    .map((event, index) => {
      const name = timelineCallName(event, spansById);
      const usage = timelineUsageText(event);
      const model = event.model?.trim() || "";
      return {
        index,
        call: {
          id: event.id,
          event,
          provider: providerId(event.provider),
          name,
          detail: [model && model !== name ? model : null, usage || null].filter(Boolean).join(" · "),
          startMs: new Date(event.timestamp).getTime(),
          durationMs: Math.max(0, finite(event.duration_ms) ?? 0),
          cost: finite(event.cost_usd),
          failure: timelineFailure(event),
        } satisfies TimelineCall,
      };
    })
    .sort((a, b) => {
      const left = Number.isFinite(a.call.startMs) ? a.call.startMs : Number.POSITIVE_INFINITY;
      const right = Number.isFinite(b.call.startMs) ? b.call.startMs : Number.POSITIVE_INFINITY;
      return left === right ? a.index - b.index : left - right;
    })
    .map(({ call }) => call);
  const timed = calls.filter((call) => Number.isFinite(call.startMs));
  const startMs = timed.reduce((min, call) => Math.min(min, call.startMs), Number.POSITIVE_INFINITY);
  const endMs = timed.reduce((max, call) => Math.max(max, call.startMs + call.durationMs), Number.NEGATIVE_INFINITY);
  const spanMs = Number.isFinite(startMs) && endMs > startMs ? endMs - startMs : 0;
  const providers = [...new Set(calls.map((call) => call.provider).filter(Boolean))];
  return { calls, startMs: Number.isFinite(startMs) ? startMs : 0, spanMs, providers };
}

/** Where a call's bar sits on its lane, as percentages of the lane. */
export function barGeometry(callStartMs: number, durationMs: number, runStartMs: number, spanMs: number): { left: number; width: number } {
  if (!Number.isFinite(callStartMs) || !Number.isFinite(runStartMs) || !(spanMs > 0)) return { left: 0, width: 0 };
  const left = Math.max(0, Math.min(100, (callStartMs - runStartMs) / spanMs * 100));
  const width = Math.max(0, Math.min(100 - left, (Math.max(0, durationMs) / spanMs) * 100));
  return { left: round(left), width: round(width) };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

const TICK_STEPS_MS = [
  1, 2, 5, 10, 20, 50, 100, 200, 500,
  1_000, 2_000, 5_000, 10_000, 15_000, 30_000,
  60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000, 3_600_000,
];

export interface AxisTick {
  /** Percent of the lane. */
  at: number;
  label: string;
}

/** "0 s", "2 s", "500 ms", "2 min", on a whole step. */
export function tickLabel(ms: number, stepMs: number): string {
  if (ms === 0) return "0 s";
  if (stepMs < 1_000) return `${Math.round(ms)} ms`;
  if (stepMs < 60_000) return `${round(ms / 1_000)} s`;
  return `${round(ms / 60_000)} min`;
}

/** Evenly spaced ticks on round values, at most `maxIntervals` steps across the run. */
export function axisTicks(spanMs: number, maxIntervals = 4): AxisTick[] {
  if (!(spanMs > 0)) return [];
  const step = TICK_STEPS_MS.find((candidate) => Math.floor(spanMs / candidate) <= maxIntervals)
    ?? Math.ceil(spanMs / maxIntervals / 3_600_000) * 3_600_000;
  const ticks: AxisTick[] = [];
  for (let ms = 0; ms <= spanMs + 1e-9; ms += step) ticks.push({ at: round(ms / spanMs * 100), label: tickLabel(ms, step) });
  return ticks;
}

export interface ProviderShare {
  provider: string;
  cost: number;
  /** Percent of the priced total. */
  share: number;
  /** "28%", or "<1%" for a sliver. */
  label: string;
}

/** Each provider's part of what the run cost. Unpriced calls are left out. */
export function providerShares(calls: Array<Pick<TimelineCall, "provider" | "cost">>): ProviderShare[] {
  const totals = new Map<string, number>();
  for (const call of calls) {
    if (call.cost == null || !(call.cost > 0)) continue;
    const id = call.provider || "unknown";
    totals.set(id, (totals.get(id) ?? 0) + call.cost);
  }
  const total = [...totals.values()].reduce((sum, value) => sum + value, 0);
  if (!(total > 0)) return [];
  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([provider, cost]) => {
      const share = cost / total * 100;
      return { provider, cost, share, label: share < 1 ? "<1%" : `${Math.round(share)}%` };
    });
}

/** A short form of a run id for the header: "tr_4b1a9c..." reads "4b1a9c". */
export function shortRunId(traceId: string): string {
  const bare = traceId.replace(/^(?:[a-z]+_)+/i, "") || traceId;
  return bare.slice(0, 6);
}
