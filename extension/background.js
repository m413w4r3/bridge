/**
 * Service worker : détient l'unique WebSocket vers le serveur local et relaie
 * les prompts vers le content script de l'onglet chatgpt.com.
 *
 * Le WebSocket vit ici plutôt que dans le content script pour deux raisons :
 * il survit aux navigations SPA, et il n'est pas soumis à la CSP de la page.
 */

const DEFAULT_URL = "ws://127.0.0.1:8001/ws";
const RECONNECT_MIN = 1000;
const RECONNECT_MAX = 30000;

const REPLACED_BACKOFF = 60000; // après un remplacement, on laisse la place
const workerSessionId = crypto.randomUUID();
let bridgeInstanceIdPromise = null;

// Toute conversation fraîche ouverte par le bridge est un Temporary Chat :
// jamais écrite dans l'historique ChatGPT, donc jamais à en supprimer après
// coup. C'est l'URL canonique — on ne dépend jamais d'une navigation
// ultérieure vers /c/... pour obtenir une identité.
const TEMPORARY_CHAT_URL = "https://chatgpt.com/?temporary-chat=true";
const ALLOWED_CHAT_ORIGINS = ["https://chatgpt.com", "https://chat.openai.com"];

let socket = null;
let connectionGeneration = 0;
let connectAttempt = null;
let reconnectDelay = RECONNECT_MIN;
let reconnectTimer = null;
let suppressUntil = 0;
/** Raison typée de la suppression courante : "replaced" (4000) ou "owner_active" (4409). */
let suppressReason = null;
let status = { connected: false, lastError: null, url: DEFAULT_URL };
// Diagnostic de connexion sans contenu : identité du socket courant, nombre de
// reconnexions de ce worker et âge du dernier ping serveur.
let connectionIdentity = null;
let openedConnections = 0;
let lastPingAt = null;
// Le serveur pinge toutes les 20 s ; au-delà de trois pings manqués, un socket
// OPEN est considéré stale (même borne que BRIDGE_EXTENSION_PONG_TIMEOUT).
const PING_STALE_MS = 60000;
/** id de requête -> id de l'onglet qui la traite */
const inflight = new Map();
/** Deuxième barrière persistante : un id reçu n'est jamais retransmis deux fois au DOM. */
const requestStates = new Map();
const eventCounters = new Map();
/**
 * Registre des sessions live : conversation.id (UUID applicatif) -> onglet
 * Chrome exact. C'est l'identité de routage — jamais l'URL. Vit uniquement
 * dans chrome.storage.session : un redémarrage du service worker le
 * recharge, mais un redémarrage du navigateur / rechargement de l'extension
 * le perd volontairement (Temporary Chat n'est alors plus reconstructible).
 */
const conversationRegistry = new Map();
/**
 * Proofs of successful exact closes. A missing live binding is not enough to
 * answer `already_closed`: this map is written only after the exact tab or
 * owned window close operation has completed successfully.
 */
const closedConversationRegistry = new Map();
const busyTabs = new Set();
const requestConversationResults = new Map();
const requestExtensionMetadata = new Map();
const requestFinalOutputs = new Map();
const requestConversationBindings = new Map();
/** target_id de run stateless -> onglet Temporary Chat exact. */
const browserTargetRegistry = new Map();
/** id de requête -> binding de routage observé (diagnostics same-tab). */
const requestRoutes = new Map();
/** Sérialise la réservation initiale d'une même target dans un service worker. */
const browserTargetReservations = new Map();

// --------------------------------------------------------------------------- //
// Autonomie de l'onglet d'arrière-plan
//
// L'onglet de génération est créé volontairement inactif et ne doit jamais
// avoir besoin d'être focalisé. Deux protections indépendantes vivent ici :
//   - `autoDiscardable = false` pendant un run lié, pour que Chrome ne décharge
//     pas l'onglet exact sous pression mémoire (jamais d'activation) ;
//   - un `observe_tick` cadencé par le ping du serveur, horloge que le
//     throttling des minuteries de page n'atteint pas. Le tick ne fait que
//     réveiller la boucle du content script : il n'émet ni heartbeat ni `done`
//     et ne peut donc jamais prétendre que l'observateur DOM est vivant.
// --------------------------------------------------------------------------- //

/** Marque/démarque l'onglet exact comme non déchargeable. Jamais d'activation. */
async function setTabAutoDiscardable(tabId, autoDiscardable) {
  if (typeof tabId !== "number") return;
  try {
    await chrome.tabs.update(tabId, { autoDiscardable });
  } catch (_) {
    // Un onglet disparu ou une API indisponible ne doit jamais faire échouer
    // un run : c'est une protection opportuniste, pas une garantie.
  }
}

/** L'onglet est-il encore lié à une conversation live ou à une target ? */
function tabIsStillBound(tabId) {
  for (const entry of conversationRegistry.values()) {
    if (entry.tab_id === tabId) return true;
  }
  for (const entry of browserTargetRegistry.values()) {
    if (entry.tab_id === tabId) return true;
  }
  return false;
}

/**
 * Rend l'onglet déchargeable à nouveau — sauf s'il reste lié (KEEP), auquel
 * cas un déchargement casserait le CONTINUE de cette conversation exacte.
 */
async function releaseTabAutoDiscardable(tabId) {
  if (typeof tabId !== "number" || tabIsStillBound(tabId)) return;
  await setTabAutoDiscardable(tabId, true);
}

/**
 * État de l'onglet exact d'un run, sans contenu : uniquement les champs de
 * cycle de vie que Chrome expose. Jamais d'autre onglet que celui-là.
 */
async function boundTabState(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    let windowFocused = null;
    let windowState = null;
    let windowType = null;
    try {
      const window = await chrome.windows?.get(tab.windowId);
      windowFocused = window?.focused ?? null;
      windowState = window?.state ?? null;
      windowType = window?.type ?? null;
    } catch (_) {
      windowFocused = null;
    }
    return {
      tab_id: tab.id ?? tabId,
      exists: true,
      active: tab.active ?? null,
      discarded: tab.discarded ?? null,
      // `tab.frozen` n'existe pas sur les Chrome plus anciens : son absence
      // vaut `null`, jamais une erreur ni un run en échec.
      frozen: tab.frozen ?? null,
      auto_discardable: tab.autoDiscardable ?? null,
      status: tab.status ?? null,
      window_id: tab.windowId ?? null,
      window_focused: windowFocused,
      window_state: windowState,
      window_type: windowType,
    };
  } catch (_) {
    return { tab_id: tabId, exists: false };
  }
}

async function logBoundTabState(phase, requestId, tabId) {
  console.log("bridge_run_phase", {
    phase,
    bridge_run_id: requestId,
    tab_state: await boundTabState(tabId),
  });
}

/**
 * Réveille la boucle d'observation des onglets exacts encore en vol.
 * Déclenché par le ping serveur (20 s), donc par une horloge extérieure à la
 * page : c'est ce qui rend la détection de fin indépendante du throttling
 * d'arrière-plan sans jamais activer ni focaliser l'onglet.
 */
function pumpObservationTicks() {
  for (const [requestId, tabId] of inflight.entries()) {
    chrome.tabs
      .sendMessage(tabId, { type: "observe_tick", id: requestId })
      .catch(() => {});
  }
}

/** Erreur de routage typée : `.code` est ce que le serveur doit voir, jamais aplati. */
class BridgeRoutingError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

/** Erreur structurée du cleanup d'une conversation identifiée. */
class ConversationArchiveError extends Error {
  constructor(code, message, { retryable = false, details = {} } = {}) {
    super(message || code);
    this.code = code;
    this.retryable = retryable;
    this.phase = "conversation_archive";
    this.details = details;
  }
}

function archiveDiagnosticDetails(value, binding) {
  const details = {};
  for (const field of ["tab_id", "window_id", "window_closed", "operation"]) {
    const candidate = value?.[field];
    if (typeof candidate === "boolean" || typeof candidate === "number") {
      details[field] = candidate;
    } else if (typeof candidate === "string") {
      details[field] = candidate.slice(0, 128);
    }
  }
  if (typeof details.tab_id !== "number" && typeof binding?.tab_id === "number") {
    details.tab_id = binding.tab_id;
  }
  if (typeof details.window_id !== "number" && typeof binding?.window_id === "number") {
    details.window_id = binding.window_id;
  }
  return details;
}

const requestStatesReady = chrome.storage.local.get("bridgeRequestStates").then(({ bridgeRequestStates }) => {
  for (const [id, state] of Object.entries(bridgeRequestStates || {})) requestStates.set(id, state);
});

// Métadonnées de rejeu final : utiles après coup (recovery, idempotence),
// jamais des bindings d'onglet vivants. Restent en chrome.storage.local.
const replayMetadataReady = chrome.storage.local
  .get([
    "bridgeRequestConversationResults",
    "bridgeRequestExtensionMetadata",
    "bridgeRequestFinalOutputs",
    "bridgeRequestConversationBindings",
  ])
  .then(
    ({
      bridgeRequestConversationResults,
      bridgeRequestExtensionMetadata,
      bridgeRequestFinalOutputs,
      bridgeRequestConversationBindings,
    }) => {
      for (const [id, value] of Object.entries(bridgeRequestConversationResults || {})) {
        requestConversationResults.set(id, value);
      }
      for (const [id, value] of Object.entries(bridgeRequestExtensionMetadata || {})) {
        requestExtensionMetadata.set(id, value);
      }
      for (const [id, value] of Object.entries(bridgeRequestFinalOutputs || {})) {
        if (typeof value === "string") requestFinalOutputs.set(id, value);
      }
      for (const [id, value] of Object.entries(bridgeRequestConversationBindings || {})) {
        requestConversationBindings.set(id, value);
      }
    },
  );

// Le registre de sessions live vit exclusivement dans chrome.storage.session :
// il doit survivre à une suspension/relance du service worker, mais jamais à
// un redémarrage du navigateur ou un rechargement de l'extension.
const conversationRegistryReady = chrome.storage.session
  .get("bridgeConversationRegistry")
  .then(({ bridgeConversationRegistry }) => {
    for (const [id, entry] of Object.entries(bridgeConversationRegistry || {})) {
      conversationRegistry.set(id, entry);
    }
  });

const closedConversationRegistryReady = chrome.storage.session
  .get("bridgeClosedConversationRegistry")
  .then(({ bridgeClosedConversationRegistry }) => {
    for (const [id, entry] of Object.entries(bridgeClosedConversationRegistry || {})) {
      closedConversationRegistry.set(id, entry);
    }
  });

const browserTargetRegistryReady = chrome.storage.session
  .get("bridgeBrowserTargetRegistry")
  .then(({ bridgeBrowserTargetRegistry }) => {
    for (const [id, entry] of Object.entries(bridgeBrowserTargetRegistry || {})) {
      browserTargetRegistry.set(id, entry);
    }
  });

