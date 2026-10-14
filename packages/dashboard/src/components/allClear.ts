/**
 * The Overview's all-clear message ("No unusual spending") can be dismissed
 * for the rest of the month, per project. Warnings ignore this and always show.
 */
function key(projectId: string, now: Date, timeZone?: string): string {
  let month: string;
  try {
    month = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit" }).format(now).slice(0, 7);
  } catch {
    month = now.toISOString().slice(0, 7);
  }
  return `costkey.allClearDismissed.${projectId}.${month}`;
}

export function allClearDismissed(projectId: string | null | undefined, now = new Date(), timeZone?: string): boolean {
  if (!projectId) return false;
  try { return window.localStorage.getItem(key(projectId, now, timeZone)) === "1"; } catch { return false; }
}

export function dismissAllClear(projectId: string | null | undefined, now = new Date(), timeZone?: string): void {
  if (!projectId) return;
  try { window.localStorage.setItem(key(projectId, now, timeZone), "1"); } catch { /* private window: it simply shows again */ }
}
