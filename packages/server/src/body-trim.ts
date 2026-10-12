/**
 * Earlier versions stored a request or response over 100 KB as a raw text
 * slice, which the console could not read. These turn such a slice back into
 * JSON, cut at the last complete value. Bodies are stored whole now.
 */

export const TRIMMED_KEY = "__costkey_trimmed__";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Close a JSON text cut off at an arbitrary byte: keep every complete value up
 * to the cut, close an open string value, then close the open arrays and
 * objects. Used to repair bodies stored as a raw slice by earlier versions.
 */
export function closePartialJson(text: string): unknown | null {
  let inString = false;
  let escaped = false;
  const stack: string[] = [];
  // The last place where the text so far ends on complete values.
  let safe = -1;
  let safeStack: string[] = [];
  let stringStart = -1;
  let stringIsValue = false;
  let lastSignificant = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === "\"") { inString = false; lastSignificant = "\""; if (stringIsValue) { safe = i + 1; safeStack = [...stack]; } }
      continue;
    }
    if (ch === "\"") {
      inString = true; stringStart = i;
      // A string after ':' or in an array is a value; after '{' or ',' in an object it is a key.
      const top = stack[stack.length - 1];
      stringIsValue = lastSignificant === ":" || (top === "[" && (lastSignificant === "[" || lastSignificant === ","));
      continue;
    }
    if (ch === "{" || ch === "[") { stack.push(ch); lastSignificant = ch; continue; }
    if (ch === "}" || ch === "]") { stack.pop(); lastSignificant = ch; safe = i + 1; safeStack = [...stack]; continue; }
    if (ch === ",") { safe = i; safeStack = [...stack]; lastSignificant = ch; continue; }
    if (ch === ":") { lastSignificant = ch; continue; }
    if (!/\s/.test(ch)) lastSignificant = ch;
  }
  let head: string;
  let open: string[];
  if (inString && stringIsValue && stringStart >= 0) {
    // Close the cut string value, dropping a dangling escape.
    let partial = text.slice(stringStart + 1).replace(/\\u[0-9a-fA-F]{0,3}$/, "");
    if (/(^|[^\\])(\\\\)*\\$/.test(partial)) partial = partial.slice(0, -1);
    head = `${text.slice(0, stringStart)}"${partial}…"`;
    open = [...stack];
  } else {
    if (safe < 0) return null;
    head = text.slice(0, safe);
    open = safeStack;
  }
  const closing = open.reverse().map((ch) => (ch === "{" ? "}" : "]")).join("");
  try {
    return JSON.parse(head.replace(/,\s*$/, "") + closing);
  } catch {
    return null;
  }
}

/** A body stored as `{ __costkey_truncated__, preview }` turned back into an object. */
export function repairTruncatedEnvelope(envelope: unknown): unknown | null {
  if (!isRecord(envelope) || envelope["__costkey_truncated__"] !== true || typeof envelope["preview"] !== "string") return null;
  const repaired = closePartialJson(envelope["preview"]);
  if (!isRecord(repaired)) return null;
  return { ...repaired, [TRIMMED_KEY]: { original_bytes: Number(envelope["original_bytes"]) || null, cut_at_end: true } };
}
