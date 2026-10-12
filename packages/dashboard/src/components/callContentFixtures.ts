/** Realistic stored request/response pairs, one per format, for tests and previews. */

export interface CallContentFixture {
  name: string;
  provider: string;
  model: string;
  input: unknown;
  output: unknown;
}

/** A 1x1 PNG padded out so it reads as a real upload (about 3 KB). */
export const FIXTURE_IMAGE_BASE64 = `iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg${"A".repeat(4000)}==`;

const LONG_SYSTEM_PROMPT = [
  "You are the statement extraction service for Ledgerly, a personal finance app used by people who want to understand their credit card spending.",
  "You receive the text of one credit card statement at a time. Read it carefully and return a single JSON object that matches the credit_card_extraction schema exactly.",
  "Rules:",
  "1. Never guess a value. If a field is not on the statement, return null for it.",
  "2. Dates are ISO 8601 (YYYY-MM-DD). Statements from India often print dates as DD/MM/YYYY; convert them.",
  "3. Amounts are numbers in the statement's currency, without symbols or thousands separators.",
  "4. The last four digits of the card are the only card digits you may return. Never return a full card number.",
  "5. If the statement covers more than one card, extract the primary card only and lower the confidence score.",
  "6. Use the lookup_issuer tool when the issuer name is ambiguous or abbreviated.",
  "7. Confidence is a number from 0 to 1 describing how sure you are about the extraction as a whole.",
  "Formatting: respond with JSON only. Do not add commentary, markdown or code fences.",
  "Internal reference for the issuer lookup service: api_key=[REDACTED]",
].join("\n");

const CREDIT_CARD_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["issuer", "card_network", "card_holder", "last_four", "expiry", "statement_period", "balances", "due_date", "confidence"],
  properties: {
    issuer: { type: "string", description: "Bank or company that issued the card" },
    card_network: { type: "string", enum: ["visa", "mastercard", "amex", "rupay", "diners", "other"] },
    card_holder: {
      type: "object",
      required: ["full_name", "billing_address"],
      properties: {
        full_name: { type: "string" },
        billing_address: {
          type: "object",
          required: ["line1", "city", "country"],
          properties: {
            line1: { type: "string" },
            line2: { type: ["string", "null"] },
            city: { type: "string" },
            state: { type: ["string", "null"] },
            postal_code: { type: ["string", "null"] },
            country: { type: "string" },
          },
        },
      },
    },
    last_four: { type: "string", description: "Last four digits only" },
    expiry: { type: "object", properties: { month: { type: "integer" }, year: { type: "integer" } } },
    statement_period: { type: "object", properties: { start_date: { type: "string" }, end_date: { type: "string" } } },
    balances: {
      type: "object",
      properties: { current_balance: { type: "number" }, minimum_due: { type: "number" }, credit_limit: { type: ["number", "null"] } },
    },
    due_date: { type: "string" },
    confidence: { type: "number" },
  },
};

const EXTRACTION = {
  issuer: "HDFC Bank",
  card_network: "visa",
  card_holder: {
    full_name: "Asha Rao",
    billing_address: { line1: "14 Residency Road", line2: null, city: "Bengaluru", state: "Karnataka", postal_code: "560025", country: "IN" },
  },
  last_four: "4417",
  expiry: { month: 8, year: 2029 },
  statement_period: { start_date: "2026-08-16", end_date: "2026-09-15" },
  balances: { current_balance: 48210.5, minimum_due: 2410.53, credit_limit: 300000 },
  due_date: "2026-10-05",
  confidence: 0.94,
};

