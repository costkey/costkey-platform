import { useEffect, useState, type ReactNode } from "react";
import { animate, AnimatePresence, motion, useMotionValue, useReducedMotion, useTransform } from "motion/react";
import { PrototypeIcon, type PrototypeIconName } from "./PrototypeIcon";

/**
 * The signed-out brand panel: a small CostKey window that walks through the
 * product (spend across providers, agent runs, quality, budgets, alerts).
 * Decorative only; with reduced motion it shows the first scene, still.
 */

type SceneId = "spend" | "agents" | "quality" | "budgets" | "alerts";
const SCENES: Array<{ id: SceneId; label: string; tab: PrototypeIconName; crumb: string }> = [
  { id: "spend", label: "Spend", tab: "overview", crumb: "overview" },
  { id: "agents", label: "Agent runs", tab: "agent", crumb: "agents / support-agent" },
  { id: "quality", label: "Quality", tab: "quality", crumb: "quality / failed runs" },
  { id: "budgets", label: "Budgets", tab: "workflow", crumb: "agents / budgets" },
  { id: "alerts", label: "Alerts", tab: "overview", crumb: "overview" },
];
const NAV: PrototypeIconName[] = ["overview", "workflow", "agent", "trace", "quality"];
const SCENE_MS = 5200;
const EASE = [0.22, 1, 0.36, 1] as const;

function Count({ to, prefix = "$", decimals = 0, delay = 0 }: { to: number; prefix?: string; decimals?: number; delay?: number }) {
  const value = useMotionValue(0);
  const text = useTransform(value, (latest) => `${prefix}${latest.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`);
  useEffect(() => {
    const controls = animate(value, to, { duration: 1.1, delay, ease: "easeOut" });
    return () => controls.stop();
  }, [value, to, delay]);
  return <motion.span>{text}</motion.span>;
}

function Grow({ width, delay = 0, className = "", left }: { width: number; delay?: number; className?: string; left?: number }) {
  return <motion.b className={className} style={left === undefined ? undefined : { left: `${left}%` }} initial={{ width: 0 }} animate={{ width: `${width}%` }} transition={{ delay, duration: 0.6, ease: "easeOut" }} />;
}

function Skeleton({ width }: { width: number }) {
  return <span className="as-skel" style={{ width: `${width}%` }} />;
}

const PROVIDERS = [
  { name: "OpenAI", share: 38, tone: "#8fb3df" },
  { name: "Anthropic", share: 27, tone: "#d9a77a" },
  { name: "Gemini", share: 16, tone: "#9bd1b8" },
  { name: "Bedrock", share: 9, tone: "#b9a6e0" },
  { name: "Mistral", share: 6, tone: "#f5cc68" },
  { name: "DeepSeek", share: 4, tone: "#7fc4d8" },
];
const DAYS = [38, 44, 41, 52, 49, 58, 63, 57, 66, 72, 70, 78];

function SpendScene() {
  return <div className="as-scene">
    <div className="as-metrics">
      <div><small>Month to date</small><strong><Count to={8412} /></strong></div>
      <div><small>Month-end at this pace</small><strong><Count to={21730} delay={0.2} /></strong></div>
      <div><small>Runs</small><strong><Count to={41208} prefix="" delay={0.35} /></strong></div>
    </div>
    <div className="as-stack">{PROVIDERS.map((provider, index) => <motion.i key={provider.name} style={{ background: provider.tone }} initial={{ width: 0 }} animate={{ width: `${provider.share}%` }} transition={{ delay: 0.2 + index * 0.08, duration: 0.6, ease: "easeOut" }} />)}</div>
    <div className="as-legend">{PROVIDERS.map((provider) => <span key={provider.name}><i style={{ background: provider.tone }} />{provider.name}<em>{provider.share}%</em></span>)}</div>
    <div className="as-bars">
      {DAYS.map((height, index) => <motion.i key={index} initial={{ height: 0 }} animate={{ height: `${height}%` }} transition={{ delay: 0.5 + index * 0.05, duration: 0.5, ease: "easeOut" }} />)}
      {[82, 86, 90].map((height, index) => <motion.i key={`f${index}`} className="as-forecast" initial={{ height: 0 }} animate={{ height: `${height}%` }} transition={{ delay: 1.2 + index * 0.08, duration: 0.5 }} />)}
    </div>
  </div>;
}

