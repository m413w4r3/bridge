/**
 * Contrat de localisation de la réponse (ResponseRoot) dans la nouvelle UI
 * ChatGPT : plus aucun `data-message-author-role`, `data-message-id`,
 * `data-turn`, `conversation-turn` ni `<article>`. Le contenu de la réponse est
 * rendu dans un `div` dont une classe COMMENCE par « MarkdownRoot- » (suffixe
 * généré), et les feuilles `inline-markdown` qui s'y trouvent ne sont jamais
 * une réponse à elles seules.
 *
 * L'identité du candidat vient d'un DELTA structurel contre le baseline capturé
 * juste avant le Send — jamais « le dernier MarkdownRoot de la page ». Ce
 * fichier couvre : sélection, ambiguïté (fail closed), dérive de contrat,
 * remplacement React du nœud, diagnostic borné et absence de contenu.
 *
 * jsdom est une dépendance de test de ce dépôt : `npm ci` avant ce test.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");

const EXTENSION = path.join(__dirname, "..", "extension");
const SECRET_RESPONSE = "SUPER_SECRET_RESPONSE_8472";

/** Charge l'extension dans un DOM simulé et rend ses fonctions appelables. */
function loadExtension(body, url = "https://chatgpt.com/?temporary-chat=true") {
  const dom = new JSDOM(`<!doctype html><html><body>${body}</body></html>`, {
    runScripts: "outside-only",
    url,
  });
  const { window } = dom;

  // jsdom ne calcule aucune mise en page : sans ce repli, `isVisibleElement()`
  // renverrait false pour tout et aucun ResponseRoot ne serait jamais retenu.
  window.Element.prototype.getClientRects = function getClientRects() {
    return this.hasAttribute("data-test-offscreen") ? [] : [{}];
  };
  window.CSS = window.CSS || {
    escape: (value) => String(value).replace(/["\\]/g, "\\$&"),
  };
  window.TextEncoder = TextEncoder;

  const messageListeners = [];
  window.chrome = {
    storage: { local: { get: async () => ({}), set: async () => {} } },
    runtime: {
      sendMessage: async () => {},
      onMessage: { addListener: (listener) => messageListeners.push(listener) },
    },
  };

  const context = dom.getInternalVMContext();
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
    globalThis.DataTransfer = DataTransfer;
    globalThis.ClipboardEvent = ClipboardEvent;
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
      { filename: file },
    );
  }
  return {
    window,
    run: (expression) => vm.runInContext(expression, context),
    dispatch: (message) =>
      new Promise((resolve) => {
        for (const listener of messageListeners) listener(message, {}, resolve);
      }),
  };
}

/** Horloge virtuelle : chaque minuterie avance le temps et rend la main. */
function useVirtualClock(window) {
  let clock = 0;
  window.Date.now = () => clock;
  window.setTimeout = (fn, ms) => {
    clock += ms || 0;
    queueMicrotask(fn);
    return 0;
  };
  return () => clock;
}

/** Page moderne : main > transcript + composer ProseMirror sans id historique. */
const MODERN_PAGE = `
  <main id="chat">
    <div id="transcript"></div>
    <form id="composer-form">
      <div
        contenteditable="true"
        aria-multiline="true"
        role="textbox"
        class="ProseMirror"
        data-composer-markdown></div>
      <button type="submit" aria-label="Send">Send</button>
    </form>
  </main>`;

const answerRoot = (content, suffix = "AbCd12") =>
  `<div class="MarkdownRoot-${suffix}">${content}</div>`;

const inlineText = (text, suffix = "X") =>
  `<p><span class="inline-markdown InlineMarkdownIsolate-${suffix}">${text}</span></p>`;

/** Instrumente la page moderne : paste ProseMirror + submit qui rend la réponse. */
function observeModernComposer(window, onRender) {
  const observed = { pastedText: null, submitEvents: 0 };
  const composer = window.document.querySelector("[data-composer-markdown]");
  const form = window.document.querySelector("#composer-form");
  composer.addEventListener("paste", (event) => {
    event.preventDefault();
    observed.pastedText = event.clipboardData.getData("text/plain");
    composer.textContent = observed.pastedText;
  });
  form.addEventListener("submit", (event) => {
    observed.submitEvents += 1;
    event.preventDefault();
    composer.textContent = "";
    onRender(window.document.querySelector("#transcript"));
  });
  return observed;
}

