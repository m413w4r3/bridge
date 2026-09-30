"""Tests for `bridge/app.py`: readiness, startup logging, and shutdown."""

from __future__ import annotations

import asyncio
import json
import logging
import time
from pathlib import Path

import pytest
from conftest import FakeExtension, isolated_registry, request_with_key

from bridge.app import BridgeApplication
from bridge.contracts import BridgeRunRequest
from bridge.transport import ExtensionIdentity


async def test_ready_distinguishes_incomplete_absent_and_available_states(
    runtime: BridgeApplication,
) -> None:
    globals_ = runtime.ready.__globals__
    globals_["HOST"] = "0.0.0.0"
    globals_["API_KEY"] = None
    globals_["WS_TOKEN"] = None
    runtime.bridge.ws = None

    incomplete = await runtime.ready()
    incomplete_body = json.loads(incomplete.body)
    assert incomplete.status_code == 503
    assert incomplete_body["status"] == "configuration_incomplete"
    assert incomplete_body["server_operational"] is True
    assert incomplete_body["configuration"]["http_auth"] == "absent"
    assert incomplete_body["configuration"]["websocket_token"] == "absent"

    globals_["API_KEY"] = "not-logged-http-secret"
    globals_["WS_TOKEN"] = "not-logged-websocket-secret"
    absent = await runtime.ready()
    assert absent.status_code == 503
    assert json.loads(absent.body)["status"] == "extension_absent"

    await runtime.bridge.attach(
        FakeExtension(runtime),
        ExtensionIdentity(
            instance_id="11111111-1111-4111-8111-111111111111",
            worker_session_id="22222222-2222-4222-8222-222222222222",
            connection_id="33333333-3333-4333-8333-333333333333",
            client_name="extension-chrome",
            extension_version="1.0.0",
        ),
    )
    available = await runtime.ready()
    assert available.status_code == 200
    assert json.loads(available.body)["status"] == "extension_available"


