"""Tests for `bridge/routes_bridge.py`: native runs, idempotency, conversation
binding, model/UI controls, capabilities, and recovery.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from pathlib import Path
from typing import Any

import pytest
from conftest import FakeExtension, isolated_registry, request_with_key
from fastapi import HTTPException
from pydantic import ValidationError

from bridge.app import BridgeApplication
from bridge.contracts import BridgeRunRequest
from bridge.generation import _response_chat_request
from bridge.registry import RunRegistry


def test_native_bridge_contract_reports_honest_capabilities(runtime: BridgeApplication) -> None:
    request = BridgeRunRequest(
        requested_model="premium-profile",
        input="Recherche autorisée",
        web_search=True,
        reasoning_effort="high",
        background=True,
    )

    translated = runtime.bridge_routes._bridge_response_request(request)

    assert translated.model == "premium-profile"
    assert translated.tools == [{"type": "web_search"}]
    assert translated.background is True


def test_conversation_contract_is_explicit_and_rejects_arbitrary_navigation(
    runtime: BridgeApplication,
) -> None:
    conversation_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    fresh = BridgeRunRequest(
        input="A1",
        conversation={"mode": "fresh", "id": conversation_id},
    )
    continued = BridgeRunRequest(
        input="A2",
        conversation={
            "mode": "continue",
            "id": conversation_id,
            "expected_turn_id": "external-turn-1",
        },
    )

    assert not _response_chat_request(
        runtime.bridge_routes._bridge_response_request(fresh)
    ).new_chat
    assert not _response_chat_request(
        runtime.bridge_routes._bridge_response_request(continued)
    ).new_chat
    # fresh forbids a pre-existing expected_turn_id.
    with pytest.raises(ValidationError):
        BridgeRunRequest(
            input="fresh avec cible",
            conversation={
                "mode": "fresh",
                "id": conversation_id,
                "expected_turn_id": "external-turn-1",
            },
        )
    with pytest.raises(ValidationError):
        BridgeRunRequest(
            input="continuation sans cible",
            conversation={"mode": "continue", "id": conversation_id},
        )
    # external_locator is not a routing field at all: any input under that key
    # is rejected as an unexpected extra field, not silently accepted.
    with pytest.raises(ValidationError):
        BridgeRunRequest(
            input="locator arbitraire",
            conversation={
                "mode": "continue",
                "id": conversation_id,
                "expected_turn_id": "external-turn-1",
                "external_locator": "https://example.org/internal",
            },
        )


def test_requested_model_is_a_label_and_only_ui_model_drives_the_interface(
    runtime: BridgeApplication,
) -> None:
    bridge_controls = runtime.bridge_routes._bridge_controls

    label = bridge_controls(BridgeRunRequest(requested_model="premium-profile", input="x"))
    driving = bridge_controls(
        BridgeRunRequest(requested_model="premium-profile", ui_model="GPT-5 Thinking", input="x")
    )
    neutral = bridge_controls(BridgeRunRequest(ui_model="chatgpt-web", input="x"))

    assert label.model is None
    assert driving.model == "GPT-5 Thinking"
    assert neutral.model is None
    # `web_search=False` est une exigence, pas une absence : le bridge doit
    # désactiver un outil resté actif dans l'interface.
    assert label.web_search is False


async def test_fake_extension_routes_a_b_a_and_retry_clicks_once(
    runtime: BridgeApplication, tmp_path: Path
) -> None:
    isolated_registry(runtime, tmp_path)
    extension = FakeExtension(runtime)
    runtime.bridge.ws = extension
    conversation_a = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    conversation_b = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

    async def send(key: str, conversation: dict[str, object]) -> dict[str, Any]:
        result = await runtime.bridge_routes.create_bridge_run(
            BridgeRunRequest(input=key, conversation=conversation),
            request_with_key(key),
        )
        assert isinstance(result, dict)
        return result

    a1 = await send("a1", {"mode": "fresh", "id": conversation_a})
    b1 = await send("b1", {"mode": "fresh", "id": conversation_b})
    a2_target = {
        "mode": "continue",
        "id": conversation_a,
        "expected_turn_id": a1["metadata"]["conversation"]["turn_id"],
    }
    a2 = await send("a2", a2_target)
    replay = await send("a2", a2_target)

    assert a2["metadata"]["conversation"]["id"] == conversation_a
    # A/B/A routing is by id + expected_turn_id, never by a locator: both
    # simulated conversations may legitimately share the same diagnostic URL.
    assert (
        a2["metadata"]["conversation"]["external_locator"]
        == b1["metadata"]["conversation"]["external_locator"]
    )
    assert a1["metadata"]["conversation"]["turn_id"] != b1["metadata"]["conversation"]["turn_id"]
    assert replay == a2
    assert extension.prompt_count == 3


async def test_three_http_retries_with_same_key_submit_one_prompt_and_replay_result(
    runtime: BridgeApplication, tmp_path: Path
) -> None:
    isolated_registry(runtime, tmp_path)
    extension = FakeExtension(runtime, prompt_delay=0.02)
    runtime.bridge.ws = extension
    req = BridgeRunRequest(input="secret prompt")

    first, second, third = await asyncio.gather(
        runtime.bridge_routes.create_bridge_run(req, request_with_key("business-1")),
        runtime.bridge_routes.create_bridge_run(req, request_with_key("business-1")),
        runtime.bridge_routes.create_bridge_run(req, request_with_key("business-1")),
    )
    replay = await runtime.bridge_routes.create_bridge_run(req, request_with_key("business-1"))

    assert first["id"] == second["id"] == third["id"] == replay["id"]
    assert extension.prompt_count == 1
    assert first["metadata"]["completion_signal"] == "assistant_actions"
    assert first["metadata"]["completion_confidence"] == "high"
    assert first["metadata"]["stable_for_ms"] == 2_100
    assert first["metadata"]["output_chars"] == 2
    assert first["metadata"]["visible_citation_count"] == 0
    assert first["metadata"]["content_script_version"] == "14"


async def test_background_bridge_run_returns_immediately_and_is_polled_to_completion(
    runtime: BridgeApplication, tmp_path: Path
) -> None:
    isolated_registry(runtime, tmp_path)
    generation_started = asyncio.Event()
    release_generation = asyncio.Event()

    class ControlledExtension(FakeExtension):
        async def _respond(self, payload: dict[str, Any]) -> None:
            if payload["type"] != "prompt":
                await super()._respond(payload)
                return
            self.prompt_count += 1
            generation_started.set()
            await release_generation.wait()
            browser_target = payload.get("browser_target")
            self.runtime.bridge.dispatch(
                {
                    "type": "done",
                    "id": payload["id"],
                    "event_id": "1",
                    "text": "snapshot final unique",
                    "metadata": {
                        "completion_signal": "assistant_actions",
                        "completion_confidence": "high",
                        "stable_for_ms": 2_100,
                        "output_chars": 21,
                        "visible_citation_count": 0,
                        "content_script_version": "14",
                    },
                    "target_id": browser_target["id"],
                    "tab_id": 1,
                }
            )

    extension = ControlledExtension(runtime)
    runtime.bridge.ws = extension
    request = BridgeRunRequest(input="durable", background=True)

    create_bridge_run = runtime.bridge_routes.create_bridge_run
    accepted = await create_bridge_run(request, request_with_key("durable-background"))
    replay = await create_bridge_run(request, request_with_key("durable-background"))
    await generation_started.wait()
    running = await runtime.bridge_routes.retrieve_bridge_run(accepted["id"])
    running_by_request_key = await runtime.bridge_routes.retrieve_bridge_run(
        "durable-background"
    )

    assert accepted["status"] in {"queued", "running"}
    assert replay["id"] == accepted["id"]
    assert running["status"] == "running"
    assert running_by_request_key["id"] == accepted["id"]
    assert running_by_request_key["status"] == "running"
    assert extension.prompt_count == 1

    release_generation.set()
    await runtime.bridge_routes.idempotent_tasks[accepted["id"]]
    completed = await runtime.bridge_routes.retrieve_bridge_run(accepted["id"])

    assert completed["status"] == "completed"
    assert completed["output_text"] == "snapshot final unique"
    assert extension.prompt_count == 1


async def test_active_signal_stalled_incomplete_is_native_needs_review(
    runtime: BridgeApplication, tmp_path: Path
) -> None:
    isolated_registry(runtime, tmp_path)

    class StalledExtension(FakeExtension):
        async def _respond(self, payload: dict[str, Any]) -> None:
            if payload["type"] != "prompt":
                await super()._respond(payload)
                return
            self.prompt_count += 1
            browser_target = payload.get("browser_target")
            route = (
                {"target_id": browser_target["id"], "tab_id": 1}
                if isinstance(browser_target, dict)
                else {}
            )
            self.runtime.bridge.dispatch(
                {
                    "type": "incomplete",
                    "id": payload["id"],
                    "event_id": "stalled",
                    "reason": "active_signal_stalled",
                    "metadata": {"completion_signal": "streaming", "output_chars": 0},
                    **route,
                }
            )

    extension = StalledExtension(runtime)
    runtime.bridge.ws = extension

    result = await runtime.bridge_routes.create_bridge_run(
        BridgeRunRequest(input="mission"), request_with_key("active-signal-stalled")
    )

    assert result["status"] == "needs_review"
    assert result["error"]["code"] == "active_signal_stalled"
    assert result["metadata"]["reason"] == "active_signal_stalled"
    assert extension.prompt_count == 1


def _stalled_extension(
    runtime: BridgeApplication, *, text: str, turn_id: str | None
) -> type[FakeExtension]:
    """Reproduit l'incident : réponse visible, UI qui se dit encore en streaming."""

    class StalledWithVisibleAnswer(FakeExtension):
        async def _respond(self, payload: dict[str, Any]) -> None:
            if payload["type"] != "prompt":
                await super()._respond(payload)
                return
            self.prompt_count += 1
            browser_target = payload.get("browser_target")
            route = (
                {"target_id": browser_target["id"], "tab_id": 1}
                if isinstance(browser_target, dict)
                else {}
            )
            self.runtime.bridge.dispatch(
                {
                    "type": "incomplete",
                    "id": payload["id"],
                    "event_id": "stalled",
                    "reason": "active_signal_stalled",
                    "text": text,
                    "submission_state": "post_submission",
                    "metadata": {
                        "completion_signal": "streaming",
                        "completion_confidence": "high",
                        "stable_for_ms": 300_000,
                        "output_chars": len(text),
                        "initial_turn_id": turn_id,
                        "serializer_version": "chatgpt-dom-v3",
                        "content_script_version": "27",
                        "visible_citations": [],
                        "streaming_signal_sources": [
                            {
                                "source": ".result-streaming",
                                "visible": True,
                                "data_is_streaming": None,
                                "aria_hidden": None,
                                "data_state": None,
                            }
                        ],
                    },
                    **route,
                }
            )

    return StalledWithVisibleAnswer


