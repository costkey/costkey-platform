import { pgTable, text, integer, boolean, doublePrecision, bigint, timestamp, date, jsonb, primaryKey, uniqueIndex, index } from "drizzle-orm/pg-core";

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
  description: text("description"),
  orgId: text("org_id").notNull().references(() => orgs.id),
  authKey: text("auth_key").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const events = pgTable("events", {
  id: text("id").notNull(),
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
  release: text("release"),
  blFunction: text("bl_function"),
  blFile: text("bl_file"),
  blLine: integer("bl_line"),
  /** Provenance for the feature label; never infer this from the label alone. */
  featureSource: text("feature_source").notNull().default("unknown"),
  featureMappingId: text("feature_mapping_id"),
  featureMappingActionId: text("feature_mapping_action_id"),
  featureOriginal: text("feature_original"),
  metadata: jsonb("metadata"),
  systemPrompt: text("system_prompt"),
  requestBody: jsonb("request_body"),
  responseBody: jsonb("response_body"),
  /** Provider-reported image output token breakdown when available. */
  imageOutputTokens: integer("image_output_tokens"),

  // Accounting/lifecycle fields. All are nullable so old SDK envelopes remain
  // valid and can be reprocessed without inventing lifecycle success.
  eventType: text("event_type").notNull().default("call"),
  source: text("source").notNull().default("auto"),
  entityType: text("entity_type"),
  entityId: text("entity_id"),
  sequence: integer("sequence"),
  requestModel: text("request_model"),
  attemptId: text("attempt_id"),
  parentEventId: text("parent_event_id"),
  chargeId: text("charge_id"),
  componentId: text("component_id"),
  executionId: text("execution_id"),
  groupId: text("group_id"),
  groupName: text("group_name"),
  groupKind: text("group_kind"),
  phase: text("phase"),
  configuration: jsonb("configuration"),
  datasetRevision: text("dataset_revision"),
  caseId: text("case_id"),
  lifecycleState: text("lifecycle_state"),
  lifecycleAt: timestamp("lifecycle_at", { withTimezone: true }),
  lifecycleErrorType: text("lifecycle_error_type"),
  usageEvent: jsonb("usage_event"),
  costBasis: text("cost_basis").notNull().default("unknown"),
  costSource: text("cost_source"),
  pricingId: text("pricing_id"),
  pricingDate: timestamp("pricing_date", { withTimezone: true }),
  costCurrency: text("cost_currency").notNull().default("USD"),
  unitKind: text("unit_kind"),
  unitValue: doublePrecision("unit_value"),
  unit: text("unit"),
  aggregation: text("aggregation"),
  revision: integer("revision"),
  contentStatus: text("content_status").notNull().default("unknown"),

  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.id] }),
  index("idx_events_project_ts").on(t.projectId, t.timestamp),
  index("idx_events_project_model").on(t.projectId, t.model),
  index("idx_events_trace").on(t.projectId, t.traceId),
  index("idx_events_execution").on(t.projectId, t.executionId),
  index("idx_events_charge").on(t.projectId, t.chargeId),
]);

export const sourcemaps = pgTable("sourcemaps", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  release: text("release").notNull(),
  fileName: text("file_name").notNull(),
  sourcemapJson: text("sourcemap_json").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (t) => [
  uniqueIndex("sourcemaps_project_id_release_file_name_key").on(t.projectId, t.release, t.fileName),
  index("idx_sourcemaps_lookup").on(t.projectId, t.release),
]);

