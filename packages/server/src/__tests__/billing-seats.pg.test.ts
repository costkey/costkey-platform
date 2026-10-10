import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import pg from "pg";
import { randomBytes } from "node:crypto";
import { initDatabase, shutdownDatabase } from "../db.js";
import { ensurePlatformSchema } from "../platform-storage.js";
import { applyStripeWebhookEvent, createSubscriptionRouter, syncSubscriptionSeats } from "../subscription.js";

const connectionString = process.env["ACCOUNTING_TEST_DATABASE_URL"];

test("billing is $9 per member, and seats follow the team", { skip: !connectionString }, async () => {
  const pool = new pg.Pool({ connectionString });
  const suffix = randomBytes(6).toString("hex");
  const orgId = `org_seats_${suffix}`;
  const subId = `sub_seats_${suffix}`;
  const owner = { id: `usr_seats_owner_${suffix}`, email: `owner_${suffix}@seats.test`, orgId, role: "owner" };
  const env = { secret: process.env["STRIPE_SECRET_KEY"], price: process.env["COSTKEY_STRIPE_PRICE_ID"] };
  process.env["STRIPE_SECRET_KEY"] = "sk_test_seats";
  process.env["COSTKEY_STRIPE_PRICE_ID"] = "price_seat";

  // A stand-in for Stripe; every other request goes through.
  const realFetch = globalThis.fetch;
  const stripeCalls: Array<{ method: string; path: string; body: URLSearchParams | null }> = [];
  let priceCents = 900;
  let remoteQuantity = 1;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith("https://api.stripe.com")) return realFetch(input, init);
    const path = new URL(url).pathname;
    const method = init?.method ?? "GET";
    const body = init?.body instanceof URLSearchParams ? init.body : null;
    stripeCalls.push({ method, path, body });
    const json = (payload: unknown) => new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    if (path === "/v1/prices/price_seat") return json({ active: true, currency: "usd", unit_amount: priceCents, recurring: { interval: "month", interval_count: 1 } });
    if (path === "/v1/checkout/sessions") return json({ id: "cs_seats", url: "https://checkout.stripe.test/cs_seats" });
    if (path === `/v1/subscriptions/${subId}` && method === "GET") return json({ items: { data: [{ id: "si_seats", quantity: remoteQuantity, price: { id: "price_seat" } }] } });
    if (path === `/v1/subscriptions/${subId}` && method === "POST") { remoteQuantity = Number(body?.get("items[0][quantity]")); return json({}); }
    return new Response(JSON.stringify({ error: { message: `unexpected ${method} ${path}` } }), { status: 404 });
  }) as typeof fetch;

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as unknown as { user: typeof owner }).user = owner; next(); });
  app.use(createSubscriptionRouter(pool));
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = async (path: string, init: RequestInit = {}) => {
    const response = await realFetch(`${base}${path}`, { ...init, headers: { "content-type": "application/json" } });
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  const stripeWrites = () => stripeCalls.filter((entry) => entry.method === "POST" && entry.path === `/v1/subscriptions/${subId}`);

  try {
    await initDatabase();
    await ensurePlatformSchema(pool);
    await pool.query("INSERT INTO orgs(id,name,slug) VALUES ($1,'Seats',$2)", [orgId, `seats-${suffix}`]);
    for (const [index, role] of ["owner", "developer", "viewer"].entries()) {
      const id = index === 0 ? owner.id : `usr_seats_${index}_${suffix}`;
      await pool.query("INSERT INTO users(id,email,password_hash,name,org_id,role) VALUES ($1,$2,'x',$3,$4,$5)", [id, `${id}@seats.test`, id, orgId, role]);
    }

    const before = await call("/api/v1/subscription");
    assert.equal(before.status, 200);
    assert.equal(before.body.subscription.pricing, "per_user");
    assert.equal(before.body.subscription.seats, 3);
    assert.equal(before.body.subscription.amountCents, 900);
    assert.equal(before.body.subscription.totalCents, 2700);
    assert.deepEqual(before.body.target, { amountUsd: 9, interval: "month", per: "user", seats: 3, totalUsd: 27 });

    const checkout = await call("/api/v1/subscription/checkout", { method: "POST", body: "{}" });
    assert.equal(checkout.status, 200);
    assert.equal(checkout.body.seats, 3);
    const session = stripeCalls.find((entry) => entry.path === "/v1/checkout/sessions");
    assert.equal(session?.body?.get("line_items[0][quantity]"), "3", "checkout bills one seat per member");

    // Stripe confirms the subscription at the quantity bought.
    await applyStripeWebhookEvent(pool, {
      id: `evt_seats_${suffix}`, type: "customer.subscription.created", created: Math.floor(Date.now() / 1000),
      data: { object: { metadata: { org_id: orgId }, id: subId, customer: `cus_seats_${suffix}`, status: "active", items: { data: [{ quantity: 1 }] } } },
    });
    assert.equal((await pool.query("SELECT seats FROM subscriptions WHERE org_id = $1", [orgId])).rows[0].seats, 1);

    // Reconciles to the team's size, with proration.
    const synced = await syncSubscriptionSeats(pool, orgId);
    assert.deepEqual(synced, { seats: 3, updated: true });
    const write = stripeWrites().at(-1)!;
    assert.equal(write.body?.get("items[0][id]"), "si_seats");
    assert.equal(write.body?.get("items[0][quantity]"), "3");
    assert.equal(write.body?.get("proration_behavior"), "create_prorations");
    assert.equal((await pool.query("SELECT seats FROM subscriptions WHERE org_id = $1", [orgId])).rows[0].seats, 3);

    // Already in step: nothing is written.
    assert.deepEqual(await syncSubscriptionSeats(pool, orgId), { seats: 3, updated: false });
    assert.equal(stripeWrites().length, 1);

    // Someone leaves.
    await pool.query("DELETE FROM users WHERE id = $1", [`usr_seats_2_${suffix}`]);
    assert.deepEqual(await syncSubscriptionSeats(pool, orgId), { seats: 2, updated: true });
    assert.equal(remoteQuantity, 2);

    // A workspace on the old flat $10 plan keeps it.
    await pool.query("UPDATE subscriptions SET amount_cents = 1000 WHERE org_id = $1", [orgId]);
    const writesBefore = stripeWrites().length;
    assert.deepEqual(await syncSubscriptionSeats(pool, orgId), { seats: 2, updated: false });
    assert.equal(stripeWrites().length, writesBefore);
    const legacy = await call("/api/v1/subscription");
    assert.equal(legacy.body.subscription.pricing, "workspace");
    assert.equal(legacy.body.subscription.totalCents, 1000);
    assert.equal(legacy.body.target.per, "workspace");

    // Checkout refuses a Stripe price that is not $9.
    priceCents = 1000;
    await pool.query("UPDATE subscriptions SET status = 'canceled' WHERE org_id = $1", [orgId]);
    assert.equal((await call("/api/v1/subscription/checkout", { method: "POST", body: "{}" })).status, 502);
  } finally {
    globalThis.fetch = realFetch;
    if (env.secret === undefined) delete process.env["STRIPE_SECRET_KEY"]; else process.env["STRIPE_SECRET_KEY"] = env.secret;
    if (env.price === undefined) delete process.env["COSTKEY_STRIPE_PRICE_ID"]; else process.env["COSTKEY_STRIPE_PRICE_ID"] = env.price;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const table of ["subscription_events", "subscription_invoices", "subscriptions", "users"]) {
      await pool.query(`DELETE FROM ${table} WHERE org_id = $1`, [orgId]).catch(() => undefined);
    }
    await pool.query("DELETE FROM orgs WHERE id = $1", [orgId]).catch(() => undefined);
    await pool.end();
    await shutdownDatabase();
  }
});
