"""Contract checks on the extension's own source (background.js/content.js).

These aren't unit tests of the Python bridge: they pin invariants of the
extension scripts that the Python side has no other way to enforce (there is
no Python import of `extension/`).
"""

from __future__ import annotations

from pathlib import Path


def test_extension_reserves_request_before_real_send_trigger() -> None:
    root = Path(__file__).parents[1] / "extension"
    background = (root / "background.js").read_text()
    content = (root / "content.js").read_text()

    assert 'requestStates.set(msg.id, "received")' in background
    assert "requestStatesReady" in background and "conversationRegistryReady" in background
    assert content.index("await claimPrompt(id)") < content.index("const submissionMethod = triggerComposerSubmission(composer, sendBtn)")
    assert "submittedRequestIds" in content
    assert "bridgeConversationRegistry" in background
    assert "bridgeBrowserTargetRegistry" in background
    route_start = background.index("async function routeTab(")
    route_body = background[route_start : background.index("\n\n/** Envoie", route_start)]
    assert "if (msg.conversation) return resolveConversationTab(msg.conversation);" in route_body
    assert "if (msg.browser_target) return resolveBrowserTarget(msg.browser_target);" in route_body
    assert "if (msg.type === \"prompt\")" in route_body
    assert "return findChatTab();" in route_body
    # P0 : le heartbeat est un signal de liveness de l'extension. Il doit être
    # émis avant tout `continue` dépendant du DOM, sinon une phase de recherche
    # web qui remplace le tour assistant provoque un faux idle timeout.
    assert 'type: "heartbeat"' in content
    assert content.index('type: "heartbeat"') < content.index("if (!turn) continue;")
    assert 'type: "chunk"' not in content
    assert "text: serialized.text" in content
    send_start = background.index("async function sendToTab(")
    send_end = background.index("\nasync function cleanupReservationAfterDeliveryFailure", send_start)
    send_body = background[send_start:send_end]
    assert "chrome.scripting.executeScript" not in send_body
    assert send_body.count("chrome.tabs.sendMessage") == 1


def test_fresh_conversations_are_temporary_chat_url_based() -> None:
    root = Path(__file__).parents[1] / "extension"
    background = (root / "background.js").read_text()

    assert (
        'const TEMPORARY_CHAT_URL = "https://chatgpt.com/?temporary-chat=true";' in background
    )
    assert "?temporary-chat=true" in background
    # The original regression: opening a bare chatgpt.com/ root and depending
    # on a later navigation for identity must never come back.
    assert 'chrome.tabs.create({ url: "https://chatgpt.com/", active: false })' not in background
    # Every NEW Temporary Chat goes through the one dedicated-window helper.
    assert "async function createDedicatedTemporaryChat()" in background
    assert background.count("await createDedicatedTemporaryChat()") == 2
    assert "chrome.tabs.create(" not in background


def test_new_temporary_chats_live_in_a_dedicated_unfocused_window() -> None:
    """Chaque Temporary Chat live est l'onglet actif de sa propre fenêtre.

    Un onglet `active: false` dans la fenêtre de l'opérateur reste masqué
    (`document.visibilityState=hidden`) pendant toute la génération : c'est la
    dépendance au premier plan que cette architecture teste.
    """
    root = Path(__file__).parents[1] / "extension"
    background = (root / "background.js").read_text()

    start = background.index("async function createDedicatedTemporaryChat()")
    end = background.index("\nasync function removeWindowById(", start)
    body = background[start:end]

    assert "chrome.windows.create({" in body
    assert 'type: "normal",' in body
    assert "focused: false," in body
    assert 'state: "normal",' in body
    # Jamais minimisée : une fenêtre minimisée peut remettre la page en cycle
    # de vie masqué et invaliderait l'expérience.
    assert '"minimized"' not in background
    # L'onglet est résolu depuis le windowId exact, jamais par recherche d'URL.
    assert "chrome.tabs.query({ windowId })" in body
    assert "tabs.length !== 1" in body
    assert "candidate.windowId !== windowId" in body
    assert "loaded.windowId !== windowId" in body
    assert "isAllowedChatOrigin(loaded.url)" in body
    assert "loaded.active !== true" in body
    assert 'phase: "dedicated_window_created"' in body


