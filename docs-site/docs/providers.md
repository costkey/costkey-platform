---
sidebar_position: 4
title: Providers
description: All 15 AI providers supported by CostKey, with auto-detection details.
---

# Providers

CostKey auto-detects 15 AI providers by matching the URL hostname of outgoing HTTP requests. No configuration needed — if you call any of these APIs, CostKey captures it.

## Supported providers

| Provider | Hostname(s) | Auto-detected | Notes |
|----------|------------|:---:|-------|
| **OpenAI** | `api.openai.com` | Yes | Includes GPT-4o, o1, o3, DALL-E, Whisper, Embeddings |
| **Anthropic** | `api.anthropic.com` | Yes | Claude models. Cache tokens tracked (read + creation) |
| **Google** | `generativelanguage.googleapis.com`, `*-aiplatform.googleapis.com` | Yes | Gemini, PaLM, Vertex AI |
| **Azure OpenAI** | `*.openai.azure.com` | Yes | Azure-hosted OpenAI models |
| **Groq** | `api.groq.com` | Yes | Fast inference (Llama, Mixtral, Gemma) |
| **xAI** | `api.x.ai`, `api.grok.xai.com` | Yes | Grok models |
| **Mistral** | `api.mistral.ai` | Yes | Mistral, Mixtral, Codestral |
| **DeepSeek** | `api.deepseek.com` | Yes | DeepSeek-V3, DeepSeek-R1. Reasoning + cache tokens tracked |
| **Cohere** | `api.cohere.com` | Yes | Command, Embed, Rerank |
| **Together AI** | `api.together.xyz` | Yes | Open-source model hosting |
| **Fireworks AI** | `api.fireworks.ai` | Yes | Fast open-source inference |
| **Perplexity** | `api.perplexity.ai` | Yes | Sonar models |
| **Cerebras** | `api.cerebras.ai` | Yes | Fastest inference (Llama) |
| **OpenRouter** | `openrouter.ai` | Yes | Multi-provider router |
| **AWS Bedrock** | `bedrock-runtime.*.amazonaws.com` | Yes | Claude, Titan, Llama on AWS |

## How auto-detection works

On every `fetch` call (TypeScript) or `httpx`/`requests` call (Python), the SDK checks the request URL's hostname against the provider list. The check is a simple string match — it runs in microseconds and adds zero measurable overhead to non-AI calls.

When a match is found, the SDK:

1. Captures a stack trace (for call site attribution)
2. Records the start time
3. Passes the request through to the provider unmodified
4. Reads the response (cloned) to extract token usage
5. Sends a CostKey event asynchronously

For streaming responses, the SDK wraps the response stream to capture timing metrics (TTFT, tokens/sec) and extracts usage from the final SSE chunk.

## Server-side cost calculation

The SDK sends raw token counts to the CostKey server. The server calculates costs using a fuzzy model matching system:

- `claude-sonnet-4-5-20250514` matches pricing for `claude-sonnet-4-5`
- `ft:gpt-4o:my-org:custom:abc` matches pricing for `gpt-4o`
- `accounts/fireworks/models/llama-v3p1-70b-instruct` matches `llama-3.1-70b`

This means you never need to update the SDK when prices change — the server pricing table is updated independently.

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
