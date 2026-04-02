/**
 * Server-side sourcemap translation.
 * Translates minified stack frames to original source locations.
 */
import { SourceMapConsumer } from "source-map";
import type pg from "pg";
import type { StackFrame } from "@costkey/shared";

/** Initialize WASM for source-map library — call once at startup */
export async function initSourceMaps(): Promise<void> {
  // source-map v0.7+ uses WASM; some versions need explicit init
  try {
    const smc = SourceMapConsumer as unknown as Record<string, unknown>;
    if (typeof smc["initialize"] === "function") {
      (smc["initialize"] as (opts: Record<string, string>) => void)({
        "lib/mappings.wasm": "https://unpkg.com/source-map@0.7.4/lib/mappings.wasm",
      });
    }
  } catch {
    // Already initialized or not needed
  }
}

/**
 * Translate minified stack frames to original source using sourcemaps.
 * Returns translated frames and whether any translation occurred.
 */
export async function translateFrames(
  pool: pg.Pool,
  projectId: string,
  release: string,
  frames: StackFrame[],
): Promise<{ translated: StackFrame[]; wasTranslated: boolean }> {
  if (!frames.length || !release) {
    return { translated: frames, wasTranslated: false };
  }

  // Collect unique filenames from frames
  const fileNames = [...new Set(frames.map((f) => f.fileName).filter(Boolean))] as string[];
  if (fileNames.length === 0) {
    return { translated: frames, wasTranslated: false };
  }

  // Fetch matching sourcemaps
  const result = await pool.query(
    `SELECT file_name, sourcemap_json FROM sourcemaps
     WHERE project_id = $1 AND release = $2 AND file_name = ANY($3)`,
    [projectId, release, fileNames],
  );

  if (result.rows.length === 0) {
    // Try fuzzy match — strip URL protocol+host, match by path
    const fuzzyResult = await pool.query(
      `SELECT file_name, sourcemap_json FROM sourcemaps
       WHERE project_id = $1 AND release = $2`,
      [projectId, release],
    );

    if (fuzzyResult.rows.length === 0) {
      return { translated: frames, wasTranslated: false };
    }

    // Build a map of available sourcemaps by various matching strategies
    const maps = new Map<string, string>();
    for (const row of fuzzyResult.rows) {
      maps.set(row.file_name, row.sourcemap_json);
    }

    return translateWithMaps(frames, maps, fileNames);
  }

  const maps = new Map<string, string>();
  for (const row of result.rows) {
    maps.set(row.file_name, row.sourcemap_json);
  }

  return translateWithMaps(frames, maps, fileNames);
}

async function translateWithMaps(
  frames: StackFrame[],
  maps: Map<string, string>,
  _fileNames: string[],
): Promise<{ translated: StackFrame[]; wasTranslated: boolean }> {
  // Create consumers for each sourcemap
  const consumers = new Map<string, SourceMapConsumer>();
  try {
    for (const [fileName, json] of maps) {
      try {
        const consumer = await new SourceMapConsumer(JSON.parse(json));
        consumers.set(fileName, consumer);
      } catch {
        // Invalid sourcemap, skip
      }
    }

    if (consumers.size === 0) {
      return { translated: frames, wasTranslated: false };
    }

    let wasTranslated = false;
    const translated = frames.map((frame) => {
      const fileName = frame.fileName ?? "";
      // Try exact match, then path match, then basename match
      const consumer = consumers.get(fileName)
        ?? findConsumerByPath(consumers, fileName);

      if (!consumer || frame.lineNumber == null) return frame;

      const pos = consumer.originalPositionFor({
        line: frame.lineNumber,
        column: frame.columnNumber ?? 0,
      });

      if (pos.source) {
        wasTranslated = true;
        return {
          functionName: pos.name ?? frame.functionName,
          fileName: pos.source,
          lineNumber: pos.line,
          columnNumber: pos.column,
        };
      }

      return frame;
    });

    return { translated, wasTranslated };
  } finally {
    // Destroy consumers to free WASM memory
    for (const consumer of consumers.values()) {
      consumer.destroy();
    }
  }
}

/** Try to match a frame filename against available sourcemap filenames */
function findConsumerByPath(
  consumers: Map<string, SourceMapConsumer>,
  fileName: string,
): SourceMapConsumer | undefined {
  // Strip URL protocol + host: "https://app.example.com/assets/main.js" → "assets/main.js"
  let path = fileName;
  try {
    const url = new URL(fileName);
    path = url.pathname.replace(/^\//, "");
  } catch {
    // Not a URL, use as-is
  }

  // Try path match
  for (const [mapFile, consumer] of consumers) {
    if (mapFile.endsWith(path) || path.endsWith(mapFile)) {
      return consumer;
    }
    // Try basename match
    const mapBase = mapFile.split("/").pop();
    const frameBase = path.split("/").pop();
    if (mapBase && frameBase && mapBase === frameBase) {
      return consumer;
    }
  }

  return undefined;
}
