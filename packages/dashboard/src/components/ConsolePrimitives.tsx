import { appUrl } from "../basePath";
import type { ReactNode } from "react";
import { ArrowDown, ArrowUp, GitCompareArrows, Minus, RefreshCw, X } from "lucide-react";
import { COMPARE_OPTIONS, metricChange, type CompareTo, type MetricChange } from "./compareScope";
import { PrototypeIcon, type PrototypeIconName } from "./PrototypeIcon";

export type Tone = "good" | "warn" | "critical" | "info" | "neutral";

/** Spot illustrations from the design language (480 x 320 viewBox SVGs). */
export type IllustrationName = "first-light" | "a-little-ahead" | "room-to-explore" | "a-closer-look" | "observation-note";

/** Spot art for onboarding, summaries and empty states. Never placed over live data. */
export function Illustration({ name, width = 200, className = "" }: { name: IllustrationName; width?: number; className?: string }) {
  return <img className={`ck-illustration ${className}`} src={appUrl(`/assets/illustrations/${name}.svg`)} width={width} height={Math.round(width * 2 / 3)} alt="" aria-hidden="true" draggable={false} />;
}

const STATUS_ICON: Record<Tone, PrototypeIconName> = { good: "check", warn: "alert", critical: "pause", info: "info", neutral: "info" };

/** One-line scoped status ("All tracked projects are within budget."). Always an icon and words. */
export function StatusLine({ tone = "good", children, right, onDismiss }: { tone?: Tone; children: ReactNode; right?: ReactNode; /** Shows a close button at the right edge. */ onDismiss?: () => void }) {
  return (
    <div className={`ck-status-line ck-status-line-${tone} ${onDismiss ? "is-dismissible" : ""}`} role="status">
      <span className="ck-status-line-text"><PrototypeIcon name={STATUS_ICON[tone]} size={16} />{children}</span>
      {(right || onDismiss) && <span className="ck-status-line-right">{right}{onDismiss && <button className="ck-status-line-close" type="button" aria-label="Dismiss this message" onClick={onDismiss}><X size={14} aria-hidden="true" /></button>}</span>}
    </div>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="ck-page-header">
      <div className="min-w-0">
        {eyebrow && <div className="ck-eyebrow">{eyebrow}</div>}
        <h1 className="ck-page-title">{title}</h1>
        {description && <p className="ck-page-description">{description}</p>}
      </div>
      {actions && <div className="ck-page-actions">{actions}</div>}
    </div>
  );
}

export type Period = "1h" | "today" | "24h" | "mtd" | "7d" | "30d" | "custom";

/**
 * Period and environment as compact pills for the page header. There is no
 * filter bar: pages put this in their header actions.
 */
const PERIOD_LABELS: Record<Period, string> = {
  "1h": "Last hour",
  today: "Today",
  "24h": "Last 24 hours",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  mtd: "Month to date",
  custom: "Custom range",
};
const DEFAULT_PERIODS: Period[] = ["mtd", "7d", "30d", "24h", "custom"];