export const openAiChatFixture: CallContentFixture = {
  name: "OpenAI chat",
  provider: "openai",
  model: "gpt-4.1-mini",
  input: {
    model: "gpt-4.1-mini",
    temperature: 0.1,
    max_completion_tokens: 2048,
    response_format: { type: "json_schema", json_schema: { name: "credit_card_extraction", strict: true, schema: CREDIT_CARD_SCHEMA } },
    tools: [
      { type: "function", function: { name: "lookup_issuer", description: "Resolve an abbreviated issuer name to the bank's full name.", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } },
      { type: "function", function: { name: "fx_rate", description: "Get the exchange rate between two currencies on a date.", parameters: { type: "object", properties: { from: { type: "string" }, to: { type: "string" }, date: { type: "string" } } } } },
    ],
    messages: [
      { role: "system", content: LONG_SYSTEM_PROMPT },
      { role: "user", content: "Statement text:\nHDFC BANK  REGALIA\nCard No: XXXX XXXX XXXX 4417\nStatement Date 15/09/2026  Payment Due Date 05/10/2026\nTotal Dues 48,210.50  Minimum Amount Due 2,410.53\nCredit Limit 3,00,000" },
      { role: "assistant", content: null, tool_calls: [{ id: "call_9fX2", type: "function", function: { name: "lookup_issuer", arguments: "{\"query\":\"HDFC BANK REGALIA\"}" } }] },
      { role: "tool", tool_call_id: "call_9fX2", content: "{\"issuer\":\"HDFC Bank\",\"product\":\"Regalia\",\"network\":\"visa\"}" },
    ],
  },
  output: {
    id: "chatcmpl-B7x1",
    object: "chat.completion",
    model: "gpt-4.1-mini-2025-04-14",
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(EXTRACTION), refusal: null } }],
    usage: { prompt_tokens: 1203, completion_tokens: 212, total_tokens: 1415, prompt_tokens_details: { cached_tokens: 1024 }, completion_tokens_details: { reasoning_tokens: 0 } },
  },
};

export const openAiResponsesFixture: CallContentFixture = {
  name: "OpenAI Responses",
  provider: "openai",
  model: "o4-mini",
  input: {
    model: "o4-mini",
    instructions: "You triage support tickets for an online pharmacy. Decide the queue and urgency.",
    reasoning: { effort: "medium", summary: "auto" },
    max_output_tokens: 4000,
    tools: [{ type: "function", name: "get_order", description: "Fetch an order by its id.", parameters: { type: "object", properties: { order_id: { type: "string" } } } }],
    text: { format: { type: "json_schema", name: "ticket_triage", schema: { type: "object", properties: { queue: { type: "string" }, urgency: { type: "string" }, reason: { type: "string" } }, required: ["queue", "urgency"] } } },
    input: [
      { role: "user", content: [{ type: "input_text", text: "My order 88231 arrived without the insulin pens. I need them by tomorrow." }] },
      { type: "function_call", call_id: "fc_01", name: "get_order", arguments: "{\"order_id\":\"88231\"}" },
      { type: "function_call_output", call_id: "fc_01", output: "{\"status\":\"delivered\",\"items\":[\"insulin pens x2\",\"test strips\"],\"cold_chain\":true}" },
    ],
  },
  output: {
    id: "resp_6a1",
    object: "response",
    status: "completed",
    model: "o4-mini-2025-04-16",
    output: [
      { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "Cold chain medication missing from a delivered order is urgent." }] },
      { type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: "{\"queue\":\"fulfilment\",\"urgency\":\"high\",\"reason\":\"Cold chain item missing\"}" }] },
    ],
    usage: { input_tokens: 412, output_tokens: 96, total_tokens: 508, output_tokens_details: { reasoning_tokens: 64 }, input_tokens_details: { cached_tokens: 0 } },
    incomplete_details: null,
  },
};

export const anthropicFixture: CallContentFixture = {
  name: "Anthropic",
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  input: {
    model: "claude-sonnet-4-5",
    max_tokens: 1024,
    temperature: 0.3,
    system: [
      { type: "text", text: "You are a receipt checker for an expense tool." },
      { type: "text", text: "Flag receipts that look edited.", cache_control: { type: "ephemeral" } },
    ],
    tools: [{ name: "get_policy", description: "Read the expense policy for a category.", input_schema: { type: "object", properties: { category: { type: "string" } } } }],
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: FIXTURE_IMAGE_BASE64 } },
          { type: "text", text: "Is this taxi receipt within policy?" },
        ],
      },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_01A", name: "get_policy", input: { category: "local_travel" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_01A", content: "Local travel: up to 1,500 per trip with a receipt." }] },
    ],
  },
  output: {
    id: "msg_01",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-5-20250929",
    content: [{ type: "text", text: "Yes. The fare is 640, which is within the 1,500 limit for local travel.\nThe receipt shows no signs of editing." }],
    stop_reason: "end_turn",
    usage: { input_tokens: 1880, output_tokens: 41, cache_read_input_tokens: 300, cache_creation_input_tokens: 0 },
  },
};

