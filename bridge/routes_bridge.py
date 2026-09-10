"""Routes natives du bridge: runs idempotents, recovery, UI, capabilities, métriques.

Encapsule les endpoints natifs du bridge sous un propriétaire explicite.
"""

import asyncio
import hashlib
import json
import logging
import time
import uuid
from typing import Any, Callable, Dict

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse

from bridge.config import UI_SNAPSHOT_STALE, UI_TIMEOUT
from bridge.contracts import (
    MODELES_NEUTRES,
    BridgeRunRequest,
    ResponseRequest,
    RunControls,
)
from bridge.generation import (
    NeedsReviewError,
    _BackgroundRequest,
    _stable_external_turn_id,
    _visible_citations,
    generation_progress,
)
from bridge.registry import RunRegistry
from bridge.routes_openai import (
    OpenAIRoutes,
    _browser_target_for_run,
    _release_browser_target,
)
from bridge.transport import Bridge
from bridge.ui import (
    UiUnavailable,
    apply_controls,
    fetch_ui_state,
    invalidate_probe_cache,
    probed_ui_state,
)

logger = logging.getLogger("chatgpt_bridge")


def _record_submission_state(record: dict[str, Any]) -> str | None:
    if record.get("state") == "needs_review":
        return "post_submission"
    body = _stored_error_body(record)
    if body is None:
        return None
    error = body.get("error") if isinstance(body, dict) else None
    if not isinstance(error, dict):
        return None
    state = error.get("submission_state")
    return state if state in {"submission_attempted", "post_submission"} else None


def _recovery_assistant_turn_id(record: dict[str, Any]) -> str | None:
    body = _stored_error_body(record)
    if body is None:
        return None
    error = body.get("error")
    details = error.get("details") if isinstance(error, dict) else None
    metadata = body.get("metadata")
    for source in (details, metadata):
        if not isinstance(source, dict):
            continue
        for key in ("initial_turn_id", "assistant_turn_id"):
            # Un placeholder d'interface ne désigne aucun tour : router une
            # capture dessus ne retrouverait jamais la réponse.
            value = _stable_external_turn_id(source.get(key))
            if value is not None:
                return value
    return None


def _stored_error_body(record: dict[str, Any]) -> dict[str, Any] | None:
    raw = record.get("error_json")
    if not isinstance(raw, str):
        return None
    try:
        stored = json.loads(raw)
    except json.JSONDecodeError:
        return None
    if not isinstance(stored, dict):
        return None
    body = stored.get("body")
    return body if isinstance(body, dict) else stored


CAPTURED_INCOMPLETE = "captured_incomplete"
LIVE_VERIFIED_FINAL = "live_verified_final"
VERIFIED_FINAL_CONFIDENCE = "verified_final"


def _durable_preview_document(
    record: dict[str, Any], response_id: str
) -> dict[str, Any] | None:
    """Document `preview_json` du registre, s'il décrit bien ce run."""
    raw = record.get("preview_json")
    if not isinstance(raw, str):
        return None
    try:
        stored = json.loads(raw)
    except json.JSONDecodeError:
        return None
    if not isinstance(stored, dict) or stored.get("bridge_run_id") != response_id:
        return None
    return stored


def _preview_with_provenance(
    candidate: object, response_id: str, provenance: str
) -> dict[str, Any] | None:
    if not isinstance(candidate, dict) or candidate.get("provenance") != provenance:
        return None
    if candidate.get("bridge_run_id") != response_id:
        return None
    text = candidate.get("text")
    if not isinstance(text, str) or not text.strip():
        return None
    return candidate


def _stored_verified_final_preview(
    record: dict[str, Any], response_id: str
) -> dict[str, Any] | None:
    """Réponse finale vérifiée déjà rendue durable pour ce run.

    Une fois écrite, elle est servie telle quelle : plus aucun aller-retour DOM
    n'est requis, et deux aperçus successifs renvoient les mêmes octets.
    """
    return _preview_with_provenance(
        _durable_preview_document(record, response_id), response_id, LIVE_VERIFIED_FINAL
    )


