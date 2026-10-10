import { useEffect, useState } from "react";
import { ArrowLeft, CircleAlert } from "lucide-react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { acknowledgeFinding, getFinding, type FindingResponse } from "../api";
import { useAuth } from "../contexts/useAuth";
import { EmptyPanel, PageHeader, Panel } from "../components/ConsolePrimitives";
import { FindingBody } from "../components/FindingBody";
import { formatReportedAmount } from "../components/consoleFormatters";

export default function Finding() {
  const { currentProjectId, projects, user, workspaceSettings, setCurrentProjectId } = useAuth();
  const projectId = currentProjectId ?? projects[0]?.id ?? null;
  const reportingCurrency = workspaceSettings?.reportingCurrency ?? "USD";
  const fx = workspaceSettings?.fx;
  const { findingId } = useParams();
  const [searchParams] = useSearchParams();
  const requestedProjectId = searchParams.get("project");
  const requestedProject = requestedProjectId ? projects.find((project) => project.id === requestedProjectId) : undefined;
  const [finding, setFinding] = useState<FindingResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [acknowledging, setAcknowledging] = useState(false);

  useEffect(() => {
    if (requestedProject && requestedProject.id !== currentProjectId) setCurrentProjectId(requestedProject.id);
  }, [requestedProject, currentProjectId, setCurrentProjectId]);

  useEffect(() => {
    if (!projectId || !findingId || (requestedProject && requestedProject.id !== currentProjectId)) return;
    let cancelled = false;
    setLoading(true); setError(null);
    getFinding(projectId, findingId).then((result) => { if (!cancelled) setFinding(result.finding); }).catch(() => { if (!cancelled) setError("It may have been removed, or it belongs to a project you can’t open."); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [projectId, findingId, requestedProject, currentProjectId]);

  async function acknowledge(): Promise<void> {
    if (!projectId || !findingId || !finding || finding.state === "acknowledged") return;
    setAcknowledging(true); setError(null);
    try { await acknowledgeFinding(projectId, findingId); setFinding({ ...finding, state: "acknowledged", acknowledgedAt: new Date().toISOString(), acknowledgedBy: user?.id ?? null }); } catch { setError("Couldn’t save that. Try again."); } finally { setAcknowledging(false); }
  }

  const back = <Link className="ck-back-link" to="/"><ArrowLeft size={13} aria-hidden="true" /> Overview</Link>;
  if (requestedProject && requestedProject.id !== currentProjectId) return <div className="ck-main-inner"><PageHeader title="Opening…" /><Panel><div style={{ padding: 20 }}><span className="ck-skeleton" style={{ width: "70%", height: 18 }} /></div></Panel></div>;
  if (!projectId || !findingId) return <div className="ck-main-inner">{back}<PageHeader title="Nothing selected" /><Panel><EmptyPanel title="Nothing to look at here" body="Open a flagged change from the Overview." action={<Link className="ck-button ck-button-secondary" to="/">Go to Overview</Link>} icon={<CircleAlert size={20} />} /></Panel></div>;
  if (loading) return <div className="ck-main-inner">{back}<Panel><div style={{ padding: 20 }}><span className="ck-skeleton" style={{ width: "70%", height: 18 }} /><span className="ck-skeleton" style={{ width: "45%", marginTop: 12 }} /></div></Panel></div>;
  if (!finding) return <div className="ck-main-inner">{back}<PageHeader title="Couldn’t open this" /><Panel><EmptyPanel title="Couldn’t open this change" body={error ?? "It may have been removed, or it belongs to a project you can’t open."} icon={<CircleAlert size={20} />} /></Panel></div>;
  return (
    <div className="ck-main-inner ck-finding-page">
      {back}
      {error && <div className="ck-alert ck-alert-error" role="alert"><CircleAlert size={15} /><div>{error}</div></div>}
      <section className="ck-panel ck-finding-panel">
        <FindingBody finding={finding} projectId={projectId} money={(value) => formatReportedAmount(value, reportingCurrency, fx)} canAcknowledge={user?.role !== "viewer"} acknowledging={acknowledging} onAcknowledge={() => void acknowledge()} />
      </section>
    </div>
  );
}
