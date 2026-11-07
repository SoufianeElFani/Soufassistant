/*
 * Mode Confidentiel, côté écran (serveur : server/lib/vault.js).
 *
 *   bouton bouclier   sous la zone de saisie : allumé = le message et ses pièces
 *                     jointes sont pseudonymisés par le serveur avant l'envoi.
 *                     Allumé par défaut en Code et Cowork, éteint en Chat ; un clic
 *                     le bascule pour le mode courant (mémorisé).
 *   démasquage        les pseudonymes (Client-A, Personne-03…) des réponses sont
 *                     affichés avec les vrais noms, soulignés en pointillé ; le survol
 *                     montre ce qui a été envoyé. La table vient du serveur
 *                     ('vault_map') et ne quitte jamais le navigateur.
 *   Particulariser    dans la visionneuse : la version réelle d'un livrable est
 *                     produite dans le coffre et téléchargée (jamais dans le Drive).
 */
import { S } from './state.js';
import { wsBase } from './dom.js';
import { icon } from './icons.js';
import { showToast } from './toast.js';

let map = {};          // alias → vrai nom
let re = null;
const DEFAULT_ON = { code: true, cowork: true, chat: false };

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function compile() {
  const keys = Object.keys(map).sort((a, b) => b.length - a.length);
  re = keys.length ? new RegExp(`(?<![\\p{L}\\p{N}@.])(?:${keys.map(esc).join('|')})(?![\\p{L}\\p{N}])`, 'gu') : null;
}

export function applyVaultMap(m) { map = m || {}; compile(); }
export const reveal = (t) => (re && t ? String(t).replace(re, (a) => map[a] ?? a) : t);

/** Dans un élément déjà rendu : remplacer les pseudonymes par les vrais noms, marqués. */
export function revealDom(el) {
  if (!re || !el) return;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const nodes = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) { re.lastIndex = 0; if (re.test(n.nodeValue)) nodes.push(n); }
  re.lastIndex = 0;
  for (const n of nodes) {
    const frag = document.createDocumentFragment();
    let last = 0;
    n.nodeValue.replace(re, (a, off) => {
      frag.appendChild(document.createTextNode(n.nodeValue.slice(last, off)));
      const s = document.createElement('span');
      s.className = 'pii';
      s.textContent = map[a] ?? a;
      s.title = `Envoyé à Claude comme « ${a} »`;
      frag.appendChild(s);
      last = off + a.length;
      return a;
    });
    frag.appendChild(document.createTextNode(n.nodeValue.slice(last)));
    n.replaceWith(frag);
  }
}

// ── Le bouton ──
const left = document.querySelector('.composer-left');
const btn = document.createElement('button');
btn.type = 'button';
btn.id = 'conf-btn';
btn.className = 'attach-btn conf-btn';
btn.innerHTML = '<svg class="ic" viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.4 7.5 9.5 4.3-1.1 7.5-4.9 7.5-9.5V6z"/><path class="conf-check" d="m9 12 2.2 2.2L15.5 10"/></svg>';
left.insertBefore(btn, left.children[1] || null);

const pref = () => { try { return JSON.parse(localStorage.getItem('confidential') || '{}'); } catch { return {}; } };
export function isConfidential() {
  const p = pref();
  return p[S.mode] ?? DEFAULT_ON[S.mode] ?? true;
}
function render() {
  const on = isConfidential();
  btn.classList.toggle('active', on);
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  btn.title = on ? 'Confidentiel : les noms sont pseudonymisés avant l\'envoi (cliquer pour désactiver)'
    : 'Confidentiel désactivé : le message part tel quel (cliquer pour activer)';
  btn.setAttribute('aria-label', btn.title);
  document.body.classList.toggle('conf-on', on);
}
btn.onclick = (e) => {
  e.stopPropagation();
  const p = pref();
  p[S.mode] = !isConfidential();
  localStorage.setItem('confidential', JSON.stringify(p));
  render();
  showToast(p[S.mode] ? 'Confidentiel activé : les noms seront pseudonymisés avant l\'envoi.' : 'Confidentiel désactivé pour ce mode.');
};
new MutationObserver(render).observe(document.body, { attributes: true, attributeFilter: ['data-mode'] });
render();

export const confidentialFields = () => (isConfidential() ? { confidential: true } : {});

export function applyNotice(msg) {
  showToast(`Confidentiel — ${msg.notes.join(' · ')}`, { kind: 'error', timeout: 12000 });
}

// ── Particulariser (visionneuse) ──
const share = document.getElementById('artifact-share');
const real = document.createElement('button');
real.type = 'button';
real.id = 'artifact-real';
real.className = 'find-nav';
real.title = 'Particulariser : produire la version avec les vrais noms (dans le coffre, à télécharger)';
real.setAttribute('aria-label', real.title);
real.innerHTML = icon('user', 16);
share?.before(real);
const sync = () => real.classList.toggle('hidden', !share || share.classList.contains('hidden'));
if (share) new MutationObserver(sync).observe(share, { attributes: true, attributeFilter: ['class'] });
sync();
real.onclick = async () => {
  const p = document.getElementById('artifact-title')?.title;
  if (!p) return;
  real.disabled = true;
  try {
    const r = await (await fetch(`${wsBase}/api/vault/particularize`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: p }) })).json();
    if (!r.ok) { showToast(r.error || 'Impossible.', { kind: 'error' }); return; }
    const f = r.reels[0];
    showToast(`Version réelle prête : ${f.name}`, { action: { label: 'Télécharger', fn: () => window.open(`${wsBase}/api/vault/reel?id=${encodeURIComponent(f.id)}`, '_blank') }, timeout: 20000 });
  } finally { real.disabled = false; }
};
