/**
 * Fixtures DOM ChatGPT partagées par les tests du runtime (content-dom) et de
 * l'outil console (dom-contract). Une seule table : le runtime et
 * tools/diagnose.js sont jugés sur les mêmes variantes de l'UI.
 */

// Interface ChatGPT observée en production le 2026-09-24. Volontairement
// sans aucun ancien id prompt ni data-testid d'envoi : si elle passe, c'est
// grâce au contrat actuel, jamais à une signature historique.
const CURRENT_CHATGPT_COMPOSER_2026_09_24 = `<form>
  <div
    contenteditable="true"
    aria-multiline="true"
    role="textbox"
    class="ProseMirror"
    data-composer-markdown
    aria-label="Ask ChatGPT">
    <p data-empty-paragraph="true"
       data-placeholder="Ask ChatGPT"
       class="placeholder">
      <br class="ProseMirror-trailingBreak">
    </p>
  </div>
  <button
    type="submit"
    aria-label="Send">
    Send
  </button>
</form>`;

// Matrice de dérive : [status, strategy, selector] attendus pour le composer
// et le bouton Send. `data-test-offscreen` simule un élément non rendu.
const editorOnly = CURRENT_CHATGPT_COMPOSER_2026_09_24.match(/<div[\s\S]*?<\/div>/)[0];
const structuralEditor = `<div contenteditable="true" role="textbox" aria-multiline="true" class="ProseMirror"></div>`;
const DOM_DRIFT_MATRIX = [
  {
    name: "old ID DOM",
    body: `<form><div id="prompt-textarea" contenteditable="true"></div>
      <button data-testid="send-button">Send</button></form>`,
    composer: ["ok", "named_selector", "#prompt-textarea"],
    send: ["ok", "named_selector", "button[data-testid='send-button']"],
  },
  {
    name: "current ProseMirror DOM",
    body: CURRENT_CHATGPT_COMPOSER_2026_09_24,
    composer: ["ok", "named_selector", "[data-composer-markdown][contenteditable='true'][role='textbox']"],
    send: ["ok", "named_selector", "button[aria-label*='Send']"],
  },
  {
    name: "current DOM without aria-label",
    body: CURRENT_CHATGPT_COMPOSER_2026_09_24
      .replace('aria-label="Ask ChatGPT"', "")
      .replace('aria-label="Send"', ""),
    composer: ["ok", "named_selector", "[data-composer-markdown][contenteditable='true'][role='textbox']"],
    send: ["degraded", "structural_fallback", "button[type='submit']"],
  },
  {
    name: "current DOM with French aria-label",
    body: CURRENT_CHATGPT_COMPOSER_2026_09_24
      .replace('aria-label="Ask ChatGPT"', 'aria-label="Demander à ChatGPT"')
      .replace('aria-label="Send"', 'aria-label="Envoyer le message"'),
    composer: ["ok", "named_selector", "[data-composer-markdown][contenteditable='true'][role='textbox']"],
    send: ["ok", "named_selector", "button[aria-label*='Envoyer']"],
  },
  {
    name: "current DOM with unknown-language aria-label",
    body: CURRENT_CHATGPT_COMPOSER_2026_09_24
      .replace('aria-label="Ask ChatGPT"', 'aria-label="Pregunta a ChatGPT"')
      .replace('aria-label="Send"', 'aria-label="Enviar"'),
    composer: ["ok", "named_selector", "[data-composer-markdown][contenteditable='true'][role='textbox']"],
    send: ["degraded", "structural_fallback", "button[type='submit']"],
  },
  {
    name: "structural fallback",
    body: `<form>${structuralEditor}<button type="submit">Go</button></form>`,
    composer: ["degraded", "structural_fallback", "[contenteditable='true'][role='textbox']"],
    send: ["degraded", "structural_fallback", "button[type='submit']"],
  },
  {
    name: "hidden stale composer (old id, hidden) + current DOM",
    body: `<div id="prompt-textarea" contenteditable="true" data-test-offscreen></div>
      ${CURRENT_CHATGPT_COMPOSER_2026_09_24}`,
    composer: ["ok", "named_selector", "[data-composer-markdown][contenteditable='true'][role='textbox']"],
    send: ["ok", "named_selector", "button[aria-label*='Send']"],
  },
  {
    name: "hidden stale named composer + visible structural composer",
    body: `<div id="prompt-textarea" contenteditable="true" data-test-offscreen></div>
      <form>${structuralEditor}<button type="submit">Go</button></form>`,
    composer: ["degraded", "structural_fallback", "[contenteditable='true'][role='textbox']"],
    send: ["degraded", "structural_fallback", "button[type='submit']"],
  },
  {
    name: "multiple ambiguous composers",
    body: `<form>${editorOnly}</form><form>${editorOnly}</form>`,
    composer: ["ambiguous", "named_selector", "[data-composer-markdown][contenteditable='true'][role='textbox']"],
    send: ["missing", "structural_fallback", "button[type='submit']"],
  },
  {
    name: "send inside form",
    body: `<button aria-label="Send feedback">Feedback</button>${CURRENT_CHATGPT_COMPOSER_2026_09_24}`,
    composer: ["ok", "named_selector", "[data-composer-markdown][contenteditable='true'][role='textbox']"],
    send: ["ok", "named_selector", "button[aria-label*='Send']"],
    sendInForm: true,
  },
  {
    name: "stray submit outside form",
    body: `<form>${editorOnly}</form><button type="submit" aria-label="Send">Stray</button>`,
    composer: ["ok", "named_selector", "[data-composer-markdown][contenteditable='true'][role='textbox']"],
    send: ["missing", "structural_fallback", "button[type='submit']"],
  },
];

module.exports = { CURRENT_CHATGPT_COMPOSER_2026_09_24, DOM_DRIFT_MATRIX };
