"""Fausse extension : simule Chrome pour tester le serveur sans navigateur.

⚠️  Un seul client à la fois peut tenir le pont. Désactive l'extension Chrome
(ou ferme l'onglet chatgpt.com) avant de lancer ce script, sinon l'un des deux
se fait déconnecter avec le code 4000 « replaced ».

    python examples/fake_extension.py
    BRIDGE_PORT=8001 python examples/fake_extension.py
"""

import asyncio
import json
import os
import uuid
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import websockets

HOST = os.getenv("BRIDGE_HOST", "127.0.0.1")
PORT = os.getenv("BRIDGE_PORT", "8001")
URL = os.getenv("BRIDGE_WS", f"ws://{HOST}:{PORT}/ws")
WS_TOKEN = os.getenv("BRIDGE_WS_TOKEN", "")


def authenticated_url() -> str:
    parts = urlsplit(URL)
    query = dict(parse_qsl(parts.query))
    if WS_TOKEN:
        query["token"] = WS_TOKEN
    return urlunsplit(
        (parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment)
    )


# --------------------------------------------------------------------------- #
# Interface simulée : mêmes messages typés que le content script (ui_state /
# ui_control), pour tester les contrôles du bridge sans navigateur.
# --------------------------------------------------------------------------- #
MODELES = [
    {"id": "gpt-5", "label": "GPT-5"},
    {"id": "gpt-5-thinking", "label": "GPT-5 Thinking"},
    {"id": "gpt-4o", "label": "GPT-4o"},
]
PROFILS = [
    {"id": "personnel", "label": "Personnel"},
    {"id": "equipe-cti", "label": "Équipe CTI"},
]

UI = {"model": "gpt-5", "profile": "personnel", "web_search": False}
# Identité par id ; continuation par expected_turn_id — jamais par locator/URL.
# Toutes les conversations simulées partagent la même URL Temporary Chat,
# volontairement, pour prouver que le routage n'en dépend pas.
TEMPORARY_CHAT_URL = "https://chatgpt.com/?temporary-chat=true"
CONVERSATIONS: dict[str, str | None] = {}


def _picker(courant: list, choix: str, probe: bool) -> dict:
    item = next((m for m in courant if m["id"] == choix), None)
    return {
        "supported": True,
        "selected": item["label"] if item else None,
        "selected_id": choix,
        "verified": item is not None,
        "available": courant if probe else None,
        "reason": None,
    }


def etat(probe: bool) -> dict:
    return {
        "observed_at": None,
        "url": "https://chatgpt.com/simulateur",
        "content_script_version": "simulateur",
        "probed": probe,
        "model": _picker(MODELES, UI["model"], probe),
        "profile": _picker(PROFILS, UI["profile"], probe),
        "web_search": {
            "supported": True,
            "enabled": UI["web_search"],
            "verified": True,
            "via": "composer_toggle",
            "reason": None,
        },
    }


def _select(cle: str, catalogue: list, voulu: str) -> dict:
    item = next(
        (m for m in catalogue if voulu.lower() in (m["id"], m["label"].lower())),
        None,
    )
    if item is None:
        return {
            "requested": voulu,
            "applied": None,
            "verified": False,
            "ok": False,
            "changed": False,
            "reason": f"« {voulu} » absent du sélecteur simulé",
            "available": catalogue,
        }
    change = UI[cle] != item["id"]
    UI[cle] = item["id"]
    return {
        "requested": voulu,
        "applied": item["label"],
        "verified": True,
        "ok": True,
        "changed": change,
        "reason": None,
    }


def applique(controls: dict) -> dict:
    resultats = {}
    if controls.get("profile"):
        resultats["profile"] = _select("profile", PROFILS, controls["profile"])
    if controls.get("model"):
        resultats["model"] = _select("model", MODELES, controls["model"])
    if isinstance(controls.get("web_search"), bool):
        voulu = controls["web_search"]
        change = UI["web_search"] != voulu
        UI["web_search"] = voulu
        resultats["web_search"] = {
            "requested": voulu,
            "applied": voulu,
            "verified": True,
            "ok": True,
            "changed": change,
            "via": "composer_toggle",
            "reason": None,
        }
    return resultats


