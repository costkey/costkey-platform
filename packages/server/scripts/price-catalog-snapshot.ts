/**
 * Regenerate the price catalog snapshot shipped with the server. A fresh
 * install seeds from it, then the scheduled sync keeps prices current.
 *
 *   npm run pricing:snapshot --workspace=@costkey/server
 */
import { writeFile } from "node:fs/promises";
import { PRICE_SOURCES } from "../src/price-catalog/sync.js";
import type { CatalogEntry } from "../src/price-catalog/types.js";

const entries: CatalogEntry[] = [];
const sources: Record<string, { url: string; entries: number }> = {};
for (const { source, url, normalize } of PRICE_SOURCES) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000), headers: { "User-Agent": "costkey-price-sync" } });
  if (!response.ok) throw new Error(`${source}: HTTP ${response.status}`);
  const normalized = normalize(await response.json());
  if (normalized.length === 0) throw new Error(`${source}: no prices`);
  entries.push(...normalized);
  sources[source] = { url, entries: normalized.length };
}
const target = new URL("../data/price-catalog.snapshot.json", import.meta.url);
await writeFile(target, `${JSON.stringify({ generatedAt: new Date().toISOString(), sources, entries })}\n`);
console.log(`Wrote ${entries.length} prices to ${target.pathname}`, sources);
