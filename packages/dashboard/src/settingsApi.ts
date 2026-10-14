import { appUrl } from "./basePath";
import { UNAUTHENTICATED_EVENT } from "./api";

const API_BASE = appUrl("/api/v1");

export class SettingsApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown = null) {
    super(message);
    this.name = "SettingsApiError";
    this.status = status;
    this.body = body;
  }
}

type RequestOptions = Omit<RequestInit, "body"> & { body?: unknown };

/** Normalize additive API collections so an older server cannot blank the shell. */
export function arrayOrEmpty<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    credentials: "include",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const contentType = response.headers.get("content-type") ?? "";
  const payload: unknown = contentType.includes("json")
    ? await response.json().catch(() => null)
    : await response.text().catch(() => "");
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event(UNAUTHENTICATED_EVENT));
    const message = payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
      ? payload.error
      : `Settings request failed (${response.status})`;
    throw new SettingsApiError(message, response.status, payload);
  }
  return payload as T;
}

export interface WorkspaceSettings {
  timezone: string;
  reportingCurrency: "USD" | "INR";
  fx?: { available: boolean; rate: number | null; source: string | null; asOf: string | null };
  fxRate?: number | null;
  fxSource?: string | null;
  fxAsOf?: string | null;
  updatedAt: string | null;
}

export interface WorkspaceSettingsResponse {
  settings: WorkspaceSettings | null;
  canManage?: boolean;
}

export function getWorkspaceSettings(): Promise<WorkspaceSettingsResponse> {
  return request("/workspace/settings");
}

export function updateWorkspaceSettings(input: {
  timezone: string;
  reportingCurrency: "USD" | "INR";
  fxRate?: number;
  fxSource?: string;
  fxAsOf?: string;
}): Promise<WorkspaceSettingsResponse> {
  return request("/workspace/settings", { method: "PATCH", body: input });
}

export interface ProjectDetail {
  id: string;
  name: string;
  description?: string | null;
  created_at?: string;
  capture_mode?: "metadata" | "text" | string;
  body_capture_enabled?: boolean;
  redaction_enabled?: boolean;
  body_retention_days?: number;
  metadata_retention_days?: number;
  aggregate_retention_days?: number;
  source_access_enabled?: boolean;
}

export interface ProjectDetailResponse {
  project: ProjectDetail;
  canManage: boolean;
}

export function getProjectDetail(projectId: string): Promise<ProjectDetailResponse> {
  return request(`/projects/${encodeURIComponent(projectId)}`);
}

export interface ConnectionHealth {
  status: "active" | "idle" | "inactive" | "no_data" | string;
  lastEventAt: string | null;
  eventsLastHour: number;
  hints?: Array<{ type: string; message: string; link: string }>;
}

export function getConnectionHealth(projectId: string): Promise<ConnectionHealth> {
  return request(`/projects/${encodeURIComponent(projectId)}/health`);
}

export interface AttributionHealth {
  [key: string]: unknown;
}

export function getAttributionHealth(projectId: string): Promise<AttributionHealth> {
  return request(`/projects/${encodeURIComponent(projectId)}/attribution-health`);
}

export interface FindingThresholds {
  expensiveSample: number;
  expensiveMultiplier: number;
  expensiveMinAbsolute: number;
  unitSample: number;
  unitMinRelative: number;
  unitMinImpact: number;
  coverageMinDrop: number;
  allowanceMinRatio: number;
}

export interface FindingThresholdsResponse {
  projectId: string;
  thresholds: FindingThresholds;
  defaults: FindingThresholds;
}

export function getFindingThresholds(projectId: string): Promise<FindingThresholdsResponse> {
  return request(`/projects/${encodeURIComponent(projectId)}/finding-thresholds`);
}

export function updateFindingThresholds(projectId: string, input: Partial<FindingThresholds>): Promise<FindingThresholdsResponse> {
  return request(`/projects/${encodeURIComponent(projectId)}/finding-thresholds`, { method: "PATCH", body: input });
}

export interface SourcemapRow {
  id: string;
  file_name: string;
  created_at: string;
  size_bytes: number;
}

export interface SourcemapsResponse {
  release: string;
  sourcemaps: SourcemapRow[];
}

export function getSourcemaps(projectId: string, release: string): Promise<SourcemapsResponse> {
  return request(`/projects/${encodeURIComponent(projectId)}/sourcemaps/${encodeURIComponent(release)}`);
}

