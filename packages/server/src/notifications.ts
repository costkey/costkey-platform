import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { Request, Response, Router } from "express";
import { Router as createRouter } from "express";
import type pg from "pg";
import { Resend } from "resend";
import { chargesCte } from "./charge-cohort.js";
import { requireAuth } from "./auth.js";
import { withMigrationLock } from "./db.js";
import {
  canAccessProject,
  normalizeRole,
  roleCanManageWorkspace,
} from "./permissions.js";
import { appPath, basePath, publicOrigin, publicUrl } from "./public-url.js";

export type NotificationEventType =
  | "weekly_summary"
  | "daily_summary"
  | "finding"
  | "policy_warning"
  | "enforcement"
  | "execution_receipt";

export interface NotificationPayload {
  eventType: NotificationEventType | string;
  orgId: string;
  projectId?: string | null;
  scope?: Record<string, unknown>;
  title: string;
  message: string;
  evidence?: Record<string, unknown>;
  link?: string;
  occurredAt?: string;
  /** Internal recipient routing; never serialized into a channel payload. */
  recipientUserId?: string | null;
  /** Exact preference scope for subscriptions. A null value is the workspace scope. */
  preferenceProjectId?: string | null;
  /** Stable outbox identity for callers that already own a dedupe key. */
  dedupeKey?: string;
}

export interface WebhookDeliveryResult {
  status: "sent" | "failed" | "suppressed";
  statusCode?: number;
  error?: string;
  deliveryId: string;
}

const localSink: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
const MAX_DELIVERY_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = [60_000, 5 * 60_000] as const;
const DEFAULT_TIMEZONE = "UTC";
const DEFAULT_WEEKDAY = 1;
const DEFAULT_HOUR = 9;
const DEFAULT_THRESHOLDS = [0.8, 1];

function externalDeliveryAllowed(): boolean {
  return process.env["NODE_ENV"] !== "test" || process.env["COSTKEY_NOTIFICATION_TEST_DELIVERY"] === "1";
}

type Row = Record<string, unknown>;
type Queryable = Pick<pg.Pool, "query">;
type DestinationRow = Row & {
  id: string;
  org_id: string;
  project_id: string | null;
  owner_user_id: string | null;
  kind: "email" | "webhook" | "slack";
  address: string;
  secret_ciphertext?: string | null;
  event_types?: unknown;
  enabled?: boolean;
};
type PreferenceRow = Row & {
  org_id: string;
  user_id: string;
  project_id: string | null;
  weekly_summary_enabled?: boolean;
  weekly_summary_hour?: number;
  weekly_summary_weekday?: number;
  daily_summary_enabled?: boolean;
  daily_summary_hour?: number;
  timezone?: string;
  findings_enabled?: boolean;
  policy_warning_thresholds?: number[];
  enforcement_enabled?: boolean;
  /** NULL inherits enforcement_enabled, which used to gate budget warnings too. */
  budget_alerts_enabled?: boolean | null;
  execution_receipts_enabled?: boolean;
};

function randomId(prefix = "ntf"): string {
  return `${prefix}_${randomBytes(12).toString("hex")}`;
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return jsonObject(value);
  try {
    return jsonObject(JSON.parse(value));
  } catch {
    return {};
  }
}

function stableJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  const object = value as Record<string, unknown>;
  return "{" + Object.keys(object).sort().map((key) => JSON.stringify(key) + ":" + stableJson(object[key])).join(",") + "}";
}

function findingEvidenceFingerprint(
  family: unknown,
  scope: unknown,
  baseline: unknown,
  evidence: unknown,
): string {
  const stableEvidence = parseJsonObject(evidence);
  delete stableEvidence.chronology;
  return createHash("sha256").update(stableJson({
    family: String(family ?? ""),
    scope: parseJsonObject(scope),
    baseline: parseJsonObject(baseline),
    evidence: stableEvidence,
  })).digest("hex").slice(0, 32);
}

function primitive(value: unknown): string | number | boolean | null | undefined {
  if (value === null || value === undefined) return value;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return undefined;
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/[-\s]/g, "_").toLowerCase();
  return /^(prompt|prompts|completion|response|responses|messages|contents|input|output|system|developer|raw|raw_body|request_body|response_body|source|source_map|source_maps|call_site_raw|call_site_frames|callsite|secret|password|credential|authorization|cookie|dsn|auth_key|authkey|token)$/.test(normalized)
    || /(^|_)(password|secret|credential|authorization|cookie|dsn)(_|$)/.test(normalized);
}

const SAFE_SCOPE_KEYS = new Set([
  "periodStart", "periodEnd", "projectCount", "traceCount", "dimension", "value",
  "feature", "function", "customer", "model", "provider", "environment",
  "traceId", "executionId", "groupId", "policyId", "findingId", "windowKey",
  "threshold", "reason", "status", "scopeType", "scopeId", "timezone",
]);

const SAFE_EVIDENCE_KEYS = new Set([
  "cost", "knownCost", "previousCost", "change", "changePct", "calls", "observations",
  "pricedCalls", "pricedObservations", "unpricedCalls", "unpricedObservations",
  "coverage", "previousCoverage", "previousCalls", "previousObservations",
  "previousPricedCalls", "previousPricedObservations", "previousUnpricedCalls",
  "previousUnpricedObservations", "threshold", "allowance", "observedUsage",
  "policyId", "traceId", "executionId", "groupId", "status", "basis", "currency",
  "currentValue", "alertType", "project", "triggeredAt",
  "projectCount", "traceCount", "previousTraceCount", "findingsCount",
  "policyWarnings", "policyRefusals", "executionCount", "completedExecutions",
  "family", "traceCost", "currentPricingCoverage", "currentAttributionCoverage",
  "pricingDrop", "attributionDrop",
  "contributors", "findings", "policyActivity", "phases", "activityChange",
  "sampleSufficient", "pricedOnly", "reason", "relativeDifference", "absoluteDifference",
  "currentUnitCost", "previousUnitCost", "currentCost", "previousCost",
  "currentCount", "previousCount", "highestRatio", "unpricedCount", "link",
  "models", "budgets",
]);

const SAFE_NESTED_KEYS = new Set([
  "key", "label", "name", "family", "state", "cost", "knownCost", "previousCost",
  "change", "changePct", "observations", "calls", "pricedCalls", "unpricedCalls",
  "coverage", "traceCount", "findingId", "policyId", "threshold", "allowance",
  "observedUsage", "status", "basis", "currency", "relativeDifference",
  "absoluteDifference", "currentUnitCost", "previousUnitCost", "currentCost",
  "previousCount", "currentCount", "activityChange", "link", "windowKey",
  "reason", "projectId", "periodStart", "periodEnd",
  "currentValue", "alertType", "project", "triggeredAt",
  "family", "traceCost", "currentPricingCoverage", "currentAttributionCoverage",
  "pricingDrop", "attributionDrop",
  "ratio", "unit",
]);

function sanitizeNested(value: unknown, depth = 0, key?: string): unknown {
  if (depth > 4) return undefined;
  const leaf = primitive(value);
  if (leaf !== undefined) {
    if (typeof leaf === "string") {
      if (key === "link") return safeDeepLink(leaf);
      return leaf.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 500);
    }
    if (typeof leaf === "number" && !Number.isFinite(leaf)) return null;
    return leaf;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => sanitizeNested(item, depth + 1)).filter((item) => item !== undefined);
  }
  if (!value || typeof value !== "object") return undefined;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isSensitiveKey(key) || !SAFE_NESTED_KEYS.has(key)) continue;
    const clean = sanitizeNested(entry, depth + 1, key);
    if (clean !== undefined) result[key] = clean;
  }
  return result;
}

function sanitizeScope(value: unknown): Record<string, unknown> {
  const source = jsonObject(value);
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(source)) {
    if (isSensitiveKey(key) || !SAFE_SCOPE_KEYS.has(key)) continue;
    const clean = sanitizeNested(entry);
    if (clean !== undefined) result[key] = clean;
  }
  return result;
}

function sanitizeEvidence(value: unknown): Record<string, unknown> {
  const source = jsonObject(value);
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(source)) {
    if (isSensitiveKey(key) || !SAFE_EVIDENCE_KEYS.has(key)) continue;
    const clean = sanitizeNested(entry);
    if (clean !== undefined) result[key] = clean;
  }
  return result;
}

function cleanText(value: unknown, max: number): string {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\b(?:bearer|basic)\s+[a-z0-9._~+/=-]+/gi, "[redacted]")
    .replace(/\b(?:sk|rk|re|key)_[a-z0-9_-]{12,}\b/gi, "[redacted]")
    .slice(0, max);
}

function publicAppOrigin(): URL {
  const configured = publicOrigin();
  try {
    const url = new URL(configured);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("invalid public URL");
    url.hash = "";
    url.search = "";
    return url;
  } catch {
    return publicUrl();
  }
}

function safeDeepLink(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const base = publicAppOrigin();
    // A root-relative link ("/traces") is an app path, so it goes under the
    // base path unless it is already there.
    const prefix = basePath();
    const target = prefix && value.startsWith("/") && !value.startsWith("//")
      && value !== prefix && !value.startsWith(`${prefix}/`) && !value.startsWith(`${prefix}?`)
      ? `${prefix}${value}`
      : value;
    const link = new URL(target, base);
    if (link.origin !== base.origin || link.username || link.password || link.protocol !== base.protocol) return undefined;
    for (const key of link.searchParams.keys()) {
      if (/(^|_)(token|secret|password|credential|authorization|auth|code|key)(_|$)/i.test(key)) return undefined;
    }
    link.hash = "";
    return link.toString().slice(0, 1_000);
  } catch {
    return undefined;
  }
}

function appLink(pathname: string, params: Record<string, string | null | undefined> = {}): string {
  const url = new URL(appPath(pathname), publicAppOrigin());
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
}

function sanitizedPayload(payload: NotificationPayload): Record<string, unknown> {
  const occurredAt = payload.occurredAt && !Number.isNaN(new Date(payload.occurredAt).getTime())
    ? new Date(payload.occurredAt).toISOString()
    : new Date().toISOString();
  return {
    eventType: cleanText(payload.eventType, 80),
    orgId: cleanText(payload.orgId, 255),
    projectId: payload.projectId == null ? null : cleanText(payload.projectId, 255),
    scope: sanitizeScope(payload.scope),
    title: cleanText(payload.title, 240),
    message: cleanText(payload.message, 2_000),
    evidence: sanitizeEvidence(payload.evidence),
    link: safeDeepLink(payload.link),
    occurredAt,
  };
}

function encryptionKey(): Buffer | null {
  const configured = process.env["COSTKEY_NOTIFICATION_ENCRYPTION_KEY"]
    ?? (process.env["NODE_ENV"] === "production" ? undefined : process.env["COSTKEY_JWT_SECRET"] ?? "costkey-dev-notification-key");
  return configured && configured.trim() ? createHash("sha256").update(configured).digest() : null;
}

export function encryptSecret(secret: string): string | null {
  if (typeof secret !== "string" || secret.length === 0 || secret.length > 4_096) return null;
  const key = encryptionKey();
  if (!key) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return `v1.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${ciphertext.toString("base64url")}`;
}

export function decryptSecret(value: string | null | undefined): string | null {
  if (!value) return null;
  const key = encryptionKey();
  if (!key) return null;
  const parts = value.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return null;
  try {
    const iv = Buffer.from(parts[1], "base64url");
    const tag = Buffer.from(parts[2], "base64url");
    const ciphertext = Buffer.from(parts[3], "base64url");
    if (iv.length !== 12 || tag.length !== 16) return null;
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

function parseIPv4(value: string): number[] | null {
  const pieces = value.split(".");
  if (pieces.length !== 4 || pieces.some((piece) => !/^\d{1,3}$/.test(piece))) return null;
  const octets = pieces.map(Number);
  return octets.every((octet) => octet >= 0 && octet <= 255) ? octets : null;
}

function ipv4Number(value: string): number | null {
  const octets = parseIPv4(value);
  if (!octets) return null;
  return (((octets[0] * 256 + octets[1]) * 256 + octets[2]) * 256 + octets[3]) >>> 0;
}

function ipv4IsPrivate(value: string): boolean {
  const number = ipv4Number(value);
  if (number == null) return true;
  const first = number >>> 24;
  const second = (number >>> 16) & 255;
  return first === 0 || first === 10 || first === 127 || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 192 && second === 0)
    || (first === 192 && second === 2)
    || (first === 198 && (second === 18 || second === 19 || second === 51))
    || (first === 203 && second === 0)
    || first >= 224;
}

function ipv6Number(value: string): bigint | null {
  let input = value.toLowerCase().split("%", 1)[0];
  if (input.includes(".")) {
    const lastColon = input.lastIndexOf(":");
    const mapped = lastColon >= 0 ? ipv4Number(input.slice(lastColon + 1)) : null;
    if (mapped == null) return null;
    input = `${input.slice(0, lastColon + 1)}${((mapped >>> 16) & 0xffff).toString(16)}:${(mapped & 0xffff).toString(16)}`;
  }
  const halves = input.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if ([...left, ...right].some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  const missing = 8 - left.length - right.length;
  if (halves.length === 1 && missing !== 0) return null;
  if (missing < 0) return null;
  const parts = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (parts.length !== 8) return null;
  return parts.reduce((result, part) => (result << 16n) + BigInt(parseInt(part, 16)), 0n);
}

function ipv6IsPrivate(value: string): boolean {
  const number = ipv6Number(value);
  if (number == null) return true;
  const first = Number(number >> 120n);
  const mappedV4 = Number(number & 0xffffffffn);
  const mappedPrefix = Number(number >> 32n) & 0xffffffff;
  return number === 0n || number === 1n || first >= 224
    || first === 0xfc || first === 0xfd
    || (first === 0xfe && Number(number >> 118n) === 0x3fa)
    || (mappedPrefix === 0xffff && ipv4IsPrivate([
      mappedV4 >>> 24,
      (mappedV4 >>> 16) & 255,
      (mappedV4 >>> 8) & 255,
      mappedV4 & 255,
    ].join(".")));
}

function isPrivateAddress(address: string): boolean {
  const kind = isIP(address);
  return kind === 4 ? ipv4IsPrivate(address) : kind === 6 ? ipv6IsPrivate(address) : true;
}

function isLoopbackAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) {
    const value = ipv4Number(address);
    return value != null && (value >>> 24) === 127;
  }
  return kind === 6 && ipv6Number(address) === 1n;
}

