import type { PostHog } from "posthog-js";

let client: PostHog | null = null;

const ALLOWED_CAPTURE_PROPERTIES = new Set(["joined_via_invite", "provider", "model", "has_function_attribution"]);
const ALLOWED_IDENTITY_PROPERTIES = new Set(["role"]);

function allowlisted(properties: Record<string, unknown> | undefined, allowed: Set<string>): Record<string, unknown> | undefined {
  if (!properties) return undefined;
  const safe = Object.fromEntries(Object.entries(properties).filter(([key]) => allowed.has(key)));
  return Object.keys(safe).length > 0 ? safe : undefined;
}

export function sanitizeCaptureProperties(properties?: Record<string, unknown>): Record<string, unknown> | undefined {
  return allowlisted(properties, ALLOWED_CAPTURE_PROPERTIES);
}

export function sanitizeIdentityProperties(properties?: Record<string, unknown>): Record<string, unknown> | undefined {
  return allowlisted(properties, ALLOWED_IDENTITY_PROPERTIES);
}

export async function initAnalytics(): Promise<void> {
  const token = import.meta.env.VITE_POSTHOG_PROJECT_TOKEN as string | undefined;
  if (!token) return;

  const { default: posthog } = await import("posthog-js");
  posthog.init(token, {
    api_host: import.meta.env.VITE_POSTHOG_HOST ?? "https://us.i.posthog.com",
    defaults: "2026-05-30",
    capture_pageview: "history_change",
    capture_pageleave: true,
    // The dashboard renders customer prompts and model output. Explicit events
    // give us the product signals we need without collecting DOM contents.
    autocapture: false,
    disable_session_recording: true,
  });
  client = posthog;
}

export const analytics = {
  capture(event: string, properties?: Record<string, unknown>): void {
    client?.capture(event, sanitizeCaptureProperties(properties));
  },
  identify(id: string, properties?: Record<string, unknown>): void {
    client?.identify(id, sanitizeIdentityProperties(properties));
  },
  group(type: string, key: string, properties?: Record<string, unknown>): void {
    // Group labels are workspace data. Keep the group key pseudonymous and
    // omit mutable organization names/slugs from the analytics payload.
    void properties;
    client?.group(type, key);
  },
  reset(): void {
    client?.reset();
  },
};
