import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";

interface User {
  id: string;
  email: string;
  name: string;
  orgId: string;
  role: string;
}

interface Org {
  id: string;
  name: string;
  slug: string;
}

interface Project {
  id: string;
  name: string;
  authKey: string;
  createdAt: string;
}

interface AuthState {
  user: User | null;
  org: Org | null;
  projects: Project[];
  members: Array<{ id: string; email: string; name: string; role: string }>;
  loading: boolean;
  error: string | null;
  login: (email: string, password: string) => Promise<boolean>;
  signup: (email: string, password: string, name: string, orgName: string) => Promise<{ dsn: string; projectId: string } | null>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  currentProjectId: string | null;
  setCurrentProjectId: (id: string) => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [org, setOrg] = useState<Org | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [members, setMembers] = useState<Array<{ id: string; email: string; name: string; role: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/auth/me", { credentials: "include" });
      if (!res.ok) {
        setUser(null);
        setOrg(null);
        setProjects([]);
        setMembers([]);
        return;
      }
      const data = await res.json();
      setUser(data.user);
      setOrg(data.org);
      setProjects(data.projects ?? []);
      setMembers(data.members ?? []);
      if (!currentProjectId && data.projects?.length > 0) {
        setCurrentProjectId(data.projects[0].id);
      }
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, [currentProjectId]);

  useEffect(() => { refresh(); }, []);

  const login = async (email: string, password: string): Promise<boolean> => {
    setError(null);
    try {
      const res = await fetch("/auth/login", {
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
      const meRes = await fetch("/auth/me", { credentials: "include" });
      if (meRes.ok) {
        const data = await meRes.json();
        setUser(data.user);
        setOrg(data.org);
        setProjects(data.projects ?? []);
        setMembers(data.members ?? []);
        if (data.projects?.length > 0) {
          setCurrentProjectId(data.projects[0].id);
        }
      }
      return true;
    } catch {
      setError("Network error");
      return false;
    }
  };

  const signup = async (
    email: string, password: string, name: string, orgName: string,
  ): Promise<{ dsn: string; projectId: string } | null> => {
    setError(null);
    try {
      const res = await fetch("/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email, password, name, orgName }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Signup failed");
        return null;
      }
      await refresh();
      return { dsn: data.dsn, projectId: data.project.id };
    } catch {
      setError("Network error");
      return null;
    }
  };

  const logout = async () => {
    await fetch("/auth/logout", { method: "POST", credentials: "include" });
    setUser(null);
    setOrg(null);
    setProjects([]);
    setCurrentProjectId(null);
  };

  return (
    <AuthContext.Provider value={{
      user, org, projects, members, loading, error,
      login, signup, logout, refresh,
      currentProjectId, setCurrentProjectId,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
