import { appUrl } from "../basePath";
import { useEffect, useState } from "react";
import { ArrowRight, CircleAlert, Gauge, Plus, ShieldCheck } from "lucide-react";
import { Link, Navigate, useParams, useSearchParams } from "react-router-dom";
import { useAuth } from "../contexts/useAuth";
import { EmptyPanel, LoadingRows, PageHeader, Panel, StatusPill } from "../components/ConsolePrimitives";
import { formatCurrencyAmount } from "../components/consoleFormatters";
import { prototypeRole, prototypeState, PrototypeStateNotice, PrototypeStatePanel } from "../components/PrototypeState";
import { isPrototypePreview } from "../prototypePreview";
import "./PrototypeRoute.css";

type PolicyMode = "monitor" | "enforce";
type PolicyStatus = "active" | "paused" | "archived";
type PolicyUnit = "money" | "calls" | "tokens";
type PolicyWindow = "per_trace" | "per_execution" | "per_call" | "calendar_minute" | "calendar_day" | "calendar_month";

interface Policy {
  id: string;
  projectId: string;
  name: string | null;
  scope: Record<string, string | string[]>;
  mode: PolicyMode;
  status: PolicyStatus;
  unit: PolicyUnit;
  allowance: number;
  currency: "USD" | "INR" | null;
  window: PolicyWindow;
  timezone: string;
  usage?: { observed: number | null; committed: number | null; remaining: number | null; coverage?: number | null };
}

const POLICY_TABS = ["Active", "Paused", "Archived"] as const;
type PolicyTab = typeof POLICY_TABS[number];

/** "search, answer +1": a group shows its first two values. */
function scopeValueText(value: string | string[]): string {
  const values = Array.isArray(value) ? value : [value];
  return values.length > 2 ? `${values.slice(0, 2).join(", ")} +${values.length - 2}` : values.join(", ");
}

function policyScope(policy: Policy): string {
  const [key, rawValue] = Object.entries(policy.scope ?? {})[0] ?? [];
  if (!key || !rawValue || rawValue.length === 0) return "Whole project";
  const value = scopeValueText(rawValue);
  if (isPrototypePreview()) {
    if (key === "project") return "Atlas · All environments";
    if (key === "feature" && value === "Search") return "Feature: Search · All environments";
    if (key === "feature" && value === "Voice assistance") return "Voice framework · Each trace";
    if (key === "group") return `Group: ${value}`;
  }
  return `${key === "group" ? "Experiment" : key[0].toUpperCase() + key.slice(1)}: ${value}`;
}

function formatWindow(value: PolicyWindow): string {
  return ({
    per_trace: "Per run",
    per_execution: "Per batch",
    per_call: "Per call",
    calendar_minute: "Per minute",
    calendar_day: "Daily",
    calendar_month: "Monthly",
  })[value];
}

function formatPolicyValue(policy: Policy, value: number | null | undefined): string {
  if (value == null) return "Unavailable";
  if (policy.unit === "money") return formatCurrencyAmount(value, policy.currency ?? "USD");
  return `${value.toLocaleString()} ${policy.unit}`;
}

/** Budget status in the design language: Within budget, Needs a look, Limit reached. */
function budgetStatus(policy: Policy): { tone: "good" | "warn" | "critical" | "neutral"; label: string } {
  if (policy.status === "paused") return { tone: "neutral", label: "Paused" };
  if (policy.status === "archived") return { tone: "neutral", label: "Archived" };
  const allowance = Number(policy.allowance) || 0;
  const observed = policy.usage?.observed;
  if (observed == null || allowance <= 0) return { tone: "neutral", label: "Waiting for usage" };
  const ratio = observed / allowance;
  if (ratio >= 1) return { tone: "critical", label: "Limit reached" };
  if (ratio >= 0.8) return { tone: "warn", label: "Needs a look" };
  return { tone: "good", label: "Within budget" };
}

