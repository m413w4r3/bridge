/**
 * Machine à états de finalisation : ACTIVE / QUIESCENT / FINAL.
 *
 * Deux générations de DOM doivent finaliser de la même façon :
 *   - le tour assistant historique, dont la barre d'actions reste une preuve
 *     terminale explicite (finalisation rapide, sans régression) ;
 *   - le ResponseRoot moderne (`div` dont une classe commence par
 *     « MarkdownRoot- »), qui peut rendre une réponse complète SANS jamais
 *     exposer de bouton Copy.
 *
 * Ce fichier couvre les scénarios de contrat : réponse sans action, streaming,
 * Stop, reasoning, changement de sortie, remplacement React et fin unique.
 *
 * jsdom est une dépendance de test de ce dépôt : `npm ci` avant ce test.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");

const EXTENSION = path.join(__dirname, "..", "extension");

/** Charge l'extension dans un DOM simulé et rend ses fonctions appelables. */
function loadExtension(body, url = "https://chatgpt.com/?temporary-chat=true") {
  const dom = new JSDOM(`<!doctype html><html><body>${body}</body></html>`, {
    runScripts: "outside-only",
    url,
  });
  const { window } = dom;

  // jsdom ne calcule aucune mise en page : sans ce repli, `isVisibleElement()`
  // renverrait false pour tout et aucun signal ne serait jamais lu.
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

/**
 * Borne dure de l'horloge virtuelle : une finalisation qui ne conclut pas
 * ferait tourner la boucle indéfiniment. Mieux vaut un échec explicite.
 */
const VIRTUAL_CLOCK_LIMIT_MS = 600_000;

/** Horloge virtuelle : chaque minuterie avance le temps et rend la main. */
function useVirtualClock(window) {
  let clock = 0;
  window.Date.now = () => clock;
  const advance = (ms) => {
    clock += Math.max(0, ms || 0);
    if (clock > VIRTUAL_CLOCK_LIMIT_MS) {
      throw new Error(
        `finalisation non concluante : horloge virtuelle à ${clock} ms`,
      );
    }
  };
  window.setTimeout = (fn, ms) => {
    advance(ms);
    queueMicrotask(fn);
    return 0;
  };
  /**
   * Déclenche `fn` après `ticks` itérations RÉELLES de la boucle (chaque
   * minuterie posée par le content script compte pour une), sans jamais
   * dépendre d'une échéance : le run doit être en cours quelle que soit la
   * fenêtre de stabilisation en vigueur.
   */
  const afterTicks = (ticks, fn) => {
    let left = ticks;
    window.setTimeout = (callback, ms) => {
      if (left !== null) {
        left -= 1;
        if (left <= 0) {
          left = null;
          fn();
        }
      }
      advance(ms);
      queueMicrotask(callback);
      return 0;
    };
  };
  return { clock: () => clock, afterTicks };
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

/** Page historique : tour assistant sémantique + barre d'actions. */
const LEGACY_PAGE = `
  <main id="chat">
    <div id="transcript"></div>
    <form id="composer-form">
      <textarea data-id="prompt"></textarea>
      <button aria-disabled="false" data-testid="send-button">Send</button>
    </form>
  </main>`;

const COPY_BUTTON = `<button data-testid="copy-turn-action-button">Copy response</button>`;
const STOP_BUTTON = `<button data-testid="stop-button" aria-label="Stop streaming"></button>`;

const answerRoot = (content, suffix = "AbCd12") =>
  `<div class="MarkdownRoot-${suffix}">${content}</div>`;
const inlineText = (text, suffix = "X") =>
  `<p><span class="inline-markdown InlineMarkdownIsolate-${suffix}">${text}</span></p>`;

/** Instrumente la page moderne : paste ProseMirror + submit qui rend la réponse. */
function observeComposer(window, onRender) {
  const observed = { pastedText: null, submitEvents: 0 };
  const composer = window.document.querySelector(
    window.document.querySelector("[data-composer-markdown]")
      ? "[data-composer-markdown]"
      : "textarea[data-id='prompt']",
  );
  const form = window.document.querySelector("#composer-form");
  composer.addEventListener("paste", (event) => {
    event.preventDefault();
    observed.pastedText = event.clipboardData.getData("text/plain");
    composer.textContent = observed.pastedText;
  });
  form.addEventListener("submit", (event) => {
    observed.submitEvents += 1;
    event.preventDefault();
    if (composer.tagName === "TEXTAREA") composer.value = "";
    else composer.textContent = "";
    onRender(window.document.querySelector("#transcript"));
  });
  return observed;
}

async function runPrompt({ window, run, sent, page, id, render, before }) {
  window.console.log = () => {};
  window.console.warn = () => {};
  window.chrome.runtime.sendMessage = async (message) => {
    sent.push(message);
  };
  const clock = useVirtualClock(window);
  const observed = observeComposer(window, (transcript) => {
    render(transcript, clock);
  });
  if (before) before(clock, window);
  await run(
    `handlePrompt({ id: ${JSON.stringify(id)}, prompt: "bonjour", conversation: { id: "conv-${id}", mode: "fresh" } })`,
  );
  return { observed, virtual: clock };
}

const terminalMessages = (sent) =>
  sent.filter((message) => ["done", "incomplete", "error"].includes(message.type));
const heartbeats = (sent) =>
  sent.filter((message) => message.type === "heartbeat");

(async () => {
  // --- 1. ResponseRoot moderne SANS bouton Copy : QUIESCENT puis FINAL ----- //
  // Le cas principal : aucune action, aucun streaming, aucun Stop, aucun
  // reasoning. La finalisation ne peut venir que de la stabilité observée.
  {
    const sent = [];
    const { window, run } = loadExtension(MODERN_PAGE);
    let renderedAt = null;
    const { virtual } = await runPrompt({
      window,
      run,
      sent,
      id: "req-quiescent",
      render: (transcript, virtual) => {
        renderedAt = virtual.clock();
        transcript.innerHTML = answerRoot(inlineText("BRIDGE_OK"));
      },
    });

    const terminal = terminalMessages(sent);
    assert.equal(terminal.length, 1, "une seule fin, jamais deux");
    assert.equal(terminal[0].type, "incomplete", "UI moderne : pas d'identité externe");
    assert.equal(terminal[0].reason, "external_turn_identity_unavailable");
    assert.equal(terminal[0].text, "BRIDGE_OK", "le serializer rend la réponse entière");
    assert.equal(terminal[0].metadata.output_chars, "BRIDGE_OK".length);
    assert.equal(
      terminal[0].metadata.completion_signal,
      "quiescent_stability",
      "la fin vient de la stabilité, pas d'une action Copy",
    );
    assert.equal(terminal[0].metadata.completion_confidence, "medium");

    const finalization = terminal[0].metadata.finalization;
    assert.equal(finalization.finalization_state, "final", "FINAL est terminal");
    assert.equal(finalization.signal, "quiescent_stability");
    assert.equal(finalization.output_chars, "BRIDGE_OK".length);
    assert.equal(finalization.streaming_visible, false);
    assert.equal(finalization.reasoning_visible, false);
    assert.equal(finalization.stop_visible, false);
    assert.equal(finalization.terminal_action_visible, false);
    assert.equal(finalization.response_strategy, "markdown_root_delta");

    const evidence = terminal[0].metadata.finalization_evidence;
    assert.equal(evidence.mode, "quiescent_stability");
    assert.equal(evidence.signal, "quiescent_stability");
    assert.equal(evidence.candidate_strategy, "markdown_root_delta");
    assert.equal(evidence.output_chars, "BRIDGE_OK".length);
    assert.ok(
      evidence.stable_for_ms >= run("SETTLE_UNKNOWN_MS"),
      `stabilité suffisante requise, vue ${evidence.stable_for_ms}`,
    );
    assert.ok(
      evidence.stable_observations >= run("MIN_QUIESCENT_OBSERVATIONS"),
      `observations réelles requises, vues ${evidence.stable_observations}`,
    );

    const beats = heartbeats(sent);
    assert.ok(beats.length >= 2, "les heartbeats continuent pendant la quiescence");
    const quiescentBeats = beats.filter(
      (message) =>
        message.progress.finalization.finalization_state === "quiescent",
    );
    assert.ok(
      quiescentBeats.length >= 1,
      "l'état QUIESCENT est nommé avant toute stabilité suffisante",
    );
    assert.ok(
      quiescentBeats.some(
        (message) =>
          message.progress.finalization.stable_for_ms <
          run("SETTLE_UNKNOWN_MS"),
      ),
      "t = 0 est QUIESCENT, jamais FINAL",
    );
    assert.ok(
      beats.every(
        (message) =>
          message.progress.finalization.signal ===
          message.progress.completion_signal,
      ),
      "le heartbeat publie le signal de la machine, jamais un autre",
    );
    assert.equal(
      JSON.stringify(beats).includes("BRIDGE_OK"),
      false,
      "un heartbeat ne transporte jamais de contenu",
    );

    // La durée n'est jamais devinée : la fin arrive après la fenêtre entière.
    assert.ok(
      virtual.clock() >= renderedAt + run("SETTLE_UNKNOWN_MS"),
      `fin prématurée à t=${virtual.clock()} (rendu à ${renderedAt})`,
    );
  }

  // --- 2. Terminal action historique : finalisation rapide, sans régression - //
  {
    const sent = [];
    const { window, run } = loadExtension(LEGACY_PAGE);
    let renderedAt = null;
    const { virtual } = await runPrompt({
      window,
      run,
      sent,
      id: "req-legacy-actions",
      render: (transcript, virtual) => {
        renderedAt = virtual.clock();
        transcript.innerHTML = `
          <article data-testid="conversation-turn-1">
            <div data-message-author-role="assistant" data-message-id="legacy-1">
              <div class="markdown"><p>réponse historique</p></div>
            </div>
            ${COPY_BUTTON}
          </article>`;
      },
    });

    const terminal = terminalMessages(sent);
    assert.equal(terminal.length, 1);
    assert.equal(terminal[0].type, "done", "l'identité externe existe : done");
    assert.equal(terminal[0].text, "réponse historique");
    assert.equal(terminal[0].metadata.completion_signal, "assistant_actions");
    assert.equal(terminal[0].metadata.completion_confidence, "high");
    const evidence = terminal[0].metadata.finalization_evidence;
    assert.equal(evidence.mode, "terminal_action");
    assert.equal(evidence.candidate_strategy, "semantic_assistant");
    assert.equal(
      terminal[0].metadata.finalization.finalization_state,
      "final",
    );
    assert.equal(terminal[0].metadata.finalization.terminal_action_visible, true);
    assert.ok(
      evidence.stable_for_ms < run("SETTLE_UNKNOWN_MS"),
      "la preuve terminale n'attend pas la fenêtre de quiescence",
    );
    assert.ok(
      virtual.clock() - renderedAt < run("SETTLE_UNKNOWN_MS"),
      `finalisation lente sans raison : ${virtual.clock() - renderedAt} ms`,
    );
  }

  // --- 3. Streaming : ACTIVE même stable, QUIESCENT après disparition ------- //
  {
    const sent = [];
    const { window, run } = loadExtension(MODERN_PAGE);
    let streaming = null;
    let streamingRemovedAt = null;
    let terminalsWhileStreaming = null;
    const { virtual } = await runPrompt({
      window,
      run,
      sent,
      id: "req-streaming",
      before: (virtual, win) => {
        virtual.afterTicks(180, () => {
          terminalsWhileStreaming = terminalMessages(sent).length;
          streamingRemovedAt = virtual.clock();
          streaming.remove();
        });
      },
      render: (transcript) => {
        transcript.innerHTML = `${answerRoot(`${inlineText("BRIDGE_OK")}<div class="result-streaming"></div>`, "Stream1")}`;
        streaming = transcript.querySelector(".result-streaming");
      },
    });

    assert.equal(
      terminalsWhileStreaming,
      0,
      "un texte stable pendant le streaming n'est jamais une fin",
    );
    const beats = heartbeats(sent);
    const activeBeats = beats.filter(
      (message) => message.progress.finalization.finalization_state === "active",
    );
    assert.ok(activeBeats.length >= 1, "ACTIVE est publié pendant le streaming");
    assert.ok(
      activeBeats.every(
        (message) => message.progress.finalization.signal === "streaming",
      ),
      "le signal bloquant est nommé : streaming",
    );
    assert.ok(
      activeBeats.some(
        (message) =>
          message.progress.finalization.stable_for_ms >=
          run("SETTLE_UNKNOWN_MS"),
      ),
      "le texte est resté stable plus longtemps que la fenêtre sans conclure",
    );
    assert.equal(
      beats.some(
        (message) =>
          message.progress.finalization.streaming_visible === false &&
          message.progress.finalization.finalization_state === "active",
      ),
      false,
      "aucun état ACTIVE n'est publié après la disparition du streaming",
    );

    const terminal = terminalMessages(sent);
    assert.equal(terminal.length, 1);
    assert.equal(terminal[0].text, "BRIDGE_OK");
    assert.equal(
      terminal[0].metadata.completion_signal,
      "quiescent_stability",
      "la fin attend la disparition du signal actif",
    );
    assert.ok(
      terminal[0].metadata.finalization_evidence.stable_for_ms >=
        run("SETTLE_UNKNOWN_MS"),
      "la nouvelle période QUIESCENT repart de zéro",
    );
    assert.ok(
      virtual.clock() - streamingRemovedAt >= run("SETTLE_UNKNOWN_MS"),
      "aucune conclusion sur l'ancienne période",
    );
  }

  // --- 4. Stop du composer : ACTIVE tant qu'il est visible ------------------ //
  {
    const sent = [];
    const { window, run } = loadExtension(LEGACY_PAGE);
    let stop = null;
    let stopRemovedAt = null;
    let terminalsWhileStopVisible = null;
    const { virtual } = await runPrompt({
      window,
      run,
      sent,
      id: "req-stop",
      before: (virtual) => {
        virtual.afterTicks(180, () => {
          terminalsWhileStopVisible = terminalMessages(sent).length;
          stopRemovedAt = virtual.clock();
          stop.remove();
        });
      },
      render: (transcript) => {
        transcript.innerHTML = `
          <article data-testid="conversation-turn-1">
            <div data-message-author-role="assistant" data-message-id="stop-1">
              <div class="markdown"><p>réponse complète</p></div>
            </div>
          </article>`;
        window.document
          .querySelector("#composer-form")
          .insertAdjacentHTML("beforeend", STOP_BUTTON);
        stop = window.document.querySelector("[data-testid='stop-button']");
      },
    });

    assert.equal(
      terminalsWhileStopVisible,
      0,
      "le Stop visible interdit toute conclusion",
    );
    const beats = heartbeats(sent);
    const stopBeats = beats.filter(
      (message) => message.progress.finalization.signal === "stop_button",
    );
    assert.ok(stopBeats.length >= 1, "le Stop est un signal ACTIVE nommé");
    assert.ok(
      stopBeats.every(
        (message) =>
          message.progress.finalization.finalization_state === "active" &&
          message.progress.finalization.stop_visible === true,
      ),
      "ACTIVE tant que le Stop est visible",
    );
    const terminal = terminalMessages(sent);
    assert.equal(terminal.length, 1);
    assert.equal(terminal[0].metadata.completion_signal, "quiescent_stability");
    assert.ok(virtual.clock() - stopRemovedAt >= run("SETTLE_UNKNOWN_MS"));
  }

  // --- 5. Reasoning actif : ACTIVE malgré une réponse partielle déjà écrite - //
  {
    const sent = [];
    const { window, run } = loadExtension(MODERN_PAGE);
    let reasoning = null;
    let reasoningRemovedAt = null;
    let terminalsWhileReasoning = null;
    const { virtual } = await runPrompt({
      window,
      run,
      sent,
      id: "req-reasoning",
      before: (virtual) => {
        virtual.afterTicks(180, () => {
          terminalsWhileReasoning = terminalMessages(sent).length;
          reasoningRemovedAt = virtual.clock();
          reasoning.remove();
        });
      },
      render: (transcript) => {
        transcript.innerHTML = `
          <details data-testid="reasoning" open><summary>Réflexion</summary></details>
          ${answerRoot(inlineText("BRIDGE_OK partiel"), "Rsn1")}`;
        reasoning = transcript.querySelector("[data-testid='reasoning']");
      },
    });

    assert.equal(
      terminalsWhileReasoning,
      0,
      "le reasoning bloque la finalisation même avec du texte déjà écrit",
    );
    const beats = heartbeats(sent);
    const reasoningBeats = beats.filter(
      (message) => message.progress.finalization.signal === "reasoning",
    );
    assert.ok(reasoningBeats.length >= 1, "le reasoning est un signal ACTIVE nommé");
    assert.ok(
      reasoningBeats.every(
        (message) =>
          message.progress.finalization.finalization_state === "active" &&
          message.progress.finalization.output_chars > 0,
      ),
      "la réponse partielle est déjà visible et ne conclut pourtant pas",
    );
    const terminal = terminalMessages(sent);
    assert.equal(terminal.length, 1);
    assert.equal(terminal[0].metadata.completion_signal, "quiescent_stability");
    assert.ok(virtual.clock() - reasoningRemovedAt >= run("SETTLE_UNKNOWN_MS"));
  }

  // --- 6. Changement de sortie : la fenêtre repart de zéro ------------------ //
  {
    const sent = [];
    const { window, run } = loadExtension(MODERN_PAGE);
    let changedAt = null;
    const { virtual } = await runPrompt({
      window,
      run,
      sent,
      id: "req-output-change",
      before: (virtual) => {
        // ~10 s de quiescence, puis la réponse continue : la fenêtre de 15 s ne
        // doit PAS aboutir depuis l'ancien début.
        virtual.afterTicks(90, () => {
          changedAt = virtual.clock();
          window.document
            .querySelector("[class*='MarkdownRoot-']")
            .insertAdjacentHTML("beforeend", inlineText("deuxième moitié", "Y"));
        });
      },
      render: (transcript) => {
        transcript.innerHTML = answerRoot(inlineText("première moitié"));
      },
    });

    assert.notEqual(changedAt, null, "la réponse a réellement changé en cours de run");
    const terminal = terminalMessages(sent);
    assert.equal(terminal.length, 1);
    assert.ok(
      terminal[0].text.includes("première moitié") &&
        terminal[0].text.includes("deuxième moitié"),
      `le snapshot final contient la réponse entière : ${terminal[0].text}`,
    );
    const evidence = terminal[0].metadata.finalization_evidence;
    assert.ok(
      evidence.stable_for_ms >= run("SETTLE_UNKNOWN_MS"),
      "la fenêtre mesurée repart du dernier changement",
    );
    assert.ok(
      virtual.clock() - changedAt >= run("SETTLE_UNKNOWN_MS"),
      `finalisation trop tôt après le changement : ${virtual.clock() - changedAt} ms`,
    );
  }

  // --- 7. Remplacement React : même réponse logique, fenêtre conservée ------ //
  // React remplace `MarkdownRoot A` par `MarkdownRoot B` en pleine quiescence,
  // avec exactement le même texte : la stabilité est une propriété du CONTENU,
  // pas d'un nœud DOM. La fenêtre ne doit donc pas repartir de zéro — sinon une
  // fin déjà acquise serait repoussée d'une fenêtre entière.
  {
    const sent = [];
    const { window, run } = loadExtension(MODERN_PAGE);
    let replacedAt = null;
    let replacements = 0;
    const { virtual } = await runPrompt({
      window,
      run,
      sent,
      id: "req-react-replacement",
      before: (virtual) => {
        virtual.afterTicks(90, () => {
          replacements += 1;
          replacedAt = virtual.clock();
          const transcript = window.document.querySelector("#transcript");
          transcript.innerHTML = answerRoot(inlineText("BRIDGE_OK"), "Second");
        });
      },
      render: (transcript) => {
        transcript.innerHTML = answerRoot(inlineText("BRIDGE_OK"));
      },
    });

    assert.equal(replacements, 1, "le ResponseRoot a réellement été remplacé");
    assert.notEqual(replacedAt, null);
    const terminal = terminalMessages(sent);
    assert.equal(terminal.length, 1);
    assert.equal(terminal[0].text, "BRIDGE_OK");
    assert.equal(terminal[0].metadata.completion_signal, "quiescent_stability");
    assert.ok(
      virtual.clock() - replacedAt < run("SETTLE_UNKNOWN_MS"),
      `le remplacement a redémarré la fenêtre : +${virtual.clock() - replacedAt} ms`,
    );
  }

  // --- 8. FINAL est terminal : un observer tardif ne produit pas un 2e done - //
  {
    const sent = [];
    const { window, run } = loadExtension(MODERN_PAGE);
    const { virtual } = await runPrompt({
      window,
      run,
      sent,
      id: "req-at-most-once",
      render: (transcript) => {
        transcript.innerHTML = answerRoot(inlineText("BRIDGE_OK"));
      },
    });
    assert.equal(terminalMessages(sent).length, 1);

    // Mutations tardives : React peut encore réécrire le tour après la fin.
    const transcript = window.document.querySelector("#transcript");
    transcript.insertAdjacentHTML("beforeend", COPY_BUTTON);
    transcript
      .querySelector("[class*='MarkdownRoot-']")
      .insertAdjacentHTML("beforeend", inlineText("texte tardif", "Z"));
    await new Promise((resolve) => window.setTimeout(resolve, 60_000));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      terminalMessages(sent).length,
      1,
      "une mutation tardive ne produit jamais un second done",
    );
    assert.equal(
      sent.filter((message) => message.type === "done").length,
      0,
      "aucun done n'est fabriqué après coup",
    );
    assert.equal(
      run("activeDomWatchers.size"),
      0,
      "aucun observateur ne survit au job",
    );
    assert.ok(virtual.clock() >= 60_000);
  }

  console.log("finalization state contract: ok");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
