from __future__ import annotations

import os

import costkey


costkey.init(dsn=os.environ.get("COSTKEY_DSN"), capture_body=False)


async def run_evaluation(
    cases: list[dict[str, str]], variant: str, dataset_revision: str
) -> None:
    with costkey.start_execution(
        name="search-eval",
        kind="evaluation",
        expected_items=len(cases),
        configuration={"variant": variant},
        dataset_revision=dataset_revision,
    ):
        for test_case in cases:
            with costkey.with_context(case_id=test_case["id"], phase="generation"):
                with costkey.start_trace(name="eval.generation"):
                    await existing_generation(test_case["input"])

            with costkey.with_context(case_id=test_case["id"], phase="scoring"):
                with costkey.start_trace(name="eval.scoring"):
                    await existing_judge(test_case)
    costkey.flush()


async def existing_generation(value: str):
    # Replace with the generation provider call. This example makes no request.
    raise RuntimeError(f"Replace existing_generation before running ({len(value)} chars)")


async def existing_judge(test_case: dict[str, str]):
    # Replace with the external judge call, if the harness has one.
    raise RuntimeError(f"Replace existing_judge before running ({test_case['id']})")


# For a non-HTTP component, record_usage is the source-contract escape hatch:
# costkey.record_usage(
#     event_id=f"judge:{test_case['id']}:r1",
#     component_id="external-judge",
#     charge_id=f"judge:{test_case['id']}",
#     revision=1,
#     aggregation="delta",
#     provider="external-judge",
#     usage={"requests": 1},
# )
