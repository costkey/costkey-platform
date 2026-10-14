import { useEffect, useId, useRef, useState } from "react";
import { Clock, GitCommitHorizontal } from "lucide-react";
import type { Release } from "../api";
import { periodLabel, type ConsolePeriod } from "./consoleFormatters";
import { PrototypeIcon } from "./PrototypeIcon";
import { shortRelease } from "./releasesModel";

const QUICK_LABELS: Record<string, string> = {
  "15m": "15 min", "30m": "30 min", "1h": "1 hour", "3h": "3 hours", "6h": "6 hours", "12h": "12 hours",
  "24h": "24 hours", "3d": "3 days", "7d": "7 days", "14d": "14 days", "30d": "30 days", "90d": "90 days",
  today: "Today", mtd: "This month",
};

type Unit = "m" | "h" | "d" | "w";
const UNITS: Array<{ value: Unit; label: string }> = [
  { value: "m", label: "minutes" }, { value: "h", label: "hours" }, { value: "d", label: "days" }, { value: "w", label: "weeks" },
];

function sentence(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "3h ago", "2d ago". */
function ago(iso: string, now: number): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** "14 Oct, 09:30" from a datetime-local value, or "14 Oct" from a date. */
function inputLabel(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}:\d{2}))?/.exec(value);
  if (!match) return value;
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(match[2]) - 1];
  return `${Number(match[3])} ${month}${match[4] ? `, ${match[4]}` : ""}`;
}

export interface TimeRangePickerProps {
  period: ConsolePeriod;
  onPeriodChange: (period: ConsolePeriod) => void;
  /** Quick picks, in order. */
  quick: ConsolePeriod[];
  /** Offer "last N minutes/hours/days/weeks". */
  customRelative?: boolean;
  /** A custom range. Values are datetime-local strings with `withTime`, dates without. */
  absolute?: { from?: string; to?: string; withTime: boolean; onApply: (from: string, to: string) => void };
  /** Offer "since the last deploy", starting at that release's first call. */
  deploy?: { release: Release | null; loaded: boolean };
  /** Shown under the custom range, e.g. "Asia/Kolkata". */
  timezone?: string | null;
}

