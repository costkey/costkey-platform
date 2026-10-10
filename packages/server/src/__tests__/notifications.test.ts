import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clearLocalNotificationSink,
  digestSchedule,
  digestWindow,
  dispatchNotification,
  dispatchWebhook,
  getLocalNotificationSink,
  isSafeWebhookUrl,
  verifyWebhookSignature,
} from "../notifications.js";

function withEnv(values: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return fn().finally(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test("webhook syntax blocks private targets and credentials", () => {
  assert.equal(isSafeWebhookUrl("http://127.0.0.1:8123/hook"), false);
  assert.equal(isSafeWebhookUrl("http://10.0.0.2/hook"), false);
  assert.equal(isSafeWebhookUrl("http://[::1]/hook"), false);
  assert.equal(isSafeWebhookUrl("http://[::ffff:127.0.0.1]/hook"), false);
  assert.equal(isSafeWebhookUrl("http://[::ffff:10.0.0.1]/hook"), false);
  assert.equal(isSafeWebhookUrl("http://[::ffff:8.8.8.8]/hook"), true);
  assert.equal(isSafeWebhookUrl("http://[2001:4860:4860::8888]/hook"), true);
  assert.equal(isSafeWebhookUrl("http://[fe80::1]/hook"), false);
  assert.equal(isSafeWebhookUrl("http://[2001:::1]/hook"), false);
  assert.equal(isSafeWebhookUrl("http://[::]/hook"), false);
  assert.equal(isSafeWebhookUrl("https://user:password@example.com/hook"), false);
  assert.equal(isSafeWebhookUrl("https://example.com/hook#redirect"), false);
  assert.equal(isSafeWebhookUrl("https://example.com/hook"), true);
});

test("memory sink signs a redacted webhook without network access", async () => {
  await withEnv({ COSTKEY_NOTIFICATION_SINK: "memory", COSTKEY_NOTIFICATION_ENCRYPTION_KEY: "test-key" }, async () => {
    clearLocalNotificationSink();
    const result = await dispatchWebhook("https://example.com/costkey", "webhook-secret", {
      eventType: "finding",
      orgId: "org_1",
      projectId: "project_1",
      title: "Spending changed",
      message: "Inspect the evidence.",
      evidence: { cost: 2.4, prompt: "must not be delivered", source: "must not be delivered" },
      scope: { findingId: "finding_1", prompt: "must not be delivered" },
      link: "https://app.costkey.dev/findings/finding_1?project=project_1",
    });
    assert.equal(result.status, "sent");
    const item = getLocalNotificationSink().at(-1);
    assert.ok(item);
    const body = JSON.parse(item.body) as Record<string, unknown>;
    assert.equal((body.evidence as Record<string, unknown>).prompt, undefined);
    assert.equal((body.evidence as Record<string, unknown>).source, undefined);
    assert.equal((body.scope as Record<string, unknown>).prompt, undefined);
    assert.equal(
      verifyWebhookSignature("webhook-secret", item.headers["X-CostKey-Timestamp"], item.body, item.headers["X-CostKey-Signature"]),
      true,
    );
  });
});

test("test mode suppresses external webhook attempts unless explicitly opted in", async () => {
  await withEnv({ NODE_ENV: "test", COSTKEY_NOTIFICATION_SINK: undefined, COSTKEY_NOTIFICATION_TEST_DELIVERY: undefined }, async () => {
    const result = await dispatchWebhook("https://example.com/costkey", "webhook-secret", {
      eventType: "finding",
      orgId: "org_1",
      title: "Finding",
      message: "No external request should be made.",
    });
    assert.equal(result.status, "suppressed");
  });
});

test("email destinations use the memory sink even when a fake provider key exists", async () => {
  await withEnv({ COSTKEY_NOTIFICATION_SINK: "memory", RESEND_API_KEY: "re_fake_key" }, async () => {
    clearLocalNotificationSink();
    let deliverySelects = 0;
    const preference = {
      id: "pref_1",
      org_id: "org_1",
      user_id: "user_1",
      project_id: null,
      email: "owner@example.com",
      findings_enabled: true,
      enforcement_enabled: true,
      weekly_summary_enabled: false,
      execution_receipts_enabled: false,
    };
    const destination = {
      id: "default_org_1_user_1_workspace",
      org_id: "org_1",
      owner_user_id: "user_1",
      project_id: null,
      kind: "email",
      address: "owner@example.com",
      event_types: ["finding"],
      enabled: true,
    };
    const query = async (sql: string): Promise<{ rows: Record<string, unknown>[]; rowCount?: number }> => {
      if (sql.includes("FROM notification_destinations") && sql.includes("enabled = TRUE")) return { rows: [] };
      if (sql.includes("FROM notification_preferences")) return { rows: [preference] };
      if (sql.includes("INSERT INTO notification_destinations")) return { rows: [] };
      return { rows: [], rowCount: 1 };
    };
    const client = {
      query: async (sql: string): Promise<{ rows: Record<string, unknown>[]; rowCount?: number }> => {
        if (sql.includes("FROM notification_deliveries")) {
          deliverySelects += 1;
          return deliverySelects === 1 ? { rows: [] } : { rows: [] };
        }
        if (sql.includes("INSERT INTO notification_deliveries")) {
          return {
            rows: [{
              id: "delivery_1",
              org_id: "org_1",
              user_id: "user_1",
              destination_id: destination.id,
              status: "pending",
              attempt_count: 0,
              created_at: new Date(),
            }],
          };
        }
        if (sql.includes("FROM findings")) return { rows: [{ state: "new" }] };
        if (sql.includes("JOIN users u")) return { rows: [destination] };
        if (sql.includes("FROM notification_preferences")) return { rows: [preference] };
        return { rows: [], rowCount: 1 };
      },
      release: () => undefined,
    };
    const pool = {
      query,
      connect: async () => client,
    } as unknown as import("pg").Pool;
    const results = await dispatchNotification(pool, {
      eventType: "finding",
      orgId: "org_1",
      projectId: "project_1",
      title: "Finding",
      message: "Review this finding.",
      evidence: { cost: 2, prompt: "do not send" },
      scope: { findingId: "finding_1" },
    });
    assert.equal(results[0]?.status, "sent");
    const item = getLocalNotificationSink().at(-1);
    assert.ok(item);
    assert.match(item.url, /^email:\/\//);
    assert.equal(item.body.includes("do not send"), false);
  });
});

test("digest windows use recipient local midnight", () => {
  const window = digestWindow(new Date("2026-09-14T03:30:00.000Z"), "Asia/Kolkata");
  assert.equal(window.startLabel, "2026-09-07");
  assert.equal(window.endLabel, "2026-09-14");
  assert.equal(window.start.toISOString(), "2026-09-06T18:30:00.000Z");
  assert.equal(window.end.toISOString(), "2026-09-13T18:30:00.000Z");
});

test("digest schedule catches up once after downtime and handles DST", () => {
  const scheduledMonday = digestSchedule(new Date("2026-09-14T03:30:00.000Z"), "Asia/Kolkata", 1, 9);
  const nextDay = digestSchedule(new Date("2026-09-15T03:30:00.000Z"), "Asia/Kolkata", 1, 9);
  const beforeFallBackSchedule = digestSchedule(new Date("2026-11-02T13:00:00.000Z"), "America/New_York", 1, 9);
  assert.equal(scheduledMonday?.scheduledAt.toISOString(), "2026-09-14T03:30:00.000Z");
  assert.equal(nextDay?.scheduledAt.toISOString(), scheduledMonday?.scheduledAt.toISOString());
  assert.equal(beforeFallBackSchedule, null);

  const newYork = digestSchedule(new Date("2026-11-03T14:00:00.000Z"), "America/New_York", 1, 9);
  assert.equal(newYork?.scheduledAt.toISOString(), "2026-11-02T14:00:00.000Z");
});
