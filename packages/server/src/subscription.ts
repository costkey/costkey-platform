import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request, Response, Router } from "express";
import { Router as createRouter } from "express";
import type pg from "pg";
import { requireAuth } from "./auth.js";
import { roleCanManageSubscription } from "./permissions.js";
import { publicAppUrl } from "./public-url.js";

type SubscriptionUser = { id: string; email: string; orgId: string; role: string };

/** $9 per user per month. Every member of the workspace is a seat. */
export const SEAT_PRICE_CENTS = 900;
/** Subscriptions bought at the old flat $10 workspace price keep it. */
const LEGACY_WORKSPACE_CENTS = 1000;
const ENTITLED = ["active", "trialing", "past_due"];

function userOf(req: Request): SubscriptionUser | null {
  return (req as Request & { user?: SubscriptionUser }).user ?? null;
}

function providerConfigured(): boolean {
  return Boolean(process.env["STRIPE_SECRET_KEY"] && process.env["COSTKEY_STRIPE_PRICE_ID"]);
}

function randomId(prefix = "sub"): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `${prefix}_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function verifyStripeWebhookSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  secret: string,
  maxAgeSeconds = 300,
): boolean {
  if (!signatureHeader) return false;
  const parts = new Map(signatureHeader.split(",").map((part) => {
    const index = part.indexOf("=");
    return index > 0 ? [part.slice(0, index), part.slice(index + 1)] as const : ["", ""] as const;
  }));
  const timestamp = parts.get("t");
  const supplied = parts.get("v1");
  if (!timestamp || !supplied || Math.abs(Date.now() / 1000 - Number(timestamp)) > maxAgeSeconds) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  const suppliedBuffer = Buffer.from(supplied, "hex");
  return suppliedBuffer.length === expectedBuffer.length && timingSafeEqual(suppliedBuffer, expectedBuffer);
}

async function stripeRequest<T>(path: string, method: "POST" | "GET", params?: URLSearchParams, idempotencyKey?: string): Promise<T> {
  const key = process.env["STRIPE_SECRET_KEY"];
  if (!key) throw new Error("Stripe is not configured");
  const response = await fetch(`https://api.stripe.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      ...(params ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: params,
  });
  const payload = await response.json() as T & { error?: { message?: string } };
  if (!response.ok) throw new Error(payload.error?.message ?? `Stripe returned HTTP ${response.status}`);
  return payload;
}

async function validateStripePrice(): Promise<void> {
  const priceId = process.env["COSTKEY_STRIPE_PRICE_ID"];
  if (!priceId) throw new Error("Stripe price is not configured");
  const price = await stripeRequest<{
    active?: boolean;
    currency?: string;
    unit_amount?: number;
    recurring?: { interval?: string; interval_count?: number };
  }>(`/v1/prices/${encodeURIComponent(priceId)}`, "GET");
  if (price.active !== true || price.currency?.toLowerCase() !== "usd" || price.unit_amount !== SEAT_PRICE_CENTS
    || price.recurring?.interval !== "month" || price.recurring.interval_count !== 1) {
    throw new Error("Configured Stripe price is not the $9 USD monthly per-user subscription");
  }
}

/** Billable seats: everyone in the workspace, and never fewer than one. */
export async function countSeats(pool: pg.Pool, orgId: string): Promise<number> {
  const result = await pool.query("SELECT COUNT(*)::int AS seats FROM users WHERE org_id = $1", [orgId]);
  return Math.max(1, Number(result.rows[0]?.seats) || 0);
}

function isLegacyWorkspacePlan(row: Record<string, unknown>): boolean {
  return Number(row.amount_cents) === LEGACY_WORKSPACE_CENTS && ENTITLED.includes(String(row.status));
}

/**
 * Keep the Stripe quantity equal to the workspace's members, prorated.
 * Only per-user subscriptions on the configured price are touched; a
 * workspace on the old flat price keeps it.
 */
