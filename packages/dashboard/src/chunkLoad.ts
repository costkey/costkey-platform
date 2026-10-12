/**
 * Code chunks can fail to load for reasons that a page reload fixes: a proxy
 * in front of CostKey (such as Identity-Aware Proxy) refusing a background
 * script request while it refreshes its session, or a deploy replacing the
 * files mid-session. Retry once, then reload the page once.
 */
const RELOAD_KEY = "costkey:chunk-reload";

function reloadOnce(): boolean {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0);
    if (Date.now() - last < 30_000) return false;
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    return false;
  }
  window.location.reload();
  return true;
}

export async function loadChunk<T>(load: () => Promise<T>): Promise<T> {
  try {
    return await load();
  } catch (first) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    try {
      return await load();
    } catch {
      // A reload is in flight: never settle, so nothing renders an error first.
      if (reloadOnce()) return new Promise<T>(() => {});
      throw first;
    }
  }
}

/** Vite reports failed preloads here; a reload fetches them again. */
export function installChunkReload(): void {
  window.addEventListener("vite:preloadError", (event) => {
    if (reloadOnce()) event.preventDefault();
  });
}
