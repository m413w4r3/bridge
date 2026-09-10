"""Routes OpenAI: responses, chat completions, models.

Encapsule les endpoints OpenAI sous un propriétaire explicite.
"""

import asyncio
import json
import logging
import time
import uuid
from typing import Any, AsyncIterator, Callable, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse

from bridge.contracts import (
    BridgeBrowserTarget,
    ChatRequest,
    ResponseRequest,
    RunControls,
)
from bridge.generation import (
    NeedsReviewError,
    UpstreamError,
    _BackgroundRequest,
    _response_body,
    _response_chat_request,
    _tokens,
    completion_body,
    parse_messages,
    run_generation,
    sse_chunk,
)
from bridge.registry import RunRegistry
from bridge.transport import Bridge
from bridge.ui import (
    UiUnavailable,
    cached_probe,
    fetch_ui_state,
    prepare_run,
    probed_ui_state,
)

logger = logging.getLogger("chatgpt_bridge")


def _browser_target_for_run(
    run_id: str, conversation: object | None
) -> BridgeBrowserTarget | None:
    """Construit une seule identité Chrome pour une génération stateless."""
    if conversation is not None:
        return None
    return BridgeBrowserTarget(id=f"bridge-run-{run_id}")


async def _release_browser_target(
    bridge: Bridge, target: BridgeBrowserTarget | None, run_id: str
) -> None:
    if target is None:
        return
    try:
        await bridge.send(
            {
                "type": "browser_target_release",
                "id": f"{run_id}:release",
                "browser_target": target.model_dump(mode="json"),
                "run_id": run_id,
            }
        )
    except Exception as exc:  # noqa: BLE001 - best effort après l'erreur initiale
        logger.warning(
            "bridge_browser_target_release_failed bridge_run_id=%s target_id=%s error=%s",
            run_id,
            target.id,
            type(exc).__name__,
        )


async def _retain_browser_target(
    bridge: Bridge, target: BridgeBrowserTarget | None, run_id: str
) -> None:
    """Tell the extension to retain an exact target for explicit recovery."""
    if target is None:
        return
    try:
        await bridge.send(
            {
                "type": "browser_target_retain",
                "id": f"{run_id}:retain",
                "browser_target": target.model_dump(mode="json"),
                "run_id": run_id,
            }
        )
    except Exception as exc:  # noqa: BLE001 - the original failure is authoritative
        logger.warning(
            "bridge_browser_target_retain_failed bridge_run_id=%s target_id=%s error=%s",
            run_id,
            target.id,
            type(exc).__name__,
        )


def _is_ambiguous_submission(exc: BaseException) -> bool:
    return getattr(exc, "submission_state", None) in {
        "submission_attempted",
        "post_submission",
    }


async def _release_browser_target_if_safe(
    bridge: Bridge,
    target: BridgeBrowserTarget | None,
    run_id: str,
    exc: BaseException,
) -> None:
    if _is_ambiguous_submission(exc):
        await _retain_browser_target(bridge, target, run_id)
    else:
        await _release_browser_target(bridge, target, run_id)


async def _release_browser_target_for_detail(
    bridge: Bridge,
    target: BridgeBrowserTarget | None,
    run_id: str,
    detail: dict[str, Any],
) -> None:
    if detail.get("submission_state") in {"submission_attempted", "post_submission"}:
        await _retain_browser_target(bridge, target, run_id)
    else:
        await _release_browser_target(bridge, target, run_id)


def _upstream_error_detail(exc: UpstreamError) -> dict[str, Any]:
    detail: dict[str, Any] = {
        "code": exc.code,
        "message": str(exc),
        "retryable": exc.retryable,
        "phase": exc.phase,
        "submission_state": exc.submission_state,
    }
    if exc.details:
        detail["details"] = exc.details
    return detail


