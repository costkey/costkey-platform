import { describe, expect, it } from "vitest";
import { sanitizeCaptureProperties, sanitizeIdentityProperties } from "./analytics";

describe("dashboard analytics privacy", () => {
  it("keeps only the event allowlist", () => {
    expect(sanitizeCaptureProperties({ provider: "openai", model: "gpt-4o", trace_id: "trace-secret", query: "customer-42", prompt: "private" })).toEqual({ provider: "openai", model: "gpt-4o" });
  });

  it("keeps role only on identity events", () => {
    expect(sanitizeIdentityProperties({ role: "developer", email: "person@example.com", name: "Person", org: "Acme" })).toEqual({ role: "developer" });
  });
});
