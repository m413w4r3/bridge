"""Tests for `bridge/generation.py`: idle vs. total timeout semantics.

`run_generation` distinguishes two deadlines that must never be confused: the
idle timeout (the extension stopped sending anything) and the total timeout
(the extension is alive but the generation ran too long). Confusing the two
has already caused a live extension sending heartbeats to be misdiagnosed as
disconnected.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

import pytest
from conftest import request_with_key

from bridge.app import BridgeApplication
from bridge.contracts import BridgeBrowserTarget, ChatRequest
from bridge.generation import UpstreamError, run_generation


class SilentExtension:
    """Extension muette : reçoit le prompt mais ne redispatche jamais rien."""

    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []
        self.closed: tuple[int, str] | None = None

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)

    async def close(self, code: int, reason: str) -> None:
        self.closed = (code, reason)


class TypedErrorExtension:
    """Extension-side typed failure used to verify the submission boundary."""

    def __init__(self, runtime: BridgeApplication) -> None:
        self.runtime = runtime

    async def send_json(self, payload: dict[str, Any]) -> None:
        if payload.get("type") == "prompt":
            self.runtime.bridge.dispatch(
                {
                    "type": "error",
                    "id": payload["id"],
                    "event_id": "typed-error",
                    "code": "bridge_ui_timeout",
                    "message": "confirmation impossible",
                    "retryable": True,
                    "phase": "submission_confirmation",
                    "submission_state": "submission_attempted",
                    "diagnostics": {
                        "composer_text": "secret prompt must not escape",
                        "user_turns_before": 2,
                    },
                }
            )

    async def close(self, code: int, reason: str) -> None:
        del code, reason


async def test_idle_timeout_does_not_send_abort_to_extension(
    runtime: BridgeApplication,
) -> None:
    """Vérifier que le timeout de 120s ne déclenche plus un abort automatique.

    Avant la correction :
    - Timeout après 120s sans paquet
    - finally envoie automatiquement {"type": "abort"}
    - extension clique Stop dans ChatGPT
    - → "Stopped thinking"

    Après la correction :
    - Timeout après 120s sans paquet
    - finally ferme le canal HTTP uniquement
    - ChatGPT continue dans son onglet
    - récupération DOM possible via /recovery/visible
    """
    silent = SilentExtension()
    runtime.bridge.ws = silent

    chat_request = ChatRequest(messages=[{"role": "user", "content": "test"}])

    async def never_disconnects() -> dict[str, Any]:
        await asyncio.Event().wait()
        raise AssertionError("unreachable")

    http_req = request_with_key("timeout-test")
    http_req._receive = never_disconnects

    old_idle = run_generation.__globals__["IDLE_TIMEOUT"]
    run_generation.__globals__["IDLE_TIMEOUT"] = 0.1
    try:
        with pytest.raises(Exception) as caught:
            async for _ in run_generation(
                runtime.bridge, runtime.registry, "timeout-test", chat_request, http_req
            ):
                pass
    finally:
        run_generation.__globals__["IDLE_TIMEOUT"] = old_idle

    assert "aucune donnée de l'extension depuis" in str(caught.value)

    # Vérification critique : le nettoyage du serveur ne clique jamais Stop.
    abort_messages = [msg for msg in silent.sent if msg.get("type") == "abort"]
    assert not abort_messages, (
        "Un message abort ne doit jamais être envoyé automatiquement, "
        f"mais {len(abort_messages)} ont été trouvé(s)"
    )
    assert [msg for msg in silent.sent if msg.get("type") == "prompt"], (
        "Le prompt aurait dû être transmis à l'extension"
    )


async def test_stateless_generation_carries_one_browser_target(
    runtime: BridgeApplication,
) -> None:
    silent = SilentExtension()
    runtime.bridge.ws = silent
    chat_request = ChatRequest(
        messages=[{"role": "user", "content": "test"}],
        new_chat=True,
    )
    target = BridgeBrowserTarget(id="bridge-attempt-1")
    http_req = request_with_key("target-contract")

    async def never_disconnects() -> dict[str, Any]:
        await asyncio.Event().wait()
        raise AssertionError("unreachable")

    http_req._receive = never_disconnects

    old_idle = run_generation.__globals__["IDLE_TIMEOUT"]
    run_generation.__globals__["IDLE_TIMEOUT"] = 0.01
    try:
        with pytest.raises(UpstreamError):
            async for _ in run_generation(
                runtime.bridge,
                runtime.registry,
                "target-contract",
                chat_request,
                http_req,
                browser_target=target,
            ):
                pass
    finally:
        run_generation.__globals__["IDLE_TIMEOUT"] = old_idle

    prompt = next(msg for msg in silent.sent if msg.get("type") == "prompt")
    assert prompt["browser_target"] == target.model_dump(mode="json")
    assert prompt["conversation"] is None


async def test_stateless_new_chat_without_browser_target_fails_pre_submission(
    runtime: BridgeApplication,
) -> None:
    runtime.bridge.ws = SilentExtension()
    chat_request = ChatRequest(
        messages=[{"role": "user", "content": "test"}],
        new_chat=True,
    )

    with pytest.raises(UpstreamError) as caught:
        async for _ in run_generation(
            runtime.bridge,
            runtime.registry,
            "missing-target",
            chat_request,
            request_with_key("missing-target"),
        ):
            pass

    assert caught.value.code == "bridge_browser_target_required"
    assert caught.value.submission_state == "pre_submission"


class HeartbeatingExtension:
    """Extension vivante : heartbeat régulier, `done` optionnel.

    Elle reproduit le cas qui a fait diagnostiquer à tort une extension muette :
    ChatGPT travaille, les heartbeats arrivent toutes les quelques secondes, mais
    la génération dépasse la borne totale du bridge.
    """

    def __init__(
        self,
        runtime: BridgeApplication,
        *,
        interval: float,
        done_after: float | None = None,
    ) -> None:
        self.runtime = runtime
        self.interval = interval
        self.done_after = done_after
        self.sent: list[dict[str, Any]] = []
        self.beats = 0
        self.task: asyncio.Task[None] | None = None
        self.closed: tuple[int, str] | None = None

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)
        if payload.get("type") == "prompt":
            self.task = asyncio.create_task(self._beat(payload["id"]))

    async def _beat(self, request_id: str) -> None:
        started = asyncio.get_running_loop().time()
        while True:
            await asyncio.sleep(self.interval)
            if (
                self.done_after is not None
                and asyncio.get_running_loop().time() - started >= self.done_after
            ):
                self.runtime.bridge.dispatch(
                    {
                        "type": "done",
                        "id": request_id,
                        "event_id": "done",
                        "text": "rapport final",
                        "metadata": {
                            "completion_signal": "assistant_actions",
                            "completion_confidence": "high",
                            "stable_for_ms": 2_100,
                            "output_chars": len("rapport final"),
                            "visible_citation_count": 0,
                            "content_script_version": "16",
                        },
                    }
                )
                return
            self.beats += 1
            self.runtime.bridge.dispatch(
                {
                    "type": "heartbeat",
                    "id": request_id,
                    "event_id": f"hb-{self.beats}",
                    "progress": {
                        "phase": "generating",
                        "output_chars": 30_454,
                        "stable_for_ms": 0,
                        "completion_signal": "streaming",
                        "completion_confidence": "high",
                    },
                }
            )

    async def close(self, code: int, reason: str) -> None:
        self.closed = (code, reason)

    def stop(self) -> None:
        if self.task is not None:
            self.task.cancel()


async def _generate(
    runtime: BridgeApplication,
    extension: Any,
    request_id: str,
    *,
    total_timeout: float,
    idle_timeout: float,
) -> tuple[list[str], Exception | None, float]:
    """Exécute une génération complète avec des échéances accélérées."""
    runtime.bridge.ws = extension
    chat_request = ChatRequest(messages=[{"role": "user", "content": "recherche"}])

    async def never_disconnects() -> dict[str, Any]:
        await asyncio.Event().wait()
        raise AssertionError("unreachable")

    http_req = request_with_key(request_id)
    http_req._receive = never_disconnects

    globals_ = run_generation.__globals__
    previous = (globals_["TOTAL_TIMEOUT"], globals_["IDLE_TIMEOUT"])
    globals_["TOTAL_TIMEOUT"] = total_timeout
    globals_["IDLE_TIMEOUT"] = idle_timeout
    chunks: list[str] = []
    failure: Exception | None = None
    started = asyncio.get_running_loop().time()
    try:
        async for text in run_generation(
            runtime.bridge, runtime.registry, request_id, chat_request, http_req
        ):
            chunks.append(text)
    except Exception as exc:  # noqa: BLE001 - le test inspecte lui-même le type et le code
        failure = exc
    finally:
        elapsed = asyncio.get_running_loop().time() - started
        globals_["TOTAL_TIMEOUT"], globals_["IDLE_TIMEOUT"] = previous
        if hasattr(extension, "stop"):
            extension.stop()
    return chunks, failure, elapsed


async def test_typed_extension_error_preserves_submission_state_and_safe_diagnostics(
    runtime: BridgeApplication,
) -> None:
    _, failure, _ = await _generate(
        runtime,
        TypedErrorExtension(runtime),
        "typed-error",
        total_timeout=1.0,
        idle_timeout=0.2,
    )

    assert isinstance(failure, UpstreamError)
    assert failure.code == "bridge_ui_timeout"
    assert failure.retryable is True
    assert failure.phase == "submission_confirmation"
    assert failure.submission_state == "submission_attempted"
    assert "composer_text" not in failure.details
    assert failure.details["user_turns_before"] == 2


async def test_live_generation_reaching_the_total_deadline_is_never_called_idle(
    runtime: BridgeApplication,
) -> None:
    """Le bug du 17/08 : 900 s pile, heartbeats reçus, message « aucune donnée ».

    `asyncio.wait_for` expirait sur la borne totale, mais la branche d'erreur
    accusait systématiquement l'extension d'être muette.
    """
    extension = HeartbeatingExtension(runtime, interval=0.05)

    _, failure, elapsed = await _generate(
        runtime, extension, "total-timeout", total_timeout=0.5, idle_timeout=0.15
    )

    assert isinstance(failure, UpstreamError)
    assert failure.code == "bridge_total_timeout"
    assert "génération non terminée après" in str(failure)
    assert "aucune donnée de l'extension" not in str(failure)
    # La borne totale, et elle seule, a mis fin au run : les heartbeats
    # réarmaient l'attente d'inactivité à chaque paquet.
    assert elapsed >= 0.5
    assert extension.beats >= 3


async def test_silent_extension_is_reported_as_idle_well_before_the_total_deadline(
    runtime: BridgeApplication,
) -> None:
    _, failure, elapsed = await _generate(
        runtime, SilentExtension(), "idle-timeout", total_timeout=2.0, idle_timeout=0.2
    )

    assert isinstance(failure, UpstreamError)
    assert failure.code == "bridge_idle_timeout"
    assert "aucune donnée de l'extension depuis" in str(failure)
    assert elapsed < 1.0


async def test_long_but_live_generation_completes_before_the_total_deadline(
    runtime: BridgeApplication,
) -> None:
    extension = HeartbeatingExtension(runtime, interval=0.05, done_after=0.6)

    chunks, failure, _ = await _generate(
        runtime, extension, "live-completion", total_timeout=1.5, idle_timeout=0.15
    )

    assert failure is None
    assert "".join(chunks) == "rapport final"
    # Le run a duré bien plus longtemps que l'idle timeout sans jamais expirer.
    assert extension.beats >= 3


class EndlessStreamingAnimationExtension:
    """Génération pathologique : `.streaming-animation` sans fin, texte figé.

    Reproduit l'incident de production côté serveur : le content script observe
    un tour dont la sortie ne mute plus depuis plus de 300 s, mais dont
    `.streaming-animation` reste visible. Il n'invente donc ni `done` ni
    `incomplete` — il ne fait que battre. La durée n'est bornée que par
    `bridge_total_timeout`, et cette borne ne rejoue jamais le prompt.
    """

    FROZEN_OUTPUT_CHARS = 32

    def __init__(self, runtime: BridgeApplication, *, interval: float) -> None:
        self.runtime = runtime
        self.interval = interval
        self.sent: list[dict[str, Any]] = []
        self.beats = 0
        self.task: asyncio.Task[None] | None = None
        self.closed: tuple[int, str] | None = None

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)
        if payload.get("type") == "prompt":
            self.task = asyncio.create_task(self._beat(payload["id"]))

    async def _beat(self, request_id: str) -> None:
        stable_for_ms = 300_000
        while True:
            await asyncio.sleep(self.interval)
            self.beats += 1
            stable_for_ms += 5_000
            self.runtime.bridge.dispatch(
                {
                    "type": "heartbeat",
                    "id": request_id,
                    "event_id": f"hb-{self.beats}",
                    "progress": {
                        "phase": "generating",
                        "output_chars": self.FROZEN_OUTPUT_CHARS,
                        "stable_for_ms": stable_for_ms,
                        "completion_signal": "streaming",
                        "completion_confidence": "high",
                        "streaming_signal_sources": [
                            {"source": ".streaming-animation", "visible": True}
                        ],
                    },
                }
            )

    async def close(self, code: int, reason: str) -> None:
        self.closed = (code, reason)

    def stop(self) -> None:
        if self.task is not None:
            self.task.cancel()


async def test_endless_streaming_animation_is_bounded_only_by_the_total_timeout(
    runtime: BridgeApplication,
) -> None:
    """`.streaming-animation` sans fin : borné par la durée totale, jamais rejoué.

    Les heartbeats — sans contenu — réarment l'attente d'inactivité à chaque
    paquet, donc l'échéance atteinte doit être `bridge_total_timeout` et jamais
    `bridge_idle_timeout`. Aucun `done` fabriqué, aucun second prompt, aucun
    `abort` (qui cliquerait Stop dans ChatGPT).
    """
    extension = EndlessStreamingAnimationExtension(runtime, interval=0.05)

    chunks, failure, elapsed = await _generate(
        runtime,
        extension,
        "endless-streaming-animation",
        total_timeout=0.6,
        idle_timeout=0.2,
    )

    assert isinstance(failure, UpstreamError)
    assert failure.code == "bridge_total_timeout"
    assert "aucune donnée de l'extension" not in str(failure)
    assert elapsed >= 0.6
    # Les heartbeats ont bien tenu l'idle timeout en échec pendant tout le run.
    assert extension.beats >= 3
    # Aucun contenu n'a été rendu : un heartbeat n'est jamais une réponse.
    assert chunks == []
    prompts = [msg for msg in extension.sent if msg.get("type") == "prompt"]
    assert len(prompts) == 1, "la borne totale ne doit jamais rejouer le prompt"
    assert not [msg for msg in extension.sent if msg.get("type") == "abort"], (
        "aucun abort : cliquer Stop fabriquerait une fin de génération"
    )


class HiddenTabExtension:
    """Onglet masqué et sans focus, du premier heartbeat au `done` final.

    Reproduit le contrat d'autonomie côté serveur : la liveness et la fin
    arrivent d'une page qui n'a jamais été ramenée au premier plan. Le
    diagnostic joint est borné, typé et sans contenu.
    """

    PAGE_STATE = {
        "visibility_state": "hidden",
        "hidden": True,
        "has_focus": False,
        "started_visibility_state": "hidden",
        "started_hidden": True,
        "started_has_focus": False,
        "visible_transitions": 0,
        "focus_gains": 0,
        "visible_transitions_during_run": 0,
        "focus_gains_during_run": 0,
        "stable_observations": 4,
        "ms_since_dom_mutation": 40_000,
        "ms_since_observation": 0,
        "ms_since_heartbeat": 0,
        "wake_mutation": 12,
        "wake_tick": 31,
        "wake_timer": 5,
        # Champs hostiles : jamais retenus par le serveur.
        "answer_text": "réponse confidentielle",
        "visibility_state_extra": "visible",
    }

    def __init__(self, runtime: BridgeApplication, *, interval: float, beats: int) -> None:
        self.runtime = runtime
        self.interval = interval
        self.beats_target = beats
        self.beats = 0
        self.sent: list[dict[str, Any]] = []
        self.task: asyncio.Task[None] | None = None

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)
        if payload.get("type") == "prompt":
            self.task = asyncio.create_task(self._run(payload["id"]))

    async def _run(self, request_id: str) -> None:
        while self.beats < self.beats_target:
            await asyncio.sleep(self.interval)
            self.beats += 1
            self.runtime.bridge.dispatch(
                {
                    "type": "heartbeat",
                    "id": request_id,
                    "event_id": f"hb-{self.beats}",
                    "progress": {
                        "phase": "generating",
                        "output_chars": 12,
                        "stable_for_ms": 0,
                        "completion_signal": "streaming",
                        "completion_confidence": "high",
                        "page_state": dict(self.PAGE_STATE),
                    },
                }
            )
        self.runtime.bridge.dispatch(
            {
                "type": "done",
                "id": request_id,
                "event_id": "done",
                "text": "rapport final",
                "metadata": {
                    "completion_signal": "assistant_actions",
                    "completion_confidence": "high",
                    "stable_for_ms": 2_100,
                    "output_chars": len("rapport final"),
                    "visible_citation_count": 0,
                    "content_script_version": "31",
                    "page_state": dict(self.PAGE_STATE),
                },
            }
        )

    async def close(self, code: int, reason: str) -> None:
        del code, reason

    def stop(self) -> None:
        if self.task is not None:
            self.task.cancel()


async def test_hidden_unfocused_tab_completes_and_is_provably_autonomous(
    runtime: BridgeApplication,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Onglet masqué : le run aboutit, et les logs le prouvent objectivement.

    C'est la contrepartie serveur du test d'extension : la liveness et la fin
    viennent d'une page jamais focalisée, et `bridge_run_autonomy` permet de
    trancher après coup entre « a exigé un focus » et « terminé masqué ».
    """
    extension = HiddenTabExtension(runtime, interval=0.05, beats=4)

    with caplog.at_level(logging.INFO, logger="chatgpt_bridge"):
        chunks, failure, _ = await _generate(
            runtime, extension, "hidden-tab", total_timeout=3.0, idle_timeout=0.5
        )
    extension.stop()

    assert failure is None
    assert "".join(chunks) == "rapport final"
    assert extension.beats == 4
    # Un seul prompt : aucune resoumission n'a été provoquée par l'arrière-plan.
    assert len([msg for msg in extension.sent if msg.get("type") == "prompt"]) == 1

    autonomy = [
        record.getMessage()
        for record in caplog.records
        if record.getMessage().startswith("bridge_run_autonomy")
    ]
    assert len(autonomy) == 1
    assert "visibility_state=hidden" in autonomy[0]
    assert "has_focus=False" in autonomy[0]
    assert "started_visibility_state=hidden" in autonomy[0]
    assert "started_hidden=True" in autonomy[0]
    assert "started_has_focus=False" in autonomy[0]
    assert "focus_gains_during_run=0" in autonomy[0]
    assert "visible_transitions_during_run=0" in autonomy[0]
    assert "focus_gains=0" in autonomy[0]
    assert "visible_transitions=0" in autonomy[0]
    assert "wake_tick=31" in autonomy[0]
    # Aucun contenu ne fuit dans la télémétrie d'autonomie.
    assert "confidentielle" not in autonomy[0]


def test_page_state_diagnostics_are_bounded_and_content_free() -> None:
    from bridge.generation import _page_state

    state = _page_state(
        {
            "visibility_state": "hidden",
            "hidden": True,
            "has_focus": False,
            "started_visibility_state": "hidden",
            "started_hidden": True,
            "started_has_focus": False,
            "focus_gains": 2,
            "focus_gains_during_run": 2,
            "visible_transitions_during_run": 0,
            "stable_observations": 3,
            "ms_since_dom_mutation": 40_000,
            # Rejets attendus : hors domaine, hors borne, mauvais type, inconnu.
            "visible_transitions": -1,
            "wake_timer": 10**12,
            "wake_tick": True,
            "answer_text": "réponse confidentielle",
        }
    )

    assert state == {
        "visibility_state": "hidden",
        "hidden": True,
        "has_focus": False,
        "started_visibility_state": "hidden",
        "started_hidden": True,
        "started_has_focus": False,
        "focus_gains": 2,
        "focus_gains_during_run": 2,
        "visible_transitions_during_run": 0,
        "stable_observations": 3,
        "ms_since_dom_mutation": 40_000,
    }
    assert _page_state({"visibility_state": "focused"}) == {}
    assert _page_state("hidden") == {}