function persistRequestStates() {
  const entries = [...requestStates.entries()].slice(-1000);
  chrome.storage.local.set({ bridgeRequestStates: Object.fromEntries(entries) });
}

function persistReplayMetadata() {
  chrome.storage.local.set({
    bridgeRequestConversationResults: Object.fromEntries([...requestConversationResults.entries()].slice(-1000)),
    bridgeRequestExtensionMetadata: Object.fromEntries([...requestExtensionMetadata.entries()].slice(-1000)),
    bridgeRequestFinalOutputs: Object.fromEntries([...requestFinalOutputs.entries()].slice(-50)),
    bridgeRequestConversationBindings: Object.fromEntries(
      [...requestConversationBindings.entries()].slice(-1000),
    ),
  });
}

function persistConversationRegistry() {
  chrome.storage.session.set({
    bridgeConversationRegistry: Object.fromEntries(conversationRegistry.entries()),
  });
}

function persistClosedConversationRegistry() {
  chrome.storage.session.set({
    bridgeClosedConversationRegistry: Object.fromEntries(closedConversationRegistry.entries()),
  });
}

function persistBrowserTargetRegistry() {
  chrome.storage.session.set({
    bridgeBrowserTargetRegistry: Object.fromEntries(browserTargetRegistry.entries()),
  });
}

async function serverUrl() {
  const { serverUrl } = await chrome.storage.local.get("serverUrl");
  return serverUrl || DEFAULT_URL;
}

async function authenticatedServerUrl() {
  const [url, stored] = await Promise.all([serverUrl(), chrome.storage.local.get("wsToken")]);
  const parsed = new URL(url);
  if (stored.wsToken) parsed.searchParams.set("token", stored.wsToken);
  return parsed.toString();
}

async function persistentBridgeInstanceId() {
  if (!bridgeInstanceIdPromise) {
    bridgeInstanceIdPromise = (async () => {
      const { bridgeInstanceId: storedId } = await chrome.storage.local.get("bridgeInstanceId");
      if (typeof storedId === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(storedId)) {
        return storedId.toLowerCase();
      }
      const instanceId = crypto.randomUUID();
      await chrome.storage.local.set({ bridgeInstanceId: instanceId });
      return instanceId;
    })();
  }
  return bridgeInstanceIdPromise;
}

function setStatus(patch) {
  status = { ...status, ...patch };
  chrome.storage.local.set({ status });
}

function socketIsOwned(socketToCheck) {
  return (
    socketToCheck &&
    (socketToCheck.readyState === WebSocket.OPEN ||
      socketToCheck.readyState === WebSocket.CONNECTING ||
      socketToCheck.readyState === WebSocket.CLOSING)
  );
}

async function connect() {
  if (socketIsOwned(socket) || connectAttempt) {
    return;
  }
  // Un autre client détient volontairement le pont : ne pas le lui reprendre
  // en boucle (sinon les deux se volent la connexion indéfiniment).
  if (Date.now() < suppressUntil) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  const attempt = {};
  const startingGeneration = connectionGeneration;
  connectAttempt = attempt;
  try {
    const displayUrl = await serverUrl();
    const url = await authenticatedServerUrl();
    const instanceId = await persistentBridgeInstanceId();
    if (connectAttempt !== attempt) return;
    if (socketIsOwned(socket)) return;
    if (Date.now() < suppressUntil) return;
    setStatus({ url: displayUrl });

    if (socket && socket.readyState === WebSocket.CLOSED) socket = null;
    let ws;
    const identity = {
      instance_id: instanceId,
      worker_session_id: workerSessionId,
      connection_id: crypto.randomUUID(),
      extension_version: chrome.runtime.getManifest().version,
    };
    try {
      ws = new WebSocket(url);
    } catch (err) {
      scheduleReconnect(null, String(err), { generation: startingGeneration, attempt });
      return;
    }
    const generation = ++connectionGeneration;
    socket = ws;
    connectAttempt = null;

    ws.onopen = () => {
      if (socket !== ws) return;
      reconnectDelay = RECONNECT_MIN;
      connectionIdentity = identity;
      openedConnections += 1;
      lastPingAt = null;
      suppressReason = null;
      setStatus({ connected: true, lastError: null });
      send({ type: "hello", client: "extension-chrome", ...identity });
      flush(); // rejoue ce qui a été produit pendant la coupure
      console.log("🤖 Connecté au Mini-Bridge", displayUrl, enAttente.length ? "(file non vidée)" : "");
    };

    ws.onmessage = (event) => {
      if (socket !== ws) return;
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type === "ping") {
        lastPingAt = Date.now();
        send({ type: "pong" }); // maintient aussi le service worker éveillé
        pumpObservationTicks();
        return;
      }
      if (msg.type === "prompt") {
        handlePrompt(msg);
      } else if (msg.type === "ui_state" || msg.type === "ui_control") {
        handleUiRequest(msg);
      } else if (msg.type === "conversation_archive") {
        handleConversationArchive(msg);
      } else if (msg.type === "recovery_capture") {
        handleRecoveryCapture(msg);
      } else if (msg.type === "browser_target_retain") {
        handleBrowserTargetRetain(msg);
      } else if (msg.type === "browser_target_release") {
        handleBrowserTargetRelease(msg);
      } else if (msg.type === "abort") {
        const tabId = inflight.get(msg.id);
        inflight.delete(msg.id);
        if (tabId !== undefined) {
          chrome.tabs.sendMessage(tabId, { type: "abort", id: msg.id }).catch(() => {});
        }
      }
    };

    ws.onclose = (event) => {
      if (socket !== ws) {
        console.debug("stale_socket_close_ignored", { generation, code: event.code });
        return;
      }
      if (event.code === 4000) {
        // Le serveur nous a remplacés par un autre client (fake_extension.py,
        // un second profil Chrome…). On s'efface au lieu de reprendre la main.
        suppressUntil = Date.now() + REPLACED_BACKOFF;
        suppressReason = "replaced";
        scheduleReconnect(ws, "remplacé par un autre client du pont", { generation });
        return;
      }
      if (event.code === 4409 && event.reason === "owner_active") {
        // Un autre owner détient un lease sain : attendre avant toute nouvelle
        // tentative évite une oscillation entre plusieurs profils Chrome.
        suppressUntil = Date.now() + REPLACED_BACKOFF;
        suppressReason = "owner_active";
        scheduleReconnect(ws, "owner_active", { generation });
        return;
      }
      scheduleReconnect(ws, null, { generation });
    };
    ws.onerror = () => {
      if (socket !== ws) return;
      setStatus({ lastError: "serveur injoignable" });
    };
  } finally {
    if (connectAttempt === attempt) connectAttempt = null;
  }
}

async function handleRecoveryCapture(msg) {
  if (msg.browser_target) {
    let tab;
    try {
      tab = await resolveRecoverableBrowserTarget(msg.browser_target, msg.bridge_run_id);
    } catch (err) {
      send({
        type: "recovery_preview",
        id: msg.id,
        code: err.code || "recovery_unavailable",
        error: err.message,
      });
      return;
    }
    try {
      const result = await sendToTab(tab.id, msg);
      send({
        ...result,
        type: "recovery_preview",
        id: msg.id,
        target_id: msg.browser_target.id,
        bridge_run_id: msg.bridge_run_id,
        tab_id: tab.id,
      });
    } catch (err) {
      send({
        type: "recovery_preview",
        id: msg.id,
        code: "recovery_unavailable",
        error: err.message,
        target_id: msg.browser_target.id,
        bridge_run_id: msg.bridge_run_id,
        tab_id: tab.id,
      });
    }
    return;
  }
  await conversationRegistryReady;
  const known = conversationRegistry.get(msg.conversation.id);
  if (!known) {
    send({ type: "recovery_preview", id: msg.id, error: "conversation_unavailable" });
    return;
  }
  let tab;
  try {
    tab = await chrome.tabs.get(known.tab_id);
  } catch {
    // L'onglet n'existe plus : la session live est perdue, jamais reconstruite.
    conversationRegistry.delete(msg.conversation.id);
    persistConversationRegistry();
    send({ type: "recovery_preview", id: msg.id, error: "conversation_unavailable" });
    return;
  }
  if (!isAllowedChatOrigin(tab.url)) {
    send({ type: "recovery_preview", id: msg.id, error: "conversation_unavailable" });
    return;
  }
  try {
    const result = await sendToTab(tab.id, msg);
    send({ ...result, type: "recovery_preview", id: msg.id });
  } catch (err) {
    send({ type: "recovery_preview", id: msg.id, error: err.message });
  }
}

async function handleConversationArchive(msg) {
  const conversationId = msg.conversation_id;
  let known = null;
  try {
    await Promise.all([conversationRegistryReady, closedConversationRegistryReady]);
    known = conversationRegistry.get(conversationId);
    const previouslyClosed = closedConversationRegistry.get(conversationId);
    console.log(
      "🗂️ conversation_archive reçu — ferme la session Temporary Chat exacte (jamais " +
        "écrite dans l'historique ChatGPT, donc rien à y supprimer)",
      { conversation_id: conversationId, tab_id: known?.tab_id ?? previouslyClosed?.tab_id ?? null },
    );

    if (!known) {
      if (
        previouslyClosed?.conversation_id === conversationId &&
        previouslyClosed?.close_state === "closed"
      ) {
        const packet = {
          type: "conversation_archive",
          id: msg.id,
          ok: true,
          conversation_id: conversationId,
          close_state: "already_closed",
          tab_id: previouslyClosed.tab_id,
          window_id: previouslyClosed.window_id,
          phase: "conversation_archive",
        };
        send(packet);
        return packet;
      }
      throw new ConversationArchiveError(
        "conversation_binding_missing",
        "aucun binding exact n'est enregistré pour cette conversation",
      );
    }

    if (
      typeof known.tab_id !== "number" ||
      typeof known.window_id !== "number" ||
      known.tab_id < 0 ||
      known.window_id < 0
    ) {
      throw new ConversationArchiveError(
        "conversation_registry_inconsistent",
        "le binding exact de la conversation est incohérent",
        { details: { tab_id: known.tab_id ?? null, window_id: known.window_id ?? null } },
      );
    }

    const closed = await closeBoundTargetWithOptions(known, { strict: true });
    const packet = {
      type: "conversation_archive",
      id: msg.id,
      ok: true,
      conversation_id: conversationId,
      close_state: closed?.close_state || "closed",
      tab_id: known.tab_id,
      window_id: known.window_id,
      phase: "conversation_archive",
    };
    closedConversationRegistry.set(conversationId, {
      conversation_id: conversationId,
      tab_id: known.tab_id,
      window_id: known.window_id,
      close_state: "closed",
      closed_at: Date.now(),
    });
    conversationRegistry.delete(conversationId);
    persistConversationRegistry();
    persistClosedConversationRegistry();
    send(packet);
    return packet;
  } catch (err) {
    const packet = {
      type: "conversation_archive",
      id: msg.id,
      ok: false,
      conversation_id: conversationId,
      code:
        typeof err?.code === "string" && err.code.length > 0
          ? err.code.slice(0, 64)
          : "conversation_archive_internal_error",
      message: String(err?.message || "échec interne de fermeture").slice(0, 512),
      retryable: typeof err?.retryable === "boolean" ? err.retryable : false,
      phase:
        typeof err?.phase === "string" ? err.phase.slice(0, 64) : "conversation_archive",
      details: archiveDiagnosticDetails(err?.details, known),
    };
    send(packet);
    return packet;
  }
}

