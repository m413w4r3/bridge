"""Shared fixtures and helpers for the bridge test suite.

Every test here imports `bridge.*` directly (this file puts the package root
on `sys.path`), then builds its own `BridgeApplication()` — the cheap
composition root `server.py` also uses — for per-test isolation. There is no
need to reload `server.py` through `runpy`: `bridge.app`, `bridge.ui`, and
`bridge.generation` are import-cached across tests like any other module, and
`BridgeApplication()` already builds fresh `Bridge`/`RunRegistry`/route
instances each call.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from typing import Any

import pytest
from starlette.requests import Request

sys.path.insert(0, str(Path(__file__).parent.parent))

from bridge.app import BridgeApplication
from bridge.registry import RunRegistry


def final_output_metadata(
    text: str,
    *,
    mode: str = "terminal_action",
    stable_for_ms: int | None = None,
    stable_observations: int | None = None,
    content_script_version: str = "14",
) -> dict[str, Any]:
    """Build metadata matching one of content.js's authoritative final proofs."""
    terminal = mode == "terminal_action"
    signal = "assistant_actions" if terminal else "quiescent_stability"
    confidence = "high" if terminal else "medium"
    stable_for_ms = stable_for_ms if stable_for_ms is not None else (2_100 if terminal else 15_104)
    stable_observations = (
        stable_observations
        if stable_observations is not None
        else (1 if terminal else 111)
    )
    flags = {
        "streaming_visible": False,
        "reasoning_visible": False,
        "stop_visible": False,
        "terminal_action_visible": terminal,
    }
    return {
        "completion_signal": signal,
        "completion_confidence": confidence,
        "stable_for_ms": stable_for_ms,
        "output_chars": len(text),
        "visible_citation_count": 0,
        "serializer_version": "chatgpt-dom-v3",
        "content_script_version": content_script_version,
        "finalization": {
            "finalization_state": "final",
            "mode": mode,
            "signal": signal,
            "confidence": confidence,
            "output_chars": len(text),
            "stable_for_ms": stable_for_ms,
            "stable_observations": stable_observations,
            **flags,
            "response_strategy": "semantic_assistant" if terminal else "markdown_root_delta",
        },
        "finalization_evidence": {
            "mode": mode,
            "signal": signal,
            "stable_for_ms": stable_for_ms,
            "stable_observations": stable_observations,
            "output_chars": len(text),
            "candidate_strategy": "semantic_assistant" if terminal else "markdown_root_delta",
        },
    }


@pytest.fixture
def runtime() -> BridgeApplication:
    return BridgeApplication()


class FakeExtension:
    """Simule l'extension côté WebSocket : répond aux `ui_control`/`ui_state`
    et `prompt` avec un `done` immédiat (ou après `prompt_delay`)."""

    def __init__(self, runtime: BridgeApplication, *, prompt_delay: float = 0) -> None:
        self.runtime = runtime
        self.prompt_delay = prompt_delay
        self.prompt_count = 0
        self.answer_text = "ok"
        self.final_metadata_overrides: dict[str, Any] = {}
        self.omit_external_turn_id = False
        self.stateless_external_turn_id: str | None = None
        self.sent: list[dict[str, Any]] = []
        self.tasks: set[asyncio.Task[None]] = set()
        self.closed: tuple[int, str] | None = None
        # Live session state, by conversation id: last verified external turn.
        # Identity is id + expected_turn_id — never a locator/URL.
        self.turn_ids: dict[str, str] = {}

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)
        task = asyncio.create_task(self._respond(payload))
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)

    async def _respond(self, payload: dict[str, Any]) -> None:
        if payload["type"] in {"ui_control", "ui_state"}:
            await asyncio.sleep(0)
            browser_target = payload.get("browser_target")
            route = (
                {"target_id": browser_target["id"], "tab_id": 1}
                if isinstance(browser_target, dict) and browser_target.get("id")
                else {}
            )
            applied = {}
            if payload["type"] == "ui_control":
                applied = {
                    key: {
                        "requested": value,
                        "applied": value,
                        "verified": True,
                        "ok": True,
                        "changed": False,
                    }
                    for key, value in payload.get("controls", {}).items()
                }
            self.runtime.bridge.dispatch(
                {
                    "type": payload["type"],
                    "id": payload["id"],
                    "applied": applied,
                    "state": {
                        "observed_at": 1,
                        "model": {},
                        "profile": {},
                        "web_search": {},
                    },
                    **route,
                }
            )
        elif payload["type"] == "prompt":
            self.prompt_count += 1
            await asyncio.sleep(self.prompt_delay)
            browser_target = payload.get("browser_target")
            route = (
                {"target_id": browser_target["id"], "tab_id": 1}
                if isinstance(browser_target, dict) and browser_target.get("id")
                else {}
            )
            self.runtime.bridge.dispatch(
                {
                    "type": "heartbeat",
                    "id": payload["id"],
                    "event_id": "1",
                    **route,
                }
            )
            target = payload.get("conversation")
            conversation = None
            if target:
                if target["mode"] == "fresh":
                    if target["id"] in self.turn_ids:
                        self.runtime.bridge.dispatch(
                            {
                                "type": "error",
                                "id": payload["id"],
                                "event_id": "2",
                                "code": "conversation_unavailable",
                                "message": "une session live existe déjà pour cet id",
                            }
                        )
                        return
                elif self.turn_ids.get(target["id"]) != target.get("expected_turn_id"):
                    self.runtime.bridge.dispatch(
                        {
                            "type": "error",
                            "id": payload["id"],
                            "event_id": "2",
                            "code": "conversation_unavailable",
                            "message": "conversation simulée introuvable",
                        }
                    )
                    return
                new_turn_id = f"turn-{self.prompt_count}"
                self.turn_ids[target["id"]] = new_turn_id
                conversation = {
                    "id": target["id"],
                    "turn_id": None if self.omit_external_turn_id else new_turn_id,
                    "mode": target["mode"],
                    "verified": True,
                    "ephemeral": True,
                    # Diagnostic only: every simulated conversation shares this
                    # URL on purpose, to prove routing never depends on it.
                    "external_locator": "https://chatgpt.com/?temporary-chat=true",
                }
            answer = self.answer_text
            metadata = final_output_metadata(answer)
            metadata["initial_turn_id"] = (
                conversation.get("turn_id")
                if conversation
                else self.stateless_external_turn_id
            )
            metadata.update(self.final_metadata_overrides)
            self.runtime.bridge.dispatch(
                {
                    "type": "done",
                    "id": payload["id"],
                    "event_id": "2",
                    "text": answer,
                    "metadata": metadata,
                    "conversation": conversation,
                    **route,
                }
            )

    async def close(self, code: int, reason: str) -> None:
        self.closed = (code, reason)
        for task in tuple(self.tasks):
            task.cancel()
        if self.tasks:
            await asyncio.gather(*self.tasks, return_exceptions=True)


def request_with_key(key: str) -> Request:
    return Request(
        {
            "type": "http",
            "method": "POST",
            "path": "/v1/bridge/runs",
            "headers": [(b"x-idempotency-key", key.encode())],
        }
    )


def isolated_registry(runtime: BridgeApplication, tmp_path: Path) -> None:
    """`DurableRunService` is the single registry owner behind every facade;
    the application keeps its own reference for readiness and shutdown."""
    registry = RunRegistry(tmp_path / "runs.sqlite3")
    runtime.registry = registry
    runtime.run_service.registry = registry
