const assert = require("node:assert/strict");

require("../extension/final-output.js");

const {
  createAccumulator,
  outputChars,
  finalizationOutcome,
  finalizationThresholdMs,
} = globalThis.ChatGPTBridgeFinalOutput;

const thresholds = {
  settle_ms: 2_000,
  settle_unknown_ms: 15_000,
  empty_final_settle_ms: 10_000,
  min_quiescent_observations: 3,
  finalization_stall_ms: 45_000,
  active_signal_stall_ms: 300_000,
};

const outcome = (fields) =>
  finalizationOutcome({
    text: "rapport final",
    stableForMs: 0,
    stableObservations: 0,
    thresholds,
    ...fields,
  }).outcome;

const rewritten = createAccumulator();
rewritten.observe("ABC");
rewritten.observe("ABCDE");
rewritten.observe("ABXYZ");
assert.equal(rewritten.final(), "ABXYZ");
assert.notEqual(rewritten.final(), "ABCDEXYZ");
assert.equal(outputChars("A😀B"), 3);

// --- Fin terminale explicite : SETTLE court -------------------------------- //
assert.equal(
  outcome({
    state: "final",
    mode: "terminal_action",
    signal: "assistant_actions",
    confidence: "high",
    stableForMs: 1_999,
  }),
  "pending",
  "une preuve terminale attend son SETTLE court",
);
assert.equal(
  outcome({
    state: "final",
    mode: "terminal_action",
    signal: "assistant_actions",
    confidence: "high",
    stableForMs: 2_000,
  }),
  "final",
);
assert.equal(
  outcome({
    state: "final",
    mode: "terminal_action",
    signal: "assistant_actions",
    confidence: "high",
    text: "",
    stableForMs: 9_999,
  }),
  "pending",
  "une fin terminale sans texte reste en attente du texte",
);
assert.equal(
  outcome({
    state: "final",
    mode: "terminal_action",
    signal: "assistant_actions",
    confidence: "high",
    text: "",
    stableForMs: 10_000,
  }),
  "no_final_answer",
  "une fin terminale durablement vide n'est jamais un succès",
);

// --- Quiescence : SETTLE_UNKNOWN_MS ET plusieurs observations réelles ------ //
assert.equal(
  outcome({
    state: "quiescent",
    signal: "output_stable",
    confidence: "medium",
    stableForMs: 14_999,
    stableObservations: 120,
  }),
  "pending",
);
assert.equal(
  outcome({
    state: "quiescent",
    signal: "output_stable",
    confidence: "medium",
    stableForMs: 15_000,
    stableObservations: 2,
  }),
  "pending",
  "un unique réveil tardif ne conclut pas une quiescence",
);
const quiescentFinal = finalizationOutcome({
  state: "quiescent",
  signal: "output_stable",
  confidence: "medium",
  text: "BRIDGE_OK",
  stableForMs: 15_000,
  stableObservations: 3,
  thresholds,
});
assert.equal(quiescentFinal.outcome, "final");
assert.equal(quiescentFinal.mode, "quiescent_stability");
assert.equal(quiescentFinal.signal, "quiescent_stability");
assert.equal(quiescentFinal.confidence, "medium");

// --- ACTIVE : aucune durée ne conclut -------------------------------------- //
assert.equal(
  outcome({
    state: "active",
    signal: "streaming",
    confidence: "high",
    stableForMs: 60_000,
    stableObservations: 50,
  }),
  "pending",
  "un texte stable pendant une génération active n'est pas une réponse finie",
);
assert.equal(
  outcome({
    state: "active",
    signal: "reasoning",
    confidence: "high",
    text: "",
    stableForMs: 60_000,
    stableObservations: 50,
  }),
  "pending",
  "un raisonnement actif ne devient jamais incomplet par durée seule",
);
assert.equal(
  outcome({
    state: "waiting",
    signal: "unknown",
    confidence: "low",
    text: "",
    stableForMs: 60_000,
    stableObservations: 50,
  }),
  "pending",
  "aucune preuve lisible : rien ne conclut",
);

const fiveSubjects = createAccumulator();
fiveSubjects.observe(
  "# SUJETS CANDIDATS\n\n## SUBJECT S1\nA\n\n## SUBJECT S2\nB",
);
fiveSubjects.observe(
  [
    "# SUJETS CANDIDATS",
    "## SUBJECT S1\nA réécrit",
    "## SUBJECT S2\nB réécrit",
    "## SUBJECT S3\nC",
    "## SUBJECT S4\nD",
    "## SUBJECT S5\nE",
  ].join("\n\n"),
);
const finalReport = fiveSubjects.final();
assert.equal((finalReport.match(/^## SUBJECT S\d+$/gm) || []).length, 5);
assert.equal(finalReport.includes("A\n\n## SUBJECT S2\nB"), false);

// --- Seuil publié : celui que le runtime applique à cet état ---------------- //
// Le diagnostic vivant affiche « Stable X / threshold » : ce seuil doit être
// la borne de sortie réellement appliquée par `finalizationOutcome`, jamais un
// nombre choisi par le popup.
const threshold = (fields) => finalizationThresholdMs({ thresholds, ...fields });
assert.equal(
  threshold({ state: "active", outputChars: 120 }),
  300_000,
  "ACTIVE sort au bout de `active_signal_stall_ms`",
);
assert.equal(
  outcome({ state: "active", stableForMs: 300_000, stableObservations: 5 }),
  "pending",
  "la durée seule ne convertit jamais ACTIVE en FINAL",
);
assert.equal(
  threshold({ state: "quiescent", outputChars: 120 }),
  45_000,
  "QUIESCENT sort au bout de `finalization_stall_ms`",
);
assert.equal(
  threshold({ state: "final", outputChars: 120 }),
  2_000,
  "une fin terminale avec texte conclut sur `settle_ms`",
);
assert.equal(
  threshold({ state: "final", outputChars: 0 }),
  10_000,
  "une fin terminale sans texte attend `empty_final_settle_ms`",
);
assert.equal(
  threshold({ state: "waiting", outputChars: 0 }),
  null,
  "aucune borne n'est inventée pour un état sans borne",
);
assert.equal(
  threshold({ state: "idle", outputChars: 0 }),
  null,
  "hors run, aucun seuil n'est publié",
);
assert.equal(
  finalizationThresholdMs({ state: "active", outputChars: 1 }),
  null,
  "sans seuils fournis, rien n'est inventé",
);

console.log("final-only output contract: ok");
