import { projectDsn } from "../basePath";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  AlertTriangle,
  Check,
  Code2,
  Copy,
  CreditCard,
  Database,
  Eye,
  EyeOff,
  KeyRound,
  Link2,
  Lock,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  Shield,
  Trash2,
  UserPlus,
  X,
} from "lucide-react";
import { useAuth } from "../contexts/useAuth";
import {
  createCustomProvider,
  deleteCustomProvider,
  getCustomProviders,
  updateCustomProvider,
  type CustomProvider,
} from "../api";
import {
  createProject,
  createTeamInvite,
  createCredit,
  createEffectivePrice,
  deleteProject,
  deleteCapturedContent,
  deleteCredit,
  deleteEffectivePrice,
  getConnectionHealth,
  getCredits,
  getFindingThresholds,
  getInvoices,
  getMemberProjects,
  getEffectivePrices,
  getPriceCatalogStatus,
  getUnpricedModels,
  refreshPriceCatalog,
  searchCatalogModels,
  setModelAlias,
  setModelRates,
  getPrivacySettings,
  getProjectDetail,
  getSubscription,
  getTeamInvites,
  removeTeamMember,
  revokeTeamInvite,
  resendTeamInvite,
  rotateProjectKey,
  SettingsApiError,
  startSubscriptionCheckout,
  transferWorkspaceOwnership,
  getWorkspaceClosureImpact,
  requestWorkspaceClosure,
  updateCredit,
  updateFindingThresholds,
  updateEffectivePrice,
  updatePrivacySettings,
  updateTeamMember,
  cancelSubscription,
  resumeSubscription,
  updateProject,
  updateWorkspaceSettings,
  getWorkspaceSettings,
  arrayOrEmpty,
  type ConnectionHealth,
  type Credit,
  type Invoice,
  type EffectivePrice,
  type CatalogModel,
  type PriceCatalogStatus,
  type UnpricedModel,
  type FindingThresholds,
  type PrivacySettings,
  type ProjectDetail,
  type Subscription,
  type TeamInvite,
  type WorkspaceSettings,
  type WorkspaceClosureImpact,
  type BillingTarget,
} from "../settingsApi";
import {
  EmptyPanel,
  LoadingRows,
  PageHeader,
  Panel,
  StatusPill,
} from "../components/ConsolePrimitives";
import { prototypeState, PrototypeStateNotice } from "../components/PrototypeState";
import CodingAgents from "../components/CodingAgents";
import { formatDateTime } from "../components/consoleFormatters";
import { isValidFxBasis, parseFindingThresholdForm, type FindingThresholdFormValues } from "../settingsGuards";
import "./Settings.css";

type Role = "owner" | "admin" | "developer" | "viewer";
type SettingSection = "projects" | "team" | "notifications" | "data" | "pricing" | "agents" | "billing";

interface SettingsProject {
  id: string;
  name: string;
  authKey?: string | null;
  createdAt?: string;
  description?: string | null;
}

interface SettingsMember {
  id: string;
  email: string;
  name: string;
  role: string;
  projectIds?: string[];
}

const sections: Array<{ id: SettingSection; label: string }> = [
  { id: "projects", label: "Projects" },
  { id: "team", label: "Team" },
  { id: "notifications", label: "Notifications" },
  { id: "data", label: "Privacy & data" },
  { id: "pricing", label: "Prices & credits" },
  { id: "agents", label: "Coding agents" },
  { id: "billing", label: "Billing" },
];

/** Plan status in words, never a raw enum. */
function planLabel(status: string | null | undefined): string {
  return ({ active: "Active", trialing: "Trial", past_due: "Payment due", canceled: "Cancelled", cancelled: "Cancelled", incomplete: "Incomplete", not_configured: "No plan" } as Record<string, string>)[String(status ?? "")] ?? (status ? status.replaceAll("_", " ") : "Loading");
}

function normalizeRole(role: unknown): Role {
  switch (String(role ?? "").toLowerCase()) {
    case "owner": return "owner";
    case "admin": return "admin";
    case "developer":
    case "member": return "developer";
    default: return "viewer";
  }
}

function canManage(role: Role): boolean {
  return role === "owner" || role === "admin";
}

function canManageSubscription(role: Role): boolean {
  return role === "owner";
}

function settingSection(value: string | null): SettingSection {
  return sections.some((section) => section.id === value) ? value as SettingSection : "projects";
}

function errorText(error: unknown): string {
  if (error instanceof SettingsApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "Something went wrong. Try again.";
}

function formatDateInput(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value.slice(0, 10) : date.toISOString().slice(0, 10);
}

function formatSettingsDate(value: string | null | undefined): string {
  if (!value) return "Unknown date";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Unknown date";
  // Prototype order ("20 Sep, 14:32") from design/console-prototype/app.js.
  return formatDateTime(value);
}

function maskSecret(value: string | null | undefined): string {
  if (!value) return "Restricted to Owner or Admin";
  return `${value.slice(0, 3)}${"•".repeat(Math.max(8, value.length - 3))}`;
}

function statusTone(status: string): "good" | "warn" | "critical" | "info" | "neutral" {
  if (status === "active" || status === "ok" || status === "sent") return "good";
  if (status === "failed" || status === "error") return "critical";
  if (status === "idle" || status === "inactive" || status === "suppressed") return "warn";
  return "neutral";
}

function healthLabel(health: ConnectionHealth | undefined): string {
  if (!health) return "Unable to check";
  if (health.status === "active") return "Activity arriving";
  if (health.status === "idle") return "Idle; last activity retained";
  if (health.status === "inactive") return "Historical activity";
  if (health.status === "no_data") return "Waiting for activity";
  return "Unable to check";
}

function healthTone(health: ConnectionHealth | undefined): "good" | "warn" | "critical" | "info" {
  if (!health) return "critical";
  if (health.status === "active") return "good";
  if (health.status === "no_data") return "info";
  return "warn";
}

function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }
  return <button className="settings-icon-button" type="button" onClick={() => void copy()} aria-label={copied ? `${label} copied` : label} title={copied ? "Copied" : label}>{copied ? <Check size={14} /> : <Copy size={14} />}</button>;
}

function RolePill({ role }: { role: string }) {
  const normalized = normalizeRole(role);
  return <span className="settings-role-text">{normalized.charAt(0).toUpperCase() + normalized.slice(1)}</span>;
}

function LoadingPanel({ title }: { title: string }) {
  return <Panel title={title}><LoadingRows count={4} columns={3} /></Panel>;
}

interface ConfirmationRequest {
  title: string;
  body: string;
  actionLabel: string;
  onConfirm: () => void | Promise<void>;
  trigger: HTMLElement | null;
}

function useConfirmation() {
  const [request, setRequest] = useState<ConfirmationRequest | null>(null);
  const ask = useCallback((input: Omit<ConfirmationRequest, "trigger">, trigger: HTMLElement | null) => {
    setRequest({ ...input, trigger });
  }, []);
  const close = useCallback(() => {
    const trigger = request?.trigger;
    setRequest(null);
    window.setTimeout(() => {
      if (trigger && document.contains(trigger)) trigger.focus();
    }, 0);
  }, [request]);
  return { ask, dialog: request ? <ConfirmationDialog request={request} onClose={close} /> : null };
}

function ConfirmationDialog({ request, onClose }: { request: ConfirmationRequest; onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    confirmRef.current?.focus();
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [closeRef.current, cancelRef.current, confirmRef.current].filter((item): item is HTMLButtonElement => Boolean(item));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);
  const [busy, setBusy] = useState(false);
  async function confirm(): Promise<void> {
    setBusy(true);
    try { await request.onConfirm(); } finally { setBusy(false); onClose(); }
  }
  return <div className="settings-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className="settings-dialog" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="settings-confirm-title" aria-describedby="settings-confirm-body"><div className="settings-dialog-header"><div><h2 id="settings-confirm-title">{request.title}</h2><p id="settings-confirm-body">{request.body}</p></div><button ref={closeRef} className="settings-icon-button" type="button" onClick={onClose} aria-label="Close confirmation dialog"><X size={14} /></button></div><div className="settings-dialog-footer"><button ref={cancelRef} className="ck-button ck-button-secondary" type="button" onClick={onClose} disabled={busy}>Cancel</button><button ref={confirmRef} className="ck-button ck-button-danger" type="button" onClick={() => void confirm()} disabled={busy}>{busy ? "Working" : request.actionLabel}</button></div></div></div>;
}

export default function Settings() {
  const { user, org, projects, members, refresh, currentProjectId } = useAuth();
  const role = normalizeRole(user?.role);
  const [searchParams, setSearchParams] = useSearchParams();
  const [section, setSection] = useState<SettingSection>(() => settingSection(searchParams.get("section")));
  const previewState = searchParams.get("state");
  const explicitState = prototypeState(searchParams);

  useEffect(() => {
    setSection(settingSection(searchParams.get("section")));
  }, [searchParams]);

  useEffect(() => {
    if (section !== "team" || window.location.hash !== "#ownership-transfer") return;
    const timer = window.setTimeout(() => document.getElementById("ownership-transfer")?.scrollIntoView({ block: "start" }), 0);
    return () => window.clearTimeout(timer);
  }, [section]);

  function chooseSection(next: SettingSection): void {
    setSection(next);
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set("section", next);
    setSearchParams(nextParams, { replace: true });
  }


  function onSectionKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, current: SettingSection): void {
    const index = sections.findIndex((item) => item.id === current);
    const delta = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 0;
    if (!delta) return;
    event.preventDefault();
    const next = sections[(index + delta + sections.length) % sections.length].id;
    chooseSection(next);
    window.setTimeout(() => {
      const nextTab = document.getElementById(`settings-tab-${next}`);
      nextTab?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "nearest", inline: "nearest" });
      nextTab?.focus();
    }, 0);
  }

  const projectItems = projects as SettingsProject[];
  const memberItems = members as SettingsMember[];
  return (
    <div className="ck-main-inner settings-page">
      <PageHeader title="Settings" />
      <PrototypeStateNotice state={explicitState} family="settings" role={role} />
      {explicitState === "capabilities" && <div className="ck-alert" role="status"><Check size={15} /><div><strong>What each integration supports.</strong> Some integrations can stop calls; others can only alert. Each is listed below.</div></div>}
      {explicitState === "rejected" && <div className="ck-alert ck-alert-error" role="alert"><AlertTriangle size={15} /><div><strong>Recent runs were rejected.</strong> Nothing was recorded. Check that your app uses this project’s DSN.</div></div>}
      {explicitState === "missing-source" && <div className="ck-alert" role="status"><AlertTriangle size={15} /><div><strong>No source map for this release.</strong> Costs are tracked fine. Upload a source map to see file and function names.</div></div>}
      {explicitState === "delivery-failed" && <div className="ck-alert ck-alert-error" role="alert"><AlertTriangle size={15} /><div><strong>An alert couldn’t be delivered.</strong> Your settings are saved. Check the destination below.</div></div>}
      {explicitState === "expired" && <div className="ck-alert" role="status"><AlertTriangle size={15} /><div><strong>Invitation expired.</strong> That invitation has expired. Send a new one from Team.</div></div>}
      {explicitState === "cancelled" && <div className="ck-alert" role="status"><Check size={15} /><div><strong>Cancellation scheduled.</strong> Your workspace stays active until the end of the paid period.</div></div>}
      <div className="settings-layout">
        <div className="settings-nav-wrap">
          <nav className="settings-nav" aria-label="Settings sections" role="tablist" aria-orientation="vertical">
            {sections.map(({ id, label }) => <button className={`settings-nav-button ${section === id ? "active" : ""}`} key={id} id={`settings-tab-${id}`} type="button" role="tab" tabIndex={section === id ? 0 : -1} onClick={() => chooseSection(id)} onKeyDown={(event) => onSectionKeyDown(event, id)} aria-current={section === id ? "page" : undefined} aria-selected={section === id} aria-controls={`settings-panel-${id}`}>{label}</button>)}
          </nav>
        </div>
        <div className="settings-content" id={`settings-panel-${section}`} role="tabpanel" tabIndex={-1} aria-labelledby={`settings-tab-${section}`}>
          {previewState === "loading" ? <Panel><LoadingRows count={5} columns={4} /></Panel> : <>
            {previewState === "error" && <div className="ck-alert ck-alert-error" role="alert"><AlertTriangle size={15} /><span>Couldn’t refresh settings. Nothing was changed.</span></div>}
            {previewState === "restricted" && <div className="ck-alert" role="status"><Lock size={15} /><div><strong>Some settings are view only for you.</strong> Owners and Admins can change them.</div></div>}
            {section === "projects" && <ProjectsConnections projects={projectItems} role={role} refresh={refresh} currentProjectId={currentProjectId} />}
            {section === "team" && <TeamAccess projects={projectItems} members={memberItems} userId={user?.id ?? ""} role={role} orgName={org?.name ?? "Workspace"} refresh={refresh} />}
            {section === "notifications" && <NotificationsSettings projects={projectItems} role={role} userEmail={user?.email ?? ""} />}
            {section === "data" && <DataSourceSettings projects={projectItems} role={role} currentProjectId={currentProjectId} />}
            {section === "pricing" && <PricingCredits projects={projectItems} role={role} currentProjectId={currentProjectId} />}
            {section === "agents" && <CodingAgents projects={projectItems} />}
            {section === "billing" && <BillingSettings role={role} orgId={user?.orgId ?? org?.id ?? null} billingQuery={searchParams.get("billing")} />}
          </>}
        </div>
      </div>
    </div>
  );
}

