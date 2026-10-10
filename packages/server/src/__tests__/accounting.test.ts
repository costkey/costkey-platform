import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AccountingConflictError,
  InvalidAccountingEventError,
  normalizeAccountingEvent,
  stableGroupId,
} from "../accounting.js";
import { chargesCte, dimensionExpression, scopeClauses } from "../charge-cohort.js";
import { contentStatusForEvent, sanitizeEventUrl } from "../ingest.js";
import { redactCapturedContent, stripIngestEventPrivacy } from "../privacy.js";
import { explorerSort } from "../accounting-api.js";

describe("accounting event contract", () => {
  it("keeps a legacy call as a billable call and accepts trace context", () => {
    const event = normalizeAccountingEvent({
      id: "evt_1",
      timestamp: "2026-09-13T10:00:00Z",
      provider: "openai",
      model: "gpt-4o",
      context: { traceId: "trace_1", feature: "search" },
    });
    assert.equal(event.eventType, "call");
    assert.equal(event.traceId, "trace_1");
    assert.equal(event.groupName, null);
  });

  it("requires strict id/component/revision/aggregation fields for explicit usage", () => {
    assert.throws(
      () => normalizeAccountingEvent({ eventType: "usage", id: "usage_1", timestamp: "2026-09-13T00:00:00Z", amount: { value: 1, currency: "USD" } }),
      (error: unknown) => error instanceof InvalidAccountingEventError && /componentId/.test(error.message),
    );
    assert.throws(
      () => normalizeAccountingEvent({ eventType: "usage", id: "usage_1", timestamp: "2026-09-13T00:00:00Z", componentId: "tts", revision: 1, aggregation: "delta", usage: { seconds: -1 } }),
      (error: unknown) => error instanceof InvalidAccountingEventError && /non-negative/.test(error.message),
    );
    assert.throws(
      () => normalizeAccountingEvent({ eventType: "usage", id: "usage_string", timestamp: "2026-09-13T00:00:00Z", componentId: "tts", revision: "1", aggregation: "delta", unitValue: "2" }),
      (error: unknown) => error instanceof InvalidAccountingEventError && /revision/.test(error.message),
    );
    const event = normalizeAccountingEvent({
      eventType: "usage", id: "usage_1", componentId: "tts",
      chargeId: "charge_1", revision: 1, aggregation: "delta", provider: "voice",
      usage: { seconds: 2 }, amount: { value: 0, currency: "USD" }, timestamp: "2026-09-13T00:00:00Z",
    });
    assert.equal(event.amount, 0);
    assert.equal(event.unitValue, null);
    const unknown = normalizeAccountingEvent({
      eventType: "usage", id: "usage_2", componentId: "tts", revision: 1, aggregation: "cumulative",
      provider: "voice", model: "tts-v1", usage: { seconds: 2 }, costUsd: null, timestamp: "2026-09-13T00:00:00Z",
    });
    assert.equal(unknown.amountPresent, false);
  });

  it("requires lifecycle entity identity and does not infer success", () => {
    assert.throws(
      () => normalizeAccountingEvent({ eventType: "lifecycle", id: "lc_1", timestamp: "2026-09-13T00:00:00Z", entityType: "trace", lifecycle: "completed" }),
      (error: unknown) => error instanceof InvalidAccountingEventError && /entityId/.test(error.message),
    );
    const event = normalizeAccountingEvent({
      eventType: "lifecycle", entityType: "trace", entityId: "trace_1", lifecycle: "failed",
      id: "lc_2", timestamp: "2026-09-13T10:00:00Z", errorType: "timeout",
    });
    assert.equal(event.lifecycle, "failed");
    assert.equal(event.traceId, "trace_1");
  });

  it("derives a deterministic project-scoped group identity", () => {
    assert.equal(stableGroupId("project-a", "nightly", "batch"), stableGroupId("project-a", "nightly", "batch"));
    assert.notEqual(stableGroupId("project-a", "nightly", "batch"), stableGroupId("project-b", "nightly", "batch"));
  });

  it("keeps conflict/error types available for atomic ingest handling", () => {
    assert.equal(new AccountingConflictError("x").code, "accounting_conflict");
  });
});

