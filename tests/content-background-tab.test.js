/**
 * Autonomie en onglet d'arrière-plan.
 *
 * L'onglet de génération est créé volontairement inactif (`active: false`).
 * L'observation manuelle rapportée était : « le pont ne semble consommer la
 * réponse qu'après un clic sur l'onglet ChatGPT ». Ce fichier reproduit un run
 * complet dans un onglet qui reste MASQUÉ et SANS FOCUS du début à la fin, avec
 * des minuteries throttlées comme le fait Chrome, et prouve que :
 *
 *   - le prompt est soumis exactement une fois ;
 *   - `.streaming-animation` maintient l'observation pendant une recherche
 *     longue sans jamais produire `active_signal_stalled` (sémantique v29) ;
 *   - les heartbeats continuent, sans contenu ;
 *   - le `done` final est émis sans qu'aucun focus, clic ou activation
 *     n'intervienne ;
 *   - la latence de détection ne dépend pas de la minuterie throttlée.
 *
 * Limite assumée : jsdom ne modélise pas le throttling de Chrome. Il est donc
 * modélisé explicitement ci-dessous (1 s en arrière-plan, puis 1 min au-delà de
 * cinq minutes masquées, ce que Chrome appelle « intensive throttling »). Le
 * gel complet d'un onglet (freezing) et son déchargement (discard) ne sont pas
 * modélisables ici : le discard est couvert côté service worker dans
 * `background-conversation.test.js`, le freezing par la procédure manuelle de
 * `docs/chatgpt_bridge_operations.md`.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");

const EXTENSION = path.join(__dirname, "..", "extension");

/** Modèle du throttling Chrome : 1 s en arrière-plan, 1 min après 5 min masqué. */
const BACKGROUND_THROTTLE_MS = 1000;
const INTENSIVE_THROTTLE_AFTER_MS = 300_000;
const INTENSIVE_THROTTLE_MS = 60_000;
/** Cadence du ping serveur, donc de l'`observe_tick` du service worker. */
const OBSERVE_TICK_MS = 20_000;

const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Charge l'extension dans un onglet simulé masqué et non focalisé, avec une
 * boucle d'évènements virtuelle : minuteries throttlées d'un côté, rendus DOM
 * de ChatGPT et ticks du service worker de l'autre (jamais throttlés — ils sont
 * pilotés par le réseau et par le service worker, pas par la page).
 */
