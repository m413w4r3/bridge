const dot = document.getElementById("dot");
const state = document.getElementById("state");
const detail = document.getElementById("detail");
const url = document.getElementById("url");
const token = document.getElementById("token");
const ui = document.getElementById("ui");
const diagnosticFields = {
  temporary: document.getElementById("temporary-status"),
  composer: document.getElementById("composer-status"),
  send: document.getElementById("send-status"),
  version: document.getElementById("content-version"),
  extension: document.getElementById("extension-state"),
  connection: document.getElementById("connection-detail"),
  tab: document.getElementById("diagnostic-tab"),
  composerSelector: document.getElementById("composer-selector"),
  composerStrategy: document.getElementById("composer-strategy"),
  composerCandidates: document.getElementById("composer-candidates"),
  sendSelector: document.getElementById("send-selector"),
  sendStrategy: document.getElementById("send-strategy"),
  sendCandidates: document.getElementById("send-candidates"),
  message: document.getElementById("diagnostic-message"),
  json: document.getElementById("diagnostic-json"),
};
let diagnostic = null;

const COMPOSER_SELECTORS = new Set([
  "[data-composer-markdown][contenteditable='true'][role='textbox']",
  "#prompt-textarea",
  "[data-testid='prompt-textarea']",
  "div[contenteditable='true'][id^='prompt']",
  "textarea[data-id]",
  "[contenteditable='true'][role='textbox']",
]);
const SEND_SELECTORS = new Set([
  "button[data-testid='send-button']",
  "#composer-submit-button",
  "button[aria-label*='Envoyer']",
  "button[aria-label*='Send']",
  "button[type='submit']",
]);
const STATUSES = new Set(["ok", "degraded", "missing", "ambiguous", "invalid"]);
const CONNECTION_STATES = new Set(["stable", "connecting", "stale", "conflict", "disconnected"]);

function boundedCount(value) {
  return Number.isInteger(value) ? Math.max(0, Math.min(value, 999)) : 0;
}

/** Préfixe d'identifiant (8 caractères hex/tiret au plus), jamais un id complet. */
function idPrefix(value) {
  return typeof value === "string" && /^[0-9a-f-]{1,8}$/i.test(value) ? value : null;
}

function safeConnection(raw) {
  const connection = raw || {};
  const state = CONNECTION_STATES.has(connection.state) ? connection.state : "disconnected";
  return {
    state,
    conflict_reason:
      state === "conflict" && ["replaced", "owner_active"].includes(connection.conflict_reason)
        ? connection.conflict_reason
        : null,
    instance_id_prefix: idPrefix(connection.instance_id_prefix),
    worker_session_prefix: idPrefix(connection.worker_session_prefix),
    connection_id_prefix: idPrefix(connection.connection_id_prefix),
    reconnections: boundedCount(connection.reconnections),
    seconds_since_ping: Number.isInteger(connection.seconds_since_ping)
      ? Math.max(0, Math.min(connection.seconds_since_ping, 86400))
      : null,
  };
}

/** Copy only the fixed diagnostic contract; never pass arbitrary message data through. */
function safeDiagnostic(raw) {
  const version = /^\d{1,4}$/.test(raw?.content_script_version || "")
    ? raw.content_script_version
    : null;
  const base = {
    ok: raw?.ok === true,
    content_script_version: version,
    tab_id: Number.isInteger(raw?.tab_id) ? raw.tab_id : null,
    extension_state: raw?.extension_state === "active" ? "active" : "unknown",
    websocket_state: raw?.websocket_state === "connected" ? "connected" : "disconnected",
    connection: safeConnection(raw?.connection),
  };
  if (raw?.ok !== true) {
    return {
      ...base,
      error: ["no_chatgpt_tab", "content_script_unavailable", "diagnostic_failed"].includes(raw?.error)
        ? raw.error
        : "diagnostic_failed",
    };
  }

  const surface = raw.surface || {};
  const composer = raw.composer || {};
  const send = raw.send || {};
  const path = typeof surface.pathname === "string" && /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]{0,127}$/.test(surface.pathname)
    ? surface.pathname
    : "";
  return {
    ...base,
    surface: {
      origin_ok: surface.origin_ok === true,
      pathname: path,
      temporary_query: surface.temporary_query === true,
      temporary_status: STATUSES.has(surface.temporary_status) ? surface.temporary_status : "invalid",
      visibility_state: ["visible", "hidden", "prerender", "unloaded"].includes(surface.visibility_state)
        ? surface.visibility_state
        : "unknown",
      has_focus: surface.has_focus === true,
    },
    composer: {
      status: STATUSES.has(composer.status) ? composer.status : "missing",
      strategy: ["named_selector", "structural_fallback"].includes(composer.strategy) ? composer.strategy : null,
      selector: COMPOSER_SELECTORS.has(composer.selector) ? composer.selector : null,
      visible_candidates: boundedCount(composer.visible_candidates),
      known_selector_candidates: boundedCount(composer.known_selector_candidates),
      structural_candidates: boundedCount(composer.structural_candidates),
      tag: ["DIV", "TEXTAREA", "INPUT"].includes(composer.tag) ? composer.tag : null,
      role: composer.role === "textbox" ? "textbox" : null,
      contenteditable: composer.contenteditable === true,
      data_composer_markdown: composer.data_composer_markdown === true,
      form_found: composer.form_found === true,
    },
    send: {
      status: STATUSES.has(send.status) ? send.status : "missing",
      strategy: ["named_selector", "structural_fallback"].includes(send.strategy) ? send.strategy : null,
      selector: SEND_SELECTORS.has(send.selector) ? send.selector : null,
      visible_candidates: boundedCount(send.visible_candidates),
      type: ["button", "submit", "reset", "other"].includes(send.type) ? send.type : null,
      disabled: send.disabled === true,
      aria_disabled: send.aria_disabled === true,
      same_form_as_composer: send.same_form_as_composer === true,
    },
  };
}

