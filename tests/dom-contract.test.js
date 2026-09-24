/**
 * Contrat DOM unique : le runtime (content.js), les listes blanches de
 * diagnostic (background.js, popup.js) et l'outil console tools/diagnose.js
 * ne doivent jamais diverger. Couvre aussi la matrice du rapport « un clic »
 * du popup : statuts lisibles et aucun contenu utilisateur.
 *
 * jsdom est une dépendance de test de ce dépôt : `npm ci` avant ce test.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");
const { DOM_DRIFT_MATRIX } = require("./fixtures/chatgpt-dom.js");

const ROOT = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");
const CONTENT = read("extension/content.js");
const BACKGROUND = read("extension/background.js");
const POPUP = read("extension/popup.js");
const POPUP_HTML = read("extension/popup.html");
const DIAGNOSE = read("tools/diagnose.js");

const STRUCTURAL_SEND = "button[type='submit']";

/** Littéraux de chaîne du premier bloc `[ ... ]` qui suit `marker`. */
function stringsAfter(source, marker) {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `marqueur introuvable : ${marker}`);
  const open = source.indexOf("[", start);
  // Les sélecteurs contiennent eux-mêmes des crochets : on cherche le premier
  // `]` hors d'un littéral de chaîne.
  const values = [];
  let current = null;
  for (let index = open + 1; index < source.length; index += 1) {
    const char = source[index];
    if (current !== null) {
      if (char === '"') {
        values.push(current);
        current = null;
      } else {
        current += char;
      }
    } else if (char === '"') {
      current = "";
    } else if (char === "]") {
      return values;
    }
  }
  throw new Error(`tableau non fermé après ${marker}`);
}

function stringConst(source, name) {
  const match = source.match(new RegExp(`${name}\\s*=\\s*\\n?\\s*"([^"]+)"`));
  assert.ok(match, `constante introuvable : ${name}`);
  return match[1];
}

const sorted = (values) => [...new Set(values)].sort();

// 1. Une seule liste de sélecteurs, recopiée à l'identique partout.
{
  const runtimeComposer = stringsAfter(CONTENT, "const SELECTORS = {\n  composer:");
  const runtimeSend = stringsAfter(CONTENT, "\n  send: [");
  const structural = stringConst(CONTENT, "STRUCTURAL_COMPOSER_SELECTOR");
  assert.ok(runtimeComposer.includes(structural), "le repli structurel appartient à SELECTORS.composer");
  assert.ok(runtimeComposer.includes("[data-composer-markdown][contenteditable='true'][role='textbox']"));
  assert.ok(runtimeSend.includes("button[aria-label*='Send']"));

  const backgroundComposer = stringsAfter(BACKGROUND, "const composerSelectors = new Set(");
  const backgroundSend = stringsAfter(BACKGROUND, "const sendSelectors = new Set(");
  const popupComposer = stringsAfter(POPUP, "const COMPOSER_SELECTORS = new Set(");
  const popupSend = stringsAfter(POPUP, "const SEND_SELECTORS = new Set(");

  for (const [name, list] of [["background", backgroundComposer], ["popup", popupComposer]]) {
    assert.deepEqual(sorted(list), sorted(runtimeComposer), `${name}: liste blanche composer ≠ runtime`);
  }
  for (const [name, list] of [["background", backgroundSend], ["popup", popupSend]]) {
    assert.deepEqual(
      sorted(list),
      sorted([...runtimeSend, STRUCTURAL_SEND]),
      `${name}: liste blanche Send ≠ runtime + repli structurel`,
    );
  }

  const diagnoseComposer = [
    ...stringsAfter(DIAGNOSE, "const SELECTEURS_COMPOSER = ["),
    stringConst(DIAGNOSE, "SELECTEUR_COMPOSER_STRUCTUREL"),
  ];
  const diagnoseSend = stringsAfter(DIAGNOSE, "const SELECTEURS_SEND = [");
  assert.deepEqual(diagnoseComposer, runtimeComposer, "diagnose.js : ordre et contenu composer = runtime");
  assert.deepEqual(diagnoseSend, runtimeSend, "diagnose.js : ordre et contenu Send = runtime");
  assert.ok(DIAGNOSE.includes(`"${STRUCTURAL_SEND}"`), "diagnose.js garde le repli Send structurel");
}

