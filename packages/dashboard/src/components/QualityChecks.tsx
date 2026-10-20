import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { X } from "lucide-react";
import type { InsightScope } from "../api";
import {
  backfillQualityCheck,
  createQualityCheck,
  deleteQualityCheck,
  getQualityChecks,
  updateQualityCheck,
  type JudgeProvider,
  type QualityCheckWithStats,
  type QualityChecksResponse,
  type RuleId,
} from "../qualityChecksApi";
import { EmptyPanel, LoadingRows, Panel, StatusLine, StatusPill } from "./ConsolePrimitives";
import {
  PROVIDER_LABELS,
  appliesToLabel,
  applyProvider,
  applyRule,
  applyTemplate,
  emptyForm,
  formFromCheck,
  formToPayload,
  formatAverage,
  formatPassRate,
  formatSampleRate,
  keyPlaceholder,
  kindLabel,
  statusView,
  type CheckForm,
  type FormCatalog,
} from "./qualityChecksModel";
import "./QualityChecks.css";

/** The checks table. Presentational so it renders without a router or data. */
export function ChecksTable({
  checks,
  canManage,
  busyId,
  onEdit,
  onToggle,
  onBackfill,
}: {
  checks: QualityCheckWithStats[];
  canManage: boolean;
  busyId?: string | null;
  onEdit?: (check: QualityCheckWithStats) => void;
  onToggle?: (check: QualityCheckWithStats) => void;
  onBackfill?: (check: QualityCheckWithStats) => void;
}) {
  return <div className="ck-table-wrap"><table className="ck-table qc-table">
    <thead><tr>
      <th>Check</th>
      <th className="hide-mobile">Applies to</th>
      <th className="numeric">Pass rate</th>
      <th className="numeric hide-mobile">Average</th>
      <th className="numeric hide-mobile">Runs scored</th>
      <th>Status</th>
      {canManage && <th className="qc-actions-head"><span className="ck-sort-hidden">Actions</span></th>}
    </tr></thead>
    <tbody>{checks.map((check) => {
      const status = statusView(check);
      const busy = busyId === check.id;
      return <tr key={check.id}>
        <td className="primary-cell">{check.name}<small className="ck-table-sub">{kindLabel(check)}</small></td>
        <td className="hide-mobile">{appliesToLabel(check)}<small className="ck-table-sub">{formatSampleRate(check.sampleRate)}</small></td>
        <td className="numeric">{formatPassRate(check.stats.passRate)}</td>
        <td className="numeric hide-mobile">{formatAverage(check.stats.avg)}</td>
        <td className="numeric hide-mobile">{check.stats.scored.toLocaleString()}{check.stats.queued > 0 && <small className="ck-table-sub">{check.stats.queued.toLocaleString()} queued</small>}</td>
        <td><StatusPill tone={status.tone}>{status.label}</StatusPill>{status.hint && <small className="ck-table-sub qc-hint">{status.hint}</small>}</td>
        {canManage && <td className="qc-actions">
          <button className="ck-button ck-button-quiet" type="button" onClick={() => onEdit?.(check)} disabled={busy}>Edit</button>
          <button className="ck-button ck-button-quiet" type="button" onClick={() => onBackfill?.(check)} disabled={busy || !check.enabled || check.stats.backfilling > 0} title={check.stats.backfilling > 0 ? "Already running on recent runs" : undefined}>Run on recent runs</button>
          <button className="ck-button ck-button-quiet" type="button" onClick={() => onToggle?.(check)} disabled={busy}>{check.enabled ? "Turn off" : "Turn on"}</button>
        </td>}
      </tr>;
    })}</tbody>
  </table></div>;
}

function Field({ label, hint, children, id }: { label: string; hint?: string; children: ReactNode; id: string }) {
  return <div className="ck-form-field">
    <label htmlFor={id}>{label}</label>
    {children}
    {hint && <small className="qc-field-hint">{hint}</small>}
  </div>;
}

