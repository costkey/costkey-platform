import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Download, FlaskConical, Plus, Trash2 } from "lucide-react";
import { useAuth } from "../contexts/useAuth";
import { EmptyPanel, LoadingRows, MetricCard, PageHeader, Panel } from "../components/ConsolePrimitives";
import { formatReportedAmount, type ReportingFx } from "../components/consoleFormatters";
import { EvalRunDetail, EvalRunsPanel, LabelPill, PassBar, RunEvalPanel, Screenshot } from "../components/DatasetEvals";
import { useEvalRuns } from "../components/useEvalRuns";
import { configurationPairs, costChange, labelEntries, labelTone, passShare, percent, shareTone, timeAgo } from "../components/datasetView";
import { actionFrom, actionTitle } from "../components/replayModel";
import { useInsightScope } from "./useInsightScope";
import {
  createDataset,
  datasetExportUrl,
  deleteDataset,
  getDataset,
  listDatasets,
  removeDatasetItem,
  updateDatasetItem,
  type Dataset,
  type DatasetItem,
} from "../datasetsApi";
import "./Datasets.css";

/** Labelled calls kept as cases for evals. */
export default function Datasets() {
  const { datasetId, executionId } = useParams();
  const { currentProjectId, projects, user } = useAuth();
  const { currency, fx } = useInsightScope();
  const projectId = currentProjectId ?? projects[0]?.id ?? null;
  if (!projectId) {
    return <div className="ck-main-inner"><PageHeader title="Datasets" /><Panel><EmptyPanel illustration="first-light" title="Connect a project first" body="Datasets are built from the calls a project records." action={<Link className="ck-button ck-button-primary" to="/onboarding">Connect a project</Link>} /></Panel></div>;
  }
  if (user?.role === "viewer") {
    return <div className="ck-main-inner"><PageHeader title="Datasets" /><Panel><EmptyPanel title="Datasets hold captured prompts and screenshots" body="Viewers can't open them. Ask an admin for Developer access." /></Panel></div>;
  }
  if (datasetId && executionId) return <EvalRunDetail projectId={projectId} datasetId={datasetId} executionId={executionId} currency={currency} fx={fx} />;
  return datasetId ? <DatasetDetail projectId={projectId} datasetId={datasetId} currency={currency} fx={fx} /> : <DatasetList projectId={projectId} />;
}

/** A stacked bar of how a dataset's calls are labelled. */
function LabelBar({ labels }: { labels: Record<string, number> }) {
  const entries = labelEntries(labels);
  const total = entries.reduce((sum, entry) => sum + entry.count, 0);
  if (total === 0) return <span className="ck-ds-muted">No labels</span>;
  return <div className="ck-ds-labelbar">
    <div className="ck-ds-labelbar-track" aria-hidden="true">{entries.map((entry) => <i key={entry.label} className={`is-${entry.tone}`} style={{ flexGrow: entry.count }} />)}</div>
    <div className="ck-ds-labelbar-keys">{entries.slice(0, 3).map((entry) => <LabelPill key={entry.label} label={entry.label} count={entry.count} />)}{entries.length > 3 && <span className="ck-ds-muted">+{entries.length - 3}</span>}</div>
  </div>;
}

function Covers({ projectId, covers }: { projectId: string; covers: string[] }) {
  if (covers.length === 0) return <span className="ck-ds-cover is-empty" aria-hidden="true"><FlaskConical size={16} /></span>;
  return <span className="ck-ds-covers" aria-hidden="true">{covers.slice(0, 3).map((sha) => <Screenshot key={sha} projectId={projectId} sha256={sha} className="ck-ds-cover" />)}</span>;
}

