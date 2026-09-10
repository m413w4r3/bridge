"""Tests for `bridge/app.py`: readiness, startup logging, and shutdown."""

from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path

import pytest
from conftest import FakeExtension, isolated_registry, request_with_key

from bridge.app import BridgeApplication
from bridge.contracts import BridgeRunRequest


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

    runtime.bridge.ws = FakeExtension(runtime)
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
