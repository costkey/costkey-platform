/**
 * Error classification. SDKs send the raw exception class or JS error name
 * (`AbortError`, `CancelledError`, `TimeoutError`...) and never decide what
 * it means; the server maps it to a cancelled or failed outcome.
 */

const CANCELLATION_NAMES = new Set([
  "aborterror",            // fetch / AbortController (JS)
  "cancellederror",        // asyncio.CancelledError, concurrent.futures.CancelledError
  "asyncio.cancellederror",
  "asyncio.exceptions.cancellederror",
  "concurrent.futures.cancellederror",
  "concurrent.futures._base.cancellederror",
  "cancelederror",         // axios, gRPC clients
  "canceledexception",
  "operationcanceledexception",
  "taskcanceledexception",
]);

const CANCELLATION_CODES = new Set(["abort_err", "err_canceled", "err_cancelled"]);

export type ErrorOutcome = "cancelled" | "failed";

/** Whether a raw error name (or code) means the caller cancelled the work. */
export function isCancellation(name: unknown, code?: unknown): boolean {
  const normalized = typeof name === "string" ? name.trim().toLowerCase() : "";
  if (normalized && CANCELLATION_NAMES.has(normalized)) return true;
  // A qualified class name (`anyio._backends.Cancelled...`) ends in its class.
  const leaf = normalized.split(".").pop() ?? "";
  if (leaf === "cancellederror" || leaf === "aborterror") return true;
  const codeValue = typeof code === "string" ? code.trim().toLowerCase() : "";
  return codeValue !== "" && CANCELLATION_CODES.has(codeValue);
}

/** Cancelled or failed for a raw error, with the error type kept only for failures. */
export function classifyError(name: unknown, code?: unknown): { outcome: ErrorOutcome; errorType: string | null } {
  if (isCancellation(name, code)) return { outcome: "cancelled", errorType: null };
  const raw = typeof name === "string" && name.trim() ? name.trim().slice(0, 200) : "Error";
  return { outcome: "failed", errorType: raw };
}
