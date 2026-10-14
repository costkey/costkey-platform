/** A span's attributes as label and text rows. Nested objects (an integration's own
 * fields, such as `openai_agents: { model }`) list their fields instead of printing
 * "[object Object]"; a field keeps its parent's name only when two would share a label. */
export function attributeRows(attributes: Record<string, unknown>): Array<[string, string]> {
  const leaves: Array<{ path: string[]; text: string }> = [];
  const walk = (value: unknown, path: string[]) => {
    if (value != null && typeof value === "object" && !Array.isArray(value)) {
      const entries = Object.entries(value as Record<string, unknown>);
      if (entries.length === 0) return;
      for (const [key, nested] of entries) walk(nested, [...path, key]);
      return;
    }
    leaves.push({ path, text: valueText(value) });
  };
  for (const [key, value] of Object.entries(attributes)) walk(value, [key]);
  const counts = new Map<string, number>();
  for (const leaf of leaves) counts.set(leaf.path[leaf.path.length - 1], (counts.get(leaf.path[leaf.path.length - 1]) ?? 0) + 1);
  return leaves.map(({ path, text }) => {
    const leaf = path[path.length - 1];
    return [counts.get(leaf)! > 1 ? path.join(".") : leaf, text];
  });
}

/** Content such as a tool's output, which may be structured. */
export function valueText(value: unknown): string {
  if (value == null) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value) && value.every((item) => item == null || typeof item !== "object")) return value.map((item) => String(item ?? "—")).join(", ");
  return JSON.stringify(value, null, 2);
}
