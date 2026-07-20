import { useState, useEffect } from "react";
import { BarChart3, Route, FileCode, Activity, Search, AlertCircle, X, ExternalLink } from "lucide-react";
import AnomalyBanner from "../components/AnomalyBanner";
import SummaryView from "../components/SummaryView";
import { getHealth, type HealthHint } from "../api";
import StatCards from "../components/StatCards";
import CostTrend from "../components/CostTrend";
import CallSitesTable from "../components/CallSitesTable";
import ModelBreakdown from "../components/ModelBreakdown";
import TracesView from "../components/TracesView";
import RecentEvents from "../components/RecentEvents";
import EmptyState from "../components/EmptyState";
import InsightsView from "../components/InsightsView";
import { useSummary, useOverview, useCallSites, useEvents, useTrends, useTraces } from "../hooks/useApi";
import { useAuth } from "../contexts/AuthContext";
import { analytics } from "../analytics";

type Tab = "overview" | "insights" | "traces" | "call-sites" | "events";
type TimeRange = "mtd" | "7d" | "30d" | "3m" | "6m" | "1y";

const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: "overview", label: "Overview", icon: <BarChart3 size={14} /> },
  // { id: "insights", label: "Insights", icon: <Lightbulb size={14} /> }, // TODO: re-enable after polish
  { id: "events", label: "Events", icon: <Activity size={14} /> },
  { id: "call-sites", label: "Call Sites", icon: <FileCode size={14} /> },
  { id: "traces", label: "Traces", icon: <Route size={14} /> },
];

export default function Dashboard({ demoMode = false }: { demoMode?: boolean }) {
  const { currentProjectId } = useAuth();
  const projectId = demoMode ? "proj_demo" : (currentProjectId ?? "proj_demo");
  const [activeTab, setActiveTab] = useState<Tab>("overview");
  const [search, setSearch] = useState("");
  const [timeRange, setTimeRange] = useState<TimeRange>("mtd");
  const [groupByModel, setGroupByModel] = useState(false);

  const [hints, setHints] = useState<HealthHint[]>([]);
  const [dismissedHints, setDismissedHints] = useState<Set<string>>(new Set());

  useEffect(() => {
    getHealth(projectId).then((h) => {
      if (h.hints?.length) setHints(h.hints);
    }).catch(() => {});
  }, [projectId]);

  const summary = useSummary(projectId);
  const overview = useOverview(projectId);
  const callSites = useCallSites(projectId);
  const events = useEvents(projectId, 100);
  const trends = useTrends(projectId, timeRange, groupByModel);
  const traces = useTraces(projectId);

  const showSearch = activeTab !== "overview";

  const selectTab = (tab: Tab) => {
    setActiveTab(tab);
    setSearch("");
    if (!demoMode) analytics.capture("dashboard_tab_viewed", { tab, project_id: projectId });
  };

  const dismissHint = (hint: HealthHint) => {
    setDismissedHints((prev) => new Set([...prev, hint.type]));
    if (!demoMode) analytics.capture("health_hint_dismissed", { hint_type: hint.type, project_id: projectId });
  };

  return (
    <main className="max-w-[1440px] mx-auto px-4 md:px-6 pt-5 pb-6 flex flex-col gap-0 min-h-[calc(100vh-56px)]">
      <AnomalyBanner projectId={projectId} />

      {/* Setup hints banner */}
      {hints.filter((h) => !dismissedHints.has(h.type)).map((hint) => (
        <div key={hint.type} className="bg-amber-muted border border-amber/20 rounded-sm px-4 py-3 flex items-center gap-3 mb-4">
          <AlertCircle size={16} className="text-amber shrink-0" />
          <p className="text-sm text-text-primary flex-1">{hint.message}</p>
          <a
            href={`https://costkey.dev${hint.link}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-xs font-medium text-accent hover:text-accent-hover shrink-0"
          >
            Setup guide <ExternalLink size={11} />
          </a>
          <button
            onClick={() => dismissHint(hint)}
            className="text-text-muted hover:text-text-secondary cursor-pointer shrink-0"
          >
            <X size={14} />
          </button>
        </div>
      ))}

      {/* Tab bar */}
      <div className="flex items-center gap-0 border-b border-border mb-5 overflow-x-auto">
        <div className="flex items-center gap-1">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => selectTab(tab.id)}
              className={`flex items-center gap-2 px-4 py-3 text-sm font-medium cursor-pointer transition-colors border-b-2 -mb-px whitespace-nowrap ${
                activeTab === tab.id
                  ? "text-text-primary border-text-primary"
                  : "text-text-muted hover:text-text-secondary border-transparent"
              }`}
            >
              {tab.icon}
              {tab.label}
            </button>
          ))}
        </div>

        {showSearch && (
          <div className="ml-auto flex items-center gap-2 bg-surface-raised border border-border rounded-sm px-3 py-2">
            <Search size={14} className="text-text-muted" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={`Search ${activeTab.replace("-", " ")}...`}
              className="bg-transparent text-sm text-text-primary placeholder:text-text-muted outline-none w-56"
            />
          </div>
        )}
      </div>

      {/* Tab content */}
      <div className="flex-1">
        {activeTab === "overview" && (
          !overview.loading && overview.data?.overview && overview.data.overview.total_calls === 0
            ? <EmptyState tab="overview" />
            : (
              <div className="flex flex-col gap-5">
                <SummaryView summary={summary.data} loading={summary.loading} />
                <StatCards overview={overview.data?.overview ?? null} loading={overview.loading} />
                <div className="grid grid-cols-1 md:grid-cols-[1fr_340px] gap-5">
                  <CostTrend
                    trends={trends.data?.trends ?? null}
                    byModel={trends.data?.byModel}
                    loading={trends.loading}
                    timeRange={timeRange}
                    onTimeRangeChange={(range) => {
                      setTimeRange(range);
                      if (!demoMode) analytics.capture("dashboard_time_range_changed", { range, project_id: projectId });
                    }}
                    groupByModel={groupByModel}
                    onGroupByModelChange={(enabled) => {
                      setGroupByModel(enabled);
                      if (!demoMode) analytics.capture("dashboard_model_grouping_changed", { enabled, project_id: projectId });
                    }}
                  />
                  <ModelBreakdown models={overview.data?.byModel ?? null} loading={overview.loading} />
                </div>
              </div>
            )
        )}

        {activeTab === "insights" && (
          <InsightsView projectId={projectId} />
        )}

        {activeTab === "traces" && (
          !traces.loading && traces.data && traces.data.length === 0
            ? <EmptyState tab="traces" />
            : <TracesView traces={traces.data} loading={traces.loading} projectId={projectId} search={search} />
        )}

        {activeTab === "call-sites" && (
          !callSites.loading && callSites.data && callSites.data.length === 0
            ? <EmptyState tab="call-sites" />
            : <CallSitesTable callSites={callSites.data} loading={callSites.loading} search={search} projectId={projectId} />
        )}

        {activeTab === "events" && (
          !events.loading && events.data && events.data.length === 0
            ? <EmptyState tab="events" />
            : <RecentEvents events={events.data} loading={events.loading} search={search} projectId={projectId} demoMode={demoMode} />
        )}
      </div>
    </main>
  );
}
