/**
 * Tests du périmètre DOM de content.js : quels nœuds ont le droit de dire
 * qu'une génération est encore active. Un signal lu trop large (Stop d'un
 * widget quelconque, indicateur de streaming laissé par un ancien tour)
 * empêchait la finalisation du tour surveillé.
 *
 * jsdom est une dépendance de test de ce dépôt : `npm ci` avant ce test.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const EXTENSION = path.join(__dirname, "..", "extension");

let JSDOM;
try {
  ({ JSDOM } = require("jsdom"));
} catch (err) {
  console.error("jsdom introuvable : lancer `npm ci` à la racine du dépôt avant ce test.");
  throw err;
}

/**
 * Charge les scripts de l'extension dans un DOM simulé et rend leurs fonctions
 * de haut niveau appelables depuis le test.
 */
function loadExtension(body, url = "https://chatgpt.com/") {
  const dom = new JSDOM(`<!doctype html><html><body>${body}</body></html>`, {
    runScripts: "outside-only",
    url,
  });
  const { window } = dom;

  // jsdom ne calcule aucune mise en page : sans ce repli, `visible()` renverrait
  // false pour tous les éléments et aucun signal ne serait jamais lu.
  window.Element.prototype.getClientRects = function getClientRects() {
    return this.hasAttribute("data-test-offscreen") ? [] : [{}];
  };
  // `CSS.escape` existe dans le navigateur mais pas dans jsdom ; les locators de
  // tour sont de simples identifiants, un échappement minimal suffit ici.
  window.CSS = window.CSS || {
    escape: (value) => String(value).replace(/["\\]/g, "\\$&"),
  };
  window.chrome = {
    storage: { local: { get: async () => ({}), set: async () => {} } },
    runtime: {
      sendMessage: async () => {},
      onMessage: { addListener: () => {} },
    },
  };

  const context = dom.getInternalVMContext();
  // jsdom ne fournit ni `TextEncoder`, ni `DataTransfer`, ni `ClipboardEvent`,
  // ni `DragEvent` — tous natifs dans Chrome. Shims minimaux, évalués DANS le
  // contexte vm pour que les objets partagent le realm du document.
  window.TextEncoder = TextEncoder;
  vm.runInContext(
    `
    class DataTransfer {
      constructor() {
        this._data = new Map();
        this._files = [];
        const files = this._files;
        this.items = {
          add: (file) => { files.push(file); return file; },
          get length() { return files.length; },
        };
      }
      setData(type, value) { this._data.set(String(type), String(value)); }
      getData(type) { return this._data.get(String(type)) ?? ""; }
      get types() { return [...this._data.keys()]; }
      get files() { return this._files; }
    }
    class ClipboardEvent extends Event {
      constructor(type, init = {}) {
        super(type, init);
        this.clipboardData = init.clipboardData ?? null;
      }
    }
    class DragEvent extends Event {
      constructor(type, init = {}) {
        super(type, init);
        this.dataTransfer = init.dataTransfer ?? null;
      }
    }
    globalThis.DataTransfer = DataTransfer;
    globalThis.ClipboardEvent = ClipboardEvent;
    globalThis.DragEvent = DragEvent;
  `,
    context,
    { filename: "test-shims.js" },
  );
  for (const file of [
    "serializer.js",
    "completion.js",
    "final-output.js",
    "content.js",
  ]) {
    vm.runInContext(
      fs.readFileSync(path.join(EXTENSION, file), "utf8"),
      context,
      {
        filename: file,
      },
    );
  }
  return {
    window,
    run: (expression) => vm.runInContext(expression, context),
    // Les objets nés dans le contexte vm ont un autre prototype : on les
    // recopie pour que deepEqual compare des valeurs, pas des realms.
    state: (expression) => ({ ...vm.runInContext(expression, context) }),
  };
}

const WATCHED_TURN = `
  <article data-testid="conversation-turn-3">
    <div data-message-author-role="assistant" data-message-id="m3">
      <div class="markdown"><p>réponse finale</p></div>
    </div>
    __ACTIONS__
  </article>`;

const composer = `
  <form>
    <div id="prompt-textarea" contenteditable="true"></div>
    <button data-testid="send-button">Envoyer</button>
    __COMPOSER_STOP__
  </form>`;

const copyButton = `<button data-testid="copy-turn-action-button">Copy response</button>`;
const stopButton = `<button data-testid="stop-button" aria-label="Stop streaming"></button>`;

function page({
  staleStreaming = false,
  watchedStreaming = false,
  actions = false,
  strayStop = false,
  composerStop = false,
  withComposer = true,
} = {}) {
  const stale = `
    <article data-testid="conversation-turn-1">
      <div data-message-author-role="assistant" data-message-id="m1">
        <div class="markdown"><p>ancienne réponse</p></div>
        ${staleStreaming ? `<div data-is-streaming="true"></div>` : ""}
      </div>
      ${copyButton}
    </article>`;
  const watched = WATCHED_TURN.replace(
    "__ACTIONS__",
    `${watchedStreaming ? `<div class="result-streaming"></div>` : ""}${
      actions ? copyButton : ""
    }`,
  );
  const aside = strayStop
    ? `<aside><button aria-label="Stop la lecture">Stop</button></aside>`
    : "";
  const form = withComposer
    ? composer.replace("__COMPOSER_STOP__", composerStop ? stopButton : "")
    : "";
  return `<main>${stale}${watched}</main>${aside}${form}`;
}

const WATCHED = `document.querySelector("[data-testid='conversation-turn-3'] [data-message-author-role='assistant']")`;

function serializeMarkup(body) {
  const { run } = loadExtension(body);
  return run(
    `ChatGPTBridgeSerializer.serializeResponse(document.querySelector("#serialize-root"))`,
  );
}

function serializeCode(raw, className = "") {
  const classAttribute = className ? ` class="${className}"` : "";
  const { run } = loadExtension(
    `<div id="serialize-root"><pre><code${classAttribute}></code></pre></div>`,
  );
  run(
    `document.querySelector("#serialize-root code").textContent = ${JSON.stringify(raw)}`,
  );
  return run(
    `ChatGPTBridgeSerializer.serializeResponse(document.querySelector("#serialize-root"))`,
  );
}

function recoverFencedCode(markdown) {
  const openingLineEnd = markdown.indexOf("\n");
  const closingFence = "\n```";
  assert.ok(openingLineEnd >= 0, "le code doit avoir une ligne d'ouverture");
  assert.ok(markdown.endsWith(closingFence), "le code doit avoir une fence fermante");
  return markdown.slice(openingLineEnd + 1, -closingFence.length);
}

// --- Fidélité du serializer Markdown ------------------------------------- //
{
  const serialized = serializeMarkup(`
    <div id="serialize-root">
      <h1>Premier</h1>
      <h2>Deuxième</h2>
      <h3>Troisième</h3>
      <h6>Sixième</h6>
    </div>`);
  assert.equal(
    serialized.text,
    "# Premier\n\n## Deuxième\n\n### Troisième\n\n###### Sixième",
  );
  assert.equal(serialized.serializer_version, "chatgpt-dom-v3");
}

{
  const serialized = serializeMarkup(`
    <div id="serialize-root">
      <h2>Liste</h2>
      <ul><li>un</li><li>deux</li></ul>
    </div>`);
  assert.equal(serialized.text, "## Liste\n\n- un\n- deux");
}

{
  const raw = "  const answer = 42;  \n    return answer;";
  const { run } = loadExtension(
    `<div id="serialize-root"><h2>Exemple</h2><pre><code class="language-js"></code></pre></div>`,
  );
  run(`document.querySelector("#serialize-root code").textContent = ${JSON.stringify(raw)}`);
  const serialized = run(
    `ChatGPTBridgeSerializer.serializeResponse(document.querySelector("#serialize-root"))`,
  );
  assert.equal(
    serialized.text,
    `## Exemple\n\n\`\`\`js\n${raw}\n\`\`\``,
  );
  assert.equal(recoverFencedCode(serialized.text.split("\n\n")[1]), raw);
}

{
  const raw = `  trailing spaces  \n\n\n\n  backslashes C:\\tmp\\file  \nhxxps\\://example.test/path  \n`;
  const serialized = serializeCode(raw);
  assert.equal(recoverFencedCode(serialized.text), raw);
  assert.equal(serialized.text, `\`\`\`\n${raw}\n\`\`\``);
}

{
  const withoutFinalNewline = serializeCode("ligne");
  const withFinalNewline = serializeCode("ligne\n");
  assert.equal(withoutFinalNewline.text, "\`\`\`\nligne\n\`\`\`");
  assert.equal(withFinalNewline.text, "\`\`\`\nligne\n\n\`\`\`");
  assert.equal(recoverFencedCode(withoutFinalNewline.text), "ligne");
  assert.equal(recoverFencedCode(withFinalNewline.text), "ligne\n");
}

{
  const serialized = serializeMarkup(
    `<div id="serialize-root">prose   \n\n\nprose hxxps\\://example.test</div>`,
  );
  assert.equal(serialized.text, "prose\n\nprose hxxps\\://example.test");
}

{
  const serialized = serializeMarkup(`
    <div id="serialize-root">
      <p>Voir <a href="https://example.test/page?utm_source=chatgpt&amp;b=2">la page</a>
        <sup data-testid="citation"><a href="https://example.test/source">[1]</a></sup>
      </p>
    </div>`);
  assert.equal(
    serialized.text,
    "Voir [la page](https://example.test/page?utm_source=chatgpt&b=2)",
  );
  assert.deepEqual(JSON.parse(JSON.stringify(serialized.visible_citations)), [
    {
      label: "[1]",
      url: "https://example.test/source",
      canonical_url: "https://example.test/source",
      position: null,
    },
  ]);
}

// --- Périmètre du streaming : le tour surveillé, pas la page entière -------- //
{
  const { state } = loadExtension(
    page({ staleStreaming: true, strayStop: true, actions: true }),
  );
  assert.deepEqual(
    state(`completionState(${WATCHED})`),
    { finished: true, signal: "assistant_actions", confidence: "high" },
    "un indicateur de streaming d'un ancien tour ne bloque pas la finalisation",
  );
}

{
  const { state } = loadExtension(page({ watchedStreaming: true }));
  assert.deepEqual(
    state(`completionState(${WATCHED})`),
    { finished: false, signal: "streaming", confidence: "high" },
    "le streaming du tour surveillé, lui, interdit la finalisation",
  );
}

// --- Périmètre du Stop : le composer, pas la page entière ------------------ //
{
  const { state } = loadExtension(page({ strayStop: true, actions: true }));
  assert.deepEqual(
    state(`completionState(${WATCHED})`),
    { finished: true, signal: "assistant_actions", confidence: "high" },
    "un bouton « Stop » hors composer ne maintient pas le tour en running",
  );
}

{
  const { state } = loadExtension(page({ strayStop: true }));
  assert.deepEqual(
    state(`completionState(${WATCHED})`),
    { finished: null, signal: "unknown", confidence: "low" },
    "un « Stop » hors composer n'est pas lu du tout",
  );
}

{
  const { state } = loadExtension(page({ composerStop: true }));
  assert.deepEqual(
    state(`completionState(${WATCHED})`),
    { finished: false, signal: "stop_button", confidence: "high" },
    "le Stop du composer reste un signal d'activité",
  );
}

{
  // Composer temporairement absent : mieux vaut aucun signal qu'un scope
  // retombant sur document.body, qui rendrait le cloisonnement inutile.
  const { state } = loadExtension(
    page({ withComposer: false, strayStop: true }),
  );
  assert.deepEqual(
    state(`completionState(${WATCHED})`),
    { finished: null, signal: "unknown", confidence: "low" },
    "sans composer, aucun Stop n'est retenu",
  );
}

// --- Identité externe : un placeholder d'UI n'en est pas une --------------- //
{
  const placeholder =
    "request-placeholder-request-WEB:822ff1a2-6c1f-49a1-b10e-3143f7ca53b3-0";
  const { run } = loadExtension(`
    <article data-testid="conversation-turn-4">
      <div data-message-author-role="assistant" data-message-id="${placeholder}">
        <div class="markdown"><p>réponse</p></div>
      </div>
    </article>
    <article data-testid="conversation-turn-5">
      <div data-message-author-role="assistant" data-message-id="m-stable">
        <div class="markdown"><p>réponse</p></div>
      </div>
    </article>`);

  assert.equal(
    run(
      `turnExternalId(document.querySelector("[data-message-id='${placeholder}']"))`,
    ),
    null,
    "un data-message-id placeholder ne devient jamais une identité durable",
  );
  assert.equal(
    run(`turnExternalId(document.querySelector("[data-message-id='m-stable']"))`),
    "m-stable",
    "un vrai data-message-id reste l'identité externe du tour",
  );
  assert.equal(
    run(`findAssistantTurnByExternalId(${JSON.stringify(placeholder)})`),
    null,
    "aucun tour n'est routable par un placeholder",
  );
}

// --- Diagnostic de streaming : quel détecteur, et rien d'autre -------------- //
{
  const { run } = loadExtension(`
    <div id="scope">
      <div class="streaming-animation" aria-hidden="false"></div>
      <div data-is-streaming="true" data-state="open"></div>
      <div class="result-streaming" data-test-offscreen></div>
      <p>texte de réponse à ne jamais journaliser</p>
    </div>`);
  const sources = JSON.parse(
    JSON.stringify(run(`streamingSignalSources(document.querySelector("#scope"))`)),
  );
  assert.deepEqual(sources, [
    {
      source: ".streaming-animation",
      visible: true,
      data_is_streaming: null,
      aria_hidden: "false",
      data_state: null,
    },
    {
      source: "[data-is-streaming='true']",
      visible: true,
      data_is_streaming: "true",
      aria_hidden: null,
      data_state: "open",
    },
  ]);
  assert.ok(
    !JSON.stringify(sources).includes("texte de réponse"),
    "le diagnostic ne doit contenir aucun contenu de page",
  );
}

// --- Garde-fou : un signal actif figé ne boucle pas indéfiniment ------------ //
(async () => {
  const { window, run } = loadExtension(page({ watchedStreaming: true }));

  // Horloge virtuelle : chaque sleep() avance le temps du délai demandé, ce qui
  // rend les deux minutes de stabilité atteignables sans attente réelle.
  let clock = 1_000_000;
  let sleeps = 0;
  window.Date.now = () => clock;
  window.setTimeout = (fn, ms) => {
    clock += ms || 0;
    sleeps += 1;
    queueMicrotask(fn);
    return 0;
  };

  window.testJob = { id: "stall", aborted: false };
  const result = await run(`streamAnswer(testJob, "conversation-turn-3", 1)`);

  assert.equal(result.incomplete, true);
  assert.equal(result.incomplete_reason, "active_signal_stalled");
  assert.equal(result.completion_signal, "streaming");
  assert.equal(result.text, "réponse finale");
  // Incident de production : la réponse était visible et le run a pourtant été
  // journalisé output_chars=0. Le candidat et son décompte réel restent joints.
  assert.equal(result.output_chars, "réponse finale".length);
  // Et le diagnostic dit *quel* détecteur est resté allumé, sans contenu.
  assert.deepEqual(
    JSON.parse(JSON.stringify(result.streaming_signal_sources)),
    [
      {
        source: ".result-streaming",
        visible: true,
        data_is_streaming: null,
        aria_hidden: null,
        data_state: null,
      },
    ],
    "le stall doit nommer le sélecteur de streaming encore actif",
  );
  // Le seuil est relu dans le script : le test protège le garde-fou, pas une
  // valeur particulière, qui peut être desserrée quand ChatGPT ralentit.
  const seuil = run("WATCHED_TURN_ACTIVE_SIGNAL_STALL_MS");
  assert.ok(seuil >= 120_000, `garde-fou trop court : ${seuil} ms`);
  assert.ok(
    result.stable_for_ms >= seuil,
    `stabilité attendue >= ${seuil} ms, vue ${result.stable_for_ms}`,
  );
  assert.ok(sleeps > 0, "la boucle doit réellement avoir tourné");

  console.log("content dom scope contract: ok");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

// --------------------------------------------------------------------------- //
// Temporary Chat : confirmation positive avant Send, jamais best-effort ; et
// identité du tour précédent pour CONTINUE, jamais par index/comptage.
// --------------------------------------------------------------------------- //
/** Contourne les délais réels de waitFor()/sleep() : chaque setTimeout avance
 * une horloge virtuelle et relance immédiatement le callback. */
function useVirtualClock(window) {
  let clock = 0;
  window.Date.now = () => clock;
  window.setTimeout = (fn, ms) => {
    clock += ms || 0;
    queueMicrotask(fn);
    return 0;
  };
}

(async () => {
  const temporaryComposer = `<div id="prompt-textarea" contenteditable="true"></div>`;

  // 1. URL Temporary + composer, sans toggle : le markup de l'UI n'est pas
  // une preuve de confidentialité et n'est jamais requis.
  {
    const { run } = loadExtension(temporaryComposer, "https://chatgpt.com/?temporary-chat=true");
    await run("ensureTemporaryChat()");
  }

  // 2. Toggle au markup inconnu : accepté, sans clic.
  {
    const { window, run } = loadExtension(
      `${temporaryComposer}<button aria-label="Temporary chat"><svg><use href="#unknown"></use></svg></button>`,
      "https://chatgpt.com/?temporary-chat=true",
    );
    useVirtualClock(window);
    let clicked = false;
    window.document.querySelector("button[aria-label='Temporary chat']").addEventListener("click", () => { clicked = true; });
    await run("ensureTemporaryChat()");
    assert.equal(clicked, false, "un toggle au markup inconnu ne doit jamais être cliqué");
  }

  // 3. aria-pressed=false ne doit pas provoquer de mutation.
  {
    const { window, run } = loadExtension(
      `${temporaryComposer}<button aria-label="Temporary chat" aria-pressed="false"></button>`,
      "https://chatgpt.com/?temporary-chat=true",
    );
    useVirtualClock(window);
    let clicked = false;
    window.document.querySelector("button[aria-label='Temporary chat']").addEventListener("click", () => { clicked = true; });
    await run("ensureTemporaryChat()");
    assert.equal(clicked, false, "aria-pressed=false ne doit jamais être cliqué");
  }

  // 4-7. URL non temporaire ou navigation persistante : échec immédiat.
  {
    const { run } = loadExtension(temporaryComposer, "https://chatgpt.com/");
    await assert.rejects(run("ensureTemporaryChat()"), (err) => err.code === "bridge_ui_timeout");
  }
  {
    const { run } = loadExtension(temporaryComposer, "https://chatgpt.com/?temporary-chat=false");
    await assert.rejects(run("ensureTemporaryChat()"), (err) => err.code === "bridge_ui_timeout");
  }
  {
    const { run } = loadExtension(temporaryComposer, "https://chatgpt.com/c/abc123");
    await assert.rejects(run("ensureTemporaryChat()"), (err) => err.code === "conversation_unavailable");
  }
  {
    const { run } = loadExtension(temporaryComposer, "https://example.com/?temporary-chat=true");
    await assert.rejects(run("ensureTemporaryChat()"), (err) => err.code === "bridge_ui_timeout");
  }

  // 8. URL correcte mais composer jamais rendu : timeout de chargement, avec
  // relecture du DOM à chaque poll.
  {
    const { window, run } = loadExtension("", "https://chatgpt.com/?temporary-chat=true");
    useVirtualClock(window);
    await assert.rejects(
      run("ensureTemporaryChat()"),
      (err) => err.code === "bridge_ui_timeout",
      "composer absent : bridge_ui_timeout",
    );
  }

  // 9. Composer rendu après plusieurs polls : le DOM est relu, sans conserver
  // un nœud obsolète.
  {
    const { window, run } = loadExtension("", "https://chatgpt.com/?temporary-chat=true");
    useVirtualClock(window);
    window.setTimeout(() => { window.document.body.innerHTML = temporaryComposer; }, 300);
    await run("ensureTemporaryChat()");
  }

  // 10. Chemin comportemental réel : l'onglet est créé directement sur l'URL
  // Temporary, le composer existe et l'ancien markup SVG est absent. Le prompt
  // doit atteindre Send sans aucun contrôle Temporary.
  {
    const body = `<form id="composer-form">
      <textarea data-id="prompt"></textarea>
      <button aria-disabled="false" id="composer-submit-button" aria-label="Send prompt" data-testid="send-button">Send</button>
    </form><button data-testid="create-new-chat-button">New chat</button>`;
    const { window, run } = loadExtension(body, "https://chatgpt.com/?temporary-chat=true");
    useVirtualClock(window);
    const sent = [];
    window.chrome.runtime.sendMessage = async (message) => { sent.push(message); };
    let sendClicks = 0;
    let submitEvents = 0;
    let newChatClicks = 0;
    window.document.querySelector("button[data-testid='send-button']").addEventListener("click", () => { sendClicks += 1; });
    window.document.querySelector("#composer-form").addEventListener("submit", (event) => {
      submitEvents += 1;
      event.preventDefault();
      window.document.querySelector("textarea[data-id='prompt']").value = "";
      window.document.body.insertAdjacentHTML("beforeend", `
        <article data-testid="conversation-turn-1">
          <div data-message-author-role="assistant" data-message-id="msg-A1">
            <div class="markdown"><p>réponse finale</p></div>
          </div>
          ${copyButton}
        </article>`);
    });
    window.document.querySelector("button[data-testid='create-new-chat-button']").addEventListener("click", () => {
      newChatClicks += 1;
    });
    await run(`handlePrompt({ id: "req-A", prompt: "bonjour", new_chat: true, conversation: { id: "conv-A", mode: "fresh" } })`);
    assert.equal(window.document.querySelector("textarea[data-id='prompt']").value, "");
    assert.equal(newChatClicks, 0, "une conversation explicite ne doit jamais cliquer New Chat");
    assert.equal(submitEvents, 1, "le formulaire doit être soumis exactement une fois");
    assert.equal(sendClicks, 0, "requestSubmit ne doit pas dépendre d'un click synthétique");
    assert.equal(sent.some((message) => message.type === "error"), false, "aucune erreur pre_submission");
    assert.equal(sent.some((message) => message.type === "done"), true, "le chemin comportemental doit terminer");
  }

  // 10b. Un run stateless reçoit sa cible déjà réservée : il n'a aucune
  // autorisation de fabriquer un Temporary Chat par clic DOM.
  {
    const body = `<form id="composer-form">
      <textarea data-id="prompt"></textarea>
      <button aria-disabled="false" data-testid="send-button">Send</button>
    </form><button data-testid="create-new-chat-button">New chat</button>`;
    const { window, run } = loadExtension(body, "https://chatgpt.com/?temporary-chat=true");
    useVirtualClock(window);
    const sent = [];
    window.chrome.runtime.sendMessage = async (message) => { sent.push(message); };
    let newChatClicks = 0;
    let submitEvents = 0;
    window.document.querySelector("button[data-testid='create-new-chat-button']").addEventListener("click", () => {
      newChatClicks += 1;
    });
    window.document.querySelector("#composer-form").addEventListener("submit", (event) => {
      submitEvents += 1;
      event.preventDefault();
      window.document.querySelector("textarea[data-id='prompt']").value = "";
      window.document.body.insertAdjacentHTML("beforeend", `
        <article data-testid="conversation-turn-stateless">
          <div data-message-author-role="assistant" data-message-id="msg-stateless">
            <div class="markdown"><p>réponse finale</p></div>
          </div>${copyButton}
        </article>`);
    });
    await run(`handlePrompt({ id: "req-stateless", prompt: "bonjour", new_chat: true, browser_target: { kind: "temporary_chat_run", id: "target-stateless" } })`);
    assert.equal(newChatClicks, 0, "un run stateless ne doit jamais cliquer New Chat");
    assert.equal(submitEvents, 1, "le run stateless doit soumettre une seule fois");
    assert.equal(sent.some((message) => message.type === "error"), false);
    assert.equal(sent.some((message) => message.type === "done"), true);
  }

  // 10c. La surface stateless sans browser_target est une erreur PRE_SUBMISSION.
  {
    const body = `<form id="composer-form"><textarea data-id="prompt"></textarea>
      <button aria-disabled="false" data-testid="send-button">Send</button></form>`;
    const { window, run } = loadExtension(body, "https://chatgpt.com/?temporary-chat=true");
    const sent = [];
    window.chrome.runtime.sendMessage = async (message) => { sent.push(message); };
    await run(`handlePrompt({ id: "req-no-target", prompt: "bonjour", new_chat: true })`);
    const error = sent.find((message) => message.type === "error");
    assert.equal(error.code, "bridge_browser_target_required");
    assert.equal(error.phase, "pre_submission");
    assert.equal(error.submission_state, "pre_submission");
  }

  // 10a. Le tour utilisateur est la preuve la plus forte : le composer peut
  // rester rempli, le Stop peut être hors formulaire et l'assistant peut ne
  // pas encore être apparu.
  {
    const body = `<aside><button data-testid="stop-button">ancien Stop</button></aside>
      <form id="composer-form"><textarea data-id="prompt">bonjour</textarea>
        <button aria-disabled="false" data-testid="send-button">Send</button></form>`;
    const { window, run } = loadExtension(body, "https://chatgpt.com/?temporary-chat=true");
    let submitEvents = 0;
    const form = window.document.querySelector("#composer-form");
    form.addEventListener("submit", (event) => {
      submitEvents += 1;
      event.preventDefault();
      form.insertAdjacentHTML(
        "beforeend",
        `<div data-message-author-role="user">bonjour</div>`,
      );
    });
    const signal = await run(`(async () => {
      const composer = document.querySelector("textarea[data-id='prompt']");
      const send = document.querySelector("button[data-testid='send-button']");
      const before = captureSubmissionSnapshot(composer, send);
      triggerComposerSubmission(composer, send);
      return waitForSubmissionConfirmation(composer, send, before, "requestSubmit");
    })()`);
    assert.equal(signal, "user_turn");
    assert.equal(submitEvents, 1);
  }

  // 10a-bis. Une preuve qui arrive après l'ancienne fenêtre de 5 s reste
  // attachée au même run et réussit sans second trigger.
  {
    const body = `<form id="composer-form"><textarea data-id="prompt">bonjour</textarea>
      <button aria-disabled="false" data-testid="send-button">Send</button></form>`;
    const { window, run } = loadExtension(body, "https://chatgpt.com/?temporary-chat=true");
    let clock = 0;
    let polls = 0;
    let userAdded = false;
    window.Date.now = () => clock;
    window.setTimeout = (fn, ms) => {
      clock += ms || 0;
      polls += 1;
      if (!userAdded && clock > 5_000) {
        userAdded = true;
        window.document.body.insertAdjacentHTML(
          "beforeend",
          `<div data-message-author-role="user">bonjour</div>`,
        );
      }
      queueMicrotask(fn);
      return 0;
    };
    let submitEvents = 0;
    window.document.querySelector("#composer-form").addEventListener("submit", (event) => {
      submitEvents += 1;
      event.preventDefault();
    });
    const signal = await run(`(async () => {
      const composer = document.querySelector("textarea[data-id='prompt']");
      const send = document.querySelector("button[data-testid='send-button']");
      const before = captureSubmissionSnapshot(composer, send);
      triggerComposerSubmission(composer, send);
      return waitForSubmissionConfirmation(composer, send, before, "requestSubmit");
    })()`);
    assert.equal(signal, "user_turn");
    assert.equal(submitEvents, 1, "un seul triggerComposerSubmission");
    assert.ok(clock > 5_000);
    assert.ok(polls > 0);
  }

  // 10a-ter. La borne finale sans preuve produit une erreur typée après un
  // seul trigger ; l'absence de confirmation n'autorise aucun rejeu.
  {
    const body = `<textarea data-id="prompt">bonjour</textarea>
      <button aria-disabled="false" data-testid="send-button">Send</button>`;
    const { window, run } = loadExtension(body, "https://chatgpt.com/?temporary-chat=true");
    useVirtualClock(window);
    let clicks = 0;
    window.document.querySelector("button[data-testid='send-button']").addEventListener(
      "click",
      () => { clicks += 1; },
    );
    let error;
    try {
      await run(`(async () => {
        const composer = document.querySelector("textarea[data-id='prompt']");
        const send = document.querySelector("button[data-testid='send-button']");
        const before = captureSubmissionSnapshot(composer, send);
        triggerComposerSubmission(composer, send);
        return waitForSubmissionConfirmation(composer, send, before, "click");
      })()`);
    } catch (caught) {
      error = caught;
    }
    assert.equal(error.code, "bridge_ui_timeout");
    assert.equal(error.diagnostics.composer_still_has_text, true);
    assert.equal(clicks, 1, "aucun second clic après un timeout ambigu");
  }

  // 10b. Un click observé sans effet de soumission ne suffit jamais : aucune
  // seconde méthode ne doit être tentée après l'échec de confirmation.
  {
    const body = `<form id="composer-form">
      <textarea data-id="prompt"></textarea>
      <button aria-disabled="false" id="composer-submit-button" aria-label="Send prompt" data-testid="send-button">Send</button>
    </form>`;
    const { window, run } = loadExtension(body, "https://chatgpt.com/?temporary-chat=true");
    useVirtualClock(window);
    const sent = [];
    window.chrome.runtime.sendMessage = async (message) => { sent.push(message); };
    let submitEvents = 0;
    let sendClicks = 0;
    window.document.querySelector("#composer-form").addEventListener("submit", (event) => {
      submitEvents += 1;
      event.preventDefault();
    });
    window.document.querySelector("button[data-testid='send-button']").addEventListener("click", () => { sendClicks += 1; });
    await run(`handlePrompt({ id: "req-no-confirm", prompt: "bonjour", conversation: { id: "conv-A", mode: "fresh" } })`);
    const error = sent.find((message) => message.type === "error");
    assert.equal(submitEvents, 1);
    assert.equal(sendClicks, 0);
    assert.equal(error?.code, "bridge_ui_timeout");
    assert.equal(error?.submission_state, "submission_attempted");
  }

  // 10c. Un bouton disabled avant tout trigger reste un échec pre_submission.
  {
    const body = `<form><textarea data-id="prompt"></textarea>
      <button aria-disabled="true" id="composer-submit-button" aria-label="Send prompt" data-testid="send-button">Send</button></form>`;
    const { window, run } = loadExtension(body, "https://chatgpt.com/?temporary-chat=true");
    useVirtualClock(window);
    const sent = [];
    window.chrome.runtime.sendMessage = async (message) => { sent.push(message); };
    await run(`handlePrompt({ id: "req-pre", prompt: "bonjour", conversation: { id: "conv-A", mode: "fresh" } })`);
    assert.equal(sent.find((message) => message.type === "error")?.submission_state, "pre_submission");
  }

  // 10d. Une soumission confirmée puis une panne de génération est post_submission.
  {
    const body = `<form id="composer-form"><textarea data-id="prompt"></textarea>
      <button aria-disabled="false" id="composer-submit-button" aria-label="Send prompt" data-testid="send-button">Send</button></form>`;
    const { window, run } = loadExtension(body, "https://chatgpt.com/?temporary-chat=true");
    useVirtualClock(window);
    const sent = [];
    window.chrome.runtime.sendMessage = async (message) => { sent.push(message); };
    let submitEvents = 0;
    window.document.querySelector("#composer-form").addEventListener("submit", (event) => {
      submitEvents += 1;
      event.preventDefault();
      window.document.querySelector("textarea[data-id='prompt']").value = "";
    });
    await run(`handlePrompt({ id: "req-post", prompt: "bonjour", conversation: { id: "conv-A", mode: "fresh" } })`);
    assert.equal(submitEvents, 1);
    const error = sent.find((message) => message.type === "error");
    assert.equal(error?.code, "bridge_ui_timeout");
    assert.equal(error?.phase, "generation");
    assert.equal(error?.submission_state, "post_submission");
    assert.equal(error?.diagnostics?.composer_has_text, false);
    assert.equal(error?.diagnostics?.streaming_generation_signal_visible, false);
    assert.equal(error?.diagnostics?.assistant_turns_before, 0);
    assert.equal(error?.diagnostics?.assistant_turns_after, 0);
    assert.equal(
      JSON.stringify(error).includes("bonjour"),
      false,
      "les diagnostics de stall ne doivent pas contenir le prompt",
    );
  }

  // 10e. Le premier tour peut apparaître après plus de 30 s : une activité de
  // génération post-soumission garde l'attente en vie, les heartbeats restent
  // sans contenu, puis le même envoi aboutit sans second trigger.
  {
    const body = `<form id="composer-form"><textarea data-id="prompt"></textarea>
      <button aria-disabled="false" data-testid="send-button">Send</button></form>`;
    const { window, run } = loadExtension(body, "https://chatgpt.com/?temporary-chat=true");
    const sent = [];
    window.chrome.runtime.sendMessage = async (message) => { sent.push(message); };
    let clock = 0;
    let assistantAdded = false;
    window.Date.now = () => clock;
    window.setTimeout = (fn, ms) => {
      clock += ms || 0;
      if (!assistantAdded && clock >= 30_500) {
        assistantAdded = true;
        window.document.body.insertAdjacentHTML(
          "beforeend",
          `<article data-testid="conversation-turn-long">
            <div data-message-author-role="assistant" data-message-id="msg-long">
              <div class="markdown"><p>réponse après longue attente</p></div>
            </div>${copyButton}
          </article>`,
        );
      }
      queueMicrotask(fn);
      return 0;
    };
    let submitEvents = 0;
    window.document.querySelector("#composer-form").addEventListener("submit", (event) => {
      submitEvents += 1;
      event.preventDefault();
      window.document.querySelector("textarea[data-id='prompt']").value = "";
      window.document.querySelector("#composer-form").insertAdjacentHTML(
        "beforeend",
        `<div class="result-streaming"></div>`,
      );
    });

    await run(`handlePrompt({ id: "req-long-first-turn", prompt: "recherche longue", conversation: { id: "conv-long", mode: "fresh" } })`);

    assert.ok(clock > 30_000, "le tour doit être attendu au-delà de l'ancienne borne de 30 s");
    assert.equal(submitEvents, 1, "le formulaire ne doit être soumis qu'une fois");
    assert.equal(sent.filter((message) => message.type === "error").length, 0);
    assert.equal(sent.find((message) => message.type === "done")?.text, "réponse après longue attente");
    const heartbeats = sent.filter((message) => message.type === "heartbeat");
    assert.ok(heartbeats.length >= 5, "les heartbeats doivent continuer avant le premier tour");
    assert.ok(
      heartbeats.every(
        (message) =>
          message.progress?.phase === "waiting_answer" &&
          message.progress?.output_chars === 0,
      ),
      "l'attente du premier tour ne doit publier que de la liveness sans contenu",
    );
    assert.equal(
      heartbeats.some((message) => JSON.stringify(message).includes("recherche longue")),
      false,
      "un heartbeat ne doit jamais contenir le prompt",
    );
    assert.equal(
      heartbeats.some((message) => JSON.stringify(message).includes("réponse après longue attente")),
      false,
      "un heartbeat ne doit jamais contenir la réponse",
    );
  }

  // 10f. Les signaux Stop/reasoning/streaming déjà présents avant l'envoi ne
  // prolongent pas artificiellement l'attente d'un nouveau tour assistant.
  {
    const body = `<article data-testid="conversation-turn-stale">
        <div data-message-author-role="assistant" data-message-id="msg-stale">
          <div class="markdown"><p>ancienne réponse</p></div>
          <div class="result-streaming"></div>
        </div>
      </article>
      <details data-testid="reasoning" open><summary>Reasoning</summary></details>
      <form id="composer-form"><textarea data-id="prompt"></textarea>
        <button data-testid="stop-button" aria-label="Stop streaming">Stop</button>
        <button aria-disabled="false" data-testid="send-button">Send</button></form>`;
    const { window, run } = loadExtension(body, "https://chatgpt.com/?temporary-chat=true");
    useVirtualClock(window);
    const sent = [];
    window.chrome.runtime.sendMessage = async (message) => { sent.push(message); };
    let submitEvents = 0;
    window.document.querySelector("#composer-form").addEventListener("submit", (event) => {
      submitEvents += 1;
      event.preventDefault();
      window.document.querySelector("textarea[data-id='prompt']").value = "";
    });

    await run(`handlePrompt({ id: "req-stale-signals", prompt: "recherche", conversation: { id: "conv-stale", mode: "fresh" } })`);

    const error = sent.find((message) => message.type === "error");
    assert.equal(submitEvents, 1, "un signal DOM périmé ne doit jamais provoquer un second envoi");
    assert.equal(error?.code, "bridge_ui_timeout");
    assert.equal(error?.phase, "generation");
    assert.equal(error?.submission_state, "post_submission");
    assert.equal(error?.diagnostics?.assistant_turns_before, 1);
    assert.equal(error?.diagnostics?.assistant_turns_after, 1);
    assert.equal(error?.diagnostics?.stop_visible, true);
    assert.equal(error?.diagnostics?.reasoning_visible, true);
    assert.equal(error?.diagnostics?.streaming_generation_signal_visible, true);
  }

  // 10g. `generationSignalTransition` distingue les six cas observables. Une
  // persistance stricte n'est jamais de l'activité.
  {
    const { window, run } = loadExtension(
      `<div id="host"><div class="result-streaming" id="s1"></div></div>`,
    );
    const host = window.document.querySelector("#host");
    const capture = (name) =>
      run(`globalThis.${name} = currentSubmissionGenerationSignals(); null`);

    // signal déjà présent, strictement inchangé -> aucune transition
    capture("__a");
    capture("__b");
    assert.equal(run(`generationSignalTransition(__a, __b)`), null);

    // changement de signature/state sur le même élément
    window.document
      .querySelector("#s1")
      .setAttribute("class", "result-streaming busy");
    capture("__c");
    assert.equal(run(`generationSignalTransition(__b, __c)`), "changed");

    // nouvel élément apparu
    host.insertAdjacentHTML(
      "beforeend",
      `<button data-testid="stop-button" aria-label="Stop streaming"></button>`,
    );
    capture("__d");
    assert.equal(run(`generationSignalTransition(__c, __d)`), "appeared");

    // aucune mutation entre deux polls -> toujours aucune activité
    capture("__e");
    assert.equal(run(`generationSignalTransition(__d, __e)`), null);

    // disparition
    window.document.querySelector("#s1").remove();
    capture("__f");
    assert.equal(run(`generationSignalTransition(__e, __f)`), "disappeared");

    // plus aucun signal, deux fois de suite -> aucune activité
    window.document.querySelector("[data-testid='stop-button']").remove();
    capture("__g");
    capture("__h");
    assert.equal(run(`generationSignalTransition(__g, __h)`), null);
  }

  // 10h. Un signal de génération qui apparaît APRÈS Send puis reste
  // parfaitement figé ne doit pas rafraîchir l'activité à chaque poll :
  // l'attente doit finir en bridge_ui_timeout borné.
  {
    const body = `<form id="composer-form"><textarea data-id="prompt"></textarea>
      <button aria-disabled="false" data-testid="send-button">Send</button></form>`;
    const { window, run } = loadExtension(body, "https://chatgpt.com/?temporary-chat=true");
    const sent = [];
    window.chrome.runtime.sendMessage = async (message) => { sent.push(message); };
    let clock = 0;
    let polls = 0;
    window.Date.now = () => clock;
    window.setTimeout = (fn, ms) => {
      clock += ms || 0;
      polls += 1;
      if (polls > 20_000) {
        throw new Error(
          "le watchdog n'a jamais conclu : un signal figé maintient l'attente en vie",
        );
      }
      queueMicrotask(fn);
      return 0;
    };
    let submitEvents = 0;
    let sendClicks = 0;
    window.document.querySelector("button[data-testid='send-button']").addEventListener("click", () => { sendClicks += 1; });
    window.document.querySelector("#composer-form").addEventListener("submit", (event) => {
      submitEvents += 1;
      event.preventDefault();
      window.document.querySelector("textarea[data-id='prompt']").value = "";
      // Apparaît une fois, puis plus jamais aucune mutation.
      window.document.body.insertAdjacentHTML(
        "beforeend",
        `<div class="result-streaming" data-frozen="true"></div>`,
      );
    });

    await run(`handlePrompt({ id: "req-frozen-signal", prompt: "recherche figée", conversation: { id: "conv-frozen", mode: "fresh" } })`);

    const error = sent.find((message) => message.type === "error");
    assert.equal(error?.code, "bridge_ui_timeout");
    assert.equal(error?.phase, "generation");
    assert.equal(error?.submission_state, "post_submission");
    assert.equal(error?.diagnostics?.streaming_generation_signal_visible, true);
    assert.equal(error?.diagnostics?.assistant_turns_after, 0);
    assert.equal(submitEvents, 1, "aucune resoumission après un stall figé");
    assert.equal(sendClicks, 0);
    assert.ok(
      clock >= 300_000,
      `le stall ne doit pas être prématuré (clock=${clock})`,
    );
    assert.ok(
      clock < 400_000,
      `le stall doit rester borné par FIRST_ASSISTANT_ACTIVITY_STALL_MS (clock=${clock})`,
    );
    assert.equal(
      JSON.stringify(sent).includes("recherche figée"),
      false,
      "ni heartbeat ni diagnostics ne doivent contenir le prompt",
    );
  }

  // 10i. Une vraie activité prolongée (signature qui change réellement) garde
  // le watchdog vivant bien au-delà de FIRST_ASSISTANT_ACTIVITY_STALL_MS, puis le tour
  // assistant arrive et la finalisation se poursuit normalement.
  {
    const body = `<form id="composer-form"><textarea data-id="prompt"></textarea>
      <button aria-disabled="false" data-testid="send-button">Send</button></form>`;
    const { window, run } = loadExtension(body, "https://chatgpt.com/?temporary-chat=true");
    const sent = [];
    window.chrome.runtime.sendMessage = async (message) => { sent.push(message); };
    let clock = 0;
    let polls = 0;
    let assistantAdded = false;
    window.Date.now = () => clock;
    window.setTimeout = (fn, ms) => {
      clock += ms || 0;
      polls += 1;
      if (polls > 40_000) throw new Error("boucle non bornée");
      const signal = window.document.querySelector(".result-streaming");
      if (signal && clock < 600_000) {
        signal.setAttribute("class", `result-streaming step-${polls}`);
      }
      if (!assistantAdded && clock >= 600_000) {
        assistantAdded = true;
        signal?.remove();
        window.document.body.insertAdjacentHTML(
          "beforeend",
          `<article data-testid="conversation-turn-slow">
            <div data-message-author-role="assistant" data-message-id="msg-slow">
              <div class="markdown"><p>réponse après recherche approfondie</p></div>
            </div>${copyButton}
          </article>`,
        );
      }
      queueMicrotask(fn);
      return 0;
    };
    let submitEvents = 0;
    window.document.querySelector("#composer-form").addEventListener("submit", (event) => {
      submitEvents += 1;
      event.preventDefault();
      window.document.querySelector("textarea[data-id='prompt']").value = "";
      window.document.body.insertAdjacentHTML(
        "beforeend",
        `<div class="result-streaming"></div>`,
      );
    });

    await run(`handlePrompt({ id: "req-long-activity", prompt: "recherche approfondie", conversation: { id: "conv-long-activity", mode: "fresh" } })`);

    assert.ok(clock > 600_000, "l'attente doit dépasser largement 30 s et 300 s");
    assert.equal(sent.filter((message) => message.type === "error").length, 0);
    assert.equal(
      sent.find((message) => message.type === "done")?.text,
      "réponse après recherche approfondie",
    );
    assert.equal(submitEvents, 1, "exactement une soumission");
    const heartbeats = sent.filter((message) => message.type === "heartbeat");
    assert.ok(heartbeats.length >= 5, "le heartbeat doit continuer pendant l'attente");
    assert.equal(
      JSON.stringify(heartbeats).includes("recherche approfondie"),
      false,
      "aucun contenu de prompt dans les heartbeats",
    );
    assert.equal(
      JSON.stringify(heartbeats).includes("réponse après recherche approfondie"),
      false,
      "aucun contenu de réponse dans les heartbeats",
    );
  }

  // 11. CONTINUE sur une navigation /c/... : refus avant toute saisie/envoi.
  {
    const body = `${temporaryComposer}<button data-testid="send-button">Send</button>
      <article data-testid="conversation-turn-1"><div data-message-author-role="assistant" data-message-id="msg-A1"><div class="markdown">ancien</div></div></article>`;
    const { window, run } = loadExtension(body, "https://chatgpt.com/c/abc123");
    useVirtualClock(window);
    const sent = [];
    window.chrome.runtime.sendMessage = async (message) => { sent.push(message); };
    let sendClicks = 0;
    window.document.querySelector("button[data-testid='send-button']").addEventListener("click", () => { sendClicks += 1; });
    await run(`handlePrompt({ id: "req-continue", prompt: "suite", conversation: { id: "conv-A", mode: "continue", expected_turn_id: "msg-A1" } })`);
    assert.equal(sendClicks, 0, "une navigation /c/... interdit tout envoi");
    assert.equal(sent.find((message) => message.type === "error")?.code, "conversation_unavailable");
  }

  // 5. CONTINUE : le tour externe attendu existe -> trouvé par identité stable.
  {
    const { run } = loadExtension(page({ actions: true }));
    const found = run(
      `findAssistantTurnByExternalId("m3") !== null`,
    );
    assert.equal(found, true, "le tour attendu doit être retrouvé par son identifiant stable");
    assert.equal(run(`turnExternalId(document.querySelector("[data-testid='conversation-turn-3'] [data-message-author-role='assistant']"))`), "m3");
    assert.equal(run(`turnLocator(document.querySelector("[data-testid='conversation-turn-3'] [data-message-author-role='assistant']"))`), "conversation-turn-3");
  }

  // 6. CONTINUE : le tour externe attendu est absent -> aucune correspondance,
  //    jamais un repli sur le dernier tour visible ou un index.
  {
    const { run } = loadExtension(page({ actions: true }));
    const found = run(
      `findAssistantTurnByExternalId("conversation-turn-does-not-exist")`,
    );
    assert.equal(found, null, "aucun tour ne doit correspondre à un identifiant inconnu");
  }

  // A DOM locator without data-message-id is not a continuation identity.
  {
    const { run } = loadExtension(`
      <article data-testid="conversation-turn-9">
        <div data-message-author-role="assistant"><div class="markdown">réponse</div></div>
      </article>`);
    assert.equal(run(`turnExternalId(document.querySelector("[data-message-author-role='assistant']"))`), null);
    assert.equal(run(`findAssistantTurnByExternalId("conversation-turn-9")`), null);
  }

  // Recovery stateless is a read-only exact-target capture: only an explicitly
  // final answer with a stable external message id is returned, and no Send or
  // requestSubmit path is touched.
  {
    const body = `<form id="composer-form"><textarea data-id="prompt">draft intact</textarea>
      <button aria-disabled="false" data-testid="send-button">Send</button></form>
      <article data-testid="conversation-turn-9">
        <div data-message-author-role="assistant" data-message-id="stable-final">
          <div class="markdown"><p>réponse finale récupérable</p></div>
        </div>${copyButton}
      </article>`;
    const { window, run } = loadExtension(body);
    let clicks = 0;
    let submits = 0;
    window.document.querySelector("button[data-testid='send-button']").addEventListener("click", () => {
      clicks += 1;
    });
    window.document.querySelector("#composer-form").addEventListener("submit", (event) => {
      submits += 1;
      event.preventDefault();
    });
    const preview = await run(`captureLaterResponse(${JSON.stringify({
      id: "recovery-1",
      bridge_run_id: "run-1",
      browser_target: { kind: "temporary_chat_run", id: "target-1" },
    })})`);
    assert.equal(preview.target_id, "target-1");
    assert.equal(preview.bridge_run_id, "run-1");
    assert.equal(preview.turn_id, "stable-final");
    assert.equal(preview.text, "réponse finale récupérable");
    assert.equal(clicks, 0);
    assert.equal(submits, 0);
    assert.equal(window.document.querySelector("textarea[data-id='prompt']").value, "draft intact");
  }

  // A local container/testid without data-message-id is never accepted as a
  // recovery identity.
  {
    const { run } = loadExtension(`
      <article data-testid="conversation-turn-10">
        <div data-message-author-role="assistant"><div class="markdown"><p>final</p></div></div>
        ${copyButton}
      </article>`);
    const preview = await run(`captureLaterResponse(${JSON.stringify({
      id: "recovery-no-id",
      bridge_run_id: "run-no-id",
      browser_target: { kind: "temporary_chat_run", id: "target-no-id" },
    })})`);
    assert.equal(preview.error, "aucune réponse finale postérieure au tour initial");
  }

  // Upgrading a `captured_incomplete` reads the SAME external assistant turn:
  // another turn that happens to be final is never substituted for it.
  {
    const { run } = loadExtension(`
      <article data-testid="conversation-turn-11">
        <div data-message-author-role="assistant" data-message-id="assistant-43">
          <div class="markdown"><p>réponse d'un autre tour</p></div>
        </div>${copyButton}
      </article>`);
    const preview = await run(`captureLaterResponse(${JSON.stringify({
      id: "recovery-other-turn",
      bridge_run_id: "run-other-turn",
      browser_target: { kind: "temporary_chat_run", id: "target-other-turn" },
      assistant_turn_id: "assistant-42",
    })})`);
    assert.equal(preview.error, "aucune réponse finale postérieure au tour initial");
    assert.equal(preview.text, undefined);
  }

  // The expected turn is found but still streaming: no `verified_final`
  // capture, so the durable incomplete candidate stays the only answer.
  {
    const { run } = loadExtension(`
      <article data-testid="conversation-turn-12">
        <div data-message-author-role="assistant" data-message-id="assistant-42">
          <div class="markdown"><p>réponse encore en cours</p></div>
        </div>
        <div class="result-streaming"></div>
      </article>`);
    const preview = await run(`captureLaterResponse(${JSON.stringify({
      id: "recovery-streaming",
      bridge_run_id: "run-streaming",
      browser_target: { kind: "temporary_chat_run", id: "target-streaming" },
      assistant_turn_id: "assistant-42",
    })})`);
    assert.equal(preview.error, "aucune réponse finale postérieure au tour initial");
  }

  // The same turn's text changes between the two read-only reads: the capture
  // is discarded rather than returned as a final answer.
  {
    const { window, run } = loadExtension(`
      <article data-testid="conversation-turn-13">
        <div data-message-author-role="assistant" data-message-id="assistant-42">
          <div class="markdown"><p>texte initial</p></div>
        </div>${copyButton}
      </article>`);
    const paragraph = window.document.querySelector(".markdown p");
    // Control: this exact DOM is capturable while the text is stable.
    const stable = await run(`captureLaterResponse(${JSON.stringify({
      id: "recovery-stable",
      bridge_run_id: "run-drift",
      browser_target: { kind: "temporary_chat_run", id: "target-drift" },
      assistant_turn_id: "assistant-42",
    })})`);
    assert.equal(stable.text, "texte initial");
    assert.equal(stable.metadata.capture_confidence, "verified_final");
    // `findAssistantTurnByExternalId` re-resolves the turn between the two
    // reads; mutate the DOM exactly there to simulate React still writing.
    const original = window.eval("findAssistantTurnByExternalId");
    window.eval(
      `findAssistantTurnByExternalId = function (id) { globalThis.__drift(); return (${original.toString()})(id); }`,
    );
    window.__drift = () => {
      paragraph.textContent = "texte réécrit";
    };
    const preview = await run(`captureLaterResponse(${JSON.stringify({
      id: "recovery-drift",
      bridge_run_id: "run-drift",
      browser_target: { kind: "temporary_chat_run", id: "target-drift" },
      assistant_turn_id: "assistant-42",
    })})`);
    assert.equal(preview.error, "aucune réponse finale postérieure au tour initial");
  }

  // 7. Aucune attente de 15s sur un locator de conversation ne subsiste.
  {
    const source = fs.readFileSync(path.join(EXTENSION, "content.js"), "utf8");
    assert.equal(source.includes("toggle.click()"), false, "le bridge ne doit jamais cliquer le toggle Temporary");
    assert.equal(source.includes("temporaryChatCheckedIcon"), false, "l'ancien signal SVG ne doit plus exister");
    assert.equal(source.includes("SELECTORS.newChat"), false, "New Chat ne doit plus faire partie du chemin stateless");
    assert.ok(
      !source.includes("locator de conversation non attribué"),
      "l'ancienne attente de locator de conversation ne doit plus exister",
    );
    assert.ok(
      !source.includes("verifiedLocator"),
      "verifiedLocator ne doit plus exister en tant que concept d'identité",
    );
  }

  console.log("temporary chat + continuation identity contract: ok");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

// --------------------------------------------------------------------------- //
// Cycle de vie React : le premier nœud assistant observé n'est PAS celui qui
// porte l'identité finale. `handlePrompt` doit lire l'identité sur le tour
// courant re-résolu par streamAnswer, jamais sur la référence détachée.
// --------------------------------------------------------------------------- //
/**
 * Rejoue le remplacement observé en production : l'UI insère d'abord un tour
 * assistant portant `request-placeholder-request-WEB:<uuid>-0`, puis React
 * remplace ce nœud, dans le MÊME conteneur `conversation-turn`, par le vrai
 * message assistant.
 */
function replacementPage() {
  return `<form id="composer-form"><textarea data-id="prompt"></textarea>
      <button aria-disabled="false" data-testid="send-button">Send</button></form>`;
}

const PLACEHOLDER_ID =
  "request-placeholder-request-WEB:1f4c0a2e-1d47-4a5b-9d0a-2f1b3c4d5e6f-0";

(async () => {
  // A/B/C/D : placeholder -> remplacement par un id stable -> texte final.
  {
    const { window, run } = loadExtension(
      replacementPage(),
      "https://chatgpt.com/?temporary-chat=true",
    );
    const sent = [];
    window.chrome.runtime.sendMessage = async (message) => { sent.push(message); };
    const doc = window.document;
    let clock = 0;
    let replacedAt = null;
    window.Date.now = () => clock;
    window.setTimeout = (fn, ms) => {
      clock += ms || 0;
      // C. React remplace le nœud assistant à l'intérieur du même conteneur.
      if (replacedAt !== null && clock >= replacedAt) {
        replacedAt = null;
        const container = doc.querySelector("[data-testid='conversation-turn-1']");
        container.querySelector("[data-message-author-role='assistant']").remove();
        container.insertAdjacentHTML(
          "afterbegin",
          `<div data-message-author-role="assistant" data-message-id="stable-assistant-42">
             <div class="markdown"><p>réponse finale stable</p></div>
           </div>`,
        );
        container.insertAdjacentHTML("beforeend", copyButton);
      }
      queueMicrotask(fn);
      return 0;
    };
    let submitEvents = 0;
    doc.querySelector("#composer-form").addEventListener("submit", (event) => {
      submitEvents += 1;
      event.preventDefault();
      doc.querySelector("textarea[data-id='prompt']").value = "";
      // A. Premier tour assistant : uniquement un placeholder d'interface.
      doc.body.insertAdjacentHTML(
        "beforeend",
        `<article data-testid="conversation-turn-1">
           <div data-message-author-role="assistant" data-message-id="${PLACEHOLDER_ID}">
             <div class="markdown"><p>réponse partielle</p></div>
           </div>
         </article>`,
      );
      replacedAt = clock + 2_000;
    });

    // B/D.
    await run(`handlePrompt({ id: "req-replaced", prompt: "bonjour", conversation: { id: "conv-replaced", mode: "fresh" } })`);

    const done = sent.find((message) => message.type === "done");
    assert.equal(submitEvents, 1, "un remplacement DOM ne doit jamais provoquer un second envoi");
    assert.equal(
      sent.some((message) => message.type === "error"),
      false,
      "aucun conversation_unavailable ne doit être émis quand l'id stable existe",
    );
    assert.ok(done, "le tour remplacé doit aboutir à un done");
    assert.equal(done.text, "réponse finale stable");
    assert.equal(
      done.conversation?.turn_id,
      "stable-assistant-42",
      "l'identité doit venir du nœud courant, pas du placeholder détaché",
    );
    assert.equal(done.metadata?.initial_turn_id, "stable-assistant-42");
    assert.equal(done.metadata?.content_script_version, "32");
  }

  // Même remplacement, mais l'UI reste bloquée « en streaming » : le candidat
  // part en incomplete avec l'identité stable du nœud courant.
  {
    const { window, run } = loadExtension(
      replacementPage(),
      "https://chatgpt.com/?temporary-chat=true",
    );
    const sent = [];
    window.chrome.runtime.sendMessage = async (message) => { sent.push(message); };
    const doc = window.document;
    let clock = 0;
    let replacedAt = null;
    window.Date.now = () => clock;
    window.setTimeout = (fn, ms) => {
      clock += ms || 0;
      if (replacedAt !== null && clock >= replacedAt) {
        replacedAt = null;
        const container = doc.querySelector("[data-testid='conversation-turn-1']");
        container.querySelector("[data-message-author-role='assistant']").remove();
        container.insertAdjacentHTML(
          "afterbegin",
          `<div data-message-author-role="assistant" data-message-id="stable-assistant-42">
             <div class="markdown"><p>réponse finale stable</p></div>
             <div class="result-streaming"></div>
           </div>`,
        );
      }
      queueMicrotask(fn);
      return 0;
    };
    let submitEvents = 0;
    doc.querySelector("#composer-form").addEventListener("submit", (event) => {
      submitEvents += 1;
      event.preventDefault();
      doc.querySelector("textarea[data-id='prompt']").value = "";
      doc.body.insertAdjacentHTML(
        "beforeend",
        `<article data-testid="conversation-turn-1">
           <div data-message-author-role="assistant" data-message-id="${PLACEHOLDER_ID}">
             <div class="markdown"><p>réponse partielle</p></div>
             <div class="result-streaming"></div>
           </div>
         </article>`,
      );
      replacedAt = clock + 2_000;
    });

    await run(`handlePrompt({ id: "req-replaced-stalled", prompt: "bonjour", conversation: { id: "conv-replaced-stalled", mode: "fresh" } })`);

    const incomplete = sent.find((message) => message.type === "incomplete");
    assert.equal(submitEvents, 1, "un stall ne doit jamais resoumettre");
    assert.ok(incomplete, "un signal actif figé doit produire un incomplete");
    assert.equal(incomplete.reason, "active_signal_stalled");
    assert.equal(incomplete.text, "réponse finale stable");
    assert.equal(
      incomplete.metadata?.initial_turn_id,
      "stable-assistant-42",
      "le candidat durable doit porter l'identité du nœud courant",
    );
    assert.equal(incomplete.conversation?.turn_id, "stable-assistant-42");
    assert.equal(sent.some((message) => message.type === "done"), false);
  }

  // Le placeholder ne devient jamais stable : le texte final n'est pas détruit,
  // il devient un needs_review typé sans identité de continuation fabriquée.
  {
    const { window, run } = loadExtension(
      replacementPage(),
      "https://chatgpt.com/?temporary-chat=true",
    );
    const sent = [];
    window.chrome.runtime.sendMessage = async (message) => { sent.push(message); };
    const doc = window.document;
    useVirtualClock(window);
    let submitEvents = 0;
    doc.querySelector("#composer-form").addEventListener("submit", (event) => {
      submitEvents += 1;
      event.preventDefault();
      doc.querySelector("textarea[data-id='prompt']").value = "";
      doc.body.insertAdjacentHTML(
        "beforeend",
        `<article data-testid="conversation-turn-1">
           <div data-message-author-role="assistant" data-message-id="${PLACEHOLDER_ID}">
             <div class="markdown"><p>réponse finale sans identité</p></div>
           </div>${copyButton}
         </article>`,
      );
    });

    await run(`handlePrompt({ id: "req-placeholder-forever", prompt: "bonjour", conversation: { id: "conv-placeholder", mode: "fresh" } })`);

    const incomplete = sent.find((message) => message.type === "incomplete");
    assert.equal(submitEvents, 1);
    assert.equal(
      sent.some((message) => message.type === "done"),
      false,
      "sans identité stable, aucun done ne doit promettre une conversation poursuivable",
    );
    assert.equal(
      sent.some((message) => message.type === "error"),
      false,
      "le texte final ne doit pas être détruit par une erreur sans texte",
    );
    assert.ok(incomplete, "le texte final doit survivre en incomplete typé");
    assert.equal(incomplete.reason, "external_turn_identity_unavailable");
    assert.equal(incomplete.text, "réponse finale sans identité");
    assert.equal(incomplete.metadata?.initial_turn_id, null);
    assert.equal(incomplete.conversation?.turn_id, null);
  }

  console.log("react turn replacement identity contract: ok");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

// --------------------------------------------------------------------------- //
// `.streaming-animation` = génération encore active
//
// Incident de production (deux runs indépendants) : un tour assistant affichait
// ~30 caractères intermédiaires, `.streaming-animation` restait visible, le
// texte n'a pas bougé pendant 300 003 ms puis 352 002 ms, et le content script
// concluait `active_signal_stalled`. ChatGPT travaillait pourtant toujours : le
// MÊME tour a ensuite produit la vraie réponse finale, l'animation a disparu et
// la barre d'actions est apparue. « Le texte n'a pas bougé » n'est donc pas une
// preuve d'échec pour ce détecteur-là.
// --------------------------------------------------------------------------- //

const RECHERCHE_INTERMEDIAIRE = "Recherche en cours sur la menace";
const RECHERCHE_FINALE_CORPS = "Analyse détaillée du rapport final. ".repeat(200).trim();
const RECHERCHE_FINALE = `# REFERENCES\n\n${RECHERCHE_FINALE_CORPS}`;

(async () => {
  // --- Timeline de production : >300 s figés, puis la vraie réponse finale --- //
  {
    const body = `<form id="composer-form"><textarea data-id="prompt"></textarea>
      <button aria-disabled="false" data-testid="send-button">Send</button></form>`;
    const { window, run } = loadExtension(
      body,
      "https://chatgpt.com/?temporary-chat=true",
    );
    const doc = window.document;
    const sent = [];
    window.chrome.runtime.sendMessage = async (message) => { sent.push(message); };

    let clock = 0;
    let polls = 0;
    let finalisee = false;
    window.Date.now = () => clock;
    window.setTimeout = (fn, ms) => {
      clock += ms || 0;
      polls += 1;
      if (polls > 40_000) throw new Error("boucle non bornée");
      // 10/11/12/13. Bien au-delà de l'ancienne borne de 300 s, le MÊME tour
      // remplace le texte intermédiaire par la réponse complète, retire
      // `.streaming-animation` et expose la barre d'actions.
      if (!finalisee && clock >= 400_000) {
        finalisee = true;
        const article = doc.querySelector("[data-testid='conversation-turn-research']");
        article.querySelector(".streaming-animation").remove();
        article.querySelector(".markdown").innerHTML =
          `<h1>REFERENCES</h1><p>${RECHERCHE_FINALE_CORPS}</p>`;
        article.insertAdjacentHTML("beforeend", copyButton);
      }
      queueMicrotask(fn);
      return 0;
    };

    // 1. Une seule soumission, jamais rejouée.
    let submitEvents = 0;
    let sendClicks = 0;
    doc.querySelector("button[data-testid='send-button']").addEventListener(
      "click",
      () => { sendClicks += 1; },
    );
    doc.querySelector("#composer-form").addEventListener("submit", (event) => {
      submitEvents += 1;
      event.preventDefault();
      doc.querySelector("textarea[data-id='prompt']").value = "";
      // 2/3/4/5. Tour assistant stable, identité externe stable, sortie
      // intermédiaire d'environ 30 caractères, `.streaming-animation` visible
      // dans le tour surveillé.
      doc.body.insertAdjacentHTML(
        "beforeend",
        `<article data-testid="conversation-turn-research">
           <div data-message-author-role="assistant" data-message-id="turn-research-1">
             <div class="markdown"><p>${RECHERCHE_INTERMEDIAIRE}</p></div>
             <div class="streaming-animation"></div>
           </div>
         </article>`,
      );
    });

    await run(`handlePrompt({ id: "req-long-research", prompt: "recherche approfondie", conversation: { id: "conv-long-research", mode: "fresh" } })`);

    const heartbeats = sent.filter((message) => message.type === "heartbeat");
    const done = sent.find((message) => message.type === "done");

    // 6/7. Le texte n'a pas bougé pendant plus de 300 s — l'ancienne frontière
    // de régression est réellement franchie — sans jamais devenir un stall.
    const seuil = run("WATCHED_TURN_ACTIVE_SIGNAL_STALL_MS");
    assert.ok(
      heartbeats.some(
        (message) =>
          message.progress?.completion_signal === "streaming" &&
          message.progress?.stable_for_ms > seuil,
      ),
      `la stabilité observée doit dépasser ${seuil} ms sans conclure`,
    );
    assert.equal(
      sent.some(
        (message) =>
          message.type === "incomplete" ||
          message.reason === "active_signal_stalled",
      ),
      false,
      "`.streaming-animation` active interdit active_signal_stalled",
    );
    assert.equal(sent.filter((message) => message.type === "error").length, 0);

    // 8/9. Aucun `done` prématuré, et des heartbeats sans contenu pendant l'attente.
    assert.ok(heartbeats.length >= 5, "les heartbeats doivent continuer");
    assert.equal(
      heartbeats.some((message) => JSON.stringify(message).includes(RECHERCHE_INTERMEDIAIRE)),
      false,
      "un heartbeat ne transporte jamais de contenu de réponse",
    );
    assert.equal(
      heartbeats.some((message) => JSON.stringify(message).includes("recherche approfondie")),
      false,
      "un heartbeat ne transporte jamais le prompt",
    );

    // 14/15/16. `done` final autoritaire, texte complet, identité externe attendue.
    assert.ok(done, "le tour terminé doit produire un done");
    assert.equal(done.text, RECHERCHE_FINALE);
    assert.equal(done.metadata?.completion_signal, "assistant_actions");
    assert.equal(done.metadata?.initial_turn_id, "turn-research-1");
    assert.equal(done.conversation?.turn_id, "turn-research-1");
    assert.ok(clock >= 400_000, `la génération doit dépasser 400 s (clock=${clock})`);

    // 17. Exactement une soumission de prompt, aucun second envoi.
    assert.equal(submitEvents, 1, "exactement une soumission de prompt");
    assert.equal(sendClicks, 0, "aucun clic d'envoi supplémentaire");
  }

  // --- Cas pathologique : `.streaming-animation` sans fin -------------------- //
  // Le content script n'invente jamais de succès et ne resoumet jamais ; c'est
  // le `bridge_total_timeout` du serveur qui borne la durée (cf.
  // tests/test_generation_timeouts.py). Ici, l'abandon du job simule la
  // fermeture du canal HTTP par cette borne serveur.
  {
    const body = `
      <main>
        <article data-testid="conversation-turn-endless">
          <div data-message-author-role="assistant" data-message-id="turn-endless-1">
            <div class="markdown"><p>${RECHERCHE_INTERMEDIAIRE}</p></div>
            <div class="streaming-animation"></div>
          </div>
        </article>
      </main>
      <form id="composer-form">
        <div id="prompt-textarea" contenteditable="true"></div>
        <button data-testid="send-button">Envoyer</button>
      </form>`;
    const { window, run } = loadExtension(body);
    const doc = window.document;
    const sent = [];
    window.chrome.runtime.sendMessage = async (message) => { sent.push(message); };

    let submitEvents = 0;
    let sendClicks = 0;
    doc.querySelector("button[data-testid='send-button']").addEventListener(
      "click",
      () => { sendClicks += 1; },
    );
    doc.querySelector("#composer-form").addEventListener("submit", (event) => {
      submitEvents += 1;
      event.preventDefault();
    });

    let clock = 1_000_000;
    let polls = 0;
    window.testEndlessJob = { id: "endless", aborted: false };
    window.Date.now = () => clock;
    window.setTimeout = (fn, ms) => {
      clock += ms || 0;
      polls += 1;
      if (polls > 60_000) throw new Error("boucle non bornée");
      // Le texte ne mute jamais et l'animation ne disparaît jamais. Au-delà de
      // six fois l'ancienne borne, le serveur aurait coupé : on abandonne le job.
      if (clock >= 1_000_000 + 1_800_000) window.testEndlessJob.aborted = true;
      queueMicrotask(fn);
      return 0;
    };

    const result = await run(
      `streamAnswer(testEndlessJob, "conversation-turn-endless", 0)`,
    );

    assert.ok(
      clock - 1_000_000 >= 1_800_000,
      `l'observation doit se poursuivre bien au-delà de 300 s (écoulé=${clock - 1_000_000})`,
    );
    assert.notEqual(
      result.incomplete_reason,
      "active_signal_stalled",
      "la seule stabilité du texte ne doit jamais produire active_signal_stalled",
    );
    assert.notEqual(
      result.completion_signal,
      "assistant_actions",
      "aucune finalisation ne doit être inventée",
    );
    assert.equal(
      sent.some((message) => ["done", "incomplete", "error"].includes(message.type)),
      false,
      "aucun succès ni échec fabriqué pendant l'observation",
    );
    const heartbeats = sent.filter((message) => message.type === "heartbeat");
    assert.ok(heartbeats.length >= 5, "les heartbeats doivent continuer indéfiniment");
    assert.ok(
      heartbeats.every(
        (message) =>
          message.progress?.completion_signal === "streaming" &&
          !JSON.stringify(message).includes(RECHERCHE_INTERMEDIAIRE),
      ),
      "les heartbeats restent des signaux de liveness sans contenu",
    );
    assert.equal(submitEvents, 0, "aucune seconde soumission");
    assert.equal(sendClicks, 0, "aucun second envoi");
  }

  // --- La barre d'actions prime toujours sur `.streaming-animation` ---------- //
  {
    const { state } = loadExtension(`
      <main>
        <article data-testid="conversation-turn-3">
          <div data-message-author-role="assistant" data-message-id="m3">
            <div class="markdown"><p>réponse finale</p></div>
            <div class="streaming-animation"></div>
          </div>
          ${copyButton}
        </article>
      </main>`);
    assert.deepEqual(
      state(`completionState(${WATCHED})`),
      { finished: true, signal: "assistant_actions", confidence: "high" },
      "assistant_actions reste le signal final le plus fort",
    );
  }

  // --- Le désarmement est local au tour surveillé ---------------------------- //
  // Une `.streaming-animation` laissée par un ANCIEN tour ne doit ni maintenir
  // le tour surveillé en vie, ni désarmer son garde-fou : sur ce tour-ci, seul
  // `.result-streaming` est actif, et le stall borné doit rester en vigueur.
  {
    const body = `
      <main>
        <article data-testid="conversation-turn-1">
          <div data-message-author-role="assistant" data-message-id="m1">
            <div class="markdown"><p>ancienne réponse</p></div>
            <div class="streaming-animation"></div>
          </div>
          ${copyButton}
        </article>
        <article data-testid="conversation-turn-3">
          <div data-message-author-role="assistant" data-message-id="m3">
            <div class="markdown"><p>réponse finale</p></div>
            <div class="result-streaming"></div>
          </div>
        </article>
      </main>
      <form>
        <div id="prompt-textarea" contenteditable="true"></div>
        <button data-testid="send-button">Envoyer</button>
      </form>`;
    const { window, run } = loadExtension(body);
    let clock = 1_000_000;
    window.Date.now = () => clock;
    window.setTimeout = (fn, ms) => {
      clock += ms || 0;
      queueMicrotask(fn);
      return 0;
    };
    window.testScopedJob = { id: "scoped", aborted: false };
    const result = await run(
      `streamAnswer(testScopedJob, "conversation-turn-3", 1)`,
    );

    assert.equal(
      result.incomplete_reason,
      "active_signal_stalled",
      "`.result-streaming` garde sa sémantique bornée",
    );
    assert.deepEqual(
      JSON.parse(JSON.stringify(result.streaming_signal_sources)).map((s) => s.source),
      [".result-streaming"],
      "l'animation d'un ancien tour n'entre jamais dans le périmètre surveillé",
    );
  }

  // --- `[data-is-streaming='true']` : sémantique inchangée, faute de preuve --- //
  {
    const body = `
      <main>
        <article data-testid="conversation-turn-3">
          <div data-message-author-role="assistant" data-message-id="m3">
            <div class="markdown"><p>réponse finale</p></div>
            <div data-is-streaming="true"></div>
          </div>
        </article>
      </main>
      <form>
        <div id="prompt-textarea" contenteditable="true"></div>
        <button data-testid="send-button">Envoyer</button>
      </form>`;
    const { window, run } = loadExtension(body);
    let clock = 1_000_000;
    window.Date.now = () => clock;
    window.setTimeout = (fn, ms) => {
      clock += ms || 0;
      queueMicrotask(fn);
      return 0;
    };
    window.testAttrJob = { id: "attr", aborted: false };
    const result = await run(`streamAnswer(testAttrJob, "conversation-turn-3", 0)`);

    assert.equal(result.incomplete_reason, "active_signal_stalled");
    assert.equal(result.text, "réponse finale");
  }

  console.log("streaming-animation long research contract: ok");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

// --------------------------------------------------------------------------- //
// Injection du prompt : un seul paste synthétique, jamais de commande
// d'édition, jamais de lecture répétée du composer, et bascule en pièce
// jointe au-delà de 200 000 octets UTF-8.
// --------------------------------------------------------------------------- //

const INJECTION_PAGE = `
  <form id="composer-form">
    <div id="prompt-textarea" contenteditable="true"></div>
    <input type="file" />
    <button aria-disabled="false" data-testid="send-button">Send</button>
  </form>`;

/** jsdom n'implémente pas `Blob.prototype.text()` : on relit via FileReader. */
function readFileText(window, file) {
  return new Promise((resolve, reject) => {
    const reader = new window.FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

/** Interdit toute commande d'édition : la production ne doit plus en émettre. */
function forbidEditingCommand(window) {
  window.document.execCommand = () => {
    throw new Error("execCommand ne doit jamais être appelé");
  };
}

/**
 * Instrumente un composer contenteditable comme le ferait ProseMirror : le
 * paste est consommé par l'éditeur, qui met lui-même le contenu à jour.
 */
function observeComposer(window) {
  const composer = window.document.querySelector("#prompt-textarea");
  const observed = { pasteCount: 0, inputCount: 0, pastedText: null };
  composer.addEventListener("input", () => {
    observed.inputCount += 1;
  });
  composer.addEventListener("paste", (event) => {
    event.preventDefault();
    observed.pasteCount += 1;
    observed.pastedText = event.clipboardData.getData("text/plain");
    composer.textContent = observed.pastedText;
  });
  return { composer, observed };
}

/**
 * Exécute `handlePrompt` sur une page minimale et rend compte de ce qui a
 * réellement été collé dans le composer et attaché à l'input file.
 */
async function runPromptInjection({ id, prompt, files = null }) {
  const { window, run } = loadExtension(
    INJECTION_PAGE,
    "https://chatgpt.com/?temporary-chat=true",
  );
  useVirtualClock(window);
  forbidEditingCommand(window);
  const { composer, observed } = observeComposer(window);

  const fileInput = window.document.querySelector("input[type=file]");
  // jsdom refuse l'affectation d'un FileList fabriqué : on rend la propriété
  // inscriptible pour observer exactement ce que le bridge dépose.
  Object.defineProperty(fileInput, "files", {
    writable: true,
    configurable: true,
    value: null,
  });
  const attach = { operations: 0, files: [] };
  fileInput.addEventListener("change", () => {
    attach.operations += 1;
    attach.files = [...(fileInput.files || [])];
  });

  window.document
    .querySelector("#composer-form")
    .addEventListener("submit", (event) => event.preventDefault());

  const injected = [];
  window.console.log = (...args) => {
    if (args[0] === "bridge_run_phase" && args[1]?.phase === "prompt_injected") {
      injected.push({ ...args[1] });
    }
  };
  window.console.warn = () => {};
  window.console.error = () => {};

  window.__promptArg = {
    id,
    prompt,
    files,
    conversation: { id: `conv-${id}`, mode: "fresh" },
  };
  await run("handlePrompt(globalThis.__promptArg)");

  return { window, run, composer, observed, attach, injected: injected[0] };
}

(async () => {
  // A + B. Un contenteditable reçoit exactement un `paste` synthétique, aucune
  // commande d'édition, et le bridge n'émet aucun `input` après le collage.
  {
    const { window, run } = loadExtension(
      `<div id="prompt-textarea" contenteditable="true"></div>`,
    );
    forbidEditingCommand(window);
    const { composer, observed } = observeComposer(window);

    const method = await run(
      `typePrompt(document.querySelector("#prompt-textarea"), "bonjour\\nmonde")`,
    );

    assert.equal(method, "synthetic_paste");
    assert.equal(composer.textContent, "bonjour\nmonde");
    assert.equal(observed.pastedText, "bonjour\nmonde");
    assert.equal(observed.pasteCount, 1, "un seul ClipboardEvent('paste')");
    assert.equal(observed.inputCount, 0, "aucun second `input` après le paste");
  }

  // I. Le chemin `<textarea>` reste le setter natif + son `input` normal.
  {
    const { window, run } = loadExtension(`<textarea data-id="prompt"></textarea>`);
    forbidEditingCommand(window);
    const textarea = window.document.querySelector("textarea[data-id='prompt']");
    let inputs = 0;
    textarea.addEventListener("input", () => {
      inputs += 1;
    });
    const method = await run(
      `typePrompt(document.querySelector("textarea[data-id='prompt']"), "bonjour")`,
    );
    assert.equal(method, "native_value");
    assert.equal(textarea.value, "bonjour");
    assert.equal(inputs, 1);
  }

  // D. Le seuil se mesure en octets UTF-8, pas en `text.length`.
  {
    const { run } = loadExtension(`<div id="prompt-textarea" contenteditable="true"></div>`);
    assert.equal(run(`LARGE_PROMPT_FILE_THRESHOLD_BYTES`), 200_000);
    assert.equal(run(`utf8ByteLength("a".repeat(200000))`), 200_000);
    assert.equal(run(`utf8ByteLength("a".repeat(200001))`), 200_001);
    // Deux octets par caractère : 150 000 caractères dépassent le seuil.
    assert.equal(run(`utf8ByteLength("é".repeat(150000))`), 300_000);
    assert.equal(run(`"é".repeat(150000).length`), 150_000);
  }

  // C. Un gros prompt sous le seuil reste un collage, en une seule fois.
  {
    const text = "x".repeat(150_000);
    const { observed, attach, injected, run } = await runPromptInjection({
      id: "req-under-threshold",
      prompt: text,
    });
    assert.equal(run(`utf8ByteLength(globalThis.__promptArg.prompt)`) < 200_000, true);
    assert.equal(injected.prompt_as_file, false);
    assert.equal(injected.prompt_bytes, 150_000);
    assert.equal(injected.injection_method, "synthetic_paste");
    assert.equal(injected.attachment_count, 0);
    assert.equal(observed.pasteCount, 1, "aucun découpage : un seul paste");
    assert.equal(observed.pastedText, text);
    assert.equal(observed.inputCount, 0);
    assert.equal(attach.operations, 0);
  }

  // D-bis. 200 000 octets exactement : encore un collage.
  {
    const { observed, injected } = await runPromptInjection({
      id: "req-exact-threshold",
      prompt: "a".repeat(200_000),
    });
    assert.equal(injected.prompt_bytes, 200_000);
    assert.equal(injected.prompt_as_file, false);
    assert.equal(observed.pasteCount, 1);
  }

  // D-ter. 200 001 octets : bascule en fichier.
  {
    const { injected, attach } = await runPromptInjection({
      id: "req-over-threshold",
      prompt: "a".repeat(200_001),
    });
    assert.equal(injected.prompt_bytes, 200_001);
    assert.equal(injected.prompt_as_file, true);
    assert.equal(attach.files.length, 1);
  }

  // D-quater. Le seuil suit les octets UTF-8 : 150 000 caractères accentués
  // (300 000 octets) partent en fichier bien que `length` soit sous le seuil.
  {
    const prompt = "é".repeat(150_000);
    const { window, injected, attach } = await runPromptInjection({
      id: "req-unicode-threshold",
      prompt,
    });
    assert.equal(injected.prompt_bytes, 300_000);
    assert.equal(injected.prompt_as_file, true);
    assert.equal(attach.files.length, 1);
    assert.equal(attach.files[0].size, 300_000);
    assert.equal(await readFileText(window, attach.files[0]), prompt);
  }

  // E. Au-delà du seuil : le prompt part en fichier `.txt`, intact, et le
  // composer ne reçoit que la consigne de lecture — jamais le prompt.
  {
    const prompt = `PROMPT-DEBUT\n${"z".repeat(210_000)}\nPROMPT-FIN`;
    const { window, observed, attach, injected, run } = await runPromptInjection({
      id: "req/large:prompt",
      prompt,
    });

    assert.equal(injected.prompt_as_file, true);
    assert.equal(injected.injection_method, "synthetic_paste");
    assert.equal(injected.attachment_count, 1);

    assert.equal(attach.operations, 1);
    assert.equal(attach.files.length, 1);
    const file = attach.files[0];
    assert.match(file.name, /^bridge-prompt-.*\.txt$/);
    assert.equal(file.name, "bridge-prompt-req_large_prompt.txt");
    assert.match(file.type, /^text\/plain/);
    assert.equal(file.size, prompt.length, "aucune troncature");
    assert.equal(
      await readFileText(window, file),
      prompt,
      "le fichier contient le prompt exact",
    );

    const expected = run(`largePromptInstruction(${JSON.stringify(file.name)})`);
    assert.equal(observed.pastedText, expected);
    assert.equal(observed.pasteCount, 1);
    assert.equal(observed.inputCount, 0);
    // Le gros prompt ne peut pas être à la fois joint ET collé.
    assert.ok(observed.pastedText.length < 400);
    assert.equal(observed.pastedText.includes("PROMPT-DEBUT"), false);
    assert.equal(observed.pastedText.includes("zzzz"), false);
  }

  // F. Gros prompt + pièces jointes existantes : un seul DataTransfer, deux
  // fichiers, aucune pièce jointe écrasée.
  {
    const prompt = "w".repeat(200_050);
    const { window, attach, injected } = await runPromptInjection({
      id: "req-mixed",
      prompt,
      files: [{ name: "rapport.csv", mime: "text/csv", data: Buffer.from("a,b\n1,2").toString("base64") }],
    });

    assert.equal(injected.prompt_as_file, true);
    assert.equal(injected.attachment_count, 2);
    assert.equal(attach.operations, 1, "une seule opération d'attachement");
    assert.deepEqual(
      attach.files.map((f) => f.name),
      ["rapport.csv", "bridge-prompt-req-mixed.txt"],
    );
    assert.equal(await readFileText(window, attach.files[0]), "a,b\n1,2");
    assert.equal(await readFileText(window, attach.files[1]), prompt);
  }

  // G. Plus aucune lecture d'`innerText` sur le composer.
  {
    const body = `<form>
      <div id="prompt-textarea" contenteditable="true">bonjour</div>
      <button aria-disabled="false" data-testid="send-button">Send</button>
    </form>`;
    const { window, run } = loadExtension(body);
    const composer = window.document.querySelector("#prompt-textarea");
    Object.defineProperty(composer, "innerText", {
      get() {
        throw new Error("innerText ne doit pas être lu");
      },
    });

    const SEL = `document.querySelector("#prompt-textarea"), document.querySelector("button[data-testid='send-button']")`;
    assert.equal(run(`composerHasText(document.querySelector("#prompt-textarea"))`), true);
    const diagnostics = run(`(() => {
      const snapshot = captureSubmissionSnapshot(${SEL});
      const after = captureSubmissionSnapshot(${SEL});
      return submissionDiagnostics(snapshot, "click", after);
    })()`);
    assert.equal(diagnostics.composer_was_non_empty, true);
    assert.equal(diagnostics.composer_still_has_text, true);
    assert.equal(diagnostics.content_script_version, "32");

    // Le snapshot ne transporte plus le texte du composer, seulement un booléen.
    const snapshot = run(`captureSubmissionSnapshot(${SEL})`);
    assert.equal(snapshot.composerHasText, true);
    assert.equal("composerText" in snapshot, false);

    composer.textContent = "   \n  ";
    assert.equal(run(`composerHasText(document.querySelector("#prompt-textarea"))`), false);
  }

  // H. `composer_cleared` reste détecté sans lire le texte du composer.
  {
    const body = `<form id="composer-form">
      <div id="prompt-textarea" contenteditable="true">bonjour</div>
      <button aria-disabled="false" data-testid="send-button">Send</button>
    </form>`;
    const { window, run } = loadExtension(body, "https://chatgpt.com/?temporary-chat=true");
    useVirtualClock(window);
    const composer = window.document.querySelector("#prompt-textarea");
    Object.defineProperty(composer, "innerText", {
      get() {
        throw new Error("innerText ne doit pas être lu");
      },
    });
    window.document
      .querySelector("#composer-form")
      .addEventListener("submit", (event) => {
        event.preventDefault();
        composer.textContent = "";
      });

    const signal = await run(`(async () => {
      const composer = document.querySelector("#prompt-textarea");
      const send = document.querySelector("button[data-testid='send-button']");
      const before = captureSubmissionSnapshot(composer, send);
      triggerComposerSubmission(composer, send);
      return waitForSubmissionConfirmation(composer, send, before, "requestSubmit");
    })()`);
    assert.equal(signal, "composer_cleared");
  }

  console.log("prompt injection contract: ok");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
