/**
 * The signed-out brand art: an agent drawn as a constellation, its tools,
 * models and a sub-agent around it, with a light travelling between them.
 * Pure SVG and CSS; still when the system asks for reduced motion.
 */

const AGENT = { x: 300, y: 250 };
const NODES = [
  { x: 150, y: 150, r: 7 },
  { x: 455, y: 128, r: 8 },
  { x: 500, y: 300, r: 6 },
  { x: 380, y: 410, r: 7 },
  { x: 170, y: 365, r: 6 },
  { x: 92, y: 258, r: 5 },
];
// A sub-agent hangs off one of the tools, with its own two calls.
const SUB = { x: 545, y: 205, r: 9 };
const SUB_LEAVES = [{ x: 590, y: 150, r: 4 }, { x: 600, y: 255, r: 4 }];
const STARS = Array.from({ length: 46 }, (_, index) => ({
  x: (index * 131 + 37) % 640,
  y: (index * 89 + 23) % 500,
  r: index % 6 === 0 ? 1.6 : 1,
  delay: `${(index % 9) * 0.7}s`,
}));
// The light's route: agent, a tool, back, the sub-agent's branch, back, a model.
const ROUTE = [AGENT, NODES[1], SUB, NODES[1], AGENT, NODES[3], AGENT, NODES[0], AGENT];
const ROUTE_PATH = ROUTE.map((point, index) => `${index === 0 ? "M" : "L"}${point.x} ${point.y}`).join(" ");

export function AuthScene() {
  return (
    <div className="auth-scene" aria-hidden="true">
      <svg className="auth-constellation" viewBox="0 0 640 500" preserveAspectRatio="xMidYMid meet">
        <defs>
          <radialGradient id="auth-lamp" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#f5cc68" stopOpacity="0.55" />
            <stop offset="100%" stopColor="#f5cc68" stopOpacity="0" />
          </radialGradient>
        </defs>
        {STARS.map((star, index) => <circle key={index} className="auth-star" cx={star.x} cy={star.y} r={star.r} style={{ animationDelay: star.delay }} />)}
        <g className="auth-links">
          {NODES.map((node, index) => <line key={index} x1={AGENT.x} y1={AGENT.y} x2={node.x} y2={node.y} />)}
          <line x1={NODES[1].x} y1={NODES[1].y} x2={SUB.x} y2={SUB.y} />
          {SUB_LEAVES.map((leaf, index) => <line key={index} x1={SUB.x} y1={SUB.y} x2={leaf.x} y2={leaf.y} />)}
        </g>
        <circle className="auth-agent-glow" cx={AGENT.x} cy={AGENT.y} r={70} fill="url(#auth-lamp)" />
        {NODES.map((node, index) => <circle key={index} className="auth-node" cx={node.x} cy={node.y} r={node.r} />)}
        {SUB_LEAVES.map((leaf, index) => <circle key={index} className="auth-node auth-node-faint" cx={leaf.x} cy={leaf.y} r={leaf.r} />)}
        <circle className="auth-node auth-node-sub" cx={SUB.x} cy={SUB.y} r={SUB.r} />
        <circle className="auth-agent-ring" cx={AGENT.x} cy={AGENT.y} r={24} />
        <circle className="auth-agent" cx={AGENT.x} cy={AGENT.y} r={13} />
        <circle className="auth-signal" r={3.2}>
          <animateMotion dur="11s" repeatCount="indefinite" path={ROUTE_PATH} keyPoints="0;1" keyTimes="0;1" calcMode="linear" />
        </circle>
      </svg>
    </div>
  );
}