function scheduleReconnect(ownerSocket, error, options = {}) {
  if (ownerSocket && socket !== ownerSocket) return false;
  if (options.attempt && connectAttempt !== options.attempt) return false;
  if (
    options.generation !== undefined &&
    connectionGeneration !== options.generation
  ) {
    return false;
  }
  if (ownerSocket) socket = null;
  setStatus({ connected: false, lastError: error || status.lastError });
  clearTimeout(reconnectTimer);
  const delay = Math.max(reconnectDelay, suppressUntil - Date.now());
  const generation = options.generation ?? connectionGeneration;
  reconnectTimer = setTimeout(() => {
    if (generation !== connectionGeneration || socket !== null) return;
    reconnectTimer = null;
    void connect();
  }, delay);
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX);
  return true;
}

const MAX_EN_ATTENTE = 500;
/** Messages produits alors que le socket était fermé, rejoués à la reconnexion. */
const enAttente = [];

/**
 * Un service worker MV3 peut être arrêté puis relancé à tout moment ; son
 * WebSocket est alors refermé et rouvert. Jeter les messages produits pendant
 * cet intervalle faisait perdre des réponses entières (le client HTTP restait
 * bloqué jusqu'au timeout). On les met donc en file d'attente.
 */
function send(payload) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
    return;
  }
  if (enAttente.length < MAX_EN_ATTENTE) enAttente.push(payload);
  if (!socket || socket.readyState === WebSocket.CLOSED) void connect();
}

function flush() {
  while (enAttente.length && socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(enAttente.shift()));
  }
}

/** Onglet ChatGPT le plus pertinent : actif en priorité, sinon le plus récent.
 *  Réservé aux opérations sans conversation (lecture/pilotage d'UI). Ne
 *  participe jamais au routage d'une conversation identifiée. */
async function findChatTab() {
  const tabs = await chrome.tabs.query({
    url: ["https://chatgpt.com/*", "https://chat.openai.com/*"],
  });
  if (tabs.length === 0) return null;
  return tabs.find((t) => t.active) || tabs[tabs.length - 1];
}

/**
 * Onglet diagnostiqué : la priorité suit la chaîne réelle du run, du plus
 * exact au plus générique. Un onglet ChatGPT quelconque n'est JAMAIS préféré à
 * une cible du bridge, et le diagnostic dit toujours de quelle source il parle
 * (`diagnostic_target.source` + `bridge_owned`).
 *
 *   1. inflight      : l'onglet exact du run en cours (Map `inflight`) ;
 *   2. browser_target: la target exacte réservée pour un run stateless ;
 *   3. bridge_conversation : le binding retenu (KEEP / recovery) d'une
 *      conversation live, retrouvé par `tabs.get` exact ;
 *   4. bridge_owned_tab : un onglet ChatGPT vivant dans une fenêtre possédée
 *      par le bridge — la propriété est prouvée, l'onglet ne l'est pas ;
 *   5. generic_chatgpt_tab : dernier recours assumé, `bridge_owned: false`.
 */
async function findDiagnosticChatTab() {
  const exact = async (tabId, source, bridgeOwned) => {
    try {
      const tab = await chrome.tabs.get(tabId);
      return { tab, source, bridge_owned: bridgeOwned };
    } catch {
      return null;
    }
  };
  for (const tabId of [...new Set([...inflight.values()].reverse())]) {
    const found = await exact(tabId, "inflight", true);
    if (found) return found;
  }
  await Promise.all([browserTargetRegistryReady, conversationRegistryReady]);
  const bound = async (entries, source) => {
    for (const entry of entries) {
      if (entry?.bridge_owned_window !== true || !Number.isInteger(entry.tab_id)) continue;
      const found = await exact(entry.tab_id, source, true);
      if (found) return found;
    }
    return null;
  };
  const browserTarget = await bound([...browserTargetRegistry.values()].reverse(), "browser_target");
  if (browserTarget) return browserTarget;
  const conversation = await bound(
    [...conversationRegistry.values()].reverse(),
    "bridge_conversation",
  );
  if (conversation) return conversation;
  // Le filtre d'URL est refait ici : le diagnostic ne dépend pas de la
  // sémantique exacte de `chrome.tabs.query({ url })` côté navigateur.
  const tabs = (
    await chrome.tabs.query({
      url: ["https://chatgpt.com/*", "https://chat.openai.com/*"],
    })
  ).filter((tab) => isAllowedChatOrigin(tab.url));
  if (tabs.length === 0) return null;
  const ownedWindows = new Set();
  for (const entry of [...browserTargetRegistry.values(), ...conversationRegistry.values()]) {
    if (entry?.bridge_owned_window !== true || !Number.isInteger(entry.window_id)) continue;
    ownedWindows.add(entry.window_id);
  }
  const ownedTab = tabs.find((tab) => ownedWindows.has(tab.windowId));
  if (ownedTab) {
    return { tab: ownedTab, source: "bridge_owned_tab", bridge_owned: true };
  }
  const active = tabs.find((tab) => tab.active);
  if (active) return { tab: active, source: "generic_chatgpt_tab", bridge_owned: false };
  const recent = tabs.reduce((newest, tab) => {
    if (typeof tab.lastAccessed === "number" && typeof newest.lastAccessed === "number") {
      return tab.lastAccessed > newest.lastAccessed ? tab : newest;
    }
    return tabs.indexOf(tab) > tabs.indexOf(newest) ? tab : newest;
  });
  return { tab: recent, source: "generic_chatgpt_tab", bridge_owned: false };
}

/**
 * État de connexion du point de vue du worker, sans contenu ni secret :
 * seuls des préfixes d'identifiants, des compteurs et des âges bornés.
 */
function connectionDiagnostic(now = Date.now()) {
  const open = socket?.readyState === WebSocket.OPEN;
  let state;
  if (now < suppressUntil) state = "conflict";
  else if (!socket) state = "disconnected";
  else if (!open) state = "connecting";
  else if (lastPingAt !== null && now - lastPingAt > PING_STALE_MS) state = "stale";
  else state = "stable";
  const prefix = (value) => (typeof value === "string" ? value.slice(0, 8) : null);
  const current = open ? connectionIdentity : null;
  return {
    state,
    conflict_reason: state === "conflict" ? suppressReason : null,
    instance_id_prefix: prefix(current?.instance_id),
    worker_session_prefix: prefix(workerSessionId),
    connection_id_prefix: prefix(current?.connection_id),
    reconnections: Math.max(0, openedConnections - 1),
    seconds_since_ping:
      open && lastPingAt !== null ? Math.max(0, Math.round((now - lastPingAt) / 1000)) : null,
  };
}

function diagnosticCount(value) {
  return Number.isInteger(value) ? Math.max(0, Math.min(value, 999)) : 0;
}

const RESPONSE_STRATEGIES = new Set(["semantic_assistant", "markdown_root_delta"]);
const SURFACE_STRATEGIES = new Set([
  "composer_main",
  "composer_scroll_container",
  "composer_parent",
  "document_main",
  "document_body",
]);

/**
 * Contrat de réponse (ResponseRoot) : surface, stratégie, comptages et
 * dernière décision du locator. Liste blanche fermée — jamais un texte, jamais
 * un nœud, jamais une référence DOM.
 */
function safeResponseLocator(raw) {
  const locator = raw || {};
  const tag = ["DIV", "ARTICLE", "SECTION", "SPAN", "P"].includes(
    locator.candidate_root_tag,
  )
    ? locator.candidate_root_tag
    : null;
  return {
    conversation_surface: locator.conversation_surface === true,
    surface_strategy: SURFACE_STRATEGIES.has(locator.surface_strategy)
      ? locator.surface_strategy
      : null,
    strategy: RESPONSE_STRATEGIES.has(locator.strategy) ? locator.strategy : null,
    baseline_root_count: diagnosticCount(locator.baseline_root_count),
    current_root_count: diagnosticCount(locator.current_root_count),
    candidate_found: locator.candidate_found === true,
    candidate_root_tag: tag,
    markdown_root: locator.markdown_root === true,
    inline_leaf_count: diagnosticCount(locator.inline_leaf_count),
    ambiguity_count: diagnosticCount(locator.ambiguity_count),
    candidate_state: ["idle", "pending", "found", "broken"].includes(locator.candidate_state)
      ? locator.candidate_state
      : "idle",
    reason: ["ambiguous_root", "inline_without_root", "surface_missing"].includes(locator.reason)
      ? locator.reason
      : null,
  };
}

