from __future__ import annotations

import os

import costkey


# Keep the DSN in the process environment. Do not put it in source control.
costkey.init(
    dsn=os.environ.get("COSTKEY_DSN"),
    capture_body=False,
    default_context={
        "environment": "production",
        "service": "search-api",
    },
)


async def handle_search(query: str, customer_id: str) -> dict[str, str]:
    with costkey.with_context(feature="search", customer=customer_id):
        with costkey.start_trace(name="POST /search"):
            return await existing_search(query)


async def existing_search(query: str) -> dict[str, str]:
    # Replace this function with your existing provider client call.
    # This example intentionally does not make a paid request.
    raise RuntimeError(f"Replace existing_search before running ({len(query)} chars)")

