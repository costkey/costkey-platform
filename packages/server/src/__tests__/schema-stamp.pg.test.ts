import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";

const connectionString = process.env["ACCOUNTING_TEST_DATABASE_URL"];

test("a build sets up its schema once; later boots start while tables are busy", { skip: !connectionString }, async () => {
  process.env["DATABASE_URL"] = connectionString;
  process.env["COSTKEY_COMMIT"] = "5c4e3a2b1c0d";
  const { createApp } = await import("../index.js");
  const { shutdownDatabase } = await import("../db.js");
  const other = new pg.Client({ connectionString });
  try {
    const first = createApp({ initialize: false, startSchedulers: false, includeDashboard: false });
    await first.initialize();
    const stamp = await first.pool.query("SELECT 1 FROM migrations WHERE name = 'schema@5c4e3a2b1c0d'");
    assert.equal(stamp.rows.length, 1);

    // Another session holds events the way a long report or a deploy's DDL can.
    await other.connect();
    await other.query("BEGIN");
    await other.query("LOCK TABLE events IN ACCESS EXCLUSIVE MODE");
    const second = createApp({ initialize: false, startSchedulers: false, includeDashboard: false });
    const started = await Promise.race([
      second.initialize().then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 10_000)),
    ]);
    assert.equal(started, true, "a later boot of the same build takes no table locks");
  } finally {
    await other.query("ROLLBACK").catch(() => undefined);
    await other.end().catch(() => undefined);
    await shutdownDatabase();
  }
});
