import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CostKey } from "../index.js";

type Event = Record<string, unknown>;

describe("CostKey.score", () => {
  let originalFetch: typeof globalThis.fetch;
  let events: Event[];
  let captureBody: boolean;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    events = [];
    captureBody = false;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "https://costkey.dev/api/v1/events") {
        const body = JSON.parse(String(init?.body)) as { events: Event[] };
        events.push(...body.events);
        return new Response(JSON.stringify({ accepted: body.events.length }), { status: 202 });
      }
      if (url.endsWith("/config")) {
        return new Response(JSON.stringify({
          projectId: "score-test",
          capture: { mode: captureBody ? "text" : "metadata", bodyCaptureEnabled: captureBody, redactionEnabled: true },
        }), { status: 200 });
      }
      return originalFetch(input, init);
    };
  });

  afterEach(async () => {
    await CostKey.shutdown();
    globalThis.fetch = originalFetch;
  });

  it("attaches to the current span and trace by default", async () => {
    CostKey.init({ dsn: "https://ck_test@costkey.dev/score-test", maxBatchSize: 200 });
    let spanId = "";
    let traceId = "";
    await CostKey.agent("support", async (span) => {
      spanId = span.id;
      traceId = span.traceId;
      await CostKey.score({ name: "faithfulness", value: 0.82, label: "pass", source: "judge", comment: "grounded" });
    });
    await CostKey.flush();

    const scores = events.filter((event) => event["eventType"] === "score");
    expect(scores).toHaveLength(1);
    const [score] = scores;
    expect(score).toMatchObject({ name: "faithfulness", value: 0.82, label: "pass", source: "judge", traceId, spanId });
    expect(String(score["id"])).toMatch(/^sc_/);
    expect(score["comment"]).toBeUndefined();
  });

  it("sends the comment only when body capture is on", async () => {
    captureBody = true;
    CostKey.init({ dsn: "https://ck_test@costkey.dev/score-test", maxBatchSize: 200 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await CostKey.score({ name: "tone", value: 3, traceId: "tr_1", comment: "c".repeat(1_500) });
    await CostKey.flush();
    const score = events.find((event) => event["eventType"] === "score");
    expect(String(score?.["comment"])).toHaveLength(1_000);
  });

  it("scores an explicit run without inheriting the current span", async () => {
    CostKey.init({ dsn: "https://ck_test@costkey.dev/score-test", maxBatchSize: 200 });
    await CostKey.agent("support", async () => {
      await CostKey.score({ name: "accuracy", value: 1, traceId: "tr_other", id: "sc_fixed", source: "human" });
    });
    await CostKey.flush();
    const score = events.find((event) => event["eventType"] === "score");
    expect(score).toMatchObject({ id: "sc_fixed", traceId: "tr_other", source: "human" });
    expect(score?.["spanId"]).toBeUndefined();
  });

  it("validates input and is a no-op before init", async () => {
    await expect(CostKey.score({ name: "x", value: 1, traceId: "tr" })).resolves.toBeUndefined();
    expect(() => CostKey.score({ name: "", value: 1, traceId: "tr" })).toThrow(TypeError);
    expect(() => CostKey.score({ name: "x".repeat(121), value: 1, traceId: "tr" })).toThrow(TypeError);
    expect(() => CostKey.score({ name: "x", value: Number.NaN, traceId: "tr" })).toThrow(TypeError);
    expect(() => CostKey.score({ name: "x", value: 1, traceId: "tr", label: "l".repeat(61) })).toThrow(TypeError);
    expect(() => CostKey.score({ name: "x", value: 1, traceId: "tr", source: "robot" as never })).toThrow(TypeError);
    expect(() => CostKey.score({ name: "x", value: 1 })).toThrow(/needs a run/);
  });

  it("passes scores through beforeSendEvent", async () => {
    CostKey.init({
      dsn: "https://ck_test@costkey.dev/score-test",
      maxBatchSize: 200,
      beforeSendEvent: (event) => event.eventType === "score" && event.name === "drop" ? null : event,
    });
    await CostKey.score({ name: "drop", value: 0, traceId: "tr_1" });
    await CostKey.score({ name: "keep", value: 1, traceId: "tr_1" });
    await CostKey.flush();
    expect(events.filter((event) => event["eventType"] === "score").map((event) => event["name"])).toEqual(["keep"]);
  });
});
