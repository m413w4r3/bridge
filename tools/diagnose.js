/**
 * Enregistreur de l'UI ChatGPT — capture le cycle complet d'une réponse.
 *
 * MODE D'EMPLOI
 *   1. Ouvre la console (F12) sur chatgpt.com et colle tout ce fichier.
 *   2. Envoie un prompt à la main, de préférence un qui déclenche une phase de
 *      réflexion (« Thinking »), par exemple : « réfléchis bien : 17 * 23 ? ».
 *   3. Laisse la réponse se terminer, puis attends la ligne « ENREGISTREMENT
 *      TERMINÉ » (90 s max, ou tape __diagStop() pour couper avant).
 *   4. Copie tout le bloc final et transmets-le.
 *
 * Il ne journalise que les CHANGEMENTS d'état : la sortie reste courte.
 */
(() => {
  const DUREE_MS = 90000;
  const PAS_MS = 400;
  const t0 = Date.now();
  const journal = [];

  const attrs = (el) =>
    `${el.tagName.toLowerCase()}[testid=${el.getAttribute("data-testid") || "-"}][label=${
      el.getAttribute("aria-label") || "-"
    }]${el.disabled ? "[disabled]" : ""}`;

  /** Boutons du composer : c'est parmi eux que vivent « envoyer » et « stop ». */
  function boutonsComposer() {
    const champ = document.querySelector("#prompt-textarea");
    if (!champ) return "composer absent";
    const zone = champ.closest("form") || champ.parentElement?.parentElement?.parentElement;
    if (!zone) return "zone composer introuvable";
    return [...zone.querySelectorAll("button")].map(attrs).join("  ") || "aucun bouton";
  }

  /** Indices de réflexion / streaming, quel que soit le nommage employé. */
  function indices() {
    const out = [];
    for (const el of document.querySelectorAll("[data-testid]")) {
      const id = el.getAttribute("data-testid");
      if (/think|reason|thought|stream/i.test(id)) out.push(`testid=${id}`);
    }
    for (const el of document.querySelectorAll("[class*='stream'], [class*='thinking']")) {
      const cls = [...el.classList].filter((c) => /stream|thinking/i.test(c)).join(".");
      if (cls) out.push(`class=${cls}`);
    }
    return [...new Set(out)].join("  ") || "aucun";
  }

  function etat() {
    const tours = document.querySelectorAll("[data-message-author-role='assistant']");
    const tour = tours[tours.length - 1];
    if (!tour) return { sig: "aucune réponse", detail: null };

    const conteneur =
      tour.closest("[data-testid^='conversation-turn']") || tour.closest("article") || tour.parentElement;
    const blocs = [...tour.querySelectorAll(".markdown")];
    const copie = conteneur ? conteneur.querySelector("[data-testid='copy-turn-action-button']") : null;

    const detail = {
      blocs: blocs.length,
      // Pour chaque bloc : son ancêtre porteur d'un data-testid = le conteneur
      // qui permettra de distinguer réflexion et réponse.
      ancetres: blocs
        .map((b, i) => {
          const a = b.closest("[data-testid]");
          return `#${i}<${a ? a.getAttribute("data-testid") : "-"}>${JSON.stringify(
            b.innerText.slice(0, 40),
          )}`;
        })
        .join("  "),
      copie: copie ? "OUI" : "non",
      conteneur: conteneur ? conteneur.getAttribute("data-testid") || conteneur.tagName : "-",
      boutons: boutonsComposer(),
      indices: indices(),
      len: tour.innerText.length,
    };
    // La longueur du texte est volontairement hors signature : sinon chaque
    // caractère produirait une ligne de journal.
    const sig = `${detail.blocs}|${detail.copie}|${detail.boutons}|${detail.indices}|${detail.ancetres}`;
    return { sig, detail };
  }

  let precedent = null;
  const timer = setInterval(() => {
    const { sig, detail } = etat();
    if (sig !== precedent) {
      precedent = sig;
      const s = ((Date.now() - t0) / 1000).toFixed(1).padStart(5);
      journal.push({ t: s, ...(detail || {}) });
      console.log(`[${s}s] ${detail ? JSON.stringify(detail, null, 1) : sig}`);
    }
    if (Date.now() - t0 > DUREE_MS) fin();
  }, PAS_MS);

  function fin() {
    clearInterval(timer);
    console.log("\n=== ENREGISTREMENT TERMINÉ — copie tout ce qui suit ===");
    console.log(JSON.stringify(journal, null, 1));
  }
  window.__diagStop = fin;

  console.log("🔴 Enregistrement en cours. Envoie ton prompt maintenant.");
  console.log("   (__diagStop() pour arrêter avant la fin des 90 s)");
})();