function ProjectsConnections({ projects, role, refresh, currentProjectId }: { projects: SettingsProject[]; role: Role; refresh: () => Promise<void>; currentProjectId: string | null }) {
  const [selectedId, setSelectedId] = useState(currentProjectId ?? projects[0]?.id ?? "");
  const [details, setDetails] = useState<Record<string, ProjectDetail | undefined>>({});
  const [health, setHealth] = useState<Record<string, ConnectionHealth | undefined>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [newDescription, setNewDescription] = useState("");
  const [creating, setCreating] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [editingDescription, setEditingDescription] = useState("");
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const confirmation = useConfirmation();

  const projectKey = useMemo(() => projects.map((project) => project.id).join(","), [projects]);
  useEffect(() => {
    if (currentProjectId && projects.some((project) => project.id === currentProjectId)) setSelectedId(currentProjectId);
  }, [currentProjectId, projects]);
  useEffect(() => {
    let alive = true;
    async function load(): Promise<void> {
      setLoading(true); setError(null);
      const nextDetails: Record<string, ProjectDetail | undefined> = {};
      const nextHealth: Record<string, ConnectionHealth | undefined> = {};
      await Promise.all(projects.map(async (project) => {
        const [detail, pipeline] = await Promise.allSettled([getProjectDetail(project.id), getConnectionHealth(project.id)]);
        if (detail.status === "fulfilled") nextDetails[project.id] = detail.value.project;
        if (pipeline.status === "fulfilled") nextHealth[project.id] = pipeline.value;
      }));
      if (!alive) return;
      setDetails(nextDetails); setHealth(nextHealth); if (projects.length === 0) setSelectedId(""); setLoading(false);
    }
    void load().catch((loadError: unknown) => { if (alive) { setError(errorText(loadError)); setLoading(false); } });
    return () => { alive = false; };
  }, [projectKey, projects]);

  async function create(): Promise<void> {
    if (!canManage(role) || !newName.trim()) return;
    setCreating(true); setActionMessage(null); setActionError(null);
    try { const result = await createProject({ name: newName.trim(), description: newDescription.trim() || undefined }); setNewName(""); setNewDescription(""); setSelectedId(result.id); setAddOpen(false); setActionMessage("Project created."); await refresh(); }
    catch (createError) { setActionError(errorText(createError)); }
    finally { setCreating(false); }
  }
  function startRename(project: SettingsProject): void { setEditingId(project.id); setEditingName(project.name); setEditingDescription(project.description ?? details[project.id]?.description ?? ""); setActionError(null); setActionMessage(null); }
  async function saveRename(): Promise<void> {
    if (!editingId || !editingName.trim()) return;
    setActionMessage(null); setActionError(null);
    try { await updateProject(editingId, { name: editingName.trim(), description: editingDescription.trim() || null }); setEditingId(null); setActionMessage("Project details updated."); await refresh(); }
    catch (renameError) { setActionError(errorText(renameError)); }
  }
  function rotate(project: SettingsProject, trigger: HTMLElement): void {
    if (!canManage(role)) return;
    confirmation.ask({ title: `Rotate ${project.name}'s DSN?`, body: "Apps using the old DSN stop sending right away. Update them with the new one.", actionLabel: "Rotate DSN", onConfirm: async () => {
      setActionMessage(null); setActionError(null);
      try { await rotateProjectKey(project.id); setRevealed((current) => ({ ...current, [project.id]: false })); setActionMessage("DSN rotated. Update your app to keep sending runs."); await refresh(); }
      catch (rotateError) { setActionError(errorText(rotateError)); }
    } }, trigger);
  }
  function remove(project: SettingsProject, trigger: HTMLElement): void {
    if (!canManage(role)) return;
    confirmation.ask({ title: `Delete ${project.name}?`, body: "This deletes the project and everything recorded for it. This can’t be undone.", actionLabel: "Delete project", onConfirm: async () => {
      setActionMessage(null); setActionError(null);
      try { await deleteProject(project.id); setActionMessage(`Deleted ${project.name}.`); await refresh(); }
      catch (deleteError) { setActionError(errorText(deleteError)); }
    } }, trigger);
  }

  return <>
    {confirmation.dialog}
    <Panel className="settings-projects-primary">
      <div className="settings-card-body"><div className="settings-section-title"><div><h2>Projects</h2></div>{canManage(role) && !addOpen && <button className="ck-button ck-button-secondary" type="button" onClick={() => setAddOpen(true)}><Plus size={13} /> New project</button>}</div></div>
    {(actionMessage || actionError) && <div className={`settings-status-line ${actionError ? "error" : "success"}`} role={actionError ? "alert" : "status"}>{actionError ?? actionMessage}</div>}
    {error && <div className="ck-alert"><AlertTriangle size={15} /><span>{error}</span></div>}
    {loading ? <div className="settings-card-body"><LoadingRows count={4} columns={3} /></div> : projects.length === 0 ? <div className="settings-card-body"><EmptyPanel title="No project yet" body={canManage(role) ? "Create a project, then add its DSN to your app. New projects record cost and usage only." : "You don’t have a project yet. Ask an Owner or Admin to add you to one."} icon={<Server size={18} />} /></div> : <div className="settings-project-list">{projects.map((project) => {
      const detail = details[project.id]; const pipeline = health[project.id]; const authKey = typeof project.authKey === "string" ? project.authKey : null; const dsn = authKey ? projectDsn(authKey, project.id) : null;
      const pricingHint = pipeline?.hints?.find((hint) => hint.type === "unpriced_calls");
      const receivingLabel = pipeline?.status === "active" ? "Receiving runs" : healthLabel(pipeline);
      const projectDescription = project.id === "proj_preview" ? "Production, Development · search-api, document-worker, voice-service" : (detail?.description ?? project.description ?? "");
      return <div className="settings-project-card" key={project.id}><div className="settings-card-body"><div className="settings-card-heading"><div><h3>{project.name}</h3>{projectDescription && <p>{projectDescription}</p>}</div>{/* Idle projects show no pill: the sidebar dot carries live status. */}{(pipeline?.status === "active" || pipeline?.status === "no_data") && <div className="settings-card-meta"><StatusPill tone={healthTone(pipeline)}>{receivingLabel}</StatusPill></div>}</div>
        {pricingHint && <div className="settings-project-warning"><StatusPill tone="warn">{pricingHint.message.replace(/\.$/, "")}</StatusPill><Link className="ck-text-link" to="/settings?section=pricing">Add a rate</Link></div>}
        {project.id === "proj_preview" ? <div className="settings-key-row" style={{ marginTop: 18 }}><code>https://••••••••@ingest.example.invalid/atlas</code>{canManage(role) && <button className="ck-button ck-button-secondary sm" type="button" onClick={(event) => rotate(project, event.currentTarget)} aria-label={`Rotate DSN for ${project.name}`}><RefreshCw size={12} /> Rotate DSN</button>}</div> : <div className="settings-key-row" style={{ marginTop: 18 }}><KeyRound size={14} aria-hidden="true" /><code className={revealed[project.id] ? "revealed" : ""}>{dsn ? (revealed[project.id] ? dsn : maskSecret(dsn)) : maskSecret(null)}</code>{dsn && canManage(role) && <button className="settings-icon-button" type="button" onClick={() => setRevealed((current) => ({ ...current, [project.id]: !current[project.id] }))} aria-label={revealed[project.id] ? "Hide DSN" : "Reveal DSN"}>{revealed[project.id] ? <EyeOff size={14} /> : <Eye size={14} />}</button>}{dsn && canManage(role) && revealed[project.id] && <CopyButton value={dsn} label="Copy DSN" />}{canManage(role) && <button className="ck-button ck-button-quiet sm" type="button" onClick={(event) => rotate(project, event.currentTarget)} aria-label={`Rotate DSN for ${project.name}`}><RefreshCw size={12} /> Rotate DSN</button>}</div>}
        {!canManage(role) && <p className="settings-footnote" style={{ marginTop: 8 }}><Lock size={12} style={{ verticalAlign: "-2px" }} /> Only Owners and Admins can see and rotate DSNs.</p>}
        <div className="settings-project-actions"><Link className="ck-button ck-button-secondary" aria-label={`Open setup guide for ${project.name}`} to={`/onboarding?project=${encodeURIComponent(project.id)}`}><Code2 size={13} /> Open setup guide</Link>{canManage(role) && project.id !== "proj_preview" && <span className="settings-project-actions-end"><button className="ck-button ck-button-quiet" type="button" onClick={() => startRename(project)} aria-label={`Edit ${project.name}`}><Pencil size={13} /> Edit</button><button className="ck-button ck-button-quiet ck-button-danger-quiet" type="button" onClick={(event) => remove(project, event.currentTarget)} aria-label={`Delete ${project.name}`}><Trash2 size={13} /> Delete</button></span>}</div>
      </div>{editingId === project.id && <div className="settings-card-body"><div className="settings-form"><div className="settings-form-grid"><div className="settings-form-field"><label htmlFor={`project-name-${project.id}`}>Project name</label><input id={`project-name-${project.id}`} value={editingName} onChange={(event) => setEditingName(event.target.value)} /></div><div className="settings-form-field"><label htmlFor={`project-description-${project.id}`}>Description</label><input id={`project-description-${project.id}`} value={editingDescription} onChange={(event) => setEditingDescription(event.target.value)} /></div></div><div className="settings-form-footer"><button className="ck-button ck-button-quiet" type="button" onClick={() => setEditingId(null)}>Cancel</button><button className="ck-button ck-button-primary" type="button" onClick={() => void saveRename()} disabled={!editingName.trim()}>Save project</button></div></div></div>}</div>;
    })}</div>}
    </Panel>
    {canManage(role) && addOpen && <Panel id="add-project" title="New project"><div className="settings-card-body"><div className="settings-form-grid"><div className="settings-form-field"><label htmlFor="new-project-name">Project name</label><input id="new-project-name" value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="Search API" onKeyDown={(event) => { if (event.key === "Enter") void create(); }} /></div><div className="settings-form-field"><label htmlFor="new-project-description">Description <span className="settings-footnote">(optional)</span></label><input id="new-project-description" value={newDescription} onChange={(event) => setNewDescription(event.target.value)} placeholder="Production application" /></div></div><div className="settings-form-footer"><button className="ck-button ck-button-quiet" type="button" onClick={() => setAddOpen(false)}>Cancel</button><button className="ck-button ck-button-primary" type="button" onClick={() => void create()} disabled={creating || !newName.trim()}><Plus size={13} /> {creating ? "Creating" : "Create project"}</button></div></div></Panel>}
    {selectedId && <CustomProvidersPanel projectId={selectedId} role={role} />}
  </>;
}

function CustomProvidersPanel({ projectId, role }: { projectId: string; role: Role }) {
  const [providers, setProviders] = useState<CustomProvider[]>([]); const [loading, setLoading] = useState(false); const [editingId, setEditingId] = useState<string | null>(null); const [form, setForm] = useState({ name: "", hostname: "", input: "usage.prompt_tokens", output: "usage.completion_tokens", model: "model" }); const [message, setMessage] = useState<string | null>(null); const [error, setError] = useState<string | null>(null); const allowed = canManage(role); const [formOpen, setFormOpen] = useState(false);
  const confirmation = useConfirmation();
  const load = useCallback(async (): Promise<void> => { setLoading(true); setError(null); try { const result = await getCustomProviders(projectId); setProviders(arrayOrEmpty<CustomProvider>(result?.providers)); } catch (loadError) { setProviders([]); setError(errorText(loadError)); } finally { setLoading(false); } }, [projectId]);
  useEffect(() => { void load(); }, [load]);
  function reset(): void { setEditingId(null); setFormOpen(false); setForm({ name: "", hostname: "", input: "usage.prompt_tokens", output: "usage.completion_tokens", model: "model" }); }
  async function save(): Promise<void> { if (!allowed || !form.name.trim() || !form.hostname.trim()) return; setMessage(null); setError(null); try { const input = { name: form.name.trim(), hostname: form.hostname.trim(), usageInputPath: form.input.trim(), usageOutputPath: form.output.trim(), modelPath: form.model.trim() }; if (editingId) await updateCustomProvider(projectId, editingId, input); else await createCustomProvider(projectId, input); reset(); setMessage("Custom provider saved."); await load(); } catch (saveError) { setError(errorText(saveError)); } }
  async function toggle(provider: CustomProvider): Promise<void> { if (!allowed) return; setMessage(null); setError(null); try { await updateCustomProvider(projectId, provider.id, { enabled: !provider.enabled }); setMessage(`${provider.name} ${provider.enabled ? "paused" : "enabled"}.`); await load(); } catch (toggleError) { setError(errorText(toggleError)); } }
  function remove(provider: CustomProvider, trigger: HTMLElement): void { if (!allowed) return; confirmation.ask({ title: `Delete ${provider.name}?`, body: "Calls to this endpoint won’t be read anymore.", actionLabel: "Delete adapter", onConfirm: async () => { try { await deleteCustomProvider(projectId, provider.id); await load(); } catch (deleteError) { setError(errorText(deleteError)); } } }, trigger); }
  return <>{confirmation.dialog}<Panel title="Custom AI endpoints" actions={allowed ? (formOpen || editingId ? undefined : <button className="ck-button ck-button-secondary" type="button" onClick={() => setFormOpen(true)}><Plus size={13} /> Add an endpoint</button>) : <StatusPill tone="neutral" icon={false}>View only</StatusPill>}><div className="settings-card-body">{allowed && (formOpen || editingId) && <div className="settings-form"><div className="settings-form-grid"><div className="settings-form-field"><label htmlFor="provider-name">Name</label><input id="provider-name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="Internal LLM" /></div><div className="settings-form-field"><label htmlFor="provider-hostname">Hostname</label><input id="provider-hostname" value={form.hostname} onChange={(event) => setForm({ ...form, hostname: event.target.value })} placeholder="ai.internal.example" /></div><div className="settings-form-field"><label htmlFor="provider-input-path">Input usage path</label><input id="provider-input-path" value={form.input} onChange={(event) => setForm({ ...form, input: event.target.value })} /></div><div className="settings-form-field"><label htmlFor="provider-output-path">Output usage path</label><input id="provider-output-path" value={form.output} onChange={(event) => setForm({ ...form, output: event.target.value })} /></div><div className="settings-form-field"><label htmlFor="provider-model-path">Model path</label><input id="provider-model-path" value={form.model} onChange={(event) => setForm({ ...form, model: event.target.value })} /></div></div><div className="settings-form-footer"><button className="ck-button ck-button-secondary" type="button" onClick={() => void save()} disabled={!form.name.trim() || !form.hostname.trim()}><Plus size={13} /> {editingId ? "Save changes" : "Save endpoint"}</button><button className="ck-button ck-button-quiet" type="button" onClick={reset}>Cancel</button></div></div>}{message && <div className="settings-status-line success" role="status">{message}</div>}{error && <div className="settings-status-line error" role="alert">{error}</div>}{loading ? <LoadingRows count={2} columns={3} /> : providers.length === 0 ? null : <div className="settings-table-wrap"><table className="settings-table"><thead><tr><th>Adapter</th><th>Usage paths</th><th>Status</th><th /></tr></thead><tbody>{providers.map((provider) => <tr key={provider.id}><td className="primary">{provider.name}<div className="muted">{provider.hostname}</div></td><td className="mono">{provider.usage_input_path} · {provider.usage_output_path}<div className="muted">model: {provider.model_path}</div></td><td><StatusPill tone={provider.enabled ? "good" : "neutral"}>{provider.enabled ? "Enabled" : "Paused"}</StatusPill></td><td className="actions">{allowed && <><button className="ck-button ck-button-quiet" type="button" onClick={() => void toggle(provider)} aria-label={`${provider.enabled ? "Pause" : "Enable"} ${provider.name}`} aria-pressed={provider.enabled}>{provider.enabled ? "Pause" : "Enable"}</button><button className="settings-icon-button" type="button" onClick={() => { setEditingId(provider.id); setForm({ name: provider.name, hostname: provider.hostname, input: provider.usage_input_path, output: provider.usage_output_path, model: provider.model_path }); }} aria-label={`Edit ${provider.name}`}><Pencil size={13} /></button><button className="settings-icon-button" type="button" onClick={(event) => remove(provider, event.currentTarget)} aria-label={`Delete ${provider.name}`}><Trash2 size={13} /></button></>}</td></tr>)}</tbody></table></div>}</div></Panel></>;
}

function TeamAccess({ projects, members, userId, role, orgName, refresh }: { projects: SettingsProject[]; members: SettingsMember[]; userId: string; role: Role; orgName: string; refresh: () => Promise<void> }) {
  const [invites, setInvites] = useState<TeamInvite[]>([]);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteLink, setInviteLink] = useState<{ email: string; url: string } | null>(null);
  const [inviteRole, setInviteRole] = useState<"admin" | "developer" | "viewer">("viewer");
  const [inviteProjects, setInviteProjects] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [assignments, setAssignments] = useState<Record<string, string[] | undefined>>({});
  const [assignmentStatus, setAssignmentStatus] = useState<Record<string, "loading" | "ready" | "unavailable"> | null>(null);
  const [transferTargetId, setTransferTargetId] = useState("");
  const [transferSaving, setTransferSaving] = useState(false);
  const confirmation = useConfirmation();

  const canManageTeam = canManage(role);
  const projectKey = useMemo(() => projects.map((project) => project.id).join(","), [projects]);
  useEffect(() => { setInviteProjects([]); }, [projectKey]);
  useEffect(() => {
    let alive = true;
    async function load(): Promise<void> {
      setLoading(true); setError(null);
      if (!canManageTeam) { setLoading(false); return; }
      try { const result = await getTeamInvites(); if (alive) setInvites(Array.isArray(result.invites) ? result.invites : []); }
      catch (loadError) { if (alive) setError(errorText(loadError)); }
      finally { if (alive) setLoading(false); }
    }
    void load();
    return () => { alive = false; };
  }, [canManageTeam]);
  useEffect(() => {
    if (!canManageTeam || members.length === 0) return;
    let alive = true;
    setAssignmentStatus(Object.fromEntries(members.map((member) => [member.id, "loading"])));
    async function loadAssignments(): Promise<void> {
      const entries = await Promise.all(members.map(async (member) => {
        try {
          const result = await getMemberProjects(member.id);
          return [member.id, result.projectIds, "ready" as const] as const;
        } catch {
          const inline = member.projectIds;
          return [member.id, inline, inline ? "ready" as const : "unavailable" as const] as const;
        }
      }));
      if (!alive) return;
      const next: Record<string, string[] | undefined> = {};
      const statuses: Record<string, "loading" | "ready" | "unavailable"> = {};
      entries.forEach(([id, projectIds, status]) => { next[id] = projectIds; statuses[id] = status; });
      setAssignments(next); setAssignmentStatus(statuses);
    }
    void loadAssignments();
    return () => { alive = false; };
  }, [canManageTeam, members]);

  function inviteSent(email: string, result: { inviteUrl?: string; emailSent?: boolean }): void {
    if (result.emailSent === false && result.inviteUrl) { setInviteLink({ email, url: result.inviteUrl }); setMessage(`No email sent. Share this link with ${email}.`); return; }
    setInviteLink(null); setMessage(`Invitation sent to ${email}.`);
  }
  async function invite(): Promise<void> {
    if (!canManageTeam || !inviteEmail.trim()) return;
    setSaving(true); setError(null); setMessage(null);
    try { const result = await createTeamInvite({ email: inviteEmail.trim(), role: inviteRole, projectIds: inviteProjects }); setInvites((current) => [{ id: result.id, email: result.email, role: result.role, project_ids: result.projectIds, status: "pending", created_at: new Date().toISOString(), expires_at: result.expiresAt, accepted_at: null, revoked_at: null, resent_count: 0, invited_by_name: "You" }, ...current]); setInviteEmail(""); inviteSent(result.email, result); }
    catch (inviteError) { setError(errorText(inviteError)); }
    finally { setSaving(false); }
  }
  function revoke(invite: TeamInvite, trigger: HTMLElement): void {
    confirmation.ask({ title: `Revoke ${invite.email}'s invitation?`, body: "The invite link will stop working.", actionLabel: "Revoke invitation", onConfirm: async () => {
      try { await revokeInviteAndRefresh(invite.id); } catch (revokeError) { setError(errorText(revokeError)); }
    } }, trigger);
  }
  async function revokeInviteAndRefresh(inviteId: string): Promise<void> {
    await revokeTeamInvite(inviteId); setInvites((current) => current.map((invite) => invite.id === inviteId ? { ...invite, status: "revoked", revoked_at: new Date().toISOString() } : invite));
  }
  async function resend(invite: TeamInvite): Promise<void> {
    try { const result = await resendTeamInvite(invite.id); setInvites((current) => current.map((item) => item.id === invite.id ? { ...item, status: "pending", expires_at: result.expiresAt, resent_count: item.resent_count + 1 } : item)); inviteSent(invite.email, result); }
    catch (resendError) { setError(errorText(resendError)); }
  }
  async function updateRole(member: SettingsMember, nextRole: Role): Promise<void> {
    if (!canManageTeam || nextRole === "owner") return;
    setError(null); setMessage(null);
    try { const result = await updateTeamMember(member.id, { role: nextRole, ...(assignments[member.id] ? { projectIds: assignments[member.id] } : {}) }); if (result.projectIds) setAssignments((current) => ({ ...current, [member.id]: result.projectIds })); setMessage(`${member.name}'s role is now ${nextRole}.`); await refresh(); }
    catch (roleError) { setError(errorText(roleError)); }
  }
  async function updateAssignments(member: SettingsMember, projectIds: string[]): Promise<void> {
    if (!canManageTeam || member.id === userId || !assignments[member.id]) return;
    const previous = assignments[member.id] ?? [];
    setAssignments((current) => ({ ...current, [member.id]: projectIds })); setError(null); setMessage(null);
    try { const memberRole = normalizeRole(member.role); const requestedRole: "admin" | "developer" | "viewer" = memberRole === "owner" ? "viewer" : memberRole; const result = await updateTeamMember(member.id, { role: requestedRole, projectIds }); setAssignments((current) => ({ ...current, [member.id]: result.projectIds ?? projectIds })); setMessage(`${member.name}'s project access was updated.`); await refresh(); }
    catch (assignmentError) { setAssignments((current) => ({ ...current, [member.id]: previous })); setError(errorText(assignmentError)); }
  }
  function remove(member: SettingsMember, trigger: HTMLElement): void {
    if (!canManageTeam || member.id === userId) return;
    confirmation.ask({ title: `Remove ${member.name} from ${orgName}?`, body: "They’ll lose access right away. You can invite them again later.", actionLabel: "Remove member", onConfirm: async () => {
      try { await removeTeamMember(member.id); setMessage(`${member.name} was removed.`); await refresh(); } catch (removeError) { setError(errorText(removeError)); }
    } }, trigger);
  }
  function reviewOwnershipTransfer(trigger: HTMLElement): void {
    if (role !== "owner" || !transferTargetId) return;
    const target = members.find((member) => member.id === transferTargetId);
    if (!target || normalizeRole(target.role) === "owner" || target.id === userId) return;
    confirmation.ask({
      title: `Transfer ownership to ${target.name}?`,
      body: `You will become an Admin and ${target.name} will become the workspace Owner. Project assignments, subscription status, DSNs, capture settings and privacy policies are unchanged. The transfer is recorded as a workspace audit event and requires the current owner to confirm.`,
      actionLabel: "Transfer ownership",
      onConfirm: async () => {
        setTransferSaving(true); setError(null); setMessage(null);
        try {
          await transferWorkspaceOwnership(target.id);
          setTransferTargetId("");
          setMessage(`Ownership transferred to ${target.name}. You remain an Admin.`);
          await refresh();
        } catch (transferError) {
          setError(errorText(transferError));
        } finally {
          setTransferSaving(false);
        }
      },
    }, trigger);
  }

  const pendingInvites = invites.filter((invite) => invite.status !== "accepted");
  const transferTargets = members.filter((member) => member.id !== userId && normalizeRole(member.role) !== "owner");
  return <>
    {confirmation.dialog}
    <div className="settings-section-title"><div><h2>Team</h2></div>{!canManageTeam && <StatusPill tone="neutral">Assigned-project access</StatusPill>}</div>
    {(message || error) && <div className={`settings-status-line ${error ? "error" : "success"}`} role={error ? "alert" : "status"}>{error ?? message}</div>}
    {inviteLink && <div className="settings-key-row"><Link2 size={14} aria-hidden="true" /><code className="revealed">{inviteLink.url}</code><CopyButton value={inviteLink.url} label={`Copy invite link for ${inviteLink.email}`} /></div>}
    {!canManageTeam && <div className="ck-alert"><Lock size={15} /><div><strong>View only.</strong> Ask an Owner or Admin to invite people or change roles.</div></div>}
    {canManageTeam && <Panel title="Invite a member"><div className="settings-card-body"><div className="settings-form"><div className="settings-form-grid"><div className="settings-form-field"><label htmlFor="invite-email">Email</label><input id="invite-email" type="email" value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} placeholder="colleague@company.com" onKeyDown={(event) => { if (event.key === "Enter") void invite(); }} /></div><div className="settings-form-field"><label htmlFor="invite-role">Role</label><select id="invite-role" value={inviteRole} onChange={(event) => { const nextRole = event.target.value as typeof inviteRole; setInviteRole(nextRole); if (nextRole === "admin") setInviteProjects([]); }}><option value="viewer">Viewer: sees costs</option><option value="developer">Developer: also sees prompts and code</option><option value="admin">Admin: manages the workspace</option></select></div><div className="settings-form-field full"><span className="settings-form-field-label" id="invite-projects-label">Assigned projects</span><div className="settings-assignment-list" aria-labelledby="invite-projects-label">{projects.map((project) => <button className={`settings-assignment ${inviteProjects.includes(project.id) ? "selected" : ""}`} type="button" key={project.id} aria-pressed={inviteProjects.includes(project.id)} disabled={inviteRole === "admin"} onClick={() => setInviteProjects((current) => current.includes(project.id) ? current.filter((id) => id !== project.id) : [...current, project.id])}>{project.name}</button>)}</div><small>{inviteRole === "admin" ? "Admins see every project." : inviteProjects.length === 0 ? "No project picked." : `${inviteProjects.length} project${inviteProjects.length === 1 ? "" : "s"} selected`}</small></div></div><div className="settings-form-footer"><button className="ck-button ck-button-primary" type="button" onClick={() => void invite()} disabled={saving || !inviteEmail.trim()}><UserPlus size={13} /> {saving ? "Sending" : "Send invitation"}</button></div></div></div></Panel>}
    {role === "owner" && transferTargets.length > 0 && <div id="ownership-transfer"><Panel title="Transfer workspace ownership"><div className="settings-card-body"><div className="ck-alert"><Shield size={15} /><div><strong>Check before confirming.</strong> The new Owner will manage billing. Your DSNs, data and provider accounts don’t change.</div></div>{transferTargets.length === 0 ? <div className="settings-empty" style={{ marginTop: 14 }}>Invite someone first.</div> : <div className="settings-form"><div className="settings-form-grid"><div className="settings-form-field"><label htmlFor="ownership-target">New Owner</label><select id="ownership-target" value={transferTargetId} onChange={(event) => setTransferTargetId(event.target.value)}><option value="">Select an existing member</option>{transferTargets.map((member) => <option key={member.id} value={member.id}>{member.name} · {member.email} · {normalizeRole(member.role)}</option>)}</select><small>Pick someone already in this workspace.</small></div></div><div className="settings-form-footer"><button className="ck-button ck-button-danger" type="button" onClick={(event) => reviewOwnershipTransfer(event.currentTarget)} disabled={transferSaving || !transferTargetId} aria-label="Transfer ownership">{transferSaving ? "Transferring" : "Review transfer"}</button></div></div>}</div></Panel></div>}
    <Panel title={`${orgName} members`} subtitle={`${members.length} member${members.length === 1 ? "" : "s"}`}>{loading ? <LoadingRows count={4} columns={4} /> : <div className="settings-table-wrap"><table className="settings-table"><thead><tr><th>Member</th><th>Role</th><th>Project access</th><th /></tr></thead><tbody>{members.map((member) => { const memberRole = normalizeRole(member.role); const projectIds = assignments[member.id]; const status = assignmentStatus?.[member.id]; return <tr key={member.id}><td className="primary">{member.name}<div className="muted">{member.email}</div></td><td>{canManageTeam && memberRole !== "owner" && member.id !== userId ? <select className="settings-role-select" aria-label={`Role for ${member.name}`} value={memberRole} onChange={(event) => void updateRole(member, event.target.value as Role)}><option value="admin">Admin</option><option value="developer">Developer</option><option value="viewer">Viewer</option></select> : <RolePill role={memberRole} />}</td><td>{memberRole === "owner" || memberRole === "admin" ? <span className="muted">All projects</span> : status === "loading" ? <span className="muted">Loading access…</span> : status === "unavailable" ? <span className="muted">Assignments unavailable</span> : <div className="settings-assignment-list">{projects.map((project) => <button className={`settings-assignment ${projectIds?.includes(project.id) ? "selected" : ""}`} type="button" key={project.id} disabled={!canManageTeam || member.id === userId} aria-label={`${project.name} access for ${member.name}`} aria-pressed={projectIds?.includes(project.id) ?? false} onClick={() => void updateAssignments(member, projectIds?.includes(project.id) ? (projectIds ?? []).filter((id) => id !== project.id) : [...(projectIds ?? []), project.id])}>{project.name}</button>)}</div>}</td><td className="actions">{canManageTeam && member.id !== userId && memberRole !== "owner" && <button className="settings-icon-button" type="button" onClick={(event) => remove(member, event.currentTarget)} aria-label={`Remove ${member.name}`}><Trash2 size={13} /></button>}</td></tr>; })}</tbody></table></div>}</Panel>
    {canManageTeam && <Panel title="Invitations">{pendingInvites.length === 0 ? <div className="settings-empty">No invitations yet.</div> : <div className="settings-table-wrap"><table className="settings-table"><thead><tr><th>Email</th><th>Role</th><th>Projects</th><th>Status</th><th /></tr></thead><tbody>{pendingInvites.map((invite) => <tr key={invite.id}><td className="primary">{invite.email}<div className="muted">Expires {formatSettingsDate(invite.expires_at)}</div></td><td><RolePill role={invite.role} /></td><td className="muted">{invite.project_ids?.length ? invite.project_ids.map((id) => projects.find((project) => project.id === id)?.name ?? id).join(", ") : "No project assignment"}</td><td><StatusPill tone={invite.status === "pending" ? "warn" : invite.status === "expired" ? "neutral" : "critical"}>{invite.status.charAt(0).toUpperCase() + invite.status.slice(1)}</StatusPill></td><td className="actions">{(invite.status === "pending" || invite.status === "expired") && <><button className="ck-button ck-button-quiet" type="button" onClick={() => void resend(invite)} aria-label={`Resend invitation to ${invite.email}`}>Resend</button>{invite.status === "pending" && <button className="settings-icon-button" type="button" onClick={(event) => revoke(invite, event.currentTarget)} aria-label={`Revoke ${invite.email}`}><Trash2 size={13} /></button>}</>}</td></tr>)}</tbody></table></div>}</Panel>}
  </>;
}

