import { afterEach, describe, expect, it } from "vitest";
import { allClearDismissed, dismissAllClear } from "./allClear";

const store = new Map<string, string>();
Object.defineProperty(globalThis, "window", { value: { localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } } }, configurable: true });

describe("all-clear dismissal", () => {
  afterEach(() => store.clear());

  it("stays dismissed for the rest of the month, per project", () => {
    dismissAllClear("p1", new Date("2026-10-12T10:00:00Z"), "Asia/Kolkata");
    expect(allClearDismissed("p1", new Date("2026-10-30T10:00:00Z"), "Asia/Kolkata")).toBe(true);
    expect(allClearDismissed("p2", new Date("2026-10-30T10:00:00Z"), "Asia/Kolkata")).toBe(false);
    expect(allClearDismissed("p1", new Date("2026-11-01T10:00:00Z"), "Asia/Kolkata")).toBe(false);
  });

  it("uses the workspace month: 31 Oct 20:00 UTC is already November in India", () => {
    dismissAllClear("p1", new Date("2026-10-12T10:00:00Z"), "Asia/Kolkata");
    expect(allClearDismissed("p1", new Date("2026-10-31T20:00:00Z"), "Asia/Kolkata")).toBe(false);
  });

  it("never throws when storage is blocked", () => {
    const original = window.localStorage;
    Object.defineProperty(window, "localStorage", { get: () => { throw new Error("blocked"); }, configurable: true });
    expect(allClearDismissed("p1")).toBe(false);
    expect(() => dismissAllClear("p1")).not.toThrow();
    Object.defineProperty(window, "localStorage", { value: original, configurable: true });
  });
});
