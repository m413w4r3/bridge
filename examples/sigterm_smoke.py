"""Client contrôlé pour vérifier l'arrêt SIGTERM sans session ChatGPT réelle."""

import asyncio
import http.client
import json
import os
import sys
import urllib.error
import urllib.request
from urllib.parse import urlencode

import websockets

HTTP_URL = os.getenv("BRIDGE_HTTP", "http://chatgpt-bridge:8001/v1")
WS_URL = os.getenv("BRIDGE_WS", "ws://chatgpt-bridge:8001/ws")
API_KEY = os.environ["BRIDGE_API_KEY"]
WS_TOKEN = os.environ["BRIDGE_WS_TOKEN"]
REQUEST_ID = os.environ["SIGTERM_REQUEST_ID"]


def post_run() -> tuple[int, dict]:
    body = json.dumps(
        {"request_id": REQUEST_ID, "input": "controlled shutdown input"}
    ).encode()
    request = urllib.request.Request(
        f"{HTTP_URL}/bridge/runs",
        data=body,
        headers={
            "Authorization": f"Bearer {API_KEY}",
            "Content-Type": "application/json",
            "X-Idempotency-Key": REQUEST_ID,
        },
        method="POST",
    )
    try:
        response = urllib.request.urlopen(request, timeout=35)
    except urllib.error.HTTPError as exc:
        response = exc
    except (urllib.error.URLError, http.client.RemoteDisconnected, TimeoutError):
        return 0, {}
    with response:
        return response.status, json.load(response)


async def answer_ui(socket: websockets.ClientConnection, message: dict) -> None:
    applied = {
        key: {
            "requested": value,
            "applied": value,
            "verified": True,
            "ok": True,
            "changed": False,
        }
        for key, value in message.get("controls", {}).items()
    }
    await socket.send(
        json.dumps(
            {
                "type": message["type"],
                "id": message["id"],
                "applied": applied,
                "state": {"model": {}, "profile": {}, "web_search": {}},
            }
        )
    )


async def run(phase: str) -> None:
    prompt_count = 0
    async with websockets.connect(f"{WS_URL}?{urlencode({'token': WS_TOKEN})}") as socket:
        await socket.send(json.dumps({"type": "hello", "client": f"sigterm-{phase}"}))
        post = asyncio.create_task(asyncio.to_thread(post_run))
        try:
            while not post.done():
                try:
                    raw = await asyncio.wait_for(socket.recv(), timeout=0.1)
                except asyncio.TimeoutError:
                    continue
                message = json.loads(raw)
                if message["type"] == "ping":
                    await socket.send(json.dumps({"type": "pong"}))
                elif message["type"] in {"ui_state", "ui_control"}:
                    await answer_ui(socket, message)
                elif message["type"] == "prompt":
                    prompt_count += 1
                    print("sigterm smoke: prompt received", flush=True)
                    # Aucun done : le run reste actif jusqu'au SIGTERM.
        except websockets.ConnectionClosed:
            pass

    status, body = await post
    if phase == "active":
        assert prompt_count == 1
        assert status in {0, 503}
        if status == 503:
            assert body["error"]["code"] == "bridge_server_error"
        print("sigterm smoke: interrupted run failed safe")
    else:
        assert prompt_count == 0
        assert status == 503
        assert body["error"]["code"] == "bridge_server_error"
        print("sigterm smoke: replay failed without prompt")


if len(sys.argv) != 2 or sys.argv[1] not in {"active", "replay"}:
    raise SystemExit("usage: sigterm_smoke.py active|replay")
asyncio.run(run(sys.argv[1]))
