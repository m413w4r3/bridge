"""Focused coverage for the shared durable run engine."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

from starlette.requests import Request

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
