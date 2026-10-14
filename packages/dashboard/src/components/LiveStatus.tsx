import { useEffect, useState } from "react";
import type { LiveStatus as Status } from "../hooks/liveQuery";

/** "Updated 5 s ago", "Reconnecting" or "Paused": a quiet note for a page header. */
export function liveStatusText(status: Status, updatedAt: number | null, now: number): string {
  if (status === "reconnecting") return "Reconnecting";
  if (status === "paused") return "Paused";
  if (updatedAt == null) return "Loading";
  const seconds = Math.max(0, Math.round((now - updatedAt) / 1000));
  if (seconds < 5) return "Updated just now";
  if (seconds < 60) return `Updated ${seconds} s ago`;
  const minutes = Math.round(seconds / 60);
  return `Updated ${minutes} min ago`;
}

/** A dot and one word: Live, Not live or Reconnecting. When it last updated is on hover. */
export function LiveStatus({ status, updatedAt, onRefresh }: { status: Status; updatedAt: number | null; onRefresh?: () => void }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => window.clearInterval(timer);
  }, []);
  const label = status === "live" ? "Live" : status === "reconnecting" ? "Reconnecting" : "Not live";
  const tone = status === "reconnecting" ? "is-warn" : status === "live" ? "is-live" : "is-off";
  const updated = updatedAt == null ? null : liveStatusText("live", updatedAt, now);
  return <button className={`ck-live-status ${tone}`} type="button" onClick={onRefresh} title={`${updated ? `${updated}. ` : ""}Click to refresh now.`} aria-live="polite">
    <i aria-hidden="true" />{label}
  </button>;
}
