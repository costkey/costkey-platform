import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  CircleHelp,
  LogOut,
  Menu,
  X,
} from "lucide-react";
import { BrowserRouter, Link, Navigate, Outlet, Route as RouterRoute, Routes, useLocation, useNavigate } from "react-router-dom";
import { AuthProvider } from "./contexts/AuthContext";
import { useAuth } from "./contexts/useAuth";
import { BrandMark } from "./components/BrandMark";
import { isPrototypePreview } from "./prototypePreview";
import { PrototypeIcon, type PrototypeIconName } from "./components/PrototypeIcon";
const Budgets = lazy(() => import("./pages/Budgets"));
const Costs = lazy(() => import("./pages/Costs"));
const Dashboard = lazy(() => import("./pages/Dashboard"));
const Forecast = lazy(() => import("./pages/Forecast"));
const Executions = lazy(() => import("./pages/Executions"));
const Finding = lazy(() => import("./pages/Finding"));
const Invite = lazy(() => import("./pages/Invite"));
const CliAuth = lazy(() => import("./pages/CliAuth"));
const Login = lazy(() => import("./pages/Login"));
const Onboarding = lazy(() => import("./pages/Onboarding"));
const SettingsPage = lazy(() => import("./pages/Settings"));
const Signup = lazy(() => import("./pages/Signup"));
const Traces = lazy(() => import("./pages/Traces"));
const Workflows = lazy(() => import("./pages/RunGroups").then((module) => ({ default: module.Workflows })));
const Agents = lazy(() => import("./pages/RunGroups").then((module) => ({ default: module.Agents })));
const AgentDetailPage = lazy(() => import("./pages/RunGroups").then((module) => ({ default: module.AgentDetailPage })));
const Quality = lazy(() => import("./pages/Quality"));
const Alerting = lazy(() => import("./pages/Alerting"));
const ContributorPage = lazy(() => import("./pages/ProductParityRoutes").then((module) => ({ default: module.ContributorPage })));
const FindingDrawerPage = lazy(() => import("./pages/ProductParityRoutes").then((module) => ({ default: module.FindingDrawerPage })));
const ComparePage = lazy(() => import("./pages/ProductParityRoutes").then((module) => ({ default: module.ComparePage })));
const PolicyDetailPage = lazy(() => import("./pages/ProductParityRoutes").then((module) => ({ default: module.PolicyDetailPage })));
const PolicyEditPage = lazy(() => import("./pages/ProductParityRoutes").then((module) => ({ default: module.PolicyEditPage })));

function displayProjectName(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+\(synthetic\)$/i, "").trim() || "Project";
}

