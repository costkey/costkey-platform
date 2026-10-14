import { describe, expect, it } from "vitest";
import { callCostText, callFailure, failureReason } from "./callOutcome";

const money = (value: number) => `$${value.toFixed(4)}`;

describe("call failures", () => {
  it("says a timed-out call timed out, with how long it waited", () => {
    expect(callFailure({ lifecycle_state: "failed", lifecycle_error_type: "ReadTimeout", duration_ms: 10_120 })).toEqual({ label: "Failed", reason: "Timed out after 10.1 s" });
    expect(failureReason("TimeoutError", null, 2_000)).toBe("Timed out after 2.0 s");
  });

  it("maps connection errors and HTTP statuses to plain words", () => {
    expect(failureReason("ConnectError")).toBe("Couldn’t connect");
    expect(failureReason("http_429")).toBe("Rate limited (429)");
    expect(failureReason("http_503")).toBe("HTTP 503");
    expect(failureReason("SomethingElse")).toBe("SomethingElse");
  });

  it("treats an HTTP error status as a failure even without a lifecycle state", () => {
    expect(callFailure({ status_code: 429 })).toEqual({ label: "Failed", reason: "Rate limited (429)" });
    expect(callFailure({ status_code: 200, lifecycle_state: "completed" })).toBeNull();
  });

  it("labels a cancelled call as cancelled", () => {
    expect(callFailure({ lifecycle_state: "cancelled", lifecycle_error_type: "AbortError" })).toEqual({ label: "Cancelled", reason: null });
  });
});

describe("call cost text", () => {
  it("shows the cost of a failed call the provider billed", () => {
    expect(callCostText({ lifecycle_state: "failed", lifecycle_error_type: "ReadTimeout", cost_usd: 0.012 }, money)).toBe("$0.0120");
  });

  it("shows No charge for a failed call without a price", () => {
    expect(callCostText({ lifecycle_state: "failed", lifecycle_error_type: "ConnectError", cost_usd: null }, money)).toBe("No charge");
  });

  it("keeps Unpriced for a successful call that lacks a price", () => {
    expect(callCostText({ status_code: 200, cost_usd: null }, money)).toBe("Unpriced");
  });
});