export interface TeamInvite {
  id: string;
  email: string;
  role: "admin" | "developer" | "viewer" | string;
  project_ids?: string[] | null;
  status: "pending" | "expired" | "accepted" | "revoked" | string;
  created_at: string;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
  resent_count: number;
  invited_by_name: string;
}

export function getTeamInvites(): Promise<{ invites: TeamInvite[] }> {
  return request("/team/invites");
}

export function createTeamInvite(input: {
  email: string;
  role: "admin" | "developer" | "viewer";
  projectIds: string[];
}): Promise<{ id: string; email: string; role: string; projectIds: string[]; expiresAt: string; inviteUrl?: string; emailSent?: boolean }> {
  return request("/team/invite", { method: "POST", body: input });
}

export function revokeTeamInvite(inviteId: string): Promise<{ ok: true }> {
  return request(`/team/invites/${encodeURIComponent(inviteId)}`, { method: "DELETE" });
}

export function resendTeamInvite(inviteId: string): Promise<{ id: string; expiresAt: string; inviteUrl?: string; emailSent?: boolean }> {
  return request(`/team/invites/${encodeURIComponent(inviteId)}/resend`, { method: "POST" });
}

export function updateTeamMember(memberId: string, input: { role: "admin" | "developer" | "viewer"; projectIds?: string[] }): Promise<{ ok: true; role?: string; projectIds?: string[] }> {
  return request(`/team/members/${encodeURIComponent(memberId)}`, { method: "PATCH", body: input });
}

export function getMemberProjects(memberId: string): Promise<{ projectIds: string[] }> {
  return request(`/team/members/${encodeURIComponent(memberId)}/projects`);
}

export function removeTeamMember(memberId: string): Promise<{ ok: true }> {
  return request(`/team/members/${encodeURIComponent(memberId)}`, { method: "DELETE" });
}

export function transferWorkspaceOwnership(targetUserId: string): Promise<{
  ok: true;
  owner: { id: string; email: string; name: string };
  previousOwner: { id: string; role: "admin" };
  auditId: string;
}> {
  return request("/team/transfer-ownership", {
    method: "POST",
    body: { targetUserId, confirmTargetUserId: targetUserId },
  });
}

export interface NotificationPreferences {
  id: string;
  projectId: string | null;
  weeklySummaryEnabled: boolean;
  weeklySummaryHour: number;
  weeklySummaryWeekday: number;
  /** Older servers omit the daily summary fields; treat them as off at 09:00. */
  dailySummaryEnabled?: boolean;
  dailySummaryHour?: number;
  timezone: string;
  findingsEnabled: boolean;
  policyWarningThresholds: number[];
  enforcementEnabled: boolean;
  /** Older servers gate budget alerts with enforcementEnabled. */
  budgetAlertsEnabled?: boolean;
  executionReceiptsEnabled: boolean;
  updatedAt: string | null;
}

export type NotificationEventType =
  | "weekly_summary"
  | "daily_summary"
  | "finding"
  | "policy_warning"
  | "enforcement"
  | "execution_receipt";

/** New destinations subscribe to every event; preferences decide what is sent. */
export const ALL_NOTIFICATION_EVENT_TYPES: NotificationEventType[] = [
  "weekly_summary",
  "daily_summary",
  "finding",
  "policy_warning",
  "enforcement",
  "execution_receipt",
];

export type NotificationDestinationKind = "email" | "webhook" | "slack";

export interface NotificationPreferencesResponse {
  preferences: NotificationPreferences;
  workspaceDefaults?: Partial<NotificationPreferences> | null;
  policySilenceDoesNotDisableEnforcement?: boolean;
}

export function getNotificationPreferences(projectId?: string): Promise<NotificationPreferencesResponse> {
  const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
  return request(`/notifications/preferences${query}`);
}

export function updateNotificationPreferences(input: Partial<NotificationPreferences> & { projectId?: string | null }): Promise<NotificationPreferencesResponse> {
  return request("/notifications/preferences", { method: "PATCH", body: input });
}

