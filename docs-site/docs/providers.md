---
sidebar_position: 4
title: Providers
description: Provider endpoint, response-shape, and transport coverage for CostKey.
---

# Providers

CostKey has built-in extractors for the provider endpoints below. Detection is
an exact hostname/pattern match in the current SDKs; it is not a claim that
every API, proxy, WebSocket, or SDK transport for a provider is covered. No
provider-routing gateway is required.

## Supported providers

TypeScript patches `globalThis.fetch`. Python patches `httpx`, `requests` and
`aiohttp` (which google-genai uses whenever it's installed), plus boto3 for
Bedrock.

| Provider | Matched endpoint(s) | What's recorded |
| --- | --- | --- |
| OpenAI | `api.openai.com` | Tokens, cached input, reasoning (Chat Completions and Responses, streamed or not) |
| Azure OpenAI / AI Foundry | `*.openai.azure.com`, `*.services.ai.azure.com`, `*.cognitiveservices.azure.com` | Same as OpenAI; priced at the Azure rate |
| Anthropic | `api.anthropic.com` | Tokens, cache reads and writes |
| Google Gemini | `generativelanguage.googleapis.com` | Tokens, thinking, cached input, tool-use prompt tokens, search and Maps grounding |
| Google Vertex AI | `aiplatform.googleapis.com`, `*-aiplatform.googleapis.com` | Same as Gemini |
| AWS Bedrock | `bedrock-runtime.*.amazonaws.com` | Tokens and cache, including Converse and InvokeModel event streams |
| OpenRouter | `openrouter.ai` | Tokens; provider-reported cost |
| Groq, xAI, Mistral, DeepSeek, Cohere, Together, Fireworks, Perplexity, Cerebras | Their API hosts | Tokens |
| ElevenLabs | `api.elevenlabs.io` | Characters for text to speech; audio duration for speech to text |
| Rumik Silk | `*.rumik.ai` | Characters |
| Exa | `api.exa.ai` | Searches and results, pages; provider-reported cost |
| Firecrawl | `api.firecrawl.dev` | Credits; searches and results |
| TypeSafe | `api.typesafe.ai` | Tokens |

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
provider list. Matching is intentionally narrow. Non-matching calls pass
through, while matched calls are observed for usage and timing. Request/response
copying, parsing, stack capture, and serialization still have a cost; profile
your application before choosing performance-sensitive settings.

When a match is found, the SDK:

1. Captures a stack trace (for call site attribution)
2. Records the start time
3. Passes the request to the provider; supported streaming may add a usage
   inclusion option and explicit CostKey carrier headers are removed
4. Reads the response (cloned) to extract token usage
5. Sends a CostKey event asynchronously

For supported streaming responses, the SDK wraps the response stream to capture
timing metrics (TTFT, tokens/sec) and looks for usage in SSE data frames. This
does not provide complete voice or non-HTTP transport coverage.

## Cost

The SDK sends usage; the server prices it from a synced catalog. See
[Pricing](/pricing) for sources, matching and what to do when a model has no
price.

## Adding a custom provider

If you use an AI provider not in the built-in list, register a custom extractor:

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

<Tabs>
<TabItem value="python" label="Python">

```python
import costkey
from costkey.types import Provider, NormalizedUsage

class MyProviderExtractor:
    provider = Provider.UNKNOWN

    def match(self, url: str) -> bool:
        from urllib.parse import urlparse
        return urlparse(url).hostname == "api.myprovider.com"

    def extract_usage(self, body: dict) -> NormalizedUsage | None:
        usage = body.get("usage")
        if not usage:
            return None
        return NormalizedUsage(
            input_tokens=usage.get("prompt_tokens"),
            output_tokens=usage.get("completion_tokens"),
            total_tokens=usage.get("total_tokens"),
        )

    def extract_model(self, request_body, response_body) -> str | None:
        if isinstance(response_body, dict):
            return response_body.get("model")
        if isinstance(request_body, dict):
            return request_body.get("model")
        return None

costkey.register_extractor(MyProviderExtractor())
```

</TabItem>
<TabItem value="typescript" label="TypeScript">

```typescript
import { CostKey, Provider } from 'costkey'
import type { ProviderExtractor, NormalizedUsage } from 'costkey'

CostKey.registerExtractor({
  provider: Provider.Unknown,

  match(url: URL): boolean {
    return url.hostname === 'api.myprovider.com'
  },

  extractUsage(body: unknown): NormalizedUsage | null {
    const b = body as Record<string, any>
    const usage = b?.usage
    if (!usage) return null
    return {
      inputTokens: usage.prompt_tokens ?? null,
      outputTokens: usage.completion_tokens ?? null,
      totalTokens: usage.total_tokens ?? null,
      reasoningTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
    }
  },

  extractModel(requestBody: unknown, responseBody: unknown): string | null {
    const resp = responseBody as Record<string, any>
    if (resp?.model) return resp.model
    const req = requestBody as Record<string, any>
    if (req?.model) return req.model
    return null
  },
})
```

</TabItem>
</Tabs>

## Provider-specific notes

### OpenAI

CostKey injects `stream_options: { include_usage: true }` into streaming requests so that the final SSE chunk includes token usage. This is done transparently — your code doesn't need to change.

### Anthropic

Cache tokens are tracked separately:
- `cacheReadTokens` / `cache_read_tokens` — tokens read from Anthropic's prompt cache
- `cacheCreationTokens` / `cache_creation_tokens` — tokens written to cache

### DeepSeek

Reasoning tokens (from DeepSeek-R1) are captured in the `reasoningTokens` field. Cache hit/miss tokens are also tracked.

### AWS Bedrock

Bedrock URLs follow the pattern `bedrock-runtime.<region>.amazonaws.com`. All regions are auto-detected. The SDK extracts usage from Bedrock's response format, which wraps the underlying model's response.

### Google / Vertex AI

Both the Generative Language API (`generativelanguage.googleapis.com`) and Vertex AI endpoints (`*-aiplatform.googleapis.com`) are detected.