const RUN = [
  { depth: 0, kind: "Agent", name: "support-agent", start: 0, width: 100, cost: "$0.042" },
  { depth: 1, kind: "Step", name: "Plan", start: 0, width: 16, cost: "$0.006" },
  { depth: 2, kind: "Tool", name: "search_orders", start: 16, width: 14, cost: "" },
  { depth: 1, kind: "Step", name: "Draft answer", start: 30, width: 46, cost: "$0.031" },
  { depth: 2, kind: "Tool", name: "refund_policy", start: 40, width: 12, cost: "" },
  { depth: 1, kind: "Judge", name: "faithfulness 0.91", start: 78, width: 18, cost: "$0.005" },
];

function AgentScene() {
  return <div className="as-scene">
    <div className="as-head"><strong>support-agent</strong><span className="as-chip">6 steps · 2 tools · 4.1 s</span><span className="as-head-cost"><Count to={0.042} decimals={3} /></span></div>
    <div className="as-tree">{RUN.map((row, index) => (
      <motion.div key={row.name} className="as-tree-row" initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: index * 0.25, duration: 0.35 }}>
        <span className="as-tree-name" style={{ paddingLeft: row.depth * 14 }}><em className={`as-kind as-kind-${row.kind.toLowerCase()}`}>{row.kind}</em>{row.name}</span>
        <i className="as-track"><Grow className={`as-bar as-bar-${row.kind.toLowerCase()}`} left={row.start} width={row.width} delay={0.2 + index * 0.25} /></i>
        <span className="as-tree-cost">{row.cost}</span>
      </motion.div>
    ))}</div>
  </div>;
}

const FAILS = [14, 22, 18, 30, 26, 44, 38, 24, 20, 16, 12, 10];

function QualityScene() {
  return <div className="as-scene">
    <div className="as-metrics">
      <div><small>Failed runs</small><strong className="as-bad">4.2%</strong></div>
      <div><small>Judged failing</small><strong>2.8%</strong></div>
      <div><small>Wasted</small><strong><Count to={312} /></strong></div>
    </div>
    <div className="as-bars as-bars-fail">{FAILS.map((height, index) => <motion.i key={index} initial={{ height: 0 }} animate={{ height: `${height * 1.9}%` }} transition={{ delay: 0.2 + index * 0.05, duration: 0.45, ease: "easeOut" }} />)}</div>
    {[
      { chip: "Tool failed", tone: "bad", detail: "search_orders: timeout", skel: 46 },
      { chip: "Judged failing", tone: "warn", detail: "faithfulness 0.31", skel: 38 },
      { chip: "Model call failed", tone: "bad", detail: "gpt-6-sol returned 429", skel: 52 },
    ].map((row, index) => (
      <motion.div key={row.chip} className="as-fail-row" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.8 + index * 0.18 }}>
        <span className={`as-tag as-tag-${row.tone}`}>{row.chip}</span><span className="as-mono">{row.detail}</span><Skeleton width={row.skel} />
      </motion.div>
    ))}
  </div>;
}

function BudgetScene() {
  return <div className="as-scene">
    <div className="as-budget">
      <div className="as-budget-row"><strong>support-agent</strong><span className="as-mono">monthly · $800</span><span className="as-tag as-tag-warn">Alert</span></div>
      <i className="as-meter"><Grow width={82} delay={0.2} className="as-meter-fill" /><span className="as-threshold" /></i>
      <div className="as-budget-row as-muted"><span><Count to={656} delay={0.2} /> used</span><span>Alert at 80%</span></div>
    </div>
    <div className="as-budget">
      <div className="as-budget-row"><strong>gpt-6-sol</strong><span className="as-mono">each call · $0.50</span><span className="as-tag as-tag-bad">Stop calls</span></div>
      <motion.div className="as-refused" initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: 1, duration: 0.35 }}>
        <PrototypeIcon name="pause" size={14} /> Call stopped · estimated $0.71
      </motion.div>
    </div>
    <div className="as-budget as-budget-dim"><div className="as-budget-row"><strong>search · answer · rerank</strong><span className="as-mono">group · daily</span></div><i className="as-meter"><Grow width={41} delay={0.4} className="as-meter-fill as-meter-calm" /></i></div>
    <motion.div className="as-note" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 1.5 }}>
      <svg viewBox="0 0 70 40"><motion.path d="M66 34 C 46 36, 26 30, 10 8 M10 8 L 9 18 M10 8 L 19 11" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ delay: 1.5, duration: 0.7 }} /></svg>
      <span>stops it before it's sent</span>
    </motion.div>
  </div>;
}

