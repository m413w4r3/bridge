/**
 * Content script injecté sur chatgpt.com : reçoit un prompt du service worker,
 * le tape dans le composer, puis observe le DOM avant de renvoyer un snapshot final.
 *
 * Tous les sélecteurs dépendants de l'UI OpenAI sont regroupés dans SELECTORS
 * ci-dessous : c'est le seul bloc à retoucher si l'interface change.
 */

// Affichée au chargement : permet de vérifier dans la console quel code tourne
// réellement dans l'onglet (recharger l'extension ne suffit pas à le remplacer).
const VERSION = "31";

// Journalise dans la console les décisions de la boucle de streaming, à chaque
// changement d'état. Utile quand l'UI d'OpenAI change et qu'une réponse arrive
// tronquée ou dupliquée : la ligne indique l'état de fin détecté, le conteneur
// lu et le nombre de blocs de code vus.
const DEBUG = false;

const SELECTORS = {
  composer: [
    "#prompt-textarea",
    "div[contenteditable='true'][id^='prompt']",
    "textarea[data-id]",
  ],
  send: [
    "button[data-testid='send-button']",
    "#composer-submit-button",
    "button[aria-label*='Envoyer']",
    "button[aria-label*='Send']",
  ],
  stop: [
    "button[data-testid='stop-button']",
    "button[aria-label*='Stop']",
    "button[aria-label*='rrêter']",
  ],
  fileInput: ["input[type='file']"],
  assistant: "[data-message-author-role='assistant']",
  user: "[data-message-author-role='user']",
  markdown: ".markdown",
  // Conteneurs de la phase de réflexion : leur texte n'est pas la réponse.
  reasoning: [
    "[data-testid*='thinking']",
    "[data-testid*='reasoning']",
    "[data-testid*='thought']",
    "[data-message-model-slug] details",
  ],
  // Barre d'actions rendue sous une réponse *terminée* : signal de fin le plus
  // fiable, car elle n'existe pas tant que ChatGPT écrit (ni pendant sa réflexion).
  turnActions: [
    "[data-testid='copy-turn-action-button']",
    "button[data-testid*='copy-turn']",
    "button[aria-label*='Copier']",
    "button[aria-label*='Copy response']",
  ],
  // Conteneur d'un échange complet. La barre d'actions vit ici, *au-dessus* du
  // div [data-message-author-role] : chercher dans le seul tour ne la trouve pas.
  turnContainer: ["[data-testid^='conversation-turn']", "article"],
  // Indicateurs « ChatGPT écrit encore ». Un seul point de vérité : la boucle de
  // génération, la confirmation de soumission et les diagnostics de stall
  // doivent parler du même ensemble de détecteurs.
  streaming: [
    ".streaming-animation",
    ".result-streaming",
    "[data-is-streaming='true']",
  ],
  // Sous-ensemble de `streaming` dont la production a prouvé qu'il peut rester
  // allumé plusieurs minutes SANS mutation de texte, pendant une recherche
  // approfondie (deux runs indépendants : 300 003 ms et 352 002 ms de stabilité,
  // puis le même tour a produit la vraie réponse finale). Pour ces détecteurs,
  // « le texte n'a pas bougé » ne prouve rien : seule la borne totale du serveur
  // fait autorité. Les autres détecteurs conservent le garde-fou local.
  longRunningStreaming: [".streaming-animation"],

  // --- Contrôles de l'interface (cf. section « Contrôles typés » plus bas) --- //
  // Déclencheur du sélecteur de modèle, dans l'en-tête de la conversation.
  modelTrigger: [
    "button[data-testid='model-switcher-dropdown-button']",
    "[data-testid='model-switcher-dropdown-button']",
    "button[aria-label*='Modèle']",
    "button[aria-label*='Model']",
  ],
  // Déclencheur du sélecteur de compte / espace de travail.
  profileTrigger: [
    "button[data-testid='accounts-profile-button']",
    "[data-testid='accounts-profile-button']",
    "button[aria-label*='Profil']",
    "button[aria-label*='Account']",
  ],
  // Menu ouvert, et ses entrées (Radix : role=menu / menuitem).
  menu: ["[role='menu']", "[role='listbox']"],
  menuItem: ["[role='menuitem']", "[role='menuitemradio']", "[role='option']"],
  // Bouton dédié à la recherche web, cherché *dans le composer* uniquement :
  // la barre latérale a elle aussi un bouton « Rechercher » (dans les chats).
  searchToggle: [
    "button[data-testid='composer-button-search']",
    "button[data-testid*='search']",
    "button[aria-label*='Recherche web']",
    "button[aria-label*='Search the web']",
  ],
  // Menu d'outils du composer (« + »), où la recherche se trouve dans certaines
  // versions de l'UI au lieu d'un bouton dédié.
  toolsTrigger: [
    "button[data-testid='composer-plus-btn']",
    "button[id^='system-hint']",
    "button[aria-haspopup='menu'][aria-label*='Ajouter']",
  ],

  // --- Conversation éphémère --- //
  // Bascule « Temporary chat » : rend la conversation non sauvegardée dans
  // l'historique ChatGPT, ce qui évite d'avoir à la supprimer après coup.
  temporaryChatToggle: [
    "button[aria-label='Temporary chat']",
    "button[aria-label*='Temporary chat']",
    "button[aria-label*='temporaire']",
  ],
};

// Libellés reconnus comme « recherche web » dans un menu d'outils (FR/EN).
const MOTS_RECHERCHE =
  /recherche web|rechercher sur le web|search the web|web search/;
// Entrée d'un menu de modèles repliant les autres modèles dans un sous-menu.
const MOTS_PLUS_MODELES = /plus de mod|autres mod|more models|legacy models/;

const POLL_MS = 120;
// Réveil minimal entre deux itérations d'observation quand c'est une mutation
// (et non la minuterie) qui réveille la boucle : une tempête de mutations ne
// doit pas transformer l'observation en boucle serrée. Aucune conséquence sur
// la sémantique : la boucle est idempotente, seul son coût CPU est borné ici.
const OBSERVER_MIN_INTERVAL_MS = 100;
// Attributs dont la mutation change une décision de fin. Volontairement fermé :
// observer tous les attributs de chatgpt.com produirait un bruit inutile.
const OBSERVED_ATTRIBUTES = [
  "class",
  "data-is-streaming",
  "data-message-id",
  "data-testid",
  "data-state",
  "aria-hidden",
  "aria-label",
  "open",
];
// La première fenêtre reste courte pour rendre rapidement un diagnostic, mais
// elle n'est plus la borne de la soumission. Après celle-ci, on conserve le
// même job et le même onglet dans une phase ambiguë jusqu'à cette borne finale.
const SUBMISSION_CONFIRMATION_TIMEOUT_MS = 5000;
const SUBMISSION_CONFIRMATION_FINAL_TIMEOUT_MS = 20000;
const UPLOAD_TIMEOUT_MS = 120000; // upload des pièces jointes

const SETTLE_MS = 2000; // fin UI confirmée
const SETTLE_UNKNOWN_MS = 15000; // pas de signal UI fiable : prudence
const EMPTY_FINAL_SETTLE_MS = 10000;
const NO_MARKDOWN_FALLBACK_MS = 25000;
const HEARTBEAT_INTERVAL_MS = 5000;
const RUNTIME_METRICS_INTERVAL_MS = 30000;

// Une réponse non vide et inchangée ne doit jamais rester "running"
// pendant plusieurs minutes uniquement à cause d'un signal DOM périmé.
const FINALIZATION_STALL_MS = 45000;

// Un « figé » se mesure en durée ET en nombre d'observations réelles.
//
// Chrome throttle les minuteries d'un onglet masqué : au-delà de cinq minutes
// cachées, une itération de la boucle peut ne revenir qu'une minute plus tard.
// Une seule itération fait alors bondir `stable_for_ms` de 0 à 60 000 ms, et
// tous les garde-fous ci-dessous se déclenchent d'un coup — y compris sur une
// réponse parfaitement terminée, qui partait en `incomplete` au lieu d'un
// `done` (mesuré : réponse finale rendue, `completion_signal=assistant_actions`,
// `finalization_stalled` à la première observation suivante). Exiger plusieurs
// observations distinctes distingue « la boucle a vraiment tourné sans jamais
// conclure » de « la boucle n'a tourné qu'une fois, tard ».
const MIN_STALL_OBSERVATIONS = 3;

// Deux garde-fous distincts, longtemps confondus sous un même nom.
//
// 1) AVANT le premier tour assistant : rien n'est encore observable côté
//    réponse, seule l'activité des signaux de génération dit que quelque chose
//    se passe. Une UI totalement figée après Send doit échouer de façon bornée,
//    sans attendre la borne totale du serveur.
const FIRST_ASSISTANT_ACTIVITY_STALL_MS = 300000;

// 2) APRÈS le premier tour assistant : l'UI se prétend encore active
//    (`finished=false`, donc le garde-fou de finalisation ci-dessus est
//    désarmé) alors que la réponse n'a plus bougé d'un caractère. On ne conclut
//    pas « terminé » — un Stop réellement visible peut signifier que ChatGPT
//    travaille — mais on rend la main en `incomplete` plutôt que de rester
//    « running » indéfiniment.
//    Exception : cf. `longRunningStreamingSignalActive()` — quand
//    `.streaming-animation` est visible dans le tour surveillé, la stabilité du
//    texte n'est PAS une preuve d'échec et ce garde-fou est désarmé ; la borne
//    dure redevient alors le `bridge_total_timeout` du serveur.
const WATCHED_TURN_ACTIVE_SIGNAL_STALL_MS = 300000;

let currentJob = null;
const claimedRequestIds = new Set();
let persistedRequestIdsPromise = chrome.storage.local
  .get("submittedRequestIds")
  .then(({ submittedRequestIds }) => new Set(submittedRequestIds || []));

async function claimPrompt(id) {
  if (claimedRequestIds.has(id)) return false;
  claimedRequestIds.add(id);
  const persisted = await persistedRequestIdsPromise;
  if (persisted.has(id)) return false;
  // Persister avant toute manipulation du DOM : après un arrêt du content
  // script, la sécurité at-most-once prime sur une resoumission implicite.
  persisted.add(id);
  const bounded = [...persisted].slice(-1000);
  persistedRequestIdsPromise = Promise.resolve(new Set(bounded));
  await chrome.storage.local.set({ submittedRequestIds: bounded });
  return true;
}

// --------------------------------------------------------------------------- //
// Utilitaires DOM
// --------------------------------------------------------------------------- //
/** Premier élément de `root` correspondant à l'un des sélecteurs, dans l'ordre. */
const $in = (root, list) => {
  for (const sel of list) {
    const el = root.querySelector(sel);
    if (el) return el;
  }
  return null;
};

const $ = (list) => $in(document, list);

/** Premier ancêtre de `el` correspondant à l'un des sélecteurs. */
const closestOf = (el, list) => {
  for (const sel of list) {
    const found = el.closest(sel);
    if (found) return found;
  }
  return null;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeout, label) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = fn();
    if (value) return value;
    await sleep(100);
  }
  throw new Error(`Timeout : ${label}`);
}