function safeDomHealth(raw, tabId, diagnosticTarget) {
  const statuses = new Set(["ok", "degraded", "missing", "ambiguous", "invalid", "not_rendered_idle"]);
  const composerStrategies = new Set(["named_selector", "structural_fallback"]);
  const sendStrategies = composerStrategies;
  const composerSelectors = new Set([
    "[data-composer-markdown][contenteditable='true'][role='textbox']",
    "#prompt-textarea",
    "[data-testid='prompt-textarea']",
    "div[contenteditable='true'][id^='prompt']",
    "textarea[data-id]",
    "[contenteditable='true'][role='textbox']",
  ]);
  const sendSelectors = new Set([
    "button[data-testid='send-button']",
    "#composer-submit-button",
    "button[aria-label*='Envoyer']",
    "button[aria-label*='Send']",
    "button[type='submit']",
  ]);
  const surface = raw?.surface || {};
  const composer = raw?.composer || {};
  const send = raw?.send || {};
  const normalizeStatus = (value, fallback = "missing") =>
    statuses.has(value) ? value : fallback;
  const strategy = (value, allowed) => (allowed.has(value) ? value : null);
  const fixedSelector = (value, allowed) => (allowed.has(value) ? value : null);
  const tag = ["DIV", "TEXTAREA", "INPUT"].includes(composer.tag) ? composer.tag : null;
  const sendType = ["button", "submit", "reset", "other"].includes(send.type)
    ? send.type
    : null;

  return {
    ok: raw?.ok === true,
    content_script_version:
      typeof raw?.content_script_version === "string"
        ? raw.content_script_version.slice(0, 20)
        : null,
    tab_id: Number.isInteger(tabId) ? tabId : null,
    diagnostic_target: {
      source: ["inflight", "browser_target", "bridge_conversation", "bridge_owned_tab", "generic_chatgpt_tab"].includes(diagnosticTarget?.source)
        ? diagnosticTarget.source
        : "generic_chatgpt_tab",
      bridge_owned: diagnosticTarget?.bridge_owned === true,
    },
    extension_state: "active",
    websocket_state: status.connected ? "connected" : "disconnected",
    connection: connectionDiagnostic(),
    surface: {
      origin_ok: surface.origin_ok === true,
      pathname: typeof surface.pathname === "string" ? surface.pathname.slice(0, 128) : "",
      temporary_query: surface.temporary_query === true,
      temporary_status: normalizeStatus(surface.temporary_status, "invalid"),
      visibility_state: ["visible", "hidden", "prerender", "unloaded"].includes(
        surface.visibility_state,
      )
        ? surface.visibility_state
        : "unknown",
      has_focus: surface.has_focus === true,
    },
    composer: {
      status: normalizeStatus(composer.status),
      strategy: strategy(composer.strategy, composerStrategies),
      selector: fixedSelector(composer.selector, composerSelectors),
      visible_candidates: diagnosticCount(composer.visible_candidates),
      known_selector_candidates: diagnosticCount(composer.known_selector_candidates),
      structural_candidates: diagnosticCount(composer.structural_candidates),
      tag,
      role: composer.role === "textbox" ? "textbox" : null,
      contenteditable: composer.contenteditable === true,
      data_composer_markdown: composer.data_composer_markdown === true,
      form_found: composer.form_found === true,
    },
    send: {
      status: normalizeStatus(send.status),
      strategy: strategy(send.strategy, sendStrategies),
      selector: fixedSelector(send.selector, sendSelectors),
      visible_candidates: diagnosticCount(send.visible_candidates),
      type: sendType,
      disabled: send.disabled === true,
      aria_disabled: send.aria_disabled === true,
      same_form_as_composer: typeof send.same_form_as_composer === "boolean"
        ? send.same_form_as_composer
        : null,
    },
    response_locator: safeResponseLocator(raw?.response_locator),
    // État vivant du run : le worker le recopie filtré, il ne le recompute pas.
    run: safeRunState(raw?.run),
  };
}

async function handleUiDiagnostic() {
  const target = await findDiagnosticChatTab();
  if (!target) {
    return {
      ok: false,
      error: "no_chatgpt_tab",
      extension_state: "active",
      websocket_state: status.connected ? "connected" : "disconnected",
      connection: connectionDiagnostic(),
    };
  }
  const { tab } = target;
  try {
    const health = await chrome.tabs.sendMessage(tab.id, { type: "dom_health" });
    return safeDomHealth(health, tab.id, target);
  } catch {
    return {
      ok: false,
      error: "content_script_unavailable",
      tab_id: Number.isInteger(tab.id) ? tab.id : null,
      diagnostic_target: {
        source: target.source,
        bridge_owned: target.bridge_owned === true,
      },
      extension_state: "active",
      websocket_state: status.connected ? "connected" : "disconnected",
      connection: connectionDiagnostic(),
    };
  }
}

// --------------------------------------------------------------------------- //
// Snapshot structurel borné (« Copy response structure »)
//
// Le worker ne recopie jamais la page : chaque champ traverse une liste
// blanche fermée (tag, tokens de classe bornés, role, data-testid, data-*
// autorisés, profondeur, nombre d'enfants, dimensions, visibilité). Aucune
// propriété textuelle n'est jamais acceptée — ni texte, ni innerHTML, ni
// corps de réponse, ni prompt.
// --------------------------------------------------------------------------- //

const STRUCTURE_LIMITS = {
  depth: 6,
  nodes: 200,
  children: 40,
  class_tokens: 8,
  token_length: 40,
  value_length: 64,
};
const STRUCTURE_DATA_KEYS = new Set([
  "testid",
  "author_role",
  "turn",
  "state",
  "is_streaming",
  "composer_markdown",
  "aria_hidden",
]);
const STRUCTURE_TAGS = new Set([
  "DIV",
  "SPAN",
  "P",
  "UL",
  "OL",
  "LI",
  "PRE",
  "CODE",
  "TABLE",
  "TBODY",
  "THEAD",
  "TR",
  "TD",
  "TH",
  "BLOCKQUOTE",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "A",
  "STRONG",
  "EM",
  "HR",
  "BR",
  "IMG",
  "VIDEO",
  "CANVAS",
  "MAIN",
  "SECTION",
  "ARTICLE",
  "FORM",
  "BUTTON",
]);

/** Compteur borné : jamais un NaN, jamais une valeur non finie. */
function structureCount(value) {
  return Number.isInteger(value) ? Math.max(0, Math.min(value, 999)) : 0;
}

/** Token de classe : borné, jamais un caractère de balisage ni d'espace. */
function structureToken(value) {
  return typeof value === "string" &&
    value.length <= STRUCTURE_LIMITS.token_length &&
    !/[\s"'<>\\]/.test(value)
    ? value
    : null;
}

/** Valeur d'attribut sûre : courte et sans caractère de balisage. */
function structureValue(value) {
  return typeof value === "string" &&
    value.length <= STRUCTURE_LIMITS.value_length &&
    !/[\s"'<>\\]/.test(value)
    ? value
    : null;
}

function safeStructureData(raw) {
  const data = {};
  if (!raw || typeof raw !== "object") return data;
  for (const [key, value] of Object.entries(raw)) {
    if (!STRUCTURE_DATA_KEYS.has(key)) continue;
    if (value === true) {
      data[key] = true;
      continue;
    }
    const bounded = structureValue(value);
    if (bounded !== null) data[key] = bounded;
  }
  return data;
}

function safeStructureNode(raw, depth, budget) {
  if (!raw || typeof raw !== "object" || depth > STRUCTURE_LIMITS.depth) return null;
  budget.nodes += 1;
  const children = [];
  if (Array.isArray(raw.children)) {
    for (const child of raw.children.slice(0, STRUCTURE_LIMITS.children)) {
      if (budget.nodes >= STRUCTURE_LIMITS.nodes) break;
      const node = safeStructureNode(child, depth + 1, budget);
      if (node) children.push(node);
    }
  }
  const dimension = (value) =>
    Number.isInteger(value) && value >= 0 && value <= 100000 ? value : null;
  return {
    tag: STRUCTURE_TAGS.has(raw.tag) ? raw.tag : null,
    class_tokens: Array.isArray(raw.class_tokens)
      ? raw.class_tokens
          .slice(0, STRUCTURE_LIMITS.class_tokens)
          .map(structureToken)
          .filter((token) => token !== null && token !== "")
      : [],
    role: structureValue(raw.role),
    data_testid: structureValue(raw.data_testid),
    data: safeStructureData(raw.data),
    has_message_id: raw.has_message_id === true,
    depth,
    children_count: structureCount(raw.children_count),
    children,
    width: dimension(raw.width),
    height: dimension(raw.height),
    visible: raw.visible === true,
  };
}

function safeRootStrategy(value) {
  return RESPONSE_STRATEGIES.has(value) ? value : null;
}

/** Copie bornée du snapshot structurel : aucune propriété textuelle, jamais. */
function safeResponseStructure(raw, tabId, diagnosticTarget) {
  const surface = raw?.conversation_surface || {};
  const roots = Array.isArray(raw?.roots) ? raw.roots : [];
  return {
    ok: raw?.ok === true,
    content_script_version:
      typeof raw?.content_script_version === "string"
        ? raw.content_script_version.slice(0, 20)
        : null,
    tab_id: Number.isInteger(tabId) ? tabId : null,
    diagnostic_target: {
      source: ["inflight", "browser_target", "bridge_conversation", "bridge_owned_tab", "generic_chatgpt_tab"].includes(diagnosticTarget?.source)
        ? diagnosticTarget.source
        : "generic_chatgpt_tab",
      bridge_owned: diagnosticTarget?.bridge_owned === true,
    },
    conversation_surface: {
      found: surface.found === true,
      strategy: SURFACE_STRATEGIES.has(surface.strategy) ? surface.strategy : null,
      node: surface.node ? safeStructureNode(surface.node, 0, { nodes: 0 }) : null,
    },
    strategy: safeRootStrategy(raw?.strategy),
    markdown_root_matches: structureCount(raw?.markdown_root_matches),
    semantic_assistant_matches: structureCount(raw?.semantic_assistant_matches),
    inline_leaf_matches: structureCount(raw?.inline_leaf_matches),
    roots: roots
      .slice(0, STRUCTURE_LIMITS.nodes)
      .map((root) => ({
        strategy: safeRootStrategy(root?.strategy),
        node: safeStructureNode(root?.node, 0, { nodes: 0 }),
      }))
      .filter((root) => root.node !== null),
  };
}

const RUN_STATES = new Set(["idle", "waiting", "active", "quiescent", "final"]);
const RUN_SIGNALS = new Set([
  "unknown",
  "streaming",
  "reasoning",
  "stop_button",
  "assistant_actions",
  "output_stable",
  "quiescent_stability",
]);
const RUN_MODES = new Set(["terminal_action", "quiescent_stability"]);
const RUN_CONFIDENCES = new Set(["low", "medium", "high"]);
const RUN_PHASES = /^[a-z_]{1,32}$/;
const RUN_SERIALIZER = /^[a-z][a-z0-9.-]{0,31}$/;

/**
 * État vivant du run (finalisation + sérialisation + réveils), en liste blanche
 * fermée : comptages, booléens, durées, chaînes bornées. Jamais un contenu,
 * jamais un nœud, jamais un identifiant d'onglet complet. Le worker et le popup
 * ne recalculent aucune finalisation : ils recopient l'état que la boucle du
 * content script a réellement maintenu et utilisé pour décider.
 */
function safeRunState(raw) {
  const run = raw || {};
  const bounded = (value) =>
    Number.isInteger(value) && value >= 0 && value <= 1000000 ? value : 0;
  const duration = (value) =>
    Number.isFinite(value) ? Math.max(0, Math.round(value)) : null;
  const signals = run.signals || {};
  const serialization = run.serialization || {};
  const observation = run.observation || {};
  const lastWake = observation.last_wake || {};
  const threshold = run.stable_threshold_ms;
  return {
    active: run.active === true,
    phase: typeof run.phase === "string" && RUN_PHASES.test(run.phase) ? run.phase : "idle",
    state: RUN_STATES.has(run.state) ? run.state : "idle",
    mode: RUN_MODES.has(run.mode) ? run.mode : null,
    signal: RUN_SIGNALS.has(run.signal) ? run.signal : null,
    confidence: RUN_CONFIDENCES.has(run.confidence) ? run.confidence : null,
    output_chars: bounded(run.output_chars),
    stable_for_ms: bounded(run.stable_for_ms),
    stable_threshold_ms: Number.isFinite(threshold) && threshold >= 0
      ? Math.round(threshold)
      : null,
    stable_observations: bounded(run.stable_observations),
    signals: {
      actions: signals.actions === true,
      streaming: signals.streaming === true,
      reasoning: signals.reasoning === true,
      stop: signals.stop === true,
    },
    serialization: {
      root_found: typeof serialization.root_found === "boolean"
        ? serialization.root_found
        : null,
      serializer: typeof serialization.serializer === "string" &&
        RUN_SERIALIZER.test(serialization.serializer)
        ? serialization.serializer
        : null,
      last_serialize: ["ok", "error"].includes(serialization.last_serialize)
        ? serialization.last_serialize
        : null,
      ms: bounded(serialization.ms),
    },
    observation: {
      last_wake: {
        mutation: bounded(lastWake.mutation),
        observe_tick: bounded(lastWake.observe_tick),
        timer: bounded(lastWake.timer),
      },
      ms_since_observation: duration(observation.ms_since_observation),
      ms_since_dom_mutation: duration(observation.ms_since_dom_mutation),
    },
  };
}
/**
 * État vivant seul, pour le popup ouvert pendant un run : même sélection de
 * cible que le diagnostic complet, même liste blanche, aucune observation de
 * plus. Un onglet sans run rend `active: false` — jamais un état hérité.
 */
async function handleRunState() {
  const target = await findDiagnosticChatTab();
  if (!target) {
    return {
      ok: false,
      error: "no_chatgpt_tab",
      diagnostic_target: { source: "generic_chatgpt_tab", bridge_owned: false },
      run: safeRunState(null),
    };
  }
  const { tab } = target;
  const diagnostic_target = {
    source: target.source,
    bridge_owned: target.bridge_owned === true,
  };
  try {
    const run = await chrome.tabs.sendMessage(tab.id, { type: "run_state" });
    return {
      ok: true,
      error: null,
      tab_id: Number.isInteger(tab.id) ? tab.id : null,
      diagnostic_target,
      run: safeRunState(run),
    };
  } catch {
    return {
      ok: false,
      error: "content_script_unavailable",
      tab_id: Number.isInteger(tab.id) ? tab.id : null,
      diagnostic_target,
      run: safeRunState(null),
    };
  }
}

async function handleResponseStructure() {
  const target = await findDiagnosticChatTab();
  if (!target) return { ok: false, error: "no_chatgpt_tab" };
  const { tab } = target;
  try {
    const structure = await chrome.tabs.sendMessage(tab.id, {
      type: "response_structure",
    });
    return safeResponseStructure(structure, tab.id, target);
  } catch {
    return {
      ok: false,
      error: "content_script_unavailable",
      tab_id: Number.isInteger(tab.id) ? tab.id : null,
    };
  }
}

/** Un onglet appartient-il à une origine ChatGPT autorisée ? Jamais une identité. */
function isAllowedChatOrigin(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && ALLOWED_CHAT_ORIGINS.includes(url.origin);
  } catch {
    return false;
  }
}

async function waitForTab(tabId) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") return tab;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("chargement de la conversation expiré");
}

