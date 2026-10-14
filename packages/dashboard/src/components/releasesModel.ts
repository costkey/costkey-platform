import { useEffect, useState } from "react";
import { getReleases, type Release } from "../api";

const SHA = /^[0-9a-f]{7,40}$/i;
const TTL_MS = 60_000;
const cache = new Map<string, { at: number; data: Release[]; pending?: Promise<Release[]> }>();

/** "df48a0a" for a commit SHA; any other release name as it is. */
export function shortRelease(release: string): string {
  return SHA.test(release) ? release.slice(0, 7).toLowerCase() : release;
}

function loadReleases(projectId: string, environment: string): Promise<Release[]> {
  const key = `${projectId}\u0001${environment}`;
  const cached = cache.get(key);
  if (cached?.pending) return cached.pending;
  if (cached && cached.at > Date.now() - TTL_MS) return Promise.resolve(cached.data);
  const pending = getReleases(projectId, environment)
    .then((response) => { cache.set(key, { at: Date.now(), data: response.releases }); return response.releases; })
    .catch(() => { cache.delete(key); return [] as Release[]; });
  cache.set(key, { at: cached?.at ?? 0, data: cached?.data ?? [], pending });
  return pending;
}

/** The project's recent deploys, newest first; shared and kept for a minute. */
export function useReleases(projectId: string | null, environment = "all"): { releases: Release[]; loaded: boolean } {
  const key = projectId ? `${projectId}\u0001${environment}` : null;
  const [state, setState] = useState<{ key: string | null; releases: Release[] }>(() => ({ key, releases: key ? cache.get(key)?.data ?? [] : [] }));
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    loadReleases(projectId, environment).then((releases) => { if (!cancelled) setState({ key: `${projectId}\u0001${environment}`, releases }); });
    return () => { cancelled = true; };
  }, [projectId, environment]);
  return { releases: state.key === key ? state.releases : [], loaded: state.key === key };
}
