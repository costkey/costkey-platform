---
sidebar_position: 5
title: Dashboard
description: What each tab in the CostKey dashboard shows.
---

# Dashboard

The CostKey dashboard is a React SPA that gives you full visibility into your AI API usage. It connects to the CostKey server API and displays cost, usage, and performance data.

Access it at [app.costkey.dev](https://app.costkey.dev) or self-host it (the dashboard is built into the server binary).

## Overview tab

[screenshot: overview]

The Overview tab shows aggregate metrics over a selected time range:

- **Total cost** — sum of all AI API costs in the period
- **Total calls** — number of AI API calls
- **Total tokens** — input + output tokens
- **Average latency** — mean request duration
- **Cost over time** — area chart showing cost trend
- **Cost by provider** — breakdown by AI provider
- **Cost by model** — breakdown by model
- **Top call sites** — which functions in your code spend the most

Use the time range selector to view the last hour, day, week, or month.

## Call Sites tab

[screenshot: call-sites]

Call Sites groups events by the business logic function that triggered them. CostKey's stack trace analysis finds the first frame from a different file than the direct API caller, skipping wrapper/utility functions automatically.

For each call site you see:

- **Function name** and file location
- **Total cost** from that call site
- **Call count**
- **Average cost per call**
- **Average latency**

This answers the question: "Which part of my code costs the most?"

## Traces tab

[screenshot: traces]

Traces group related AI calls that happen during a single operation. When you use `start_trace()` (or the Express/FastAPI middleware), all AI calls within that scope are grouped under one trace.

For each trace:

- **Trace name** (e.g., `POST /api/search`)
- **Total cost** of all calls in the trace
- **Call count** within the trace
- **Duration** from first to last call
- **Timeline** showing the sequence of AI calls

CostKey also auto-generates trace IDs from stack traces when you don't use `start_trace()` explicitly. Calls made from the same request handler within a 5-second window are grouped automatically.

## Events tab

[screenshot: events]

Events is the raw event log — every individual AI API call. The table shows:

- **Timestamp**
- **Provider** and **model**
- **Cost** (in USD)
- **Input/output tokens**
- **Latency** (ms)
- **Streaming** (yes/no)
- **Call site** function name

### Event detail panel

Click any event to open the slide-over detail panel showing:

- **Full request body** (the prompt sent to the AI provider)
- **Full response body** (the completion received)
- **Token breakdown** (input, output, reasoning, cache read, cache creation)
- **Streaming metrics** (TTFT, tokens/sec, chunk count)
- **Full stack trace** with the business logic frame highlighted
- **Context** metadata (task, team, custom tags)

Request and response bodies have credentials automatically scrubbed. API keys, bearer tokens, JWTs, and other secrets matching known patterns are replaced with `[REDACTED]`.

## Filtering

All tabs support filtering by:

- **Time range** — last hour, day, week, month, or custom
- **Provider** — filter to a specific AI provider
- **Model** — filter to a specific model
- **Context** — filter by custom context values (task, team, etc.)

## Projects

If you have multiple projects (e.g., staging vs. production, or separate services), each project has its own DSN and isolated data. Switch between projects in the sidebar.