function setStatus(element, value, fallback = "BROKEN") {
  const display = {
    ok: ["OK", "contract-good"],
    degraded: ["DEGRADED", "contract-warn"],
    missing: [fallback, "contract-bad"],
    ambiguous: ["AMBIGUOUS", "contract-bad"],
    invalid: ["INVALID", "contract-bad"],
  }[value] || [fallback, "contract-bad"];
  element.textContent = display[0];
  element.className = display[1];
}

function describeStrategy(strategy) {
  return {
    named_selector: "named selector",
    structural_fallback: "structural fallback",
  }[strategy] || "";
}

function renderDiagnostic(raw) {
  diagnostic = safeDiagnostic(raw);
  document.getElementById("copy-diagnostic").disabled = false;
  diagnosticFields.json.textContent = JSON.stringify(diagnostic, null, 2);
  diagnosticFields.json.hidden = false;
  const { connection } = diagnostic;
  diagnosticFields.extension.textContent =
    `${diagnostic.extension_state} / WebSocket ${connection.state.toUpperCase()}`;
  diagnosticFields.extension.className = {
    stable: "contract-good",
    connecting: "contract-warn",
    stale: "contract-bad",
    conflict: "contract-bad",
  }[connection.state] || "contract-bad";
  diagnosticFields.connection.textContent = [
    `instance ${connection.instance_id_prefix || "—"}`,
    `worker ${connection.worker_session_prefix || "—"}`,
    `connexion ${connection.connection_id_prefix || "—"}`,
    `reconnexions ${connection.reconnections}`,
    `dernier ping ${connection.seconds_since_ping == null ? "—" : `${connection.seconds_since_ping} s`}`,
    connection.conflict_reason ? `conflit ${connection.conflict_reason}` : null,
  ].filter(Boolean).join(" · ");

  if (!diagnostic.ok) {
    setStatus(diagnosticFields.temporary, "invalid");
    setStatus(diagnosticFields.composer, "missing");
    setStatus(diagnosticFields.send, "missing");
    diagnosticFields.version.textContent = "—";
    diagnosticFields.tab.textContent = diagnostic.tab_id == null ? "" : `Onglet #${diagnostic.tab_id}`;
    diagnosticFields.composerSelector.textContent = "—";
    diagnosticFields.composerStrategy.textContent = "";
    diagnosticFields.composerCandidates.textContent = "";
    diagnosticFields.sendSelector.textContent = "—";
    diagnosticFields.sendStrategy.textContent = "";
    diagnosticFields.sendCandidates.textContent = "";
    diagnosticFields.message.textContent = diagnostic.error === "no_chatgpt_tab"
      ? "Aucun onglet ChatGPT ouvert."
      : "Content script absent ou indisponible. Recharge l’onglet ChatGPT.";
    return;
  }

  const { surface, composer, send } = diagnostic;
  setStatus(diagnosticFields.temporary, surface.temporary_status, "INVALID");
  setStatus(diagnosticFields.composer, composer.status);
  setStatus(diagnosticFields.send, send.status);
  diagnosticFields.version.textContent = diagnostic.content_script_version
    ? `v${diagnostic.content_script_version}`
    : "inconnue";
  diagnosticFields.tab.textContent = diagnostic.tab_id == null ? "" : `Onglet #${diagnostic.tab_id}`;
  diagnosticFields.composerSelector.textContent = composer.selector || "Aucun sélecteur trouvé";
  diagnosticFields.composerStrategy.textContent = describeStrategy(composer.strategy);
  diagnosticFields.composerCandidates.textContent =
    `${composer.visible_candidates} visible · ${composer.known_selector_candidates} known · ${composer.structural_candidates} structural · form ${composer.form_found ? "yes" : "no"}`;
  diagnosticFields.sendSelector.textContent = send.selector || "Aucun sélecteur trouvé";
  diagnosticFields.sendStrategy.textContent = describeStrategy(send.strategy);
  diagnosticFields.sendCandidates.textContent =
    `${send.visible_candidates} visible · type ${send.type || "unknown"} · disabled ${send.disabled ? "yes" : "no"} · aria-disabled ${send.aria_disabled ? "yes" : "no"} · same form ${send.same_form_as_composer ? "yes" : "no"}`;
  diagnosticFields.message.textContent = "Diagnostic terminé. Aucun contenu de conversation n’a été lu.";
}