function isSafeWebhookSyntax(value: string): boolean {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) return false;
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
    const allowLoopbackTest = process.env["NODE_ENV"] === "test" && process.env["COSTKEY_NOTIFICATION_TEST_ALLOW_LOOPBACK"] === "1";
    const loopbackTestTarget = allowLoopbackTest && (host === "localhost" || isLoopbackAddress(host));
    if (!host || (!loopbackTestTarget && (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")))) return false;
    if (isIP(host) === 4 && ipv4IsPrivate(host) && !loopbackTestTarget) return false;
    if (isIP(host) === 6 && ipv6IsPrivate(host) && !loopbackTestTarget) return false;
    return true;
  } catch {
    return false;
  }
}

/** Synchronous syntax guard retained for router callers and tests. */
export function isSafeWebhookUrl(value: string): boolean {
  return isSafeWebhookSyntax(value);
}

async function safeWebhookAddresses(value: string): Promise<string[]> {
  if (!isSafeWebhookSyntax(value)) return [];
  const url = new URL(value);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const allowLoopbackTest = process.env["NODE_ENV"] === "test" && process.env["COSTKEY_NOTIFICATION_TEST_ALLOW_LOOPBACK"] === "1";
  if (isIP(host)) return isPrivateAddress(host) && !(allowLoopbackTest && isLoopbackAddress(host)) ? [] : [host];
  try {
    const records = await dnsLookup(host, { all: true, verbatim: true });
    if (records.length === 0 || records.some((record) => isPrivateAddress(record.address) && !(allowLoopbackTest && isLoopbackAddress(record.address)))) return [];
    return records.map((record) => record.address);
  } catch {
    return [];
  }
}

async function resolvesSafeWebhookTarget(value: string): Promise<boolean> {
  return (await safeWebhookAddresses(value)).length > 0;
}

function postWebhookToAddress(
  value: string,
  address: string,
  headers: Record<string, string>,
  body: string,
): Promise<{ statusCode: number }> {
  return new Promise((resolve, reject) => {
    const url = new URL(value);
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)({
      hostname: address,
      port: url.port || undefined,
      path: url.pathname + url.search,
      method: "POST",
      headers: { ...headers, Host: url.host },
      servername: url.hostname.replace(/^\[|\]$/g, ""),
      timeout: 10_000,
      rejectUnauthorized: true,
    }, (response) => {
      response.resume();
      response.once("end", () => resolve({ statusCode: response.statusCode ?? 0 }));
    });
    request.once("timeout", () => request.destroy(new Error("Webhook request timed out")));
    request.once("error", reject);
    request.end(body);
  });
}

function signatureFor(secret: string, timestamp: string, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

export function verifyWebhookSignature(
  secret: string,
  timestamp: string,
  body: string,
  signature: string,
  maxAgeSeconds = 300,
): boolean {
  if (!secret || !Number.isFinite(maxAgeSeconds) || maxAgeSeconds < 0) return false;
  const timestampNumber = Number(timestamp);
  if (!Number.isFinite(timestampNumber) || Math.abs(Date.now() / 1000 - timestampNumber) > maxAgeSeconds) return false;
  const supplied = signature.replace(/^sha256=/i, "");
  if (!/^[0-9a-f]{64}$/i.test(supplied)) return false;
  const expectedBuffer = Buffer.from(signatureFor(secret, timestamp, body), "hex");
  const suppliedBuffer = Buffer.from(supplied, "hex");
  return suppliedBuffer.length === expectedBuffer.length && timingSafeEqual(suppliedBuffer, expectedBuffer);
}

/** Send one generic signed webhook, using the local sink when explicitly enabled. */
export async function dispatchWebhook(
  url: string,
  secret: string | null,
  payload: Record<string, unknown>,
  deliveryId = randomId("delivery"),
): Promise<WebhookDeliveryResult> {
  if (!isSafeWebhookSyntax(url)) return { status: "failed", error: "Webhook URL is invalid or targets a private host", deliveryId };
  if (!secret) return { status: "suppressed", error: "Webhook secret is not configured", deliveryId };

  const directEvidence = { ...jsonObject(payload.evidence) };
  for (const key of ["threshold", "currentValue", "alertType", "project", "triggeredAt"]) {
    const value = primitive(payload[key]);
    if (value !== undefined) directEvidence[key] = value;
  }
  const safePayload = sanitizedPayload({
    eventType: typeof payload.eventType === "string" ? payload.eventType : "notification",
    orgId: typeof payload.orgId === "string" ? payload.orgId : "",
    projectId: typeof payload.projectId === "string" ? payload.projectId : null,
    scope: jsonObject(payload.scope),
    title: typeof payload.title === "string" ? payload.title : "CostKey notification",
    message: typeof payload.message === "string" ? payload.message : "",
    evidence: directEvidence,
    link: typeof payload.link === "string" ? payload.link : undefined,
    occurredAt: typeof payload.occurredAt === "string" ? payload.occurredAt : undefined,
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify(safePayload);
  const headers = {
    "Content-Type": "application/json",
    "User-Agent": "CostKey-Notifications/1",
    "X-CostKey-Event": String(safePayload.eventType ?? "notification"),
    "X-CostKey-Delivery": deliveryId,
    "X-CostKey-Timestamp": timestamp,
    "X-CostKey-Signature": "sha256=" + signatureFor(secret, timestamp, body),
  };
  return postJsonSafely(url, headers, body, deliveryId, "Webhook", url);
}

/**
 * The one outbound HTTP path for channels: memory sink, test-mode
 * suppression, DNS resolution that refuses private targets, then a pinned
 * address request with TLS verification.
 */
async function postJsonSafely(
  url: string,
  headers: Record<string, string>,
  body: string,
  deliveryId: string,
  label: "Webhook" | "Slack",
  sinkUrl: string,
): Promise<WebhookDeliveryResult> {
  if (process.env["COSTKEY_NOTIFICATION_SINK"] === "memory") {
    localDelivery(sinkUrl, headers, body);
    return { status: "sent", statusCode: 202, deliveryId };
  }
  if (!externalDeliveryAllowed()) {
    return { status: "suppressed", error: label + " delivery is disabled in test mode", deliveryId };
  }
  const addresses = await safeWebhookAddresses(url);
  if (addresses.length === 0) {
    return { status: "failed", error: label + " URL DNS target is invalid or private", deliveryId };
  }

  try {
    const response = await postWebhookToAddress(url, addresses[0], headers, body);
    if (response.statusCode < 200 || response.statusCode >= 300) {
      return { status: "failed", statusCode: response.statusCode, error: label + " returned HTTP " + response.statusCode, deliveryId };
    }
    return { status: "sent", statusCode: response.statusCode, deliveryId };
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error.message.slice(0, 300) : label + " request failed", deliveryId };
  }
}

/** Post one Block Kit message to a Slack incoming webhook. */
export async function dispatchSlack(
  webhookUrl: string | null,
  payload: Record<string, unknown>,
  deliveryId = randomId("delivery"),
): Promise<WebhookDeliveryResult> {
  if (!webhookUrl) return { status: "suppressed", error: "Slack webhook is not configured", deliveryId };
  if (!isSlackWebhookUrl(webhookUrl) || !isSafeWebhookSyntax(webhookUrl)) {
    return { status: "failed", error: "Slack webhook URL is invalid", deliveryId };
  }
  const body = JSON.stringify(slackMessage(payload));
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "User-Agent": "CostKey-Notifications/1",
    "X-CostKey-Event": cleanText(payload.eventType ?? "notification", 80),
    "X-CostKey-Delivery": deliveryId,
  };
  return postJsonSafely(webhookUrl, headers, body, deliveryId, "Slack", "slack://" + maskSlackWebhookUrl(webhookUrl));
}

export function getLocalNotificationSink(): ReadonlyArray<{ url: string; headers: Record<string, string>; body: string }> {
  return [...localSink];
}

export function clearLocalNotificationSink(): void {
  localSink.splice(0);
}

function localDelivery(url: string, headers: Record<string, string>, body: string): void {
  localSink.push({ url, headers, body });
}

function validEmailAddress(value: string): boolean {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

const schemaReady = new WeakMap<object, Promise<void>>();

/**
 * Additive notification columns for Slack destinations, the daily summary and
 * a budget-alert switch that is independent of refusals. Every statement is
 * idempotent; the platform migration remains the owner of the base tables.
 */
export function ensureNotificationSchema(pool: pg.Pool): Promise<void> {
  const existing = schemaReady.get(pool);
  if (existing) return existing;
  const ready = withMigrationLock(pool, async (client) => {
    await client.query(`
      ALTER TABLE notification_preferences ADD COLUMN IF NOT EXISTS daily_summary_enabled BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE notification_preferences ADD COLUMN IF NOT EXISTS daily_summary_hour INTEGER NOT NULL DEFAULT 9;
      ALTER TABLE notification_preferences ADD COLUMN IF NOT EXISTS budget_alerts_enabled BOOLEAN;
      DO $notification_daily_checks$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass(format('%I.%I', current_schema(), 'notification_preferences')) AND conname = 'notification_preferences_daily_hour_check') THEN
          ALTER TABLE notification_preferences ADD CONSTRAINT notification_preferences_daily_hour_check CHECK (daily_summary_hour BETWEEN 0 AND 23);
        END IF;
        IF EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = to_regclass(format('%I.%I', current_schema(), 'notification_destinations'))
            AND conname = 'notification_destinations_kind_check'
            AND pg_get_constraintdef(oid) NOT LIKE '%slack%'
        ) THEN
          ALTER TABLE notification_destinations DROP CONSTRAINT notification_destinations_kind_check;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass(format('%I.%I', current_schema(), 'notification_destinations')) AND conname = 'notification_destinations_kind_check') THEN
          ALTER TABLE notification_destinations ADD CONSTRAINT notification_destinations_kind_check CHECK (kind IN ('email', 'webhook', 'slack'));
        END IF;
      END $notification_daily_checks$;
      CREATE INDEX IF NOT EXISTS idx_notification_preferences_daily_due
        ON notification_preferences(daily_summary_enabled) WHERE daily_summary_enabled = TRUE;
    `);
  });
  schemaReady.set(pool, ready);
  ready.catch(() => schemaReady.delete(pool));
  return ready;
}

const SLACK_WEBHOOK_PATTERN = /^https:\/\/hooks\.slack\.com\/services\/(T[A-Z0-9]{2,32})\/(B[A-Z0-9]{2,32})\/([A-Za-z0-9]{16,64})$/;

/** Only Slack incoming-webhook URLs on hooks.slack.com are accepted. */
export function isSlackWebhookUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 300 || !SLACK_WEBHOOK_PATTERN.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "hooks.slack.com" && !url.port
      && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

/** Display form of a Slack webhook. The token is a credential and is never shown. */
export function maskSlackWebhookUrl(value: string): string {
  const match = SLACK_WEBHOOK_PATTERN.exec(value);
  if (!match) return "hooks.slack.com/services/••••";
  return "hooks.slack.com/services/" + match[1] + "/" + match[2] + "/••••" + match[3].slice(-4);
}

function slackEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatUsd(value: unknown): string | null {
  const amount = finiteNumber(value);
  if (amount == null || value === null || value === undefined) return null;
  const absolute = Math.abs(amount);
  return (amount < 0 ? "-$" : "$") + (absolute > 0 && absolute < 0.01 ? absolute.toFixed(4) : absolute.toFixed(2));
}

function formatPct(value: unknown, signed = true): string | null {
  const ratio = finiteNumber(value);
  if (ratio == null || value === null || value === undefined) return null;
  return (signed && ratio > 0 ? "+" : "") + (ratio * 100).toFixed(Math.abs(ratio) < 0.1 ? 1 : 0) + "%";
}

function slackFields(payload: Record<string, unknown>): Array<[string, string]> {
  const evidence = jsonObject(payload.evidence);
  const scope = jsonObject(payload.scope);
  const fields: Array<[string, string | null]> = [];
  switch (payload.eventType) {
    case "daily_summary":
      fields.push(["Yesterday", formatUsd(evidence.cost) ?? "Unpriced"]);
      fields.push(["Change", formatPct(evidence.changePct) ?? formatUsd(evidence.change)]);
      fields.push(Number(evidence.unpricedCalls) > 0
        ? ["Unpriced calls", String(Number(evidence.unpricedCalls))]
        : ["Calls", evidence.calls == null ? null : String(Number(evidence.calls))]);
      break;
    case "weekly_summary":
      fields.push(["Spend", formatUsd(evidence.cost)]);
      fields.push(["Change", formatPct(evidence.changePct) ?? formatUsd(evidence.change)]);
      fields.push(["Calls", evidence.calls == null ? null : String(Number(evidence.calls))]);
      break;
    case "policy_warning":
      fields.push(["Budget", typeof evidence.policyId === "string" ? evidence.policyId : null]);
      fields.push(["Threshold", formatPct(evidence.threshold ?? scope.threshold, false)]);
      fields.push(["Used", evidence.observedUsage == null ? null : String(evidence.observedUsage) + (evidence.allowance == null ? "" : " of " + String(evidence.allowance))]);
      break;
    case "enforcement":
      fields.push(["Budget", typeof evidence.policyId === "string" ? evidence.policyId : null]);
      fields.push(["Reason", typeof evidence.reason === "string" ? evidence.reason.replace(/_/g, " ") : null]);
      break;
    case "finding":
      fields.push(["Cost", formatUsd(evidence.cost)]);
      fields.push(["Change", formatPct(evidence.changePct) ?? formatUsd(evidence.change)]);
      fields.push(["Type", typeof evidence.family === "string" ? evidence.family.replace(/_/g, " ") : null]);
      break;
    case "execution_receipt":
      fields.push(["Batches", evidence.executionCount == null ? null : String(Number(evidence.executionCount))]);
      fields.push(["Spend", formatUsd(evidence.cost)]);
      break;
  }
  const present = fields.filter((field): field is [string, string] => typeof field[1] === "string" && field[1].length > 0).slice(0, 3);
  return present.length > 0 ? present : [["Channel", "Slack"]];
}

/** Slack Block Kit message: header, a short line, up to three fields and a deep link. */
export function slackMessage(payload: Record<string, unknown>): Record<string, unknown> {
  const title = cleanText(payload.title ?? "CostKey notification", 150) || "CostKey notification";
  const message = cleanText(payload.message, 600);
  const link = safeDeepLink(payload.link) ?? appLink("/alerting");
  const fields = slackFields(payload);
  const blocks: Array<Record<string, unknown>> = [
    { type: "header", text: { type: "plain_text", text: title, emoji: false } },
  ];
  const section: Record<string, unknown> = { type: "section" };
  if (message) section.text = { type: "mrkdwn", text: slackEscape(message) };
  if (fields.length > 0) section.fields = fields.map(([label, value]) => ({ type: "mrkdwn", text: "*" + slackEscape(label) + "*\n" + slackEscape(value) }));
  if (section.text || section.fields) blocks.push(section);
  blocks.push({
    type: "actions",
    elements: [{ type: "button", text: { type: "plain_text", text: "View in CostKey" }, url: link, action_id: "costkey_open" }],
  });
  return { text: slackEscape((title + (message ? " — " + message : "")).slice(0, 300)), blocks, unfurl_links: false, unfurl_media: false };
}

function validateEventTypes(value: unknown): string[] {
  const allowed = new Set<NotificationEventType>(["weekly_summary", "daily_summary", "finding", "policy_warning", "enforcement", "execution_receipt"]);
  if (value === undefined) return ["weekly_summary"];
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string" && allowed.has(item as NotificationEventType)))];
}

function emailBody(payload: Record<string, unknown>): string {
  const message = cleanText(payload.message, 2_000);
  const scope = jsonObject(payload.scope);
  const scopeText = Object.entries(scope).slice(0, 8).map(([key, value]) => key + "=" + formatEmailValue(value)).join(", ");
  const evidence = jsonObject(payload.evidence);
  const evidenceItems = Object.entries(evidence)
    .filter(([key]) => key !== "link")
    .slice(0, 20)
    .map(([key, value]) => "<li><strong>" + escapeHtml(key) + ":</strong> " + escapeHtml(formatEmailValue(value)) + "</li>")
    .join("");
  const link = safeDeepLink(payload.link);
  const artwork = safeDeepLink(process.env["COSTKEY_NOTIFICATION_ARTWORK_URL"] ?? appLink("/assets/digest.png"));
  const compact = payload.eventType === "daily_summary";
  const scopeMarkup = scopeText && !compact ? "<p style='font-size:13px;color:#52677A;margin:0 0 18px'><strong>Scope:</strong> " + escapeHtml(scopeText) + "</p>" : "";
  const evidenceMarkup = evidenceItems && !compact ? "<ul style='padding-left:20px;margin:0 0 20px;color:#52677A'>" + evidenceItems + "</ul>" : "";
  const linkMarkup = link ? "<p style='margin:24px 0 8px'><a style='display:inline-block;padding:11px 18px;border-radius:8px;background:#F5CC68;color:#182B45;text-decoration:none;font-weight:700' href='" + escapeHtml(link) + "'>Open in CostKey</a></p>" : "";
  return "<div style='margin:0;background:#F7F5EF;color:#182B45;font-family:Inter,system-ui,sans-serif;padding:24px 12px'>"
    + "<div style='max-width:600px;margin:0 auto;border:1px solid #DCE8EE;border-radius:16px;overflow:hidden;background:#FFFFFF'>"
    + "<div style='padding:22px 24px;background:#DCE8EE'>"
    + (artwork ? "<img src='" + escapeHtml(artwork) + "' width='132' height='92' alt='CostKey observatory' style='display:block;object-fit:contain;margin:0 0 10px'>" : "")
    + "<div style='font-size:11px;letter-spacing:.12em;font-weight:700;color:#52677A'>COSTKEY · OBSERVED SPENDING</div></div>"
    + "<div style='padding:24px'><h2 style='margin:0 0 12px;color:#182B45;font-size:22px;line-height:1.25'>"
    + escapeHtml(cleanText(payload.title ?? "CostKey notification", 240))
    + "</h2><p style='margin:0 0 18px;color:#182B45;font-size:15px;line-height:1.55'>"
    + escapeHtml(message) + "</p>" + scopeMarkup + evidenceMarkup + linkMarkup
    + "</div><div style='padding:14px 24px;border-top:1px solid #DCE8EE;color:#52677A;font-size:11px'>Authenticated CostKey workspace link · notification preferences affect messages, not active policies.</div></div></div>";
}

function formatEmailValue(value: unknown): string {
  if (Array.isArray(value)) return value.slice(0, 5).map((item) => formatEmailValue(item)).join("; ");
  if (value && typeof value === "object") return Object.entries(value as Record<string, unknown>).slice(0, 8).map(([key, item]) => key + "=" + formatEmailValue(item)).join(", ");
  if (value === null || value === undefined) return "Unavailable";
  return String(value).slice(0, 300);
}

async function deliverDestinationSafe(
  destination: DestinationRow,
  payload: Record<string, unknown>,
  deliveryId: string,
): Promise<WebhookDeliveryResult> {
  if (destination.kind === "webhook") {
    const secret = decryptSecret(destination.secret_ciphertext as string | null);
    return dispatchWebhook(destination.address, secret, payload, deliveryId);
  }
  if (destination.kind === "slack") {
    return dispatchSlack(decryptSecret(destination.secret_ciphertext as string | null), payload, deliveryId);
  }
  if (destination.kind !== "email") return { status: "failed", error: "Destination kind is unsupported", deliveryId };
  if (!validEmailAddress(destination.address)) return { status: "failed", error: "Email destination is invalid", deliveryId };
  const body = emailBody(payload);
  if (process.env["COSTKEY_NOTIFICATION_SINK"] === "memory") {
    localDelivery("email://" + encodeURIComponent(destination.address), {
      "Content-Type": "text/html; charset=utf-8",
      "X-CostKey-Event": String(payload.eventType ?? "notification"),
      "X-CostKey-Delivery": deliveryId,
    }, body);
    return { status: "sent", statusCode: 202, deliveryId };
  }
  if (!externalDeliveryAllowed()) return { status: "suppressed", error: "Email delivery is disabled in test mode", deliveryId };
  const apiKey = process.env["RESEND_API_KEY"];
  if (!apiKey) return { status: "suppressed", error: "Email delivery is not configured", deliveryId };
  try {
    const resend = new Resend(apiKey);
    const response = await resend.emails.send({
      from: process.env["COSTKEY_NOTIFICATION_FROM"] ?? "CostKey <noreply@costkey.dev>",
      to: destination.address,
      subject: cleanText(payload.title ?? "CostKey notification", 240),
      html: body,
    }, { idempotencyKey: deliveryId });
    if (response.error) {
      const error = response.error as { message?: unknown; statusCode?: unknown };
      return {
        status: "failed",
        statusCode: typeof error.statusCode === "number" ? error.statusCode : undefined,
        error: cleanText(error.message ?? "Email provider rejected the message", 300),
        deliveryId,
      };
    }
    if (!response.data) return { status: "failed", error: "Email provider returned no acceptance", deliveryId };
    return { status: "sent", statusCode: 202, deliveryId };
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error.message.slice(0, 300) : "Email delivery failed", deliveryId };
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char] ?? char));
}