def test_dedicated_window_ownership_is_recorded_in_session_only() -> None:
    root = Path(__file__).parents[1] / "extension"
    background = (root / "background.js").read_text()

    assert background.count("bridge_owned_window: true,") == 2
    assert "bridge_owned_window" not in _local_storage_calls(background)


def test_window_cleanup_requires_proven_ownership() -> None:
    """Aucune fenêtre n'est fermée parce qu'elle contient une URL ChatGPT."""
    root = Path(__file__).parents[1] / "extension"
    background = (root / "background.js").read_text()

    start = background.index("async function closeBoundTargetWithOptions(binding")
    end = background.index("\nfunction isBrowserTarget(", start)
    body = background[start:end]

    assert 'binding.bridge_owned_window !== true' in body
    assert "tab.windowId !== windowId" in body
    assert "chrome.windows.get(windowId, { populate: true })" in body
    assert "tabs.length === 1 && tabs[0]?.id === tabId" in body
    # Propriété non prouvée ou onglets ajoutés par l'opérateur : au plus
    # l'onglet exact du bridge est fermé.
    assert "await chrome.tabs.remove(tabId);" in body
    assert "await chrome.tabs.remove(tabId).catch(() => {});" in body
    assert "chrome.tabs.query(" not in body
    # Toute fermeture de session live passe par ce chemin exact : les seuls
    # `chrome.tabs.remove` du service worker sont les trois replis sûrs ici.
    assert background.count("chrome.tabs.remove(") == 3
    assert body.count("chrome.tabs.remove(") == 3
    # Une fenêtre n'est jamais fermée ailleurs que par le helper de propriété.
    assert background.count("chrome.windows.remove(") == 2
    assert "async function removeWindowById(windowId)" in background


def test_conversation_registry_lives_in_session_storage_only() -> None:
    root = Path(__file__).parents[1] / "extension"
    background = (root / "background.js").read_text()

    assert "chrome.storage.session\n  .get(\"bridgeConversationRegistry\")" in background
    assert 'chrome.storage.session.set({\n    bridgeConversationRegistry' in background
    # The live registry must never be persisted to chrome.storage.local.
    assert "bridgeConversationRegistry" not in _local_storage_calls(background)


def test_stateless_target_registry_lives_in_session_storage_only() -> None:
    root = Path(__file__).parents[1] / "extension"
    background = (root / "background.js").read_text()

    assert 'chrome.storage.session\n  .get("bridgeBrowserTargetRegistry")' in background
    assert "bridgeBrowserTargetRegistry: Object.fromEntries" in background
    assert "bridgeBrowserTargetRegistry" not in _local_storage_calls(background)


def _local_storage_calls(source: str) -> str:
    """Every `chrome.storage.local.set({...})` / `.get([...])` call site,
    concatenated — used to assert a key never appears among them."""
    calls: list[str] = []
    cursor = 0
    for marker in ("chrome.storage.local.set(", "chrome.storage.local.get("):
        while True:
            start = source.find(marker, cursor)
            if start == -1:
                break
            end = source.find(");", start)
            calls.append(source[start : end + 2] if end != -1 else source[start:])
            cursor = start + 1
        cursor = 0
    return "\n".join(calls)


def test_resolve_conversation_tab_never_routes_by_external_locator() -> None:
    root = Path(__file__).parents[1] / "extension"
    background = (root / "background.js").read_text()

    start = background.index("async function resolveConversationTab(")
    end = background.index("\nasync function routeTab(")
    body = background[start:end]
    continue_start = body.index('// mode === "continue"')
    continue_body = body[continue_start:]

    # external_locator may be *stored* as diagnostic metadata inside the
    # registry entry, but it must never be read/compared to make a routing
    # decision within resolveConversationTab.
    assert "conversation.external_locator" not in body
    assert "known.external_locator" not in body
    assert "candidate.url === conversation.external_locator" not in background
    # continue: exact tab retrieval, never a query/discovery, never a new tab.
    assert "chrome.tabs.get(known.tab_id)" in continue_body
    assert "chrome.tabs.query(" not in continue_body
    assert "chrome.tabs.create(" not in continue_body
    # expected_turn_id / head_turn_id participate in continuation verification.
    assert "known.head_turn_id !== conversation.expected_turn_id" in continue_body


