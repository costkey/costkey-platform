import { useState } from "react";
import { BarChart3, GitBranch, Route, FileCode, Activity, Search } from "lucide-react";
import AnomalyBanner from "../components/AnomalyBanner";
import StatCards from "../components/StatCards";
import CostTrend from "../components/CostTrend";
import CallSitesTable from "../components/CallSitesTable";
import ModelBreakdown from "../components/ModelBreakdown";
import FeatureTree from "../components/FeatureTree";
import TracesView from "../components/TracesView";
import RecentEvents from "../components/RecentEvents";
import { useOverview, useCallSites, useEvents, useTrends, useFeatures, useTraces } from "../hooks/useApi";
import { useAuth } from "../contexts/AuthContext";

type Tab = "overview" | "features" | "traces" | "call-sites" | "events";

const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: "overview", label: "Overview", icon: <BarChart3 size={13} /> },
  { id: "features", label: "Features", icon: <GitBranch size={13} /> },
  { id: "traces", label: "Traces", icon: <Route size={13} /> },
  { id: "call-sites", label: "Call Sites", icon: <FileCode size={13} /> },
  { id: "events", label: "Events", icon: <Activity size={13} /> },
];

export default function Dashboard() {
  const { currentProjectId } = useAuth();
  const projectId = currentProjectId ?? "proj_demo";
  const [activeTab, setActiveTab] = useState<Tab>("overview");
  const [search, setSearch] = useState("");

  const overview = useOverview(projectId);
  const callSites = useCallSites(projectId);
  const events = useEvents(projectId, 50);
  const trends = useTrends(projectId);
  const features = useFeatures(projectId);
  const traces = useTraces(projectId);

  const showSearch = activeTab !== "overview";

  return (
    <main className="max-w-[1440px] mx-auto px-4 py-3 flex flex-col gap-3">
      <AnomalyBanner projectId={projectId} />

      {/* Tab bar */}
      <div className="flex items-center gap-0 border-b border-border">
        <div className="flex items-center gap-0">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => { setActiveTab(tab.id); setSearch(""); }}
              className={`flex items-center gap-1.5 px-4 py-2 font-mono text-xs tracking-wide cursor-pointer transition-colors border-b-2 -mb-px ${
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

        {/* Search */}
        {showSearch && (
          <div className="ml-auto flex items-center gap-1.5 bg-surface-raised border border-border rounded-sm px-2.5 py-1.5">
            <Search size={12} className="text-text-muted" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={`Search ${activeTab.replace("-", " ")}...`}
              className="bg-transparent text-xs font-mono text-text-primary placeholder:text-text-muted outline-none w-48"
            />
          </div>
        )}
      </div>

      {/* Tab content */}
      {activeTab === "overview" && (
        <div className="flex flex-col gap-3">
          <StatCards
            overview={overview.data?.overview ?? null}
            loading={overview.loading}
          />
          <div className="grid grid-cols-[1fr_320px] gap-3">
            <CostTrend trends={trends.data} loading={trends.loading} />
            <ModelBreakdown models={overview.data?.byModel ?? null} loading={overview.loading} />
          </div>
        </div>
      )}

      {activeTab === "features" && (
        <FeatureTree features={features.data} loading={features.loading} search={search} />
      )}

      {activeTab === "traces" && (
        <TracesView traces={traces.data} loading={traces.loading} projectId={projectId} search={search} />
      )}

      {activeTab === "call-sites" && (
        <CallSitesTable callSites={callSites.data} loading={callSites.loading} search={search} />
      )}

      {activeTab === "events" && (
        <RecentEvents events={events.data} loading={events.loading} search={search} />
      )}
    </main>
  );
}
