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

| Provider label | Matched endpoint(s) | TypeScript `fetch` | Python HTTPX | Python `requests` | Response evidence |
| --- | --- | :---: | :---: | :---: | --- |
| OpenAI | `api.openai.com` | ✓ | ✓ | ✓ | `usage.prompt_tokens`/`completion_tokens`; Responses-style `input_tokens`/`output_tokens` |
| Anthropic | `api.anthropic.com` | ✓ | ✓ | ✓ | `usage.input_tokens`/`output_tokens`; cache fields when present |
| Google | `generativelanguage.googleapis.com` | ✓ | ✓ | ✓ | `usageMetadata.promptTokenCount`/`candidatesTokenCount` |
| Google / Vertex | `*-aiplatform.googleapis.com` | ✓ | ✓ | ✓ | Same `usageMetadata` shape when returned |
| Azure OpenAI | `*.openai.azure.com` | ✓ | ✓ | ✓ | OpenAI-style usage; event provider label is `openai` in the current extractor |
| Groq | `api.groq.com` | ✓ | ✓ | ✓ | OpenAI-compatible `usage` fields when present |
| xAI | `api.x.ai`, `api.grok.xai.com` | ✓ | ✓ | ✓ | OpenAI-compatible `usage` fields when present |
| Mistral | `api.mistral.ai` | ✓ | ✓ | ✓ | OpenAI-compatible `usage` fields when present |
| DeepSeek | `api.deepseek.com` | ✓ | ✓ | ✓ | OpenAI-style usage plus reasoning/cache fields when present |
| Cohere | `api.cohere.com` | ✓ | ✓ | ✓ | `meta.tokens` or OpenAI-compatible `usage` |
| Together AI | `api.together.xyz` | ✓ | ✓ | ✓ | OpenAI-compatible `usage` fields when present |
| Fireworks AI | `api.fireworks.ai` | ✓ | ✓ | ✓ | OpenAI-compatible `usage` fields when present |
| Perplexity | `api.perplexity.ai` | ✓ | ✓ | ✓ | OpenAI-compatible `usage` fields when present |
| Cerebras | `api.cerebras.ai` | ✓ | ✓ | ✓ | OpenAI-compatible `usage` fields when present |
| OpenRouter | `openrouter.ai` | ✓ | ✓ | ✓ | OpenAI-style usage; TypeScript also reads provider-reported `usage.cost` when present |
| AWS Bedrock | `bedrock-runtime.*.amazonaws.com` | ✓ | ✓ | ✓ | `usage.inputTokens`/`outputTokens` or `amazon-bedrock-invocationMetrics` |

The checkmarks identify the patched method, not every library that may call
that method. TypeScript patches `globalThis.fetch`; Python patches
`httpx.Client.send`, `httpx.AsyncClient.send`, and `requests.Session.send`.
The endpoint rows correspond to the extractor registries and provider-shape
tests in the SDK source; a hostname match alone is not live-provider proof.
Python stream iteration is implemented for HTTPX; the `requests` path is
JSON-oriented and has no separate SSE iterator wrapper. The current
TypeScript and HTTPX stream paths require a JSON request with `stream: true`
and usage in a parseable SSE `data:` frame. Bedrock streaming is not asserted
by this table.

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

## Server-side cost calculation

The SDK sends raw token counts to the CostKey server. The server calculates costs using a fuzzy model matching system:

- `claude-sonnet-4-5-20250514` matches pricing for `claude-sonnet-4-5`
- `ft:gpt-4o:my-org:custom:abc` matches pricing for `gpt-4o`
- `accounts/fireworks/models/llama-v3p1-70b-instruct` matches `llama-3.1-70b`

Pricing is resolved server-side when the model and usage are known. A missing
price remains unknown; it is not rendered as zero. This page intentionally does
not publish model rates.

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
