---
sidebar_position: 4
title: Developer recipes & diagnostics
description: DX10 recipes for supported HTTP capture, context, grouped work, evals, and voice usage.
---

# Developer recipes & diagnostics

CostKey observes supported provider calls in the process that makes them. It
does not require replacing a provider client, moving credentials, or adding a
model gateway. Use the phrase **No gateway required / no extra provider-routing
hop**. The transport and endpoint still determine what is observable; a
provider brand by itself is not a coverage guarantee.

This page separates APIs present in the workspace SDK source from APIs already
available in a released package. Examples use `COSTKEY_DSN` from the
environment and make no provider request. A placeholder such as
`existingSearch()` means “call the provider client your application already
uses.”

:::caution Source versus package release

The lifecycle, explicit-usage, and carrier helpers are implemented in the
current workspace TypeScript source and in the parallel Python SDK worktree,
but package publication and the full cross-language acceptance run are still a
release task. Treat those snippets as source-contract examples until your
installed npm/PyPI version exports the method and its tests pass. Existing
published trace/context APIs remain compatible.

:::

## Status at a glance

Verified in the existing SDK API surface:

- initialization with a DSN, optional body capture, default context, and
  asynchronous delivery settings;
- nested business context (`withContext` / `with_context`);
- explicit trace boundaries (`startTrace` / `start_trace`);
- `flush` and `shutdown`; and
- custom provider extractors.

The workspace source now also contains `startExecution`/`start_execution`,
`recordUsage`/`record_usage`, and an explicit carrier pair. They are marked
**source implemented — release pending** below because the installed package
version may not export them yet. Do not claim a feature is shipped from source
presence alone.

New projects begin metadata-only. The SDK negotiates capture mode with the
DSN-authenticated project configuration and starts metadata-only until that
response is known. A project must explicitly enable text capture, and the SDK
must allow body capture, before prompt/response/tool content can be delivered;
an endpoint still has to expose a recognized shape. `captureBody: false` /
`capture_body=False` is always an opt-out. Runtime config failure or revocation
keeps content off without blocking supported provider calls.

The HTTP, worker, grouped-batch, and eval files are syntax/type-checked
templates whose provider functions are stubs. The Python LiveKit harness is
the only example executed end-to-end locally; it uses an in-memory transport
and no provider or CostKey network call.

## Capability matrix

The table describes code paths, not just provider names. “Supported” means the
SDK can match the endpoint and inspect the response shape shown; it does not
mean every endpoint, transport, streaming mode, or provider-hosted proxy is
covered.

| Path | Endpoint evidence | Transport/response evidence | Automatically observed | Current status |
| --- | --- | --- | --- | --- |
| TypeScript/Node | Built-in host matchers such as `api.openai.com`, `api.anthropic.com`, `generativelanguage.googleapis.com`, and `bedrock-runtime.*.amazonaws.com` | `globalThis.fetch`; JSON responses and SSE-style `data:` responses when the JSON request has `stream: true` | Provider/model, usage fields recognized by the extractor, duration, stack, and current context | Source implemented; release/acceptance caveat |
| Python async/sync HTTP | The same built-in provider host matchers in the Python SDK | `httpx.AsyncClient.send` and `httpx.Client.send`; JSON responses and wrapped HTTPX stream iteration (`iter_*`, `aiter_*`, `read`, `aread`) | Provider/model, recognized usage, duration, stack, and current context | Source implemented; release/acceptance caveat |
| Python `requests` | The same host matchers | `requests.Session.send`; response JSON is inspected; no separate SSE iterator wrapper is provided | Provider/model, recognized usage, duration, stack, and current context | Source implemented; JSON path |
| Custom HTTP provider | Your extractor's `match(url)` predicate | The transport must expose a response body in the extractor's expected shape | Whatever the custom extractor returns | Implemented extension point |
| LiveKit Agents | No CostKey HTTP endpoint is involved; LiveKit emits plugin metrics and cumulative `session.usage.model_usage` | `session_usage_updated`/`session.usage` are application callbacks, not auto-captured HTTP | Nothing automatically; an adapter must preserve native units and identity | Explicit adapter; source implemented, release/acceptance pending |
| WebSocket, gRPC, or other non-matched transport | No built-in endpoint matcher or hook in the current packages | No automatic response inspection path; caller can emit an explicit usage event | Nothing automatically | `recordUsage`/`record_usage` source implemented; adapter/acceptance pending |