// --------------------------------------------------------------------------- //
// Autonomie en arrière-plan : diagnostics d'état de page et réveil événementiel
//
// Un onglet de génération est créé volontairement en arrière-plan (`active:
// false`) et ne doit jamais avoir besoin d'être focalisé pour qu'une réponse
// soit consommée. Chrome ralentit pourtant les minuteries d'une page masquée
// (jusqu'à une exécution par minute au-delà de cinq minutes), ce qui rend une
// boucle uniquement minutée lente à *constater* une fin déjà rendue.
//
// Trois sources de réveil indépendantes sont donc combinées, sans qu'aucune ne
// puisse produire un `done` ni un heartbeat à elle seule :
//   - MutationObserver : non soumis au throttling des minuteries ;
//   - tick du service worker (`observe_tick`), cadencé par le ping serveur ;
//   - minuterie `POLL_MS`, repli borné, throttlée mais jamais supprimée.
// --------------------------------------------------------------------------- //

/**
 * Compteurs de passage au premier plan, sans contenu. Ils rendent vérifiable
 * après coup la seule question qui compte : la détection de la fin a-t-elle été
 * précédée d'un focus humain ? `focus_gains === 0` et `visible_transitions === 0`
 * sur tout un run prouvent une complétion autonome, onglet masqué.
 */
const foregroundActivity = { visible_transitions: 0, focus_gains: 0 };
try {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      foregroundActivity.visible_transitions += 1;
    }
  });
  globalThis.addEventListener?.("focus", () => {
    foregroundActivity.focus_gains += 1;
  });
} catch (_) {
  // Un diagnostic absent ne doit jamais empêcher une génération.
}

function documentHasFocus() {
  try {
    return typeof document.hasFocus === "function" ? document.hasFocus() : null;
  } catch (_) {
    return null;
  }
}

/** Snapshot immuable du début d'un run : les deltas restent propres à ce run. */
function captureRunStartDiagnostics() {
  return {
    started_visibility_state: document.visibilityState ?? null,
    started_hidden:
      typeof document.hidden === "boolean" ? document.hidden : null,
    started_has_focus: documentHasFocus(),
    visible_transitions: foregroundActivity.visible_transitions,
    focus_gains: foregroundActivity.focus_gains,
  };
}

/**
 * État de plan de la page et fraîcheur des trois horloges d'observation.
 * Strictement sans contenu : états standards et durées uniquement — jamais de
 * texte, de HTML ni d'attribut arbitraire du DOM.
 */
function pageStateDiagnostics(now, sources = {}) {
  const since = (value) =>
    Number.isFinite(value) && value > 0 ? Math.max(0, now - value) : null;
  const watcher = sources.watcher;
  const run = sources.run;
  const delta = (current, baseline) =>
    Number.isInteger(current) &&
    Number.isInteger(baseline) &&
    current >= baseline
      ? current - baseline
      : 0;
  return {
    visibility_state: document.visibilityState ?? null,
    hidden: document.hidden ?? null,
    has_focus: documentHasFocus(),
    visible_transitions: foregroundActivity.visible_transitions,
    focus_gains: foregroundActivity.focus_gains,
    ...(run
      ? {
          started_visibility_state: run.started_visibility_state,
          started_hidden: run.started_hidden,
          started_has_focus: run.started_has_focus,
          focus_gains_during_run: delta(
            foregroundActivity.focus_gains,
            run.focus_gains,
          ),
          visible_transitions_during_run: delta(
            foregroundActivity.visible_transitions,
            run.visible_transitions,
          ),
        }
      : {}),
    ...(Number.isInteger(sources.stableObservations) &&
    sources.stableObservations >= 0
      ? { stable_observations: sources.stableObservations }
      : {}),
    ms_since_dom_mutation: since(watcher ? watcher.lastMutationAt : null),
    ms_since_observation: since(sources.lastObservationAt),
    ms_since_heartbeat: since(sources.lastHeartbeatAt),
    wake_mutation: watcher ? watcher.wakes.mutation : 0,
    wake_tick: watcher ? watcher.wakes.tick : 0,
    wake_timer: watcher ? watcher.wakes.timer : 0,
  };
}

/** Observateurs vivants : garantit qu'aucun ne survit à la fin d'un job. */
const activeDomWatchers = new Set();

/**
 * Réveille la boucle d'observation sur mutation du DOM, avec repli minuté.
 *
 * `wait(ms)` résout dès qu'une mutation pertinente survient (au plus une fois
 * par `OBSERVER_MIN_INTERVAL_MS`), sinon à l'expiration de la minuterie. Le
 * réveil ne décide jamais rien : il rend seulement la main à la boucle, qui
 * relit le DOM et applique exactement les mêmes règles qu'avant.
 */
function createDomWatcher(label) {
  const watcher = {
    label,
    lastMutationAt: 0,
    mutations: 0,
    wakes: { mutation: 0, tick: 0, timer: 0 },
    disconnected: false,
    pending: null,
    armedAt: 0,
  };

  const settle = (reason) => {
    const pending = watcher.pending;
    if (!pending) return false;
    if (
      reason !== "timer" &&
      reason !== "disconnected" &&
      Date.now() - watcher.armedAt < OBSERVER_MIN_INTERVAL_MS
    ) {
      return false;
    }
    watcher.pending = null;
    if (watcher.wakes[reason] !== undefined) watcher.wakes[reason] += 1;
    pending(reason);
    return true;
  };

  let observer = null;
  try {
    observer = new MutationObserver(() => {
      watcher.lastMutationAt = Date.now();
      watcher.mutations += 1;
      settle("mutation");
    });
    // Portée : la racine du document. Le tour surveillé est remplacé par React
    // entre réflexion, streaming et rendu final — observer un nœud de tour
    // laisserait l'observateur attaché à un nœud détaché. La portée large est
    // compensée par un filtre d'attributs fermé et un callback trivial.
    observer.observe(document.documentElement || document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: OBSERVED_ATTRIBUTES,
    });
  } catch (_) {
    // Pas de MutationObserver : la boucle retombe sur sa minuterie, comme avant.
    observer = null;
  }

  watcher.wake = (reason) => settle(reason);

  watcher.wait = (ms) =>
    new Promise((resolve) => {
      if (watcher.disconnected) {
        setTimeout(() => resolve("timer"), ms);
        return;
      }
      watcher.armedAt = Date.now();
      watcher.pending = resolve;
      setTimeout(() => {
        if (watcher.pending !== resolve) return;
        watcher.pending = null;
        watcher.wakes.timer += 1;
        resolve("timer");
      }, ms);
    });

  watcher.disconnect = () => {
    if (watcher.disconnected) return;
    watcher.disconnected = true;
    if (observer) observer.disconnect();
    activeDomWatchers.delete(watcher);
    settle("disconnected");
  };

  activeDomWatchers.add(watcher);
  return watcher;
}

/** Aucun observateur ne doit survivre à un job : appelé en fin de handlePrompt. */
function disconnectDomWatchers() {
  for (const watcher of [...activeDomWatchers]) watcher.disconnect();
}

/**
 * Tick d'observation émis par le service worker (cadencé par le ping serveur).
 * C'est une horloge que le throttling d'arrière-plan n'atteint pas — mais elle
 * ne prouve rien : elle réveille la boucle, qui reste seule à lire le DOM, à
 * émettre les heartbeats et à conclure.
 */
function handleObservationTick(msg) {
  if (!currentJob || currentJob.id !== msg?.id) return false;
  let woken = false;
  for (const watcher of activeDomWatchers) {
    if (watcher.wake("tick")) woken = true;
  }
  return woken;
}

function composerText(el) {
  if (!el) return "";
  if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") return el.value || "";
  return el.innerText || el.textContent || "";
}

function isSendButtonReady(button) {
  if (!button || button.disabled === true) return false;
  return button.getAttribute("aria-disabled") !== "true";
}

function submissionForm(composer, sendBtn) {
  const form = sendBtn?.form || sendBtn?.closest("form") || composer?.closest("form");
  if (!form) return null;
  if (typeof form.requestSubmit !== "function") return null;
  if (!(form === sendBtn.form || form.contains(sendBtn))) return null;
  return form;
}

function triggerComposerSubmission(composer, sendBtn) {
  const form = submissionForm(composer, sendBtn);
  const method = form ? "requestSubmit" : "click";
  console.log("bridge_run_phase", {
    phase: "send_ready",
    button_id: sendBtn.id || null,
    aria_disabled: sendBtn.getAttribute("aria-disabled"),
    disabled: sendBtn.disabled,
    has_form: Boolean(form),
    submission_method: method,
  });
  if (form) form.requestSubmit(sendBtn);
  else sendBtn.click();
  return method;
}

function submissionSignalVisible(element) {
  if (!element || element.getAttribute?.("aria-hidden") === "true") return false;
  const style = globalThis.getComputedStyle?.(element);
  if (style?.display === "none" || style?.visibility === "hidden") return false;
  return (
    typeof element.getClientRects !== "function" ||
    element.getClientRects().length > 0
  );
}

function activeSubmissionSignals(selectors, predicate = submissionSignalVisible) {
  const result = [];
  for (const selector of selectors) {
    for (const element of document.querySelectorAll(selector)) {
      if (predicate(element)) result.push(element);
    }
  }
  return result;
}

function activeReasoningSignal(element) {
  if (element?.tagName === "DETAILS" && !element.open) return false;
  if (["closed", "collapsed"].includes(element?.getAttribute?.("data-state"))) {
    return false;
  }
  return submissionSignalVisible(element);
}

// Nombre maximal de détecteurs décrits dans un diagnostic : borne dure, pour
// qu'une page pathologique ne puisse pas gonfler une métadonnée de run.
const MAX_SIGNAL_SOURCES = 10;

/**
 * Décrit *quel* détecteur de streaming est actif, sans jamais lire de contenu.
 *
 * Un `completion_signal = streaming` figé est aujourd'hui indiscernable : les
 * trois sélecteurs sont fusionnés en un seul booléen, et l'incident de
 * production ne dit pas lequel est resté allumé. Ce diagnostic ne renvoie que
 * l'identité du sélecteur et un état DOM sûr (visibilité, `data-is-streaming`,
 * `aria-hidden`, `data-state`) — jamais de texte, de HTML ni d'attribut
 * arbitraire.
 */
function streamingSignalSources(scope) {
  const root = scope || document;
  const sources = [];
  for (const selector of SELECTORS.streaming) {
    let nodes;
    try {
      nodes = root.querySelectorAll(selector);
    } catch (_) {
      continue;
    }
    for (const element of nodes) {
      if (!submissionSignalVisible(element)) continue;
      sources.push({
        source: selector,
        visible: true,
        data_is_streaming: element.getAttribute("data-is-streaming"),
        aria_hidden: element.getAttribute("aria-hidden"),
        data_state: element.getAttribute("data-state"),
      });
      if (sources.length >= MAX_SIGNAL_SOURCES) return sources;
    }
  }
  return sources;
}

