"""Run the LiveKit usage adapter against a local, credential-free fixture.

LiveKit's Python Agents data hook exposes a cumulative
``event.usage.model_usage`` list. This harness constructs that object shape,
passes it to CostKey's Python ``record_livekit_usage`` adapter, and captures
the resulting SDK events in memory.

No LiveKit room, provider, CostKey endpoint, or model request is started. When
``livekit-agents`` is installed, the fixture uses its concrete
``SessionUsageUpdatedEvent``/``AgentSessionUsage``/``*ModelUsage`` classes. In
the normal lightweight checkout it uses explicitly named local stand-ins with
the same fields, so the recipe remains runnable without that optional package.
The printed envelopes are serialized by CostKey's own transport serializer,
not hand-authored telemetry. Amounts below are declared fixture estimates,
not provider rates or invoice reconciliation.
"""

from __future__ import annotations

import json
import os
import sys
from collections.abc import Mapping
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Iterator


LOCAL_SESSION_USAGE: dict[str, Any] = {
    "session_id": "local-session-001",
    "execution_id": "local-execution-001",
    "group_name": "voice-support",
    "revision": 1,
    "timestamp": "2026-09-13T09:00:00Z",
    "model_usage": [
        {
            "type": "llm_usage",
            "provider": "openai",
            "model": "gpt-4o",
            "input_tokens": 20,
            "output_tokens": 5,
        },
        {
            "type": "stt_usage",
            "provider": "deepgram",
            "model": "nova-3",
            "input_tokens": 20,
            "output_tokens": 4,
            "audio_duration": 1.25,
        },
        {
            "type": "tts_usage",
            "provider": "elevenlabs",
            "model": "turbo",
            "audio_duration": 2.0,
            "characters_count": 30,
        },
    ],
}

DECLARED_AMOUNTS: dict[str, dict[str, Any]] = {
    "stt:deepgram:nova-3": {"value": 0.01, "currency": "USD"},
    "llm:openai:gpt-4o": {"value": 0.02, "currency": "USD"},
    "tts:elevenlabs:turbo": {"value": 0.03, "currency": "USD"},
}

DECLARED_PRICING_IDS = {
    "stt:deepgram:nova-3": "fixture:deepgram",
    "llm:openai:gpt-4o": "fixture:openai",
    "tts:elevenlabs:turbo": "fixture:elevenlabs",
}


class LLMModelUsage(SimpleNamespace):
    """Fallback stand-in with LiveKit's concrete class name and fields."""


class STTModelUsage(SimpleNamespace):
    """Fallback stand-in with LiveKit's concrete class name and fields."""


class TTSModelUsage(SimpleNamespace):
    """Fallback stand-in with LiveKit's concrete class name and fields."""


def _load_livekit_classes() -> tuple[Any, Any, Any, Any, Any, str]:
    """Use real LiveKit classes when available; otherwise use local stand-ins."""

    try:
        from livekit.agents import SessionUsageUpdatedEvent
        from livekit.agents.metrics import (
            AgentSessionUsage,
            LLMModelUsage as LiveKitLLMModelUsage,
            STTModelUsage as LiveKitSTTModelUsage,
            TTSModelUsage as LiveKitTTSModelUsage,
        )
    except ImportError:
        return (
            SimpleNamespace,
            SimpleNamespace,
            LLMModelUsage,
            STTModelUsage,
            TTSModelUsage,
            "local class-shaped fallback",
        )

    return (
        SessionUsageUpdatedEvent,
        AgentSessionUsage,
        LiveKitLLMModelUsage,
        LiveKitSTTModelUsage,
        LiveKitTTSModelUsage,
        "livekit-agents classes",
    )


def local_livekit_event(snapshot: Mapping[str, Any]) -> tuple[Any, str]:
    """Construct the object shape delivered as ``event.usage.model_usage``."""

    event_class, usage_class, llm_class, stt_class, tts_class, source = _load_livekit_classes()
    entries = snapshot.get("model_usage", [])
    if not isinstance(entries, list):
        raise ValueError("model_usage must be a list")

    row_classes = {
        "llm_usage": llm_class,
        "stt_usage": stt_class,
        "tts_usage": tts_class,
    }
    usage_rows = []
    for entry in entries:
        if not isinstance(entry, Mapping):
            raise ValueError("each model_usage entry must be an object")
        row_class = row_classes.get(str(entry.get("type", "llm_usage")), llm_class)
        values = {key: value for key, value in entry.items() if key != "type"}
        row = row_class(**values)
        if source == "local class-shaped fallback":
            row.type = str(entry.get("type", "llm_usage"))
        usage_rows.append(row)

    # The real event class receives AgentSessionUsage(model_usage=[...]); the
    # fallback uses equivalent attributes and is still accepted by the SDK
    # adapter's structural parser.
    usage = usage_class(model_usage=usage_rows)
    if event_class is SimpleNamespace:
        return (
            SimpleNamespace(
                session_id=str(snapshot.get("session_id", "local-session")),
                usage=usage,
            ),
            source,
        )
    return event_class(usage=usage), source


