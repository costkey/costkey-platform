import { formatCost } from "../utils";

/** A rolling window ending now: `15m`, `3h`, `7d`, `2w`. */
export type RelativePeriod = `${number}${"m" | "h" | "d" | "w"}`;

/** Rolling windows, today and the month so far, since the latest deploy, or a custom range. */
export type ConsolePeriod = RelativePeriod | "today" | "mtd" | "deploy" | "custom";

const RELATIVE = /^([1-9]\d{0,3})([mhdw])$/;
const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 } as const;
const UNIT_WORDS = { m: ["minute", "minutes"], h: ["hour", "hours"], d: ["day", "days"], w: ["week", "weeks"] } as const;
const MAX_RELATIVE_MS = 400 * UNIT_MS.d;

/** A rolling period's length in ms, or null for any other period. */
export function relativeMs(period: string): number | null {
  const match = RELATIVE.exec(period);
  if (!match) return null;
  const ms = Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS];
  return ms <= MAX_RELATIVE_MS ? ms : null;
}

export function parsePeriod(value: string | null | undefined): ConsolePeriod {
  if (value === "today" || value === "deploy" || value === "custom") return value;
  return value && relativeMs(value) != null ? value as RelativePeriod : "mtd";
}

/** "last 15 minutes", "today", "since the last deploy". */
export function periodLabel(period: ConsolePeriod): string {
  if (period === "today") return "today";
  if (period === "mtd") return "month to date";
  if (period === "deploy") return "since the last deploy";
  if (period === "custom") return "custom range";
  const match = RELATIVE.exec(period);
  if (!match) return "month to date";
  const amount = Number(match[1]);
  const [one, many] = UNIT_WORDS[match[2] as keyof typeof UNIT_WORDS];
  return amount === 1 ? `last ${one}` : `last ${amount} ${many}`;
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

/** An instant as a datetime-local value ("2026-10-14T09:30") in the workspace time zone. */
export function isoToZonedInput(iso: string, timezone?: string | null): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone ?? undefined, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date);
    const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
  } catch {
    return date.toISOString().slice(0, 16);
  }
}

/** A datetime-local value read as wall time in the workspace time zone. */
export function zonedInputToIso(value: string, timezone?: string | null): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const wall = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]));
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone ?? "UTC", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(wall));
    const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
    const atZone = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
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
  // Prototype order ("20 Sep, 19:53") from the console prototype.
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
  // Prototype order ("20 Sep 2026, 14:32:08") from the console prototype.
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
  // Prototype order ("7 Sep 2026") from the console prototype.
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timeZone ?? displayTimeZone, day: "numeric", month: "short", year: "numeric" }).formatToParts(date);
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("day")} ${get("month")} ${get("year")}`;
}

export function periodDates(period: ConsolePeriod, timezone = Intl.DateTimeFormat().resolvedOptions().timeZone): { from: string; to: string } {
  const to = new Date();
  // 7 and 30 days start at local midnight, as they always have; other rolling windows end now.
  const rolling = period === "7d" || period === "30d" ? null : relativeMs(period);
  if (rolling != null) return { from: new Date(to.getTime() - rolling).toISOString(), to: to.toISOString() };
  // "deploy" and "custom" need more than a period; callers that support them resolve them first.
  if (period === "deploy") return { from: new Date(to.getTime() - UNIT_MS.d).toISOString(), to: to.toISOString() };
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

const PROVIDER_NAMES: Record<string, string> = {
  openai: "OpenAI", anthropic: "Anthropic", google: "Google", gemini: "Google", vertex: "Vertex AI", openrouter: "OpenRouter",
  azure: "Azure OpenAI", bedrock: "AWS Bedrock", mistral: "Mistral", cohere: "Cohere", groq: "Groq", deepseek: "DeepSeek",
  xai: "xAI", together: "Together AI", fireworks: "Fireworks", perplexity: "Perplexity", cerebras: "Cerebras", ai21: "AI21",
  upstage: "Upstage", sarvam: "Sarvam", typesafe: "Typesafe", deepinfra: "DeepInfra", nvidia: "NVIDIA", sambanova: "SambaNova",
  novita: "Novita", hyperbolic: "Hyperbolic", nebius: "Nebius", alibaba: "Alibaba Cloud", qwen: "Qwen", moonshot: "Moonshot",
  zai: "Z.ai", minimax: "MiniMax", huggingface: "Hugging Face", baseten: "Baseten", lambda: "Lambda", featherless: "Featherless",
  friendli: "Friendli", cloudflare: "Cloudflare", vercel: "Vercel", ollama: "Ollama", livekit: "LiveKit", deepgram: "Deepgram",
  elevenlabs: "ElevenLabs", assemblyai: "AssemblyAI", cartesia: "Cartesia", rumik: "Rumik", voyage: "Voyage AI", jina: "Jina AI",
  tavily: "Tavily", exa: "Exa", firecrawl: "Firecrawl",
};

/** "deepgram" -> "Deepgram" */
export function providerName(value: string): string {
  const id = value.trim().toLowerCase();
  return PROVIDER_NAMES[id] ?? (id ? id.charAt(0).toUpperCase() + id.slice(1) : "—");
}

/** "anthropic,openai" -> "Anthropic, OpenAI" */
export function formatProviders(value: string | null | undefined): string {
  const names = String(value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  if (names.length === 0) return "—";
  return names.map(providerName).join(", ");
}

/** Year, month (1-12) and day of a moment in the workspace time zone. */
export function zonedDateParts(date: Date, timeZone?: string | null): { year: number; month: number; day: number } {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: timeZone ?? undefined, year: "numeric", month: "numeric", day: "numeric" }).formatToParts(date);
    const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
    return { year: get("year"), month: get("month"), day: get("day") };
  } catch {
    return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
  }
}

/** Days in the workspace's current month. */
export function zonedDaysInMonth(date: Date, timeZone?: string | null): number {
  const { year, month } = zonedDateParts(date, timeZone);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
