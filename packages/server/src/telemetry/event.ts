/**
 * Applying a raw `telemetry` envelope to an ingest event: the server derives
 * every normalized call field from it and writes them onto the event, so the
 * rest of ingest stores the same columns as for SDK 0.6 events. When both
 * are present, telemetry wins over the legacy normalized fields.
 */
import type { StackFrame } from "@costkey/shared";
import { asRecord, type Rec } from "./skeleton.js";
import { extractCall, isCallTelemetry, type DerivedCall } from "./extract.js";
import { normalizeRawCallSite } from "./callsite.js";
import type { ServerExtractor } from "./types.js";

export interface AppliedTelemetry {
  derived: DerivedCall;
  /** The envelope to keep for reprocessing (size-capped), or null. */
  stored: Rec | null;
}

const MAX_STORED_TELEMETRY_BYTES = 256 * 1024;

/** Whether an event carries a v1 call telemetry envelope. */
export function hasCallTelemetry(event: Rec): boolean {
  const telemetry = asRecord(event["telemetry"]);
  if (!isCallTelemetry(telemetry) || telemetry["source"] === "livekit") return false;
  // Calls carry it; Claude Agent SDK usage events become calls. Spans, scores
  // and lifecycle events never take call fields from an envelope.
  const eventType = event["eventType"] ?? event["event_type"];
  return eventType === undefined || eventType === null || eventType === "call"
    || (eventType === "usage" && telemetry["source"] === "claude-agent-sdk");
}

/** The envelope as stored: whole when small, without stream chunks when large, else nothing. */
export function telemetryForStorage(telemetry: unknown): Rec | null {
  const record = asRecord(telemetry);
  if (!record) return null;
  const fits = (value: unknown): boolean => {
    const json = JSON.stringify(value);
    return json !== undefined && Buffer.byteLength(json, "utf8") <= MAX_STORED_TELEMETRY_BYTES;
  };
  if (fits(record)) return record;
  const stream = asRecord(record["stream"]);
  if (stream) {
    const trimmed = { ...record, stream: { ...stream, chunks: [{ $trunc: true }] } };
    if (fits(trimmed)) return trimmed;
  }
  return null;
}

/**
 * Derive the call from `event.telemetry` and overwrite the event's
 * normalized fields. Returns null (event untouched) when there is no usable
 * envelope, so the legacy path runs unchanged.
 */
export function applyCallTelemetry(
  event: Rec,
  options: { customExtractors?: readonly ServerExtractor[]; isInternalFrame?: (frame: StackFrame) => boolean } = {},
): AppliedTelemetry | null {
  if (!hasCallTelemetry(event)) return null;
  const telemetry = event["telemetry"];
  const derived = extractCall(telemetry, { customExtractors: options.customExtractors });
  if (!derived) return null;

  // Claude Agent SDK messages are token usage priced like a call.
  const eventType = event["eventType"] ?? event["event_type"];
  if (eventType === "usage" && asRecord(telemetry)?.["source"] === "claude-agent-sdk") {
    event["eventType"] = "call";
    delete event["event_type"];
  }

  event["provider"] = derived.provider;
  event["model"] = derived.model;
  event["requestModel"] = derived.requestModel;
  delete event["request_model"];
  event["url"] = derived.url ?? "";
  event["method"] = derived.method;
  event["statusCode"] = derived.statusCode;
  event["usage"] = derived.usage;
  event["costUsd"] = derived.costUsd;
  if (derived.durationMs != null) event["durationMs"] = derived.durationMs;
  event["streaming"] = derived.streaming;
  event["streamTiming"] = derived.streamTiming;
  event["providerRequestId"] = derived.providerRequestId;
  event["chargeId"] = derived.providerRequestId;
  delete event["charge_id"];
  if (derived.startedAt) event["timestamp"] = derived.startedAt;

  // SDK 0.7 sends the whole stack; keep structured frames (or parse the raw
  // text) and filter the stored raw text like the frames.
  if (options.isInternalFrame) {
    const callSite = normalizeRawCallSite(event["callSite"] ?? event["call_site"], options.isInternalFrame);
    if (callSite) {
      event["callSite"] = callSite;
      delete event["call_site"];
    }
  }

  return { derived, stored: telemetryForStorage(telemetry) };
}
