import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Info } from "lucide-react";
import { costLineWords, otherCostLabel, getModelDetail, type CostBreakdownData } from "../modelDetailApi";

type Money = (value: number | null | undefined) => string;

/** How a cost adds up: each component, its quantity, its rate and what it came to. */
export function CostBreakdownTable({ breakdown, money, caption }: { breakdown: CostBreakdownData; money: Money; caption?: string }) {
  const rows = breakdown.lines.filter((line) => line.quantity > 0);
  if (rows.length === 0 && breakdown.other.length === 0) return null;
  return <div className="ck-cost-breakdown">
    {caption && <div className="ck-cost-breakdown-caption">{caption}</div>}
    <table>
      <tbody>
        {rows.map((line) => {
          const words = costLineWords(line);
          return <tr key={`${line.component}:${line.rate}:${line.tier ?? ""}`}>
            <td><span className="ck-cost-breakdown-label">{words.label}</span><small>{words.quantity} at {words.rate}</small></td>
            <td className="numeric">{money(line.cost)}</td>
          </tr>;
        })}
        {breakdown.other.map((row) => <tr key={`${row.basis}:${row.source ?? ""}`}>
          <td><span className="ck-cost-breakdown-label">{otherCostLabel(row.basis, row.source)}</span><small>{row.calls.toLocaleString("en-US")} {row.calls === 1 ? "call" : "calls"}</small></td>
          <td className="numeric">{money(row.cost)}</td>
        </tr>)}
      </tbody>
      <tfoot><tr><td>Total</td><td className="numeric">{money(breakdown.total)}</td></tr></tfoot>
    </table>
    {breakdown.partial && <p className="ck-cost-breakdown-note">Counted over the latest 20,000 priced calls.</p>}
  </div>;
}

/**
 * An (i) beside a model's cost: opens how that cost adds up for the period,
 * loaded when opened.
 */
export function ModelCostInfo({ projectId, provider, model, period, money }: { projectId: string | null; provider: string | null; model: string; period: { from: string; to: string; environment: string | null }; money: Money }) {
  const [open, setOpen] = useState(false);
  const [breakdown, setBreakdown] = useState<CostBreakdownData | null>(null);
  const [failed, setFailed] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const popRef = useRef<HTMLSpanElement>(null);
  // Fixed to the viewport, so a table that scrolls or clips can't cut it off.
  const [place, setPlace] = useState<{ top: number; left: number } | null>(null);
  useEffect(() => {
    if (!open || !ref.current) return;
    const position = () => {
      const rect = ref.current!.getBoundingClientRect();
      const width = Math.min(340, window.innerWidth - 32);
      setPlace({ top: rect.bottom + 6, left: Math.max(16, Math.min(rect.right - width + 8, window.innerWidth - width - 16)) });
    };
    position();
    window.addEventListener("scroll", position, true);
    window.addEventListener("resize", position);
    return () => { window.removeEventListener("scroll", position, true); window.removeEventListener("resize", position); };
  }, [open]);
  useEffect(() => {
    if (!open || breakdown || !projectId) return;
    let live = true;
    getModelDetail(projectId, provider ?? "", model, { from: period.from, to: period.to, environment: period.environment ?? undefined })
      .then((detail) => { if (live) setBreakdown(detail.price.breakdown ?? null); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [open, breakdown, projectId, provider, model, period.from, period.to, period.environment]);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!ref.current?.contains(target) && !popRef.current?.contains(target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", escape); };
  }, [open]);
  return <span className="ck-cost-info" ref={ref}>
    <button type="button" className="ck-cost-info-button" aria-label={`How the ${model} cost is calculated`} aria-expanded={open} onClick={(event) => { event.preventDefault(); event.stopPropagation(); setOpen((value) => !value); }}><Info size={13} /></button>
    {open && place && createPortal(<span ref={popRef} className="ck-cost-info-pop" style={{ top: place.top, left: place.left }} role="dialog" aria-label={`${model} cost breakdown`} onClick={(event) => event.stopPropagation()}>
      <span className="ck-cost-info-title">How the {model} cost adds up</span>
      {failed ? <span className="ck-cost-breakdown-note">Couldn’t load the breakdown.</span>
        : !breakdown ? <span className="ck-cost-breakdown-note">Loading</span>
          : <CostBreakdownTable breakdown={breakdown} money={money} />}
    </span>, document.body)}
  </span>;
}
