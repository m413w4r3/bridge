"""Compose smoke test: controlled fake extension, no ChatGPT session."""

import asyncio
import json
import os
import urllib.request
import uuid
from urllib.parse import urlencode

import websockets

HTTP_URL = os.getenv("BRIDGE_HTTP", "http://chatgpt-bridge:8001/v1")
WS_URL = os.getenv("BRIDGE_WS", "ws://chatgpt-bridge:8001/ws")
API_KEY = os.environ["BRIDGE_API_KEY"]
WS_TOKEN = os.environ["BRIDGE_WS_TOKEN"]
REQUEST_ID = f"compose-{uuid.uuid4()}"


def post_once() -> dict:
    body = json.dumps({"request_id": REQUEST_ID, "input": "controlled smoke input"}).encode()
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
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.load(response)


async def main() -> None:
    prompt_count = 0
    async with websockets.connect(f"{WS_URL}?{urlencode({'token': WS_TOKEN})}") as socket:
        await socket.send(json.dumps({"type": "hello", "client": "compose-smoke"}))

        async def extension() -> None:
            nonlocal prompt_count
            async for raw in socket:
                message = json.loads(raw)
                if message["type"] == "ping":
                    await socket.send(json.dumps({"type": "pong"}))
                elif message["type"] in {"ui_state", "ui_control"}:
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
                elif message["type"] == "prompt":
                    prompt_count += 1
                    await asyncio.sleep(0.05)
                    await socket.send(
                        json.dumps(
                            {
                                "type": "done",
                                "id": message["id"],
                                "event_id": "compose:1",
                                "text": "ok",
                                "metadata": {
                                    "visible_citations": [],
                                    "serializer_version": "compose-smoke",
                                    "completion_signal": "unknown",
                                    "completion_confidence": "low",
                                    "stable_for_ms": 0,
                                    "output_chars": len("ok"),
                                    "visible_citation_count": 0,
                                    "content_script_version": "compose-smoke",
                                },
                            }
                        )
                    )

        extension_task = asyncio.create_task(extension())
        first, second = await asyncio.gather(
            asyncio.to_thread(post_once), asyncio.to_thread(post_once)
        )
        replay = await asyncio.to_thread(post_once)
        assert first["id"] == second["id"] == replay["id"]
        assert prompt_count == 1
        extension_task.cancel()
    print("compose bridge smoke: one prompt, one durable run")


asyncio.run(main())
