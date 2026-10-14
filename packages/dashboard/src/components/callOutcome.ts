import { formatDuration } from "../utils";

/**
 * How a call ended, in words. A failed or cancelled call is not a pricing
 * problem: it shows as failed with its reason, and costs nothing unless the
 * provider billed it.
 */

export interface CallOutcomeFields {
  lifecycle_state?: string | null;
  lifecycle_error_type?: string | null;
  status_code?: number | string | null;
  duration_ms?: number | string | null;
  cost_usd?: number | string | null;
}

export interface CallFailure {
  label: "Failed" | "Cancelled";
  /** The error in plain words: "Timed out after 10.1 s", "Rate limited (429)". */
  reason: string | null;
}

function httpReason(code: number): string {
  return code === 429 ? "Rate limited (429)" : `HTTP ${code}`;
}

/** The error in plain words, from the recorded error name and HTTP status. */
export function failureReason(errorType: string | null | undefined, statusCode?: number | null, durationMs?: number | null): string | null {
  const name = (errorType ?? "").trim();
  const http = name.match(/^http_(\d{3})$/i);
  if (http) return httpReason(Number(http[1]));
  if (/timeout|timedout|timed_out/i.test(name)) {
    return durationMs != null && durationMs > 0 ? `Timed out after ${formatDuration(durationMs)}` : "Timed out";
  }
  if (/^(connecterror|connectionerror|apiconnectionerror|connecttimeout|econnrefused|enotfound)$/i.test(name)) return "Couldn’t connect";
  if (/^(aborterror|cancellederror|cancelled|canceled)$/i.test(name)) return "Cancelled";
  if (name) return name;
  if (statusCode != null && statusCode >= 400) return httpReason(statusCode);
  return null;
}

/** Null for a call that succeeded. */
export function callFailure(event: CallOutcomeFields): CallFailure | null {
  const state = String(event.lifecycle_state ?? "").toLowerCase();
  const status = event.status_code == null || event.status_code === "" ? null : Number(event.status_code);
  const failedState = state === "failed" || state === "cancelled" || state === "canceled";
  const httpFailed = status != null && Number.isFinite(status) && status >= 400;
  if (!failedState && !httpFailed) return null;
  const duration = event.duration_ms == null ? null : Number(event.duration_ms);
  const reason = failureReason(event.lifecycle_error_type, httpFailed ? status : null, duration);
  return { label: state === "cancelled" || state === "canceled" ? "Cancelled" : "Failed", reason: reason === "Cancelled" && state.startsWith("cancel") ? null : reason };
}

/** A failed call with no price cost nothing we know of; only a successful call can be unpriced. */
export function isNoCharge(event: CallOutcomeFields): boolean {
  return event.cost_usd == null && callFailure(event) != null;
}

/** The cost cell for one call: its cost, "No charge" for a failed call without one, else "Unpriced". */
export function callCostText(event: CallOutcomeFields, money: (value: number) => string): string {
  if (event.cost_usd != null && event.cost_usd !== "" && Number.isFinite(Number(event.cost_usd))) return money(Number(event.cost_usd));
  return isNoCharge(event) ? "No charge" : "Unpriced";
}