// Prototype roles render capitalized ("Owner", "Admin"); the API returns lowercase.
function displayRole(role: string | null | undefined): string {
  const value = role ?? "member";
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function ShellLoading() {
  return (
    <div className="ck-shell">
      <div className="ck-mobile-bar" />
      <aside className="ck-sidebar" aria-label="Loading navigation">
        <div className="ck-sidebar-brand"><span className="ck-skeleton" style={{ width: 25, height: 25 }} /><span className="ck-skeleton" style={{ width: 82 }} /></div>
        <div className="ck-workspace-block"><span className="ck-skeleton" style={{ width: 74 }} /><span className="ck-skeleton" style={{ width: 142, marginTop: 12 }} /></div>
      </aside>
      <main className="ck-main"><div className="ck-main-inner"><span className="ck-skeleton" style={{ width: 80, height: 28 }} /></div></main>
    </div>
  );
}

function RouteLoading() {
  return <ShellLoading />;
}

function ProtectedRoute() {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <ShellLoading />;
  if (!user) {
    const returnTo = `${location.pathname}${location.search}${location.hash}`;
    return <Navigate to={`/login?returnTo=${encodeURIComponent(returnTo)}`} replace />;
  }
  return <AppShell />;
}

function ProjectSwitcher() {
  const { projects, currentProjectId, setCurrentProjectId, org, user } = useAuth();
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const current = projects.find((project) => project.id === currentProjectId) ?? projects[0];
  const canManageProjects = user?.role === "owner" || user?.role === "admin";

  useEffect(() => {
    if (!open) return;
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    const close = (event: MouseEvent) => {
      if (!(event.target as HTMLElement).closest("[data-project-switcher]")) {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("keydown", keydown);
    document.addEventListener("click", close);
    return () => { document.removeEventListener("keydown", keydown); document.removeEventListener("click", close); };
  }, [open]);

  useEffect(() => {
    if (open) menuRef.current?.querySelector<HTMLElement>("button, a")?.focus();
  }, [open]);

  function closeMenu(): void {
    setOpen(false);
    window.requestAnimationFrame(() => buttonRef.current?.focus());
  }

  if (projects.length === 0) {
    return canManageProjects
      ? <Link className="ck-project-button" to="/onboarding"><span><PrototypeIcon className="ck-project-glyph" name="plus" size={16} /><span className="ck-project-label"><small>{displayProjectName(org?.name) || "Workspace"}</small><strong>Connect a project</strong></span></span><PrototypeIcon name="right" size={16} /></Link>
      : <div className="ck-project-button" aria-label="No project assigned"><span>No project assigned</span></div>;
  }

  return (
    <div className="ck-project-switcher" data-project-switcher>
      <button ref={buttonRef} className="ck-project-button" type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} aria-haspopup="menu">
        <span><PrototypeIcon className="ck-project-glyph" name="folder" size={16} /><span className="ck-project-label">{org?.name && displayProjectName(org.name) !== displayProjectName(current?.name) && <small>{displayProjectName(org.name)}</small>}<strong>{displayProjectName(current?.name ?? org?.name)}</strong></span></span>
        <PrototypeIcon name="down" size={18} />
      </button>
      {open && (
        <div ref={menuRef} className="ck-project-menu" role="menu" onKeyDown={(event) => {
          const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("button, a"));
          if (event.key === "Tab") {
            if (items.length === 0) return;
            const first = items[0];
            const last = items[items.length - 1];
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
            return;
          }
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          const currentIndex = items.indexOf(document.activeElement as HTMLElement);
          const nextIndex = event.key === "ArrowDown" ? (currentIndex + 1) % items.length : (currentIndex - 1 + items.length) % items.length;
          event.preventDefault();
          items[nextIndex]?.focus();
        }}>
          {projects.map((project) => (
            <button
              className="ck-project-option"
              key={project.id}
              type="button"
              role="menuitem"
              aria-current={project.id === currentProjectId}
              onClick={() => { setCurrentProjectId(project.id); closeMenu(); }}
            >
              {displayProjectName(project.name)}
            </button>
          ))}
          {canManageProjects && <Link className="ck-project-option" role="menuitem" to="/onboarding" onClick={closeMenu}>Add project</Link>}
        </div>
      )}
    </div>
  );
}

function FeedbackLink() {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const wasOpenRef = useRef(false);

  useEffect(() => {
    if (!open) {
      if (wasOpenRef.current) triggerRef.current?.focus();
      wasOpenRef.current = false;
      return;
    }
    wasOpenRef.current = true;
    textareaRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
      }
      if (event.key === "Tab") {
        const dialog = document.querySelector<HTMLElement>(".ck-dialog");
        if (!dialog) return;
        const focusable = Array.from(dialog.querySelectorAll<HTMLElement>("button, textarea, input, select, a[href]:not([aria-disabled='true'])"));
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [open]);

  async function send(): Promise<void> {
    if (!message.trim()) return;
    setStatus("sending");
    try {
      const response = await fetch("/api/v1/feedback", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: message.trim(), type: "feedback" }),
      });
      if (!response.ok) throw new Error("Feedback failed");
      setStatus("sent");
      window.setTimeout(() => { setOpen(false); setMessage(""); setStatus("idle"); }, 1100);
    } catch {
      setStatus("error");
    }
  }

  return (
    <>
      <button ref={triggerRef} className="ck-utility-link" type="button" onClick={() => setOpen(true)}>
        <CircleHelp size={15} aria-hidden="true" />
        <span>Share feedback</span>
      </button>
      {open && (
        <div className="ck-dialog-backdrop" role="presentation" onClick={() => setOpen(false)}>
          <section className="ck-dialog" role="dialog" aria-modal="true" aria-labelledby="feedback-title" onClick={(event) => event.stopPropagation()}>
            <div className="ck-dialog-header"><div><h2 id="feedback-title">Share feedback</h2><p>Tell us what would make cost investigation easier.</p></div><button className="ck-icon-button" type="button" onClick={() => setOpen(false)} aria-label="Close feedback"><X size={16} /></button></div>
            <textarea ref={textareaRef} className="ck-textarea" rows={5} value={message} onChange={(event) => setMessage(event.target.value)} placeholder="What should we improve?" />
            {status === "error" && <p className="ck-form-error">Couldn’t send feedback. Try again.</p>}
            <div className="ck-dialog-footer"><button className="ck-button ck-button-secondary" type="button" onClick={() => setOpen(false)}>Cancel</button><button className="ck-button ck-button-primary" type="button" onClick={() => void send()} disabled={status === "sending" || !message.trim()}>{status === "sending" ? "Sending" : status === "sent" ? "Sent" : "Send feedback"}</button></div>
          </section>
        </div>
      )}
    </>
  );
}