// --------------------------------------------------------------------------- //
// Fenêtre Chrome dédiée
//
// Un onglet créé `active: false` dans la fenêtre de l'opérateur reste un onglet
// d'arrière-plan : `document.visibilityState` y vaut `hidden` pendant toute la
// génération. Une production réelle de ~13 min l'a prouvé (`started_hidden=true`,
// terminée seulement après une visite humaine de la page).
//
// L'expérience testée ici est différente : chaque Temporary Chat live devient
// l'onglet *actif* de sa *propre* fenêtre Chrome, elle-même *non focalisée*.
// Attendu côté page : `visibilityState=visible`, `hasFocus()=false`.
//
// Une fenêtre par Temporary Chat, jamais une fenêtre partagée : une seule
// fenêtre ne peut avoir qu'un onglet actif, donc deux générations simultanées
// dans une même fenêtre recréeraient exactement le défaut d'arrière-plan.
//
// Interdits : demander le focus à la création, mettre à jour le focus d'une
// fenêtre, activer un onglet dans la fenêtre de l'opérateur, ou minimiser la
// fenêtre dédiée (une fenêtre minimisée peut remettre la page en cycle de vie
// masqué et invaliderait l'expérience).
// --------------------------------------------------------------------------- //

/**
 * Crée un Temporary Chat comme onglet actif d'une fenêtre dédiée non focalisée.
 * L'onglet est résolu explicitement depuis le `windowId` exact — jamais par une
 * recherche d'URL, jamais « le premier onglet chatgpt.com ».
 */
async function createDedicatedTemporaryChat() {
  if (!chrome.windows?.create) {
    throw new BridgeRoutingError(
      "conversation_unavailable",
      "chrome.windows indisponible : aucune fenêtre dédiée ne peut être créée",
    );
  }
  const created = await chrome.windows.create({
    url: TEMPORARY_CHAT_URL,
    type: "normal",
    focused: false,
    state: "normal",
  });
  const windowId = created?.id;
  if (typeof windowId !== "number") {
    throw new BridgeRoutingError(
      "conversation_unavailable",
      "la fenêtre dédiée n'a pas d'identifiant exact",
    );
  }
  try {
    const tabs = await chrome.tabs.query({ windowId });
    if (tabs.length !== 1) {
      throw new BridgeRoutingError(
        "conversation_unavailable",
        "la fenêtre dédiée ne contient pas exactement un onglet",
      );
    }
    const [candidate] = tabs;
    if (candidate.windowId !== windowId || typeof candidate.id !== "number") {
      throw new BridgeRoutingError(
        "conversation_unavailable",
        "l'onglet créé n'appartient pas à la fenêtre dédiée",
      );
    }
    const loaded = await waitForTab(candidate.id);
    if (loaded.windowId !== windowId) {
      throw new BridgeRoutingError(
        "conversation_unavailable",
        "l'onglet a quitté la fenêtre dédiée avant d'être chargé",
      );
    }
    if (!isAllowedChatOrigin(loaded.url)) {
      throw new BridgeRoutingError(
        "conversation_unavailable",
        "l'onglet Temporary Chat créé n'est pas sur une origine ChatGPT",
      );
    }
    if (loaded.active !== true) {
      throw new BridgeRoutingError(
        "conversation_unavailable",
        "l'onglet Temporary Chat n'est pas actif dans sa fenêtre dédiée",
      );
    }
    let windowFocused = null;
    let windowState = null;
    let windowType = null;
    try {
      const window = await chrome.windows.get(windowId);
      windowFocused = window?.focused ?? null;
      windowState = window?.state ?? null;
      windowType = window?.type ?? null;
    } catch (_) {
      // Diagnostic seulement : ne jamais faire échouer une réservation valide.
    }
    console.log("bridge_run_phase", {
      phase: "dedicated_window_created",
      window_id: windowId,
      tab_id: loaded.id,
      tab_active: loaded.active ?? null,
      window_focused: windowFocused,
      window_state: windowState,
      window_type: windowType,
    });
    return { window_id: windowId, tab: loaded };
  } catch (err) {
    await removeWindowById(windowId);
    if (err instanceof BridgeRoutingError) throw err;
    throw new BridgeRoutingError(
      "conversation_unavailable",
      `création de la fenêtre dédiée impossible : ${err.message}`,
    );
  }
}

/**
 * La fenêtre dédiée créée par le bridge est-elle toujours celle qui héberge
 * l'onglet ? Un binding réécrit depuis un événement du content script ne doit
 * jamais revendiquer une fenêtre que le bridge n'a pas ouverte.
 */
function ownsDedicatedWindow(existing, observedWindowId) {
  if (existing?.bridge_owned_window !== true) return false;
  if (typeof observedWindowId !== "number") return false;
  return existing.window_id === observedWindowId;
}

async function removeWindowById(windowId) {
  if (typeof windowId !== "number" || !chrome.windows?.remove) return;
  await chrome.windows.remove(windowId).catch(() => {});
}

/**
 * Ferme la ressource exacte d'un binding.
 *
 * Une fenêtre n'est fermée que si la propriété est *prouvée* depuis l'entrée de
 * registre créée par le bridge : `bridge_owned_window`, l'onglet exact existe
 * encore, il est toujours dans cette fenêtre, et cette fenêtre ne contient que
 * lui. Sinon — propriété non prouvable, ou onglets ajoutés par l'opérateur — on
 * ne ferme au plus que l'onglet exact du bridge. Jamais une fenêtre repérée
 * parce qu'elle contient une URL ChatGPT.
 */
async function closeBoundTarget(binding) {
  return closeBoundTargetWithOptions(binding);
}

async function closeBoundTargetWithOptions(binding, { strict = false } = {}) {
  const tabId = binding?.tab_id;
  if (typeof tabId !== "number") return;
  const windowId = binding.window_id;
  if (
    typeof windowId !== "number" ||
    !chrome.windows?.get
  ) {
    if (strict) {
      throw new ConversationArchiveError(
        "conversation_registry_inconsistent",
        "le binding exact ne contient pas une fenêtre exploitable",
        { details: { tab_id: tabId, window_id: windowId ?? null } },
      );
    }
    await chrome.tabs.remove(tabId).catch(() => {});
    return { close_state: "closed", window_closed: false };
  }
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (_) {
    if (strict) {
      throw new ConversationArchiveError(
        "conversation_tab_missing",
        "l'onglet exact de la conversation n'existe plus",
        { details: { tab_id: tabId, window_id: windowId } },
      );
    }
    return;
  }
  if (tab.windowId !== windowId) {
    // The exact tab is still the only safe target. Do not touch either window.
    try {
      await chrome.tabs.remove(tabId);
    } catch (err) {
      if (strict) {
        throw new ConversationArchiveError(
          "conversation_tab_close_failed",
          `fermeture de l'onglet exact impossible : ${err?.message || err}`,
          { retryable: true, details: { tab_id: tabId, window_id: windowId } },
        );
      }
    }
    return { close_state: "closed", window_closed: false };
  }

  let ownershipProven = false;
  try {
    const window = await chrome.windows.get(windowId, { populate: true });
    const tabs = window?.tabs || [];
    if (binding.bridge_owned_window !== true) {
      ownershipProven = false;
    } else {
      ownershipProven = tabs.length === 1 && tabs[0]?.id === tabId;
    }
  } catch (_) {
    if (strict) {
      throw new ConversationArchiveError(
        "conversation_registry_inconsistent",
        "la fenêtre exacte du binding n'est plus exploitable",
        { details: { tab_id: tabId, window_id: windowId } },
      );
    }
  }
  if (ownershipProven) {
    try {
      await chrome.windows.remove(windowId);
    } catch (err) {
      if (strict) {
        throw new ConversationArchiveError(
          "conversation_window_close_failed",
          `fermeture de la fenêtre exacte impossible : ${err?.message || err}`,
          { retryable: true, details: { tab_id: tabId, window_id: windowId } },
        );
      }
      return;
    }
    console.log("bridge_run_phase", {
      phase: "dedicated_window_removed",
      window_id: windowId,
      tab_id: tabId,
    });
    return { close_state: "closed", window_closed: true };
  }
  try {
    await chrome.tabs.remove(tabId);
  } catch (err) {
    if (strict) {
      throw new ConversationArchiveError(
        "conversation_tab_close_failed",
        `fermeture de l'onglet exact impossible : ${err?.message || err}`,
        { retryable: true, details: { tab_id: tabId, window_id: windowId } },
      );
    }
  }
  return { close_state: "closed", window_closed: false };
}