/**
 * Un détecteur de streaming « longue durée » est-il actif dans ce diagnostic ?
 *
 * Entrée : la sortie de `streamingSignalSources(turnSignalScope(turn))`, donc
 * déjà limitée au tour surveillé et déjà filtrée par la visibilité. Aucun
 * élargissement : seuls les sélecteurs de `SELECTORS.longRunningStreaming`
 * comptent, les autres gardent leur sémantique historique.
 */
function longRunningStreamingSignalActive(signalSources) {
  return (signalSources || []).some(
    (entry) =>
      entry &&
      entry.visible === true &&
      SELECTORS.longRunningStreaming.includes(entry.source),
  );
}

function currentSubmissionGenerationSignals() {
  const stopSignals = activeSubmissionSignals(SELECTORS.stop);
  const reasoningSignals = activeSubmissionSignals(
    SELECTORS.reasoning,
    activeReasoningSignal,
  );
  const streamingSignals = activeSubmissionSignals(SELECTORS.streaming);
  const elements = [
    ...stopSignals,
    ...reasoningSignals,
    ...streamingSignals,
  ];
  const signatures = new Map(
    elements.map((element) => [
      element,
      [
        element.getAttribute("aria-hidden"),
        element.getAttribute("data-state"),
        element.getAttribute("data-is-streaming"),
        element.getAttribute("class"),
        element.getAttribute("style"),
        element.open,
      ].join("|"),
    ]),
  );
  return {
    stop: stopSignals.length > 0,
    reasoning: reasoningSignals.length > 0,
    streaming: streamingSignals.length > 0,
    present: elements.length > 0,
    elements: new Set(elements),
    signatures,
  };
}

function captureSubmissionSnapshot(composer, sendBtn) {
  const generation = currentSubmissionGenerationSignals();
  return {
    userTurns: document.querySelectorAll(SELECTORS.user).length,
    assistantTurns: document.querySelectorAll(SELECTORS.assistant).length,
    composerText: composerText(composer),
    sendState: {
      disabled: sendBtn?.disabled ?? null,
      ariaDisabled: sendBtn?.getAttribute("aria-disabled") ?? null,
      ready: isSendButtonReady(sendBtn),
    },
    generation,
  };
}

/**
 * Compares two generation-signal states and names the transition between them.
 *
 * Returns `null` when the signals are strictly unchanged — same elements, same
 * signatures. Persistence is not activity: a Stop/reasoning/streaming node that
 * appeared once and then froze must stop refreshing any liveness deadline.
 */
function generationSignalTransition(previous, current) {
  for (const element of current.elements) {
    if (!previous.elements.has(element)) return "appeared";
    if (previous.signatures?.get(element) !== current.signatures.get(element)) {
      return "changed";
    }
  }
  for (const element of previous.elements) {
    if (!current.elements.has(element)) return "disappeared";
  }
  return null;
}

/**
 * Submission proof only: a signal that appeared or mutated since the
 * pre-submission snapshot. A signal *disappearing* proves nothing about the
 * send having been accepted, so it is deliberately not counted here.
 */
function newSubmissionGenerationSignal(before) {
  const transition = generationSignalTransition(
    before.generation,
    currentSubmissionGenerationSignals(),
  );
  return transition === "appeared" || transition === "changed";
}

function submissionDiagnostics(snapshot, method, after) {
  return {
    method,
    assistant_turns_before: snapshot.assistantTurns,
    assistant_turns_after: after.assistantTurns,
    user_turns_before: snapshot.userTurns,
    user_turns_after: after.userTurns,
    composer_was_non_empty: Boolean(snapshot.composerText.trim()),
    composer_still_has_text: Boolean(after.composerText.trim()),
    send_before: snapshot.sendState,
    send_after: after.sendState,
    generation_before: {
      stop: snapshot.generation.stop,
      reasoning: snapshot.generation.reasoning,
      present: snapshot.generation.present,
    },
    generation_after: {
      stop: after.generation.stop,
      reasoning: after.generation.reasoning,
      present: after.generation.present,
    },
    content_script_version: VERSION,
  };
}

async function waitForSubmissionConfirmation(composer, sendBtn, snapshot, method) {
  const startedAt = Date.now();
  const rapidDeadline = startedAt + SUBMISSION_CONFIRMATION_TIMEOUT_MS;
  const finalDeadline = startedAt + SUBMISSION_CONFIRMATION_FINAL_TIMEOUT_MS;
  let uncertainAnnounced = false;
  while (Date.now() < finalDeadline) {
    const after = captureSubmissionSnapshot(composer, sendBtn);
    let signal = null;
    if (after.userTurns > snapshot.userTurns) signal = "user_turn";
    else if (!after.composerText.trim()) signal = "composer_cleared";
    else if (newSubmissionGenerationSignal(snapshot)) signal = "generation_signal";
    else if (after.assistantTurns > snapshot.assistantTurns) signal = "assistant_turn";
    if (signal) {
      console.log("bridge_run_phase", {
        phase: "submission_confirmed",
        signal,
        submission_state: "post_submission",
      });
      return signal;
    }
    if (!uncertainAnnounced && Date.now() >= rapidDeadline) {
      uncertainAnnounced = true;
      console.warn("bridge_run_phase", {
        phase: "submission_uncertain",
        submission_state: "submission_attempted",
        ...submissionDiagnostics(snapshot, method, after),
      });
    }
    await sleep(100);
  }
  const after = captureSubmissionSnapshot(composer, sendBtn);
  const diagnostics = submissionDiagnostics(snapshot, method, after);
  console.warn("submission_confirmation_failed", diagnostics);
  const error = new BridgeError(
    "bridge_ui_timeout",
    "soumission du prompt non confirmée par l'interface ChatGPT",
  );
  error.diagnostics = diagnostics;
  throw error;
}

function firstAssistantWaitDiagnostics(
  composer,
  sendBtn,
  snapshot,
  before,
  startedAt,
) {
  const after = captureSubmissionSnapshot(composer, sendBtn);
  return {
    content_script_version: VERSION,
    elapsed_ms: Math.max(0, Date.now() - startedAt),
    assistant_turns_before: before,
    assistant_turns_after: after.assistantTurns,
    user_turns_before: snapshot.userTurns,
    user_turns_after: after.userTurns,
    composer_has_text: Boolean(after.composerText.trim()),
    send_enabled: after.sendState.ready,
    send_disabled: !after.sendState.ready,
    stop_visible: after.generation.stop,
    reasoning_visible: after.generation.reasoning,
    streaming_generation_signal_visible: after.generation.present,
    streaming_signal_sources: streamingSignalSources(document),
  };
}

/**
 * Waits for the first assistant turn created by the already-confirmed send.
 *
 * This is deliberately not a wall-clock appearance timeout. ChatGPT can spend
 * several minutes in web research or reasoning before it creates the visible
 * assistant turn.
 *
 * Activity is a *transition* from the last observed signal state, never a
 * repeated comparison against the pre-submission snapshot. That distinction
 * matters for two symmetric failures:
 *   - a signal already visible before Send never counts (it never transitions);
 *   - a signal that appears after Send and then freezes counts exactly once,
 *     so a stuck UI still reaches FIRST_ASSISTANT_ACTIVITY_STALL_MS instead of being kept
 *     alive forever by its own persistence.
 * Real activity — appearance, disappearance, signature/state change, a new
 * element — keeps refreshing the deadline for as long as the UI truly moves.
 */
async function waitForFirstAssistantTurn(
  job,
  composer,
  sendBtn,
  submissionSnapshot,
  assistantTurnsBefore,
  run,
) {
  const startedAt = Date.now();
  let lastActivityAt = startedAt;
  let lastHeartbeatAt = startedAt;
  let lastObservationAt = startedAt;
  let observationsSinceActivity = 0;
  // Baseline = the state observed at submission time, so a pre-existing signal
  // is already "seen" and cannot register as an appearance.
  let observedSignals = submissionSnapshot.generation;
  const watcher = createDomWatcher("first_assistant_turn");

  try {
    while (!job.aborted) {
      await watcher.wait(POLL_MS);
      const now = Date.now();

      if (now - lastHeartbeatAt >= HEARTBEAT_INTERVAL_MS) {
        reply({
          type: "heartbeat",
          id: job.id,
          progress: {
            phase: "waiting_answer",
            output_chars: 0,
            stable_for_ms: 0,
            completion_signal: "unknown",
            completion_confidence: "low",
            page_state: pageStateDiagnostics(now, {
              watcher,
              lastObservationAt,
              lastHeartbeatAt,
              run,
            }),
          },
        });
        lastHeartbeatAt = now;
      }
      lastObservationAt = now;

      const turns = document.querySelectorAll(SELECTORS.assistant);
      if (turns.length > assistantTurnsBefore) return turns[turns.length - 1];

      const currentSignals = currentSubmissionGenerationSignals();
      if (generationSignalTransition(observedSignals, currentSignals)) {
        lastActivityAt = now;
        observationsSinceActivity = 0;
      } else {
        observationsSinceActivity += 1;
      }
      observedSignals = currentSignals;
      // Même règle que dans `streamAnswer` : une unique itération throttlée ne
      // prouve pas qu'une UI est figée (cf. MIN_STALL_OBSERVATIONS).
      if (
        now - lastActivityAt >= FIRST_ASSISTANT_ACTIVITY_STALL_MS &&
        observationsSinceActivity >= MIN_STALL_OBSERVATIONS
      ) {
        const error = new BridgeError(
          "bridge_ui_timeout",
          "aucun tour assistant après la soumission du prompt",
        );
        error.diagnostics = {
          ...firstAssistantWaitDiagnostics(
            composer,
            sendBtn,
            submissionSnapshot,
            assistantTurnsBefore,
            startedAt,
          ),
          page_state: pageStateDiagnostics(now, {
            watcher,
            lastObservationAt,
            lastHeartbeatAt,
            run,
          }),
        };
        throw error;
      }
    }
    return null;
  } finally {
    watcher.disconnect();
  }
}

/**
 * Écrit `text` dans le composer.
 * ProseMirror ignore les mutations directes du DOM : on passe par
 * `insertText`, qui produit la même séquence d'évènements qu'une vraie frappe.
 */
function typePrompt(el, text) {
  el.focus();
  if (el.tagName === "TEXTAREA") {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    ).set;
    setter.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return;
  }
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  if (!document.execCommand("insertText", false, text)) {
    // Repli : évènement paste synthétique (accepté par ProseMirror).
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    el.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      }),
    );
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

/**
 * Dépose des fichiers dans le composer.
 * ChatGPT écoute un `input[type=file]` caché : on lui injecte un FileList
 * fabriqué via DataTransfer, seule façon d'alimenter un input file par script.
 */
