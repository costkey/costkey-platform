# CostKey DX10 examples

These examples show where CostKey context belongs in a real application. They
contain no provider credentials and make no provider requests. Replace the
`existing_*` functions with the provider client that already belongs to your
application.

CostKey observes supported provider traffic in-process. It does not require a
model gateway or an extra provider-routing hop. The transport and endpoint
boundary still matter: see the [capability matrix](../../docs-site/docs/recipes.md#capability-matrix)
before assuming that a provider or voice framework is covered.

## Status

- **Verified now:** `CostKey.init`, `CostKey.withContext`,
  `CostKey.startTrace`, `CostKey.flush`, and `CostKey.shutdown` in the
  TypeScript SDK; the equivalent context-manager APIs in the Python SDK.
- **Source implemented — release caveat:** grouped executions, explicit usage
  reporting, and a cross-process context carrier are present in the current
  TypeScript source and the parallel Python SDK worktree. Verify your installed
  npm/PyPI version before using them; the examples are not proof of a package
  release or acceptance run.
- **Reference voice adapter:** `reference_livekit.ts` and `reference_livekit.py` construct local objects
  with LiveKit's `session.usage.modelUsage` / `model_usage` shape. The TS
  adapter uses `recordLiveKitUsage`; the Python adapter uses its equivalent.
  Local tests assert native units, deterministic duplicate-row
  grouping, full-snapshot coverage, explicit component selection, and no
  auto-capture double count. Neither recipe calls LiveKit, a model provider,
  or a CostKey endpoint.

## Verification level

- **Executed integration:** `reference_livekit.py` invokes the Python adapter
  with the sibling SDK source, an in-memory transport, declared fixture
  estimates, and duplicate-snapshot assertions. It never performs network I/O.
- **Compile-only/illustrative:** `reference_livekit.ts` defines the structural
  Node callback and fixture but does not start a LiveKit session. The HTTP,
  background, grouped-batch, and experiment/eval files leave the provider
  function as a stub; their checks establish syntax/types, not provider or
  CostKey delivery proof.
- **Contract notes:** the `.md` files describe source/release boundaries and
  are not executable recipes.

## Recipes

| Recipe | Files | What it demonstrates |
| --- | --- | --- |
| HTTP request | [`http_request.ts`](http_request.ts), [`http_request.py`](http_request.py) | One request trace plus business context |
| Background worker | [`background_worker.ts`](background_worker.ts), [`background_worker.py`](background_worker.py) | Per-item traces and an explicit lifecycle flush |
| Mixed Python/TypeScript | [`mixed_python_typescript.md`](mixed_python_typescript.md) | Explicit carrier and trusted handoff |
| Grouped batch | [`grouped_batch.md`](grouped_batch.md), [`grouped_batch.ts`](grouped_batch.ts), [`grouped_batch.py`](grouped_batch.py) | Stable group versus fresh execution identity |
| Experiment/eval | [`experiment_eval.md`](experiment_eval.md), [`experiment_eval.ts`](experiment_eval.ts), [`experiment_eval.py`](experiment_eval.py) | Generation/scoring phases and late usage |
| LiveKit reference | [`reference_livekit.ts`](reference_livekit.ts), [`reference_livekit.py`](reference_livekit.py) | Native STT/LLM/TTS usage units without double-counting snapshots |

To inspect the voice adapter locally:

```bash
python3 examples/cost-infra/reference_livekit.py
python3 examples/cost-infra/reference_livekit.py \
  examples/cost-infra/fixtures/livekit-session-usage.json
```

The command prints the SDK-serialized local JSON events and performs no network
I/O. It declares `$0.01`, `$0.02`, and `$0.03` fixture estimates with explicit
pricing IDs so known-cost plumbing is visible; these are not provider rates or
invoice reconciliation. Remove a declaration in the script to exercise an
unknown amount—CostKey must not invent a model rate.
