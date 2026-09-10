#!/usr/bin/env python3
"""Test réel (extension Chrome réelle) : crée une conversation via le bridge et
vérifie qu'elle a bien été ouverte en mode "Temporary chat" (ChatGPT ne l'écrit
jamais dans l'historique), puis referme l'onglet par le chemin exact qu'emprunte
le backend en production (`DELETE /v1/bridge/conversations/{id}`, la même route
que `_archive_ephemeral_conversation` dans
`backend/src/cti_app/application/discovery/service.py`).

Chaque étape est journalisée dans un fichier JSONL horodaté
(`out/audit_ephemeral_*.jsonl`) pour permettre l'audit : c'est ce script qui a
servi à établir que l'ancien pipeline de suppression (release + cleanup/start)
n'était jamais atteint en production, avant qu'il ne soit remplacé par le mode
"Temporary chat" de ChatGPT lui-même. Ce script ne simule rien côté
extension — il pilote le vrai serveur bridge, qui doit être connecté à une
vraie extension Chrome sur un vrai onglet chatgpt.com connecté.

Prérequis avant de lancer ce script :
  1. `python server.py` tourne (ou `make up`).
  2. `chrome://extensions/` → extension chargée, mode développeur actif.
  3. Un onglet `https://chatgpt.com/` ouvert, connecté à un compte réel ;
     l'icône de l'extension doit être verte (connectée au bridge).
  4. `GET /health` doit répondre `extension: connected`.

Usage :
    .venv/bin/python examples/verify_ephemeral_conversation.py

Configuration : BRIDGE_URL (défaut http://127.0.0.1:8001), BRIDGE_API_KEY.

Identité de routage : `conversation.id` (UUID applicatif) + `expected_turn_id`
pour une continuation — jamais un `external_locator`/URL, qui n'est qu'une
métadonnée diagnostique optionnelle et peut être identique entre plusieurs
conversations Temporary Chat simultanées (elles partagent toutes
`https://chatgpt.com/?temporary-chat=true`).

Ce script NE PEUT PAS vérifier lui-même que la conversation n'apparaît pas
dans l'historique ChatGPT (il n'a pas accès visuel à la page) : il affiche
l'URL diagnostique (`external_locator`, si présente) à la fin et demande une
vérification humaine.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

_HOST = os.getenv("BRIDGE_HOST", "127.0.0.1")
_PORT = os.getenv("BRIDGE_PORT", "8001")
BRIDGE_URL = os.getenv("BRIDGE_URL", f"http://{_HOST}:{_PORT}")
API_KEY = os.getenv("BRIDGE_API_KEY")

OUT_DIR = Path(__file__).resolve().parent.parent / "out"
OUT_DIR.mkdir(exist_ok=True)
AUDIT_PATH = OUT_DIR / f"audit_ephemeral_{datetime.now(UTC):%Y%m%dT%H%M%SZ}.jsonl"


class AuditLog:
    """Journal d'audit horodaté : un événement JSON par ligne, et un écho console."""

    def __init__(self, path: Path):
        self.path = path
        self._fh = path.open("w", encoding="utf-8")

    def event(self, step: str, **fields: Any) -> None:
        record = {"ts": datetime.now(UTC).isoformat(), "step": step, **fields}
        line = json.dumps(record, ensure_ascii=False, sort_keys=True)
        self._fh.write(line + "\n")
        self._fh.flush()
        print(f"[{record['ts']}] {step} {fields}")

    def close(self) -> None:
        self._fh.close()


def _call(
    method: str, path: str, payload: dict | None = None, timeout: float = 60.0
) -> tuple[int, Any]:
    url = f"{BRIDGE_URL}{path}"
    body = (
        json.dumps(payload, ensure_ascii=False).encode("utf-8")
        if payload is not None
        else None
    )
    headers = {"Content-Type": "application/json"}
    if API_KEY:
        headers["Authorization"] = f"Bearer {API_KEY}"
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", "replace")
            return resp.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", "replace")
        try:
            parsed = json.loads(raw)
        except Exception:
            parsed = raw
        return exc.code, parsed
    except urllib.error.URLError as exc:
        raise SystemExit(
            f"Serveur injoignable sur {url} ({exc.reason}). Lance `python server.py` "
            "et vérifie que l'extension est connectée."
        ) from None


