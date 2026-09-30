/** Détection pure et testable de la finalisation d'un tour assistant. */
(function exposeCompletion(root) {
  /**
   * Machine à états explicite de la finalisation. Trois états, plus `waiting`
   * (aucune preuve encore lisible) :
   *
   *   ACTIVE    — au moins une preuve active est présente : ChatGPT écrit ou
   *               réfléchit encore. AUCUNE stabilité de texte ne conclut tant
   *               qu'un signal actif est là, même après plusieurs minutes.
   *   QUIESCENT — une réponse existe avec du texte sérialisé, aucun signal
   *               actif, aucune preuve terminale : la réponse *paraît* finie,
   *               seule sa stabilité dans le temps peut le confirmer.
   *   FINAL     — une preuve terminale explicite est visible (barre d'actions
   *               historique du tour).
   *
   * Les signaux arrivent déjà scopés par l'appelant (le ResponseRoot et son
   * périmètre, le composer courant pour le Stop) : cette fonction ne lit aucun
   * DOM, ne connaît aucun sélecteur et ne décide d'aucune durée.
   */
  function finalizationState(signals) {
    const input = signals || {};
    // La barre d'actions appartient au tour assistant surveillé : c'est le
    // signal terminal le plus spécifique, et il n'apparaît pas tant que ChatGPT
    // écrit. Il prime donc sur les signaux d'activité, moins localisés.
    // Il n'est plus *requis* : une réponse stable sans lui reste finalisable.
    if (input.terminal_action_visible) {
      return {
        state: "final",
        mode: "terminal_action",
        signal: "assistant_actions",
        confidence: "high",
      };
    }
    // Les signaux ci-dessous disent qu'une génération est encore active. Ils ne
    // sont évalués qu'en l'absence du signal terminal, du plus proche de la
    // réponse (streaming, reasoning) au plus global (le Stop du composer).
    if (input.streaming_visible) {
      return {
        state: "active",
        mode: null,
        signal: "streaming",
        confidence: "high",
      };
    }
    if (input.reasoning_visible) {
      return {
        state: "active",
        mode: null,
        signal: "reasoning",
        confidence: "high",
      };
    }
    if (input.stop_visible) {
      return {
        state: "active",
        mode: null,
        signal: "stop_button",
        confidence: "high",
      };
    }
    // Rien d'actif et rien de terminal, mais une réponse non vide : c'est
    // exactement l'état « quiescent » — ni streaming, ni actions. Une UI qui
    // n'expose plus jamais Copy n'est donc plus une finalisation impossible.
    if (input.output_chars > 0) {
      return {
        state: "quiescent",
        mode: null,
        signal: "output_stable",
        confidence: "medium",
      };
    }
    return { state: "waiting", mode: null, signal: "unknown", confidence: "low" };
  }

  root.ChatGPTBridgeCompletion = { finalizationState };
})(globalThis);