Streaming capture is conditional: the current HTTP implementations need a JSON
request with `stream: true`, and usage must be present in a response shape that
the provider extractor understands. Do not infer voice, WebSocket, or gRPC
coverage from ordinary `fetch`/HTTP support. Measure application overhead in
your own runtime before making performance claims; this documentation does not
promise that instrumentation adds no application work or latency.

For the complete host and response-shape list, see [Providers](/providers).

## 1. HTTP request: name the boundary once

Put CostKey initialization before the first provider call. Add business
context at the request boundary and a trace around the operation. Context is
metadata you know; it is not inferred from a function name. Use a stable,
non-sensitive customer identifier or omit it.

### TypeScript

```ts
import { CostKey } from "costkey";

CostKey.init({
  dsn: process.env.COSTKEY_DSN,
  captureBody: false,
  defaultContext: { environment: "production", service: "search-api" },
});

export async function handleSearch(query: string, customerId: string) {
  return CostKey.withContext(
    { feature: "search", customer: customerId },
    () => CostKey.startTrace(
      { name: "POST /search" },
      () => existingSearch(query),
    ),
  );
}

// Your existing provider client call. This docs example makes no request.
declare function existingSearch(query: string): Promise<unknown>;
```

### Python

```python
import os
import costkey

costkey.init(
    dsn=os.environ.get("COSTKEY_DSN"),
    capture_body=False,
    default_context={"environment": "production", "service": "search-api"},
)

async def handle_search(query: str, customer_id: str):
    with costkey.with_context(feature="search", customer=customer_id):
        with costkey.start_trace(name="POST /search"):
            return await existing_search(query)

# Your existing provider client call. This docs example makes no request.
async def existing_search(query: str):
    raise RuntimeError("replace with the existing provider client")
```

CostKey captures supported provider identity, response usage, timing and call
site automatically. You supply the feature/customer labels and the operation
boundary when framework middleware does not already provide one. Without
those labels the observed call remains visible and unassigned; it is not
silently given invented business meaning.

## 2. Background worker: keep item traces and flush at the lifecycle boundary

Use one trace per item or meaningful operation. A loop over items is not proof
of a single trace, and telemetry silence is not proof that a job completed.
Flush when the worker is about to exit or hand work to another lifecycle
owner. The full examples are in `examples/cost-infra/background_worker.ts` and
`background_worker.py`.

### TypeScript

```ts
export async function processItem(itemId: string) {
  return CostKey.withContext(
    { operation: "document.process", itemId },
    () => CostKey.startTrace(
      { name: "document.process" },
      () => existingDocumentWork(itemId),
    ),
  );
}

export async function runBatch(itemIds: string[]) {
  try {
    for (const itemId of itemIds) await processItem(itemId);
  } finally {
    await CostKey.flush();
  }
}
```

### Python

```python
async def process_item(item_id: str):
    with costkey.with_context(operation="document.process", item_id=item_id):
        with costkey.start_trace(name="document.process"):
            await existing_document_work(item_id)

async def run_batch(item_ids: list[str]):
    try:
        for item_id in item_ids:
            await process_item(item_id)
    finally:
        costkey.flush()
```

The SDK supplies supported call identity and usage. The worker supplies item
identity, queue/job metadata, completion/error/cancellation, and expected item
counts. `startTrace` emits a trace lifecycle; use the grouped batch recipe when
you also need an execution receipt.

## Spending policy boundary

Installing or initializing the SDK does not enable blocking. Monitor mode is
the default. Enforcement is an explicit source-level option in both SDKs; it
requires a pre-call admission decision before the provider request. A refusal
is typed and should be handled as an application outcome, not retried as a
provider failure:

```python
import os
import costkey
from costkey import CostKeyPolicyRefused

costkey.init(
    dsn=os.environ.get("COSTKEY_DSN"),
    policy_mode="enforce",
    # Use a verified admission callback or the CostKey admission integration.
    policy=verified_admission,
)

try:
    await existing_search(query)
except CostKeyPolicyRefused as refusal:
    # Choose the safe response for your application: explain, queue, or stop.
    handle_refusal(refusal.reason, refusal.retry_after, refusal.reset_at)
```

