const assert = require("node:assert/strict");

require("../extension/final-output.js");

const { createAccumulator, outputChars, settledOutcome } =
  globalThis.ChatGPTBridgeFinalOutput;

const rewritten = createAccumulator();
rewritten.observe("ABC");
rewritten.observe("ABCDE");
rewritten.observe("ABXYZ");
assert.equal(rewritten.final(), "ABXYZ");
assert.notEqual(rewritten.final(), "ABCDEXYZ");
assert.equal(outputChars("A😀B"), 3);
assert.equal(
  settledOutcome({
    completion: { finished: true },
    text: "",
    stableForMs: 10_000,
    emptySettleMs: 10_000,
  }),
  "incomplete",
);
assert.equal(
  settledOutcome({
    completion: { finished: false },
    text: "",
    stableForMs: 60_000,
    emptySettleMs: 10_000,
  }),
  "active",
  "un raisonnement actif ne devient jamais incomplet par durée seule",
);
assert.equal(
  settledOutcome({
    completion: { finished: true },
    text: "rapport final",
    stableForMs: 2_000,
    emptySettleMs: 10_000,
  }),
  "complete",
);
assert.equal(
  settledOutcome({
    completion: { finished: null },
    text: "",
    stableForMs: 60_000,
    emptySettleMs: 10_000,
  }),
  "unknown",
  "une longue durée ne transforme pas un état DOM inconnu en fin fiable",
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

console.log("final-only output contract: ok");
