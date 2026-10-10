import { useEffect, useMemo, useState } from "react";
import { animate, AnimatePresence, motion, useMotionValue, useReducedMotion, useTransform } from "motion/react";

/**
 * The signed-out brand panel: a run plays out step by step, its cost lands
 * on the month's spend, and the budget alerts when it crosses 80%.
 * Decorative only; the reduced-motion version shows the finished state.
 */

interface Span { label: string; kind: "step" | "tool" | "judge" | "agent"; start: number; width: number }
interface Run { agent: string; cost: number; spans: Span[] }

const RUNS: Run[] = [
  { agent: "support-agent", cost: 0.042, spans: [
    { label: "Plan", kind: "step", start: 0, width: 18 },
    { label: "search_orders", kind: "tool", start: 18, width: 16 },
    { label: "Draft answer", kind: "step", start: 34, width: 44 },
    { label: "Judge", kind: "judge", start: 80, width: 14 },
  ] },
  { agent: "browser-agent", cost: 0.118, spans: [
    { label: "Step 1", kind: "step", start: 0, width: 22 },
    { label: "Step 2", kind: "step", start: 22, width: 26 },
    { label: "action review", kind: "judge", start: 50, width: 10 },
    { label: "Step 3", kind: "step", start: 60, width: 32 },
  ] },
  { agent: "statement-reader", cost: 0.031, spans: [
    { label: "Extract", kind: "step", start: 0, width: 48 },
    { label: "lookup_merchant", kind: "tool", start: 48, width: 14 },
    { label: "Repair", kind: "step", start: 62, width: 24 },
    { label: "faithfulness", kind: "judge", start: 88, width: 10 },
  ] },
];

const BUDGET = 800;
const START_SPEND = 628;
const SPARK = [52, 49, 47, 42, 40, 33, 30, 26, 20, 17, 12];
const STARS = Array.from({ length: 34 }, (_, index) => ({
  left: (index * 37 + 11) % 100,
  top: (index * 53 + 7) % 62,
  size: index % 5 === 0 ? 2.5 : 1.5,
  delay: (index % 7) * 0.6,
}));

function Money({ value }: { value: number }) {
  const motionValue = useMotionValue(value);
  const text = useTransform(motionValue, (latest) => `$${latest.toFixed(latest < 10 ? 3 : 2)}`);
  useEffect(() => {
    const controls = animate(motionValue, value, { duration: 0.9, ease: "easeOut" });
    return () => controls.stop();
  }, [motionValue, value]);
  return <motion.span>{text}</motion.span>;
}

export function AuthScene() {
  const reduced = useReducedMotion();
  const [tick, setTick] = useState(0);
  const run = RUNS[tick % RUNS.length]!;
  // Spend grows with every finished run; scaled so the alert threshold is crossed once per loop.
  const spend = START_SPEND + (tick % 6) * 6.5;
  const ratio = spend / BUDGET;
  const alerted = ratio >= 0.8;

  useEffect(() => {
    if (reduced) return;
    const timer = window.setInterval(() => setTick((value) => value + 1), 4200);
    return () => window.clearInterval(timer);
  }, [reduced]);

  const sparkPath = useMemo(() => {
    const points = [...SPARK, Math.max(4, SPARK[SPARK.length - 1]! - (tick % 6))];
    return points.map((y, index) => `${index === 0 ? "M" : "L"}${(index / (points.length - 1)) * 240} ${y}`).join(" ");
  }, [tick]);

  return (
    <div className="auth-scene" aria-hidden="true">
      <div className="auth-scene-sky">
        {STARS.map((star, index) => (
          <motion.i
            key={index}
            className="auth-scene-star"
            style={{ left: `${star.left}%`, top: `${star.top}%`, width: star.size, height: star.size }}
            animate={reduced ? undefined : { opacity: [0.25, 0.9, 0.25] }}
            transition={{ duration: 3.4, repeat: Infinity, delay: star.delay, ease: "easeInOut" }}
          />
        ))}
        <motion.div className="auth-scene-glow" animate={reduced ? undefined : { opacity: [0.55, 0.85, 0.55], scale: [1, 1.06, 1] }} transition={{ duration: 8, repeat: Infinity, ease: "easeInOut" }} />
      </div>

      <div className="auth-scene-stack">
        <motion.div className="auth-card auth-card-run" initial={reduced ? false : { opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}>
          <AnimatePresence mode="wait">
            <motion.div key={tick % RUNS.length} initial={reduced ? false : { opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.25 }}>
              <div className="auth-card-row">
                <span className="auth-card-kind">Agent</span>
                <strong>{run.agent}</strong>
                <span className="auth-card-cost">{reduced ? `$${run.cost.toFixed(3)}` : <Money value={run.cost} />}</span>
              </div>
              {run.spans.map((span, index) => (
                <div className="auth-card-span" key={span.label}>
                  <span>{span.label}</span>
                  <i>
                    <motion.b
                      className={`kind-${span.kind}`}
                      style={{ left: `${span.start}%` }}
                      initial={reduced ? false : { width: 0 }}
                      animate={{ width: `${span.width}%` }}
                      transition={{ delay: 0.25 + index * 0.45, duration: 0.5, ease: "easeOut" }}
                    />
                  </i>
                </div>
              ))}
            </motion.div>
          </AnimatePresence>
        </motion.div>

        <motion.div className="auth-card auth-card-budget" initial={reduced ? false : { opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15, duration: 0.6, ease: [0.22, 1, 0.36, 1] }}>
          <div className="auth-card-row"><span>Monthly budget</span><strong>{reduced ? `$${spend.toFixed(2)}` : <Money value={spend} />} <em>of ${BUDGET}</em></strong></div>
          <i className="auth-card-meter">
            <motion.b animate={{ width: `${Math.min(100, ratio * 100)}%` }} transition={{ duration: 0.9, ease: "easeOut" }} className={alerted ? "alerted" : ""} />
            <span className="auth-card-threshold" style={{ left: "80%" }} />
          </i>
          <div className="auth-card-row auth-card-muted"><span>Alert at 80%</span><span>Stop at 100%</span></div>
        </motion.div>

        <motion.div className="auth-card auth-card-spend" initial={reduced ? false : { opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3, duration: 0.6, ease: [0.22, 1, 0.36, 1] }}>
          <div className="auth-card-row"><span>Spend this month</span><strong>{reduced ? `$${spend.toFixed(2)}` : <Money value={spend} />}</strong></div>
          <svg viewBox="0 0 240 56" preserveAspectRatio="none">
            <motion.path d={sparkPath} initial={reduced ? false : { pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 1.4, ease: "easeInOut" }} />
            <path className="auth-card-pace" d="M0 52 L240 8" />
          </svg>
        </motion.div>

        <AnimatePresence>
          {alerted && !reduced && (
            <motion.div className="auth-toast" key="alert" initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 24 }} transition={{ type: "spring", stiffness: 260, damping: 24 }}>
              <span className="auth-toast-dot" />
              <span><strong>#ai-costs</strong> Monthly budget passed 80%</span>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