The TypeScript source uses `policy: { mode: "monitor" | "enforce", ... }` and
raises `CostKeyPolicyRefused` with `retryAt`; the Python source exposes the
equivalent `policy_mode`/`policy` options and `retry_after`. Unknown required
pricing or an unavailable decision must refuse under an enforced policy;
unsupported transports remain monitoring-only. Do not promise a global ceiling
over bypass traffic or already in-flight work.

## 3. Mixed Python/TypeScript handoff

### Current behavior

Both SDKs can attach the same application-owned correlation value explicitly:

```text
TypeScript: CostKey.withContext({ traceId: appRequestId }, handler)
Python:     costkey.with_context(traceId=app_request_id)
```

This is an explicit, app-owned convention—not automatic propagation. Keep the
value on a trusted, allowlisted service/queue path. Do not forward arbitrary
context, credentials, prompt bodies, or request headers.

The workspace TypeScript source exposes `CostKey.exportContext()` and
`CostKey.exportContextHeaders()`. The Python source exposes
`costkey.export_context()` and accepts a mapping through `with_context(...)`.
These helpers may not yet be in the package version you installed.

### Explicit carrier (source implemented; release caveat above)

```text
SOURCE IMPLEMENTED — check the installed package before calling

carrier = CostKey.exportContext()
trustedRequest.headers = CostKey.exportContextHeaders()
python_context = costkey.with_context(carrier)
```

`exportContextHeaders()` is an explicit caller action; the SDK does not attach
it to arbitrary application requests. The Python side receives the trusted
JSON carrier and passes it to `with_context(...)`; a framework still owns
extraction from the inbound request. The carrier contains only approved
trace/group/business fields, never a DSN, provider credential, prompt,
response body, or arbitrary request headers. A copied link or correlation value
must not grant project access.

## 4. Grouped batch: stable group, fresh execution

The scheduler remains the source of truth for invocation and lifecycle. A
stable group name (for example, `nightly-document-import`) groups history; a
fresh execution ID distinguishes today’s invocation from yesterday’s. Member
traces should remain inspectable.

The following shape is implemented in workspace source for both SDKs. It is
shown here with the release caveat above; verify exports before running it:

```text
SOURCE IMPLEMENTED — check installed package version before calling

await CostKey.startExecution(
  { name: "nightly-document-import", kind: "batch", expectedItems: itemCount },
  () => runItems(),
)

with costkey.start_execution(
    name="nightly-document-import", kind="batch", expected_items=item_count
):
    await run_items()
```

The helper preserves lifecycle state separately from accounting completeness.
Delayed or unpriced usage stays partial/pending; it must not become zero. A
rerun gets a new execution, while a resumed invocation keeps its execution
identity.

## 5. Experiment and evaluation

Experiments and evals use grouped work but remain customer-owned. The harness
supplies the stable suite name, fresh invocation, variant/configuration,
dataset revision, case, and phase. Generation, scoring, retrieval, and a
separately running judge can use different providers or services.

The grouped lifecycle and explicit-usage APIs are implemented in workspace
source but still need package-release and cross-language acceptance evidence.
Until your installed version exports them, do not tag history in the console
and call it instrumentation; use the current trace/context APIs for calls that
are actually observed.

```text
SOURCE IMPLEMENTED — verify installed package exports before running

execution(kind=evaluation, name="search-eval", configuration=variant,
          datasetRevision=revision)
  generation -> trace(caseId=case, provider call)
  scoring    -> trace(caseId=case, external judge call)
  retrieval  -> trace(caseId=case, when instrumented)
  late usage -> same execution receipt
```

Quality scores are optional data supplied by the evaluator; CostKey must not
invent judge results. Retries are subsets of their phase totals, and shared
setup/judge charges need an explicit allocation rather than being counted for
every case.

## 6. Reference LiveKit usage

