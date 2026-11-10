import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowDown, ArrowLeft, ArrowUp, Pencil, Plus, Trash2, X } from "lucide-react";
import { useAuth } from "../contexts/useAuth";
import { getCostBreakdown, getTrends, type CostBreakdownResponse, type TrendBucket } from "../api";
import { EmptyPanel, LoadingRows, PageHeader, Panel } from "../components/ConsolePrimitives";
import { formatAbsoluteDate, formatReportedAmount, type ReportingFx } from "../components/consoleFormatters";
import {
  breakdownRows,
  bucketValue,
  defaultTitle,
  GROUP_LABELS,
  KIND_LABELS,
  METRIC_LABELS,
  PERIOD_LABELS,
  periodRange,
  requestFor,
  requestsFor,
  totalOf,
} from "../components/dashboardWidgets";
import {
  createDashboard,
  deleteDashboard,
  getDashboard,
  listDashboards,
  saveDashboard,
  type CustomDashboard,
  type WidgetGroup,
  type WidgetKind,
  type WidgetMetric,
  type WidgetPeriod,
  type WidgetSpec,
} from "../dashboardsApi";
import { useInsightScope } from "./useInsightScope";
import "./Dashboards.css";

/** Dashboards a team arranges from cost, calls and tokens widgets. */
export default function Dashboards() {
  const { dashboardId } = useParams();
  const { currentProjectId, projects, user } = useAuth();
  const { currency, fx } = useInsightScope();
  const projectId = currentProjectId ?? projects[0]?.id ?? null;
  if (!projectId) return <EmptyPanel title="No project yet" />;
  const canEdit = user?.role !== "viewer";
  return dashboardId
    ? <DashboardView projectId={projectId} dashboardId={dashboardId} canEdit={canEdit} currency={currency} fx={fx} />
    : <DashboardList projectId={projectId} canEdit={canEdit} />;
}

function DashboardList({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const navigate = useNavigate();
  const [state, setState] = useState<{ dashboards: CustomDashboard[] | null; error: string | null }>({ dashboards: null, error: null });
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    let cancelled = false;
    listDashboards(projectId)
      .then((result) => { if (!cancelled) setState({ dashboards: result.dashboards, error: null }); })
      .catch((reason: unknown) => { if (!cancelled) setState({ dashboards: [], error: reason instanceof Error ? reason.message : "Dashboards couldn't be loaded" }); });
    return () => { cancelled = true; };
  }, [projectId]);
  async function create(): Promise<void> {
    if (!name.trim()) return;
    setCreating(true);
    try {
      const { dashboard } = await createDashboard(projectId, name.trim());
      navigate(`/dashboards/${dashboard.id}?edit=1`);
    } catch (reason) {
      setState((current) => ({ ...current, error: reason instanceof Error ? reason.message : "The dashboard couldn't be created" }));
      setCreating(false);
    }
  }
  return <>
    <PageHeader title="Dashboards" description="Your own views of spend, calls and tokens, shared with the workspace." actions={canEdit && <form className="ck-dash-new" onSubmit={(event) => { event.preventDefault(); void create(); }}>
      <input aria-label="New dashboard name" placeholder="New dashboard name" value={name} maxLength={80} onChange={(event) => setName(event.target.value)} />
      <button className="ck-button ck-button-secondary" type="submit" disabled={creating || !name.trim()}><Plus size={14} /> Create</button>
    </form>} />
    <Panel>
      {state.dashboards === null ? <LoadingRows count={3} columns={3} />
        : state.error ? <div className="ck-dash-error" role="alert">{state.error}</div>
          : state.dashboards.length === 0 ? <EmptyPanel title="No dashboards yet" body={canEdit ? "Name one above to start from a spend, calls and breakdown layout you can change." : undefined} />
            : <div className="ck-table-wrap"><table className="ck-table">
              <thead><tr><th>Dashboard</th><th>Widgets</th><th>Updated</th></tr></thead>
              <tbody>{state.dashboards.map((dashboard) => <tr key={dashboard.id}>
                <td><Link className="ck-inline-link" to={`/dashboards/${dashboard.id}`}>{dashboard.name}</Link></td>
                <td>{dashboard.widgets.length}</td>
                <td>{formatAbsoluteDate(dashboard.updatedAt)}</td>
              </tr>)}</tbody>
            </table></div>}
    </Panel>
  </>;
}