function NotificationsSettings({ projects, role }: { projects: SettingsProject[]; role: Role; userEmail?: string }) {
  // Destinations, subscriptions and delivery history live on /alerting.
  return <>
    <div className="settings-section-title"><div><h2>Notifications</h2></div></div>
    <Panel title="Alerting" actions={<Link className="ck-button ck-button-secondary" to="/alerting">Open Alerting</Link>}>{null}</Panel>
    <FindingThresholdSettings projects={projects} role={role} />
  </>;
}

function findingThresholdFormFromValues(thresholds: Partial<FindingThresholds> | null | undefined, defaults: Partial<FindingThresholds> | null | undefined): FindingThresholdFormValues {
  const value = (key: keyof FindingThresholds, fallback: number): number => {
    const candidate = thresholds?.[key] ?? defaults?.[key];
    return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : fallback;
  };
  return {
    expensiveSample: String(value("expensiveSample", 20)),
    expensiveMultiplier: String(value("expensiveMultiplier", 3)),
    expensiveMinAbsolute: String(value("expensiveMinAbsolute", 0.05)),
    unitSample: String(value("unitSample", 20)),
    unitMinRelativePercent: String(value("unitMinRelative", 0.5) * 100),
    unitMinImpact: String(value("unitMinImpact", 1)),
  };
}