// 1bis. Listes blanches du diagnostic vivant : recopiées à l'identique entre
//       le service worker et le popup, elles ne peuvent pas diverger.
{
  const TARGET_SOURCES = [
    "inflight",
    "browser_target",
    "bridge_conversation",
    "bridge_owned_tab",
    "generic_chatgpt_tab",
  ];
  const targetSourceLists = (source) => {
    const lists = [];
    for (const match of source.matchAll(/\[("inflight"(?:\s*,\s*"[a-z_]+")*)\]/g)) {
      lists.push([...match[1].matchAll(/"([a-z_]+)"/g)].map((item) => item[1]));
    }
    return lists;
  };
  const backgroundSources = targetSourceLists(BACKGROUND);
  const popupSources = targetSourceLists(POPUP);
  assert.ok(backgroundSources.length >= 2, "background : toutes les listes sont inspectées");
  assert.ok(popupSources.length >= 3, "popup : toutes les listes sont inspectées");
  for (const list of [...backgroundSources, ...popupSources]) {
    assert.deepEqual(list, TARGET_SOURCES, "source de cible : liste blanche identique partout");
  }

  // Mêmes états, mêmes signaux, mêmes modes : le popup affiche exactement ce
  // que la boucle du content script a le droit de publier.
  const setNames = ["RUN_STATES", "RUN_SIGNALS", "RUN_MODES", "RUN_CONFIDENCES"];
  for (const name of setNames) {
    assert.deepEqual(
      stringsAfter(BACKGROUND, `const ${name} = new Set(`).sort(),
      stringsAfter(POPUP, `const ${name} = new Set(`).sort(),
      `${name}: worker et popup partagent la même liste`,
    );
  }
  const regexLiteral = (source, name) => {
    const match = source.match(new RegExp(`const ${name} = (/[^/]+/[a-z]*);`));
    assert.ok(match, `expression introuvable : ${name}`);
    return match[1];
  };
  for (const name of ["RUN_PHASES", "RUN_SERIALIZER"]) {
    assert.equal(
      regexLiteral(BACKGROUND, name),
      regexLiteral(POPUP, name),
      `${name}: worker et popup partagent le même filtre`,
    );
  }

  // Le popup ne calcule aucun seuil : le seuil affiché vient du runtime, jamais
  // d'une règle locale qui pourrait diverger de la décision réelle.
  assert.equal(
    /finalizationThresholdMs|settle_unknown_ms|active_signal_stall_ms/.test(POPUP),
    false,
    "le popup n'invente aucun seuil de finalisation",
  );
}

// 2. tools/diagnose.js donne le même verdict que le runtime sur chaque variante
//    de la matrice de dérive (le runtime est jugé sur la même table dans
//    content-dom.test.js).
{
  for (const testCase of DOM_DRIFT_MATRIX) {
    const dom = new JSDOM(`<!doctype html><html><body>${testCase.body}</body></html>`, {
      runScripts: "outside-only",
      url: "https://chatgpt.com/?temporary-chat=true",
    });
    const { window } = dom;
    window.Element.prototype.getClientRects = function getClientRects() {
      return this.hasAttribute("data-test-offscreen") ? [] : [{}];
    };
    const logs = [];
    window.console.log = (...args) => logs.push(args);
    window.setInterval = () => 0;
    vm.runInContext(DIAGNOSE, dom.getInternalVMContext(), { filename: "diagnose.js" });
    const logged = (label) => logs.find((args) => args[0] === label)?.[1];
    assert.equal(logged("composer status:"), testCase.composer[0], `${testCase.name}: diagnose composer`);
    assert.equal(logged("send status:"), testCase.send[0], `${testCase.name}: diagnose send`);
    const strategies = logs.find((args) => args[0] === "matched strategy:");
    assert.equal(strategies[1], testCase.composer[1], `${testCase.name}: diagnose composer strategy`);
    assert.equal(strategies[3], testCase.send[1], `${testCase.name}: diagnose send strategy`);
  }
}

// 3. Rapport « un clic » du popup : chaque état se lit sans ambiguïté, et
//    rien d'autre que le contrat fixe ne traverse la liste blanche.
function loadPopup({ onCopy = null } = {}) {
  const dom = new JSDOM(POPUP_HTML.replace(/<script[^>]*><\/script>/, ""), {
    runScripts: "outside-only",
    url: "chrome-extension://bridge/popup.html",
  });
  const { window } = dom;
  if (onCopy) {
    // jsdom n'implémente pas le presse-papiers : on capture le texte copié par
    // le vrai gestionnaire du bouton, sans le remplacer.
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (value) => onCopy(String(value)) },
    });
  }
  const pending = () => new Promise(() => {});
  window.chrome = {
    runtime: { sendMessage: pending },
    tabs: { query: async () => [], sendMessage: pending },
    storage: { local: { get: async () => ({}), set: async () => {} } },
  };
  window.setInterval = () => 0;
  const context = dom.getInternalVMContext();
  vm.runInContext(POPUP, context, { filename: "popup.js" });
  return {
    window,
    render: (raw) => {
      window.__raw = raw;
      vm.runInContext("renderDiagnostic(globalThis.__raw)", context);
      return JSON.parse(vm.runInContext("JSON.stringify(diagnostic)", context));
    },
    structure: (raw, tabId = null, target = null) => {
      window.__raw = raw;
      window.__tab = tabId;
      window.__target = target;
      vm.runInContext(
        "globalThis.__structure = safeResponseStructure(globalThis.__raw, globalThis.__tab, globalThis.__target)",
        context,
      );
      return JSON.parse(
        vm.runInContext("JSON.stringify(globalThis.__structure)", context),
      );
    },
    text: (id) => window.document.getElementById(id).textContent,
  };
}

