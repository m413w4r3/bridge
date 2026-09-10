"""Tests for `bridge/transport.py`: the WebSocket multiplexer and its
authentication gate in `bridge/app.py`."""

from __future__ import annotations

from bridge.app import BridgeApplication
from bridge.transport import Bridge


async def test_websocket_without_pairing_token_is_rejected(runtime: BridgeApplication) -> None:
    runtime.websocket_endpoint.__globals__["WS_TOKEN"] = "required-secret"

    class UnauthenticatedSocket:
        def __init__(self) -> None:
            self.query_params: dict[str, str] = {}
            self.accepted = False
            self.closed: tuple[int, str] | None = None

        async def accept(self) -> None:
            self.accepted = True

        async def close(self, code: int, reason: str) -> None:
            self.closed = (code, reason)

    socket = UnauthenticatedSocket()
    await runtime.websocket_endpoint(socket)

    assert socket.accepted is False
    assert socket.closed == (4401, "authentication required")


async def test_duplicate_websocket_event_is_dispatched_once() -> None:
    bridge = Bridge()
    queue = bridge.open_channel("run-1")
    packet = {"id": "run-1", "type": "heartbeat", "text": "x", "event_id": "event-1"}

    bridge.dispatch(packet)
    bridge.dispatch(packet)

    assert (await queue.get())["text"] == "x"
    assert queue.empty()
