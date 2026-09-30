const assert = require("node:assert/strict");

require("../extension/completion.js");

const { finalizationState } = globalThis.ChatGPTBridgeCompletion;

const quiet = {
  terminal_action_visible: false,
  streaming_visible: false,
  reasoning_visible: false,
  stop_visible: false,
  output_chars: 0,
};

assert.deepEqual(
  finalizationState({ ...quiet }),
  { state: "waiting", mode: null, signal: "unknown", confidence: "low" },
  "aucune preuve lisible : ni final, ni quiescent",
);

assert.deepEqual(
  finalizationState({
    ...quiet,
    terminal_action_visible: true,
  }),
  {
    state: "final",
    mode: "terminal_action",
    signal: "assistant_actions",
    confidence: "high",
  },
  "les actions visibles restent une preuve terminale explicite",
);

// La barre d'actions du tour surveillé prime sur un Stop encore affiché par le
// composer : c'est le signal le plus spécifique, et le seul qui soit positif.
assert.deepEqual(
  finalizationState({
    ...quiet,
    terminal_action_visible: true,
    stop_visible: true,
  }),
  {
    state: "final",
    mode: "terminal_action",
    signal: "assistant_actions",
    confidence: "high",
  },
  "les actions du tour priment sur le Stop du composer",
);

assert.deepEqual(
  finalizationState({ ...quiet, streaming_visible: true, output_chars: 42 }),
  { state: "active", mode: null, signal: "streaming", confidence: "high" },
  "un streaming actif interdit la finalisation, même avec du texte déjà écrit",
);

assert.deepEqual(
  finalizationState({ ...quiet, reasoning_visible: true, output_chars: 42 }),
  { state: "active", mode: null, signal: "reasoning", confidence: "high" },
  "la phase de réflexion reste un état actif, même avec une réponse partielle",
);

assert.deepEqual(
  finalizationState({ ...quiet, stop_visible: true, output_chars: 42 }),
  { state: "active", mode: null, signal: "stop_button", confidence: "high" },
  "le Stop seul reste un signal d'activité",
);

// Le cas que l'ancienne logique ne savait pas nommer : une réponse complète
// rendue sans aucune barre d'actions (UI moderne).
assert.deepEqual(
  finalizationState({ ...quiet, output_chars: 42 }),
  { state: "quiescent", mode: null, signal: "output_stable", confidence: "medium" },
  "une réponse non vide sans signal terminal est quiescente, jamais active",
);

console.log("completion contract: ok");
