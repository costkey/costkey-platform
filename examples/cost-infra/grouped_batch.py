from __future__ import annotations

import os

import costkey


costkey.init(
    dsn=os.environ.get("COSTKEY_DSN"),
    capture_body=False,
    default_context={"environment": "worker", "service": "document-worker"},
)


async def run_nightly_import(item_ids: list[str]) -> None:
    try:
        with costkey.start_execution(
            name="nightly-document-import",
            kind="batch",
            expected_items=len(item_ids),
            configuration={"parser": "v2"},
        ):
            for item_id in item_ids:
                with costkey.with_context(operation="document.process", item_id=item_id):
                    with costkey.start_trace(name="document.process"):
                        await existing_document_work(item_id)
    finally:
        costkey.flush()


async def existing_document_work(item_id: str) -> None:
    # Replace with the existing provider calls. This example makes no request.
    raise RuntimeError(f"Replace existing_document_work before running ({item_id})")