export interface NotificationDestination {
  id: string;
  project_id: string | null;
  owner_user_id: string | null;
  kind: NotificationDestinationKind | string;
  /** Slack webhook URLs are secrets: the server only ever returns a masked form. */
  address: string;
  event_types: string[];
  enabled: boolean;
  last_delivery_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export function getNotificationDestinations(): Promise<{ destinations: NotificationDestination[] }> {
  return request("/notifications/destinations");
}

export function createNotificationDestination(input: {
  kind: NotificationDestinationKind;
  address: string;
  secret?: string;
  eventTypes: string[];
  projectId?: string | null;
}): Promise<{ destination: NotificationDestination }> {
  return request("/notifications/destinations", { method: "POST", body: input });
}

export function deleteNotificationDestination(destinationId: string): Promise<{ ok: true }> {
  return request(`/notifications/destinations/${encodeURIComponent(destinationId)}`, { method: "DELETE" });
}

export interface NotificationDelivery {
  id: string;
  event_type: string;
  scope_type: string | null;
  scope_id: string | null;
  status: "pending" | "sent" | "failed" | "suppressed" | string;
  attempt_count: number;
  last_error: string | null;
  sent_at: string | null;
  created_at: string;
  destination_id: string | null;
}

export function testNotificationDestination(destinationId: string): Promise<{ delivery: { status: string; error?: string | null } }> {
  return request(`/notifications/destinations/${encodeURIComponent(destinationId)}/test`, { method: "POST" });
}

export function getNotificationDeliveries(): Promise<{ deliveries: NotificationDelivery[] }> {
  return request("/notifications/deliveries");
}

export interface PrivacySettings {
  projectId: string;
  captureMode: "metadata" | "text" | string;
  bodyCaptureEnabled: boolean;
  redactionEnabled: boolean;
  bodyRetentionDays: number;
  metadataRetentionDays: number;
  aggregateRetentionDays: number;
  sourceAccessEnabled: boolean;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export function getPrivacySettings(projectId: string): Promise<{ settings: PrivacySettings; canManage: boolean }> {
  return request(`/projects/${encodeURIComponent(projectId)}/privacy`);
}

export function updatePrivacySettings(projectId: string, input: Partial<Pick<PrivacySettings, "captureMode" | "bodyCaptureEnabled" | "redactionEnabled" | "bodyRetentionDays" | "metadataRetentionDays" | "aggregateRetentionDays" | "sourceAccessEnabled">>): Promise<{ settings: PrivacySettings }> {
  return request(`/projects/${encodeURIComponent(projectId)}/privacy`, { method: "PATCH", body: input });
}

export function deleteCapturedContent(projectId: string): Promise<{ deletedContent: number; projectId: string }> {
  return request(`/projects/${encodeURIComponent(projectId)}/privacy/delete-content`, {
    method: "POST",
    body: { confirmProjectId: projectId },
  });
}

export interface RetentionRun {
  id: string;
  started_at: string;
  completed_at: string | null;
  redacted_bodies: number;
  deleted_events: number;
  error: string | null;
}

export function getRetentionStatus(): Promise<{ latestRun: RetentionRun | null }> {
  return request("/retention/status");
}

export function runRetention(): Promise<{
  runId: string;
  redactedBodies: number;
  deletedEvents: number;
  deletedAggregates: number;
  completedAt: string;
}> {
  return request("/retention/run", { method: "POST" });
}

export interface Credit {
  id: string;
  project_id: string;
  provider: string;
  account_scope: string;
  cloud_project: string | null;
  currency: string;
  original_amount: number;
  balance_amount: number;
  balance_as_of: string;
  expires_at: string | null;
  eligibility: Record<string, unknown>;
  source: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreditInput {
  provider: string;
  accountScope: string;
  cloudProject: string;
  currency: string;
  originalAmount: number;
  balanceAmount: number;
  balanceAsOf: string;
  expiresAt?: string | null;
  eligibility: Record<string, unknown>;
}

export function getCredits(projectId: string): Promise<{ credits: Credit[] }> {
  return request(`/projects/${encodeURIComponent(projectId)}/credits`);
}

export function createCredit(projectId: string, input: CreditInput): Promise<{ credit: Credit }> {
  return request(`/projects/${encodeURIComponent(projectId)}/credits`, { method: "POST", body: input });
}

export function updateCredit(projectId: string, creditId: string, input: CreditInput): Promise<{ credit: Credit }> {
  return request(`/projects/${encodeURIComponent(projectId)}/credits/${encodeURIComponent(creditId)}`, { method: "PATCH", body: input });
}

export function deleteCredit(projectId: string, creditId: string): Promise<{ ok: true }> {
  return request(`/projects/${encodeURIComponent(projectId)}/credits/${encodeURIComponent(creditId)}`, { method: "DELETE" });
}

export interface EffectivePrice {
  id: string;
  projectId: string;
  provider: string;
  accountScope: string;
  model: string | null;
  nativeUnit: string;
  pricePerUnit: number;
  currency: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  source: string;
  version: number;
  pricingId: string | null;
  metadata: Record<string, unknown>;
  createdBy: string | null;
  updatedBy: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EffectivePriceInput {
  provider: string;
  accountScope: string;
  model: string | null;
  nativeUnit: string;
  pricePerUnit: number;
  currency: string;
  effectiveFrom: string;
  effectiveTo?: string | null;
  source: string;
  version: number;
  pricingId?: string | null;
  metadata?: Record<string, unknown>;
}

export function getEffectivePrices(projectId: string): Promise<{ prices: EffectivePrice[] }> {
  return request(`/projects/${encodeURIComponent(projectId)}/effective-prices`);
}

export function createEffectivePrice(projectId: string, input: EffectivePriceInput): Promise<{ price: EffectivePrice }> {
  return request(`/projects/${encodeURIComponent(projectId)}/effective-prices`, { method: "POST", body: input });
}

export function updateEffectivePrice(projectId: string, id: string, input: EffectivePriceInput): Promise<{ price: EffectivePrice }> {
  return request(`/projects/${encodeURIComponent(projectId)}/effective-prices/${encodeURIComponent(id)}`, { method: "PATCH", body: input });
}

export function deleteEffectivePrice(projectId: string, id: string): Promise<{ ok: true; revokedId?: string }> {
  return request(`/projects/${encodeURIComponent(projectId)}/effective-prices/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export interface PriceCatalogStatus {
  enabled: boolean;
  prices: number;
  loadedAt: string | null;
  sources: Array<{ source: string; url: string }>;
  lastSync: { status: string; finished_at: string | null; added: number; changed: number; repriced: number } | null;
}

export interface UnpricedModel {
  provider: string;
  model: string | null;
  calls: number;
  firstSeen: string;
  lastSeen: string;
  units: string[];
  /** Why these calls have no cost: the catalog doesn't know the model, the calls reported no usage, or they're waiting to be repriced. */
  reason?: "no_price" | "no_usage" | "pending";
}

export interface CatalogModel {
  provider: string;
  model: string;
  source: string;
  rates: Record<string, number>;
}

export function getPriceCatalogStatus(): Promise<PriceCatalogStatus> {
  return request("/pricing/catalog");
}

export function refreshPriceCatalog(): Promise<{ status: string; added: number; changed: number; repriced: number }> {
  return request("/pricing/catalog/sync", { method: "POST" });
}

export function searchCatalogModels(provider: string, query: string): Promise<{ models: CatalogModel[] }> {
  return request(`/pricing/models?provider=${encodeURIComponent(provider)}&q=${encodeURIComponent(query)}`);
}

export function getUnpricedModels(projectId: string): Promise<{ models: UnpricedModel[] }> {
  return request(`/projects/${encodeURIComponent(projectId)}/pricing/unpriced`);
}

export function setModelAlias(projectId: string, input: { provider: string; model: string; targetModel: string }): Promise<{ repriced: number }> {
  return request(`/projects/${encodeURIComponent(projectId)}/pricing/aliases`, { method: "POST", body: input });
}

export function setModelRates(projectId: string, input: { provider: string; model: string; rates: Record<string, number> }): Promise<{ repriced: number }> {
  return request(`/projects/${encodeURIComponent(projectId)}/pricing/rates`, { method: "POST", body: input });
}

export interface Subscription {
  provider: string;
  status: string;
  amountCents: number;
  pricing?: "per_user" | "workspace";
  seats?: number;
  totalCents?: number;
  currency: string;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  cancelAt: string | null;
  paymentMethodSummary: string | null;
  updatedAt: string | null;
}

export interface SubscriptionResponse {
  subscription: Subscription;
  target: BillingTarget;
}

export interface BillingTarget {
  amountUsd: number;
  interval: string;
  /** "user": $9 for each member. "workspace": the old flat plan. */
  per: "user" | "workspace";
  seats: number;
  totalUsd: number;
}

export function getSubscription(): Promise<SubscriptionResponse> {
  return request("/subscription");
}

export function startSubscriptionCheckout(idempotencyKey: string): Promise<{ configured: boolean; checkoutUrl?: string; sessionId?: string; status: string }> {
  return request("/subscription/checkout", { method: "POST", headers: { "Idempotency-Key": idempotencyKey } });
}

export function cancelSubscription(): Promise<{ subscription: Subscription }> {
  return request("/subscription/cancel", { method: "POST" });
}

export function resumeSubscription(): Promise<{ subscription: Subscription }> {
  return request("/subscription/resume", { method: "POST" });
}

export interface Invoice {
  id: string;
  provider_invoice_id: string | null;
  status: string;
  amount_due_cents: number | null;
  amount_paid_cents: number | null;
  currency: string;
  hosted_invoice_url: string | null;
  issued_at: string | null;
  due_at: string | null;
  paid_at: string | null;
  created_at: string;
}

export function getInvoices(): Promise<{ invoices: Invoice[] }> {
  return request("/subscription/invoices");
}

export interface WorkspaceClosureImpact {
  generatedAt: string;
  projects: { count: number; dsnCount: number; dsnAction: string };
  members: { count: number; accessAction: string };
  subscription: {
    provider: string;
    status: string;
    cancelAtPeriodEnd: boolean;
    providerCustomerBound: boolean;
    providerSubscriptionBound: boolean;
    action: string;
  };
  policies: { activeCount: number; action: string };
  data: { capturedContent: string; deletion: string; aggregateHistory: string };
  pendingRequest: { id: string; status: string; requested_at: string } | null;
}

export function getWorkspaceClosureImpact(): Promise<{ impact: WorkspaceClosureImpact }> {
  return request("/workspace/closure-impact");
}

export function requestWorkspaceClosure(confirmOrgId: string): Promise<{
  ok: true;
  closureRequested: true;
  deletionStarted: false;
  created: boolean;
  requestId: string;
  status: "requested";
  impact: WorkspaceClosureImpact;
}> {
  return request("/workspace/closure", {
    method: "POST",
    body: { confirmOrgId, acknowledgeImpact: true },
  });
}

export async function createProject(input: { name: string; description?: string }): Promise<{ id: string; name: string; authKey: string; dsn: string }> {
  return request("/projects", { method: "POST", body: input });
}

export async function updateProject(projectId: string, input: { name?: string; description?: string | null }): Promise<{ project: ProjectDetail }> {
  return request(`/projects/${encodeURIComponent(projectId)}`, { method: "PATCH", body: input });
}

export async function rotateProjectKey(projectId: string): Promise<{ authKey: string; dsn: string }> {
  return request(`/projects/${encodeURIComponent(projectId)}/rotate-key`, { method: "POST" });
}

export async function deleteProject(projectId: string): Promise<{ ok: true; deletedProjectId: string }> {
  return request(`/projects/${encodeURIComponent(projectId)}`, { method: "DELETE", body: { confirmProjectId: projectId } });
}

/** A personal access token a coding agent uses to read this workspace (MCP). */
export interface AgentToken {
  id: string;
  name: string;
  /** The token's last four characters. */
  hint: string | null;
  scopes: string[];
  projectIds: string[] | null;
  createdAt: string | null;
  lastUsedAt: string | null;
  expiresAt: string | null;
}

export interface AgentTokenList {
  tokens: AgentToken[];
  mcpUrl: string;
  mcpEnabled: boolean;
}

export async function getAgentTokens(): Promise<AgentTokenList> {
  const body = await request<Partial<AgentTokenList>>("/agent-tokens");
  return { tokens: arrayOrEmpty<AgentToken>(body.tokens), mcpUrl: String(body.mcpUrl ?? ""), mcpEnabled: body.mcpEnabled !== false };
}

export async function createAgentToken(input: { name: string; projectIds?: string[] | null; expiresAt?: string | null }): Promise<{ token: AgentToken; secret: string; mcpUrl: string }> {
  return request("/agent-tokens", { method: "POST", body: input });
}

export async function revokeAgentToken(tokenId: string): Promise<{ revoked: true }> {
  return request(`/agent-tokens/${encodeURIComponent(tokenId)}`, { method: "DELETE" });
}

export async function uploadSourcemap(projectId: string, release: string, file: File): Promise<{ uploaded: boolean; release: string; fileName: string }> {
  const sourcemapJson = await file.text();
  return request(`/projects/${encodeURIComponent(projectId)}/sourcemaps`, {
    method: "POST",
    body: { release, fileName: file.name, sourcemapJson },
  });
}

/** The repository releases link to when the SDK doesn't report one; null clears it. */
export function updateRepository(projectId: string, url: string | null): Promise<{ repository: string | null }> {
  return request(`/projects/${encodeURIComponent(projectId)}/repository`, { method: "PUT", body: { url: url ?? "" } });
}
