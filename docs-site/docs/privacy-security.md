---
sidebar_position: 8
title: Privacy & Security
description: What CostKey captures, how credentials are scrubbed, and data retention.
---

# Privacy & Security

CostKey is designed to be safe to run in production. The SDK includes built-in credential scrubbing, and you have full control over what data is captured and sent.

## What CostKey captures

By default, the SDK captures the following for each AI API call:

| Data | Captured | Purpose |
|------|:--------:|---------|
| Provider + model | Yes | Cost calculation, filtering |
| Token counts (input, output, cache, reasoning) | Yes | Cost calculation, usage analytics |
| Latency (total, TTFT, tokens/sec) | Yes | Performance monitoring |
| HTTP status code | Yes | Error tracking |
| Stack trace | Yes | Call site attribution |
| Request body (prompt) | Default on | Debugging, inspection in event detail panel |
| Response body (completion) | Default on | Debugging, inspection in event detail panel |
| Request URL | Yes | Provider detection |

### What CostKey does NOT capture

- **API keys or auth headers** — the SDK reads response bodies, not request headers
- **Non-AI HTTP calls** — only requests to known AI provider hostnames are intercepted
- **Environment variables** — never read or sent (except the DSN you explicitly pass)
- **File system contents** — never accessed
- **Other network traffic** — non-AI fetch/httpx calls pass through untouched

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
    dsn="https://ck_key@app.costkey.dev/proj_id",
    capture_body=False,  # Only send metadata, tokens, and cost
)
```

</TabItem>
<TabItem value="typescript" label="TypeScript">

```typescript
CostKey.init({
  dsn: 'https://ck_key@app.costkey.dev/proj_id',
  captureBody: false,  // Only send metadata, tokens, and cost
})
```

</TabItem>
</Tabs>

With `captureBody` disabled, you still get full cost tracking, token counts, latency, and stack traces. You just won't be able to inspect prompts and completions in the event detail panel.

## `before_send` hook

For fine-grained control, use the `before_send` hook to modify or drop events before they leave your app.

<Tabs>
<TabItem value="python" label="Python">

```python
from costkey.types import CostKeyEvent

def my_hook(event: CostKeyEvent) -> CostKeyEvent | None:
    # Drop events from dev/test models
    if event.model and "test" in event.model:
        return None

    # Strip all request bodies (keep responses for debugging)
    event.request_body = None

    # Remove PII from context
    if "user_email" in event.context:
        del event.context["user_email"]

    return event

costkey.init(
    dsn="https://ck_key@app.costkey.dev/proj_id",
    before_send=my_hook,
)
```

</TabItem>
<TabItem value="typescript" label="TypeScript">

```typescript
import type { CostKeyEvent } from 'costkey'

CostKey.init({
  dsn: 'https://ck_key@app.costkey.dev/proj_id',
  beforeSend: (event: CostKeyEvent): CostKeyEvent | null => {
    // Drop events from dev/test models
    if (event.model?.includes('test')) return null

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

If the `before_send` hook throws an exception, the event is dropped (not sent). The SDK never crashes your app — errors in hooks are caught silently (or logged if `debug: true`).

## Data retention

| Hosting | Default retention | Configurable |
|---------|:-----------------:|:------------:|
| CostKey Cloud (app.costkey.dev) | 90 days | No (free tier) |
| Self-hosted | Unlimited | Yes (your database) |

Self-hosted instances retain data for as long as you keep it in PostgreSQL. You can set up your own retention policies using standard PostgreSQL features (e.g., `pg_partman` or a cron job to delete old rows).

## Network security

### SDK to server communication

- Events are sent via HTTPS (TLS 1.2+) to the ingest endpoint
- Authentication uses the auth key from the DSN (sent as a `Bearer` token in the `Authorization` header)
- Events are batched (default: up to 50 per request) and sent every 5 seconds
- The transport never blocks your application. If a send fails, events are retried on the next flush. If the queue exceeds 500 events, the oldest are dropped.

### Self-hosted security

When self-hosting, you control:

- **Network access** — restrict ingest endpoints to your VPN/internal network
- **Database encryption** — use PostgreSQL's encryption features
- **TLS termination** — handle at your reverse proxy (nginx, Cloudflare, etc.)
- **Auth** — the JWT secret controls dashboard access

## Open source

CostKey is fully open-source (MIT license). You can audit every line of code:

- [SDK source (TypeScript)](https://github.com/costkey/costkey/tree/main/packages/sdk)
- [SDK source (Python)](https://github.com/costkey/costkey-python)
- [Server source](https://github.com/costkey/costkey/tree/main/packages/server)
