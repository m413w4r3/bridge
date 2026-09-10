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
from bridge.run_service import (
    DurableRunService,
    DurableRunSpec,
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
    # New durable results wrap the facade projection under `response`; accept
    # the previous `body` wrapper as well for rows created before the refactor.
    body = stored.get("body") or stored.get("response")
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

    La génération est déléguée au service durable commun aux façades. `bridge`
    et `registry` sont des instances injectées par BridgeApplication.
    """

    def __init__(
        self,
        *,
        bridge: Bridge,
        registry: RunRegistry,
        run_service: DurableRunService,
        auth_dependency: Callable[..., Any],
        ensure_accepting_runs: Callable[[], None],
    ) -> None:
        self.bridge = bridge
        self.run_service = run_service
        self.ensure_accepting_runs = ensure_accepting_runs
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

    @property
    def registry(self) -> RunRegistry:
        return self.run_service.registry

    @registry.setter
    def registry(self, value: RunRegistry) -> None:
        self.run_service.registry = value

    @property
    def idempotent_tasks(self):
        """Compatibility view; task ownership remains exclusively in service."""
        return self.run_service.task_map

    @property
    def bridge_metrics(self):
        return self.run_service.metrics

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
            bridge_ui_model=req.ui_model,
            bridge_profile=req.profile,
            allow_unverified_model=req.allow_unverified_model,
        )

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
        response_request = self._bridge_response_request(req).model_copy(
            update={"background": False}
        )
        spec = DurableRunSpec(
            response_request=response_request,
            chat_request=self.run_service._engine("_response_chat_request")(
                response_request
            ),
            controls=self._bridge_controls(req),
            allow_unverified_model=req.allow_unverified_model,
            # Preserve the historical native canonicalization exactly.
            hash_payload=req.model_dump(mode="json", exclude={"request_id"}),
        )
        snapshot = await self.run_service.submit(
            spec,
            idempotency_key=key,
            background=req.background,
            correlation_id=http_req.headers.get("X-Correlation-ID", "-")[:128],
        )
        if req.background and snapshot.state in {"queued", "running"}:
            return {"id": snapshot.response_id, "object": "response", "status": snapshot.state}
        body = snapshot.response_body()
        if body is not None:
            if snapshot.state == "failed":
                detail = snapshot.error_detail() or {}
                interrupted = (
                    detail.get("code") == "bridge_server_error"
                    and detail.get("phase") == "shutdown"
                )
                if not req.background and not interrupted:
                    raise HTTPException(
                        status_code=snapshot.status_code(),
                        detail=detail,
                    )
                return JSONResponse(status_code=snapshot.status_code(), content=body)
            return body
        return {"id": snapshot.response_id, "object": "response", "status": snapshot.state}

    async def retrieve_bridge_run(self, response_id: str):
        snapshot = self.run_service.retrieve(response_id)
        body = snapshot.response_body()
        if body is not None:
            if snapshot.state == "failed":
                return JSONResponse(status_code=snapshot.status_code(), content=body)
            return body
        return {
            "id": snapshot.response_id,
            "object": "response",
            "status": snapshot.state,
            "metadata": {
                "bridge_progress": generation_progress(snapshot.response_id),
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
        self.run_service.store_preview(response_id, preview)
        logger.info(
            "bridge_recovery_final_upgraded bridge_run_id=%s turn_id=%s sha256=%s",
            response_id,
            turn_id,
            digest,
        )
        return preview

    async def preview_visible_recovery(self, response_id: str):
        record = self.run_service.get_record(response_id)
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
            self.run_service.store_preview(response_id, preview)
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
        self.run_service.store_preview(response_id, preview)
        return preview

    async def release_visible_recovery(self, response_id: str):
        """Explicitement abandonner une target stateless conservée."""
        record = self.run_service.get_record(response_id)
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
            "active_runs": len(self.run_service.active_tasks),
            "extension_connected": self.bridge.online,
            "busy": self.bridge.slot.locked(),
        }