export async function syncSubscriptionSeats(pool: pg.Pool, orgId: string): Promise<{ seats: number; updated: boolean }> {
  const seats = await countSeats(pool, orgId);
  const row = (await pool.query("SELECT * FROM subscriptions WHERE org_id = $1", [orgId])).rows[0] as Record<string, unknown> | undefined;
  const priceId = process.env["COSTKEY_STRIPE_PRICE_ID"];
  if (!row || row.provider !== "stripe" || typeof row.provider_subscription_id !== "string" || !ENTITLED.includes(String(row.status))
    || isLegacyWorkspacePlan(row) || !priceId || !process.env["STRIPE_SECRET_KEY"]) {
    return { seats, updated: false };
  }
  const subscriptionPath = `/v1/subscriptions/${encodeURIComponent(row.provider_subscription_id)}`;
  const remote = await stripeRequest<{ items?: { data?: Array<{ id?: string; quantity?: number; price?: { id?: string } }> } }>(subscriptionPath, "GET");
  const item = remote.items?.data?.find((candidate) => candidate.price?.id === priceId);
  if (!item?.id) return { seats, updated: false };
  let updated = false;
  if (item.quantity !== seats) {
    await stripeRequest(subscriptionPath, "POST", new URLSearchParams({
      "items[0][id]": item.id,
      "items[0][quantity]": String(seats),
      proration_behavior: "create_prorations",
    }));
    updated = true;
  }
  await pool.query("UPDATE subscriptions SET seats = $2, updated_at = NOW() WHERE org_id = $1", [orgId, seats]);
  return { seats, updated };
}

/** Membership changed: resync seats without holding up the request. */
export function syncSeatsLater(pool: pg.Pool, ...orgIds: Array<string | null | undefined>): void {
  for (const orgId of new Set(orgIds.filter((id): id is string => Boolean(id)))) {
    void syncSubscriptionSeats(pool, orgId).catch((error: unknown) => {
      console.error("[costkey] Seat sync failed; the next membership change or billing event retries:", error);
    });
  }
}

async function ensureSubscription(pool: pg.Pool, orgId: string): Promise<Record<string, unknown>> {
  const existing = await pool.query("SELECT * FROM subscriptions WHERE org_id = $1", [orgId]);
  if (existing.rows[0]) return existing.rows[0] as Record<string, unknown>;
  const inserted = await pool.query(
    `INSERT INTO subscriptions(org_id, provider, status, amount_cents, currency)
     VALUES ($1, 'unconfigured', 'not_configured', 900, 'usd')
     ON CONFLICT (org_id) DO UPDATE SET org_id = EXCLUDED.org_id
     RETURNING *`,
    [orgId],
  );
  return inserted.rows[0] as Record<string, unknown>;
}

function subscriptionResponse(row: Record<string, unknown>, seats: number): Record<string, unknown> {
  const status = String(row.status ?? "not_configured");
  const legacy = isLegacyWorkspacePlan(row);
  const amountCents = legacy ? LEGACY_WORKSPACE_CENTS : SEAT_PRICE_CENTS;
  return {
    provider: row.provider,
    status,
    pricing: legacy ? "workspace" : "per_user",
    amountCents,
    seats,
    totalCents: legacy ? amountCents : amountCents * seats,
    currency: row.currency,
    currentPeriodStart: row.current_period_start,
    currentPeriodEnd: row.current_period_end,
    cancelAtPeriodEnd: row.cancel_at_period_end,
    cancelAt: row.cancel_at,
    paymentMethodSummary: row.payment_method_summary,
    configured: status !== "not_configured" && row.provider !== "unconfigured",
    entitlementActive: ["active", "trialing", "past_due"].includes(status),
    aiProviderSpendIsSeparate: true,
  };
}

