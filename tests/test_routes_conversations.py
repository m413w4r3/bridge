"""Tests for the exact Temporary Chat archive contract."""

from __future__ import annotations

from typing import Any
from uuid import UUID

import pytest
from fastapi import HTTPException

from bridge.routes_conversations import ConversationRoutes


class _Bridge:
    def __init__(self, packet: dict[str, Any] | None = None, *, online: bool = True) -> None:
        self.online = online
        self.packet = packet or {}
        self.requests: list[dict[str, Any]] = []

    async def request(self, payload: dict[str, Any], timeout: float) -> dict[str, Any]:
        del timeout
        self.requests.append(payload)
        return self.packet


def _routes(bridge: _Bridge) -> ConversationRoutes:
    return ConversationRoutes(bridge=bridge, auth_dependency=lambda: None)  # type: ignore[arg-type]


@pytest.mark.asyncio
async def test_archive_route_returns_success_only_for_an_explicit_ok_packet() -> None:
    conversation_id = UUID("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
    bridge = _Bridge(
        {
            "ok": True,
            "conversation_id": str(conversation_id),
            "close_state": "closed",
            "tab_id": 17,
            "window_id": 23,
        }
    )

    result = await _routes(bridge).archive_bridge_conversation(conversation_id)

    assert result == {
        "archived": True,
        "conversation_id": str(conversation_id),
        "close_state": "closed",
        "tab_id": 17,
        "window_id": 23,
    }
    assert bridge.requests == [
        {"type": "conversation_archive", "conversation_id": str(conversation_id)}
    ]


@pytest.mark.asyncio
async def test_archive_route_rejects_ok_false_and_keeps_structured_cause() -> None:
    conversation_id = UUID("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
    bridge = _Bridge(
        {
            "ok": False,
            "conversation_id": str(conversation_id),
            "code": "conversation_tab_close_failed",
            "message": "fermeture de l'onglet exact impossible",
            "retryable": True,
            "phase": "conversation_archive",
            "details": {"tab_id": 7, "window_id": 8, "prompt": "never copy"},
        }
    )

    with pytest.raises(HTTPException) as caught:
        await _routes(bridge).archive_bridge_conversation(conversation_id)

    assert caught.value.status_code == 503
    assert caught.value.detail == {
        "code": "conversation_tab_close_failed",
        "message": "fermeture de l'onglet exact impossible",
        "retryable": True,
        "conversation_id": str(conversation_id),
        "phase": "conversation_archive",
        "details": {"tab_id": 7, "window_id": 8},
    }


@pytest.mark.asyncio
async def test_archive_route_reports_disconnect_as_retryable() -> None:
    conversation_id = UUID("cccccccc-cccc-4ccc-8ccc-cccccccccccc")

    with pytest.raises(HTTPException) as caught:
        await _routes(_Bridge(online=False)).archive_bridge_conversation(conversation_id)

    assert caught.value.status_code == 503
    assert caught.value.detail == {
        "code": "bridge_extension_disconnected",
        "message": "Extension Chrome non connectée.",
        "retryable": True,
        "conversation_id": str(conversation_id),
        "phase": "conversation_archive",
    }
