import type { CostKeyEvent } from "@costkey/shared";
import { computeCost, inferImageOutputTokens } from "./pricing.js";

function record(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return {}; }
  }
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

export function validCost(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Available even for old SDKs: read billing before body truncation discards it. */
export function openRouterReportedCost(provider: string, responseBody: unknown): number | null {
  if (provider !== "openrouter") return null;
  const value = record(record(responseBody).usage).cost;
  return validCost(value) ? value : null;
}

function openRouterImageOutputTokens(provider: string, responseBody: unknown): number | null {
  if (provider !== "openrouter") return null;
  const usage = record(record(responseBody).usage);
  const details = record(usage.completion_tokens_details ?? usage.output_tokens_details);
  for (const value of [
    details.image_tokens,
    details.image_output_tokens,
    usage.image_tokens,
    usage.image_output_tokens,
    usage.native_tokens_completion_images,
  ]) {
    if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  }
  return null;
}

export function resolveEventCost(event: CostKeyEvent): number | null {
  const reported = openRouterReportedCost(event.provider, event.responseBody);
  if (reported != null) return reported;
  if (event.provider === "openrouter" && validCost(event.usage?.costUsd)) return event.usage.costUsd;
  const imageOutputTokens = event.usage?.imageOutputTokens
    ?? openRouterImageOutputTokens(event.provider, event.responseBody)
    ?? inferImageOutputTokens(event.model, event.usage?.outputTokens ?? null);
  const estimate = computeCost(
    event.model, event.usage?.inputTokens ?? null, event.usage?.outputTokens ?? null,
    event.usage?.cacheReadTokens, event.usage?.cacheCreationTokens, event.provider,
    event.timestamp, imageOutputTokens,
  );
  return estimate ?? (validCost(event.costUsd) ? event.costUsd : null);
}