function actionText(policy: Policy): string {
  if (policy.status !== "active") return "Not checking";
  if (policy.window === "per_call") return policy.mode === "enforce" ? "Refuse calls over the limit" : "Alert on calls over the limit";
  return policy.mode === "enforce" ? "Stop new calls" : "Alert at 80% and 100%";
}

function actionSubtext(policy: Policy): string {
  if (isPrototypePreview()) {
    if (policy.mode === "enforce") return "Calls already running still finish";
    if (policy.scope?.feature === "Voice assistance") return "Nothing is blocked";
    return "Resets 1 Oct, 00:00 IST";
  }
  if (policy.status !== "active") return "History kept";
  return policy.mode === "enforce" ? "Calls already running still finish" : "Nothing is blocked";
}

function policyPath(projectId: string, policyId: string): string {
  return `/policy?id=${encodeURIComponent(policyId)}&project=${encodeURIComponent(projectId)}`;
}

function editorPath(projectId: string, policy?: Policy): string {
  const params = new URLSearchParams({ project: projectId });
  if (policy) {
    params.set("id", policy.id);
    const [scopeDimension, scopeValue] = Object.entries(policy.scope ?? {})[0] ?? [];
    if (scopeDimension) params.set("scopeDimension", scopeDimension);
    if (scopeValue) params.set("scopeValue", Array.isArray(scopeValue) ? scopeValue.join(", ") : scopeValue);
  }
  return `/policy-edit?${params.toString()}`;
}

function PolicyTable({ policies, projectId, canEdit, onArchive }: { policies: Policy[]; projectId: string; canEdit: boolean; onArchive: (policy: Policy) => void }) {
  if (policies.length === 0) return <EmptyPanel title="No budgets here yet" action={canEdit ? <Link className="ck-button ck-button-secondary" to={editorPath(projectId)}>Create a budget <ArrowRight size={14} /></Link> : <span className="ck-table-note" style={{ border: 0, padding: 0 }}>Ask an Owner or Admin to create one.</span>} icon={<ShieldCheck size={20} />} />;

  return <div className="ck-table-wrap"><table className="ck-table ck-budget-table"><thead><tr><th>Budget</th><th>Limit</th><th className="numeric">Used</th><th className="hide-mobile">When reached</th><th className="hide-mobile">Status</th>{canEdit && <th className="hide-mobile"><span className="sr-only">Actions</span></th>}</tr></thead><tbody>{policies.map((policy) => {
    const allowance = Number(policy.allowance) || 0;
    const observed = policy.usage?.observed ?? null;
    const progress = allowance > 0 && observed != null ? Math.min(100, Math.max(0, observed / allowance * 100)) : null;
    const progressTone = progress != null && progress >= 100 ? "critical" : progress != null && progress >= 80 ? "warn" : "";
    return <tr key={policy.id}>
      <td><Link className="ck-table-link primary-cell" to={policyPath(projectId, policy.id)}>{policy.name || "Unnamed budget"}</Link><div className="muted">{policyScope(policy)}</div><div className="ck-show-mobile"><StatusPill tone={budgetStatus(policy).tone}>{budgetStatus(policy).label}</StatusPill></div></td>
      <td><span className="numeric">{formatPolicyValue(policy, allowance)}</span><div className="muted">{formatWindow(policy.window)}</div></td>
      <td className="numeric"><span>{formatPolicyValue(policy, observed)}</span>{progress != null && <div className={`ck-progress ${progressTone}`} style={{ margin: "6px 0 0", height: 5 }} aria-label={`${Math.round(progress)} percent used`}><span style={{ width: `${progress}%` }} /></div>}</td>
      <td className="hide-mobile"><span>{actionText(policy)}</span><div className="muted">{actionSubtext(policy)}</div></td>
      <td className="hide-mobile"><StatusPill tone={budgetStatus(policy).tone}>{budgetStatus(policy).label}</StatusPill></td>
      {canEdit && <td className="hide-mobile numeric"><span className="ck-row-actions"><Link className="ck-button ck-button-quiet sm" to={editorPath(projectId, policy)}>Edit</Link>{policy.status !== "archived" && <button className="ck-button ck-button-quiet sm" type="button" onClick={() => onArchive(policy)}>Archive</button>}</span></td>}
    </tr>;
  })}</tbody></table></div>;
}


