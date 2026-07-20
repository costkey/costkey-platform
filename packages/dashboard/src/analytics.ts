import type { PostHog } from "posthog-js";

let client: PostHog | null = null;

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
    client?.capture(event, properties);
  },
  identify(id: string, properties?: Record<string, unknown>): void {
    client?.identify(id, properties);
  },
  group(type: string, key: string, properties?: Record<string, unknown>): void {
    client?.group(type, key, properties);
  },
  reset(): void {
    client?.reset();
  },
};
