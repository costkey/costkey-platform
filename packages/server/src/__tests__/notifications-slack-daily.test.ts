import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clearLocalNotificationSink,
  dailySummarySchedule,
  dispatchNotification,
  dispatchSlack,
  encryptSecret,
  getLocalNotificationSink,
  isSlackWebhookUrl,
  maskSlackWebhookUrl,
  slackMessage,
} from "../notifications.js";

// Synthetic, never a real workspace: the token shape only has to satisfy validation.
const SLACK_URL = "https://hooks.slack.com/services/T00TESTWS/B00TESTCH/abcdefghijklmnopqrstuvwx";
const TOKEN = "abcdefghijklmnopqrstuvwx";

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

type Blocks = Array<Record<string, unknown>>;

test("Slack destinations accept only hooks.slack.com incoming webhooks", () => {
  assert.equal(isSlackWebhookUrl(SLACK_URL), true);
  for (const bad of [
    "http://hooks.slack.com/services/T00TESTWS/B00TESTCH/abcdefghijklmnopqrstuvwx",
    "https://hooks.slack.com.evil.test/services/T00TESTWS/B00TESTCH/abcdefghijklmnopqrstuvwx",
    "https://evil.test/hooks.slack.com/services/T00TESTWS/B00TESTCH/abcdefghijklmnopqrstuvwx",
    "https://hooks.slack.com:8443/services/T00TESTWS/B00TESTCH/abcdefghijklmnopqrstuvwx",
    "https://user:pass@hooks.slack.com/services/T00TESTWS/B00TESTCH/abcdefghijklmnopqrstuvwx",
    "https://hooks.slack.com/services/T00TESTWS/B00TESTCH/abcdefghijklmnopqrstuvwx?x=1",
    "https://hooks.slack.com/services/T00TESTWS/B00TESTCH/abcdefghijklmnopqrstuvwx#x",
    "https://hooks.slack.com/services/T00TESTWS/B00TESTCH/abcdefghijklmnopqrstuvwx/",
    "https://hooks.slack.com/services/T00TESTWS/B00TESTCH/../../x/abcdefghijklmnop",
    "https://hooks.slack.com/workflows/T00TESTWS/A00TESTCH/123/abcdefghijklmnopqrstuvwx",
    "https://hooks.slack.com/services/t00testws/B00TESTCH/abcdefghijklmnopqrstuvwx",
    "https://hooks.slack.com/services/T00TESTWS/B00TESTCH/short",
    " https://hooks.slack.com/services/T00TESTWS/B00TESTCH/abcdefghijklmnopqrstuvwx",
    "https://127.0.0.1/services/T00TESTWS/B00TESTCH/abcdefghijklmnopqrstuvwx",
    "",
    null,
  ]) assert.equal(isSlackWebhookUrl(bad), false, String(bad));
});

test("Slack webhook URLs are masked without the token", () => {
  const masked = maskSlackWebhookUrl(SLACK_URL);
  assert.equal(masked.includes(TOKEN), false);
  assert.equal(masked.startsWith("hooks.slack.com/services/T00TESTWS/B00TESTCH/"), true);
  assert.equal(masked.endsWith("uvwx"), true);
  assert.equal(maskSlackWebhookUrl("not a url").includes("not a url"), false);
});

