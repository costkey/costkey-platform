import type { CallSite, StackFrame } from "./types.js";

const MIN_STACK_FRAMES = 50;

/**
 * Capture the stack at the current call site. Every frame is sent, CostKey's
 * own and Node's included, along with the raw stack text: the server decides
 * which frame is the application's call site. Returns null only when the
 * runtime has no stack traces.
 */
export function captureCallSite(): CallSite | null {
  // CostKey and HTTP-client frames take slots too, so capture deeper than
  // V8's default of 10 for this one stack.
  const limit = Error.stackTraceLimit;
  let raw: string | undefined;
  try {
    if (typeof limit === "number" && limit < MIN_STACK_FRAMES) Error.stackTraceLimit = MIN_STACK_FRAMES;
    raw = new Error().stack;
  } finally {
    Error.stackTraceLimit = limit;
  }
  if (!raw) return null;
  return { raw, frames: parseStack(raw) };
}

/**
 * Parse a V8-style stack trace string into structured frames.
 *
 * V8 format:
 *   at functionName (fileName:lineNumber:columnNumber)
 *   at fileName:lineNumber:columnNumber
 *   at async functionName (fileName:lineNumber:columnNumber)
 */
function parseStack(stack: string): StackFrame[] {
  const lines = stack.split("\n");
  const frames: StackFrame[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("at ")) continue;

    const frame = parseFrame(trimmed.slice(3)); // strip "at "
    if (frame) frames.push(frame);
  }

  return frames;
}

function parseFrame(frame: string): StackFrame | null {
  // Strip "async " prefix
  const cleaned = frame.startsWith("async ") ? frame.slice(6) : frame;

  // Format: functionName (fileName:line:col)
  const parenMatch = cleaned.match(/^(.+?)\s+\((.+):(\d+):(\d+)\)$/);
  if (parenMatch) {
    return {
      functionName: parenMatch[1] || null,
      fileName: parenMatch[2] || null,
      lineNumber: parseInt(parenMatch[3], 10),
      columnNumber: parseInt(parenMatch[4], 10),
    };
  }

  // Format: fileName:line:col (anonymous)
  const directMatch = cleaned.match(/^(.+):(\d+):(\d+)$/);
  if (directMatch) {
    return {
      functionName: null,
      fileName: directMatch[1] || null,
      lineNumber: parseInt(directMatch[2], 10),
      columnNumber: parseInt(directMatch[3], 10),
    };
  }

  // Frames without a position: `new Promise (<anonymous>)`, `Array.map (native)`, `<anonymous>`.
  const bareMatch = cleaned.match(/^(.+?)\s+\((.+)\)$/);
  if (bareMatch) {
    return { functionName: bareMatch[1] || null, fileName: bareMatch[2] || null, lineNumber: null, columnNumber: null };
  }
  return { functionName: null, fileName: cleaned || null, lineNumber: null, columnNumber: null };
}
