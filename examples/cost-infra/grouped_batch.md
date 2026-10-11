# Grouped batch

Grouped work has two identities:

- a stable group name such as `nightly-document-import`, reused in history;
- a fresh execution identity for each invocation, supplied by the SDK or by the
  scheduler.

The scheduler remains responsible for retries, cancellation, and item
progress. A quiet telemetry queue is not evidence that a batch completed.
Member items should keep their own traces so one failed or expensive item is
inspectable.

Runnable source-contract examples (with the provider call deliberately left as
a stub) are `grouped_batch.ts` and `grouped_batch.py`.

The grouped-execution helper is implemented in the current workspace source
for both SDKs, but may not be in the package version you installed. Verify the
release before running the following source-contract examples:

```text
SOURCE IMPLEMENTED — check installed package version before calling

await CostKey.startExecution(
  {
    name: "nightly-document-import",
    kind: "batch",
    expectedItems: itemCount,
    configuration: { parser: "v2" },
  },
  () => runItems(),
)

with costkey.start_execution(
    name="nightly-document-import",
    kind="batch",
    expected_items=item_count,
    configuration={"parser": "v2"},
):
    await run_items()
```

An execution receipt remains distinct from a trace and distinguishes lifecycle
state from accounting completeness. Delayed or unpriced member usage remains
partial/pending rather than being rendered as zero.
