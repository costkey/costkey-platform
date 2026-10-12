import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CircleAlert, Plus } from "lucide-react";
import { Link, Navigate, useParams, useSearchParams } from "react-router-dom";
import { deleteBudget, listBudgets, type Budget } from "../budgetsApi";
import { useAuth } from "../contexts/useAuth";
import { useLiveQuery } from "../hooks/useLiveQuery";
import { EmptyPanel, LoadingRows, PageHeader, Panel, StatusLine, StatusPill } from "../components/ConsolePrimitives";
import { LiveStatus } from "../components/LiveStatus";
import { actionText, periodLastDay, budgetDetailHref, budgetEditorHref, coversText, formatBudgetAmount, healthCounts, healthView, periodText, sortBudgets, usedShare } from "../components/budgetModel";
import { BudgetProgress } from "../components/ScopeBudget";
import "../components/Budgets.css";

function usedCell(budget: Budget): { label: string; value: string } {
  if (budget.window === "per_call") return { label: "Largest call, last 24 hours", value: formatBudgetAmount(budget, budget.usage?.observed) };
  if (budget.window === "per_trace" || budget.window === "per_execution") return { label: "", value: "Counted each run" };
  return { label: "", value: formatBudgetAmount(budget, budget.usage?.observed) };
}

function ForecastCell({ budget, timezone }: { budget: Budget; timezone?: string }) {
  const projected = budget.forecast?.projected;
  const end = budget.forecast?.periodEnd;
  if (projected == null || !end) return <span className="ck-budget-muted">—</span>;
  // A period is a calendar month or day in the budget's own time zone.
  const lastDay = periodLastDay(end, budget.timezone ?? timezone);
  return <><span className="ck-budget-figure">{formatBudgetAmount(budget, projected)}</span><span className="ck-budget-sub">by {lastDay}</span></>;
}

function DeleteDialog({ budget, onCancel, onConfirm, busy, error }: { budget: Budget; onCancel: () => void; onConfirm: () => void; busy: boolean; error: string | null }) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const onCancelRef = useRef(onCancel);
  useEffect(() => { onCancelRef.current = onCancel; });
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelRef.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onCancelRef.current(); };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); opener?.focus(); };
  }, []);
  // On the body, so no page container can clip the backdrop.
  return createPortal(<div className="ck-dialog-backdrop" role="presentation" onClick={onCancel}>
    <section className="ck-dialog ck-budget-dialog" role="alertdialog" aria-modal="true" aria-labelledby="budget-delete-title" aria-describedby="budget-delete-copy" onClick={(event) => event.stopPropagation()}>
      <h2 id="budget-delete-title">Delete {budget.name || "this budget"}?</h2>
      <p id="budget-delete-copy">It stops checking calls right away. Spend history is kept.</p>
      {error && <p className="ck-form-error" role="alert">{error}</p>}
      <div className="ck-dialog-footer">
        <button ref={cancelRef} className="ck-button ck-button-secondary" type="button" onClick={onCancel} disabled={busy}>Cancel</button>
        <button className="ck-button ck-button-danger" type="button" onClick={onConfirm} disabled={busy}>{busy ? "Deleting" : "Delete budget"}</button>
      </div>
    </section>
  </div>, document.body);
}

function BudgetTable({ budgets, projectId, canManage, timezone, onDelete }: { budgets: Budget[]; projectId: string; canManage: boolean; timezone?: string; onDelete: (budget: Budget) => void }) {
  return <div className="ck-table-wrap"><table className="ck-table ck-budgets-table">
    <thead><tr>
      <th>Budget</th>
      <th className="numeric">Limit</th>
      <th>Used</th>
      <th className="numeric">Forecast</th>
      <th>Status</th>
      <th>At the limit</th>
      <th><span className="sr-only">Actions</span></th>
    </tr></thead>
    <tbody>{budgets.map((budget) => {
      const covers = coversText(budget);
      const health = healthView(budget);
      const action = actionText(budget);
      const used = usedCell(budget);
      const share = usedShare(budget);
      const calendar = budget.window === "calendar_month" || budget.window === "calendar_day" || budget.window === "calendar_minute";
      return <tr key={budget.id}>
        <td className="ck-budget-name-cell">
          <Link className="ck-table-link primary-cell" to={budgetDetailHref(projectId, budget.id)}>{budget.name || "Unnamed budget"}</Link>
          <span className="ck-budget-sub"><span className="ck-budget-kind">{covers.kind}</span>{covers.value && <> · <span title={covers.value}>{covers.value}</span></>}</span>
        </td>
        <td className="numeric" data-label="Limit"><span className="ck-budget-figure">{formatBudgetAmount(budget, budget.allowance)}</span><span className="ck-budget-sub">{periodText(budget.window)}</span></td>
        <td className="ck-budget-used-cell" data-label="Used">
          <span className="ck-budget-used-line"><span className="ck-budget-figure">{used.value}</span>{calendar && share != null && <span className="ck-budget-sub">{Math.round(share * 100)}%</span>}</span>
          {calendar && share != null && <BudgetProgress share={share} health={health.health} label={`${budget.name || "Budget"}: ${Math.round(share * 100)} percent used`} />}
          {used.label && <span className="ck-budget-sub">{used.label}</span>}
        </td>
        <td className="numeric" data-label="Forecast"><ForecastCell budget={budget} timezone={timezone} /></td>
        <td data-label="Status"><StatusPill tone={health.tone}>{health.label}</StatusPill></td>
        <td data-label="At the limit"><span className="ck-budget-action">{budget.mode === "enforce" ? <StatusPill tone="critical" icon="pause">{action.label}</StatusPill> : <StatusPill tone="neutral" icon="bell">{action.label}</StatusPill>}</span></td>
        <td className="ck-budget-actions-cell">
          <span className="ck-budget-row-actions">
            <Link className="ck-button ck-button-quiet sm" to={budgetDetailHref(projectId, budget.id)} aria-label={`View ${budget.name || "budget"}`}>View</Link>
            {canManage && <Link className="ck-button ck-button-quiet sm" to={budgetEditorHref(projectId, { id: budget.id })} aria-label={`Edit ${budget.name || "budget"}`}>Edit</Link>}
            {canManage && <button className="ck-button ck-button-quiet sm ck-budget-delete" type="button" onClick={() => onDelete(budget)} aria-label={`Delete ${budget.name || "budget"}`}>Delete</button>}
          </span>
        </td>
      </tr>;
    })}</tbody>
  </table></div>;
}