function isBrowserTarget(value) {
  if (!value || typeof value !== "object") return false;
  const keys = Object.keys(value).sort();
  return (
    keys.length === 2 &&
    keys[0] === "id" &&
    keys[1] === "kind" &&
    value.kind === "temporary_chat_run" &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    value.id.length <= 255 &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value.id)
  );
}

async function reserveBrowserTarget(browserTarget) {
  const targetId = browserTarget.id;
  const { window_id: windowId, tab: loaded } = await createDedicatedTemporaryChat();
  await setTabAutoDiscardable(loaded.id, false);
  browserTargetRegistry.set(targetId, {
    target_id: targetId,
    tab_id: loaded.id,
    window_id: windowId,
    bridge_owned_window: true,
    state: "reserved",
    last_verified_at: Date.now(),
  });
  persistBrowserTargetRegistry();
  console.log("bridge_run_phase", {
    phase: "browser_target_reserved",
    target_id: targetId,
    tab_id: loaded.id,
    window_id: windowId,
  });
  return loaded;
}

/** Résout exclusivement le binding exact d'une cible stateless request-scoped. */
async function resolveBrowserTarget(browserTarget) {
  if (!isBrowserTarget(browserTarget)) {
    throw new BridgeRoutingError("bridge_browser_target_required", "browser_target invalide");
  }
  await browserTargetRegistryReady;
  const targetId = browserTarget.id;
  const known = browserTargetRegistry.get(targetId);
  if (known) {
    if (known.state === "recoverable" || known.recoverable === true) {
      throw new BridgeRoutingError(
        "recovery_unavailable",
        "la browser_target est conservée pour un recovery explicite",
      );
    }
    try {
      const tab = await chrome.tabs.get(known.tab_id);
      if (!isAllowedChatOrigin(tab.url)) throw new Error("origine invalide");
      return tab;
    } catch {
      // Une target connue mais perdue ne doit jamais être réparée par une
      // recherche d'URL ou par la création d'un second onglet sous la même id.
      browserTargetRegistry.delete(targetId);
      persistBrowserTargetRegistry();
      throw new BridgeRoutingError(
        "conversation_unavailable",
        "l'onglet exact de la browser_target n'existe plus",
      );
    }
  }
  const pending = browserTargetReservations.get(targetId);
  if (pending) return pending;
  const reservation = reserveBrowserTarget(browserTarget);
  browserTargetReservations.set(targetId, reservation);
  try {
    return await reservation;
  } finally {
    browserTargetReservations.delete(targetId);
  }
}

/**
 * Résout uniquement une target déjà conservée après une fin ambiguë.
 * Cette fonction ne partage volontairement pas le chemin de réservation : un
 * recovery ne peut jamais créer un nouvel onglet ou réanimer une identité.
 */
async function resolveRecoverableBrowserTarget(browserTarget, bridgeRunId) {
  if (!isBrowserTarget(browserTarget) || typeof bridgeRunId !== "string" || !bridgeRunId) {
    throw new BridgeRoutingError("recovery_unavailable", "binding de recovery invalide");
  }
  await browserTargetRegistryReady;
  const targetId = browserTarget.id;
  const known = browserTargetRegistry.get(targetId);
  if (
    !known ||
    known.target_id !== targetId ||
    known.bridge_run_id !== bridgeRunId ||
    (known.state !== "recoverable" && known.recoverable !== true)
  ) {
    throw new BridgeRoutingError(
      "recovery_unavailable",
      "aucun binding exact de recovery n'est disponible",
    );
  }
  try {
    const tab = await chrome.tabs.get(known.tab_id);
    if (!isAllowedChatOrigin(tab.url)) throw new Error("origine invalide");
    return tab;
  } catch {
    // La disparition de l'onglet est une perte de session, jamais une raison
    // de créer une autre target sous le même identifiant.
    browserTargetRegistry.delete(targetId);
    persistBrowserTargetRegistry();
    throw new BridgeRoutingError(
      "recovery_unavailable",
      "l'onglet exact de recovery n'existe plus",
    );
  }
}

/**
 * Résout l'onglet exact d'une conversation identifiée par conversation.id.
 * L'URL n'est jamais une identité : `fresh` ouvre toujours un Temporary Chat
 * neuf, `continue` ne fait jamais que retrouver l'onglet déjà lié.
 */
async function resolveConversationTab(conversation) {
  if (!conversation?.id || !["fresh", "continue"].includes(conversation.mode)) {
    throw new BridgeRoutingError("conversation_unavailable", "cible de conversation invalide");
  }
  await conversationRegistryReady;

  if (conversation.mode === "fresh") {
    const existing = conversationRegistry.get(conversation.id);
    if (existing) {
      if (existing.state !== "reserved") {
        throw new BridgeRoutingError(
          "conversation_unavailable",
          "une session live existe déjà pour cette conversation : fresh refusé",
        );
      }
      try {
        const reserved = await chrome.tabs.get(existing.tab_id);
        if (!isAllowedChatOrigin(reserved.url)) throw new Error("origine invalide");
        return reserved;
      } catch {
        conversationRegistry.delete(conversation.id);
        persistConversationRegistry();
      }
    }
    const { window_id: windowId, tab: loaded } = await createDedicatedTemporaryChat();
    await setTabAutoDiscardable(loaded.id, false);
    conversationRegistry.set(conversation.id, {
      tab_id: loaded.id,
      window_id: windowId,
      bridge_owned_window: true,
      head_turn_id: null,
      state: "reserved",
      external_locator: null,
      last_verified_at: Date.now(),
    });
    persistConversationRegistry();
    return loaded;
  }

  // mode === "continue"
  if (!conversation.expected_turn_id) {
    throw new BridgeRoutingError("conversation_unavailable", "expected_turn_id requis pour continuer");
  }
  const known = conversationRegistry.get(conversation.id);
  if (!known) {
    throw new BridgeRoutingError("conversation_unavailable", "aucune session live pour cette conversation");
  }
  if (known.head_turn_id !== conversation.expected_turn_id) {
    throw new BridgeRoutingError(
      "conversation_unavailable",
      "expected_turn_id ne correspond pas au dernier tour connu de la session live",
    );
  }
  let tab;
  try {
    tab = await chrome.tabs.get(known.tab_id);
  } catch {
    // Onglet disparu : la session live est perdue, jamais reconstruite à
    // partir d'une URL ou de l'historique ChatGPT.
    conversationRegistry.delete(conversation.id);
    persistConversationRegistry();
    throw new BridgeRoutingError("conversation_unavailable", "l'onglet de la session live n'existe plus");
  }
  if (!isAllowedChatOrigin(tab.url)) {
    conversationRegistry.delete(conversation.id);
    persistConversationRegistry();
    throw new BridgeRoutingError("conversation_unavailable", "l'onglet a quitté l'origine ChatGPT");
  }
  if (busyTabs.has(tab.id)) {
    throw new BridgeRoutingError("conversation_busy", "l'onglet de cette conversation traite déjà une requête");
  }
  return tab;
}

async function routeTab(msg) {
  if (msg.conversation) return resolveConversationTab(msg.conversation);
  if (msg.browser_target) return resolveBrowserTarget(msg.browser_target);
  // Un prompt est toujours un run et ne bénéficie d'aucun fallback vers un
  // onglet choisi par URL/activité. `findChatTab` reste réservé aux sondes UI.
  if (msg.type === "prompt") {
    throw new BridgeRoutingError(
      "bridge_browser_target_required",
      "un run stateless exige une browser_target dédiée",
    );
  }
  return findChatTab();
}

/** Envoie une seule fois au content script déjà installé par le manifest. */
async function sendToTab(tabId, msg) {
  // Une erreur de réponse après livraison est ambiguë : réinjecter puis
  // renvoyer le prompt pourrait provoquer un second clic UI. Le manifest
  // installe déjà le content script sur les onglets ChatGPT ; une nouvelle
  // tentative passe par la clé d'idempotence du même run, jamais par un
  // deuxième POST DOM implicite.
  return await chrome.tabs.sendMessage(tabId, msg);
}

async function cleanupReservationAfterDeliveryFailure(msg, route) {
  if (msg.conversation?.mode === "fresh") {
    const binding = conversationRegistry.get(msg.conversation.id);
    if (binding?.state === "submitted" && binding.bridge_run_id === msg.id) {
      await closeBoundTarget(binding);
      conversationRegistry.delete(msg.conversation.id);
      persistConversationRegistry();
    }
  }
  await cleanupBrowserTargetForRequest(msg.id, route);
}

async function cleanupBrowserTargetForRequest(requestId, route = requestRoutes.get(requestId)) {
  const targetId = route?.target_id;
  if (!targetId) return;
  await browserTargetRegistryReady;
  const binding = browserTargetRegistry.get(targetId);
  if (!binding) return;
  if (binding.bridge_run_id && binding.bridge_run_id !== requestId) return;
  await closeBoundTarget(binding);
  browserTargetRegistry.delete(targetId);
  persistBrowserTargetRegistry();
  console.log("bridge_run_phase", {
    phase: "browser_target_released",
    target_id: targetId,
    tab_id: binding.tab_id,
    window_id: binding.window_id ?? null,
  });
}

async function retainBrowserTargetForRecovery(requestId, route = requestRoutes.get(requestId)) {
  const targetId = route?.target_id;
  if (!targetId) return;
  await browserTargetRegistryReady;
  const binding = browserTargetRegistry.get(targetId);
  if (!binding || binding.bridge_run_id !== requestId) return;
  browserTargetRegistry.set(targetId, {
    ...binding,
    target_id: targetId,
    state: "recoverable",
    recoverable: true,
    bridge_run_id: requestId,
    last_verified_at: Date.now(),
  });
  persistBrowserTargetRegistry();
  console.log("bridge_run_phase", {
    phase: "browser_target_recoverable",
    target_id: targetId,
    bridge_run_id: requestId,
    tab_id: binding.tab_id,
  });
}

