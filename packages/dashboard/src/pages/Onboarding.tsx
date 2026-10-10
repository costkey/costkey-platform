import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, CheckCircle2, ChevronDown, CircleAlert, Clock3, Copy, LoaderCircle, Lock, LogOut, Mail, Menu, RefreshCw, X } from "lucide-react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { createProject } from "../settingsApi";
import { useAuth } from "../contexts/useAuth";
import { selectOnboardingProject } from "../onboardingSelection";
import { BrandLockup, BrandMark } from "../components/BrandMark";
import { isPrototypePreview } from "../prototypePreview";
import { PrototypeIcon, type PrototypeIconName } from "../components/PrototypeIcon";
import { Illustration } from "../components/ConsolePrimitives";
import { formatReportedAmount } from "../components/consoleFormatters";
import "./PrototypeRoute.css";

type SetupState = "default" | "loading" | "received" | "ungrouped" | "missing-source" | "unpriced" | "partial" | "rejected" | "restricted" | "error";
type Language = "Python" | "TypeScript";
type CopyTarget = "dsn" | "snippet" | "handoff" | null;

function setupInitials(user: { name?: string; email?: string } | null): string {
  return (user?.name || user?.email || "?")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.slice(0, 1).toUpperCase())
    .join("") || "?";
}