(async () => {
  // --- 1. Réponse simple : un seul ResponseRoot, un seul output ------------ //
  {
    const { window, run } = loadExtension(`<main><div id="transcript"></div></main>`);
    window.__baseline = run("captureResponseBaseline()");
    assert.equal(window.__baseline.markdownRootCount, 0, "baseline sans réponse");
    assert.equal(window.__baseline.semanticRootCount, 0);
    assert.deepEqual(
      [...window.__baseline.rootSignatures],
      [],
      "aucune signature avant la réponse",
    );

    window.document.querySelector("#transcript").innerHTML = answerRoot(
      inlineText("BRIDGE_OK"),
    );

    const roots = run("resolveResponseRoots()");
    assert.equal(roots.markdown.length, 1, "un seul ResponseRoot");
    assert.equal(roots.inline_leaf_count, 1, "une feuille inline observée");
    assert.equal(roots.semantic.length, 0);

    const candidate = run("resolveResponseCandidate(globalThis.__baseline)");
    assert.equal(candidate.status, "found");
    assert.equal(candidate.strategy, "markdown_root_delta");
    assert.equal(candidate.markdown_root, true);
    assert.equal(candidate.candidate_count, 1);
    assert.equal(candidate.baseline_root_count, 0);
    assert.equal(candidate.current_root_count, 1);

    const output = run(`(() => {
      const candidate = resolveResponseCandidate(globalThis.__baseline);
      const content = resolveResponseContentRoot(candidate, true);
      return { isRoot: content === document.querySelector("[class*='MarkdownRoot-']"), ...readAnswer(content, false) };
    })()`);
    assert.equal(output.isRoot, true, "le MarkdownRoot est lui-même le content root");
    assert.equal(output.text, "BRIDGE_OK", "un seul output, sans duplication inline");
  }

  // --- 2. Réponse complexe : un seul root malgré P/OL/LI/PRE --------------- //
  {
    const { window, run } = loadExtension(`<main><div id="transcript"></div></main>`);
    window.__baseline = run("captureResponseBaseline()");
    window.document.querySelector("#transcript").innerHTML = answerRoot(`
      <p><span class="inline-markdown InlineMarkdownIsolate-A">BRIDGE_OK</span></p>
      <ol>
        <li><span class="inline-markdown InlineMarkdownIsolate-B">première</span></li>
        <li><span class="inline-markdown InlineMarkdownIsolate-C">seconde</span></li>
      </ol>
      <pre><code class="language-js">const answer = 42;</code></pre>
      <table><tbody><tr><td>cellule</td><td>valeur</td></tr></tbody></table>
    `);

    const roots = run("resolveResponseRoots()");
    assert.equal(roots.markdown.length, 1, "P/OL/LI/PRE/TABLE restent UN root");
    assert.equal(roots.inline_leaf_count, 3);

    const candidate = run("resolveResponseCandidate(globalThis.__baseline)");
    assert.equal(candidate.status, "found");
    assert.equal(candidate.candidate_count, 1);

    const output = run(`(() => {
      const candidate = resolveResponseCandidate(globalThis.__baseline);
      return readAnswer(resolveResponseContentRoot(candidate, true), false);
    })()`);
    assert.ok(output.text.includes("BRIDGE_OK"));
    assert.ok(output.text.includes("- première"));
    assert.ok(output.text.includes("```js"));
    assert.ok(output.text.includes("cellule"));
    // Un seul fragment de chaque : aucune duplication par feuille inline.
    assert.equal(output.text.split("BRIDGE_OK").length - 1, 1);
  }

  // --- 3. Le suffixe de classe est généré : jamais écrit en dur ------------ //
  {
    const { window, run } = loadExtension(`
      <main><div id="transcript">
        <div class="NotMarkdownRoot-AbCd12">faux positif</div>
        <div class="MarkdownRoot-rZKhxa">${inlineText("BRIDGE_OK")}</div>
      </div></main>`);
    const roots = run("resolveResponseRoots()");
    assert.equal(roots.markdown.length, 1, "seul un token MarkdownRoot-* compte");
    assert.equal(
      run(`SELECTORS.markdownRootCandidate`).includes("MarkdownRoot-"),
      true,
    );
    assert.equal(
      run(`document.querySelectorAll(".MarkdownRoot-rZKhxa").length`),
      1,
      "aucun sélecteur en dur : on n'utilise jamais le suffixe généré",
    );
    assert.equal(window.document.body.innerHTML.includes("NotMarkdownRoot-AbCd12"), true);
  }

  // --- 4. L'ancien DOM sémantique reste supporté --------------------------- //
  {
    const legacy = `
      <article data-testid="conversation-turn-3">
        <div data-message-author-role="assistant" data-message-id="m3">
          <div class="markdown"><p>réponse historique</p></div>
        </div>
      </article>`;
    const { run } = loadExtension(legacy);
    const baseline = run("captureResponseBaseline()");
    assert.equal(baseline.semanticRootCount, 1);
    assert.equal(baseline.markdownRootCount, 0);

    const candidate = run("resolveResponseCandidate(globalThis.__legacyBaseline || captureResponseBaseline())");
    assert.equal(candidate.status, "pending", "aucun delta : la réponse est antérieure");

    const fresh = run(`(() => {
      const baseline = captureResponseBaseline();
      document.body.insertAdjacentHTML("beforeend", ${JSON.stringify(legacy.replace("m3", "m4").replace("réponse historique", "réponse suivante"))});
      const candidate = resolveResponseCandidate(baseline);
      return {
        status: candidate.status,
        strategy: candidate.strategy,
        text: readAnswer(resolveResponseContentRoot(candidate, true), false).text,
      };
    })()`);
    assert.equal(fresh.status, "found");
    assert.equal(fresh.strategy, "semantic_assistant", "la stratégie historique reste prioritaire");
    assert.equal(fresh.text, "réponse suivante");
  }

  // --- 5. Baseline : un ancien MarkdownRoot ne devient jamais le candidat -- //
  {
    const { window, run } = loadExtension(`<main><div id="transcript"></div></main>`);
    const transcript = window.document.querySelector("#transcript");
    transcript.innerHTML = answerRoot(inlineText("ancienne réponse"));
    window.__baseline = run("captureResponseBaseline()");
    assert.equal(window.__baseline.markdownRootCount, 1);
    assert.equal(window.__baseline.rootSignatures.length, 1);

    // Signature identique : tout ce qui est présent avant le Send reste
    // « autorisé » une fois, et seul le surplus est candidat.
    transcript.insertAdjacentHTML(
      "beforeend",
      answerRoot(inlineText("BRIDGE_OK")),
    );

    const candidate = run("resolveResponseCandidate(globalThis.__baseline)");
    assert.equal(candidate.status, "found");
    assert.equal(candidate.candidate_count, 1);
    const output = run(`(() => {
      const candidate = resolveResponseCandidate(globalThis.__baseline);
      return readAnswer(resolveResponseContentRoot(candidate, true), false);
    })()`);
    assert.equal(output.text, "BRIDGE_OK", "le nouveau root uniquement");
    assert.equal(output.text.includes("ancienne"), false);
  }

  // --- 5bis. Le prompt moderne est lui aussi un MarkdownRoot sans rôle ----- //
  {
    const prompt = "Consigne de planification confidentielle ".repeat(24);
    const { window, run } = loadExtension(MODERN_PAGE);
    const transcript = window.document.querySelector("#transcript");
    window.__baseline = run("captureResponseBaseline()");
    window.__isPrompt = run(`createSubmittedPromptMatcher(${JSON.stringify(prompt)})`);

    transcript.innerHTML = answerRoot(inlineText(prompt), "User1");
    assert.equal(
      run("resolveResponseCandidate(globalThis.__baseline).status"),
      "found",
      "l'ancien locator confondait le prompt avec l'assistant",
    );
    let candidate = run(
      "resolveResponseCandidate(globalThis.__baseline, document, globalThis.__isPrompt)",
    );
    assert.equal(candidate.status, "pending");
    assert.equal(candidate.inline_leaf_count, 0, "les feuilles du prompt ne signalent pas une dérive");

    transcript.insertAdjacentHTML("beforeend", answerRoot(inlineText("PLAN_FINAL"), "Assistant1"));
    candidate = run(
      "resolveResponseCandidate(globalThis.__baseline, document, globalThis.__isPrompt)",
    );
    assert.equal(candidate.status, "found");
    assert.equal(run("readAnswer(resolveResponseContentRoot(resolveResponseCandidate(globalThis.__baseline, document, globalThis.__isPrompt)), false).text"), "PLAN_FINAL");
    window.__locator = run(
      "createResponseLocator(resolveResponseCandidate(globalThis.__baseline, document, globalThis.__isPrompt), globalThis.__baseline, document, globalThis.__isPrompt)",
    );
    assert.equal(
      run("readAnswer(locateResponseCandidate(globalThis.__locator, globalThis.__baseline, document, globalThis.__isPrompt).element, false).text"),
      "PLAN_FINAL",
    );

    // Un re-rendu React du message utilisateur ne doit jamais décaler le
    // locator de l'assistant vers l'écho du prompt.
    transcript.firstElementChild.outerHTML = answerRoot(inlineText(prompt), "User2");
    assert.equal(
      run("readAnswer(locateResponseCandidate(globalThis.__locator, globalThis.__baseline, document, globalThis.__isPrompt).element, false).text"),
      "PLAN_FINAL",
    );
  }

  // --- 6. Ambiguïté : deux nouveaux roots -> fail closed ------------------- //
  {
    const { window, run } = loadExtension(`<main><div id="transcript"></div></main>`);
    window.__baseline = run("captureResponseBaseline()");
    window.document.querySelector("#transcript").innerHTML =
      answerRoot(inlineText("BRIDGE_A")) + answerRoot(inlineText("BRIDGE_B"));
    const candidate = run("resolveResponseCandidate(globalThis.__baseline)");
    assert.equal(candidate.status, "ambiguous");
    assert.equal(candidate.candidate_count, 2);
    assert.equal(candidate.element, null, "aucun choix arbitraire");
  }

  // --- 7. Surface : le chrome applicatif n'est jamais une réponse ---------- //
  {
    const body = `
      <header>
        <div data-testid="app-shell-header-context-menu-surface">
          ${answerRoot(inlineText("MENU_DECOY"))}
        </div>
      </header>
      <aside>${answerRoot(inlineText("SIDEBAR_DECOY"))}</aside>
      <main id="chat">
        <div id="transcript">${answerRoot(inlineText("BRIDGE_OK"))}</div>
        <form id="composer-form">
          <div contenteditable="true" role="textbox" class="ProseMirror"
               data-composer-markdown></div>
          <button type="submit" aria-label="Send">Send</button>
        </form>
      </main>
      <div data-message-author-role="user" data-message-id="u1">
        ${answerRoot(inlineText("PROMPT_ECHO"))}
      </div>`;
    const { window, run } = loadExtension(body);
    const candidate = run("resolveResponseCandidate(globalThis.__emptyBaseline || { markdownRootKeys: [], rootSignatures: [], markdownRootCount: 0, semanticRootKeys: [], semanticRootCount: 0 })");
    assert.equal(candidate.status, "found", "un seul candidat réellement conversationnel");
    assert.equal(candidate.surface_strategy, "composer_main");
    assert.equal(candidate.current_root_count, 1, "chrome, sidebar et écho utilisateur ignorés");
    const text = run(`(() => {
      const baseline = { markdownRootKeys: [], rootSignatures: [], markdownRootCount: 0, semanticRootKeys: [], semanticRootCount: 0 };
      const candidate = resolveResponseCandidate(baseline);
      return readAnswer(resolveResponseContentRoot(candidate, true), false).text;
    })()`);
    assert.equal(text, "BRIDGE_OK");
    assert.equal(
      window.document
        .querySelector("[data-testid='app-shell-header-context-menu-surface']")
        .textContent.trim(),
      "MENU_DECOY",
      "le décor n'a pas été touché",
    );
  }

  // --- 8. Remplacement React : le locator rattache le nouveau nœud --------- //
  {
    const { window, run } = loadExtension(MODERN_PAGE);
    window.__baseline = run("captureResponseBaseline()");
    const transcript = window.document.querySelector("#transcript");
    transcript.innerHTML = answerRoot(inlineText("BRIDGE_"));
    const locator = run(`(() => {
      const candidate = resolveResponseCandidate(globalThis.__baseline);
      globalThis.__locator = createResponseLocator(candidate, globalThis.__baseline);
      return globalThis.__locator;
    })()`);
    assert.equal(locator.kind, "markdown_root");
    assert.equal(locator.ordinal, 0);

    // React recrée le nœud : même markup, autre élément, même réponse.
    transcript.innerHTML = answerRoot(inlineText("BRIDGE_OK"));
    const relocated = run(`locateResponseCandidate(globalThis.__locator, globalThis.__baseline)`);
    assert.ok(relocated, "le candidat logique doit être retrouvé");
    assert.equal(relocated.element, window.document.querySelector("[class*='MarkdownRoot-']"));
    assert.equal(
      run(`locateResponseCandidate(globalThis.__locator, globalThis.__baseline).element.querySelector("span").textContent`),
      "BRIDGE_OK",
    );
    // Un second ResponseRoot nouveau rend la ré-attribution ambiguë : on ne
    // devine pas, `locateResponseCandidate` refuse de choisir.
    transcript.insertAdjacentHTML("beforeend", answerRoot(inlineText("AUTRE")));
    assert.equal(
      run(`locateResponseCandidate(globalThis.__locator, globalThis.__baseline) === null`),
      false,
      "le nœud ordinal reste prioritaire tant que sa signature correspond",
    );
    transcript.innerHTML = answerRoot(inlineText("AUTRE"), "ZzZz");
    assert.equal(
      run(`locateResponseCandidate(globalThis.__locator, globalThis.__baseline) === null`),
      false,
      "un seul root nouveau reste rattachable",
    );
  }

  // --- 9. Diagnostic de santé : contrat fixe, sans contenu ---------------- //
  {
    const { window, run, dispatch } = loadExtension(
      MODERN_PAGE.replace("</main>", "").replace("<div id=\"transcript\"></div>", ""),
    );
    window.document.querySelector("#chat").insertAdjacentHTML(
      "afterbegin",
      `<div id="transcript">${answerRoot(inlineText(SECRET_RESPONSE))}</div>`,
    );
    const health = await dispatch({ type: "dom_health" });
    assert.equal(health.ok, true);
    assert.equal(health.content_script_version, "40");
    assert.deepEqual(Object.keys(health.response_locator).sort(), [
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
    // Aucun run n'a eu lieu dans cet onglet : le locator est idle, jamais
    // BROKEN — un onglet générique ne produit pas de fausse alarme.
    assert.equal(health.response_locator.candidate_state, "idle");
    assert.equal(health.response_locator.reason, null);
    assert.equal(health.response_locator.conversation_surface, true);
    assert.equal(health.response_locator.surface_strategy, "composer_main");
    assert.equal(health.response_locator.current_root_count, 1);
    assert.equal(health.response_locator.markdown_root, true);
    assert.equal(health.response_locator.inline_leaf_count, 1);
    assert.equal(JSON.stringify(health).includes(SECRET_RESPONSE), false);
    assert.equal(run("resolveResponseRoots().markdown.length"), 1);
  }

  // --- 10. Snapshot structurel borné (« Copy response structure ») -------- //
  {
    const nested = Array.from({ length: 9 }).reduce(
      (inner) => `<div class="depth-marker">${inner}</div>`,
      `<span class="inline-markdown InlineMarkdownIsolate-X">${SECRET_RESPONSE}</span>`,
    );
    const { window, dispatch } = loadExtension(
      MODERN_PAGE.replace(
        `<div id="transcript"></div>`,
        `<div id="transcript">${answerRoot(nested)}</div>`,
      ),
    );
    const structure = await dispatch({ type: "response_structure" });
    assert.equal(structure.ok, true);
    assert.equal(structure.content_script_version, "40");
    assert.equal(structure.conversation_surface.found, true);
    assert.equal(structure.conversation_surface.strategy, "composer_main");
    assert.equal(structure.strategy, "markdown_root_delta");
    assert.equal(structure.markdown_root_matches, 1);
    assert.equal(structure.inline_leaf_matches, 1);
    assert.equal(structure.roots.length, 1);
    assert.equal(structure.roots[0].strategy, "markdown_root_delta");

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
    assert.equal(root.depth, 0);
    assert.equal(root.visible, true);
    assert.equal(root.has_message_id, false);
    assert.ok(root.class_tokens.some((token) => token.startsWith("MarkdownRoot-")));
    assert.equal(Number.isInteger(root.width), true);

    // Bornes de profondeur : le texte ne peut pas être atteint par accident.
    let deepest = root;
    while (deepest.children.length) deepest = deepest.children[0];
    assert.ok(deepest.depth <= 6, `profondeur bornée, vue ${deepest.depth}`);
    assert.equal(deepest.children.length, 0, "feuille bornée");
    assert.ok(Number.isInteger(deepest.children_count));

    const json = JSON.stringify(structure);
    assert.equal(json.includes(SECRET_RESPONSE), false, "aucun contenu dans le snapshot");
    assert.equal(json.includes("innerText"), false);
    assert.equal(json.includes("textContent"), false);
    assert.equal(json.includes("innerHTML"), false);
    assert.equal(window.document.body.textContent.includes(SECRET_RESPONSE), true);
  }

  // --- 11. Run complet sur la nouvelle UI : la réponse est trouvée --------- //
  {
    const { window, run } = loadExtension(MODERN_PAGE);
    useVirtualClock(window);
    const sent = [];
    const locatorLogs = [];
    window.chrome.runtime.sendMessage = async (message) => { sent.push(message); };
    window.console.log = (event, details) => {
      if (event === "bridge_response_locator") locatorLogs.push({ ...details });
    };
    window.console.warn = () => {};
    const observed = observeModernComposer(window, (transcript) => {
      transcript.innerHTML = answerRoot(inlineText("BRIDGE_OK"));
    });

    await run(`handlePrompt({ id: "req-modern-root", prompt: "bonjour", conversation: { id: "conv-modern-root", mode: "fresh" }, requires_continuation_identity: true })`);

    assert.equal(observed.pastedText, "bonjour", "prompt injecté dans le ProseMirror moderne");
    assert.equal(observed.submitEvents, 1, "une seule soumission");
    const answers = sent.filter((message) => ["done", "incomplete"].includes(message.type));
    assert.equal(answers.length, 1, "une seule réponse, jamais un root par span");
    assert.equal(answers[0].text, "BRIDGE_OK");
    assert.equal(answers[0].submission_state, "post_submission");
    assert.equal(answers[0].metadata.output_chars, "BRIDGE_OK".length);
    assert.equal(answers[0].metadata.content_script_version, "40");
    // Ce test demande une conversation Bridge réutilisable : la finale reste
    // visible, mais elle ne peut pas devenir `done` sans identité externe.
    assert.equal(answers[0].type, "incomplete");
    assert.equal(answers[0].reason, "external_turn_identity_unavailable");
    assert.equal(answers[0].conversation?.turn_id, null);

    assert.ok(locatorLogs.length >= 1, "la décision du locator est journalisée");
    assert.deepEqual(Object.keys(locatorLogs[0]).sort(), [
      "ambiguity_count",
      "baseline_root_count",
      "candidate_found",
      "candidate_root_tag",
      "current_root_count",
      "inline_leaf_count",
      "markdown_root",
      "strategy",
      "version",
    ]);
    assert.equal(locatorLogs[0].strategy, "markdown_root_delta");
    assert.equal(locatorLogs[0].candidate_found, true);
    assert.equal(locatorLogs[0].candidate_root_tag, "DIV");
    assert.equal(locatorLogs[0].markdown_root, true);
    assert.equal(locatorLogs[0].baseline_root_count, 0);
    assert.equal(locatorLogs[0].current_root_count, 1);
    assert.equal(locatorLogs[0].inline_leaf_count, 1);
    assert.equal(locatorLogs[0].ambiguity_count, 0);
    assert.equal(locatorLogs[0].version, "40");
    assert.equal(JSON.stringify(locatorLogs).includes("BRIDGE_OK"), false);
  }

  // --- 11bis. Le MarkdownRoot utilisateur précède la réponse assistant ---- //
  {
    const prompt = "PLAN_PROMPT_PRIVE ".repeat(40);
    const { window, run } = loadExtension(MODERN_PAGE);
    const sent = [];
    window.chrome.runtime.sendMessage = async (message) => { sent.push(message); };
    window.console.log = () => {};
    const transcript = window.document.querySelector("#transcript");
    const form = window.document.querySelector("#composer-form");
    let clock = 0;
    let rendered = false;
    window.Date.now = () => clock;
    window.setTimeout = (fn, ms) => {
      clock += ms || 0;
      if (!rendered && clock >= 30_500) {
        rendered = true;
        form.querySelector("[data-testid='stop-button']")?.remove();
        transcript.insertAdjacentHTML("beforeend", answerRoot(inlineText("PLAN_FINAL"), "Assistant1"));
      }
      queueMicrotask(fn);
      return 0;
    };
    const observed = observeModernComposer(window, (surface) => {
      surface.innerHTML = answerRoot(inlineText(prompt), "User1");
      form.insertAdjacentHTML("beforeend", `<button data-testid="stop-button">Stop</button>`);
    });

    await run(`handlePrompt({ id: "req-user-root-first", prompt: ${JSON.stringify(prompt)}, conversation: { id: "conv-user-root-first", mode: "fresh" } })`);

    assert.equal(observed.submitEvents, 1);
    assert.ok(clock >= 30_500);
    assert.equal(sent.filter((message) => message.type === "error").length, 0);
    assert.equal(sent.find((message) => message.type === "done")?.text, "PLAN_FINAL");
    assert.equal(sent.some((message) => JSON.stringify(message).includes(prompt)), false);
  }

  // --- 12. Remplacement React pendant le run : une seule réponse ---------- //
  {
    const { window, run } = loadExtension(MODERN_PAGE);
    const sent = [];
    window.chrome.runtime.sendMessage = async (message) => { sent.push(message); };
    window.console.log = () => {};
    window.console.warn = () => {};
    const transcript = window.document.querySelector("#transcript");
    let clock = 0;
    // Le remplacement est déclenché par un COMPTEUR de tours de minuterie,
    // jamais par une échéance virtuelle : le run doit être encore en cours,
    // quelle que soit la fenêtre de stabilisation en vigueur.
    let ticksBeforeReplacement = null;
    let replacedAt = null;
    window.Date.now = () => clock;
    window.setTimeout = (fn, ms) => {
      clock += ms || 0;
      if (ticksBeforeReplacement !== null) {
        ticksBeforeReplacement -= 1;
        if (ticksBeforeReplacement <= 0) {
          ticksBeforeReplacement = null;
          replacedAt = clock;
          // React recrée le nœud pendant que la réponse s'écrit : même markup,
          // autre élément, même candidat logique.
          transcript.innerHTML = answerRoot(inlineText("BRIDGE_OK"));
        }
      }
      queueMicrotask(fn);
      return 0;
    };
    let firstRootElement = null;
    const observed = observeModernComposer(window, (target) => {
      target.innerHTML = answerRoot(inlineText("BRIDGE_"));
      firstRootElement = target.querySelector("[class*='MarkdownRoot-']");
      ticksBeforeReplacement = 6;
    });

    await run(`handlePrompt({ id: "req-replaced-root", prompt: "bonjour", conversation: { id: "conv-replaced-root", mode: "fresh" } })`);

    assert.equal(observed.submitEvents, 1, "un remplacement de nœud ne resoumet jamais");
    const answers = sent.filter((message) => ["done", "incomplete"].includes(message.type));
    assert.equal(answers.length, 1, "un seul candidat, jamais deux réponses");
    assert.equal(answers[0].text, "BRIDGE_OK", "le texte vient du nœud recréé");
    assert.equal(
      sent.some((message) => message.type === "error"),
      false,
      "un remplacement de nœud n'est jamais un échec",
    );
    assert.notEqual(replacedAt, null, "le nœud a bien été remplacé pendant le run");
    assert.equal(firstRootElement.isConnected, false, "l'ancien nœud est détaché");
    assert.notEqual(
      transcript.querySelector("[class*='MarkdownRoot-']"),
      firstRootElement,
      "la réponse vient du nœud recréé, pas de la référence gardée",
    );
    assert.ok(
      clock >= replacedAt + 2000,
      `l'observation continue après le remplacement (clock=${clock}, remplacement=${replacedAt})`,
    );
  }

  // --- 13. Deux nouveaux roots : fail closed, aucun replay ---------------- //
  {
    const { window, run } = loadExtension(MODERN_PAGE);
    const clockOf = useVirtualClock(window);
    const sent = [];
    window.chrome.runtime.sendMessage = async (message) => { sent.push(message); };
    window.console.log = () => {};
    window.console.warn = () => {};
    const observed = observeModernComposer(window, (transcript) => {
      transcript.innerHTML =
        answerRoot(inlineText("BRIDGE_A")) + answerRoot(inlineText("BRIDGE_B"));
    });

    await run(`handlePrompt({ id: "req-ambiguous-roots", prompt: "bonjour", conversation: { id: "conv-ambiguous-roots", mode: "fresh" } })`);

    const error = sent.find((message) => message.type === "error");
    assert.equal(observed.submitEvents, 1, "aucun replay automatique");
    assert.equal(error?.code, "bridge_response_contract_drift");
    assert.equal(error?.phase, "generation");
    assert.equal(error?.submission_state, "post_submission");
    const details = error?.diagnostics || {};
    assert.equal(details.reason, "ambiguous_response_roots");
    assert.equal(details.markdown_root_matches, 2);
    assert.equal(details.semantic_assistant_matches, 0);
    assert.equal(details.inline_leaf_matches, 2);
    assert.equal(details.baseline_root_count, 0);
    assert.equal(details.current_root_count, 2);
    assert.equal(details.conversation_surface_found, true);
    assert.equal(details.submission_state, "post_submission");
    assert.equal(details.content_script_version, "40");
    assert.deepEqual([...details.response_root_strategies], ["markdown_root_delta"]);
    assert.ok(
      clockOf() >= run("RESPONSE_AMBIGUITY_HOLD_MS"),
      "l'ambiguïté doit persister avant de conclure",
    );
    assert.equal(
      sent.some((message) => ["done", "incomplete"].includes(message.type)),
      false,
      "aucune réponse fabriquée",
    );
    assert.equal(JSON.stringify(error).includes("BRIDGE_A"), false);

    // Le diagnostic « un clic » du popup reprend la décision réelle du locator
    // (raison bornée, jamais re-dérivée côté popup).
    const health = run("responseLocatorHealth()");
    assert.equal(health.candidate_state, "broken");
    assert.equal(health.reason, "ambiguous_root");
    assert.equal(health.conversation_surface, true);
    assert.equal(health.current_root_count, 2);
    assert.equal(health.inline_leaf_count, 2);
  }

  // --- 14. Dérive : feuilles inline sans ResponseRoot résolvable ---------- //
  {
    const { window, run } = loadExtension(MODERN_PAGE);
    const clockOf = useVirtualClock(window);
    const sent = [];
    window.chrome.runtime.sendMessage = async (message) => { sent.push(message); };
    window.console.log = () => {};
    window.console.warn = () => {};
    const observed = observeModernComposer(window, (transcript) => {
      // Aucun MarkdownRoot, seulement la feuille inline : l'UI a encore bougé.
      // Le texte est bien rendu, mais le contrat de réponse est illisible.
      transcript.innerHTML = `<div class="prose-block"><span class="inline-markdown InlineMarkdownIsolate-X">${SECRET_RESPONSE}</span></div>`;
    });

    await run(`handlePrompt({ id: "req-drift", prompt: "bonjour", conversation: { id: "conv-drift", mode: "fresh" } })`);

    const error = sent.find((message) => message.type === "error");
    assert.equal(observed.submitEvents, 1, "aucun replay automatique");
    assert.equal(error?.code, "bridge_response_contract_drift");
    assert.equal(error?.submission_state, "post_submission");
    const details = error?.diagnostics || {};
    assert.equal(details.reason, "inline_markdown_without_response_root");
    assert.equal(details.markdown_root_matches, 0);
    assert.equal(details.semantic_assistant_matches, 0);
    assert.equal(details.inline_leaf_matches, 1);
    assert.equal(details.baseline_root_count, 0);
    assert.equal(details.current_root_count, 0);
    assert.equal(details.conversation_surface_found, true);
    assert.deepEqual([...details.response_root_strategies], []);
    assert.equal(details.submission_state, "post_submission");
    assert.equal(details.content_script_version, "40");
    assert.ok(
      clockOf() >= run("RESPONSE_CONTRACT_DRIFT_MS"),
      "la dérive se conclut dans une fenêtre bornée",
    );
    assert.equal(
      sent.some((message) => ["done", "incomplete"].includes(message.type)),
      false,
    );
    // Le popup doit pouvoir dire *pourquoi* le locator refuse de conclure :
    // « BROKEN · inline_without_root », pas un booléen muet.
    const health = run("responseLocatorHealth()");
    assert.equal(health.candidate_state, "broken");
    assert.equal(health.reason, "inline_without_root");
    assert.equal(health.current_root_count, 0);
    assert.equal(health.inline_leaf_count, 1);
    assert.equal(JSON.stringify(health).includes(SECRET_RESPONSE), false);
    assert.equal(
      JSON.stringify(error).includes(SECRET_RESPONSE),
      false,
      "le diagnostic de dérive ne contient jamais la réponse",
    );
  }

  // --- 15. Vie privée : le contenu n'entre dans aucun diagnostic ---------- //
  {
    const { window, run, dispatch } = loadExtension(MODERN_PAGE);
    useVirtualClock(window);
    const sent = [];
    const logs = [];
    window.chrome.runtime.sendMessage = async (message) => { sent.push(message); };
    window.console.log = (...args) => logs.push(args);
    window.console.warn = (...args) => logs.push(args);
    window.console.error = (...args) => logs.push(args);
    observeModernComposer(window, (transcript) => {
      transcript.innerHTML = answerRoot(inlineText(SECRET_RESPONSE));
    });

    await run(`handlePrompt({ id: "req-privacy", prompt: "bonjour confidentiel", conversation: { id: "conv-privacy", mode: "fresh" } })`);

    const answer = sent.find((message) => ["done", "incomplete"].includes(message.type));
    assert.equal(
      answer?.text,
      SECRET_RESPONSE,
      "la réponse reste livrée intégralement, elle",
    );
    const health = await dispatch({ type: "dom_health" });
    const structure = await dispatch({ type: "response_structure" });
    assert.equal(health.response_locator.markdown_root, true);
    for (const [label, value] of [
      ["logs", JSON.stringify(logs)],
      ["dom_health", JSON.stringify(health)],
      ["response_structure", JSON.stringify(structure)],
      ["locator", JSON.stringify(health.response_locator)],
      [
        "bridge_response_locator",
        JSON.stringify(logs.filter((args) => args[0] === "bridge_response_locator")),
      ],
    ]) {
      assert.equal(
        value.includes(SECRET_RESPONSE),
        false,
        `${label} ne doit jamais contenir la réponse`,
      );
      assert.equal(
        value.includes("bonjour confidentiel"),
        false,
        `${label} ne doit jamais contenir le prompt`,
      );
    }
  }

  // --- 16. Re-rendu React d'un ancien tour : jamais la nouvelle réponse ---- //
  {
    const { window, run } = loadExtension(MODERN_PAGE);
    const transcript = window.document.querySelector("#transcript");
    transcript.innerHTML = answerRoot(inlineText("ancienne réponse"), "Old1");
    window.__baseline = run("captureResponseBaseline()");
    assert.equal(window.__baseline.markdownRootCount, 1);

    // React remonte le tour : nœud neuf, signature de classes neuve, contenu
    // inchangé. Aucune réponse n'a été écrite : l'ancienne ne doit pas devenir
    // la nouvelle. Le rang est dans l'enveloppe du baseline, donc rien n'est
    // frais — le run reste en attente, il ne livre jamais ce texte.
    transcript.innerHTML = answerRoot(inlineText("ancienne réponse"), "Rerendered2");
    const rerendered = run("resolveResponseCandidate(globalThis.__baseline)");
    assert.equal(rerendered.status, "pending", "un re-rendu React n'est pas une réponse");
    assert.equal(rerendered.element, null, "aucun nœud choisi");
    assert.equal(rerendered.current_root_count, 1);

    // Le tour suivant, lui, apparaît au-delà de l'enveloppe : il reste trouvé,
    // même en présence de l'ancien tour re-rendu.
    transcript.insertAdjacentHTML(
      "beforeend",
      answerRoot(inlineText("BRIDGE_OK"), "New3"),
    );
    const fresh = run(`(() => {
      const candidate = resolveResponseCandidate(globalThis.__baseline);
      return {
        status: candidate.status,
        text: candidate.element
          ? readAnswer(resolveResponseContentRoot(candidate, true), false).text
          : null,
      };
    })()`);
    assert.equal(fresh.status, "found");
    assert.equal(fresh.text, "BRIDGE_OK", "le nouveau tour uniquement");
    assert.equal(fresh.text.includes("ancienne"), false);

    // Le repli du locator applique le même contrat : si la réponse du run
    // disparaît et que seul l'ancien tour est recréé, il n'y a aucune identité
    // de repli — surtout pas l'ancien contenu.
    transcript.innerHTML =
      answerRoot(inlineText("ancienne réponse"), "Old1") +
      answerRoot(inlineText("BRIDGE_OK"), "New1");
    run(`(() => {
      const candidate = resolveResponseCandidate(globalThis.__baseline);
      globalThis.__locator = createResponseLocator(candidate, globalThis.__baseline);
    })()`);
    transcript.innerHTML = answerRoot(inlineText("ancienne réponse"), "Rerendered2");
    assert.equal(
      run("locateResponseCandidate(globalThis.__locator, globalThis.__baseline) === null"),
      true,
      "un ancien tour re-rendu n'est jamais une identité de repli",
    );
  }

  // --- 17. Re-montage React pendant le run : aucun ancien texte livré ------ //
  {
    const OLD_TEXT = "ancienne réponse à ne jamais relivrer";
    const { window, run, dispatch } = loadExtension(MODERN_PAGE);
    const clockOf = useVirtualClock(window);
    const sent = [];
    window.chrome.runtime.sendMessage = async (message) => { sent.push(message); };
    window.console.log = () => {};
    window.console.warn = () => {};
    const transcript = window.document.querySelector("#transcript");
    transcript.innerHTML = answerRoot(inlineText(OLD_TEXT), "Old1");

    // Le re-montage est déclenché par un COMPTEUR de tours de minuterie : le
    // run est encore en cours, quelle que soit la fenêtre de stabilisation.
    const tick = window.setTimeout;
    let ticksBeforeRemount = null;
    let remountedAt = null;
    let quietResolve = null;
    const quiet = new Promise((resolve) => { quietResolve = resolve; });
    let ticksAfterRemount = 0;
    window.setTimeout = (fn, ms) => {
      if (ticksBeforeRemount !== null) {
        ticksBeforeRemount -= 1;
        if (ticksBeforeRemount <= 0) {
          ticksBeforeRemount = null;
          remountedAt = clockOf();
          // React remonte la liste entière : la réponse du run disparaît,
          // l'ancien tour revient avec une signature neuve.
          transcript.innerHTML =
            `<div class="MarkdownRoot-Rerendered2">${inlineText(OLD_TEXT, "Old2")}</div>`;
        }
      } else if (remountedAt !== null && quietResolve) {
        ticksAfterRemount += 1;
        // 500 tours de POLL_MS : bien au-delà de toutes les fenêtres de
        // conclusion, et toujours aucune réponse fabriquée.
        if (ticksAfterRemount >= 500) { quietResolve(); quietResolve = null; }
      }
      return tick(fn, ms);
    };
    const observed = observeModernComposer(window, (target) => {
      target.innerHTML =
        `<div class="MarkdownRoot-R1">${inlineText("BRIDGE_", "R1")}<div class="result-streaming"></div></div>`;
      ticksBeforeRemount = 8;
    });

    const runPromise = run(
      `handlePrompt({ id: "req-remount", prompt: "bonjour", conversation: { id: "conv-remount", mode: "fresh" } })`,
    );
    await quiet;
    assert.equal(observed.submitEvents, 1, "aucun replay automatique");
    assert.notEqual(remountedAt, null, "le re-montage a bien eu lieu pendant le run");
    assert.ok(
      clockOf() >= remountedAt + 500 * run("POLL_MS"),
      "le run observe sans conclure après le re-montage",
    );
    assert.equal(
      sent.some((message) => ["done", "incomplete"].includes(message.type)),
      false,
      "aucune réponse fabriquée depuis le contenu de l'ancien tour",
    );
    assert.equal(JSON.stringify(sent).includes(OLD_TEXT), false);

    await dispatch({ type: "abort", id: "req-remount" });
    await runPromise;
    assert.equal(
      sent.some((message) => ["done", "incomplete"].includes(message.type)),
      false,
      "un abandon ne fabrique pas de réponse",
    );
  }

  console.log("response root locator contract: ok");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
