import type { ReactNode } from "react";
import { ArrowDown, ArrowUp, Minus, RefreshCw } from "lucide-react";
import { PrototypeIcon, type PrototypeIconName } from "./PrototypeIcon";

export type Tone = "good" | "warn" | "critical" | "info" | "neutral";

/** Spot illustrations from the design language (480 x 320 viewBox SVGs). */
export type IllustrationName = "first-light" | "a-little-ahead" | "room-to-explore" | "a-closer-look" | "observation-note";

/** Spot art for onboarding, summaries and empty states. Never placed over live data. */
export function Illustration({ name, width = 200, className = "" }: { name: IllustrationName; width?: number; className?: string }) {
  return <img className={`ck-illustration ${className}`} src={`/assets/illustrations/${name}.svg`} width={width} height={Math.round(width * 2 / 3)} alt="" aria-hidden="true" draggable={false} />;
}

const STATUS_ICON: Record<Tone, PrototypeIconName> = { good: "check", warn: "alert", critical: "pause", info: "info", neutral: "info" };

/** One-line scoped status ("All tracked projects are within budget."). Always an icon and words. */
export function StatusLine({ tone = "good", children, right }: { tone?: Tone; children: ReactNode; right?: ReactNode }) {
  return (
    <div className={`ck-status-line ck-status-line-${tone}`} role="status">
      <span className="ck-status-line-text"><PrototypeIcon name={STATUS_ICON[tone]} size={16} />{children}</span>
      {right && <span className="ck-status-line-right">{right}</span>}
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

export type Period = "24h" | "mtd" | "7d" | "30d" | "custom";

/**
 * Period and environment as compact pills for the page header. There is no
 * filter bar: pages put this in their header actions.
 */
export function ScopeToolbar({
  period,
  onPeriodChange,
  environment = "all",
  onEnvironmentChange,
  environmentOptions,
  customFrom,
  customTo,
  onCustomRangeChange,
  chips,
  right,
}: {
  period: Period;
  onPeriodChange: (period: Period) => void;
  environment?: string;
  onEnvironmentChange?: (environment: string) => void;
  environmentOptions?: Array<{ value: string; label: string }>;
  customFrom?: string;
  customTo?: string;
  onCustomRangeChange?: (from: string, to: string) => void;
  currency?: string;
  currencyNote?: string;
  timezone?: string;
  chips?: ReactNode;
  right?: ReactNode;
}) {
  const environments = environmentOptions ?? [{ value: "all", label: "All environments" }];
  const showEnvironment = Boolean(onEnvironmentChange) && (environments.length > 1 || environment !== "all");
  return (
    <div className="ck-scope-pills">
      {chips}
      {showEnvironment && <span className="ck-pill-select"><select aria-label="Environment" value={environment} onChange={(event) => onEnvironmentChange?.(event.target.value)}>{environments.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select><PrototypeIcon name="down" size={12} /></span>}
      <span className="ck-pill-select"><select aria-label="Period" value={period} onChange={(event) => onPeriodChange(event.target.value as Period)}>
        <option value="mtd">Month to date</option>
        <option value="7d">Last 7 days</option>
        <option value="30d">Last 30 days</option>
        <option value="24h">Last 24 hours</option>
        <option value="custom">Custom range</option>
      </select><PrototypeIcon name="down" size={12} /></span>
      {period === "custom" && onCustomRangeChange && <span className="ck-scope-dates"><input aria-label="From" type="date" value={customFrom?.slice(0, 10) ?? ""} onChange={(event) => onCustomRangeChange(event.target.value, customTo?.slice(0, 10) ?? event.target.value)} /><span aria-hidden="true">–</span><input aria-label="To" type="date" value={customTo?.slice(0, 10) ?? ""} onChange={(event) => onCustomRangeChange(customFrom?.slice(0, 10) ?? event.target.value, event.target.value)} /></span>}
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
}: {
  label: string;
  value: string;
  detail?: ReactNode;
  tone?: Tone;
  loading?: boolean;
  icon?: PrototypeIconName;
}) {
  return (
    <article className="ck-metric-card">
      <div className="ck-metric-label"><span>{label}</span>{icon && <PrototypeIcon name={icon} size={16} />}</div>
      {loading ? <div className="ck-skeleton ck-skeleton-metric" /> : <div className={`ck-metric-value ck-tone-${tone}`}>{value}</div>}
      {detail && <div className="ck-metric-detail">{detail}</div>}
    </article>
  );
}

/** Status pill: icon and words, never color alone. Pass `icon={false}` for a plain label. */
export function StatusPill({ tone = "neutral", children, icon }: { tone?: Tone; children: ReactNode; icon?: PrototypeIconName | false }) {
  const glyph = icon === false ? null : icon ?? (tone === "good" ? "check" : tone === "warn" ? "alert" : tone === "critical" ? "pause" : null);
  return <span className={`ck-status-pill ck-status-${tone}`}>{glyph && <PrototypeIcon name={glyph} size={13} />}{children}</span>;
}

/** Period-over-period change in words ("12.4% lower than last month"). */
export function Delta({ value, comparison = "the previous period" }: { value: number | null | undefined; comparison?: string }) {
  if (value == null || !Number.isFinite(Number(value))) {
    return <span className="ck-delta ck-delta-neutral">No earlier period to compare</span>;
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
