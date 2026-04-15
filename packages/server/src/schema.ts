import { pgTable, text, integer, boolean, doublePrecision, bigint, timestamp, jsonb, primaryKey, uniqueIndex, index } from "drizzle-orm/pg-core";

export const orgs = pgTable("orgs", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash"),
  name: text("name").notNull(),
  orgId: text("org_id").notNull().references(() => orgs.id),
  role: text("role").notNull().default("member"),
  githubId: text("github_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const projects = pgTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  orgId: text("org_id").notNull().references(() => orgs.id),
  authKey: text("auth_key").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const events = pgTable("events", {
  id: text("id").primaryKey(),
  timestamp: timestamp("timestamp", { withTimezone: true }).notNull(),
  projectId: text("project_id").notNull(),
  provider: text("provider").notNull(),
  model: text("model"),
  url: text("url"),
  method: text("method"),
  statusCode: integer("status_code"),

  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  totalTokens: integer("total_tokens"),
  reasoningTokens: integer("reasoning_tokens"),
  cacheReadTokens: integer("cache_read_tokens"),
  cacheCreationTokens: integer("cache_creation_tokens"),

  costUsd: doublePrecision("cost_usd"),
  durationMs: doublePrecision("duration_ms"),
  streaming: boolean("streaming").default(false),

  ttft: doublePrecision("ttft"),
  tps: doublePrecision("tps"),
  streamDuration: doublePrecision("stream_duration"),
  chunkCount: integer("chunk_count"),

  callSiteRaw: text("call_site_raw"),
  callSiteFrames: jsonb("call_site_frames"),

  traceId: text("trace_id"),
  traceName: text("trace_name"),
  context: jsonb("context"),
  requestBody: jsonb("request_body"),
  responseBody: jsonb("response_body"),

  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (t) => [
  index("idx_events_project_ts").on(t.projectId, t.timestamp),
  index("idx_events_project_model").on(t.projectId, t.model),
  index("idx_events_trace").on(t.projectId, t.traceId),
]);

export const callSiteStats = pgTable("call_site_stats", {
  projectId: text("project_id").notNull(),
  callSiteKey: text("call_site_key").notNull(),
  fileName: text("file_name"),
  functionName: text("function_name"),
  lineNumber: integer("line_number"),
  provider: text("provider"),
  model: text("model"),

  totalCalls: integer("total_calls").default(0),
  totalCostUsd: doublePrecision("total_cost_usd").default(0),
  totalInputTokens: bigint("total_input_tokens", { mode: "number" }).default(0),
  totalOutputTokens: bigint("total_output_tokens", { mode: "number" }).default(0),
  avgDurationMs: doublePrecision("avg_duration_ms").default(0),
  avgTtft: doublePrecision("avg_ttft"),
  avgTps: doublePrecision("avg_tps"),

  firstSeen: timestamp("first_seen", { withTimezone: true }),
  lastSeen: timestamp("last_seen", { withTimezone: true }),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.callSiteKey, t.model] }),
  index("idx_callsite_cost").on(t.projectId, t.totalCostUsd),
]);

export const teamInvites = pgTable("team_invites", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => orgs.id),
  email: text("email").notNull(),
  role: text("role").notNull().default("member"),
  invitedBy: text("invited_by").notNull().references(() => users.id),
  token: text("token").notNull().unique(),
  // status ∈ { pending, accepted, expired, revoked }
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  acceptedBy: text("accepted_by").references(() => users.id),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  revokedBy: text("revoked_by").references(() => users.id),
  resentCount: integer("resent_count").notNull().default(0),
  lastResentAt: timestamp("last_resent_at", { withTimezone: true }),
});

export const alerts = pgTable("alerts", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => orgs.id),
  projectId: text("project_id").references(() => projects.id),
  type: text("type").notNull(),
  threshold: doublePrecision("threshold"),
  channel: text("channel").notNull().default("webhook"),
  webhookUrl: text("webhook_url"),
  enabled: boolean("enabled").default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const customProviders = pgTable("custom_providers", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  hostname: text("hostname").notNull(),
  usageInputPath: text("usage_input_path").default("usage.prompt_tokens"),
  usageOutputPath: text("usage_output_path").default("usage.completion_tokens"),
  modelPath: text("model_path").default("model"),
  enabled: boolean("enabled").default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (t) => [
  index("idx_custom_providers_project").on(t.projectId),
]);

export const frameStats = pgTable("frame_stats", {
  projectId: text("project_id").notNull(),
  fileName: text("file_name").notNull(),
  functionName: text("function_name").notNull(),
  totalSeen: integer("total_seen").notNull().default(0),
  positionSum: integer("position_sum").notNull().default(0),
  stackDepthSum: integer("stack_depth_sum").notNull().default(0),
  cooccurKeys: jsonb("cooccur_keys").notNull().default([]),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.fileName, t.functionName] }),
  index("idx_frame_stats_project").on(t.projectId),
]);

export const frameStatsCallsites = pgTable("frame_stats_callsites", {
  projectId: text("project_id").notNull(),
  fileName: text("file_name").notNull(),
  functionName: text("function_name").notNull(),
  callSiteKey: text("call_site_key").notNull(),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.fileName, t.functionName, t.callSiteKey] }),
]);

export const alertHistory = pgTable("alert_history", {
  id: text("id").primaryKey(),
  alertId: text("alert_id").notNull().references(() => alerts.id),
  triggeredAt: timestamp("triggered_at", { withTimezone: true }).defaultNow(),
  value: doublePrecision("value"),
  message: text("message"),
});
