/**
 * Content script injecté sur chatgpt.com : reçoit un prompt du service worker,
 * le tape dans le composer, puis observe le DOM avant de renvoyer un snapshot final.
 *
 * Tous les sélecteurs dépendants de l'UI OpenAI sont regroupés dans SELECTORS
 * ci-dessous : c'est le seul bloc à retoucher si l'interface change.
 */

// Affichée au chargement : permet de vérifier dans la console quel code tourne
// réellement dans l'onglet (recharger l'extension ne suffit pas à le remplacer).
const VERSION = "37";

// Journalise dans la console les décisions de la boucle de streaming, à chaque
// changement d'état. Utile quand l'UI d'OpenAI change et qu'une réponse arrive
// tronquée ou dupliquée : la ligne indique l'état de fin détecté, le conteneur
// lu et le nombre de blocs de code vus.
const DEBUG = false;

const SELECTORS = {
  composer: [
    "[data-composer-markdown][contenteditable='true'][role='textbox']",
    "#prompt-textarea",
    "[data-testid='prompt-textarea']",
    "div[contenteditable='true'][id^='prompt']",
    "textarea[data-id]",
    "[contenteditable='true'][role='textbox']",
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

  // --- Réponse (ResponseRoot) --- //
  // La nouvelle UI ne pose plus ni rôle, ni message id, ni tour : le contenu
  // de la réponse est rendu dans un div dont UNE CLASSE COMMENCE par ce
  // préfixe. Le suffixe est généré : il ne doit jamais être écrit en dur dans
  // un sélecteur (`.MarkdownRoot-rZKhxa`). Le sélecteur ci-dessous n'est qu'un
  // pré-filtre borné ; c'est `isMarkdownRootElement()` qui tranche sur les
  // tokens de classe.
  responseRootClassPrefix: "MarkdownRoot-",
  markdownRootCandidate: "[class*='MarkdownRoot-']",
  // Feuilles inline : preuve qu'un ResponseRoot porte du contenu
  // conversationnel, JAMAIS une réponse en soi (jamais « le dernier span »).
  inlineMarkdown: ["[class*='inline-markdown']", "[class*='InlineMarkdown']"],
  // Chrome applicatif : en-tête, navigation, panneaux, menus, popovers,
  // modales. Rien de tout cela n'est une conversation — le diagnostic réel a
  // déjà montré `data-testid="app-shell-header-context-menu-surface"` sur un
  // nœud qui ne doit jamais être pris pour une réponse.
  nonConversationSurface: [
    "header",
    "nav",
    "aside",
    "footer",
    "[role='dialog']",
    "[role='menu']",
    "[role='listbox']",
    "[role='toolbar']",
    "[role='tooltip']",
    "[data-testid*='menu']",
    "[data-testid*='modal']",
    "[data-testid*='popover']",
    "[data-testid*='header']",
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

// Au-delà de ce volume, coller le prompt dans le contenteditable de ChatGPT
// fait exploser l'activité ProseMirror/React : l'onglet monte à plusieurs Go,
// le renderer ne répond plus et aucun heartbeat ne repart. Le prompt part donc
// en pièce jointe texte et le composer ne reçoit qu'une courte consigne.
// Le seuil porte sur les octets UTF-8, pas sur `text.length`.
const LARGE_PROMPT_FILE_THRESHOLD_BYTES = 200_000;

function utf8ByteLength(text) {
  return new TextEncoder().encode(text).byteLength;
}

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

// Le contrat de réponse (ResponseRoot) a ses propres bornes, distinctes de
// celles de l'activité :
//
//   - `RESPONSE_CONTRACT_DRIFT_MS` : des feuilles `inline-markdown` sont
//     visibles alors qu'AUCUN ResponseRoot n'est résolvable. C'est la
//     signature exacte d'un nouveau changement d'UI : au-delà de cette
//     fenêtre bornée, on échoue en `bridge_response_contract_drift` — la borne
//     d'activité de 300 s, elle, ne dit rien de la structure.
//   - `RESPONSE_AMBIGUITY_HOLD_MS` : deux ResponseRoots nouveaux simultanés.
//     React peut monter deux nœuds le temps d'une frame ; l'ambiguïté doit
//     persister avant de conclure. Aucun choix arbitraire n'est jamais fait.
const RESPONSE_CONTRACT_DRIFT_MS = 20000;
const RESPONSE_AMBIGUITY_HOLD_MS = 1500;
// Bornes de taille : une signature ou un snapshot structurel ne doivent jamais
// pouvoir être gonflés par une page pathologique.
const RESPONSE_SIGNATURE_MAX_TOKENS = 6;
const RESPONSE_SIGNATURE_MAX_TOKEN_LENGTH = 40;
const MAX_INLINE_LEAF_COUNT = 999;
const STRUCTURE_LIMITS = {
  max_depth: 6,
  max_nodes: 200,
  max_children: 40,
  max_roots: 4,
  max_class_tokens: 8,
  max_token_length: 40,
  max_value_length: 64,
};

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

const STRUCTURAL_COMPOSER_SELECTOR =
  "[contenteditable='true'][role='textbox']";

/** Visible in the current document, without reading or logging user content. */
function isVisibleElement(el) {
  if (!el || !el.isConnected) return false;
  const style = globalThis.getComputedStyle?.(el);
  if (style?.display === "none" || style?.visibility === "hidden") return false;
  if (typeof el.getClientRects === "function" && el.getClientRects().length === 0) {
    return false;
  }
  return true;
}

function isComposerElement(el) {
  if (!el) return false;
  const tag = el.tagName;
  return (
    tag === "TEXTAREA" ||
    tag === "INPUT" ||
    el.getAttribute("contenteditable") === "true"
  );
}

function looksLikeStructuralComposer(el) {
  return (
    el.hasAttribute("data-composer-markdown") ||
    el.getAttribute("aria-multiline") === "true" ||
    el.classList?.contains("ProseMirror") ||
    Boolean(el.querySelector("p[data-placeholder]"))
  );
}

function uiResolution(strategy, selector, candidateCount, element) {
  return {
    element: element || null,
    strategy,
    selector,
    candidate_count: candidateCount,
  };
}

function visibleMatches(root, selector, predicate = () => true) {
  return [...root.querySelectorAll(selector)].filter(
    (el) => isVisibleElement(el) && predicate(el),
  );
}

/** Inspect composer structure without reading any editable or rendered text. */
function inspectComposer(root = document) {
  const namedSelectors = SELECTORS.composer.filter(
    (selector) => selector !== STRUCTURAL_COMPOSER_SELECTOR,
  );
  const knownElements = new Set();
  for (const selector of namedSelectors) {
    const candidates = visibleMatches(root, selector, isComposerElement);
    for (const candidate of candidates) knownElements.add(candidate);
    if (candidates.length > 1) {
      return {
        element: null,
        status: "ambiguous",
        strategy: "named_selector",
        selector,
        visible_candidates: candidates.length,
        known_selector_candidates: knownElements.size,
        structural_candidates: visibleMatches(root, STRUCTURAL_COMPOSER_SELECTOR).length,
      };
    }
    if (candidates.length === 1) {
      return {
        element: candidates[0],
        status: "ok",
        strategy: "named_selector",
        selector,
        visible_candidates: candidates.length,
        known_selector_candidates: knownElements.size,
        structural_candidates: visibleMatches(root, STRUCTURAL_COMPOSER_SELECTOR).length,
      };
    }
  }

  const candidates = visibleMatches(root, STRUCTURAL_COMPOSER_SELECTOR);
  const structural = {
    element: null,
    status: candidates.length > 1 ? "ambiguous" : "missing",
    strategy: "structural_fallback",
    selector: STRUCTURAL_COMPOSER_SELECTOR,
    visible_candidates: candidates.length,
    known_selector_candidates: knownElements.size,
    structural_candidates: candidates.length,
  };
  if (candidates.length !== 1) return structural;

  const candidate = candidates[0];
  if (
    (candidate.closest("form") || candidate.hasAttribute("data-composer-markdown")) &&
    looksLikeStructuralComposer(candidate)
  ) {
    return { ...structural, element: candidate, status: "degraded" };
  }
  return { ...structural, visible_candidates: 0 };
}

/** Inspect Send in the exact composer form when one exists. */
function inspectSendButton(composer, root = document) {
  const form = composer?.closest("form") || null;
  const searchRoot = form || root;
  for (const selector of SELECTORS.send) {
    const candidates = visibleMatches(
      searchRoot,
      selector,
      (el) => el.tagName === "BUTTON",
    );
    if (candidates.length > 1) {
      return {
        element: null,
        status: "ambiguous",
        strategy: "named_selector",
        selector,
        visible_candidates: candidates.length,
        same_form_as_composer: false,
      };
    }
    if (candidates.length === 1) {
      return {
        element: candidates[0],
        status: "ok",
        strategy: "named_selector",
        selector,
        visible_candidates: 1,
        same_form_as_composer: Boolean(form && candidates[0].closest("form") === form),
      };
    }
  }

  const candidates = form
    ? visibleMatches(form, "button[type='submit']", (el) => el.tagName === "BUTTON")
    : [];
  if (candidates.length > 1) {
    return {
      element: null,
      status: "ambiguous",
      strategy: "structural_fallback",
      selector: "button[type='submit']",
      visible_candidates: candidates.length,
      same_form_as_composer: false,
    };
  }
  if (candidates.length === 1) {
    return {
      element: candidates[0],
      status: "degraded",
      strategy: "structural_fallback",
      selector: "button[type='submit']",
      visible_candidates: 1,
      same_form_as_composer: candidates[0].closest("form") === form,
    };
  }
  return {
    element: null,
    status: "missing",
    strategy: "structural_fallback",
    selector: "button[type='submit']",
    visible_candidates: 0,
    same_form_as_composer: false,
  };
}

/**
 * État du contrat de réponse pour le diagnostic, sans contenu : surface,
 * comptages de roots et dernière décision du locator pendant un run.
 */
function responseLocatorHealth() {
  const collected = resolveResponseRoots();
  const last = lastResponseLocatorDiagnostic;
  return {
    conversation_surface: Boolean(collected.surface_element),
    surface_strategy: collected.surface_strategy || null,
    strategy: last?.strategy ?? null,
    baseline_root_count: last?.baseline_root_count ?? collected.markdown.length,
    current_root_count: collected.markdown.length,
    candidate_found: last?.candidate_found === true,
    candidate_root_tag: last?.candidate_root_tag ?? null,
    markdown_root: last ? last.markdown_root : collected.markdown.length > 0,
    inline_leaf_count: collected.inline_leaf_count,
    ambiguity_count: last?.ambiguity_count ?? 0,
  };
}

/** Bounded UI snapshot. This function deliberately never reads page text. */
function domHealthSnapshot() {
  let url = null;
  try {
    url = new URL(window.location.href);
  } catch {
    // A failed URL parse is represented by the fixed safe defaults below.
  }
  const originOk = Boolean(url && TEMPORARY_CHAT_ORIGINS.has(url.origin));
  const pathname = typeof url?.pathname === "string" ? url.pathname.slice(0, 128) : "";
  const temporaryQuery = url?.searchParams.get("temporary-chat") === "true";
  const composer = inspectComposer();
  const send = composer.element
    ? inspectSendButton(composer.element)
    : {
        element: null,
        status: "missing",
        strategy: "structural_fallback",
        selector: "button[type='submit']",
        visible_candidates: 0,
        same_form_as_composer: false,
      };
  const composerElement = composer.element;
  const composerText = composerElement
    ? ("value" in composerElement ? composerElement.value : composerElement.textContent)
    : "";
  const pageSendButtons = composerElement
    ? new Set([
        ...SELECTORS.send.flatMap((selector) => visibleMatches(document, selector, (el) => el.tagName === "BUTTON")),
        ...visibleMatches(document, "button[type='submit']", (el) => el.tagName === "BUTTON"),
      ])
    : new Set();
  const idleSendNotRendered =
    composer.status === "ok" && !String(composerText || "").trim() &&
    !send.element && send.status === "missing" && pageSendButtons.size === 0;
  const visibilityState = ["visible", "hidden", "prerender", "unloaded"].includes(
    document.visibilityState,
  )
    ? document.visibilityState
    : "unknown";

  return {
    ok: true,
    content_script_version: VERSION,
    surface: {
      origin_ok: originOk,
      pathname,
      temporary_query: temporaryQuery,
      temporary_status: originOk && pathname === "/" && temporaryQuery ? "ok" : "invalid",
      visibility_state: visibilityState,
      has_focus: Boolean(document.hasFocus?.()),
    },
    composer: {
      status: composer.status,
      strategy: composer.strategy,
      selector: composer.selector,
      visible_candidates: composer.visible_candidates,
      known_selector_candidates: composer.known_selector_candidates,
      structural_candidates: composer.structural_candidates,
      tag: composer.element?.tagName || null,
      role: composer.element?.getAttribute("role") === "textbox" ? "textbox" : null,
      contenteditable: composer.element?.getAttribute("contenteditable") === "true",
      data_composer_markdown: Boolean(
        composer.element?.hasAttribute("data-composer-markdown"),
      ),
      form_found: Boolean(composer.element?.closest("form")),
    },
    response_locator: responseLocatorHealth(),
    send: {
      // dom_health est un diagnostic read-only : un composer vide n'affiche
      // pas toujours Send. Le runtime, lui, garde son attente post-injection.
      status: idleSendNotRendered ? "not_rendered_idle" : send.status,
      strategy: send.strategy,
      selector: send.selector,
      visible_candidates: send.visible_candidates,
      type: send.element && ["button", "submit", "reset"].includes(send.element.type)
        ? send.element.type
        : send.element
          ? "other"
          : null,
      disabled: Boolean(send.element?.disabled),
      aria_disabled: send.element?.getAttribute("aria-disabled") === "true",
      same_form_as_composer: idleSendNotRendered ? null : send.same_form_as_composer,
    },
  };
}

function warnIfDegraded(component, resolution) {
  if (resolution?.strategy !== "structural_fallback" || !resolution.element) return;
  console.warn("bridge_dom_contract_degraded", {
    component,
    strategy: resolution.strategy,
    selector: resolution.selector,
    candidate_count: resolution.candidate_count,
    content_script_version: VERSION,
  });
}

function uiContractError(kind, resolution, message) {
  const error = new BridgeError("bridge_ui_timeout", message);
  error.diagnostics = {
    ui_contract_error: kind,
    ...(kind.includes("composer")
      ? {
          composer_strategy: resolution.strategy,
          composer_selector: resolution.selector,
          composer_candidate_count: resolution.candidate_count,
        }
      : {
          send_strategy: resolution.strategy,
          send_selector: resolution.selector,
          send_candidate_count: resolution.candidate_count,
        }),
    content_script_version: VERSION,
  };
  error.diagnostics.dom_health = domHealthSnapshot();
  return error;
}

function addPostInjectionUiDiagnostics(error) {
  const health = domHealthSnapshot();
  const composer = health.composer || {};
  const send = health.send || {};
  // À l'instant runtime, l'injection a eu lieu : idle n'est plus une
  // explication recevable pour l'absence de Send.
  if (health.send?.status === "not_rendered_idle") health.send.status = "missing";
  error.diagnostics = {
    ...(error.diagnostics || {}),
    composer_status: composer.status || "missing",
    send_status: send.status === "not_rendered_idle" ? "missing" : send.status || "missing",
    prompt_injected: true,
    send_candidates: Number.isInteger(send.visible_candidates) ? send.visible_candidates : 0,
    form_found: composer.form_found === true,
    content_script_version: VERSION,
    dom_health: health,
  };
  return error;
}

/** Resolve a unique, visible composer or report the UI contract ambiguity. */
function resolveComposer(root = document) {
  const inspected = inspectComposer(root);
  const resolution = uiResolution(
    inspected.strategy,
    inspected.selector,
    inspected.visible_candidates,
    inspected.element,
  );
  if (inspected.status === "ambiguous") {
    throw uiContractError(
      "ambiguous_composer",
      resolution,
      inspected.strategy === "named_selector"
        ? "plusieurs composers correspondent au même sélecteur"
        : "plusieurs zones de texte peuvent être le composer",
    );
  }
  return resolution;
}

/** Resolve Send inside the composer's form whenever the form is available. */
function resolveSendButton(composer, root = document) {
  const inspected = inspectSendButton(composer, root);
  if (inspected.status === "ambiguous") {
    throw uiContractError(
      "ambiguous_send_button",
      uiResolution(inspected.strategy, inspected.selector, inspected.visible_candidates),
      inspected.strategy === "named_selector"
        ? "plusieurs boutons Send correspondent au même sélecteur"
        : "plusieurs boutons submit sont présents dans le formulaire du composer",
    );
  }
  return uiResolution(
    inspected.strategy,
    inspected.selector,
    inspected.visible_candidates,
    inspected.element,
  );
}

async function waitForComposer(timeout, label) {
  const deadline = Date.now() + timeout;
  let resolution = resolveComposer();
  while (Date.now() < deadline) {
    if (resolution.element) return resolution;
    await sleep(100);
    resolution = resolveComposer();
  }
  throw uiContractError(
    "composer_missing",
    resolution,
    label || "composer introuvable",
  );
}

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

/**
 * Le composer contient-il au moins un caractère non blanc ?
 *
 * Volontairement booléen : les boucles de confirmation n'ont besoin que de
 * cette information, et lire `innerText` (ou même `textContent`) sur un
 * contenteditable de plusieurs dizaines de kilo-octets déclenche un layout et
 * reconstruit une chaîne énorme à chaque poll. Le TreeWalker s'arrête au
 * premier nœud texte non vide et n'alloue rien.
 */
function composerHasText(el) {
  if (!el) return false;
  if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
    return /\S/.test(el.value || "");
  }
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    if (/\S/.test(node.nodeValue || "")) return true;
  }
  return false;
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
    composerHasText: composerHasText(composer),
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
    composer_was_non_empty: snapshot.composerHasText,
    composer_still_has_text: after.composerHasText,
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
    // Uniquement la transition true → false. Un composer déjà vide avant Send
    // (gros collage converti en pièce jointe par ChatGPT) reste vide après :
    // `false → false` n'est aucune preuve de soumission.
    else if (snapshot.composerHasText && !after.composerHasText)
      signal = "composer_cleared";
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

/**
 * Diagnostic d'attente du premier ResponseRoot, sans contenu : comptages,
 * booléens et dernière décision du locator.
 */
function responseWaitDiagnostics(
  composer,
  sendBtn,
  snapshot,
  responseBaseline,
  startedAt,
  candidate,
) {
  const after = captureSubmissionSnapshot(composer, sendBtn);
  const collected = resolveResponseRoots();
  return {
    content_script_version: VERSION,
    elapsed_ms: Math.max(0, Date.now() - startedAt),
    assistant_turns_before: snapshot.assistantTurns,
    assistant_turns_after: after.assistantTurns,
    user_turns_before: snapshot.userTurns,
    user_turns_after: after.userTurns,
    composer_has_text: after.composerHasText,
    send_enabled: after.sendState.ready,
    send_disabled: !after.sendState.ready,
    stop_visible: after.generation.stop,
    reasoning_visible: after.generation.reasoning,
    streaming_generation_signal_visible: after.generation.present,
    streaming_signal_sources: streamingSignalSources(document),
    response_locator: responseLocatorDiagnostic(candidate),
    conversation_surface_found: Boolean(collected.surface_element),
    conversation_surface_strategy: collected.surface_strategy || null,
    baseline_root_count: responseBaseline?.markdownRootCount || 0,
    current_root_count: collected.markdown.length,
    inline_leaf_count: collected.inline_leaf_count,
  };
}

/**
 * Détails sûrs d'une dérive de contrat de réponse : comptages et booléens
 * uniquement — jamais un caractère de contenu, jamais un identifiant externe.
 */
function responseContractDriftDetails(reason, candidate) {
  const collected = resolveResponseRoots();
  const strategies = [];
  if (collected.semantic.length) strategies.push("semantic_assistant");
  if (collected.markdown.length) strategies.push("markdown_root_delta");
  return {
    reason,
    response_root_strategies: strategies,
    semantic_assistant_matches: collected.semantic.length,
    markdown_root_matches: collected.markdown.length,
    inline_leaf_matches: collected.inline_leaf_count,
    baseline_root_count: candidate?.baseline_root_count ?? 0,
    current_root_count: candidate?.current_root_count ?? collected.markdown.length,
    conversation_surface_found: Boolean(collected.surface_element),
    conversation_surface_strategy: collected.surface_strategy || null,
    candidate_root_count: candidate?.candidate_count ?? 0,
    submission_state: "post_submission",
    content_script_version: VERSION,
  };
}

/**
 * Contrat de réponse illisible après un Send confirmé : deux candidats
 * simultanés impossibles à départager, ou des feuilles `inline-markdown` sans
 * ResponseRoot résolvable. Fail closed : aucun choix arbitraire, aucune
 * resoumission, et surtout pas de réponse inventée.
 */
function responseContractDriftError(reason, candidate) {
  const details = responseContractDriftDetails(reason, candidate);
  console.warn("bridge_response_contract_drift", details);
  const error = new BridgeError(
    "bridge_response_contract_drift",
    `contrat DOM de la réponse non résolu après la soumission (${reason})`,
  );
  error.diagnostics = details;
  return error;
}

/**
 * Attend le premier ResponseRoot créé par le Send déjà confirmé.
 *
 * Ce n'est délibérément pas une borne murale d'apparition : ChatGPT peut
 * passer plusieurs minutes en recherche web ou en réflexion avant de rendre
 * quoi que ce soit de lisible.
 *
 * L'activité est une *transition* depuis le dernier état de signaux observé,
 * jamais une comparaison répétée avec le snapshot d'avant-Send. Cette
 * distinction compte pour deux défaillances symétriques :
 *   - un signal déjà visible avant le Send n'est jamais compté (il n'a pas de
 *     transition) ;
 *   - un signal apparu après le Send puis figé est compté exactement une fois,
 *     donc une UI bloquée atteint bien FIRST_ASSISTANT_ACTIVITY_STALL_MS au
 *     lieu d'être maintenue en vie par sa propre persistance.
 * Un vrai mouvement (apparition, disparition, changement d'état, nouveau
 * nœud) repousse la borne aussi longtemps que l'UI bouge réellement.
 *
 * Le candidat vient du DELTA structurel : la stratégie historique d'abord,
 * puis le delta des MarkdownRoots contre le baseline d'avant-Send. Deux
 * dérives de contrat sont détectées ici, bornées et fail closed :
 *   - ambiguïté persistante : deux nouveaux ResponseRoots simultanés ;
 *   - feuilles inline visibles mais aucun ResponseRoot résolvable.
 */
async function waitForResponseCandidate(
  job,
  composer,
  sendBtn,
  submissionSnapshot,
  responseBaseline,
  run,
) {
  const startedAt = Date.now();
  let lastActivityAt = startedAt;
  let lastHeartbeatAt = startedAt;
  let lastObservationAt = startedAt;
  let observationsSinceActivity = 0;
  // Baseline = l'état observé à la soumission : un signal déjà présent est donc
  // déjà « vu » et ne peut pas être compté comme une apparition.
  let observedSignals = submissionSnapshot.generation;
  // Fenêtres bornées propres au contrat de réponse (cf. constantes).
  let ambiguousSince = null;
  let unresolvedLeavesSince = null;
  let candidate = null;
  const watcher = createDomWatcher("response_root");

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

      candidate = resolveResponseCandidate(responseBaseline);
      recordResponseLocator(candidate);
      if (candidate.status === "found") return candidate;

      if (candidate.status === "ambiguous") {
        if (ambiguousSince === null) ambiguousSince = now;
        if (now - ambiguousSince >= RESPONSE_AMBIGUITY_HOLD_MS) {
          throw responseContractDriftError("ambiguous_response_roots", candidate);
        }
      } else {
        ambiguousSince = null;
      }

      // Le contenu conversationnel est là (feuilles inline visibles) mais aucun
      // ResponseRoot n'est résolvable : c'est un changement d'UI, pas une
      // attente. Borné, donc : fail closed avec un diagnostic attribuable.
      if (
        candidate.inline_leaf_count > 0 &&
        candidate.raw_candidate_count === 0
      ) {
        if (unresolvedLeavesSince === null) unresolvedLeavesSince = now;
        if (now - unresolvedLeavesSince >= RESPONSE_CONTRACT_DRIFT_MS) {
          throw responseContractDriftError(
            "inline_markdown_without_response_root",
            candidate,
          );
        }
      } else {
        unresolvedLeavesSince = null;
      }

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
          "aucune réponse rendue après la soumission du prompt",
        );
        error.diagnostics = {
          ...responseWaitDiagnostics(
            composer,
            sendBtn,
            submissionSnapshot,
            responseBaseline,
            startedAt,
            candidate,
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

/** Sélectionne tout le contenu du composer, cible du collage. */
function selectComposerContents(el) {
  const range = document.createRange();
  range.selectNodeContents(el);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

/**
 * Collage entièrement synthétique : `DataTransfer` + `ClipboardEvent`.
 *
 * Jamais `navigator.clipboard` — cela demanderait une permission, le focus de
 * l'onglet, et écraserait le presse-papiers réel de l'utilisateur.
 *
 * Retourne `event.defaultPrevented` : c'est la SEULE preuve que l'éditeur a
 * pris le collage en charge. ProseMirror appelle `preventDefault()` puis
 * applique sa propre transaction — dont le résultat peut être du texte dans le
 * composer *ou* une pièce jointe créée par ChatGPT. L'état du composer ne dit
 * donc rien sur la réussite du collage.
 */
function dispatchPromptPaste(el, text) {
  const dataTransfer = new DataTransfer();
  dataTransfer.setData("text/plain", text);
  const event = new ClipboardEvent("paste", {
    clipboardData: dataTransfer,
    bubbles: true,
    cancelable: true,
    composed: true,
  });
  el.dispatchEvent(event);

  return event.defaultPrevented;
}

/**
 * Écrit `text` dans le composer.
 *
 * Sur un contenteditable, l'insertion passe par UN SEUL évènement `paste`
 * synthétique : ProseMirror le traite en une transaction unique. L'ancienne
 * insertion par commande d'édition (`insertText`) produisait au contraire une
 * avalanche de mutations DOM qui figeait le renderer sur les gros prompts —
 * elle est définitivement supprimée, y compris en repli. Aucun découpage, et aucun
 * second `input` émis à la main : l'éditeur émet le sien.
 *
 * Le succès se lit sur `event.defaultPrevented`, jamais sur le contenu du
 * composer : au-delà d'une certaine taille, ChatGPT accepte le collage puis le
 * convertit lui-même en pièce jointe et laisse le contenteditable vide. Un
 * composer vide après un collage consommé est donc parfaitement valide ; la
 * disponibilité réelle est ensuite vérifiée par le bouton Send.
 */
async function typePrompt(el, text) {
  el.focus();

  if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
    const prototype =
      el.tagName === "TEXTAREA"
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (!setter) {
      throw new BridgeError(
        "bridge_prompt_injection_failed",
        "setter natif du composer introuvable",
      );
    }
    setter.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return "native_value";
  }

  selectComposerContents(el);

  const handled = dispatchPromptPaste(el, text);
  if (!handled) {
    throw new BridgeError(
      "bridge_prompt_injection_failed",
      "le paste synthétique n'a pas été pris en charge par le composer ChatGPT",
    );
  }

  return "synthetic_paste";
}

/** Nom de fichier sûr et déterministe dérivé de l'identifiant du run. */
function safePromptFileId(id) {
  return String(id || "run")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .slice(0, 64);
}

/**
 * Fichier texte contenant EXACTEMENT le prompt : aucune troncature, aucune
 * normalisation, aucun en-tête ajouté.
 */
function createLargePromptFile(id, prompt) {
  return new File([prompt], `bridge-prompt-${safePromptFileId(id)}.txt`, {
    type: "text/plain;charset=utf-8",
  });
}

/**
 * Consigne courte déposée dans le composer quand le prompt part en fichier.
 * Elle ne contient jamais le prompt ni un extrait de celui-ci.
 */
function largePromptInstruction(filename) {
  return (
    `Le message utilisateur complet est joint dans le fichier "${filename}". ` +
    "Lis ce fichier intégralement et traite son contenu comme le message " +
    "utilisateur auquel tu dois répondre."
  );
}

/** Décode une pièce jointe sérialisée (base64) venant du serveur. */
function decodeAttachmentFile(f) {
  const bin = atob(f.data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new File([bytes], f.name, {
    type: f.mime || "application/octet-stream",
  });
}

/**
 * Dépose des fichiers dans le composer.
 * ChatGPT écoute un `input[type=file]` caché : on lui injecte un FileList
 * fabriqué via DataTransfer, seule façon d'alimenter un input file par script.
 */
async function attachFileObjects(fileObjects) {
  if (!fileObjects.length) return;

  const input = $(SELECTORS.fileInput);
  if (!input) throw new Error("champ d'upload introuvable sur la page");

  const dt = new DataTransfer();
  for (const file of fileObjects) dt.items.add(file);

  input.files = dt.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
  // Repli : certaines versions de l'UI n'écoutent que le drop sur le composer.
  const composer = resolveComposer().element;
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
 * Pièces jointes de la requête + fichiers fabriqués localement (gros prompt),
 * dans UN SEUL `DataTransfer` : deux opérations d'attachement distinctes
 * déclencheraient deux uploads et pourraient écraser le premier lot.
 */
async function attachFiles(files, extraFiles = []) {
  const fileObjects = [
    ...(files || []).map(decodeAttachmentFile),
    ...extraFiles,
  ];
  await attachFileObjects(fileObjects);
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
  // Observation pure : `inspect*` ne lève jamais. Une ambiguïté transitoire du
  // composer après l'envoi signifie « pas de signal », jamais une erreur de
  // contrat UI qui ferait échouer un tour déjà soumis.
  const composer = inspectComposer().element;
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
    sendVisible: Boolean(composer && inspectSendButton(composer).element),
  });
}

// --------------------------------------------------------------------------- //
// Localisation de la réponse : ResponseRoot
//
// Un ResponseRoot est « le contenu rendu de la réponse produite APRÈS la
// soumission du prompt ». Deux stratégies le résolvent, dans cet ordre :
//
//   1. `semantic_assistant`  — UI historique :
//      `[data-message-author-role="assistant"]` et son answer root historique
//      (`answerRoot`). Ce sélecteur est intrinsèquement sémantique (il ne peut
//      désigner qu'un message), il garde donc son périmètre d'origine.
//   2. `markdown_root_delta` — UI observée en production : ni
//      `data-message-author-role`, ni `data-message-id`, ni `data-turn`, ni
//      `conversation-turn`, ni `<article>`. Le contenu vit dans un `div` dont
//      une classe COMMENCE par « MarkdownRoot- » (suffixe généré : jamais
//      écrit en dur dans un sélecteur). L'identité du candidat vient d'un
//      DELTA structurel mesuré contre le baseline capturé juste avant le Send —
//      jamais « le dernier MarkdownRoot de la page ».
//
// Une réponse reste UN seul ResponseRoot, quel que soit le nombre de feuilles
// `inline-markdown` / `InlineMarkdown…` qu'elle contient : ces feuilles ne sont
// qu'une preuve de contenu conversationnel, jamais une réponse.
// --------------------------------------------------------------------------- //

/** Un token de classe commence-t-il par `prefix` ? (suffixe généré toléré) */
function hasClassPrefix(el, prefix) {
  if (!el || !el.classList) return false;
  for (const token of el.classList) {
    if (token.startsWith(prefix)) return true;
  }
  return false;
}

/** `div MarkdownRoot-*` : content root d'une réponse dans la nouvelle UI. */
function isMarkdownRootElement(el) {
  return (
    el?.nodeType === Node.ELEMENT_NODE &&
    hasClassPrefix(el, SELECTORS.responseRootClassPrefix)
  );
}

/** Tout élément du chrome applicatif : jamais une conversation. */
function isApplicationChrome(el) {
  if (!el?.closest) return false;
  for (const selector of SELECTORS.nonConversationSurface) {
    if (el.closest(selector)) return true;
  }
  return false;
}

/** Composer courant (jamais une référence gardée) : le périmètre interdit. */
function composerScope(root = document) {
  const composer = inspectComposer(root).element;
  if (!composer) return null;
  return composer.closest("form") || composer;
}

function isInsideComposer(el, root = document) {
  const scope = composerScope(root);
  return Boolean(scope && (el === scope || scope.contains(el)));
}

/** Premier ancêtre scrollable : la zone de transcript réellement rendue. */
function nearestScrollableAncestor(el, maxDepth = 12) {
  let node = el?.parentElement || null;
  let depth = 0;
  while (node && depth < maxDepth) {
    const style = globalThis.getComputedStyle?.(node);
    if (style?.overflowY === "auto" || style?.overflowY === "scroll") {
      return node;
    }
    node = node.parentElement;
    depth += 1;
  }
  return null;
}

/**
 * Surface de conversation : la plus petite zone réellement reliée au composer.
 * Stratégie bornée, du plus précis au plus large — jamais un scan aveugle de
 * la page. Le chrome applicatif (header/nav/aside/menus/popovers/modales) ne
 * peut jamais devenir une surface.
 */
function resolveConversationSurface(root = document) {
  const usable = (element, strategy) => {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return null;
    if (isApplicationChrome(element)) return null;
    if (!isVisibleElement(element)) return null;
    return { element, strategy };
  };
  const composer = inspectComposer(root).element;
  if (composer) {
    const main = usable(composer.closest("main"), "composer_main");
    if (main) return main;
    const scroller = usable(
      nearestScrollableAncestor(composer),
      "composer_scroll_container",
    );
    if (scroller) return scroller;
    const form = composer.closest("form");
    const parent = usable(
      form?.parentElement || composer.parentElement,
      "composer_parent",
    );
    if (parent) return parent;
  }
  const main = usable(root.querySelector?.("main"), "document_main");
  if (main) return main;
  return {
    element: root.body || root.documentElement || null,
    strategy: "document_body",
  };
}

/** Clé locale d'un nœud (WeakMap) : jamais persistée, jamais exportée. */
const responseRootKeys = new WeakMap();
let responseRootKeySeq = 0;

function responseRootKey(el) {
  let key = responseRootKeys.get(el);
  if (!key) {
    responseRootKeySeq += 1;
    key = `root-${responseRootKeySeq}`;
    responseRootKeys.set(el, key);
  }
  return key;
}

/** Tokens de classe bornés : structure seulement, jamais du contenu. */
function boundedClassTokens(el) {
  return [...(el?.classList || [])]
    .slice(0, RESPONSE_SIGNATURE_MAX_TOKENS)
    .map((token) => token.slice(0, RESPONSE_SIGNATURE_MAX_TOKEN_LENGTH))
    .join(".");
}

/**
 * Signature structurelle d'un MarkdownRoot : identité locale valable pendant
 * le run, sans aucun texte. React peut recréer le nœud : la signature permet
 * de rattacher le nouveau nœud au même candidat logique.
 */
function markdownRootSignature(el) {
  const parent = el?.parentElement || null;
  return [
    el?.tagName || "?",
    boundedClassTokens(el),
    `${parent?.tagName || "?"}.${boundedClassTokens(parent)}`,
  ].join("|");
}

/** Contenu sérialisable : du texte non blanc, ou un média réellement rendu. */
function hasSerializableContent(el) {
  if (!el) return false;
  const doc = el.ownerDocument || document;
  const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    if (/\S/.test(node.nodeValue || "")) return true;
  }
  return Boolean(el.querySelector("img[src], video, canvas"));
}

/**
 * Un MarkdownRoot est-il un ResponseRoot plausible ?
 * Candidat moderne = descendant de la surface, hors composer, hors chrome, hors
 * réflexion, hors message utilisateur, visible, et non ambigu par lui-même.
 */
function isResponseRootCandidate(el, surfaceElement, root = document) {
  if (!isMarkdownRootElement(el) || !el.isConnected) return false;
  if (surfaceElement && !surfaceElement.contains(el)) return false;
  // Un tour assistant historique contient déjà ce contenu : la stratégie
  // sémantique le couvre, il ne doit pas être compté deux fois.
  if (el.closest(SELECTORS.assistant)) return false;
  // Le prompt de l'utilisateur est rendu en markdown lui aussi.
  if (el.closest(SELECTORS.user)) return false;
  // « Thinking » n'est pas la réponse.
  for (const selector of SELECTORS.reasoning) {
    if (el.closest(selector)) return false;
  }
  if (isApplicationChrome(el) || isInsideComposer(el, root)) return false;
  return isVisibleElement(el);
}

/**
 * Tous les ResponseRoots visibles, par stratégie. Observation pure : aucun
 * choix, aucune écriture, aucun texte lu ni journalisé.
 */
function resolveResponseRoots(root = document) {
  const surface = resolveConversationSurface(root);
  const surfaceElement = surface.element;
  const semantic = [];
  const markdown = [];
  let inlineLeafCount = 0;
  if (surfaceElement) {
    for (const element of surfaceElement.querySelectorAll(
      SELECTORS.markdownRootCandidate,
    )) {
      if (isResponseRootCandidate(element, surfaceElement, root)) {
        markdown.push(element);
      }
    }
    let leaves = 0;
    for (const leaf of surfaceElement.querySelectorAll(
      SELECTORS.inlineMarkdown.join(", "),
    )) {
      if (isVisibleElement(leaf) && !isInsideComposer(leaf, root)) leaves += 1;
    }
    inlineLeafCount = Math.min(leaves, MAX_INLINE_LEAF_COUNT);
  }
  for (const element of root.querySelectorAll(SELECTORS.assistant)) {
    if (isVisibleElement(element) && !isApplicationChrome(element)) {
      semantic.push(element);
    }
  }
  return {
    surface_element: surfaceElement,
    surface_strategy: surface.strategy,
    semantic,
    markdown,
    inline_leaf_count: inlineLeafCount,
  };
}

/**
 * Baseline structurelle capturée juste AVANT le Send. Elle ne contient que des
 * comptages, des clés locales (WeakMap) et des signatures de classes — jamais
 * un caractère de contenu utilisateur, jamais un identifiant externe.
 */
function captureResponseBaseline(root = document) {
  const collected = resolveResponseRoots(root);
  return {
    surface_strategy: collected.surface_strategy,
    semanticRootKeys: collected.semantic.map(responseRootKey),
    semanticRootCount: collected.semantic.length,
    markdownRootKeys: collected.markdown.map(responseRootKey),
    markdownRootCount: collected.markdown.length,
    rootSignatures: collected.markdown.map(markdownRootSignature),
  };
}

function emptyResponseBaseline() {
  return {
    surface_strategy: null,
    semanticRootKeys: [],
    semanticRootCount: 0,
    markdownRootKeys: [],
    markdownRootCount: 0,
    rootSignatures: [],
  };
}

/** Candidat décrit par les mêmes champs, quelle que soit la stratégie. */
function describeResponseCandidate(status, strategy, element, collected, baseline) {
  const roots = collected || { markdown: [], inline_leaf_count: 0 };
  return {
    status,
    strategy,
    element: element || null,
    candidate_root_tag: element?.tagName || null,
    candidate_count: status === "found" ? 1 : 0,
    raw_candidate_count: 0,
    markdown_root: strategy === "markdown_root_delta",
    baseline_root_count: baseline?.markdownRootCount || 0,
    current_root_count: roots.markdown.length,
    semantic_root_count: roots.semantic?.length || 0,
    inline_leaf_count: roots.inline_leaf_count || 0,
    surface_found: Boolean(roots.surface_element),
    surface_strategy: roots.surface_strategy || null,
  };
}

/**
 * Candidat de réponse par DELTA contre le baseline.
 *
 * - `found`     : exactement un nouveau ResponseRoot porteur de contenu.
 * - `pending`   : rien de nouveau (ou un nœud monté mais encore vide).
 * - `ambiguous` : plusieurs nouveaux ResponseRoots plausibles — on ne devine
 *                 pas, l'appelant décide (fail closed).
 */
function resolveResponseCandidate(baseline, root = document) {
  const safeBaseline = baseline || emptyResponseBaseline();
  const collected = resolveResponseRoots(root);
  const markdownKeys = new Set(safeBaseline.markdownRootKeys || []);
  // Stratégie historique : un tour assistant de plus, dans l'ordre du
  // document. Le sélecteur est intrinsèquement sémantique (il ne peut désigner
  // qu'un message), donc la CROISSANCE du compteur suffit — et elle est plus
  // sûre qu'une comparaison nœud par nœud : React peut recréer au passage les
  // tours précédents, ce qui produirait sinon plusieurs « nouveaux » tours et
  // une fausse ambiguïté sur une UI parfaitement lisible.
  const semanticCandidates =
    collected.semantic.length > (safeBaseline.semanticRootCount || 0)
      ? [collected.semantic[collected.semantic.length - 1]]
      : [];

  let strategy = null;
  let raw = [];
  if (semanticCandidates.length) {
    strategy = "semantic_assistant";
    raw = semanticCandidates;
  } else {
    // Sélection par delta : une occurrence n'est retenue que si sa signature
    // dépasse le compte du baseline (les occurrences antérieures consomment
    // l'autorisation) ET si son nœud n'était pas déjà présent avant le Send.
    const allowance = new Map();
    for (const signature of safeBaseline.rootSignatures || []) {
      allowance.set(signature, (allowance.get(signature) || 0) + 1);
    }
    const surplusRoots = [];
    for (const el of collected.markdown) {
      const signature = markdownRootSignature(el);
      const left = allowance.get(signature) || 0;
      if (left > 0) {
        allowance.set(signature, left - 1);
        continue;
      }
      surplusRoots.push(el);
    }
    const freshSurplus = surplusRoots.filter(
      (el) => !markdownKeys.has(responseRootKey(el)),
    );
    if (freshSurplus.length) {
      strategy = "markdown_root_delta";
      raw = freshSurplus;
    }
  }

  const withContent = raw.filter((el) => hasSerializableContent(el));
  const status =
    withContent.length > 1
      ? "ambiguous"
      : withContent.length === 1
        ? "found"
        : "pending";
  const candidate = describeResponseCandidate(
    status,
    raw.length ? strategy : null,
    status === "found" ? withContent[0] : null,
    collected,
    safeBaseline,
  );
  candidate.candidate_count = withContent.length;
  candidate.raw_candidate_count = raw.length;
  return candidate;
}

/**
 * Content root d'un candidat : le nœud moderne est lui-même le content root
 * (ne pas remonter vers des wrappers de layout moins stables), tandis que la
 * stratégie historique garde son answer root `.markdown`.
 */
function resolveResponseContentRoot(candidate, fallbackOk = true) {
  if (!candidate?.element) return null;
  if (candidate.strategy === "semantic_assistant") {
    return answerRoot(candidate.element, fallbackOk);
  }
  return candidate.element;
}

/**
 * Locator local d'un ResponseRoot : valable pendant le run, jamais persisté,
 * jamais comparé à un identifiant externe (conversation, tour, message).
 */
function createResponseLocator(candidate, baseline, root = document) {
  if (!candidate?.element) return null;
  if (candidate.strategy === "semantic_assistant") {
    const surface = resolveConversationSurface(root).element;
    const turns = surface
      ? [...surface.querySelectorAll(SELECTORS.assistant)]
      : [];
    return {
      kind: "semantic_assistant",
      strategy: "semantic_assistant",
      turn_locator: turnLocator(candidate.element),
      baseline_count: baseline?.semanticRootCount || 0,
      ordinal: turns.indexOf(candidate.element),
    };
  }
  const collected = resolveResponseRoots(root);
  return {
    kind: "markdown_root",
    strategy: "markdown_root_delta",
    ordinal: collected.markdown.indexOf(candidate.element),
    signature: markdownRootSignature(candidate.element),
  };
}

/**
 * Re-résout le candidat depuis son locator : React recrée volontiers le nœud
 * (le locator doit rattacher le nouveau nœud au même candidat logique), mais
 * deux candidats restent indistinguables — on ne devine alors pas.
 */
function locateResponseCandidate(locator, baseline, root = document) {
  if (!locator) return null;
  if (locator.kind === "semantic_assistant") {
    const turn = findTurn(locator.turn_locator, locator.baseline_count);
    if (!turn) return null;
    return describeResponseCandidate(
      "found",
      "semantic_assistant",
      turn,
      resolveResponseRoots(root),
      baseline,
    );
  }
  const collected = resolveResponseRoots(root);
  const ordinalRoot = collected.markdown[locator.ordinal] || null;
  if (ordinalRoot && markdownRootSignature(ordinalRoot) === locator.signature) {
    return describeResponseCandidate(
      "found",
      "markdown_root_delta",
      ordinalRoot,
      collected,
      baseline,
    );
  }
  const baselineKeys = new Set(baseline?.markdownRootKeys || []);
  const fresh = collected.markdown.filter(
    (el) => !baselineKeys.has(responseRootKey(el)),
  );
  if (fresh.length === 1) {
    return describeResponseCandidate(
      "found",
      "markdown_root_delta",
      fresh[0],
      collected,
      baseline,
    );
  }
  return null;
}

// Dernière décision du locator : observabilité sans contenu, exposée au popup.
let lastResponseLocatorDiagnostic = null;
let recordedResponseLocatorSignature = null;

/** Charge utile de log § « bridge_response_locator » : aucun contenu. */
function responseLocatorDiagnostic(candidate) {
  return {
    strategy: candidate?.strategy ?? null,
    baseline_root_count: candidate?.baseline_root_count ?? 0,
    current_root_count: candidate?.current_root_count ?? 0,
    candidate_found: candidate?.status === "found",
    candidate_root_tag: candidate?.candidate_root_tag ?? null,
    markdown_root: candidate?.markdown_root === true,
    inline_leaf_count: candidate?.inline_leaf_count ?? 0,
    ambiguity_count:
      candidate?.status === "ambiguous" ? candidate.candidate_count : 0,
    version: VERSION,
  };
}

/** Mémorise et journalise la dernière décision, à chaque changement seulement. */
function recordResponseLocator(candidate) {
  const diagnostic = responseLocatorDiagnostic(candidate);
  const signature = [
    diagnostic.strategy,
    diagnostic.candidate_found,
    diagnostic.current_root_count,
    diagnostic.inline_leaf_count,
    diagnostic.ambiguity_count,
  ].join("|");
  if (signature === recordedResponseLocatorSignature) return diagnostic;
  recordedResponseLocatorSignature = signature;
  lastResponseLocatorDiagnostic = diagnostic;
  console.log("bridge_response_locator", diagnostic);
  return diagnostic;
}

// --------------------------------------------------------------------------- //
// Snapshot structurel borné (« Copy response structure »)
//
// Sortie autorisée : tag, tokens de classe bornés, role, data-testid,
// data-* en liste blanche, profondeur, nombre d'enfants, dimensions,
// visibilité, stratégie de root. Interdit : innerText, textContent, innerHTML,
// corps de réponse, prompt.
// --------------------------------------------------------------------------- //

const STRUCTURE_SAFE_ATTRIBUTES = {
  "data-testid": "testid",
  "data-message-author-role": "author_role",
  "data-turn": "turn",
  "data-state": "state",
  "data-is-streaming": "is_streaming",
  "data-composer-markdown": "composer_markdown",
  "aria-hidden": "aria_hidden",
};

function boundedStructureValue(value) {
  return typeof value === "string" &&
    value.length <= STRUCTURE_LIMITS.max_value_length &&
    /^[A-Za-z0-9 _.:#-]*$/.test(value)
    ? value
    : null;
}

function boundedStructureData(el) {
  const data = {};
  for (const [attribute, key] of Object.entries(STRUCTURE_SAFE_ATTRIBUTES)) {
    const raw = el.getAttribute(attribute);
    if (raw === null) continue;
    if (raw === "") {
      data[key] = true;
      continue;
    }
    const bounded = boundedStructureValue(raw);
    if (bounded !== null) data[key] = bounded;
  }
  return data;
}

function boundedStructureNode(el, depth, budget) {
  budget.nodes += 1;
  let rect = null;
  try {
    rect = typeof el.getBoundingClientRect === "function"
      ? el.getBoundingClientRect()
      : null;
  } catch (_) {
    // Une dimension indisponible ne doit jamais faire échouer un diagnostic.
  }
  const children = [];
  if (
    depth < STRUCTURE_LIMITS.max_depth &&
    budget.nodes < STRUCTURE_LIMITS.max_nodes
  ) {
    for (const child of el.children) {
      if (children.length >= STRUCTURE_LIMITS.max_children) break;
      if (budget.nodes >= STRUCTURE_LIMITS.max_nodes) break;
      children.push(boundedStructureNode(child, depth + 1, budget));
    }
  }
  return {
    tag: el.tagName,
    class_tokens: [...(el.classList || [])]
      .slice(0, STRUCTURE_LIMITS.max_class_tokens)
      .map((token) => token.slice(0, STRUCTURE_LIMITS.max_token_length)),
    role: boundedStructureValue(el.getAttribute("role")),
    data_testid: boundedStructureValue(el.getAttribute("data-testid")),
    data: boundedStructureData(el),
    has_message_id: Boolean(el.getAttribute("data-message-id")),
    depth,
    children_count: el.children.length,
    children,
    width: rect && Number.isFinite(rect.width) ? Math.round(rect.width) : null,
    height: rect && Number.isFinite(rect.height) ? Math.round(rect.height) : null,
    visible: isVisibleElement(el),
  };
}

/**
 * Snapshot structurel de la surface de conversation et des ResponseRoots.
 * Aucune propriété textuelle n'est jamais lue : ni innerText, ni textContent,
 * ni innerHTML, ni valeur d'attribut hors liste blanche.
 */
function responseStructureSnapshot(root = document) {
  const collected = resolveResponseRoots(root);
  const surfaceElement = collected.surface_element;
  const roots = [
    ...collected.markdown
      .slice(0, STRUCTURE_LIMITS.max_roots)
      .map((element) => ({
        strategy: "markdown_root_delta",
        node: boundedStructureNode(element, 0, { nodes: 0 }),
      })),
    ...collected.semantic
      .slice(0, STRUCTURE_LIMITS.max_roots)
      .map((element) => ({
        strategy: "semantic_assistant",
        node: boundedStructureNode(element, 0, { nodes: 0 }),
      })),
  ];
  return {
    ok: true,
    content_script_version: VERSION,
    conversation_surface: {
      found: Boolean(surfaceElement),
      strategy: collected.surface_strategy || null,
      node: surfaceElement
        ? boundedStructureNode(surfaceElement, 0, { nodes: 0 })
        : null,
    },
    strategy: collected.markdown.length
      ? "markdown_root_delta"
      : collected.semantic.length
        ? "semantic_assistant"
        : null,
    markdown_root_matches: collected.markdown.length,
    semantic_assistant_matches: collected.semantic.length,
    inline_leaf_matches: collected.inline_leaf_count,
    roots,
  };
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
  const composer = resolveComposer().element;
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
async function streamAnswer(job, locator, responseBaseline, run) {
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
  let finalTurnLocator =
    locator.kind === "semantic_assistant" ? locator.turn_locator : null;
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

      // Re-résolution du candidat à chaque itération, jamais de référence
      // gardée : React remplace le nœud entre la réflexion et la réponse, et
      // un nœud détaché resterait figé sur « Thinking ».
      const candidate = locateResponseCandidate(locator, responseBaseline);
      if (!candidate) continue;
      const turn = candidate.element;

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
      const root = resolveResponseContentRoot(
        candidate,
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
        // même candidat logique, puis revérifier finalité, identité et texte
        // sur ce nœud.
        const verificationLocator =
          locator.kind === "semantic_assistant"
            ? { ...locator, turn_locator: turnLocator(turn) || locator.turn_locator }
            : locator;
        const verificationCandidate = locateResponseCandidate(
          verificationLocator,
          responseBaseline,
        );
        const verificationCompletion = verificationCandidate
          ? completionState(verificationCandidate.element)
          : null;
        const verificationRoot = verificationCandidate
          ? resolveResponseContentRoot(verificationCandidate, true)
          : null;
        const verification = verificationRoot
          ? readAnswer(verificationRoot, false)
          : null;
        const currentExternalTurnId = turnExternalId(turn);
        const verificationExternalTurnId = verificationCandidate
          ? turnExternalId(verificationCandidate.element)
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
          finalTurnLocator = verificationCandidate
            ? turnLocator(verificationCandidate.element) ||
              verificationLocator.turn_locator ||
              null
            : null;
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
function resolveExternalTurnId(serialized, locator, responseBaseline) {
  if (serialized.external_turn_id) return serialized.external_turn_id;
  const refined =
    locator?.kind === "semantic_assistant" && serialized.turn_locator
      ? { ...locator, turn_locator: serialized.turn_locator }
      : locator;
  const candidate = locateResponseCandidate(refined, responseBaseline);
  return candidate ? turnExternalId(candidate.element) : null;
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

function temporaryVerificationFailure(
  reason,
  url,
  composerFound,
  toggleFound,
  composerResolution = null,
) {
  console.warn("temporary_chat_verification_failed", {
    reason,
    origin: url?.origin ?? null,
    pathname: url?.pathname ?? null,
    temporary_param: url?.searchParams.get("temporary-chat") ?? null,
    composer_found: composerFound,
    composer_strategy: composerResolution?.strategy ?? null,
    composer_selector: composerResolution?.selector ?? null,
    composer_candidate_count: composerResolution?.candidate_count ?? 0,
    toggle_found: toggleFound,
    content_script_version: VERSION,
  });
}

async function ensureTemporaryChat() {
  const deadline = Date.now() + TEMPORARY_SURFACE_TIMEOUT_MS;
  let lastReason = "temporary_surface_origin_invalid";
  let lastResolution = uiResolution(
    "structural_fallback",
    STRUCTURAL_COMPOSER_SELECTOR,
    0,
  );
  while (Date.now() < deadline) {
    let url;
    try {
      url = new URL(window.location.href);
    } catch {
      temporaryVerificationFailure(lastReason, null, false, false);
      throw new BridgeError("conversation_unavailable", "surface Temporary Chat invalide");
    }

    const toggleFound = Boolean($(SELECTORS.temporaryChatToggle));
    if (!TEMPORARY_CHAT_ORIGINS.has(url.origin)) {
      lastReason = "temporary_surface_origin_invalid";
    } else if (url.pathname !== "/") {
      lastReason = "temporary_surface_path_invalid";
    } else if (!url.searchParams.has("temporary-chat")) {
      lastReason = "temporary_query_missing";
    } else if (url.searchParams.get("temporary-chat") !== "true") {
      lastReason = "temporary_query_not_true";
    } else {
      lastResolution = resolveComposer();
      if (!lastResolution.element) {
        lastReason = "temporary_composer_missing";
      } else {
        console.log("bridge_run_phase", { phase: "temporary_verification", state: "verified", content_script_version: VERSION });
        return lastResolution.element;
      }
    }

    // Origin/path/query violations are deterministic and must not become a
    // generic 15s timeout. Only a missing composer can be an SPA load race.
    if (lastReason !== "temporary_composer_missing") {
      temporaryVerificationFailure(lastReason, url, Boolean(lastResolution.element), toggleFound, lastResolution);
      throw new BridgeError(
        lastReason === "temporary_surface_path_invalid" ? "conversation_unavailable" : "bridge_ui_timeout",
        `vérification Temporary Chat refusée (${lastReason})`,
      );
    }
    await sleep(100);
  }

  let url = null;
  try { url = new URL(window.location.href); } catch { /* diagnostic below */ }
  try {
    lastResolution = resolveComposer();
  } catch (error) {
    temporaryVerificationFailure(
      "composer_contract_ambiguous",
      url,
      false,
      Boolean($(SELECTORS.temporaryChatToggle)),
    );
    throw error;
  }
  temporaryVerificationFailure(
    lastReason,
    url,
    Boolean(lastResolution.element),
    Boolean($(SELECTORS.temporaryChatToggle)),
    lastResolution,
  );
  throw uiContractError(
    "composer_missing",
    lastResolution,
    "composer Temporary Chat introuvable",
  );
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
  let promptInjected = false;
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

    let composerResolution = await waitForComposer(
      15000,
      "composer introuvable",
    );
    let composer = composerResolution.element;
    console.log("bridge_run_phase", { phase: "composer" });
    const assistantTurnsBefore = document.querySelectorAll(SELECTORS.assistant).length;
    const before = assistantTurnsBefore;
    if (!baselineTurn && before) {
      baselineTurn = document.querySelectorAll(SELECTORS.assistant)[before - 1];
    }

    // Un prompt trop gros n'entre JAMAIS dans le composer : il part en pièce
    // jointe texte et le composer ne reçoit que la consigne de lecture. Les
    // deux branches sont exclusives — `composerPrompt` est réassigné, jamais
    // concaténé au prompt.
    const promptBytes = prompt ? utf8ByteLength(prompt) : 0;
    const promptAsFile =
      Boolean(prompt) && promptBytes > LARGE_PROMPT_FILE_THRESHOLD_BYTES;

    let composerPrompt = prompt || "";
    const extraFiles = [];
    if (promptAsFile) {
      const promptFile = createLargePromptFile(id, prompt);
      extraFiles.push(promptFile);
      composerPrompt = largePromptInstruction(promptFile.name);
    }

    const hasAttachments = Boolean(files?.length) || extraFiles.length > 0;
    if (hasAttachments) {
      await attachFiles(files || [], extraFiles);
      // L'ajout d'une pièce jointe provoque un rerender du composer :
      // ProseMirror/React peut avoir remplacé le nœud. On ne colle jamais dans
      // une référence potentiellement détachée du document.
      composerResolution = await waitForComposer(
        5000,
        "composer introuvable après ajout des pièces jointes",
      );
      composer = composerResolution.element;
    }

    let injectionMethod = null;
    if (composerPrompt) {
      injectionMethod = await typePrompt(composer, composerPrompt);
      promptInjected = true;
    }
    // Paste and attachment handling can cause a React render. Use the current
    // composer for readiness, the baseline snapshot, and the one allowed Send.
    composerResolution = resolveComposer();
    if (!composerResolution.element) {
      throw uiContractError(
        "composer_missing",
        composerResolution,
        "composer introuvable après injection",
      );
    }
    composer = composerResolution.element;
    // Volumétrie uniquement : ni le prompt, ni le contenu du fichier, ni le
    // DOM du composer ne doivent apparaître dans un log.
    console.log("bridge_run_phase", {
      phase: "prompt_injected",
      prompt_bytes: promptBytes,
      prompt_as_file: promptAsFile,
      injection_method: injectionMethod,
      paste_consumed: injectionMethod === "synthetic_paste",
      attachment_count: (files?.length || 0) + extraFiles.length,
    });

    // Un collage consommé par ChatGPT peut être converti en pièce jointe : la
    // préparation/upload qui suit prend le même temps qu'un fichier explicite,
    // même quand aucune pièce jointe n'a été déposée par le bridge.
    const mayUploadAfterPaste = injectionMethod === "synthetic_paste";
    const waitsForUpload = hasAttachments || mayUploadAfterPaste;

    // Le bouton d'envoi ne devient actif qu'après le rendu de la saisie — et,
    // si un upload est possible, qu'une fois celui-ci terminé (bien plus long).
    // Ce délai long n'ajoute aucune latence : `waitFor` rend la main dès que
    // Send devient utilisable.
    let sendResolution = null;
    let resolvedSend;
    try {
      resolvedSend = await waitFor(
        () => {
          composerResolution = resolveComposer();
          if (!composerResolution.element) return null;
          composer = composerResolution.element;
          sendResolution = resolveSendButton(composer);
          return isSendButtonReady(sendResolution.element) ? sendResolution : null;
        },
        waitsForUpload ? UPLOAD_TIMEOUT_MS : 8000,
        waitsForUpload
          ? "contenu collé ou pièce jointe non prêt pour l'envoi"
          : "bouton d'envoi jamais actif",
      );
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      if (!composerResolution.element) {
        throw uiContractError(
          "composer_missing",
          composerResolution,
          "composer introuvable pendant la préparation de l'envoi",
        );
      }
      if (!sendResolution?.element) {
        throw uiContractError(
          "send_missing",
          sendResolution || resolveSendButton(composer),
          "bouton d'envoi introuvable",
        );
      }
      throw uiContractError(
        "send_not_ready",
        sendResolution,
        "bouton d'envoi jamais actif",
      );
    }
    sendResolution = resolvedSend;
    const sendBtn = sendResolution.element;
    warnIfDegraded("composer", composerResolution);
    warnIfDegraded("send", sendResolution);
    console.log("bridge_dom_contract", {
      composer_strategy: composerResolution.strategy,
      composer_selector: composerResolution.selector,
      composer_candidate_count: composerResolution.candidate_count,
      send_strategy: sendResolution.strategy,
      send_selector: sendResolution.selector,
      send_candidate_count: sendResolution.candidate_count,
      content_script_version: VERSION,
    });
    // Capture after typing/upload and immediately before the one allowed
    // trigger: the composer text and send state must describe the actual click.
    // La baseline de réponse décrit la structure déjà rendue (comptages,
    // signatures) : aucun texte, et c'est le SEUL état de référence du delta.
    const responseBaseline = captureResponseBaseline();
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

    // Attendre le premier ResponseRoot *nouveau* (jamais le précédent), sans
    // imposer une courte borne murale à une recherche web ou réflexion longue.
    // Le candidat vient du delta structurel contre le baseline d'avant-Send.
    const candidate = await waitForResponseCandidate(
      job,
      composer,
      sendBtn,
      submissionBaseline,
      responseBaseline,
      runDiagnostics,
    );
    if (!candidate) return;
    const responseLocator = createResponseLocator(candidate, responseBaseline);
    const serialized = await streamAnswer(
      job,
      responseLocator,
      responseBaseline,
      runDiagnostics,
    );

    if (!job.aborted) {
      // Le nœud candidat peut être détaché : l'identité vient du tour courant
      // qui a produit ce texte, jamais de la référence gardée avant streaming.
      const externalTurnId = resolveExternalTurnId(
        serialized,
        responseLocator,
        responseBaseline,
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
    if (promptInjected) addPostInjectionUiDiagnostics(err);
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
  if (msg?.type === "dom_health") {
    sendResponse(domHealthSnapshot());
    return true;
  }
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
  if (msg?.type === "response_structure") {
    // Snapshot structurel borné : ni innerText, ni textContent, ni innerHTML.
    sendResponse(responseStructureSnapshot());
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