async def test_startup_reports_safe_configuration_states(
    runtime: BridgeApplication, tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    isolated_registry(runtime, tmp_path)
    globals_ = runtime._configuration_state.__globals__
    globals_["HOST"] = "0.0.0.0"
    globals_["API_KEY"] = "STARTUP-HTTP-SECRET"
    globals_["WS_TOKEN"] = "STARTUP-WS-SECRET"
    runtime.bridge.ws = None
    caplog.set_level(logging.INFO, logger="chatgpt_bridge")

    async with runtime.lifespan(None):
        pass

    rendered = caplog.text
    assert "http_auth=configured" in rendered
    assert "websocket_token=configured" in rendered
    assert "sqlite_registry=accessible" in rendered
    assert "extension=disconnected" in rendered
    assert "STARTUP-HTTP-SECRET" not in rendered
    assert "STARTUP-WS-SECRET" not in rendered


async def test_shutdown_during_run_fails_safe_without_second_prompt(
    runtime: BridgeApplication, tmp_path: Path
) -> None:
    isolated_registry(runtime, tmp_path)
    extension = FakeExtension(runtime, prompt_delay=60)
    runtime.bridge.ws = extension
    req = BridgeRunRequest(input="expensive prompt")
    create_bridge_run = runtime.bridge_routes.create_bridge_run

    active = asyncio.create_task(create_bridge_run(req, request_with_key("sigterm-run")))
    for _ in range(100):
        if extension.prompt_count:
            break
        await asyncio.sleep(0.001)
    assert extension.prompt_count == 1

    await runtime.shutdown_bridge(0.01)
    with pytest.raises(asyncio.CancelledError):
        await active
    assert extension.closed == (1001, "server shutdown")

    # Simule le redémarrage : la même clé rejoue l'échec SQLite et ne touche
    # pas la nouvelle extension, même si elle est disponible.
    runtime.accepting_runs = True
    runtime.bridge.closing = False
    replacement = FakeExtension(runtime)
    runtime.bridge.ws = replacement
    replay = await create_bridge_run(req, request_with_key("sigterm-run"))

    assert replay.status_code == 503
    body = json.loads(replay.body)
    assert body["error"]["code"] == "bridge_server_error"
    assert body["error"]["phase"] == "shutdown"
    assert body["error"]["submission_state"] == "submission_attempted"
    assert body["error"]["retryable"] is False
    retains = [message for message in extension.sent if message["type"] == "browser_target_retain"]
    assert len(retains) == 1
    assert retains[0]["run_id"] == body["id"]
    assert retains[0]["browser_target"]["id"] == f"bridge-run-{body['id']}"
    assert replacement.prompt_count == 0


async def test_readiness_matrix_only_a_healthy_accepting_owner_is_200(
    runtime: BridgeApplication,
) -> None:
    """One row per operator-visible state of `/ready`."""
    globals_ = runtime.ready.__globals__
    globals_["HOST"] = "127.0.0.1"
    globals_["API_KEY"] = "matrix-http-secret"
    globals_["WS_TOKEN"] = "matrix-ws-secret"
    runtime.bridge.ws = None

    async def ready() -> tuple[int, dict]:
        response = await runtime.ready()
        return response.status_code, json.loads(response.body)

    def owner(instance: str = "11111111-1111-4111-8111-111111111111") -> ExtensionIdentity:
        return ExtensionIdentity(
            instance_id=instance,
            worker_session_id="22222222-2222-4222-8222-222222222222",
            connection_id="33333333-3333-4333-8333-333333333333",
            client_name="extension-chrome",
            extension_version="1.0.0",
        )

    # No extension.
    code, body = await ready()
    assert (code, body["status"]) == (503, "extension_absent")

    # Socket accepted, hello not received yet.
    pending = FakeExtension(runtime)
    runtime.bridge.begin_handshake(pending)  # type: ignore[arg-type]
    code, body = await ready()
    assert (code, body["status"]) == (503, "extension_handshake_pending")
    runtime.bridge.end_handshake(pending)  # type: ignore[arg-type]

    # Fresh hello, first pong not due yet: available within the first-pong grace.
    socket = FakeExtension(runtime)
    assert await runtime.bridge.attach(socket, owner())  # type: ignore[arg-type]
    code, body = await ready()
    assert (code, body["status"]) == (200, "extension_available")
    assert body["seconds_since_pong"] is None

    # Healthy pong.
    runtime.bridge.last_pong_at = time.time()
    code, body = await ready()
    assert (code, body["status"]) == (200, "extension_available")

    # Hello too old and never ponged: stale, like an old pong.
    runtime.bridge.last_pong_at = None
    runtime.bridge.connected_at = time.time() - 10_000
    code, body = await ready()
    assert (code, body["status"]) == (503, "extension_stale")
    runtime.bridge.connected_at = time.time()
    runtime.bridge.last_pong_at = time.time() - 10_000
    code, body = await ready()
    assert (code, body["status"]) == (503, "extension_stale")

    # A second healthy instance is refused; readiness shows the conflict.
    runtime.bridge.last_pong_at = time.time()
    contender = FakeExtension(runtime)
    assert not await runtime.bridge.attach(  # type: ignore[arg-type]
        contender, owner("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
    )
    code, body = await ready()
    assert (code, body["status"]) == (503, "extension_conflict")
    assert runtime.bridge.ws is socket, "the healthy owner keeps its lease"
    runtime.bridge.connection_conflict_at = None
    assert (await ready())[0] == 200

    # Server shutdown: draining refuses new runs, so readiness is 503 even
    # while the extension is still healthy, and stays 503 after close.
    runtime.accepting_runs = False
    code, body = await ready()
    assert (code, body["status"]) == (503, "server_shutting_down")
    assert body["accepting_runs"] is False
    await runtime.bridge.close()
    code, body = await ready()
    assert (code, body["status"]) == (503, "server_shutting_down")
    rendered = json.dumps(body)
    assert "matrix-http-secret" not in rendered
    assert "matrix-ws-secret" not in rendered
