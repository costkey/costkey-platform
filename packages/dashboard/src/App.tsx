import { Hexagon } from "lucide-react";
import StatCards from "./components/StatCards";
import CostTrend from "./components/CostTrend";
import CallSitesTable from "./components/CallSitesTable";
import ModelBreakdown from "./components/ModelBreakdown";
import FeatureTree from "./components/FeatureTree";
import TracesView from "./components/TracesView";
import RecentEvents from "./components/RecentEvents";
import { useOverview, useCallSites, useEvents, useTrends, useFeatures, useTraces } from "./hooks/useApi";

const PROJECT_ID = "proj_demo";

export default function App() {
  const overview = useOverview(PROJECT_ID);
  const callSites = useCallSites(PROJECT_ID);
  const events = useEvents(PROJECT_ID, 25);
  const trends = useTrends(PROJECT_ID);
  const features = useFeatures(PROJECT_ID);
  const traces = useTraces(PROJECT_ID);

  return (
    <div className="min-h-screen bg-surface">
      {/* Header */}
      <header className="scanline-effect relative border-b border-border bg-surface-raised/50 backdrop-blur-sm sticky top-0 z-50">
        <div className="max-w-[1400px] mx-auto px-6 h-14 flex items-center gap-4">
          {/* Logo */}
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 bg-accent-muted border border-accent/30 rounded-sm flex items-center justify-center">
              <Hexagon size={14} className="text-accent" />
            </div>
            <span className="font-mono text-sm font-semibold text-text-primary tracking-tight">
              CostKey
            </span>
          </div>

          {/* Separator */}
          <div className="w-px h-5 bg-border" />

          {/* Project name */}
          <span className="font-mono text-xs text-text-muted">
            Demo App
          </span>

          {/* Right side */}
          <div className="ml-auto flex items-center gap-3">
            <div className="flex items-center gap-1.5">
              <div className="w-1.5 h-1.5 rounded-full bg-green glow-dot" />
              <span className="text-[11px] text-text-muted font-mono">collecting</span>
            </div>
            <div className="flex bg-surface-overlay border border-border rounded-sm overflow-hidden">
              {["24h", "7d", "30d"].map((period, i) => (
                <button
                  key={period}
                  className={`px-3 py-1.5 text-xs font-mono transition-colors cursor-pointer ${
                    i === 1
                      ? "bg-accent-muted text-accent border-accent/20"
                      : "text-text-muted hover:text-text-secondary"
                  } ${i > 0 ? "border-l border-border" : ""}`}
                >
                  {period}
                </button>
              ))}
            </div>
          </div>
        </div>
      </header>

      {/* Dashboard content */}
      <main className="max-w-[1400px] mx-auto px-6 py-6 flex flex-col gap-4">
        {/* Stat cards */}
        <StatCards
          overview={overview.data?.overview ?? null}
          loading={overview.loading}
        />

        {/* Cost trend + Model breakdown side by side */}
        <div className="grid grid-cols-[1fr_340px] gap-4">
          <CostTrend
            trends={trends.data}
            loading={trends.loading}
          />
          <ModelBreakdown
            models={overview.data?.byModel ?? null}
            loading={overview.loading}
          />
        </div>

        {/* Auto-detected features — THE hero */}
        <FeatureTree
          features={features.data}
          loading={features.loading}
        />

        {/* Traces — request-level cost grouping */}
        <TracesView
          traces={traces.data}
          loading={traces.loading}
          projectId={PROJECT_ID}
        />

        {/* Call sites table — flat view */}
        <CallSitesTable
          callSites={callSites.data}
          loading={callSites.loading}
        />

        {/* Recent events */}
        <RecentEvents
          events={events.data}
          loading={events.loading}
        />
      </main>

      {/* Footer */}
      <footer className="border-t border-border mt-8">
        <div className="max-w-[1400px] mx-auto px-6 py-4 flex items-center justify-between">
          <span className="font-mono text-[11px] text-text-muted">
            costkey v0.0.1
          </span>
          <span className="font-mono text-[11px] text-text-muted">
            Sentry for AI costs
          </span>
        </div>
      </footer>
    </div>
  );
}