async def test_visible_answer_survives_active_signal_stall_and_lost_tab(
    runtime: BridgeApplication, tmp_path: Path
) -> None:
    """L'incident réel : la réponse était à l'écran, le run disait output_chars=0.

    Le candidat doit être compté, persisté avant le needs_review, et rester
    lisible une fois l'onglet ChatGPT (et l'extension) disparus.
    """
    isolated_registry(runtime, tmp_path)
    answer = "## SUBJECT S1\ntitle: Réponse visible mais jamais conclue\n"
    extension = _stalled_extension(runtime, text=answer, turn_id="assistant-42")(runtime)
    runtime.bridge.ws = extension

    result = await runtime.bridge_routes.create_bridge_run(
        BridgeRunRequest(input="mission"), request_with_key("stalled-visible")
    )

    assert result["status"] == "needs_review"
    assert result["error"]["code"] == "active_signal_stalled"
    assert result["error"]["details"]["output_chars"] == len(answer)
    assert result["metadata"]["output_chars"] == len(answer)
    assert result["metadata"]["candidate_output_present"] is True
    assert result["metadata"]["recovery_preview_available"] is True
    assert result["metadata"]["completion_signal"] == "streaming"
    assert result["metadata"]["streaming_signal_sources"] == [
        {
            "source": ".result-streaming",
            "visible": True,
            "data_is_streaming": None,
            "aria_hidden": None,
            "data_state": None,
        }
    ]
    # Le texte lui-même n'entre jamais dans les métadonnées d'erreur.
    assert answer not in json.dumps(result, ensure_ascii=False)

    run_id = result["id"]
    stored = runtime.bridge_routes.registry.get_by_run_id(run_id)
    assert stored is not None
    persisted = json.loads(stored["preview_json"])
    assert persisted["provenance"] == "captured_incomplete"
    assert persisted["text"] == answer

    # L'onglet ChatGPT est fermé et l'extension déconnectée : aucun aller-retour
    # DOM n'est possible, et le candidat doit pourtant rester récupérable.
    runtime.bridge.ws = None
    preview = await runtime.bridge_routes.preview_visible_recovery(run_id)
    repeated = await runtime.bridge_routes.preview_visible_recovery(run_id)

    assert preview == repeated
    assert preview["text"] == answer
    assert preview["turn_id"] == "assistant-42"
    assert preview["metadata"]["output_chars"] == len(answer)
    assert preview["metadata"]["provenance"] == "captured_incomplete"
    assert preview["metadata"]["reason"] == "active_signal_stalled"
    assert extension.prompt_count == 1


