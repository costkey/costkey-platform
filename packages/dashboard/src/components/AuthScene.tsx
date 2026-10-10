/**
 * The signed-out brand art: the small CostKey telescope shining into the
 * night sky. The stars in its beam are your agents, and the light shows
 * what each one cost or where it failed. SVG and CSS; still with reduced
 * motion.
 */

// The telescope from the design language's "a little ahead" art, tilted up.
const SCOPE = "translate(-30 272) scale(1.1)";
const LENS = { x: 293, y: 374 };
const BEAM = `M${LENS.x - 6} ${LENS.y - 18} L574 -10 L700 128 L${LENS.x + 14} ${LENS.y + 10} Z`;

const AGENTS = [
  { x: 436, y: 214, r: 4.5, label: "support-agent", value: "$0.042", tone: "cost" },
  { x: 548, y: 168, r: 5.5, label: "browser-agent", value: "failed", tone: "fail" },
  { x: 500, y: 116, r: 3.8, label: "search", value: "$0.31", tone: "cost" },
  { x: 586, y: 66, r: 4.2, label: "judge", value: "0.91", tone: "pass" },
];
const STARS = Array.from({ length: 40 }, (_, index) => ({
  x: (index * 137 + 29) % 640,
  y: (index * 71 + 17) % 470,
  r: index % 7 === 0 ? 1.6 : 1,
  delay: `${(index % 8) * 0.8}s`,
}));

function Tag({ x, y, label, value, tone, delay }: { x: number; y: number; label: string; value: string; tone: string; delay: string }) {
  const width = 26 + (label.length + value.length) * 7.1;
  const left = x + width + 20 > 640 ? x - width - 14 : x + 12;
  return (
    <g className={`auth-tag auth-tag-${tone}`} style={{ animationDelay: delay }}>
      <rect x={left} y={y - 12} width={width} height={24} rx={7} />
      <text x={left + 10} y={y + 4}><tspan className="auth-tag-name">{label}</tspan><tspan dx={8} className="auth-tag-value">{value}</tspan></text>
    </g>
  );
}

export function AuthScene() {
  return (
    <div className="auth-scene" aria-hidden="true">
      <svg className="auth-sky" viewBox="0 0 640 600" preserveAspectRatio="xMidYMax meet">
        <defs>
          <linearGradient id="auth-beam" x1={LENS.x} y1={LENS.y} x2="620" y2="70" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#f5cc68" stopOpacity="0.42" />
            <stop offset="100%" stopColor="#f5cc68" stopOpacity="0" />
          </linearGradient>
        </defs>
        {STARS.map((star, index) => <circle key={index} className="auth-star" cx={star.x} cy={star.y} r={star.r} style={{ animationDelay: star.delay }} />)}
        <path className="auth-beam" d={BEAM} fill="url(#auth-beam)" />
        <path className="auth-hill" d="M0 560C130 520 250 540 380 522C480 508 560 520 640 506V600H0Z" />
        <g transform={SCOPE} strokeLinecap="round" strokeLinejoin="round">
          <path d="M231 163L208 176L141 278L151 281L238 183L288 282L300 278L250 174Z" fill="#6E93AE" stroke="#0f1d31" strokeWidth="2.5" />
          <path d="M228 181L224 285H235L240 180Z" fill="#344F70" stroke="#0f1d31" strokeWidth="2.5" />
          <path d="M183 235L272 235" fill="none" stroke="#0f1d31" strokeWidth="2.5" />
          <g transform="translate(211 157) rotate(-38)">
            <rect x="-62" y="-16" width="30" height="32" rx="4" fill="#344F70" stroke="#0f1d31" strokeWidth="2.5" />
            <path d="M-34 -26L102 -30L102 30L-34 25Z" fill="#FFFDF8" stroke="#0f1d31" strokeWidth="2.5" />
            <path d="M-33 7L99 6L99 29L-33 24Z" fill="#ABC6D6" />
            <path d="M60 -28L78 -29L78 29L60 29Z" fill="#F5CC68" stroke="#0f1d31" strokeWidth="2" />
            <ellipse cx="102" cy="0" rx="13" ry="30" fill="#344F70" stroke="#0f1d31" strokeWidth="2.5" />
            <ellipse cx="105" cy="0" rx="7" ry="19" fill="#f5cc68" className="auth-lens" />
            <path d="M-11 28L24 29L21 51L-8 51Z" fill="#6E93AE" stroke="#0f1d31" strokeWidth="2.5" />
            <circle cx="7" cy="40" r="7" fill="#F5CC68" stroke="#0f1d31" strokeWidth="2" />
          </g>
        </g>
        {AGENTS.map((agent, index) => (
          <g key={agent.label}>
            <circle className={`auth-agent-star auth-agent-${agent.tone}`} cx={agent.x} cy={agent.y} r={agent.r} style={{ animationDelay: `${index * 0.9}s` }} />
            <Tag x={agent.x} y={agent.y} label={agent.label} value={agent.value} tone={agent.tone} delay={`${0.5 + index * 0.35}s`} />
          </g>
        ))}
      </svg>
    </div>
  );
}
