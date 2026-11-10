import { appUrl } from "./basePath";

const API_BASE = appUrl("/api/v1");

export type WidgetKind = "total" | "trend" | "breakdown";
export type WidgetMetric = "cost" | "calls" | "tokens";
export type WidgetGroup = "model" | "provider" | "feature" | "customer" | "function";
export type WidgetPeriod = "24h" | "7d" | "30d";

export interface WidgetSpec {
  id: string;
  title: string;
  kind: WidgetKind;
  metric: WidgetMetric;
  groupBy?: WidgetGroup;
  period: WidgetPeriod;
  width: "half" | "full";
}

export interface CustomDashboard {
  id: string;
  name: string;
  widgets: WidgetSpec[];
  createdAt: string;
  updatedAt: string;
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
  if (!response.ok) throw new Error(payload?.error ?? `Dashboard request failed (${response.status})`);
  return payload as T;
}

const base = (projectId: string) => `/projects/${encodeURIComponent(projectId)}/dashboards`;

export const listDashboards = (projectId: string) => request<{ dashboards: CustomDashboard[] }>(base(projectId));
export const getDashboard = (projectId: string, id: string) => request<{ dashboard: CustomDashboard }>(`${base(projectId)}/${encodeURIComponent(id)}`);
export const createDashboard = (projectId: string, name: string) => request<{ dashboard: CustomDashboard }>(base(projectId), { method: "POST", body: { name } });
export const saveDashboard = (projectId: string, id: string, input: { name?: string; widgets?: WidgetSpec[] }) =>
  request<{ dashboard: CustomDashboard }>(`${base(projectId)}/${encodeURIComponent(id)}`, { method: "PUT", body: input });
export const deleteDashboard = (projectId: string, id: string) => request<void>(`${base(projectId)}/${encodeURIComponent(id)}`, { method: "DELETE" });
