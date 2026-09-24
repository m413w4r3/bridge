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

  /**
   * Décision de fin sur le dernier snapshot observé, à partir de l'état de la
   * machine (`finalizationState`) et de la fenêtre de stabilité réelle.
   *
   *   FINAL issu d'une preuve terminale  -> SETTLE court
   *   FINAL issu d'une stabilité quiescente -> SETTLE_UNKNOWN + observations
   *   QUIESCENT / ACTIVE / WAITING        -> rien ne conclut ici
   *
   * `active` n'est jamais converti par la durée : un texte stable pendant une
   * minute pendant que ChatGPT travaille encore n'est pas une réponse finie.
   * Une fin terminale sans aucune sortie n'est pas un succès : c'est
   * `no_final_answer`, rendu seulement après la fenêtre dédiée (le DOM peut
   * monter la barre d'actions avant le texte).
   */
  function finalizationOutcome({
    state,
    mode,
    signal,
    confidence,
    text,
    stableForMs,
    stableObservations,
    thresholds,
  }) {
    const limits = thresholds || {};
    const hasOutput = typeof text === "string" && text.length > 0;
    const stable = Number.isFinite(stableForMs) ? stableForMs : 0;
    const observations = Number.isFinite(stableObservations)
      ? stableObservations
      : 0;
    if (state === "final") {
      const terminalMode = mode || "terminal_action";
      if (!hasOutput) {
        return stable >= (limits.empty_final_settle_ms ?? Infinity)
          ? {
              outcome: "no_final_answer",
              mode: terminalMode,
              signal,
              confidence,
            }
          : { outcome: "pending", mode: terminalMode, signal, confidence };
      }
      return stable >= (limits.settle_ms ?? Infinity)
        ? { outcome: "final", mode: terminalMode, signal, confidence }
        : { outcome: "pending", mode: terminalMode, signal, confidence };
    }
    if (state === "quiescent") {
      if (
        stable >= (limits.settle_unknown_ms ?? Infinity) &&
        observations >= (limits.min_quiescent_observations ?? 1)
      ) {
        return {
          outcome: "final",
          mode: "quiescent_stability",
          signal: "quiescent_stability",
          confidence: "medium",
        };
      }
      return {
        outcome: "pending",
        mode: null,
        signal: signal || "output_stable",
        confidence: confidence || "medium",
      };
    }
    // `active` (et `waiting`) : la durée seule ne conclut jamais.
    return {
      outcome: "pending",
      mode: null,
      signal: signal || "unknown",
      confidence: confidence || "low",
    };
  }

  /**
   * Borne de durée réellement applicable à l'état courant : c'est *ce* seuil
   * que le diagnostic affiche à côté de la stabilité mesurée, pour que
   * l'opérateur compare la durée observée à la règle que le runtime applique —
   * jamais à un seuil inventé par le popup.
   *
   * Le seuil publié est la borne de SORTIE de l'état, celle après laquelle le
   * runtime rend la main au lieu d'attendre encore :
   *
   *   ACTIVE     -> `active_signal_stall_ms`  (`active_signal_stalled`)
   *   QUIESCENT  -> `finalization_stall_ms`   (`finalization_stalled`)
   *   FINAL      -> `settle_ms` / `empty_final_settle_ms` (fenêtre de conclusion)
   *
   * QUIESCENT conclut par une durée *et* des observations réelles : aucune
   * durée seule ne le résume. `waiting`/`idle` n'ont aucune borne et rendent
   * `null` — jamais un seuil qui ne serait appliqué par personne.
   */
  function finalizationThresholdMs({ state, outputChars, thresholds }) {
    const limits = thresholds || {};
    const value = (key) => (Number.isFinite(limits[key]) ? limits[key] : null);
    if (state === "final") {
      return outputChars > 0 ? value("settle_ms") : value("empty_final_settle_ms");
    }
    if (state === "quiescent") return value("finalization_stall_ms");
    if (state === "active") return value("active_signal_stall_ms");
    return null;
  }

  root.ChatGPTBridgeFinalOutput = {
    createAccumulator,
    outputChars,
    finalizationOutcome,
    finalizationThresholdMs,
  };
})(globalThis);
