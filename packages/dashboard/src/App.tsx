import { BrowserRouter, Routes, Route, Navigate, Outlet, useNavigate } from "react-router-dom";
import { Settings, ChevronDown, ExternalLink } from "lucide-react";
import { AuthProvider, useAuth } from "./contexts/AuthContext";
import Login from "./pages/Login";
import Signup from "./pages/Signup";
import Onboarding from "./pages/Onboarding";
import Dashboard from "./pages/Dashboard";
import SettingsPage from "./pages/Settings";

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

function AppShell() {
  const { user, org, projects, currentProjectId, setCurrentProjectId } = useAuth();
  const navigate = useNavigate();
  const currentProject = projects.find((p) => p.id === currentProjectId) ?? projects[0];

  return (
    <div className="min-h-screen bg-surface flex flex-col">
      {/* Header */}
      <header className="scanline-effect relative border-b border-border bg-surface-raised/50 backdrop-blur-sm sticky top-0 z-50">
        <div className="max-w-[1400px] mx-auto px-6 h-14 flex items-center gap-4">
          <button onClick={() => navigate("/")} className="flex items-center gap-2.5 cursor-pointer group">
            <img src="/favicon.svg" alt="CostKey" className="w-6 h-6 group-hover:brightness-110 transition-all" />
            <span className="font-mono text-sm font-semibold text-text-primary tracking-tight">
              CostKey
            </span>
          </button>

          <div className="w-px h-5 bg-border" />

          {/* Project switcher */}
          {projects.length > 1 ? (
            <div className="relative group">
              <button className="flex items-center gap-1.5 px-2.5 py-1 bg-surface-overlay/60 border border-border rounded-sm font-mono text-xs text-text-secondary hover:text-text-primary hover:border-border-bright cursor-pointer transition-all">
                {currentProject?.name ?? org?.name}
                <ChevronDown size={11} className="text-text-muted" />
              </button>
              <div className="absolute top-full left-0 mt-1 bg-surface-raised border border-border-bright rounded-sm py-1 min-w-[180px] hidden group-hover:block z-50 shadow-lg shadow-black/30">
                {projects.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => setCurrentProjectId(p.id)}
                    className={`block w-full text-left px-3 py-1.5 font-mono text-xs cursor-pointer transition-colors ${
                      p.id === currentProjectId ? "text-accent bg-accent-muted" : "text-text-secondary hover:bg-surface-overlay"
                    }`}
                  >
                    {p.name}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <span className="px-2.5 py-1 bg-surface-overlay/40 border border-border/60 rounded-sm font-mono text-xs text-text-muted">
              {currentProject?.name ?? org?.name}
            </span>
          )}

          {/* Right side */}
          <div className="ml-auto flex items-center gap-3">
            <a
              href="https://docs.costkey.dev"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 text-[11px] text-text-muted font-mono hover:text-text-secondary transition-colors"
            >
              Docs
              <ExternalLink size={10} />
            </a>

            <div className="w-px h-4 bg-border" />

            <div className="flex items-center gap-1.5">
              <div className="w-1.5 h-1.5 rounded-full bg-green glow-dot" />
              <span className="text-[11px] text-text-muted/70 font-mono">collecting</span>
            </div>

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
        <div className="max-w-[1440px] mx-auto px-4 py-1.5 flex items-center justify-between">
          <span className="font-mono text-[9px] text-text-muted/50">costkey v0.2.0</span>
          <div className="flex items-center gap-3">
            <a href="https://docs.costkey.dev" target="_blank" rel="noopener noreferrer" className="font-mono text-[9px] text-text-muted/50 hover:text-text-muted transition-colors">Docs</a>
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
          <Route element={<ProtectedRoute />}>
            <Route path="/" element={<Dashboard />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Route>
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
