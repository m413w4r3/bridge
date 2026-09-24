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
function loadPopup() {
  const dom = new JSDOM(POPUP_HTML.replace(/<script[^>]*><\/script>/, ""), {
    runScripts: "outside-only",
    url: "chrome-extension://bridge/popup.html",
  });
  const { window } = dom;
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
    text: (id) => window.document.getElementById(id).textContent,
  };
}

const SECRET = "TOP_SECRET_USER_PROMPT_42";
function rawReport({ composer = {}, send = {}, connection = {} } = {}) {
  return {
    ok: true,
    content_script_version: "36",
    tab_id: 7,
    extension_state: "active",
    websocket_state: "connected",
    // Champs hors contrat : ne doivent jamais apparaître dans le rapport.
    prompt: SECRET,
    text: SECRET,
    wsToken: SECRET,
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
    assert.equal(report.composer.status, composer.status);
    assert.equal(JSON.stringify(report).includes(SECRET), false, `composer ${composer.status}: aucun contenu`);
  }
  assert.equal(popup.render(rawReport({ composer: { selector: `#${SECRET}` } })).composer.selector, null);

  const sendCases = [
    [{ status: "ok" }, "OK"],
    [{ status: "degraded", strategy: "structural_fallback", selector: "button[type='submit']" }, "DEGRADED"],
    [{ status: "missing", strategy: "structural_fallback", selector: "button[type='submit']", visible_candidates: 0 }, "BROKEN"],
  ];
  for (const [send, label] of sendCases) {
    const report = popup.render(rawReport({ send }));
    assert.equal(popup.text("send-status"), label, `send ${send.status}`);
    assert.equal(JSON.stringify(report).includes(SECRET), false, `send ${send.status}: aucun contenu`);
  }

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
    "content_script_version",
    "error",
    "extension_state",
    "ok",
    "tab_id",
    "websocket_state",
  ]);
}

console.log("dom contract + popup diagnostic contract: ok");
