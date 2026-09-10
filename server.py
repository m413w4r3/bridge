"""
Mini-Bridge : serveur local exposant une API compatible OpenAI, servie par un
onglet chatgpt.com piloté via une extension Chrome.

    [client HTTP] --POST /v1/chat/completions--> [server.py] <--WebSocket--> [extension]

Lancement :  python server.py   (ou  uvicorn server:app --port 8000)

Ce module est uniquement le launcher exécutable : toute la composition
FastAPI (routes, lifecycle, WebSocket) vit dans `bridge.app.BridgeApplication`.
"""

import logging
import os

from bridge.app import BridgeApplication
from bridge.config import HOST, PORT

logger = logging.getLogger("chatgpt_bridge")

bridge_application = BridgeApplication()
app = bridge_application.app


if __name__ == "__main__":
    import uvicorn

    # Les logs protocolaires INFO d'Uvicorn incluent l'URL du handshake et donc
    # le token WebSocket en query string. Les événements applicatifs sûrs
    # conservent leur propre handler INFO ; Uvicorn reste visible à WARNING.
    bridge_handler = logging.StreamHandler()
    bridge_handler.setFormatter(logging.Formatter("%(levelname)s %(name)s %(message)s"))
    logger.addHandler(bridge_handler)
    logger.setLevel(
        getattr(logging, os.getenv("BRIDGE_LOG_LEVEL", "INFO").upper(), logging.INFO)
    )
    logger.propagate = False
    # Uvicorn libère rapidement les handlers HTTP ; les tâches idempotentes,
    # protégées par shield, sont drainées par `shutdown_bridge` pendant le délai
    # applicatif ci-dessus.
    # Le token WebSocket est transporté dans la query string par l'extension :
    # désactiver l'access log évite que Uvicorn ne l'imprime lors du handshake.
    uvicorn.run(
        app,
        host=HOST,
        port=PORT,
        log_level="warning",
        access_log=False,
        timeout_graceful_shutdown=1,
    )
