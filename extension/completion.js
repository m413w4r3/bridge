/** Détection pure et testable de la fin d'un tour assistant. */
(function exposeCompletion(root) {
  function completionState(signals) {
    // La barre d'actions appartient au tour assistant surveillé : c'est le
    // signal positif le plus spécifique, et il n'apparaît pas tant que ChatGPT
    // écrit. Il prime donc sur les signaux d'activité, moins localisés.
    if (signals.actionsVisible) {
      return {
        finished: true,
        signal: "assistant_actions",
        confidence: "high",
      };
    }
    // Les signaux ci-dessous disent qu'une génération est encore active. Ils ne
    // sont évalués qu'en l'absence du signal terminal, du plus proche du tour
    // (streaming, reasoning) au plus global (le Stop du composer).
    if (signals.streamingVisible) {
      return { finished: false, signal: "streaming", confidence: "high" };
    }
    if (signals.reasoningVisible) {
      return { finished: false, signal: "reasoning", confidence: "high" };
    }
    if (signals.stopVisible) {
      return { finished: false, signal: "stop_button", confidence: "high" };
    }
    return { finished: null, signal: "unknown", confidence: "low" };
  }

  root.ChatGPTBridgeCompletion = { completionState };
})(globalThis);
