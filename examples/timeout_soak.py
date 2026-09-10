"""Soak des deux échéances du bridge, sur le vrai protocole HTTP + WebSocket.

Trois scénarios contre un serveur configuré avec des bornes accélérées
(BRIDGE_TOTAL_TIMEOUT et BRIDGE_IDLE_TIMEOUT de quelques secondes) :

    heartbeats sans fin      -> bridge_total_timeout
    extension muette         -> bridge_idle_timeout
    heartbeats puis `done`   -> completed

Ces trois cas sont indissociables : c'est la confusion entre les deux premiers
qui a fait diagnostiquer une extension déconnectée alors qu'elle envoyait un
heartbeat toutes les cinq secondes.
"""

import asyncio
import json
import os
import urllib.error
import urllib.request
import uuid
from typing import Any
from urllib.parse import urlencode

import websockets

HTTP_URL = os.getenv("BRIDGE_HTTP", "http://chatgpt-bridge-soak:8001/v1")
WS_URL = os.getenv("BRIDGE_WS", "ws://chatgpt-bridge-soak:8001/ws")
API_KEY = os.environ["BRIDGE_API_KEY"]
WS_TOKEN = os.environ["BRIDGE_WS_TOKEN"]
HEARTBEAT_INTERVAL = float(os.getenv("SOAK_HEARTBEAT_INTERVAL", "0.2"))
DONE_AFTER = float(os.getenv("SOAK_DONE_AFTER", "1.5"))
HTTP_TIMEOUT = float(os.getenv("SOAK_HTTP_TIMEOUT", "30"))


def post_run(request_id: str) -> tuple[int, dict[str, Any]]:
    """Lance un run et renvoie (status, corps décodé), erreurs comprises."""
    body = json.dumps({"request_id": request_id, "input": "soak"}).encode()
    request = urllib.request.Request(
        f"{HTTP_URL}/bridge/runs",
        data=body,
        headers={
            "Authorization": f"Bearer {API_KEY}",
            "Content-Type": "application/json",
            "X-Idempotency-Key": request_id,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read() or b"{}")


def error_code(payload: dict[str, Any]) -> str | None:
    """Le code d'erreur, quelle que soit l'enveloppe (réponse directe ou rejeu)."""
    for envelope in ("detail", "error"):
        value = payload.get(envelope)
        if isinstance(value, dict) and isinstance(value.get("code"), str):
            return value["code"]
    return None


class Extension:
    """Extension simulée : heartbeats jusqu'à un `done` optionnel."""

    def __init__(self, socket: Any) -> None:
        self.socket = socket
        self.beats = 0
        self.mode = "silent"
        self.task: asyncio.Task[None] | None = None

    @staticmethod
    def route(message: dict[str, Any]) -> dict[str, Any]:
        browser_target = message.get("browser_target")
        if not isinstance(browser_target, dict) or not browser_target.get("id"):
            return {}
        return {"target_id": browser_target["id"], "tab_id": 1}

    async def serve(self) -> None:
        async for raw in self.socket:
            message = json.loads(raw)
            kind = message.get("type")
            if kind == "ping":
                await self.socket.send(json.dumps({"type": "pong"}))
            elif kind in {"ui_state", "ui_control"}:
                await self.socket.send(
                    json.dumps(
                        {
                            "type": kind,
                            "id": message["id"],
                            "applied": {},
                            "state": {"model": {}, "profile": {}, "web_search": {}},
                            **self.route(message),
                        }
                    )
                )
            elif kind == "prompt" and self.mode != "silent":
                self.task = asyncio.create_task(
                    self.generate(message["id"], self.route(message))
                )

    async def generate(self, request_id: str, route: dict[str, Any]) -> None:
        elapsed = 0.0
        while True:
            await asyncio.sleep(HEARTBEAT_INTERVAL)
            elapsed += HEARTBEAT_INTERVAL
            if self.mode == "completing" and elapsed >= DONE_AFTER:
                await self.socket.send(
                    json.dumps(
                        {
                            "type": "done",
                            "id": request_id,
                            "event_id": f"{request_id}:done",
                            "text": "rapport final",
                            "metadata": {
                                "completion_signal": "assistant_actions",
                                "completion_confidence": "high",
                                "stable_for_ms": 2_100,
                                "output_chars": len("rapport final"),
                                "visible_citation_count": 0,
                                "content_script_version": "soak",
                            },
                            **route,
                        }
                    )
                )
                return
            self.beats += 1
            await self.socket.send(
                json.dumps(
                    {
                        "type": "heartbeat",
                        "id": request_id,
                        "event_id": f"{request_id}:hb-{self.beats}",
                        "progress": {
                            "phase": "generating",
                            "output_chars": 30_454,
                            "stable_for_ms": 0,
                            "completion_signal": "streaming",
                            "completion_confidence": "high",
                        },
                        **route,
                    }
                )
            )


async def main() -> None:
    async with websockets.connect(f"{WS_URL}?{urlencode({'token': WS_TOKEN})}") as socket:
        await socket.send(json.dumps({"type": "hello", "client": "timeout-soak"}))
        extension = Extension(socket)
        served = asyncio.create_task(extension.serve())

        extension.mode = "beating"
        status, body = await asyncio.to_thread(post_run, f"soak-total-{uuid.uuid4()}")
        assert status == 502, f"attendu 502, reçu {status} : {body}"
        assert error_code(body) == "bridge_total_timeout", body
        assert extension.beats >= 3, "l'extension n'a pas assez battu pour prouver sa vitalité"
        print(f"soak total_timeout: ok ({extension.beats} heartbeats émis)")

        extension.mode = "silent"
        status, body = await asyncio.to_thread(post_run, f"soak-idle-{uuid.uuid4()}")
        assert status == 502, f"attendu 502, reçu {status} : {body}"
        assert error_code(body) == "bridge_idle_timeout", body
        print("soak idle_timeout: ok")

        extension.mode = "completing"
        status, body = await asyncio.to_thread(post_run, f"soak-done-{uuid.uuid4()}")
        assert status == 200, f"attendu 200, reçu {status} : {body}"
        assert body.get("status") == "completed", body
        print("soak completion: ok")

        served.cancel()
    print("bridge timeout soak: total et idle ne sont plus confondus")


asyncio.run(main())
