"""Pont WebSocket vers l'extension : transport pur, aucune logique HTTP/lifecycle."""

import asyncio
import logging
import time
import uuid
from typing import Dict, Optional

from fastapi import WebSocket

from bridge.config import RECONNECT_GRACE
from bridge.contracts import UiState

logger = logging.getLogger("chatgpt_bridge")


class Bridge:
    """Une seule extension connectée à la fois ; les requêtes sont sérialisées.

    Un unique lecteur (`_reader`) consomme le WebSocket et distribue chaque
    paquet dans la queue de la requête concernée (routage par `id`). C'est ce
    qui évite la course entre l'endpoint /ws et les handlers HTTP.
    """

    def __init__(self) -> None:
        self.ws: Optional[WebSocket] = None
        self.queues: Dict[str, asyncio.Queue] = {}
        # L'UI ChatGPT ne peut générer qu'une réponse à la fois.
        self.slot = asyncio.Lock()
        self.connected_at: Optional[float] = None
        self.client_name: str = "inconnu"
        self._grace: Optional[asyncio.Task] = None
        self.last_ui_state: Optional[UiState] = None
        self.last_ui_at: Optional[float] = None
        self.reconnections = 0
        self._seen_events: Dict[str, set[str]] = {}
        self.closing = False

    @property
    def online(self) -> bool:
        return self.ws is not None

    async def attach(self, ws: WebSocket) -> None:
        if self.connected_at is not None:
            self.reconnections += 1
        if self.ws is not None:
            # Un nouveau client prend la place de l'ancien : c'est ce qui permet
            # à un rechargement d'onglet de reprendre le pont sans redémarrage.
            print(f"⚠️  Connexion précédente ({self.client_name}) remplacée — un seul client à la fois")
            try:
                await self.ws.close(code=4000, reason="replaced")
            except Exception:
                pass
        if self._grace is not None:
            self._grace.cancel()  # reconnexion à temps : les requêtes survivent
            self._grace = None
        self.ws = ws
        self.connected_at = time.time()
        self.client_name = "inconnu"

    def detach(self, ws: WebSocket) -> None:
        # Un socket remplacé (`attach`) n'est plus l'actif : sa fermeture ne doit
        # pas faire échouer les requêtes déjà reprises par le nouveau.
        if self.ws is not ws:
            return
        self.ws = None
        self.connected_at = None
        self.client_name = "inconnu"
        print("❌ Extension déconnectée")
        # Un service worker MV3 est arrêté et relancé à tout moment : sa
        # reconnexion ne doit pas faire échouer une génération en cours. On
        # laisse donc un délai de grâce avant d'abandonner les requêtes.
        if self.queues and not self.closing:
            self._grace = asyncio.create_task(self._fail_after_grace())

    async def close(self) -> None:
        """Ferme proprement la liaison extension sans déclencher de reconnexion."""
        self.closing = True
        if self._grace is not None:
            self._grace.cancel()
            self._grace = None
        ws = self.ws
        self.ws = None
        self.connected_at = None
        self.client_name = "inconnu"
        if ws is not None:
            try:
                await ws.close(code=1001, reason="server shutdown")
            except Exception:
                logger.exception("websocket_shutdown_failure")

    async def _fail_after_grace(self) -> None:
        await asyncio.sleep(RECONNECT_GRACE)
        if self.online:
            return
        for queue in self.queues.values():
            queue.put_nowait({"type": "error", "message": "extension déconnectée"})

    async def send(self, payload: dict) -> None:
        if self.ws is None:
            raise RuntimeError("extension non connectée")
        await self.ws.send_json(payload)

    async def request(self, payload: dict, timeout: float) -> dict:
        """Aller-retour ponctuel (lecture/pilotage de l'UI), routé par `id`."""
        request_id = payload.get("id") or f"ui_{uuid.uuid4().hex[:16]}"
        queue = self.open_channel(request_id)
        try:
            await self.send({**payload, "id": request_id})
            return await asyncio.wait_for(queue.get(), timeout=timeout)
        finally:
            self.close_channel(request_id)

    def open_channel(self, request_id: str) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue()
        self.queues[request_id] = queue
        return queue

    def close_channel(self, request_id: str) -> None:
        self.queues.pop(request_id, None)
        self._seen_events.pop(request_id, None)

    def dispatch(self, packet: dict) -> None:
        state = packet.get("state")
        if isinstance(state, dict):
            try:
                self.last_ui_state = UiState.model_validate(state)
                self.last_ui_at = time.time()
            except Exception:
                pass
        request_id = str(packet.get("id", ""))
        event_id = packet.get("event_id")
        if request_id and isinstance(event_id, str):
            seen = self._seen_events.setdefault(request_id, set())
            if event_id in seen:
                return
            if len(seen) < 10_000:
                seen.add(event_id)
        queue = self.queues.get(packet.get("id", ""))
        if queue is not None:
            queue.put_nowait(packet)