function AlertScene() {
  return <div className="as-scene as-scene-dim">
    <div className="as-metrics"><div><small>Month to date</small><strong>$8,412</strong></div><div><small>Budget</small><strong>82%</strong></div><div><small>Runs</small><strong>41,208</strong></div></div>
    <div className="as-skel-block"><Skeleton width={80} /><Skeleton width={64} /><Skeleton width={72} /></div>
  </div>;
}

function Overlay({ scene }: { scene: SceneId }) {
  return <AnimatePresence>{scene === "alerts" && <>
    <motion.div key="slack" className="as-pop as-pop-slack" initial={{ opacity: 0, y: 18, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 10 }} transition={{ delay: 0.25, type: "spring", stiffness: 240, damping: 24 }}>
      <div className="as-pop-head"><b className="as-slack-mark">#</b><strong>ai-costs</strong><span className="as-mono">Slack</span></div>
      <div className="as-pop-msg"><span className="as-avatar">CK</span><div><strong>CostKey</strong> <span className="as-muted">9:41</span><p>Monthly budget passed <b>80%</b> · support-agent $656 of $800</p><span className="as-pop-button">View in CostKey</span></div></div>
    </motion.div>
    <motion.div key="email" className="as-pop as-pop-email" initial={{ opacity: 0, y: 18, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 10 }} transition={{ delay: 0.9, type: "spring", stiffness: 240, damping: 24 }}>
      <div className="as-pop-head"><PrototypeIcon name="doc" size={14} /><strong>Daily cost</strong><span className="as-mono">8:00</span></div>
      <p className="as-pop-big">$281 yesterday <em>+12%</em></p>
      <div className="as-pop-lines"><span>support-agent</span><b>$118</b><span>search</span><b>$74</b><span>gpt-6-sol</span><b>$96</b></div>
    </motion.div>
  </>}</AnimatePresence>;
}

const SCENE_VIEW: Record<SceneId, () => ReactNode> = {
  spend: () => <SpendScene />,
  agents: () => <AgentScene />,
  quality: () => <QualityScene />,
  budgets: () => <BudgetScene />,
  alerts: () => <AlertScene />,
};

export function AuthScene() {
  const reduced = useReducedMotion();
  const [index, setIndex] = useState(0);
  const scene = SCENES[index]!;

  useEffect(() => {
    if (reduced) return;
    const timer = window.setTimeout(() => setIndex((value) => (value + 1) % SCENES.length), SCENE_MS);
    return () => window.clearTimeout(timer);
  }, [index, reduced]);

  return (
    <div className="auth-scene" aria-hidden="true">
      <div className="as-glow" />
      <motion.div className="as-window" initial={reduced ? false : { opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.8, ease: EASE }}>
        <div className="as-chrome">
          <span className="as-dots"><i /><i /><i /></span>
          <span className="as-crumb">app.costkey.dev / {scene.crumb}</span>
          <span className="as-env"><i />Production</span>
        </div>
        <div className="as-body">
          <nav className="as-nav">{NAV.map((icon) => <span key={icon} className={icon === scene.tab ? "active" : ""}><PrototypeIcon name={icon} size={15} /></span>)}</nav>
          <div className="as-content">
            <AnimatePresence mode="wait">
              <motion.div key={scene.id} initial={reduced ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.3, ease: EASE }}>
                {SCENE_VIEW[scene.id]()}
              </motion.div>
            </AnimatePresence>
          </div>
        </div>
        <Overlay scene={scene.id} />
      </motion.div>
      <div className="as-steps">{SCENES.map((item, position) => (
        <div key={item.id} className={`as-step ${position === index ? "active" : ""}`}>
          <span>{item.label}</span>
          <i>{position === index && !reduced && <motion.b initial={{ width: 0 }} animate={{ width: "100%" }} transition={{ duration: SCENE_MS / 1000, ease: "linear" }} />}{position < index && <b style={{ width: "100%" }} />}</i>
        </div>
      ))}</div>
    </div>
  );
}