/**
 * Ce que le bridge annoncera dans /v1/bridge/capabilities, lu par le content
 * script. Affiché ici pour qu'un humain puisse le confronter à ce qu'il voit
 * réellement dans l'onglet — c'est tout l'intérêt d'un contrôle vérifiable.
 */
function describe(state) {
  if (!state) return "état de l'interface illisible";
  const modele = state.model.verified ? state.model.selected : `? (${state.model.reason})`;
  const recherche =
    state.web_search.verified
      ? state.web_search.enabled
        ? "activée"
        : "désactivée"
      : `? (${state.web_search.reason})`;
  return `Modèle : ${modele} — recherche web : ${recherche}`;
}

async function refresh() {
  const status = await chrome.runtime.sendMessage({ type: "status" });
  dot.classList.toggle("on", Boolean(status?.connected));
  state.textContent = status?.connected ? "Connecté au serveur" : "Déconnecté";
  detail.textContent = status?.connected ? status.url : status?.lastError || "serveur local arrêté ?";

  const tabs = await chrome.tabs.query({
    url: ["https://chatgpt.com/*", "https://chat.openai.com/*"],
  });
  if (tabs.length === 0) {
    detail.textContent += " — aucun onglet chatgpt.com ouvert";
    ui.textContent = "";
    return;
  }

  const tab = tabs.find((t) => t.active) || tabs[tabs.length - 1];
  try {
    const answer = await chrome.tabs.sendMessage(tab.id, { type: "ui_state" });
    ui.textContent = describe(answer && answer.state);
  } catch {
    ui.textContent = "content script absent de l'onglet (recharge la page)";
  }
}

document.getElementById("save").addEventListener("click", async () => {
  await chrome.storage.local.set({ serverUrl: url.value.trim(), wsToken: token.value });
  await chrome.runtime.sendMessage({ type: "reconnect" });
  setTimeout(refresh, 600);
});

document.getElementById("diagnose").addEventListener("click", async () => {
  const button = document.getElementById("diagnose");
  button.disabled = true;
  diagnosticFields.message.textContent = "Diagnostic en cours…";
  try {
    renderDiagnostic(await chrome.runtime.sendMessage({ type: "diagnose_ui" }));
  } catch {
    renderDiagnostic({ ok: false, error: "diagnostic_failed" });
  } finally {
    button.disabled = false;
  }
});

document.getElementById("copy-diagnostic").addEventListener("click", async () => {
  if (!diagnostic) return;
  const json = JSON.stringify(diagnostic, null, 2);
  try {
    await navigator.clipboard.writeText(json);
  } catch {
    const temporary = document.createElement("textarea");
    temporary.value = json;
    temporary.setAttribute("readonly", "");
    temporary.style.position = "fixed";
    temporary.style.opacity = "0";
    document.body.append(temporary);
    temporary.select();
    const copied = document.execCommand("copy");
    temporary.remove();
    if (!copied) {
      diagnosticFields.message.textContent = "Copie impossible depuis cette fenêtre.";
      return;
    }
  }
  diagnosticFields.message.textContent = "Diagnostic JSON copié.";
});

chrome.storage.local.get(["serverUrl", "wsToken"]).then(({ serverUrl, wsToken }) => {
  url.value = serverUrl || "ws://127.0.0.1:8001/ws";
  token.value = wsToken || "";
});
document.getElementById("copy-diagnostic").disabled = true;
refresh();
setInterval(refresh, 1500);