const SECRET = "TOP_SECRET_USER_PROMPT_42";
function rawReport({
  composer = {},
  send = {},
  connection = {},
  surface = {},
  diagnostic_target = {},
  response_locator = {},
  run = {},
} = {}) {
  return {
    ok: true,
    content_script_version: "39",
    tab_id: 7,
    diagnostic_target: { source: "generic_chatgpt_tab", bridge_owned: false, ...diagnostic_target },
    extension_state: "active",
    websocket_state: "connected",
    // Champs hors contrat : ne doivent jamais apparaître dans le rapport.
    prompt: SECRET,
    text: SECRET,
    wsToken: SECRET,
    response_text: SECRET,
    innerText: SECRET,
    textContent: SECRET,
    innerHTML: SECRET,
    Authorization: `Bearer ${SECRET}`,
    connection: {
      state: "stable",
      instance_id_prefix: "11111111",
      worker_session_prefix: "22222222",
      connection_id_prefix: "33333333",
      reconnections: 2,
      seconds_since_ping: 4,
      instance_id: `11111111-${SECRET}`,
      ...connection,
    },
    surface: {
      origin_ok: true,
      pathname: "/",
      temporary_query: true,
      temporary_status: "ok",
      visibility_state: "hidden",
      has_focus: false,
      title: SECRET,
      ...surface,
    },
    composer: {
      status: "ok",
      strategy: "named_selector",
      selector: "[data-composer-markdown][contenteditable='true'][role='textbox']",
      visible_candidates: 1,
      known_selector_candidates: 1,
      structural_candidates: 1,
      tag: "DIV",
      role: "textbox",
      contenteditable: true,
      data_composer_markdown: true,
      form_found: true,
      text: SECRET,
      ...composer,
    },
    send: {
      status: "ok",
      strategy: "named_selector",
      selector: "button[aria-label*='Send']",
      visible_candidates: 1,
      type: "submit",
      disabled: false,
      aria_disabled: false,
      same_form_as_composer: true,
      label: SECRET,
      ...send,
    },
    response_locator: {
      conversation_surface: true,
      surface_strategy: "composer_main",
      strategy: "markdown_root_delta",
      baseline_root_count: 0,
      current_root_count: 1,
      candidate_found: true,
      candidate_root_tag: "DIV",
      markdown_root: true,
      inline_leaf_count: 46,
      ambiguity_count: 0,
      candidate_state: "found",
      reason: null,
      // Champs hors contrat : ne doivent jamais apparaître dans le rapport.
      element: SECRET,
      text: SECRET,
      ...response_locator,
    },
    // État vivant du run : celui que la boucle du content script maintient.
    run: {
      active: true,
      phase: "stabilizing",
      state: "quiescent",
      signal: "output_stable",
      mode: null,
      confidence: "medium",
      output_chars: 1234,
      stable_for_ms: 9000,
      stable_threshold_ms: 45000,
      stable_observations: 4,
      signals: { actions: false, streaming: false, reasoning: false, stop: false },
      serialization: {
        root_found: true,
        serializer: "chatgpt-dom-v3",
        last_serialize: "ok",
        ms: 12,
      },
      observation: {
        last_wake: { mutation: 3, observe_tick: 7, timer: 1 },
        ms_since_observation: 120,
        ms_since_dom_mutation: 4000,
      },
      prompt: SECRET,
      response: SECRET,
      ...run,
    },
  };
}

