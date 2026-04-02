import { useState } from "react";
import { BarChart3, Route, FileCode, Activity, Search } from "lucide-react";
import AnomalyBanner from "../components/AnomalyBanner";
import SummaryView from "../components/SummaryView";
import StatCards from "../components/StatCards";
import CostTrend from "../components/CostTrend";
import CallSitesTable from "../components/CallSitesTable";
import ModelBreakdown from "../components/ModelBreakdown";
import TracesView from "../components/TracesView";
import RecentEvents from "../components/RecentEvents";
import EmptyState from "../components/EmptyState";
import { useSummary, useOverview, useCallSites, useEvents, useTrends, useTraces } from "../hooks/useApi";
import { useAuth } from "../contexts/AuthContext";

type Tab = "overview" | "traces" | "call-sites" | "events";

const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: "overview", label: "Overview", icon: <BarChart3 size={14} /> },
  { id: "traces", label: "Traces", icon: <Route size={14} /> },
  { id: "call-sites", label: "Call Sites", icon: <FileCode size={14} /> },
  { id: "events", label: "Events", icon: <Activity size={14} /> },
];

export default function Dashboard() {
  const { currentProjectId } = useAuth();
  const projectId = currentProjectId ?? "proj_demo";
  const [activeTab, setActiveTab] = useState<Tab>("overview");
  const [search, setSearch] = useState("");

  const summary = useSummary(projectId);
  const overview = useOverview(projectId);
  const callSites = useCallSites(projectId);
  const events = useEvents(projectId, 100);
  const trends = useTrends(projectId);
  const traces = useTraces(projectId);

  const showSearch = activeTab !== "overview";

  return (
    <main className="max-w-[1440px] mx-auto px-5 pt-3 pb-2 flex flex-col gap-0 min-h-[calc(100vh-56px)]">
      <AnomalyBanner projectId={projectId} />

      {/* Tab bar */}
      <div className="flex items-center gap-0 border-b border-border mb-4">
        <div className="flex items-center gap-0">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => { setActiveTab(tab.id); setSearch(""); }}
              className={`flex items-center gap-2 px-5 py-3 text-sm font-medium cursor-pointer transition-colors border-b-2 -mb-px ${
                activeTab === tab.id
                  ? "text-accent border-accent"
                  : "text-text-muted hover:text-text-secondary border-transparent"
              }`}
            >
              {tab.icon}
              {tab.label}
            </button>
          ))}
        </div>

        {showSearch && (
          <div className="ml-auto flex items-center gap-2 bg-surface-raised border border-border rounded-sm px-3 py-2 mb-1">
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
              <div className="flex flex-col gap-4">
                <SummaryView summary={summary.data} loading={summary.loading} />
                <StatCards overview={overview.data?.overview ?? null} loading={overview.loading} />
                <div className="grid grid-cols-[1fr_340px] gap-4">
                  <CostTrend trends={trends.data} loading={trends.loading} />
                  <ModelBreakdown models={overview.data?.byModel ?? null} loading={overview.loading} />
                </div>
              </div>
            )
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
            : <RecentEvents events={events.data} loading={events.loading} search={search} projectId={projectId} />
        )}
      </div>
    </main>
  );
}