export function ScopeToolbar({
  period,
  onPeriodChange,
  periods = DEFAULT_PERIODS,
  environment = "all",
  onEnvironmentChange,
  environmentOptions,
  customFrom,
  customTo,
  customTime = false,
  onCustomRangeChange,
  compare,
  chips,
  right,
}: {
  period: Period;
  onPeriodChange: (period: Period) => void;
  /** The periods offered, in order. */
  periods?: Period[];
  environment?: string;
  onEnvironmentChange?: (environment: string) => void;
  environmentOptions?: Array<{ value: string; label: string }>;
  customFrom?: string;
  customTo?: string;
  /** Custom ranges pick a time of day as well as a day (datetime-local values). */
  customTime?: boolean;
  onCustomRangeChange?: (from: string, to: string) => void;
  /** A Compare control, and anything that goes with the comparison (a deploy picker). */
  compare?: { value: CompareTo; onChange: (value: CompareTo) => void; deployAvailable?: boolean; detail?: ReactNode };
  currency?: string;
  currencyNote?: string;
  timezone?: string;
  chips?: ReactNode;
  right?: ReactNode;
}) {
  const environments = environmentOptions ?? [{ value: "all", label: "All environments" }];
  const showEnvironment = Boolean(onEnvironmentChange) && (environments.length > 1 || environment !== "all");
  const inputType = customTime ? "datetime-local" : "date";
  const trim = (value: string | undefined) => customTime ? value ?? "" : value?.slice(0, 10) ?? "";
  return (
    <div className="ck-scope-pills">
      {chips}
      {showEnvironment && <span className="ck-pill-select"><select aria-label="Environment" value={environment} onChange={(event) => onEnvironmentChange?.(event.target.value)}>{environments.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select><PrototypeIcon name="down" size={12} /></span>}
      <span className="ck-pill-select"><select aria-label="Period" value={period} onChange={(event) => onPeriodChange(event.target.value as Period)}>
        {(periods.includes(period) ? periods : [...periods, period]).map((value) => <option key={value} value={value}>{PERIOD_LABELS[value]}</option>)}
      </select><PrototypeIcon name="down" size={12} /></span>
      {period === "custom" && onCustomRangeChange && <span className="ck-scope-dates"><input aria-label="From" type={inputType} value={trim(customFrom)} max={trim(customTo) || undefined} onChange={(event) => onCustomRangeChange(event.target.value, trim(customTo) || event.target.value)} /><span aria-hidden="true">–</span><input aria-label="To" type={inputType} value={trim(customTo)} min={trim(customFrom) || undefined} onChange={(event) => onCustomRangeChange(trim(customFrom) || event.target.value, event.target.value)} /></span>}
      {compare && <span className={`ck-pill-select ck-compare-pill ${compare.value !== "off" ? "is-active" : ""}`}><GitCompareArrows size={13} aria-hidden="true" /><select aria-label="Compare" value={compare.value} onChange={(event) => compare.onChange(event.target.value as CompareTo)}>
        {COMPARE_OPTIONS.map((option) => <option key={option.value} value={option.value} disabled={option.value === "deploy" && compare.deployAvailable === false}>{option.value === "deploy" && compare.deployAvailable === false ? "vs previous deploy (no deploys yet)" : option.label}</option>)}
      </select><PrototypeIcon name="down" size={12} /></span>}
      {compare?.detail}
      {right}
    </div>
  );
}

export function Panel({
  title,
  subtitle,
  actions,
  children,
  className = "",
  id,
}: {
  title?: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section className={`ck-panel ${className}`} id={id}>
      {(title || subtitle || actions) && (
        <header className="ck-panel-header">
          <div className="min-w-0">
            {title && <h2 className="ck-panel-title">{title}</h2>}
            {subtitle && <p className="ck-panel-subtitle">{subtitle}</p>}
          </div>
          {actions && <div className="ck-panel-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function MetricCard({
  label,
  value,
  detail,
  tone = "neutral",
  loading = false,
  icon,
  compare,
}: {
  label: string;
  value: string;
  detail?: ReactNode;
  tone?: Tone;
  loading?: boolean;
  icon?: PrototypeIconName;
  /** How the value moved against the comparison period (a CompareLine). */
  compare?: ReactNode;
}) {
  return (
    <article className="ck-metric-card">
      <div className="ck-metric-label"><span>{label}</span>{icon && <PrototypeIcon name={icon} size={16} />}</div>
      {loading ? <div className="ck-skeleton ck-skeleton-metric" /> : <div className={`ck-metric-value ck-tone-${tone}`}>{value}</div>}
      {detail && <div className="ck-metric-detail">{detail}</div>}
      {!loading && compare}
    </article>
  );
}

/** The change as a small badge: an arrow and the amount, green when better, amber when worse. */
export function ChangeBadge({ change }: { change: MetricChange }) {
  if (change.direction === "none") return null;
  if (change.direction === "same") return <span className="ck-change ck-change-flat">Same</span>;
  return <span className={`ck-change ck-change-${change.tone}`}>
    {change.direction === "up" ? <ArrowUp size={11} strokeWidth={2.5} aria-hidden="true" /> : <ArrowDown size={11} strokeWidth={2.5} aria-hidden="true" />}
    <span className="sr-only">{change.direction === "up" ? "Up" : "Down"} </span>{change.text}
  </span>;
}

/**
 * Under a number: how it moved and what it was. `against` names the
 * comparison ("the day before"); `hideChange` keeps the old value but drops
 * the badge, for totals over windows of different lengths.
 */
export function CompareLine({ current, previous, better, rate = false, format, against, hideChange = false, loading = false }: {
  current: number | null | undefined;
  previous: number | null | undefined;
  better: "lower" | "higher" | null;
  rate?: boolean;
  format: (value: number) => string;
  against: ReactNode;
  hideChange?: boolean;
  loading?: boolean;
}) {
  if (loading) return <div className="ck-compare-line"><span className="ck-skeleton ck-skeleton-inline" /></div>;
  const change = hideChange ? null : metricChange(current, previous, better, rate);
  return <div className="ck-compare-line">
    {change && <ChangeBadge change={change} />}
    <span className="ck-compare-was">vs {previous == null ? "none" : format(previous)} {against}</span>
  </div>;
}

/** Status pill: icon and words, never color alone. Pass `icon={false}` for a plain label. */
export function StatusPill({ tone = "neutral", children, icon }: { tone?: Tone; children: ReactNode; icon?: PrototypeIconName | false }) {
  const glyph = icon === false ? null : icon ?? (tone === "good" ? "check" : tone === "warn" ? "alert" : tone === "critical" ? "pause" : null);
  return <span className={`ck-status-pill ck-status-${tone}`}>{glyph && <PrototypeIcon name={glyph} size={13} />}{children}</span>;
}

/** Period-over-period change in words ("12.4% lower than last month"). */
export function Delta({ value, comparison = "the previous period" }: { value: number | null | undefined; comparison?: string }) {
  if (value == null || !Number.isFinite(Number(value))) {
    // Nothing earlier to compare with: say nothing rather than filler.
    return null;
  }
  const numeric = Number(value);
  if (Math.abs(numeric) < 0.05) {
    return <span className="ck-delta ck-delta-neutral"><Minus size={12} aria-hidden="true" /> Same as {comparison}</span>;
  }
  const rising = numeric > 0;
  return (
    <span className={`ck-delta ${rising ? "ck-delta-warn" : "ck-delta-good"}`}>
      {rising ? <ArrowUp size={12} aria-hidden="true" /> : <ArrowDown size={12} aria-hidden="true" />}
      {Math.abs(numeric).toFixed(1)}% {rising ? "higher" : "lower"} than {comparison}
    </span>
  );
}

export function LoadingRows({ count = 5, columns = 4 }: { count?: number; columns?: number }) {
  return (
    <div className="ck-loading-rows" aria-label="Loading">
      {Array.from({ length: count }, (_, row) => (
        <div className="ck-loading-row" key={row}>
          {Array.from({ length: columns }, (_, column) => (
            <span className={`ck-skeleton ${column === 0 ? "ck-skeleton-wide" : ""}`} key={column} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function EmptyPanel({
  title,
  body,
  action,
  icon,
  illustration,
}: {
  title: string;
  body?: string;
  action?: ReactNode;
  icon?: ReactNode;
  illustration?: IllustrationName;
}) {
  return (
    <div className="ck-empty-panel">
      {illustration ? <Illustration name={illustration} width={220} className="ck-empty-art" /> : icon && <div className="ck-empty-icon">{icon}</div>}
      <h2 className="ck-empty-title">{title}</h2>
      {body && <p className="ck-empty-body">{body}</p>}
      {action && <div className="ck-empty-action">{action}</div>}
    </div>
  );
}

export function RefreshButton({ onClick, loading = false }: { onClick: () => void; loading?: boolean }) {
  return (
    <button className="ck-button ck-button-quiet ck-refresh-button" onClick={onClick} disabled={loading} type="button">
      <RefreshCw size={14} className={loading ? "ck-spin" : ""} aria-hidden="true" />
      {loading ? "Updating" : "Refresh"}
    </button>
  );
}
