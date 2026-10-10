from __future__ import annotations

import os

import costkey


costkey.init(
    dsn=os.environ.get("COSTKEY_DSN"),
    capture_body=False,
    default_context={"environment": "worker", "service": "document-worker"},
)


async def process_item(item_id: str) -> None:
    with costkey.with_context(operation="document.process", item_id=item_id):
        with costkey.start_trace(name="document.process"):
            await existing_document_work(item_id)


async def run_batch(item_ids: list[str]) -> None:
    try:
        for item_id in item_ids:
            await process_item(item_id)
    finally:
        # A worker lifecycle boundary is a good place to drain queued telemetry.
        costkey.flush()


async def existing_document_work(item_id: str) -> None:
    # Replace this with the provider calls already made by the worker.
    # This example intentionally does not make a paid request.
    raise RuntimeError(f"Replace existing_document_work before running ({item_id})")

