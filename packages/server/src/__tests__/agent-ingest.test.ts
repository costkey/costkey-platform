import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { billableOutputTokens } from "../billing.js";
import { callTimestampIsEnd, nativeUnitsJson, stripSpanContent } from "../ingest.js";
import { normalizeAccountingEvent, UnsupportedEventTypeError, InvalidAccountingEventError } from "../accounting.js";

describe("agent ingest helpers", () => {
  it("only treats call timestamps as end times for SDKs before 0.6", () => {
    assert.equal(callTimestampIsEnd(null), true);
    assert.equal(callTimestampIsEnd("0.5.2"), true);
    assert.equal(callTimestampIsEnd("python-0.5.1"), true);
    assert.equal(callTimestampIsEnd("0.6.0"), false);
    assert.equal(callTimestampIsEnd("python-0.6.0"), false);
    assert.equal(callTimestampIsEnd("1.0.0"), false);
  });

  it("bills Gemini thinking tokens at the output rate and leaves other providers alone", () => {
    assert.equal(billableOutputTokens({ provider: "google", model: "gemini-3.7-flash", usage: { outputTokens: 40, reasoningTokens: 20 } }), 60);
    assert.equal(billableOutputTokens({ provider: "openai", model: "gpt-6-sol", usage: { outputTokens: 40, reasoningTokens: 20 } }), 40);
    assert.equal(billableOutputTokens({ provider: "google", model: "gemini", usage: { outputTokens: 40, reasoningTokens: null } }), 40);
  });

  it("keeps native units small and numeric", () => {
    assert.equal(nativeUnitsJson({ nativeUnits: { groundingRequests: 1, label: "x", bad: -1 } }), JSON.stringify({ groundingRequests: 1 }));
    assert.equal(nativeUnitsJson({}), null);
    assert.equal(nativeUnitsJson(null), null);
  });

  it("strips span content but keeps structural attributes", () => {
    const event = { attributes: { model: "gpt-6", input: "secret", "tool.output": "secret", step: 3 } };
    stripSpanContent(event);
    assert.deepEqual(event.attributes, { model: "gpt-6", step: 3 });
  });

  it("normalizes span events and rejects unknown event types on their own", () => {
    const span = normalizeAccountingEvent({ id: "sp_1", eventType: "span", kind: "AGENT", name: "dash", status: "completed", traceId: "tr_1", timestamp: "2026-10-10T00:00:00.000Z" });
    assert.equal(span.eventType, "span");
    assert.equal(span.spanKind, "agent");
    assert.equal(span.spanStatus, "ok");
    assert.equal(span.startedAt, "2026-10-10T00:00:00.000Z");
    const call = normalizeAccountingEvent({ id: "c_1", context: { spanId: "sp_1" } });
    assert.equal(call.spanId, "sp_1");
    assert.throws(() => normalizeAccountingEvent({ id: "x", eventType: "agent_thought" }), UnsupportedEventTypeError);
    assert.throws(() => normalizeAccountingEvent({ id: "x", eventType: "span", kind: "agent" }), InvalidAccountingEventError);
    assert.throws(() => normalizeAccountingEvent({ id: "x", eventType: "span", name: "loop", parentSpanId: "x" }), InvalidAccountingEventError);
  });
});
