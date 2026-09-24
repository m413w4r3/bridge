/**
 * Safe structural recorder for deeper ChatGPT UI changes.
 *
 * Paste this file into the DevTools console on chatgpt.com. It logs only
 * selectors, element counts, and boolean state; it never reads page text.
 */
(() => {
  const DUREE_MS = 90000;
  const PAS_MS = 400;
  const t0 = Date.now();
  const journal = [];
  const SELECTEURS_COMPOSER = [
    "[data-composer-markdown][contenteditable='true'][role='textbox']",
    "#prompt-textarea",
    "[data-testid='prompt-textarea']",
    "div[contenteditable='true'][id^='prompt']",
    "textarea[data-id]",
  ];
  const SELECTEUR_COMPOSER_STRUCTUREL = "[contenteditable='true'][role='textbox']";
  const SELECTEURS_SEND = [
    "button[data-testid='send-button']",
    "#composer-submit-button",
    "button[aria-label*='Envoyer']",
    "button[aria-label*='Send']",
  ];
  const SELECTEURS_STREAMING = [
    ".streaming-animation",
    ".result-streaming",
    "[data-is-streaming='true']",
  ];

  function visibles(selector) {
    return [...document.querySelectorAll(selector)].filter((el) => {
      if (!el.isConnected) return false;
      const style = globalThis.getComputedStyle?.(el);
      if (style?.display === "none" || style?.visibility === "hidden") return false;
      return typeof el.getClientRects !== "function" || el.getClientRects().length > 0;
    });
  }

  function inspecterComposer() {
    for (const selector of SELECTEURS_COMPOSER) {
      const found = visibles(selector);
      if (found.length > 1) return { element: null, status: "ambiguous", strategy: "named_selector", selector, count: found.length };
      if (found.length === 1) return { element: found[0], status: "ok", strategy: "named_selector", selector, count: 1 };
    }
    const found = visibles(SELECTEUR_COMPOSER_STRUCTUREL);
    if (found.length > 1) return { element: null, status: "ambiguous", strategy: "structural_fallback", selector: SELECTEUR_COMPOSER_STRUCTUREL, count: found.length };
    const element = found[0] || null;
    const structurallySafe = element &&
      (element.closest("form") || element.hasAttribute("data-composer-markdown")) &&
      (element.hasAttribute("data-composer-markdown") ||
        element.getAttribute("aria-multiline") === "true" ||
        element.classList?.contains("ProseMirror") ||
        Boolean(element.querySelector("p[data-placeholder]")));
    return {
      element: structurallySafe ? element : null,
      status: structurallySafe ? "degraded" : "missing",
      strategy: "structural_fallback",
      selector: SELECTEUR_COMPOSER_STRUCTUREL,
      count: structurallySafe ? 1 : 0,
    };
  }

  function inspecterSend(composer) {
    const form = composer?.closest("form");
    const root = form || document;
    for (const selector of SELECTEURS_SEND) {
      const found = visibles(selector).filter((el) => el.tagName === "BUTTON" && root.contains(el));
      if (found.length > 1) return { status: "ambiguous", strategy: "named_selector", selector, count: found.length };
      if (found.length === 1) return { status: "ok", strategy: "named_selector", selector, count: 1 };
    }
    const found = form
      ? visibles("button[type='submit']").filter((el) => form.contains(el))
      : [];
    if (found.length > 1) return { status: "ambiguous", strategy: "structural_fallback", selector: "button[type='submit']", count: found.length };
    if (found.length === 1) return { status: "degraded", strategy: "structural_fallback", selector: "button[type='submit']", count: 1 };
    return { status: "missing", strategy: "structural_fallback", selector: "button[type='submit']", count: 0 };
  }

  function etat() {
    const assistants = document.querySelectorAll("[data-message-author-role='assistant']");
    const dernier = assistants[assistants.length - 1] || null;
    const tour = dernier?.closest("[data-testid^='conversation-turn']") || dernier?.closest("article") || dernier;
    const composer = inspecterComposer();
    const send = inspecterSend(composer.element);
    const streaming = SELECTEURS_STREAMING.map((selector) => ({
      selector,
      count: visibles(selector).length,
    }));
    const buttons = composer.element
      ? [...(composer.element.closest("form") || document).querySelectorAll("button")].map((button) => ({
          type: ["button", "submit", "reset"].includes(button.type) ? button.type : "other",
          disabled: Boolean(button.disabled),
          aria_disabled: button.getAttribute("aria-disabled") === "true",
        }))
      : [];
    const detail = {
      assistant_turn_count: assistants.length,
      markdown_block_count: dernier?.querySelectorAll(".markdown").length || 0,
      copy_action_present: Boolean(tour?.querySelector("[data-testid='copy-turn-action-button']")),
      turn_container_tag: tour?.tagName || null,
      composer: { status: composer.status, strategy: composer.strategy, selector: composer.selector, visible_candidates: composer.count },
      send: { status: send.status, strategy: send.strategy, selector: send.selector, visible_candidates: send.count },
      streaming,
      buttons,
    };
    return { sig: JSON.stringify(detail), detail };
  }

  const composerContract = inspecterComposer();
  const sendContract = inspecterSend(composerContract.element);
  console.log("DOM CONTRACT");
  console.log("composer status:", composerContract.status);
  console.log("send status:", sendContract.status);
  console.log("matched strategy:", composerContract.strategy, "/", sendContract.strategy);

  let precedent = null;
  const timer = setInterval(() => {
    const { sig, detail } = etat();
    if (sig !== precedent) {
      precedent = sig;
      const s = ((Date.now() - t0) / 1000).toFixed(1).padStart(5);
      journal.push({ t: s, ...detail });
      console.log(`[${s}s] ${JSON.stringify(detail, null, 1)}`);
    }
    if (Date.now() - t0 > DUREE_MS) fin();
  }, PAS_MS);

  function fin() {
    clearInterval(timer);
    console.log("\n=== ENREGISTREMENT TERMINÉ — copie tout ce qui suit ===");
    console.log(JSON.stringify(journal, null, 1));
  }
  window.__diagStop = fin;

  console.log("🔴 Enregistrement en cours. Envoie un prompt maintenant.");
  console.log("   (__diagStop() pour arrêter avant la fin des 90 s)");
})();
