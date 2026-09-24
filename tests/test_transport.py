"""Tests for `bridge/transport.py`: the WebSocket multiplexer and its
authentication gate in `bridge/app.py`."""

from __future__ import annotations

import asyncio
import json
import logging
import time

from starlette.websockets import WebSocketDisconnect

from bridge.app import BridgeApplication
from bridge.transport import Bridge, ExtensionIdentity


class FakeSocket:
    def __init__(self, packets: list[str] | None = None) -> None:
        self.query_params = {"token": "required-secret"}
        self.accepted = False
        self.closed: tuple[int, str] | None = None
        self.packets: asyncio.Queue[str | None] = asyncio.Queue()
        for packet in packets or []:
            self.packets.put_nowait(packet)

    async def accept(self) -> None:
        self.accepted = True

    async def receive_text(self) -> str:
        packet = await self.packets.get()
        if packet is None:
            raise WebSocketDisconnect(code=1000)
        return packet

    async def send_json(self, payload: dict) -> None:
        pass

    async def close(self, code: int, reason: str) -> None:
        self.closed = (code, reason)

    def feed(self, packet: dict) -> None:
        self.packets.put_nowait(json.dumps(packet))

    def disconnect(self) -> None:
        self.packets.put_nowait(None)


def identity(
    instance: str = "11111111-1111-4111-8111-111111111111",
    *,
    worker: str = "22222222-2222-4222-8222-222222222222",
    connection: str = "33333333-3333-4333-8333-333333333333",
) -> ExtensionIdentity:
    return ExtensionIdentity(instance, worker, connection, "extension-chrome", "1.0.0")


def hello(**changes: str) -> dict:
    packet = {
        "type": "hello",
        "client": "extension-chrome",
        "instance_id": "11111111-1111-4111-8111-111111111111",
        "worker_session_id": "22222222-2222-4222-8222-222222222222",
        "connection_id": "33333333-3333-4333-8333-333333333333",
        "extension_version": "1.0.0",
    }
    packet.update(changes)
    return packet


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


async def test_websocket_without_hello_stays_pending_then_times_out(
    runtime: BridgeApplication,
) -> None:
    runtime.websocket_endpoint.__globals__["WS_TOKEN"] = "required-secret"
    runtime.websocket_endpoint.__globals__["EXTENSION_HELLO_TIMEOUT"] = 0.01
    socket = FakeSocket()

    task = asyncio.create_task(runtime.websocket_endpoint(socket))
    for _ in range(10):
        await asyncio.sleep(0)
        if runtime.bridge.handshake_pending:
            break
    pending = await runtime.ready()
    assert pending.status_code == 503
    assert json.loads(pending.body)["status"] == "extension_handshake_pending"

    await task
    assert socket.closed == (4408, "hello_timeout")
    assert runtime.bridge.online is False


async def test_valid_hello_and_current_socket_pong_enable_readiness(
    runtime: BridgeApplication,
) -> None:
    runtime.websocket_endpoint.__globals__["WS_TOKEN"] = "required-secret"
    runtime.ready.__globals__["API_KEY"] = "private-http-secret"
    socket = FakeSocket([json.dumps(hello())])
    task = asyncio.create_task(runtime.websocket_endpoint(socket))
    for _ in range(10):
        await asyncio.sleep(0)
        if runtime.bridge.identified:
            break

    assert runtime.bridge.identified is True
    assert runtime.bridge.ready is True  # première fenêtre keepalive
    socket.feed({"type": "pong"})
    await asyncio.sleep(0)
    assert runtime.bridge.last_pong_at is not None
    ready = await runtime.ready()
    assert ready.status_code == 200
    assert json.loads(ready.body)["status"] == "extension_available"

    health = await runtime.health()
    rendered = json.dumps(health)
    assert "required-secret" not in rendered
    assert "private-http-secret" not in rendered
    assert "instance_id_prefix" in health
    assert health["extension_identified"] is True
    ready_body = ready.body.decode()
    assert "required-secret" not in ready_body
    assert "private-http-secret" not in ready_body
    socket.disconnect()
    await task


async def test_stale_pong_returns_503(runtime: BridgeApplication) -> None:
    socket = FakeSocket()
    assert await runtime.bridge.attach(socket, identity())
    runtime.bridge.last_pong_at = time.time() - 10_000

    ready = await runtime.ready()
    assert ready.status_code == 503
    assert json.loads(ready.body)["status"] == "extension_stale"


async def test_same_instance_worker_restart_replaces_stale_connection() -> None:
    bridge = Bridge()
    old = FakeSocket()
    new = FakeSocket()
    assert await bridge.attach(old, identity())
    bridge.last_pong_at = time.time() - 10_000

    replacement = identity(
        worker="44444444-4444-4444-8444-444444444444",
        connection="55555555-5555-4555-8555-555555555555",
    )
    assert await bridge.attach(new, replacement)
    assert old.closed == (4000, "replaced")
    assert bridge.ws is new
    assert bridge.worker_session_id == replacement.worker_session_id


async def test_different_healthy_instance_is_rejected_without_oscillation(
    runtime: BridgeApplication, caplog: pytest.LogCaptureFixture
) -> None:
    owner = FakeSocket()
    contender = FakeSocket()
    assert await runtime.bridge.attach(owner, identity())
    runtime.bridge.last_pong_at = time.time()
    caplog.set_level(logging.WARNING, logger="chatgpt_bridge")

    another = identity(
        instance="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        worker="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        connection="cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    )
    assert await runtime.bridge.attach(contender, another) is False
    assert runtime.bridge.ws is owner
    assert "extension_connection_conflict" in caplog.text
    assert "old_instance=11111111" in caplog.text
    assert "new_instance=aaaaaaaa" in caplog.text
    assert "same_instance=false" in caplog.text
    assert "required-secret" not in caplog.text
    assert runtime.bridge.readiness_status() == "extension_conflict"


async def test_different_instance_can_take_over_stale_owner() -> None:
    bridge = Bridge()
    old = FakeSocket()
    new = FakeSocket()
    assert await bridge.attach(old, identity())
    bridge.last_pong_at = time.time() - 10_000
    another = identity(instance="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")

    assert await bridge.attach(new, another)
    assert bridge.ws is new


async def test_old_socket_detach_does_not_clear_replacement() -> None:
    bridge = Bridge()
    old = FakeSocket()
    new = FakeSocket()
    assert await bridge.attach(old, identity())
    bridge.last_pong_at = time.time() - 10_000
    replacement = identity(worker="44444444-4444-4444-8444-444444444444")
    assert await bridge.attach(new, replacement)

    bridge.detach(old)
    assert bridge.ws is new
    assert bridge.connection_id == replacement.connection_id
    assert bridge.record_pong(old, identity().connection_id) is False


async def test_duplicate_websocket_event_is_dispatched_once() -> None:
    bridge = Bridge()
    queue = bridge.open_channel("run-1")
    packet = {"id": "run-1", "type": "heartbeat", "text": "x", "event_id": "event-1"}

    bridge.dispatch(packet)
    bridge.dispatch(packet)

    assert (await queue.get())["text"] == "x"
    assert queue.empty()
