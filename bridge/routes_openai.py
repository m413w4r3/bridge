"""HTTP adapters for the small OpenAI-compatible facade."""

import json
import time
import uuid
from typing import Any, AsyncIterator, Callable

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse

from bridge.contracts import ChatRequest, ResponseRequest, RunControls
from bridge.generation import (
    _BackgroundRequest,
    _response_chat_request,
    _tokens,
    completion_body,
    parse_messages,
    sse_chunk,
)
from bridge.registry import RunRegistry
from bridge.run_service import DurableRunService, DurableRunSpec, RunSnapshot
from bridge.transport import Bridge
from bridge.ui import UiUnavailable, cached_probe, fetch_ui_state, probed_ui_state


def _chat_response_request(req: ChatRequest) -> ResponseRequest:
    return ResponseRequest(
        model=req.model,
        input=[message.model_dump(mode="json") for message in req.messages],
    )


def _header(request: Request, name: str, default: str = "") -> str:
    # A few direct unit tests use a minimal ASGI scope without headers.
    try:
        return request.headers.get(name, default)
    except KeyError:
        return default


class OpenAIRoutes:
    """OpenAI-shaped adapters; durable execution belongs to `run_service`."""

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
        # Compatibility monkeypatch seam only; tasks/state remain in service.
        self.run_service.bind_compat_globals(globals())
        self.router = APIRouter(dependencies=[Depends(auth_dependency)])
        self.router.add_api_route("/v1/responses", self.create_response, methods=["POST"])
        self.router.add_api_route(
            "/v1/responses/{response_id}", self.retrieve_response, methods=["GET"]
        )
        self.router.add_api_route(
            "/v1/chat/completions", self.chat_completions, methods=["POST"]
        )
        self.router.add_api_route("/v1/models", self.list_models, methods=["GET"])

    @property
    def registry(self) -> RunRegistry:
        return self.run_service.registry

    @registry.setter
    def registry(self, value: RunRegistry) -> None:
        self.run_service.registry = value

    @property
    def background_tasks(self):
        """Read-only compatibility view; `DurableRunService` owns the map."""
        return self.run_service.task_map

    async def _execute_background_response(self, *_args: object, **_kwargs: object):
        """Legacy test seam; the service schedules the real worker."""
        response_id = str(_args[0]) if _args else str(_kwargs["response_id"])
        return await self.run_service.wait(response_id)

    def _online_or_fail(self) -> None:
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

    def _response_spec(
        self, req: ResponseRequest, controls: RunControls | None = None,
        *, allow_unverified_model: bool | None = None,
    ) -> DurableRunSpec:
        chat_request = _response_chat_request(req)
        tools = {str(tool.get("type", "")) for tool in req.tools}
        resolved_controls = controls or RunControls(
            # `model` is deliberately not used here: only this explicit
            # extension can select the ChatGPT UI model.
            model=req.bridge_ui_model,
            profile=req.bridge_profile,
            web_search=True if "web_search" in tools else None,
        )
        return DurableRunSpec(
            response_request=req,
            chat_request=chat_request,
            controls=resolved_controls,
            allow_unverified_model=(
                req.allow_unverified_model
                if allow_unverified_model is None
                else allow_unverified_model
            ),
            hash_payload=req.model_dump(mode="json"),
        )

    async def create_response_internal(
        self,
        req: ResponseRequest,
        http_req: Request,
        controls: RunControls | None = None,
        *,
        allow_unverified_model: bool = False,
        response_id: str | None = None,
    ) -> dict[str, Any]:
        """Compatibility entry point for callers of the old route API."""
        if req.stream:
            raise HTTPException(status_code=422, detail="Responses streaming non supporté")
        self.ensure_accepting_runs()
        self._online_or_fail()
        spec = self._response_spec(
            req, controls, allow_unverified_model=allow_unverified_model
        )
        snapshot = await self.run_service.submit(
            spec,
            idempotency_key=response_id,
            background=False,
            correlation_id=_header(http_req, "X-Correlation-ID", "-")[:128],
        )
        return self._response_body(snapshot)

    def _response_body(self, snapshot: RunSnapshot) -> dict[str, Any]:
        body = snapshot.response_body()
        if body is not None:
            return body
        return {
            "id": snapshot.response_id,
            "object": "response",
            "status": snapshot.state,
            "error": snapshot.error_detail(),
        }

    async def create_response(self, req: ResponseRequest, http_req: Request):
        self.ensure_accepting_runs()
        self._online_or_fail()
        spec = self._response_spec(req)
        snapshot = await self.run_service.submit(
            spec,
            idempotency_key=_header(http_req, "X-Idempotency-Key") or None,
            background=req.background,
            correlation_id=_header(http_req, "X-Correlation-ID", "-")[:128],
        )
        if req.background and snapshot.state in {"queued", "running"}:
            return {"id": snapshot.response_id, "object": "response", "status": snapshot.state}
        return self._response_body(snapshot)

    async def retrieve_response(self, response_id: str):
        return self._response_body(self.run_service.retrieve(response_id))

    async def chat_completions(self, req: ChatRequest, http_req: Request):
        self.ensure_accepting_runs()
        self._online_or_fail()
        prompt, _ = parse_messages(req.messages)
        spec = DurableRunSpec(
            response_request=_chat_response_request(req),
            chat_request=req,
            controls=RunControls(),
            allow_unverified_model=False,
            hash_payload=req.model_dump(mode="json"),
        )
        snapshot = await self.run_service.submit(
            spec,
            idempotency_key=_header(http_req, "X-Idempotency-Key") or None,
            background=req.stream,
            correlation_id=_header(http_req, "X-Correlation-ID", "-")[:128],
        )
        response_id = snapshot.response_id
        chat_id = "chatcmpl-" + response_id.removeprefix("resp_")
        created = int(time.time())
        prompt_tokens = _tokens(prompt)

        if req.stream:
            async def event_stream() -> AsyncIterator[str]:
                yield sse_chunk(chat_id, req.model, created, {"role": "assistant", "content": ""}, None)
                final = await self.run_service.wait(response_id)
                if final.state == "completed":
                    result = final.result or {}
                    yield sse_chunk(chat_id, req.model, created, {"content": result.get("output_text", "")}, None)
                    yield sse_chunk(chat_id, req.model, created, {}, "stop")
                else:
                    detail = final.error_detail() or {
                        "code": "bridge_server_error",
                        "message": "La génération via le bridge a échoué.",
                        "retryable": True,
                    }
                    yield f"data: {json.dumps({'error': {**detail, 'type': 'bridge_error'}}, ensure_ascii=False)}\n\n"
                yield "data: [DONE]\n\n"

            return StreamingResponse(
                event_stream(),
                media_type="text/event-stream",
                headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
            )

        if snapshot.state == "failed":
            raise HTTPException(status_code=snapshot.status_code(), detail=snapshot.error_detail())
        if snapshot.state == "needs_review":
            raise HTTPException(status_code=502, detail=snapshot.error_detail())
        result = snapshot.result or {}
        return completion_body(
            chat_id,
            req.model,
            created,
            str(result.get("output_text", "")),
            _tokens(prompt),
        )

    async def list_models(self, probe: bool = False):
        now = int(time.time())
        state = None
        if probe:
            try:
                state = await probed_ui_state(self.bridge)
            except UiUnavailable:
                state = None
        else:
            state = cached_probe()
        available = (state.model.available if state else None) or []
        selection = state.model.selected_id if state else None
        if available:
            try:
                selection = (await fetch_ui_state(self.bridge)).model.selected_id or selection
            except UiUnavailable:
                pass
        entries = [
            {
                "id": model["id"],
                "object": "model",
                "created": now,
                "owned_by": "chatgpt-web-ui",
                "label": model.get("label"),
                "selected": model["id"] == selection,
            }
            for model in available
            if model.get("id")
        ]
        if entries:
            return {"object": "list", "data": entries, "source": "chatgpt_ui"}
        return {
            "object": "list",
            "data": [
                {"id": name, "object": "model", "created": now, "owned_by": "chatgpt-web"}
                for name in ("chatgpt-web", "gpt-4o", "gpt-5")
            ],
            "source": "static_fallback",
        }