/** One control for the time a page covers: rolling windows, since the last deploy, or any range of days and times. */
export function TimeRangePicker({ period, onPeriodChange, quick, customRelative = false, absolute, deploy, timezone }: TimeRangePickerProps) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"relative" | "absolute">(period === "custom" ? "absolute" : "relative");
  const [amount, setAmount] = useState("45");
  const [unit, setUnit] = useState<Unit>("m");
  const [range, setRange] = useState({ fromDay: "", fromTime: "00:00", toDay: "", toTime: "23:59" });
  const [now, setNow] = useState(() => Date.now());
  const root = useRef<HTMLDivElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => { if (root.current && !root.current.contains(event.target as Node)) setOpen(false); };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("pointerdown", onPointer); document.removeEventListener("keydown", onKey); };
  }, [open]);

  const toggle = () => {
    if (!open) {
      // Start the form from what's on screen.
      const split = (value: string | undefined, fallbackTime: string) => ({ day: value?.slice(0, 10) ?? "", time: value && value.length >= 16 ? value.slice(11, 16) : fallbackTime });
      const from = split(absolute?.from, "00:00");
      const to = split(absolute?.to, "23:59");
      setRange({ fromDay: from.day, fromTime: from.time, toDay: to.day, toTime: to.time });
      setTab(period === "custom" ? "absolute" : "relative");
      setNow(Date.now());
    }
    setOpen((value) => !value);
  };
  const pick = (next: ConsolePeriod) => { onPeriodChange(next); setOpen(false); };

  const release = deploy?.release ?? null;
  const label = period === "custom" && absolute?.from && absolute.to
    ? `${inputLabel(absolute.from)} – ${inputLabel(absolute.to)}`
    : period === "deploy"
      ? release ? `Since deploy ${shortRelease(release.release)}` : "Since the last deploy"
      : QUICK_LABELS[period] && !["today", "mtd"].includes(period) ? `Last ${QUICK_LABELS[period]}` : sentence(periodLabel(period));

  const customValid = Number.isInteger(Number(amount)) && Number(amount) >= 1 && Number(amount) <= 9999;
  const withTime = absolute?.withTime ?? false;
  const from = withTime ? `${range.fromDay}T${range.fromTime}` : range.fromDay;
  const to = withTime ? `${range.toDay}T${range.toTime}` : range.toDay;
  const rangeValid = Boolean(range.fromDay && range.toDay) && from <= to && (withTime ? from < to : true);

  return (
    <div className="ck-trp" ref={root}>
      <button type="button" className={`ck-trp-trigger ${open ? "is-open" : ""}`} aria-haspopup="dialog" aria-expanded={open} aria-controls={panelId} onClick={toggle}>
        <Clock size={13} aria-hidden="true" />
        <span className="ck-trp-label">{label}</span>
        <PrototypeIcon name="down" size={12} />
      </button>
      {open && <div className="ck-trp-panel" id={panelId} role="dialog" aria-label="Time range">
        {absolute && <div className="ck-trp-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === "relative"} className={tab === "relative" ? "active" : ""} onClick={() => setTab("relative")}>Relative</button>
          <button type="button" role="tab" aria-selected={tab === "absolute"} className={tab === "absolute" ? "active" : ""} onClick={() => setTab("absolute")}>Absolute</button>
        </div>}

        {tab === "relative" ? <>
          {deploy && <button type="button" className={`ck-trp-deploy ${period === "deploy" ? "active" : ""}`} disabled={!release} onClick={() => pick("deploy")}>
            <span className="ck-trp-deploy-title">Since the last deploy</span>
            {release
              ? <span className="ck-trp-deploy-meta"><span className="ck-release"><GitCommitHorizontal size={12} aria-hidden="true" />{shortRelease(release.release)}</span>{ago(release.firstSeen, now)}</span>
              : <span className="ck-trp-deploy-meta">{deploy.loaded ? "No deploys recorded yet" : "Finding the last deploy…"}</span>}
          </button>}
          <div className="ck-trp-grid">
            {quick.filter((value) => value !== "custom" && value !== "deploy").map((value) => (
              <button key={value} type="button" className={period === value ? "active" : ""} aria-pressed={period === value} onClick={() => pick(value)}>{QUICK_LABELS[value] ?? sentence(periodLabel(value).replace(/^last /, ""))}</button>
            ))}
          </div>
          {customRelative && <form className="ck-trp-custom" onSubmit={(event) => { event.preventDefault(); if (customValid) pick(`${Number(amount)}${unit}`); }}>
            <span>Last</span>
            <input aria-label="Amount" type="number" min={1} max={9999} value={amount} onChange={(event) => setAmount(event.target.value)} />
            <select aria-label="Unit" value={unit} onChange={(event) => setUnit(event.target.value as Unit)}>{UNITS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select>
            <button type="submit" className="ck-button ck-button-secondary" disabled={!customValid}>Apply</button>
          </form>}
        </> : absolute && <form className="ck-trp-absolute" onSubmit={(event) => { event.preventDefault(); if (rangeValid) { absolute.onApply(from, to); setOpen(false); } }}>
          <label><span>Start</span><span className="ck-trp-fields"><input type="date" aria-label="Start date" value={range.fromDay} max={range.toDay || undefined} onChange={(event) => setRange({ ...range, fromDay: event.target.value })} />{withTime && <input type="time" aria-label="Start time" value={range.fromTime} onChange={(event) => setRange({ ...range, fromTime: event.target.value })} />}</span></label>
          <label><span>End</span><span className="ck-trp-fields"><input type="date" aria-label="End date" value={range.toDay} min={range.fromDay || undefined} onChange={(event) => setRange({ ...range, toDay: event.target.value })} />{withTime && <input type="time" aria-label="End time" value={range.toTime} onChange={(event) => setRange({ ...range, toTime: event.target.value })} />}</span></label>
          {timezone && <p className="ck-trp-note">Times in {timezone}.</p>}
          <div className="ck-trp-actions">
            <button type="button" className="ck-button ck-button-quiet" onClick={() => setOpen(false)}>Cancel</button>
            <button type="submit" className="ck-button ck-button-primary" disabled={!rangeValid}>Apply</button>
          </div>
        </form>}
      </div>}
    </div>
  );
}