def _stored_incomplete_preview(
    record: dict[str, Any], response_id: str
) -> dict[str, Any] | None:
    """Candidat incomplet durable d'origine — repli, jamais préférence.

    Il reste lisible sans DOM, y compris après une promotion en finale vérifiée
    (il est alors conservé sous la clé `fallback` du même document durable).
    """
    stored = _durable_preview_document(record, response_id)
    if stored is None:
        return None
    direct = _preview_with_provenance(stored, response_id, CAPTURED_INCOMPLETE)
    if direct is not None:
        return direct
    return _preview_with_provenance(
        stored.get("fallback"), response_id, CAPTURED_INCOMPLETE
    )


def _bounded_recovery_metadata(packet: dict[str, Any]) -> dict[str, Any]:
    raw = packet.get("metadata")
    if not isinstance(raw, dict):
        return {}
    metadata: dict[str, Any] = {}
    citations = raw.get("visible_citations")
    if isinstance(citations, list):
        metadata["visible_citations"] = _visible_citations(citations[:50])
    for key, limit in (
        ("serializer_version", 64),
        ("completion_signal", 32),
        ("completion_confidence", 16),
        ("content_script_version", 64),
        ("capture_confidence", 32),
    ):
        value = raw.get(key)
        if isinstance(value, str):
            metadata[key] = value[:limit]
    output_chars = raw.get("output_chars")
    if isinstance(output_chars, int) and 0 <= output_chars <= 10_000_000:
        metadata["output_chars"] = output_chars
    return metadata