export const callGraphs = pgTable("call_graphs", {
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  uploadedAt: timestamp("uploaded_at", { withTimezone: true }).defaultNow(),
  graphData: jsonb("graph_data").notNull(),
  sdkVersion: text("sdk_version"),
}, (t) => [
  primaryKey({ columns: [t.projectId] }),
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
  pricedCalls: integer("priced_calls").notNull().default(0),
  unpricedCalls: integer("unpriced_calls").notNull().default(0),
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
  projectIds: text("project_ids").array(),
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

// ── Budget rules ─────────────────────────────────────────────────────
// A project can have N rules. Each rule has a scope (NULL fields match all)
// and caps. A call must satisfy EVERY matching rule (most-restrictive wins).
// onExceed is surfaced to the SDK so it can enforce locally.
export const budgetRules = pgTable("budget_rules", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  // Human-readable label, e.g. "Opus prod cap"
  name: text("name"),
  // ── Scope filters (NULL = match all) ───────────────────────────────
  // Glob on event.model, e.g. "claude-opus*", "gpt-4o", "gemini-*"
  scopeModel: text("scope_model"),
  // Glob on event.bl_file or bl_function. Matched against the concatenation
  // "<bl_file>:<bl_function>". e.g. "generateReport*", "src/billing/*"
  scopeFunction: text("scope_function"),
  // ── Caps ───────────────────────────────────────────────────────────
  dailyUsd: doublePrecision("daily_usd"),
  monthlyUsd: doublePrecision("monthly_usd"),
  callsPerMinute: integer("calls_per_minute"),
  tokensPerMinute: integer("tokens_per_minute"),
  // ── Policy + alerts ────────────────────────────────────────────────
  onExceed: text("on_exceed").notNull().default("warn"),
  alertEmail: text("alert_email"),
  alertWebhookUrl: text("alert_webhook_url"),
  alertThresholds: doublePrecision("alert_thresholds").array().notNull().default([0.5, 0.8, 1.0]),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
}, (t) => [
  index("idx_budget_rules_project").on(t.projectId),
]);

// Tracks which (rule, scope, threshold) combos have already been alerted
// in the current window so we don't spam. Now keyed by rule_id instead of
// project_id so a per-model rule's 80% alert is independent from the
// project-wide rule's 80% alert.
export const budgetAlertFirings = pgTable("budget_alert_firings", {
  id: text("id").primaryKey(),
  ruleId: text("rule_id").notNull().references(() => budgetRules.id, { onDelete: "cascade" }),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  scope: text("scope").notNull(),        // 'daily' | 'monthly'
  threshold: doublePrecision("threshold").notNull(),  // e.g. 0.8
  windowKey: text("window_key").notNull(),
  firedAt: timestamp("fired_at", { withTimezone: true }).defaultNow(),
  spentUsd: doublePrecision("spent_usd").notNull(),
  limitUsd: doublePrecision("limit_usd").notNull(),
}, (t) => [
  uniqueIndex("idx_budget_alert_fired_once").on(t.ruleId, t.scope, t.threshold, t.windowKey),
]);

export const alerts = pgTable("alerts", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => orgs.id),
  projectId: text("project_id").references(() => projects.id),
  type: text("type").notNull(),
  threshold: doublePrecision("threshold"),
  channel: text("channel").notNull().default("webhook"),
  webhookUrl: text("webhook_url"),
  webhookSecretCiphertext: text("webhook_secret_ciphertext"),
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
  distinctCallSites: integer("distinct_call_sites").notNull().default(0),
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

// ── Accounting foundation ───────────────────────────────────────────
// These tables are deliberately separate from provider events: lifecycle and
// grouped-work state are not billable calls, while explicit usage components
// need their own dedupe/revision semantics.
export const traces = pgTable("traces", {
  id: text("id").notNull(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  traceName: text("trace_name"),
  executionId: text("execution_id"),
  groupId: text("group_id"),
  state: text("state").notNull().default("unknown"),
  lifecycleAt: timestamp("lifecycle_at", { withTimezone: true }),
  lifecycleSequence: integer("lifecycle_sequence"),
  errorType: text("error_type"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  accountingState: text("accounting_state").notNull().default("pending"),
  lifecycleSource: text("lifecycle_source").notNull().default("observed"),
  context: jsonb("context"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.id] }),
  index("idx_traces_project_started").on(t.projectId, t.startedAt),
  index("idx_traces_execution").on(t.projectId, t.executionId),
]);

export const groups = pgTable("groups", {
  id: text("id").notNull(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  kind: text("kind").notNull().default("other"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.id] }),
  uniqueIndex("idx_groups_project_name_kind").on(t.projectId, t.name, t.kind),
  index("idx_groups_project").on(t.projectId),
]);