function FindingThresholdSettings({ projects, role }: { projects: SettingsProject[]; role: Role }) {
  const [selectedProjectId, setSelectedProjectId] = useState(projects[0]?.id ?? "");
  const [thresholds, setThresholds] = useState<FindingThresholds | null>(null);
  const [form, setForm] = useState<FindingThresholdFormValues>(() => findingThresholdFormFromValues(null, null));
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const canEdit = canManage(role);
  const parsedForm = parseFindingThresholdForm(form);

  useEffect(() => {
    if (!projects.some((project) => project.id === selectedProjectId)) setSelectedProjectId(projects[0]?.id ?? "");
  }, [projects, selectedProjectId]);
  useEffect(() => {
    if (!selectedProjectId) { setThresholds(null); setLoading(false); return; }
    let alive = true;
    setLoading(true); setError(null); setMessage(null); setThresholds(null);
    getFindingThresholds(selectedProjectId)
      .then((result) => {
        if (!alive) return;
        setThresholds(result.thresholds);
        setForm(findingThresholdFormFromValues(result.thresholds, result.defaults));
      })
      .catch((loadError) => { if (alive) setError(errorText(loadError)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [selectedProjectId, reloadToken]);

  async function save(): Promise<void> {
    if (!canEdit || !selectedProjectId || !parsedForm) {
      if (!parsedForm) setError("Some values are outside the allowed range.");
      return;
    }
    setSaving(true); setError(null); setMessage(null);
    try {
      const result = await updateFindingThresholds(selectedProjectId, parsedForm);
      setThresholds(result.thresholds);
      setForm(findingThresholdFormFromValues(result.thresholds, result.defaults));
      setMessage("Saved. The next check will use these settings.");
    } catch (saveError) {
      setError(errorText(saveError));
    } finally {
      setSaving(false);
    }
  }

  if (projects.length === 0) return <Panel title="What gets flagged"><div className="settings-card-body"><div className="settings-empty">Connect a project to adjust what gets flagged.</div></div></Panel>;
  return <Panel title="What gets flagged" actions={canEdit ? undefined : <StatusPill tone="neutral">Read only</StatusPill>}><div className="settings-card-body"><div className="settings-project-picker"><label htmlFor="finding-threshold-project">Project</label><select id="finding-threshold-project" value={selectedProjectId} onChange={(event) => setSelectedProjectId(event.target.value)}><option value="">Choose a project</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></div>{loading ? <LoadingRows count={4} columns={2} /> : error && !thresholds ? <><div className="ck-alert" role="alert"><AlertTriangle size={15} /><span>{error}</span></div><div className="settings-form-footer"><button className="ck-button ck-button-secondary" type="button" onClick={() => setReloadToken((value) => value + 1)} aria-label="Try again">Retry loading thresholds</button></div></> : thresholds ? <div className="settings-form" style={{ marginTop: 16 }}><div className="settings-form-grid"><div className="settings-form-field"><label htmlFor="finding-expensive-sample">Similar runs needed</label><input id="finding-expensive-sample" type="number" min="1" max="1000" step="1" value={form.expensiveSample} disabled={!canEdit} onChange={(event) => setForm({ ...form, expensiveSample: event.target.value })} /><small>Default: 20</small></div><div className="settings-form-field"><label htmlFor="finding-expensive-multiplier">Expensive run: times the usual cost</label><input id="finding-expensive-multiplier" type="number" min="1" max="100" step="0.1" value={form.expensiveMultiplier} disabled={!canEdit} onChange={(event) => setForm({ ...form, expensiveMultiplier: event.target.value })} /><small>Default: 3×</small></div><div className="settings-form-field"><label htmlFor="finding-expensive-absolute">Expensive run: at least this much more (USD)</label><input id="finding-expensive-absolute" type="number" min="0" max="1000000" step="0.01" value={form.expensiveMinAbsolute} disabled={!canEdit} onChange={(event) => setForm({ ...form, expensiveMinAbsolute: event.target.value })} /><small>Default: $0.05</small></div></div><div className="settings-form-grid"><div className="settings-form-field"><label htmlFor="finding-unit-sample">Runs needed per period</label><input id="finding-unit-sample" type="number" min="1" max="1000" step="1" value={form.unitSample} disabled={!canEdit} onChange={(event) => setForm({ ...form, unitSample: event.target.value })} /><small>Default: 20</small></div><div className="settings-form-field"><label htmlFor="finding-unit-relative">Cost per run: minimum rise (%)</label><input id="finding-unit-relative" type="number" min="0" max="100" step="1" value={form.unitMinRelativePercent} disabled={!canEdit} onChange={(event) => setForm({ ...form, unitMinRelativePercent: event.target.value })} /><small>Default: 50%</small></div><div className="settings-form-field"><label htmlFor="finding-unit-impact">Cost per run: minimum total impact (USD)</label><input id="finding-unit-impact" type="number" min="0" max="1000000" step="0.01" value={form.unitMinImpact} disabled={!canEdit} onChange={(event) => setForm({ ...form, unitMinImpact: event.target.value })} /><small>Default: $1</small></div></div>{!canEdit && <p className="settings-footnote">Only Owners and Admins can change these.</p>}{error && <div className="settings-status-line error" role="alert">{error}</div>}{message && <div className="settings-status-line success" role="status">{message}</div>}{canEdit && !parsedForm && <p className="settings-footnote">Some values are outside the allowed range.</p>}{canEdit && <div className="settings-form-footer"><button className="ck-button ck-button-secondary" type="button" onClick={() => void save()} disabled={saving || !parsedForm}>{saving ? "Saving" : "Save"}</button></div>}</div> : <div className="settings-empty">No settings found for this project.</div>}</div></Panel>;
}

function WorkspaceReportingSettings() {
  const browserTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const [settings, setSettings] = useState<WorkspaceSettings | null>(null);
  const [timezone, setTimezone] = useState(browserTimezone);
  const [currency, setCurrency] = useState<"USD" | "INR">("USD");
  const [fxRateInput, setFxRateInput] = useState("");
  const [fxSourceInput, setFxSourceInput] = useState("");
  const [fxAsOfInput, setFxAsOfInput] = useState("");
  const [canEdit, setCanEdit] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    async function load(): Promise<void> {
      setLoading(true); setError(null);
      try {
        const result = await getWorkspaceSettings();
        if (!alive) return;
        setSettings(result.settings);
        setCanEdit(result.canManage === true);
        if (result.settings) {
          setTimezone(result.settings.timezone);
          setCurrency(result.settings.reportingCurrency);
          const savedRate = result.settings.fx?.rate ?? result.settings.fxRate;
          const savedSource = result.settings.fx?.source ?? result.settings.fxSource;
          const savedAsOf = result.settings.fx?.asOf ?? result.settings.fxAsOf;
          setFxRateInput(savedRate == null ? "" : String(savedRate));
          setFxSourceInput(savedSource ?? "");
          setFxAsOfInput(formatDateInput(savedAsOf));
        }
      }
      catch (loadError) { if (alive) setError(errorText(loadError)); }
      finally { if (alive) setLoading(false); }
    }
    void load();
    return () => { alive = false; };
  }, []);
  async function save(): Promise<void> {
    const parsedFxRate = Number(fxRateInput);
    if (currency === "INR" && !isValidFxBasis(fxRateInput, fxSourceInput, fxAsOfInput)) {
      setError("Add the rate, where it came from and its date to use INR.");
      setMessage(null);
      return;
    }
    setSaving(true); setMessage(null); setError(null);
    try {
      const result = await updateWorkspaceSettings({
        timezone,
        reportingCurrency: currency,
        ...(currency === "INR" ? { fxRate: parsedFxRate, fxSource: fxSourceInput.trim(), fxAsOf: new Date(fxAsOfInput).toISOString() } : {}),
      });
      setSettings(result.settings);
      setCanEdit(typeof result.canManage === "boolean" ? result.canManage : canEdit);
      if (currency === "USD") {
        setFxRateInput("");
        setFxSourceInput("");
        setFxAsOfInput("");
      }
      setMessage("Saved.");
    }
    catch (saveError) { setError(errorText(saveError)); }
    finally { setSaving(false); }
  }
  const fxRate = settings?.fx?.rate ?? settings?.fxRate ?? null;
  const fxSource = settings?.fx?.source ?? settings?.fxSource ?? null;
  const fxAsOf = settings?.fx?.asOf ?? settings?.fxAsOf ?? null;
  const fxAvailable = settings?.fx?.available ?? (fxRate != null && Boolean(fxSource) && Boolean(fxAsOf));
  const inrBasisValid = isValidFxBasis(fxRateInput, fxSourceInput, fxAsOfInput);
  return <Panel title="Time zone and currency" actions={canEdit ? undefined : <StatusPill tone="neutral">Read only</StatusPill>}><div className="settings-card-body">{loading ? <LoadingRows count={2} columns={3} /> : <><div className="settings-form-grid"><div className="settings-form-field"><label htmlFor="workspace-timezone">Workspace timezone</label><select id="workspace-timezone" value={timezone} disabled={!canEdit} onChange={(event) => setTimezone(event.target.value)}><option value={browserTimezone}>{browserTimezone} (browser suggestion)</option><option value="UTC">UTC</option><option value="Asia/Kolkata">Asia/Kolkata</option><option value="America/Los_Angeles">America/Los_Angeles</option><option value="America/New_York">America/New_York</option></select></div><div className="settings-form-field"><label htmlFor="workspace-currency">Reporting currency</label><select id="workspace-currency" value={currency} disabled={!canEdit} onChange={(event) => { const next = event.target.value as "USD" | "INR"; setCurrency(next); if (next === "USD") { setFxRateInput(""); setFxSourceInput(""); setFxAsOfInput(""); } }}><option value="USD">USD — United States dollar</option><option value="INR">INR — Indian rupee</option></select></div></div>{currency === "INR" && <><div className="settings-form-grid" style={{ marginTop: 14 }}><div className="settings-form-field"><label htmlFor="workspace-fx-rate">USD → INR rate</label><input id="workspace-fx-rate" type="number" min="0.0000001" step="0.0000001" value={fxRateInput} disabled={!canEdit} onChange={(event) => setFxRateInput(event.target.value)} placeholder="Enter the dated rate" aria-describedby="workspace-fx-help" /><small>How many rupees one dollar is worth.</small></div><div className="settings-form-field"><label htmlFor="workspace-fx-source">FX source</label><input id="workspace-fx-source" value={fxSourceInput} disabled={!canEdit} onChange={(event) => setFxSourceInput(event.target.value)} placeholder="Provider or published source" aria-describedby="workspace-fx-help" /><small>Where this rate came from. We don’t fetch live rates.</small></div><div className="settings-form-field"><label htmlFor="workspace-fx-as-of">Rate as of</label><input id="workspace-fx-as-of" type="date" value={fxAsOfInput} disabled={!canEdit} onChange={(event) => setFxAsOfInput(event.target.value)} aria-describedby="workspace-fx-help" /><small>Shown next to converted totals.</small></div></div><p id="workspace-fx-help" className="settings-footnote">INR totals use the rate saved here. Until it’s saved, totals stay in USD.</p><div className="settings-definition-list" style={{ marginTop: 14 }}><div className="settings-definition-row"><dt>Saved FX basis</dt><dd>{fxAvailable && fxRate != null ? `${fxRate} INR per USD` : "Unavailable"}</dd></div><div className="settings-definition-row"><dt>Saved source / as of</dt><dd>{fxAvailable && fxSource ? <>{fxSource}{fxAsOf ? ` · ${formatSettingsDate(fxAsOf)}` : ""}</> : "No rate saved yet"}</dd></div></div></>}{error && <div className="settings-status-line error" role="alert">{error}</div>}{message && <div className="settings-status-line success" role="status">{message}</div>}{!canEdit && !error && <p className="settings-footnote" style={{ marginTop: 12 }}>Only Owners and Admins can change these.</p>}{canEdit && currency === "INR" && !inrBasisValid && <p className="settings-footnote" style={{ marginTop: 12 }}>Add the rate, where it came from and its date to use INR.</p>}<div className="settings-form-footer"><button className="ck-button ck-button-primary" type="button" onClick={() => void save()} disabled={!canEdit || saving || !timezone || (currency === "INR" && !inrBasisValid)}>{saving ? "Saving" : "Save reporting defaults"}</button></div></>}</div></Panel>;
}

function DataSourceSettings({ projects, role, currentProjectId }: { projects: SettingsProject[]; role: Role; currentProjectId: string | null }) {
  const [selectedId, setSelectedId] = useState(currentProjectId ?? projects[0]?.id ?? "");
  const [privacy, setPrivacy] = useState<PrivacySettings | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const canEdit = canManage(role);
  const confirmation = useConfirmation();
  useEffect(() => { if (currentProjectId && projects.some((project) => project.id === currentProjectId)) setSelectedId(currentProjectId); }, [currentProjectId, projects]);
  useEffect(() => {
    let alive = true;
    async function load(): Promise<void> {
      if (!selectedId) { setPrivacy(null); setLoading(false); return; }
      setPrivacy(null);
      setLoading(true); setError(null); setMessage(null);
      try { const privacyResult = await getPrivacySettings(selectedId); if (!alive) return; setPrivacy(privacyResult.settings); }
      catch (loadError) { if (alive) setError(errorText(loadError)); }
      finally { if (alive) setLoading(false); }
    }
    void load(); return () => { alive = false; };
  }, [selectedId]);
  async function save(): Promise<void> {
    if (!privacy || !canEdit) return;
    setSaving(true); setError(null); setMessage(null);
    try { const result = await updatePrivacySettings(selectedId, { captureMode: privacy.captureMode, bodyCaptureEnabled: privacy.captureMode === "text", bodyRetentionDays: privacy.bodyRetentionDays, metadataRetentionDays: privacy.metadataRetentionDays, aggregateRetentionDays: privacy.aggregateRetentionDays, sourceAccessEnabled: privacy.sourceAccessEnabled, ...(privacy.redactionEnabled ? {} : { redactionEnabled: true }) }); setPrivacy(result.settings); setMessage("Saved. Applies to new runs."); }
    catch (saveError) { setError(errorText(saveError)); }
    finally { setSaving(false); }
  }
  async function enableRedaction(): Promise<void> { if (!privacy || !canEdit) return; try { const result = await updatePrivacySettings(selectedId, { redactionEnabled: true }); setPrivacy(result.settings); setMessage("Secrets are removed from new prompts."); } catch (redactionError) { setError(errorText(redactionError)); } }
  function deleteContent(trigger: HTMLElement): void { if (!canEdit || !privacy) return; confirmation.ask({ title: "Delete stored prompts?", body: "Every stored prompt and response for this project will be deleted. Costs stay. This can’t be undone.", actionLabel: "Delete stored prompts", onConfirm: async () => { setError(null); setMessage(null); try { const result = await deleteCapturedContent(selectedId); setMessage(`${result.deletedContent} captured record${result.deletedContent === 1 ? "" : "s"} cleared.`); } catch (deleteError) { setError(errorText(deleteError)); } } }, trigger); }
  if (projects.length === 0) return <><WorkspaceReportingSettings /><Panel><EmptyPanel title="No project privacy settings" body="Connect a project to change privacy settings." icon={<Database size={18} />} /></Panel></>;
  return <>
    {confirmation.dialog}
    <div className="settings-section-title"><div><h2>Privacy & data</h2></div>{!canEdit && <StatusPill tone="neutral">Read only</StatusPill>}</div>
    <WorkspaceReportingSettings />
    <Panel title="What this project stores"><div className="settings-card-body"><div className="settings-project-picker"><label htmlFor="privacy-project">Project</label><select id="privacy-project" value={selectedId} onChange={(event) => setSelectedId(event.target.value)}>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></div>{loading ? <LoadingRows count={4} columns={3} /> : privacy ? <div className="settings-form" style={{ marginTop: 16 }}><div className="settings-row"><div className="settings-row-copy"><h3>Store prompts and responses</h3></div><select className="settings-project-picker" style={{ minHeight: 34, border: "1px solid var(--ck-border)", borderRadius: 7, padding: "6px 8px" }} value={privacy.captureMode === "text" ? "text" : "metadata"} disabled={!canEdit} onChange={(event) => setPrivacy({ ...privacy, captureMode: event.target.value as "metadata" | "text", bodyCaptureEnabled: event.target.value === "text" })}><option value="metadata">Cost and usage only</option><option value="text">Cost, usage and prompts</option></select></div>{!privacy.redactionEnabled && <div className="settings-row"><div className="settings-row-copy"><h3>Secret redaction is off</h3></div><div className="settings-row-control"><button className="ck-button ck-button-secondary" type="button" onClick={() => void enableRedaction()} disabled={!canEdit}><Shield size={13} /> Enable redaction</button></div></div>}<div className="settings-form-grid"><div className="settings-form-field"><label htmlFor="body-retention">Keep prompts and responses for (days)</label><select id="body-retention" value={privacy.bodyRetentionDays} disabled={!canEdit} onChange={(event) => setPrivacy({ ...privacy, bodyRetentionDays: Number(event.target.value) })}><option value={7}>7 days</option><option value={1}>1 day</option></select><small>Shortening this deletes older text at the next daily cleanup.</small></div><div className="settings-form-field"><label htmlFor="metadata-retention">Keep run details for (days)</label><input id="metadata-retention" type="number" min="1" max="30" value={privacy.metadataRetentionDays} disabled={!canEdit} onChange={(event) => setPrivacy({ ...privacy, metadataRetentionDays: Math.max(1, Math.min(30, Number(event.target.value))) })} /></div><div className="settings-form-field"><label htmlFor="aggregate-retention">Keep daily totals for (days)</label><input id="aggregate-retention" type="number" min="30" max="395" value={privacy.aggregateRetentionDays} disabled={!canEdit} onChange={(event) => setPrivacy({ ...privacy, aggregateRetentionDays: Math.max(30, Math.min(395, Number(event.target.value))) })} /><small>Default: 395 days</small></div><div className="settings-form-field"><label htmlFor="source-access">Mapped source access</label><select id="source-access" value={privacy.sourceAccessEnabled ? "enabled" : "disabled"} disabled={!canEdit} onChange={(event) => setPrivacy({ ...privacy, sourceAccessEnabled: event.target.value === "enabled" })}><option value="enabled">On for Developers and above</option><option value="disabled">Disabled</option></select></div></div>{error && <div className="settings-status-line error" role="alert">{error}</div>}{message && <div className="settings-status-line success" role="status">{message}</div>}<div className="settings-form-footer"><button className="ck-button ck-button-secondary" type="button" onClick={() => void save()} disabled={!canEdit || saving}>{saving ? "Saving" : "Save data settings"}</button></div></div> : <div className="settings-empty">Couldn’t load privacy settings for this project.</div>}</div></Panel>
    <Panel className="settings-danger-zone" title="Delete data" subtitle="These delete data now and can’t be undone."><div className="settings-card-body"><div className="settings-row"><div className="settings-row-copy"><h3>Delete stored prompts now</h3><p>Deletes every stored prompt and response for this project. Costs stay. This can’t be undone.</p></div><button className="ck-button ck-button-danger" type="button" onClick={(event) => deleteContent(event.currentTarget)} aria-label="Delete stored prompts" disabled={!canEdit || !privacy}>Delete stored prompts</button></div>{!privacy && error && <p className="settings-footnote" role="status">These are turned off until privacy settings load.</p>}</div></Panel>
  </>;
}

interface CreditFormState {
  provider: string;
  accountScope: string;
  cloudProject: string;
  currency: string;
  originalAmount: string;
  balanceAmount: string;
  balanceAsOf: string;
  expiresAt: string;
  models: string;
  services: string;
}

interface OverrideFormState {
  provider: string;
  accountScope: string;
  model: string;
  nativeUnit: string;
  pricePerUnit: string;
  currency: string;
  effectiveFrom: string;
  effectiveTo: string;
  version: string;
  pricingId: string;
  source: string;
}

function blankCreditForm(): CreditFormState {
  return { provider: "", accountScope: "", cloudProject: "", currency: "USD", originalAmount: "", balanceAmount: "", balanceAsOf: new Date().toISOString().slice(0, 10), expiresAt: "", models: "", services: "" };
}

function blankOverrideForm(): OverrideFormState {
  return { provider: "", accountScope: "", model: "", nativeUnit: "input_tokens", pricePerUnit: "", currency: "USD", effectiveFrom: new Date().toISOString().slice(0, 10), effectiveTo: "", version: "1", pricingId: "", source: "user_supplied" };
}

function listFromInput(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function creditFormFromRow(credit: Credit): CreditFormState {
  const eligibility = credit.eligibility ?? {};
  const models = eligibility.models ?? eligibility.model;
  const services = eligibility.services ?? eligibility.service;
  return { provider: credit.provider, accountScope: credit.account_scope, cloudProject: credit.cloud_project ?? "", currency: credit.currency, originalAmount: String(credit.original_amount), balanceAmount: String(credit.balance_amount), balanceAsOf: formatDateInput(credit.balance_as_of), expiresAt: formatDateInput(credit.expires_at), models: Array.isArray(models) ? models.join(", ") : typeof models === "string" ? models : "", services: Array.isArray(services) ? services.join(", ") : typeof services === "string" ? services : "" };
}

function overrideFormFromRow(override: EffectivePrice): OverrideFormState {
  return { provider: override.provider, accountScope: override.accountScope, model: override.model ?? "", nativeUnit: override.nativeUnit, pricePerUnit: String(override.pricePerUnit), currency: override.currency, effectiveFrom: formatDateInput(override.effectiveFrom), effectiveTo: formatDateInput(override.effectiveTo), version: String(override.version + 1), pricingId: override.pricingId ?? "", source: override.source };
}

/** Rate fields asked for, by the units an unpriced model bills in. */
const UNIT_RATE_FIELDS: Record<string, Array<{ field: string; label: string }>> = {
  tokens: [{ field: "inputPerMillion", label: "Input, $ per 1M tokens" }, { field: "outputPerMillion", label: "Output, $ per 1M tokens" }],
  characters: [{ field: "perThousandCharacters", label: "$ per 1k characters" }],
  audioSeconds: [{ field: "perMinute", label: "$ per minute of audio" }],
  credits: [{ field: "perCredit", label: "$ per credit" }],
  searchQueries: [{ field: "perThousandQueries", label: "$ per 1k searches" }],
  pages: [{ field: "perThousandPages", label: "$ per 1k pages" }],
  images: [{ field: "perImage", label: "$ per image" }],
  requests: [{ field: "perRequest", label: "$ per request" }],
};

function PriceModelForm({ projectId, item, onDone, onCancel }: { projectId: string; item: UnpricedModel; onDone: (repriced: number) => void; onCancel: () => void }) {
  const tokenModel = item.units.includes("tokens");
  const [mode, setMode] = useState<"alias" | "rates">(tokenModel ? "alias" : "rates");
  const [target, setTarget] = useState("");
  const [suggestions, setSuggestions] = useState<CatalogModel[]>([]);
  const [rates, setRates] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fields = item.units.flatMap((unit) => UNIT_RATE_FIELDS[unit] ?? []);
  useEffect(() => {
    if (mode !== "alias" || target.trim().length < 2) { setSuggestions([]); return; }
    let alive = true;
    const timer = window.setTimeout(() => { void searchCatalogModels(item.provider, target.trim()).then((result) => { if (alive) setSuggestions(result.models); }).catch(() => undefined); }, 200);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [mode, target, item.provider]);
  const listId = `catalog-models-${item.provider}-${item.model ?? "none"}`.replace(/[^a-zA-Z0-9-]/g, "-");
  const chosen = suggestions.find((suggestion) => suggestion.model === target.trim().toLowerCase());
  async function save(): Promise<void> {
    if (!item.model) return;
    setSaving(true); setError(null);
    try {
      if (mode === "alias") {
        if (!target.trim()) { setError("Pick the model this one is priced as."); return; }
        onDone((await setModelAlias(projectId, { provider: item.provider, model: item.model, targetModel: target.trim() })).repriced);
      } else {
        const values = Object.fromEntries(Object.entries(rates).filter(([, value]) => value.trim() !== "").map(([field, value]) => [field, Number(value)]));
        if (Object.keys(values).length === 0 || Object.values(values).some((value) => !Number.isFinite(value) || value < 0)) { setError("Enter the rates as numbers."); return; }
        onDone((await setModelRates(projectId, { provider: item.provider, model: item.model, rates: values })).repriced);
      }
    } catch (saveError) { setError(errorText(saveError)); } finally { setSaving(false); }
  }
  return <div className="settings-form settings-price-form">
    {tokenModel && <div className="ck-segmented" role="tablist" aria-label="How to price this model"><button type="button" role="tab" aria-selected={mode === "alias"} className={mode === "alias" ? "active" : ""} onClick={() => setMode("alias")}>Same as a known model</button><button type="button" role="tab" aria-selected={mode === "rates"} className={mode === "rates" ? "active" : ""} onClick={() => setMode("rates")}>Your rates</button></div>}
    {mode === "alias"
      ? <div className="settings-form-field full"><label htmlFor={`${listId}-input`}>Priced as</label><input id={`${listId}-input`} list={listId} value={target} onChange={(event) => setTarget(event.target.value)} placeholder="gpt-6-sol" autoComplete="off" /><datalist id={listId}>{suggestions.map((suggestion) => <option key={`${suggestion.provider}/${suggestion.model}`} value={suggestion.model}>{suggestion.provider}</option>)}</datalist>{chosen && <span className="settings-form-hint">{Object.entries(chosen.rates).filter(([field]) => field === "inputPerMillion" || field === "outputPerMillion").map(([field, value]) => `${field === "inputPerMillion" ? "In" : "Out"} $${Number(value.toFixed(4))}/1M`).join(" · ")}</span>}</div>
      : <div className="settings-form-grid">{fields.map(({ field, label }) => <div className="settings-form-field" key={field}><label htmlFor={`${listId}-${field}`}>{label}</label><input id={`${listId}-${field}`} inputMode="decimal" value={rates[field] ?? ""} onChange={(event) => setRates((current) => ({ ...current, [field]: event.target.value }))} /></div>)}</div>}
    {error && <div className="settings-status-line error" role="alert">{error}</div>}
    <div className="settings-form-footer"><button className="ck-button ck-button-quiet" type="button" onClick={onCancel} disabled={saving}>Cancel</button><button className="ck-button ck-button-primary" type="button" onClick={() => void save()} disabled={saving}>{saving ? "Pricing" : "Save price"}</button></div>
  </div>;
}

/** Where prices come from, and any model still waiting for one. */
function PriceList({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const [status, setStatus] = useState<PriceCatalogStatus | null>(null);
  const [unpriced, setUnpriced] = useState<UnpricedModel[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    const [statusResult, unpricedResult] = await Promise.allSettled([getPriceCatalogStatus(), getUnpricedModels(projectId)]);
    if (statusResult.status === "fulfilled") setStatus(statusResult.value);
    if (unpricedResult.status === "fulfilled") setUnpriced(unpricedResult.value.models); else { setUnpriced([]); setError(errorText(unpricedResult.reason)); }
  }, [projectId]);
  useEffect(() => { setUnpriced(null); setOpen(null); void load(); }, [load]);
  async function refresh(): Promise<void> {
    setRefreshing(true); setError(null); setMessage(null);
    try { const result = await refreshPriceCatalog(); setMessage(result.repriced > 0 ? `Prices refreshed. Priced ${result.repriced.toLocaleString()} calls.` : "Prices are up to date."); await load(); }
    catch (refreshError) { setError(errorText(refreshError)); } finally { setRefreshing(false); }
  }
  const synced = status?.lastSync?.finished_at ?? status?.loadedAt ?? null;
  const rowKey = (item: UnpricedModel) => `${item.provider}\u0000${item.model ?? ""}`;
  return <Panel title="Price list" actions={canEdit && status?.enabled ? <button className="ck-button ck-button-quiet" type="button" onClick={() => void refresh()} disabled={refreshing}><RefreshCw size={13} /> {refreshing ? "Refreshing" : "Refresh"}</button> : undefined}><div className="settings-card-body">
    {(message || error) && <div className={`settings-status-line ${error ? "error" : "success"}`} role={error ? "alert" : "status"}>{error ?? message}</div>}
    {status && <p className="settings-footnote">{status.enabled ? `${status.prices.toLocaleString()} model prices from ${status.sources.map((source) => ({ litellm: "LiteLLM", models_dev: "models.dev", openrouter: "OpenRouter" } as Record<string, string>)[source.source] ?? source.source).join(", ")}${synced ? ` · updated ${formatDateTime(synced)}` : ""}` : "The price catalog is off on this server."}</p>}
    {unpriced === null ? <LoadingRows count={2} columns={4} /> : unpriced.length === 0
      ? null
      : <div className="settings-table-wrap"><table className="settings-table"><thead><tr><th>Model without a price</th><th>Calls</th><th>Last seen</th><th /></tr></thead><tbody>{unpriced.map((item) => <Fragment key={rowKey(item)}>
          <tr><td className="primary">{item.model ?? "Model not recorded"}<div className="muted">{item.provider}</div></td><td>{item.calls.toLocaleString()}</td><td className="muted">{formatDateTime(item.lastSeen)}</td><td className="actions">{canEdit && item.model && open !== rowKey(item) && <button className="ck-button ck-button-secondary" type="button" onClick={() => setOpen(rowKey(item))}>Set price</button>}</td></tr>
          {open === rowKey(item) && <tr className="settings-expanded-row"><td colSpan={4}><PriceModelForm projectId={projectId} item={item} onCancel={() => setOpen(null)} onDone={(repriced) => { setOpen(null); setMessage(`Priced ${repriced.toLocaleString()} call${repriced === 1 ? "" : "s"}.`); void load(); }} /></td></tr>}
        </Fragment>)}</tbody></table></div>}
  </div></Panel>;
}

/* Pricing and credits use the live project-scoped implementation below. */
function PricingCredits({ projects, role, currentProjectId }: { projects: SettingsProject[]; role: Role; currentProjectId: string | null }) {
  const [params] = useSearchParams();
  const [selectedId, setSelectedId] = useState(currentProjectId ?? projects[0]?.id ?? "");
  const [credits, setCredits] = useState<Credit[]>([]);
  const [prices, setPrices] = useState<EffectivePrice[]>([]);
  const [priceCapability, setPriceCapability] = useState<"loading" | "available" | "unavailable">("loading");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [showCreditForm, setShowCreditForm] = useState(() => params.get("state") === "credit-form");
  const [editingCredit, setEditingCredit] = useState<string | null>(null);
  const [creditForm, setCreditForm] = useState<CreditFormState>(blankCreditForm);
  const [showPriceForm, setShowPriceForm] = useState(false);
  const [editingPrice, setEditingPrice] = useState<string | null>(null);
  const [priceForm, setPriceForm] = useState<OverrideFormState>(blankOverrideForm);
  const [saving, setSaving] = useState(false);
  const canEdit = canManage(role);
  const confirmation = useConfirmation();

  useEffect(() => { if (currentProjectId && projects.some((project) => project.id === currentProjectId)) setSelectedId(currentProjectId); }, [currentProjectId, projects]);
  useEffect(() => {
    let alive = true;
    async function load(): Promise<void> {
      if (!selectedId) { setCredits([]); setPrices([]); setLoading(false); return; }
      setLoading(true); setError(null);
      const [creditResult, priceResult] = await Promise.allSettled([getCredits(selectedId), getEffectivePrices(selectedId)]);
      if (!alive) return;
      if (creditResult.status === "fulfilled") setCredits(creditResult.value.credits ?? []); else setError(errorText(creditResult.reason));
      if (priceResult.status === "fulfilled") { setPrices(priceResult.value.prices ?? []); setPriceCapability("available"); } else { setPrices([]); setPriceCapability(priceResult.reason instanceof SettingsApiError && priceResult.reason.status === 404 ? "unavailable" : "loading"); if (!(priceResult.reason instanceof SettingsApiError && priceResult.reason.status === 404)) setError(errorText(priceResult.reason)); }
      setLoading(false);
    }
    void load(); return () => { alive = false; };
  }, [selectedId]);

  function creditInput(): Parameters<typeof createCredit>[1] | null {
    const originalAmount = Number(creditForm.originalAmount); const balanceAmount = Number(creditForm.balanceAmount); const models = listFromInput(creditForm.models); const services = listFromInput(creditForm.services);
    if (!creditForm.provider.trim() || !creditForm.accountScope.trim() || !creditForm.cloudProject.trim() || !creditForm.balanceAsOf || !Number.isFinite(originalAmount) || !Number.isFinite(balanceAmount) || originalAmount < 0 || balanceAmount < 0 || balanceAmount > originalAmount || (models.length === 0 && services.length === 0)) return null;
    return { provider: creditForm.provider.trim(), accountScope: creditForm.accountScope.trim(), cloudProject: creditForm.cloudProject.trim(), currency: creditForm.currency.toUpperCase(), originalAmount, balanceAmount, balanceAsOf: creditForm.balanceAsOf, expiresAt: creditForm.expiresAt || null, eligibility: { ...(models.length ? { models } : {}), ...(services.length ? { services } : {}) } };
  }
  function effectivePriceInput(): import("../settingsApi").EffectivePriceInput | null {
    const pricePerUnit = Number(priceForm.pricePerUnit); const version = Number(priceForm.version);
    if (!priceForm.provider.trim() || !priceForm.accountScope.trim() || !priceForm.nativeUnit.trim() || !priceForm.effectiveFrom || !priceForm.source.trim() || !Number.isFinite(pricePerUnit) || pricePerUnit < 0 || !Number.isSafeInteger(version) || version <= 0) return null;
    return { provider: priceForm.provider.trim(), accountScope: priceForm.accountScope.trim(), model: priceForm.model.trim() || null, nativeUnit: priceForm.nativeUnit.trim().toLowerCase(), pricePerUnit, currency: priceForm.currency.toUpperCase(), effectiveFrom: priceForm.effectiveFrom, effectiveTo: priceForm.effectiveTo || null, source: priceForm.source.trim(), version, pricingId: priceForm.pricingId.trim() || null };
  }
  async function saveCredit(): Promise<void> { const input = creditInput(); if (!input || !canEdit) return; setSaving(true); setError(null); setMessage(null); try { if (editingCredit) await updateCredit(selectedId, editingCredit, input); else await createCredit(selectedId, input); setCredits((await getCredits(selectedId)).credits ?? []); setCreditForm(blankCreditForm()); setEditingCredit(null); setShowCreditForm(false); setMessage("Credit saved. Your costs are unchanged."); } catch (saveError) { setError(errorText(saveError)); } finally { setSaving(false); } }
  function removeCredit(credit: Credit, trigger: HTMLElement): void { if (!canEdit) return; confirmation.ask({ title: "Delete credit entry?", body: `The ${credit.provider} credit balance and eligibility record will be removed. Observed consumption is not changed.`, actionLabel: "Delete credit", onConfirm: async () => { try { await deleteCredit(selectedId, credit.id); setCredits((current) => current.filter((item) => item.id !== credit.id)); setMessage("Credit entry deleted."); } catch (deleteError) { setError(errorText(deleteError)); } } }, trigger); }
  async function savePrice(): Promise<void> { const input = effectivePriceInput(); if (!input || !canEdit || priceCapability !== "available") return; setSaving(true); setError(null); setMessage(null); try { if (editingPrice) { const result = await updateEffectivePrice(selectedId, editingPrice, input); setPrices((current) => [...current.filter((item) => item.id !== editingPrice), result.price]); } else { const result = await createEffectivePrice(selectedId, input); setPrices((current) => [result.price, ...current]); } setPriceForm(blankOverrideForm()); setEditingPrice(null); setShowPriceForm(false); setMessage("Rate saved."); } catch (saveError) { setError(errorText(saveError)); } finally { setSaving(false); } }
  function revokePrice(price: EffectivePrice, trigger: HTMLElement): void { if (!canEdit) return; confirmation.ask({ title: "Revoke effective price?", body: `New matching charges will no longer use the ${price.provider} ${price.model ?? "broad"} ${price.nativeUnit} rule. The audit row remains available.`, actionLabel: "Revoke price", onConfirm: async () => { try { await deleteEffectivePrice(selectedId, price.id); setPrices((current) => current.map((item) => item.id === price.id ? { ...item, revokedAt: new Date().toISOString() } : item)); setMessage("Rate removed."); } catch (revokeError) { setError(errorText(revokeError)); } } }, trigger); }
  if (projects.length === 0) return <Panel><EmptyPanel title="No project pricing scope" body="Connect a project to add rates or credits." icon={<CreditCard size={18} />} /></Panel>;
  return <>
    {confirmation.dialog}
    <div className="settings-section-title"><div><h2>Prices & credits</h2></div>{!canEdit && <StatusPill tone="neutral">Read only</StatusPill>}</div>
    {(message || error) && <div className={`settings-status-line ${error ? "error" : "success"}`} role={error ? "alert" : "status"}>{error ?? message}</div>}
    {selectedId && <PriceList projectId={selectedId} canEdit={canEdit} />}
    <Panel title="Custom rates" actions={canEdit && priceCapability === "available" ? <button className="ck-button ck-button-secondary" type="button" onClick={() => { setShowPriceForm((value) => !value); setEditingPrice(null); setPriceForm(blankOverrideForm()); }}><Plus size={13} /> {showPriceForm ? "Close form" : "Add a rate"}</button> : <StatusPill tone="neutral">{priceCapability === "unavailable" ? "Unavailable" : "Read only"}</StatusPill>}><div className="settings-card-body">{showPriceForm && priceCapability === "available" && <EffectivePriceForm form={priceForm} setForm={setPriceForm} saving={saving} editing={Boolean(editingPrice)} onSave={() => void savePrice()} onCancel={() => { setShowPriceForm(false); setEditingPrice(null); }} />}{loading ? <LoadingRows count={2} columns={4} /> : prices.length === 0 ? <div className="settings-empty">{priceCapability === "unavailable" ? "Custom rates aren’t available on this server." : "No custom rates."}</div> : <div className="settings-table-wrap"><table className="settings-table"><thead><tr><th>Provider / account</th><th>Model / unit</th><th>Rate</th><th>Effective</th><th>Source</th><th /></tr></thead><tbody>{prices.map((price) => <tr key={price.id}><td className="primary">{price.provider}<div className="muted">{price.accountScope}</div></td><td className="mono">{price.model ?? "Broad account rule"}<div className="muted">{price.nativeUnit}</div></td><td className="numeric">{price.pricePerUnit} {price.currency}<div className="muted">v{price.version}</div></td><td>{formatDateInput(price.effectiveFrom)}{price.effectiveTo ? ` → ${formatDateInput(price.effectiveTo)}` : " → open"}<div className="muted">{price.revokedAt ? `Revoked ${formatDateInput(price.revokedAt)}` : "Active"}</div></td><td className="muted">{price.source}<div>User supplied</div></td><td className="actions">{canEdit && !price.revokedAt && <><button className="settings-icon-button" type="button" onClick={() => { setPriceForm(overrideFormFromRow(price)); setEditingPrice(price.id); setShowPriceForm(true); }} aria-label={`Edit ${price.model ?? price.nativeUnit} price`}><Pencil size={13} /></button><button className="settings-icon-button" type="button" onClick={(event) => revokePrice(price, event.currentTarget)} aria-label={`Revoke ${price.model ?? price.nativeUnit} price`}><Trash2 size={13} /></button></>}</td></tr>)}</tbody></table></div>}</div></Panel>
    <Panel title="Credits" actions={canEdit ? <button className="ck-button ck-button-secondary" type="button" onClick={() => { setShowCreditForm((value) => !value); setEditingCredit(null); setCreditForm(blankCreditForm()); }}><Plus size={13} /> {showCreditForm ? "Close form" : "Add credit"}</button> : <StatusPill tone="neutral">Read only</StatusPill>}><div className="settings-card-body">{showCreditForm && <CreditForm form={creditForm} setForm={setCreditForm} onSave={() => void saveCredit()} onCancel={() => { setShowCreditForm(false); setEditingCredit(null); }} saving={saving} editing={Boolean(editingCredit)} />}{loading ? <LoadingRows count={2} columns={4} /> : credits.length === 0 ? <div className="settings-empty">No credits.</div> : <div className="settings-table-wrap"><table className="settings-table"><thead><tr><th>Provider / scope</th><th>Balance</th><th>Eligibility</th><th>Expiry</th><th /></tr></thead><tbody>{credits.map((credit) => <tr key={credit.id}><td className="primary">{credit.provider}<div className="muted">{credit.account_scope} · {credit.cloud_project}</div></td><td className="numeric">{credit.balance_amount} {credit.currency}<div className="muted">as of {formatDateInput(credit.balance_as_of)}</div></td><td className="muted">{JSON.stringify(credit.eligibility)}</td><td>{credit.expires_at ? formatDateInput(credit.expires_at) : "No expiry"}<div className="muted">{credit.source === "user_supplied" ? "User supplied" : credit.source}</div></td><td className="actions">{canEdit && <><button className="settings-icon-button" type="button" onClick={() => { setCreditForm(creditFormFromRow(credit)); setEditingCredit(credit.id); setShowCreditForm(true); }} aria-label={`Edit ${credit.provider} credit`}><Pencil size={13} /></button><button className="settings-icon-button" type="button" onClick={(event) => removeCredit(credit, event.currentTarget)} aria-label={`Delete ${credit.provider} credit`}><Trash2 size={13} /></button></>}</td></tr>)}</tbody></table></div>}</div></Panel>
  </>;
}

function EffectivePriceForm({ form, setForm, saving, editing, onSave, onCancel }: { form: OverrideFormState; setForm: (form: OverrideFormState) => void; saving: boolean; editing: boolean; onSave: () => void; onCancel: () => void }) {
  return <div className="settings-form" style={{ marginBottom: 16 }}><div className="settings-form-grid"><div className="settings-form-field"><label htmlFor="effective-provider">Provider</label><input id="effective-provider" value={form.provider} onChange={(event) => setForm({ ...form, provider: event.target.value })} placeholder="openrouter" /></div><div className="settings-form-field"><label htmlFor="effective-account">Account scope</label><input id="effective-account" value={form.accountScope} onChange={(event) => setForm({ ...form, accountScope: event.target.value })} placeholder="acct_123" /></div><div className="settings-form-field"><label htmlFor="effective-model">Exact model <span className="settings-footnote">(leave blank for all)</span></label><input id="effective-model" value={form.model} onChange={(event) => setForm({ ...form, model: event.target.value })} placeholder="gpt-4.1-mini" /></div><div className="settings-form-field"><label htmlFor="effective-unit">Native unit</label><select id="effective-unit" value={form.nativeUnit} onChange={(event) => setForm({ ...form, nativeUnit: event.target.value })}><option value="input_tokens">input_tokens</option><option value="output_tokens">output_tokens</option><option value="cache_read_tokens">cache_read_tokens</option><option value="cache_creation_tokens">cache_creation_tokens</option><option value="image_output_tokens">image_output_tokens</option><option value="audio_seconds">audio_seconds</option><option value="characters">characters</option><option value="requests">requests</option></select></div><div className="settings-form-field"><label htmlFor="effective-rate">Price per native unit</label><input id="effective-rate" type="number" min="0" step="0.000000001" value={form.pricePerUnit} onChange={(event) => setForm({ ...form, pricePerUnit: event.target.value })} placeholder="0.000001" /></div><div className="settings-form-field"><label htmlFor="effective-currency">Currency</label><select id="effective-currency" value={form.currency} onChange={(event) => setForm({ ...form, currency: event.target.value })}><option value="USD">USD</option><option value="INR">INR</option></select></div><div className="settings-form-field"><label htmlFor="effective-from">Effective from</label><input id="effective-from" type="date" value={form.effectiveFrom} onChange={(event) => setForm({ ...form, effectiveFrom: event.target.value })} /></div><div className="settings-form-field"><label htmlFor="effective-to">Effective to <span className="settings-footnote">(optional)</span></label><input id="effective-to" type="date" value={form.effectiveTo} onChange={(event) => setForm({ ...form, effectiveTo: event.target.value })} /></div><div className="settings-form-field"><label htmlFor="effective-version">Version</label><input id="effective-version" type="number" min="1" step="1" value={form.version} onChange={(event) => setForm({ ...form, version: event.target.value })} /></div><div className="settings-form-field"><label htmlFor="effective-pricing-id">Pricing ID <span className="settings-footnote">(optional)</span></label><input id="effective-pricing-id" value={form.pricingId} onChange={(event) => setForm({ ...form, pricingId: event.target.value })} placeholder="provider-rate-2026-09" /></div><div className="settings-form-field full"><label htmlFor="effective-source">Source / provenance</label><input id="effective-source" value={form.source} onChange={(event) => setForm({ ...form, source: event.target.value })} placeholder="user_supplied or provider documentation reference" /></div></div><div className="settings-form-footer"><button className="ck-button ck-button-primary" type="button" onClick={onSave} disabled={saving}>{saving ? "Saving" : editing ? "Save new version" : "Create effective price"}</button><button className="ck-button ck-button-quiet" type="button" onClick={onCancel}>Cancel</button></div></div>;
}

function CreditForm({ form, setForm, onSave, onCancel, saving, editing }: { form: CreditFormState; setForm: (form: CreditFormState) => void; onSave: () => void; onCancel: () => void; saving: boolean; editing: boolean }) {
  return <div className="settings-form" style={{ marginBottom: 16 }}><div className="settings-form-grid"><div className="settings-form-field"><label htmlFor="credit-provider">Provider / cloud</label><input id="credit-provider" value={form.provider} onChange={(event) => setForm({ ...form, provider: event.target.value })} placeholder="OpenAI" required /></div><div className="settings-form-field"><label htmlFor="credit-account">Account scope</label><input id="credit-account" value={form.accountScope} onChange={(event) => setForm({ ...form, accountScope: event.target.value })} placeholder="acct_123" required /></div><div className="settings-form-field"><label htmlFor="credit-project">Cloud/project scope</label><input id="credit-project" value={form.cloudProject} onChange={(event) => setForm({ ...form, cloudProject: event.target.value })} placeholder="billing-project" required /></div><div className="settings-form-field"><label htmlFor="credit-currency">Currency</label><select id="credit-currency" value={form.currency} onChange={(event) => setForm({ ...form, currency: event.target.value })}><option value="USD">USD</option><option value="INR">INR</option></select></div><div className="settings-form-field"><label htmlFor="credit-original">Original amount</label><input id="credit-original" type="number" min="0" step="0.01" value={form.originalAmount} onChange={(event) => setForm({ ...form, originalAmount: event.target.value })} placeholder="200" required /></div><div className="settings-form-field"><label htmlFor="credit-balance">Current balance</label><input id="credit-balance" type="number" min="0" step="0.01" value={form.balanceAmount} onChange={(event) => setForm({ ...form, balanceAmount: event.target.value })} placeholder="180" required /></div><div className="settings-form-field"><label htmlFor="credit-asof">Balance as of</label><input id="credit-asof" type="date" value={form.balanceAsOf} onChange={(event) => setForm({ ...form, balanceAsOf: event.target.value })} required /></div><div className="settings-form-field"><label htmlFor="credit-expiry">Expires on <span className="settings-footnote">(optional)</span></label><input id="credit-expiry" type="date" value={form.expiresAt} onChange={(event) => setForm({ ...form, expiresAt: event.target.value })} /></div><div className="settings-form-field full"><label htmlFor="credit-models">Eligible models</label><input id="credit-models" value={form.models} onChange={(event) => setForm({ ...form, models: event.target.value })} placeholder="gpt-4.1-mini, gpt-4.1" /><small>Comma-separated models or services the credit covers.</small></div><div className="settings-form-field full"><label htmlFor="credit-services">Covers</label><input id="credit-services" value={form.services} onChange={(event) => setForm({ ...form, services: event.target.value })} placeholder="direct OpenAI API" /></div></div><div className="settings-form-footer"><button className="ck-button ck-button-primary" type="button" onClick={onSave} disabled={saving}>{saving ? "Saving" : editing ? "Save credit" : "Save manual credit"}</button><button className="ck-button ck-button-quiet" type="button" onClick={onCancel} disabled={saving}>Cancel</button></div></div>;
}

function BillingSettings({ role, orgId, billingQuery }: { role: Role; orgId: string | null; billingQuery: string | null }) {
  const [closeOpen, setCloseOpen] = useState(false);
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [target, setTarget] = useState<BillingTarget | null>(null);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [closureImpact, setClosureImpact] = useState<WorkspaceClosureImpact | null>(null);
  const [closureOrgId, setClosureOrgId] = useState("");
  const [closureMessage, setClosureMessage] = useState<string | null>(null);
  const [closureError, setClosureError] = useState<string | null>(null);
  const [closureSaving, setClosureSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(billingQuery === "success" ? "Thanks! Your plan updates in a moment." : billingQuery === "cancelled" ? "Checkout cancelled. Nothing changed." : null);
  const [error, setError] = useState<string | null>(null);
  const owner = canManageSubscription(role);
  const subscriptionUnconfigured = subscription?.status === "not_configured" || subscription?.provider === "unconfigured";
  const subscriptionActionable = Boolean(subscription && ["active", "trialing", "past_due"].includes(subscription.status) && !subscriptionUnconfigured);
  const confirmation = useConfirmation();
  useEffect(() => {
    let alive = true;
    async function load(): Promise<void> {
      if (!owner) { setLoading(false); return; }
      setLoading(true); setError(null);
      const [subscriptionResult, invoiceResult, closureResult] = await Promise.allSettled([getSubscription(), getInvoices(), getWorkspaceClosureImpact()]);
      if (!alive) return;
      if (subscriptionResult.status === "fulfilled") { setSubscription(subscriptionResult.value.subscription); setTarget(subscriptionResult.value.target); } else setError(errorText(subscriptionResult.reason));
      if (invoiceResult.status === "fulfilled") setInvoices(Array.isArray(invoiceResult.value.invoices) ? invoiceResult.value.invoices : []);
      if (closureResult.status === "fulfilled") setClosureImpact(closureResult.value.impact);
      else setClosureError(errorText(closureResult.reason));
      setLoading(false);
    }
    void load(); return () => { alive = false; };
  }, [owner]);
  async function checkout(): Promise<void> { setSaving(true); setMessage(null); setError(null); try { const result = await startSubscriptionCheckout(`costkey-checkout-${Date.now()}`); if (result.checkoutUrl) window.location.assign(result.checkoutUrl); else setMessage("Billing isn’t set up on this server yet."); } catch (checkoutError) { setError(errorText(checkoutError)); } finally { setSaving(false); } }
  function cancel(trigger: HTMLElement): void { confirmation.ask({ title: "Cancel renewal at period end?", body: "Your plan stays active until the end of the paid period, then ends.", actionLabel: "Cancel subscription", onConfirm: async () => { setSaving(true); setMessage(null); setError(null); try { const result = await cancelSubscription(); setSubscription(result.subscription); setMessage("Cancels at the end of the paid period."); } catch (cancelError) { setError(errorText(cancelError)); } finally { setSaving(false); } } }, trigger); }
  async function resume(): Promise<void> { setSaving(true); setMessage(null); setError(null); try { const result = await resumeSubscription(); setSubscription(result.subscription); setMessage("Subscription renewal resumed."); } catch (resumeError) { setError(errorText(resumeError)); } finally { setSaving(false); } }
  function reviewClosure(trigger: HTMLElement): void {
    if (!orgId || !closureImpact || closureOrgId.trim() !== orgId) return;
    confirmation.ask({
      title: "Ask us to close this workspace?",
      body: "We’ll review the request and confirm with you before deleting anything.",
      actionLabel: "Request closure review",
      onConfirm: async () => {
        setClosureSaving(true); setClosureMessage(null); setClosureError(null);
        try {
          const result = await requestWorkspaceClosure(orgId);
          setClosureImpact(result.impact);
          setClosureMessage(result.created ? "Request sent. Nothing has been deleted." : "You’ve already asked. We’ll be in touch.");
        } catch (closureRequestError) {
          setClosureError(errorText(closureRequestError));
        } finally {
          setClosureSaving(false);
        }
      },
    }, trigger);
  }
  if (!owner) return <><div className="settings-section-title"><div><h2>Billing</h2></div></div><Panel><EmptyPanel title="Only the Owner can manage billing" body="Ask your workspace Owner to see invoices or change the plan." icon={<Lock size={18} />} /></Panel></>;
  return <>
    {confirmation.dialog}
    <div className="settings-section-title"><div><h2>Billing</h2></div></div>
    {(message || error) && <div className={`settings-status-line ${error ? "error" : "success"}`} role={error ? "alert" : "status"}>{error ?? message}</div>}
    {loading ? <LoadingPanel title="Subscription" /> : <Panel title="Workspace subscription"><div className="settings-card-body">{target && !subscriptionUnconfigured && <div className="settings-cost-hero"><div><div className="settings-signal-label">CostKey subscription</div><div className="settings-cost-value">${target.amountUsd}<span>{target.per === "user" ? ` / member / ${target.interval}` : ` / ${target.interval}`}</span></div><div className="settings-footnote">{target.per === "user" ? `${target.seats} ${target.seats === 1 ? "member" : "members"} · $${target.totalUsd.toLocaleString("en-US", { minimumFractionDigits: target.totalUsd % 1 ? 2 : 0 })} / ${target.interval}. Adding or removing someone updates the next invoice.` : "Workspace plan, teammates included"}</div></div><StatusPill tone={subscription?.status === "active" ? "good" : subscription?.status === "not_configured" ? "neutral" : "warn"}>{planLabel(subscription?.status)}</StatusPill></div>}{subscriptionUnconfigured ? <div className="settings-empty" style={{ marginTop: 16 }}>{subscription?.provider === "unconfigured" ? "No plan needed right now. Questions about plans? Talk to us at naman@costkey.dev." : "No plan yet. Questions about plans? Talk to us at naman@costkey.dev."}</div> : !subscription ? <div className="settings-empty" style={{ marginTop: 16 }}>Couldn’t reach billing. Try again shortly.</div> : <div className="settings-definition-list" style={{ marginTop: 16 }}><div className="settings-definition-row"><dt>Current paid period</dt><dd>{subscription.currentPeriodStart ? formatDateInput(subscription.currentPeriodStart) : "Unknown"} → {subscription.currentPeriodEnd ? formatDateInput(subscription.currentPeriodEnd) : "Unknown"}</dd></div><div className="settings-definition-row"><dt>Payment method</dt><dd>{subscription.paymentMethodSummary ?? "Not available"}</dd></div><div className="settings-definition-row"><dt>Renewal / cancellation</dt><dd>{subscription.cancelAtPeriodEnd ? `Ends ${subscription.cancelAt ? formatDateInput(subscription.cancelAt) : "at period end"}` : subscription.currentPeriodEnd ? `Renews ${formatDateInput(subscription.currentPeriodEnd)}` : "Unknown"}</dd></div></div>}{subscriptionUnconfigured && subscription?.provider !== "unconfigured" ? <div className="settings-form-footer"><button className="ck-button ck-button-primary" type="button" aria-label="Start CostKey subscription" onClick={() => void checkout()} disabled={saving}>{saving ? "Opening checkout" : "Start subscription"}</button></div> : subscriptionActionable && subscription ? <div className="settings-form-footer">{subscription.cancelAtPeriodEnd ? <button className="ck-button ck-button-secondary" type="button" onClick={() => void resume()} disabled={saving}>Resume renewal</button> : <button className="ck-button ck-button-danger" type="button" aria-label="Cancel subscription at period end" onClick={(event) => cancel(event.currentTarget)} disabled={saving}>Cancel at period end</button>}</div> : null}</div></Panel>}
    {invoices.length > 0 && <Panel title="Invoices"><div className="settings-table-wrap"><table className="settings-table"><thead><tr><th>Invoice</th><th>Status</th><th className="numeric">Amount due</th><th>Issued</th><th /></tr></thead><tbody>{invoices.map((invoice) => <tr key={invoice.id}><td className="primary">{invoice.provider_invoice_id ?? invoice.id}</td><td><StatusPill tone={statusTone(invoice.status)}>{invoice.status}</StatusPill></td><td className="numeric">{invoice.amount_due_cents == null ? "Unknown" : `${(invoice.amount_due_cents / 100).toFixed(2)} ${invoice.currency.toUpperCase()}`}</td><td>{invoice.issued_at ? formatDateInput(invoice.issued_at) : "Unknown"}</td><td className="actions">{invoice.hosted_invoice_url && <a className="ck-button ck-button-quiet" href={invoice.hosted_invoice_url} target="_blank" rel="noreferrer">Open invoice</a>}</td></tr>)}</tbody></table></div></Panel>}
    <Panel className="settings-danger-zone" title="Close workspace" actions={closeOpen ? undefined : <button className="ck-button ck-button-quiet ck-button-danger-quiet" type="button" onClick={() => setCloseOpen(true)}>Close workspace…</button>}>{closeOpen && <div className="settings-card-body"><div className="ck-alert"><AlertTriangle size={15} /><div><strong>Nothing happens right away.</strong> This only asks us to review closing the workspace. Nothing is deleted or cancelled yet.</div></div>{closureImpact ? <><div className="settings-definition-list" style={{ marginTop: 14 }}><div className="settings-definition-row"><dt>Projects</dt><dd>{closureImpact.projects.count} · DSNs keep working until you rotate them</dd></div><div className="settings-definition-row"><dt>Members</dt><dd>{closureImpact.members.count} · keep access until the review is done</dd></div><div className="settings-definition-row"><dt>Active budgets</dt><dd>{closureImpact.policies.activeCount} · unchanged until the review is done</dd></div><div className="settings-definition-row"><dt>Subscription</dt><dd>{planLabel(closureImpact.subscription.status)}</dd></div><div className="settings-definition-row"><dt>Your data</dt><dd>Kept until the review is done</dd></div><div className="settings-definition-row"><dt>Request</dt><dd>{closureImpact.pendingRequest ? `Pending · ${formatSettingsDate(closureImpact.pendingRequest.requested_at)}` : "No pending request"}</dd></div></div><div className="settings-form" style={{ marginTop: 16 }}><div className="settings-form-field"><label htmlFor="closure-confirm-org">Type the workspace ID to confirm</label><input id="closure-confirm-org" value={closureOrgId} onChange={(event) => setClosureOrgId(event.target.value)} placeholder={orgId ?? "Workspace ID"} disabled={!orgId || closureSaving} autoComplete="off" /><small>Only the Owner can request this. We’ll confirm with you before anything is deleted.</small></div><div className="settings-form-footer"><button className="ck-button ck-button-danger" type="button" onClick={(event) => reviewClosure(event.currentTarget)} disabled={!orgId || !closureImpact || closureOrgId.trim() !== orgId || closureSaving} aria-label="Ask to close this workspace">{closureSaving ? "Requesting" : "Review and request"}</button></div></div></> : <div className="settings-empty" style={{ marginTop: 14 }}>Closing a workspace isn’t available here. Contact support and we’ll help.</div>}{closureError && <div className="settings-status-line error" role="alert">{closureError}</div>}{closureMessage && <div className="settings-status-line success" role="status">{closureMessage}</div>}</div>}</Panel>
  </>;
}
