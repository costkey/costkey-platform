---
sidebar_position: 4
title: Providers
description: Provider endpoint, response-shape, and transport coverage for CostKey.
---

# Providers

CostKey captures calls to the provider hosts below. Both SDKs, TypeScript and
Python, capture every provider listed. Detection is an exact hostname or
pattern match; it is not a claim that every API, proxy, WebSocket, or SDK
transport for a provider is covered. No provider-routing gateway is required.

The SDKs only match the host and send raw telemetry. The server works out the
provider, model and usage for each call and prices it, so support for a new
response shape ships with the server.

## Supported providers

TypeScript patches `globalThis.fetch`. Python patches `httpx`, `httpx2`
(used by openai 3.x, anthropic 1.x and mistralai 3.x), `requests` and
`aiohttp` (which google-genai uses whenever it's installed), plus boto3 for
Bedrock.

| Provider | Matched endpoint(s) | What's recorded |
| --- | --- | --- |
| OpenAI | `api.openai.com` | Tokens, cached input, reasoning; speech characters; transcription seconds or tokens |
| Azure OpenAI / AI Foundry | `*.openai.azure.com`, `*.services.ai.azure.com`, `*.cognitiveservices.azure.com` | Same as OpenAI; priced at the Azure rate |
| Anthropic | `api.anthropic.com` | Tokens, cache reads and writes |
| Google Gemini | `generativelanguage.googleapis.com` | Tokens, thinking, cached input, tool-use prompt tokens, search and Maps grounding |
| Google Vertex AI | `aiplatform.googleapis.com`, `*-aiplatform.googleapis.com` | Gemini as above; Claude and other partner models with their own usage |
| AWS Bedrock | `bedrock-runtime.*.amazonaws.com` | Tokens and cache, including Converse and InvokeModel event streams |
| OpenRouter, Vercel AI Gateway, Portkey, Helicone | Their gateway hosts | Tokens; provider-reported cost where sent |
| Mistral, DeepSeek, xAI, Cohere, Groq, Together, Fireworks, Perplexity, Cerebras | Their API hosts | Tokens; Cohere embed tokens and rerank search units |
| Alibaba Qwen, Moonshot Kimi, Z.ai GLM, MiniMax | DashScope, `api.moonshot.ai`/`.cn`, `api.z.ai`, `open.bigmodel.cn`, `api.minimax.io` | Tokens; MiniMax speech characters |
| DeepInfra, NVIDIA NIM, SambaNova, Novita, Hyperbolic, Nebius, Hugging Face, Baseten, Lambda, Featherless, Friendli, AI21, Upstage, Cloudflare Workers AI | Their API hosts | Tokens |
| Ollama | `localhost:11434` | Tokens (set your own rate) |
| ElevenLabs, Cartesia, Deepgram Aura, Rumik Silk, Sarvam Bulbul | Their API hosts | Characters |
| Deepgram, AssemblyAI, Sarvam, ElevenLabs Scribe | Their API hosts | Audio seconds |
| Voyage, Jina | `api.voyageai.com`, `api.jina.ai` | Embedding and rerank tokens |
| Exa, Tavily, Firecrawl | Their API hosts | Searches and results, credits, pages |
| TypeSafe | `api.typesafe.ai` | Tokens |

WebSocket and realtime APIs (OpenAI Realtime, Deepgram live, Cartesia
websocket) aren't captured.

Failed calls (4xx/5xx) are recorded without billable units. Audio responses
are never read or buffered.

### Bedrock with the AWS SDK

boto3 is covered automatically. In Node, the AWS SDK v3 doesn't use `fetch`,
so instrument the client once:

```typescript
const bedrock = CostKey.instrumentBedrockClient(new BedrockRuntimeClient({ region: "us-east-1" }))
```

## How endpoint detection works

On every patched call, the SDK checks the request URL's hostname against the
capture list. Matching is intentionally narrow. Non-matching calls pass
through untouched.

When a match is found, the SDK:

1. Captures the stack trace (every frame; the server picks the call site)
2. Records the start time
3. Passes the request to the provider. On streamed Chat Completions calls to
   hosts that need it, it adds a usage option, and it removes explicit
   CostKey carrier headers.
4. Records the request and response as skeletons: keys and numbers are kept,
   text is replaced by its length. Streams are recorded chunk by chunk as your
   code reads them.
5. Sends the event asynchronously

Recording, stack capture and serialization still have a cost; profile your
application before choosing performance-sensitive settings. Streams over
WebSocket and other non-HTTP transports aren't covered.

## Cost

The server extracts usage from the telemetry and prices it from a synced
catalog. See [Pricing](/pricing) for sources, matching and what to do when a
model has no price.

## Custom providers

A host that isn't built in, such as an internal gateway or a self-hosted
model server, is configured on the CostKey server for each project. There is
no SDK code to write. Owners and admins create one with the projects API,
authenticated with a sign-in token such as the one `npx costkey setup` saves
in `~/.costkey/token`:

```bash
curl -X POST "$COSTKEY_URL/api/v1/projects/$PROJECT_ID/providers" \
  -H "Authorization: Bearer $(cat ~/.costkey/token)" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "internal-llm",
    "hostname": "llm.internal.example.com",
    "usageInputPath": "usage.prompt_tokens",
    "usageOutputPath": "usage.completion_tokens",
    "modelPath": "model"
  }'
```

| Field | Meaning |
| --- | --- |
| `name` | The provider name shown in the console. Required. |
| `hostname` | The host to capture. `*.example.com` matches any subdomain. Required. |
| `usageInputPath` | Dot path to the input token count in the response body. Default `usage.prompt_tokens`. |
| `usageOutputPath` | Dot path to the output token count. Default `usage.completion_tokens`. |
| `modelPath` | Dot path to the model name in the response or request body. Default `model`. |

`GET` lists a project's custom providers, and
`PATCH` and `DELETE` on `/api/v1/projects/:projectId/providers/:providerId`
change or remove one (`"enabled": false` turns one off).

How it works:

- SDKs pick up the enabled hostnames from the DSN runtime config, which they
  refresh every 60 seconds by default, and capture those calls like any other
  provider.
- The server applies the paths to the raw telemetry. Built-in providers are
  matched first, so a custom entry can't take over a known host.
- The model is read only from a key the skeleton keeps as text, such as
  `model`. Other strings arrive as lengths.
- Set a price for the model in **Settings, Prices & credits**.

## Provider-specific notes

### OpenAI

The TypeScript SDK adds `stream_options: { include_usage: true }` to streamed Chat Completions requests so the final SSE chunk includes token usage. Your code doesn't need to change.

### Anthropic

Cache reads and cache writes are tracked and priced separately from other input tokens.

### DeepSeek

Reasoning tokens and cache hit and miss tokens are tracked.

### AWS Bedrock

Bedrock URLs follow the pattern `bedrock-runtime.<region>.amazonaws.com`. All regions are detected. The server extracts usage from Bedrock's response format, which wraps the underlying model's response, and from its token count headers.

### Google / Vertex AI

Both the Generative Language API (`generativelanguage.googleapis.com`) and Vertex AI endpoints (`*-aiplatform.googleapis.com`) are detected.