export const executions = pgTable("executions", {
  id: text("id").notNull(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  groupId: text("group_id"),
  name: text("name"),
  kind: text("kind").notNull().default("other"),
  state: text("state").notNull().default("unknown"),
  lifecycleAt: timestamp("lifecycle_at", { withTimezone: true }),
  lifecycleSequence: integer("lifecycle_sequence"),
  errorType: text("error_type"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  expectedItems: integer("expected_items"),
  completedItems: integer("completed_items"),
  failedItems: integer("failed_items"),
  accountingState: text("accounting_state").notNull().default("pending"),
  configuration: jsonb("configuration"),
  datasetRevision: text("dataset_revision"),
  context: jsonb("context"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.id] }),
  index("idx_executions_project_started").on(t.projectId, t.startedAt),
  index("idx_executions_group").on(t.projectId, t.groupId),
]);

export const usageComponents = pgTable("usage_components", {
  id: text("id").notNull(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  chargeId: text("charge_id"),
  componentId: text("component_id"),
  callerId: text("caller_id"),
  context: jsonb("context"),
  traceId: text("trace_id"),
  executionId: text("execution_id"),
  groupId: text("group_id"),
  phase: text("phase"),
  component: text("component").notNull().default("custom"),
  provider: text("provider").notNull().default("unknown"),
  model: text("model"),
  unitKind: text("unit_kind"),
  unitValue: doublePrecision("unit_value"),
  unit: text("unit"),
  amount: doublePrecision("amount"),
  currency: text("currency").notNull().default("USD"),
  amountKind: text("amount_kind").notNull().default("reported"),
  aggregation: text("aggregation").notNull().default("delta"),
  revision: integer("revision"),
  pricingId: text("pricing_id"),
  payloadHash: text("payload_hash"),
  active: boolean("active").notNull().default(true),
  accountingAt: timestamp("accounting_at", { withTimezone: true }),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.id] }),
  index("idx_usage_components_project_time").on(t.projectId, t.observedAt),
  index("idx_usage_components_charge").on(t.projectId, t.chargeId),
  index("idx_usage_components_component").on(t.projectId, t.componentId),
]);

export const credits = pgTable("credits", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  accountScope: text("account_scope").notNull(),
  cloudProject: text("cloud_project"),
  currency: text("currency").notNull(),
  originalAmount: doublePrecision("original_amount").notNull(),
  balanceAmount: doublePrecision("balance_amount").notNull(),
  balanceAsOf: timestamp("balance_as_of", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  eligibility: jsonb("eligibility").notNull().default({}),
  source: text("source").notNull().default("user_supplied"),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
}, (t) => [
  index("idx_credits_project_expiry").on(t.projectId, t.expiresAt),
]);

export const findings = pgTable("findings", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  family: text("family").notNull(),
  scope: jsonb("scope").notNull().default({}),
  state: text("state").notNull().default("new"),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
  baseline: jsonb("baseline"),
  evidence: jsonb("evidence").notNull().default({}),
  nextActions: jsonb("next_actions").notNull().default([]),
  occurrenceCount: integer("occurrence_count").notNull().default(1),
  acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
  acknowledgedBy: text("acknowledged_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
}, (t) => [
  uniqueIndex("idx_findings_project_family_scope").on(t.projectId, t.family, t.scope),
  index("idx_findings_project_state").on(t.projectId, t.state, t.lastSeenAt),
]);

