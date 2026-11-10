import { useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowDown, ArrowLeft, ArrowUp, BarChart3, Columns2, Hash, LayoutDashboard, LineChart, Pencil, Plus, Rows2, Trash2, X } from "lucide-react";
import { useAuth } from "../contexts/useAuth";
import { getCostBreakdown, getTrends, type CostBreakdownResponse, type TrendBucket } from "../api";
import { EmptyPanel, LoadingRows, PageHeader, Panel } from "../components/ConsolePrimitives";
import { formatReportedAmount, type ReportingFx } from "../components/consoleFormatters";
import { useWidth } from "../components/OverviewBoard";
import { niceCeiling, tickIndexes } from "../components/overviewBoardModel";
import { timeAgo } from "../components/datasetView";
import {
  breakdownRows,
  bucketLabel,
  bucketValue,
  defaultTitle,
  GROUP_LABELS,
  METRIC_LABELS,
  PERIOD_LABELS,
  periodRange,
  requestFor,
  requestsFor,
  totalOf,
  withShares,
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
import "../components/Budgets.css";
import "./Dashboards.css";

/** Dashboards a team arranges from cost, calls and tokens widgets. */
export default function Dashboards() {
  const { dashboardId } = useParams();
  const { currentProjectId, projects, user } = useAuth();
  const { currency, fx } = useInsightScope();
  const projectId = currentProjectId ?? projects[0]?.id ?? null;
  if (!projectId) {
    return <div className="ck-main-inner"><PageHeader title="Dashboards" /><Panel><EmptyPanel illustration="first-light" title="Connect a project first" body="Dashboards show the spend, calls and tokens a project records." action={<Link className="ck-button ck-button-primary" to="/onboarding">Connect a project</Link>} /></Panel></div>;
  }
  const canEdit = user?.role !== "viewer";
  return dashboardId
    ? <DashboardView projectId={projectId} dashboardId={dashboardId} canEdit={canEdit} currency={currency} fx={fx} />
    : <DashboardList projectId={projectId} canEdit={canEdit} />;
}

const KIND_ICON = { total: Hash, trend: LineChart, breakdown: BarChart3 } as const;

/** A small picture of a dashboard's layout: one block per widget. */
function LayoutPreview({ widgets }: { widgets: WidgetSpec[] }) {
  return <div className="ck-dash-preview" aria-hidden="true">
    {widgets.slice(0, 8).map((widget) => {
      const Icon = KIND_ICON[widget.kind];
      return <span key={widget.id} className={`is-${widget.kind}${widget.width === "full" ? " is-full" : ""}`}><Icon size={10} /></span>;
    })}
  </div>;
}

function DashboardList({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const navigate = useNavigate();
  const [state, setState] = useState<{ dashboards: CustomDashboard[] | null; error: string | null }>({ dashboards: null, error: null });
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    let cancelled = false;
    listDashboards(projectId)
      .then((result) => { if (!cancelled) setState({ dashboards: result.dashboards, error: null }); })
      .catch((reason: unknown) => { if (!cancelled) setState({ dashboards: [], error: reason instanceof Error ? reason.message : "Dashboards couldn't be loaded" }); });
    return () => { cancelled = true; };
  }, [projectId]);

  async function create(): Promise<void> {
    setCreating(true);
    const taken = new Set((state.dashboards ?? []).map((dashboard) => dashboard.name));
    let name = "Untitled dashboard";
    for (let n = 2; taken.has(name); n++) name = `Untitled dashboard ${n}`;
    try {
      const { dashboard } = await createDashboard(projectId, name);
      navigate(`/dashboards/${dashboard.id}?edit=1`);
    } catch (reason) {
      setState((current) => ({ ...current, error: reason instanceof Error ? reason.message : "The dashboard couldn't be created" }));
      setCreating(false);
    }
  }

  const newButton = canEdit && <button className="ck-button ck-button-primary" type="button" disabled={creating} onClick={() => void create()}><Plus size={14} aria-hidden="true" /> {creating ? "Creating…" : "New dashboard"}</button>;
  return <div className="ck-main-inner ck-dash-page">
    <PageHeader title="Dashboards" description="Your own views of spend, calls and tokens, shared with everyone in the workspace." actions={state.dashboards && state.dashboards.length > 0 ? newButton : undefined} />
    {state.dashboards === null ? <Panel><LoadingRows count={3} columns={3} /></Panel>
      : state.error && state.dashboards.length === 0 ? <Panel><EmptyPanel title="Dashboards couldn't be loaded" body={state.error} /></Panel>
        : state.dashboards.length === 0
          ? <Panel><EmptyPanel
            illustration="a-closer-look"
            title="Build a dashboard"
            body={canEdit ? "Start from spend, calls and a breakdown by model, then add totals, charts over time and breakdowns by provider, feature, customer or function." : "No one has made a dashboard for this project yet."}
            action={newButton || undefined}
          /></Panel>
          : <div className="ck-dash-cards">{state.dashboards.map((dashboard) => <Link key={dashboard.id} className="ck-dash-card" to={`/dashboards/${dashboard.id}`}>
            <LayoutPreview widgets={dashboard.widgets} />
            <div className="ck-dash-card-body">
              <h2>{dashboard.name}</h2>
              <p>{dashboard.widgets.length} widget{dashboard.widgets.length === 1 ? "" : "s"} · updated {timeAgo(dashboard.updatedAt)}</p>
              <div className="ck-dash-card-tags">{dashboard.widgets.slice(0, 3).map((widget) => <span key={widget.id}>{widget.title || defaultTitle(widget)}</span>)}{dashboard.widgets.length > 3 && <span>+{dashboard.widgets.length - 3}</span>}</div>
            </div>
          </Link>)}</div>}
    {state.error && (state.dashboards?.length ?? 0) > 0 && <p className="ck-dash-error" role="alert">{state.error}</p>}
  </div>;
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
    if (!draft.name.trim()) { setError("Give the dashboard a name"); return; }
    setSaving(true);
    try {
      const { dashboard: saved } = await saveDashboard(projectId, dashboardId, { ...draft, name: draft.name.trim() });
      setDashboard(saved);
      setDraft(null);
      setError(null);
      if (window.location.search.includes("edit=1")) navigate(`/dashboards/${dashboardId}`, { replace: true });
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
  const update = (id: string, change: Partial<WidgetSpec>) => setDraft((current) => current && { ...current, widgets: current.widgets.map((widget) => (widget.id === id ? { ...widget, ...change } : widget)) });
  const move = (index: number, by: number) => setDraft((current) => {
    if (!current) return current;
    const next = [...current.widgets];
    const target = index + by;
    if (target < 0 || target >= next.length) return current;
    [next[index], next[target]] = [next[target]!, next[index]!];
    return { ...current, widgets: next };
  });

  if (error && !dashboard) {
    return <div className="ck-main-inner"><Link className="ck-back-link" to="/dashboards"><ArrowLeft size={13} /> Dashboards</Link><PageHeader title="Dashboard" /><Panel><EmptyPanel title="This dashboard couldn't be loaded" body={error} /></Panel></div>;
  }
  if (!dashboard) return <div className="ck-main-inner"><Link className="ck-back-link" to="/dashboards"><ArrowLeft size={13} /> Dashboards</Link><Panel><LoadingRows count={4} columns={3} /></Panel></div>;
  return <div className={`ck-main-inner ck-dash-page${draft ? " is-editing" : ""}`}>
    <Link className="ck-back-link" to="/dashboards"><ArrowLeft size={13} /> Dashboards</Link>
    {draft
      ? <div className="ck-page-header ck-dash-edit-header">
        <input className="ck-dash-name-input" aria-label="Dashboard name" value={draft.name} maxLength={80} autoFocus={window.location.search.includes("edit=1")} onFocus={(event) => event.currentTarget.select()} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
        <div className="ck-page-actions">
          <button className="ck-button ck-button-quiet" type="button" onClick={() => { setDraft(null); setError(null); }}>Cancel</button>
          <button className="ck-button ck-button-primary" type="button" disabled={saving} onClick={() => void save()}>{saving ? "Saving…" : "Save dashboard"}</button>
        </div>
      </div>
      : <PageHeader
        title={dashboard.name}
        description={`${dashboard.widgets.length} widget${dashboard.widgets.length === 1 ? "" : "s"} · updated ${timeAgo(dashboard.updatedAt)}`}
        actions={canEdit && <>
          <button className="ck-button ck-button-secondary" type="button" onClick={() => setDraft({ name: dashboard.name, widgets: dashboard.widgets })}><Pencil size={14} aria-hidden="true" /> Edit</button>
          <button className="ck-button ck-button-quiet ck-dash-danger" type="button" onClick={() => void remove()}><Trash2 size={14} aria-hidden="true" /> Delete</button>
        </>}
      />}
    {error && <p className="ck-dash-error" role="alert">{error}</p>}
    {widgets.length === 0 && !draft && <Panel><EmptyPanel icon={<LayoutDashboard size={20} />} title="No widgets yet" body={canEdit ? "Choose Edit to add totals, charts and breakdowns." : undefined} /></Panel>}
    <div className="ck-dash-grid">
      {widgets.map((widget, index) => <section key={widget.id} className={`ck-dash-widget is-${widget.kind}${widget.width === "full" ? " is-full" : ""}`} aria-label={widget.title || defaultTitle(widget)}>
        <header className="ck-dash-widget-head">
          <div className="min-w-0">
            <h2>{widget.title || defaultTitle(widget)}</h2>
            <small>{PERIOD_LABELS[widget.period]}</small>
          </div>
          {draft && <div className="ck-dash-widget-tools">
            <button type="button" aria-label={widget.width === "full" ? "Make half width" : "Make full width"} title={widget.width === "full" ? "Half width" : "Full width"} onClick={() => update(widget.id, { width: widget.width === "full" ? "half" : "full" })}>{widget.width === "full" ? <Columns2 size={13} /> : <Rows2 size={13} />}</button>
            <button type="button" aria-label="Move earlier" disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp size={13} /></button>
            <button type="button" aria-label="Move later" disabled={index === widgets.length - 1} onClick={() => move(index, 1)}><ArrowDown size={13} /></button>
            <button type="button" aria-label="Remove widget" className="is-danger" onClick={() => setDraft({ ...draft, widgets: draft.widgets.filter((item) => item.id !== widget.id) })}><X size={13} /></button>
          </div>}
        </header>
        <WidgetBody widget={widget} data={data[requestFor(widget).key]} currency={currency} fx={fx} />
      </section>)}
    </div>
    {draft && <AddWidget onAdd={(widget) => setDraft({ ...draft, widgets: [...draft.widgets, widget] })} disabled={draft.widgets.length >= 24} />}
  </div>;
}

function formatMetric(value: number, metric: WidgetMetric, currency: string, fx?: ReportingFx | null): string {
  if (metric === "cost") return formatReportedAmount(value, currency, fx);
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 10_000) return `${(value / 1_000).toFixed(1)}k`;
  return Math.round(value).toLocaleString();
}