LiveKit’s current Agents data hooks expose per-plugin metrics and cumulative
per-model usage through `session_usage_updated` and `session.usage`.
[LiveKit’s data-hooks documentation](https://docs.livekit.io/deploy/observability/data/)
lists Python `model_usage` entries for LLM, STT, TTS, and other components;
Python durations such as `audio_duration` are in seconds. The deprecated
session-level `metrics_collected` aggregate should not be used as the new
integration contract.

For a Python Agent, the source-level adapter accepts the
`ev.usage.model_usage` snapshot and emits one cumulative usage record per
provider/model component:

```python
from costkey.livekit import record_livekit_usage

@session.on("session_usage_updated")
def on_usage(ev):
    record_livekit_usage(
        ev,
        session_id=session_id,
        revision=next_snapshot_revision(),
        execution_id=execution_id,
        expected_components=("stt", "llm", "tts"),
    )
```

This adapter is source-implemented in the parallel Python SDK worktree; check
the installed package before using it. Supply a monotonic snapshot revision
and stable session/execution identity. The TypeScript source exposes the
equivalent `recordLiveKitUsage` adapter; LiveKit’s Node callback names the list
`ev.usage.modelUsage` (camelCase).

CostKey core does not automatically hook LiveKit callbacks or non-HTTP
transports; the adapter above is an explicit application callback.
The Python harness at `examples/cost-infra/reference_livekit.py` constructs
objects named after LiveKit's concrete usage classes, calls the Python
`record_livekit_usage` adapter, captures the SDK events in an in-memory sink,
and serializes them with CostKey's own transport serializer. The TypeScript
fixture and callback shape are in `examples/cost-infra/reference_livekit.ts`
and are compile-only. Both preserve native units such as tokens, audio-duration
seconds, characters, and request counts. The Python fixture passes declared
`$0.01`/`$0.02`/`$0.03` estimates and pricing IDs, marked as estimates by the
adapter; those values are not provider rates. If no amount or pricing identity
is supplied, it emits no amount and never contacts a provider or CostKey
endpoint.
The harness submits the same revision twice and asserts that the second
cumulative snapshot adds no event, exercising the SDK's local deduplication.
The printed event IDs come from the adapter's canonical `record_usage` calls;
the harness does not add a second caller/event identity.

Run it without credentials or network access:

```bash
python3 examples/cost-infra/reference_livekit.py
```

`recordUsage` / `record_usage` is the source-implemented handoff from this
adapter to CostKey; verify your installed version before calling it. The
adapter supplies the canonical caller-supplied event ID for each
component/revision; an explicit usage event must not rely on a hidden ID.
Until it is released and tested with LiveKit, the output is a fixture, not
proof of live voice coverage. A voice integration must also identify
cumulative versus delta updates, deduplicate charge identity, and surface
missing components. A cumulative update is a full snapshot whose latest
accepted revision supersedes earlier revisions; it must not be summed again.
The integration must not claim complete voice interception.

## Diagnostics

Run diagnostics in this order. Use environment variables for DSNs and auth
keys; never paste them into source, fixtures, logs, or support messages.

### 1. Validate project and DSN

The setup CLI writes the DSN and entrypoint instructions without requiring a
provider migration:

```bash
npx costkey setup
# or
pipx run costkey setup
```

For a running server, the unauthenticated service check is:

```bash
curl -fsS http://localhost:4100/health
```

An SDK-side DSN error names the expected `https://<key>@<host>/<project-id>`
shape. The key is a project telemetry credential, not a provider-spend or
cloud-billing credential.

### 2. Confirm accepted activity

Initialize before the first supported provider call. With debug logging enabled
(`COSTKEY_DEBUG=true` for the preload path), a successful first delivery logs
connection confirmation. A provider call that is still successful in the
application but produces no event is usually one of: an unmatched host, an
unsupported transport, a response shape with no recognized usage, a dropped
`beforeSend` event, or a process that exited before its queue flushed.

### 3. Check context and trace identity

Inspect a trace/call in the authenticated dashboard and verify the context
keys you supplied. Nested contexts merge and concurrent scopes must remain
isolated. Missing business labels leave a call unassigned; they are not a
connection failure. Cross-service joins require the explicit carrier contract
described above and are not assumed from provider brand or HTTP status.

### 4. Check endpoint, transport, and price coverage

Use the [capability matrix](#capability-matrix) and [provider endpoint table](/providers)
to check the exact hostname and response shape. A known usage unit with no
matching price is **unknown**, not zero. Provider-reported amounts and native
units retain their provenance; a telemetry event is not an invoice.

### 5. Check source mapping

If the call is accepted but its source location is bundled/minified, set a
matching release and upload maps from CI:

```bash
npx costkey sourcemaps upload \
  --release "$COSTKEY_RELEASE" \
  --auth-key "$COSTKEY_AUTH_KEY" \
  ./dist/*.map
```

The project attribution-health view distinguishes empty frames, bundled code,
and missing sourcemaps. Adding `withContext` at a route/worker boundary can
preserve semantic context when a runtime cannot provide useful stacks.

### Useful errors and next action

| Symptom | Meaning | Next action |
| --- | --- | --- |
| Invalid DSN / missing project ID | Local configuration could not be parsed | Use a project DSN from the authenticated dashboard; keep it in `COSTKEY_DSN` |
| `401` or `403` on ingest | DSN key does not authorize that project | Rotate/check the project key; do not retry as a provider failure |
| `413` on ingest | Batch/payload exceeds the server limit | Keep body capture disabled for sensitive/large payloads; reduce batch size and inspect bounded captures |
| Accepted call, unknown cost | Usage or a matching price is unavailable | Inspect endpoint response shape; register pricing only when you know the applicable rate; leave unknown as unknown |
| Accepted call, weak source attribution | Stack frames are empty/bundled or maps are absent | Add a boundary context and upload a matching release sourcemap |
| No event from a voice/WebSocket path | No automatic hook covers that transport | Use the source-implemented explicit-usage adapter after verifying package version; do not claim automatic voice coverage |

## Data and performance boundary

Body capture is explicit and can be disabled. `beforeSend` can redact or drop
events before delivery. Diagnostics should display statuses, counts, endpoint
capability, coverage, and targeted next actions—not credentials or captured
bodies. Delivery is best-effort and bounded; profile the real application before
choosing batch/flush settings or enabling enforcement. CostKey’s product claim
is no gateway required, not a promise of no CPU/latency impact, complete
capture, or a global invoice-reconciliation guarantee.

### Local benchmark evidence

The repository includes a loopback-only benchmark at
`packages/sdk/benchmarks/sdk-overhead.mjs`. It guards all requests to local
synthetic provider, ingest, and policy endpoints; it does not call a model
provider or CostKey production. Run it after building the SDK:

```bash
npm run build --workspace=costkey
node packages/sdk/benchmarks/sdk-overhead.mjs --iterations=100 --warmup=20
```

One run on 13 September 2026 used Node 20.19.5 on Darwin arm64. These are
machine-specific timings, not a service-level or marketing guarantee:

| Mode | p50 (ms) | p95 (ms) | Mean (ms) |
| --- | ---: | ---: | ---: |
| Unpatched fetch | 0.243 | 0.524 | 0.290 |
| Metadata-only observation | 0.251 | 0.431 | 0.289 |
| Metadata-only + local policy admission | 0.476 | 1.080 | 0.575 |

Record the machine, Node version, SDK build, iteration count, and load before
comparing another run. The benchmark also checks that policy admission receives
no request body; this test does not prove production capacity, provider
latency, or network behavior.

The parallel Python SDK has the same loopback-only benchmark at
`scripts/benchmark_overhead.py`:

```bash
cd ../costkey-python
python3 scripts/benchmark_overhead.py --iterations=100 --warmup=20 --enforce
```

One run on 13 September 2026 used Python 3.14.5, HTTPX 0.28.1, and macOS
26.5.1 arm64. The script reports microseconds and includes the local admission
path only when `--enforce` is supplied:

| Mode | p50 (µs) | p95 (µs) |
| --- | ---: | ---: |
| Baseline HTTPX | 340.666 | 411.596 |
| Metadata-only observation | 483.375 | 622.923 |
| Metadata-only + enforced admission | 7,699.583 | 12,774.007 |

These measurements use a loopback HTTP provider and synthetic policy/config
responses. They are evidence for this machine and source build only, not a
promise about deployed latency or capacity.