/** Workspace-authorized, project-scoped finding sensitivity controls. */
export const findingThresholds = pgTable("finding_thresholds", {
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  expensiveSample: integer("expensive_sample").notNull().default(20),
  expensiveMultiplier: doublePrecision("expensive_multiplier").notNull().default(3),
  expensiveMinAbsolute: doublePrecision("expensive_min_absolute").notNull().default(0.05),
  unitSample: integer("unit_sample").notNull().default(20),
  unitMinRelative: doublePrecision("unit_min_relative").notNull().default(0.5),
  unitMinImpact: doublePrecision("unit_min_impact").notNull().default(1),
  coverageMinDrop: doublePrecision("coverage_min_drop").notNull().default(0.1),
  allowanceMinRatio: doublePrecision("allowance_min_ratio").notNull().default(0.8),
  updatedBy: text("updated_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.projectId] }),
]);

export const forecastScenarios = pgTable("forecast_scenarios", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  scope: jsonb("scope").notNull().default({}),
  assumptions: jsonb("assumptions").notNull().default({}),
  result: jsonb("result"),
  shared: boolean("shared").notNull().default(false),
  calculatedAt: timestamp("calculated_at", { withTimezone: true }),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
}, (t) => [
  index("idx_forecast_scenarios_project").on(t.projectId, t.updatedAt),
]);

