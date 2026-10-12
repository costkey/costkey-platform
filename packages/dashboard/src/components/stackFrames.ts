/** A recorded stack frame, as the SDK sends it. */
export interface StackFrame {
  functionName?: string | null;
  fileName?: string | null;
  lineNumber?: number | null;
  columnNumber?: number | null;
}

export interface FrameView {
  functionName: string;
  /** The path people recognise: "financial_data_worker/generated_media.py:155". */
  location: string | null;
  /** The full recorded path, for a tooltip. */
  fullLocation: string | null;
  /** The installed package a frame belongs to ("fastapi", "@openai/agents"), if any. */
  packageName: string | null;
  /** The frame that names the call (the app's own code that made it). */
  isCallSite: boolean;
}

const INSTALLED = /(?:^|[\\/])(?:site-packages|dist-packages|node_modules)[\\/]/;
const APP_ROOTS = [
  /^\/(?:app|srv|code|src|workspace|workspaces|var\/task|usr\/src\/app|opt\/app)\//,
  /^\/(?:Users|home)\/[^/]+\/(?:(?:Code|code|src|projects|dev|work|repos)\/)?[^/]+\//,
  /^[A-Za-z]:\\(?:Users\\[^\\]+\\)?(?:[^\\]+\\)?/,
];

/** The part of a path after its install or app root, and the package it is in. */
export function shortenPath(path: string): { short: string; packageName: string | null } {
  const normalized = path.replace(/^file:\/\//, "");
  const installed = normalized.split(/(?:site-packages|dist-packages|node_modules)[\\/]/);
  if (installed.length > 1) {
    const rest = installed[installed.length - 1]!;
    const parts = rest.split(/[\\/]/).filter(Boolean);
    const packageName = parts[0]?.startsWith("@") && parts[1] ? `${parts[0]}/${parts[1]}` : parts[0]?.replace(/\.py$/, "") ?? null;
    return { short: rest, packageName };
  }
  for (const root of APP_ROOTS) {
    if (root.test(normalized)) return { short: normalized.replace(root, ""), packageName: null };
  }
  return { short: normalized, packageName: null };
}

function same(a: string | null | undefined, b: string | null | undefined): boolean {
  return Boolean(a && b && (a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`)));
}

/** Frames as rows: function first, a short location, installed packages marked, the call site highlighted. */
export function frameViews(frames: StackFrame[], callSite: { functionName?: string | null; file?: string | null; line?: number | null }): FrameView[] {
  let highlighted = false;
  return frames.map((frame) => {
    const file = frame.fileName?.trim() || null;
    const line = frame.lineNumber == null ? null : Number(frame.lineNumber);
    const { short, packageName } = file ? shortenPath(file) : { short: null, packageName: null };
    const suffix = line != null && Number.isFinite(line) ? `:${line}` : "";
    const functionName = frame.functionName?.split("\n")[0]?.trim() || "anonymous";
    const matches = !highlighted && functionName === callSite.functionName && (!callSite.file || same(file, callSite.file)) && (callSite.line == null || line === callSite.line);
    if (matches) highlighted = true;
    return {
      functionName,
      location: short ? `${short}${suffix}` : null,
      fullLocation: file ? `${file}${suffix}` : null,
      packageName: file && INSTALLED.test(file) ? packageName : null,
      isCallSite: matches,
    };
  });
}