function resultSubmissionState(msg) {
  const reported = msg.submission_state || msg.metadata?.submission_state;
  if (
    reported === "pre_submission" ||
    reported === "submission_attempted" ||
    reported === "post_submission"
  ) {
    return reported;
  }
  // An incomplete snapshot is emitted only after the confirmed send path.
  return msg.type === "incomplete" ? "post_submission" : null;
}

function isAmbiguousTargetOutcome(msg) {
  return (
    (msg.type === "incomplete" || msg.type === "error") &&
    ["submission_attempted", "post_submission"].includes(resultSubmissionState(msg))
  );
}

async function settleBrowserTargetForResult(requestId, route, msg) {
  if (isAmbiguousTargetOutcome(msg)) {
    await retainBrowserTargetForRecovery(requestId, route);
  } else {
    await cleanupBrowserTargetForRequest(requestId, route);
  }
}

async function handleBrowserTargetRetain(msg) {
  if (!isBrowserTarget(msg.browser_target) || typeof msg.run_id !== "string" || !msg.run_id) {
    return;
  }
  await retainBrowserTargetForRecovery(msg.run_id, {
    target_id: msg.browser_target.id,
  });
}

async function handleBrowserTargetRelease(msg) {
  if (!isBrowserTarget(msg.browser_target)) {
    return;
  }
  await cleanupBrowserTargetForRequest(msg.run_id || msg.id, {
    target_id: msg.browser_target.id,
  });
}

async function handlePrompt(msg) {
  await Promise.all([
    requestStatesReady,
    replayMetadataReady,
    conversationRegistryReady,
    browserTargetRegistryReady,
  ]);
  const known = requestStates.get(msg.id);
  if (known) {
    send({ type: "ack", id: msg.id, state: known, duplicate: true });
    if (known === "completed") {
      send({
        type: "done",
        id: msg.id,
        replayed: true,
        text: requestFinalOutputs.get(msg.id) || "",
        conversation: requestConversationResults.get(msg.id) || null,
        metadata: requestExtensionMetadata.get(msg.id) || null,
      });
    } else if (known === "needs_review") {
      send({
        type: "incomplete",
        id: msg.id,
        replayed: true,
        reason: "no_final_answer",
        text: "",
        conversation: requestConversationResults.get(msg.id) || null,
        metadata: requestExtensionMetadata.get(msg.id) || null,
      });
    }
    return;
  }
  // Réserver synchroniquement avant tout await ferme la course de deux paquets.
  requestStates.set(msg.id, "received");
  persistRequestStates();
  send({
    type: "ack",
    id: msg.id,
    state: "received",
    duplicate: false,
    target_id: msg.browser_target?.id || null,
  });
  let tab;
  try {
    tab = await routeTab(msg);
  } catch (err) {
    requestStates.set(msg.id, "failed");
    persistRequestStates();
    send({
      type: "error",
      id: msg.id,
      code: err.code || "bridge_server_error",
      message: err.message,
      phase: "pre_submission",
      submission_state: "pre_submission",
      target_id: msg.browser_target?.id || null,
      tab_id: null,
    });
    return;
  }
  if (!tab) {
    requestStates.set(msg.id, "failed");
    persistRequestStates();
    send({
      type: "error",
      id: msg.id,
      code: "bridge_extension_disconnected",
      message: "Aucun onglet chatgpt.com ouvert",
      phase: "pre_submission",
      submission_state: "pre_submission",
      target_id: msg.browser_target?.id || null,
      tab_id: null,
    });
    return;
  }
  if (busyTabs.has(tab.id)) {
    requestStates.set(msg.id, "failed");
    persistRequestStates();
    send({
      type: "error",
      id: msg.id,
      code: "conversation_busy",
      message: "l'onglet ChatGPT traite déjà une requête",
      phase: "pre_submission",
      submission_state: "pre_submission",
      target_id: msg.browser_target?.id || null,
      tab_id: null,
    });
    return;
  }
  inflight.set(msg.id, tab.id);
  requestRoutes.set(msg.id, {
    target_id: msg.browser_target?.id || null,
    tab_id: tab.id,
  });
  busyTabs.add(tab.id);
  // Pendant tout le run lié, Chrome ne doit pas décharger cet onglet exact :
  // un déchargement tue le content script et donc l'observation en cours.
  // C'est une protection contre le *discard*, jamais une activation.
  await setTabAutoDiscardable(tab.id, false);
  void logBoundTabState("bound_tab_state", msg.id, tab.id);
  if (msg.conversation?.mode === "fresh") {
    const binding = conversationRegistry.get(msg.conversation.id);
    if (binding?.state === "reserved") {
      conversationRegistry.set(msg.conversation.id, { ...binding, state: "submitted", bridge_run_id: msg.id });
      persistConversationRegistry();
      console.log("bridge_run_phase", { phase: "conversation_reserved", conversation_id: msg.conversation.id, tab_id: tab.id });
      console.log("bridge_run_phase", { phase: "conversation_submitted", conversation_id: msg.conversation.id, tab_id: tab.id });
    }
  }
  if (msg.browser_target) {
    const binding = browserTargetRegistry.get(msg.browser_target.id);
    if (binding) {
      browserTargetRegistry.set(msg.browser_target.id, {
        ...binding,
        state: "submitted",
        bridge_run_id: msg.id,
      });
      persistBrowserTargetRegistry();
    }
  }
  console.log("bridge_run_phase", {
    phase: "prompt_routed",
    target_id: msg.browser_target?.id || null,
    tab_id: tab.id,
  });
  send({
    type: "ack",
    id: msg.id,
    state: "running",
    duplicate: false,
    target_id: msg.browser_target?.id || null,
    tab_id: tab.id,
  });
  requestStates.set(msg.id, "running");
  persistRequestStates();
  try {
    await sendToTab(tab.id, msg);
  } catch (err) {
    const route = requestRoutes.get(msg.id);
    inflight.delete(msg.id);
    busyTabs.delete(tab.id);
    // chrome.tabs.sendMessage does not tell us whether the content script
    // received the packet before the delivery error.  Treat the handoff as
    // ambiguous: deleting the exact target here could lose a submitted
    // Temporary Chat, while retrying it could click Send twice.
    if (msg.browser_target) {
      await retainBrowserTargetForRecovery(msg.id, route);
    }
    requestStates.set(msg.id, "failed");
    persistRequestStates();
    send({
      type: "error",
      id: msg.id,
      code: "bridge_extension_disconnected",
      message: `Onglet injoignable : ${err.message}`,
      phase: "submission_confirmation",
      submission_state: "submission_attempted",
      target_id: msg.browser_target?.id || null,
      tab_id: tab.id,
    });
    requestRoutes.delete(msg.id);
  }
}

/**
 * Lecture ou pilotage de l'interface. Contrairement aux prompts, c'est un
 * échange requête/réponse : la réponse du content script est renvoyée telle
 * quelle au serveur, y compris quand elle décrit un échec — le serveur doit
 * pouvoir dire au client *pourquoi* un contrôle n'a pas pris.
 */
async function handleUiRequest(msg) {
  let tab;
  try {
    tab = await routeTab(msg);
  } catch (err) {
    send({
      type: msg.type,
      id: msg.id,
      ok: false,
      state: null,
      error: err.message,
      target_id: msg.browser_target?.id || null,
      tab_id: null,
    });
    return;
  }
  if (!tab) {
    send({
      type: msg.type,
      id: msg.id,
      ok: false,
      state: null,
      error: "Aucun onglet chatgpt.com ouvert",
      target_id: msg.browser_target?.id || null,
      tab_id: null,
    });
    return;
  }
  const route = {
    target_id: msg.browser_target?.id || null,
    tab_id: tab.id,
  };
  requestRoutes.set(msg.id, route);
  try {
    const answer = await sendToTab(tab.id, msg);
    if (!answer) throw new Error("aucune réponse du content script");
    send({ ...answer, type: msg.type, id: msg.id, ...route });
  } catch (err) {
    send({
      type: msg.type,
      id: msg.id,
      ok: false,
      state: null,
      error: `Onglet injoignable : ${err.message}`,
      ...route,
    });
  } finally {
    requestRoutes.delete(msg.id);
  }
}