def main() -> int:
    log = AuditLog(AUDIT_PATH)
    log.event("audit_started", bridge_url=BRIDGE_URL, audit_file=str(AUDIT_PATH))

    # 0. Précondition : l'extension doit être connectée.
    status, health = _call("GET", "/health")
    log.event("health_checked", status=status, body=health)
    extension_connected = isinstance(health, dict) and health.get("extension_connected")
    if status != 200 or not extension_connected:
        log.event(
            "audit_aborted",
            reason=(
                "extension non connectée — ouvre chatgpt.com avec l'extension "
                "chargée puis relance"
            ),
        )
        log.close()
        return 1

    conversation_id = str(uuid.uuid4())
    log.event("conversation_id_generated", conversation_id=conversation_id)

    # 1. Création réelle : envoie un prompt trivial sur une conversation "fresh".
    #    L'extension doit ouvrir un nouvel onglet chatgpt.com, activer "Temporary
    #    chat" (ensureTemporaryChat() dans content.js), puis y répondre.
    run_payload = {
        "input": "Réponds uniquement par le mot: ok",
        "conversation": {"mode": "fresh", "id": conversation_id},
    }
    log.event("conversation_create_requested", payload=run_payload)
    status, response = _call("POST", "/v1/bridge/runs", run_payload, timeout=120.0)
    log.event("conversation_create_completed", status=status, body=response)

    if status != 200 or not isinstance(response, dict):
        log.event("audit_aborted", reason="échec de création de la conversation réelle")
        log.close()
        return 1

    # L'info de conversation vit sous metadata.conversation dans la réponse
    # au format Responses API — pas à la racine.
    conversation_info = (response.get("metadata") or {}).get("conversation") or {}
    reported_id = conversation_info.get("id")
    verified = conversation_info.get("verified")
    ephemeral = conversation_info.get("ephemeral")
    turn_id = conversation_info.get("turn_id")
    output_text = response.get("output_text")
    # Diagnostic only — a Temporary Chat URL may be shared by many
    # conversations, so it is never required to be unique, nor required at all.
    external_locator = conversation_info.get("external_locator")
    log.event(
        "conversation_created",
        conversation_id=conversation_id,
        reported_id=reported_id,
        verified=verified,
        ephemeral=ephemeral,
        turn_id=turn_id,
        external_locator=external_locator,
    )
    if reported_id != conversation_id or verified is not True or ephemeral is not True:
        log.event(
            "audit_aborted",
            reason=(
                "la conversation retournée n'est pas vérifiée/éphémère, ou son id ne "
                "correspond pas à celui demandé"
            ),
        )
        log.close()
        return 1
    if not turn_id or not output_text:
        log.event(
            "audit_aborted",
            reason="aucun turn_id ou aucune sortie retournés — conversation non fonctionnelle",
        )
        log.close()
        return 1

    # 2. Continuation réelle, sur le même onglet exact : identité de routage
    #    conversation.id + expected_turn_id (le turn_id vérifié ci-dessus),
    #    jamais un locator/URL.
    continue_payload = {
        "input": "Réponds uniquement par le mot: bien",
        "conversation": {
            "mode": "continue",
            "id": conversation_id,
            "expected_turn_id": turn_id,
        },
    }
    log.event("conversation_continue_requested", payload=continue_payload)
    status, continue_response = _call(
        "POST", "/v1/bridge/runs", continue_payload, timeout=120.0
    )
    log.event("conversation_continue_completed", status=status, body=continue_response)
    if status != 200 or not isinstance(continue_response, dict):
        log.event(
            "audit_aborted",
            reason="échec de la continuation sur le même onglet (expected_turn_id)",
        )
        log.close()
        return 1
    continue_info = (continue_response.get("metadata") or {}).get("conversation") or {}
    if (
        continue_info.get("id") != conversation_id
        or continue_info.get("verified") is not True
        or continue_info.get("ephemeral") is not True
        or not continue_info.get("turn_id")
    ):
        log.event(
            "audit_aborted",
            reason="la continuation n'a pas rejoint l'onglet exact déjà vérifié",
        )
        log.close()
        return 1

    # 3. Chemin de fermeture EXACT emprunté par le backend en production :
    #    _archive_ephemeral_conversation() -> DELETE /v1/bridge/conversations/{id}.
    #    Voir backend/src/cti_app/application/discovery/service.py:482
    log.event(
        "close_attempted_via_production_path",
        conversation_id=conversation_id,
        endpoint=f"DELETE /v1/bridge/conversations/{conversation_id}",
        note="chemin réellement appelé en production après un run réussi",
    )
    status, archive_response = _call("DELETE", f"/v1/bridge/conversations/{conversation_id}")
    log.event("close_production_path_result", status=status, body=archive_response)

    log.event(
        "manual_verification_required",
        message=(
            "Ouvre l'historique ChatGPT (barre latérale de chatgpt.com) et vérifie qu'aucune "
            "conversation issue de ce run n'y figure. Si l'une y figure, 'Temporary chat' n'a "
            "pas été activé correctement — défaut à investiguer. external_locator, si présent, "
            "n'est qu'un indice diagnostique : il peut être partagé par plusieurs conversations."
        ),
        conversation_id=conversation_id,
        external_locator=external_locator,
    )

    log.event("audit_finished", audit_file=str(AUDIT_PATH))
    log.close()
    print(f"\nJournal d'audit complet : {AUDIT_PATH}")
    print(
        "Vérifie manuellement que la conversation "
        f"{conversation_id} N'EST PAS dans l'historique ChatGPT."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