function WidgetBody({ widget, data, currency, fx }: { widget: WidgetSpec; data?: DataState[string]; currency: string; fx?: ReportingFx | null }) {
  if (!data) return <div className="ck-dash-loading"><span className="ck-skeleton" /></div>;
  if (data.error) return <p className="ck-dash-error" role="alert">Couldn't load this widget: {data.error}</p>;
  const format = (value: number) => formatMetric(value, widget.metric, currency, fx);
  const hourly = widget.period === "24h";
  if (widget.kind === "total") {
    const trends = data.trends ?? [];
    const total = totalOf(trends, widget.metric);
    return <div className="ck-dash-total">
      <b>{format(total.value)}</b>
      {total.unpriced > 0 && <small>{total.unpriced.toLocaleString()} unpriced call{total.unpriced === 1 ? "" : "s"} not included</small>}
      {trends.length > 1 && <Sparkline values={trends.map((bucket) => bucketValue(bucket, widget.metric))} />}
    </div>;
  }
  if (widget.kind === "trend") return <TrendChart buckets={data.trends ?? []} metric={widget.metric} hourly={hourly} format={format} />;
  const rows = withShares(breakdownRows(data.costs ?? {}, widget.metric));
  if (rows.length === 0) return <p className="ck-dash-muted">Nothing recorded in this period.</p>;
  const max = Math.max(...rows.map((row) => row.value), 0) || 1;
  return <ol className="ck-dash-bars">{rows.map((row) => <li key={row.label}>
    <span className="ck-dash-bar-label" title={row.label}>{row.label}</span>
    <span className="ck-dash-bar-track"><i style={{ width: `${Math.max(1.5, (row.value / max) * 100)}%` }} /></span>
    <span className="ck-dash-bar-value">{format(row.value)}</span>
    <span className="ck-dash-bar-share">{Math.round(row.share * 100)}%</span>
  </li>)}</ol>;
}

