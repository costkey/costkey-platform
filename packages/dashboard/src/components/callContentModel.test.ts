import { describe, expect, it } from "vitest";
import {
  countSchemaFields,
  detectFormat,
  parseCallContent,
  schemaFields,
  type ContentPart,
} from "./callContentModel";
import {
  FIXTURE_IMAGE_BASE64,
  anthropicFixture,
  bedrockFixture,
  elevenLabsFixture,
  embeddingsFixture,
  geminiFixture,
  openAiChatFixture,
  openAiResponsesFixture,
  unknownFixture,
  type CallContentFixture,
} from "./callContentFixtures";

function parse(fixture: CallContentFixture) {
  return parseCallContent(fixture.input, fixture.output, { provider: fixture.provider, model: fixture.model });
}

function kinds(parts: ContentPart[]): string[] {
  return parts.map((part) => part.kind);
}

describe("parseCallContent: OpenAI chat", () => {
  const content = parse(openAiChatFixture);

  it("detects the format and lifts the system prompt out of the messages", () => {
    expect(content.format).toBe("openai-chat");
    expect(content.system).toContain("statement extraction service");
    expect(content.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    expect(content.messages.map((m) => m.index)).toEqual([1, 2, 3]);
  });

  it("pairs the tool call with its result by id", () => {
    const call = content.messages[1]!.parts[0]!;
    const result = content.messages[2]!.parts[0]!;
    expect(call).toMatchObject({ kind: "toolCall", id: "call_9fX2", name: "lookup_issuer", args: { query: "HDFC BANK REGALIA" }, resultIndex: 3 });
    expect(result).toMatchObject({ kind: "toolResult", callId: "call_9fX2", name: "lookup_issuer", callIndex: 2 });
    if (result.kind === "toolResult") expect(result.content[0]).toMatchObject({ kind: "json", value: { issuer: "HDFC Bank" } });
  });

  it("reads config chips and the JSON schema summary", () => {
    expect(content.config).toMatchObject({ model: "gpt-4.1-mini", temperature: 0.1, maxTokens: 2048 });
    expect(content.config.tools?.map((t) => t.name)).toEqual(["lookup_issuer", "fx_rate"]);
    expect(content.config.responseFormat).toMatchObject({ kind: "json_schema", name: "credit_card_extraction", fieldCount: 24 });
  });

  it("parses the output as JSON with finish reason and usage", () => {
    expect(content.output?.finishReason).toBe("stop");
    expect(content.output?.parts[0]).toMatchObject({ kind: "json", value: { issuer: "HDFC Bank", last_four: "4417" } });
    expect(content.output?.usage).toMatchObject({ input: 1203, output: 212, total: 1415, cacheRead: 1024 });
  });

  it("counts the server's redaction marker", () => {
    expect(content.redactedCount).toBe(1);
    expect(content.system).toContain("[REDACTED]");
  });
});

describe("parseCallContent: OpenAI Responses", () => {
  const content = parse(openAiResponsesFixture);

  it("reads instructions, input items and the function call pair", () => {
    expect(content.format).toBe("openai-responses");
    expect(content.system).toContain("triage support tickets");
    expect(content.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    expect(content.messages[1]!.parts[0]).toMatchObject({ kind: "toolCall", id: "fc_01", name: "get_order", args: { order_id: "88231" }, resultIndex: 3 });
    expect(content.messages[2]!.parts[0]).toMatchObject({ kind: "toolResult", name: "get_order", callIndex: 2 });
  });

  it("reads effort, max output tokens and text.format", () => {
    expect(content.config).toMatchObject({ model: "o4-mini", reasoningEffort: "medium", maxTokens: 4000 });
    expect(content.config.tools).toHaveLength(1);
    expect(content.config.responseFormat).toMatchObject({ kind: "json_schema", name: "ticket_triage", fieldCount: 3 });
  });

  it("reads reasoning and JSON output", () => {
    expect(kinds(content.output!.parts)).toEqual(["thinking", "json"]);
    expect(content.output?.parts[1]).toMatchObject({ value: { queue: "fulfilment", urgency: "high" } });
    expect(content.output?.finishReason).toBe("completed");
    expect(content.output?.usage).toMatchObject({ input: 412, output: 96, reasoning: 64 });
  });

  it("uses the incomplete reason as the finish reason", () => {
    const output = { ...(openAiResponsesFixture.output as object), status: "incomplete", incomplete_details: { reason: "max_output_tokens" } };
    expect(parseCallContent(openAiResponsesFixture.input, output).output?.finishReason).toBe("max_output_tokens");
  });
});

describe("parseCallContent: Anthropic", () => {
  const content = parse(anthropicFixture);

  it("joins system blocks and keeps message order", () => {
    expect(content.format).toBe("anthropic");
    expect(content.system).toBe("You are a receipt checker for an expense tool.\n\nFlag receipts that look edited.");
    expect(content.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
  });

  it("turns the base64 image into an attachment with an estimated size", () => {
    const image = content.messages[0]!.parts.find((part) => part.kind === "attachment");
    expect(image).toMatchObject({ kind: "attachment", type: "image", mimeType: "image/png" });
    if (image?.kind === "attachment") expect(image.sizeBytes).toBeGreaterThan(3000);
    expect(JSON.stringify(content)).not.toContain(FIXTURE_IMAGE_BASE64.slice(0, 40));
  });

  it("pairs tool_use with tool_result", () => {
    expect(content.messages[1]!.parts[0]).toMatchObject({ kind: "toolCall", id: "toolu_01A", name: "get_policy", resultIndex: 3 });
    expect(content.messages[2]!.parts[0]).toMatchObject({ kind: "toolResult", name: "get_policy", callIndex: 2 });
  });

  it("reads config and output", () => {
    expect(content.config).toMatchObject({ temperature: 0.3, maxTokens: 1024 });
    expect(content.config.tools).toEqual([{ name: "get_policy", description: "Read the expense policy for a category." }]);
    expect(content.output?.finishReason).toBe("end_turn");
    expect(content.output?.parts[0]).toMatchObject({ kind: "text" });
    expect(content.output?.usage).toMatchObject({ input: 1880, output: 41, cacheRead: 300 });
  });
});

describe("parseCallContent: Gemini", () => {
  const content = parse(geminiFixture);

  it("reads systemInstruction, roles and pairs functionCall by name", () => {
    expect(content.format).toBe("gemini");
    expect(content.system).toBe("You plan grocery deliveries for a quick commerce app.");
    expect(content.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    expect(content.messages[1]!.parts[0]).toMatchObject({ kind: "toolCall", name: "check_slot", resultIndex: 3 });
    expect(content.messages[2]!.parts[0]).toMatchObject({ kind: "toolResult", name: "check_slot", callIndex: 2 });
  });

  it("reads generationConfig and the response schema", () => {
    expect(content.config).toMatchObject({ model: "gemini-2.5-flash", temperature: 0.4, maxTokens: 512, thinkingBudget: 256 });
    expect(content.config.tools?.map((t) => t.name)).toEqual(["check_slot", "place_order"]);
    expect(content.config.responseFormat).toMatchObject({ kind: "json_schema", fieldCount: 2 });
  });

  it("reads candidates, finishReason and usageMetadata", () => {
    expect(content.output?.parts[0]).toMatchObject({ kind: "json", value: { confirmed: true, slot: "18:20" } });
    expect(content.output?.finishReason).toBe("STOP");
    expect(content.output?.usage).toMatchObject({ input: 210, output: 14, reasoning: 120, total: 344 });
  });
});

describe("parseCallContent: Bedrock Converse", () => {
  const content = parse(bedrockFixture);

  it("reads system, messages, tools and inferenceConfig", () => {
    expect(content.format).toBe("bedrock");
    expect(content.system).toBe("Summarise customer calls in two sentences.");
    expect(content.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    expect(content.messages[2]!.parts[0]).toMatchObject({ kind: "toolResult", name: "get_account", callIndex: 2 });
    expect(content.config).toMatchObject({ model: bedrockFixture.model, maxTokens: 300, temperature: 0.2 });
    expect(content.config.tools?.map((t) => t.name)).toEqual(["get_account"]);
  });

  it("reads the output message and stop reason", () => {
    expect(content.output?.parts[0]).toMatchObject({ kind: "text" });
    expect(content.output?.finishReason).toBe("end_turn");
    expect(content.output?.usage).toMatchObject({ input: 220, output: 31, total: 251 });
  });
});

describe("parseCallContent: ElevenLabs", () => {
  it("shows the text as the request and the audio as an attachment", () => {
    const content = parse(elevenLabsFixture);
    expect(content.format).toBe("elevenlabs");
    expect(content.messages[0]!.parts[0]).toMatchObject({ kind: "text" });
    expect(content.config.model).toBe("eleven_multilingual_v2");
    expect(content.config.extras).toEqual(expect.arrayContaining([{ label: "Stability", value: "0.5" }]));
    expect(content.output?.parts[0]).toMatchObject({ kind: "attachment", type: "audio", sizeBytes: 48213 });
  });

  it("still describes audio when the response body is absent", () => {
    const content = parseCallContent(elevenLabsFixture.input, null, { provider: "elevenlabs" });
    expect(content.output?.parts[0]).toMatchObject({ kind: "attachment", type: "audio" });
  });
});

describe("parseCallContent: embeddings", () => {
  it("summarises vectors without their numbers", () => {
    const content = parse(embeddingsFixture);
    expect(content.format).toBe("embeddings");
    expect(content.messages[0]!.parts).toHaveLength(3);
    expect(content.output?.parts).toEqual([{ kind: "vectors", count: 3, dimensions: 1536 }]);
    expect(JSON.stringify(content.output)).not.toContain("0.84");
  });

  it("counts dimensions through the SDK's array cap", () => {
    const content = parseCallContent({ model: "text-embedding-3-large", input: "hi" }, { data: [{ embedding: [0.1, 0.2, { $more: 3070 }] }] });
    expect(content.output?.parts[0]).toEqual({ kind: "vectors", count: 1, dimensions: 3072 });
  });
});

describe("parseCallContent: fallbacks and details", () => {
  it("falls back to raw for an unrecognised payload", () => {
    expect(parse(unknownFixture)).toMatchObject({ format: "raw", messages: [], output: null });
    expect(detectFormat("plain text", null)).toBe("raw");
  });

  it("accepts JSON strings", () => {
    const content = parseCallContent(JSON.stringify(openAiChatFixture.input), JSON.stringify(openAiChatFixture.output));
    expect(content.format).toBe("openai-chat");
  });

  it("keeps base64 data URLs out of text", () => {
    const dataUrl = `data:image/jpeg;base64,${FIXTURE_IMAGE_BASE64}`;
    const content = parseCallContent({ model: "gpt-4o", messages: [{ role: "user", content: [{ type: "text", text: "What is this?" }, { type: "image_url", image_url: { url: dataUrl } }] }] }, null);
    expect(content.messages[0]!.parts[1]).toMatchObject({ kind: "attachment", type: "image", mimeType: "image/jpeg" });
    expect(JSON.stringify(content)).not.toContain(FIXTURE_IMAGE_BASE64.slice(0, 40));
  });

  it("treats whole-string secret masks as redacted parts", () => {
    const content = parseCallContent({ model: "gpt-4o", messages: [{ role: "user", content: "[REDACTED]" }, { role: "user", content: "sk-proj-****abcd" }] }, null);
    expect(content.messages.map((m) => m.parts[0]!.kind)).toEqual(["redacted", "redacted"]);
    expect(content.redactedCount).toBe(2);
  });

  it("counts schema fields at every depth and builds a tree", () => {
    const schema = (openAiChatFixture.input as { response_format: { json_schema: { schema: unknown } } }).response_format.json_schema.schema;
    expect(countSchemaFields(schema)).toBe(24);
    const tree = schemaFields(schema);
    expect(tree.find((f) => f.name === "issuer")).toMatchObject({ type: "string", required: true });
    expect(tree.find((f) => f.name === "card_holder")?.children.find((f) => f.name === "billing_address")?.children).toHaveLength(6);
  });
});
