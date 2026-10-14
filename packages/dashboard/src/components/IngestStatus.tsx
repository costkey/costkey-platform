import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getHealth, type PipelineHealth } from "../api";
import { useLiveQuery } from "../hooks/useLiveQuery";
import { formatDateTime } from "./consoleFormatters";

export type IngestTone = "live" | "idle" | "warn" | "error";

/** The project's ingest health in a word, a tone and a hover line. */
export function ingestStatus(health: PipelineHealth | null, now: number): { tone: IngestTone; label: string; detail: string } {
  if (!health) return { tone: "idle", label: "Checking data", detail: "Checking the project’s connection" };
  const failed = health.failedLastHour ?? 0;
  const share = health.eventsLastHour > 0 ? failed / health.eventsLastHour : 0;
  const ago = health.lastEventAt ? Math.max(0, Math.round((now - new Date(health.lastEventAt).getTime()) / 1000)) : null;
  const agoText = ago == null ? "" : ago < 60 ? `${ago} s ago` : ago < 3600 ? `${Math.round(ago / 60)} min ago` : null;
  const last = health.lastEventAt ? `Last event ${agoText ?? formatDateTime(health.lastEventAt)}` : "No events yet";
  if (failed > 0 && share >= 0.5) return { tone: "error", label: "Calls failing", detail: `${failed} of ${health.eventsLastHour} calls failed in the last hour. ${last}` };
  if (failed > 0 && share >= 0.1) return { tone: "warn", label: "Some calls failing", detail: `${failed} of ${health.eventsLastHour} calls failed in the last hour. ${last}` };
  if (health.status === "active") return { tone: "live", label: "Receiving data", detail: last };
  if (health.status === "no_data") return { tone: "idle", label: "No data yet", detail: "Send a request from your app to see it here" };
  return { tone: "idle", label: "Idle", detail: last };
}

/** A small live dot for the current project's ingest health, by the account block. */
export function IngestStatus({ projectId }: { projectId: string | null }) {
  const { data } = useLiveQuery(projectId ? `health|${projectId}` : null, () => getHealth(projectId!, true));
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => window.clearInterval(timer);
  }, []);
  if (!projectId) return null;
  const status = ingestStatus(data ?? null, now);
  return <Link className={`ck-ingest-status is-${status.tone}`} to="/settings?section=projects" title={status.detail} aria-label={`${status.label}. ${status.detail}`}>
    <i aria-hidden="true" /><span>{status.label}</span>
  </Link>;
}