INCOMPLETE_CANDIDATE = "## SUBJECT S1\ntitle: en cours"
RECOVERED_FINAL = "# Rapport final\n" + "contenu vérifié arrivé plus tard.\n" * 40


def _upgradable_extension(
    runtime: BridgeApplication, *, turn_id: str = "assistant-42"
) -> Any:
    """Le run cale sur un candidat visible, puis le MÊME tour se termine.

    Le faux content script respecte le contrat v28 : `recovery_capture` est une
    lecture seule, il ne répond jamais à un `assistant_turn_id` inconnu, et il
    annonce explicitement sa finalité via `capture_confidence`.
    """
    base = _stalled_extension(runtime, text=INCOMPLETE_CANDIDATE, turn_id=turn_id)

    class UpgradableExtension(base):  # type: ignore[valid-type, misc]
        def __init__(self, inner: BridgeApplication) -> None:
            super().__init__(inner)
            self.recovery_payloads: list[dict[str, Any]] = []
            self.live_turn_id: str | None = turn_id
            self.live_text: str = RECOVERED_FINAL
            self.capture_confidence = "verified_final"
            self.completion_signal = "assistant_actions"
            self.live_available = True
            self.text_drifted = False

        async def _respond(self, payload: dict[str, Any]) -> None:
            if payload["type"] != "recovery_capture":
                await super()._respond(payload)
                return
            self.recovery_payloads.append(payload)
            route = {
                "target_id": payload["browser_target"]["id"],
                "bridge_run_id": payload["bridge_run_id"],
            }
            if not self.live_available:
                self.runtime.bridge.dispatch(
                    {
                        "type": "recovery_preview",
                        "id": payload["id"],
                        "code": "recovery_unavailable",
                        "error": "onglet exact disparu",
                        **route,
                    }
                )
                return
            if self.text_drifted or self.live_turn_id is None:
                # v28 abandonne la capture quand les deux lectures diffèrent.
                self.runtime.bridge.dispatch(
                    {
                        "type": "recovery_preview",
                        "id": payload["id"],
                        "error": "aucune réponse finale postérieure au tour initial",
                        **route,
                    }
                )
                return
            self.runtime.bridge.dispatch(
                {
                    "type": "recovery_preview",
                    "id": payload["id"],
                    "turn_id": self.live_turn_id,
                    "text": self.live_text,
                    "metadata": {
                        "completion_signal": self.completion_signal,
                        "completion_confidence": "high",
                        "capture_confidence": self.capture_confidence,
                        "content_script_version": "28",
                        "serializer_version": "chatgpt-dom-v3",
                        "output_chars": len(self.live_text),
                        "visible_citations": [],
                    },
                    **route,
                }
            )

    return UpgradableExtension(runtime)


