"""Durable execution service shared by every generation facade.

Routes translate wire contracts and response formats.  This module owns the
SQLite claim, detached task, browser execution, terminal persistence and
shutdown semantics.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
import uuid
from dataclasses import dataclass
from typing import Any, Mapping

from fastapi import HTTPException

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
    _stable_external_turn_id,
    _visible_citations,
    run_generation,
)
from bridge.registry import RunRegistry
from bridge.transport import Bridge
from bridge.ui import prepare_run

logger = logging.getLogger("chatgpt_bridge")


@dataclass(frozen=True, slots=True)
class DurableRunSpec:
    """The two wire projections needed to execute one durable run."""

    response_request: ResponseRequest
    chat_request: ChatRequest
    controls: RunControls
    allow_unverified_model: bool
    hash_payload: Mapping[str, Any]


@dataclass(frozen=True, slots=True)
class RunSnapshot:
    record: dict[str, Any]
    result: dict[str, Any] | None = None

    @property
    def response_id(self) -> str:
        return str(self.record["bridge_run_id"])

    @property
    def state(self) -> str:
        return str(self.record["state"])

    @property
    def created(self) -> bool:
        return bool(self.record.get("_created", False))

    def response_body(self) -> dict[str, Any] | None:
        if not isinstance(self.result, dict):
            return None
        body = self.result.get("response")
        if isinstance(body, dict):
            return body
        # Accept the pre-refactor terminal representation while old rows are
        # still present in a registry that has not been reset.
        return self.result if self.result.get("id") else None

    def error_detail(self) -> dict[str, Any] | None:
        if not isinstance(self.result, dict):
            return None
        error = self.result.get("error")
        return error if isinstance(error, dict) else None

    def status_code(self) -> int:
        if isinstance(self.result, dict) and isinstance(self.result.get("status_code"), int):
            return int(self.result["status_code"])
        return 500


def request_hash(payload: Mapping[str, Any]) -> str:
    """Canonical hash used by all facades before the SQLite claim."""
    return hashlib.sha256(
        json.dumps(
            dict(payload), sort_keys=True, separators=(",", ":"), ensure_ascii=False
        ).encode()
    ).hexdigest()


def _browser_target_for_run(
    run_id: str, conversation: object | None
) -> BridgeBrowserTarget | None:
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
    except Exception as exc:  # noqa: BLE001 - cleanup is best effort
        logger.warning(
            "bridge_browser_target_release_failed bridge_run_id=%s target_id=%s error=%s",
            run_id,
            target.id,
            type(exc).__name__,
        )


async def _retain_browser_target(
    bridge: Bridge, target: BridgeBrowserTarget | None, run_id: str
) -> None:
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
    except Exception as exc:  # noqa: BLE001 - preserve the original failure
        logger.warning(
            "bridge_browser_target_retain_failed bridge_run_id=%s target_id=%s error=%s",
            run_id,
            target.id,
            type(exc).__name__,
        )


def _ambiguous(exc: BaseException) -> bool:
    return getattr(exc, "submission_state", None) in {
        "submission_attempted",
        "post_submission",
    }


def _upstream_detail(exc: UpstreamError) -> dict[str, Any]:
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


def _http_detail(exc: HTTPException) -> dict[str, Any]:
    if isinstance(exc.detail, dict):
        return dict(exc.detail)
    return {
        "code": "bridge_server_error",
        "message": str(exc.detail),
        "retryable": exc.status_code in {408, 429, 502, 503, 504},
    }


class DurableRunService:
    """Single owner of durable run execution and active asyncio tasks."""

    def __init__(self, *, bridge: Bridge, registry: RunRegistry) -> None:
        self.bridge = bridge
        self.registry = registry
        self._tasks: dict[str, asyncio.Task[RunSnapshot]] = {}
        self.metrics: dict[str, int] = {
            "runs_started": 0,
            "runs_completed": 0,
            "runs_failed": 0,
            "deduplication_hits": 0,
            "payload_conflicts": 0,
            "ui_timeouts": 0,
        }
        # A small compatibility seam for tests written against the old route
        # module. It never owns state or tasks; the service remains authoritative.
        self._compat_globals: dict[str, Any] | None = None
        self._compat_baseline: dict[str, Any] = {}

    @property
    def active_tasks(self) -> set[asyncio.Task[RunSnapshot]]:
        return set(self._tasks.values())

    @property
    def task_map(self) -> dict[str, asyncio.Task[RunSnapshot]]:
        return self._tasks

    def bind_compat_globals(self, namespace: dict[str, Any]) -> None:
        self._compat_globals = namespace
        self._compat_baseline = {
            name: namespace.get(name)
            for name in ("prepare_run", "run_generation", "_BackgroundRequest")
        }

    def _engine(self, name: str) -> Any:
        if self._compat_globals is not None:
            candidate = self._compat_globals.get(name)
            if candidate is not self._compat_baseline.get(name):
                return candidate
        return globals()[name]

    def _snapshot(self, record: dict[str, Any]) -> RunSnapshot:
        result: dict[str, Any] | None = None
        raw = record.get("response_json") if record.get("state") == "completed" else record.get("error_json")
        if isinstance(raw, str):
            try:
                parsed = json.loads(raw)
                if isinstance(parsed, dict):
                    result = parsed
            except json.JSONDecodeError:
                logger.warning("bridge_run_terminal_json_invalid bridge_run_id=%s", record.get("bridge_run_id"))
        return RunSnapshot(record, result)

    def retrieve(self, response_id: str) -> RunSnapshot:
        record = self.get_record(response_id)
        if record is None:
            raise HTTPException(status_code=404, detail="Run bridge inconnu ou expiré")
        return self._snapshot(record)

    def get_record(self, response_id: str) -> dict[str, Any] | None:
        """Resolve only the exact durable run id (or its exact retry key)."""
        record = self.registry.get_by_run_id(response_id)
        return record if record is not None else self.registry.get_by_idempotency_key(response_id)

    async def submit(
        self,
        spec: DurableRunSpec,
        *,
        idempotency_key: str | None,
        background: bool,
        correlation_id: str = "-",
    ) -> RunSnapshot:
        key = idempotency_key or f"non_retryable_{uuid.uuid4().hex}"
        payload_digest = request_hash(spec.hash_payload)
        record, created = self.registry.claim(key, payload_digest)
        run_id = str(record["bridge_run_id"])
        fingerprint = hashlib.sha256(key.encode()).hexdigest()[:12]
        if record["request_hash"] != payload_digest:
            self.metrics["payload_conflicts"] += 1
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
            self.metrics["deduplication_hits"] += 1
            logger.info(
                "bridge_run_deduplicated bridge_run_id=%s idempotency_fingerprint=%s state=%s",
                run_id,
                fingerprint,
                record["state"],
            )
            existing_task = self._tasks.get(run_id)
            if existing_task is not None and not background:
                return await asyncio.shield(existing_task)
            return self._snapshot(record)

        # The claim is durable before this task is scheduled. A lost HTTP
        # connection therefore cannot cancel it and a restart cannot replay it.
        task = asyncio.create_task(self._execute(spec, key, run_id, correlation_id))
        self._tasks[run_id] = task
        task.add_done_callback(self._consume_task_exception)
        if background:
            current = self.registry.get_by_run_id(run_id) or record
            return self._snapshot(current)
        return await asyncio.shield(task)

    async def wait(self, response_id: str) -> RunSnapshot:
        task = self._tasks.get(response_id)
        if task is not None:
            return await asyncio.shield(task)
        return self.retrieve(response_id)

    def store_preview(self, response_id: str, preview: dict[str, Any]) -> None:
        """Persist a recovery preview through the service boundary."""
        self.registry.store_preview(response_id, preview)

    def _consume_task_exception(self, task: asyncio.Task[RunSnapshot]) -> None:
        try:
            task.exception()
        except asyncio.CancelledError:
            pass

    def _canonical(
        self,
        run_id: str,
        body: dict[str, Any],
        *,
        output_text: str = "",
        error: dict[str, Any] | None = None,
        status_code: int | None = None,
    ) -> dict[str, Any]:
        result: dict[str, Any] = {
            "id": run_id,
            "status": body.get("status"),
            "output_text": output_text,
            "response": body,
        }
        if error is not None:
            result["error"] = error
        if status_code is not None:
            result["status_code"] = status_code
        return result

    def _error_body(
        self, run_id: str, spec: DurableRunSpec, detail: dict[str, Any]
    ) -> dict[str, Any]:
        body = _response_body(
            run_id,
            spec.response_request,
            status="failed",
            error=str(detail.get("message") or detail.get("code") or "bridge error"),
        )
        body["error"] = detail
        for key in ("phase", "submission_state"):
            if isinstance(detail.get(key), str):
                body["metadata"][key] = detail[key]
        return body

    def _store_incomplete_preview(
        self, spec: DurableRunSpec, run_id: str, exc: NeedsReviewError, target: BridgeBrowserTarget | None
    ) -> bool:
        candidate = exc.candidate
        if not candidate:
            return False
        conversation = (
            spec.response_request.conversation.model_dump(mode="json")
            if spec.response_request.conversation
            else None
        )
        preview = {
            "bridge_run_id": run_id,
            "target_id": target.id if target else None,
            "conversation_id": conversation.get("id") if conversation else None,
            "turn_id": candidate["turn_id"],
            "text": candidate["text"],
            "provenance": "captured_incomplete",
            "metadata": {
                "provenance": "captured_incomplete",
                "reason": exc.reason,
                "output_chars": candidate["output_chars"],
                "sha256": candidate["sha256"],
                "visible_citations": candidate["visible_citations"],
                "capture_confidence": "captured_incomplete",
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
            return True
        except Exception:  # noqa: BLE001 - needs_review remains authoritative
            logger.exception("bridge_incomplete_preview_not_persisted bridge_run_id=%s", run_id)
            return False

    async def _execute(
        self, spec: DurableRunSpec, key: str, run_id: str, correlation_id: str
    ) -> RunSnapshot:
        started = time.monotonic()
        target = _browser_target_for_run(run_id, spec.response_request.conversation)
        self.metrics["runs_started"] += 1
        self.registry.set_state(key, "running")
        logger.info(
            "bridge_run_started bridge_run_id=%s correlation_id=%s idempotency_fingerprint=%s",
            run_id,
            correlation_id,
            hashlib.sha256(key.encode()).hexdigest()[:12],
        )
        try:
            prepare = self._engine("prepare_run")
            generator = self._engine("run_generation")
            request_cls = self._engine("_BackgroundRequest")
            async with self.bridge.slot:
                report = await prepare(
                    self.bridge,
                    spec.controls,
                    allow_unverified_model=spec.allow_unverified_model,
                    conversation=spec.response_request.conversation,
                    browser_target=target,
                )
                conversation_result: dict[str, Any] = {}
                extension_metadata: dict[str, Any] = {}
                parts = [
                    text
                    async for text in generator(
                        self.bridge,
                        self.registry,
                        run_id,
                        spec.chat_request,
                        request_cls(),
                        conversation=spec.response_request.conversation,
                        browser_target=target,
                        expected_tab_id=report.tab_id,
                        conversation_result=conversation_result,
                        extension_metadata=extension_metadata,
                    )
                ]
            output_text = "".join(parts)
            body = _response_body(
                run_id,
                spec.response_request,
                status="completed",
                output_text=output_text,
                run=report,
                conversation_result=conversation_result or None,
                extension_metadata=extension_metadata or None,
            )
            canonical = self._canonical(run_id, body, output_text=output_text)
            self.registry.set_state(key, "completed", canonical)
            self.metrics["runs_completed"] += 1
            logger.info(
                "bridge_run_completed bridge_run_id=%s correlation_id=%s duration_ms=%s",
                run_id,
                correlation_id,
                int((time.monotonic() - started) * 1000),
            )
            return self.retrieve(run_id)
        except NeedsReviewError as exc:
            stored = self._store_incomplete_preview(spec, run_id, exc, target)
            exc.details["recovery_preview_available"] = stored
            detail = {
                "code": exc.reason,
                "message": "ChatGPT s'est arrêté sans réponse finale.",
                "retryable": False,
                "phase": "generation",
                "submission_state": "post_submission",
                "details": exc.details,
            }
            body = self._error_body(run_id, spec, detail)
            body["status"] = "needs_review"
            body["metadata"].update(exc.details)
            body["metadata"]["reason"] = exc.reason
            body["metadata"]["submission_state"] = "post_submission"
            canonical = self._canonical(run_id, body, error=detail)
            self.registry.set_state(key, "needs_review", canonical)
            self.metrics["runs_failed"] += 1
            return self.retrieve(run_id)
        except asyncio.CancelledError:
            detail = {
                "code": "bridge_server_error",
                "message": "Le bridge a interrompu cette exécution pendant son arrêt.",
                "retryable": False,
                "phase": "shutdown",
                "submission_state": "submission_attempted",
            }
            await asyncio.shield(
                _retain_browser_target(self.bridge, target, run_id)
                if target is not None
                else asyncio.sleep(0)
            )
            body = self._error_body(run_id, spec, detail)
            self.registry.set_state(
                key,
                "failed",
                self._canonical(run_id, body, error=detail, status_code=503),
            )
            self.metrics["runs_failed"] += 1
            raise
        except UpstreamError as exc:
            detail = _upstream_detail(exc)
            if _ambiguous(exc):
                await _retain_browser_target(self.bridge, target, run_id)
            else:
                await _release_browser_target(self.bridge, target, run_id)
            body = self._error_body(run_id, spec, detail)
            self.registry.set_state(
                key,
                "failed",
                self._canonical(run_id, body, error=detail, status_code=502),
            )
            self.metrics["runs_failed"] += 1
            return self.retrieve(run_id)
        except HTTPException as exc:
            detail = _http_detail(exc)
            if detail.get("submission_state") in {"submission_attempted", "post_submission"}:
                await _retain_browser_target(self.bridge, target, run_id)
            else:
                await _release_browser_target(self.bridge, target, run_id)
            body = self._error_body(run_id, spec, detail)
            self.registry.set_state(
                key,
                "failed",
                self._canonical(run_id, body, error=detail, status_code=exc.status_code),
            )
            self.metrics["runs_failed"] += 1
            return self.retrieve(run_id)
        except Exception as exc:  # noqa: BLE001 - durable public failure
            logger.exception("bridge_run_unexpected_failure bridge_run_id=%s", run_id)
            await _release_browser_target(self.bridge, target, run_id)
            detail = {
                "code": "bridge_server_error",
                "message": "La génération via le bridge a échoué.",
                "retryable": True,
            }
            body = self._error_body(run_id, spec, detail)
            self.registry.set_state(
                key,
                "failed",
                self._canonical(run_id, body, error=detail, status_code=500),
            )
            self.metrics["runs_failed"] += 1
            return self.retrieve(run_id)
        finally:
            current = asyncio.current_task()
            if current is not None and self._tasks.get(run_id) is current:
                self._tasks.pop(run_id, None)