function eventPreferenceEnabled(row: PreferenceRow | null, eventType: string): boolean {
  // Enforcement is a policy decision, not a routine finding. A configured
  // destination can receive it unless the user explicitly mutes enforcement.
  if (!row) return eventType === "policy_warning" || eventType === "enforcement";
  switch (eventType) {
    case "weekly_summary": return row.weekly_summary_enabled === true;
    case "daily_summary": return row.daily_summary_enabled === true;
    case "finding": return row.findings_enabled === true;
    case "policy_warning": return budgetAlertsEnabled(row);
    case "enforcement": return row.enforcement_enabled !== false;
    case "execution_receipt": return row.execution_receipts_enabled === true;
    default: return false;
  }
}

function budgetAlertsEnabled(row: PreferenceRow): boolean {
  return typeof row.budget_alerts_enabled === "boolean" ? row.budget_alerts_enabled : row.enforcement_enabled !== false;
}

function policyThresholdEnabled(row: PreferenceRow | null, payload: NotificationPayload): boolean {
  if (payload.eventType !== "policy_warning" || !row || !Array.isArray(row.policy_warning_thresholds)) return true;
  const threshold = finiteNumber(jsonObject(payload.scope).threshold);
  return threshold == null || row.policy_warning_thresholds.some((value) => Math.abs(Number(value) - threshold) < 1e-9);
}

function preferenceScopeApplies(row: PreferenceRow, payload: NotificationPayload): boolean {
  if (payload.preferenceProjectId !== undefined) return row.project_id === (payload.preferenceProjectId ?? null);
  if (payload.projectId) return row.project_id === null || row.project_id === payload.projectId;
  return row.project_id === null;
}

async function findPreference(
  client: Queryable,
  payload: NotificationPayload,
  orgId: string,
  userId: string,
): Promise<PreferenceRow | null> {
  const result = await client.query(
    `SELECT *
     FROM notification_preferences
     WHERE org_id = $1 AND user_id = $2
       AND (
         ($3::text IS NULL AND project_id IS NULL)
         OR ($3::text IS NOT NULL AND (project_id IS NULL OR project_id = $3))
       )
     ORDER BY CASE WHEN project_id IS NULL THEN 1 ELSE 0 END, updated_at DESC
     LIMIT 1`,
    [orgId, userId, payload.projectId ?? null],
  );
  const rows = result.rows as PreferenceRow[];
  if (payload.preferenceProjectId !== undefined) {
    const exact = rows.find((row) => row.project_id === (payload.preferenceProjectId ?? null));
    return exact ?? null;
  }
  return rows[0] ?? null;
}

async function loadAuthorizedDestination(
  client: Queryable,
  payload: NotificationPayload,
  destinationId: string,
  orgId: string,
  recipientUserId?: string | null,
): Promise<DestinationRow | null> {
  const result = await client.query(
    `SELECT d.*, u.email AS owner_email, u.role AS owner_role
     FROM notification_destinations d
     JOIN users u ON u.id = d.owner_user_id AND u.org_id = d.org_id
     WHERE d.id = $1 AND d.org_id = $2 AND d.enabled = TRUE
       AND ($4::text IS NULL OR d.owner_user_id = $4)
       AND (
         ($3::text IS NULL AND d.project_id IS NULL)
         OR ($3::text IS NOT NULL AND (d.project_id IS NULL OR d.project_id = $3))
       )
       AND (
         $3::text IS NULL
         OR EXISTS (
           SELECT 1
           FROM projects requested_project
           WHERE requested_project.id = $3
             AND requested_project.org_id = d.org_id
             AND (
               u.role IN ('owner', 'admin')
               OR EXISTS (
                 SELECT 1 FROM project_memberships requested_membership
                 WHERE requested_membership.project_id = requested_project.id
                   AND requested_membership.user_id = u.id
               )
             )
         )
       )
       AND (
         d.project_id IS NULL
         OR EXISTS (
           SELECT 1
           FROM projects destination_project
           WHERE destination_project.id = d.project_id
             AND destination_project.org_id = d.org_id
             AND (
               u.role IN ('owner', 'admin')
               OR EXISTS (
                 SELECT 1 FROM project_memberships destination_membership
                 WHERE destination_membership.project_id = d.project_id
                   AND destination_membership.user_id = u.id
               )
             )
         )
       )
     FOR UPDATE OF d`,
    [destinationId, orgId, payload.projectId ?? null, recipientUserId ?? null],
  );
  return result.rows[0] ? result.rows[0] as DestinationRow : null;
}

function destinationEventTypes(destination: DestinationRow): string[] {
  return Array.isArray(destination.event_types)
    ? destination.event_types.filter((item): item is string => typeof item === "string")
    : [];
}

function dateFromUnknown(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value !== "string" && typeof value !== "number") return null;
  const result = new Date(value);
  return Number.isNaN(result.getTime()) ? null : result;
}

function retryDue(row: Row, now: Date): boolean {
  const attempts = Math.max(0, Number(row.attempt_count) || 0);
  if (attempts >= MAX_DELIVERY_ATTEMPTS) return false;
  if (attempts === 0) return true;
  const created = dateFromUnknown(row.created_at)?.getTime() ?? 0;
  const delay = RETRY_BACKOFF_MS[Math.min(attempts - 1, RETRY_BACKOFF_MS.length - 1)] ?? RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1];
  return now.getTime() >= created + delay;
}

function dedupeKeyFor(payload: NotificationPayload, now = new Date()): string {
  if (payload.dedupeKey) return cleanText(payload.dedupeKey, 240);
  const scope = jsonObject(payload.scope);
  const project = payload.projectId ?? "workspace";
  if (payload.eventType === "weekly_summary") {
    return "weekly_summary:" + project + ":" + String(scope.periodStart ?? payload.occurredAt ?? now.toISOString());
  }
  if (payload.eventType === "daily_summary") {
    return "daily_summary:" + project + ":" + String(scope.periodStart ?? payload.occurredAt ?? now.toISOString());
  }
  if (payload.eventType === "policy_warning") {
    return "policy_warning:" + project + ":" + String(scope.policyId ?? "policy") + ":" + String(scope.threshold ?? "threshold") + ":" + String(scope.windowKey ?? now.toISOString().slice(0, 10));
  }
  if (payload.eventType === "enforcement") {
    const timestamp = dateFromUnknown(payload.occurredAt)?.getTime() ?? now.getTime();
    const hour = Math.floor(timestamp / (60 * 60 * 1_000));
    const refusal = scope.reason ?? jsonObject(payload.evidence).reason ?? "refused";
    return "enforcement:" + project + ":" + String(scope.policyId ?? "policy") + ":" + String(refusal) + ":" + hour;
  }
  if (payload.eventType === "finding") {
    return "finding:" + project + ":" + String(scope.findingId ?? scope.traceId ?? payload.occurredAt ?? now.toISOString());
  }
  return "execution_receipt:" + project + ":" + String(scope.executionId ?? scope.groupId ?? scope.periodStart ?? payload.occurredAt ?? now.toISOString());
}

async function updateDeliveryState(
  client: Queryable,
  rowId: string,
  destinationId: string | null,
  result: WebhookDeliveryResult,
): Promise<void> {
  await client.query(
    `UPDATE notification_deliveries
     SET status = $1,
         attempt_count = LEAST(attempt_count + 1, $2),
         last_error = $3,
         sent_at = CASE WHEN $1 = 'sent' THEN NOW() ELSE sent_at END
     WHERE id = $4`,
    [result.status, MAX_DELIVERY_ATTEMPTS, result.error ?? null, rowId],
  );
  if (destinationId) {
    await client.query(
      `UPDATE notification_destinations
       SET last_delivery_at = CASE WHEN $1 = 'sent' THEN NOW() ELSE last_delivery_at END,
           last_error = $2, updated_at = NOW()
       WHERE id = $3`,
      [result.status, result.error ?? null, destinationId],
    );
  }
}