export const geminiFixture: CallContentFixture = {
  name: "Gemini",
  provider: "google",
  model: "gemini-2.5-flash",
  input: {
    systemInstruction: { parts: [{ text: "You plan grocery deliveries for a quick commerce app." }] },
    contents: [
      { role: "user", parts: [{ text: "Can you get 2 litres of milk to HSR Layout by 7pm?" }] },
      { role: "model", parts: [{ functionCall: { name: "check_slot", args: { area: "HSR Layout", before: "19:00" } } }] },
      { role: "user", parts: [{ functionResponse: { name: "check_slot", response: { available: true, slot: "18:20" } } }] },
    ],
    tools: [{ functionDeclarations: [{ name: "check_slot", description: "Check delivery slots for an area." }, { name: "place_order", description: "Place an order." }] }],
    generationConfig: {
      temperature: 0.4,
      maxOutputTokens: 512,
      responseMimeType: "application/json",
      responseSchema: { type: "OBJECT", properties: { confirmed: { type: "BOOLEAN" }, slot: { type: "STRING" } }, required: ["confirmed"] },
      thinkingConfig: { thinkingBudget: 256 },
    },
  },
  output: {
    candidates: [{ content: { role: "model", parts: [{ text: "{\"confirmed\":true,\"slot\":\"18:20\"}" }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 210, candidatesTokenCount: 14, thoughtsTokenCount: 120, totalTokenCount: 344 },
    modelVersion: "gemini-2.5-flash",
  },
};

export const bedrockFixture: CallContentFixture = {
  name: "Bedrock Converse",
  provider: "bedrock",
  model: "anthropic.claude-3-5-haiku-20241022-v1:0",
  input: {
    system: [{ text: "Summarise customer calls in two sentences." }],
    messages: [
      { role: "user", content: [{ text: "Transcript: The customer wants to move their EMI date from the 3rd to the 10th." }] },
      { role: "assistant", content: [{ toolUse: { toolUseId: "tooluse_1", name: "get_account", input: { customer_id: "C-2231" } } }] },
      { role: "user", content: [{ toolResult: { toolUseId: "tooluse_1", content: [{ json: { emi_date: 3, loan: "personal" } }], status: "success" } }] },
    ],
    inferenceConfig: { maxTokens: 300, temperature: 0.2 },
    toolConfig: { tools: [{ toolSpec: { name: "get_account", description: "Look up a loan account.", inputSchema: { json: { type: "object" } } } }] },
  },
  output: {
    output: { message: { role: "assistant", content: [{ text: "The customer asked to move their EMI date from the 3rd to the 10th. Their personal loan account is eligible." }] } },
    stopReason: "end_turn",
    usage: { inputTokens: 220, outputTokens: 31, totalTokens: 251 },
  },
};

export const elevenLabsFixture: CallContentFixture = {
  name: "ElevenLabs",
  provider: "elevenlabs",
  model: "eleven_multilingual_v2",
  input: {
    text: "Namaste! Your order has been packed and will reach you in about twenty minutes.",
    model_id: "eleven_multilingual_v2",
    voice_settings: { stability: 0.5, similarity_boost: 0.75 },
  },
  output: { $bytes: 48213 },
};

export const embeddingsFixture: CallContentFixture = {
  name: "Embeddings",
  provider: "openai",
  model: "text-embedding-3-small",
  input: { model: "text-embedding-3-small", input: ["Refund for a damaged parcel", "Where is my order?", "Change delivery address"] },
  output: {
    object: "list",
    model: "text-embedding-3-small",
    data: [0, 1, 2].map((index) => ({ object: "embedding", index, embedding: Array.from({ length: 1536 }, (_, i) => Math.round(Math.sin(i + index) * 1e6) / 1e6) })),
    usage: { prompt_tokens: 14, total_tokens: 14 },
  },
};

export const unknownFixture: CallContentFixture = {
  name: "Unrecognised",
  provider: "custom",
  model: "ranker-v2",
  input: { query: "running shoes", documents: ["Trail runner", "Road racer"], top_n: 1 },
  output: { results: [{ index: 1, relevance_score: 0.92 }] },
};

export const callContentFixtures: CallContentFixture[] = [
  openAiChatFixture,
  openAiResponsesFixture,
  anthropicFixture,
  geminiFixture,
  bedrockFixture,
  elevenLabsFixture,
  embeddingsFixture,
  unknownFixture,
];