function glance(budgets: Budget[]): { tone: "good" | "warn" | "critical"; text: string } | null {
  if (budgets.length === 0) return null;
  const counts = healthCounts(budgets);
  const plural = (count: number) => count === 1 ? "budget is" : "budgets are";
  if (counts.over > 0) return { tone: "critical", text: `${counts.over} ${plural(counts.over)} over the limit${counts.at_risk > 0 ? `, ${counts.at_risk} more at risk` : ""}.` };
  if (counts.at_risk > 0) return { tone: "warn", text: `${counts.at_risk} ${plural(counts.at_risk)} at risk of going over this period.` };
  return { tone: "good", text: "Every budget is on track." };
}

export default function Budgets() {
  const { currentProjectId, projects, user, workspaceSettings, org, setCurrentProjectId } = useAuth();
  const { policyId: pathPolicyId } = useParams();
  const [searchParams] = useSearchParams();
  const requestedProjectId = searchParams.get("project");
  const requestedProject = requestedProjectId ? projects.find((project) => project.id === requestedProjectId) : undefined;
  const projectId = currentProjectId ?? projects[0]?.id ?? null;
  const switching = Boolean(requestedProject && requestedProject.id !== currentProjectId);
  const timezone = workspaceSettings?.timezone ?? org?.timezone ?? undefined;
  const canManage = user?.role === "owner" || user?.role === "admin";
  const [pendingDelete, setPendingDelete] = useState<Budget | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    if (switching && requestedProject) setCurrentProjectId(requestedProject.id);
  }, [switching, requestedProject, setCurrentProjectId]);

  const live = useLiveQuery(projectId && !switching ? `budgets|${projectId}` : null, () => listBudgets(projectId!));

  if (pathPolicyId) return <Navigate to={budgetDetailHref(projectId ?? "", pathPolicyId)} replace />;
  if (!projectId) return <div className="ck-main-inner"><PageHeader title="Budgets" /><Panel><EmptyPanel title="Connect a project to set budgets." action={<Link className="ck-button ck-button-primary" to="/onboarding">Connect a project</Link>} /></Panel></div>;

  const budgets = sortBudgets((live.data ?? []).filter((budget) => !removed.has(budget.id)));
  const summary = glance(budgets);
  const newButton = canManage ? <Link className="ck-button ck-button-primary" to={budgetEditorHref(projectId)}><Plus size={14} aria-hidden="true" /> New budget</Link> : null;

  const confirmDelete = async (): Promise<void> => {
    if (!pendingDelete) return;
    setDeleting(true); setDeleteError(null);
    try {
      await deleteBudget(projectId, pendingDelete.id);
      setRemoved((current) => new Set([...current, pendingDelete.id]));
      setPendingDelete(null);
      live.refresh();
    } catch (reason) {
      setDeleteError(reason instanceof Error ? reason.message : "Couldn’t delete this budget. Try again.");
    } finally {
      setDeleting(false);
    }
  };

  return <div className="ck-main-inner ck-budgets-page">
    <PageHeader title="Budgets" description={canManage ? undefined : "View only. Owners and Admins can change budgets."} actions={<><LiveStatus status={live.status} updatedAt={live.updatedAt} onRefresh={live.refresh} />{budgets.length > 0 && newButton}</>} />
    {live.error && <div className="ck-alert ck-alert-error" role="alert"><CircleAlert size={15} aria-hidden="true" /><span>Couldn’t refresh budgets. <button className="ck-button ck-button-quiet ck-inline-button" type="button" onClick={live.refresh}>Try again</button></span></div>}
    {summary && <StatusLine tone={summary.tone}>{summary.text}</StatusLine>}
    <Panel className="ck-budgets-panel">
      {live.loading && !live.data ? <LoadingRows count={4} columns={6} />
        : budgets.length === 0 ? <EmptyPanel title="No budgets yet. Set one to see spend against a limit." action={newButton ?? undefined} />
          : <BudgetTable budgets={budgets} projectId={projectId} canManage={canManage} timezone={timezone} onDelete={(budget) => { setDeleteError(null); setPendingDelete(budget); }} />}
    </Panel>
    {pendingDelete && <DeleteDialog budget={pendingDelete} busy={deleting} error={deleteError} onCancel={() => { if (!deleting) setPendingDelete(null); }} onConfirm={() => void confirmDelete()} />}
  </div>;
}