function Sparkline({ values }: { values: number[] }) {
  const max = Math.max(...values, 0) || 1;
  const width = 200;
  const height = 36;
  const step = values.length > 1 ? width / (values.length - 1) : width;
  const points = values.map((value, index) => `${(index * step).toFixed(1)},${(height - 2 - (value / max) * (height - 6)).toFixed(1)}`).join(" ");
  return <svg className="ck-dash-spark" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
    <polygon points={`0,${height} ${points} ${width},${height}`} />
    <polyline points={points} />
  </svg>;
}

/** Same look as the Overview's spend chart: grid, axis labels, a hover readout. */
function TrendChart({ buckets, metric, hourly, format }: { buckets: TrendBucket[]; metric: WidgetMetric; hourly: boolean; format: (value: number) => string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  if (buckets.length === 0) return <p className="ck-dash-muted">Nothing recorded in this period.</p>;
  const values = buckets.map((bucket) => bucketValue(bucket, metric));
  const height = 200;
  const left = 54;
  const right = 12;
  const top = 12;
  const bottom = 26;
  const max = niceCeiling(Math.max(0, ...values) * 1.1);
  const plot = Math.max(1, width - left - right);
  const step = values.length > 1 ? plot / (values.length - 1) : 0;
  const x = (index: number) => (values.length > 1 ? left + step * index : left + plot / 2);
  const y = (value: number) => top + (height - top - bottom) * (1 - value / max);
  const line = values.map((value, index) => `${index === 0 ? "M" : "L"}${x(index).toFixed(1)} ${y(value).toFixed(1)}`).join(" ");
  const area = values.length > 1 ? `${line} L${x(values.length - 1).toFixed(1)} ${y(0).toFixed(1)} L${x(0).toFixed(1)} ${y(0).toFixed(1)} Z` : "";
  const xTicks = tickIndexes(values.length, width < 420 ? 4 : 7);
  const onMove = (event: ReactMouseEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const index = values.length > 1 ? Math.round((event.clientX - rect.left - left) / step) : 0;
    setHover(index >= 0 && index < values.length ? index : null);
  };
  const axis = (value: number) => (metric === "cost" ? format(value).replace(/\.00$/, "") : format(value));
  return <div className="ck-board-chart ck-spend-chart ck-dash-chart" ref={ref}>
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${METRIC_LABELS[metric]} per ${hourly ? "hour" : "day"}`} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
      {[0, max / 2, max].map((tick) => <g key={tick}><line className="grid" x1={left} x2={width - right} y1={y(tick)} y2={y(tick)} /><text x={left - 8} y={y(tick) + 4} textAnchor="end">{axis(tick)}</text></g>)}
      {area && <path className="spend-area" d={area} />}
      <path className="spend-line" d={line} />
      {hover != null && <line className="ck-dash-cursor" x1={x(hover)} x2={x(hover)} y1={top} y2={y(0)} />}
      {values.map((value, index) => (values.length <= 31 || hover === index) && <circle key={index} className="spend-point" cx={x(index)} cy={y(value)} r={hover === index ? 4.5 : 2.5} />)}
      {xTicks.map((index) => <text key={index} x={x(index)} y={height - 6} textAnchor={xTicks.length > 1 && index === 0 ? "start" : xTicks.length > 1 && index === values.length - 1 ? "end" : "middle"}>{bucketLabel(buckets[index]!.bucket, hourly)}</text>)}
    </svg>
    {hover != null && <div className="ck-board-tooltip" style={{ left: Math.min(Math.max(x(hover), 80), width - 80) }}>
      <div className="ck-board-tooltip-title">{bucketLabel(buckets[hover]!.bucket, hourly)}</div>
      <div className="ck-board-tooltip-row"><i style={{ background: "var(--ck-chart)" }} />{METRIC_LABELS[metric]}<strong>{format(values[hover] ?? 0)}</strong></div>
    </div>}
  </div>;
}

const KIND_CHOICES: Array<{ value: WidgetKind; label: string; hint: string }> = [
  { value: "total", label: "Total", hint: "One number for the period" },
  { value: "trend", label: "Over time", hint: "A chart by day or hour" },
  { value: "breakdown", label: "Breakdown", hint: "Ranked by model, feature…" },
];

function AddWidget({ onAdd, disabled }: { onAdd: (widget: WidgetSpec) => void; disabled: boolean }) {
  const [kind, setKind] = useState<WidgetKind>("breakdown");
  const [metric, setMetric] = useState<WidgetMetric>("cost");
  const [groupBy, setGroupBy] = useState<WidgetGroup>("model");
  const [period, setPeriod] = useState<WidgetPeriod>("7d");
  const [title, setTitle] = useState("");
  const metrics = (Object.keys(METRIC_LABELS) as WidgetMetric[]).filter((value) => kind !== "breakdown" || value !== "tokens");
  return <Panel title="Add a widget" subtitle={disabled ? "A dashboard holds up to 24 widgets." : undefined} className="ck-dash-add-panel">
    <form className="ck-dash-add" onSubmit={(event) => {
      event.preventDefault();
      onAdd({
        id: `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        title: title.trim(),
        kind,
        metric: kind === "breakdown" && metric === "tokens" ? "cost" : metric,
        ...(kind === "breakdown" ? { groupBy } : {}),
        period,
        width: kind === "total" ? "half" : kind === "trend" ? "full" : "half",
      });
      setTitle("");
    }}>
      <div className="ck-dash-kinds" role="radiogroup" aria-label="Widget">
        {KIND_CHOICES.map((choice) => {
          const Icon = KIND_ICON[choice.value];
          return <button key={choice.value} type="button" role="radio" aria-checked={kind === choice.value} className={kind === choice.value ? "is-on" : ""} onClick={() => setKind(choice.value)}>
            <Icon size={16} aria-hidden="true" /><b>{choice.label}</b><span>{choice.hint}</span>
          </button>;
        })}
      </div>
      <div className="ck-dash-fields">
        <label>Measure<select value={metric} onChange={(event) => setMetric(event.target.value as WidgetMetric)}>{metrics.map((value) => <option key={value} value={value}>{METRIC_LABELS[value]}</option>)}</select></label>
        {kind === "breakdown" && <label>By<select value={groupBy} onChange={(event) => setGroupBy(event.target.value as WidgetGroup)}>{(Object.keys(GROUP_LABELS) as WidgetGroup[]).map((value) => <option key={value} value={value}>{GROUP_LABELS[value][0]!.toUpperCase() + GROUP_LABELS[value].slice(1)}</option>)}</select></label>}
        <label>Period<select value={period} onChange={(event) => setPeriod(event.target.value as WidgetPeriod)}>{(Object.keys(PERIOD_LABELS) as WidgetPeriod[]).map((value) => <option key={value} value={value}>{PERIOD_LABELS[value]}</option>)}</select></label>
        <label className="ck-dash-add-title"><span>Title <em>optional</em></span><input placeholder={defaultTitle({ kind, metric: kind === "breakdown" && metric === "tokens" ? "cost" : metric, groupBy })} value={title} maxLength={80} onChange={(event) => setTitle(event.target.value)} /></label>
        <button className="ck-button ck-button-secondary" type="submit" disabled={disabled}><Plus size={14} aria-hidden="true" /> Add widget</button>
      </div>
    </form>
  </Panel>;
}
