import { Link } from "react-router-dom";
import { getAgents, getWorkflows } from "../api";
import { listBudgets, type Budget, type BudgetHealth } from "../budgetsApi";
import { useAuth } from "../contexts/useAuth";
import { useLiveQuery } from "../hooks/useLiveQuery";
import { EmptyPanel, LoadingRows, StatusPill } from "./ConsolePrimitives";
import { PrototypeIcon } from "./PrototypeIcon";
import { formatReportedAmount, periodDates, zonedDateParts, zonedDaysInMonth, type ReportingFx } from "./consoleFormatters";
import { actionText, periodLastDay, budgetDetailHref, budgetEditorHref, budgetsFor, formatBudgetAmount, healthView, periodText, usedShare, type BudgetDimension } from "./budgetModel";
import "./Budgets.css";

/** The project's budgets, kept current like the rest of the console. */
export function useProjectBudgets(projectId: string | null): { budgets: Budget[]; loading: boolean; error: string | null } {
  const live = useLiveQuery(projectId ? `budgets|${projectId}` : null, () => listBudgets(projectId!));
  return { budgets: live.data ?? [], loading: live.loading && !live.data, error: live.error };
}

function useCanManageBudgets(): boolean {
  const { user } = useAuth();
  return user?.role === "owner" || user?.role === "admin";
}

/** Used against the limit; the bar turns amber when at risk and red when over. */
export function BudgetProgress({ share, health, label }: { share: number; health: BudgetHealth; label: string }) {
  const percent = Math.min(100, Math.max(0, share * 100));
  const tone = health === "over" ? "critical" : health === "at_risk" ? "warn" : "";
  return <div className={`ck-progress ck-budget-progress ${tone}`} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)}><span style={{ width: `${percent}%` }} /></div>;
}

const NOUN: Partial<Record<BudgetDimension, string>> = { agent: "agent", workflow: "workflow", feature: "feature", model: "model", customer: "customer" };

function lastDayText(budget: Budget, timezone?: string): string | null {
  return periodLastDay(budget.forecast?.periodEnd, budget.timezone ?? timezone);
}

/** A compact budget card for an agent, workflow, feature, model or customer page. */
export function ScopeBudgetCard({ projectId, dimension, name }: { projectId: string | null; dimension: BudgetDimension; name: string }) {
  const { budgets, loading } = useProjectBudgets(projectId);
  const { workspaceSettings, org } = useAuth();
  const canManage = useCanManageBudgets();
  const timezone = workspaceSettings?.timezone ?? org?.timezone ?? undefined;
  if (!projectId || !name) return null;
  if (loading) return <section className="ck-panel ck-scope-budget" aria-busy="true"><div className="ck-skeleton ck-scope-budget-skeleton" /></section>;
  const matches = budgetsFor(budgets, dimension, name);
  const budget = matches[0];
  const noun = NOUN[dimension] ?? "scope";
  if (!budget) {
    return <section className="ck-panel ck-scope-budget ck-scope-budget-empty" aria-label="Budget">
      <span className="ck-scope-budget-title"><PrototypeIcon name="shield" size={16} />Budget</span>
      <p>No budget covers this {noun} yet.</p>
      {canManage ? <Link className="ck-button ck-button-secondary sm" to={budgetEditorHref(projectId, { dimension, name })}>Set budget</Link> : <span className="ck-budget-muted">Owners and Admins can set one.</span>}
    </section>;
  }
  const health = healthView(budget);
  const share = usedShare(budget);
  const lastDay = lastDayText(budget, timezone);
  const calendar = budget.window === "calendar_month" || budget.window === "calendar_day";
  return <section className="ck-panel ck-scope-budget" aria-label="Budget">
    <div className="ck-scope-budget-head">
      <span className="ck-scope-budget-title"><PrototypeIcon name="shield" size={16} /><Link className="ck-table-link" to={budgetDetailHref(projectId, budget.id)}>{budget.name || "Budget"}</Link></span>
      <span className="ck-scope-budget-status"><StatusPill tone={health.tone}>{health.label}</StatusPill>{matches.length > 1 && <Link className="ck-text-link" to="/budgets">{matches.length - 1} more</Link>}</span>
    </div>
    <dl className="ck-scope-budget-facts">
      <div><dt>Limit</dt><dd>{formatBudgetAmount(budget, budget.allowance)}<small>{periodText(budget.window)}</small></dd></div>
      <div className="ck-scope-budget-used"><dt>Used</dt><dd>{calendar || budget.window === "per_call" ? formatBudgetAmount(budget, budget.usage?.observed) : "Each run"}{calendar && share != null && <small>{Math.round(share * 100)}%</small>}</dd>{calendar && share != null && <BudgetProgress share={share} health={health.health} label={`${Math.round(share * 100)} percent of the budget used`} />}</div>
      <div><dt>Forecast</dt><dd>{budget.forecast?.projected == null ? "—" : formatBudgetAmount(budget, budget.forecast.projected)}{lastDay && budget.forecast?.projected != null && <small>by {lastDay}</small>}</dd></div>
      <div><dt>At the limit</dt><dd>{actionText(budget).label}</dd></div>
    </dl>
  </section>;
}

