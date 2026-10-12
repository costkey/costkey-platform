import { describe, expect, it } from "vitest";
import { runStatus } from "./RunFlow";

const retry = { workId: "w1", attempt: 1, retried: true, succeededBy: "t2", succeededOnAttempt: 2, willRetry: false, errorType: "RetryableWorkError" };

describe("run status", () => {
  it("calls a failed attempt that a later one completed Retried, with where it succeeded", () => {
    expect(runStatus({ execution_state: "failed", unpriced_count: 0, call_count: 1, retry }, 0.01)).toMatchObject({ tone: "warn", label: "Retried", succeededBy: "t2", succeededOnAttempt: 2 });
  });

  it("never promises a retry: a failed attempt with no later one is Failed", () => {
    expect(runStatus({ execution_state: "failed", unpriced_count: 0, call_count: 1, retry: { ...retry, retried: false, succeededBy: null, succeededOnAttempt: null, willRetry: true } }, 0.01).label).toBe("Failed");
    expect(runStatus({ execution_state: "failed", unpriced_count: 0, call_count: 1 }, 0.01).label).toBe("Failed");
  });

  it("never calls a run with no model calls price pending", () => {
    expect(runStatus({ execution_state: "completed", unpriced_count: 0, call_count: 0, accounting_state: "no_calls" }, null)).toMatchObject({ tone: "good", label: "Succeeded" });
  });

  it("explains price pending on hover", () => {
    expect(runStatus({ execution_state: "completed", unpriced_count: 2, call_count: 2 }, null)).toMatchObject({ label: "Price pending", title: "This model has no price yet. Set one in Settings, Prices." });
  });
});