def test_no_locator_based_identity_concepts_remain() -> None:
    root = Path(__file__).parents[1] / "extension"
    background = (root / "background.js").read_text()
    content = (root / "content.js").read_text()

    assert "validChatLocator" not in background
    assert "verifiedLocator" not in content
    assert "window.location.href !== conversation.external_locator" not in content
    assert "locator de conversation non attribué" not in content


def test_stateless_prompt_never_uses_new_chat_dom_click() -> None:
    root = Path(__file__).parents[1] / "extension"
    background = (root / "background.js").read_text()
    content = (root / "content.js").read_text()

    assert "SELECTORS.newChat" not in content
    assert "will_click_new_chat" not in content
    route_start = background.index("async function routeTab(")
    route_end = background.index("\n\n/** Envoie", route_start)
    route_body = background[route_start:route_end]
    assert route_body.index('if (msg.type === "prompt")') < route_body.index("return findChatTab();")


def test_focus_is_never_a_completion_mechanism() -> None:
    """Aucun chemin de complétion ne passe par l'activation de l'onglet.

    Le focus reste un outil de debug humain : il ne doit exister nulle part
    dans l'extension comme moyen de faire aboutir une génération.
    """
    root = Path(__file__).parents[1] / "extension"
    background = (root / "background.js").read_text()
    content = (root / "content.js").read_text()

    # Le service worker n'active jamais un onglet, ni ne focalise une fenêtre.
    assert "active: true" not in background
    assert "focused: true" not in background
    assert "chrome.windows.update" not in background
    assert "highlight" not in background
    # `chrome.tabs.update` ne sert qu'à la protection contre le déchargement.
    assert background.count("chrome.tabs.update(") == 1
    assert "chrome.tabs.update(tabId, { autoDiscardable })" in background
    # Les fenêtres dédiées naissent non focalisées et le restent.
    assert background.count("focused: false,") == 1
    # Le content script ne ramène jamais la page au premier plan.
    assert "window.focus()" not in content
    assert "globalThis.focus()" not in content
    # `document.hasFocus()` reste lu — mais seulement comme diagnostic borné,
    # jamais comme condition d'une décision de fin.
    assert content.count("document.hasFocus()") == 1
    assert "documentHasFocus" in content


def test_background_tab_is_protected_from_discard_without_activation() -> None:
    root = Path(__file__).parents[1] / "extension"
    background = (root / "background.js").read_text()

    assert "async function setTabAutoDiscardable(tabId, autoDiscardable)" in background
    assert "chrome.tabs.update(tabId, { autoDiscardable })" in background
    # Protection posée pour la durée du run lié, puis relâchée si plus rien
    # n'est lié à cet onglet exact.
    assert "await setTabAutoDiscardable(tab.id, false);" in background
    assert "releaseTabAutoDiscardable" in background
    # Un onglet perdu — déchargé par Chrome, ou fermé à la main avec sa fenêtre
    # dédiée — échoue de façon typée et fermée : jamais un rejeu, jamais un
    # onglet ou une fenêtre de remplacement.
    assert "async function failRunOnLostBoundTab(" in background
    discard_start = background.index("async function failRunOnLostBoundTab(")
    discard_end = background.index("chrome.tabs.onUpdated.addListener", discard_start)
    discard_body = background[discard_start:discard_end]
    assert '"bridge_extension_disconnected"' in discard_body
    assert 'submission_state: "post_submission"' in discard_body
    assert "retryable: false" in discard_body
    assert "createDedicatedTemporaryChat(" not in discard_body
    assert "chrome.windows.create(" not in discard_body
    assert "sendToTab(" not in discard_body


