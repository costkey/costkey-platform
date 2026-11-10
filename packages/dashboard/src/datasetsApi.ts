import { appUrl } from "./basePath";

const API_BASE = appUrl("/api/v1");

export interface Dataset {
  id: string;
  name: string;
  description: string | null;
  revision: number;
  itemCount: number;
  labels: Record<string, number>;
  createdAt: string;
  updatedAt: string;
}

export interface DatasetItem {
  id: string;
  sourceEventId: string;
  traceId: string | null;
  provider: string | null;
  model: string | null;
  label: string;
  note: string | null;
  expected: unknown;
  frameSha256: string | null;
  hasInput: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DatasetMembership {
  id: string;
  datasetId: string;
  datasetName: string;
  label: string;
  note: string | null;
}

export class DatasetApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: init.method ?? "GET",
    credentials: "include",
    headers: init.body === undefined ? undefined : { "Content-Type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (response.status === 204) return undefined as T;
  const payload = await response.json().catch(() => null) as { error?: string } | null;
  if (!response.ok) throw new DatasetApiError(payload?.error ?? `Dataset request failed (${response.status})`, response.status);
  return payload as T;
}

const project = (projectId: string) => `/projects/${encodeURIComponent(projectId)}`;

export function listDatasets(projectId: string): Promise<{ datasets: Dataset[] }> {
  return request(`${project(projectId)}/datasets`);
}

export function createDataset(projectId: string, input: { name: string; description?: string }): Promise<{ dataset: Dataset }> {
  return request(`${project(projectId)}/datasets`, { method: "POST", body: input });
}

export function getDataset(projectId: string, datasetId: string): Promise<{ dataset: Dataset; items: DatasetItem[] }> {
  return request(`${project(projectId)}/datasets/${encodeURIComponent(datasetId)}`);
}

export function deleteDataset(projectId: string, datasetId: string): Promise<void> {
  return request(`${project(projectId)}/datasets/${encodeURIComponent(datasetId)}`, { method: "DELETE" });
}

export function addDatasetItem(projectId: string, datasetId: string, input: { eventId: string; label: string; note?: string }): Promise<{ item: DatasetItem }> {
  return request(`${project(projectId)}/datasets/${encodeURIComponent(datasetId)}/items`, { method: "POST", body: input });
}

export function updateDatasetItem(projectId: string, datasetId: string, itemId: string, input: { label?: string; note?: string | null }): Promise<{ item: DatasetItem }> {
  return request(`${project(projectId)}/datasets/${encodeURIComponent(datasetId)}/items/${encodeURIComponent(itemId)}`, { method: "PATCH", body: input });
}

export function removeDatasetItem(projectId: string, datasetId: string, itemId: string): Promise<void> {
  return request(`${project(projectId)}/datasets/${encodeURIComponent(datasetId)}/items/${encodeURIComponent(itemId)}`, { method: "DELETE" });
}

export function datasetMemberships(projectId: string, eventId: string): Promise<{ items: DatasetMembership[] }> {
  return request(`${project(projectId)}/dataset-items?eventId=${encodeURIComponent(eventId)}`);
}

export function datasetExportUrl(projectId: string, datasetId: string): string {
  return `${API_BASE}${project(projectId)}/datasets/${encodeURIComponent(datasetId)}/export`;
}

export interface EvalRun {
  executionId: string;
  name: string | null;
  configuration: Record<string, unknown> | null;
  datasetRevision: string;
  state: string;
  startedAt: string | null;
  endedAt: string | null;
  cases: number;
  passed: number;
  failed: number;
  cost: number | null;
  originalCost: number | null;
}

export interface EvalCase {
  itemId: string;
  label: string;
  note: string | null;
  frameSha256: string | null;
  sourceEventId: string;
  sourceTraceId: string | null;
  originalModel: string | null;
  originalCost: number | null;
  originalOutput: unknown;
  traceId: string;
  calls: number;
  cost: number | null;
  candidateOutput: unknown;
  pass: boolean | null;
  reason: string | null;
}

export function listEvalRuns(projectId: string, datasetId: string): Promise<{ runs: EvalRun[] }> {
  return request(`${project(projectId)}/datasets/${encodeURIComponent(datasetId)}/evals`);
}

export function getEvalRun(projectId: string, datasetId: string, executionId: string): Promise<{ run: Omit<EvalRun, "cases" | "passed" | "failed" | "cost" | "originalCost">; cases: EvalCase[] }> {
  return request(`${project(projectId)}/datasets/${encodeURIComponent(datasetId)}/evals/${encodeURIComponent(executionId)}`);
}