def _http_exception_detail(exc: HTTPException) -> dict[str, Any]:
    """Keep typed bridge errors intact in the in-memory Responses cache."""
    if isinstance(exc.detail, dict):
        return dict(exc.detail)
    return {
        "code": "bridge_server_error",
        "message": str(exc.detail),
        "retryable": exc.status_code in {408, 429, 502, 503, 504},
    }


def _background_error_response(
    response_id: str, req: ResponseRequest, detail: dict[str, Any]
) -> dict[str, Any]:
    response = _response_body(
        response_id,
        req,
        status="failed",
        error=str(detail.get("message") or detail.get("code") or "bridge error"),
    )
    response["error"] = detail
    for key in ("phase", "submission_state"):
        value = detail.get(key)
        if isinstance(value, str):
            response["metadata"][key] = value
    return response


class OpenAIRoutes:
    """Propriétaire des quatre endpoints compatibles OpenAI.

    Ne détient aucun état métier propre au delà du cache local des réponses de
    fond : `bridge` et `registry` sont des instances injectées par
    BridgeApplication, `router` est l'APIRouter à monter sur l'application
    FastAPI.
    """

    def __init__(
        self,
        *,
        bridge: Bridge,
        registry: RunRegistry,
        auth_dependency: Callable[..., Any],
        ensure_accepting_runs: Callable[[], None],
    ) -> None:
        self.bridge = bridge
        self.registry = registry
        self.ensure_accepting_runs = ensure_accepting_runs
        # Les réponses de fond sont un cache de transport local, pas un état
        # canonique. PostgreSQL côté application conserve l'identité et le
        # statut du ModelRun.
        self.background_responses: Dict[str, dict] = {}
        self.background_tasks: Dict[str, asyncio.Task] = {}
        self.router = APIRouter(dependencies=[Depends(auth_dependency)])

        self.router.add_api_route(
            "/v1/responses",
            self.create_response,
            methods=["POST"],
        )
        self.router.add_api_route(
            "/v1/responses/{response_id}",
            self.retrieve_response,
            methods=["GET"],
        )
        self.router.add_api_route(
            "/v1/chat/completions",
            self.chat_completions,
            methods=["POST"],
        )
        self.router.add_api_route(
            "/v1/models",
            self.list_models,
            methods=["GET"],
        )

    async def _execute_background_response(
        self,
        response_id: str,
        req: ResponseRequest,
        controls: RunControls,
        allow_unverified_model: bool,
        browser_target: BridgeBrowserTarget | None,
    ) -> None:
        self.background_responses[response_id] = _response_body(
            response_id, req, status="in_progress"
        )
        try:
            async with self.bridge.slot:
                report = await prepare_run(
                    self.bridge,
                    controls,
                    allow_unverified_model=allow_unverified_model,
                    conversation=req.conversation,
                    browser_target=browser_target,
                )
                logger.info(
                    "bridge_run_phase bridge_run_id=%s phase=ui_controls_verified target_id=%s tab_id=%s",
                    response_id,
                    report.target_id,
                    report.tab_id,
                )
                chat_request = _response_chat_request(req)
                conversation_result: dict = {}
                extension_metadata: dict = {}
                parts = [
                    text
                    async for text in run_generation(
                        self.bridge,
                        self.registry,
                        response_id,
                        chat_request,
                        _BackgroundRequest(),
                        conversation=req.conversation,
                        browser_target=browser_target,
                        expected_tab_id=report.tab_id,
                        conversation_result=conversation_result,
                        extension_metadata=extension_metadata,
                    )
                ]
            self.background_responses[response_id] = _response_body(
                response_id,
                req,
                status="completed",
                output_text="".join(parts),
                run=report,
                conversation_result=conversation_result or None,
                extension_metadata=extension_metadata or None,
            )
        except NeedsReviewError as exc:
            await _retain_browser_target(self.bridge, browser_target, response_id)
            response = _response_body(
                response_id,
                req,
                status="needs_review",
                error="ChatGPT s'est arrêté sans réponse finale.",
            )
            response["error"] = {
                "code": exc.reason,
                "message": "ChatGPT s'est arrêté sans réponse finale.",
                "retryable": False,
                "phase": "generation",
                "submission_state": "post_submission",
                "details": exc.details,
            }
            response["metadata"].update(exc.details)
            response["metadata"]["reason"] = exc.reason
            response["metadata"]["submission_state"] = "post_submission"
            self.background_responses[response_id] = response
        except asyncio.CancelledError:
            await _retain_browser_target(self.bridge, browser_target, response_id)
            self.background_responses[response_id] = _background_error_response(
                response_id,
                req,
                {
                    "code": "bridge_server_error",
                    "message": "Le bridge a interrompu cette exécution pendant son arrêt.",
                    "retryable": False,
                    "phase": "shutdown",
                    "submission_state": "submission_attempted",
                },
            )
            raise
        except UpstreamError as exc:
            await _release_browser_target_if_safe(self.bridge, browser_target, response_id, exc)
            self.background_responses[response_id] = _background_error_response(
                response_id, req, _upstream_error_detail(exc)
            )
            print(f"⚠️  Réponse de fond {response_id} refusée : {exc}")
        except HTTPException as exc:
            # Preserve any structured code/phase/submission state; flattening
            # here would turn a typed UI timeout into an unrecoverable generic
            # bridge error.
            detail = _http_exception_detail(exc)
            await _release_browser_target_for_detail(
                self.bridge, browser_target, response_id, detail
            )
            self.background_responses[response_id] = _background_error_response(
                response_id, req, detail
            )
            print(f"⚠️  Réponse de fond {response_id} refusée : {exc.detail}")
        except Exception as exc:  # noqa: BLE001 - erreur publique nettoyée ci-dessous
            await _release_browser_target_if_safe(self.bridge, browser_target, response_id, exc)
            self.background_responses[response_id] = _response_body(
                response_id,
                req,
                status="failed",
                error="La génération via le bridge a échoué.",
            )
            print(f"⚠️  Réponse de fond {response_id} en échec : {type(exc).__name__}")
        finally:
            self.background_tasks.pop(response_id, None)

    async def create_response_internal(
        self,
        req: ResponseRequest,
        http_req: Request,
        controls: Optional[RunControls] = None,
        *,
        allow_unverified_model: bool = False,
        response_id: Optional[str] = None,
    ) -> dict:
        if req.stream:
            raise HTTPException(status_code=422, detail="Responses streaming non supporté")
        if not self.bridge.online:
            raise HTTPException(
                status_code=503,
                detail={
                    "code": "bridge_extension_disconnected",
                    "message": "Extension Chrome non connectée : ouvre un onglet chatgpt.com.",
                    "retryable": True,
                    "phase": "pre_submission",
                    "submission_state": "pre_submission",
                },
            )
        controls = controls or RunControls()
        response_id = response_id or f"resp_{uuid.uuid4().hex[:24]}"
        browser_target = _browser_target_for_run(response_id, req.conversation)
        # Valide immédiatement outils, entrées et schéma, avant de mettre en file.
        _response_chat_request(req)
        if req.background:
            self.background_responses[response_id] = _response_body(
                response_id, req, status="queued"
            )
            self.background_tasks[response_id] = asyncio.create_task(
                self._execute_background_response(
                    response_id,
                    req,
                    controls,
                    allow_unverified_model,
                    browser_target,
                )
            )
            return self.background_responses[response_id]
        # Les contrôles sont appliqués *dans* le slot : entre leur vérification
        # et la génération, aucune autre requête ne doit pouvoir rebasculer
        # l'interface.
        queued_at = time.monotonic()
        async with self.bridge.slot:
            logger.info(
                "bridge_run_phase bridge_run_id=%s phase=ui_controls target_id=%s queue_wait_ms=%s",
                response_id,
                browser_target.id if browser_target else None,
                int((time.monotonic() - queued_at) * 1000),
            )
            try:
                report = await prepare_run(
                    self.bridge,
                    controls,
                    allow_unverified_model=allow_unverified_model,
                    conversation=req.conversation,
                    browser_target=browser_target,
                )
                logger.info(
                    "bridge_run_phase bridge_run_id=%s phase=ui_controls_verified target_id=%s tab_id=%s",
                    response_id,
                    report.target_id,
                    report.tab_id,
                )
            except asyncio.CancelledError:
                await _retain_browser_target(self.bridge, browser_target, response_id)
                raise
            except Exception:
                await _release_browser_target(self.bridge, browser_target, response_id)
                raise
            chat_request = _response_chat_request(req)
            try:
                conversation_result: dict = {}
                extension_metadata: dict = {}
                parts = [
                    text
                    async for text in run_generation(
                        self.bridge,
                        self.registry,
                        response_id,
                        chat_request,
                        http_req,
                        conversation=req.conversation,
                        browser_target=browser_target,
                        expected_tab_id=report.tab_id,
                        conversation_result=conversation_result,
                        extension_metadata=extension_metadata,
                    )
                ]
            except asyncio.CancelledError:
                await _retain_browser_target(self.bridge, browser_target, response_id)
                raise
            except NeedsReviewError:
                await _retain_browser_target(self.bridge, browser_target, response_id)
                raise
            except UpstreamError as exc:
                await _release_browser_target_if_safe(
                    self.bridge, browser_target, response_id, exc
                )
                raise HTTPException(
                    status_code=502,
                    detail=_upstream_error_detail(exc),
                ) from exc
            except Exception as exc:  # noqa: BLE001 - cleanup before propagating
                await _release_browser_target_if_safe(
                    self.bridge, browser_target, response_id, exc
                )
                raise
        return _response_body(
            response_id,
            req,
            status="completed",
            output_text="".join(parts),
            run=report,
            conversation_result=conversation_result or None,
            extension_metadata=extension_metadata or None,
        )

    async def create_response(self, req: ResponseRequest, http_req: Request):
        """Façade de compatibilité ; préférer le contrat `/v1/bridge/*` en interne.

        Le champ `model` d'une requête Responses nomme un modèle de l'API
        OpenAI, pas une entrée du sélecteur de l'UI : il ne pilote donc rien
        ici. Seul l'outil `web_search` est traduit en réglage d'interface.
        """
        self.ensure_accepting_runs()
        web_search = any(str(tool.get("type", "")) == "web_search" for tool in req.tools)
        return await self.create_response_internal(
            req, http_req, RunControls(web_search=True if web_search else None)
        )

    async def retrieve_response(self, response_id: str):
        response = self.background_responses.get(response_id)
        if response is None:
            raise HTTPException(status_code=404, detail="Réponse de fond inconnue ou expirée")
        return response

    async def chat_completions(self, req: ChatRequest, http_req: Request):
        self.ensure_accepting_runs()
        if not self.bridge.online:
            raise HTTPException(
                status_code=503,
                detail={
                    "code": "bridge_extension_disconnected",
                    "message": "Extension Chrome non connectée : ouvre un onglet chatgpt.com.",
                    "retryable": True,
                    "phase": "pre_submission",
                    "submission_state": "pre_submission",
                },
            )

        cid = f"chatcmpl-{uuid.uuid4().hex[:24]}"
        created = int(time.time())
        prompt_tokens = _tokens(parse_messages(req.messages)[0])
        browser_target = _browser_target_for_run(cid, None)

        if req.stream:
            async def event_stream() -> AsyncIterator[str]:
                # Le verrou est pris ici (et pas dans le handler) : le
                # générateur s'exécute après le retour de l'endpoint.
                async with self.bridge.slot:
                    yield sse_chunk(
                        cid, req.model, created, {"role": "assistant", "content": ""}, None
                    )
                    try:
                        async for text in run_generation(
                            self.bridge,
                            self.registry,
                            cid,
                            req,
                            http_req,
                            browser_target=browser_target,
                        ):
                            yield sse_chunk(cid, req.model, created, {"content": text}, None)
                    except UpstreamError as exc:
                        await _release_browser_target_if_safe(
                            self.bridge, browser_target, cid, exc
                        )
                        err = {
                            "error": {
                                **_upstream_error_detail(exc),
                                "type": "bridge_error",
                            }
                        }
                        yield f"data: {json.dumps(err, ensure_ascii=False)}\n\n"
                        yield "data: [DONE]\n\n"
                        return
                    except NeedsReviewError as exc:
                        await _retain_browser_target(self.bridge, browser_target, cid)
                        err = {
                            "error": {
                                "code": exc.reason,
                                "message": "ChatGPT s'est arrêté sans réponse finale.",
                                "retryable": False,
                                "phase": "generation",
                                "submission_state": "post_submission",
                                "details": exc.details,
                                "type": "bridge_error",
                            }
                        }
                        yield f"data: {json.dumps(err, ensure_ascii=False)}\n\n"
                        yield "data: [DONE]\n\n"
                        return
                    except Exception as exc:  # noqa: BLE001 - cleanup before propagating
                        await _release_browser_target_if_safe(
                            self.bridge, browser_target, cid, exc
                        )
                        raise
                    yield sse_chunk(cid, req.model, created, {}, "stop")
                    yield "data: [DONE]\n\n"

            return StreamingResponse(
                event_stream(),
                media_type="text/event-stream",
                headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
            )

        async with self.bridge.slot:
            try:
                parts = [
                    text
                    async for text in run_generation(
                        self.bridge,
                        self.registry,
                        cid,
                        req,
                        http_req,
                        browser_target=browser_target,
                    )
                ]
            except UpstreamError as exc:
                await _release_browser_target_if_safe(
                    self.bridge, browser_target, cid, exc
                )
                raise HTTPException(
                    status_code=502, detail=_upstream_error_detail(exc)
                ) from exc
            except NeedsReviewError:
                await _retain_browser_target(self.bridge, browser_target, cid)
                raise
            except Exception as exc:  # noqa: BLE001 - cleanup before propagating
                await _release_browser_target_if_safe(self.bridge, browser_target, cid, exc)
                raise

        return completion_body(cid, req.model, created, "".join(parts), prompt_tokens)

    async def list_models(self, probe: bool = False):
        """Modèles du sélecteur ChatGPT quand ils sont connus, liste factice sinon.

        Énumérer les modèles impose d'ouvrir le menu de l'UI : ce n'est fait
        que sur `probe=true`, sinon on se contente d'une sonde récente déjà en
        cache.
        """
        now = int(time.time())
        state = None
        if probe:
            try:
                state = await probed_ui_state(self.bridge)
            except UiUnavailable:
                state = None
        else:
            state = cached_probe()

        disponibles = (state.model.available if state else None) or []
        # La liste des modèles bouge rarement, la sélection change à chaque
        # run : on relit celle-ci, sans toucher aux menus.
        selection = state.model.selected_id if state else None
        if disponibles:
            try:
                selection = (await fetch_ui_state(self.bridge)).model.selected_id or selection
            except UiUnavailable:
                pass

        entrees = [
            {
                "id": m["id"],
                "object": "model",
                "created": now,
                "owned_by": "chatgpt-web-ui",
                "label": m.get("label"),
                "selected": m["id"] == selection,
            }
            for m in disponibles
            if m.get("id")
        ]
        if entrees:
            return {"object": "list", "data": entrees, "source": "chatgpt_ui"}
        return {
            "object": "list",
            "data": [
                {"id": name, "object": "model", "created": now, "owned_by": "chatgpt-web"}
                for name in ("chatgpt-web", "gpt-4o", "gpt-5")
            ],
            "source": "static_fallback",
        }
