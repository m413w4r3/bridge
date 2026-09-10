/**
 * Accumulateur final-only : chaque observation remplace la précédente.
 * Le DOM ChatGPT peut réécrire du Markdown déjà rendu ; il ne faut donc jamais
 * interpréter deux snapshots successifs comme des morceaux append-only.
 */
(function exposeFinalOutput(root) {
  function outputChars(text) {
    return typeof text === "string" ? Array.from(text).length : 0;
  }

  function createAccumulator() {
    let latest = "";
    return {
      observe(snapshot) {
        latest = typeof snapshot === "string" ? snapshot : "";
        return latest;
      },
      final() {
        return latest;
      },
    };
  }

  function settledOutcome({ completion, text, stableForMs, emptySettleMs }) {
    if (completion?.finished === false) return "active";
    if (completion?.finished === true && text.length === 0) {
      return stableForMs >= emptySettleMs ? "incomplete" : "waiting";
    }
    if (completion?.finished !== false && text.length > 0) return "complete";
    return "unknown";
  }

  root.ChatGPTBridgeFinalOutput = {
    createAccumulator,
    outputChars,
    settledOutcome,
  };
})(globalThis);