{
  const popup = loadPopup();
  const composerCases = [
    [{ status: "ok" }, "OK"],
    [{ status: "degraded", strategy: "structural_fallback", selector: "[contenteditable='true'][role='textbox']" }, "DEGRADED"],
    [{ status: "missing", strategy: "structural_fallback", selector: "[contenteditable='true'][role='textbox']", visible_candidates: 0 }, "BROKEN"],
    [{ status: "ambiguous", visible_candidates: 2 }, "AMBIGUOUS"],
    // Un sélecteur hors contrat (ex. texte injecté) n'est jamais recopié.
    [{ status: "ok", selector: `#${SECRET}` }, "OK"],
  ];
  for (const [composer, label] of composerCases) {
    const report = popup.render(rawReport({ composer }));
    assert.equal(popup.text("composer-status"), label, `composer ${composer.status}`);
    assert.equal(report.input.composer.status, composer.status);
    assert.equal(JSON.stringify(report).includes(SECRET), false, `composer ${composer.status}: aucun contenu`);
  }
  assert.equal(popup.render(rawReport({ composer: { selector: `#${SECRET}` } })).input.composer.selector, null);

  const sendCases = [
    [{ status: "ok" }, "OK"],
    [{ status: "degraded", strategy: "structural_fallback", selector: "button[type='submit']" }, "DEGRADED"],
    [{ status: "missing", strategy: "structural_fallback", selector: "button[type='submit']", visible_candidates: 0 }, "BROKEN"],
    [{ status: "not_rendered_idle", visible_candidates: 0, same_form_as_composer: null }, "Idle / not rendered"],
  ];
  for (const [send, label] of sendCases) {
    const report = popup.render(rawReport({ send }));
    assert.equal(popup.text("send-status"), label, `send ${send.status}`);
    assert.equal(JSON.stringify(report).includes(SECRET), false, `send ${send.status}: aucun contenu`);
  }

  // Onglet générique : Temporary Chat = N/A, jamais une fausse alarme, et
  // aucune finalisation inventée pour un run qui n'appartient pas au bridge.
  const genericIdle = popup.render(rawReport({
    surface: { temporary_status: "invalid" },
    composer: { status: "ok" },
    send: { status: "not_rendered_idle", visible_candidates: 0, same_form_as_composer: null },
    run: { active: false, state: "idle" },
  }));
  assert.equal(genericIdle.ok, true);
  assert.equal(genericIdle.target.source, "generic_chatgpt_tab");
  assert.equal(genericIdle.target.bridge_owned, false);
  assert.equal(popup.text("target-status"), "Generic ChatGPT tab · not owned");
  assert.equal(popup.text("temporary-status"), "N/A");
  assert.equal(genericIdle.input.temporary_chat, null);
  assert.equal(popup.text("composer-status"), "OK");
  assert.equal(popup.text("send-status"), "Idle / not rendered");
  assert.equal(popup.text("finalization-state"), "Idle");
  assert.equal(popup.text("finalization-chars"), "—");
  assert.equal(popup.text("serialization-root"), "—");

  // Onglet bridge-owned : Temporary Chat est jugé pour de vrai.
  const inflightTarget = popup.render(rawReport({
    diagnostic_target: { source: "inflight", bridge_owned: true },
    surface: { temporary_status: "ok" },
    composer: { status: "ok" },
    send: { status: "ok" },
    run: { active: true, state: "active", signal: "streaming" },
  }));
  assert.equal(inflightTarget.target.source, "inflight");
  assert.equal(popup.text("target-status"), "Bridge inflight · bridge-owned");
  assert.equal(popup.text("temporary-status"), "OK");
  assert.equal(inflightTarget.input.temporary_chat, "ok");

  const connectionCases = [
    [{ state: "stable" }, "STABLE", null],
    [{ state: "stale", seconds_since_ping: 75 }, "STALE", null],
    [{ state: "conflict", conflict_reason: "owner_active" }, "CONFLICT", "owner_active"],
    [{ state: "conflict", conflict_reason: "replaced" }, "CONFLICT", "replaced"],
    [{ state: "conflict", conflict_reason: SECRET }, "CONFLICT", null],
    [{ state: SECRET }, "DISCONNECTED", null],
  ];
  for (const [connection, label, reason] of connectionCases) {
    const report = popup.render(rawReport({ connection }));
    assert.ok(popup.text("extension-state").endsWith(label), `connection ${connection.state}`);
    assert.equal(report.connection.conflict_reason, reason);
    assert.equal(report.connection.instance_id_prefix, "11111111");
    assert.equal(report.connection.reconnections, 2);
    const detail = popup.text("connection-detail");
    assert.ok(detail.includes("instance 11111111"), detail);
    assert.ok(detail.includes("reconnexions 2"), detail);
    assert.equal(JSON.stringify(report).includes(SECRET), false, `connection ${connection.state}: aucun contenu`);
    assert.equal(detail.includes(SECRET), false);
  }
  // Un id complet n'est jamais accepté comme préfixe.
  const full = popup.render(rawReport({ connection: { instance_id_prefix: "11111111-1111-4111-8111-111111111111" } }));
  assert.equal(full.connection.instance_id_prefix, null);

  // Échec du content script : rapport borné, connexion toujours décrite.
  const failed = popup.render({ ok: false, error: SECRET, connection: { state: "stable" }, prompt: SECRET });
  assert.equal(failed.error, "diagnostic_failed");
  assert.equal(failed.connection.state, "stable");
  assert.equal(popup.text("composer-status"), "BROKEN");
  assert.equal(JSON.stringify(failed).includes(SECRET), false);
  assert.deepEqual(Object.keys(failed).sort(), [
    "connection",
    "error",
    "extension_state",
    "finalization",
    "input",
    "ok",
    "response_locator",
    "serialization",
    "tab_id",
    "target",
    "version",
    "websocket_state",
  ]);
}

