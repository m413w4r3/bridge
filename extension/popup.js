const dot = document.getElementById("dot");
const state = document.getElementById("state");
const detail = document.getElementById("detail");
const url = document.getElementById("url");
const token = document.getElementById("token");
const ui = document.getElementById("ui");
const diagnosticFields = {
  target: document.getElementById("target-status"),
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
  surface: document.getElementById("surface-status"),
  strategy: document.getElementById("response-strategy"),
  baselineRoots: document.getElementById("baseline-roots"),
  rootsLabel: document.getElementById("roots-label"),
  currentRoots: document.getElementById("current-roots"),
  candidate: document.getElementById("candidate-status"),
  markdownRoot: document.getElementById("markdown-root"),
  inlineLeaves: document.getElementById("inline-leaves"),
  reasonRow: document.getElementById("locator-reason-row"),
  reason: document.getElementById("locator-reason"),
  finalizationState: document.getElementById("finalization-state"),
  finalizationSignalLabel: document.getElementById("finalization-signal-label"),
  finalizationSignal: document.getElementById("finalization-signal"),
  finalizationChars: document.getElementById("finalization-chars"),
  finalizationStable: document.getElementById("finalization-stable"),
  finalizationObservations: document.getElementById("finalization-observations"),
  finalizationActions: document.getElementById("finalization-actions"),
  finalizationStreaming: document.getElementById("finalization-streaming"),
  finalizationReasoning: document.getElementById("finalization-reasoning"),
  finalizationStop: document.getElementById("finalization-stop"),
  wake: document.getElementById("wake-detail"),
  serializationRoot: document.getElementById("serialization-root"),
  serializationSerializer: document.getElementById("serialization-serializer"),
  serializationLast: document.getElementById("serialization-last"),
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
const STATUSES = new Set(["ok", "degraded", "missing", "ambiguous", "invalid", "not_rendered_idle"]);
const CONNECTION_STATES = new Set(["stable", "connecting", "stale", "conflict", "disconnected"]);
const RESPONSE_STRATEGIES = new Set(["semantic_assistant", "markdown_root_delta"]);
const SURFACE_STRATEGIES = new Set([
  "composer_main",
  "composer_scroll_container",
  "composer_parent",
  "document_main",
  "document_body",
]);
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
  "DIV", "SPAN", "P", "UL", "OL", "LI", "PRE", "CODE", "TABLE", "TBODY",
  "THEAD", "TR", "TD", "TH", "BLOCKQUOTE", "H1", "H2", "H3", "H4", "H5",
  "H6", "A", "STRONG", "EM", "HR", "BR", "IMG", "VIDEO", "CANVAS", "MAIN",
  "SECTION", "ARTICLE", "FORM", "BUTTON",
]);

function boundedCount(value) {
  return Number.isInteger(value) ? Math.max(0, Math.min(value, 999)) : 0;
}

/** Contrat de réponse (ResponseRoot) : liste blanche fermée, jamais un texte. */
function safeResponseLocator(raw) {
  const locator = raw || {};
  return {
    conversation_surface: locator.conversation_surface === true,
    surface_strategy: SURFACE_STRATEGIES.has(locator.surface_strategy)
      ? locator.surface_strategy
      : null,
    strategy: RESPONSE_STRATEGIES.has(locator.strategy) ? locator.strategy : null,
    baseline_root_count: boundedCount(locator.baseline_root_count),
    current_root_count: boundedCount(locator.current_root_count),
    candidate_found: locator.candidate_found === true,
    candidate_root_tag: ["DIV", "ARTICLE", "SECTION", "SPAN", "P"].includes(
      locator.candidate_root_tag,
    )
      ? locator.candidate_root_tag
      : null,
    markdown_root: locator.markdown_root === true,
    inline_leaf_count: boundedCount(locator.inline_leaf_count),
    ambiguity_count: boundedCount(locator.ambiguity_count),
    candidate_state: ["idle", "pending", "found", "broken"].includes(locator.candidate_state)
      ? locator.candidate_state
      : "idle",
    reason: ["ambiguous_root", "inline_without_root", "surface_missing"].includes(locator.reason)
      ? locator.reason
      : null,
  };
}

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

