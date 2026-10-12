import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { CallContent, type CallContentProps } from "./CallContent";
import {
  FIXTURE_IMAGE_BASE64,
  anthropicFixture,
  bedrockFixture,
  callContentFixtures,
  elevenLabsFixture,
  embeddingsFixture,
  geminiFixture,
  openAiChatFixture,
  openAiResponsesFixture,
  unknownFixture,
  type CallContentFixture,
} from "./callContentFixtures";

function render(props: Partial<CallContentProps>): string {
  const full: CallContentProps = { input: null, output: null, canReadContent: true, ...props };
  return renderToString(createElement(MemoryRouter, null, createElement(CallContent, full)));
}

function renderFixture(fixture: CallContentFixture): string {
  return render({ input: fixture.input, output: fixture.output, provider: fixture.provider, model: fixture.model, contentStatus: "captured" });
}

/** Text content with tags and SSR comment markers removed, entities decoded. */
function text(markup: string): string {
  return markup.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, "\"").replace(/&amp;/g, "&").replace(/\s+/g, " ");
}

describe("CallContent", () => {
  it("renders the OpenAI chat call as system, conversation, configuration and output", () => {
    const markup = renderFixture(openAiChatFixture);
    const plain = text(markup);
    expect(plain).toContain("System prompt");
    expect(plain).toContain("User");
    expect(plain).toContain("Assistant");
    expect(plain).toContain("Tool result");
    expect(plain).toContain("Called lookup_issuer");
    expect(plain).toContain("Result of lookup_issuer");
    expect(plain).toContain("JSON schema · credit_card_extraction · 24 fields");
    expect(plain).toContain("2 tools available");
    expect(plain).toContain("Temperature 0.1");
    expect(plain).toContain("Max tokens 2,048");
    expect(plain).toContain("Finish reason: stop");
    expect(plain).toContain("View raw JSON");
    expect(plain).toContain("1 secret was redacted before storage.");
    expect(markup).toContain("ck-cc-redacted");
    expect(markup).toContain('aria-expanded="false"');
    // Output JSON is a tree with the first level open.
    expect(plain).toContain("issuer");
    expect(plain).toContain("\"HDFC Bank\"");
  });

  it("clamps the long system prompt with Show more", () => {
    const markup = renderFixture(openAiChatFixture);
    expect(markup).toContain("is-clamped");
    expect(text(markup)).toContain("Show more");
  });

  it("renders OpenAI Responses with reasoning effort and a function call", () => {
    const plain = text(renderFixture(openAiResponsesFixture));
    expect(plain).toContain("Called get_order");
    expect(plain).toContain("Result of get_order");
    expect(plain).toContain("Reasoning medium");
    expect(plain).toContain("JSON schema · ticket_triage · 3 fields");
    expect(plain).toContain("Finish reason: completed");
    expect(plain).toContain("Tokens: 412 input, 96 output, 64 reasoning, 508 total");
  });

  it("renders Anthropic images as chips, never as base64", () => {
    const markup = renderFixture(anthropicFixture);
    const plain = text(markup);
    expect(plain).toContain("Image · image/png");
    expect(plain).toContain("KB");
    expect(markup).not.toContain(FIXTURE_IMAGE_BASE64.slice(0, 40));
    expect(plain).toContain("Called get_policy");
    expect(plain).toContain("Finish reason: end_turn");
  });

  it("renders Gemini and Bedrock calls", () => {
    const gemini = text(renderFixture(geminiFixture));
    expect(gemini).toContain("Called check_slot");
    expect(gemini).toContain("Result of check_slot");
    expect(gemini).toContain("JSON schema · 2 fields");
    expect(gemini).toContain("Finish reason: STOP");
    const bedrock = text(renderFixture(bedrockFixture));
    expect(bedrock).toContain("Summarise customer calls");
    expect(bedrock).toContain("Result of get_account");
    expect(bedrock).toContain("Finish reason: end_turn");
  });

  it("renders text to speech output as audio and embeddings as a vector summary", () => {
    const speech = text(renderFixture(elevenLabsFixture));
    expect(speech).toContain("Audio · audio/mpeg · 47.1 KB");
    expect(speech).toContain("Stability 0.5");
    const embeddings = text(renderFixture(embeddingsFixture));
    expect(embeddings).toContain("3 vectors × 1,536 dimensions");
    expect(embeddings).not.toContain("0.841471");
  });

  it("shows raw JSON for an unrecognised payload", () => {
    const plain = text(renderFixture(unknownFixture));
    expect(plain).toContain("We could not recognise this format");
    expect(plain).toContain("\"relevance_score\": 0.92");
  });

  it("uses no em or en dashes in any rendered fixture", () => {
    for (const fixture of callContentFixtures) expect(text(renderFixture(fixture))).not.toMatch(/[–—]/);
  });

  it("hides content for restricted roles", () => {
    expect(text(render({ input: openAiChatFixture.input, canReadContent: false }))).toContain("Prompts and responses are hidden for your role.");
    expect(text(render({ input: openAiChatFixture.input, contentStatus: "restricted" }))).toContain("Prompts and responses are hidden for your role.");
  });

  it("explains that text capture is off, with a Turn on link only for managers", () => {
    const member = render({ contentStatus: "metadata_only" });
    expect(text(member)).toContain("Text capture is off for this project");
    expect(member).not.toContain("Turn on");
    const owner = render({ contentStatus: "metadata_only", canManageCapture: true });
    expect(text(owner)).toContain("Turn on");
    expect(owner).toContain('href="/settings?section=privacy"');
  });

  it("explains when capture is on but this call has no stored text", () => {
    for (const status of ["not_available", "expired", "captured", null]) {
      expect(text(render({ contentStatus: status }))).toContain("Captured text isn't available for this call");
    }
    expect(text(render({ contentStatus: "redacted" }))).toContain("removed for privacy");
  });
});