export default function Budgets() {
  const { currentProjectId, projects, user, setCurrentProjectId } = useAuth();
  const projectId = currentProjectId ?? projects[0]?.id ?? null;
  const { policyId: pathPolicyId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const requestedProjectId = searchParams.get("project");
  const requestedProject = requestedProjectId ? projects.find((project) => project.id === requestedProjectId) : undefined;
  const requestedTab = searchParams.get("tab");
  const tab: PolicyTab = POLICY_TABS.includes(requestedTab as PolicyTab) ? requestedTab as PolicyTab : "Active";
  const previewState = searchParams.get("state");
  const previewLoading = previewState === "loading";
  const previewError = previewState === "error" ? "Couldn’t refresh budgets. Nothing was changed." : null;
  const previewEmpty = previewState === "empty";
  const previewRestricted = previewState === "restricted";

  useEffect(() => {
    if (requestedProject && requestedProject.id !== currentProjectId) setCurrentProjectId(requestedProject.id);
  }, [requestedProject, currentProjectId, setCurrentProjectId]);

  useEffect(() => {
    if (!projectId || (requestedProject && requestedProject.id !== currentProjectId)) return;
    let cancelled = false;
    // Start the refresh in a microtask so the effect only coordinates the
    // external request; the loading/error state updates happen in the async
    // request lifecycle rather than during the effect's synchronous pass.
    void Promise.resolve().then(() => {
      if (cancelled) return null;
      setLoading(true); setError(null);
      return fetch(appUrl(`/api/v1/projects/${projectId}/budget/policies`), { credentials: "include" });
    })
      .then(async (response) => {
        if (!response) return;
        if (!response.ok) throw new Error("Couldn’t load budgets. Try again in a moment.");
        const result = await response.json() as { policies?: Policy[] };
        if (!cancelled) { setPolicies(result.policies ?? []); setLoading(false); }
      })
      .catch((reason: unknown) => { if (!cancelled) { setError(reason instanceof Error ? reason.message : "Couldn’t load budgets."); setLoading(false); } });
    return () => { cancelled = true; };
  }, [projectId, reload, requestedProject, currentProjectId]);

  if (pathPolicyId) return <Navigate to={policyPath(projectId ?? "", pathPolicyId)} replace />;
  if (requestedProject && requestedProject.id !== currentProjectId) return <div className="ck-main-inner"><PageHeader title="Budgets" /><Panel><LoadingRows count={4} columns={4} /></Panel></div>;
  if (!projectId) return <div className="ck-main-inner"><PageHeader title="Budgets" /><Panel><EmptyPanel title="Connect a project first" action={<Link className="ck-button ck-button-primary" to="/onboarding">Connect a project</Link>} icon={<Gauge size={20} />} /></Panel></div>;
  const explicitState = prototypeState(searchParams);
  const effectiveRole = prototypeRole(searchParams, user?.role ?? "viewer");
  const effectiveCanEdit = effectiveRole === "owner" || effectiveRole === "admin";
  // The reference keeps budget loading, errors, empty and viewer access in
  // the normal page frame. PrototypeStatePanel is intentionally terminal for
  // other routes, so do not let it replace this route's tabs/table.
  const panelState = ["loading", "error", "restricted", "empty"].includes(explicitState) ? "default" : explicitState;
  const namedState = PrototypeStatePanel({ state: panelState as typeof explicitState, family: "Budgets", title: explicitState === "error" ? "Couldn’t refresh budgets" : undefined, backHref: "/overview", retryHref: `/budgets${window.location.search}`, loadingRows: 4 });
  if (namedState) return namedState;

  const previewPolicies = isPrototypePreview()
    ? policies.map((policy) => policy.id === "search" && tab === "Paused" ? { ...policy, status: "paused" as const } : policy)
    : policies;
  const visiblePolicies = previewEmpty || (isPrototypePreview() && tab === "Archived") ? [] : previewPolicies.filter((policy) => tab === "Archived" ? policy.status === "archived" : tab === "Paused" ? policy.status === "paused" : policy.status === "active");
  const changeTab = (next: PolicyTab): void => setSearchParams((current) => { current.set("tab", next); current.delete("policy"); return current; });
  const archive = async (policy: Policy): Promise<void> => {
    if (!window.confirm(`Archive ${policy.name || "this budget"}? It stops checking new calls. Its history is kept.`)) return;
    const response = await fetch(appUrl(`/api/v1/projects/${projectId}/budget/policies/${encodeURIComponent(policy.id)}`), { method: "DELETE", credentials: "include" });
    if (!response.ok) { setError("Couldn’t archive this budget. Try again."); return; }
    setReload((value) => value + 1);
  };

  const prototypeReadOnly = isPrototypePreview() && explicitState === "restricted";
  const prototypeLoading = isPrototypePreview() && explicitState === "loading";
  const prototypeError = isPrototypePreview() && explicitState === "error";
  const prototypeArchived = isPrototypePreview() && tab === "Archived";
  const prototypeEmpty = isPrototypePreview() && (explicitState === "empty" || prototypeArchived);
  return <div className="ck-main-inner prototype-budgets-route">
    <PageHeader title="Budgets" actions={effectiveCanEdit && !previewRestricted && !prototypeReadOnly && !prototypeLoading && !prototypeError ? <Link className="ck-button ck-button-primary" to={editorPath(projectId)}><Plus size={14} /> Create a budget</Link> : <button className="ck-button ck-button-primary" type="button" disabled title="Only Owners and Admins can create budgets"><Plus size={14} /> Create a budget</button>} />
    <nav className="ck-tabs ck-budget-tabs" aria-label="Budget status">{POLICY_TABS.map((item) => <button className={`ck-tab ${tab === item ? "active" : ""}`} type="button" role="tab" aria-selected={tab === item} key={item} onClick={() => changeTab(item)}>{item}</button>)}</nav>
    {prototypeReadOnly && <div className="ck-alert prototype-budget-inline-notice" role="status"><ShieldCheck size={15} /><div><strong>View only</strong><span>You can see budgets and spend. Ask an Owner or Admin to change them.</span><Link className="ck-finding-link" to="/settings?section=team">See roles</Link></div></div>}
    {prototypeError && <div className="ck-alert ck-alert-error prototype-budget-inline-notice" role="alert"><CircleAlert size={15} /><div><strong>Couldn’t refresh</strong><span>Showing the last budgets we loaded.</span><button className="ck-button ck-button-quiet ck-inline-button" type="button" onClick={() => setReload((value) => value + 1)}>Try again</button></div></div>}
    {!prototypeReadOnly && !prototypeError && !prototypeLoading && <PrototypeStateNotice state={explicitState} family="budgets" role={effectiveRole} onRetry={() => setReload((value) => value + 1)} />}
    {(error || previewError) && <div className="ck-alert ck-alert-error" role="alert"><CircleAlert size={15} /><span>{previewError ?? error}</span></div>}
    <Panel className="ck-budget-table-panel">
      {prototypeEmpty ? <EmptyPanel title={prototypeArchived ? "Nothing archived" : "No budgets here yet"} body={prototypeArchived ? "Archived budgets keep their history." : undefined} action={<Link className="ck-button ck-button-primary" to={prototypeArchived ? "/budgets" : editorPath(projectId)}>{prototypeArchived ? "View active budgets" : "Create a budget"}</Link>} icon={<ShieldCheck size={20} />} /> : prototypeLoading || loading || previewLoading ? <LoadingRows count={4} columns={5} /> : <PolicyTable policies={visiblePolicies} projectId={projectId} canEdit={effectiveCanEdit && !previewRestricted} onArchive={(policy) => void archive(policy)} />}
    </Panel>
  </div>;
}