async function attachFiles(files) {
  const input = $(SELECTORS.fileInput);
  if (!input) throw new Error("champ d'upload introuvable sur la page");

  const dt = new DataTransfer();
  for (const f of files) {
    const bin = atob(f.data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    dt.items.add(
      new File([bytes], f.name, { type: f.mime || "application/octet-stream" }),
    );
  }

  input.files = dt.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
  // Repli : certaines versions de l'UI n'écoutent que le drop sur le composer.
  const composer = $(SELECTORS.composer);
  if (composer) {
    composer.dispatchEvent(
      new DragEvent("drop", {
        dataTransfer: dt,
        bubbles: true,
        cancelable: true,
      }),
    );
  }
}

/**
 * Sérialise une bulle de réponse en texte proche du Markdown source.
 * On ne peut pas se contenter de `innerText` : il embarque le libellé des
 * boutons « Copier » des blocs de code et perd les délimiteurs.
 */
const DOM_SERIALIZER = globalThis.ChatGPTBridgeSerializer;

/**
 * Conteneur portant la réponse finale.
 * Les blocs de réflexion (« Thinking ») sont rendus dans leur propre conteneur,
 * avant la réponse : on lit donc toujours le dernier, jamais le premier.
 */
/** Identifiant stable du tour (ex. « conversation-turn-10 »), survit aux re-rendus. */
function turnLocator(turn) {
  const container = closestOf(turn, SELECTORS.turnContainer);
  return container ? container.getAttribute("data-testid") : null;
}

/** Retrouve le tour courant à partir de son identifiant, jamais d'un nœud gardé. */
function findTurn(locator, before) {
  if (locator) {
    const container = document.querySelector(
      `[data-testid="${CSS.escape(locator)}"]`,
    );
    const turn = container && container.querySelector(SELECTORS.assistant);
    if (turn) return turn;
  }
  const turns = document.querySelectorAll(SELECTORS.assistant);
  return turns.length > before ? turns[turns.length - 1] : null;
}

function answerRoot(turn, fallbackOk) {
  const blocks = [...turn.querySelectorAll(SELECTORS.markdown)].filter(
    (b) => !SELECTORS.reasoning.some((sel) => b.closest(sel)),
  );
  if (blocks.length) return blocks[blocks.length - 1];

  // Aucun conteneur .markdown : mesuré sur l'UI réelle, c'est l'état de la phase
  // de réflexion. Le texte du tour vaut alors « Thinking » — surtout ne pas le
  // lire comme une réponse. Le repli sur le tour entier n'est autorisé qu'une
  // fois la réponse terminée (ou après un long délai), au cas où une réponse
  // n'utiliserait pas .markdown du tout.
  return fallbackOk ? turn : null;
}

/**
 * Dernier bloc de code de premier niveau. ChatGPT imbrique un `<pre>` dans un
 * autre (mesuré : `pre=2` pour un seul bloc) ; comme la branche PRE du
 * sérialiseur ne descend pas dans ses enfants, seul le `<pre>` extérieur est
 * réellement visité — c'est donc lui qu'il faut désigner comme « en cours ».
 */
function dernierPre(root) {
  const pres = [...root.querySelectorAll("pre")].filter(
    (p) => !(p.parentElement && p.parentElement.closest("pre")),
  );
  const pre = pres[pres.length - 1];
  if (!pre) return null;

  // Un bloc n'est « en cours d'écriture » que si rien ne le suit. Dès qu'un
  // paragraphe apparaît après lui il est terminé : le laisser ouvert ferait
  // arriver sa fermeture après du texte déjà transmis, et le diff par préfixe
  // réémettrait toute la suite.
  const suite = document.createRange();
  suite.setStartAfter(pre);
  suite.setEnd(root, root.childNodes.length);
  return suite.toString().trim() ? null : pre;
}

function readAnswer(root, streaming) {
  // Tant que ChatGPT écrit, le dernier bloc de code est celui en cours.
  const ouvert = streaming ? dernierPre(root) : null;
  return DOM_SERIALIZER.serializeResponse(root, ouvert);
}

/** Périmètre DOM dans lequel les signaux d'un tour sont lus (jamais la page). */
function turnSignalScope(turn) {
  return closestOf(turn, SELECTORS.turnContainer) || turn.parentElement || turn;
}

/**
 * La réponse est-elle terminée ?  true / false / null quand aucun signal connu
 * n'est reconnaissable — ce dernier cas est capital : conclure « terminé » par
 * défaut tronquait la réponse pendant la phase de réflexion (« Thinking »).
 */
function completionState(turn) {
  const scope = turnSignalScope(turn);
  // Le Stop est un contrôle de la génération courante : il ne se cherche que
  // dans le composer. Un bouton portant le même libellé ailleurs dans la page
  // ne doit jamais maintenir ce tour en état « running ». Volontairement sans
  // `composerRoot()`, dont le repli sur document.body rendrait le scope inutile :
  // composer introuvable => pas de signal, plutôt qu'un signal de toute la page.
  const composer = $(SELECTORS.composer);
  const generationControls =
    composer && (closestOf(composer, ["form"]) || composer.parentElement);
  const visible = (element) => {
    if (!element || element.getAttribute?.("aria-hidden") === "true")
      return false;
    const style = globalThis.getComputedStyle?.(element);
    if (style?.display === "none" || style?.visibility === "hidden")
      return false;
    return (
      typeof element.getClientRects !== "function" ||
      element.getClientRects().length > 0
    );
  };
  const activeReasoning = (element) => {
    if (element?.tagName === "DETAILS" && !element.open) return false;
    if (["closed", "collapsed"].includes(element?.getAttribute?.("data-state")))
      return false;
    return visible(element);
  };
  return globalThis.ChatGPTBridgeCompletion.completionState({
    stopVisible: Boolean(
      generationControls &&
      SELECTORS.stop.some((selector) =>
        [...generationControls.querySelectorAll(selector)].some(visible),
      ),
    ),
    // Le streaming se lit dans le tour surveillé : un indicateur laissé par un
    // ancien tour ou par un widget latéral ne doit pas empêcher sa finalisation.
    streamingVisible: Boolean(
      [...scope.querySelectorAll(SELECTORS.streaming.join(", "))].some(visible),
    ),
    reasoningVisible: SELECTORS.reasoning.some((selector) =>
      [...scope.querySelectorAll(selector)].some(activeReasoning),
    ),
    actionsVisible: SELECTORS.turnActions.some((selector) =>
      [...scope.querySelectorAll(selector)].some(visible),
    ),
    // Conservé uniquement comme observation : le moteur pur l'ignore volontairement.
    sendVisible: Boolean($(SELECTORS.send)),
  });
}

// --------------------------------------------------------------------------- //
// Contrôles typés de l'interface : modèle, profil, recherche web
//
// Règle unique de cette section : agir, puis **relire l'état dans le DOM**.
// Rien n'est déclaré appliqué sans cette relecture. Quand elle est impossible
// (bouton absent, état non exposé par l'UI), le résultat porte `ok: false` /
// `verified: false` et une `reason` — que le serveur remonte au client, plutôt
// que de laisser croire qu'un réglage a pris. Un contrôle non vérifiable doit
// dégrader visiblement, jamais silencieusement.
// --------------------------------------------------------------------------- //

/** Minuscules, sans accents ni espaces multiples : base des comparaisons. */
const norm = (s) =>
  (s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

/** Identifiant comparable : « GPT-5 Thinking » -> « gpt-5-thinking ». */
const slug = (s) =>
  norm(s)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/** Libellé d'un déclencheur (bouton portant l'état courant) : une seule ligne. */
const triggerLabel = (el) => norm(el.innerText || el.textContent || "");

/**
 * Libellé d'une entrée de menu : sa première ligne seulement. Les entrées de
 * modèle portent une description en dessous (« Réfléchit plus longtemps »),
 * qui n'appartient pas au nom.
 */
function itemLabel(el) {
  const lignes = (el.innerText || el.textContent || "").split("\n");
  for (const ligne of lignes) {
    const texte = ligne.replace(/\s+/g, " ").trim();
    if (texte) return texte;
  }
  return "";
}

/** Identifiant d'une entrée : son `data-testid` si l'UI en pose un, sinon son libellé. */
function itemId(el, label) {
  const testid = el.getAttribute("data-testid") || "";
  const m = testid.match(
    /^(?:model-switcher|model|account|workspace|profile)-(.+)$/,
  );
  return m ? slug(m[1]) : slug(label);
}

/**
 * État on/off d'un bouton, tel que l'UI l'expose. `null` = non exposé, et c'est
 * une information à part entière : un bouton dont l'état n'est pas lisible ne
 * permet aucune vérification, donc aucune promesse.
 */
function pressedState(el) {
  for (const attr of ["aria-pressed", "aria-checked", "aria-selected"]) {
    const v = el.getAttribute(attr);
    if (v === "true") return true;
    if (v === "false") return false;
  }
  // `data-state` sert aussi à Radix pour dire si un menu est ouvert : `open` et
  // `closed` ne disent rien d'un réglage, les lire comme on/off inventerait un
  // état vérifié qui n'existe pas.
  const state = norm(el.getAttribute("data-state") || "");
  if (["on", "checked", "active"].includes(state)) return true;
  if (["off", "unchecked", "inactive"].includes(state)) return false;
  return null;
}

/** Formulaire du composer : périmètre des boutons d'outils de l'envoi. */
function composerRoot() {
  const composer = $(SELECTORS.composer);
  return (
    (composer && (closestOf(composer, ["form"]) || composer.parentElement)) ||
    document.body
  );
}

/** Ouvre le menu d'un déclencheur et renvoie l'élément de menu, ou lève. */
async function openMenu(trigger, label) {
  if (trigger.getAttribute("aria-expanded") !== "true") trigger.click();
  return waitFor(
    () => {
      for (const sel of SELECTORS.menu) {
        for (const menu of document.querySelectorAll(sel)) {
          if ($in(menu, SELECTORS.menuItem)) return menu;
        }
      }
      return null;
    },
    4000,
    `menu « ${label} » jamais ouvert`,
  );
}

/** Referme un menu ouvert. Radix écoute Échap sur le document. */
function closeMenu(menu) {
  const evt = () =>
    new KeyboardEvent("keydown", {
      key: "Escape",
      code: "Escape",
      keyCode: 27,
      bubbles: true,
      cancelable: true,
    });
  if (menu) menu.dispatchEvent(evt());
  document.dispatchEvent(evt());
}

/** Entrées d'un menu, dédoublonnées, dans l'ordre du document. */
function menuItems(menu) {
  const vus = new Set();
  const items = [];
  for (const sel of SELECTORS.menuItem) {
    for (const el of menu.querySelectorAll(sel)) {
      if (vus.has(el)) continue;
      vus.add(el);
      const label = itemLabel(el);
      if (!label) continue;
      items.push({
        el,
        label,
        id: itemId(el, label),
        checked: pressedState(el),
      });
    }
  }
  return items;
}

/**
 * Entrée correspondant à `wanted`, par paliers : identifiant exact, libellé
 * exact, puis préfixe, puis inclusion. Les paliers évitent qu'un « gpt-5 »
 * demandé attrape « GPT-5 Thinking » alors que « GPT-5 » existe dans la liste.
 */
function pickItem(items, wanted) {
  const cible = slug(wanted);
  if (!cible) return null;
  const tests = [
    (i) => i.id === cible,
    (i) => slug(i.label) === cible,
    (i) => i.id.startsWith(cible) || slug(i.label).startsWith(cible),
    (i) => i.id.includes(cible) || slug(i.label).includes(cible),
  ];
  for (const test of tests) {
    const trouve = items.find(test);
    if (trouve) return trouve;
  }
  return null;
}

/** L'état relu correspond-il à ce qui a été demandé ? */
function labelMatches(wanted, label) {
  const a = slug(wanted);
  const b = slug(label);
  return Boolean(a && b && (a === b || b.includes(a) || a.includes(b)));
}

// --------------------------------------------------------------------------- //
// Lecture d'état (sans effet de bord)
// --------------------------------------------------------------------------- //

// Formes complètes des deux états lus : toutes les clés sont toujours présentes,
// pour que le serveur n'ait jamais à distinguer « absent » de « inconnu ».
const etatPicker = (extra) => ({
  supported: false,
  selected: null,
  selected_id: null,
  verified: false,
  reason: null,
  ...extra,
});

const etatRecherche = (extra) => ({
  supported: null,
  enabled: null,
  verified: false,
  via: null,
  reason: null,
  ...extra,
});

/** État d'un sélecteur à déclencheur (modèle, profil) : lecture seule. */
function readPicker(selectors, quoi) {
  const trigger = $(selectors);
  if (!trigger) return etatPicker({ reason: `${quoi} absent de la page` });

  const label = triggerLabel(trigger);
  if (!label)
    return etatPicker({
      supported: true,
      reason: `${quoi} sans libellé lisible`,
    });

  return etatPicker({
    supported: true,
    selected: label,
    selected_id: slug(label),
    verified: true,
  });
}

/**
 * État de la recherche web, lu sans ouvrir de menu.
 * `supported: null` = indéterminé : l'UI place parfois la recherche dans le
 * menu d'outils, qu'une simple lecture n'a pas le droit d'ouvrir.
 */
function readWebSearch() {
  const btn = $in(composerRoot(), SELECTORS.searchToggle);
  if (btn) {
    const pressed = pressedState(btn);
    return etatRecherche({
      supported: true,
      enabled: pressed,
      verified: pressed !== null,
      via: "composer_toggle",
      reason:
        pressed === null
          ? "bouton présent, mais son état on/off n'est pas exposé par l'UI"
          : null,
    });
  }
  const tools = $in(composerRoot(), SELECTORS.toolsTrigger);
  return etatRecherche({
    supported: tools ? null : false,
    via: tools ? "tools_menu" : null,
    reason: tools
      ? "aucun bouton dédié : état seulement lisible en ouvrant le menu d'outils (sonde)"
      : "ni bouton de recherche ni menu d'outils dans le composer",
  });
}

/** Énumère les entrées d'un menu, puis le referme. Effet de bord assumé (sonde). */
async function probeMenu(selectors, quoi) {
  const trigger = $(selectors);
  if (!trigger) return null;
  let menu = null;
  try {
    menu = await openMenu(trigger, quoi);
    return menuItems(menu).map((i) => ({
      id: i.id,
      label: i.label,
      checked: i.checked,
    }));
  } catch {
    return null;
  } finally {
    closeMenu(menu);
    await sleep(150);
  }
}

/** Cherche la recherche web dans le menu d'outils, puis referme. */
async function probeWebSearch() {
  const tools = $in(composerRoot(), SELECTORS.toolsTrigger);
  if (!tools) return null;
  let menu = null;
  try {
    menu = await openMenu(tools, "outils du composer");
    const item = menuItems(menu).find((i) =>
      MOTS_RECHERCHE.test(norm(i.label)),
    );
    if (!item) {
      return etatRecherche({
        supported: false,
        via: "tools_menu",
        reason: "aucune entrée de recherche web dans le menu d'outils",
      });
    }
    return etatRecherche({
      supported: true,
      enabled: item.checked,
      verified: item.checked !== null,
      via: "tools_menu",
      reason:
        item.checked === null
          ? "entrée trouvée, mais son état n'est pas exposé par l'UI"
          : null,
    });
  } catch (err) {
    return etatRecherche({ via: "tools_menu", reason: err.message });
  } finally {
    closeMenu(menu);
    await sleep(150);
  }
}

/**
 * Photographie de l'état pilotable de l'interface.
 * `probe` autorise l'ouverture des menus (nécessaire pour énumérer les modèles) :
 * c'est visible à l'écran, donc jamais fait pendant une génération.
 */
async function uiState(probe) {
  const state = {
    observed_at: Date.now() / 1000,
    url: location.href,
    content_script_version: VERSION,
    probed: Boolean(probe),
    model: readPicker(SELECTORS.modelTrigger, "sélecteur de modèle"),
    profile: readPicker(SELECTORS.profileTrigger, "sélecteur de profil"),
    web_search: readWebSearch(),
  };
  if (probe) {
    state.model.available = await probeMenu(SELECTORS.modelTrigger, "modèles");
    state.profile.available = await probeMenu(
      SELECTORS.profileTrigger,
      "profils",
    );
    if (state.web_search.supported !== true || !state.web_search.verified) {
      const sonde = await probeWebSearch();
      if (sonde) state.web_search = sonde;
    }
  }
  return state;
}

// --------------------------------------------------------------------------- //
// Application des contrôles (avec relecture obligatoire)
// --------------------------------------------------------------------------- //

/** Résultats typés d'un contrôle : jamais `ok` sans relecture concordante. */
const echec = (requested, reason, extra) => ({
  requested,
  applied: null,
  verified: false,
  ok: false,
  changed: false,
  reason,
  ...extra,
});

const succes = (requested, applied, changed, extra) => ({
  requested,
  applied,
  verified: true,
  ok: true,
  changed,
  reason: null,
  ...extra,
});

/**
 * Sélectionne une entrée dans un menu à déclencheur, puis vérifie que le
 * libellé du déclencheur reflète bien le choix. Sans cette concordance, le
 * contrôle est un échec — même si le clic a eu lieu.
 */
async function selectFromPicker(selectors, wanted, quoi) {
  const trigger = $(selectors);
  if (!trigger) return echec(wanted, `${quoi} absent de la page`);

  const avant = triggerLabel(trigger);
  if (labelMatches(wanted, avant)) return succes(wanted, avant, false);

  let menu = null;
  try {
    menu = await openMenu(trigger, quoi);
    const items = menuItems(menu);
    let item = pickItem(items, wanted);

    if (!item) {
      // Les modèles secondaires sont repliés dans un sous-menu.
      const plus = items.find(
        (i) =>
          MOTS_PLUS_MODELES.test(norm(i.label)) ||
          i.el.getAttribute("aria-haspopup") === "menu",
      );
      if (plus) {
        plus.el.dispatchEvent(
          new PointerEvent("pointermove", { bubbles: true }),
        );
        plus.el.click();
        await sleep(250);
        for (const sel of SELECTORS.menu) {
          for (const sous of document.querySelectorAll(sel)) {
            if (sous === menu) continue;
            const trouve = pickItem(menuItems(sous), wanted);
            if (trouve) {
              item = trouve;
              break;
            }
          }
          if (item) break;
        }
      }
    }

    if (!item) {
      return echec(wanted, `« ${wanted} » absent du ${quoi}`, {
        available: items.map((i) => ({ id: i.id, label: i.label })),
      });
    }

    item.el.click();
  } catch (err) {
    return echec(wanted, err.message);
  } finally {
    closeMenu(menu);
  }

  // Relecture : c'est elle, et elle seule, qui autorise `ok: true`.
  const applied = await waitFor(
    () => {
      const t = $(selectors);
      const label = t && triggerLabel(t);
      return label && labelMatches(wanted, label) ? label : null;
    },
    6000,
    "relecture du sélecteur",
  ).catch(() => null);

  if (!applied) {
    const t = $(selectors);
    const vu = t ? triggerLabel(t) : "?";
    return echec(
      wanted,
      `clic effectué mais ${quoi} affiche toujours « ${vu} »`,
    );
  }
  return succes(wanted, applied, true);
}

/**
 * Active ou désactive la recherche web, en préférant le bouton dédié du
 * composer (dont l'état est lisible) au menu d'outils (dont l'effet ne se
 * vérifie qu'indirectement, par l'apparition du bouton).
 */
async function setWebSearch(want) {
  const avant = readWebSearch();

  if (avant.verified && avant.enabled === want)
    return succes(want, want, false, { via: avant.via });

  const btn = $in(composerRoot(), SELECTORS.searchToggle);
  if (btn && avant.enabled !== null) {
    btn.click();
    const apres = await waitFor(
      () => {
        const s = readWebSearch();
        return s.verified && s.enabled === want ? s : null;
      },
      3000,
      "relecture du bouton de recherche",
    ).catch(() => null);
    if (apres) return succes(want, want, true, { via: apres.via });
    return echec(want, "clic sans changement d'état observable", {
      via: "composer_toggle",
    });
  }

  // Repli : l'entrée du menu d'outils. Vérification indirecte — l'activation
  // fait apparaître le bouton dédié dans le composer, la désactivation le retire.
  const tools = $in(composerRoot(), SELECTORS.toolsTrigger);
  if (!tools) {
    const raison =
      avant.reason || "aucun contrôle de recherche web dans le composer";
    return echec(want, raison, { via: avant.via });
  }
  let menu = null;
  try {
    menu = await openMenu(tools, "outils du composer");
    const item = menuItems(menu).find((i) =>
      MOTS_RECHERCHE.test(norm(i.label)),
    );
    if (!item)
      return echec(want, "aucune entrée de recherche web dans ce menu", {
        via: "tools_menu",
      });
    if (item.checked === want)
      return succes(want, want, false, { via: "tools_menu" });
    item.el.click();
  } catch (err) {
    return echec(want, err.message, { via: "tools_menu" });
  } finally {
    closeMenu(menu);
  }

  const apres = await waitFor(
    () => {
      const present = Boolean($in(composerRoot(), SELECTORS.searchToggle));
      return present === want ? { present } : null;
    },
    4000,
    "relecture du composer",
  ).catch(() => null);

  if (!apres) {
    return echec(want, "entrée cliquée mais le composer ne la reflète pas", {
      via: "tools_menu",
    });
  }
  return succes(want, want, true, { via: "tools_menu" });
}

/** Applique les contrôles demandés (les clés absentes ou nulles ne sont pas touchées). */
async function applyControls(controls) {
  const resultats = {};
  // Le profil d'abord : changer d'espace de travail recharge la liste des modèles.
  if (typeof controls.profile === "string" && controls.profile) {
    const quoi = "sélecteur de profil";
    resultats.profile = await selectFromPicker(
      SELECTORS.profileTrigger,
      controls.profile,
      quoi,
    );
  }
  if (typeof controls.model === "string" && controls.model) {
    resultats.model = await selectFromPicker(
      SELECTORS.modelTrigger,
      controls.model,
      "sélecteur de modèle",
    );
  }
  if (typeof controls.web_search === "boolean") {
    resultats.web_search = await setWebSearch(controls.web_search);
  }
  return resultats;
}

/** Requête de contrôle/lecture venue du serveur : toujours une réponse typée. */
async function handleUi(msg) {
  try {
    console.log("bridge_run_phase", { phase: "ui_controls" });
    if (msg.browser_target) {
      if (!isBrowserTarget(msg.browser_target)) {
        throw new BridgeError("bridge_browser_target_required", "browser_target invalide");
      }
      // Une target réservée peut avoir été naviguée dans ChatGPT entre deux
      // paquets : aucun contrôle ne doit alors réussir sur une surface normale.
      await ensureTemporaryChat();
    }
    const applied =
      msg.type === "ui_control"
        ? await applyControls(msg.controls || {})
        : null;
    const state = await uiState(msg.probe);
    const ok = !applied || Object.values(applied).every((r) => r.ok);
    return { type: msg.type, id: msg.id, ok, applied, state, error: null };
  } catch (err) {
    return {
      type: msg.type,
      id: msg.id,
      ok: false,
      applied: null,
      state: null,
      error: err.message,
    };
  }
}

// --------------------------------------------------------------------------- //
// Cycle de vie d'une requête
// --------------------------------------------------------------------------- //
function reply(payload) {
  chrome.runtime.sendMessage(payload).catch(() => {});
}

/**
 * Résultat `incomplete` d'un tour : le texte déjà visible n'est JAMAIS jeté.
 *
 * Un abandon sur `finalization_stalled` / `active_signal_stalled` signifie
 * « l'UI ne conclut pas », pas « ChatGPT n'a rien écrit ». Rendre la main sans
 * le candidat visible détruisait une réponse complète (incident de production
 * du 2026-08 : output_chars=0 alors que la réponse était affichée à l'écran).
 * Ce candidat n'est jamais un succès implicite : il reste soumis à une
 * adoption humaine explicite côté application.
 */
function incompleteAnswer({
  reason,
  text,
  snapshot,
  completion,
  stableForMs,
  turn,
  signalSources,
  pageState,
}) {
  const candidate = typeof text === "string" ? text : "";
  return {
    page_state: pageState || null,
    text: candidate,
    visible_citations: candidate ? snapshot?.visible_citations || [] : [],
    serializer_version: DOM_SERIALIZER.SERIALIZER_VERSION,
    completion_signal: completion.signal,
    completion_confidence: completion.confidence,
    stable_for_ms: stableForMs,
    output_chars: globalThis.ChatGPTBridgeFinalOutput.outputChars(candidate),
    streaming_signal_sources: signalSources || [],
    incomplete: true,
    incomplete_reason: reason,
    // Identité lue sur le tour *courant* — celui qui vient d'être re-résolu et
    // dont le texte est ce candidat — jamais sur le premier nœud assistant,
    // que React a pu remplacer entre-temps.
    turn_locator: turn ? turnLocator(turn) : null,
    external_turn_id: turn ? turnExternalId(turn) : null,
  };
}

/**
 * Suit la réponse dans le DOM sans transmettre les snapshots intermédiaires.
 * Chaque observation remplace la précédente, car le rendu n'est pas append-only.
 */
async function streamAnswer(job, locator, before, run) {
  const output = globalThis.ChatGPTBridgeFinalOutput.createAccumulator();
  let vu = ""; // relevé précédent, pour mesurer la stabilité
  let stableSince = null;
  // Observations consécutives où le texte n'a pas bougé (cf. MIN_STALL_OBSERVATIONS).
  let stableObservations = 0;
  let full = "";
  let debugSig = "";
  let completionSignature = "";
  const debut = Date.now();
  let lastHeartbeatAt = debut;
  let finalSerialized = null;
  // Identité externe et locator du tour re-résolu qui a produit/vérifié le
  // snapshot final. Ils sont capturés dans la même itération que le texte : le
  // texte et l'identité décrivent toujours le même nœud DOM courant.
  let finalTurnLocator = locator;
  let finalExternalTurnId = null;
  let finalCompletion = {
    finished: null,
    signal: "unknown",
    confidence: "low",
  };
  let stableForMs = 0;
  let lastSerializationMs = 0;
  let lastRuntimeMetricsAt = 0;
  let runtimeMetrics = {};
  let lastObservationAt = debut;
  // Réveil événementiel + repli minuté : l'onglet reste en arrière-plan, la
  // boucle ne dépend donc pas de la cadence des minuteries pour *constater*
  // une fin déjà rendue. Aucune règle de décision n'est modifiée.
  const watcher = createDomWatcher("stream_answer");
  const pageState = () =>
    pageStateDiagnostics(Date.now(), {
      watcher,
      lastObservationAt,
      lastHeartbeatAt,
      run,
      stableObservations,
    });
  let finalPageState = null;

  // Scalars only: never retain DOM nodes, snapshots, or response buffers.
  const sampledRuntimeMetrics = (now) => {
    if (now - lastRuntimeMetricsAt < RUNTIME_METRICS_INTERVAL_MS)
      return runtimeMetrics;
    lastRuntimeMetricsAt = now;
    const next = {};
    const heapBytes = globalThis.performance?.memory?.usedJSHeapSize;
    if (Number.isFinite(heapBytes) && heapBytes >= 0)
      next.js_heap_bytes = Math.floor(heapBytes);
    try {
      next.dom_node_count = document.getElementsByTagName("*").length;
    } catch (_) {
      // Une métrique absente ne doit jamais perturber la génération.
    }
    runtimeMetrics = next;
    return runtimeMetrics;
  };

  // Progression persistante entre les itérations, indépendante de la présence du tour.
  // Le heartbeat est un signal de liveness, pas une preuve que le DOM est lisible.
  let lastProgress = {
    phase: "waiting_answer",
    output_chars: 0,
    stable_for_ms: 0,
    completion_signal: "unknown",
    completion_confidence: "low",
  };

  try {
    while (!job.aborted) {
      await watcher.wait(POLL_MS);

      const now = Date.now();

      // Liveness indépendant du DOM : le heartbeat doit être émis même quand
      // ChatGPT remplace temporairement le tour assistant (recherche web, reasoning).
      if (now - lastHeartbeatAt >= HEARTBEAT_INTERVAL_MS) {
        reply({
          type: "heartbeat",
          id: job.id,
          progress: {
            ...lastProgress,
            page_state: pageStateDiagnostics(now, {
              watcher,
              lastObservationAt,
              lastHeartbeatAt,
              run,
              stableObservations,
            }),
          },
        });
        lastHeartbeatAt = now;
      }
      lastObservationAt = now;

      // Re-recherche du tour à chaque itération, jamais de référence gardée :
      // React remplace le nœud du message entre la phase de réflexion et la
      // réponse, et un nœud détaché resterait figé sur « Thinking ».
      const turn = findTurn(locator, before);
      if (!turn) continue;

      // `finished === false` (ChatGPT écrit encore) interdit de sortir ; `null`
      // (aucun signal reconnu) exige une stabilité bien plus longue.
      const completion = completionState(turn);
      const finished = completion.finished;
      const nextCompletionSignature = `${finished}:${completion.signal}`;
      if (nextCompletionSignature !== completionSignature) {
        completionSignature = nextCompletionSignature;
        stableSince = null;
        stableObservations = 0;
      }
      const root = answerRoot(
        turn,
        finished === true || Date.now() - debut > NO_MARKDOWN_FALLBACK_MS,
      );
      const serializationStartedAt = globalThis.performance?.now?.();
      const snapshot = root ? readAnswer(root, finished !== true) : null;
      const serializationFinishedAt = globalThis.performance?.now?.();
      if (
        Number.isFinite(serializationStartedAt) &&
        Number.isFinite(serializationFinishedAt)
      ) {
        lastSerializationMs = Math.max(
          0,
          Math.round(serializationFinishedAt - serializationStartedAt),
        );
      }
      full = snapshot ? snapshot.text : "";
      output.observe(full);

      if (DEBUG) {
        const pres = root ? root.querySelectorAll("pre") : [];
        const sig = `fini=${finished} root=${root ? root.tagName + "." + (root.className || "-").slice(0, 24) : "null"} pre=${pres.length}`;
        if (sig !== debugSig) {
          debugSig = sig;
          console.log(
            `[bridge] ${sig} | queue=${JSON.stringify(full.slice(-40))}`,
          );
        }
      }

      if (full !== vu) {
        vu = full;
        stableSince = null;
        stableObservations = 0;
      } else if (stableSince === null) {
        stableSince = Date.now();
        stableObservations = 1;
      } else {
        stableObservations += 1;
      }

      const need =
        finished === true && full.length === 0
          ? EMPTY_FINAL_SETTLE_MS
          : finished === null
            ? SETTLE_UNKNOWN_MS
            : SETTLE_MS;
      stableForMs = stableSince === null ? 0 : Date.now() - stableSince;
      const stable = stableForMs >= need;

      // Mettre à jour l'état courant pour le prochain heartbeat.
      // Ce calcul n'envoie rien : le heartbeat lui-même est émis plus haut,
      // indépendamment de la présence du tour.
      const phase =
        completion.signal === "reasoning"
          ? "reasoning"
          : completion.signal === "stop_button" ||
              completion.signal === "streaming"
            ? "generating"
            : full.length === 0
              ? "waiting_answer"
              : stableForMs > 0
                ? "stabilizing"
                : "answering";

      // Diagnostic borné et sans contenu : quand l'UI se dit « en streaming »,
      // dire *quel* détecteur l'affirme. Un stall futur doit être imputable à un
      // sélecteur nommé, jamais à un booléen agrégé.
      const signalSources =
        completion.signal === "streaming"
          ? streamingSignalSources(turnSignalScope(turn))
          : [];

      lastProgress = {
        phase,
        output_chars:
          globalThis.ChatGPTBridgeFinalOutput.outputChars(full),
        stable_for_ms: stableForMs,
        completion_signal: completion.signal,
        completion_confidence: completion.confidence,
        serialization_ms: lastSerializationMs,
        ...(signalSources.length
          ? { streaming_signal_sources: signalSources }
          : {}),
        ...sampledRuntimeMetrics(now),
      };
      const outcome = globalThis.ChatGPTBridgeFinalOutput.settledOutcome({
        completion,
        text: full,
        stableForMs,
        emptySettleMs: EMPTY_FINAL_SETTLE_MS,
      });
      const incompleteFields = {
        snapshot,
        completion,
        stableForMs,
        turn,
        signalSources,
        pageState: pageState(),
      };
      if (outcome === "incomplete") {
        // Fin confirmée mais rien d'écrit : il n'y a honnêtement aucun candidat.
        return incompleteAnswer({
          reason: "no_final_answer",
          text: "",
          ...incompleteFields,
        });
      }

      let verifyFinal = false;
      if (finished === true) {
        // `assistant_actions` est une finalité explicite : elle ne peut jamais
        // devenir `finalization_stalled`, même après un réveil tardif.
        verifyFinal = stable && full.length > 0;
      } else if (finished === false) {
        // Un texte stable n'est PAS la preuve qu'une génération active a échoué.
        // Quand `.streaming-animation` est visible dans le tour surveillé,
        // ChatGPT recherche encore : la borne dure appartient au serveur
        // (`bridge_total_timeout`).
        if (
          full.length > 0 &&
          stableForMs >= WATCHED_TURN_ACTIVE_SIGNAL_STALL_MS &&
          stableObservations >= MIN_STALL_OBSERVATIONS &&
          !longRunningStreamingSignalActive(signalSources)
        ) {
          return incompleteAnswer({
            reason: "active_signal_stalled",
            text: full,
            ...incompleteFields,
          });
        }
      } else {
        // Finalité inconnue : c'est le seul état auquel le stall de finalisation
        // peut s'appliquer.
        if (
          full.length > 0 &&
          stableForMs >= FINALIZATION_STALL_MS &&
          stableObservations >= MIN_STALL_OBSERVATIONS
        ) {
          return incompleteAnswer({
            reason: "finalization_stalled",
            text: full,
            ...incompleteFields,
          });
        }
        verifyFinal = stable && full.length > 0;
      }

      if (verifyFinal) {
        // React peut remplacer le nœud entre les observations : re-résoudre le
        // même tour, puis revérifier finalité, identité et texte sur ce nœud.
        const verificationTurn = findTurn(
          turnLocator(turn) || locator,
          before,
        );
        const verificationCompletion = verificationTurn
          ? completionState(verificationTurn)
          : null;
        const verificationRoot = verificationTurn
          ? answerRoot(verificationTurn, true)
          : null;
        const verification = verificationRoot
          ? readAnswer(verificationRoot, false)
          : null;
        const currentExternalTurnId = turnExternalId(turn);
        const verificationExternalTurnId = verificationTurn
          ? turnExternalId(verificationTurn)
          : null;
        const finalityVerified =
          finished === true
            ? verificationCompletion?.finished === true
            : verificationCompletion?.finished !== false;
        const externalTurnIdentityStable =
          currentExternalTurnId === verificationExternalTurnId;

        // La décision de fin porte uniquement sur le contenu textuel.
        // Les citations restent des métadonnées et peuvent encore être
        // réordonnées/enrichies par l'UI après la fin visible de la réponse.
        if (
          finalityVerified &&
          externalTurnIdentityStable &&
          verification &&
          verification.text === full
        ) {
          output.observe(verification.text);
          finalSerialized = verification;
          finalCompletion = verificationCompletion;
          finalTurnLocator = turnLocator(verificationTurn) || locator;
          finalExternalTurnId = verificationExternalTurnId;
          // État de plan au moment exact où la fin est constatée : c'est cette
          // valeur qui rend vérifiable « terminé sans focus » après coup.
          finalPageState = pageState();
          break;
        }

        // Le texte, la finalité ou l'identité a réellement changé entre les
        // deux lectures : on recommence la fenêtre de stabilisation.
        vu = verification ? verification.text : "";
        stableSince = null;
        stableObservations = 0;
      }
    }
  } finally {
    watcher.disconnect();
  }

  const serialized = finalSerialized || {
    text: output.final(),
    visible_citations: [],
    serializer_version: DOM_SERIALIZER.SERIALIZER_VERSION,
  };
  return {
    ...serialized,
    completion_signal: finalCompletion.signal,
    completion_confidence: finalCompletion.confidence,
    stable_for_ms: stableForMs,
    turn_locator: finalTurnLocator,
    external_turn_id: finalExternalTurnId,
    page_state: finalPageState || pageState(),
  };
}

/**
 * Identité externe du tour qui a réellement produit le snapshot rendu.
 *
 * `streamAnswer` re-résout le tour à chaque itération, car React remplace le
 * nœud assistant entre réflexion, streaming et rendu final. Le premier nœud
 * observé peut donc être détaché — et ne porter qu'un `request-placeholder-…`
 * alors que le nœud courant porte déjà le vrai `data-message-id`. On lit donc
 * l'identité capturée par `streamAnswer`, et à défaut on re-résout ce même
 * tour par son locator, sans jamais réutiliser une référence DOM conservée.
 */
function resolveExternalTurnId(serialized, locator, before) {
  if (serialized.external_turn_id) return serialized.external_turn_id;
  const turn = findTurn(serialized.turn_locator || locator, before);
  return turn ? turnExternalId(turn) : null;
}

/** Erreur de content script typée : `.code` traverse jusqu'au client, jamais aplati. */
class BridgeError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

/**
 * URL courante, si — et seulement si — elle appartient à une origine ChatGPT
 * autorisée. Diagnostic uniquement : jamais awaité, jamais comparée pour
 * router ou reconnaître une conversation. La racine `/` et la query
 * `?temporary-chat=true` sont des valeurs valides.
 */
function diagnosticLocator() {
  try {
    const url = new URL(window.location.href);
    if (
      url.protocol !== "https:" ||
      !["chatgpt.com", "chat.openai.com"].includes(url.hostname) ||
      url.username ||
      url.password
    ) {
      return null;
    }
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Un `data-message-id` temporaire posé par l'UI avant que le vrai message
 * existe (« request-placeholder-request-WEB:<uuid>-0 »). Non vide, mais il ne
 * désigne aucun tour assistant durable : le persister comme identité de
 * continuation ferait croire qu'un CONTINUE est routable alors qu'il ne l'est
 * pas. Observé tel quel en production le 2026-08.
 */
function isPlaceholderTurnId(value) {
  return (
    typeof value === "string" && value.toLowerCase().includes("placeholder")
  );
}

/** Identifiant externe stable d'un tour assistant : jamais son index ou son compte. */
function turnExternalId(turn) {
  const container = closestOf(turn, SELECTORS.turnContainer);
  // data-testid conversation-turn-N is only a local DOM locator. Persisting it
  // would turn a position/counter into a false continuation identity.
  const id =
    turn.getAttribute("data-message-id") ||
    container?.getAttribute("data-message-id") ||
    null;
  // Aucune identité vaut mieux qu'une identité fabriquée : un placeholder est
  // rejeté ici, jamais remplacé par un identifiant de substitution.
  return isPlaceholderTurnId(id) ? null : id;
}

/** Retrouve le tour assistant portant exactement `externalId`, jamais par position. */
function findAssistantTurnByExternalId(externalId) {
  const turns = document.querySelectorAll(SELECTORS.assistant);
  for (const turn of turns) {
    if (turnExternalId(turn) === externalId) return turn;
  }
  return null;
}

// Vérifie la surface de confidentialité sans jamais muter l'UI. L'URL est
// utilisée uniquement comme propriété de la surface : elle ne sert ni
// d'identité ni de routage de conversation.
const TEMPORARY_CHAT_ORIGINS = new Set([
  "https://chatgpt.com",
  "https://chat.openai.com",
]);
const TEMPORARY_SURFACE_TIMEOUT_MS = 15000;

function temporaryVerificationFailure(reason, url, composerFound, toggleFound) {
  console.warn("temporary_chat_verification_failed", {
    reason,
    origin: url?.origin ?? null,
    pathname: url?.pathname ?? null,
    temporary_param: url?.searchParams.get("temporary-chat") ?? null,
    composer_found: composerFound,
    toggle_found: toggleFound,
    content_script_version: VERSION,
  });
}

async function ensureTemporaryChat() {
  const deadline = Date.now() + TEMPORARY_SURFACE_TIMEOUT_MS;
  let lastReason = "temporary_surface_origin_invalid";
  while (Date.now() < deadline) {
    let url;
    try {
      url = new URL(window.location.href);
    } catch {
      temporaryVerificationFailure(lastReason, null, false, false);
      throw new BridgeError("conversation_unavailable", "surface Temporary Chat invalide");
    }

    const composer = $(SELECTORS.composer);
    const toggleFound = Boolean($(SELECTORS.temporaryChatToggle));
    if (!TEMPORARY_CHAT_ORIGINS.has(url.origin)) {
      lastReason = "temporary_surface_origin_invalid";
    } else if (url.pathname !== "/") {
      lastReason = "temporary_surface_path_invalid";
    } else if (!url.searchParams.has("temporary-chat")) {
      lastReason = "temporary_query_missing";
    } else if (url.searchParams.get("temporary-chat") !== "true") {
      lastReason = "temporary_query_not_true";
    } else if (!composer) {
      lastReason = "temporary_composer_missing";
    } else {
      console.log("bridge_run_phase", { phase: "temporary_verification", state: "verified", content_script_version: VERSION });
      return composer;
    }

    // Origin/path/query violations are deterministic and must not become a
    // generic 15s timeout. Only a missing composer can be an SPA load race.
    if (lastReason !== "temporary_composer_missing") {
      temporaryVerificationFailure(lastReason, url, Boolean(composer), toggleFound);
      throw new BridgeError(
        lastReason === "temporary_surface_path_invalid" ? "conversation_unavailable" : "bridge_ui_timeout",
        `vérification Temporary Chat refusée (${lastReason})`,
      );
    }
    await sleep(100);
  }

  let url = null;
  try { url = new URL(window.location.href); } catch { /* diagnostic below */ }
  temporaryVerificationFailure(lastReason, url, Boolean($(SELECTORS.composer)), Boolean($(SELECTORS.temporaryChatToggle)));
  throw new BridgeError("bridge_ui_timeout", "composer Temporary Chat introuvable");
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

async function handlePrompt({
  id,
  prompt,
  new_chat: newChat,
  files,
  conversation,
  browser_target: browserTarget,
}) {
  if (currentJob) {
    // L'observation post-clic garde l'onglet réservé : un second prompt ne doit
    // ni interrompre cette observation ni toucher au composer avant sa fin.
    if (currentJob.id === id) {
      reply({ type: "ack", id, state: "duplicate", duplicate: true });
      return;
    }
    reply({
      type: "error",
      id,
      code: "conversation_busy",
      message: "un prompt est déjà en cours de confirmation",
      phase: currentJob.phase,
      submission_state: currentJob.submissionState,
    });
    return;
  }
  const job = {
    id,
    aborted: false,
    phase: "pre_submission",
    submissionState: "pre_submission",
  };
  const runDiagnostics = captureRunStartDiagnostics();
  currentJob = job;
  if (!(await claimPrompt(id))) {
    if (currentJob === job) currentJob = null;
    reply({ type: "ack", id, state: "duplicate", duplicate: true });
    return;
  }

  try {
    console.log("bridge_run_phase", { phase: "prompt_received" });
    console.log("bridge_prompt_navigation", {
      conversation_mode: conversation?.mode ?? null,
      has_conversation: Boolean(conversation),
      requested_new_chat: Boolean(newChat),
      browser_target_id: browserTarget?.id ?? null,
    });
    if (!conversation && newChat && !browserTarget) {
      throw new BridgeError(
        "bridge_browser_target_required",
        "un prompt stateless/new_chat exige une browser_target dédiée",
      );
    }
    if (browserTarget && !isBrowserTarget(browserTarget)) {
      throw new BridgeError("bridge_browser_target_required", "browser_target invalide");
    }
    if (newChat && conversation) {
      console.warn("conversation_new_chat_ignored", {
        conversation_id: conversation.id,
        mode: conversation.mode,
      });
    }
    // Toute cible liée au bridge (conversation ou browser_target) doit être
    // positivement confirmée Temporary Chat avant Send — jamais best-effort.
    if (conversation || newChat || browserTarget) await ensureTemporaryChat();

    // CONTINUE : le tour précédent attendu doit exister exactement dans cet
    // onglet, par identité stable — jamais par index ou par comptage — avant
    // qu'on touche au composer. Un onglet repris manuellement où ce tour est
    // absent est rejeté ici, avant tout envoi.
    let baselineTurn = null;
    if (conversation?.mode === "continue") {
      if (!conversation.expected_turn_id) {
        throw new BridgeError(
          "conversation_unavailable",
          "expected_turn_id requis pour continuer une conversation",
        );
      }
      baselineTurn = findAssistantTurnByExternalId(conversation.expected_turn_id);
      if (!baselineTurn) {
        throw new BridgeError(
          "conversation_unavailable",
          "le tour attendu est absent de cet onglet : session non fiable",
        );
      }
    }

    const composer = await waitFor(
      () => $(SELECTORS.composer),
      15000,
      "composer introuvable",
    );
    console.log("bridge_run_phase", { phase: "composer" });
    const assistantTurnsBefore = document.querySelectorAll(SELECTORS.assistant).length;
    const before = assistantTurnsBefore;
    if (!baselineTurn && before) {
      baselineTurn = document.querySelectorAll(SELECTORS.assistant)[before - 1];
    }

    if (files && files.length) await attachFiles(files);
    if (prompt) typePrompt(composer, prompt);
    if (!composerText(composer).trim()) {
      throw new BridgeError("bridge_ui_timeout", "composer vide avant la soumission");
    }

    // Le bouton d'envoi ne devient actif qu'après le rendu de la saisie — et,
    // s'il y a des pièces jointes, qu'une fois leur upload terminé (bien plus long).
    const sendBtn = await waitFor(
      () => {
        const b = $(SELECTORS.send);
        return isSendButtonReady(b) ? b : null;
      },
      files && files.length ? UPLOAD_TIMEOUT_MS : 8000,
      files && files.length
        ? "upload des pièces jointes non terminé"
        : "bouton d'envoi jamais actif",
    );
    // Capture after typing/upload and immediately before the one allowed
    // trigger: the composer text and send state must describe the actual click.
    const submissionBaseline = captureSubmissionSnapshot(composer, sendBtn);
    job.submissionState = "submission_attempted";
    job.phase = "submission_confirmation";
    const submissionMethod = triggerComposerSubmission(composer, sendBtn);
    console.log("bridge_run_phase", {
      phase: "submission_attempted",
      submission_state: "submission_attempted",
      method: submissionMethod,
    });
    await waitForSubmissionConfirmation(
      composer,
      sendBtn,
      submissionBaseline,
      submissionMethod,
    );
    job.submissionState = "post_submission";
    job.phase = "generation";

    if (conversation) {
      reply({
        type: "conversation_bound",
        id,
        conversation: {
          id: conversation.id,
          expected_turn_id: conversation.expected_turn_id ?? null,
          assistant_turns_before: before,
          initial_assistant_turn_id: baselineTurn ? turnExternalId(baselineTurn) : null,
          verified: true,
          verified_at: new Date().toISOString(),
          ephemeral: true,
          external_locator: diagnosticLocator(),
        },
      });
    }

    // Attendre le premier tour assistant *nouveau* (pas le précédent), sans
    // imposer une courte borne murale à une recherche web ou réflexion longue.
    const premier = await waitForFirstAssistantTurn(
      job,
      composer,
      sendBtn,
      submissionBaseline,
      before,
      runDiagnostics,
    );
    if (!premier) return;
    const streamLocator = turnLocator(premier);
    const serialized = await streamAnswer(
      job,
      streamLocator,
      before,
      runDiagnostics,
    );

    if (!job.aborted) {
      // Le nœud `premier` peut être détaché : l'identité vient du tour courant
      // qui a produit ce texte, jamais de la référence gardée avant streaming.
      const externalTurnId = resolveExternalTurnId(
        serialized,
        streamLocator,
        before,
      );
      console.log("bridge_run_phase", { phase: "generation" });
      // Un `done` promet une conversation poursuivable : sans identité externe
      // stable, cette promesse serait fausse. Mais détruire un texte final déjà
      // sérialisé parce que l'UI n'a pas posé de `data-message-id` durable
      // serait pire : on dégrade en `incomplete` typé, candidat joint, sans
      // aucune identité de continuation fabriquée.
      let incomplete = serialized.incomplete === true;
      let reason = serialized.incomplete_reason;
      if (!externalTurnId && !incomplete) {
        if (!serialized.text) {
          throw new BridgeError(
            "conversation_unavailable",
            "aucun identifiant externe data-message-id stable pour le tour assistant",
          );
        }
        incomplete = true;
        reason = "external_turn_identity_unavailable";
      }
      reply({
        type: incomplete ? "incomplete" : "done",
        id,
        reason,
        text: serialized.text,
        submission_state: "post_submission",
        metadata: {
          visible_citations: serialized.visible_citations,
          serializer_version: serialized.serializer_version,
          completion_signal: serialized.completion_signal,
          completion_confidence: serialized.completion_confidence,
          stable_for_ms: serialized.stable_for_ms,
          output_chars:
            globalThis.ChatGPTBridgeFinalOutput.outputChars(serialized.text),
          visible_citation_count: serialized.visible_citations.length,
          content_script_version: VERSION,
          submission_state: "post_submission",
          initial_turn_id: externalTurnId,
          // Diagnostic d'autonomie : état de plan de l'onglet au moment où la
          // fin a été constatée. Sans contenu, jamais un signal de décision.
          ...(serialized.page_state ? { page_state: serialized.page_state } : {}),
          ...(serialized.streaming_signal_sources?.length
            ? { streaming_signal_sources: serialized.streaming_signal_sources }
            : {}),
        },
        conversation: conversation
          ? {
              id: conversation.id,
              mode: conversation.mode,
              turn_id: externalTurnId,
              verified: true,
              ephemeral: true,
              external_locator: diagnosticLocator(),
            }
          : null,
      });
    }
  } catch (err) {
    if (!job.aborted) {
      reply({
        type: "error",
        id,
        code: err.code || "bridge_server_error",
        message: err.message,
        phase: job.phase,
        diagnostics: err.diagnostics || {
          content_script_version: VERSION,
          page_state: pageStateDiagnostics(Date.now(), { run: runDiagnostics }),
        },
        target_id: browserTarget?.id ?? null,
        conversation: conversation
          ? { id: conversation.id, mode: conversation.mode }
          : null,
        submission_state: job.submissionState,
      });
    }
  } finally {
    if (currentJob === job) currentJob = null;
    // Aucun observateur ne survit à un job : ni fuite entre deux runs, ni
    // réveil d'une boucle qui n'existe plus.
    disconnectDomWatchers();
  }
}

function boundedRecoveryCitations(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 50).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const citation = {};
    for (const key of ["label", "url", "canonical_url"]) {
      if (typeof item[key] === "string") citation[key] = item[key].slice(0, 2048);
    }
    if (Number.isInteger(item.position) && item.position >= 0 && item.position <= 500) {
      citation.position = item.position;
    }
    return Object.keys(citation).length ? [citation] : [];
  });
}

async function captureLaterResponse(msg) {
  const stateless = Boolean(msg.browser_target);
  if (
    stateless &&
    (!isBrowserTarget(msg.browser_target) ||
      typeof msg.bridge_run_id !== "string" ||
      !msg.bridge_run_id)
  ) {
    return {
      type: "recovery_preview",
      id: msg.id,
      error: "binding de recovery invalide",
    };
  }

  const turns = [...document.querySelectorAll(SELECTORS.assistant)];
  const expectedTurnId = msg.assistant_turn_id;
  const candidates =
    typeof expectedTurnId === "string" && expectedTurnId
      ? turns.filter((turn) => turnExternalId(turn) === expectedTurnId)
      : Number.isInteger(Number(msg.conversation?.assistant_turns_before))
        ? turns.slice(Number(msg.conversation.assistant_turns_before))
        : turns;

  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const turn = candidates[index];
    const completion = completionState(turn);

    // Stateless recovery is strict: a visible answer must be explicitly final.
    // Conversation-backed recovery keeps its existing human-preview tolerance
    // for an unknown completion signal.
    if (stateless ? completion.finished !== true : completion.finished === false) continue;

    const turnId = turnExternalId(turn);
    if (!turnId) continue;
    const root = answerRoot(turn, true);
    const serialized = root ? readAnswer(root, false) : null;
    if (!serialized?.text?.trim()) continue;

    // React may replace the turn between the two reads. Re-read the same
    // external message id and accept only unchanged text and completion state;
    // this remains entirely read-only (no click, input, or requestSubmit).
    const verificationTurn = findAssistantTurnByExternalId(turnId);
    if (!verificationTurn) continue;
    const verificationCompletion = completionState(verificationTurn);
    if (stateless && verificationCompletion.finished !== true) continue;
    if (!stateless && verificationCompletion.finished === false) continue;
    const verificationRoot = answerRoot(verificationTurn, true);
    const verification = verificationRoot
      ? readAnswer(verificationRoot, false)
      : null;
    if (!verification?.text?.trim() || verification.text !== serialized.text) continue;

    return {
      type: "recovery_preview",
      id: msg.id,
      target_id: stateless ? msg.browser_target.id : null,
      bridge_run_id: stateless ? msg.bridge_run_id : null,
      text: verification.text,
      conversation_id: msg.conversation?.id || null,
      external_locator: diagnosticLocator(),
      turn_id: turnId,
      metadata: {
        visible_citations: boundedRecoveryCitations(verification.visible_citations),
        serializer_version:
          typeof verification.serializer_version === "string"
            ? verification.serializer_version.slice(0, 64)
            : null,
        output_chars: globalThis.ChatGPTBridgeFinalOutput.outputChars(
          verification.text,
        ),
        completion_signal: verificationCompletion.signal,
        completion_confidence: verificationCompletion.confidence,
        content_script_version: VERSION,
        capture_confidence:
          verificationCompletion.finished === true
            ? "verified_final"
            : "visible_unknown",
      },
    };
  }
  return {
    type: "recovery_preview",
    id: msg.id,
    target_id: stateless ? msg.browser_target.id : null,
    bridge_run_id: stateless ? msg.bridge_run_id : null,
    error: "aucune réponse finale postérieure au tour initial",
  };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "ui_state" || msg?.type === "ui_control") {
    // Requête/réponse : le service worker attend la valeur, d'où le `return true`
    // sans acquittement immédiat (un seul `sendResponse` est autorisé).
    handleUi(msg).then(sendResponse);
    return true;
  }
  if (msg?.type === "recovery_capture") {
    captureLaterResponse(msg).then(sendResponse);
    return true;
  }
  if (msg?.type === "observe_tick") {
    // Horloge insensible au throttling d'arrière-plan : elle ne fait que
    // réveiller la boucle du job exact. Elle n'émet ni heartbeat ni `done`,
    // et ne peut donc jamais prétendre à la santé de l'observateur DOM.
    sendResponse({ ok: true, woken: handleObservationTick(msg) });
    return true;
  }
  if (msg?.type === "prompt") {
    handlePrompt(msg);
  } else if (msg?.type === "abort") {
    if (currentJob && currentJob.id === msg.id) currentJob.aborted = true;
    const stop = $(SELECTORS.stop);
    if (stop) stop.click();
  }
  sendResponse({ ok: true });
  return true;
});

console.log(
  `🔌 ChatGPT Mini-Bridge : content script prêt — version ${VERSION}`,
);
