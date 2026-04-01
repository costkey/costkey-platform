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

export default function Dashboard() {
  const { currentProjectId } = useAuth();
  const projectId = currentProjectId ?? "proj_demo";

  const overview = useOverview(projectId);
  const callSites = useCallSites(projectId);
  const events = useEvents(projectId, 25);
  const trends = useTrends(projectId);
  const features = useFeatures(projectId);
  const traces = useTraces(projectId);

  return (
    <main className="max-w-[1400px] mx-auto px-6 py-6 flex flex-col gap-4">
      <AnomalyBanner projectId={projectId} />

      <StatCards
        overview={overview.data?.overview ?? null}
        loading={overview.loading}
      />

      <div className="grid grid-cols-[1fr_340px] gap-4">
        <CostTrend trends={trends.data} loading={trends.loading} />
        <ModelBreakdown models={overview.data?.byModel ?? null} loading={overview.loading} />
      </div>

      <FeatureTree features={features.data} loading={features.loading} />

      <TracesView traces={traces.data} loading={traces.loading} projectId={projectId} />

      <CallSitesTable callSites={callSites.data} loading={callSites.loading} />

      <RecentEvents events={events.data} loading={events.loading} />
    </main>
  );
}