describe("canonical charge cohort", () => {
  it("reconciles explicit usage against automatic stable charge identity", () => {
    const sql = chargesCte();
    assert.match(sql, /DISTINCT ON \(project_id, charge_key\)/);
    assert.match(sql, /u\.accounting_at/);
    assert.match(sql, /anchor\.context.*COALESCE\(u\.context, '\{\}'::jsonb\)/s);
    assert.match(sql, /cost_usd IS NOT NULL/);
  });

  it("uses the requested alias for dimension filters", () => {
    const params: unknown[] = ["project"];
    const clauses = scopeClauses({ groupBy: "feature", groupValue: "search" }, params, "tb");
    assert.match(clauses.at(-1) ?? "", /tb\.context/);
    assert.match(dimensionExpression({ groupBy: "function" }, "tb"), /tb\.bl_file/);
  });

  it("binds repeated dimension values as OR within a dimension", () => {
    const params: unknown[] = ["project"];
    const clauses = scopeClauses({ provider: ["openai", "anthropic"], feature: ["search", "voice"] }, params, "c");
    assert.ok(clauses.some((clause) => /c\.provider = ANY/.test(clause)));
    assert.ok(clauses.some((clause) => /c\.context->>'feature' = ANY/.test(clause)));
    assert.deepEqual(params.slice(1), [["search", "voice"], ["openai", "anthropic"]]);
  });

  it("uses event-safe identifiers when the shared q predicate is applied to Calls", () => {
    const params: unknown[] = ["project"];
    const clauses = scopeClauses({ q: "trace" }, params, "e");
    const query = clauses.join(" AND ");
    assert.match(query, /e\.id ILIKE/);
    assert.match(query, /e\.charge_id ILIKE/);
    assert.doesNotMatch(query, /e\.record_id/);
  });
});

describe("explorer ordering", () => {
  it("uses only allowlisted SQL orderings and stable tie-breakers", () => {
    assert.match(explorerSort("cost_desc", "traces").orderBy, /tb\.known_cost DESC/);
    assert.match(explorerSort("duration_desc", "events").orderBy, /e\.duration_ms DESC/);
    assert.match(explorerSort("calls_desc", "traces").orderBy, /tb\.call_count DESC/);
    assert.equal(explorerSort("calls_desc", "events").value, "newest");
    assert.match(explorerSort("drop table events", "traces").orderBy, /tb\.trace_id DESC/);
    assert.match(explorerSort("drop table events", "events").orderBy, /e\.id DESC/);
  });
});

describe("ingest URL boundary", () => {
  it("strips credentials, query strings, and fragments before persistence", () => {
    assert.equal(
      sanitizeEventUrl("https://user:secret@example.com/v1/chat?api_key=secret#fragment"),
      "https://example.com/v1/chat",
    );
    assert.equal(sanitizeEventUrl("not-a-url"), null);
  });
});

describe("content capture status", () => {
  it("distinguishes captured, metadata-only, unavailable, and legacy unknown", () => {
    assert.equal(contentStatusForEvent({ requestBody: { messages: [] } }), "captured");
    assert.equal(contentStatusForEvent({ requestBody: null, metadata: { prompts: [{ role: "user" }] } }), "captured");
    assert.equal(contentStatusForEvent({ requestBody: null, responseBody: null }, { captureMode: "metadata", bodyCaptureEnabled: false }), "metadata_only");
    assert.equal(contentStatusForEvent({ requestBody: null, responseBody: null }, { captureMode: "text", bodyCaptureEnabled: true }), "not_available");
    assert.equal(contentStatusForEvent({ provider: "openai" }), "unknown");
    assert.equal(contentStatusForEvent({ contentStatus: "redacted", requestBody: null }), "redacted");
  });

  it("redacts server-side credentials while retaining non-secret text capture", () => {
    const event: Record<string, unknown> = {
      requestBody: {
        messages: [{ role: "user", content: "keep this prompt" }],
        api_key: "sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
      responseBody: "Bearer eyJaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      metadata: { toolCalls: [{ name: "lookup", arguments: { secret: "do-not-store" } }] },
      context: { feature: "search", apiKey: "sk-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
    };
    stripIngestEventPrivacy(event, { allowBody: true, allowSource: true, redactionEnabled: true });
    assert.equal((event.requestBody as Record<string, unknown>).api_key, "[REDACTED]");
    assert.match(JSON.stringify((event.requestBody as Record<string, unknown>).messages), /keep this prompt/);
    assert.equal(event.responseBody, "Bearer [REDACTED]");
    assert.equal((event.metadata as Record<string, unknown>).toolCalls !== undefined, true);
    assert.equal((event.context as Record<string, unknown>).apiKey, "[REDACTED]");
    assert.deepEqual(redactCapturedContent({ password: "private", value: "visible" }), {
      password: "[REDACTED]", value: "visible",
    });
  });
});