async def _stalled_run_with_visible_candidate(
    runtime: BridgeApplication, tmp_path: Path, key: str, *, turn_id: str = "assistant-42"
) -> tuple[Any, str]:
    isolated_registry(runtime, tmp_path)
    extension = _upgradable_extension(runtime, turn_id=turn_id)
    runtime.bridge.ws = extension
    result = await runtime.bridge_routes.create_bridge_run(
        BridgeRunRequest(input="mission"), request_with_key(key)
    )
    assert result["status"] == "needs_review"
    assert result["metadata"]["completion_signal"] == "streaming"
    assert result["metadata"]["recovery_preview_available"] is True
    return extension, result["id"]


def _durable_preview(runtime: BridgeApplication, run_id: str) -> dict[str, Any]:
    record = runtime.bridge_routes.registry.get_by_run_id(run_id)
    assert record is not None and record["preview_json"]
    return json.loads(record["preview_json"])


async def test_captured_incomplete_is_upgraded_to_the_same_turn_verified_final(
    runtime: BridgeApplication, tmp_path: Path
) -> None:
    """L'incident réel : le candidat de 30 caractères ne doit plus être servi
    alors que le MÊME tour ChatGPT s'est terminé entre-temps."""
    extension, run_id = await _stalled_run_with_visible_candidate(
        runtime, tmp_path, "upgrade-verified-final"
    )
    incomplete_sha = hashlib.sha256(INCOMPLETE_CANDIDATE.encode()).hexdigest()
    assert _durable_preview(runtime, run_id)["metadata"]["sha256"] == incomplete_sha

    preview = await runtime.bridge_routes.preview_visible_recovery(run_id)

    # Run, cible et tour externe exacts — aucun repli sur un autre onglet.
    assert len(extension.recovery_payloads) == 1
    captured = extension.recovery_payloads[0]
    assert captured["bridge_run_id"] == run_id
    assert captured["browser_target"] == {
        "kind": "temporary_chat_run",
        "id": f"bridge-run-{run_id}",
    }
    assert captured["assistant_turn_id"] == "assistant-42"
    assert preview["bridge_run_id"] == run_id
    assert preview["target_id"] == f"bridge-run-{run_id}"
    assert preview["turn_id"] == "assistant-42"
    assert preview["text"] == RECOVERED_FINAL
    assert preview["provenance"] == "live_verified_final"
    assert preview["metadata"]["provenance"] == "live_verified_final"
    assert preview["metadata"]["capture_confidence"] == "verified_final"
    final_sha = hashlib.sha256(RECOVERED_FINAL.encode()).hexdigest()
    assert preview["metadata"]["sha256"] == final_sha
    assert final_sha != incomplete_sha
    assert preview["metadata"]["superseded_sha256"] == incomplete_sha

    # Les deux instantanés restent durables ; l'incomplet n'est jamais détruit.
    persisted = _durable_preview(runtime, run_id)
    assert persisted["provenance"] == "live_verified_final"
    assert persisted["text"] == RECOVERED_FINAL
    assert persisted["fallback"]["provenance"] == "captured_incomplete"
    assert persisted["fallback"]["text"] == INCOMPLETE_CANDIDATE
    assert persisted["fallback"]["metadata"]["sha256"] == incomplete_sha

    # Deuxième aperçu : mêmes octets, plus aucune dépendance au DOM.
    runtime.bridge.ws = None
    repeated = await runtime.bridge_routes.preview_visible_recovery(run_id)
    assert repeated == preview
    assert len(extension.recovery_payloads) == 1

    # Lecture seule stricte : un seul prompt, et aucun message d'écriture.
    assert extension.prompt_count == 1
    assert [payload["type"] for payload in extension.sent].count("prompt") == 1
    # Le seul message émis par la récupération est une capture en lecture seule.
    assert [
        payload["type"]
        for payload in extension.sent
        if payload["type"] not in {"ui_state", "ui_control", "prompt", "browser_target_retain"}
    ] == ["recovery_capture"]


async def test_lost_tab_keeps_the_incomplete_candidate_recoverable(
    runtime: BridgeApplication, tmp_path: Path
) -> None:
    extension, run_id = await _stalled_run_with_visible_candidate(
        runtime, tmp_path, "upgrade-lost-tab"
    )
    extension.live_available = False

    preview = await runtime.bridge_routes.preview_visible_recovery(run_id)

    assert preview["provenance"] == "captured_incomplete"
    assert preview["text"] == INCOMPLETE_CANDIDATE
    assert _durable_preview(runtime, run_id)["provenance"] == "captured_incomplete"
    assert extension.prompt_count == 1


async def test_a_different_external_turn_never_upgrades_the_candidate(
    runtime: BridgeApplication, tmp_path: Path
) -> None:
    extension, run_id = await _stalled_run_with_visible_candidate(
        runtime, tmp_path, "upgrade-other-turn"
    )
    extension.live_turn_id = "assistant-43"

    preview = await runtime.bridge_routes.preview_visible_recovery(run_id)

    assert preview["provenance"] == "captured_incomplete"
    assert preview["text"] == INCOMPLETE_CANDIDATE
    assert _durable_preview(runtime, run_id)["provenance"] == "captured_incomplete"
    assert extension.prompt_count == 1


async def test_same_turn_still_streaming_never_upgrades_the_candidate(
    runtime: BridgeApplication, tmp_path: Path
) -> None:
    extension, run_id = await _stalled_run_with_visible_candidate(
        runtime, tmp_path, "upgrade-still-streaming"
    )
    extension.capture_confidence = "visible_unknown"
    extension.completion_signal = "streaming"

    preview = await runtime.bridge_routes.preview_visible_recovery(run_id)

    assert preview["provenance"] == "captured_incomplete"
    assert preview["text"] == INCOMPLETE_CANDIDATE
    assert _durable_preview(runtime, run_id)["provenance"] == "captured_incomplete"
    assert extension.prompt_count == 1


