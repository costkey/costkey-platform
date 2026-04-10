import { useState, useEffect } from "react";
import { BrowserRouter, Routes, Route, Navigate, Outlet, useNavigate } from "react-router-dom";
import { Settings, ChevronDown, ExternalLink } from "lucide-react";
import { AuthProvider, useAuth } from "./contexts/AuthContext";
import { getHealth } from "./api";
import Login from "./pages/Login";
import Signup from "./pages/Signup";
import Onboarding from "./pages/Onboarding";
import Dashboard from "./pages/Dashboard";
import SettingsPage from "./pages/Settings";
import Invite from "./pages/Invite";

function ProtectedRoute() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen bg-surface flex items-center justify-center">
        <div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!user) return <Navigate to="/login" replace />;
  return <AppShell />;
}

function PipelineStatus({ projectId }: { projectId?: string }) {
  const [status, setStatus] = useState<"active" | "idle" | "inactive" | "no_data">("no_data");
  const [lastEvent, setLastEvent] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId) return;
    const check = () => {
      getHealth(projectId).then((h) => {
        setStatus(h.status);
        setLastEvent(h.lastEventAt);
      }).catch(() => {});
    };
    check();
    const interval = setInterval(check, 30_000); // poll every 30s
    return () => clearInterval(interval);
  }, [projectId]);

  const config = {
    active: { color: "bg-green", label: "collecting", glow: true },
    idle: { color: "bg-amber", label: "idle", glow: false },
    inactive: { color: "bg-red", label: "no data", glow: false },
    no_data: { color: "bg-text-muted", label: "waiting", glow: false },
  }[status];

  const timeAgo = lastEvent ? (() => {
    const ms = Date.now() - new Date(lastEvent).getTime();
    if (ms < 60000) return "just now";
    if (ms < 3600000) return `${Math.floor(ms / 60000)}m ago`;
    if (ms < 86400000) return `${Math.floor(ms / 3600000)}h ago`;
    return `${Math.floor(ms / 86400000)}d ago`;
  })() : null;

  return (
    <div className="flex items-center gap-1.5" title={timeAgo ? `Last event: ${timeAgo}` : "No events received yet"}>
      <div className={`w-1.5 h-1.5 rounded-full ${config.color} ${config.glow ? "glow-dot" : ""}`} />
      <span className="text-[11px] text-text-muted/70 font-mono">{config.label}</span>
      {timeAgo && status !== "active" && (
        <span className="text-[10px] text-text-muted/50 font-mono">{timeAgo}</span>
      )}
    </div>
  );
}

function ProjectSwitcher({ projects, currentProjectId, orgName, onSelect }: {
  projects: Array<{ id: string; name: string }>;
  currentProjectId: string | null;
  orgName?: string;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = projects.find((p) => p.id === currentProjectId) ?? projects[0];

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest("[data-project-switcher]")) setOpen(false);
    };
    document.addEventListener("click", handler);
    return () => document.removeEventListener("click", handler);
  }, [open]);

  return (
    <div className="relative" data-project-switcher>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 px-2.5 py-1 bg-surface-overlay/60 border border-border rounded-sm font-mono text-xs text-text-secondary hover:text-text-primary hover:border-border-bright cursor-pointer transition-all"
      >
        {current?.name ?? orgName}
        <ChevronDown size={11} className={`text-text-muted transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 bg-surface-raised border border-border-bright rounded-sm py-1 min-w-[180px] z-50 shadow-lg shadow-black/30">
          {projects.map((p) => (
            <button
              key={p.id}
              onClick={() => { onSelect(p.id); setOpen(false); }}
              className={`block w-full text-left px-3 py-1.5 font-mono text-xs cursor-pointer transition-colors ${
                p.id === currentProjectId ? "text-accent bg-accent-muted" : "text-text-secondary hover:bg-surface-overlay"
              }`}
            >
              {p.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function AppShell() {
  const { user, org, projects, currentProjectId, setCurrentProjectId } = useAuth();
  const navigate = useNavigate();
  const currentProject = projects.find((p) => p.id === currentProjectId) ?? projects[0];

  return (
    <div className="min-h-screen bg-surface flex flex-col">
      {/* Header */}
      <header className="relative border-b border-border bg-surface sticky top-0 z-50">
        <div className="max-w-[1440px] mx-auto px-6 h-14 flex items-center gap-4">
          <button onClick={() => navigate("/")} className="flex items-center gap-2.5 cursor-pointer group">
            <img src="/favicon.svg" alt="CostKey" className="w-6 h-6 group-hover:brightness-110 transition-all" />
            <span className="font-mono text-sm font-semibold text-text-primary tracking-tight">
              CostKey
            </span>
          </button>

          <div className="w-px h-5 bg-border" />

          {/* Project switcher */}
          {projects.length > 1 ? (
            <ProjectSwitcher
              projects={projects}
              currentProjectId={currentProjectId}
              orgName={org?.name}
              onSelect={setCurrentProjectId}
            />
          ) : (
            <span className="px-2.5 py-1 bg-surface-overlay/40 border border-border/60 rounded-sm font-mono text-xs text-text-muted">
              {currentProject?.name ?? org?.name}
            </span>
          )}

          {/* Right side */}
          <div className="ml-auto flex items-center gap-3">
            <a
              href="https://costkey.dev/docs"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 text-[11px] text-text-muted font-mono hover:text-text-secondary transition-colors"
            >
              Docs
              <ExternalLink size={10} />
            </a>

            <div className="w-px h-4 bg-border" />

            <PipelineStatus projectId={currentProjectId ?? projects[0]?.id} />

            <button
              onClick={() => navigate("/settings")}
              className="p-1.5 text-text-muted hover:text-text-secondary transition-colors cursor-pointer rounded-sm hover:bg-surface-overlay"
            >
              <Settings size={14} />
            </button>

            <div className="w-7 h-7 rounded-full bg-accent-muted flex items-center justify-center font-mono text-xs text-accent font-medium cursor-pointer"
              title={user?.email}
            >
              {user?.name?.charAt(0).toUpperCase() ?? "?"}
            </div>
          </div>
        </div>
      </header>

      <div className="flex-1">
        <Outlet />
      </div>

      <footer className="border-t border-border/50">
        <div className="max-w-[1440px] mx-auto px-6 py-2 flex items-center justify-between">
          <span className="font-mono text-[9px] text-text-muted/50">costkey v0.2.0</span>
          <div className="flex items-center gap-3">
            <a href="https://costkey.dev/docs" target="_blank" rel="noopener noreferrer" className="font-mono text-[9px] text-text-muted/50 hover:text-text-muted transition-colors">Docs</a>
            <span className="text-text-muted/20">|</span>
            <a href="https://github.com/costkey-ai/costkey" target="_blank" rel="noopener noreferrer" className="font-mono text-[9px] text-text-muted/50 hover:text-text-muted transition-colors">GitHub</a>
            <span className="text-text-muted/20">|</span>
            <a href="https://status.costkey.dev" target="_blank" rel="noopener noreferrer" className="font-mono text-[9px] text-text-muted/50 hover:text-text-muted transition-colors">Status</a>
          </div>
        </div>
      </footer>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/signup" element={<Signup />} />
          <Route path="/onboarding" element={<Onboarding />} />
          <Route path="/invite/:token" element={<Invite />} />
          <Route element={<ProtectedRoute />}>
            <Route path="/" element={<Dashboard />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Route>
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