// 4. Response locator : le rapport « un clic » expose la surface, la stratégie
//    et les comptages de réponse — jamais un contenu, jamais un nœud.
{
  const popup = loadPopup();
  const report = popup.render(rawReport({}));
  assert.deepEqual(Object.keys(report.response_locator).sort(), [
    "ambiguity_count",
    "baseline_root_count",
    "candidate_found",
    "candidate_root_tag",
    "candidate_state",
    "conversation_surface",
    "current_root_count",
    "inline_leaf_count",
    "markdown_root",
    "reason",
    "strategy",
    "surface_strategy",
  ]);
  assert.equal(popup.text("surface-status"), "OK (composer_main)");
  assert.equal(popup.text("response-strategy"), "markdown_root_delta");
  assert.equal(popup.text("baseline-roots"), "0");
  assert.equal(popup.text("current-roots"), "1");
  assert.equal(popup.text("roots-label"), "Current roots");
  assert.equal(popup.text("candidate-status"), "FOUND");
  assert.equal(popup.text("markdown-root"), "YES");
  assert.equal(popup.text("inline-leaves"), "46");
  assert.equal(
    popup.window.document.getElementById("locator-reason-row").hidden,
    true,
    "sans dérive de contrat, aucune raison n'est affichée",
  );
  assert.equal(report.response_locator.reason, null);
  assert.equal(JSON.stringify(report).includes(SECRET), false);

  // Dérive de contrat : ambiguïté de roots. Le verdict affiché est BROKEN, la
  // raison est bornée, et les roots affichés sont ceux du DOM réel.
  const drifted = popup.render(rawReport({
    response_locator: {
      candidate_found: false,
      candidate_state: "broken",
      reason: "ambiguous_root",
      ambiguity_count: 0,
      current_root_count: 1,
      inline_leaf_count: 46,
    },
  }));
  assert.equal(popup.text("candidate-status"), "BROKEN");
  assert.equal(popup.text("roots-label"), "Markdown roots");
  assert.equal(popup.text("current-roots"), "1");
  assert.equal(popup.text("inline-leaves"), "46");
  assert.equal(
    popup.window.document.getElementById("locator-reason-row").hidden,
    false,
    "une dérive de contrat affiche sa raison",
  );
  assert.equal(popup.text("locator-reason"), "ambiguous_root");
  assert.equal(drifted.response_locator.reason, "ambiguous_root");

  const noRoot = popup.render(rawReport({
    response_locator: {
      candidate_state: "broken",
      reason: "inline_without_root",
      candidate_found: false,
      markdown_root: false,
      current_root_count: 0,
    },
  }));
  assert.equal(popup.text("candidate-status"), "BROKEN");
  assert.equal(popup.text("locator-reason"), "inline_without_root");
  assert.equal(noRoot.response_locator.current_root_count, 0);

  // Aucun run décidé dans cet onglet : le locator ne crie pas BROKEN.
  const idleLocator = popup.render(rawReport({
    response_locator: {
      candidate_state: "idle",
      reason: null,
      candidate_found: false,
      conversation_surface: false,
      surface_strategy: null,
      strategy: null,
      markdown_root: false,
      current_root_count: 0,
    },
  }));
  assert.equal(popup.text("candidate-status"), "—");
  assert.equal(idleLocator.response_locator.candidate_state, "idle");
  assert.equal(popup.text("surface-status"), "ABSENTE");

  // Valeur hors contrat (texte injecté, nœud, stratégie inconnue) : jamais
  // recopiée, et les comptages restent bornés.
  const injected = popup.render(rawReport({
    response_locator: {
      strategy: SECRET,
      surface_strategy: SECRET,
      candidate_root_tag: SECRET,
      candidate_state: SECRET,
      reason: SECRET,
      current_root_count: SECRET,
      inline_leaf_count: 100000,
    },
  }));
  assert.equal(injected.response_locator.strategy, null);
  assert.equal(injected.response_locator.surface_strategy, null);
  assert.equal(injected.response_locator.candidate_root_tag, null);
  assert.equal(injected.response_locator.candidate_state, "idle");
  assert.equal(injected.response_locator.reason, null);
  assert.equal(injected.response_locator.current_root_count, 0);
  assert.equal(injected.response_locator.inline_leaf_count, 999);
  assert.equal(JSON.stringify(injected).includes(SECRET), false);

  // Échec du content script : la section retombe à zéro, sans contenu.
  const failed = popup.render({
    ok: false,
    error: "content_script_unavailable",
    response_locator: { strategy: SECRET },
  });
  assert.equal(popup.text("candidate-status"), "NONE");
  assert.equal(popup.text("surface-status"), "—");
  assert.equal(JSON.stringify(failed).includes(SECRET), false);
}