type DataState = Record<string, { trends?: TrendBucket[]; costs?: CostBreakdownResponse; error?: string }>;

function DashboardView({ projectId, dashboardId, canEdit, currency, fx }: { projectId: string; dashboardId: string; canEdit: boolean; currency: string; fx?: ReportingFx | null }) {
  const navigate = useNavigate();
  const [dashboard, setDashboard] = useState<CustomDashboard | null>(null);
  const [draft, setDraft] = useState<{ name: string; widgets: WidgetSpec[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<DataState>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getDashboard(projectId, dashboardId)
      .then(({ dashboard: loaded }) => {
        if (cancelled) return;
        setDashboard(loaded);
        if (canEdit && new URLSearchParams(window.location.search).get("edit") === "1") setDraft({ name: loaded.name, widgets: loaded.widgets });
      })
      .catch((reason: unknown) => { if (!cancelled) setError(reason instanceof Error ? reason.message : "The dashboard couldn't be loaded"); });
    return () => { cancelled = true; };
  }, [projectId, dashboardId, canEdit]);

  const widgets = useMemo(() => draft?.widgets ?? dashboard?.widgets ?? [], [draft, dashboard]);
  const requests = useMemo(() => requestsFor(widgets), [widgets]);
  const requestKeys = requests.map((request) => request.key).join("|");

  // One fetch per distinct request; widgets that need the same data share it.
  useEffect(() => {
    let cancelled = false;
    for (const request of requests) {
      if (data[request.key]) continue;
      const range = periodRange(request.period);
      const load = request.kind === "trends"
        ? getTrends(projectId, range.bucket, undefined, undefined, { from: range.from, to: range.to }).then((result) => ({ trends: result.trends }))
        : getCostBreakdown(projectId, { groupBy: request.groupBy!, from: range.from, to: range.to, limit: 50 }).then((costs) => ({ costs }));
      load
        .then((value) => { if (!cancelled) setData((current) => ({ ...current, [request.key]: value })); })
        .catch((reason: unknown) => { if (!cancelled) setData((current) => ({ ...current, [request.key]: { error: reason instanceof Error ? reason.message : "Couldn't load" } })); });
    }
    return () => { cancelled = true; };
    // `data` is read only to skip requests already answered.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, requestKeys]);

  async function save(): Promise<void> {
    if (!draft) return;
    setSaving(true);
    try {
      const { dashboard: saved } = await saveDashboard(projectId, dashboardId, draft);
      setDashboard(saved);
      setDraft(null);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The dashboard couldn't be saved");
    } finally {
      setSaving(false);
    }
  }
  async function remove(): Promise<void> {
    if (!dashboard || !window.confirm(`Delete the dashboard "${dashboard.name}"? This can't be undone.`)) return;
    await deleteDashboard(projectId, dashboardId);
    navigate("/dashboards");
  }
  const move = (index: number, by: number) => setDraft((current) => {
    if (!current) return current;
    const next = [...current.widgets];
    const target = index + by;
    if (target < 0 || target >= next.length) return current;
    [next[index], next[target]] = [next[target]!, next[index]!];
    return { ...current, widgets: next };
  });

  if (error && !dashboard) return <><Link className="ck-dash-back" to="/dashboards"><ArrowLeft size={14} /> Dashboards</Link><Panel><div className="ck-dash-error" role="alert">{error}</div></Panel></>;
  if (!dashboard) return <Panel><LoadingRows count={4} columns={3} /></Panel>;
  return <>
    <Link className="ck-dash-back" to="/dashboards"><ArrowLeft size={14} /> Dashboards</Link>
    <PageHeader
      title={draft ? "Edit dashboard" : dashboard.name}
      actions={canEdit && (draft
        ? <>
          <button className="ck-button ck-button-quiet" type="button" onClick={() => setDraft(null)}>Cancel</button>
          <button className="ck-button ck-button-secondary" type="button" disabled={saving} onClick={() => void save()}>{saving ? "Saving" : "Save"}</button>
        </>
        : <>
          <button className="ck-button ck-button-secondary" type="button" onClick={() => setDraft({ name: dashboard.name, widgets: dashboard.widgets })}><Pencil size={14} /> Edit</button>
          <button className="ck-button ck-button-quiet" type="button" onClick={() => void remove()}><Trash2 size={14} /> Delete</button>
        </>)}
    />
    {draft && <div className="ck-dash-editbar">
      <label htmlFor="dash-name">Name</label>
      <input id="dash-name" value={draft.name} maxLength={80} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
    </div>}
    {error && <div className="ck-dash-error" role="alert">{error}</div>}
    {widgets.length === 0 && !draft && <EmptyPanel title="This dashboard has no widgets" body={canEdit ? "Choose Edit to add some." : undefined} />}
    <div className="ck-dash-grid">
      {widgets.map((widget, index) => <section key={widget.id} className={`ck-dash-widget${widget.width === "full" ? " is-full" : ""}`} aria-label={widget.title || defaultTitle(widget)}>
        <header className="ck-dash-widget-head">
          <div>
            <h2>{widget.title || defaultTitle(widget)}</h2>
            <small>{PERIOD_LABELS[widget.period]}</small>
          </div>
          {draft && <div className="ck-dash-widget-tools">
            <button type="button" aria-label="Move up" disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp size={13} /></button>
            <button type="button" aria-label="Move down" disabled={index === widgets.length - 1} onClick={() => move(index, 1)}><ArrowDown size={13} /></button>
            <button type="button" aria-label="Remove widget" onClick={() => setDraft({ ...draft, widgets: draft.widgets.filter((item) => item.id !== widget.id) })}><X size={13} /></button>
          </div>}
        </header>
        <WidgetBody widget={widget} data={data[requestFor(widget).key]} currency={currency} fx={fx} />
      </section>)}
    </div>
    {draft && <AddWidget onAdd={(widget) => setDraft({ ...draft, widgets: [...draft.widgets, widget] })} disabled={draft.widgets.length >= 24} />}
  </>;
}

function formatMetric(value: number, metric: WidgetMetric, currency: string, fx?: ReportingFx | null): string {
  if (metric === "cost") return formatReportedAmount(value, currency, fx);
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 10_000) return `${(value / 1_000).toFixed(1)}k`;
  return Math.round(value).toLocaleString();
}

function WidgetBody({ widget, data, currency, fx }: { widget: WidgetSpec; data?: DataState[string]; currency: string; fx?: ReportingFx | null }) {
  if (!data) return <LoadingRows count={2} columns={2} />;
  if (data.error) return <div className="ck-dash-error" role="alert">{data.error}</div>;
  const format = (value: number) => formatMetric(value, widget.metric, currency, fx);
  if (widget.kind === "total") {
    const total = totalOf(data.trends ?? [], widget.metric);
    return <div className="ck-dash-total"><b>{format(total.value)}</b>{total.unpriced > 0 && <small>{total.unpriced.toLocaleString()} unpriced call{total.unpriced === 1 ? "" : "s"} not included</small>}</div>;
  }
  if (widget.kind === "trend") return <TrendChart buckets={data.trends ?? []} metric={widget.metric} format={format} />;
  const rows = breakdownRows(data.costs ?? {}, widget.metric);
  if (rows.length === 0) return <div className="ck-dash-muted">Nothing recorded in this period</div>;
  const max = Math.max(...rows.map((row) => row.value), 0) || 1;
  return <ol className="ck-dash-bars">{rows.map((row) => <li key={row.label}>
    <span className="ck-dash-bar-label" title={row.label}>{row.label}</span>
    <span className="ck-dash-bar-track"><i style={{ width: `${(row.value / max) * 100}%` }} /></span>
    <span className="ck-dash-bar-value">{format(row.value)}</span>
  </li>)}</ol>;
}

function TrendChart({ buckets, metric, format }: { buckets: TrendBucket[]; metric: WidgetMetric; format: (value: number) => string }) {
  if (buckets.length === 0) return <div className="ck-dash-muted">Nothing recorded in this period</div>;
  const values = buckets.map((bucket) => bucketValue(bucket, metric));
  const max = Math.max(...values, 0) || 1;
  const width = 600;
  const height = 140;
  const step = values.length > 1 ? width / (values.length - 1) : width;
  const points = values.map((value, index) => `${(index * step).toFixed(1)},${(height - (value / max) * (height - 8) - 4).toFixed(1)}`);
  const peak = values.indexOf(Math.max(...values));
  return <figure className="ck-dash-trend">
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={`${METRIC_LABELS[metric]} per ${buckets.length > 30 ? "hour" : "day"}, peak ${format(values[peak] ?? 0)}`}>
      <polygon points={`0,${height} ${points.join(" ")} ${width},${height}`} className="ck-dash-trend-area" />
      <polyline points={points.join(" ")} className="ck-dash-trend-line" />
    </svg>
    <figcaption><span>{new Date(buckets[0]!.bucket).toLocaleDateString()}</span><span>Peak {format(values[peak] ?? 0)}</span><span>{new Date(buckets[buckets.length - 1]!.bucket).toLocaleDateString()}</span></figcaption>
  </figure>;
}

function AddWidget({ onAdd, disabled }: { onAdd: (widget: WidgetSpec) => void; disabled: boolean }) {
  const [kind, setKind] = useState<WidgetKind>("breakdown");
  const [metric, setMetric] = useState<WidgetMetric>("cost");
  const [groupBy, setGroupBy] = useState<WidgetGroup>("model");
  const [period, setPeriod] = useState<WidgetPeriod>("7d");
  const [width, setWidth] = useState<"half" | "full">("half");
  const [title, setTitle] = useState("");
  const metrics = (Object.keys(METRIC_LABELS) as WidgetMetric[]).filter((value) => kind !== "breakdown" || value !== "tokens");
  return <Panel title="Add a widget">
    <form className="ck-dash-add" onSubmit={(event) => {
      event.preventDefault();
      onAdd({
        id: `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        title: title.trim(),
        kind,
        metric: kind === "breakdown" && metric === "tokens" ? "cost" : metric,
        ...(kind === "breakdown" ? { groupBy } : {}),
        period,
        width,
      });
      setTitle("");
    }}>
      <label>Show<select value={kind} onChange={(event) => setKind(event.target.value as WidgetKind)}>{(Object.keys(KIND_LABELS) as WidgetKind[]).map((value) => <option key={value} value={value}>{KIND_LABELS[value]}</option>)}</select></label>
      <label>Of<select value={metric} onChange={(event) => setMetric(event.target.value as WidgetMetric)}>{metrics.map((value) => <option key={value} value={value}>{METRIC_LABELS[value]}</option>)}</select></label>
      {kind === "breakdown" && <label>By<select value={groupBy} onChange={(event) => setGroupBy(event.target.value as WidgetGroup)}>{(Object.keys(GROUP_LABELS) as WidgetGroup[]).map((value) => <option key={value} value={value}>{GROUP_LABELS[value]}</option>)}</select></label>}
      <label>Period<select value={period} onChange={(event) => setPeriod(event.target.value as WidgetPeriod)}>{(Object.keys(PERIOD_LABELS) as WidgetPeriod[]).map((value) => <option key={value} value={value}>{PERIOD_LABELS[value]}</option>)}</select></label>
      <label>Width<select value={width} onChange={(event) => setWidth(event.target.value as "half" | "full")}><option value="half">Half</option><option value="full">Full</option></select></label>
      <label className="ck-dash-add-title">Title<input placeholder={defaultTitle({ kind, metric, groupBy })} value={title} maxLength={80} onChange={(event) => setTitle(event.target.value)} /></label>
      <button className="ck-button ck-button-secondary" type="submit" disabled={disabled}><Plus size={14} /> Add</button>
    </form>
  </Panel>;
}
