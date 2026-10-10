import { formatCost } from "../utils";

export type ConsolePeriod = "24h" | "mtd" | "7d" | "30d" | "custom";

export function parsePeriod(value: string | null | undefined): ConsolePeriod {
  return value === "24h" || value === "7d" || value === "30d" || value === "custom" ? value : "mtd";
}

export function periodLabel(period: ConsolePeriod): string {
  return ({ "24h": "last 24 hours", mtd: "month to date", "7d": "last 7 days", "30d": "last 30 days", custom: "custom range" })[period];
}

/** Convert a date-input day in the workspace timezone to an exclusive UTC range boundary. */
export function dateInputToIso(value: string, timezone: string | undefined, end = false): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const wall = Date.UTC(year, month - 1, day + (end ? 1 : 0));
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone ?? "UTC", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(wall));
    const atZone = Date.UTC(Number(parts.find((part) => part.type === "year")?.value), Number(parts.find((part) => part.type === "month")?.value) - 1, Number(parts.find((part) => part.type === "day")?.value), Number(parts.find((part) => part.type === "hour")?.value), Number(parts.find((part) => part.type === "minute")?.value), Number(parts.find((part) => part.type === "second")?.value));
    return new Date(wall - (atZone - wall)).toISOString();
  } catch {
    return new Date(wall).toISOString();
  }
}

export function formatAmount(value: number | null | undefined): string {
  return formatCost(value == null ? null : Number(value));
}

export function formatCurrencyAmount(value: number | null | undefined, currency = "USD"): string {
  if (value == null || !Number.isFinite(Number(value))) return "Unavailable";
  if (currency.toUpperCase() === "INR") {
    return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(Number(value));
  }
  return formatAmount(value);
}

export interface ReportingFx {
  available?: boolean;
  rate?: number | null;
  source?: string | null;
  asOf?: string | null;
}

/** Format canonical USD observations in the saved workspace reporting basis. */
export function formatReportedAmount(value: number | null | undefined, currency = "USD", fx?: ReportingFx | null): string {
  if (value == null || !Number.isFinite(Number(value))) return "Unpriced";
  if (currency.toUpperCase() === "INR" && fx?.available && fx.rate != null && Number.isFinite(fx.rate) && fx.rate > 0) {
    return formatCurrencyAmount(Number(value) * fx.rate, "INR");
  }
  return formatAmount(value);
}

export function reportingCurrencyNote(currency = "USD", fx?: ReportingFx | null): string {
  if (currency.toUpperCase() === "INR") {
    if (fx?.available && fx.rate != null && fx.source && fx.asOf) return `INR reporting · ${fx.source} · ${new Date(fx.asOf).toLocaleDateString()}`;
    return "USD source · INR conversion unavailable";
  }
  return "USD reporting";
}

export type SourceAttributionStatus = "Explicit" | "Mapped" | "Inferred" | "Recorded location" | "Unavailable";

export function sourceAttributionStatus(input: { featureSource?: string | null; featureMappingId?: string | null; functionName?: string | null; fileName?: string | null } | null | undefined): SourceAttributionStatus {
  if (!input) return "Unavailable";
  const source = input.featureSource?.trim().toLowerCase();
  if (source === "explicit" || source === "application" || source === "supplied") return "Explicit";
  if (source === "mapping" || source === "mapped" || source === "reusable_mapping" || input.featureMappingId) return "Mapped";
  if (source === "inferred" || source === "source_inferred") return "Inferred";
  if (input.functionName || input.fileName) return "Recorded location";
  return "Unavailable";
}

let displayTimeZone: string | undefined;

/**
 * Timestamps render in the workspace timezone so they agree with the period
 * label in the filter bar ("UTC · USD"). Set once workspace settings load.
 */
export function setDisplayTimeZone(timeZone: string | null | undefined): void {
  try {
    displayTimeZone = timeZone ? new Intl.DateTimeFormat("en-US", { timeZone }).resolvedOptions().timeZone : undefined;
  } catch {
    displayTimeZone = undefined;
  }
}