export async function applyStripeWebhookEvent(pool: pg.Pool, event: Record<string, unknown>): Promise<{ applied: boolean; orgId: string | null }> {
  const eventId = typeof event.id === "string" ? event.id : "";
  const eventType = typeof event.type === "string" ? event.type : "";
  if (!eventId || !eventType) throw new Error("Invalid Stripe event");
  const data = ((event.data as Record<string, unknown> | undefined)?.object ?? {}) as Record<string, unknown>;
  const metadata = (data.metadata ?? {}) as Record<string, unknown>;
  let orgId = typeof metadata.org_id === "string" ? metadata.org_id : null;
  if (!orgId && typeof data.client_reference_id === "string") orgId = data.client_reference_id;
  if (!orgId && typeof data.customer === "string") {
    const customer = await pool.query("SELECT org_id FROM subscriptions WHERE provider_customer_id = $1", [data.customer]);
    orgId = customer.rows[0]?.org_id ?? null;
  }
  // Do not permanently consume an event that cannot yet be mapped to a
  // workspace. Returning an error makes Stripe retry after the customer row
  // exists rather than silently dropping an out-of-order callback.
  if (!orgId) throw new Error("Billing event is not associated with a workspace");

  const eventCreatedAt = typeof event.created === "number" && Number.isFinite(event.created)
    ? new Date(event.created * 1000)
    : new Date();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const recorded = await client.query(
      `INSERT INTO subscription_events(provider_event_id, provider, event_type, org_id, payload, event_created_at)
       VALUES ($1, 'stripe', $2, $3, $4::jsonb, $5)
       ON CONFLICT (provider_event_id) DO NOTHING RETURNING provider_event_id`,
      [eventId, eventType, orgId, JSON.stringify(event), eventCreatedAt],
    );
    if (recorded.rows.length === 0) {
      await client.query("COMMIT");
      return { applied: false, orgId };
    }

    const customerId = typeof data.customer === "string" ? data.customer : null;
    const subscriptionId = typeof data.id === "string" && eventType.startsWith("customer.subscription")
      ? data.id
      : typeof data.subscription === "string" ? data.subscription : null;
    const items = (data.items as { data?: Array<{ quantity?: unknown }> } | undefined)?.data;
    const quantity = typeof items?.[0]?.quantity === "number" ? items[0].quantity : null;
    const currentPeriodStart = typeof data.current_period_start === "number" ? new Date(data.current_period_start * 1000) : null;
    const currentPeriodEnd = typeof data.current_period_end === "number" ? new Date(data.current_period_end * 1000) : null;

    if (eventType === "checkout.session.completed") {
      // Checkout completion is not the subscription lifecycle callback. Keep a
      // pending state until Stripe confirms the customer subscription.
      const current = await client.query("SELECT status, last_provider_event_at FROM subscriptions WHERE org_id = $1 FOR UPDATE", [orgId]);
      const currentEventAt = current.rows[0]?.last_provider_event_at ? new Date(current.rows[0].last_provider_event_at) : null;
      if (!currentEventAt || eventCreatedAt >= currentEventAt) {
        await client.query(
          `INSERT INTO subscriptions(org_id, provider, provider_customer_id, provider_subscription_id, status, updated_at, last_provider_event_at)
           VALUES ($1, 'stripe', $2, $3, 'checkout_completed', NOW(), $4)
           ON CONFLICT (org_id) DO UPDATE SET
             provider = 'stripe',
             provider_customer_id = COALESCE(EXCLUDED.provider_customer_id, subscriptions.provider_customer_id),
             provider_subscription_id = COALESCE(EXCLUDED.provider_subscription_id, subscriptions.provider_subscription_id),
             status = CASE WHEN subscriptions.status IN ('active', 'trialing', 'past_due') THEN subscriptions.status ELSE EXCLUDED.status END,
             last_provider_event_at = EXCLUDED.last_provider_event_at,
             updated_at = NOW()`,
          [orgId, customerId, typeof data.subscription === "string" ? data.subscription : null, eventCreatedAt],
        );
      }
    } else if (eventType.startsWith("customer.subscription.")) {
      const status = eventType === "customer.subscription.deleted" ? "canceled" : typeof data.status === "string" ? data.status : null;
      const cancelAtPeriodEnd = typeof data.cancel_at_period_end === "boolean" ? data.cancel_at_period_end : null;
      const cancelAt = typeof data.cancel_at === "number" ? new Date(data.cancel_at * 1000) : null;
      const current = await client.query("SELECT last_provider_event_at FROM subscriptions WHERE org_id = $1 FOR UPDATE", [orgId]);
      const currentEventAt = current.rows[0]?.last_provider_event_at ? new Date(current.rows[0].last_provider_event_at) : null;
      if (!currentEventAt || eventCreatedAt >= currentEventAt) {
        await client.query(
          `INSERT INTO subscriptions(
             org_id, provider, provider_customer_id, provider_subscription_id, status,
             current_period_start, current_period_end, cancel_at_period_end, cancel_at,
             last_provider_event_at, seats, updated_at
           ) VALUES ($1, 'stripe', $2, $3, $4, $5, $6, COALESCE($7, FALSE), $8, $9, $10, NOW())
           ON CONFLICT (org_id) DO UPDATE SET
             provider = 'stripe',
             provider_customer_id = COALESCE(EXCLUDED.provider_customer_id, subscriptions.provider_customer_id),
             provider_subscription_id = COALESCE(EXCLUDED.provider_subscription_id, subscriptions.provider_subscription_id),
             status = COALESCE(EXCLUDED.status, subscriptions.status),
             current_period_start = COALESCE(EXCLUDED.current_period_start, subscriptions.current_period_start),
             current_period_end = COALESCE(EXCLUDED.current_period_end, subscriptions.current_period_end),
             cancel_at_period_end = COALESCE(EXCLUDED.cancel_at_period_end, subscriptions.cancel_at_period_end),
             cancel_at = COALESCE(EXCLUDED.cancel_at, subscriptions.cancel_at),
             last_provider_event_at = EXCLUDED.last_provider_event_at,
             seats = COALESCE(EXCLUDED.seats, subscriptions.seats),
             updated_at = NOW()`,
          [orgId, customerId, subscriptionId, status, currentPeriodStart, currentPeriodEnd, cancelAtPeriodEnd, cancelAt, eventCreatedAt, quantity],
        );
      }
    }

    if (eventType.startsWith("invoice.")) {
      const invoiceId = typeof data.id === "string" ? data.id : randomId("invoice");
      await client.query(
        `INSERT INTO subscription_invoices(
           id, org_id, provider_invoice_id, status, amount_due_cents, amount_paid_cents,
           currency, hosted_invoice_url, issued_at, due_at, paid_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (provider_invoice_id) DO UPDATE SET
           status = EXCLUDED.status, amount_due_cents = EXCLUDED.amount_due_cents,
           amount_paid_cents = EXCLUDED.amount_paid_cents, hosted_invoice_url = EXCLUDED.hosted_invoice_url,
           paid_at = EXCLUDED.paid_at`,
        [
          randomId("invoice"), orgId, invoiceId, String(data.status ?? eventType.replace("invoice.", "")),
          typeof data.amount_due === "number" ? data.amount_due : null,
          typeof data.amount_paid === "number" ? data.amount_paid : null,
          typeof data.currency === "string" ? data.currency : "usd",
          typeof data.hosted_invoice_url === "string" ? data.hosted_invoice_url : null,
          typeof data.created === "number" ? new Date(data.created * 1000) : null,
          typeof data.due_date === "number" ? new Date(data.due_date * 1000) : null,
          eventType === "invoice.paid" ? eventCreatedAt : null,
        ],
      );
    }
    await client.query("COMMIT");
    return { applied: true, orgId };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export function createSubscriptionRouter(pool: pg.Pool): Router {
  const router = createRouter();

  // Public provider callback. Authentication is impossible here; authenticity
  // comes from Stripe's signed event and idempotency key.
  router.post("/api/v1/billing/webhooks/stripe", async (req: Request, res: Response) => {
    const secret = process.env["STRIPE_WEBHOOK_SECRET"];
    if (!secret) { res.status(503).json({ error: "Billing webhook is not configured" }); return; }
    const rawBody = Buffer.isBuffer(req.body)
      ? req.body.toString("utf8")
      : typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {});
    const signatureHeader = typeof req.headers["stripe-signature"] === "string"
      ? req.headers["stripe-signature"]
      : undefined;
    if (!verifyStripeWebhookSignature(rawBody, signatureHeader, secret)) {
      res.status(400).json({ error: "Invalid webhook signature" });
      return;
    }
    try {
      const event = JSON.parse(rawBody) as Record<string, unknown>;
      const result = await applyStripeWebhookEvent(pool, event);
      // People may have joined while checkout was open.
      if (result.applied && String(event.type ?? "").startsWith("customer.subscription.")) syncSeatsLater(pool, result.orgId);
      res.json({ received: true, applied: result.applied });
    } catch (error) {
      console.error("[costkey] Billing webhook error:", error);
      res.status(400).json({ error: "Invalid billing event" });
    }
  });

  router.use("/api", requireAuth);

  router.get("/api/v1/subscription", async (req: Request, res: Response) => {
    try {
      const user = userOf(req);
      if (!user) { res.status(401).json({ error: "Authentication required" }); return; }
      if (!roleCanManageSubscription(user.role)) { res.status(403).json({ error: "Only the workspace owner can view subscription settings" }); return; }
      const [row, seats] = await Promise.all([ensureSubscription(pool, user.orgId), countSeats(pool, user.orgId)]);
      const subscription = subscriptionResponse(row, seats);
      res.json({
        subscription,
        target: { amountUsd: Number(subscription.amountCents) / 100, interval: "month", per: subscription.pricing === "workspace" ? "workspace" : "user", seats, totalUsd: Number(subscription.totalCents) / 100 },
      });
    } catch (error) {
      console.error("[costkey] Subscription read error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.post("/api/v1/subscription/checkout", async (req: Request, res: Response) => {
    try {
      const user = userOf(req);
      if (!user) { res.status(401).json({ error: "Authentication required" }); return; }
      if (!roleCanManageSubscription(user.role)) { res.status(403).json({ error: "Only the workspace owner can start billing" }); return; }
      if (!providerConfigured()) {
        res.status(503).json({ error: "Billing is not configured", code: "billing_unconfigured", configured: false });
        return;
      }
      await validateStripePrice();
      const seats = await countSeats(pool, user.orgId);
      const base = publicAppUrl();
      const params = new URLSearchParams({
        mode: "subscription",
        "line_items[0][price]": process.env["COSTKEY_STRIPE_PRICE_ID"]!,
        "line_items[0][quantity]": String(seats),
        success_url: `${base}/settings?billing=success`,
        cancel_url: `${base}/settings?billing=cancelled`,
        client_reference_id: user.orgId,
        customer_email: user.email,
        "metadata[org_id]": user.orgId,
        "subscription_data[metadata][org_id]": user.orgId,
      });
      const requestId = typeof req.headers["idempotency-key"] === "string"
        ? req.headers["idempotency-key"]
        : `costkey-checkout-${user.orgId}`;
      const session = await stripeRequest<{ id?: string; url?: string }>("/v1/checkout/sessions", "POST", params, requestId);
      if (!session.id || !session.url) { res.status(502).json({ error: "Billing provider returned no checkout session" }); return; }
      await pool.query(
        `INSERT INTO subscriptions(org_id, provider, status, amount_cents, currency)
         VALUES ($1, 'stripe', 'checkout_pending', $2, 'usd')
         ON CONFLICT (org_id) DO UPDATE SET provider = 'stripe',
           amount_cents = CASE WHEN subscriptions.status IN ('active', 'trialing', 'past_due') THEN subscriptions.amount_cents ELSE EXCLUDED.amount_cents END,
           updated_at = NOW()`,
        [user.orgId, SEAT_PRICE_CENTS],
      );
      res.json({ configured: true, checkoutUrl: session.url, sessionId: session.id, status: "checkout_pending", seats });
    } catch (error) {
      console.error("[costkey] Subscription checkout error:", error);
      res.status(502).json({ error: "Billing checkout unavailable" });
    }
  });

  router.post("/api/v1/subscription/cancel", async (req: Request, res: Response) => {
    try {
      const user = userOf(req);
      if (!user) { res.status(401).json({ error: "Authentication required" }); return; }
      if (!roleCanManageSubscription(user.role)) { res.status(403).json({ error: "Only the workspace owner can change billing" }); return; }
      const row = await ensureSubscription(pool, user.orgId);
      if (row.provider !== "stripe" || typeof row.provider_subscription_id !== "string") { res.status(503).json({ error: "No active billing provider is configured", code: "billing_unconfigured" }); return; }
      await stripeRequest(`/v1/subscriptions/${encodeURIComponent(row.provider_subscription_id)}`, "POST", new URLSearchParams({ cancel_at_period_end: "true" }));
      const updated = await pool.query(
        `UPDATE subscriptions SET cancel_at_period_end = TRUE, cancel_at = current_period_end, updated_at = NOW()
         WHERE org_id = $1 RETURNING *`,
        [user.orgId],
      );
      res.json({ subscription: subscriptionResponse(updated.rows[0] as Record<string, unknown>, await countSeats(pool, user.orgId)) });
    } catch (error) {
      console.error("[costkey] Subscription cancellation error:", error);
      res.status(502).json({ error: "Billing cancellation unavailable" });
    }
  });

  router.post("/api/v1/subscription/resume", async (req: Request, res: Response) => {
    try {
      const user = userOf(req);
      if (!user) { res.status(401).json({ error: "Authentication required" }); return; }
      if (!roleCanManageSubscription(user.role)) { res.status(403).json({ error: "Only the workspace owner can change billing" }); return; }
      const row = await ensureSubscription(pool, user.orgId);
      if (row.provider !== "stripe" || typeof row.provider_subscription_id !== "string") { res.status(503).json({ error: "No active billing provider is configured", code: "billing_unconfigured" }); return; }
      await stripeRequest(`/v1/subscriptions/${encodeURIComponent(row.provider_subscription_id)}`, "POST", new URLSearchParams({ cancel_at_period_end: "false" }));
      const updated = await pool.query(
        `UPDATE subscriptions SET cancel_at_period_end = FALSE, cancel_at = NULL, updated_at = NOW()
         WHERE org_id = $1 RETURNING *`,
        [user.orgId],
      );
      res.json({ subscription: subscriptionResponse(updated.rows[0] as Record<string, unknown>, await countSeats(pool, user.orgId)) });
    } catch (error) {
      console.error("[costkey] Subscription resume error:", error);
      res.status(502).json({ error: "Billing resume unavailable" });
    }
  });

  router.get("/api/v1/subscription/invoices", async (req: Request, res: Response) => {
    try {
      const user = userOf(req);
      if (!user) { res.status(401).json({ error: "Authentication required" }); return; }
      if (!roleCanManageSubscription(user.role)) { res.status(403).json({ error: "Only the workspace owner can view invoices" }); return; }
      const result = await pool.query(
        `SELECT id, provider_invoice_id, status, amount_due_cents, amount_paid_cents,
                currency, hosted_invoice_url, issued_at, due_at, paid_at, created_at
         FROM subscription_invoices WHERE org_id = $1 ORDER BY issued_at DESC NULLS LAST LIMIT 100`,
        [user.orgId],
      );
      res.json({ invoices: result.rows });
    } catch (error) {
      console.error("[costkey] Subscription invoice error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}