async def test_text_drifting_between_reads_never_becomes_a_final_answer(
    runtime: BridgeApplication, tmp_path: Path
) -> None:
    extension, run_id = await _stalled_run_with_visible_candidate(
        runtime, tmp_path, "upgrade-drift"
    )
    extension.text_drifted = True

    preview = await runtime.bridge_routes.preview_visible_recovery(run_id)

    assert preview["provenance"] == "captured_incomplete"
    assert preview["text"] == INCOMPLETE_CANDIDATE
    assert _durable_preview(runtime, run_id)["provenance"] == "captured_incomplete"
    assert extension.prompt_count == 1


async def test_durable_verified_final_never_regresses_to_the_incomplete_candidate(
    runtime: BridgeApplication, tmp_path: Path
) -> None:
    """Une fois la finale rendue durable, plus rien ne peut la faire régresser."""
    database = tmp_path / "runs.sqlite3"
    extension, run_id = await _stalled_run_with_visible_candidate(
        runtime, tmp_path, "upgrade-deterministic"
    )
    upgraded = await runtime.bridge_routes.preview_visible_recovery(run_id)
    assert upgraded["provenance"] == "live_verified_final"

    # Le DOM ment maintenant (autre tour, texte instable) et le bridge redémarre :
    # l'aperçu reste la finale vérifiée, à l'octet près.
    extension.live_turn_id = "assistant-43"
    extension.text_drifted = True
    runtime.bridge_routes.registry = RunRegistry(database)
    after_restart = await runtime.bridge_routes.preview_visible_recovery(run_id)
    runtime.bridge.ws = None
    without_browser = await runtime.bridge_routes.preview_visible_recovery(run_id)

    assert after_restart == without_browser == upgraded
    assert len(extension.recovery_payloads) == 1
    # Le repli incomplet reste consultable pour l'audit.
    assert after_restart["fallback"]["text"] == INCOMPLETE_CANDIDATE
    assert extension.prompt_count == 1


async def test_placeholder_turn_id_is_never_a_durable_external_identity(
    runtime: BridgeApplication, tmp_path: Path
) -> None:
    isolated_registry(runtime, tmp_path)
    placeholder = "request-placeholder-request-WEB:822ff1a2-6c1f-49a1-b10e-3143f7ca53b3-0"
    extension = _stalled_extension(runtime, text="réponse visible", turn_id=placeholder)(runtime)
    runtime.bridge.ws = extension

    result = await runtime.bridge_routes.create_bridge_run(
        BridgeRunRequest(input="mission"), request_with_key("stalled-placeholder")
    )
    run_id = result["id"]
    preview = await runtime.bridge_routes.preview_visible_recovery(run_id)

    assert result["metadata"]["initial_turn_id"] is None
    assert result["metadata"]["external_turn_id_verified"] is False
    # Le texte reste adoptable ; seule l'identité de continuation est refusée,
    # et rien ne la remplace.
    assert preview["text"] == "réponse visible"
    assert preview["turn_id"] is None
    assert preview["metadata"]["external_turn_id_verified"] is False
    assert placeholder not in json.dumps(preview, ensure_ascii=False)
    assert extension.prompt_count == 1


async def test_failed_preview_persistence_never_claims_durable_recovery(
    runtime: BridgeApplication, tmp_path: Path
) -> None:
    """Un aperçu non persisté ne doit jamais être annoncé comme récupérable.

    Le texte a bien été vu (`candidate_output_present`), mais rien ne survit à
    la fermeture de l'onglet : promettre une adoption durable enverrait un
    humain chercher un aperçu inexistant.
    """
    isolated_registry(runtime, tmp_path)
    extension = _stalled_extension(runtime, text="réponse visible", turn_id="assistant-9")(
        runtime
    )
    runtime.bridge.ws = extension

    def refuse(run_id: str, value: dict[str, Any]) -> None:
        raise RuntimeError("registre indisponible")

    runtime.bridge_routes.registry.store_preview = refuse  # type: ignore[method-assign]

    result = await runtime.bridge_routes.create_bridge_run(
        BridgeRunRequest(input="mission"), request_with_key("stalled-unpersisted")
    )

    assert result["status"] == "needs_review"
    assert result["error"]["code"] == "active_signal_stalled"
    assert result["metadata"]["candidate_output_present"] is True
    assert result["metadata"]["output_chars"] == len("réponse visible")
    assert result["metadata"]["recovery_preview_available"] is False
    assert result["error"]["details"]["recovery_preview_available"] is False
    # Aucune resoumission implicite : l'échec de persistance reste un
    # needs_review, jamais un replay du prompt.
    assert extension.prompt_count == 1


async def test_empty_incomplete_stays_an_honest_no_final_answer(
    runtime: BridgeApplication, tmp_path: Path
) -> None:
    isolated_registry(runtime, tmp_path)
    extension = _stalled_extension(runtime, text="", turn_id="assistant-7")(runtime)
    runtime.bridge.ws = extension

    result = await runtime.bridge_routes.create_bridge_run(
        BridgeRunRequest(input="mission"), request_with_key("stalled-empty")
    )
    run_id = result["id"]
    record = runtime.bridge_routes.registry.get_by_run_id(run_id)

    assert result["status"] == "needs_review"
    assert result["metadata"]["output_chars"] == 0
    assert result["metadata"]["candidate_output_present"] is False
    assert result["metadata"]["recovery_preview_available"] is False
    assert record is not None and record["preview_json"] is None
    assert extension.prompt_count == 1