function AppShell() {
  const { user, org, projects, currentProjectId, logout } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const [topbarPanel, setTopbarPanel] = useState<"info" | "index" | null>(null);
  const [sidebarPanel, setSidebarPanel] = useState<"help" | "account" | null>(null);
  const location = useLocation();
  const navigate = useNavigate();

  // The product is light by design ("dark scenes live at the edges, not
  // behind the data"); clear any stale preference from the earlier toggle.
  useEffect(() => {
    document.documentElement.dataset.theme = "light";
    try { window.localStorage.removeItem("costkey-theme"); } catch { /* storage unavailable */ }
  }, []);

  const project = projects.find((item) => item.id === currentProjectId) ?? projects[0];
  const initials = (user?.name || user?.email || "?")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.slice(0, 1).toUpperCase())
    .join("") || "?";

  useEffect(() => {
    if (!sidebarPanel) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setSidebarPanel(null);
      }
    };
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest(".ck-sidebar-popover, .ck-help-link, .ck-user-row")) return;
      setSidebarPanel(null);
    };
    document.addEventListener("keydown", closeOnEscape);
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => {
      document.removeEventListener("keydown", closeOnEscape);
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
    };
  }, [sidebarPanel]);

  // Spend by model, budgets, forecasts and alerts are features inside the tabs.
  const navItems = useMemo(() => [
    { to: "/", label: "Overview", icon: "overview" as PrototypeIconName },
    { to: "/workflows", label: "Workflows", icon: "workflow" as PrototypeIconName },
    { to: "/agents", label: "Agents", icon: "agent" as PrototypeIconName },
    { to: "/traces", label: "Traces", icon: "trace" as PrototypeIconName },
    { to: "/quality", label: "Quality", icon: "quality" as PrototypeIconName },
  ], []);

  function navSection(pathname: string): string {
    if (pathname === "/" || pathname === "/overview" || pathname.startsWith("/finding")) return "/";
    if (pathname.startsWith("/workflows")) return "/workflows";
    if (pathname.startsWith("/agents")) return "/agents";
    if (pathname.startsWith("/traces") || pathname === "/trace" || pathname.startsWith("/compare")) return "/traces";
    if (pathname.startsWith("/executions") || pathname.startsWith("/group")) return "/workflows";
    if (pathname.startsWith("/quality")) return "/quality";
    if (pathname.startsWith("/models") || pathname.startsWith("/costs") || pathname.startsWith("/contributor")) return "/models";
    if (pathname.startsWith("/forecast")) return "/forecast";
    if (pathname.startsWith("/budgets") || pathname.startsWith("/policy")) return "/budgets";
    if (pathname.startsWith("/alerting")) return "/alerting";
    if (pathname.startsWith("/settings")) return "/settings";
    return pathname;
  }

  function isActive(path: string): boolean {
    return navSection(location.pathname) === path;
  }

  function closeMenu(): void { setMenuOpen(false); }

  const pageTitle = (() => {
    const pathname = location.pathname;
    if (pathname === "/trace" || pathname.startsWith("/trace/") || pathname.startsWith("/traces/")) return "Run detail";
    const section = navItems.find((item) => navSection(pathname) === item.to);
    if (section) return section.label;
    if (pathname.startsWith("/findings") || pathname.startsWith("/finding")) return "Needs a look";
    if (pathname.startsWith("/compare")) return "Compare";
    if (pathname.startsWith("/settings")) return "Settings";
    return "Overview";
  })();

  return (
    <div className="ck-shell">
      <div className="ck-mobile-bar">
        <button className="ck-mobile-menu-button" type="button" onClick={() => setMenuOpen((open) => !open)} aria-expanded={menuOpen} aria-label={menuOpen ? "Close navigation" : "Open navigation"}>{menuOpen ? <X size={19} /> : <Menu size={19} />}</button>
        <span className="ck-mobile-title">{pageTitle}</span>
        {isPrototypePreview() && <button className="ck-mobile-index" type="button" onClick={() => setTopbarPanel("index")} aria-label="Open screen index" title="Open screen index"><PrototypeIcon name="overview" size={16} /></button>}
      </div>
      {menuOpen && <div className="ck-mobile-overlay" onClick={closeMenu} role="presentation" />}
      <aside className={`ck-sidebar ${menuOpen ? "open" : ""}`} aria-label="Primary navigation">
        <Link className="ck-sidebar-brand" to="/" onClick={closeMenu}><BrandMark className="ck-brand-mark" /><span className="ck-brand-name">CostKey</span></Link>
        <div className="ck-workspace-block">
          <div className="ck-overline">Workspace</div>
          <div className="ck-workspace-name" title={org?.name}>{org?.name ?? "Your workspace"}</div>
          <ProjectSwitcher />
        </div>
        <nav className="ck-nav" aria-label="Main">
          {navItems.map(({ to, label, icon }) => (
            <Link key={to} className={`ck-nav-link ${isActive(to) ? "active" : ""}`} to={to} onClick={closeMenu} aria-current={isActive(to) ? "page" : undefined}>
              <PrototypeIcon name={icon} size={18} /><span>{label}</span>
            </Link>
          ))}
          <Link className={`ck-nav-link ${isActive("/settings") ? "active" : ""}`} to="/settings" onClick={closeMenu} aria-current={isActive("/settings") ? "page" : undefined}>
            <PrototypeIcon name="settings" size={18} /><span>Settings</span>
          </Link>
        </nav>
        <div className="ck-sidebar-bottom">
          <button className="ck-utility-link ck-help-link" type="button" onClick={() => setSidebarPanel((panel) => panel === "help" ? null : "help")} aria-expanded={sidebarPanel === "help"} aria-haspopup="dialog"><PrototypeIcon name="help" size={18} /><span>Help</span></button>
          {sidebarPanel === "help" && (
            <section className="ck-sidebar-popover ck-help-popover" role="dialog" aria-label="CostKey help">
              <div className="ck-sidebar-popover-heading"><strong>Need a hand?</strong><button className="ck-icon-button" type="button" onClick={() => setSidebarPanel(null)} aria-label="Close help"><X size={14} /></button></div>
              <p>The setup guide covers the SDK, labels and budgets.</p>
              <div className="ck-sidebar-popover-actions"><a href="https://costkey.dev/docs" target="_blank" rel="noreferrer">Open docs <ArrowRight size={13} /></a><a href="https://github.com/costkey-ai/costkey" target="_blank" rel="noreferrer">View SDK <ArrowRight size={13} /></a></div>
            </section>
          )}
          <div className="ck-utility-optional"><FeedbackLink /></div>
          <div className="ck-user-row" role="button" tabIndex={0} aria-expanded={sidebarPanel === "account"} aria-haspopup="dialog" onClick={() => setSidebarPanel((panel) => panel === "account" ? null : "account")} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSidebarPanel((panel) => panel === "account" ? null : "account"); } }}>
            <span className="ck-user-avatar" aria-hidden="true">{initials}</span>
            <div className="ck-user-meta"><div className="ck-user-name" title={user?.email}>{user?.name || user?.email}</div><div className="ck-user-role">{displayRole(user?.role)}</div></div>
            <PrototypeIcon className="ck-account-chevron" name="down" size={18} />
          </div>
          {sidebarPanel === "account" && (
            <section className="ck-sidebar-popover ck-account-popover" role="dialog" aria-label="Account menu">
              <div className="ck-sidebar-popover-heading"><div><strong>{user?.name || user?.email || "Account"}</strong><span>{displayRole(user?.role)}</span></div><button className="ck-icon-button" type="button" onClick={() => setSidebarPanel(null)} aria-label="Close account menu"><X size={14} /></button></div>
              <button className="ck-sidebar-popover-item" type="button" onClick={() => void logout().then(() => navigate("/login"))}><LogOut size={14} aria-hidden="true" /><span>Sign out</span></button>
            </section>
          )}
          {isPrototypePreview() && <button className="ck-review-launch" type="button" onClick={() => setTopbarPanel("index")}><b>All demo screens <ArrowRight size={13} aria-hidden="true" /></b></button>}
        </div>
      </aside>
      <main className="ck-main">
        {isPrototypePreview() && <header className="ck-topbar">
          <div className="ck-topbar-left">
            <button className="ck-topbar-menu" type="button" onClick={() => setMenuOpen((open) => !open)} aria-expanded={menuOpen} aria-label={menuOpen ? "Close navigation" : "Open navigation"}><Menu size={17} aria-hidden="true" /></button>
            <div className="ck-crumbs" aria-label="Breadcrumb">
              <span>{displayProjectName(project?.name ?? org?.name) || "Workspace"}</span>
              <PrototypeIcon name="right" size={14} className="ck-crumb-separator" />
              <strong>{pageTitle}</strong>
            </div>
          </div>
          <div className="ck-topbar-actions">
            <span className="ck-preview-badge">Design preview</span><button className="ck-topbar-icon" type="button" onClick={() => setTopbarPanel("info")} aria-label="About this screen" title="About this screen"><PrototypeIcon name="info" size={16} /></button><button className="ck-topbar-icon" type="button" onClick={() => setTopbarPanel("index")} aria-label="Open screen index" title="Open screen index"><PrototypeIcon name="overview" size={16} /></button>
          </div>
        </header>}
        <Outlet />
        {topbarPanel && <div className="ck-dialog-backdrop" role="presentation" onClick={() => setTopbarPanel(null)}><section className="ck-dialog" role="dialog" aria-modal="true" aria-labelledby="topbar-panel-title" onClick={(event) => event.stopPropagation()}><div className="ck-dialog-header"><div><div className="ck-overline">CostKey console</div><h2 id="topbar-panel-title">{topbarPanel === "info" ? "About this screen" : "Screen index"}</h2></div><button className="ck-icon-button" type="button" onClick={() => setTopbarPanel(null)} aria-label="Close"><X size={16} /></button></div>{topbarPanel === "info" ? <p className="ck-dialog-copy">This view covers the selected project and period.</p> : <nav className="ck-screen-index">{[["/", "Overview"], ["/traces", "Runs"], ["/costs", "Costs"], ["/executions", "Experiments"], ["/forecast", "Forecasts"], ["/budgets", "Budgets"], ["/settings", "Settings"]].map(([to, label]) => <Link key={to} to={to} onClick={() => setTopbarPanel(null)}>{label}<ArrowRight size={13} /></Link>)}</nav>}</section></div>}
      </main>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Suspense fallback={<RouteLoading />}>
          <Routes>
          <RouterRoute path="/login" element={<Login />} />
          <RouterRoute path="/sign-in" element={<Login />} />
          <RouterRoute path="/signup" element={<Signup />} />
          <RouterRoute path="/onboarding" element={<Onboarding />} />
          <RouterRoute path="/setup" element={<Onboarding />} />
          <RouterRoute path="/invite" element={<Invite />} />
          <RouterRoute path="/invite/:token" element={<Invite />} />
          <RouterRoute path="/cli-auth" element={<CliAuth />} />
          <RouterRoute element={<ProtectedRoute />}>
            <RouterRoute path="/" element={<Dashboard />} />
            <RouterRoute path="/overview" element={<Dashboard />} />
            <RouterRoute path="/traces" element={<Traces />} />
            <RouterRoute path="/traces/:traceId" element={<Traces />} />
            <RouterRoute path="/trace" element={<Traces />} />
            <RouterRoute path="/costs" element={<Costs />} />
            <RouterRoute path="/models" element={<Costs defaultGroup="model" title="Models" />} />
            <RouterRoute path="/workflows" element={<Workflows />} />
            <RouterRoute path="/agents" element={<Agents />} />
            <RouterRoute path="/agents/:name" element={<AgentDetailPage />} />
            <RouterRoute path="/errors" element={<Navigate to="/quality" replace />} />
            <RouterRoute path="/quality" element={<Quality />} />
            <RouterRoute path="/alerting" element={<Alerting />} />
            <RouterRoute path="/forecast" element={<Forecast />} />
            <RouterRoute path="/executions" element={<Executions />} />
            <RouterRoute path="/executions/:executionId" element={<Executions />} />
            <RouterRoute path="/findings/:findingId" element={<Finding />} />
            <RouterRoute path="/contributor" element={<ContributorPage />} />
            <RouterRoute path="/finding" element={<FindingDrawerPage />} />
            <RouterRoute path="/compare" element={<ComparePage />} />
            <RouterRoute path="/group" element={<Executions />} />
            <RouterRoute path="/policy" element={<PolicyDetailPage />} />
            <RouterRoute path="/policy-edit" element={<PolicyEditPage />} />
            <RouterRoute path="/budgets" element={<Budgets />} />
            <RouterRoute path="/budgets/:policyId" element={<Budgets />} />
            <RouterRoute path="/settings" element={<SettingsPage />} />
          </RouterRoute>
          </Routes>
        </Suspense>
      </AuthProvider>
    </BrowserRouter>
  );
}
