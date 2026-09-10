"""Paramètres environnementaux du bridge."""

import os
from pathlib import Path

HOST = os.getenv("BRIDGE_HOST", "127.0.0.1")
PORT = int(os.getenv("BRIDGE_PORT", "8001"))
# Si défini, les clients doivent envoyer  Authorization: Bearer <clé>
API_KEY = os.getenv("BRIDGE_API_KEY")
# Délai max sans le moindre paquet depuis l'extension avant d'abandonner.
IDLE_TIMEOUT = float(os.getenv("BRIDGE_IDLE_TIMEOUT", "300"))
# Délai max pour une génération complète. Une recherche approfondie ChatGPT
# dépasse couramment le quart d'heure : cette borne protège d'une génération
# réellement bloquée, elle ne doit pas arbitrer la durée normale d'une recherche.
TOTAL_TIMEOUT = float(os.getenv("BRIDGE_TOTAL_TIMEOUT", "3600"))
KEEPALIVE_INTERVAL = 20.0  # garde le service worker MV3 en vie
# Délai laissé à l'extension pour se reconnecter sans perdre la requête en cours.
RECONNECT_GRACE = float(os.getenv("BRIDGE_RECONNECT_GRACE", "20"))
# Délai max d'un aller-retour de lecture/pilotage de l'interface ChatGPT.
UI_TIMEOUT = float(os.getenv("BRIDGE_UI_TIMEOUT", "30"))
# Durée de validité d'une sonde des menus (elle les ouvre à l'écran : on évite
# de la refaire à chaque appel de /v1/models).
UI_PROBE_TTL = float(os.getenv("BRIDGE_UI_PROBE_TTL", "60"))
UI_SNAPSHOT_STALE = float(os.getenv("BRIDGE_UI_SNAPSHOT_STALE", "120"))
WS_TOKEN = os.getenv("BRIDGE_WS_TOKEN")
# `.parent.parent` : ce module vit dans bridge/, mais le chemin par défaut doit
# rester ancré sur la racine du projet (là où se trouvait server.py).
RUN_DB_PATH = Path(
    os.getenv(
        "BRIDGE_RUN_DB", str(Path(__file__).parent.parent / "data" / "bridge-runs.sqlite3")
    )
)
RUN_RETENTION_SECONDS = float(os.getenv("BRIDGE_RUN_RETENTION_SECONDS", str(7 * 86400)))
RUN_CLEANUP_LIMIT = int(os.getenv("BRIDGE_RUN_CLEANUP_LIMIT", "100"))
SHUTDOWN_GRACE_SECONDS = max(0.0, float(os.getenv("BRIDGE_SHUTDOWN_GRACE_SECONDS", "20")))