function setupRole(role: string | null | undefined): string {
  const value = role ?? "member";
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function SetupShell({ children, projectName, orgName, user, onLogout }: { children: ReactNode; projectName: string; orgName: string; user: { name?: string; email?: string; role?: string } | null; onLogout: () => void }) {
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const initials = setupInitials(user);
  const navItems = [
    { to: "/", label: "Overview", icon: "overview" },
    { to: "/workflows", label: "Workflows", icon: "workflow" },
    { to: "/agents", label: "Agents", icon: "agent" },
    { to: "/traces", label: "Traces", icon: "trace" },
    { to: "/quality", label: "Quality", icon: "quality" },
    { to: "/models", label: "Models", icon: "model" },
    { to: "/forecast", label: "Forecast", icon: "telescope" },
    { to: "/budgets", label: "Budgets", icon: "shield" },
    { to: "/alerting", label: "Alerting", icon: "bell" },
    { to: "/settings", label: "Settings", icon: "settings" },
  ] satisfies Array<{ to: string; label: string; icon: PrototypeIconName }>;

  return (
    <div className="ck-shell setup-shell prototype-setup-route">
      <div className="ck-mobile-bar">
        <button className="ck-mobile-menu-button" type="button" onClick={() => setMenuOpen((open) => !open)} aria-expanded={menuOpen} aria-label={menuOpen ? "Close navigation" : "Open navigation"}>{menuOpen ? <X size={19} /> : <Menu size={19} />}</button>
        <Link className="ck-mobile-brand" to="/"><BrandLockup className="setup-mobile-lockup" markClassName="ck-mobile-brand-mark" /></Link>
        <span className="ck-mobile-project">{projectName}</span>
      </div>
      {menuOpen && <button className="ck-mobile-overlay" type="button" onClick={() => setMenuOpen(false)} aria-label="Close navigation" />}
      <aside className={`ck-sidebar ${menuOpen ? "open" : ""}`} aria-label="Primary navigation">
        <Link className="ck-sidebar-brand" to="/" onClick={() => setMenuOpen(false)}>
          <BrandMark className="ck-brand-mark" /><span className="ck-brand-name">CostKey</span>
        </Link>
        <div className="ck-workspace-block">
          <div className="ck-overline">Workspace</div>
          <div className="ck-workspace-name" title={orgName}>{orgName}</div>
          <div className="ck-project-switcher">
            <button className="ck-project-button" type="button" onClick={() => navigate("/settings?section=projects")}><span><PrototypeIcon className="ck-project-glyph" name="folder" size={16} /><span className="ck-project-label">{orgName !== projectName && <small>{orgName}</small>}<strong>{projectName}</strong></span></span><ChevronDown size={14} aria-hidden="true" /></button>
          </div>
        </div>
        <nav className="ck-nav" aria-label="Main">
          {navItems.map(({ to, label, icon }) => <Link key={to} className="ck-nav-link" to={to} onClick={() => setMenuOpen(false)}><PrototypeIcon name={icon} size={18} /><span>{label}</span></Link>)}
        </nav>
        <div className="ck-sidebar-bottom">
          <a className="ck-utility-link ck-help-link" href="https://costkey.dev/docs" target="_blank" rel="noreferrer"><PrototypeIcon name="help" size={18} /><span>Help</span></a>
          <div className="ck-user-row"><span className="ck-user-avatar" aria-hidden="true">{initials}</span><div className="ck-user-meta"><div className="ck-user-name">{user?.name || user?.email || "Signed-out visitor"}</div><div className="ck-user-role">{setupRole(user?.role)}</div></div>{user && <button className="ck-icon-button ck-logout-button" type="button" onClick={onLogout} aria-label="Sign out"><LogOut size={14} /></button>}</div>
        </div>
      </aside>
      <main className="ck-main">
        <header className="ck-topbar">
          <div className="ck-topbar-left"><button className="ck-topbar-menu" type="button" onClick={() => setMenuOpen((open) => !open)} aria-expanded={menuOpen} aria-label="Open navigation"><Menu size={17} aria-hidden="true" /></button><div className="ck-crumbs" aria-label="Breadcrumb"><span>{projectName}</span><PrototypeIcon name="right" size={14} className="ck-crumb-separator" /><strong>Project setup</strong></div></div>
          <div className="ck-topbar-actions">{isPrototypePreview() && <span className="ck-preview-badge">Design preview</span>}</div>
        </header>
        <div className="ck-main-inner">{children}</div>
      </main>
    </div>
  );
}

function SetupStepper({ step }: { step: "workspace" | "project" | "connect" }) {
  return (
    <nav className="setup-stepper" aria-label="Setup progress">
      <span className={step === "workspace" ? "active" : ""}><i>1</i> Workspace</span>
      <PrototypeIcon name="right" size={14} aria-hidden="true" />
      <span className={step === "project" ? "active" : ""}><i>2</i> Project</span>
      <PrototypeIcon name="right" size={14} aria-hidden="true" />
      <span className={step === "connect" ? "active" : ""}><i>3</i> First run</span>
    </nav>
  );
}

function SetupHeader({ title, copy, onBack }: { title: string; copy?: string; onBack: () => void }) {
  return <div className="ck-page-header setup-page-header"><div><h1 className="ck-page-title">{title}</h1>{copy && <p className="ck-page-description">{copy}</p>}</div><button className="ck-button ck-button-quiet setup-back-button" type="button" onClick={onBack}><ArrowLeft size={14} aria-hidden="true" /> Back to Overview</button></div>;
}

function SetupFormField({ label, id, children, hint }: { label: string; id?: string; children: ReactNode; hint?: string }) {
  return <div className="ck-form-field"><label htmlFor={id}>{label}</label>{children}{hint && <small>{hint}</small>}</div>;
}

function SetupStateBadge({ state, received }: { state: SetupState; received: boolean }) {
  if (received) return <span className="ck-status-pill ck-status-good"><CheckCircle2 size={13} aria-hidden="true" /> Receiving runs</span>;
  if (state === "rejected" || state === "error") return <span className="ck-status-pill ck-status-critical"><CircleAlert size={13} aria-hidden="true" /> {state === "rejected" ? "Runs rejected" : "Needs a look"}</span>;
  return <span className="ck-status-pill ck-status-neutral"><Clock3 size={13} aria-hidden="true" /> Waiting for your first run</span>;
}

/** The DSN points at this CostKey host; the SDK posts to <host>/api/v1/events. */
function projectDsn(authKey: string | null | undefined, projectId: string): string {
  if (!authKey) return "";
  return `${window.location.protocol}//${authKey}@${window.location.host}/${projectId}`;
}

export default function Onboarding() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { projects, loading: authLoading, user, org, refresh, logout } = useAuth();
  const stepParam = searchParams.get("step");
  const step: "workspace" | "project" | "connect" = stepParam === "workspace" ? "workspace" : stepParam === "project" ? "project" : "connect";
  const requestedState = searchParams.get("state");
  const state: SetupState = requestedState && ["loading", "received", "ungrouped", "missing-source", "unpriced", "partial", "rejected", "restricted", "error"].includes(requestedState) ? requestedState as SetupState : "default";
  const project = selectOnboardingProject(projects, searchParams.get("project"));
  const projectId = project?.id ?? "";
  const projectName = project?.name ?? (isPrototypePreview() ? "Atlas" : "Project");
  const dsn = projectDsn(project?.authKey, project?.id ?? "");
  const [language, setLanguage] = useState<Language>(searchParams.get("language") === "TypeScript" ? "TypeScript" : "Python");
  const [copied, setCopied] = useState<CopyTarget>(null);
  const [dsnRevealed, setDsnRevealed] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [activity, setActivity] = useState<{ calls: number; cost: number | null; firstSeen: boolean } | null>(null);
  const [checkKey, setCheckKey] = useState(0);
  const [checking, setChecking] = useState(false);
  const [latestDestination, setLatestDestination] = useState<string | null>(null);
  const [workspaceName, setWorkspaceName] = useState(org?.name ?? (isPrototypePreview() ? "Northstar" : ""));
  const [projectNameInput, setProjectNameInput] = useState(isPrototypePreview() ? "Atlas" : "");
  const [projectDescription, setProjectDescription] = useState(isPrototypePreview() ? "AI search and document services" : "");
  const [formError, setFormError] = useState<string | null>(null);
  const [creatingProject, setCreatingProject] = useState(false);
  const initialCount = useRef<number | null>(null);

  // Poll the real project until runs arrive. A project that already has
  // runs shows them immediately; nothing here is simulated.
  useEffect(() => {
    if (!projectId || state !== "default") return;
    let alive = true;
    let interval = 0;
    const poll = async () => {
      try {
        const response = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/overview`, { credentials: "include" });
        if (!response.ok || !alive) return;
        const data = await response.json() as { overview?: { observations?: number; total_calls?: number; known_cost?: number | null } };
        const count = Number(data.overview?.observations ?? data.overview?.total_calls ?? 0) || 0;
        const cost = data.overview?.known_cost == null ? null : Number(data.overview.known_cost);
        if (initialCount.current == null) initialCount.current = count;
        if (!alive) return;
        setActivity({ calls: count, cost, firstSeen: initialCount.current === 0 && count > 0 });
        setChecking(false);
        if (count === 0) return;
        window.clearInterval(interval);
        const tracesResponse = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/traces?limit=1&offset=0`, { credentials: "include" });
        if (tracesResponse.ok) {
          const traceData = await tracesResponse.json() as { traces?: Array<{ trace_id?: string | null }> };
          const traceId = traceData.traces?.[0]?.trace_id;
          if (alive && traceId) setLatestDestination(`/traces/${encodeURIComponent(traceId)}`);
        }
      } catch { if (alive) setChecking(false); }
    };
    interval = window.setInterval(() => void poll(), 3000);
    void poll();
    return () => { alive = false; window.clearInterval(interval); };
  }, [projectId, state, checkKey]);

  async function copyText(text: string, target: Exclude<CopyTarget, null>): Promise<void> {
    setCopyError(null);
    if (!text) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(text);
      setCopied(target);
      window.setTimeout(() => setCopied(null), 1800);
    } catch {
      setCopyError("Couldn’t copy. Select the text and copy it yourself.");
    }
  }

  async function submitProject(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setFormError(null);
    setCreatingProject(true);
    try {
      const result = await createProject({ name: projectNameInput.trim(), description: projectDescription.trim() || undefined });
      await refresh();
      navigate(`/onboarding?project=${encodeURIComponent(result.id)}`);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Couldn’t create the project. Your details are still here.");
    } finally {
      setCreatingProject(false);
    }
  }

  const shellProps = { projectName, orgName: org?.name ?? (isPrototypePreview() ? "Northstar" : "Workspace"), user, onLogout: () => { void logout().then(() => navigate("/login")); } };

  if (authLoading || state === "loading") {
    return <SetupShell {...shellProps}><SetupHeader title="Loading setup" onBack={() => navigate("/")} /><SetupStepper step="connect" /><div className="ck-setup-layout"><section className="ck-panel setup-loading-panel"><div className="ck-skeleton setup-skeleton-title" /><div className="ck-skeleton setup-skeleton-block" /><div className="ck-skeleton setup-skeleton-block short" /></section><aside className="ck-panel setup-loading-panel"><div className="ck-skeleton setup-skeleton-title" /><div className="ck-skeleton setup-skeleton-status" /><p>Checking for runs…</p></aside></div></SetupShell>;
  }

  // Signup creates the workspace; outside the design preview this step has
  // nothing to save, so go straight to naming a project.
  if (step === "workspace" && !isPrototypePreview()) return <Navigate to="/onboarding?step=project" replace />;

  if (step === "workspace") {
    return <SetupShell {...shellProps}><SetupHeader title="Create a workspace" onBack={() => navigate("/")} /><SetupStepper step="workspace" /><form className="ck-panel ck-form setup-form-panel" onSubmit={(event) => { event.preventDefault(); navigate("/onboarding?step=project"); }}><div className="ck-form-section"><h2 className="ck-form-section-title">Name your workspace</h2><p className="ck-form-section-copy">Your projects, team and budgets live here.</p><div className="ck-form-grid"><SetupFormField label="Workspace name" id="workspace-name"><input id="workspace-name" className="ck-input" type="text" value={workspaceName} onChange={(event) => setWorkspaceName(event.target.value)} required /></SetupFormField><SetupFormField label="Timezone" id="workspace-timezone" hint="Used for calendar windows and daily rollups."><select id="workspace-timezone" className="ck-select" defaultValue={Intl.DateTimeFormat().resolvedOptions().timeZone}><option>Asia/Kolkata</option><option>UTC</option><option>America/New_York</option></select></SetupFormField><SetupFormField label="Reporting currency" id="workspace-currency" hint="You can change this later in Settings."><select id="workspace-currency" className="ck-select" defaultValue="USD"><option>USD</option><option>INR</option></select></SetupFormField></div></div><div className="ck-form-section"><label className="setup-check-row"><input type="checkbox" defaultChecked /><span><strong>Send a weekly summary</strong><small>Monday at 09:00 in your timezone · Previous calendar week.</small></span></label></div><div className="ck-form-actions"><button className="ck-button ck-button-primary" type="submit">Create workspace <ArrowRight size={15} aria-hidden="true" /></button><span>$10/month per workspace. Teammates included.</span></div></form></SetupShell>;
  }

  if (step === "project") {
    return <SetupShell {...shellProps}><SetupHeader title="Create a project" onBack={() => navigate("/onboarding?step=workspace")} /><SetupStepper step="project" /><form className="ck-panel ck-form setup-form-panel" onSubmit={submitProject}><div className="ck-form-section"><h2 className="ck-form-section-title">Name your project</h2><p className="ck-form-section-copy">A project can cover several environments, services and providers.</p><SetupFormField label="Project name" id="project-name" hint="Use a name your whole team will recognize."><input id="project-name" className="ck-input" type="text" value={projectNameInput} onChange={(event) => setProjectNameInput(event.target.value)} required /></SetupFormField><div className="ck-form-field setup-description-field"><label htmlFor="project-description">Description <span>(optional)</span></label><textarea id="project-description" className="ck-textarea" value={projectDescription} onChange={(event) => setProjectDescription(event.target.value)} placeholder="What does this project do?" /></div>{formError && <div className="ck-alert ck-alert-error" role="alert"><CircleAlert size={15} aria-hidden="true" />{formError}</div>}</div><div className="ck-form-actions"><button className="ck-button ck-button-primary" type="submit" disabled={creatingProject}>{creatingProject ? <><LoaderCircle size={15} className="auth-spin" /> Creating project…</> : <>Create project <ArrowRight size={15} aria-hidden="true" /></>}</button><span>No provider billing credentials or business labels are required.</span></div></form></SetupShell>;
  }

  if (!authLoading && !user) {
    return <SetupShell {...shellProps}><SetupHeader title="Connect your application" copy="Sign in to retrieve a project-scoped setup guide." onBack={() => navigate("/login")} /><SetupStepper step="connect" /><section className="ck-panel setup-restricted"><Lock size={20} aria-hidden="true" /><h2>Sign in to continue setup</h2><p>Your project DSN and capture settings are only available inside an authenticated workspace.</p><Link className="ck-button ck-button-primary" to="/login?returnTo=%2Fonboarding">Back to sign in <ArrowRight size={15} aria-hidden="true" /></Link></section></SetupShell>;
  }

  if (!authLoading && !user?.role || (!authLoading && !["owner", "admin"].includes(user?.role ?? ""))) {
    return <SetupShell {...shellProps}><SetupHeader title="Connect your application" onBack={() => navigate("/")} /><SetupStepper step="connect" /><section className="ck-panel setup-restricted"><Lock size={20} aria-hidden="true" /><h2>Project setup needs an Admin</h2><p>Owners and Admins manage projects, DSNs and capture. You can still view permitted costs and send a setup request.</p><div className="ck-form-actions"><Link className="ck-button ck-button-primary" to="/settings?section=projects">Open project settings</Link><a className="ck-button ck-button-secondary" href={`mailto:?subject=${encodeURIComponent("CostKey setup request")}&body=${encodeURIComponent("Please share an authorized CostKey setup link for the project.")}`}><Mail size={15} aria-hidden="true" /> Request setup</a></div></section></SetupShell>;
  }

  if (!project) {
    return <SetupShell {...shellProps}><SetupHeader title="Connect your application" onBack={() => navigate("/")} /><SetupStepper step="connect" /><section className="ck-panel setup-restricted"><CircleAlert size={20} aria-hidden="true" /><h2>Create a project first</h2><p>A project DSN is required before setup instructions can be generated. Create one in Settings, then return here.</p><Link className="ck-button ck-button-primary" to="/settings?section=projects">Create project <ArrowRight size={15} aria-hidden="true" /></Link></section></SetupShell>;
  }

  const previewReceived = ["received", "ungrouped", "missing-source", "unpriced", "partial"].includes(state);
  const received = previewReceived || (activity?.calls ?? 0) > 0;
  const displayedDsn = dsnRevealed ? dsn : dsn.replace(/\/\/[^@]+@/, "//••••••••@");
  const money = (value: number | null | undefined) => value == null ? "Unpriced" : formatReportedAmount(value, "USD");
  const statusAmount = previewReceived ? (state === "unpriced" ? "Unpriced" : state === "partial" ? "$0.42 known" : "$0.42") : money(activity?.cost);
  const statusMeta = previewReceived ? (state === "unpriced" ? "Usage recorded · no price yet" : `${state === "partial" ? "Some calls unpriced" : "5 calls"} · sample data`) : `${(activity?.calls ?? 0).toLocaleString()} call${activity?.calls === 1 ? "" : "s"} recorded so far`;
  const install = language === "Python" ? "pip install costkey" : "npm install costkey";
  const snippetText = language === "Python"
    ? `import os\nimport costkey\n\ncostkey.init(dsn=os.environ["COSTKEY_DSN"])\n\n# Calls to supported providers are now tracked.`
    : `import { CostKey } from "costkey";\n\nCostKey.init({ dsn: process.env.COSTKEY_DSN });\n\n// Calls to supported providers are now tracked.`;
  const snippet = language === "Python"
    ? <>import os{"\n"}import costkey{"\n\n"}costkey.init(dsn=os.environ[<span className="warm">"COSTKEY_DSN"</span>]){"\n\n"}<span className="comment"># Calls to supported providers are now tracked.</span></>
    : <>import &#123; CostKey &#125; from <span className="warm">"costkey"</span>;{"\n\n"}CostKey.init(&#123; dsn: process.env.COSTKEY_DSN &#125;);{"\n\n"}<span className="comment">// Calls to supported providers are now tracked.</span></>;
  const statusTitle = state === "rejected" ? "Runs are being rejected." : state === "error" ? "Something needs a look." : received ? (activity?.firstSeen || previewReceived ? "Your first run is here." : "Runs are arriving.") : "Ready for your first run.";
  const statusCopy = state === "ungrouped" ? "This call arrived on its own, not as part of a run. You can still inspect it." : state === "unpriced" ? "Usage is arriving, but this model has no price yet." : state === "partial" ? "Runs are arriving. A few calls don’t have a price yet." : state === "missing-source" ? "Costs are tracked. Upload a source map to see file and function names." : state === "rejected" ? "The DSN in your app doesn’t match this project. Copy it again below." : state === "error" ? "We couldn’t check this project. Try again in a moment." : received ? "Now you have something to explore." : "Add the DSN to your app and send a request. This page updates on its own.";
  const setupLink = `${window.location.origin}/onboarding?project=${encodeURIComponent(project.id)}`;

  return <SetupShell {...shellProps}><SetupHeader title="Connect your app" onBack={() => navigate("/")} /><SetupStepper step="connect" /><div className="ck-setup-layout"><div className="setup-guide-column"><section className="ck-panel setup-guide"><div className="ck-panel-header"><div><h2 className="ck-panel-title">Set up {projectName}</h2></div></div><div className="setup-guide-body"><div className="setup-language-tabs" role="tablist" aria-label="SDK language"><button className={language === "Python" ? "active" : ""} type="button" role="tab" aria-selected={language === "Python"} aria-controls="setup-snippet" onClick={() => { setLanguage("Python"); navigate(`/onboarding?project=${encodeURIComponent(project.id)}&language=Python`); }}>Python</button><button className={language === "TypeScript" ? "active" : ""} type="button" role="tab" aria-selected={language === "TypeScript"} aria-controls="setup-snippet" onClick={() => { setLanguage("TypeScript"); navigate(`/onboarding?project=${encodeURIComponent(project.id)}&language=TypeScript`); }}>TypeScript</button></div>
    <div className="setup-guide-section"><div className="setup-section-heading"><h3>1. Install</h3><button className="ck-button ck-button-quiet sm" type="button" onClick={() => void copyText(install, "handoff")}><Copy size={14} aria-hidden="true" />Copy</button></div><pre className="setup-code setup-code-short"><code>{install}</code></pre></div>
    <div className="setup-guide-section"><div className="setup-section-heading"><h3>2. Add your DSN</h3><button className="ck-button ck-button-quiet sm" type="button" onClick={() => setDsnRevealed((revealed) => !revealed)} disabled={!dsn}><Lock size={13} aria-hidden="true" />{dsnRevealed ? "Hide" : "Show"}</button></div><div className="setup-dsn"><code>{displayedDsn || "Ask an Owner or Admin for this project’s DSN"}</code><button className="ck-button ck-button-secondary sm" type="button" onClick={() => void copyText(dsn, "dsn")} disabled={!dsn}><Copy size={14} aria-hidden="true" />{copied === "dsn" ? "Copied" : "Copy"}</button></div><p className="setup-help-copy">Save it as <code>COSTKEY_DSN</code> in your app’s environment. Treat it like a password.</p></div>
    <div className="setup-guide-section"><div className="setup-section-heading"><h3>3. Initialise once at startup</h3><button className="ck-button ck-button-quiet sm" type="button" onClick={() => void copyText(snippetText, "snippet")}><Copy size={14} aria-hidden="true" />{copied === "snippet" ? "Copied" : "Copy"}</button></div><pre className="setup-code" id="setup-snippet"><code>{snippet}</code></pre></div>
    <div className="setup-guide-section setup-step-four"><h3>4. Send a request from your app</h3></div>
    {copyError && <div className="ck-alert ck-alert-error" role="alert"><CircleAlert size={15} aria-hidden="true" />{copyError}</div>}</div></section>
    <div className="setup-handoff"><button className="ck-button ck-button-secondary" type="button" onClick={() => void copyText(setupLink, "handoff")}><Mail size={14} aria-hidden="true" />{copied === "handoff" ? "Link copied" : "Copy a setup link for a teammate"}</button></div></div>
    <aside className="setup-status-column"><section className={`ck-panel setup-status-card ${received ? "is-lit" : ""}`}><Illustration name="first-light" width={240} className="setup-spot" /><SetupStateBadge state={state} received={received} /><h2>{statusTitle}</h2><p>{statusCopy}</p>{received ? <><div className="setup-status-amount">{statusAmount}</div><small>{statusMeta}</small><Link className="ck-button ck-button-primary" to={latestDestination ?? `/traces${state === "ungrouped" ? "?tab=calls" : ""}`}>{latestDestination ? (activity?.firstSeen || previewReceived ? "See your first run" : "See the latest run") : "View runs"} <ArrowRight size={15} aria-hidden="true" /></Link></> : <button className="ck-button ck-button-secondary" type="button" onClick={() => { setChecking(true); setCheckKey((value) => value + 1); }} disabled={checking}><RefreshCw size={15} aria-hidden="true" className={checking ? "ck-spin" : ""} />{checking ? "Checking" : "Check now"}</button>}</section>
    {received ? <section className="ck-panel setup-next-steps"><h3>Make it more useful</h3>{[["Label features and customers", "https://costkey.dev/docs/recipes#1-http-request-name-the-boundary-once"], ["Trace agents", "https://costkey.dev/docs/agents"], ["Group jobs and evals", "https://costkey.dev/docs/recipes#4-grouped-batch-stable-group-fresh-execution"], ["Upload source maps", "https://costkey.dev/docs/sourcemaps"]].map(([label, href]) => <a key={label} href={href} target="_blank" rel="noreferrer"><span>{label}</span><ArrowRight size={14} aria-hidden="true" /></a>)}</section> : <section className="ck-panel setup-next-steps"><h3>What happens next</h3><div className="setup-fact-row"><span>Cost and usage</span><span className="ck-status-pill ck-status-good">Recorded automatically</span></div><div className="setup-fact-row"><span>Grouping into runs</span><span>Automatic for web requests</span></div><div className="setup-fact-row"><span>Feature labels</span><span>Optional</span></div><div className="setup-fact-row"><span>Budgets</span><span>Off until you set one</span></div><p>Installing the SDK never blocks a call.</p></section>}
    </aside></div></SetupShell>;
}