// 4bis. Finalisation et sérialisation : le popup affiche l'état vivant du run
//       sans le recalculer — la même décision que celle du content script.
{
  const popup = loadPopup();
  const BRIDGE_TARGET = { source: "inflight", bridge_owned: true };
  const report = popup.render(rawReport({ diagnostic_target: BRIDGE_TARGET }));
  assert.deepEqual(Object.keys(report.finalization).sort(), [
    "active",
    "confidence",
    "mode",
    "observation",
    "output_chars",
    "phase",
    "serialization",
    "signal",
    "signals",
    "stable_for_ms",
    "stable_observations",
    "stable_threshold_ms",
    "state",
  ]);
  assert.deepEqual(report.finalization.observation, {
    last_wake: { mutation: 3, observe_tick: 7, timer: 1 },
    ms_since_observation: 120,
    ms_since_dom_mutation: 4000,
  });
  assert.equal(popup.text("finalization-state"), "QUIESCENT");
  assert.equal(popup.text("finalization-signal-label"), "Signal");
  assert.equal(popup.text("finalization-signal"), "output_stable");
  assert.equal(popup.text("finalization-chars"), "1234");
  // Stable s'affiche « durée observée / seuil réellement appliqué ».
  assert.equal(popup.text("finalization-stable"), "9 s / 45 s");
  assert.equal(popup.text("finalization-observations"), "4");
  assert.equal(popup.text("finalization-actions"), "no");
  assert.equal(popup.text("finalization-streaming"), "no");
  assert.equal(popup.text("serialization-root"), "yes");
  assert.equal(popup.text("serialization-serializer"), "chatgpt-dom-v3");
  assert.equal(popup.text("serialization-last"), "OK");
  assert.equal(report.serialization.root_found, true);
  assert.ok(popup.text("wake-detail").includes("tick 7"), popup.text("wake-detail"));

  // Finalisation bloquée : ACTIVE, signal bloquant nommé, stabilité mesurée.
  const blocked = popup.render(rawReport({
    diagnostic_target: BRIDGE_TARGET,
    run: {
      active: true,
      phase: "generating",
      state: "active",
      signal: "streaming",
      output_chars: 2048,
      stable_for_ms: 85000,
      stable_threshold_ms: 300000,
      stable_observations: 5,
      signals: { actions: false, streaming: true, reasoning: false, stop: true },
    },
  }));
  assert.equal(popup.text("finalization-state"), "ACTIVE");
  assert.equal(popup.text("finalization-signal-label"), "Blocking signal");
  assert.equal(popup.text("finalization-signal"), "streaming");
  assert.equal(popup.text("finalization-stable"), "85 s / 300 s");
  assert.equal(popup.text("finalization-streaming"), "yes");
  assert.equal(popup.text("finalization-stop"), "yes");
  assert.equal(popup.text("finalization-actions"), "no");
  assert.equal(blocked.finalization.output_chars, 2048);

  // Une sérialisation en erreur est nommée, pas avalée.
  popup.render(rawReport({
    diagnostic_target: BRIDGE_TARGET,
    run: {
      active: true,
      state: "waiting",
      serialization: { root_found: false, serializer: "chatgpt-dom-v3", last_serialize: "error", ms: 0 },
    },
  }));
  assert.equal(popup.text("serialization-root"), "no");
  assert.equal(popup.text("serialization-last"), "ERROR");

  // Valeurs hors contrat : bornées, jamais recopiées.
  const injected = popup.render(rawReport({
    diagnostic_target: BRIDGE_TARGET,
    run: {
      state: SECRET,
      phase: SECRET,
      signal: SECRET,
      confidence: SECRET,
      mode: SECRET,
      output_chars: SECRET,
      stable_for_ms: -5,
      stable_threshold_ms: SECRET,
      stable_observations: 1e9,
      serialization: { serializer: SECRET, last_serialize: SECRET, root_found: SECRET },
      observation: { last_wake: { mutation: SECRET }, ms_since_observation: SECRET },
    },
  }));
  assert.equal(injected.finalization.state, "idle");
  assert.equal(injected.finalization.signal, null);
  assert.equal(injected.finalization.confidence, null);
  assert.equal(injected.finalization.mode, null);
  assert.equal(injected.finalization.output_chars, 0);
  assert.equal(injected.finalization.stable_for_ms, 0);
  assert.equal(injected.finalization.stable_threshold_ms, null);
  assert.equal(injected.finalization.stable_observations, 0);
  assert.equal(injected.finalization.serialization.serializer, null);
  assert.equal(injected.finalization.serialization.last_serialize, null);
  assert.equal(injected.finalization.serialization.root_found, null);
  assert.equal(injected.finalization.observation.last_wake.mutation, 0);
  assert.equal(injected.finalization.observation.ms_since_observation, null);
  assert.equal(JSON.stringify(injected).includes(SECRET), false);
}

