---
sidebar_position: 8
title: Privacy & security
description: What CostKey captures, how credentials are scrubbed, and data retention.
---

# Privacy & security

CostKey includes built-in credential scrubbing, and the SDK lets you choose
whether request/response bodies are sent. Capture still depends on the
supported endpoint and transport; see the [developer capability
matrix](/recipes#capability-matrix).

## What CostKey captures

For each supported AI API call, CostKey records the following. The SDK only
sends raw telemetry: a skeleton of the request and response in which keys and
numbers are kept and text is replaced by its length. The server works out the
provider, model, token counts and latency from it.

| Data | Captured | Purpose |
|------|:--------:|---------|
| Provider + model | When available | Cost calculation, filtering |
| Token counts (input, output, cache, reasoning) | When reported | Cost calculation, usage analytics |
| Latency (total, TTFT, tokens/sec) | When observable | Performance monitoring |
| HTTP status code | When a response exists | Error tracking |
| Stack trace | When captured | Call site attribution |
| Request body (prompt) | Conditional | Only when project text capture, SDK body capture, and endpoint support it |
| Response body (completion) | Conditional | Only when project text capture, SDK body capture, and endpoint support it |
| Request URL | Yes | Provider detection |

The SDK's local preference preserves legacy text-capture compatibility for
existing text-enabled projects, but runtime startup is metadata-only until the
DSN-authenticated project configuration is known. New projects default to
metadata-only at the server. The server project setting is authoritative, and
`captureBody: false` / `capture_body=False` is the application-side switch
that omits request/response bodies from telemetry in every mode.
Project permissions and retention settings can further restrict what a member
can read and how long captured content remains available.

Metadata-only events may still carry structural counts and roles needed for
diagnostics; they do not carry prompt, response, tool-definition, tool-call, or
system-instruction content.

### What CostKey doesn’t capture

- **API keys or auth headers**: only an allowlist of request headers is sent (such as `content-type` and `anthropic-version`), credential query parameters are dropped, and cookie, authorization and API key response headers are dropped
- **Non-AI HTTP calls**: only requests to known AI provider hostnames are intercepted
- **Environment variables**: not sent (except the DSN/configuration values you explicitly provide)
- **Source contents**: not sent as prompt data; the Python call-graph option reads `.py` structure locally and sends only its structural graph
- **Other network traffic**: non-AI fetch/httpx calls pass through untouched

## Credential scrubbing

The SDK automatically scrubs credentials from captured request and response bodies before sending them to the server. This runs on every event, regardless of configuration.

### Scrubbed patterns

Values matching these patterns are replaced with `[REDACTED]`:

| Pattern | Example |
|---------|---------|
| `sk-[a-zA-Z0-9]{20,}` | OpenAI API keys |
| `sk-ant-[a-zA-Z0-9-]{20,}` | Anthropic API keys |
| `AIza[a-zA-Z0-9_-]{30,}` | Google API keys |
| `Bearer .{20,}` | Bearer tokens |
| `eyJ[a-zA-Z0-9_-]{20,}` | JWTs |
| `xox[bpras]-[a-zA-Z0-9-]{20,}` | Slack tokens |
| `ghp_[a-zA-Z0-9]{30,}` | GitHub tokens |

### Scrubbed keys

Any JSON key matching these names (case-insensitive) has its value replaced with `[REDACTED]`:

`api_key`, `apikey`, `api-key`, `secret`, `secret_key`, `secretkey`, `token`, `access_token`, `refresh_token`, `password`, `passwd`, `credential`, `authorization`, `auth`, `private_key`, `privatekey`

## Disabling body capture

If you don't want request/response bodies sent to CostKey at all, disable body capture:

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

<Tabs>
<TabItem value="python" label="Python">

```python
costkey.init(
    dsn="http://ck_key@localhost:4100/proj_id",
    capture_body=False,  # Only send metadata, tokens, and cost
)
```

</TabItem>
<TabItem value="typescript" label="TypeScript">

```typescript
CostKey.init({
  dsn: 'http://ck_key@localhost:4100/proj_id',
  captureBody: false,  // Only send metadata, tokens, and cost
})
```

</TabItem>
</Tabs>

With `captureBody` disabled, supported events can still provide cost/usage,
latency, and stack metadata. Prompt and completion inspection is unavailable,
and any unknown pricing remains unknown rather than being shown as zero.

## `before_send` hook

For fine-grained control, use the `before_send` hook to modify or drop events before they leave your app.

<Tabs>
<TabItem value="python" label="Python">

```python
from costkey.types import CostKeyEvent

def my_hook(event: CostKeyEvent) -> CostKeyEvent | None:
    # Drop events from a test environment
    if event.context.get("environment") == "test":
        return None

    # Strip all request bodies (keep responses for debugging)
    event.request_body = None

    # Remove PII from context
    if "user_email" in event.context:
        del event.context["user_email"]

    return event

costkey.init(
    dsn="http://ck_key@localhost:4100/proj_id",
    before_send=my_hook,
)
```

</TabItem>
<TabItem value="typescript" label="TypeScript">

```typescript
import type { CostKeyEvent } from 'costkey'

CostKey.init({
  dsn: 'http://ck_key@localhost:4100/proj_id',
  beforeSend: (event: CostKeyEvent): CostKeyEvent | null => {
    // Drop events from a test environment
    if (event.context.environment === 'test') return null

    // Strip all request bodies
    event.requestBody = null

    // Remove PII from context
    delete event.context.userEmail

    return event
  },
})
```

</TabItem>
</Tabs>

If the `before_send` hook throws an exception, the event is dropped (not sent). The SDK never crashes your app: errors in hooks are caught silently (or logged if `debug: true`).

## Data retention

Current project settings target separate windows for each kind of data:

| Data | Target default | Available setting |
|------|:--------------:|-------------------|
| Detailed trace metadata | 30 days | Owner/Admin can shorten it |
| Captured text bodies | 7 days | One day or disable new body capture |
| Daily cost aggregates | 395 days | Retained separately from trace detail |

These settings describe primary data. Database-provider backups and legal
retention are separate and are not implied by the project setting. Shortening a
window or disabling future body capture does not silently rewrite existing
history; the console shows when a body has expired while retained cost and
metadata remain available.

## Network security

### SDK to server communication

- Events are sent via HTTPS (TLS 1.2+) to the ingest endpoint
- Authentication uses the auth key from the DSN (sent as a `Bearer` token in the `Authorization` header)
- Events are batched (default: up to 50 per request) and sent every 5 seconds
- Delivery is queued and best-effort. Network/server failures are retried by
  the transport where supported, and a queue above 500 events drops the oldest
  event. Capture, serialization, and an explicit flush still consume
  application resources; do not interpret this as a no-additional-work
  guarantee.


## Source code

The SDK source is available on GitHub for review:

- [TypeScript SDK](https://github.com/costkey/costkey)
- [Python SDK](https://github.com/costkey/costkey-python)