async function findingStillNotifiable(client: Queryable, payload: NotificationPayload): Promise<boolean> {
  if (payload.eventType !== "finding") return true;
  const findingId = jsonObject(payload.scope).findingId;
  if (typeof findingId !== "string" || !payload.projectId) return false;
  try {
    const result = await client.query(
      `SELECT f.state
       FROM findings f
       JOIN projects p ON p.id = f.project_id AND p.org_id = $3
       WHERE f.id = $1 AND f.project_id = $2
       FOR UPDATE OF f`,
      [findingId, payload.projectId, payload.orgId],
    );
    return result.rows[0]?.state === "new" || result.rows[0]?.state === "updated";
  } catch {
    // Fail closed if the accounting finding table is unavailable.
    return false;
  }
}

interface OutboxAttemptOptions {
  destinationId?: string | null;
  ownerUserId?: string | null;
  existingId?: string;
  dedupeKey?: string;
  safePayload?: Record<string, unknown>;
  payload: NotificationPayload;
  now: Date;
}

async function attemptOutbox(pool: pg.Pool, options: OutboxAttemptOptions): Promise<WebhookDeliveryResult | null> {
  const client = await pool.connect();
  let deliveryId = options.existingId ?? randomId("delivery");
  try {
    await client.query("BEGIN");
    const lockKey = options.existingId
      ?? [options.payload.orgId, options.destinationId ?? "", options.dedupeKey ?? dedupeKeyFor(options.payload, options.now)].join(":");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [lockKey]);

    let deliveryRow: Row | undefined;
    if (options.existingId) {
      const existing = await client.query(
        `SELECT * FROM notification_deliveries WHERE id = $1 FOR UPDATE`,
        [options.existingId],
      );
      deliveryRow = existing.rows[0] as Row | undefined;
      if (!deliveryRow) {
        await client.query("ROLLBACK");
        return null;
      }
      deliveryId = String(deliveryRow.id);
    } else {
      const dedupeKey = options.dedupeKey ?? dedupeKeyFor(options.payload, options.now);
      const existing = await client.query(
        `SELECT * FROM notification_deliveries
         WHERE org_id = $1 AND destination_id = $2 AND dedupe_key = $3
         FOR UPDATE`,
        [options.payload.orgId, options.destinationId, dedupeKey],
      );
      deliveryRow = existing.rows[0] as Row | undefined;
      if (!deliveryRow) {
        const inserted = await client.query(
          `INSERT INTO notification_deliveries
             (id, org_id, user_id, destination_id, event_type, scope_type, scope_id, dedupe_key, payload, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, 'pending')
           ON CONFLICT DO NOTHING
           RETURNING *`,
          [
            deliveryId,
            options.payload.orgId,
            options.ownerUserId ?? options.payload.recipientUserId ?? null,
            options.destinationId,
            options.payload.eventType,
            options.payload.projectId ? "project" : "workspace",
            options.payload.projectId ?? null,
            dedupeKey,
            JSON.stringify(options.safePayload ?? sanitizedPayload(options.payload)),
          ],
        );
        deliveryRow = inserted.rows[0] as Row | undefined;
        if (!deliveryRow) {
          const raced = await client.query(
            `SELECT * FROM notification_deliveries
             WHERE org_id = $1 AND destination_id = $2 AND dedupe_key = $3
             FOR UPDATE`,
            [options.payload.orgId, options.destinationId, dedupeKey],
          );
          deliveryRow = raced.rows[0] as Row | undefined;
        }
      }
      if (!deliveryRow) {
        await client.query("ROLLBACK");
        return null;
      }
      deliveryId = String(deliveryRow.id);
    }

    const status = String(deliveryRow.status ?? "pending");
    const suppressedCanRecheck = status === "suppressed"
      && (deliveryRow.last_error === "Notification preference is disabled" || deliveryRow.last_error === "Finding is no longer notifiable");
    if (status === "sent" || (status === "suppressed" && !suppressedCanRecheck) || (!suppressedCanRecheck && !retryDue(deliveryRow, options.now))) {
      await client.query("COMMIT");
      return null;
    }

    const destinationId = String(deliveryRow.destination_id ?? options.destinationId ?? "");
    if (!destinationId) {
      const suppressed: WebhookDeliveryResult = { status: "suppressed", error: "Notification destination is unavailable", deliveryId };
      await updateDeliveryState(client, deliveryId, null, suppressed);
      await client.query("COMMIT");
      return suppressed;
    }

    const destination = await loadAuthorizedDestination(
      client,
      options.payload,
      destinationId,
      options.payload.orgId,
      options.payload.recipientUserId ?? (deliveryRow.user_id ? String(deliveryRow.user_id) : null),
    );
    if (!destination) {
      const suppressed: WebhookDeliveryResult = { status: "suppressed", error: "Notification recipient is no longer authorized", deliveryId };
      await updateDeliveryState(client, deliveryId, destinationId, suppressed);
      await client.query("COMMIT");
      return suppressed;
    }
    if (!destinationEventTypes(destination).includes(options.payload.eventType)) {
      const suppressed: WebhookDeliveryResult = { status: "suppressed", error: "Notification event is not subscribed on this destination", deliveryId };
      await updateDeliveryState(client, deliveryId, destinationId, suppressed);
      await client.query("COMMIT");
      return suppressed;
    }
    if (!destination.owner_user_id) {
      const suppressed: WebhookDeliveryResult = { status: "suppressed", error: "Notification recipient is unavailable", deliveryId };
      await updateDeliveryState(client, deliveryId, destinationId, suppressed);
      await client.query("COMMIT");
      return suppressed;
    }
    const preference = await findPreference(client, options.payload, options.payload.orgId, destination.owner_user_id);
    if (!eventPreferenceEnabled(preference, options.payload.eventType) || !policyThresholdEnabled(preference, options.payload)) {
      if (suppressedCanRecheck) {
        await client.query("COMMIT");
        return null;
      }
      const suppressed: WebhookDeliveryResult = { status: "suppressed", error: "Notification preference is disabled", deliveryId };
      await updateDeliveryState(client, deliveryId, destinationId, suppressed);
      await client.query("COMMIT");
      return suppressed;
    }
    if (!await findingStillNotifiable(client, options.payload)) {
      if (suppressedCanRecheck && deliveryRow.last_error === "Finding is no longer notifiable") {
        await client.query("COMMIT");
        return null;
      }
      const suppressed: WebhookDeliveryResult = { status: "suppressed", error: "Finding is no longer notifiable", deliveryId };
      await updateDeliveryState(client, deliveryId, destinationId, suppressed);
      await client.query("COMMIT");
      return suppressed;
    }

    const channelPayload = options.safePayload ?? sanitizedPayload(options.payload);
    const result = await deliverDestinationSafe(destination, channelPayload, deliveryId);
    await updateDeliveryState(client, deliveryId, destinationId, result);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    return {
      status: "failed",
      error: error instanceof Error ? error.message.slice(0, 300) : "Notification delivery failed",
      deliveryId,
    };
  } finally {
    client.release();
  }
}

async function loadPreferences(pool: pg.Pool, payload: NotificationPayload): Promise<PreferenceRow[]> {
  const result = await pool.query(
    `SELECT np.*, u.email
     FROM notification_preferences np
     JOIN users u ON u.id = np.user_id AND u.org_id = np.org_id
     WHERE np.org_id = $1
       AND ($2::text IS NULL OR np.user_id = $2)`,
    [payload.orgId, payload.recipientUserId ?? null],
  );
  return result.rows as PreferenceRow[];
}

function appendDefaultEmailDestinations(
  payload: NotificationPayload,
  destinationRows: DestinationRow[],
  preferences: PreferenceRow[],
): void {
  const existing = new Set(
    destinationRows
      .filter((destination) => destination.kind === "email")
      .map((destination) => String(destination.owner_user_id) + ":" + destination.address.toLowerCase()),
  );
  for (const preference of preferences) {
    if (!preferenceScopeApplies(preference, payload) || !eventPreferenceEnabled(preference, payload.eventType)) continue;
    const email = typeof preference.email === "string" ? preference.email.trim() : "";
    if (!validEmailAddress(email)) continue;
    const key = String(preference.user_id) + ":" + email.toLowerCase();
    if (existing.has(key)) continue;
    destinationRows.push({
      id: "default_" + payload.orgId + "_" + String(preference.user_id) + "_" + (payload.projectId ?? "workspace"),
      org_id: payload.orgId,
      project_id: payload.projectId ?? null,
      owner_user_id: String(preference.user_id),
      kind: "email",
      address: email,
      secret_ciphertext: null,
      event_types: [payload.eventType],
      enabled: true,
    });
    existing.add(key);
  }
}

async function persistDefaultEmailDestination(pool: pg.Pool, payload: NotificationPayload, destination: DestinationRow): Promise<void> {
  if (!destination.id.startsWith("default_")) return;
  await pool.query(
    `INSERT INTO notification_destinations(id, org_id, project_id, owner_user_id, kind, address, event_types)
     VALUES ($1, $2, $3, $4, 'email', $5, $6::text[])
     ON CONFLICT (id) DO UPDATE
     SET event_types = ARRAY(
       SELECT DISTINCT event_type
       FROM unnest(notification_destinations.event_types || EXCLUDED.event_types) AS event_type
     ),
     updated_at = NOW()`,
    [destination.id, payload.orgId, payload.projectId ?? null, destination.owner_user_id, destination.address, [payload.eventType]],
  );
}

export async function dispatchNotification(pool: pg.Pool, payload: NotificationPayload): Promise<WebhookDeliveryResult[]> {
  const safePayload = sanitizedPayload(payload);
  const destinations = await pool.query(
    `SELECT id, org_id, project_id, owner_user_id, kind, address, secret_ciphertext, event_types, enabled
     FROM notification_destinations
     WHERE org_id = $1 AND enabled = TRUE
       AND (
         ($2::text IS NULL AND project_id IS NULL)
         OR ($2::text IS NOT NULL AND (project_id IS NULL OR project_id = $2))
       )
       AND ($3::text IS NULL OR owner_user_id = $3)`,
    [payload.orgId, payload.projectId ?? null, payload.recipientUserId ?? null],
  );
  const destinationRows = [...destinations.rows as DestinationRow[]];
  const preferences = await loadPreferences(pool, payload);
  appendDefaultEmailDestinations(payload, destinationRows, preferences);

  const results: WebhookDeliveryResult[] = [];
  const dedupeKey = dedupeKeyFor(payload);
  for (const destination of destinationRows) {
    if (!destinationEventTypes(destination).includes(payload.eventType)) continue;
    await persistDefaultEmailDestination(pool, payload, destination);
    const result = await attemptOutbox(pool, {
      destinationId: destination.id,
      ownerUserId: destination.owner_user_id,
      dedupeKey,
      payload,
      safePayload,
      now: new Date(),
    });
    if (result) results.push(result);
  }
  return results;
}

export async function retryNotificationDeliveries(pool: pg.Pool, now = new Date()): Promise<number> {
  const result = await pool.query(
    `SELECT id, org_id, user_id, destination_id, payload, status, attempt_count, created_at
     FROM notification_deliveries
     WHERE status IN ('pending', 'failed')
       AND attempt_count < $1
     ORDER BY created_at ASC
     LIMIT 100`,
    [MAX_DELIVERY_ATTEMPTS],
  );
  let attempted = 0;
  for (const row of result.rows as Row[]) {
    if (!retryDue(row, now) || !row.destination_id) continue;
    const body = parseJsonObject(row.payload);
    const payload: NotificationPayload = {
      eventType: cleanText(body.eventType, 80),
      orgId: String(row.org_id),
      projectId: typeof body.projectId === "string" ? body.projectId : null,
      scope: jsonObject(body.scope),
      title: cleanText(body.title, 240),
      message: cleanText(body.message, 2_000),
      evidence: jsonObject(body.evidence),
      link: typeof body.link === "string" ? body.link : undefined,
      occurredAt: typeof body.occurredAt === "string" ? body.occurredAt : undefined,
      recipientUserId: typeof row.user_id === "string" ? row.user_id : null,
      preferenceProjectId: body.eventType === "weekly_summary" || body.eventType === "daily_summary" || body.eventType === "execution_receipt"
        ? (typeof body.projectId === "string" ? body.projectId : null)
        : undefined,
    };
    const delivery = await attemptOutbox(pool, {
      existingId: String(row.id),
      destinationId: String(row.destination_id),
      ownerUserId: typeof row.user_id === "string" ? row.user_id : null,
      payload,
      safePayload: sanitizedPayload(payload),
      now,
    });
    if (delivery) attempted += 1;
  }
  return attempted;
}

type SavedViewPreferenceUser = { id: string; orgId: string; role: string; email?: string; name?: string };

