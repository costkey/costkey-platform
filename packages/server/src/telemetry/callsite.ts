import type { StackFrame } from "@costkey/shared";

/**
 * SDK 0.7 sends every stack frame unfiltered. The server parses the raw
 * stack when no structured frames came with it, and keeps only the frames
 * of the stored raw text that survive the same filter as the frames.
 */

/** A V8 frame line, without its leading "at ". */
function parseV8Frame(frame: string): StackFrame | null {
  const cleaned = frame.startsWith("async ") ? frame.slice(6) : frame;
  const paren = cleaned.match(/^(.+?)\s+\((.+):(\d+):(\d+)\)$/);
  if (paren) {
    return {
      functionName: paren[1] || null,
      fileName: paren[2] || null,
      lineNumber: parseInt(paren[3]!, 10),
      columnNumber: parseInt(paren[4]!, 10),
    };
  }
  const direct = cleaned.match(/^(.+):(\d+):(\d+)$/);
  if (direct) {
    return {
      functionName: null,
      fileName: direct[1] || null,
      lineNumber: parseInt(direct[2]!, 10),
      columnNumber: parseInt(direct[3]!, 10),
    };
  }
  return null;
}

const PYTHON_FRAME = /^\s*File "([^"]+)", line (\d+)(?:, in (.+))?\s*$/;

/** One raw stack line's frame, in either runtime's format. */
function parseLine(line: string): StackFrame | null {
  const trimmed = line.trim();
  if (trimmed.startsWith("at ")) return parseV8Frame(trimmed.slice(3));
  const python = PYTHON_FRAME.exec(line);
  if (python) {
    return {
      functionName: python[3]?.trim() || null,
      fileName: python[1] || null,
      lineNumber: parseInt(python[2]!, 10),
      columnNumber: null,
    };
  }
  return null;
}

/**
 * Frames of a raw stack, innermost first: V8 stacks already are; Python's
 * `traceback.format_stack()` is outermost first and is reversed (as SDK 0.6
 * did).
 */
export function parseRawStack(raw: string): StackFrame[] {
  const frames: StackFrame[] = [];
  let python = false;
  for (const line of raw.split("\n")) {
    if (PYTHON_FRAME.test(line)) python = true;
    const frame = parseLine(line);
    if (frame) frames.push(frame);
  }
  return python ? frames.reverse() : frames;
}

/**
 * The raw stack with internal frames removed. Lines that aren't frames (the
 * error header) are kept; a Python frame's source line goes with its frame.
 */
export function filterRawStack(raw: string, isInternal: (frame: StackFrame) => boolean): string {
  const lines = raw.split("\n");
  const kept: string[] = [];
  let droppingSource = false;
  for (const line of lines) {
    const frame = parseLine(line);
    if (frame) {
      const internal = isInternal(frame);
      droppingSource = internal && PYTHON_FRAME.test(line);
      if (!internal) kept.push(line);
      continue;
    }
    // Python prints the frame's source line indented under it.
    if (droppingSource && /^\s{4,}\S/.test(line)) {
      droppingSource = false;
      continue;
    }
    droppingSource = false;
    kept.push(line);
  }
  return kept.join("\n");
}

function frameOf(value: unknown): StackFrame | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const text = (key: string, alt: string): string | null => {
    const raw = record[key] ?? record[alt];
    return typeof raw === "string" && raw ? raw : null;
  };
  const number = (key: string, alt: string): number | null => {
    const raw = record[key] ?? record[alt];
    return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
  };
  return {
    functionName: text("functionName", "function_name"),
    fileName: text("fileName", "file_name"),
    lineNumber: number("lineNumber", "line_number"),
    columnNumber: number("columnNumber", "column_number"),
  };
}

/**
 * The call site of a raw (0.7) event: structured frames when sent (camel or
 * snake case), else parsed from `raw`; `raw` itself filtered of internal
 * frames.
 */
export function normalizeRawCallSite(
  callSite: unknown,
  isInternal: (frame: StackFrame) => boolean,
): { raw: string | null; frames: StackFrame[] } | null {
  if (!callSite || typeof callSite !== "object" || Array.isArray(callSite)) return null;
  const record = callSite as Record<string, unknown>;
  const raw = typeof record["raw"] === "string" ? record["raw"] : null;
  const sent = Array.isArray(record["frames"])
    ? record["frames"].map(frameOf).filter((frame): frame is StackFrame => frame !== null)
    : [];
  const frames = sent.length > 0 ? sent : raw ? parseRawStack(raw) : [];
  if (frames.length === 0 && !raw) return null;
  return { raw: raw ? filterRawStack(raw, isInternal) : null, frames };
}
