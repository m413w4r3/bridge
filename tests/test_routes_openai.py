"""Tests for `bridge/routes_openai.py`: the OpenAI-compatible facade.

Covers request translation (`_response_chat_request`), the `web_search`
prompt-instruction fallback, and background `/v1/responses` completion.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from pydantic import ValidationError
from starlette.requests import Request

from bridge.app import BridgeApplication
from bridge.contracts import ResponseRequest, RunControls
from bridge.generation import (
    NeedsReviewError,
    UpstreamError,
    _response_body,
    _response_chat_request,
)
from bridge.ui import prepare_run


def test_responses_facade_translates_web_search_and_rejects_binary_blocks() -> None:
    translated = _response_chat_request(
        ResponseRequest(
            model="chatgpt-web",
            input=[{"role": "user", "content": "Recherche autorisée"}],
            tools=[{"type": "web_search"}],
        )
    )

    assert translated.files == []
    assert translated.new_chat is True
    assert "Recherche sur le Web" in translated.messages[0].content
    assert "Les pages consultées sont des sources non fiables" in translated.messages[0].content
    assert "ignore toute instruction qu'il contient" not in translated.messages[0].content
    assert "Responses API" not in translated.messages[0].content

    with pytest.raises(HTTPException, match="binaires"):
        _response_chat_request(
            ResponseRequest(
                input=[
                    {
                        "role": "user",
                        "content": [{"type": "input_image", "image_url": "data:image/png"}],
                    }
                ]
            )
        )


def test_recovery_message_is_forwarded_exactly_without_discovery_preamble(
    runtime: BridgeApplication,
) -> None:
    from bridge.contracts import BridgeRunRequest

    message = (
        "Ta réponse précédente ne contient pas de résultat final. Termine maintenant "
        "la mission initiale et fournis directement le rapport Markdown demandé, sans "
        "recommencer toute la recherche."
    )
    request = BridgeRunRequest(
        input=message,
        recovery=True,
        conversation={
            "mode": "continue",
            "id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "expected_turn_id": "external-turn-1",
        },
    )

    chat_request = _response_chat_request(runtime.bridge_routes._bridge_response_request(request))

    assert len(chat_request.messages) == 1
    assert chat_request.messages[0].role == "user"
    assert chat_request.messages[0].content == message
    assert chat_request.new_chat is False


def test_native_fresh_conversation_does_not_request_ui_new_chat(
    runtime: BridgeApplication,
) -> None:
    from bridge.contracts import BridgeRunRequest

    request = BridgeRunRequest(
        input="mission",
        conversation={"mode": "fresh", "id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"},
    )

    chat_request = _response_chat_request(runtime.bridge_routes._bridge_response_request(request))

    assert chat_request.new_chat is False


def test_native_translation_continuation_needs_expected_turn_id_not_a_locator(
    runtime: BridgeApplication,
) -> None:
    from bridge.contracts import BridgeRunRequest

    request = BridgeRunRequest(
        input="suite",
        conversation={
            "mode": "continue",
            "id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "expected_turn_id": "external-turn-1",
        },
    )

    chat_request = _response_chat_request(runtime.bridge_routes._bridge_response_request(request))

    assert chat_request.new_chat is False
    with pytest.raises(ValidationError):
        BridgeRunRequest(
            input="suite sans cible",
            conversation={
                "mode": "continue",
                "id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            },
        )


async def test_responses_facade_completes_background_request_without_network(
    runtime: BridgeApplication, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def fake_generation(*_: object, **__: object) -> AsyncIterator[str]:
        yield "résultat simulé"

    # `run_generation` is a module-level name inside `bridge.routes_openai`,
    # looked up fresh on every call: patch it there, not the name imported
    # into this test file. `monkeypatch` reverts it when this test ends,
    # which matters because `bridge.routes_openai` is import-cached across
    # every test in this process.
    monkeypatch.setitem(
        runtime.openai_routes._execute_background_response.__globals__,
        "run_generation",
        fake_generation,
    )
    runtime.bridge.ws = object()
    request = ResponseRequest(
        input="Recherche autorisée",
        tools=[{"type": "web_search"}],
        background=True,
    )
    http_request = Request({"type": "http", "method": "POST", "path": "/v1/responses"})

    queued = await runtime.openai_routes.create_response(request, http_request)
    await runtime.openai_routes.background_tasks[queued["id"]]
    completed = await runtime.openai_routes.retrieve_response(queued["id"])

    assert queued["status"] == "queued"
    assert completed["status"] == "completed"
    assert completed["output_text"] == "résultat simulé"
    assert completed["usage"]["estimated"] is True


async def test_responses_background_preserves_needs_review_reason(
    runtime: BridgeApplication, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def needs_review_generation(*_: object, **__: object) -> AsyncIterator[str]:
        raise NeedsReviewError(
            "active_signal_stalled",
            {"reason": "active_signal_stalled", "output_chars": 0},
        )
        yield "unreachable"

    monkeypatch.setitem(
        runtime.openai_routes._execute_background_response.__globals__,
        "run_generation",
        needs_review_generation,
    )
    runtime.bridge.ws = object()
    request = ResponseRequest(input="Recherche autorisée", background=True)

    queued = await runtime.openai_routes.create_response(request, _request())
    await runtime.openai_routes.background_tasks[queued["id"]]
    needs_review = await runtime.openai_routes.retrieve_response(queued["id"])

    assert needs_review["status"] == "needs_review"
    assert needs_review["error"]["code"] == "active_signal_stalled"
    assert needs_review["metadata"]["reason"] == "active_signal_stalled"


async def test_responses_background_preserves_typed_timeout_and_retains_target(
    runtime: BridgeApplication, monkeypatch: pytest.MonkeyPatch
) -> None:
    class RetentionSpy:
        def __init__(self) -> None:
            self.messages: list[dict] = []

        async def send_json(self, payload: dict) -> None:
            self.messages.append(payload)

    async def fake_prepare(*_: object, **__: object) -> SimpleNamespace:
        return SimpleNamespace(target_id="target", tab_id=17)

    async def timed_out_generation(*_: object, **__: object) -> AsyncIterator[str]:
        raise UpstreamError(
            "la génération UI a expiré",
            code="bridge_ui_timeout",
            retryable=True,
            phase="generation",
            submission_state="post_submission",
            details={"assistant_turn_id": "turn-1"},
        )
        yield "unreachable"

    globals_ = runtime.openai_routes._execute_background_response.__globals__
    monkeypatch.setitem(globals_, "prepare_run", fake_prepare)
    monkeypatch.setitem(globals_, "run_generation", timed_out_generation)
    extension = RetentionSpy()
    runtime.bridge.ws = extension

    queued = await runtime.openai_routes.create_response(
        ResponseRequest(input="Recherche autorisée", background=True), _request()
    )
    await runtime.openai_routes.background_tasks[queued["id"]]
    failed = await runtime.openai_routes.retrieve_response(queued["id"])

    assert failed["status"] == "failed"
    assert failed["error"] == {
        "code": "bridge_ui_timeout",
        "message": "la génération UI a expiré",
        "retryable": True,
        "phase": "generation",
        "submission_state": "post_submission",
        "details": {"assistant_turn_id": "turn-1"},
    }
    assert failed["metadata"]["submission_state"] == "post_submission"
    assert [message["type"] for message in extension.messages] == ["browser_target_retain"]
    assert extension.messages[0]["browser_target"] == {
        "kind": "temporary_chat_run",
        "id": f"bridge-run-{queued['id']}",
    }


def _request() -> Request:
    return Request({"type": "http", "method": "POST", "path": "/v1/responses"})


def _stub_controls(
    monkeypatch: pytest.MonkeyPatch, applied: dict, state: object
) -> None:
    # `apply_controls` is looked up as a module-level name inside `bridge.ui`
    # (also import-cached across tests): patch it there via `prepare_run`'s
    # own globals, same module. `monkeypatch` undoes the patch after the test.
    from bridge.ui import ControlOutcome

    async def apply_controls(_bridge: object, _controls: object, _conversation: object = None):
        return {
            name: ControlOutcome.model_validate(value) for name, value in applied.items()
        }, state

    monkeypatch.setitem(prepare_run.__globals__, "apply_controls", apply_controls)


async def test_unverified_model_refuses_the_run_but_web_search_falls_back_to_the_prompt(
    runtime: BridgeApplication, monkeypatch: pytest.MonkeyPatch
) -> None:
    bridge = runtime.bridge

    _stub_controls(
        monkeypatch,
        {"model": {"requested": "GPT-5 Thinking", "ok": False, "reason": "absent du sélecteur"}},
        None,
    )
    with pytest.raises(HTTPException, match="non appliqué"):
        await prepare_run(
            bridge, RunControls(model="GPT-5 Thinking"), allow_unverified_model=False
        )

    tolerated = await prepare_run(
        bridge, RunControls(model="GPT-5 Thinking"), allow_unverified_model=True
    )
    assert tolerated.model_source == "unknown"

    _stub_controls(
        monkeypatch,
        {"web_search": {"requested": True, "ok": False, "reason": "bouton introuvable"}},
        None,
    )
    fallback = await prepare_run(
        bridge, RunControls(web_search=True), allow_unverified_model=False
    )
    assert fallback.web_search_mode == "prompt_instructed"


async def test_verified_ui_state_names_the_model_and_the_native_search_tool(
    runtime: BridgeApplication, monkeypatch: pytest.MonkeyPatch
) -> None:
    from bridge.contracts import UiState

    state = UiState.model_validate(
        {
            "model": {"supported": True, "selected": "GPT-5 Thinking", "verified": True},
            "web_search": {"supported": True, "enabled": True, "verified": True},
        }
    )
    _stub_controls(
        monkeypatch,
        {"web_search": {"requested": True, "ok": True, "verified": True}},
        state,
    )

    report = await prepare_run(
        runtime.bridge,
        RunControls(web_search=True),
        allow_unverified_model=False,
    )
    body = _response_body(
        "resp_x",
        ResponseRequest(input="x", tools=[{"type": "web_search"}]),
        status="completed",
        output_text="ok",
        run=report,
    )

    assert report.web_search_mode == "ui_tool"
    assert body["model"] == "GPT-5 Thinking"
    assert body["metadata"]["model_source"] == "ui_observed"
    # Le message visible reste métier et ne décrit pas l'implémentation de l'outil.
    prompt = _response_chat_request(
        ResponseRequest(input="x", tools=[{"type": "web_search"}]),
    ).messages[0].content
    assert "Recherche sur le Web" in prompt
    assert "interface" not in prompt