function CheckEditor({
  projectId,
  catalog,
  existing,
  textCapture,
  onClose,
  onSaved,
}: {
  projectId: string;
  catalog: FormCatalog;
  existing: QualityCheckWithStats | null;
  textCapture: boolean;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [form, setForm] = useState<CheckForm>(() => existing ? formFromCheck(existing, catalog) : emptyForm("judge", catalog));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const rule = catalog.rules.find((item) => item.id === form.rule);
  const update = (patch: Partial<CheckForm>) => setForm((current) => ({ ...current, ...patch }));

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function save(): Promise<void> {
    const built = formToPayload(form, catalog, existing);
    if ("error" in built) { setError(built.error); return; }
    setSaving(true);
    setError(null);
    try {
      if (existing) await updateQualityCheck(projectId, existing.id, built.payload);
      else await createQualityCheck(projectId, built.payload);
      onSaved(existing ? "Check saved." : "Check created. It runs on runs that finish from now on.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Couldn't save the check.");
      setSaving(false);
    }
  }

  async function remove(): Promise<void> {
    if (!existing) return;
    if (!confirmDelete) { setConfirmDelete(true); return; }
    setSaving(true);
    try {
      await deleteQualityCheck(projectId, existing.id);
      onSaved("Check deleted. Its past scores are kept.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Couldn't delete the check.");
      setSaving(false);
    }
  }

  const unit = rule?.target?.unit;
  return <div className="ck-drawer-overlay" role="presentation" onClick={onClose}>
    <aside className="ck-drawer qc-drawer" role="dialog" aria-modal="true" aria-labelledby="qc-editor-title" onClick={(event) => event.stopPropagation()}>
      <div className="ck-dialog-header">
        <div><h2 id="qc-editor-title">{existing ? "Edit check" : "New check"}</h2><p>Checks run on the server after each run finishes.</p></div>
        <button className="ck-icon-button" type="button" onClick={onClose} aria-label="Close"><X size={16} /></button>
      </div>
      <div className="qc-form">
        {!existing && <div className="ck-segmented qc-kind" role="radiogroup" aria-label="Kind of check">
          {(["judge", "rule"] as const).map((kind) => <button key={kind} type="button" role="radio" aria-checked={form.kind === kind} className={form.kind === kind ? "active" : ""} onClick={() => setForm(emptyForm(kind, catalog))}>{kind === "judge" ? "Rubric" : "Rule"}</button>)}
        </div>}

        {form.kind === "judge" ? <>
          {!textCapture && <StatusLine tone="warn">Rubric checks need prompt capture. Until it is on, this check is skipped.</StatusLine>}
          <Field id="qc-template" label="Start from">
            <select id="qc-template" className="ck-select" value={form.template} onChange={(event) => setForm(applyTemplate(form, event.target.value, catalog))}>
              {catalog.templates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}
              <option value="custom">Custom rubric</option>
            </select>
          </Field>
          <Field id="qc-name" label="Name"><input id="qc-name" className="ck-input" value={form.name} maxLength={120} onChange={(event) => update({ name: event.target.value })} /></Field>
          <Field id="qc-rubric" label="Rubric" hint="The model scores each run from 0 to 1 and writes a short reason. A score of 0.5 or more passes.">
            <textarea id="qc-rubric" className="ck-textarea qc-rubric" rows={9} value={form.rubric} onChange={(event) => update({ rubric: event.target.value })} />
          </Field>
          <div className="qc-row">
            <Field id="qc-provider" label="Provider">
              <select id="qc-provider" className="ck-select" value={form.provider} onChange={(event) => setForm(applyProvider(form, event.target.value as JudgeProvider, catalog))}>
                {catalog.providers.map((provider) => <option key={provider.id} value={provider.id}>{PROVIDER_LABELS[provider.id]}</option>)}
              </select>
            </Field>
            <Field id="qc-model" label="Model"><input id="qc-model" className="ck-input" value={form.model} onChange={(event) => update({ model: event.target.value })} spellCheck={false} /></Field>
          </div>
          <Field id="qc-key" label="API key" hint="Stored encrypted. It can't be shown again. Check calls are billed to this key and show in Costs under the feature quality-checks.">
            <input id="qc-key" className="ck-input" type="password" autoComplete="off" spellCheck={false} placeholder={keyPlaceholder(existing)} value={form.apiKey} onChange={(event) => update({ apiKey: event.target.value, removeKey: false })} />
          </Field>
          {existing?.hasKey && <label className="qc-checkbox"><input type="checkbox" checked={form.removeKey} onChange={(event) => update({ removeKey: event.target.checked, apiKey: "" })} /> Remove the saved key</label>}
        </> : <>
          <Field id="qc-rule" label="Rule" hint={rule?.description}>
            <select id="qc-rule" className="ck-select" value={form.rule} disabled={Boolean(existing)} onChange={(event) => setForm(applyRule(form, event.target.value as RuleId, catalog))}>
              {catalog.rules.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </Field>
          <Field id="qc-name" label="Name"><input id="qc-name" className="ck-input" value={form.name} maxLength={120} onChange={(event) => update({ name: event.target.value })} /></Field>
          {rule?.target && <Field id="qc-target" label={unit === "share" ? `${rule.target.label} (%)` : rule.target.label}>
            <input id="qc-target" className="ck-input" inputMode="decimal" value={form.target} onChange={(event) => update({ target: event.target.value })} />
          </Field>}
        </>}

        <Field id="qc-applies" label="Applies to">
          <select id="qc-applies" className="ck-select" value={form.appliesTo} onChange={(event) => update({ appliesTo: event.target.value as "all" | "named" })}>
            <option value="all">All runs</option>
            <option value="named">Specific agents or workflows</option>
          </select>
        </Field>
        {form.appliesTo === "named" && <Field id="qc-names" label="Agent or workflow names" hint="Separate names with commas.">
          <input id="qc-names" className="ck-input" value={form.names} placeholder="support-agent, research-agent" onChange={(event) => update({ names: event.target.value })} />
        </Field>}
        <Field id="qc-sample" label="Sample rate (%)" hint="Runs are picked by run id, so the same runs are always in the sample.">
          <input id="qc-sample" className="ck-input" inputMode="decimal" value={form.sampleRate} onChange={(event) => update({ sampleRate: event.target.value })} />
        </Field>
        <label className="qc-checkbox"><input type="checkbox" checked={form.enabled} onChange={(event) => update({ enabled: event.target.checked })} /> Check is on</label>

        {error && <div className="ck-form-error" role="alert">{error}</div>}
      </div>
      <div className="ck-form-footer qc-footer">
        {existing && <button className="ck-button ck-button-danger qc-delete" type="button" onClick={() => void remove()} disabled={saving}>{confirmDelete ? "Confirm delete" : "Delete"}</button>}
        <button className="ck-button ck-button-secondary" type="button" onClick={onClose} disabled={saving}>Cancel</button>
        <button className="ck-button ck-button-primary" type="button" onClick={() => void save()} disabled={saving}>{saving ? "Saving" : existing ? "Save" : "Create check"}</button>
      </div>
    </aside>
  </div>;
}

/** The Checks view on the Quality page: list, editor and backfill. */
export function QualityChecksPanel({ projectId, scope, scopeKey }: { projectId: string; scope: InsightScope; scopeKey: string }) {
  const [reload, setReload] = useState(0);
  const [state, setState] = useState<{ key: string; data: QualityChecksResponse | null; error: string | null }>({ key: "", data: null, error: null });
  const [editing, setEditing] = useState<QualityCheckWithStats | "new" | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [flash, setFlash] = useState<{ tone: "good" | "warn" | "critical"; text: string } | null>(null);
  const key = `${scopeKey}|${reload}`;

  useEffect(() => {
    let alive = true;
    getQualityChecks(projectId, scope)
      .then((data) => { if (alive) setState({ key, data, error: null }); })
      .catch((error: unknown) => { if (alive) setState((current) => ({ key, data: current.data, error: error instanceof Error ? error.message : "Couldn't load checks." })); });
    return () => { alive = false; };
    // `scope` is captured by `scopeKey`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, key]);

  const data = state.data;
  const loading = state.key !== key;
  const catalog: FormCatalog | null = data ? { templates: data.templates, rules: data.rules, providers: data.providers } : null;
  const refresh = () => setReload((value) => value + 1);

  async function toggle(check: QualityCheckWithStats): Promise<void> {
    setBusyId(check.id);
    try {
      await updateQualityCheck(projectId, check.id, { enabled: !check.enabled });
      setFlash({ tone: "good", text: check.enabled ? `${check.name} is off.` : `${check.name} is on.` });
      refresh();
    } catch (error) {
      setFlash({ tone: "critical", text: error instanceof Error ? error.message : "Couldn't change the check." });
    } finally {
      setBusyId(null);
    }
  }

  async function backfill(check: QualityCheckWithStats): Promise<void> {
    setBusyId(check.id);
    try {
      const { queued } = await backfillQualityCheck(projectId, check.id);
      setFlash(queued > 0
        ? { tone: "good", text: `Running ${check.name} on ${queued.toLocaleString()} recent run${queued === 1 ? "" : "s"}. Results appear over the next few minutes.` }
        : { tone: "warn", text: `No finished runs in the last 30 days match ${check.name}.` });
      refresh();
    } catch (error) {
      setFlash({ tone: "critical", text: error instanceof Error ? error.message : "Couldn't start the run." });
    } finally {
      setBusyId(null);
    }
  }

  const hasJudges = data?.checks.some((check) => check.kind === "judge") ?? false;
  return <>
    {flash && <StatusLine tone={flash.tone} right={<button className="ck-button ck-button-quiet" type="button" onClick={() => setFlash(null)}>Dismiss</button>}>{flash.text}</StatusLine>}
    {data && !data.textCapture && hasJudges && <StatusLine tone="warn" right={<Link className="ck-button ck-button-quiet" to="/settings?section=data">Open settings</Link>}>This project is metadata only, so rubric checks are skipped. Rule checks still run.</StatusLine>}
    <Panel
      title="Checks"
      subtitle={data ? `Scores each finished run on the server. Results show on the run and in Overview. Run on recent runs scores up to ${data.maxBackfillRuns} runs.` : undefined}
      actions={data?.canManage ? <button className="ck-button ck-button-primary" type="button" onClick={() => setEditing("new")}>New check</button> : undefined}
    >
      {state.error && !data ? <EmptyPanel title="Couldn't load checks" body={state.error} />
        : loading && !data ? <LoadingRows count={4} columns={6} />
          : data && data.checks.length === 0 ? <EmptyPanel
            title="No checks yet"
            body={data.canManage ? "Add a rubric check, or a rule such as Run succeeded. Each finished run gets a score." : "Owners and admins can add checks."}
            action={data.canManage ? <button className="ck-button ck-button-primary" type="button" onClick={() => setEditing("new")}>New check</button> : undefined}
          />
            : data && <ChecksTable checks={data.checks} canManage={data.canManage} busyId={busyId} onEdit={(check) => setEditing(check)} onToggle={(check) => void toggle(check)} onBackfill={(check) => void backfill(check)} />}
    </Panel>
    {editing && catalog && data && <CheckEditor
      projectId={projectId}
      catalog={catalog}
      existing={editing === "new" ? null : editing}
      textCapture={data.textCapture}
      onClose={() => setEditing(null)}
      onSaved={(message) => { setEditing(null); setFlash({ tone: "good", text: message }); refresh(); }}
    />}
  </>;
}