function NewDatasetForm({ projectId, onCancel }: { projectId: string; onCancel: () => void }) {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const { dataset } = await createDataset(projectId, { name: name.trim(), ...(description.trim() ? { description: description.trim() } : {}) });
      navigate(`/datasets/${dataset.id}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The dataset couldn't be created");
      setSaving(false);
    }
  }
  return <Panel title="New dataset" subtitle="Add calls to it from any run: open a call or a replay step and choose Add to dataset.">
    <form className="ck-ds-form" onSubmit={(event) => void submit(event)}>
      <label><span>Name</span><input autoFocus value={name} maxLength={80} placeholder="Checkout clicks" onChange={(event) => setName(event.target.value)} /></label>
      <label className="is-wide"><span>Description <em>optional</em></span><input value={description} maxLength={300} placeholder="What these calls test" onChange={(event) => setDescription(event.target.value)} /></label>
      <div className="ck-ds-form-actions">
        <button className="ck-button ck-button-primary" type="submit" disabled={!name.trim() || saving}>{saving ? "Creating…" : "Create dataset"}</button>
        <button className="ck-button ck-button-quiet" type="button" onClick={onCancel}>Cancel</button>
      </div>
      {error && <p className="ck-ds-error" role="alert">{error}</p>}
    </form>
  </Panel>;
}

/** What a dataset is for, in three steps: shown until the first one exists. */
function DatasetsIntro() {
  return <Panel>
    <EmptyPanel
      illustration="room-to-explore"
      title="Build your first dataset"
      body="Label the calls your agent got right or wrong, then replay them against another model or prompt to see whether it does better and what it costs."
      action={<Link className="ck-button ck-button-primary" to="/traces">Open runs</Link>}
    />
    <ol className="ck-ds-steps">
      <li><b>Label calls</b><span>In any run, pick a call or a replay step and choose <em>Add to dataset</em>. Mark it Good or Bad.</span></li>
      <li><b>Run an eval</b><span>Replay every call with another model or prompt, in your own environment and with your own keys.</span></li>
      <li><b>Compare</b><span>See the pass rate and the cost next to the original calls, case by case.</span></li>
    </ol>
  </Panel>;
}

function DatasetList({ projectId }: { projectId: string }) {
  const navigate = useNavigate();
  const [state, setState] = useState<{ datasets: Dataset[] | null; error: string | null }>({ datasets: null, error: null });
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    let cancelled = false;
    listDatasets(projectId)
      .then((result) => { if (!cancelled) setState({ datasets: result.datasets, error: null }); })
      .catch((reason: unknown) => { if (!cancelled) setState({ datasets: [], error: reason instanceof Error ? reason.message : "Datasets couldn't be loaded" }); });
    return () => { cancelled = true; };
  }, [projectId]);

  const datasets = state.datasets;
  const totals = useMemo(() => {
    const list = datasets ?? [];
    const labels: Record<string, number> = {};
    for (const dataset of list) for (const [label, count] of Object.entries(dataset.labels)) labels[label] = (labels[label] ?? 0) + Number(count);
    const latest = list
      .filter((dataset) => dataset.lastEval?.startedAt)
      .sort((a, b) => String(b.lastEval!.startedAt).localeCompare(String(a.lastEval!.startedAt)))[0];
    return {
      calls: list.reduce((sum, dataset) => sum + dataset.itemCount, 0),
      labels,
      evalRuns: list.reduce((sum, dataset) => sum + (dataset.evalRuns ?? 0), 0),
      latest,
    };
  }, [datasets]);
  const goodBad = labelEntries(totals.labels).filter((entry) => entry.tone !== "neutral").map((entry) => `${entry.count.toLocaleString()} ${entry.label.toLowerCase()}`).join(" · ");
  const latestShare = totals.latest?.lastEval ? passShare(totals.latest.lastEval.passed, totals.latest.lastEval.failed) : null;

  return <div className="ck-main-inner ck-ds-page">
    <PageHeader
      title="Datasets"
      description="Calls you labelled from runs. Replay them against another model or prompt and compare the pass rate and cost."
      actions={!creating && <button className="ck-button ck-button-primary" type="button" onClick={() => setCreating(true)}><Plus size={14} aria-hidden="true" /> New dataset</button>}
    />
    {creating && <NewDatasetForm projectId={projectId} onCancel={() => setCreating(false)} />}
    {datasets === null
      ? <><div className="ck-metric-grid ck-metric-grid-4">{["Datasets", "Labelled calls", "Eval runs", "Latest pass rate"].map((label) => <MetricCard key={label} label={label} value="" loading />)}</div><Panel><LoadingRows count={3} columns={5} /></Panel></>
      : state.error
        ? <Panel><EmptyPanel title="Datasets couldn't be loaded" body={state.error} /></Panel>
        : datasets.length === 0
          ? (!creating && <DatasetsIntro />)
          : <>
            <div className="ck-metric-grid ck-metric-grid-4">
              <MetricCard icon="flask" label="Datasets" value={datasets.length.toLocaleString()} detail={`Updated ${timeAgo(datasets[0]!.updatedAt)}`} />
              <MetricCard icon="check" label="Labelled calls" value={totals.calls.toLocaleString()} detail={goodBad || undefined} />
              <MetricCard icon="activity" label="Eval runs" value={totals.evalRuns.toLocaleString()} detail={totals.latest?.lastEval?.startedAt ? `Last one ${timeAgo(totals.latest.lastEval.startedAt)}` : "None yet"} />
              <MetricCard icon="quality" label="Latest pass rate" value={percent(latestShare)} tone={shareTone(latestShare)} detail={totals.latest ? totals.latest.name : undefined} />
            </div>
            <Panel title="All datasets" subtitle="Select one to see its calls and run an eval.">
              <div className="ck-table-wrap"><table className="ck-table ck-ds-table">
                <thead><tr><th>Dataset</th><th className="numeric">Calls</th><th>Labels</th><th>Last eval</th><th className="numeric">Updated</th></tr></thead>
                <tbody>{datasets.map((dataset) => {
                  const last = dataset.lastEval;
                  const share = last ? passShare(last.passed, last.failed) : null;
                  const config = configurationPairs(last?.configuration, 1)[0];
                  return <tr key={dataset.id} className="ck-row-link" onClick={() => navigate(`/datasets/${dataset.id}`)}>
                    <td className="primary-cell"><div className="ck-ds-name-cell">
                      <Covers projectId={projectId} covers={dataset.covers ?? []} />
                      <div className="min-w-0"><Link className="ck-table-link ck-stretch-link" to={`/datasets/${dataset.id}`} onClick={(event) => event.stopPropagation()}>{dataset.name}</Link>{dataset.description && <div className="ck-ds-muted ck-ds-clamp">{dataset.description}</div>}</div>
                    </div></td>
                    <td className="numeric">{dataset.itemCount.toLocaleString()}</td>
                    <td><LabelBar labels={dataset.labels} /></td>
                    <td>{last ? <div className="ck-ds-last">
                      <PassBar passed={last.passed} failed={last.failed} />
                      <span className="ck-ds-muted">{[config ? config.value : null, last.startedAt ? timeAgo(last.startedAt) : null].filter(Boolean).join(" · ") || (share == null ? "Unscored" : "")}</span>
                    </div> : <span className="ck-ds-muted">Not run yet</span>}</td>
                    <td className="numeric ck-ds-muted">{timeAgo(dataset.updatedAt)}</td>
                  </tr>;
                })}</tbody>
              </table></div>
            </Panel>
          </>}
  </div>;
}

/** Good / Bad, or the call's own label, changed in place. */
function LabelSwitch({ value, onChange }: { value: string; onChange: (label: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const tone = labelTone(value);
  if (editing) {
    return <form className="ck-ds-label-edit" onSubmit={(event) => { event.preventDefault(); setEditing(false); if (draft.trim()) onChange(draft.trim()); }}>
      <input autoFocus aria-label="Label" value={draft} maxLength={60} onChange={(event) => setDraft(event.target.value)} onBlur={() => { setEditing(false); if (draft.trim() && draft.trim() !== value) onChange(draft.trim()); }} />
    </form>;
  }
  return <div className="ck-ds-switch" role="group" aria-label="Label">
    <button type="button" className={tone === "good" ? "is-on is-good" : ""} aria-pressed={tone === "good"} onClick={() => tone !== "good" && onChange("Good")}>Good</button>
    <button type="button" className={tone === "critical" ? "is-on is-bad" : ""} aria-pressed={tone === "critical"} onClick={() => tone !== "critical" && onChange("Bad")}>Bad</button>
    <button type="button" className={tone === "neutral" ? "is-on" : ""} aria-pressed={tone === "neutral"} title="Use your own label" onClick={() => { setDraft(tone === "neutral" ? value : ""); setEditing(true); }}>{tone === "neutral" ? value : "Other"}</button>
  </div>;
}

function ItemCard({ projectId, item, onRelabel, onRemove }: { projectId: string; item: DatasetItem; onRelabel: (label: string) => void; onRemove: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const action = actionFrom(item.output);
  useEffect(() => {
    if (!confirming) return;
    const timer = window.setTimeout(() => setConfirming(false), 3000);
    return () => window.clearTimeout(timer);
  }, [confirming]);
  return <article className={`ck-ds-card is-${labelTone(item.label)}`}>
    <Screenshot projectId={projectId} sha256={item.frameSha256} markers={action?.x != null && action.y != null ? [{ x: action.x, y: action.y, kind: "original" }] : []} className="ck-ds-card-shot" />
    <div className="ck-ds-card-body">
      <div className="ck-ds-card-top">
        <LabelSwitch value={item.label} onChange={onRelabel} />
        <button className={`ck-button ck-button-quiet ck-ds-remove${confirming ? " is-confirming" : ""}`} type="button" aria-label={confirming ? "Click again to remove from the dataset" : "Remove from dataset"} onClick={() => (confirming ? onRemove() : setConfirming(true))}>
          <Trash2 size={13} aria-hidden="true" />{confirming && "Remove"}
        </button>
      </div>
      <p className="ck-ds-action">{action ? <>{actionTitle(action.label)}{action.x != null && action.y != null ? <span className="ck-ds-muted"> at {Math.round(action.x)}, {Math.round(action.y)}</span> : null}{action.text ? <span className="ck-ds-muted"> “{action.text}”</span> : null}</> : <span className="ck-ds-muted">No screen action in the response</span>}</p>
      {item.note && <p className="ck-ds-note">{item.note}</p>}
      {!item.hasInput && <p className="ck-ds-warn">The prompt wasn't captured, so an eval can't replay this call.</p>}
      <div className="ck-ds-card-meta">
        <span title={item.model ?? undefined}>{item.model ?? "Unknown model"}</span>
        {item.traceId && <Link className="ck-inline-link" to={`/traces/${encodeURIComponent(item.traceId)}?call=${encodeURIComponent(item.sourceEventId)}`}>Open call</Link>}
      </div>
    </div>
  </article>;
}

function DatasetDetail({ projectId, datasetId, currency, fx }: { projectId: string; datasetId: string; currency: string; fx?: ReportingFx | null }) {
  const navigate = useNavigate();
  const [showEval, setShowEval] = useState(false);
  const [filter, setFilter] = useState<string>("all");
  const [state, setState] = useState<{ dataset: Dataset | null; items: DatasetItem[]; error: string | null; loading: boolean }>({ dataset: null, items: [], error: null, loading: true });
  const runs = useEvalRuns(projectId, datasetId);
  const load = useCallback(() => getDataset(projectId, datasetId)
    .then((result) => setState({ dataset: result.dataset, items: result.items, error: null, loading: false }))
    .catch((reason: unknown) => setState({ dataset: null, items: [], error: reason instanceof Error ? reason.message : "The dataset couldn't be loaded", loading: false })), [projectId, datasetId]);
  useEffect(() => { void load(); }, [load]);

  async function relabel(item: DatasetItem, label: string): Promise<void> {
    if (!label.trim() || label === item.label) return;
    setState((current) => ({ ...current, items: current.items.map((entry) => (entry.id === item.id ? { ...entry, label } : entry)) }));
    await updateDatasetItem(projectId, datasetId, item.id, { label: label.trim() }).catch(() => undefined);
    await load();
  }
  async function remove(item: DatasetItem): Promise<void> {
    setState((current) => ({ ...current, items: current.items.filter((entry) => entry.id !== item.id) }));
    await removeDatasetItem(projectId, datasetId, item.id).catch(() => undefined);
    await load();
  }
  async function removeDataset(): Promise<void> {
    if (!state.dataset || !window.confirm(`Delete "${state.dataset.name}" and its ${state.dataset.itemCount} labelled calls? Eval runs stay in Traces. This can't be undone.`)) return;
    await deleteDataset(projectId, datasetId);
    navigate("/datasets");
  }

  const dataset = state.dataset;
  const labelCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const item of state.items) counts[item.label] = (counts[item.label] ?? 0) + 1;
    return labelEntries(counts);
  }, [state.items]);
  const shown = filter === "all" ? state.items : state.items.filter((item) => item.label === filter);
  const latest = runs.runs?.[0] ?? null;
  const latestShare = latest ? passShare(latest.passed, latest.failed) : null;
  const change = latest ? costChange(latest.cost, latest.originalCost) : null;
  const money = (value: number | null | undefined) => (value == null ? "—" : formatReportedAmount(value, currency, fx));
  const latestModel = latest ? configurationPairs(latest.configuration, 1)[0]?.value : undefined;

  if (state.error) {
    return <div className="ck-main-inner"><Link className="ck-back-link" to="/datasets"><ArrowLeft size={13} /> Datasets</Link><PageHeader title="Dataset" /><Panel><EmptyPanel title="This dataset couldn't be loaded" body={state.error} /></Panel></div>;
  }
  return <div className="ck-main-inner ck-ds-page">
    <Link className="ck-back-link" to="/datasets"><ArrowLeft size={13} /> Datasets</Link>
    <PageHeader
      title={dataset?.name ?? "Dataset"}
      description={dataset?.description ?? undefined}
      actions={dataset && <>
        <button className="ck-button ck-button-primary" type="button" aria-expanded={showEval} onClick={() => setShowEval((value) => !value)}><FlaskConical size={14} aria-hidden="true" /> Run eval</button>
        <a className="ck-button ck-button-secondary" href={datasetExportUrl(projectId, datasetId)} download><Download size={14} aria-hidden="true" /> Export</a>
        <button className="ck-button ck-button-quiet ck-ds-danger" type="button" onClick={() => void removeDataset()}><Trash2 size={14} aria-hidden="true" /> Delete</button>
      </>}
    />
    {showEval && dataset && <RunEvalPanel datasetName={dataset.name} onClose={() => setShowEval(false)} />}
    <div className="ck-metric-grid ck-metric-grid-4">
      <MetricCard icon="flask" label="Labelled calls" value={dataset ? dataset.itemCount.toLocaleString() : ""} loading={state.loading} detail={labelCounts.slice(0, 3).map((entry) => `${entry.count} ${entry.label.toLowerCase()}`).join(" · ") || undefined} />
      <MetricCard icon="activity" label="Eval runs" value={runs.runs ? runs.runs.length.toLocaleString() : ""} loading={runs.runs === null} detail={latest?.startedAt ? `Last one ${timeAgo(latest.startedAt)}` : "None yet"} />
      <MetricCard icon="quality" label="Latest pass rate" value={percent(latestShare)} tone={shareTone(latestShare)} loading={runs.runs === null} detail={latest ? [`${latest.passed} of ${latest.passed + latest.failed} passed`, latestModel].filter(Boolean).join(" · ") : undefined} />
      <MetricCard icon="cost" label="Latest eval cost" value={money(latest?.cost)} loading={runs.runs === null} detail={latest ? <>{change && <span className={`ck-ds-change is-${change.tone}`}>{change.text}</span>} than the original {money(latest.originalCost)}</> : undefined} />
    </div>
    <Panel
      title="Labelled calls"
      subtitle="When you run an eval, each one is replayed with its prompt and screenshot."
      actions={labelCounts.length > 1 && <div className="ck-ds-filter" role="group" aria-label="Show">
        <button type="button" aria-pressed={filter === "all"} className={filter === "all" ? "is-on" : ""} onClick={() => setFilter("all")}>All <span>{state.items.length}</span></button>
        {labelCounts.map((entry) => <button key={entry.label} type="button" aria-pressed={filter === entry.label} className={filter === entry.label ? "is-on" : ""} onClick={() => setFilter(entry.label)}>{entry.label} <span>{entry.count}</span></button>)}
      </div>}
    >
      {state.loading ? <LoadingRows count={3} columns={4} />
        : state.items.length === 0 ? <EmptyPanel title="No calls in this dataset yet" body="Open a run, pick a call or a replay step and choose Add to dataset." action={<Link className="ck-button ck-button-secondary" to="/traces">Open runs</Link>} />
          : <div className="ck-ds-grid">{shown.map((item) => <ItemCard key={item.id} projectId={projectId} item={item} onRelabel={(label) => void relabel(item, label)} onRemove={() => void remove(item)} />)}</div>}
    </Panel>
    {dataset && <EvalRunsPanel datasetId={datasetId} runs={runs.runs} error={runs.error} currency={currency} fx={fx} onRunEval={() => setShowEval(true)} />}
  </div>;
}
