/**
 * Citations du serializer DOM : les pastilles restent hors du texte et sont
 * rendues à part, les liens HTTPS ordinaires sont conservés, les destinations
 * non sûres sont rejetées.
 *
 * Ces cas vivaient dans les tests de l'application cliente, qui importait
 * directement `extension/serializer.js`, avant l'extraction du Bridge.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");

const SERIALIZER = fs.readFileSync(
  path.join(__dirname, "..", "extension", "serializer.js"),
  "utf8",
);

function serialize(html) {
  const dom = new JSDOM("<!doctype html><body></body>", {
    runScripts: "outside-only",
  });
  dom.window.eval(SERIALIZER);
  const root = dom.window.document.createElement("div");
  root.innerHTML = html;
  // Les objets nés dans le realm jsdom ont un autre prototype : on les
  // recopie pour que deepEqual compare des valeurs, pas des realms.
  return JSON.parse(
    JSON.stringify(dom.window.ChatGPTBridgeSerializer.serializeResponse(root)),
  );
}

test("keeps citation pills out of words and returns them separately", () => {
  const result = serialize(`
    <p>Le groupe utili<span data-testid="webpage-citation-pill">
      <a href="https://publisher.example/report?utm_source=chatgpt">Publisher</a>
    </span>se un chargeur.</p>
    <span data-testid="webpage-citation-pill">
      <a href="https://second.example/advisory">+1</a>
    </span>
  `);

  assert.ok(result.text.includes("Le groupe utilise un chargeur."));
  assert.ok(!result.text.includes("Publisher"));
  assert.ok(!result.text.includes("+1"));
  assert.deepEqual(result.visible_citations, [
    {
      label: "Publisher",
      url: "https://publisher.example/report?utm_source=chatgpt",
      canonical_url: "https://publisher.example/report",
      position: null,
    },
    {
      label: "+1",
      url: "https://second.example/advisory",
      canonical_url: "https://second.example/advisory",
      position: null,
    },
  ]);
  assert.equal(result.serializer_version, "chatgpt-dom-v3");
});

test("keeps ordinary HTTPS links and rejects unsafe citation destinations", () => {
  const result = serialize(`
    <p>Lire <a href="https://cert.example/advisory">l'avis du CERT</a>.</p>
    <span data-testid="citation"><a href="http://unsafe.example/">Unsafe</a></span>
  `);

  assert.ok(
    result.text.includes("Lire [l'avis du CERT](https://cert.example/advisory)."),
  );
  assert.deepEqual(result.visible_citations, []);
});