async def main() -> None:
    try:
        ws = await websockets.connect(authenticated_url())
    except OSError as exc:
        raise SystemExit(
            f"❌ Serveur injoignable sur {URL} ({exc}). Lance `python server.py`."
        )

    async with ws:
        await ws.send(json.dumps({"type": "hello", "client": "simulateur"}))
        print(f"connecté au bridge sur {URL}")
        try:
            async for raw in ws:
                msg = json.loads(raw)
                if msg["type"] == "ping":
                    await ws.send(json.dumps({"type": "pong"}))
                    continue
                if msg["type"] in ("ui_state", "ui_control"):
                    applied = (
                        applique(msg.get("controls") or {})
                        if msg["type"] == "ui_control"
                        else None
                    )
                    print(f"{msg['type']} → {applied if applied is not None else UI}")
                    await ws.send(
                        json.dumps(
                            {
                                "type": msg["type"],
                                "id": msg["id"],
                                "ok": applied is None
                                or all(r["ok"] for r in applied.values()),
                                "applied": applied,
                                "state": etat(bool(msg.get("probe"))),
                                "error": None,
                            }
                        )
                    )
                    continue
                if msg["type"] != "prompt":
                    continue

                target = msg.get("conversation")
                conversation_result = None
                if target:
                    conversation_id = target["id"]
                    if target["mode"] == "fresh":
                        if conversation_id in CONVERSATIONS:
                            await ws.send(
                                json.dumps(
                                    {
                                        "type": "error",
                                        "id": msg["id"],
                                        "code": "conversation_unavailable",
                                        "message": "une session live existe déjà pour cet id",
                                    }
                                )
                            )
                            continue
                    else:
                        expected_turn_id = target.get("expected_turn_id")
                        known_turn_id = CONVERSATIONS.get(conversation_id)
                        if known_turn_id is None or known_turn_id != expected_turn_id:
                            await ws.send(
                                json.dumps(
                                    {
                                        "type": "error",
                                        "id": msg["id"],
                                        "code": "conversation_unavailable",
                                        "message": (
                                            "conversation simulée introuvable ou "
                                            "expected_turn_id périmé"
                                        ),
                                    }
                                )
                            )
                            continue
                    new_turn_id = f"simulated-turn-{uuid.uuid4()}"
                    CONVERSATIONS[conversation_id] = new_turn_id
                    conversation_result = {
                        "id": conversation_id,
                        "turn_id": new_turn_id,
                        "mode": target["mode"],
                        "verified": True,
                        "ephemeral": True,
                        # Diagnostic only: the same URL may be shared by every
                        # simulated conversation, on purpose.
                        "external_locator": TEMPORARY_CHAT_URL,
                    }

                files = msg.get("files") or []
                print(
                    f"prompt reçu : {len(msg['prompt'])} caractère(s), {len(files)} pièce(s) jointe(s)"
                )
                joints = "".join(
                    f"\n- {f['name']} ({f['mime']}, {len(f['data']) * 3 // 4} octets)"
                    for f in files
                )
                reponse = f"Écho ({len(msg['prompt'])} caractères){joints}\n\n```python\nprint('bloc de code')\n```"
                # Le protocole actuel ne transmet aucun contenu avant `done` :
                # seul un heartbeat périodique prouve que la génération avance.
                for _ in range(3):
                    await ws.send(
                        json.dumps(
                            {
                                "type": "heartbeat",
                                "id": msg["id"],
                                "progress": {
                                    "phase": "streaming",
                                    "output_chars": len(reponse),
                                    "stable_for_ms": 0,
                                    "completion_signal": "streaming",
                                    "completion_confidence": "low",
                                },
                            }
                        )
                    )
                    await asyncio.sleep(0.03)
                await ws.send(
                    json.dumps(
                        {
                            "type": "done",
                            "id": msg["id"],
                            "text": reponse,
                            "metadata": {
                                "visible_citations": [],
                                "serializer_version": "simulateur",
                                "completion_signal": "unknown",
                                "completion_confidence": "low",
                                "stable_for_ms": 0,
                                "output_chars": len(reponse),
                                "visible_citation_count": 0,
                                "content_script_version": "simulateur",
                            },
                            "conversation": conversation_result,
                        }
                    )
                )
        except websockets.exceptions.ConnectionClosedError as exc:
            if exc.rcvd and exc.rcvd.code == 4000:
                raise SystemExit(
                    "❌ Un autre client (l'extension Chrome) a pris le pont.\n"
                    "   Désactive l'extension dans chrome://extensions/ ou ferme l'onglet\n"
                    "   chatgpt.com, puis relance ce script."
                ) from None
            raise


asyncio.run(main())
