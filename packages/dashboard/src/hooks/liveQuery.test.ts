import { describe, expect, it } from "vitest";
import { LIVE_BACKOFF_MS, LIVE_FAST_INTERVAL_MS, LIVE_INTERVAL_MS, LIVE_MAX_SKIP_MS, LivePoller, setLiveVersionSource, type LiveEnvironment } from "./liveQuery";
import { liveStatusText } from "../components/LiveStatus";

/** A clock and visibility we control. */
function fakeEnvironment() {
  let now = 0;
  let visible = true;
  const timers: Array<{ at: number; callback: () => void; id: number }> = [];
  const listeners = new Set<() => void>();
  let nextId = 1;
  const env: LiveEnvironment = {
    visible: () => visible,
    onVisibilityChange: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    setTimeout: (callback, ms) => { const id = nextId++; timers.push({ at: now + ms, callback, id }); return id; },
    clearTimeout: (handle) => { const index = timers.findIndex((timer) => timer.id === handle); if (index >= 0) timers.splice(index, 1); },
    now: () => now,
  };
  return {
    env,
    pendingDelays: () => timers.map((timer) => timer.at - now),
    async advance(ms: number) {
      const until = now + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (!next || next.at > until) break;
        timers.shift();
        now = next.at;
        next.callback();
        await flush();
      }
      now = until;
    },
    async setVisible(value: boolean) { visible = value; for (const listener of listeners) listener(); await flush(); },
  };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("live queries", () => {
  it("refreshes every 10 s and keeps data on screen across refreshes", async () => {
    const clock = fakeEnvironment();
    let calls = 0;
    const poller = new LivePoller(async () => { calls += 1; return { runs: calls }; }, { environment: clock.env });
    const seen: Array<boolean> = [];
    poller.subscribe((state) => seen.push(state.data == null && !state.loading));
    poller.start();
    await flush();
    expect(poller.snapshot.data).toEqual({ runs: 1 });
    expect(clock.pendingDelays()).toEqual([LIVE_INTERVAL_MS]);
    await clock.advance(LIVE_INTERVAL_MS);
    expect(poller.snapshot.data).toEqual({ runs: 2 });
    expect(poller.snapshot.loading).toBe(false);
    expect(seen.every((empty) => !empty)).toBe(true);
    poller.stop();
  });

  it("pauses while the tab is hidden and refetches at once when it comes back", async () => {
    const clock = fakeEnvironment();
    let calls = 0;
    const poller = new LivePoller(async () => ++calls, { environment: clock.env });
    poller.start();
    await flush();
    await clock.setVisible(false);
    expect(poller.snapshot.status).toBe("paused");
    await clock.advance(5 * LIVE_INTERVAL_MS);
    expect(calls).toBe(1);
    await clock.setVisible(true);
    expect(calls).toBe(2);
    expect(poller.snapshot.status).toBe("live");
    poller.stop();
  });

  it("backs off to a minute after three failed refreshes, keeping the last data", async () => {
    const clock = fakeEnvironment();
    let fail = false;
    const poller = new LivePoller(async () => { if (fail) throw new Error("offline"); return "ok"; }, { environment: clock.env });
    poller.start();
    await flush();
    fail = true;
    await clock.advance(LIVE_INTERVAL_MS * 3);
    expect(poller.snapshot.failures).toBe(3);
    expect(poller.snapshot.status).toBe("reconnecting");
    expect(poller.snapshot.data).toBe("ok");
    expect(clock.pendingDelays()).toEqual([LIVE_BACKOFF_MS]);
    fail = false;
    await clock.advance(LIVE_BACKOFF_MS);
    expect(poller.snapshot.failures).toBe(0);
    expect(clock.pendingDelays()).toEqual([LIVE_INTERVAL_MS]);
    poller.stop();
  });

  it("polls every 3 s while a run is still in progress", async () => {
    const clock = fakeEnvironment();
    let running = true;
    const poller = new LivePoller(async () => ({ running }), { environment: clock.env, isFast: (data) => data.running });
    poller.start();
    await flush();
    expect(clock.pendingDelays()).toEqual([LIVE_FAST_INTERVAL_MS]);
    running = false;
    await clock.advance(LIVE_FAST_INTERVAL_MS);
    expect(clock.pendingDelays()).toEqual([LIVE_INTERVAL_MS]);
    poller.stop();
  });

  it("holds new rows while the pointer is on the list", async () => {
    const clock = fakeEnvironment();
    let calls = 0;
    let pointerOnList = false;
    const poller = new LivePoller(async () => ++calls, { environment: clock.env, shouldDefer: () => pointerOnList });
    poller.start();
    await flush();
    pointerOnList = true;
    await clock.advance(LIVE_INTERVAL_MS);
    expect(poller.snapshot.data).toBe(1);
    pointerOnList = false;
    await clock.advance(1_000);
    expect(poller.snapshot.data).toBe(2);
    poller.stop();
  });

  it("says how fresh the data is", () => {
    expect(liveStatusText("live", 0, 2_000)).toBe("Updated just now");
    expect(liveStatusText("live", 0, 12_000)).toBe("Updated 12 s ago");
    expect(liveStatusText("reconnecting", 0, 12_000)).toBe("Reconnecting");
  });

  it("skips a refresh when the project has no new calls, and reloads when it does", async () => {
    const clock = fakeEnvironment();
    let version = "a";
    let checks = 0;
    setLiveVersionSource(async () => { checks += 1; return version; });
    let loads = 0;
    const poller = new LivePoller(async () => { loads += 1; return { loads }; }, { environment: clock.env });
    poller.start();
    await flush();
    expect(loads).toBe(1);
    await clock.advance(LIVE_INTERVAL_MS);
    expect(loads).toBe(1);                      // nothing new: the heavy query didn't run
    expect(checks).toBeGreaterThan(1);
    version = "b";                              // a new call arrived
    await clock.advance(LIVE_INTERVAL_MS);
    expect(loads).toBe(2);
    poller.stop();
    setLiveVersionSource(null);
  });

  it("reloads at least once a minute, on Refresh, and while something is running", async () => {
    const clock = fakeEnvironment();
    setLiveVersionSource(async () => "same");
    let loads = 0;
    const poller = new LivePoller(async () => { loads += 1; return { loads }; }, { environment: clock.env });
    poller.start();
    await flush();
    await clock.advance(LIVE_MAX_SKIP_MS + LIVE_INTERVAL_MS);
    expect(loads).toBe(2);                      // a sliding window still moves
    poller.refresh();
    await flush();
    expect(loads).toBe(3);                      // the Refresh button always reloads
    poller.stop();

    let fastLoads = 0;
    const running = new LivePoller(async () => { fastLoads += 1; return { running: true }; }, { environment: clock.env, isFast: () => true });
    running.start();
    await flush();
    await clock.advance(LIVE_FAST_INTERVAL_MS);
    expect(fastLoads).toBe(2);                  // a run in progress refreshes regardless
    running.stop();
    setLiveVersionSource(null);
  });
});
