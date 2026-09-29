const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const script = fs.readFileSync(path.join(__dirname, '../tools/diagnose-composer-payload.js'), 'utf8');

function diagnose(html) {
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  const { window } = dom;
  window.Element.prototype.getClientRects = () => [{}];
  const output = [];
  window.console.log = (...args) => output.push(args);
  // Reading content is forbidden, even when its result would not be printed.
  for (const node of window.document.querySelectorAll('*')) {
    for (const key of ['textContent', 'innerHTML', 'outerHTML', 'innerText', 'value']) {
      Object.defineProperty(node, key, { get() { throw new Error(`private read: ${key}`); } });
    }
  }
  window.eval(script);
  return output;
}

test('composer recorder captures cards outside form without reading content or filenames', () => {
  const logs = diagnose(`<section><div class="AttachmentCard"><span>PRIVATE_FILENAME.txt</span>
    <button aria-label="Remove PRIVATE_FILENAME.txt" title="PRIVATE_TITLE">remove</button>
    <div role="progressbar" aria-valuenow="25" data-private-content="PRIVATE_DATA"></div>
    <svg><path d="PRIVATE_PATH"></path></svg></div>
    <form><div data-composer-markdown contenteditable="true" role="textbox">PRIVATE_PROMPT</div>
      <button type="submit" aria-disabled="false">Send</button><input value="PRIVATE_VALUE"></form>
  </section>`);
  assert.equal(logs.length, 1);
  assert.equal(logs[0][0], 'bridge_composer_structure');
  const result = JSON.parse(logs[0][1]);
  assert.equal(result.form_found, true);
  assert.equal(result.truncated, false);
  assert.ok(result.nodes.some((node) => node.classes.includes('AttachmentCard')));
  assert.ok(result.nodes.some((node) => node.attributes['aria-valuenow'] === '25'));
  assert.ok(result.nodes.some((node) => node.composer));
  assert.equal(JSON.stringify(logs).includes('PRIVATE_'), false);
});

test('composer recorder limits structure and never chooses an ambiguous composer', () => {
  const logs = diagnose(`<section><form><div id="prompt-textarea" contenteditable="true"></div></form>
    ${'<div><span></span></div>'.repeat(300)}</section>`);
  const result = JSON.parse(logs[0][1]);
  assert.ok(result.nodes.length <= 160);
  assert.equal(result.truncated, true);
  const ambiguous = diagnose('<div id="prompt-textarea" contenteditable="true"></div><div id="prompt-textarea" contenteditable="true"></div>');
  assert.equal(ambiguous[0][0], 'bridge_composer_structure: ambiguous composer');
});

test('observed deep composer records attachment contents rather than cutting off at the card', () => {
  const card = `<div data-composer-attachments data-visible-attachments="true">
    <div class="flex flex-wrap"><span class="group/composer-attachment">
      <div class="attachment-preview"><svg class="file-icon"></svg></div>
      <button aria-label="Remove file"></button>
    </span></div></div>`;
  const logs = diagnose(`<div class="contents"><form>
    <div><div><div><div><div><div>${card}</div></div></div></div></div></div>
    <div data-composer-markdown contenteditable="true" role="textbox"></div>
  </form></div>`);
  const result = JSON.parse(logs[0][1]);
  assert.equal(result.version, 2);
  assert.equal(result.attachment_surface_found, true);
  assert.equal(result.truncated, false);
  assert.ok(result.nodes.some((node) => node.classes.includes('file-icon')));
  assert.ok(result.nodes.some((node) => node.control === 'remove_file'));
});
