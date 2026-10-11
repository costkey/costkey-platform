/**
 * The signed-out brand art: the CostKey telescope from the design language,
 * redrawn for the night panel, under a few faintly twinkling stars.
 */

const STARS = [
  { x: 60, y: 40, r: 1.6 }, { x: 150, y: 90, r: 1.1 }, { x: 245, y: 30, r: 1.4 }, { x: 330, y: 70, r: 1 },
  { x: 420, y: 24, r: 1.6 }, { x: 455, y: 110, r: 1.1 }, { x: 30, y: 150, r: 1.1 }, { x: 110, y: 200, r: 1.4 },
  { x: 440, y: 190, r: 1.3 }, { x: 395, y: 250, r: 1 }, { x: 20, y: 260, r: 1.4 }, { x: 465, y: 285, r: 1.1 },
  { x: 205, y: 62, r: 1 }, { x: 290, y: 130, r: 1.2 },
];

// Faint stars across the whole panel (percent coordinates).
const SKY = Array.from({ length: 34 }, (_, index) => ({
  x: (index * 37 + 7) % 100,
  y: (index * 53 + 11) % 100,
  r: index % 5 === 0 ? 0.22 : 0.14,
}));

export function AuthScene() {
  return (
    <div className="auth-scene" aria-hidden="true">
      <svg className="auth-starfield" viewBox="0 0 100 100" preserveAspectRatio="none">
        {SKY.map((star, index) => <circle key={index} className="auth-star" cx={star.x} cy={star.y} r={star.r} vectorEffect="non-scaling-stroke" style={{ animationDelay: `${(index * 0.61) % 6}s` }} />)}
      </svg>
      <svg className="auth-telescope" viewBox="0 0 480 320" strokeLinecap="round" strokeLinejoin="round">
        {STARS.map((star, index) => <circle key={index} className="auth-star" cx={star.x} cy={star.y} r={star.r} style={{ animationDelay: `${(index * 0.83) % 6}s` }} />)}
        <path d="M58 219C50 126 117 79 219 93C293 62 412 105 417 218Z" fill="#203a5a" opacity="0.7" />
        <ellipse cx="240" cy="279" rx="134" ry="14" fill="#0f1d31" opacity="0.55" />
        <path d="M86 151C157 64 273 36 372 79" fill="none" stroke="#6E93AE" strokeWidth="2" strokeDasharray="3 8" />
        <path d="M375 68 Q376 78 386 79 Q376 80 375 90 Q374 80 364 79 Q374 78 375 68Z" fill="#F5CC68" className="auth-target" />
        <circle cx="86" cy="151" r="4" fill="#6E93AE" />
        <circle cx="162" cy="95" r="3" fill="#6E93AE" />
        <path d="M231 163L208 176L141 278L151 281L238 183L288 282L300 278L250 174Z" fill="#6E93AE" stroke="#0f1d31" strokeWidth="2.5" />
        <path d="M228 181L224 285H235L240 180Z" fill="#344F70" stroke="#0f1d31" strokeWidth="2.5" />
        <path d="M183 235L272 235" fill="none" stroke="#0f1d31" strokeWidth="2.5" />
        <g transform="translate(211 157) rotate(-23)">
          <rect x="-62" y="-16" width="30" height="32" rx="4" fill="#344F70" stroke="#0f1d31" strokeWidth="2.5" />
          <path d="M-34 -26L102 -30L102 30L-34 25Z" fill="#FFFDF8" stroke="#0f1d31" strokeWidth="2.5" />
          <path d="M-33 7L99 6L99 29L-33 24Z" fill="#ABC6D6" />
          <path d="M60 -28L78 -29L78 29L60 29Z" fill="#F5CC68" stroke="#0f1d31" strokeWidth="2" />
          <ellipse cx="102" cy="0" rx="13" ry="30" fill="#344F70" stroke="#0f1d31" strokeWidth="2.5" />
          <ellipse cx="105" cy="0" rx="7" ry="19" fill="#112238" />
          <path d="M105 -11V-5" fill="none" stroke="#ABC6D6" strokeWidth="2" />
          <path d="M-11 28L24 29L21 51L-8 51Z" fill="#6E93AE" stroke="#0f1d31" strokeWidth="2.5" />
          <circle cx="7" cy="40" r="7" fill="#F5CC68" stroke="#0f1d31" strokeWidth="2" />
        </g>
        <path d="M356 190L373 190M364 182V198" fill="none" stroke="#6E93AE" strokeWidth="2" />
        <path d="M94 234H121M105 226V242" fill="none" stroke="#6E93AE" strokeWidth="2" />
      </svg>
    </div>
  );
}