function loadHiddenTab(body, url = "https://chatgpt.com/?temporary-chat=true") {
  const dom = new JSDOM(`<!doctype html><html><body>${body}</body></html>`, {
    runScripts: "outside-only",
    url,
  });
  const { window } = dom;

  window.Element.prototype.getClientRects = function getClientRects() {
    return this.hasAttribute("data-test-offscreen") ? [] : [{}];
  };
  window.CSS = window.CSS || {
    escape: (value) => String(value).replace(/["\\]/g, "\\$&"),
  };
  // jsdom ne fournit pas `TextEncoder`, natif dans Chrome : le content script
  // s'en sert pour mesurer la taille UTF-8 du prompt.
  window.TextEncoder = TextEncoder;

  // Onglet d'arrière-plan : masqué, sans focus, pour toute la durée du test.
  Object.defineProperty(window.Document.prototype, "visibilityState", {
    configurable: true,
    get: () => "hidden",
  });
  Object.defineProperty(window.Document.prototype, "hidden", {
    configurable: true,
    get: () => true,
  });
  let hasFocusCalls = 0;
  window.document.hasFocus = () => {
    hasFocusCalls += 1;
    return false;
  };
  let windowFocusCalls = 0;
  window.focus = () => {
    windowFocusCalls += 1;
  };

  const messageListeners = [];
  const sent = [];
  window.chrome = {
    storage: { local: { get: async () => ({}), set: async () => {} } },
    runtime: {
      sendMessage: async (message) => {
        sent.push(message);
      },
      onMessage: {
        addListener: (listener) => messageListeners.push(listener),
      },
    },
  };

  // --- Boucle d'évènements virtuelle ---------------------------------------- //
  let clock = 0;
  let seq = 0;
  const queue = [];
  const schedule = (time, fn, kind) => {
    queue.push({ time, seq: (seq += 1), fn, kind });
  };
  const timerFloor = () =>
    clock >= INTENSIVE_THROTTLE_AFTER_MS
      ? INTENSIVE_THROTTLE_MS
      : BACKGROUND_THROTTLE_MS;

  window.Date.now = () => clock;
  window.setTimeout = (fn, ms) => {
    schedule(clock + Math.max(Math.max(0, ms || 0), timerFloor()), fn, "timer");
    return seq;
  };
  window.clearTimeout = () => {};

  const context = dom.getInternalVMContext();
  for (const file of [
    "serializer.js",
    "completion.js",
    "final-output.js",
    "content.js",
  ]) {
    vm.runInContext(fs.readFileSync(path.join(EXTENSION, file), "utf8"), context, {
      filename: file,
    });
  }

  const kinds = { timer: 0, dom: 0, tick: 0 };

  return {
    window,
    sent,
    kinds,
    run: (expression) => vm.runInContext(expression, context),
    now: () => clock,
    focusCounters: () => ({
      has_focus_calls: hasFocusCalls,
      window_focus_calls: windowFocusCalls,
    }),
    /** Rendu de ChatGPT : piloté par le réseau, jamais par une minuterie de page. */
    renderAt: (time, fn) => schedule(time, fn, "dom"),
    /** Tick d'observation du service worker, cadencé par le ping serveur. */
    startObservationTicks: (requestId) => {
      const beat = (time) => {
        schedule(
          time,
          () => {
            for (const listener of messageListeners) {
              listener({ type: "observe_tick", id: requestId }, {}, () => {});
            }
            beat(time + OBSERVE_TICK_MS);
          },
          "tick",
        );
      };
      beat(OBSERVE_TICK_MS);
    },
    /** Déroule la boucle virtuelle jusqu'à `until()` ou épuisement des évènements. */
    drain: async (until, maxSteps = 20_000) => {
      for (let step = 0; step < maxSteps; step += 1) {
        await flushMicrotasks();
        if (until()) return true;
        if (!queue.length) return until();
        queue.sort((a, b) => a.time - b.time || a.seq - b.seq);
        const next = queue.shift();
        clock = Math.max(clock, next.time);
        kinds[next.kind] += 1;
        next.fn();
      }
      return until();
    },
  };
}

const COMPOSER = `<form id="composer-form">
  <textarea data-id="prompt"></textarea>
  <button aria-disabled="false" id="composer-submit-button" data-testid="send-button">Send</button>
</form>`;

const COPY_BUTTON = `<button data-testid="copy-turn-action-button">Copy response</button>`;
const FINAL_TEXT = "réponse finale de la recherche approfondie";

/**
 * Scénario commun : onglet masqué, un seul Send, un tour assistant qui reste en
 * `.streaming-animation` pendant plus de dix minutes sans que son texte bouge,
 * puis le rendu final. Aucun clic, aucun focus, aucune activation.
 */
async function runHiddenGeneration({
  observationTicks,
  multiMutationFinal = false,
  preRunFocus = false,
}) {
  const tab = loadHiddenTab(COMPOSER);
  const { window, run, sent } = tab;
  const requestId = observationTicks ? "req-hidden-ticks" : "req-hidden-no-ticks";

  let submitEvents = 0;
  let sendClicks = 0;
  let clicksAfterSubmission = 0;
  window.document
    .querySelector("button[data-testid='send-button']")
    .addEventListener("click", () => {
      sendClicks += 1;
    });
  window.document.addEventListener("click", () => {
    if (submitEvents) clicksAfterSubmission += 1;
  });
  window.document
    .querySelector("#composer-form")
    .addEventListener("submit", (event) => {
      submitEvents += 1;
      event.preventDefault();
      window.document.querySelector("textarea[data-id='prompt']").value = "";
    });

  // Rendu de ChatGPT, aux instants où le réseau le produit — jamais lié à la
  // cadence des minuteries de la page.
  const turn = () => window.document.querySelector("#watched");
  tab.renderAt(20_000, () => {
    window.document.body.insertAdjacentHTML(
      "beforeend",
      `<article data-testid="conversation-turn-1">
         <div id="watched" data-message-author-role="assistant" data-message-id="msg-hidden-1">
           <div class="markdown"><p>Recherche en cours</p></div>
           <div class="streaming-animation"></div>
         </div>
       </article>`,
    );
  });
  // Plateau de recherche : plus aucune mutation de texte pendant ~10 minutes.
  // Seul `.streaming-animation` dit que ChatGPT travaille encore.
  const finalizedAt = 660_000;
  if (multiMutationFinal) {
    // React-style final rendering: three separate DOM batches, with no
    // foreground 120 ms timer cadence at this point in the hidden tab.
    tab.renderAt(finalizedAt, () => {
      turn().querySelector(".markdown").innerHTML = `<p>${FINAL_TEXT}</p>`;
    });
    tab.renderAt(finalizedAt, () => {
      turn().querySelector(".streaming-animation").remove();
    });
    tab.renderAt(finalizedAt, () => {
      turn().closest("article").insertAdjacentHTML("beforeend", COPY_BUTTON);
    });
    // Separate post-final mutations provide enough real observations for
    // MIN_STALL_OBSERVATIONS before the next hidden-page timer wake arrives.
    for (const offset of [100, 200, 60_100, 60_200]) {
      tab.renderAt(finalizedAt + offset, () => {
        turn().closest("article").setAttribute("data-state", `settled-${offset}`);
      });
    }
  } else {
    tab.renderAt(finalizedAt, () => {
      turn().querySelector(".markdown").innerHTML = `<p>${FINAL_TEXT}</p>`;
      turn().querySelector(".streaming-animation").remove();
      turn().closest("article").insertAdjacentHTML("beforeend", COPY_BUTTON);
    });
  }

  if (observationTicks) tab.startObservationTicks(requestId);

  if (preRunFocus) window.dispatchEvent(new window.Event("focus"));

  let finished = false;
  run(`globalThis.__hiddenRun = handlePrompt(${JSON.stringify({
    id: requestId,
    prompt: "question de production",
    new_chat: true,
    conversation: { id: "conv-hidden", mode: "fresh" },
  })})`);
  run(`globalThis.__hiddenRun.then(() => { globalThis.__hiddenDone = true; })`);

  const completed = await tab.drain(() => {
    finished = run("globalThis.__hiddenDone === true");
    return finished;
  });

  return {
    tab,
    sent,
    completed,
    finalizedAt,
    doneAt: tab.now(),
    submitEvents,
    sendClicks,
    clicksAfterSubmission,
  };
}

(async () => {
  // --- 1. Onglet masqué + ticks du service worker : cas nominal -------------- //
  {
    const result = await runHiddenGeneration({ observationTicks: true });
    assert.ok(result.completed, "le run doit se terminer sans focus");

    const done = result.sent.find((message) => message.type === "done");
    const errors = result.sent.filter((message) => message.type === "error");
    const incompletes = result.sent.filter(
      (message) => message.type === "incomplete",
    );
    assert.deepEqual(errors, [], "aucune erreur ne doit être émise");
    assert.deepEqual(incompletes, [], "aucun incomplete : la fin est réelle");
    assert.ok(done, "un `done` final doit être émis, onglet masqué");
    assert.equal(done.text, FINAL_TEXT);
    assert.equal(done.metadata.initial_turn_id, "msg-hidden-1");
    assert.equal(done.conversation.turn_id, "msg-hidden-1");
    assert.equal(done.metadata.content_script_version, "33");

    // Exactement une soumission, jamais un clic de secours.
    assert.equal(result.submitEvents, 1, "exactement un prompt soumis");
    assert.equal(result.sendClicks, 0, "aucun clic synthétique sur Envoyer");
    assert.equal(
      result.clicksAfterSubmission,
      0,
      "aucun clic dans la page après la soumission",
    );
    assert.equal(
      result.tab.focusCounters().window_focus_calls,
      0,
      "le content script ne doit jamais appeler window.focus()",
    );

    // Le diagnostic prouve l'autonomie : masqué, sans focus, sans aucun retour
    // au premier plan pendant tout le run.
    const pageState = JSON.parse(JSON.stringify(done.metadata.page_state));
    assert.equal(pageState.visibility_state, "hidden");
    assert.equal(pageState.hidden, true);
    assert.equal(pageState.has_focus, false);
    assert.equal(pageState.focus_gains, 0);
    assert.equal(pageState.visible_transitions, 0);
    assert.equal(pageState.focus_gains_during_run, 0);
    assert.equal(pageState.visible_transitions_during_run, 0);
    assert.equal(pageState.started_visibility_state, "hidden");
    assert.equal(pageState.started_hidden, true);
    assert.equal(pageState.started_has_focus, false);
    assert.ok(
      pageState.wake_mutation > 0,
      "la boucle doit avoir été réveillée par des mutations DOM",
    );
    assert.ok(
      pageState.wake_tick > 0,
      "la boucle doit avoir été réveillée par les ticks du service worker",
    );

    // Heartbeats : présents pendant toute la recherche, et sans contenu.
    const heartbeats = result.sent.filter(
      (message) => message.type === "heartbeat",
    );
    assert.ok(
      heartbeats.length >= 5,
      `heartbeats insuffisants pendant la recherche : ${heartbeats.length}`,
    );
    const heartbeatJson = JSON.stringify(heartbeats);
    assert.ok(
      !heartbeatJson.includes("question de production"),
      "un heartbeat ne doit jamais contenir le prompt",
    );
    assert.ok(
      !heartbeatJson.includes(FINAL_TEXT),
      "un heartbeat ne doit jamais contenir la réponse",
    );
    assert.ok(
      heartbeats.every(
        (message) => message.progress.page_state.visibility_state === "hidden",
      ),
      "chaque heartbeat doit rapporter l'état de plan réel de l'onglet",
    );

    // Sémantique v29 : `.streaming-animation` visible + texte figé pendant plus
    // de WATCHED_TURN_ACTIVE_SIGNAL_STALL_MS n'est jamais un stall.
    assert.ok(
      result.finalizedAt >
        result.tab.run("WATCHED_TURN_ACTIVE_SIGNAL_STALL_MS") + 60_000,
      "le plateau doit dépasser le garde-fou de stall pour être probant",
    );

    // La détection ne dépend pas de la minuterie throttlée : à ce stade du run,
    // un réveil purement minuté coûterait au moins deux tours d'une minute.
    const detectionLag = result.doneAt - result.finalizedAt;
    assert.ok(
      detectionLag < INTENSIVE_THROTTLE_MS,
      `détection trop lente (${detectionLag} ms) : elle dépend encore de la minuterie`,
    );
  }

  // --- 2. Sans aucun tick : la correction ne dépend pas du service worker ---- //
  // Le pont doit rester correct si le serveur ne ping plus : seule la latence
  // de détection augmente, jamais le résultat, et jamais un besoin de focus.
  {
    const result = await runHiddenGeneration({ observationTicks: false });
    assert.ok(result.completed, "le run doit se terminer même sans tick");
    const done = result.sent.find((message) => message.type === "done");
    assert.ok(done, "un `done` final doit être émis sans tick, onglet masqué");
    assert.equal(done.text, FINAL_TEXT);
    assert.equal(result.submitEvents, 1, "exactement un prompt soumis");
    assert.equal(
      JSON.parse(JSON.stringify(done.metadata.page_state)).focus_gains,
      0,
      "aucun retour au premier plan n'a été nécessaire",
    );
  }

  // --- 3. Rendu final multi-mutations + réveil minuté throttlé -------------- //
  {
    const result = await runHiddenGeneration({
      observationTicks: false,
      multiMutationFinal: true,
    });
    const done = result.sent.find((message) => message.type === "done");
    const terminal = result.sent.filter((message) =>
      ["done", "incomplete", "error"].includes(message.type),
    );
    const pageState = JSON.parse(JSON.stringify(done?.metadata?.page_state));

    assert.equal(result.completed, true);
    assert.equal(terminal.length, 1, "un seul résultat terminal doit être émis");
    assert.ok(done, "la finalité explicite doit produire done");
    assert.equal(done.text, FINAL_TEXT);
    assert.equal(done.metadata.completion_signal, "assistant_actions");
    assert.equal(done.metadata.initial_turn_id, "msg-hidden-1");
    assert.equal(done.conversation.turn_id, "msg-hidden-1");
    assert.ok(
      done.metadata.stable_for_ms > result.tab.run("FINALIZATION_STALL_MS"),
      "le test doit dépasser le seuil de finalisation avant le réveil tardif",
    );
    assert.ok(
      pageState.stable_observations >= result.tab.run("MIN_STALL_OBSERVATIONS"),
      "des observations stables suffisantes doivent précéder le réveil tardif",
    );
    assert.ok(
      pageState.wake_mutation >= 3,
      "les mutations Markdown / animation / barre d'actions doivent réveiller la boucle",
    );
    assert.ok(
      result.doneAt - result.finalizedAt >= INTENSIVE_THROTTLE_MS,
      `le résultat doit attendre le timer caché (~60 s), délai=${result.doneAt - result.finalizedAt}`,
    );
    assert.equal(result.submitEvents, 1, "exactement une soumission");
    assert.equal(result.sendClicks, 0, "aucun clic d'envoi");
    assert.equal(result.tab.focusCounters().window_focus_calls, 0);
  }

  // --- 4. Un focus historique ne pollue pas le diagnostic du run ------------ //
  {
    const result = await runHiddenGeneration({
      observationTicks: true,
      preRunFocus: true,
    });
    const done = result.sent.find((message) => message.type === "done");
    const pageState = JSON.parse(JSON.stringify(done.metadata.page_state));

    assert.ok(
      pageState.focus_gains >= 1,
      "le compteur cumulatif conserve l'événement historique",
    );
    assert.equal(pageState.focus_gains_during_run, 0);
    assert.equal(pageState.visible_transitions_during_run, 0);
    assert.equal(pageState.started_visibility_state, "hidden");
    assert.equal(pageState.started_hidden, true);
    assert.equal(pageState.started_has_focus, false);
  }

  // --- 5. Les observateurs ne fuient pas d'un run à l'autre ------------------ //
  {
    const result = await runHiddenGeneration({ observationTicks: true });
    assert.equal(
      result.tab.run("activeDomWatchers.size"),
      0,
      "aucun MutationObserver ne doit survivre à la fin du job",
    );
  }

  console.log("background tab autonomy contract: ok");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
