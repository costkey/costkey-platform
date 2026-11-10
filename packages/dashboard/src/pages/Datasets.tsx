import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Download, Trash2 } from "lucide-react";
import { useAuth } from "../contexts/useAuth";
import { EmptyPanel, LoadingRows, PageHeader, Panel } from "../components/ConsolePrimitives";
import { formatAbsoluteDate } from "../components/consoleFormatters";
import { frameUrl } from "../api";
import {
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
  const { datasetId } = useParams();
  const { currentProjectId, projects, user } = useAuth();
  const projectId = currentProjectId ?? projects[0]?.id ?? null;
  if (!projectId) return <EmptyPanel title="No project yet" />;
  if (user?.role === "viewer") {
    return <><PageHeader title="Datasets" /><EmptyPanel title="Datasets hold captured content" body="Ask an admin for Developer access to open them." /></>;
  }
  return datasetId ? <DatasetDetail projectId={projectId} datasetId={datasetId} /> : <DatasetList projectId={projectId} />;
}

function LabelCounts({ labels }: { labels: Record<string, number> }) {
  const entries = Object.entries(labels).sort((a, b) => b[1] - a[1]);
  return <span className="ck-ds-labels">{entries.map(([label, count]) => <span key={label} className={`ck-ds-label${/^bad$/i.test(label) ? " is-bad" : /^good$/i.test(label) ? " is-good" : ""}`}>{label} {count.toLocaleString()}</span>)}</span>;
}

function DatasetList({ projectId }: { projectId: string }) {
  const [state, setState] = useState<{ datasets: Dataset[] | null; error: string | null }>({ datasets: null, error: null });
  useEffect(() => {
    let cancelled = false;
    listDatasets(projectId)
      .then((result) => { if (!cancelled) setState({ datasets: result.datasets, error: null }); })
      .catch((reason: unknown) => { if (!cancelled) setState({ datasets: [], error: reason instanceof Error ? reason.message : "Datasets couldn't be loaded" }); });
    return () => { cancelled = true; };
  }, [projectId]);

  return <>
    <PageHeader title="Datasets" description="Calls you labelled from runs, kept with their input, output and screenshot to evaluate other models and prompts against." />
    <Panel>
      {state.datasets === null ? <LoadingRows count={4} columns={4} />
        : state.error ? <div className="ck-ds-error" role="alert">{state.error}</div>
          : state.datasets.length === 0 ? <EmptyPanel title="No datasets yet" body="Open a run, pick a call or a replay step, and choose Add to dataset." />
            : <div className="ck-table-wrap"><table className="ck-table">
              <thead><tr><th>Dataset</th><th>Calls</th><th>Labels</th><th>Updated</th></tr></thead>
              <tbody>{state.datasets.map((dataset) => <tr key={dataset.id}>
                <td><Link className="ck-inline-link" to={`/datasets/${dataset.id}`}>{dataset.name}</Link>{dataset.description && <div className="ck-ds-muted">{dataset.description}</div>}</td>
                <td>{dataset.itemCount.toLocaleString()}</td>
                <td><LabelCounts labels={dataset.labels} /></td>
                <td>{formatAbsoluteDate(dataset.updatedAt)}</td>
              </tr>)}</tbody>
            </table></div>}
    </Panel>
  </>;
}

function DatasetDetail({ projectId, datasetId }: { projectId: string; datasetId: string }) {
  const navigate = useNavigate();
  const [state, setState] = useState<{ dataset: Dataset | null; items: DatasetItem[]; error: string | null; loading: boolean }>({ dataset: null, items: [], error: null, loading: true });
  const load = useCallback(() => getDataset(projectId, datasetId)
    .then((result) => setState({ dataset: result.dataset, items: result.items, error: null, loading: false }))
    .catch((reason: unknown) => setState({ dataset: null, items: [], error: reason instanceof Error ? reason.message : "The dataset couldn't be loaded", loading: false })), [projectId, datasetId]);
  useEffect(() => { void load(); }, [load]);

  async function relabel(item: DatasetItem, label: string): Promise<void> {
    if (!label.trim() || label === item.label) return;
    await updateDatasetItem(projectId, datasetId, item.id, { label: label.trim() });
    await load();
  }
  async function remove(item: DatasetItem): Promise<void> {
    await removeDatasetItem(projectId, datasetId, item.id);
    await load();
  }
  async function removeDataset(): Promise<void> {
    if (!state.dataset || !window.confirm(`Delete "${state.dataset.name}" and its ${state.dataset.itemCount} labelled calls? This can't be undone.`)) return;
    await deleteDataset(projectId, datasetId);
    navigate("/datasets");
  }

  const dataset = state.dataset;
  return <>
    <Link className="ck-ds-back" to="/datasets"><ArrowLeft size={14} /> Datasets</Link>
    <PageHeader
      title={dataset?.name ?? "Dataset"}
      description={dataset ? `${dataset.description ? `${dataset.description} · ` : ""}${dataset.itemCount.toLocaleString()} call${dataset.itemCount === 1 ? "" : "s"} · revision ${dataset.revision}` : undefined}
      actions={dataset && <>
        <a className="ck-button ck-button-secondary" href={datasetExportUrl(projectId, datasetId)} download><Download size={14} /> Export JSONL</a>
        <button className="ck-button ck-button-quiet" type="button" onClick={() => void removeDataset()}><Trash2 size={14} /> Delete</button>
      </>}
    />
    <Panel>
      {state.loading ? <LoadingRows count={4} columns={5} />
        : state.error ? <div className="ck-ds-error" role="alert">{state.error}</div>
          : state.items.length === 0 ? <EmptyPanel title="No calls in this dataset" body="Add calls from a run's replay or call detail." />
            : <div className="ck-table-wrap"><table className="ck-table ck-ds-items">
              <thead><tr><th>Screenshot</th><th>Label</th><th>Note</th><th>Model</th><th>Run</th><th aria-label="Remove" /></tr></thead>
              <tbody>{state.items.map((item) => <tr key={item.id}>
                <td>{item.frameSha256 ? <img className="ck-ds-thumb" src={frameUrl(projectId, item.frameSha256)} alt="" loading="lazy" /> : <span className="ck-ds-muted">None</span>}</td>
                <td><input className="ck-ds-label-input" aria-label="Label" defaultValue={item.label} maxLength={60} onBlur={(event) => void relabel(item, event.target.value)} /></td>
                <td className="ck-ds-note">{item.note ?? ""}{!item.hasInput && <div className="ck-ds-muted">No input kept: prompts weren't captured for this call</div>}</td>
                <td>{item.model ?? "Unknown"}</td>
                <td>{item.traceId ? <Link className="ck-inline-link" to={`/traces/${encodeURIComponent(item.traceId)}?call=${encodeURIComponent(item.sourceEventId)}`}>Open call</Link> : <span className="ck-ds-muted">Unknown</span>}</td>
                <td><button className="ck-button ck-button-quiet" type="button" aria-label="Remove from dataset" onClick={() => void remove(item)}><Trash2 size={13} /></button></td>
              </tr>)}</tbody>
            </table></div>}
    </Panel>
  </>;
}