/** Short label for the display timezone ("UTC", "IST"). */
export function displayTimeZoneLabel(): string | null {
  try {
    const parts = new Intl.DateTimeFormat("en-IN", { timeZone: displayTimeZone, timeZoneName: "short" }).formatToParts(new Date());
    return parts.find((part) => part.type === "timeZoneName")?.value ?? null;
  } catch {
    return null;
  }
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "Unknown time";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown time";
  // Prototype order ("20 Sep, 19:53") from design/console-prototype/app.js.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: displayTimeZone,
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("day")} ${get("month")}, ${get("hour")}:${get("minute")}`;
}

export function formatAbsoluteDate(value: string | null | undefined): string {
  if (!value) return "Unknown date";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown date";
  // Prototype order ("20 Sep 2026, 14:32:08") from design/console-prototype/app.js.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: displayTimeZone,
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("day")} ${get("month")} ${get("year")}, ${get("hour")}:${get("minute")}:${get("second")}`;
}

export function formatDayDate(value: string | null | undefined, timeZone?: string): string {
  if (!value) return "Unknown date";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown date";
  // Prototype order ("7 Sep 2026") from design/console-prototype/app.js.
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timeZone ?? displayTimeZone, day: "numeric", month: "short", year: "numeric" }).formatToParts(date);
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("day")} ${get("month")} ${get("year")}`;
}

export function periodDates(period: ConsolePeriod, timezone = Intl.DateTimeFormat().resolvedOptions().timeZone): { from: string; to: string } {
  const to = new Date();
  if (period === "24h") return { from: new Date(to.getTime() - 24 * 60 * 60 * 1000).toISOString(), to: to.toISOString() };
  const dateParts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(to);
  const year = Number(dateParts.find((part) => part.type === "year")?.value);
  const month = Number(dateParts.find((part) => part.type === "month")?.value);
  const day = Number(dateParts.find((part) => part.type === "day")?.value);
  const localDate = new Date(Date.UTC(year, month - 1, day));
  if (period === "mtd") localDate.setUTCDate(1);
  if (period === "7d") localDate.setUTCDate(localDate.getUTCDate() - 7);
  if (period === "30d" || period === "custom") localDate.setUTCDate(localDate.getUTCDate() - 30);
  const offsetParts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(localDate);
  const wallTime = Date.UTC(Number(offsetParts.find((part) => part.type === "year")?.value), Number(offsetParts.find((part) => part.type === "month")?.value) - 1, Number(offsetParts.find((part) => part.type === "day")?.value), Number(offsetParts.find((part) => part.type === "hour")?.value), Number(offsetParts.find((part) => part.type === "minute")?.value), Number(offsetParts.find((part) => part.type === "second")?.value));
  const timezoneOffset = wallTime - localDate.getTime();
  return { from: new Date(localDate.getTime() - timezoneOffset).toISOString(), to: to.toISOString() };
}

export function formatPercent(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(Number(value))) return "—";
  return `${Number(value).toFixed(1)}%`;
}

const PROVIDER_NAMES: Record<string, string> = { openai: "OpenAI", anthropic: "Anthropic", google: "Google", gemini: "Google", openrouter: "OpenRouter", azure: "Azure OpenAI", bedrock: "AWS Bedrock", mistral: "Mistral", cohere: "Cohere", groq: "Groq", deepseek: "DeepSeek", xai: "xAI", livekit: "LiveKit", deepgram: "Deepgram", elevenlabs: "ElevenLabs" };

/** "anthropic,openai" -> "Anthropic, OpenAI" */
export function formatProviders(value: string | null | undefined): string {
  const names = String(value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  if (names.length === 0) return "—";
  return names.map((name) => PROVIDER_NAMES[name.toLowerCase()] ?? name.charAt(0).toUpperCase() + name.slice(1)).join(", ");
}
