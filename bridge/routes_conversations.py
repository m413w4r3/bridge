"""Routes conversation : ferme l'onglet local d'une conversation bridge.

Encapsule l'endpoint conversation sous un propriétaire explicite.
"""

import logging
import uuid
from collections.abc import Callable
from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from bridge.transport import Bridge
from bridge.ui import UiUnavailable, _ui_roundtrip

logger = logging.getLogger("chatgpt_bridge")

_ARCHIVE_NOT_FOUND_CODES = {
    "conversation_binding_missing",
    "conversation_tab_missing",
}


def _archive_message(packet: dict[str, Any], fallback: str) -> str:
    for field in ("message", "reason", "error"):
        value = packet.get(field)
        if isinstance(value, str) and value.strip():
            return " ".join(value.split())[:512]
    return fallback


def _archive_detail(
    conversation_id: uuid.UUID,
    *,
    packet: dict[str, Any] | None = None,
    error: UiUnavailable | None = None,
) -> dict[str, Any]:
    source = packet or {}
    code = source.get("code") if isinstance(source.get("code"), str) else None
    if code is None and error is not None:
        code = error.code
    code = code or "bridge_protocol_error"

    retryable = source.get("retryable")
    if not isinstance(retryable, bool) and error is not None:
        retryable = error.retryable
    if not isinstance(retryable, bool):
        retryable = False

    phase = source.get("phase")
    if not isinstance(phase, str) and error is not None:
        phase = error.phase
    phase = phase if isinstance(phase, str) else "conversation_archive"

    detail: dict[str, Any] = {
        "code": code[:64],
        "message": _archive_message(source, str(error) if error is not None else "Échec de fermeture de la conversation."),
        "retryable": retryable,
        "conversation_id": str(conversation_id),
        "phase": phase[:64],
    }
    for field in ("reason", "cause_code"):
        value = source.get(field)
        if isinstance(value, str) and value.strip():
            detail[field] = " ".join(value.split())[:256]
    if error is not None and isinstance(error.details, dict):
        source_details = error.details
    else:
        source_details = source.get("details")
    if isinstance(source_details, dict):
        # Only lifecycle identity is returned here. Prompt/DOM payloads must
        # never cross this endpoint as diagnostics.
        safe_details: dict[str, Any] = {}
        for field in ("tab_id", "window_id", "window_closed", "operation"):
            value = source_details.get(field)
            if isinstance(value, (bool, int, str)):
                safe_details[field] = value if not isinstance(value, str) else value[:128]
        if safe_details:
            detail["details"] = safe_details
    return detail


def _archive_status(detail: dict[str, Any]) -> int:
    code = detail["code"]
    if code in _ARCHIVE_NOT_FOUND_CODES:
        return 404
    if code == "conversation_registry_inconsistent":
        return 409
    if detail["retryable"] is True:
        return 503
    if code == "bridge_protocol_error":
        return 502
    return 500


class ConversationRoutes:
    """Propriétaire de l'endpoint conversation.

    Ne détient aucun état métier propre : `bridge` est une instance injectée
    par BridgeApplication, `router` est l'APIRouter à monter sur
    l'application FastAPI.
    """

    def __init__(
        self,
        *,
        bridge: Bridge,
        auth_dependency: Callable[..., Any],
    ) -> None:
        self.bridge = bridge
        self.router = APIRouter(dependencies=[Depends(auth_dependency)])

        self.router.add_api_route(
            "/v1/bridge/conversations/{conversation_id}",
            self.archive_bridge_conversation,
            methods=["DELETE"],
        )

    async def archive_bridge_conversation(self, conversation_id: uuid.UUID):
        # NOTE: this closes the exact live Temporary Chat browser session bound
        # to this conversation id — the extension resolves conversation_id to
        # its own tab binding (see background.js handleConversationArchive),
        # never to an external_locator/URL. It does not delete ChatGPT history:
        # every conversation the bridge opens fresh is put in ChatGPT's
        # "Temporary chat" mode by content.js's ensureTemporaryChat() before the
        # first prompt is sent, so it was never written to ChatGPT's own
        # history in the first place — closing the tab is the entire cleanup.
        # external_locator plays no part in this: identity here is
        # conversation_id -> tab binding only.
        logger.info("conversation_archive_requested conversation_id=%s", conversation_id)
        if not self.bridge.online:
            logger.warning(
                "conversation_archive_failed conversation_id=%s reason=extension_disconnected",
                conversation_id,
            )
            detail = _archive_detail(
                conversation_id,
                packet={
                    "code": "bridge_extension_disconnected",
                    "message": "Extension Chrome non connectée.",
                    "retryable": True,
                },
            )
            raise HTTPException(status_code=503, detail=detail)
        try:
            packet = await _ui_roundtrip(
                self.bridge,
                {"type": "conversation_archive", "conversation_id": str(conversation_id)},
            )
        except UiUnavailable as exc:
            detail = _archive_detail(conversation_id, error=exc)
            raise HTTPException(status_code=_archive_status(detail), detail=detail) from exc
        if packet.get("ok") is not True:
            detail = _archive_detail(conversation_id, packet=packet)
            logger.warning(
                "conversation_archive_failed conversation_id=%s code=%s retryable=%s phase=%s",
                conversation_id,
                detail["code"],
                detail["retryable"],
                detail["phase"],
            )
            raise HTTPException(status_code=_archive_status(detail), detail=detail)
        logger.info(
            "conversation_archive_completed conversation_id=%s close_state=%s",
            conversation_id,
            packet.get("close_state", "closed"),
        )
        result: dict[str, Any] = {
            "archived": True,
            "conversation_id": str(conversation_id),
            "close_state": packet.get("close_state", "closed"),
        }
        for field in ("tab_id", "window_id"):
            value = packet.get(field)
            if isinstance(value, int):
                result[field] = value
        return result