/** A Costs row's budget: status and share used, or a way to set one. */
export function BudgetCell({ budgets, projectId, dimension, name, canManage }: { budgets: Budget[]; projectId: string; dimension: BudgetDimension; name: string; canManage: boolean }) {
  const budget = budgetsFor(budgets, dimension, name)[0];
  if (!budget) return canManage ? <Link className="ck-text-link ck-budget-set-link" to={budgetEditorHref(projectId, { dimension, name })} aria-label={`Set a budget for ${name}`}>Set budget</Link> : <span className="ck-budget-muted">—</span>;
  const health = healthView(budget);
  const share = usedShare(budget);
  return <Link className="ck-budget-cell" to={budgetDetailHref(projectId, budget.id)} title={`${budget.name || "Budget"}: ${formatBudgetAmount(budget, budget.allowance)} ${periodText(budget.window).toLowerCase()}`}>
    <StatusPill tone={health.tone}>{health.label}</StatusPill>
    {share != null && <small>{Math.round(share * 100)}% of {formatBudgetAmount(budget, budget.allowance)}</small>}
  </Link>;
}

/** Every agent or workflow this month with its budget, or a month-end estimate where it has none. */
export function GroupBudgets({ kind, projectId, currency, fx }: { kind: "agent" | "workflow"; projectId: string; currency: string; fx?: ReportingFx | null }) {
  const { workspaceSettings, org } = useAuth();
  const canManage = useCanManageBudgets();
  const timezone = workspaceSettings?.timezone ?? org?.timezone ?? undefined;
  const month = periodDates("mtd", timezone);
  const groups = useLiveQuery(`group-budgets|${kind}|${projectId}|${month.from}`, () => kind === "agent"
    ? getAgents(projectId, month).then((result) => result.agents)
    : getWorkflows(projectId, month).then((result) => result.workflows));
  const { budgets, loading } = useProjectBudgets(projectId);
  if (groups.error && !groups.data) return <EmptyPanel title="Couldn’t load budgets" body={groups.error} />;
  if ((groups.loading && !groups.data) || loading) return <LoadingRows count={4} columns={5} />;
  const rows = groups.data ?? [];
  if (rows.length === 0) return <EmptyPanel title={kind === "agent" ? "No agent runs this month." : "No workflow runs this month."} />;
  const now = new Date();
  const day = zonedDateParts(now, timezone).day;
  const daysInMonth = zonedDaysInMonth(now, timezone);
  const pace = (cost: number | null) => cost == null ? null : cost / Math.max(1, day) * daysInMonth;
  return <div className="ck-table-wrap"><table className="ck-table ck-group-budgets">
    <thead><tr><th>{kind === "agent" ? "Agent" : "Workflow"}</th><th className="numeric">This month</th><th>Budget</th><th className="numeric hide-mobile">Forecast</th><th>Status</th></tr></thead>
    <tbody>{rows.map((group) => {
      const budget = budgetsFor(budgets, kind, group.name)[0];
      const health = budget ? healthView(budget) : null;
      const share = budget ? usedShare(budget) : null;
      return <tr key={group.name}>
        <td className="primary-cell"><Link className="ck-table-link" to={`/${kind === "agent" ? "agents" : "workflows"}/${encodeURIComponent(group.name)}`}>{group.name}</Link></td>
        <td className="numeric">{group.cost == null ? "Unpriced" : formatReportedAmount(group.cost, currency, fx)}</td>
        <td>{budget
          ? <Link className="ck-budget-cell" to={budgetDetailHref(projectId, budget.id)}><span>{formatBudgetAmount(budget, budget.allowance)} <small>{periodText(budget.window).toLowerCase()}</small></span>{share != null && health && <BudgetProgress share={share} health={health.health} label={`${group.name}: ${Math.round(share * 100)} percent of the budget used`} />}</Link>
          : canManage ? <Link className="ck-text-link" to={budgetEditorHref(projectId, { dimension: kind, name: group.name })} aria-label={`Set a budget for ${group.name}`}>Set budget</Link> : <span className="ck-budget-muted">None</span>}</td>
        <td className="numeric hide-mobile">{budget ? (budget.forecast?.projected == null ? "—" : formatBudgetAmount(budget, budget.forecast.projected)) : formatReportedAmount(pace(group.cost), currency, fx)}{!budget && <small className="ck-table-sub">At this pace</small>}</td>
        <td>{health ? <StatusPill tone={health.tone}>{health.label}</StatusPill> : <span className="ck-budget-muted">No budget</span>}</td>
      </tr>;
    })}</tbody>
  </table></div>;
}