class BridgeRoutes:
    """Propriétaire des huit endpoints natifs du bridge (runs, recovery, UI).

    Dépend de `OpenAIRoutes` (pour déléguer la génération synchrone à
    `create_response_internal`), jamais l'inverse. `bridge` et `registry` sont
    des instances injectées par BridgeApplication.
    """

    def __init__(
        self,
        *,
        bridge: Bridge,
        registry: RunRegistry,
        openai_routes: OpenAIRoutes,
        auth_dependency: Callable[..., Any],
        ensure_accepting_runs: Callable[[], None],
    ) -> None:
        self.bridge = bridge
        self.registry = registry
        self.openai_routes = openai_routes
        self.ensure_accepting_runs = ensure_accepting_runs
        self.idempotent_tasks: Dict[str, asyncio.Task] = {}
        self.bridge_metrics: Dict[str, int] = {
            "runs_started": 0,
            "runs_completed": 0,
            "runs_failed": 0,
            "deduplication_hits": 0,
            "payload_conflicts": 0,
            "ui_timeouts": 0,
        }
        self.router = APIRouter(dependencies=[Depends(auth_dependency)])

        self.router.add_api_route(
            "/v1/bridge/runs",
            self.create_bridge_run,
            methods=["POST"],
        )
        self.router.add_api_route(
            "/v1/bridge/runs/{response_id}",
            self.retrieve_bridge_run,
            methods=["GET"],
        )
        self.router.add_api_route(
            "/v1/bridge/runs/{response_id}/recovery/visible",
            self.preview_visible_recovery,
            methods=["POST"],
        )
        self.router.add_api_route(
            "/v1/bridge/runs/{response_id}/recovery/release",
            self.release_visible_recovery,
            methods=["POST"],
        )
        self.router.add_api_route(
            "/v1/bridge/ui",
            self.bridge_ui_state,
            methods=["GET"],
        )
        self.router.add_api_route(
            "/v1/bridge/ui/controls",
            self.bridge_ui_controls,
            methods=["POST"],
        )
        self.router.add_api_route(
            "/v1/bridge/capabilities",
            self.bridge_capabilities,
            methods=["GET"],
        )
        self.router.add_api_route(
            "/v1/bridge/metrics",
            self.bridge_operational_metrics,
            methods=["GET"],
        )

    def _bridge_controls(self, req: BridgeRunRequest) -> RunControls:
        modele = (req.ui_model or "").strip()
        return RunControls(
            model=None if modele.lower() in MODELES_NEUTRES else modele,
            profile=req.profile,
            # `False` est volontaire : sans lui, une recherche web laissée active
            # dans l'UI polluerait tous les runs suivants à l'insu de l'appelant.
            web_search=req.web_search,
        )

    def _bridge_response_request(self, req: BridgeRunRequest) -> ResponseRequest:
        # `reasoning_effort` est conservé dans le contrat pour l'observabilité, mais
        # l'interface web ne permet pas encore de sélectionner ce réglage de façon fiable.
        return ResponseRequest(
            model=req.requested_model,
            input=req.input,
            tools=[{"type": "web_search"}] if req.web_search else [],
            text={"format": req.response_format} if req.response_format else None,
            background=req.background,
            conversation=req.conversation,
            bridge_recovery=req.recovery,
        )

    def _store_incomplete_preview(
        self, req: BridgeRunRequest, run_id: str, exc: NeedsReviewError
    ) -> bool:
        """Rendre durable la réponse visible jointe à un `incomplete`.

        Le candidat n'est jamais adopté ici : il devient seulement récupérable.
        Sa provenance (`captured_incomplete`) le distingue explicitement d'une
        relecture DOM ultérieure (`live_dom_capture`).

        Renvoie `True` uniquement si l'aperçu est réellement écrit dans le
        registre. Un échec de persistance ne casse pas le `needs_review` — il
        ne doit simplement jamais être annoncé comme une récupération durable.
        """
        candidate = exc.candidate
        if not candidate:
            return False
        conversation = req.conversation.model_dump(mode="json") if req.conversation else None
        target = _browser_target_for_run(run_id, req.conversation)
        preview = {
            "bridge_run_id": run_id,
            "target_id": target.id if target else None,
            "conversation_id": conversation.get("id") if conversation else None,
            # Identité externe vérifiée uniquement : un placeholder d'interface
            # a déjà été rejeté en amont, et rien ne le remplace.
            "turn_id": candidate["turn_id"],
            "text": candidate["text"],
            "provenance": CAPTURED_INCOMPLETE,
            "metadata": {
                "provenance": CAPTURED_INCOMPLETE,
                "reason": exc.reason,
                "output_chars": candidate["output_chars"],
                "sha256": candidate["sha256"],
                "visible_citations": candidate["visible_citations"],
                "capture_confidence": CAPTURED_INCOMPLETE,
                "external_turn_id_verified": candidate["turn_id"] is not None,
                **{
                    key: exc.details[key]
                    for key in (
                        "completion_signal",
                        "completion_confidence",
                        "stable_for_ms",
                        "serializer_version",
                        "content_script_version",
                        "streaming_signal_sources",
                        "submission_state",
                    )
                    if exc.details.get(key) is not None
                },
            },
        }
        try:
            self.registry.store_preview(run_id, preview)
        except Exception:  # noqa: BLE001 - l'état needs_review reste prioritaire
            logger.exception("bridge_incomplete_preview_not_persisted bridge_run_id=%s", run_id)
            return False
        logger.info(
            "bridge_incomplete_preview_persisted bridge_run_id=%s reason=%s output_chars=%s "
            "external_turn_id_verified=%s",
            run_id,
            exc.reason,
            candidate["output_chars"],
            candidate["turn_id"] is not None,
        )
        return True

    def _consume_task_exception(self, task: asyncio.Task) -> None:
        """Observe detached failures; the typed result already lives in SQLite."""
        try:
            task.exception()
        except asyncio.CancelledError:
            pass

    async def create_bridge_run(self, req: BridgeRunRequest, http_req: Request):
        self.ensure_accepting_runs()
        header_key = http_req.headers.get("X-Idempotency-Key")
        if header_key and req.request_id and header_key != req.request_id:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "bridge_payload_conflict",
                    "message": "L'en-tête et request_id ne concordent pas.",
                    "retryable": False,
                },
            )
        key = header_key or req.request_id or f"non_retryable_{uuid.uuid4().hex}"
        canonical = req.model_dump(mode="json", exclude={"request_id"})
        request_hash = hashlib.sha256(
            json.dumps(
                canonical, sort_keys=True, separators=(",", ":"), ensure_ascii=False
            ).encode()
        ).hexdigest()
        record, created = self.registry.claim(key, request_hash)
        fingerprint = hashlib.sha256(key.encode()).hexdigest()[:12]
        correlation_id = http_req.headers.get("X-Correlation-ID", "-")[:128]
        run_id = str(record["bridge_run_id"])
        if record["request_hash"] != request_hash:
            self.bridge_metrics["payload_conflicts"] += 1
            logger.warning(
                "bridge_payload_conflict bridge_run_id=%s idempotency_fingerprint=%s",
                run_id,
                fingerprint,
            )
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "bridge_payload_conflict",
                    "message": "Cette clé d'idempotence désigne un autre payload.",
                    "retryable": False,
                },
            )

        if not created:
            self.bridge_metrics["deduplication_hits"] += 1
            logger.info(
                "bridge_run_deduplicated bridge_run_id=%s idempotency_fingerprint=%s "
                "state=%s deduplication_hit=true",
                run_id,
                fingerprint,
                record["state"],
            )
            if record["state"] == "completed" and record["response_json"]:
                return json.loads(record["response_json"])
            if record["state"] == "needs_review" and record["error_json"]:
                return json.loads(record["error_json"])
            if record["state"] == "failed" and record["error_json"]:
                stored = json.loads(record["error_json"])
                return JSONResponse(status_code=stored["status_code"], content=stored["body"])

        async def execute_once() -> dict:
            started = time.monotonic()
            self.bridge_metrics["runs_started"] += 1
            self.registry.set_state(key, "running")
            logger.info(
                "bridge_run_started bridge_run_id=%s correlation_id=%s idempotency_fingerprint=%s phase=waiting_extension",
                run_id,
                correlation_id,
                fingerprint,
            )
            try:
                response = await self.openai_routes.create_response_internal(
                    # Le mode background du contrat natif est géré par ce registre
                    # SQLite. La façade Responses interne doit donc exécuter une
                    # seule génération synchrone dans cette tâche détachée.
                    self._bridge_response_request(req).model_copy(update={"background": False}),
                    _BackgroundRequest(),
                    self._bridge_controls(req),
                    allow_unverified_model=req.allow_unverified_model,
                    response_id=run_id,
                )
                self.registry.set_state(key, "completed", response)
                self.bridge_metrics["runs_completed"] += 1
                logger.info(
                    "bridge_run_completed bridge_run_id=%s correlation_id=%s idempotency_fingerprint=%s "
                    "duration_ms=%s phase=completed",
                    run_id,
                    correlation_id,
                    fingerprint,
                    int((time.monotonic() - started) * 1000),
                )
                return response
            except NeedsReviewError as exc:
                # Ordre imposé : le candidat visible est rendu durable AVANT que
                # le run passe en needs_review. L'onglet ChatGPT peut être fermé
                # dans la seconde qui suit la réponse HTTP ; l'aperçu de
                # récupération doit alors survivre sans aucun accès au DOM.
                stored = self._store_incomplete_preview(req, run_id, exc)
                # `recovery_preview_available` décrit la persistance, pas
                # l'observation : il ne passe à True qu'après une écriture
                # réussie dans le registre. `candidate_output_present` reste,
                # lui, le fait brut « un texte était visible ».
                exc.details["recovery_preview_available"] = stored
                body = {
                    "id": run_id,
                    "object": "response",
                    "status": "needs_review",
                    "error": {
                        "code": exc.reason,
                        "message": "ChatGPT s'est arrêté sans réponse finale.",
                        "retryable": False,
                        "phase": "generation",
                        "submission_state": "post_submission",
                        "details": exc.details,
                    },
                    "metadata": {
                        **exc.details,
                        "reason": exc.reason,
                        "submission_state": "post_submission",
                    },
                }
                self.registry.set_state(key, "needs_review", body)
                logger.warning(
                    "bridge_run_needs_review bridge_run_id=%s correlation_id=%s reason=%s",
                    run_id,
                    correlation_id,
                    exc.reason,
                )
                return body
            except asyncio.CancelledError:
                stored = {
                    "status_code": 503,
                    "body": {
                        "id": run_id,
                        "object": "response",
                        "status": "failed",
                        "error": {
                            "code": "bridge_server_error",
                            "message": "Le bridge a interrompu cette exécution pendant son arrêt.",
                            "retryable": False,
                            "phase": "shutdown",
                            "submission_state": "submission_attempted",
                        }
                    },
                }
                self.registry.set_state(key, "failed", stored)
                self.bridge_metrics["runs_failed"] += 1
                logger.warning(
                    "bridge_run_interrupted bridge_run_id=%s correlation_id=%s "
                    "idempotency_fingerprint=%s phase=shutdown",
                    run_id,
                    correlation_id,
                    fingerprint,
                )
                raise
            except HTTPException as exc:
                detail = exc.detail if isinstance(exc.detail, dict) else {
                    "code": "bridge_server_error",
                    "message": str(exc.detail),
                    "retryable": exc.status_code in {408, 429, 502, 503, 504},
                }
                stored = {
                    "status_code": exc.status_code,
                    "body": {"id": run_id, "status": "failed", "error": detail},
                }
                self.registry.set_state(key, "failed", stored)
                self.bridge_metrics["runs_failed"] += 1
                raise
            except Exception as exc:
                logger.exception("bridge_run_unexpected_failure bridge_run_id=%s", run_id)
                stored = {
                    "status_code": 500,
                    "body": {
                        "id": run_id,
                        "status": "failed",
                        "error": {
                            "code": "bridge_server_error",
                            "message": "La génération via le bridge a échoué.",
                            "retryable": True,
                        }
                    },
                }
                self.registry.set_state(key, "failed", stored)
                self.bridge_metrics["runs_failed"] += 1
                raise HTTPException(status_code=500, detail=stored["body"]["error"]) from exc
            finally:
                self.idempotent_tasks.pop(run_id, None)

        task = self.idempotent_tasks.get(run_id)
        if task is None:
            # Une déconnexion HTTP ne doit ni annuler ni resoumettre un clic coûteux.
            task = asyncio.create_task(execute_once())
            self.idempotent_tasks[run_id] = task
            task.add_done_callback(self._consume_task_exception)
        if req.background:
            # Le client reprend exclusivement par GET. Le résultat final sera écrit
            # par execute_once dans SQLite, même si cette requête HTTP disparaît.
            current = self.registry.get_by_run_id(run_id) or record
            return {
                "id": run_id,
                "object": "response",
                "status": current["state"],
            }
        return await asyncio.shield(task)

    async def retrieve_bridge_run(self, response_id: str):
        record = self.registry.get_by_run_id(response_id)
        if record is None:
            # A caller that lost the POST response only has the exact
            # idempotency key (`<model-run-uuid>:aN`). Resolve that key in the
            # same durable registry; never infer a run from UI state.
            record = self.registry.get_by_idempotency_key(response_id)
        if record is None:
            raise HTTPException(status_code=404, detail="Run bridge inconnu ou expiré")
        bridge_run_id = str(record["bridge_run_id"])
        if record["state"] == "completed" and record["response_json"]:
            return json.loads(record["response_json"])
        if record["state"] == "needs_review" and record["error_json"]:
            return json.loads(record["error_json"])
        if record["state"] == "failed" and record["error_json"]:
            stored = json.loads(record["error_json"])
            return JSONResponse(status_code=stored["status_code"], content=stored["body"])
        return {
            "id": bridge_run_id,
            "object": "response",
            "status": record["state"],
            "metadata": {
                "bridge_progress": generation_progress(bridge_run_id),
            },
        }

    async def _live_verified_final_upgrade(
        self,
        record: dict[str, Any],
        response_id: str,
        incomplete: dict[str, Any],
    ) -> dict[str, Any] | None:
        """Relire, en lecture seule, la finale du MÊME tour ChatGPT.

        Strictement optionnel : tout doute (cible perdue, tour absent, identité
        externe différente, finalité non explicite, texte instable entre les
        deux lectures, persistance impossible) renvoie `None`, et l'appelant
        sert alors le candidat incomplet durable. Aucun prompt, aucun clic,
        aucune mutation du DOM n'est possible depuis ce chemin : le seul
        message émis est `recovery_capture`, une capture en lecture seule.
        """
        if record.get("state") not in {"needs_review", "failed"}:
            return None
        # Identité externe exacte obligatoire : sans tour attendu vérifié, rien
        # ne prouve que la finale lue est bien la suite de ce candidat.
        expected_turn_id = _stable_external_turn_id(
            incomplete.get("turn_id")
        ) or _recovery_assistant_turn_id(record)
        if expected_turn_id is None:
            return None

        conversation: dict[str, Any] | None = None
        target = None
        raw_conversation = record.get("conversation_json")
        if raw_conversation:
            loaded = json.loads(raw_conversation)
            if not isinstance(loaded, dict) or not loaded.get("id"):
                return None
            conversation = loaded
            request: dict[str, Any] = {
                "type": "recovery_capture",
                "conversation": conversation,
                "assistant_turn_id": expected_turn_id,
            }
        else:
            if _record_submission_state(record) is None:
                return None
            target = _browser_target_for_run(response_id, None)
            if target is None:
                return None
            request = {
                "type": "recovery_capture",
                "bridge_run_id": response_id,
                "browser_target": target.model_dump(mode="json"),
                "assistant_turn_id": expected_turn_id,
            }

        packet = await self.bridge.request(request, timeout=UI_TIMEOUT)
        if not isinstance(packet, dict) or packet.get("error") or packet.get("code"):
            return None
        if target is not None:
            if (
                packet.get("target_id") != target.id
                or packet.get("bridge_run_id") != response_id
            ):
                return None
        elif conversation is not None:
            if packet.get("conversation_id") != conversation.get("id"):
                return None
        turn_id = _stable_external_turn_id(packet.get("turn_id"))
        if turn_id is None or turn_id != expected_turn_id:
            return None
        text = packet.get("text")
        if not isinstance(text, str) or not text.strip():
            return None
        metadata = _bounded_recovery_metadata(packet)
        # Promouvoir un `captured_incomplete` exige une finalité explicite :
        # un état de complétion inconnu ne suffit pas.
        if metadata.get("capture_confidence") != VERIFIED_FINAL_CONFIDENCE:
            return None
        if metadata.get("completion_signal") == "streaming":
            return None

        digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
        superseded = incomplete.get("metadata")
        superseded_sha = superseded.get("sha256") if isinstance(superseded, dict) else None
        preview = {
            "bridge_run_id": response_id,
            "target_id": target.id if target is not None else None,
            "conversation_id": conversation.get("id") if conversation else None,
            "external_locator": (
                conversation.get("external_locator") if conversation else None
            ),
            "turn_id": turn_id,
            "text": text,
            "provenance": LIVE_VERIFIED_FINAL,
            "metadata": {
                **metadata,
                "provenance": LIVE_VERIFIED_FINAL,
                "capture_confidence": VERIFIED_FINAL_CONFIDENCE,
                # Empreinte calculée côté bridge, jamais reprise du DOM.
                "sha256": digest,
                "external_turn_id_verified": True,
                "upgraded_from": CAPTURED_INCOMPLETE,
                **(
                    {"superseded_sha256": superseded_sha}
                    if isinstance(superseded_sha, str)
                    else {}
                ),
            },
            # Le candidat incomplet d'origine reste durable pour l'audit et
            # comme repli : la promotion ne détruit jamais ses octets.
            "fallback": incomplete,
        }
        self.registry.store_preview(response_id, preview)
        logger.info(
            "bridge_recovery_final_upgraded bridge_run_id=%s turn_id=%s sha256=%s",
            response_id,
            turn_id,
            digest,
        )
        return preview

    async def preview_visible_recovery(self, response_id: str):
        record = self.registry.get_by_run_id(response_id)
        if record is None:
            raise HTTPException(status_code=404, detail="Run bridge inconnu")
        # Une finale vérifiée déjà durable est définitive : elle est servie sans
        # aucune dépendance au navigateur et ne peut plus régresser.
        final = _stored_verified_final_preview(record, response_id)
        if final is not None:
            return final
        # Un candidat capturé au moment du `incomplete` est durable mais
        # obsolète dès que le MÊME tour ChatGPT se termine. On tente donc une
        # relecture finale en lecture seule, et on retombe sur lui à la moindre
        # incertitude — l'onglet peut avoir disparu, l'extension être
        # déconnectée : la réponse visible reste récupérable.
        stored = _stored_incomplete_preview(record, response_id)
        if stored is not None:
            try:
                upgraded = await self._live_verified_final_upgrade(
                    record, response_id, stored
                )
            except Exception:  # noqa: BLE001 - le repli durable reste prioritaire
                logger.warning(
                    "bridge_recovery_final_upgrade_unavailable bridge_run_id=%s",
                    response_id,
                    exc_info=True,
                )
                upgraded = None
            return upgraded if upgraded is not None else stored
        if not record.get("conversation_json"):
            target = _browser_target_for_run(response_id, None)
            if (
                target is None
                or record["state"] not in {"needs_review", "failed"}
                or _record_submission_state(record) is None
            ):
                raise HTTPException(status_code=409, detail="Run stateless non récupérable")
            packet = await self.bridge.request(
                {
                    "type": "recovery_capture",
                    "bridge_run_id": response_id,
                    "browser_target": target.model_dump(mode="json"),
                    "assistant_turn_id": _recovery_assistant_turn_id(record),
                },
                timeout=UI_TIMEOUT,
            )
            if packet.get("error") or packet.get("code"):
                raise HTTPException(
                    status_code=404,
                    detail={
                        "code": packet.get("code") or "recovery_answer_unavailable",
                        "message": str(packet.get("error") or packet.get("code")),
                    },
                )
            if (
                packet.get("target_id") != target.id
                or packet.get("bridge_run_id") != response_id
            ):
                raise HTTPException(
                    status_code=409,
                    detail="Cible ou run de recovery incohérent",
                )
            turn_id = _stable_external_turn_id(packet.get("turn_id"))
            if turn_id is None:
                raise HTTPException(
                    status_code=409,
                    detail="Identifiant externe du tour de recovery absent ou invalide",
                )
            text = packet.get("text")
            if not isinstance(text, str) or not text.strip():
                raise HTTPException(status_code=404, detail="Aucune réponse finale récupérable")
            metadata = _bounded_recovery_metadata(packet)
            metadata["provenance"] = "live_dom_capture"
            preview = {
                "bridge_run_id": response_id,
                "target_id": target.id,
                "turn_id": turn_id,
                "text": text,
                "provenance": "live_dom_capture",
                "metadata": metadata,
            }
            self.registry.store_preview(response_id, preview)
            return preview

        if (
            record["state"] not in {
                "running",
                "needs_review",
                "completed",
                "failed",
            }
            or not record.get("conversation_json")
        ):
            raise HTTPException(status_code=409, detail="Run non récupérable")

        conversation = json.loads(record["conversation_json"])
        packet = await self.bridge.request(
            {
                "type": "recovery_capture",
                "conversation": conversation,
            },
            timeout=UI_TIMEOUT,
        )
        if packet.get("error"):
            raise HTTPException(
                status_code=404,
                detail={
                    "code": "recovery_answer_unavailable",
                    "message": str(packet["error"]),
                },
            )
        # L'identité de récupération est conversation_id -> binding d'onglet
        # exact (résolu côté extension) : external_locator n'y participe pas,
        # ce n'est qu'une métadonnée diagnostique portée par la conversation.
        if packet.get("conversation_id") != conversation.get("id"):
            raise HTTPException(status_code=409, detail="Conversation de récupération incohérente")
        text = packet.get("text")
        if not isinstance(text, str) or not text.strip():
            raise HTTPException(status_code=404, detail="Aucune réponse finale récupérable")
        live_metadata = (
            dict(packet["metadata"]) if isinstance(packet.get("metadata"), dict) else {}
        )
        live_metadata["provenance"] = "live_dom_capture"
        preview = {
            "bridge_run_id": response_id,
            "conversation_id": conversation["id"],
            "external_locator": conversation.get("external_locator"),
            "turn_id": _stable_external_turn_id(packet.get("turn_id")),
            "text": text,
            "provenance": "live_dom_capture",
            "metadata": live_metadata,
        }
        self.registry.store_preview(response_id, preview)
        return preview

    async def release_visible_recovery(self, response_id: str):
        """Explicitement abandonner une target stateless conservée."""
        record = self.registry.get_by_run_id(response_id)
        if record is None:
            raise HTTPException(status_code=404, detail="Run bridge inconnu")
        target = (
            _browser_target_for_run(response_id, None)
            if not record.get("conversation_json")
            else None
        )
        if target is None:
            raise HTTPException(status_code=409, detail="Ce run ne possède pas de target stateless")
        await _release_browser_target(self.bridge, target, response_id)
        return {
            "bridge_run_id": response_id,
            "target_id": target.id,
            "released": True,
        }

    async def bridge_ui_state(self, probe: bool = False, fresh: bool = False):
        """État pilotable de l'onglet ChatGPT, tel que le content script le relit.

        `probe=true` ouvre les menus pour énumérer modèles et profils : c'est visible
        à l'écran, et la génération en cours est attendue avant de le faire.
        """
        try:
            state = await (
                probed_ui_state(self.bridge, fresh) if probe else fetch_ui_state(self.bridge)
            )
        except UiUnavailable as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        return state.model_dump()

    async def bridge_ui_controls(self, controls: RunControls):
        """Applique des réglages hors run (ex. fixer le profil une fois pour toutes)."""
        if not controls.wanted():
            raise HTTPException(status_code=422, detail="Aucun contrôle demandé")
        async with self.bridge.slot:
            try:
                outcomes, state = await apply_controls(self.bridge, controls)
            except UiUnavailable as exc:
                raise HTTPException(status_code=503, detail=str(exc)) from exc
        # La sonde en cache décrit un état désormais périmé.
        invalidate_probe_cache()
        return {
            "ok": all(o.ok for o in outcomes.values()),
            "applied": {name: o.model_dump() for name, o in outcomes.items()},
            "state": state.model_dump() if state else None,
        }

    async def bridge_capabilities(self, probe: bool = False, fresh: bool = False):
        """Capacités réelles, y compris l'état vérifié des contrôles d'interface.

        Sans `probe`, l'état est lu sans toucher à l'UI : le modèle sélectionné est
        connu, mais pas la liste des modèles disponibles.
        """
        if probe:
            try:
                state = await probed_ui_state(self.bridge, fresh)
            except UiUnavailable as exc:
                code = (
                    "bridge_ui_timeout" if "après" in str(exc) else "bridge_extension_disconnected"
                )
                if code == "bridge_ui_timeout":
                    self.bridge_metrics["ui_timeouts"] += 1
                raise HTTPException(
                    status_code=504 if code == "bridge_ui_timeout" else 503,
                    detail={"code": code, "message": str(exc), "retryable": True},
                ) from exc
        else:
            # Chemin critique : strictement aucun aller-retour WebSocket/DOM.
            state = self.bridge.last_ui_state

        observed_at = self.bridge.last_ui_at or (state.observed_at if state else None)
        age = max(0.0, time.time() - observed_at) if observed_at else None
        stale = age is None or age > UI_SNAPSHOT_STALE

        model_ok = bool(state and state.model.supported and state.model.verified)
        search_ok = bool(state and state.web_search.supported and state.web_search.verified)
        return {
            "transport": "chatgpt_web_ui",
            "extension_connected": self.bridge.online,
            "serialization": "single_request",
            "text": True,
            "new_chat": True,
            "web_search": "ui_toggle" if search_ok else "prompt_instructed",
            "structured_output": "prompt_and_client_validation",
            "background": "asynchronous_durable_result",
            "streaming": "final_delta_only",
            # Vrai seulement quand le libellé du sélecteur a pu être relu : c'est le
            # modèle *affiché* par l'UI, pas le snapshot exact servi par OpenAI.
            "actual_model_version": model_ok,
            "native_usage": False,
            "binary_allowed_for_cti_gateway": False,
            "controls": {
                "model_selection": "verified" if model_ok else "unavailable",
                "profile_selection": (
                    "verified"
                    if state and state.profile.supported and state.profile.verified
                    else "unavailable"
                ),
                "web_search_toggle": "verified" if search_ok else "unavailable",
                "reasoning_effort": "unavailable",
                "verification": "dom_readback",
            },
            "ui": {
                "available": state is not None,
                "state": state.model_dump() if state else None,
                "observed_at": observed_at,
                "age_seconds": age,
                "stale": stale,
                "reason": None if state else "snapshot indisponible",
            },
        }

    async def bridge_operational_metrics(self):
        """Compteurs bornés, sans labels issus des prompts ou des secrets."""
        return {
            **self.bridge_metrics,
            "websocket_reconnections": self.bridge.reconnections,
            "active_runs": len(self.idempotent_tasks),
            "extension_connected": self.bridge.online,
            "busy": self.bridge.slot.locked(),
        }
