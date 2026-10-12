import { describe, expect, it } from "vitest";
import { ingestStatus } from "./IngestStatus";

const now = Date.parse("2026-10-12T10:00:00Z");

describe("ingest status", () => {
  it("is live while events arrive, with how long ago the last one was", () => {
    expect(ingestStatus({ status: "active", lastEventAt: "2026-10-12T09:59:48Z", eventsLastHour: 40, failedLastHour: 0 }, now)).toEqual({ tone: "live", label: "Receiving data", detail: "Last event 12 s ago" });
  });

  it("is idle when nothing arrived recently", () => {
    expect(ingestStatus({ status: "idle", lastEventAt: "2026-10-12T09:20:00Z", eventsLastHour: 0, failedLastHour: 0 }, now)).toMatchObject({ tone: "idle", label: "Idle", detail: "Last event 40 min ago" });
  });

  it("warns when calls fail, and turns red when most do", () => {
    expect(ingestStatus({ status: "active", lastEventAt: "2026-10-12T09:59:00Z", eventsLastHour: 10, failedLastHour: 2 }, now).tone).toBe("warn");
    expect(ingestStatus({ status: "active", lastEventAt: "2026-10-12T09:59:00Z", eventsLastHour: 10, failedLastHour: 8 }, now).tone).toBe("error");
  });
});
