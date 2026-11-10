import { useEffect, useId, useState } from "react";
import { Link } from "react-router-dom";
import { Tag } from "lucide-react";
import {
  addDatasetItem,
  createDataset,
  datasetMemberships,
  listDatasets,
  type Dataset,
  type DatasetMembership,
} from "../datasetsApi";
import { labelTone } from "./datasetView";
import "./AddToDataset.css";

const QUICK_LABELS = ["Good", "Bad"];
const NEW_DATASET = "__new__";

/**
 * Label a call and keep it in a dataset, with its input, output and the
 * screenshot the model saw. Shows the datasets the call is already in.
 */
export function AddToDataset({ projectId, eventId, compact = false }: { projectId: string; eventId: string; compact?: boolean }) {
  const formId = useId();
  const [memberships, setMemberships] = useState<DatasetMembership[] | null>(null);
  const [datasets, setDatasets] = useState<Dataset[] | null>(null);
  const [open, setOpen] = useState(false);
  const [datasetId, setDatasetId] = useState<string>("");
  const [newName, setNewName] = useState("");
  const [label, setLabel] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);

  // A different call starts closed, with its own memberships.
  if (loadedFor !== eventId) {
    setLoadedFor(eventId);
    setMemberships(null);
    setOpen(false);
    setError(null);
  }

  useEffect(() => {
    let cancelled = false;
    datasetMemberships(projectId, eventId)
      .then((result) => { if (!cancelled) setMemberships(result.items); })
      .catch(() => { if (!cancelled) setMemberships([]); });
    return () => { cancelled = true; };
  }, [projectId, eventId]);

  async function start(): Promise<void> {
    setOpen(true);
    setError(null);
    const current = memberships?.[0];
    setLabel(current?.label ?? "");
    setNote(current?.note ?? "");
    try {
      const result = await listDatasets(projectId);
      setDatasets(result.datasets);
      setDatasetId(current?.datasetId ?? result.datasets[0]?.id ?? NEW_DATASET);
    } catch (reason) {
      setDatasets([]);
      setDatasetId(NEW_DATASET);
      setError(reason instanceof Error ? reason.message : "Datasets couldn't be loaded");
    }
  }

  async function save(): Promise<void> {
    if (!label.trim()) { setError("Pick or type a label"); return; }
    setSaving(true);
    setError(null);
    try {
      let target = datasetId;
      if (target === NEW_DATASET) {
        if (!newName.trim()) { setError("Name the new dataset"); setSaving(false); return; }
        target = (await createDataset(projectId, { name: newName.trim() })).dataset.id;
      }
      await addDatasetItem(projectId, target, { eventId, label: label.trim(), note: note.trim() || undefined });
      setMemberships((await datasetMemberships(projectId, eventId)).items);
      setOpen(false);
      setNewName("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The call couldn't be added");
    } finally {
      setSaving(false);
    }
  }

  return <div className={`ck-add-dataset${compact ? " is-compact" : ""}`}>
    {!open && <div className="ck-add-dataset-row">
      {memberships?.map((membership) => <Link key={membership.id} className={`ck-add-dataset-chip is-${labelTone(membership.label)}`} to={`/datasets/${membership.datasetId}`} title={membership.note ?? `Open ${membership.datasetName}`}>
        <Tag size={12} aria-hidden="true" />{membership.datasetName}<b>{membership.label}</b>
      </Link>)}
      <button className="ck-button ck-button-quiet" type="button" onClick={() => void start()} disabled={memberships === null}>
        <Tag size={13} />{memberships && memberships.length > 0 ? "Relabel" : "Add to dataset"}
      </button>
    </div>}
    {open && <form className="ck-add-dataset-form" aria-label="Add to dataset" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <label htmlFor={`${formId}-dataset`}>Dataset</label>
      <select id={`${formId}-dataset`} value={datasetId} onChange={(event) => setDatasetId(event.target.value)} disabled={datasets === null}>
        {(datasets ?? []).map((dataset) => <option key={dataset.id} value={dataset.id}>{dataset.name}</option>)}
        <option value={NEW_DATASET}>New dataset…</option>
      </select>
      {datasetId === NEW_DATASET && <input aria-label="New dataset name" placeholder="e.g. checkout clicks" value={newName} maxLength={80} onChange={(event) => setNewName(event.target.value)} autoFocus />}
      <span className="ck-add-dataset-label">Label</span>
      <div className="ck-add-dataset-quick">
        {QUICK_LABELS.map((quick) => <button key={quick} type="button" className={`ck-add-dataset-pill is-${labelTone(quick)}${label === quick ? " is-on" : ""}`} aria-pressed={label === quick} onClick={() => setLabel(quick)}>{quick}</button>)}
        <input aria-label="Custom label" placeholder="or type one, e.g. wrong click" value={QUICK_LABELS.includes(label) ? "" : label} maxLength={60} onChange={(event) => setLabel(event.target.value)} />
      </div>
      <label htmlFor={`${formId}-note`}>Note</label>
      <textarea id={`${formId}-note`} rows={2} maxLength={2000} placeholder="What should have happened?" value={note} onChange={(event) => setNote(event.target.value)} />
      {error && <div className="ck-add-dataset-error" role="alert">{error}</div>}
      <div className="ck-add-dataset-actions">
        <button className="ck-button ck-button-quiet" type="button" onClick={() => setOpen(false)}>Cancel</button>
        <button className="ck-button ck-button-primary" type="submit" disabled={saving || !label.trim()}>{saving ? "Saving…" : memberships && memberships.length > 0 ? "Save label" : "Add to dataset"}</button>
      </div>
    </form>}
  </div>;
}
