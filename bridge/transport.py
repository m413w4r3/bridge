"""Pont WebSocket vers l'extension : transport pur, aucune logique HTTP/lifecycle."""

import asyncio
import logging
import time
import uuid
from dataclasses import dataclass
from typing import Dict, Optional

from fastapi import WebSocket

from bridge.config import (
    EXTENSION_CONFLICT_WINDOW,
    EXTENSION_FIRST_PONG_GRACE,
    EXTENSION_PONG_TIMEOUT,
    RECONNECT_GRACE,
)
from bridge.contracts import UiState

logger = logging.getLogger("chatgpt_bridge")


@dataclass(frozen=True)
class ExtensionIdentity:
    instance_id: str
    worker_session_id: str
    connection_id: str
    client_name: str
    extension_version: str


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
        self.identified_at: Optional[float] = None
        self.last_pong_at: Optional[float] = None
        self.instance_id: Optional[str] = None
        self.worker_session_id: Optional[str] = None
        self.connection_id: Optional[str] = None
        self.client_name: str = "inconnu"
        self.extension_version: Optional[str] = None
        self._pending_handshakes: Dict[int, tuple[WebSocket, float]] = {}
        self.connection_conflict_at: Optional[float] = None
        self._has_connected = False
        self._grace: Optional[asyncio.Task] = None
        self.last_ui_state: Optional[UiState] = None
        self.last_ui_at: Optional[float] = None
        self.reconnections = 0
        self._seen_events: Dict[str, set[str]] = {}
        self.closing = False

    @property
    def online(self) -> bool:
        return self.ws is not None

    @property
    def identified(self) -> bool:
        return bool(self.ws is not None and self.connection_id)

    @property
    def healthy_extension(self) -> bool:
        """La connexion identifiée a un pong récent ou attend son premier ping."""
        if not self.online or not self.identified or self.connected_at is None:
            return False
        now = time.time()
        if self.last_pong_at is not None:
            return now - self.last_pong_at <= EXTENSION_PONG_TIMEOUT
        return now - self.connected_at <= EXTENSION_FIRST_PONG_GRACE

    @property
    def ready(self) -> bool:
        return self.healthy_extension

    @property
    def handshake_pending(self) -> bool:
        return bool(self._pending_handshakes)

    @staticmethod
    def _prefix(value: Optional[str]) -> str:
        return value[:8] if value else "none"

    def diagnostics(self, now: Optional[float] = None) -> dict:
        now = time.time() if now is None else now
        return {
            "extension_connected": self.online,
            "extension_identified": self.identified,
            "extension_handshake_pending": self.handshake_pending,
            "instance_id_prefix": self._prefix(self.instance_id),
            "worker_session_prefix": self._prefix(self.worker_session_id),
            "connection_id_prefix": self._prefix(self.connection_id),
            "connected_for_seconds": (
                max(0.0, now - self.connected_at) if self.connected_at is not None else None
            ),
            "seconds_since_pong": (
                max(0.0, now - self.last_pong_at) if self.last_pong_at is not None else None
            ),
            "reconnections": self.reconnections,
            "busy": self.slot.locked(),
        }

    def readiness_status(self, now: Optional[float] = None) -> str:
        now = time.time() if now is None else now
        if self.healthy_extension:
            if (
                self.connection_conflict_at is not None
                and now - self.connection_conflict_at <= EXTENSION_CONFLICT_WINDOW
            ):
                return "extension_conflict"
            return "extension_available"
        if self.online and self.identified:
            return "extension_stale"
        if self.handshake_pending:
            return "extension_handshake_pending"
        return "extension_absent"

    def begin_handshake(self, ws: WebSocket) -> None:
        self._pending_handshakes[id(ws)] = (ws, time.time())

    def end_handshake(self, ws: WebSocket) -> None:
        self._pending_handshakes.pop(id(ws), None)

    def is_current(self, ws: WebSocket, connection_id: str) -> bool:
        return self.ws is ws and self.connection_id == connection_id

    def record_pong(self, ws: WebSocket, connection_id: str) -> bool:
        if not self.is_current(ws, connection_id):
            return False
        self.last_pong_at = time.time()
        return True

    async def attach(self, ws: WebSocket, identity: ExtensionIdentity) -> bool:
        """Attache un hello validé si son owner est libre ou stale.

        Un owner sain conserve son lease : cela empêche deux profils Chrome de
        se voler silencieusement le transport à chaque reconnexion.
        """
        self.end_handshake(ws)
        old_ws = self.ws
        old_identity = self.instance_id
        old_worker = self.worker_session_id
        old_connected_at = self.connected_at
        now = time.time()

        if old_ws is not None and self.healthy_extension:
            same_instance = old_identity == identity.instance_id
            old_age_ms = max(0, int((now - (old_connected_at or now)) * 1000))
            logger.warning(
                "extension_connection_conflict old_instance=%s new_instance=%s "
                "old_worker=%s new_worker=%s same_instance=%s old_connection_age_ms=%s",
                self._prefix(old_identity),
                self._prefix(identity.instance_id),
                self._prefix(old_worker),
                self._prefix(identity.worker_session_id),
                str(same_instance).lower(),
                old_age_ms,
            )
            self.connection_conflict_at = now
            return False

        if self._has_connected:
            self.reconnections += 1
        if old_ws is not None:
            logger.info(
                "extension_connection_replaced old_instance=%s new_instance=%s "
                "old_worker=%s new_worker=%s",
                self._prefix(old_identity),
                self._prefix(identity.instance_id),
                self._prefix(old_worker),
                self._prefix(identity.worker_session_id),
            )
        if self._grace is not None:
            self._grace.cancel()  # reconnexion à temps : les requêtes survivent
            self._grace = None

        self.ws = ws
        self.connected_at = now
        self.identified_at = now
        self.last_pong_at = None
        self.instance_id = identity.instance_id
        self.worker_session_id = identity.worker_session_id
        self.connection_id = identity.connection_id
        self.client_name = identity.client_name
        self.extension_version = identity.extension_version
        self._has_connected = True
        self.connection_conflict_at = None
        if old_ws is not None and old_ws is not ws:
            try:
                await old_ws.close(code=4000, reason="replaced")
            except Exception:
                pass
        return True

    def detach(self, ws: WebSocket) -> None:
        # Un socket remplacé (`attach`) n'est plus l'actif : sa fermeture ne doit
        # pas faire échouer les requêtes déjà reprises par le nouveau.
        if self.ws is not ws:
            return
        self.ws = None
        self.connected_at = None
        self.identified_at = None
        self.last_pong_at = None
        self.instance_id = None
        self.worker_session_id = None
        self.connection_id = None
        self.client_name = "inconnu"
        self.extension_version = None
        logger.info("extension_disconnected")
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
        self.identified_at = None
        self.last_pong_at = None
        self.instance_id = None
        self.worker_session_id = None
        self.connection_id = None
        self.client_name = "inconnu"
        self.extension_version = None
        if ws is not None:
            try:
                await ws.close(code=1001, reason="server shutdown")
            except Exception:
                logger.exception("websocket_shutdown_failure")
        pending = [entry[0] for entry in self._pending_handshakes.values()]
        self._pending_handshakes.clear()
        for pending_ws in pending:
            try:
                await pending_ws.close(code=1013, reason="server shutdown")
            except Exception:
                pass

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
