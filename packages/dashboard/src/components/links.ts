import { modelPath } from "../modelDetailApi";

/** Period and environment from the current URL, so drilling in keeps them. */
export function scopeSearch(extra: Record<string, string> = {}): string {
  const current = typeof window === "undefined" ? new URLSearchParams() : new URLSearchParams(window.location.search);
  const next = new URLSearchParams();
  for (const key of ["period", "from", "to", "environment", "project"]) {
    const value = current.get(key);
    if (value) next.set(key, value);
  }
  for (const [key, value] of Object.entries(extra)) next.set(key, value);
  const text = next.toString();
  return text ? `?${text}` : "";
}

export const agentHref = (name: string) => `/agents/${encodeURIComponent(name)}${scopeSearch()}`;
export const workflowHref = (name: string) => `/workflows/${encodeURIComponent(name)}${scopeSearch()}`;
export const ownerHref = (kind: "agent" | "workflow" | "agents" | "workflows" | string, name: string) => kind.startsWith("agent") ? agentHref(name) : workflowHref(name);
export const modelHref = (provider: string | null | undefined, model: string) => `${modelPath(provider || "unknown", model)}${scopeSearch()}`;
export const userHref = (id: string) => `/users/${encodeURIComponent(id)}${scopeSearch()}`;
export const featureHref = (feature: string) => `/costs${scopeSearch({ groupBy: "feature", groupValue: feature })}`;
export const checkHref = (name: string) => `/quality${scopeSearch({ check: name })}`;
export const toolHref = (name: string) => `/traces${scopeSearch({ q: name })}`;
