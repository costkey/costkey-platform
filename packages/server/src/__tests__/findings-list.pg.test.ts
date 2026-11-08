import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { randomBytes } from "node:crypto";
import { initDatabase } from "../db.js";
import { getFinding, listFindings } from "../findings.js";

const connectionString = process.env["ACCOUNTING_TEST_DATABASE_URL"];

test("the findings list leaves out trace ID lists, and the finding itself keeps them", { skip: !connectionString }, async () => {
  const pool = new pg.Pool({ connectionString });
  const suffix = randomBytes(6).toString("hex");
  const orgId = `org_findings_${suffix}`;
  const projectId = `project_findings_${suffix}`;
  const findingId = `finding_${suffix}`;
  try {
    await initDatabase();
    await pool.query("INSERT INTO orgs(id,name,slug) VALUES ($1,'Findings',$2)", [orgId, `findings-${suffix}`]);
    await pool.query("INSERT INTO projects(id,name,org_id,auth_key) VALUES ($1,'Findings',$2,$3)", [projectId, orgId, `key_findings_${suffix}`]);
    const evidence = {
      currentUnitCost: 0.14,
      supportingTraceIds: { current: ["a", "b"], previous: ["c"] },
      affectedTraceIds: ["a"],
      observedDifferences: { releaseChanged: true },
    };
    await pool.query(
      `INSERT INTO findings (id, project_id, family, scope, observed_at, last_seen_at, evidence)
       VALUES ($1, $2, 'increased_unit_cost', '{"feature":"search"}', NOW(), NOW(), $3)`,
      [findingId, projectId, JSON.stringify(evidence)],
    );

    const [listed] = await listFindings(pool, projectId);
    assert.deepEqual(listed?.evidence, { currentUnitCost: 0.14, observedDifferences: { releaseChanged: true } });
    assert.deepEqual(listed?.scope, { feature: "search" });

    const finding = await getFinding(pool, projectId, findingId);
    assert.deepEqual(finding?.evidence, evidence);
  } finally {
    await pool.query("DELETE FROM projects WHERE id = $1", [projectId]).catch(() => undefined);
    await pool.query("DELETE FROM orgs WHERE id = $1", [orgId]).catch(() => undefined);
    await pool.end();
  }
});
