/**
 * Paste into the ChatGPT tab's DevTools console while the converted file is
 * visible. Read-only, one snapshot, bounded structure only: no text, filenames,
 * HTML, URLs, input values, aria-label/title, or SVG path data.
 */
(() => {
  const selectors = [
    "[data-composer-markdown][contenteditable='true'][role='textbox']",
    "#prompt-textarea", "[data-testid='prompt-textarea']",
    "div[contenteditable='true'][id^='prompt']", "textarea[data-id]",
    "[contenteditable='true'][role='textbox']",
  ];
  const visible = (node) => node.isConnected && node.getClientRects().length > 0;
  let composer = null;
  for (const selector of selectors) {
    const found = [...document.querySelectorAll(selector)].filter(visible);
    if (found.length > 1) return console.log('bridge_composer_structure: ambiguous composer');
    if (found.length === 1) { composer = found[0]; break; }
  }
  if (!composer) return console.log('bridge_composer_structure: composer missing');
  const form = composer.closest('form');
  // Start AT the attachments region: the observed composer nests its cards
  // eight levels down, so a form-root traversal cut off their entire contents.
  const attachmentSurface = form && [...form.querySelectorAll('[data-composer-attachments]')]
    .find((node) => node.querySelector("[class~='group/composer-attachment']"));
  const root = attachmentSurface || form?.parentElement || composer.parentElement;
  const attributes = [
    'role', 'data-testid', 'data-state', 'data-upload-status', 'data-status',
    'data-loading', 'aria-busy', 'aria-invalid', 'aria-disabled',
    'aria-valuenow', 'aria-valuemax', 'aria-hidden',
    'data-visible-attachments', 'data-upload-progress', 'data-file-status',
  ];
  const nodes = [];
  let truncated = false;
  function visit(node, parent, depth) {
    if (nodes.length >= 160 || depth > 8) { truncated = true; return; }
    const index = nodes.length;
    const item = { parent, tag: node.tagName, visible: visible(node) };
    if (node === composer) item.composer = true;
    if (node === form) item.composer_form = true;
    if (node.tagName === 'BUTTON') item.disabled = node.disabled === true;
    // Fixed UI labels only; arbitrary labels may embed private filenames.
    const fixedControls = [
      ['[aria-label="Remove file"]', 'remove_file'],
      ['[aria-label="Remove attachment"]', 'remove_file'],
      ['[aria-label="Supprimer le fichier"]', 'remove_file'],
      ['[aria-label="Supprimer la pièce jointe"]', 'remove_file'],
      ['[aria-label="Cancel upload"]', 'cancel_upload'],
      ['[aria-label="Annuler le téléversement"]', 'cancel_upload'],
    ];
    const control = fixedControls.find(([selector]) => node.matches(selector));
    if (control) item.control = control[1];
    item.classes = [...node.classList].filter((token) =>
      token.length <= 96 && /^[A-Za-z0-9_:/.[\]()%#=+-]+$/.test(token)).slice(0, 12);
    item.attributes = {};
    for (const name of attributes) {
      const value = node.getAttribute(name);
      if (value !== null && value.length <= 80 && /^[A-Za-z0-9_.:-]*$/.test(value)) {
        item.attributes[name] = value;
      }
    }
    // Attribute NAMES can reveal unanticipated UI state contracts without
    // copying arbitrary attribute VALUES (which can contain private content).
    item.data_keys = node.getAttributeNames().filter((name) =>
      /^data-[a-z0-9-]{1,60}$/.test(name)).slice(0, 16);
    nodes.push(item);
    if (node === composer || node.matches('[contenteditable], textarea, input')) return;
    let count = 0;
    for (const child of node.children) {
      if (++count > 32) { truncated = true; break; }
      visit(child, index, depth + 1);
      if (nodes.length >= 160) { truncated = true; break; }
    }
  }
  visit(root, null, 0);
  console.log('bridge_composer_structure', JSON.stringify({
    version: 2, form_found: Boolean(form), attachment_surface_found: Boolean(attachmentSurface), truncated, nodes,
  }));
})();