def test_manual_window_closure_fails_closed() -> None:
    """Fermer l'onglet ou la fenêtre dédiée pendant un run est un échec fermé."""
    root = Path(__file__).parents[1] / "extension"
    background = (root / "background.js").read_text()

    start = background.index("chrome.tabs.onRemoved.addListener((tabId) => {")
    end = background.index("chrome.windows?.onRemoved?.addListener", start)
    body = background[start:end]

    assert "const lost = [...inflight.entries()]" in body
    assert "failRunOnLostBoundTab(" in body
    # Les bindings sont purgés avant l'émission : rien ne ressuscite une target
    # dont l'onglet est définitivement mort.
    assert body.index("conversationRegistry.delete(id)") < body.index("failRunOnLostBoundTab(")
    assert body.index("browserTargetRegistry.delete(targetId)") < body.index(
        "failRunOnLostBoundTab("
    )
    assert "createDedicatedTemporaryChat(" not in body
    assert "sendToTab(" not in body


def test_bound_tab_state_reports_window_lifecycle_without_being_fatal() -> None:
    root = Path(__file__).parents[1] / "extension"
    background = (root / "background.js").read_text()

    start = background.index("async function boundTabState(tabId)")
    end = background.index("\nasync function logBoundTabState(", start)
    body = background[start:end]

    for field in (
        "tab_id:",
        "active:",
        "discarded:",
        "frozen:",
        "auto_discardable:",
        "status:",
        "window_id:",
        "window_focused:",
        "window_state:",
        "window_type:",
    ):
        assert field in body
    # Un champ de cycle de vie absent (Chrome plus ancien) vaut null.
    assert "tab.frozen ?? null" in body
    assert "chrome.windows?.get(" in body


def test_observation_tick_wakes_the_loop_without_claiming_liveness() -> None:
    """Le tick du service worker réveille, il ne prouve rien.

    S'il pouvait produire un heartbeat ou un `done`, il affirmerait la santé
    d'un observateur DOM qu'il n'observe pas.
    """
    root = Path(__file__).parents[1] / "extension"
    background = (root / "background.js").read_text()
    content = (root / "content.js").read_text()

    assert "function pumpObservationTicks()" in background
    pump_start = background.index("function pumpObservationTicks()")
    pump_end = background.index("\n\n", pump_start)
    pump_body = background[pump_start:pump_end]
    assert '{ type: "observe_tick", id: requestId }' in pump_body
    assert "heartbeat" not in pump_body
    assert "done" not in pump_body

    tick_start = content.index("function handleObservationTick(")
    tick_end = content.index("\n}", tick_start)
    tick_body = content[tick_start:tick_end]
    # Le tick ne fait que réveiller la boucle du job exact.
    assert "currentJob.id !== msg?.id" in tick_body
    assert "reply(" not in tick_body
    assert 'type: "done"' not in tick_body


def test_dom_observation_is_event_driven_and_leak_free() -> None:
    root = Path(__file__).parents[1] / "extension"
    content = (root / "content.js").read_text()

    assert "new MutationObserver(" in content
    # La boucle d'observation attend un réveil (mutation / tick / minuterie),
    # jamais un simple sleep minuté.
    assert "await watcher.wait(POLL_MS)" in content
    assert "await sleep(POLL_MS)" not in content
    # Aucun observateur ne survit à un job.
    assert "function disconnectDomWatchers()" in content
    assert "disconnectDomWatchers();" in content
    assert content.count("watcher.disconnect();") >= 2


def test_stall_guards_require_several_real_observations() -> None:
    """Un unique réveil throttlé ne prouve pas qu'une UI est figée.

    Sans cette règle, une réponse terminée dans un onglet masqué partait en
    `incomplete` (`finalization_stalled`) au lieu d'un `done`.
    """
    root = Path(__file__).parents[1] / "extension"
    content = (root / "content.js").read_text()

    assert "const MIN_STALL_OBSERVATIONS = 3;" in content
    assert content.count("stableObservations >= MIN_STALL_OBSERVATIONS") == 2
    assert "observationsSinceActivity >= MIN_STALL_OBSERVATIONS" in content
    # La sémantique v29 de `.streaming-animation` reste intacte.
    assert 'longRunningStreaming: [".streaming-animation"]' in content
    assert "!longRunningStreamingSignalActive(signalSources)" in content
