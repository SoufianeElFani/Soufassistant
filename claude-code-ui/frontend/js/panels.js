/*
 * The header's drop-down panels, as one family.
 *
 * Each panel module still opens and closes its own panel (and keeps its own
 * outside-click rule); this module only adds what none of them can do alone:
 *
 *  - one at a time: opening a panel closes whichever other one was open, so
 *    two never stack and the button that opened the hidden one is not needed
 *    to get rid of it;
 *  - Escape closes the open panel;
 *  - opening a document in the viewer closes them all (`closeAllPanels`, called
 *    from artifacts.js). Under 1000px the viewer covers the whole frame,
 *    header included, so a panel left open floated above the document with the
 *    button that would close it out of reach; on a wide screen the header
 *    shifts left to make room, so the button was no longer where it was;
 *  - a click into the viewer's iframe closes them too. Clicks inside an iframe
 *    never reach this document, so the outside-click rules could not see it —
 *    but the window loses focus to the iframe, which can be seen.
 *
 * Modules register with `registerPanel(panelEl, closeFn)`; the panel being
 * shown is noticed by watching its `hidden` class, so no open function had to
 * change.
 */
const registry = [];

const isOpen = (panel) => !panel.classList.contains('hidden');

export function registerPanel(panel, close) {
  if (!panel || typeof close !== 'function') return;
  registry.push({ panel, close });
  new MutationObserver(() => {
    if (isOpen(panel)) closeOthers(panel);
  }).observe(panel, { attributes: true, attributeFilter: ['class'] });
}

function closeOthers(keep) {
  for (const r of registry) {
    if (r.panel !== keep && isOpen(r.panel)) {
      try { r.close(); } catch { r.panel.classList.add('hidden'); }
    }
  }
}

export function closeAllPanels() { closeOthers(null); }

export function anyPanelOpen() { return registry.some((r) => isOpen(r.panel)); }

// A modal (confirmation, permission prompt, question) owns Escape while it is up.
function modalOpen() {
  return !!document.querySelector('#confirm-overlay:not(.hidden), #permission-overlay:not(.hidden), #dialog-overlay:not(.hidden)');
}

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.defaultPrevented || !anyPanelOpen() || modalOpen()) return;
  closeAllPanels();
});

// On a phone, the on-screen keyboard shrinks the visible band (viewport.js) but
// the panel's own scroller does not follow the field being typed in: a field low
// in the Hub (the vault passphrase) ended up under the keyboard. Keep the focused
// field of a panel or a dialog in view — on focus, and each time the band resizes.
const FIELD = 'input:not([type=checkbox]):not([type=radio]):not([type=file]), textarea, select';
function revealField() {
  const f = document.activeElement;
  if (!f?.matches?.(FIELD)) return;
  if (!registry.some((r) => isOpen(r.panel) && r.panel.contains(f)) && !f.closest('.permission-overlay')) return;
  // the visible band viewport.js measured (inside the HA app's iframe, our own
  // window does not shrink for the keyboard: only that band does)
  const css = getComputedStyle(document.documentElement);
  const top = parseFloat(css.getPropertyValue('--app-top')) || 0;
  const height = parseFloat(css.getPropertyValue('--app-height')) || window.visualViewport?.height || window.innerHeight;
  const r = f.getBoundingClientRect();
  if (r.top >= top + 8 && r.bottom <= top + height - 8) return;
  // scroll the field's own scroller only: scrollIntoView would also scroll Home
  // Assistant's page around the ingress iframe, and the whole app with it
  let sc = f.parentElement;
  while (sc && sc !== document.body && !/(auto|scroll)/.test(getComputedStyle(sc).overflowY)) sc = sc.parentElement;
  if (!sc || sc === document.body) return;
  const box = sc.getBoundingClientRect();
  const visTop = Math.max(box.top, top), visBottom = Math.min(box.bottom, top + height);
  sc.scrollTop += (r.top + r.height / 2) - (visTop + visBottom) / 2;
}
let revealTimer = null;
const scheduleReveal = () => { clearTimeout(revealTimer); revealTimer = setTimeout(revealField, 120); };
document.addEventListener('focusin', () => { scheduleReveal(); setTimeout(revealField, 450); });   // again once the keyboard is up
window.visualViewport?.addEventListener('resize', scheduleReveal);
window.addEventListener('appband', scheduleReveal);
window.addEventListener('resize', scheduleReveal);

window.addEventListener('blur', () => {
  // activeElement is updated by the time the blur has been dispatched; defer a
  // tick anyway so the check never races the focus change.
  setTimeout(() => {
    if (document.activeElement?.tagName === 'IFRAME' && anyPanelOpen()) closeAllPanels();
  }, 0);
});
