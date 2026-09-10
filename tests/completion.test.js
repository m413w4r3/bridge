const assert = require("node:assert/strict");

require("../extension/completion.js");

const { completionState } = globalThis.ChatGPTBridgeCompletion;

assert.deepEqual(
  completionState({
    stopVisible: false,
    streamingVisible: false,
    reasoningVisible: false,
    actionsVisible: false,
    sendVisible: true,
  }),
  { finished: null, signal: "unknown", confidence: "low" },
  "le bouton Envoyer seul ne prouve pas la fin",
);

assert.deepEqual(
  completionState({
    stopVisible: false,
    streamingVisible: false,
    reasoningVisible: false,
    actionsVisible: true,
  }),
  { finished: true, signal: "assistant_actions", confidence: "high" },
  "les actions visibles constituent un signal positif",
);

// La barre d'actions du tour surveillé prime sur un Stop encore affiché par le
// composer : c'est le signal le plus spécifique, et le seul qui soit positif.
assert.deepEqual(
  completionState({
    stopVisible: true,
    streamingVisible: false,
    reasoningVisible: false,
    actionsVisible: true,
  }),
  { finished: true, signal: "assistant_actions", confidence: "high" },
  "les actions du tour priment sur le Stop du composer",
);

assert.deepEqual(
  completionState({
    stopVisible: false,
    streamingVisible: true,
    reasoningVisible: false,
    actionsVisible: false,
  }),
  { finished: false, signal: "streaming", confidence: "high" },
  "un streaming sans actions interdit toujours la finalisation",
);

assert.deepEqual(
  completionState({
    stopVisible: false,
    streamingVisible: false,
    reasoningVisible: true,
    actionsVisible: false,
  }),
  { finished: false, signal: "reasoning", confidence: "high" },
  "la phase de réflexion reste un état actif",
);

assert.deepEqual(
  completionState({
    stopVisible: true,
    streamingVisible: false,
    reasoningVisible: false,
    actionsVisible: false,
  }),
  { finished: false, signal: "stop_button", confidence: "high" },
  "le Stop seul reste un signal d'activité",
);

console.log("completion contract: ok");