test("Slack messages carry a header, 1-3 fields and a CostKey link button for every event type", () => {
  const cases: Array<Record<string, unknown>> = [
    { eventType: "daily_summary", title: "Daily spend · 2026-10-09", message: "$12.00 yesterday.", evidence: { cost: 12, changePct: 0.25, unpricedCalls: 3 }, link: "https://app.costkey.dev/overview?project=p1" },
    { eventType: "weekly_summary", title: "Your CostKey spending summary", message: "Week.", evidence: { cost: 80, changePct: -0.1, calls: 900 } },
    { eventType: "policy_warning", title: "Allowance warning at 80%", message: "Warn.", evidence: { policyId: "pol_1", threshold: 0.8, observedUsage: 8, allowance: 10 } },
    { eventType: "enforcement", title: "A CostKey policy refused a call", message: "Refused.", evidence: { policyId: "pol_1", reason: "budget_exhausted" } },
    { eventType: "finding", title: "Cost per comparable trace increased", message: "Finding.", evidence: { cost: 2, changePct: 0.5, family: "increased_unit_cost" } },
    { eventType: "execution_receipt", title: "Your grouped-work CostKey digest", message: "Batches.", evidence: { executionCount: 4, cost: 1.5 } },
    { eventType: "weekly_summary", title: "CostKey channel test", message: "Test." },
  ];
  for (const payload of cases) {
    const message = slackMessage(payload);
    const blocks = message.blocks as Blocks;
    assert.equal(typeof message.text, "string");
    assert.equal(blocks[0].type, "header");
    assert.equal((blocks[0].text as Record<string, unknown>).text, payload.title);
    const section = blocks.find((block) => block.type === "section");
    assert.ok(section, String(payload.eventType));
    const fields = section.fields as unknown[];
    assert.ok(fields.length >= 1 && fields.length <= 3, String(payload.eventType));
    const actions = blocks.find((block) => block.type === "actions");
    assert.ok(actions);
    const button = (actions.elements as Blocks)[0];
    assert.equal((button.text as Record<string, unknown>).text, "View in CostKey");
    assert.match(String(button.url), /^https:\/\/app\.costkey\.dev\//);
  }
  const daily = slackMessage(cases[0]);
  const dailyFields = ((daily.blocks as Blocks)[1].fields as Array<{ text: string }>).map((field) => field.text);
  assert.deepEqual(dailyFields, ["*Yesterday*\n$12.00", "*Change*\n+25%", "*Unpriced calls*\n3"]);
});

test("Slack messages escape markup and drop off-origin links", () => {
  const message = slackMessage({
    eventType: "finding",
    title: "Spend <!channel>",
    message: "See <https://evil.test|here> & more",
    link: "https://evil.test/phish",
  });
  assert.equal(String(message.text).includes("<!channel>"), false);
  const section = (message.blocks as Blocks).find((block) => block.type === "section")!;
  assert.equal((section.text as Record<string, unknown>).text, "See &lt;https://evil.test|here&gt; &amp; more");
  const actions = (message.blocks as Blocks).find((block) => block.type === "actions")!;
  assert.equal(String((actions.elements as Blocks)[0].url).startsWith("https://app.costkey.dev/"), true);
});

test("Slack delivery uses the memory sink and never records the token", async () => {
  await withEnv({ COSTKEY_NOTIFICATION_SINK: "memory" }, async () => {
    clearLocalNotificationSink();
    const result = await dispatchSlack(SLACK_URL, { eventType: "daily_summary", title: "Daily", message: "Short.", evidence: { cost: 1 } });
    assert.equal(result.status, "sent");
    const item = getLocalNotificationSink().at(-1);
    assert.ok(item);
    assert.equal(item.url.startsWith("slack://hooks.slack.com/services/"), true);
    assert.equal(item.url.includes(TOKEN), false);
    const body = JSON.parse(item.body) as Record<string, unknown>;
    assert.ok(Array.isArray(body.blocks));
  });
});

test("Slack delivery is suppressed in test mode and rejects non-Slack URLs", async () => {
  await withEnv({ NODE_ENV: "test", COSTKEY_NOTIFICATION_SINK: undefined, COSTKEY_NOTIFICATION_TEST_DELIVERY: undefined }, async () => {
    const suppressed = await dispatchSlack(SLACK_URL, { eventType: "finding", title: "x", message: "y" });
    assert.equal(suppressed.status, "suppressed");
    const invalid = await dispatchSlack("https://example.com/services/T1/B1/abcdefghijklmnopqrstuvwx", { eventType: "finding", title: "x", message: "y" });
    assert.equal(invalid.status, "failed");
    const missing = await dispatchSlack(null, { eventType: "finding", title: "x", message: "y" });
    assert.equal(missing.status, "suppressed");
  });
});

test("dispatchNotification delivers to a Slack destination from its encrypted URL", async () => {
  await withEnv({ COSTKEY_NOTIFICATION_SINK: "memory", COSTKEY_NOTIFICATION_ENCRYPTION_KEY: "slack-test-key" }, async () => {
    clearLocalNotificationSink();
    const destination = {
      id: "dest_slack",
      org_id: "org_1",
      owner_user_id: "user_1",
      project_id: null,
      kind: "slack",
      address: maskSlackWebhookUrl(SLACK_URL),
      secret_ciphertext: encryptSecret(SLACK_URL),
      event_types: ["daily_summary"],
      enabled: true,
    };
    const preference = { id: "pref_1", org_id: "org_1", user_id: "user_1", project_id: null, email: "bad", daily_summary_enabled: true };
    const query = async (sql: string): Promise<{ rows: Record<string, unknown>[]; rowCount?: number }> => {
      if (sql.includes("FROM notification_destinations") && sql.includes("enabled = TRUE")) return { rows: [destination] };
      if (sql.includes("FROM notification_preferences")) return { rows: [preference] };
      return { rows: [], rowCount: 1 };
    };
    const client = {
      query: async (sql: string): Promise<{ rows: Record<string, unknown>[]; rowCount?: number }> => {
        if (sql.includes("INSERT INTO notification_deliveries")) {
          return { rows: [{ id: "delivery_slack", org_id: "org_1", user_id: "user_1", destination_id: destination.id, status: "pending", attempt_count: 0, created_at: new Date() }] };
        }
        if (sql.includes("FROM notification_deliveries")) return { rows: [] };
        if (sql.includes("JOIN users u")) return { rows: [destination] };
        if (sql.includes("FROM notification_preferences")) return { rows: [preference] };
        return { rows: [], rowCount: 1 };
      },
      release: () => undefined,
    };
    const pool = { query, connect: async () => client } as unknown as import("pg").Pool;
    const results = await dispatchNotification(pool, {
      eventType: "daily_summary",
      orgId: "org_1",
      recipientUserId: "user_1",
      preferenceProjectId: null,
      title: "Daily spend · 2026-10-09",
      message: "$1.00 yesterday.",
      evidence: { cost: 1, calls: 3, prompt: "never" },
      dedupeKey: "daily_summary:workspace:2026-10-08T18:30:00.000Z:user_1",
    });
    assert.equal(results[0]?.status, "sent");
    const item = getLocalNotificationSink().at(-1);
    assert.ok(item);
    assert.match(item.url, /^slack:\/\//);
    assert.equal(item.body.includes("never"), false);
    assert.equal(item.url.includes(TOKEN), false);
  });
});

test("daily summary schedule fires once per local day at the chosen hour", () => {
  // 03:30Z is 09:00 in Kolkata.
  const atNine = dailySummarySchedule(new Date("2026-10-10T03:30:00.000Z"), "Asia/Kolkata", 9);
  assert.equal(atNine?.dateLabel, "2026-10-10");
  assert.equal(atNine?.scheduledAt.toISOString(), "2026-10-10T03:30:00.000Z");
  // Later the same day: same instant, so the dedupe key is stable.
  const later = dailySummarySchedule(new Date("2026-10-10T12:00:00.000Z"), "Asia/Kolkata", 9);
  assert.equal(later?.scheduledAt.toISOString(), atNine?.scheduledAt.toISOString());
  // Before the hour: still yesterday's schedule.
  const before = dailySummarySchedule(new Date("2026-10-10T02:00:00.000Z"), "Asia/Kolkata", 9);
  assert.equal(before?.dateLabel, "2026-10-09");
  // Invalid inputs fall back to UTC 09:00.
  const fallback = dailySummarySchedule(new Date("2026-10-10T10:00:00.000Z"), "Not/AZone", 99);
  assert.equal(fallback?.scheduledAt.toISOString(), "2026-10-10T09:00:00.000Z");
});