async def test_empty_done_is_never_reported_as_completed(
    runtime: BridgeApplication, tmp_path: Path
) -> None:
    isolated_registry(runtime, tmp_path)

    class EmptyDoneExtension(FakeExtension):
        async def _respond(self, payload: dict[str, Any]) -> None:
            if payload["type"] != "prompt":
                await super()._respond(payload)
                return
            self.prompt_count += 1
            browser_target = payload.get("browser_target")
            route = (
                {"target_id": browser_target["id"], "tab_id": 1}
                if isinstance(browser_target, dict)
                else {}
            )
            self.runtime.bridge.dispatch(
                {
                    "type": "done",
                    "id": payload["id"],
                    "event_id": "empty",
                    "text": "",
                    "metadata": {"output_chars": 0},
                    **route,
                }
            )

    extension = EmptyDoneExtension(runtime)
    runtime.bridge.ws = extension

    result = await runtime.bridge_routes.create_bridge_run(
        BridgeRunRequest(input="empty final"), request_with_key("empty-done")
    )

    assert result["status"] != "completed"
    assert result["status"] == "needs_review"
    assert result["error"]["code"] == "no_final_answer"
    assert extension.prompt_count == 1


async def test_conversation_binding_precedes_incomplete_and_survives_restart(
    runtime: BridgeApplication, tmp_path: Path
) -> None:
    database = tmp_path / "runs.sqlite3"
    isolated_registry(runtime, tmp_path)
    bound = asyncio.Event()
    release = asyncio.Event()
    conversation_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    locator = f"https://chatgpt.com/c/{conversation_id}"

    class IncompleteExtension(FakeExtension):
        wrong_conversation = False

        async def _respond(self, payload: dict[str, Any]) -> None:
            if payload["type"] == "recovery_capture":
                self.runtime.bridge.dispatch(
                    {
                        "type": "recovery_preview",
                        "id": payload["id"],
                        "conversation_id": (
                            "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
                            if self.wrong_conversation
                            else conversation_id
                        ),
                        "external_locator": locator,
                        "turn_id": "assistant-later",
                        "text": "## SUBJECT S1\ntitle: Réponse récupérée\n",
                        "metadata": {"completion_signal": "assistant_actions"},
                    }
                )
                return
            if payload["type"] != "prompt":
                await super()._respond(payload)
                return
            self.prompt_count += 1
            conversation = {
                "id": conversation_id,
                "expected_turn_id": None,
                "external_locator": locator,
                "assistant_turns_before": 2,
                "initial_assistant_turn_id": "assistant-before",
                "verified": True,
                "ephemeral": True,
                "verified_at": "2026-08-13T10:00:00.000Z",
            }
            self.runtime.bridge.dispatch(
                {
                    "type": "conversation_bound",
                    "id": payload["id"],
                    "event_id": "1",
                    "conversation": conversation,
                }
            )
            bound.set()
            await release.wait()
            self.runtime.bridge.dispatch(
                {
                    "type": "incomplete",
                    "id": payload["id"],
                    "event_id": "2",
                    "reason": "no_final_answer",
                    "metadata": {
                        "completion_signal": "assistant_actions",
                        "completion_confidence": "high",
                        "initial_turn_id": "assistant-empty",
                        "output_chars": 0,
                    },
                }
            )

    extension = IncompleteExtension(runtime)
    runtime.bridge.ws = extension
    request = BridgeRunRequest(
        input="mission",
        background=True,
        conversation={"mode": "fresh", "id": conversation_id},
    )
    accepted = await runtime.bridge_routes.create_bridge_run(
        request, request_with_key("incomplete-bound")
    )
    await bound.wait()

    persisted = runtime.bridge_routes.registry.get_by_run_id(accepted["id"])
    assert persisted is not None
    binding = json.loads(persisted["conversation_json"])
    assert binding["external_locator"] == locator
    assert binding["assistant_turns_before"] == 2

    release.set()
    await runtime.bridge_routes.idempotent_tasks[accepted["id"]]
    needs_review = await runtime.bridge_routes.retrieve_bridge_run(accepted["id"])
    assert needs_review["status"] == "needs_review"
    assert needs_review["error"]["code"] == "no_final_answer"

    restarted = RunRegistry(database)
    runtime.bridge_routes.registry = restarted
    preview = await runtime.bridge_routes.preview_visible_recovery(accepted["id"])
    assert preview["turn_id"] == "assistant-later"
    assert preview["text"].startswith("## SUBJECT S1")
    assert extension.prompt_count == 1

    extension.wrong_conversation = True
    with pytest.raises(HTTPException) as mismatched:
        await runtime.bridge_routes.preview_visible_recovery(accepted["id"])
    assert mismatched.value.status_code == 409
    assert extension.prompt_count == 1