// 4ter. Secret injecté : les trois valeurs du contrat de diagnostic ne
//       traversent ni le rendu, ni le JSON copié, à aucun niveau de la chaîne.
{
  const PROMPT_SECRET_123 = "PROMPT_SECRET_123";
  const RESPONSE_SECRET_456 = "RESPONSE_SECRET_456";
  const BEARER_SECRET_789 = "Bearer SECRET_789";
  const secrets = [PROMPT_SECRET_123, RESPONSE_SECRET_456, BEARER_SECRET_789];
  const copied = [];
  const popup = loadPopup({ onCopy: (value) => copied.push(value) });

  const poisoned = rawReport({
    diagnostic_target: { source: "inflight", bridge_owned: true },
    connection: {
      instance_id: `11111111-${PROMPT_SECRET_123}`,
      wsToken: BEARER_SECRET_789,
    },
    surface: { title: RESPONSE_SECRET_456 },
    composer: { text: PROMPT_SECRET_123 },
    send: { label: RESPONSE_SECRET_456 },
    response_locator: { element: RESPONSE_SECRET_456, text: RESPONSE_SECRET_456 },
    run: {
      prompt: PROMPT_SECRET_123,
      response_text: RESPONSE_SECRET_456,
      innerText: RESPONSE_SECRET_456,
      textContent: RESPONSE_SECRET_456,
      innerHTML: RESPONSE_SECRET_456,
      Authorization: BEARER_SECRET_789,
      wsToken: BEARER_SECRET_789,
      cookie: PROMPT_SECRET_123,
      localStorage: RESPONSE_SECRET_456,
    },
  });
  poisoned.prompt = PROMPT_SECRET_123;
  poisoned.response_text = RESPONSE_SECRET_456;
  poisoned.Authorization = BEARER_SECRET_789;
  poisoned.wsToken = BEARER_SECRET_789;
  poisoned.cookie = PROMPT_SECRET_123;
  poisoned.localStorage = RESPONSE_SECRET_456;

  const report = popup.render(poisoned);
  const reportJson = JSON.stringify(report);
  const rendered = popup.window.document.body.textContent;
  for (const secret of secrets) {
    assert.equal(reportJson.includes(secret), false, `rapport: ${secret}`);
    assert.equal(rendered.includes(secret), false, `popup: ${secret}`);
  }
  // L'état vivant reste lisible : le filtrage n'efface pas le diagnostic utile.
  assert.equal(report.target.source, "inflight");
  assert.equal(report.response_locator.candidate_state, "found");
  assert.equal(rendered.includes("QUIESCENT"), true, "la finalisation reste rendue");

  assert.equal(
    popup.window.document.getElementById("copy-diagnostic").textContent.trim(),
    "Copy diagnostic",
    "le bouton du contrat porte son nom",
  );
  // « Copy diagnostic » copie le JSON complet sûr, jamais le contenu filtré.
  // Le presse-papiers capturé est appelé synchroniquement par le vrai
  // gestionnaire de clic : aucune attente n'est nécessaire pour l'observer.
  popup.window.document.getElementById("copy-diagnostic").click();
  assert.equal(copied.length, 1, "le bouton copie exactement un document");
  const copiedJson = copied[0];
  for (const secret of secrets) {
    assert.equal(copiedJson.includes(secret), false, `copie: ${secret}`);
  }
  const parsed = JSON.parse(copiedJson);
  assert.deepEqual(
    Object.keys(parsed).sort(),
    [
      "connection",
      "extension_state",
      "finalization",
      "input",
      "ok",
      "response_locator",
      "serialization",
      "tab_id",
      "target",
      "version",
      "websocket_state",
    ],
    "le JSON copié expose toute la chaîne, et rien d'autre",
  );
  // Aucune clé de contenu, à aucun niveau du document copié.
  const forbiddenKeys = [
    "prompt",
    "response",
    "response_text",
    "text",
    "innerText",
    "textContent",
    "innerHTML",
    "Authorization",
    "wsToken",
    "cookie",
    "localStorage",
  ];
  const walk = (value, path = "json") => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      assert.equal(
        forbiddenKeys.includes(key),
        false,
        `clé interdite dans la copie : ${path}.${key}`,
      );
      walk(item, `${path}.${key}`);
    }
  };
  walk(parsed);
  assert.equal(parsed.version, "39");
  assert.equal(parsed.target.source, "inflight");
  assert.equal(parsed.target.bridge_owned, true);
  assert.equal(parsed.finalization.state, "quiescent");
  assert.equal(parsed.serialization.serializer, "chatgpt-dom-v3");
  assert.equal(parsed.serialization.last_serialize, "ok");
}