// Remontée des paquets du content script vers le serveur.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "diagnose_ui") {
    void handleUiDiagnostic().then(
      sendResponse,
      () => sendResponse({
        ok: false,
        error: "diagnostic_failed",
        extension_state: "active",
        websocket_state: status.connected ? "connected" : "disconnected",
        connection: connectionDiagnostic(),
      }),
    );
    return true;
  }
  if (msg?.type === "status") {
    sendResponse({ ...status, connection: connectionDiagnostic() });
    return true;
  }
  if (msg?.type === "run_state") {
    // État vivant du run (finalisation / sérialisation / réveils), relu à
    // chaque rafraîchissement du popup : le popup n'invente aucun état.
    void handleRunState().then(
      sendResponse,
      () => sendResponse({
        ok: false,
        error: "diagnostic_failed",
        diagnostic_target: { source: "generic_chatgpt_tab", bridge_owned: false },
        run: safeRunState(null),
      }),
    );
    return true;
  }
  if (msg?.type === "response_structure") {
    // Snapshot structurel borné, demandé par le popup : le worker transmet la
    // question à l'onglet diagnostiqué puis ne recopie que la liste blanche.
    void handleResponseStructure().then(
      sendResponse,
      () => sendResponse({ ok: false, error: "diagnostic_failed" }),
    );
    return true;
  }
  if (msg?.type === "reconnect") {
    // Reconnexion manuelle : reprend le pont même si on vient d'être remplacé.
    reconnectDelay = RECONNECT_MIN;
    suppressUntil = 0;
    suppressReason = null;
    connect();
    sendResponse({ ok: true });
    return true;
  }
  if (
    [
      "ack",
      "heartbeat",
      "conversation_bound",
      "incomplete",
      "done",
      "error",
    ].includes(msg?.type)
  ) {
    const route = requestRoutes.get(msg.id);
    const senderTabId = sender.tab?.id ?? null;
    if (route?.target_id && senderTabId !== route.tab_id) {
      const mismatch = {
        type: "error",
        id: msg.id,
        code: "bridge_tab_mismatch",
        message: "un événement stateless provient d'un autre onglet que le prompt",
        phase: msg.phase || "generation",
        submission_state: msg.submission_state || "post_submission",
        target_id: route.target_id,
        tab_id: senderTabId,
      };
      const inflightTabId = inflight.get(msg.id);
      inflight.delete(msg.id);
      if (inflightTabId !== undefined) busyTabs.delete(inflightTabId);
      requestStates.set(msg.id, "failed");
      persistRequestStates();
      void settleBrowserTargetForResult(msg.id, route, mismatch);
      requestRoutes.delete(msg.id);
      send(mismatch);
      sendResponse({ ok: true });
      return true;
    }
    const sequence = (eventCounters.get(msg.id) || 0) + 1;
    eventCounters.set(msg.id, sequence);
    if (msg.type === "conversation_bound" && msg.conversation?.id) {
      const serverBinding = { ...msg.conversation };
      requestConversationBindings.set(msg.id, serverBinding);
      const existing = conversationRegistry.get(msg.conversation.id);
      conversationRegistry.set(msg.conversation.id, {
        tab_id: sender.tab?.id || null,
        window_id: sender.tab?.windowId ?? existing?.window_id ?? null,
        // La propriété de la fenêtre ne survit que si l'onglet est resté dans
        // exactement la fenêtre que le bridge a créée : sinon on repasse en
        // mode sûr (fermeture de l'onglet exact seulement).
        bridge_owned_window: ownsDedicatedWindow(existing, sender.tab?.windowId),
        head_turn_id: existing ? existing.head_turn_id : null,
        state: "submitted",
        // Diagnostic uniquement : jamais utilisé pour router ou rouvrir un onglet.
        external_locator: msg.conversation.external_locator ?? existing?.external_locator ?? null,
        last_verified_at: Date.now(),
      });
      persistConversationRegistry();
      console.log("bridge_run_phase", { phase: "conversation_bound", conversation_id: msg.conversation.id, tab_id: sender.tab?.id || null });
    }
    if (["done", "incomplete", "error"].includes(msg.type)) {
      const tabId = inflight.get(msg.id);
      inflight.delete(msg.id);
      if (tabId !== undefined) busyTabs.delete(tabId);
      // Le run lié est fini : l'onglet redevient déchargeable, sauf s'il reste
      // la session live d'une conversation (KEEP) ou d'une target conservée.
      if (tabId !== undefined) {
        void logBoundTabState("bound_tab_settled", msg.id, tabId);
      }
      requestStates.set(
        msg.id,
        msg.type === "done"
          ? "completed"
          : msg.type === "incomplete"
            ? "needs_review"
            : "failed",
      );
      if (msg.type === "done" && msg.conversation?.id) {
        requestConversationResults.set(msg.id, msg.conversation);
        const existing = conversationRegistry.get(msg.conversation.id);
        conversationRegistry.set(msg.conversation.id, {
          tab_id: sender.tab?.id || existing?.tab_id || null,
          window_id: sender.tab?.windowId ?? existing?.window_id ?? null,
          bridge_owned_window: ownsDedicatedWindow(existing, sender.tab?.windowId),
          // Le tour externe vérifié devient la nouvelle tête : c'est ce qui
          // autorise un futur CONTINUE (KEEP) sur exactement cet onglet.
          head_turn_id: msg.conversation.turn_id || existing?.head_turn_id || null,
          state: "live",
          external_locator: msg.conversation.external_locator ?? existing?.external_locator ?? null,
          last_verified_at: Date.now(),
        });
        persistConversationRegistry();
      }
      if (msg.type === "incomplete") {
        const binding = requestConversationBindings.get(msg.id);
        const live = binding && conversationRegistry.get(binding.id);
        const initialTurnId = msg.metadata?.initial_turn_id;
        if (live && typeof initialTurnId === "string" && initialTurnId) {
          conversationRegistry.set(binding.id, {
            ...live,
            state: "live",
            head_turn_id: initialTurnId,
            last_verified_at: Date.now(),
          });
          persistConversationRegistry();
        }
        if (binding) {
          const completedBinding = {
            ...binding,
            initial_assistant_turn_id: initialTurnId || binding.initial_assistant_turn_id || null,
          };
          requestConversationBindings.set(msg.id, completedBinding);
          requestConversationResults.set(msg.id, completedBinding);
        }
        if (msg.metadata) requestExtensionMetadata.set(msg.id, msg.metadata);
        persistReplayMetadata();
      }
      if (msg.type === "done" && msg.metadata) {
        requestExtensionMetadata.set(msg.id, msg.metadata);
      }
      if (msg.type === "done" && typeof msg.text === "string")
        requestFinalOutputs.set(msg.id, msg.text);
      if (msg.type === "done") persistReplayMetadata();
      if (msg.type === "error" && msg.conversation?.id && msg.submission_state === "pre_submission") {
        const binding = conversationRegistry.get(msg.conversation.id);
        if (binding?.state === "submitted" && binding.bridge_run_id === msg.id) {
          void closeBoundTarget(binding);
          conversationRegistry.delete(msg.conversation.id);
          persistConversationRegistry();
        }
      }
      const targetRoute = route;
      persistRequestStates();
      if (targetRoute?.target_id) {
        void settleBrowserTargetForResult(msg.id, targetRoute, msg);
      }
      if (tabId !== undefined) void releaseTabAutoDiscardable(tabId);
      requestRoutes.delete(msg.id);
    }
    send({
      ...msg,
      target_id: route?.target_id ?? msg.target_id ?? null,
      tab_id: senderTabId ?? route?.tab_id ?? null,
      event_id: `${msg.id}:${sequence}`,
    });
  }
  sendResponse({ ok: true });
  return true;
});

// Nettoyage proactif : un onglet fermé ou parti hors origine ChatGPT ne doit
// jamais laisser un binding vivant pointer dans le vide.
chrome.tabs.onRemoved.addListener((tabId) => {
  // Fermeture manuelle de l'onglet ou de la fenêtre dédiée pendant un run.
  // Les bindings sont purgés d'abord, *puis* l'échec est émis : rien ne doit
  // ressusciter une target qui pointerait vers un onglet définitivement mort.
  const lost = [...inflight.entries()].filter(([, boundTabId]) => boundTabId === tabId);
  let changed = false;
  for (const [id, entry] of conversationRegistry.entries()) {
    if (entry.tab_id === tabId) {
      conversationRegistry.delete(id);
      changed = true;
    }
  }
  if (changed) persistConversationRegistry();
  let browserChanged = false;
  for (const [targetId, entry] of browserTargetRegistry.entries()) {
    if (entry.tab_id === tabId) {
      browserTargetRegistry.delete(targetId);
      browserChanged = true;
    }
  }
  if (browserChanged) persistBrowserTargetRegistry();
  for (const [requestId] of lost) {
    void failRunOnLostBoundTab(
      requestId,
      tabId,
      "l'onglet ChatGPT lié (ou sa fenêtre dédiée) a été fermé pendant le run",
    );
  }
});

/**
 * Une fenêtre dédiée disparue emporte ses bindings. Chrome émet déjà
 * `tabs.onRemoved` pour chacun de ses onglets ; ce filet ne fait que garantir
 * qu'aucun binding ne prétend posséder une fenêtre qui n'existe plus.
 */
chrome.windows?.onRemoved?.addListener((windowId) => {
  let changed = false;
  for (const [id, entry] of conversationRegistry.entries()) {
    if (entry.bridge_owned_window === true && entry.window_id === windowId) {
      conversationRegistry.delete(id);
      changed = true;
    }
  }
  if (changed) persistConversationRegistry();
  let browserChanged = false;
  for (const [targetId, entry] of browserTargetRegistry.entries()) {
    if (entry.bridge_owned_window === true && entry.window_id === windowId) {
      browserTargetRegistry.delete(targetId);
      browserChanged = true;
    }
  }
  if (browserChanged) persistBrowserTargetRegistry();
});

/**
 * Onglet lié perdu pendant un run : déchargé par Chrome, ou fermé à la main
 * (onglet ou fenêtre dédiée) par l'opérateur.
 *
 * Le content script est mort avec la page : plus aucun heartbeat n'arrivera et
 * la génération observée est perdue. On le dit tout de suite, de façon typée et
 * *fermée* — le run échoue en `post_submission` (donc ambigu : sa target exacte
 * est conservée pour une recovery explicite). Jamais de resoumission, jamais
 * d'onglet de remplacement, jamais d'activation pour « réveiller » l'onglet.
 */
async function failRunOnLostBoundTab(
  requestId,
  tabId,
  message = "l'onglet ChatGPT lié a été déchargé par le navigateur (tab discarded)",
) {
  const route = requestRoutes.get(requestId);
  inflight.delete(requestId);
  busyTabs.delete(tabId);
  requestStates.set(requestId, "failed");
  persistRequestStates();
  const packet = {
    type: "error",
    id: requestId,
    code: "bridge_extension_disconnected",
    message,
    phase: "generation",
    submission_state: "post_submission",
    retryable: false,
    diagnostics: { tab_state: await boundTabState(tabId) },
    target_id: route?.target_id ?? null,
    tab_id: tabId,
  };
  if (route) await settleBrowserTargetForResult(requestId, route, packet);
  requestRoutes.delete(requestId);
  send(packet);
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.discarded !== true) return;
  for (const [requestId, boundTabId] of [...inflight.entries()]) {
    if (boundTabId === tabId) void failRunOnLostBoundTab(requestId, tabId);
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // Seul un changement d'origine invalide le binding : une navigation à
  // l'intérieur de chatgpt.com (query/path) ne le fait jamais, l'URL n'étant
  // pas l'identité de la conversation.
  if (!changeInfo.url || isAllowedChatOrigin(changeInfo.url)) return;
  let changed = false;
  for (const [id, entry] of conversationRegistry.entries()) {
    if (entry.tab_id === tabId) {
      conversationRegistry.delete(id);
      changed = true;
    }
  }
  if (changed) persistConversationRegistry();
  let browserChanged = false;
  for (const [targetId, entry] of browserTargetRegistry.entries()) {
    if (entry.tab_id === tabId) {
      browserTargetRegistry.delete(targetId);
      browserChanged = true;
    }
  }
  if (browserChanged) persistBrowserTargetRegistry();
  // Plus aucun binding : l'onglet n'a plus à être protégé du déchargement.
  if (changed || browserChanged) void setTabAutoDiscardable(tabId, true);
});

// Réveils : le service worker MV3 peut être arrêté quand il est inactif.
chrome.alarms.create("keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(connect);
chrome.runtime.onStartup.addListener(connect);

chrome.runtime.onInstalled.addListener(async () => {
  connect();
  // Chrome ne remplace pas le content script des onglets déjà ouverts quand on
  // recharge l'extension : sans ça, l'ancien code continue de tourner et les
  // corrections passent inaperçues. On recharge donc les onglets concernés.
  const tabs = await chrome.tabs.query({
    url: ["https://chatgpt.com/*", "https://chat.openai.com/*"],
  });
  for (const tab of tabs) {
    chrome.tabs.reload(tab.id).catch(() => {});
  }
});

connect();
