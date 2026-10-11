import { ArrowRight, Check } from "lucide-react";
import { Link } from "react-router-dom";
import type { FindingResponse } from "../api";
import { StatusPill } from "./ConsolePrimitives";
import { formatDateTime } from "./consoleFormatters";
import { findingView } from "./findingView";
import { PrototypeIcon } from "./PrototypeIcon";

/**
 * "This run needs a look" from the design language: the comparison, the
 * amounts and the runs behind it. Shared by the finding drawer and page.
 */
export function FindingBody({ finding, projectId, money, canAcknowledge, acknowledging, onAcknowledge, titleId }: {
  finding: FindingResponse;
  projectId: string;
  money: (value: number | null | undefined) => string;
  canAcknowledge: boolean;
  acknowledging: boolean;
  onAcknowledge: () => void;
  titleId?: string;
}) {
  const view = findingView(finding, money);
  const reviewed = finding.state === "acknowledged";
  const scope = finding.scope ?? {};
  const runsParams = new URLSearchParams({ project: projectId });
  for (const key of ["feature", "function", "environment", "model"]) {
    const value = scope[key];
    if (typeof value === "string" && value) runsParams.set(key, value);
  }
  const budgetParams = new URLSearchParams({ project: projectId });
  const scopeKey = ["feature", "function", "model", "customer"].find((key) => typeof scope[key] === "string" && scope[key]);
  if (scopeKey) { budgetParams.set("scopeDimension", scopeKey); budgetParams.set("scopeValue", String(scope[scopeKey])); }
  return (
    <div className="ck-finding-body">
      <div className="ck-finding-kicker"><span className="ck-finding-icon"><PrototypeIcon name="alert" size={20} /></span>{reviewed ? "Reviewed" : "Needs a look"}</div>
      <h1 className="ck-finding-heading" id={titleId}>{view.title}</h1>
      {view.scopeLabels.length > 0 && <div className="ck-pill-row">{view.scopeLabels.map((label) => <StatusPill tone="neutral" icon={false} key={label}>{label}</StatusPill>)}</div>}
      <p className="ck-finding-summary">{view.summary}</p>
      {view.metrics.length > 0 && <div className="ck-finding-values">{view.metrics.map((metric) => <div key={metric.label}><span>{metric.label}</span><strong>{metric.value}</strong>{metric.detail && <small>{metric.detail}</small>}</div>)}</div>}
      {view.facts.length > 0 && <dl className="ck-definition-list ck-finding-facts">{view.facts.map((fact) => <div key={fact.label}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}</dl>}
      <p className="ck-finding-meta">Spotted {formatDateTime(finding.observedAt)}{finding.lastSeenAt && finding.lastSeenAt !== finding.observedAt ? ` · last seen ${formatDateTime(finding.lastSeenAt)}` : ""}. We compare equal periods and only count priced runs. The cause isn’t confirmed.</p>
      <h2 className="ck-finding-section">What to do next</h2>
      <ul className="ck-finding-steps">{view.nextSteps.map((step) => <li key={step}>{step}</li>)}</ul>
      {view.traceIds.length > 0 && <>
        <h2 className="ck-finding-section">Runs behind this</h2>
        <div className="ck-finding-runs">{view.traceIds.slice(0, 5).map((traceId) => <Link key={traceId} className="ck-text-link" to={`/traces/${encodeURIComponent(traceId)}?project=${encodeURIComponent(projectId)}`}><span className="mono">{traceId}</span> <ArrowRight size={12} /></Link>)}{view.traceIds.length > 5 && <span className="muted">and {view.traceIds.length - 5} more</span>}</div>
      </>}
      <div className="ck-finding-actions">
        <Link className="ck-button ck-button-secondary" to={`/traces?${runsParams.toString()}`}>Review these runs <ArrowRight size={14} /></Link>
        <Link className="ck-button ck-button-secondary" to={`/policy-edit?${budgetParams.toString()}`}><PrototypeIcon name="shield" size={16} /> Set a budget</Link>
        {!reviewed && canAcknowledge && <button className="ck-button ck-button-quiet" type="button" onClick={onAcknowledge} disabled={acknowledging}><Check size={14} /> {acknowledging ? "Saving" : "Mark as reviewed"}</button>}
      </div>
      {reviewed && <p className="ck-finding-meta"><Check size={12} aria-hidden="true" /> Marked as reviewed{finding.acknowledgedAt ? ` ${formatDateTime(finding.acknowledgedAt)}` : ""}. Reviewing doesn’t stop any work.</p>}
    </div>
  );
}