// 5. Snapshot structurel borné (« Copy response structure ») : liste blanche
//    fermée, aucune propriété textuelle, aucune clé hors contrat.
{
  const popup = loadPopup();
  const depthChain = (levels) => {
    let node = { tag: "SPAN", class_tokens: ["inline-markdown"], data: {} };
    for (let level = 0; level < levels; level += 1) {
      node = { tag: "DIV", class_tokens: [`depth-${level}`], data: {}, children: [node] };
    }
    return node;
  };
  const node = {
    tag: "DIV",
    class_tokens: ["MarkdownRoot-AbCd12", "group", "flex"],
    role: null,
    data_testid: "conversation-turn-3",
    data: { testid: "conversation-turn-3", state: "ready", unknown_key: SECRET },
    has_message_id: true,
    depth: 0,
    children_count: 1,
    children: [depthChain(9)],
    width: 640,
    height: 120,
    visible: true,
    // Champs hors contrat : jamais recopiés.
    text: SECRET,
    innerText: SECRET,
    textContent: SECRET,
    innerHTML: SECRET,
    prompt: SECRET,
    element: SECRET,
  };
  const structure = popup.structure(
    {
      ok: true,
      content_script_version: "39",
      conversation_surface: { found: true, strategy: "composer_main", node },
      strategy: "markdown_root_delta",
      markdown_root_matches: 1,
      semantic_assistant_matches: 0,
      inline_leaf_matches: 1,
      roots: [{ strategy: "markdown_root_delta", node }],
      prompt: SECRET,
      response_text: SECRET,
    },
    7,
    { source: "inflight", bridge_owned: true },
  );
  assert.equal(structure.ok, true);
  assert.equal(structure.content_script_version, "39");
  assert.equal(structure.tab_id, 7);
  assert.equal(structure.diagnostic_target.source, "inflight");
  assert.equal(structure.diagnostic_target.bridge_owned, true);
  assert.equal(structure.conversation_surface.found, true);
  assert.equal(structure.conversation_surface.strategy, "composer_main");
  assert.equal(structure.strategy, "markdown_root_delta");
  assert.equal(structure.markdown_root_matches, 1);
  assert.equal(structure.inline_leaf_matches, 1);
  assert.equal(structure.roots.length, 1);

  const root = structure.roots[0].node;
  assert.deepEqual(Object.keys(root).sort(), [
    "children",
    "children_count",
    "class_tokens",
    "data",
    "data_testid",
    "depth",
    "has_message_id",
    "height",
    "role",
    "tag",
    "visible",
    "width",
  ]);
  assert.equal(root.tag, "DIV");
  assert.equal(root.visible, true);
  assert.equal(root.has_message_id, true);
  assert.deepEqual(Object.keys(root.data).sort(), ["state", "testid"]);
  let deepest = root;
  while (deepest.children.length) deepest = deepest.children[0];
  assert.ok(deepest.depth <= 6, `profondeur bornée, vue ${deepest.depth}`);

  // Un signal de dérive illisible reste un rapport borné, jamais un rejet brut.
  const drifted = popup.structure(
    { ok: true, roots: [{ strategy: SECRET, node: { tag: SECRET, text: SECRET } }] },
    7,
    { source: "generic_chatgpt_tab", bridge_owned: false },
  );
  assert.equal(drifted.strategy, null);
  assert.equal(drifted.roots.length, 1);
  assert.equal(drifted.roots[0].strategy, null);
  assert.equal(drifted.roots[0].node.tag, null);

  for (const report of [structure, drifted]) {
    const json = JSON.stringify(report);
    assert.equal(json.includes(SECRET), false, "aucun contenu dans le snapshot");
    for (const forbidden of ["innerText", "textContent", "innerHTML"]) {
      assert.equal(json.includes(forbidden), false, `snapshot structurel : ${forbidden}`);
    }
  }
}

// 6. Le worker et le popup partagent littéralement le même bloc de liste
//    blanche structurelle : il ne peut pas dériver de l'un à l'autre.
{
  const block = (source) => {
    const start = source.indexOf("function structureToken(");
    assert.notEqual(start, -1, "bloc de liste blanche structurelle introuvable");
    const marker = source.indexOf("function safeResponseStructure(");
    assert.notEqual(marker, -1, "safeResponseStructure introuvable");
    const end = source.indexOf("\n}\n", marker);
    assert.notEqual(end, -1, "fin de safeResponseStructure introuvable");
    return source.slice(start, end + 3).replace(/\s+/g, " ").trim();
  };
  assert.equal(block(BACKGROUND), block(POPUP), "liste blanche structurelle divergente");
  assert.ok(BACKGROUND.includes("async function handleResponseStructure()"));
  assert.ok(POPUP.includes('type: "response_structure"'));
  assert.ok(POPUP_HTML.includes('id="copy-response-structure"'));
  for (const id of [
    "surface-status",
    "response-strategy",
    "baseline-roots",
    "current-roots",
    "candidate-status",
    "markdown-root",
    "inline-leaves",
  ]) {
    assert.ok(POPUP_HTML.includes(`id="${id}"`), `popup.html : ${id} manquant`);
  }
}

console.log("dom contract + popup diagnostic contract: ok");
