"""Lecture et pilotage de l'interface ChatGPT."""

import asyncio
import time
from typing import Any

from fastapi import HTTPException

from bridge.config import UI_PROBE_TTL, UI_TIMEOUT
from bridge.contracts import (
    BridgeBrowserTarget,
    BridgeConversationTarget,
    ControlOutcome,
    Outcomes,
    RunControls,
    RunReport,
    UiState,
)
from bridge.transport import Bridge


class UiUnavailable(RuntimeError):
    def __init__(
        self,
        message: str,
        *,
        code: str = "bridge_extension_disconnected",
        retryable: bool = True,
        phase: str | None = None,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.retryable = retryable
        self.phase = phase
        self.details = details or {}


async def _ui_roundtrip(bridge: Bridge, payload: dict) -> dict:
    archive_phase = "conversation_archive" if payload.get("type") == "conversation_archive" else None
    if not bridge.online:
        raise UiUnavailable(
            "extension non connectée",
            code="bridge_extension_disconnected",
            phase=archive_phase,
        )
    try:
        packet = await bridge.request(payload, UI_TIMEOUT)
    except asyncio.TimeoutError as exc:
        raise UiUnavailable(
            f"aucune réponse de l'extension après {UI_TIMEOUT:.0f}s",
            code="bridge_ui_timeout",
            phase=archive_phase,
        ) from exc
    except Exception as exc:
        raise UiUnavailable(
            f"{type(exc).__name__}: {exc}",
            code="bridge_extension_disconnected",
            phase=archive_phase,
        ) from exc
    if packet.get("type") == "error":  # injecté par `_fail_after_grace`
        code = packet.get("code")
        raise UiUnavailable(
            str(packet.get("message") or "extension déconnectée"),
            code=code if isinstance(code, str) else "bridge_extension_disconnected",
            retryable=packet.get("retryable") if isinstance(packet.get("retryable"), bool) else True,
            phase=packet.get("phase") if isinstance(packet.get("phase"), str) else archive_phase,
            details=packet.get("details") if isinstance(packet.get("details"), dict) else None,
        )
    if packet.get("error"):
        raise UiUnavailable(
            str(packet["error"]),
            code="bridge_protocol_error",
            retryable=False,
            phase=archive_phase,
        )
    return packet


def _ui_state_of(packet: dict) -> UiState | None:
    state = packet.get("state")
    if not isinstance(state, dict):
        return None
    # Le background ajoute ces champs à la réponse, plutôt qu'au DOM state,
    # pour rendre le binding observable sans en faire une identité métier.
    state_with_route = dict(state)
    for field in ("target_id", "tab_id"):
        if field in packet:
            state_with_route[field] = packet[field]
    return UiState.model_validate(state_with_route)


def _routing_payload(
    conversation: BridgeConversationTarget | None,
    browser_target: BridgeBrowserTarget | None,
) -> dict:
    if conversation is not None and browser_target is not None:
        raise UiUnavailable("conversation et browser_target sont mutuellement exclusifs")
    return {
        "conversation": conversation.model_dump(mode="json") if conversation else None,
        "browser_target": browser_target.model_dump(mode="json") if browser_target else None,
    }


def _verify_target_packet(
    packet: dict, browser_target: BridgeBrowserTarget | None
) -> int | None:
    if browser_target is None:
        return None
    if packet.get("target_id") != browser_target.id:
        raise UiUnavailable("la réponse UI ne correspond pas à la cible browser du run")
    tab_id = packet.get("tab_id")
    if not isinstance(tab_id, int) or tab_id < 0:
        raise UiUnavailable("la réponse UI ne contient pas de tab_id routé")
    return tab_id


async def fetch_ui_state(
    bridge: Bridge,
    probe: bool = False,
    conversation: BridgeConversationTarget | None = None,
    browser_target: BridgeBrowserTarget | None = None,
) -> UiState:
    """Lit l'état de l'UI. `probe` ouvre les menus pour énumérer les choix."""
    packet = await _ui_roundtrip(
        bridge,
        {
            "type": "ui_state",
            "probe": probe,
            **_routing_payload(conversation, browser_target),
        },
    )
    _verify_target_packet(packet, browser_target)
    state = _ui_state_of(packet)
    if state is None:
        raise UiUnavailable("l'extension n'a renvoyé aucun état")
    bridge.last_ui_state = state
    bridge.last_ui_at = time.time()
    return state


_probe_cache: dict[str, Any] = {"at": 0.0, "state": None}


async def probed_ui_state(bridge: Bridge, fresh: bool = False) -> UiState:
    cached: UiState | None = _probe_cache["state"]
    if not fresh and cached is not None and time.monotonic() - _probe_cache["at"] < UI_PROBE_TTL:
        return cached
    # La sonde manipule l'UI : elle ne doit jamais s'exécuter pendant une génération.
    async with bridge.slot:
        state = await fetch_ui_state(bridge, probe=True)
    _probe_cache.update(at=time.monotonic(), state=state)
    return state


async def apply_controls(
    bridge: Bridge,
    controls: RunControls,
    conversation: BridgeConversationTarget | None = None,
    browser_target: BridgeBrowserTarget | None = None,
) -> tuple[Outcomes, UiState | None]:
    wanted = controls.wanted()
    if not wanted:
        return {}, await fetch_ui_state(
            bridge, conversation=conversation, browser_target=browser_target
        )
    packet = await _ui_roundtrip(
        bridge,
        {
            "type": "ui_control",
            "controls": wanted,
            **_routing_payload(conversation, browser_target),
        },
    )
    _verify_target_packet(packet, browser_target)
    outcomes = {
        name: ControlOutcome.model_validate(value)
        for name, value in (packet.get("applied") or {}).items()
    }
    return outcomes, _ui_state_of(packet)


def _web_search_mode(controls: RunControls, outcomes: Outcomes) -> str:
    """Comment la recherche web est réellement obtenue pour ce run."""
    outcome = outcomes.get("web_search")
    applied = outcome is not None and outcome.ok
    if controls.web_search is True:
        # L'instruction dans le prompt reste le repli : elle demande à ChatGPT
        # de chercher, sans garantie que l'outil soit actif.
        return "ui_tool" if applied else "prompt_instructed"
    if controls.web_search is False:
        return "off" if applied else "off_unverified"
    return "untouched"


async def prepare_run(
    bridge: Bridge,
    controls: RunControls,
    *,
    allow_unverified_model: bool,
    conversation: BridgeConversationTarget | None = None,
    browser_target: BridgeBrowserTarget | None = None,
) -> RunReport:
    """Applique les contrôles avant la génération, à l'intérieur du slot.

    Un contrôle explicitement demandé et non vérifié fait échouer le run : dans
    une chaîne CTI, un run attribué au mauvais modèle est pire qu'un run manquant.
    """
    try:
        if conversation is not None or browser_target is not None:
            outcomes, state = await apply_controls(
                bridge,
                controls,
                conversation,
                browser_target=browser_target,
            )
        else:
            outcomes, state = await apply_controls(bridge, controls)
    except UiUnavailable as exc:
        # Modèle et profil sont des exigences : sans pilotage de l'UI, le run
        # n'a pas lieu. La recherche web, elle, a un repli par le prompt, et
        # l'état seul n'est qu'un bonus d'observabilité.
        if controls.model or controls.profile:
            raise HTTPException(
                status_code=502, detail=f"Contrôles d'interface inapplicables : {exc}"
            ) from exc
        outcomes, state = {}, None

    for nom, demande in (("profile", controls.profile), ("model", controls.model)):
        outcome = outcomes.get(nom)
        if outcome is None or outcome.ok:
            continue
        if nom == "model" and allow_unverified_model:
            continue
        raise HTTPException(
            status_code=409,
            detail=f"Réglage « {nom} » = « {demande} » non appliqué dans l'UI : {outcome.reason}",
        )

    if any(o.changed for o in outcomes.values()):
        _probe_cache.update(at=0.0, state=None)  # la sonde en cache est périmée

    observed = state.model.selected if state and state.model.verified else None
    return RunReport(
        model_observed=observed,
        model_source="ui_observed" if observed else "unknown",
        web_search_mode=_web_search_mode(controls, outcomes),
        target_id=browser_target.id if browser_target else None,
        tab_id=state.tab_id if state else None,
        controls=outcomes,
    )


def cached_probe() -> UiState | None:
    state: UiState | None = _probe_cache["state"]
    if state is None or time.monotonic() - _probe_cache["at"] >= UI_PROBE_TTL:
        return None
    return state


def invalidate_probe_cache() -> None:
    _probe_cache.update(at=0.0, state=None)
