import { describe, expect, it } from "vitest";
import type { TrendBucket } from "../api";
import type { WidgetSpec } from "../dashboardsApi";
import { breakdownRows, bucketLabel, defaultTitle, periodRange, requestsFor, totalOf, withShares } from "./dashboardWidgets";

const widget = (fields: Partial<WidgetSpec>): WidgetSpec => ({ id: "w", title: "", kind: "total", metric: "cost", period: "7d", width: "half", ...fields });
const bucket = (cost: number | null, calls: number, tokens: number, unpriced = 0): TrendBucket =>
  ({ bucket: "2026-11-01", cost, calls, input_tokens: tokens, output_tokens: 0, unpriced_count: unpriced }) as TrendBucket;

describe("dashboard widgets", () => {
  it("shares one request between widgets that need the same data", () => {
    const requests = requestsFor([
      widget({ id: "a", kind: "total", metric: "cost", period: "7d" }),
      widget({ id: "b", kind: "total", metric: "calls", period: "7d" }),
      widget({ id: "c", kind: "trend", metric: "cost", period: "7d" }),
      widget({ id: "d", kind: "breakdown", metric: "cost", groupBy: "model", period: "30d" }),
      widget({ id: "e", kind: "breakdown", metric: "calls", groupBy: "model", period: "30d" }),
      widget({ id: "f", kind: "trend", metric: "tokens", period: "24h" }),
    ]);
    expect(requests.map((request) => request.key)).toEqual(["trends:7d", "costs:30d:model", "trends:24h"]);
  });

  it("totals a metric and counts unpriced calls only for spend", () => {
    const trends = [bucket(0.5, 10, 100, 2), bucket(null, 4, 50, 1)];
    expect(totalOf(trends, "cost")).toEqual({ value: 0.5, unpriced: 3 });
    expect(totalOf(trends, "calls")).toEqual({ value: 14, unpriced: 0 });
    expect(totalOf(trends, "tokens").value).toBe(150);
  });

  it("ranks a breakdown and names unlabelled rows", () => {
    const rows = breakdownRows({ contributors: [{ key: "a", known_cost: 1 }, { label: "b", known_cost: 3 }, { known_cost: 2 }] }, "cost");
    expect(rows).toEqual([{ label: "b", value: 3 }, { label: "Unattributed", value: 2 }, { label: "a", value: 1 }]);
  });

  it("titles and windows", () => {
    expect(defaultTitle({ kind: "breakdown", metric: "cost", groupBy: "feature" })).toBe("Spend by feature");
    const range = periodRange("24h", Date.UTC(2026, 10, 10, 12, 0, 30));
    expect([range.from, range.to, range.bucket]).toEqual(["2026-11-09T12:00:00.000Z", "2026-11-10T12:00:00.000Z", "hour"]);
  });

  it("labels buckets and shares", () => {
    expect(bucketLabel("2026-11-03T00:00:00Z", false, "UTC")).toBe("3 Nov");
    expect(bucketLabel("2026-11-03T14:00:00Z", true, "UTC")).toBe("14:00");
    expect(withShares([{ label: "a", value: 3 }, { label: "b", value: 1 }]).map((row) => row.share)).toEqual([0.75, 0.25]);
  });
});