class LocalTransport:
    """In-memory sink used instead of CostKey's network transport."""

    def __init__(self) -> None:
        self.events: list[Any] = []

    def enqueue(self, event: Any) -> None:
        self.events.append(event)


def _load_sdk() -> tuple[Any, Any, Any, Any]:
    """Load the Python SDK source used by this workspace without publishing it."""

    default_root = Path(__file__).resolve().parents[2].parent / "costkey-python"
    sdk_root = Path(os.environ.get("COSTKEY_PYTHON_ROOT", str(default_root)))
    if not sdk_root.is_dir():
        raise RuntimeError(
            f"CostKey Python source not found at {sdk_root}; "
            "set COSTKEY_PYTHON_ROOT to a checkout that exports costkey.livekit"
        )
    root_text = str(sdk_root)
    if root_text not in sys.path:
        sys.path.insert(0, root_text)

    import costkey.client as client
    import costkey.livekit as livekit
    import costkey.patch as patch
    import costkey.transport as transport

    return client, livekit, patch, transport


@contextmanager
def local_sdk_sink(patch: Any, client: Any) -> Iterator[LocalTransport]:
    """Install a temporary in-memory sink without calling ``costkey.init``."""

    state = patch._state
    saved = {
        "transport": state.transport,
        "project_id": state.project_id,
        "before_send": state.before_send,
        "before_send_event": state.before_send_event,
        "debug": state.debug,
        "admission": state.admission,
        "admission_mode": state.admission_mode,
    }
    sink = LocalTransport()
    state.transport = sink
    state.project_id = "local-project"
    state.before_send = None
    state.before_send_event = None
    state.debug = False
    state.admission = None
    state.admission_mode = "monitor"
    try:
        yield sink
    finally:
        for key, value in saved.items():
            setattr(state, key, value)
        with client._usage_lock:
            client._usage_updates.clear()
            client._usage_modes.clear()
            client._usage_event_ids.clear()


def run_local_adapter(snapshot: Mapping[str, Any]) -> dict[str, Any]:
    client, livekit, patch, transport_module = _load_sdk()
    update, shape_source = local_livekit_event(snapshot)
    revision = int(snapshot.get("revision", 1))
    with local_sdk_sink(patch, client) as sink:
        kwargs = {
            "revision": revision,
            "session_id": str(snapshot.get("session_id", "local-session")),
            "execution_id": snapshot.get("execution_id"),
            "expected_components": ("stt", "llm", "tts"),
            "declared_amounts": DECLARED_AMOUNTS,
            "declared_pricing_ids": DECLARED_PRICING_IDS,
        }
        recorded_ids = livekit.record_livekit_usage(update, **kwargs)
        duplicate_ids = livekit.record_livekit_usage(update, **kwargs)
        if duplicate_ids != recorded_ids or len(sink.events) != len(recorded_ids):
            raise AssertionError("duplicate cumulative snapshot was not suppressed")

        serializer = transport_module.Transport(
            "https://local.invalid/api/v1/events", "local-only", 50, 5, False
        )
        serialized_events = [serializer._serialize(event) for event in sink.events]

    return {
        "amounts": "declared local fixture estimates; not provider rates",
        "duplicateSuppressed": True,
        "network": "none",
        "shapeSource": shape_source,
        "recordedIds": recorded_ids,
        "events": serialized_events,
    }


def main() -> None:
    snapshot: Mapping[str, Any] = LOCAL_SESSION_USAGE
    if len(sys.argv) > 1:
        with open(sys.argv[1], encoding="utf-8") as source:
            loaded = json.load(source)
        if not isinstance(loaded, Mapping):
            raise SystemExit("snapshot must be a JSON object")
        snapshot = loaded

    print(json.dumps(run_local_adapter(snapshot), indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
