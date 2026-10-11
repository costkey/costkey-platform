import { appUrl } from "../basePath";
import { setDisplayTimeZone } from "../components/consoleFormatters";
import { useState, useEffect, useCallback, type ReactNode } from "react";
import { analytics } from "../analytics";
import { UNAUTHENTICATED_EVENT } from "../api";
import { getWorkspaceSettings, type WorkspaceSettings } from "../settingsApi";
import { AuthContext } from "./auth-state";
import type { Org, Project, User } from "./auth-state";

function pseudonymousKey(prefix: string, value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${prefix}_${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [org, setOrg] = useState<Org | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [members, setMembers] = useState<Array<{ id: string; email: string; name: string; role: string }>>([]);
  const [workspaceSettings, setWorkspaceSettings] = useState<WorkspaceSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(appUrl("/auth/me"), { credentials: "include" });
      if (!res.ok) {
        setUser(null);
        setOrg(null);
        setProjects([]);
        setMembers([]);
        setWorkspaceSettings(null);
        return;
      }
      const data = await res.json();
      if (data.authenticated === false) {
        setUser(null);
        setOrg(null);
        setProjects([]);
        setMembers([]);
        setWorkspaceSettings(null);
        return;
      }
      setUser(data.user);
      setOrg(data.org);
      setProjects(data.projects ?? []);
      setMembers(data.members ?? []);
      const settings = await getWorkspaceSettings().catch(() => null);
      setDisplayTimeZone(settings?.settings?.timezone ?? data.org?.timezone ?? "UTC");
      setWorkspaceSettings(settings?.settings ?? null);
      if (data.projects?.length > 0) {
        setCurrentProjectId((current) => current ?? data.projects[0].id);
      }
    } catch {
      setUser(null);
      setWorkspaceSettings(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    const clearExpiredSession = () => {
      setUser(null);
      setOrg(null);
      setProjects([]);
      setMembers([]);
      setWorkspaceSettings(null);
      setCurrentProjectId(null);
      setLoading(false);
      analytics.reset();
    };

    window.addEventListener(UNAUTHENTICATED_EVENT, clearExpiredSession);
    return () => window.removeEventListener(UNAUTHENTICATED_EVENT, clearExpiredSession);
  }, []);

  useEffect(() => {
    if (!user) return;
    analytics.identify(pseudonymousKey("user", user.analyticsId ?? user.id), { role: user.role });
    if (org) analytics.group("organization", pseudonymousKey("org", org.analyticsId ?? org.id));
  }, [user, org]);

  const login = async (email: string, password: string): Promise<boolean> => {
    setError(null);
    try {
      const res = await fetch(appUrl("/auth/login"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) {
        const data = await res.json();
        setError(data.error ?? "Login failed");
        return false;
      }
      // Fetch user data immediately after login
      const meRes = await fetch(appUrl("/auth/me"), { credentials: "include" });
      if (meRes.ok) {
        const data = await meRes.json();
        setUser(data.user);
        setOrg(data.org);
        setProjects(data.projects ?? []);
        setMembers(data.members ?? []);
        const settings = await getWorkspaceSettings().catch(() => null);
        setWorkspaceSettings(settings?.settings ?? null);
        if (data.projects?.length > 0) {
        setCurrentProjectId((current) => current ?? data.projects[0].id);
        }
      }
      analytics.capture("user_logged_in");
      return true;
    } catch {
      setError("Network error");
      return false;
    }
  };

  const signup = async (
    email: string, password: string, name: string, orgName: string, inviteToken?: string,
  ): Promise<{ dsn: string; projectId: string; joinedViaInvite?: boolean } | null> => {
    setError(null);
    try {
      const res = await fetch(appUrl("/auth/signup"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email, password, name, orgName, inviteToken }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Signup failed");
        return null;
      }
      await refresh();
      analytics.capture("user_signed_up", { joined_via_invite: data.joinedViaInvite ?? false });
      return {
        dsn: data.dsn ?? "",
        projectId: data.project?.id ?? "",
        joinedViaInvite: data.joinedViaInvite ?? false,
      };
    } catch {
      setError("Network error");
      return null;
    }
  };

  const logout = async () => {
    analytics.capture("user_logged_out");
    const res = await fetch(appUrl("/auth/logout"), { method: "POST", credentials: "include" });
    setUser(null);
    setOrg(null);
    setProjects([]);
    setCurrentProjectId(null);
    setWorkspaceSettings(null);
    analytics.reset();
    // Single sign-on: behind IAP the server names IAP's clear-login-cookie
    // path, otherwise the next request would sign straight back in.
    const body = await res.json().catch(() => null) as { redirectTo?: unknown } | null;
    if (typeof body?.redirectTo === "string" && body.redirectTo.startsWith("/") && !body.redirectTo.startsWith("//")) {
      window.location.assign(body.redirectTo);
      // The page is leaving; don't let callers route to /login and sign in again.
      await new Promise<never>(() => undefined);
    }
  };

  return (
    <AuthContext.Provider value={{
      user, org, projects, members, workspaceSettings, loading, error,
      login, signup, logout, refresh,
      currentProjectId, setCurrentProjectId,
    }}>
      {children}
    </AuthContext.Provider>
  );
}