async function ensurePreferences(
  pool: pg.Pool,
  user: SavedViewPreferenceUser,
  projectId: string | null,
  overrides: Record<string, unknown> = {},
): Promise<PreferenceRow> {
  const existing = await pool.query(
    `SELECT *
     FROM notification_preferences
     WHERE org_id = $1 AND user_id = $2 AND project_id IS NOT DISTINCT FROM $3
     LIMIT 1`,
    [user.orgId, user.id, projectId],
  );
  if (existing.rows[0]) return existing.rows[0] as PreferenceRow;
  const id = randomId("pref");
  const inserted = await pool.query(
    `INSERT INTO notification_preferences(
       id, org_id, user_id, project_id,
       weekly_summary_enabled, weekly_summary_hour, weekly_summary_weekday, timezone,
       findings_enabled, policy_warning_thresholds, enforcement_enabled, execution_receipts_enabled,
       daily_summary_enabled, daily_summary_hour, budget_alerts_enabled
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [
      id, user.orgId, user.id, projectId,
      overrides.weeklySummaryEnabled === true,
      Number.isInteger(overrides.weeklySummaryHour) ? overrides.weeklySummaryHour : DEFAULT_HOUR,
      Number.isInteger(overrides.weeklySummaryWeekday) ? overrides.weeklySummaryWeekday : DEFAULT_WEEKDAY,
      typeof overrides.timezone === "string" ? overrides.timezone : DEFAULT_TIMEZONE,
      overrides.findingsEnabled === true,
      Array.isArray(overrides.policyWarningThresholds) ? overrides.policyWarningThresholds : DEFAULT_THRESHOLDS,
      overrides.enforcementEnabled !== false,
      overrides.executionReceiptsEnabled === true,
      overrides.dailySummaryEnabled === true,
      Number.isInteger(overrides.dailySummaryHour) ? overrides.dailySummaryHour : DEFAULT_HOUR,
      overrides.budgetAlertsEnabled !== false,
    ],
  );
  if (inserted.rows[0]) return inserted.rows[0] as PreferenceRow;
  const raced = await pool.query(
    `SELECT *
     FROM notification_preferences
     WHERE org_id = $1 AND user_id = $2 AND project_id IS NOT DISTINCT FROM $3
     LIMIT 1`,
    [user.orgId, user.id, projectId],
  );
  return raced.rows[0] as PreferenceRow;
}

function defaultPreferenceRow(user: SavedViewPreferenceUser, projectId: string | null): PreferenceRow {
  return {
    id: null,
    org_id: user.orgId,
    user_id: user.id,
    project_id: projectId,
    weekly_summary_enabled: false,
    weekly_summary_hour: DEFAULT_HOUR,
    weekly_summary_weekday: DEFAULT_WEEKDAY,
    timezone: DEFAULT_TIMEZONE,
    findings_enabled: false,
    policy_warning_thresholds: [...DEFAULT_THRESHOLDS],
    enforcement_enabled: true,
    budget_alerts_enabled: null,
    execution_receipts_enabled: false,
    daily_summary_enabled: false,
    daily_summary_hour: DEFAULT_HOUR,
  };
}

function preferenceResponse(row: PreferenceRow, explicit = true): Record<string, unknown> {
  return {
    id: row.id ?? null,
    projectId: row.project_id,
    weeklySummaryEnabled: row.weekly_summary_enabled === true,
    weeklySummaryHour: Number(row.weekly_summary_hour ?? DEFAULT_HOUR),
    weeklySummaryWeekday: Number(row.weekly_summary_weekday ?? DEFAULT_WEEKDAY),
    dailySummaryEnabled: row.daily_summary_enabled === true,
    dailySummaryHour: Number(row.daily_summary_hour ?? DEFAULT_HOUR),
    timezone: typeof row.timezone === "string" ? row.timezone : DEFAULT_TIMEZONE,
    findingsEnabled: row.findings_enabled === true,
    policyWarningThresholds: Array.isArray(row.policy_warning_thresholds) ? row.policy_warning_thresholds : [...DEFAULT_THRESHOLDS],
    enforcementEnabled: row.enforcement_enabled !== false,
    budgetAlertsEnabled: budgetAlertsEnabled(row),
    executionReceiptsEnabled: row.execution_receipts_enabled === true,
    explicit,
    updatedAt: row.updated_at ?? null,
  };
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
}

const WEEKDAY_BY_NAME: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function validTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 80) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function zonedParts(value: Date, timezone: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(formatter.formatToParts(value).map((part) => [part.type, part.value]));
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short" }).format(value);
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAY_BY_NAME[weekday] ?? 0,
  };
}

function dateKey(parts: Pick<ZonedParts, "year" | "month" | "day">): string {
  return String(parts.year).padStart(4, "0") + "-" + String(parts.month).padStart(2, "0") + "-" + String(parts.day).padStart(2, "0");
}

function addCalendarDays(key: string, days: number): string {
  const date = new Date(key + "T00:00:00.000Z");
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function localMidnightUtc(key: string, timezone: string): Date {
  return localDateTimeUtc(key, 0, timezone);
}

function localDateTimeUtc(key: string, hour: number, timezone: string): Date {
  const target = Date.parse(key + "T" + String(hour).padStart(2, "0") + ":00:00.000Z");
  let candidate = target;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = zonedParts(new Date(candidate), timezone);
    const actual = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    candidate += target - actual;
  }
  return new Date(candidate);
}

export function digestWindow(now: Date, timezone = DEFAULT_TIMEZONE): { start: Date; end: Date; startLabel: string; endLabel: string } {
  const safeTimezone = validTimeZone(timezone) ? timezone : DEFAULT_TIMEZONE;
  const parts = zonedParts(now, safeTimezone);
  const endLabel = dateKey(parts);
  const startLabel = addCalendarDays(endLabel, -7);
  return {
    start: localMidnightUtc(startLabel, safeTimezone),
    end: localMidnightUtc(endLabel, safeTimezone),
    startLabel,
    endLabel,
  };
}

export interface DigestSchedule {
  scheduledAt: Date;
  timezone: string;
  dateLabel: string;
}

/**
 * Return the current week's scheduled instant when it is due or missed by at
 * most seven days. Anchoring the window to this instant makes a restart on
 * Tuesday catch up Monday's digest without changing its period or dedupe key.
 */
export function digestSchedule(
  now: Date,
  timezoneValue: unknown = DEFAULT_TIMEZONE,
  weekdayValue: unknown = DEFAULT_WEEKDAY,
  hourValue: unknown = DEFAULT_HOUR,
): DigestSchedule | null {
  const timezone = validTimeZone(timezoneValue) ? timezoneValue : DEFAULT_TIMEZONE;
  const weekday = Number.isInteger(weekdayValue) && Number(weekdayValue) >= 0 && Number(weekdayValue) <= 6
    ? Number(weekdayValue)
    : DEFAULT_WEEKDAY;
  const hour = Number.isInteger(hourValue) && Number(hourValue) >= 0 && Number(hourValue) <= 23
    ? Number(hourValue)
    : DEFAULT_HOUR;
  const parts = zonedParts(now, timezone);
  const currentDate = dateKey(parts);
  const daysSinceSchedule = (parts.weekday - weekday + 7) % 7;
  let dateLabel = addCalendarDays(currentDate, -daysSinceSchedule);
  let scheduledAt = localDateTimeUtc(dateLabel, hour, timezone);
  if (scheduledAt.getTime() > now.getTime()) {
    dateLabel = addCalendarDays(dateLabel, -7);
    scheduledAt = localDateTimeUtc(dateLabel, hour, timezone);
  }
  const elapsed = now.getTime() - scheduledAt.getTime();
  if (elapsed < 0 || elapsed >= 7 * 24 * 60 * 60 * 1_000) return null;
  return { scheduledAt, timezone, dateLabel };
}

function preferenceDue(row: PreferenceRow, now: Date): DigestSchedule | null {
  return digestSchedule(now, row.timezone, row.weekly_summary_weekday, row.weekly_summary_hour);
}

function finiteNumber(value: unknown): number | null {
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

interface ChargeStats {
  observations: number;
  pricedObservations: number;
  unpricedObservations: number;
  knownCost: number | null;
  traceCount: number;
  coverage: number | null;
}

interface ContributorStat {
  label: string;
  observations: number;
  cost: number | null;
  previousCost: number | null;
  change: number | null;
  changePct: number | null;
}

interface DigestAggregates {
  current: ChargeStats;
  previous: ChargeStats;
  contributors: ContributorStat[];
}

function emptyChargeStats(): ChargeStats {
  return {
    observations: 0,
    pricedObservations: 0,
    unpricedObservations: 0,
    knownCost: null,
    traceCount: 0,
    coverage: null,
  };
}

/**
 * Aggregate the canonical cohort in PostgreSQL. Only totals and the top five
 * feature rows per period cross the process boundary; raw charges are never
 * materialized for a weekly digest.
 */
async function aggregateChargesForProjects(
  pool: pg.Pool,
  projectIds: string[],
  currentFrom: Date,
  currentTo: Date,
  previousFrom: Date,
  executionOnly = false,
): Promise<DigestAggregates> {
  if (projectIds.length === 0) return { current: emptyChargeStats(), previous: emptyChargeStats(), contributors: [] };
  const result = await pool.query(
    `${chargesCte()}
     , period_rows AS (
       SELECT 'current'::text AS period, c.*
       FROM charges c
       WHERE c.project_id = ANY($1::text[])
         AND c.timestamp >= $2 AND c.timestamp < $3
         ${executionOnly ? "AND c.execution_id IS NOT NULL" : ""}
       UNION ALL
       SELECT 'previous'::text AS period, c.*
       FROM charges c
       WHERE c.project_id = ANY($1::text[])
         AND c.timestamp >= $4 AND c.timestamp < $2
         ${executionOnly ? "AND c.execution_id IS NOT NULL" : ""}
     ), labeled AS (
       SELECT period,
              COALESCE(NULLIF(context->>'feature', ''), '(unassigned)') AS label,
              cost_usd, trace_id
       FROM period_rows
     ), grouped AS (
       SELECT period,
              CASE WHEN GROUPING(label) = 1 THEN NULL ELSE label END AS label,
              COUNT(*)::int AS observations,
              COUNT(*) FILTER (WHERE cost_usd IS NOT NULL)::int AS priced_observations,
              COUNT(*) FILTER (WHERE cost_usd IS NULL)::int AS unpriced_observations,
              SUM(cost_usd) FILTER (WHERE cost_usd IS NOT NULL) AS known_cost,
              COUNT(DISTINCT trace_id) FILTER (WHERE trace_id IS NOT NULL)::int AS trace_count
       FROM labeled
       GROUP BY period, ROLLUP(label)
     ), ranked AS (
       SELECT grouped.*,
              CASE WHEN label IS NULL THEN 0 ELSE ROW_NUMBER() OVER (
                PARTITION BY period
                ORDER BY known_cost DESC NULLS LAST, observations DESC, label
              ) END AS rank
       FROM grouped
     )
     SELECT period, label, observations, priced_observations,
            unpriced_observations, known_cost, trace_count
     FROM ranked
     WHERE label IS NULL OR rank <= 5
     ORDER BY period, label NULLS FIRST`,
    [projectIds, currentFrom.toISOString(), currentTo.toISOString(), previousFrom.toISOString()],
  );
  const stats: Record<"current" | "previous", ChargeStats> = {
    current: emptyChargeStats(),
    previous: emptyChargeStats(),
  };
  const contributorRows: Record<"current" | "previous", Map<string, {
    observations: number;
    knownCost: number | null;
  }>> = {
    current: new Map(),
    previous: new Map(),
  };
  for (const row of result.rows as Row[]) {
    const period = row.period === "previous" ? "previous" : "current";
    const observations = Number(row.observations) || 0;
    const pricedObservations = Number(row.priced_observations) || 0;
    const unpricedObservations = Number(row.unpriced_observations) || 0;
    if (row.label == null) {
      stats[period] = {
        observations,
        pricedObservations,
        unpricedObservations,
        knownCost: pricedObservations > 0 ? finiteNumber(row.known_cost) : null,
        traceCount: Number(row.trace_count) || 0,
        coverage: observations > 0 ? pricedObservations / observations : null,
      };
    } else {
      contributorRows[period].set(String(row.label), {
        observations,
        knownCost: pricedObservations > 0 ? finiteNumber(row.known_cost) : null,
      });
    }
  }
  const labels = new Set([...contributorRows.current.keys(), ...contributorRows.previous.keys()]);
  const contributors = [...labels].map((label) => {
    const current = contributorRows.current.get(label) ?? { observations: 0, knownCost: null };
    const previous = contributorRows.previous.get(label) ?? { observations: 0, knownCost: null };
    const change = current.knownCost != null && previous.knownCost != null ? current.knownCost - previous.knownCost : null;
    return {
      label,
      observations: current.observations,
      cost: current.knownCost,
      previousCost: previous.knownCost,
      change,
      changePct: change != null && previous.knownCost != null && previous.knownCost !== 0 ? change / previous.knownCost : null,
    };
  }).sort((a, b) => (b.cost ?? -1) - (a.cost ?? -1) || b.observations - a.observations).slice(0, 5);
  return { current: stats.current, previous: stats.previous, contributors };
}

async function accessibleProjectIds(pool: pg.Pool, row: PreferenceRow): Promise<string[]> {
  const result = await pool.query(
    `SELECT p.id
     FROM projects p
     WHERE p.org_id = $1
       AND ($2 IN ('owner', 'admin') OR EXISTS (
         SELECT 1 FROM project_memberships pm
         WHERE pm.project_id = p.id AND pm.user_id = $3
       ))
     ORDER BY p.id`,
    [row.org_id, String(row.role ?? ""), row.user_id],
  );
  return result.rows.map((project) => String(project.id));
}

async function projectsForPreference(pool: pg.Pool, row: PreferenceRow): Promise<string[]> {
  if (row.project_id) {
    const result = await pool.query(
      `SELECT p.id
       FROM projects p
       WHERE p.id = $1 AND p.org_id = $2
         AND ($3 IN ('owner', 'admin') OR EXISTS (
           SELECT 1 FROM project_memberships pm
           WHERE pm.project_id = p.id AND pm.user_id = $4
         ))`,
      [row.project_id, row.org_id, String(row.role ?? ""), row.user_id],
    );
    return result.rows.length > 0 ? [row.project_id] : [];
  }
  return accessibleProjectIds(pool, row);
}

async function optionalRows(pool: pg.Pool, sql: string, params: unknown[]): Promise<Row[]> {
  try {
    return (await pool.query(sql, params)).rows as Row[];
  } catch {
    // Optional tables are created by platform/accounting migrations. A missing
    // activity table must not block a canonical spend summary.
    return [];
  }
}

async function summaryFindings(pool: pg.Pool, projectIds: string[], from: Date, to: Date): Promise<Row[]> {
  if (projectIds.length === 0) return [];
  return optionalRows(
    pool,
    `SELECT id, project_id, family, state, observed_at, last_seen_at, evidence
     FROM findings
     WHERE project_id = ANY($1::text[])
       AND state IN ('new', 'updated')
       AND last_seen_at >= $2 AND last_seen_at < $3
     ORDER BY last_seen_at DESC
     LIMIT 10`,
    [projectIds, from.toISOString(), to.toISOString()],
  );
}

async function summaryPolicyActivity(pool: pg.Pool, orgId: string, projectIds: string[], from: Date, to: Date): Promise<{ warnings: Row[]; refusals: Row[] }> {
  if (projectIds.length === 0) return { warnings: [], refusals: [] };
  const warnings = await optionalRows(
    pool,
    `SELECT project_id, rule_id, scope, threshold, window_key, spent_usd, limit_usd, fired_at
     FROM budget_alert_firings
     WHERE project_id = ANY($1::text[]) AND fired_at >= $2 AND fired_at < $3
     ORDER BY fired_at DESC LIMIT 20`,
    [projectIds, from.toISOString(), to.toISOString()],
  );
  const refusals = await optionalRows(
    pool,
    `SELECT pd.project_id, pd.admission_id, pd.decision, pd.refusal, pd.created_at
     FROM policy_decisions pd
     JOIN projects p ON p.id = pd.project_id
     WHERE p.org_id = $1 AND pd.project_id = ANY($2::text[])
       AND pd.decision = 'refuse'
       AND pd.created_at >= $3 AND pd.created_at < $4
     ORDER BY pd.created_at DESC LIMIT 20`,
    [orgId, projectIds, from.toISOString(), to.toISOString()],
  );
  return { warnings, refusals };
}

function findingEvidence(row: Row): Record<string, unknown> {
  const evidence = parseJsonObject(row.evidence);
  const scope = parseJsonObject(row.scope);
  return {
    findingId: String(row.id),
    family: cleanText(row.family, 80),
    state: cleanText(row.state, 40),
    absoluteDifference: finiteNumber(evidence.absoluteDifference),
    relativeDifference: finiteNumber(evidence.relativeDifference),
    traceId: typeof evidence.traceId === "string" ? evidence.traceId : typeof scope.traceId === "string" ? scope.traceId : undefined,
    link: appLink("/findings/" + encodeURIComponent(String(row.id)), { project: String(row.project_id) }),
  };
}

function policyActivityEvidence(activity: { warnings: Row[]; refusals: Row[] }): Record<string, unknown> {
  const warnings = activity.warnings.slice(0, 5).map((row) => ({
    policyId: String(row.rule_id ?? ""),
    threshold: finiteNumber(row.threshold),
    observedUsage: finiteNumber(row.spent_usd),
    allowance: finiteNumber(row.limit_usd),
    status: "warning",
    windowKey: typeof row.window_key === "string" ? row.window_key : undefined,
    link: appLink("/budgets/" + encodeURIComponent(String(row.rule_id ?? "")), { project: String(row.project_id ?? "") }),
  }));
  const refusals = activity.refusals.slice(0, 5).map((row) => {
    const refusal = parseJsonObject(row.refusal);
    return {
      policyId: typeof refusal.policyId === "string" ? refusal.policyId : undefined,
      status: "refused",
      reason: typeof refusal.reason === "string" ? refusal.reason : "budget_exhausted",
      link: typeof refusal.policyId === "string"
        ? appLink("/budgets/" + encodeURIComponent(refusal.policyId), { project: String(row.project_id ?? "") })
        : undefined,
    };
  });
  return {
    policyWarnings: activity.warnings.length,
    policyRefusals: activity.refusals.length,
    policyActivity: [...warnings, ...refusals],
  };
}

async function weeklyPayload(pool: pg.Pool, row: PreferenceRow, now: Date, anchorAt = now): Promise<NotificationPayload | null> {
  const timezone = validTimeZone(row.timezone) ? String(row.timezone) : DEFAULT_TIMEZONE;
  const window = digestWindow(anchorAt, timezone);
  const projectIds = await projectsForPreference(pool, row);
  const previousStart = localMidnightUtc(addCalendarDays(window.startLabel, -7), timezone);
  const results = await Promise.all([
    aggregateChargesForProjects(pool, projectIds, window.start, window.end, previousStart),
    summaryFindings(pool, projectIds, window.start, window.end),
    summaryPolicyActivity(pool, row.org_id, projectIds, window.start, window.end),
  ]);
  const aggregates = results[0];
  const findings = results[1] as Row[];
  const policyActivity = results[2] as { warnings: Row[]; refusals: Row[] };
  const currentStats = aggregates.current;
  const previousStats = aggregates.previous;
  const change = currentStats.knownCost != null && previousStats.knownCost != null ? currentStats.knownCost - previousStats.knownCost : null;
  const changePct = change != null && previousStats.knownCost != null && previousStats.knownCost !== 0 ? change / previousStats.knownCost : null;
  const currentText = currentStats.knownCost == null ? "known spend is unavailable" : "known spend $" + currentStats.knownCost.toFixed(4);
  const previousText = previousStats.knownCost == null ? "the comparable prior period has unavailable spend" : "the comparable prior period was $" + previousStats.knownCost.toFixed(4);
  const changeText = change == null
    ? "change is unavailable because one period has incomplete pricing"
    : "change was " + (change >= 0 ? "+" : "") + "$" + change.toFixed(4) + (changePct == null ? "" : " (" + (changePct >= 0 ? "+" : "") + (changePct * 100).toFixed(1) + "%)");
  const top = aggregates.contributors;
  const topText = top.length > 0
    ? " Main contributors: " + top.slice(0, 3).map((item) => item.label + " " + (item.cost == null ? "unpriced" : "$" + item.cost.toFixed(4))).join(", ") + "."
    : "";
  const findingsText = findings.length > 0 ? " " + findings.length + " finding" + (findings.length === 1 ? "" : "s") + " need review." : " No eligible findings in this period.";
  const policyCount = policyActivity.warnings.length + policyActivity.refusals.length;
  const policyText = policyCount > 0
    ? " Policy activity: " + policyActivity.warnings.length + " warning" + (policyActivity.warnings.length === 1 ? "" : "s") + " and " + policyActivity.refusals.length + " refusal" + (policyActivity.refusals.length === 1 ? "" : "s") + "."
    : " No policy warning or refusal activity in this period.";
  const projectId = row.project_id ? String(row.project_id) : null;
  return {
    eventType: "weekly_summary",
    orgId: String(row.org_id),
    projectId,
    recipientUserId: String(row.user_id),
    preferenceProjectId: projectId,
    title: "Your CostKey spending summary",
    message: currentStats.observations + " canonical charges observed from " + window.startLabel + " through " + window.endLabel + "; " + currentText + ". " + previousText + "; " + changeText + "." + topText + findingsText + policyText,
    evidence: {
      calls: currentStats.observations,
      cost: currentStats.knownCost,
      previousCalls: previousStats.observations,
      previousCost: previousStats.knownCost,
      change,
      changePct,
      pricedCalls: currentStats.pricedObservations,
      unpricedCalls: currentStats.unpricedObservations,
      coverage: currentStats.coverage,
      previousPricedCalls: previousStats.pricedObservations,
      previousUnpricedCalls: previousStats.unpricedObservations,
      previousCoverage: previousStats.coverage,
      traceCount: currentStats.traceCount,
      previousTraceCount: previousStats.traceCount,
      projectCount: projectIds.length,
      contributors: top,
      findings: findings.map(findingEvidence),
      findingsCount: findings.length,
      ...policyActivityEvidence(policyActivity),
      basis: "canonical_observed",
      currency: "USD",
    },
    link: appLink("/overview", {
      from: window.start.toISOString(),
      to: window.end.toISOString(),
      project: projectId ?? undefined,
    }),
    occurredAt: now.toISOString(),
    scope: {
      scopeType: projectId ? "project" : "workspace",
      scopeId: projectId ?? "workspace",
      periodStart: window.start.toISOString(),
      periodEnd: window.end.toISOString(),
      projectCount: projectIds.length,
      timezone,
    },
    dedupeKey: "weekly_summary:" + (projectId ?? "workspace") + ":" + window.start.toISOString() + ":" + row.user_id,
  };
}

async function executionDigestPayload(pool: pg.Pool, row: PreferenceRow, now: Date, anchorAt = now): Promise<NotificationPayload | null> {
  const timezone = validTimeZone(row.timezone) ? String(row.timezone) : DEFAULT_TIMEZONE;
  const window = digestWindow(anchorAt, timezone);
  const projectIds = await projectsForPreference(pool, row);
  if (projectIds.length === 0) return null;
  const executions = await optionalRows(
    pool,
    `SELECT project_id, id, name, group_id, state, started_at, ended_at
     FROM executions
     WHERE project_id = ANY($1::text[])
       AND COALESCE(ended_at, started_at) >= $2
       AND COALESCE(ended_at, started_at) < $3
     ORDER BY COALESCE(ended_at, started_at) DESC
     LIMIT 100`,
    [projectIds, window.start.toISOString(), window.end.toISOString()],
  );
  if (executions.length === 0) return null;
  const aggregates = await aggregateChargesForProjects(
    pool,
    projectIds,
    window.start,
    window.end,
    localMidnightUtc(addCalendarDays(window.startLabel, -7), timezone),
    true,
  );
  const stats = aggregates.current;
  const projectId = row.project_id ? String(row.project_id) : null;
  return {
    eventType: "execution_receipt",
    orgId: String(row.org_id),
    projectId,
    recipientUserId: String(row.user_id),
    preferenceProjectId: projectId,
    title: "Your grouped-work CostKey digest",
    message: executions.length + " grouped execution" + (executions.length === 1 ? "" : "s") + " completed from " + window.startLabel + " through " + window.endLabel + "; " + (stats.knownCost == null ? "known spend is unavailable" : "known spend $" + stats.knownCost.toFixed(4)) + ".",
    evidence: {
      executionCount: executions.length,
      completedExecutions: executions.filter((execution) => execution.state === "completed").length,
      calls: stats.observations,
      cost: stats.knownCost,
      pricedCalls: stats.pricedObservations,
      unpricedCalls: stats.unpricedObservations,
      coverage: stats.coverage,
      basis: "canonical_observed",
      currency: "USD",
    },
    link: appLink("/traces", {
      from: window.start.toISOString(),
      to: window.end.toISOString(),
      project: projectId ?? undefined,
    }),
    occurredAt: now.toISOString(),
    scope: { scopeType: projectId ? "project" : "workspace", scopeId: projectId ?? "workspace", periodStart: window.start.toISOString(), periodEnd: window.end.toISOString() },
    dedupeKey: "execution_digest:" + (projectId ?? "workspace") + ":" + window.start.toISOString() + ":" + row.user_id,
  };
}

function findingNotificationCopy(row: Row): {
  title: string;
  message: string;
  evidence: Record<string, unknown>;
  scope: Record<string, unknown>;
  evidenceFingerprint: string;
} {
  const family = String(row.family ?? "");
  const scope = parseJsonObject(row.scope);
  const sourceEvidence = parseJsonObject(row.evidence);
  const baseline = parseJsonObject(row.baseline);
  const currentCost = finiteNumber(sourceEvidence.currentCost ?? sourceEvidence.traceCost);
  const previousCost = finiteNumber(sourceEvidence.previousCost ?? baseline.previousCost ?? baseline.medianCost);
  const currentUnitCost = finiteNumber(sourceEvidence.currentUnitCost);
  const previousUnitCost = finiteNumber(sourceEvidence.previousUnitCost ?? baseline.previousUnitCost);
  const relativeDifference = finiteNumber(sourceEvidence.relativeDifference);
  const absoluteDifference = finiteNumber(sourceEvidence.absoluteDifference);
  const currentPricingCoverage = finiteNumber(sourceEvidence.currentPricingCoverage);
  const currentAttributionCoverage = finiteNumber(sourceEvidence.currentAttributionCoverage);
  const highestRatio = finiteNumber(sourceEvidence.highestRatio);
  const traceId = typeof scope.traceId === "string"
    ? scope.traceId
    : typeof sourceEvidence.traceId === "string" ? sourceEvidence.traceId : null;
  let title = "A CostKey finding needs review";
  let message = "A material cost observation is outside its configured comparison threshold.";
  if (family === "expensive_trace") {
    title = "An expensive trace needs review";
    message = currentCost == null
      ? "A comparable trace exceeded its prior baseline; the exact amount is unavailable."
      : "A comparable trace cost $" + currentCost.toFixed(4) + (previousCost == null ? " and its prior baseline is unavailable." : " versus a prior baseline of $" + previousCost.toFixed(4) + ".");
  } else if (family === "increased_unit_cost") {
    title = "Cost per comparable trace increased";
    message = currentUnitCost == null || previousUnitCost == null
      ? "Cost per comparable trace increased; one comparison amount is unavailable."
      : "Cost per comparable trace moved from $" + previousUnitCost.toFixed(4) + " to $" + currentUnitCost.toFixed(4) + ".";
  } else if (family === "coverage_deterioration") {
    title = "Pricing or attribution coverage changed";
    const coverage = currentPricingCoverage ?? currentAttributionCoverage;
    message = coverage == null
      ? "Pricing or attribution coverage deteriorated; inspect the affected activity."
      : "Current eligible coverage is " + Math.round(coverage * 100) + "%. Inspect what became unavailable.";
  } else if (family === "allowance_trajectory") {
    title = "A spending allowance needs attention";
    message = highestRatio == null
      ? "A spending allowance crossed its notification threshold."
      : "Observed allowance usage reached " + Math.round(highestRatio * 100) + "%.";
  }
  return {
    title,
    message,
    evidence: {
      family,
      findingId: String(row.id),
      status: String(row.state ?? "new"),
      traceId,
      cost: currentCost,
      previousCost,
      change: absoluteDifference,
      changePct: relativeDifference,
      currentUnitCost,
      previousUnitCost,
      currentPricingCoverage,
      currentAttributionCoverage,
      pricingDrop: finiteNumber(sourceEvidence.pricingDrop),
      attributionDrop: finiteNumber(sourceEvidence.attributionDrop),
      highestRatio,
      basis: "structured_finding",
    },
    scope: { ...scope, findingId: String(row.id) },
    evidenceFingerprint: findingEvidenceFingerprint(row.family, row.scope, row.baseline, row.evidence),
  };
}

/**
 * Deliver persisted material findings from the hourly notification worker.
 * State is rechecked inside the outbox transaction, so an acknowledgement or
 * no-longer-outside transition that races this scan is suppressed.
 */
export async function runFindingNotifications(pool: pg.Pool, limit = 100): Promise<number> {
  const boundedLimit = Math.max(1, Math.min(1_000, Math.trunc(limit)));
  const rows = await optionalRows(
    pool,
    `SELECT f.id, f.project_id, f.family, f.scope, f.state, f.baseline, f.evidence,
            f.observed_at, f.last_seen_at, p.org_id
     FROM findings f
     JOIN projects p ON p.id = f.project_id
     WHERE f.state IN ('new', 'updated')
       AND f.family IN ('expensive_trace', 'increased_unit_cost', 'coverage_deterioration')
     ORDER BY f.last_seen_at DESC
     LIMIT $1`,
    [boundedLimit],
  );
  let attempted = 0;
  for (const row of rows) {
    const copy = findingNotificationCopy(row);
    const results = await dispatchFindingNotification(pool, {
      orgId: String(row.org_id),
      projectId: String(row.project_id),
      findingId: String(row.id),
      title: copy.title,
      message: copy.message,
      evidence: copy.evidence,
      scope: copy.scope,
      evidenceFingerprint: copy.evidenceFingerprint,
    });
    attempted += results.length;
  }
  return attempted;
}

export interface DailySummarySchedule {
  scheduledAt: Date;
  timezone: string;
  /** Local date the summary is sent on; it reports the day before. */
  dateLabel: string;
}

/**
 * Return today's scheduled instant once it has passed, else yesterday's.
 * Anchoring the reported day to that instant keeps the dedupe key stable
 * across hourly runs, restarts and a missed hour.
 */
export function dailySummarySchedule(
  now: Date,
  timezoneValue: unknown = DEFAULT_TIMEZONE,
  hourValue: unknown = DEFAULT_HOUR,
): DailySummarySchedule | null {
  const timezone = validTimeZone(timezoneValue) ? timezoneValue : DEFAULT_TIMEZONE;
  const hour = Number.isInteger(hourValue) && Number(hourValue) >= 0 && Number(hourValue) <= 23
    ? Number(hourValue)
    : DEFAULT_HOUR;
  let dateLabel = dateKey(zonedParts(now, timezone));
  let scheduledAt = localDateTimeUtc(dateLabel, hour, timezone);
  if (scheduledAt.getTime() > now.getTime()) {
    dateLabel = addCalendarDays(dateLabel, -1);
    scheduledAt = localDateTimeUtc(dateLabel, hour, timezone);
  }
  const elapsed = now.getTime() - scheduledAt.getTime();
  if (elapsed < 0 || elapsed >= 24 * 60 * 60 * 1_000) return null;
  return { scheduledAt, timezone, dateLabel };
}

interface RankedCost {
  label: string;
  cost: number | null;
  calls: number;
}

async function topModelsForProjects(pool: pg.Pool, projectIds: string[], from: Date, to: Date): Promise<RankedCost[]> {
  if (projectIds.length === 0) return [];
  const result = await pool.query(
    `${chargesCte()}
     SELECT COALESCE(NULLIF(c.model, ''), '(unknown)') AS label,
            COUNT(*)::int AS calls,
            COUNT(*) FILTER (WHERE c.cost_usd IS NOT NULL)::int AS priced_calls,
            SUM(c.cost_usd) FILTER (WHERE c.cost_usd IS NOT NULL) AS known_cost
     FROM charges c
     WHERE c.project_id = ANY($1::text[])
       AND c.timestamp >= $2 AND c.timestamp < $3
     GROUP BY 1
     ORDER BY known_cost DESC NULLS LAST, calls DESC, label
     LIMIT 3`,
    [projectIds, from.toISOString(), to.toISOString()],
  );
  return (result.rows as Row[]).map((row) => ({
    label: cleanText(row.label, 120),
    calls: Number(row.calls) || 0,
    cost: Number(row.priced_calls) > 0 ? finiteNumber(row.known_cost) : null,
  }));
}

interface BudgetUsage {
  policyId: string;
  projectId: string;
  name: string;
  unit: string;
  currency: string | null;
  allowance: number;
  observedUsage: number;
  ratio: number;
  windowKey: string;
}

/**
 * Calendar budgets at or above the threshold for the reported day (daily
 * budgets) or the month containing it (monthly budgets). Exposure matches the
 * policy warning worker: settled + reserved + observed.
 */
async function budgetsAtOrAbove(pool: pg.Pool, projectIds: string[], reportedAt: Date, threshold = 0.8): Promise<BudgetUsage[]> {
  if (projectIds.length === 0) return [];
  const policies = await optionalRows(
    pool,
    `SELECT id, project_id, name, unit, currency, allowance, window_kind, timezone
     FROM spending_policies
     WHERE project_id = ANY($1::text[])
       AND COALESCE(status, 'active') = 'active'
       AND window_kind IN ('calendar_day', 'calendar_month')`,
    [projectIds],
  );
  if (policies.length === 0) return [];
  const keys = policies.map((policy) => {
    const parts = zonedParts(reportedAt, validTimeZone(policy.timezone) ? String(policy.timezone) : DEFAULT_TIMEZONE);
    return policy.window_kind === "calendar_month" ? dateKey(parts).slice(0, 7) : dateKey(parts);
  });
  const usage = await optionalRows(
    pool,
    `SELECT u.policy_id, u.window_key, u.settled_quantity, u.reserved_quantity, u.observed_quantity
     FROM policy_window_usage u
     JOIN unnest($1::text[], $2::text[]) AS wanted(policy_id, window_key)
       ON wanted.policy_id = u.policy_id AND wanted.window_key = u.window_key`,
    [policies.map((policy) => String(policy.id)), keys],
  );
  const byPolicy = new Map(usage.map((row) => [String(row.policy_id), row]));
  const results: BudgetUsage[] = [];
  policies.forEach((policy, index) => {
    const row = byPolicy.get(String(policy.id));
    if (!row) return;
    const exposure = (Number(row.settled_quantity) || 0) + (Number(row.reserved_quantity) || 0) + (Number(row.observed_quantity) || 0);
    const allowance = Number(policy.allowance);
    if (!Number.isFinite(allowance) || allowance < 0) return;
    const ratio = allowance === 0 ? (exposure > 0 ? 1 : 0) : exposure / allowance;
    if (ratio < threshold) return;
    results.push({
      policyId: String(policy.id),
      projectId: String(policy.project_id),
      name: cleanText(policy.name || policy.id, 120),
      unit: cleanText(policy.unit, 20),
      currency: typeof policy.currency === "string" ? policy.currency : null,
      allowance,
      observedUsage: exposure,
      ratio,
      windowKey: keys[index],
    });
  });
  return results.sort((a, b) => b.ratio - a.ratio).slice(0, 5);
}

function rankedText(items: Array<{ label: string; cost: number | null }>): string {
  return items.map((item) => item.label + " " + (formatUsd(item.cost) ?? "unpriced")).join(", ");
}

async function dailyPayload(pool: pg.Pool, row: PreferenceRow, now: Date, schedule: DailySummarySchedule): Promise<NotificationPayload | null> {
  const timezone = schedule.timezone;
  const reportedLabel = addCalendarDays(schedule.dateLabel, -1);
  const dayStart = localMidnightUtc(reportedLabel, timezone);
  const dayEnd = localMidnightUtc(schedule.dateLabel, timezone);
  const previousStart = localMidnightUtc(addCalendarDays(reportedLabel, -1), timezone);
  const projectIds = await projectsForPreference(pool, row);
  if (projectIds.length === 0) return null;
  const [aggregates, models, budgets] = await Promise.all([
    aggregateChargesForProjects(pool, projectIds, dayStart, dayEnd, previousStart),
    topModelsForProjects(pool, projectIds, dayStart, dayEnd),
    budgetsAtOrAbove(pool, projectIds, new Date(dayEnd.getTime() - 1)),
  ]);
  const current = aggregates.current;
  const previous = aggregates.previous;
  if (current.observations === 0 && previous.observations === 0 && budgets.length === 0) return null;
  const change = current.knownCost != null && previous.knownCost != null ? current.knownCost - previous.knownCost : null;
  const changePct = change != null && previous.knownCost != null && previous.knownCost !== 0 ? change / previous.knownCost : null;
  const features = aggregates.contributors.slice(0, 3).map((item) => ({ label: item.label, cost: item.cost, calls: item.observations }));
  const projectId = row.project_id ? String(row.project_id) : null;
  const parts = [
    (formatUsd(current.knownCost) ?? "Unpriced spend") + " yesterday"
      + (previous.knownCost == null ? "" : ", " + (formatPct(changePct) ?? ((change ?? 0) > 0 ? "+" : "") + (formatUsd(change) ?? "")) + " vs " + formatUsd(previous.knownCost)) + ".",
  ];
  if (features.length > 0) parts.push("Top features: " + rankedText(features) + ".");
  if (models.length > 0) parts.push("Top models: " + rankedText(models) + ".");
  if (budgets.length > 0) parts.push(budgets.length + " budget" + (budgets.length === 1 ? "" : "s") + " over 80%: " + budgets.slice(0, 3).map((budget) => budget.name + " " + Math.round(budget.ratio * 100) + "%").join(", ") + ".");
  if (current.unpricedObservations > 0) parts.push(current.unpricedObservations + " unpriced call" + (current.unpricedObservations === 1 ? "" : "s") + ".");
  return {
    eventType: "daily_summary",
    orgId: String(row.org_id),
    projectId,
    recipientUserId: String(row.user_id),
    preferenceProjectId: projectId,
    title: "Daily spend · " + reportedLabel,
    message: parts.join(" "),
    evidence: {
      cost: current.knownCost,
      previousCost: previous.knownCost,
      change,
      changePct,
      calls: current.observations,
      previousCalls: previous.observations,
      pricedCalls: current.pricedObservations,
      unpricedCalls: current.unpricedObservations,
      contributors: features,
      models,
      budgets: budgets.map((budget) => ({
        policyId: budget.policyId,
        projectId: budget.projectId,
        name: budget.name,
        unit: budget.unit,
        currency: budget.currency,
        allowance: budget.allowance,
        observedUsage: budget.observedUsage,
        ratio: budget.ratio,
        windowKey: budget.windowKey,
        link: appLink("/budgets/" + encodeURIComponent(budget.policyId), { project: budget.projectId }),
      })),
      projectCount: projectIds.length,
      basis: "canonical_observed",
      currency: "USD",
    },
    link: appLink("/overview", {
      from: dayStart.toISOString(),
      to: dayEnd.toISOString(),
      project: projectId ?? undefined,
    }),
    occurredAt: now.toISOString(),
    scope: {
      scopeType: projectId ? "project" : "workspace",
      scopeId: projectId ?? "workspace",
      periodStart: dayStart.toISOString(),
      periodEnd: dayEnd.toISOString(),
      projectCount: projectIds.length,
      timezone,
    },
    dedupeKey: "daily_summary:" + (projectId ?? "workspace") + ":" + dayStart.toISOString() + ":" + row.user_id,
  };
}

/** Send due daily summaries; idempotent per recipient, scope and reported day. */
export async function runDailySummaries(pool: pg.Pool, now = new Date()): Promise<number> {
  const due = await pool.query(
    `SELECT np.*, u.email, u.name, u.role
     FROM notification_preferences np
     JOIN users u ON u.id = np.user_id AND u.org_id = np.org_id
     WHERE np.daily_summary_enabled = TRUE`,
  );
  let attempted = 0;
  for (const row of due.rows as PreferenceRow[]) {
    const schedule = dailySummarySchedule(now, row.timezone, row.daily_summary_hour);
    if (!schedule) continue;
    const payload = await dailyPayload(pool, row, now, schedule);
    if (!payload) continue;
    const results = await dispatchNotification(pool, payload);
    attempted += results.length;
  }
  return attempted;
}

export async function runWeeklyDigests(pool: pg.Pool, now = new Date()): Promise<number> {
  await ensureNotificationSchema(pool).catch((error) => console.error("[costkey] Notification schema error:", error));
  let attempted = await retryNotificationDeliveries(pool, now).catch(() => 0);
  attempted += await runFindingNotifications(pool).catch(() => 0);
  const due = await pool.query(
    `SELECT np.*, u.email, u.name, u.role
     FROM notification_preferences np
     JOIN users u ON u.id = np.user_id AND u.org_id = np.org_id
     WHERE np.weekly_summary_enabled = TRUE`,
  );
  for (const row of due.rows as PreferenceRow[]) {
    const schedule = preferenceDue(row, now);
    if (!schedule) continue;
    const payload = await weeklyPayload(pool, row, now, schedule.scheduledAt);
    if (!payload) continue;
    const results = await dispatchNotification(pool, payload);
    attempted += results.length;
  }

  const executionDue = await pool.query(
    `SELECT np.*, u.email, u.name, u.role
     FROM notification_preferences np
     JOIN users u ON u.id = np.user_id AND u.org_id = np.org_id
     WHERE np.execution_receipts_enabled = TRUE`,
  );
  for (const row of executionDue.rows as PreferenceRow[]) {
    const schedule = preferenceDue(row, now);
    if (!schedule) continue;
    const payload = await executionDigestPayload(pool, row, now, schedule.scheduledAt);
    if (!payload) continue;
    const results = await dispatchNotification(pool, payload);
    attempted += results.length;
  }
  // Daily summaries share the hourly worker so index.ts keeps one scheduler.
  attempted += await runDailySummaries(pool, now).catch((error) => {
    console.error("[costkey] Daily summary error:", error);
    return 0;
  });
  return attempted;
}

export interface PolicyWarningNotification {
  orgId: string;
  projectId: string;
  policyId: string;
  threshold: number;
  windowKey: string;
  allowance: number;
  observedUsage: number;
  link?: string;
}

export async function dispatchPolicyWarning(pool: pg.Pool, input: PolicyWarningNotification): Promise<WebhookDeliveryResult[]> {
  return dispatchNotification(pool, {
    eventType: "policy_warning",
    orgId: input.orgId,
    projectId: input.projectId,
    title: "Allowance warning at " + Math.round(input.threshold * 100) + "%",
    message: "Policy " + input.policyId + " has observed " + input.observedUsage + " of " + input.allowance + " in window " + input.windowKey + ".",
    evidence: {
      policyId: input.policyId,
      threshold: input.threshold,
      allowance: input.allowance,
      observedUsage: input.observedUsage,
      status: "warning",
      basis: "observed",
    },
    link: input.link ?? appLink("/budgets/" + encodeURIComponent(input.policyId), { project: input.projectId }),
    scope: { policyId: input.policyId, threshold: input.threshold, windowKey: input.windowKey },
    occurredAt: new Date().toISOString(),
    dedupeKey: "policy_warning:" + input.projectId + ":" + input.policyId + ":" + input.threshold + ":" + input.windowKey,
  });
}

export interface EnforcementNotification {
  orgId: string;
  projectId: string;
  policyId: string;
  traceId?: string | null;
  reason: string;
  message?: string;
  windowKey?: string | null;
  link?: string;
}

export async function dispatchEnforcementNotification(pool: pg.Pool, input: EnforcementNotification): Promise<WebhookDeliveryResult[]> {
  return dispatchNotification(pool, {
    eventType: "enforcement",
    orgId: input.orgId,
    projectId: input.projectId,
    title: "A CostKey policy refused a call",
    message: input.message ?? "Policy " + input.policyId + " refused further matching work (" + input.reason + ").",
    evidence: { policyId: input.policyId, traceId: input.traceId ?? null, status: "refused", reason: input.reason, basis: "policy_decision" },
    link: input.link ?? appLink("/budgets", { project: input.projectId, policy: input.policyId }),
    scope: { policyId: input.policyId, traceId: input.traceId ?? null, reason: input.reason, windowKey: input.windowKey ?? null },
    occurredAt: new Date().toISOString(),
  });
}

export interface FindingNotification {
  orgId: string;
  projectId: string;
  findingId: string;
  title: string;
  message: string;
  evidence?: Record<string, unknown>;
  scope?: Record<string, unknown>;
  evidenceFingerprint?: string;
  link?: string;
}

export async function dispatchFindingNotification(pool: pg.Pool, input: FindingNotification): Promise<WebhookDeliveryResult[]> {
  return dispatchNotification(pool, {
    eventType: "finding",
    orgId: input.orgId,
    projectId: input.projectId,
    title: input.title,
    message: input.message,
    evidence: { ...(input.evidence ?? {}), findingId: input.findingId },
    link: input.link ?? appLink("/findings/" + encodeURIComponent(input.findingId), { project: input.projectId }),
    scope: { ...(input.scope ?? {}), findingId: input.findingId },
    occurredAt: new Date().toISOString(),
    dedupeKey: "finding:" + input.projectId + ":" + input.findingId + ":" + (
      input.evidenceFingerprint
      ?? findingEvidenceFingerprint("finding", input.scope, null, input.evidence)
    ),
  });
}

function publicDestination(row: DestinationRow): Record<string, unknown> {
  const { secret_ciphertext: _secret, ...rest } = row;
  void _secret;
  if (row.kind === "slack" && isSlackWebhookUrl(row.address)) return { ...rest, address: maskSlackWebhookUrl(row.address) };
  return rest;
}

export function createNotificationsRouter(pool: pg.Pool): Router {
  const router = createRouter();
  router.use("/api", requireAuth);
  router.use("/api/v1/notifications", (_req, _res, next) => {
    ensureNotificationSchema(pool).then(() => next(), (error) => {
      console.error("[costkey] Notification schema error:", error);
      next();
    });
  });

  router.get("/api/v1/notifications/preferences", async (req: Request, res: Response) => {
    try {
      const user = (req as Request & { user?: SavedViewPreferenceUser }).user;
      if (!user) { res.status(401).json({ error: "Authentication required" }); return; }
      const projectId = typeof req.query.projectId === "string" ? req.query.projectId : null;
      if (projectId && !await canAccessProject(pool, user, projectId)) { res.status(404).json({ error: "Project not found" }); return; }
      const existing = await pool.query(
        `SELECT *
         FROM notification_preferences
         WHERE org_id = $1 AND user_id = $2 AND project_id IS NOT DISTINCT FROM $3
         LIMIT 1`,
        [user.orgId, user.id, projectId],
      );
      const row = existing.rows[0] as PreferenceRow | undefined;
      res.json({
        preferences: preferenceResponse(row ?? defaultPreferenceRow(user, projectId), Boolean(row)),
        policySilenceDoesNotDisableEnforcement: true,
        weeklySummaryRequiresExplicitPreference: true,
        weeklySummaryOffered: true,
      });
    } catch (error) {
      console.error("[costkey] Notification preference read error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.patch("/api/v1/notifications/preferences", async (req: Request, res: Response) => {
    try {
      const user = (req as Request & { user?: SavedViewPreferenceUser }).user;
      if (!user) { res.status(401).json({ error: "Authentication required" }); return; }
      if (req.body?.projectId !== undefined && req.body?.projectId !== null && typeof req.body.projectId !== "string") {
        res.status(400).json({ error: "projectId must be a string or null" }); return;
      }
      const projectId = typeof req.body?.projectId === "string" ? req.body.projectId : null;
      if (projectId && !await canAccessProject(pool, user, projectId)) { res.status(404).json({ error: "Project not found" }); return; }
      const validators: Array<[string, (value: unknown) => boolean]> = [
        ["weeklySummaryEnabled", (value) => typeof value === "boolean"],
        ["findingsEnabled", (value) => typeof value === "boolean"],
        ["enforcementEnabled", (value) => typeof value === "boolean"],
        ["executionReceiptsEnabled", (value) => typeof value === "boolean"],
        ["dailySummaryEnabled", (value) => typeof value === "boolean"],
        ["budgetAlertsEnabled", (value) => typeof value === "boolean"],
        ["timezone", validTimeZone],
        ["weeklySummaryHour", (value) => Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 23],
        ["dailySummaryHour", (value) => Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 23],
        ["weeklySummaryWeekday", (value) => Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 6],
        ["policyWarningThresholds", (value) => Array.isArray(value) && value.length > 0 && value.length <= 8 && value.every((item) => typeof item === "number" && Number.isFinite(item) && item > 0 && item <= 1)],
      ];
      for (const [key, valid] of validators) {
        if (req.body?.[key] !== undefined && !valid(req.body[key])) {
          res.status(400).json({ error: "Invalid " + key });
          return;
        }
      }
      const columns: Array<[string, string]> = [
        ["weeklySummaryEnabled", "weekly_summary_enabled"],
        ["findingsEnabled", "findings_enabled"],
        ["enforcementEnabled", "enforcement_enabled"],
        ["executionReceiptsEnabled", "execution_receipts_enabled"],
        ["dailySummaryEnabled", "daily_summary_enabled"],
        ["budgetAlertsEnabled", "budget_alerts_enabled"],
        ["timezone", "timezone"],
        ["weeklySummaryHour", "weekly_summary_hour"],
        ["dailySummaryHour", "daily_summary_hour"],
        ["weeklySummaryWeekday", "weekly_summary_weekday"],
        ["policyWarningThresholds", "policy_warning_thresholds"],
      ];
      const updates: string[] = [];
      const params: unknown[] = [];
      const overrides: Record<string, unknown> = {};
      let index = 1;
      for (const [key, column] of columns) {
        if (req.body?.[key] === undefined) continue;
        updates.push(column + " = $" + index++);
        params.push(req.body[key]);
        overrides[key] = req.body[key];
      }
      if (updates.length === 0) { res.status(400).json({ error: "Nothing to update" }); return; }
      await ensurePreferences(pool, user, projectId, overrides);
      if (req.body?.enforcementEnabled !== undefined && req.body?.budgetAlertsEnabled === undefined) {
        // Refusals used to gate budget warnings too. Pin the inherited value
        // before changing refusals so the two switches stay independent.
        await pool.query(
          `UPDATE notification_preferences
           SET budget_alerts_enabled = COALESCE(budget_alerts_enabled, enforcement_enabled)
           WHERE org_id = $1 AND user_id = $2 AND project_id IS NOT DISTINCT FROM $3`,
          [user.orgId, user.id, projectId],
        );
      }
      params.push(user.orgId, user.id, projectId);
      await pool.query(
        "UPDATE notification_preferences SET " + updates.join(", ") + ", updated_at = NOW() WHERE org_id = $" + index++ + " AND user_id = $" + index++ + " AND project_id IS NOT DISTINCT FROM $" + index,
        params,
      );
      const row = await ensurePreferences(pool, user, projectId);
      res.json({
        preferences: preferenceResponse(row, true),
        policySilenceDoesNotDisableEnforcement: true,
        weeklySummaryRequiresExplicitPreference: true,
        weeklySummaryOffered: true,
      });
    } catch (error) {
      console.error("[costkey] Notification preference update error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.get("/api/v1/notifications/destinations", async (req: Request, res: Response) => {
    try {
      const user = (req as Request & { user?: SavedViewPreferenceUser }).user;
      if (!user) { res.status(401).json({ error: "Authentication required" }); return; }
      const result = await pool.query(
        `SELECT id, org_id, project_id, owner_user_id, kind, address, event_types, enabled,
                last_delivery_at, last_error, created_at, updated_at
         FROM notification_destinations
         WHERE org_id = $1 AND (owner_user_id = $2 OR $3 IN ('owner', 'admin'))
         ORDER BY created_at DESC`,
        [user.orgId, user.id, normalizeRole(user.role)],
      );
      res.json({ destinations: (result.rows as DestinationRow[]).map(publicDestination) });
    } catch (error) {
      console.error("[costkey] Notification destination list error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.post("/api/v1/notifications/destinations", async (req: Request, res: Response) => {
    try {
      const user = (req as Request & { user?: SavedViewPreferenceUser }).user;
      if (!user) { res.status(401).json({ error: "Authentication required" }); return; }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const kind = body.kind === "webhook" ? "webhook" : body.kind === "email" ? "email" : body.kind === "slack" ? "slack" : null;
      const address = typeof body.address === "string" ? body.address.trim() : "";
      if (!kind || !address) { res.status(400).json({ error: "kind and address are required" }); return; }
      if (kind === "webhook" && !roleCanManageWorkspace(user.role)) { res.status(403).json({ error: "Only owners and admins can manage workspace webhooks" }); return; }
      if (kind === "slack" && !roleCanManageWorkspace(user.role)) { res.status(403).json({ error: "Only owners and admins can manage Slack destinations" }); return; }
      if (kind === "slack" && !isSlackWebhookUrl(address)) {
        res.status(400).json({ error: "Use a Slack incoming webhook URL (https://hooks.slack.com/services/...)" }); return;
      }
      if (kind === "webhook" && !(process.env["COSTKEY_NOTIFICATION_SINK"] === "memory" || !externalDeliveryAllowed() ? isSafeWebhookSyntax(address) : await resolvesSafeWebhookTarget(address))) {
        res.status(400).json({ error: "Webhook URL is invalid or targets a private host" }); return;
      }
      if (kind === "email" && !validEmailAddress(address)) {
        res.status(400).json({ error: "Email destination is invalid" }); return;
      }
      if (kind === "email" && !roleCanManageWorkspace(user.role) && address.toLowerCase() !== String(user.email ?? "").toLowerCase()) {
        res.status(403).json({ error: "Members can only configure their own email destination" }); return;
      }
      const projectId = typeof body.projectId === "string" ? body.projectId : null;
      if (projectId && !await canAccessProject(pool, user, projectId)) { res.status(404).json({ error: "Project not found" }); return; }
      const secret = kind === "webhook" && typeof body.secret === "string" ? body.secret : undefined;
      if (kind === "webhook" && (!secret || secret.length < 16 || secret.length > 4_096)) { res.status(400).json({ error: "Webhook secret must be between 16 and 4096 characters" }); return; }
      // A Slack incoming-webhook URL is itself the credential: it is stored
      // encrypted like a webhook signing secret and only a mask is kept in
      // the address column that the API returns.
      const encryptedSecret = kind === "slack" ? encryptSecret(address) : secret ? encryptSecret(secret) : null;
      if ((kind === "webhook" || kind === "slack") && !encryptedSecret) { res.status(503).json({ error: "Secret storage is not configured" }); return; }
      const storedAddress = kind === "slack" ? maskSlackWebhookUrl(address) : address;
      const id = randomId("dest");
      const eventTypes = validateEventTypes(body.eventTypes);
      if (eventTypes.length === 0) { res.status(400).json({ error: "eventTypes must contain supported notification types" }); return; }
      const result = await pool.query(
        `INSERT INTO notification_destinations(id, org_id, project_id, owner_user_id, kind, address, secret_ciphertext, event_types)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text[])
         RETURNING id, org_id, project_id, owner_user_id, kind, address, event_types, enabled, last_delivery_at, last_error, created_at, updated_at`,
        [id, user.orgId, projectId, user.id, kind, storedAddress, encryptedSecret, eventTypes],
      );
      res.status(201).json({ destination: publicDestination(result.rows[0] as DestinationRow) });
    } catch (error) {
      console.error("[costkey] Notification destination create error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.delete("/api/v1/notifications/destinations/:destinationId", async (req: Request, res: Response) => {
    try {
      const user = (req as Request & { user?: SavedViewPreferenceUser }).user;
      if (!user) { res.status(401).json({ error: "Authentication required" }); return; }
      const result = await pool.query(
        `DELETE FROM notification_destinations
         WHERE id = $1 AND org_id = $2 AND (owner_user_id = $3 OR $4 IN ('owner', 'admin'))`,
        [req.params.destinationId, user.orgId, user.id, normalizeRole(user.role)],
      );
      if ((result.rowCount ?? 0) === 0) { res.status(404).json({ error: "Destination not found" }); return; }
      res.json({ ok: true });
    } catch (error) {
      console.error("[costkey] Notification destination delete error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.post("/api/v1/notifications/destinations/:destinationId/test", async (req: Request, res: Response) => {
    try {
      const user = (req as Request & { user?: SavedViewPreferenceUser }).user;
      if (!user) { res.status(401).json({ error: "Authentication required" }); return; }
      const result = await pool.query(
        `SELECT * FROM notification_destinations
         WHERE id = $1 AND org_id = $2 AND (owner_user_id = $3 OR $4 IN ('owner', 'admin'))`,
        [req.params.destinationId, user.orgId, user.id, normalizeRole(user.role)],
      );
      const destination = result.rows[0] as DestinationRow | undefined;
      if (!destination) { res.status(404).json({ error: "Destination not found" }); return; }
      const deliveryId = randomId("delivery");
      const deliveryPayload = sanitizedPayload({
        eventType: "weekly_summary", orgId: user.orgId, title: "CostKey channel test",
        message: "This is an explicit CostKey channel test. No policy or preference was changed.",
        occurredAt: new Date().toISOString(),
      });
      const client = await pool.connect();
      let delivery: WebhookDeliveryResult;
      try {
        await client.query("BEGIN");
        const authorized = await loadAuthorizedDestination(client, {
          eventType: "weekly_summary",
          orgId: user.orgId,
          projectId: destination.project_id,
          title: "CostKey channel test",
          message: "This is an explicit CostKey channel test.",
          recipientUserId: user.id,
        }, destination.id, user.orgId, user.id);
        if (!authorized) {
          await client.query("ROLLBACK");
          res.status(403).json({ error: "Destination is no longer authorized" });
          return;
        }
        delivery = await deliverDestinationSafe(authorized, deliveryPayload, deliveryId);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
      res.status(delivery.status === "failed" ? 502 : delivery.status === "suppressed" ? 503 : 200).json({ delivery });
    } catch (error) {
      console.error("[costkey] Notification test error:", error);
      res.status(500).json({ error: "Notification test failed" });
    }
  });

  router.get("/api/v1/notifications/deliveries", async (req: Request, res: Response) => {
    try {
      const user = (req as Request & { user?: SavedViewPreferenceUser }).user;
      if (!user) { res.status(401).json({ error: "Authentication required" }); return; }
      const result = await pool.query(
        `SELECT nd.id, nd.event_type, nd.scope_type, nd.scope_id, nd.status,
                nd.attempt_count, nd.last_error, nd.sent_at, nd.created_at,
                nd.destination_id
         FROM notification_deliveries nd
         WHERE nd.org_id = $1
           AND ($2 IN ('owner', 'admin') OR nd.user_id = $3 OR EXISTS (
             SELECT 1 FROM notification_destinations d
             WHERE d.id = nd.destination_id AND d.owner_user_id = $3
           ))
         ORDER BY nd.created_at DESC LIMIT 100`,
        [user.orgId, normalizeRole(user.role), user.id],
      );
      res.json({ deliveries: result.rows });
    } catch (error) {
      console.error("[costkey] Notification delivery list error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}
