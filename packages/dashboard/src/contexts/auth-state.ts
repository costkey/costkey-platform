import { createContext } from "react";
import type { WorkspaceSettings } from "../settingsApi";

export interface User {
  id: string;
  email: string;
  name: string;
  orgId: string;
  role: string;
  analyticsId?: string | null;
}

export interface Org {
  id: string;
  name: string;
  slug: string;
  timezone?: string | null;
  analyticsId?: string | null;
}

export interface Project {
  id: string;
  name: string;
  authKey: string | null;
  createdAt: string;
}

export interface AuthState {
  user: User | null;
  org: Org | null;
  projects: Project[];
  members: Array<{ id: string; email: string; name: string; role: string }>;
  workspaceSettings: WorkspaceSettings | null;
  loading: boolean;
  error: string | null;
  login: (email: string, password: string) => Promise<boolean>;
  signup: (email: string, password: string, name: string, orgName: string, inviteToken?: string) => Promise<{ dsn: string; projectId: string; joinedViaInvite?: boolean } | null>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  currentProjectId: string | null;
  setCurrentProjectId: (id: string) => void;
}

export const AuthContext = createContext<AuthState | null>(null);
