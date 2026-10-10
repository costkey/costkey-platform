import type { SVGProps } from "react";

export type PrototypeIconName =
  | "overview" | "trace" | "flask" | "telescope" | "shield" | "folder" | "search" | "settings"
  | "activity" | "clock" | "doc" | "download" | "check" | "alert" | "pause"
  | "cost" | "help" | "calendar" | "plus" | "info" | "arrow" | "right" | "down";

// Geometry from the CostKey design language icon set (24 px grid, 1.75 px
// stroke, rounded ends). "trace" is the Runs play glyph; "pause" is the
// stopped-state glyph used with critical status.
const paths: Record<PrototypeIconName, string> = {
  overview: '<path d="M3 10V4h7v6H3Zm11 10V4h7v16h-7ZM3 20v-6h7v6H3Z"/>',
  trace: '<path d="M5 4v16l14-8L5 4Z"/>',
  flask: '<path d="M9 3h6M10 3v7l-5 8a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-8V3M8 15h8"/>',
  telescope: '<path d="m4 9 13-6 3 7-13 5-3-6ZM4 10l-2 1 1 3 3-1M12 14v3m0 0-5 5m5-5 5 5m-5-5v5M16 4l3 7"/>',
  shield: '<path d="m12 3 8 3v6c0 4-4 7-8 9-4-2-8-5-8-9V6l8-3Z"/><path d="m8 12 3 3 5-6"/>',
  folder: '<path d="M3 6a2 2 0 0 1 2-2h5l3 3h6a2 2 0 0 1 2 2v10H3V6Z"/>',
  search: '<circle cx="10" cy="10" r="6.5"/><path d="m15 15 6 6"/>',
  settings: '<path d="M4 7h7m5 0h4M4 17h3m5 0h8"/><circle cx="13" cy="7" r="3"/><circle cx="9" cy="17" r="3"/>',
  activity: '<path d="M2 12h5l3-8 4 16 3-8h5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>',
  doc: '<path d="M5 3h10l4 4v14H5V3Zm10 0v5h4M8 12h8M8 16h6"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 15v6h16v-6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  alert: '<path d="m12 3 10 17H2L12 3ZM12 9v5"/><circle cx="12" cy="17" r=".8" fill="currentColor" stroke="none"/>',
  pause: '<circle cx="12" cy="12" r="9"/><path d="M9 8v8M15 8v8"/>',
  cost: '<path d="M4 20h17M7 16v-5m5 5V5m5 11V8"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.6 2.6 0 0 1 5 1c0 2-2.5 2-2.5 4m0 3h.01"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4m10-4v4M3 10h18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10h.01"/>',
  arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  right: '<path d="m9 6 6 6-6 6"/>',
  down: '<path d="m7 10 5 5 5-5"/>',
};

export function PrototypeIcon({ name, size = 18, ...props }: { name: PrototypeIconName; size?: number } & Omit<SVGProps<SVGSVGElement>, "name">) {
  return <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...props} dangerouslySetInnerHTML={{ __html: paths[name] }} />;
}