async def test_stateless_incomplete_recovery_uses_canonical_target_and_release(
    runtime: BridgeApplication, tmp_path: Path
) -> None:
    isolated_registry(runtime, tmp_path)

    class StatelessRecoveryExtension:
        def __init__(self) -> None:
            self.runtime = runtime
            self.prompt_count = 0
            self.recovery_payloads: list[dict[str, Any]] = []
            self.release_payloads: list[dict[str, Any]] = []
            self.mismatch: str | None = None

        async def send_json(self, payload: dict[str, Any]) -> None:
            if payload["type"] in {"ui_state", "ui_control"}:
                self.runtime.bridge.dispatch(
                    {
                        "type": payload["type"],
                        "id": payload["id"],
                        "state": {},
                        "applied": {},
                        "target_id": payload["browser_target"]["id"],
                        "tab_id": 1,
                    }
                )
            elif payload["type"] == "prompt":
                self.prompt_count += 1
                target_id = payload["browser_target"]["id"]
                self.runtime.bridge.dispatch(
                    {
                        "type": "incomplete",
                        "id": payload["id"],
                        "event_id": "incomplete-1",
                        "reason": "no_final_answer",
                        "metadata": {
                            "submission_state": "post_submission",
                            "initial_turn_id": "assistant-pending",
                        },
                        "target_id": target_id,
                        "tab_id": 1,
                    }
                )
            elif payload["type"] == "recovery_capture":
                self.recovery_payloads.append(payload)
                target = payload["browser_target"]
                target_id = target["id"]
                bridge_run_id = payload["bridge_run_id"]
                if self.mismatch == "target":
                    target_id = "wrong-target"
                elif self.mismatch == "run":
                    bridge_run_id = "wrong-run"
                self.runtime.bridge.dispatch(
                    {
                        "type": "recovery_preview",
                        "id": payload["id"],
                        "target_id": target_id,
                        "bridge_run_id": bridge_run_id,
                        "turn_id": "assistant-final",
                        "text": "réponse finale tardive",
                        "metadata": {
                            "completion_signal": "assistant_actions",
                            "completion_confidence": "high",
                        },
                    }
                )
            elif payload["type"] == "browser_target_release":
                self.release_payloads.append(payload)

        async def close(self, code: int, reason: str) -> None:
            del code, reason

    extension = StatelessRecoveryExtension()
    runtime.bridge.ws = extension

    result = await runtime.bridge_routes.create_bridge_run(
        BridgeRunRequest(input="mission"), request_with_key("stateless-recovery")
    )
    assert result["status"] == "needs_review"
    run_id = result["id"]

    preview = await runtime.bridge_routes.preview_visible_recovery(run_id)
    assert preview["bridge_run_id"] == run_id
    assert preview["target_id"] == f"bridge-run-{run_id}"
    assert preview["turn_id"] == "assistant-final"
    assert preview["text"] == "réponse finale tardive"
    assert extension.prompt_count == 1
    assert extension.recovery_payloads[0]["browser_target"] == {
        "kind": "temporary_chat_run",
        "id": f"bridge-run-{run_id}",
    }
    assert extension.recovery_payloads[0]["bridge_run_id"] == run_id
    assert extension.release_payloads == []

    extension.mismatch = "target"
    with pytest.raises(HTTPException) as wrong_target:
        await runtime.bridge_routes.preview_visible_recovery(run_id)
    assert wrong_target.value.status_code == 409

    extension.mismatch = "run"
    with pytest.raises(HTTPException) as wrong_run:
        await runtime.bridge_routes.preview_visible_recovery(run_id)
    assert wrong_run.value.status_code == 409

    released = await runtime.bridge_routes.release_visible_recovery(run_id)
    retried = await runtime.bridge_routes.release_visible_recovery(run_id)
    assert released == retried == {
        "bridge_run_id": run_id,
        "target_id": f"bridge-run-{run_id}",
        "released": True,
    }
    assert len(extension.release_payloads) == 2
    assert all(
        payload["browser_target"]["id"] == f"bridge-run-{run_id}"
        and payload["run_id"] == run_id
        for payload in extension.release_payloads
    )


async def test_interrupted_stateless_run_recovers_by_exact_run_target(
    runtime: BridgeApplication, tmp_path: Path
) -> None:
    isolated_registry(runtime, tmp_path)
    key = "interrupted-stateless"
    record, created = runtime.bridge_routes.registry.claim(key, "request-hash")
    assert created is True
    runtime.bridge_routes.registry.set_state(key, "running")
    runtime.bridge_routes.registry.recover_interrupted()

    class RecoveryExtension:
        def __init__(self) -> None:
            self.runtime = runtime
            self.payloads: list[dict[str, Any]] = []

        async def send_json(self, payload: dict[str, Any]) -> None:
            self.payloads.append(payload)
            if payload["type"] == "recovery_capture":
                target_id = payload["browser_target"]["id"]
                self.runtime.bridge.dispatch(
                    {
                        "type": "recovery_preview",
                        "id": payload["id"],
                        "target_id": target_id,
                        "bridge_run_id": payload["bridge_run_id"],
                        "turn_id": "assistant-recovered",
                        "text": "réponse après redémarrage",
                        "metadata": {},
                    }
                )

    extension = RecoveryExtension()
    runtime.bridge.ws = extension
    preview = await runtime.bridge_routes.preview_visible_recovery(record["bridge_run_id"])

    assert preview["bridge_run_id"] == record["bridge_run_id"]
    assert len(extension.payloads) == 1
    payload = extension.payloads[0]
    assert payload["type"] == "recovery_capture"
    assert payload["bridge_run_id"] == record["bridge_run_id"]
    assert payload["browser_target"] == {
        "kind": "temporary_chat_run",
        "id": f"bridge-run-{record['bridge_run_id']}",
    }
    assert payload["assistant_turn_id"] is None


