"""Focused coverage for the shared durable run engine."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

from starlette.requests import Request
from fastapi.testclient import TestClient

from conftest import FakeExtension, isolated_registry
from bridge.app import BridgeApplication
from bridge.contracts import ChatRequest, ResponseRequest, RunControls, RunReport
from bridge.registry import RunRegistry
from bridge.run_service import DurableRunSpec


def _request(path: str, **headers: str) -> Request:
    return Request(
        {
            "type": "http",
            "method": "POST",
            "path": path,
            "headers": [(name.lower().encode(), value.encode()) for name, value in headers.items()],
        }
    )


async def test_responses_background_is_idempotent_and_survives_reconstruction(
    runtime: BridgeApplication, tmp_path, monkeypatch
) -> None:
    isolated_registry(runtime, tmp_path)
    runtime.bridge.ws = FakeExtension(runtime)

    calls = 0

    async def fake_prepare(*args, **kwargs):
        return RunReport()

    async def fake_generation(*args, **kwargs):
        nonlocal calls
        calls += 1
        yield "durable response"

    monkeypatch.setattr("bridge.run_service.prepare_run", fake_prepare)
    monkeypatch.setattr("bridge.run_service.run_generation", fake_generation)
    req = ResponseRequest(input="hello", background=True)

    first = await runtime.openai_routes.create_response(
        req, _request("/v1/responses", **{"X-Idempotency-Key": "responses-once"})
    )
    duplicate = await runtime.openai_routes.create_response(
        req, _request("/v1/responses", **{"X-Idempotency-Key": "responses-once"})
    )
    assert duplicate["id"] == first["id"]
    await runtime.run_service.task_map[first["id"]]
    assert calls == 1

    replacement = BridgeApplication(registry=RunRegistry(tmp_path / "runs.sqlite3"))
    recovered = await replacement.openai_routes.retrieve_response(first["id"])
    assert recovered["status"] == "completed"
    assert recovered["output_text"] == "durable response"


async def test_chat_completions_uses_the_same_durable_service(
    runtime: BridgeApplication, tmp_path, monkeypatch
) -> None:
    isolated_registry(runtime, tmp_path)
    runtime.bridge.ws = FakeExtension(runtime)

    async def fake_prepare(*args, **kwargs):
        return RunReport()

    async def fake_generation(*args, **kwargs):
        yield "chat result"

    monkeypatch.setattr("bridge.run_service.prepare_run", fake_prepare)
    monkeypatch.setattr("bridge.run_service.run_generation", fake_generation)
    response = await runtime.openai_routes.chat_completions(
        ChatRequest(model="client-label", messages=[{"role": "user", "content": "hi"}]),
        _request("/v1/chat/completions", **{"X-Idempotency-Key": "chat-once"}),
    )
    assert response["model"] == "client-label"
    assert response["choices"][0]["message"]["content"] == "chat result"
    assert runtime.registry.get_by_idempotency_key("chat-once")["state"] == "completed"


def test_stateless_chat_final_without_external_turn_id_is_http_success_and_idempotent(
    runtime: BridgeApplication, tmp_path, monkeypatch
) -> None:
    monkeypatch.setattr("bridge.app.API_KEY", None)
    isolated_registry(runtime, tmp_path)
    extension = FakeExtension(runtime)
    extension.answer_text = "BRIDGE_OK"
    extension.final_metadata_overrides = {
        "completion_signal": "quiescent_stability",
        "completion_confidence": "medium",
        "stable_for_ms": 15_104,
        "serializer_version": "chatgpt-dom-v3",
        "finalization": {
            "finalization_state": "final",
            "mode": "quiescent_stability",
            "signal": "quiescent_stability",
            "confidence": "medium",
            "output_chars": 9,
            "stable_for_ms": 15_104,
            "stable_observations": 111,
            "streaming_visible": False,
            "reasoning_visible": False,
            "stop_visible": False,
            "terminal_action_visible": False,
            "response_strategy": "markdown_root_delta",
        },
        "finalization_evidence": {
            "mode": "quiescent_stability",
            "signal": "quiescent_stability",
            "stable_for_ms": 15_104,
            "stable_observations": 111,
            "output_chars": 9,
            "candidate_strategy": "markdown_root_delta",
        },
    }
    runtime.bridge.ws = extension
    request = {
        "model": "chatgpt-web",
        "messages": [{"role": "user", "content": "Reply with exactly: BRIDGE_OK"}],
    }

    with TestClient(runtime.app) as client:
        first = client.post(
            "/v1/chat/completions",
            json=request,
            headers={"X-Idempotency-Key": "stateless-final-without-turn-id"},
        )
        second = client.post(
            "/v1/chat/completions",
            json=request,
            headers={"X-Idempotency-Key": "stateless-final-without-turn-id"},
        )
        record = runtime.registry.get_by_idempotency_key(
            "stateless-final-without-turn-id"
        )

    assert first.status_code == 200
    assert second.status_code == 200
    assert first.json() == second.json()
    body = first.json()
    assert body["choices"][0]["message"]["content"] == "BRIDGE_OK"
    assert body["metadata"]["external_turn_id"] is None
    assert body["metadata"]["external_turn_id_verified"] is False
    assert body["metadata"]["continuation_available"] is False
    assert body["metadata"]["completion_signal"] == "quiescent_stability"
    assert body["metadata"]["completion_confidence"] == "medium"
    assert body["metadata"]["serializer_version"] == "chatgpt-dom-v3"
    assert body["metadata"]["finalization"]["finalization_state"] == "final"
    assert body["metadata"]["finalization_evidence"]["mode"] == "quiescent_stability"
    assert record["state"] == "completed"
    assert extension.prompt_count == 1


async def test_chat_stream_is_final_delta_only_and_transport_independent(
    runtime: BridgeApplication, tmp_path, monkeypatch
) -> None:
    isolated_registry(runtime, tmp_path)
    runtime.bridge.ws = FakeExtension(runtime)

    async def fake_prepare(*args, **kwargs):
        return RunReport()

    async def fake_generation(*args, **kwargs):
        yield "one final answer"

    monkeypatch.setattr("bridge.run_service.prepare_run", fake_prepare)
    monkeypatch.setattr("bridge.run_service.run_generation", fake_generation)
    response = await runtime.openai_routes.chat_completions(
        ChatRequest(
            model="label-only",
            messages=[{"role": "user", "content": "hi"}],
            stream=True,
        ),
        _request("/v1/chat/completions"),
    )
    chunks = [chunk async for chunk in response.body_iterator]
    rendered = "".join(chunks)
    assert rendered.count('"content": "one final answer"') == 1
    assert rendered.endswith("data: [DONE]\n\n")


async def test_response_model_label_never_becomes_a_ui_control(
    runtime: BridgeApplication, tmp_path, monkeypatch
) -> None:
    isolated_registry(runtime, tmp_path)
    runtime.bridge.ws = FakeExtension(runtime)
    seen: list[RunControls] = []

    async def fake_prepare(_bridge, controls, **kwargs):
        seen.append(controls)
        return RunReport()

    async def fake_generation(*args, **kwargs):
        yield "ok"

    monkeypatch.setattr("bridge.run_service.prepare_run", fake_prepare)
    monkeypatch.setattr("bridge.run_service.run_generation", fake_generation)
    await runtime.openai_routes.create_response(
        ResponseRequest(model="foo", input="hello"), _request("/v1/responses")
    )
    await runtime.openai_routes.create_response(
        ResponseRequest(model="foo", bridge_ui_model="GPT-5 Thinking", input="hello"),
        _request("/v1/responses"),
    )
    assert seen[0].model is None
    assert seen[1].model == "GPT-5 Thinking"