/**
 * Rapport « un clic » : la chaîne complète du run, en liste blanche fermée.
 *
 *   target → input → response_locator → finalization → serialization
 *
 * Chaque section ne recopie que des comptages, des booléens, des durées, des
 * noms de sélecteurs et des stratégies connues. Aucun prompt, aucun texte de
 * réponse, aucun innerText/textContent/innerHTML, aucun jeton, jamais.
 */
function safeDiagnostic(raw) {
  const version = /^\d{1,4}$/.test(raw?.content_script_version || "")
    ? raw.content_script_version
    : null;
  const target = {
    source: ["inflight", "browser_target", "bridge_conversation", "bridge_owned_tab", "generic_chatgpt_tab"].includes(raw?.diagnostic_target?.source)
      ? raw.diagnostic_target.source
      : "generic_chatgpt_tab",
    bridge_owned: raw?.diagnostic_target?.bridge_owned === true,
  };
  const base = {
    ok: raw?.ok === true,
    version,
    tab_id: Number.isInteger(raw?.tab_id) ? raw.tab_id : null,
    target,
    extension_state: raw?.extension_state === "active" ? "active" : "unknown",
    websocket_state: raw?.websocket_state === "connected" ? "connected" : "disconnected",
    connection: safeConnection(raw?.connection),
    // Un run n'existe que dans un onglet qui appartient au bridge : un onglet
    // ChatGPT quelconque ne doit jamais afficher un état de finalisation.
    finalization: safeRunState(target.bridge_owned ? raw?.run : null),
  };
  if (raw?.ok !== true) {
    return {
      ...base,
      input: null,
      response_locator: null,
      serialization: null,
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
  const temporaryStatus = STATUSES.has(surface.temporary_status) ? surface.temporary_status : "invalid";
  const locator = safeResponseLocator(raw.response_locator);
  return {
    ...base,
    input: {
      // N/A (null) dès que l'onglet n'appartient pas au bridge : la question
      // « ce chat est-il temporaire ? » ne concerne pas l'onglet de l'opérateur.
      temporary_chat: target.bridge_owned ? temporaryStatus : null,
      surface: {
        origin_ok: surface.origin_ok === true,
        pathname: path,
        temporary_query: surface.temporary_query === true,
        temporary_status: temporaryStatus,
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
        same_form_as_composer: typeof send.same_form_as_composer === "boolean"
          ? send.same_form_as_composer
          : null,
      },
    },
    response_locator: locator,
    serialization: base.finalization.serialization,
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
function setStatus(element, value, fallback = "BROKEN") {
  const display = {
    ok: ["OK", "contract-good"],
    degraded: ["DEGRADED", "contract-warn"],
    not_rendered_idle: ["Idle / not rendered", "contract-neutral"],
    missing: [fallback, "contract-bad"],
    ambiguous: ["AMBIGUOUS", "contract-bad"],
    invalid: ["INVALID", "contract-bad"],
  }[value] || [fallback, "contract-bad"];
  element.textContent = display[0];
  element.className = display[1];
}

/** Copie défensive : presse-papiers, puis repli `execCommand` borné. */
async function copyText(value) {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    const temporary = document.createElement("textarea");
    temporary.value = value;
    temporary.setAttribute("readonly", "");
    temporary.style.position = "fixed";
    temporary.style.opacity = "0";
    document.body.append(temporary);
    temporary.select();
    const copied = document.execCommand("copy");
    temporary.remove();
    return copied;
  }
}

function describeStrategy(strategy) {
  return {
    named_selector: "named selector",
    structural_fallback: "structural fallback",
  }[strategy] || "";
}

const FINALIZATION_LABELS = {
  idle: ["Idle", "contract-neutral"],
  waiting: ["WAITING", "contract-neutral"],
  active: ["ACTIVE", "contract-warn"],
  quiescent: ["QUIESCENT", "contract-warn"],
  final: ["FINAL", "contract-good"],
};

const TARGET_LABELS = {
  inflight: "Bridge inflight",
  browser_target: "Bridge browser target",
  bridge_conversation: "Bridge conversation",
  bridge_owned_tab: "Bridge-owned tab",
  generic_chatgpt_tab: "Generic ChatGPT tab",
};

const LOCATOR_REASON_LABELS = {
  ambiguous_root: "ambiguous_root",
  inline_without_root: "inline_without_root",
  surface_missing: "surface_missing",
};

/** Durée lisible et bornée : jamais un flottant brut, jamais un NaN. */
function formatDuration(value) {
  if (!Number.isFinite(value)) return "—";
  if (value < 1000) return `${Math.round(value)} ms`;
  // Secondes jusqu'à dix minutes : « 85 s / 300 s » se compare d'un coup d'œil,
  // « 1.4 min / 5 min » non.
  if (value < 600000) return `${Number((value / 1000).toFixed(1))} s`;
  return `${Number((value / 60000).toFixed(1))} min`;
}

/** Oui/non borné : un état inconnu n'est jamais rendu comme « non ». */
function yesNo(value, tone = "contract-warn") {
  if (value === true) return ["yes", tone];
  if (value === false) return ["no", "contract-neutral"];
  return ["—", "contract-neutral"];
}

function setRow(element, text, className = "contract-neutral") {
  element.textContent = text;
  element.className = className;
}

/**
 * Sections « Finalization » et « Serialization » : elles ne lisent que l'état
 * vivant publié par la boucle du content script (aucune reconstruction, aucun
 * seuil inventé — le seuil affiché est celui que le runtime applique).
 */
function renderRun(run) {
  const finalization = run && typeof run === "object" ? run : null;
  if (!finalization) {
    setRow(diagnosticFields.finalizationState, "—");
    diagnosticFields.finalizationSignalLabel.textContent = "Signal";
    setRow(diagnosticFields.finalizationSignal, "—");
    setRow(diagnosticFields.finalizationChars, "—");
    setRow(diagnosticFields.finalizationStable, "—");
    setRow(diagnosticFields.finalizationObservations, "—");
    for (const field of [
      diagnosticFields.finalizationActions,
      diagnosticFields.finalizationStreaming,
      diagnosticFields.finalizationReasoning,
      diagnosticFields.finalizationStop,
    ]) {
      setRow(field, "—");
    }
    diagnosticFields.wake.textContent = "";
    setRow(diagnosticFields.serializationRoot, "—");
    setRow(diagnosticFields.serializationSerializer, "—");
    setRow(diagnosticFields.serializationLast, "—");
    return;
  }
  const [stateLabel, stateTone] = FINALIZATION_LABELS[finalization.state] || ["—", "contract-neutral"];
  setRow(diagnosticFields.finalizationState, stateLabel, stateTone);
  const active = finalization.active === true;
  // Pendant ACTIVE, le signal est *la* raison pour laquelle la finalisation ne
  // conclut pas : on le nomme comme tel plutôt que de le laisser deviner.
  diagnosticFields.finalizationSignalLabel.textContent =
    finalization.state === "active" ? "Blocking signal" : "Signal";
  setRow(
    diagnosticFields.finalizationSignal,
    active && finalization.signal ? finalization.signal : "—",
    finalization.state === "active" ? "contract-warn" : "contract-neutral",
  );
  setRow(diagnosticFields.finalizationChars, active ? String(finalization.output_chars) : "—");
  setRow(
    diagnosticFields.finalizationStable,
    active
      ? `${formatDuration(finalization.stable_for_ms)} / ${formatDuration(finalization.stable_threshold_ms)}`
      : "—",
    finalization.state === "active" ? "contract-warn" : "contract-neutral",
  );
  setRow(diagnosticFields.finalizationObservations, active ? String(finalization.stable_observations) : "—");
  const signals = finalization.signals || {};
  const [actionsText, actionsTone] = yesNo(active ? signals.actions : null, "contract-good");
  setRow(diagnosticFields.finalizationActions, actionsText, actionsTone);
  for (const [field, value] of [
    [diagnosticFields.finalizationStreaming, signals.streaming],
    [diagnosticFields.finalizationReasoning, signals.reasoning],
    [diagnosticFields.finalizationStop, signals.stop],
  ]) {
    const [text, tone] = yesNo(active ? value : null);
    setRow(field, text, tone);
  }
  const observation = finalization.observation || {};
  const lastWake = observation.last_wake || {};
  diagnosticFields.wake.textContent = active
    ? `Réveils mutation ${lastWake.mutation} · tick ${lastWake.observe_tick} · timer ${lastWake.timer}` +
      ` — dernière observation ${formatDuration(observation.ms_since_observation)}` +
      `, dernière mutation DOM ${formatDuration(observation.ms_since_dom_mutation)}`
    : "";

  const serialization = finalization.serialization || {};
  const rootFound = serialization.root_found;
  setRow(
    diagnosticFields.serializationRoot,
    rootFound === true ? "yes" : rootFound === false ? "no" : "—",
    rootFound === true ? "contract-good" : rootFound === false ? "contract-warn" : "contract-neutral",
  );
  setRow(
    diagnosticFields.serializationSerializer,
    serialization.serializer || "—",
  );
  const lastSerialize = serialization.last_serialize;
  setRow(
    diagnosticFields.serializationLast,
    lastSerialize === "ok" ? "OK" : lastSerialize === "error" ? "ERROR" : "—",
    lastSerialize === "ok"
      ? "contract-good"
      : lastSerialize === "error"
        ? "contract-bad"
        : "contract-neutral",
  );
}

function renderDiagnostic(raw) {
  diagnostic = safeDiagnostic(raw);
  document.getElementById("copy-response-structure").disabled = true;
  document.getElementById("copy-diagnostic").disabled = false;
  diagnosticFields.json.textContent = JSON.stringify(diagnostic, null, 2);
  diagnosticFields.json.hidden = false;
  const { connection, target } = diagnostic;
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

  // La source et la propriété de la cible sont toujours affichées : c'est ce
  // qui permet de savoir *quel* onglet a été diagnostiqué, sans DevTools.
  diagnosticFields.target.textContent =
    `${TARGET_LABELS[target.source]} · ${target.bridge_owned ? "bridge-owned" : "not owned"}`;
  diagnosticFields.tab.textContent = diagnostic.tab_id == null ? "" : `Onglet #${diagnostic.tab_id}`;

  renderRun(diagnostic.finalization);

  if (!diagnostic.ok) {
    diagnosticFields.temporary.textContent = target.bridge_owned ? "—" : "N/A";
    diagnosticFields.temporary.className = "contract-neutral";
    setStatus(diagnosticFields.composer, "missing");
    setStatus(diagnosticFields.send, "missing");
    diagnosticFields.version.textContent = "—";
    diagnosticFields.composerSelector.textContent = "—";
    diagnosticFields.composerStrategy.textContent = "";
    diagnosticFields.composerCandidates.textContent = "";
    diagnosticFields.sendSelector.textContent = "—";
    diagnosticFields.sendStrategy.textContent = "";
    diagnosticFields.sendCandidates.textContent = "";
    diagnosticFields.surface.textContent = "—";
    diagnosticFields.surface.className = "contract-neutral";
    diagnosticFields.strategy.textContent = "—";
    diagnosticFields.baselineRoots.textContent = "—";
    diagnosticFields.rootsLabel.textContent = "Current roots";
    diagnosticFields.currentRoots.textContent = "—";
    setStatus(diagnosticFields.candidate, "missing", "NONE");
    diagnosticFields.markdownRoot.textContent = "—";
    diagnosticFields.inlineLeaves.textContent = "—";
    diagnosticFields.reasonRow.hidden = true;
    diagnosticFields.message.textContent = diagnostic.error === "no_chatgpt_tab"
      ? "Aucun onglet ChatGPT ouvert."
      : "Content script absent ou indisponible. Recharge l’onglet ChatGPT.";
    return;
  }

  const { surface, composer, send } = diagnostic.input;
  const locator = diagnostic.response_locator;
  // Un onglet qui n'appartient pas au bridge ne doit jamais déclencher de
  // fausse alarme « Temporary Chat » : la question ne le concerne pas.
  if (target.bridge_owned) {
    setStatus(diagnosticFields.temporary, diagnostic.input.temporary_chat, "INVALID");
  } else {
    diagnosticFields.temporary.textContent = "N/A";
    diagnosticFields.temporary.className = "contract-neutral";
  }
  setStatus(diagnosticFields.composer, composer.status);
  setStatus(diagnosticFields.send, send.status);
  diagnosticFields.version.textContent = diagnostic.version
    ? `v${diagnostic.version}`
    : "inconnue";
  diagnosticFields.composerSelector.textContent = composer.selector || "Aucun sélecteur trouvé";
  diagnosticFields.composerStrategy.textContent = describeStrategy(composer.strategy);
  diagnosticFields.composerCandidates.textContent =
    `${composer.visible_candidates} visible · ${composer.known_selector_candidates} known · ${composer.structural_candidates} structural · form ${composer.form_found ? "yes" : "no"}`;
  diagnosticFields.sendSelector.textContent = send.selector || "Aucun sélecteur trouvé";
  diagnosticFields.sendStrategy.textContent = describeStrategy(send.strategy);
  diagnosticFields.sendCandidates.textContent = send.status === "not_rendered_idle"
    ? `${send.visible_candidates} visible · bouton non rendu tant que le composer est vide`
    : `${send.visible_candidates} visible · type ${send.type || "unknown"} · disabled ${send.disabled ? "yes" : "no"} · aria-disabled ${send.aria_disabled ? "yes" : "no"} · same form ${send.same_form_as_composer == null ? "unknown" : send.same_form_as_composer ? "yes" : "no"}`;
  // Response locator : surface, stratégie, comptages et raison bornée d'un
  // refus — jamais un contenu, jamais un nœud.
  setRow(
    diagnosticFields.surface,
    locator.conversation_surface
      ? `OK${locator.surface_strategy ? ` (${locator.surface_strategy})` : ""}`
      : "ABSENTE",
    locator.conversation_surface ? "contract-good" : "contract-bad",
  );
  diagnosticFields.strategy.textContent = locator.strategy || "—";
  diagnosticFields.baselineRoots.textContent = String(locator.baseline_root_count);
  // Dérive de contrat : les roots affichés sont ceux du DOM *réel*, mesurés
  // contre le baseline du run (`Markdown roots`), pas une valeur de candidat.
  diagnosticFields.rootsLabel.textContent =
    locator.candidate_state === "broken" ? "Markdown roots" : "Current roots";
  diagnosticFields.currentRoots.textContent = String(locator.current_root_count);
  const candidateLabel = {
    found: ["FOUND", "contract-good"],
    pending: ["NONE", "contract-neutral"],
    broken: ["BROKEN", "contract-bad"],
    idle: ["—", "contract-neutral"],
  }[locator.candidate_state] || ["—", "contract-neutral"];
  diagnosticFields.candidate.textContent = candidateLabel[0];
  diagnosticFields.candidate.className = candidateLabel[1];
  diagnosticFields.markdownRoot.textContent = locator.markdown_root ? "YES" : "NO";
  diagnosticFields.markdownRoot.className = locator.markdown_root
    ? "contract-good"
    : "contract-neutral";
  diagnosticFields.inlineLeaves.textContent = String(locator.inline_leaf_count);
  const reason = LOCATOR_REASON_LABELS[locator.reason] || null;
  diagnosticFields.reasonRow.hidden = reason === null;
  diagnosticFields.reason.textContent = reason || "—";
  diagnosticFields.reason.className = reason === null ? "contract-neutral" : "contract-bad";
  document.getElementById("copy-response-structure").disabled = false;
  diagnosticFields.message.textContent = "Diagnostic terminé. Aucun contenu de conversation n’a été lu.";
}

/**
 * État vivant poussé par le service worker pendant qu'un run est en cours : le
 * même contrat borné que `run` dans le diagnostic complet, et la même source
 * que le run (inflight → browser target → conversation retenue → onglet
 * bridge → onglet ChatGPT générique en dernier recours).
 */
function safeLiveRun(raw) {
  const source = ["inflight", "browser_target", "bridge_conversation", "bridge_owned_tab", "generic_chatgpt_tab"].includes(raw?.diagnostic_target?.source)
    ? raw.diagnostic_target.source
    : "generic_chatgpt_tab";
  const bridgeOwned = raw?.diagnostic_target?.bridge_owned === true;
  return {
    ok: raw?.ok === true,
    target: { source, bridge_owned: bridgeOwned },
    // Un run n'appartient qu'au bridge : un onglet générique rend un état vide.
    run: safeRunState(bridgeOwned ? raw?.run : null),
  };
}

function applyLiveRun(live) {
  const run = live?.run || null;
  renderRun(run);
  if (!diagnostic) return;
  diagnostic.finalization = run;
  diagnostic.serialization = run?.serialization || null;
  diagnosticFields.json.textContent = JSON.stringify(diagnostic, null, 2);
}

async function refreshLiveRun() {
  try {
    applyLiveRun(safeLiveRun(await chrome.runtime.sendMessage({ type: "run_state" })));
  } catch {
    applyLiveRun(null);
  }
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
  // État vivant du run en parallèle du reste : le popup ouvert pendant une
  // génération voit ACTIVE / QUIESCENT / FINAL évoluer sans clic.
  void refreshLiveRun();
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
  diagnosticFields.message.textContent = (await copyText(
    JSON.stringify(diagnostic, null, 2),
  ))
    ? "Diagnostic JSON copié."
    : "Copie impossible depuis cette fenêtre.";
});

/**
 * Demande le snapshot structurel borné au service worker puis le copie.
 * Le popup ne recopie jamais la page : `safeResponseStructure` re-filtre.
 */
document.getElementById("copy-response-structure").addEventListener("click", async () => {
  const button = document.getElementById("copy-response-structure");
  button.disabled = true;
  try {
    const structure = safeResponseStructure(
      await chrome.runtime.sendMessage({ type: "response_structure" }),
      diagnostic?.tab_id ?? null,
      diagnostic?.target ?? null,
    );
    if (structure.ok !== true) {
      diagnosticFields.message.textContent =
        "Structure de réponse indisponible (content script absent ?).";
      return;
    }
    diagnosticFields.message.textContent = (await copyText(
      JSON.stringify(structure, null, 2),
    ))
      ? "Structure de réponse copiée."
      : "Copie impossible depuis cette fenêtre.";
  } catch {
    diagnosticFields.message.textContent =
      "Structure de réponse indisponible (content script absent ?).";
  } finally {
    button.disabled = false;
  }
});

chrome.storage.local.get(["serverUrl", "wsToken"]).then(({ serverUrl, wsToken }) => {
  url.value = serverUrl || "ws://127.0.0.1:8001/ws";
  token.value = wsToken || "";
});
document.getElementById("copy-diagnostic").disabled = true;
refresh();
setInterval(refresh, 1500);