async def test_done_rejects_incoherent_output_chars(
    runtime: BridgeApplication, tmp_path: Path
) -> None:
    isolated_registry(runtime, tmp_path)

    class InvalidLengthExtension(FakeExtension):
        async def _respond(self, payload: dict[str, Any]) -> None:
            if payload["type"] != "prompt":
                await super()._respond(payload)
                return
            self.prompt_count += 1
            browser_target = payload.get("browser_target")
            self.runtime.bridge.dispatch(
                {
                    "type": "done",
                    "id": payload["id"],
                    "text": "final",
                    "event_id": "1",
                    "metadata": {"output_chars": 99},
                    "target_id": browser_target["id"],
                    "tab_id": 1,
                }
            )

    runtime.bridge.ws = InvalidLengthExtension(runtime)

    with pytest.raises(HTTPException) as caught:
        await runtime.bridge_routes.create_bridge_run(
            BridgeRunRequest(input="bad length"),
            request_with_key("bad-length"),
        )
    assert caught.value.status_code == 502
    assert "longueur du snapshot final incohérente" in str(caught.value.detail)


async def test_cancelled_http_wait_then_retry_joins_original_run(
    runtime: BridgeApplication, tmp_path: Path
) -> None:
    isolated_registry(runtime, tmp_path)
    extension = FakeExtension(runtime, prompt_delay=0.05)
    runtime.bridge.ws = extension
    req = BridgeRunRequest(input="expensive prompt")
    create_bridge_run = runtime.bridge_routes.create_bridge_run

    abandoned = asyncio.create_task(
        create_bridge_run(req, request_with_key("business-timeout"))
    )
    await asyncio.sleep(0.01)
    abandoned.cancel()
    with pytest.raises(asyncio.CancelledError):
        await abandoned
    replay = await create_bridge_run(req, request_with_key("business-timeout"))

    assert replay["status"] == "completed"
    assert extension.prompt_count == 1


async def test_same_key_different_payload_conflicts(
    runtime: BridgeApplication, tmp_path: Path
) -> None:
    isolated_registry(runtime, tmp_path)
    extension = FakeExtension(runtime)
    runtime.bridge.ws = extension
    await runtime.bridge_routes.create_bridge_run(
        BridgeRunRequest(input="one"), request_with_key("conflict")
    )

    with pytest.raises(HTTPException) as caught:
        await runtime.bridge_routes.create_bridge_run(
            BridgeRunRequest(input="two"), request_with_key("conflict")
        )
    assert caught.value.status_code == 409
    assert isinstance(caught.value.detail, dict)
    assert caught.value.detail["code"] == "bridge_payload_conflict"


async def test_completed_run_survives_registry_restart_without_ui(
    runtime: BridgeApplication, tmp_path: Path
) -> None:
    database = tmp_path / "runs.sqlite3"
    isolated_registry(runtime, tmp_path)
    extension = FakeExtension(runtime)
    runtime.bridge.ws = extension
    req = BridgeRunRequest(input="once")
    first = await runtime.bridge_routes.create_bridge_run(req, request_with_key("restart"))

    runtime.bridge_routes.registry = RunRegistry(database)
    runtime.bridge.ws = None
    replay = await runtime.bridge_routes.create_bridge_run(req, request_with_key("restart"))

    assert replay["id"] == first["id"]
    assert extension.prompt_count == 1


async def test_capabilities_degrade_visibly_without_a_connected_extension(
    runtime: BridgeApplication,
) -> None:
    runtime.bridge.ws = None

    caps = await runtime.bridge_routes.bridge_capabilities()

    assert caps["streaming"] == "final_delta_only"
    assert caps["web_search"] == "prompt_instructed"
    assert caps["actual_model_version"] is False
    assert caps["controls"]["model_selection"] == "unavailable"
    assert caps["ui"]["available"] is False
    assert caps["ui"]["stale"] is True
    assert caps["ui"]["state"] is None


async def test_capabilities_never_waits_for_a_blocked_extension(
    runtime: BridgeApplication,
) -> None:
    class Blocked:
        async def send_json(self, _: dict[str, Any]) -> None:
            await asyncio.Event().wait()

    runtime.bridge.ws = Blocked()
    started = asyncio.get_running_loop().time()
    caps = await runtime.bridge_routes.bridge_capabilities()
    elapsed = asyncio.get_running_loop().time() - started

    assert elapsed < 0.25
    assert caps["extension_connected"] is True


async def test_ui_probe_timeout_is_typed(
    runtime: BridgeApplication, monkeypatch: pytest.MonkeyPatch
) -> None:
    class Silent:
        async def send_json(self, _: dict[str, Any]) -> None:
            return None

    runtime.bridge.ws = Silent()
    # `UI_TIMEOUT` is a module-level name inside `bridge.routes_bridge`
    # (import-cached across tests): a bare assignment here would leak
    # UI_TIMEOUT=0.01 into every later test in this process.
    monkeypatch.setitem(
        runtime.bridge_routes.bridge_capabilities.__globals__, "UI_TIMEOUT", 0.01
    )
    with pytest.raises(HTTPException) as caught:
        await runtime.bridge_routes.bridge_capabilities(probe=True, fresh=True)

    assert caught.value.status_code == 504
    assert isinstance(caught.value.detail, dict)
    assert caught.value.detail["code"] == "bridge_ui_timeout"


async def test_bridge_logs_neither_prompt_nor_idempotency_secret(
    runtime: BridgeApplication, tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    isolated_registry(runtime, tmp_path)
    runtime.bridge.ws = FakeExtension(runtime)
    caplog.set_level(logging.INFO, logger="chatgpt_bridge")

    await runtime.bridge_routes.create_bridge_run(
        BridgeRunRequest(input="TOP-SECRET-PROMPT"),
        request_with_key("TOP-SECRET-IDEMPOTENCY-KEY"),
    )

    rendered = caplog.text
    assert "TOP-SECRET-PROMPT" not in rendered
    assert "TOP-SECRET-IDEMPOTENCY-KEY" not in rendered
    assert "idempotency_fingerprint=" in rendered