/** Durable daily accounting rollups retained after detailed events expire. */
export const dailyCostAggregates = pgTable("daily_cost_aggregates", {
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  day: date("day", { mode: "string" }).notNull(),
  timezone: text("timezone").notNull().default("UTC"),
  environment: text("environment").notNull().default("(unassigned)"),
  feature: text("feature").notNull().default("(unassigned)"),
  functionKey: text("function_key").notNull().default("(unassigned)"),
  customer: text("customer").notNull().default("(unassigned)"),
  service: text("service").notNull().default("(unassigned)"),
  release: text("release").notNull().default("(unassigned)"),
  provider: text("provider").notNull().default("(unknown)"),
  model: text("model").notNull().default("(unknown)"),
  knownCostUsd: doublePrecision("known_cost_usd"),
  observations: integer("observations").notNull().default(0),
  callCount: integer("call_count").notNull().default(0),
  pricedObservations: integer("priced_observations").notNull().default(0),
  unpricedObservations: integer("unpriced_observations").notNull().default(0),
  traceCount: integer("trace_count").notNull().default(0),
  fullyPricedTraceCount: integer("fully_priced_trace_count").notNull().default(0),
  fullyPricedTraceCostUsd: doublePrecision("fully_priced_trace_cost_usd"),
  reportedObservations: integer("reported_observations").notNull().default(0),
  estimatedObservations: integer("estimated_observations").notNull().default(0),
  unknownObservations: integer("unknown_observations").notNull().default(0),
  inputTokens: bigint("input_tokens", { mode: "number" }).notNull().default(0),
  outputTokens: bigint("output_tokens", { mode: "number" }).notNull().default(0),
  noChargeObservations: integer("no_charge_observations").notNull().default(0),
  durationSumMs: doublePrecision("duration_sum_ms").notNull().default(0),
  durationCount: integer("duration_count").notNull().default(0),
  untracedUsageCount: integer("untraced_usage_count").notNull().default(0),
  untracedUsageCostUsd: doublePrecision("untraced_usage_cost_usd"),
  reconciledAt: timestamp("reconciled_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.day, t.environment, t.feature, t.functionKey, t.customer, t.service, t.release, t.provider, t.model] }),
  index("idx_daily_cost_aggregates_project_day").on(t.projectId, t.day),
]);

/** Days the scheduler rebuilt after they ended; only these are read from the rollup. */
export const dailyRollupDays = pgTable("daily_rollup_days", {
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  day: date("day", { mode: "string" }).notNull(),
  timezone: text("timezone").notNull(),
  version: integer("version").notNull(),
  reconciledAt: timestamp("reconciled_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.projectId, t.day] })]);

/** A day's totals per dimension, with traces counted once per group. */
export const dailyLensAggregates = pgTable("daily_lens_aggregates", {
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  day: date("day", { mode: "string" }).notNull(),
  lens: text("lens").notNull(),
  groupKey: text("group_key").notNull(),
  observations: integer("observations").notNull().default(0),
  traceCount: integer("trace_count").notNull().default(0),
  fullyPricedTraceCount: integer("fully_priced_trace_count").notNull().default(0),
  fullyPricedTraceCostUsd: doublePrecision("fully_priced_trace_cost_usd"),
}, (t) => [primaryKey({ columns: [t.projectId, t.day, t.lens, t.groupKey] })]);

export const dailyCostAggregateCheckpoints = pgTable("daily_cost_aggregate_checkpoints", {
  projectId: text("project_id").primaryKey().references(() => projects.id, { onDelete: "cascade" }),
  throughDay: date("through_day", { mode: "string" }).notNull(),
  sourceCreatedBefore: timestamp("source_created_before", { withTimezone: true }).notNull(),
  generation: bigint("generation", { mode: "number" }).notNull().default(0),
  completedAt: timestamp("completed_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Dated, permissioned rate versions; historical rows are never overwritten. */
export const priceOverrides = pgTable("price_overrides", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => orgs.id, { onDelete: "cascade" }),
  projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  unit: text("unit").notNull().default("1m_tokens"),
  inputRate: doublePrecision("input_rate"),
  outputRate: doublePrecision("output_rate"),
  currency: text("currency").notNull().default("USD"),
  effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull(),
  effectiveTo: timestamp("effective_to", { withTimezone: true }),
  source: text("source").notNull().default("user_supplied"),
  updatedBy: text("updated_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
}, (t) => [
  index("idx_price_overrides_org_model_date").on(t.orgId, t.provider, t.model, t.effectiveFrom),
  index("idx_price_overrides_project_model_date").on(t.projectId, t.provider, t.model, t.effectiveFrom),
]);

/** Provider/account scoped effective-rate versions consumed by F10. */
export const effectivePrices = pgTable("effective_prices", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  accountScope: text("account_scope").notNull(),
  model: text("model"),
  nativeUnit: text("native_unit").notNull(),
  pricePerUnit: doublePrecision("price_per_unit").notNull(),
  currency: text("currency").notNull().default("USD"),
  effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull(),
  effectiveTo: timestamp("effective_to", { withTimezone: true }),
  source: text("source").notNull().default("user_supplied"),
  version: integer("version").notNull(),
  pricingId: text("pricing_id"),
  metadata: jsonb("metadata").notNull().default({}),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdBy: text("created_by"),
  updatedBy: text("updated_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
}, (t) => [
  index("idx_effective_prices_project_scope").on(t.projectId, t.provider, t.accountScope, t.nativeUnit, t.effectiveFrom),
  uniqueIndex("idx_effective_prices_version").on(t.projectId, t.provider, t.accountScope, t.model, t.nativeUnit, t.currency, t.version),
]);

export const featureMappings = pgTable("feature_mappings", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  feature: text("feature").notNull(),
  match: jsonb("match").notNull().default({}),
  enabled: boolean("enabled").notNull().default(true),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
}, (t) => [
  index("idx_feature_mappings_project").on(t.projectId, t.enabled),
]);

export const featureMappingActions = pgTable("feature_mapping_actions", {
  id: text("id").primaryKey(),
  mappingId: text("mapping_id").notNull().references(() => featureMappings.id, { onDelete: "cascade" }),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  action: text("action").notNull(),
  fromTime: timestamp("from_time", { withTimezone: true }),
  toTime: timestamp("to_time", { withTimezone: true }),
  matchedCount: integer("matched_count").notNull().default(0),
  overrideExplicit: boolean("override_explicit").notNull().default(false),
  performedBy: text("performed_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (t) => [
  index("idx_feature_mapping_actions_project").on(t.projectId, t.createdAt),
]);

export const migrations = pgTable("migrations", {
  name: text("name").primaryKey(),
  ranAt: timestamp("ran_at", { withTimezone: true }).notNull().defaultNow(),
});
