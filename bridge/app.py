"""Composition root FastAPI du bridge.

Propriétaire unique de l'application FastAPI et de son état serveur.
"""

import asyncio
import hmac
import json
import logging
import re
import time
from contextlib import asynccontextmanager
from typing import Any, Optional

from fastapi import Depends, FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from bridge.config import (
    API_KEY,
    EXTENSION_HELLO_TIMEOUT,
    HOST,
    KEEPALIVE_INTERVAL,
    PORT,
    RUN_DB_PATH,
    SHUTDOWN_GRACE_SECONDS,
    WS_TOKEN,
)
from bridge.registry import RunRegistry
from bridge.run_service import DurableRunService
from bridge.routes_bridge import BridgeRoutes
from bridge.routes_conversations import ConversationRoutes
from bridge.routes_openai import OpenAIRoutes
from bridge.transport import Bridge, ExtensionIdentity

logger = logging.getLogger("chatgpt_bridge")

_bearer = HTTPBearer(auto_error=False)
_UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)


class BridgeApplication:
    """Propriétaire unique de l'application FastAPI et de son état serveur.

    Composition root : une seule instance de `Bridge`, `RunRegistry`, et des
    trois familles de routes. Le seam `bridge=`/`registry=` explicite permet
    aux tests d'injecter un registry temporaire sans patcher quatre
    références après construction.
    """

    def __init__(
        self,
        *,
        bridge: Bridge | None = None,
        registry: RunRegistry | None = None,
    ) -> None:
        self.bridge = bridge or Bridge()
        self.registry = registry or RunRegistry(RUN_DB_PATH)
        self.run_service = DurableRunService(bridge=self.bridge, registry=self.registry)

        self.accepting_runs = True

        self.app = FastAPI(
            title="ChatGPT Mini-Bridge", version="1.0.0", lifespan=self.lifespan
        )

        self.conversation_routes = ConversationRoutes(
            bridge=self.bridge,
            auth_dependency=self.require_key,
        )
        self.app.include_router(self.conversation_routes.router)

        self.openai_routes = OpenAIRoutes(
            bridge=self.bridge,
            run_service=self.run_service,
            auth_dependency=self.require_key,
            ensure_accepting_runs=self._ensure_accepting_runs,
        )
        self.app.include_router(self.openai_routes.router)

        self.bridge_routes = BridgeRoutes(
            bridge=self.bridge,
            run_service=self.run_service,
            auth_dependency=self.require_key,
            ensure_accepting_runs=self._ensure_accepting_runs,
        )
        self.app.include_router(self.bridge_routes.router)

        self.app.add_api_websocket_route("/ws", self.websocket_endpoint)
        self.app.add_api_route("/health", self.health, methods=["GET"])
        self.app.add_api_route("/ready", self.ready, methods=["GET"])
        self.app.add_exception_handler(HTTPException, self.openai_error)

    async def keepalive_loop(self) -> None:
        """Ping périodique : réveille le service worker MV3 et détecte les sockets morts."""
        while True:
            await asyncio.sleep(KEEPALIVE_INTERVAL)
            if self.bridge.ws is not None:
                try:
                    await self.bridge.send({"type": "ping", "t": time.time()})
                except Exception:
                    pass

    def _configuration_state(self) -> dict[str, Any]:
        local_only = HOST in {"127.0.0.1", "localhost", "::1"}
        http_configured = bool(API_KEY)
        websocket_configured = bool(WS_TOKEN)
        return {
            "complete": websocket_configured and (http_configured or local_only),
            "http_auth": "configured" if http_configured else "absent",
            "http_auth_required": not local_only,
            "websocket_token": "configured" if websocket_configured else "absent",
        }

    def _ensure_accepting_runs(self) -> None:
        if not self.accepting_runs:
            raise HTTPException(
                status_code=503,
                detail={
                    "code": "bridge_server_error",
                    "message": "Le bridge est en cours d'arrêt et n'accepte plus de nouveaux runs.",
                    "retryable": True,
                },
            )

    async def shutdown_bridge(self, grace_seconds: float = SHUTDOWN_GRACE_SECONDS) -> None:
        """Draine les runs natifs, puis annule prudemment ce qui reste."""
        self.accepting_runs = False
        tracked = self.run_service.active_tasks
        logger.info(
            "bridge_shutdown_started grace_seconds=%s active_runs=%s extension=%s",
            grace_seconds,
            len(tracked),
            "connected" if self.bridge.online else "disconnected",
        )
        pending = tracked
        if tracked and grace_seconds > 0:
            _, pending = await asyncio.wait(tracked, timeout=grace_seconds)
        for task in pending:
            task.cancel()
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)
        # Let cancellation handlers retain ambiguous browser targets while the
        # WebSocket is still open. Closing first would strand a stateless
        # Temporary Chat in the submitted state, making exact recovery fail.
        await self.bridge.close()
        self.registry.checkpoint_and_close()
        logger.info("bridge_shutdown_completed cancelled_runs=%s", len(pending))

    @asynccontextmanager
    async def lifespan(self, app: FastAPI):
        self.accepting_runs = True
        self.bridge.closing = False
        task = asyncio.create_task(self.keepalive_loop())
        self.registry.recover_interrupted()
        self.registry.cleanup()

        configuration = self._configuration_state()
        registry_state = "accessible" if self.registry.accessible() else "unavailable"
        logger.info(
            "bridge_started host=%s port=%s http_auth=%s websocket_token=%s "
            "sqlite_registry=%s extension=disconnected",
            HOST,
            PORT,
            configuration["http_auth"],
            configuration["websocket_token"],
            registry_state,
        )
        try:
            yield
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            await self.shutdown_bridge()

    # ----------------------------------------------------------------- #
    # Auth
    # ----------------------------------------------------------------- #

    async def require_key(
        self, cred: Optional[HTTPAuthorizationCredentials] = Depends(_bearer)
    ) -> None:
        if not API_KEY and HOST not in {"127.0.0.1", "localhost", "::1"}:
            raise HTTPException(
                status_code=503,
                detail={
                    "code": "bridge_auth_failed",
                    "message": "BRIDGE_API_KEY est obligatoire sur une écoute non locale.",
                    "retryable": False,
                },
            )
        if API_KEY and (cred is None or cred.credentials != API_KEY):
            raise HTTPException(
                status_code=401,
                detail={
                    "code": "bridge_auth_failed",
                    "message": "Clé API invalide.",
                    "retryable": False,
                },
            )

    # ----------------------------------------------------------------- #
    # WebSocket extension
    # ----------------------------------------------------------------- #

    @staticmethod
    def _parse_extension_hello(packet: Any) -> ExtensionIdentity | None:
        if not isinstance(packet, dict) or packet.get("type") != "hello":
            return None
        if packet.get("client") != "extension-chrome":
            return None
        instance_id = packet.get("instance_id")
        worker_session_id = packet.get("worker_session_id")
        connection_id = packet.get("connection_id")
        extension_version = packet.get("extension_version")
        identifiers = (instance_id, worker_session_id, connection_id)
        if any(not isinstance(value, str) or not _UUID_RE.fullmatch(value) for value in identifiers):
            return None
        if not isinstance(extension_version, str) or not extension_version or len(extension_version) > 64:
            return None
        return ExtensionIdentity(
            instance_id=instance_id.lower(),
            worker_session_id=worker_session_id.lower(),
            connection_id=connection_id.lower(),
            client_name="extension-chrome",
            extension_version=extension_version,
        )

    async def websocket_endpoint(self, ws: WebSocket) -> None:
        if not self.accepting_runs or self.bridge.closing:
            await ws.close(code=1013, reason="server shutdown")
            return
        supplied = ws.query_params.get("token")
        if not WS_TOKEN or not supplied or not hmac.compare_digest(supplied, WS_TOKEN):
            # Fermeture avant acceptation : l'extension ne peut envoyer aucun paquet.
            await ws.close(code=4401, reason="authentication required")
            logger.warning("websocket_auth_failed")
            return
        await ws.accept()
        self.bridge.begin_handshake(ws)
        attached = False
        try:
            try:
                raw_hello = await asyncio.wait_for(
                    ws.receive_text(), timeout=EXTENSION_HELLO_TIMEOUT
                )
            except asyncio.TimeoutError:
                await ws.close(code=4408, reason="hello_timeout")
                logger.warning("extension_handshake_timeout")
                return
            try:
                hello = json.loads(raw_hello)
            except (json.JSONDecodeError, TypeError):
                hello = None
            identity = self._parse_extension_hello(hello)
            if identity is None:
                await ws.close(code=4400, reason="invalid_hello")
                logger.warning("extension_handshake_invalid")
                return
            if not await self.bridge.attach(ws, identity):
                await ws.close(code=4409, reason="owner_active")
                return
            attached = True
            diagnostics = self.bridge.diagnostics()
            logger.info(
                "extension_connected instance=%s worker=%s connection=%s reconnections=%s",
                diagnostics["instance_id_prefix"],
                diagnostics["worker_session_prefix"],
                diagnostics["connection_id_prefix"],
                self.bridge.reconnections,
            )
            while True:
                raw = await ws.receive_text()
                if not self.bridge.is_current(ws, identity.connection_id):
                    break
                try:
                    packet = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if not isinstance(packet, dict):
                    continue
                kind = packet.get("type")
                if kind == "pong":
                    self.bridge.record_pong(ws, identity.connection_id)
                    continue
                if kind == "hello":  # l'identité est immuable pendant cette connexion
                    continue
                self.bridge.dispatch(packet)
        except WebSocketDisconnect:
            pass
        except Exception:  # noqa: BLE001 - on ne veut jamais tuer le serveur
            logger.exception("websocket_failure")
        finally:
            self.bridge.end_handshake(ws)
            if attached:
                self.bridge.detach(ws)

    # ----------------------------------------------------------------- #
    # Liveness / readiness
    # ----------------------------------------------------------------- #

    async def health(self):
        return {
            "status": "ok",
            **self.bridge.diagnostics(),
            "client": self.bridge.client_name if self.bridge.identified else None,
            "connected_since": self.bridge.connected_at,
        }

    async def ready(self):
        """Disponibilité fonctionnelle, distincte de la liveness `/health`."""
        configuration = self._configuration_state()
        registry_accessible = self.registry.accessible()
        if not registry_accessible:
            status = "server_unavailable"
        elif not configuration["complete"]:
            status = "configuration_incomplete"
        else:
            status = self.bridge.readiness_status()
        diagnostics = self.bridge.diagnostics()
        body = {
            "status": status,
            "server_operational": registry_accessible and self.accepting_runs,
            "accepting_runs": self.accepting_runs,
            "configuration": configuration,
            "sqlite_registry": "accessible" if registry_accessible else "unavailable",
            "extension": status if status.startswith("extension_") else (
                "connected" if self.bridge.online else "disconnected"
            ),
            **diagnostics,
        }
        return JSONResponse(
            status_code=200 if status == "extension_available" else 503,
            content=body,
        )

    async def openai_error(self, _: Request, exc: HTTPException):
        """Erreurs au format OpenAI, pour que les SDK clients les comprennent."""
        if isinstance(exc.detail, dict):
            error = exc.detail
        else:
            error = {
                "message": str(exc.detail),
                "type": "bridge_error",
                "code": "bridge_server_error",
                "retryable": exc.status_code in {408, 429, 502, 503, 504},
            }
        return JSONResponse(
            status_code=exc.status_code,
            content={"error": error},
        )
