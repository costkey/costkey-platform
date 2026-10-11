# Experiment and evaluation

Use grouped work for experiments and evaluations; CostKey does not become the
runner or the evaluator. Give the suite a stable name, create a fresh
execution per invocation, and add configuration/variant, dataset revision,
case, and phase only where the harness knows them.

Generation, scoring, retrieval, and an external judge can run in different
services or providers. Propagate the same execution/case identity through a
trusted boundary, and report a later score against the same execution. A new
scheduled invocation must create a new execution. Quality results are inputs
from the customer's evaluator, not scores CostKey should invent.

The lifecycle and explicit-usage helpers required for this recipe are present
in the current workspace source for both SDKs, but package-release and
cross-language acceptance evidence remain separate. Keep the field names and
phase behavior aligned with the installed SDK:

```text
SOURCE IMPLEMENTED — verify installed package exports before running

execution(kind=evaluation, name="search-eval", configuration=variant,
          datasetRevision=revision)
  phase=generation -> trace(caseId=case, provider call)
  phase=scoring    -> trace(caseId=case, external judge call)
  phase=retrieval   -> trace(caseId=case, if instrumented)
  late score/usage -> same execution receipt
```

The receipt must show phase subtotals and coverage. A retry is a subset of its
phase, not an additional total. Unsupported or local judge work remains
missing unless the harness supplies an explicit usage event; no model rate is
assumed here.
