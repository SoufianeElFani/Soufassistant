/*
 * Mode Confidentiel, côté écran (serveur : server/lib/vault.js).
 *
 *   bouton bouclier   sous la zone de saisie : allumé = le message et ses pièces
 *                     jointes sont pseudonymisés par le serveur avant l'envoi.
 *                     Allumé par défaut dans tous les modes ; un clic le bascule
 *                     pour le mode courant (mémorisé).
 *   avant l'envoi     coffre chiffré et verrouillé → demande de la phrase de passe ;
 *                     puis l'alerte : les mots qui ressemblent à des noms et que le
 *                     coffre ne connaît pas (protéger / ne plus signaler / laisser) ;
 *                     enfin chaque image / PDF joint passe par l'éditeur de masquage
 *                     (redact.js) — un PDF peut aussi partir en texte pseudonymisé.
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
import { redactAttachment, blackOut } from './redact.js';

let map = {};          // alias → vrai nom
let re = null;
const DEFAULT_ON = { code: true, cowork: true, chat: true };
let status = { encrypted: false, locked: false };

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
  if (on && status.locked) btn.title = 'Confidentiel : coffre verrouillé — la phrase de passe sera demandée à l\'envoi';
  btn.classList.toggle('locked', on && status.locked);
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

/**
 * A passphrase field iOS leaves alone. In the Home Assistant app's WebView a
 * type=password field opened the password AutoFill bar but never the keyboard,
 * so the vault passphrase could not be typed on an iPhone: plain text, masked by
 * CSS (-webkit-text-security), no autofill hints.
 */
export function secretField(i) {
  i.type = 'text';
  i.classList.add('pass-field');
  i.autocomplete = 'off';
  for (const [k, v] of [['autocapitalize', 'off'], ['autocorrect', 'off'], ['spellcheck', 'false'], ['data-1p-ignore', ''], ['data-lpignore', 'true']]) i.setAttribute(k, v);
  return i;
}

export function applyVaultStatus(m) { status = { encrypted: !!m.encrypted, locked: !!m.locked }; render(); }

const readFileAsDataURL = (file) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(file); });
const post = (u, b) => fetch(`${wsBase}${u}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) }).then((r) => r.json());

// ── Une petite boîte de dialogue (même habillage que les confirmations) ──
function dialog(build) {
  return new Promise((resolve) => {
    const ov = document.createElement('div');
    ov.className = 'permission-overlay conf-dialog';
    const card = document.createElement('div');
    card.className = 'permission-card confirm-card';
    ov.appendChild(card);
    const done = (v) => { ov.remove(); document.removeEventListener('keydown', esc); resolve(v); };
    const esc = (e) => { if (e.key === 'Escape') { e.preventDefault(); done(null); } };
    ov.onclick = (e) => { e.stopPropagation(); if (e.target === ov) done(null); };
    document.addEventListener('keydown', esc);
    build(card, done);
    document.body.appendChild(ov);
    card.querySelector('input, select, button.btn-allow')?.focus();
  });
}
const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
function head(card, title, body) {
  const hd = h('div', 'card-head');
  hd.appendChild(h('h3', 'perm-title', title));
  card.append(hd, h('p', 'confirm-body', body));
}
function buttons(card, list) {
  const bar = h('div', 'perm-buttons');
  for (const [label, cls, fn] of list) { const b = h('button', `btn ${cls}`, label); b.type = 'button'; b.onclick = fn; bar.appendChild(b); }
  card.appendChild(bar);
}

/** Demander la phrase de passe et déverrouiller le coffre. → true si déverrouillé */
export function askUnlock() {
  return dialog((card, done) => {
    head(card, 'Coffre verrouillé', 'Le coffre du mode Confidentiel est chiffré. Saisis ta phrase de passe pour pseudonymiser ce message. Elle n\'est jamais enregistrée ; le coffre se reverrouille au redémarrage de l\'app.');
    const inp = secretField(h('input', 'scheduled-form-input')); inp.id = 'conf-pass';
    const err = h('div', 'conf-err');
    card.append(inp, err);
    const go = async () => {
      const r = await post('/api/vault/unlock', { pass: inp.value }).catch(() => ({ ok: false, error: 'Serveur injoignable.' }));
      if (r.ok) { status.locked = false; render(); done(true); } else { err.textContent = r.error || 'Échec.'; inp.select(); }
    };
    inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } };
    buttons(card, [['Annuler', 'btn-deny', () => done(false)], ['Déverrouiller', 'btn-allow', go]]);
  });
}

const KINDS = [['client', 'Client'], ['personne', 'Personne'], ['lieu', 'Lieu'], ['projet', 'Projet'], ['partenaire', 'Partenaire'], ['autre', 'Autre']];
/**
 * Avant l'envoi d'un message confidentiel : coffre déverrouillé, l'alerte sur
 * les noms possibles que le coffre ne connaît pas, puis le masquage des images
 * et PDF joints. → false (rien n'est envoyé) ou { replaced: Map(pièce jointe →
 * images masquées à envoyer à sa place) }.
 */
export async function preSendCheck(text, atts = []) {
  const replaced = new Map();
  const extra = new Map();     // attachment → fields sent with it (an Office file's repainted pictures)
  if (!isConfidential()) return { replaced, extra };
  if (status.locked && !(await askUnlock())) return false;
  if (text && !(await namesCheck(text))) return false;
  for (const a of atts) {
    if (OFFICE_RE.test(a.name)) {
      const f = await officePictures(a);
      if (f === null) return false;
      if (f) extra.set(a, f);
      continue;
    }
    const pdf = /pdf/i.test(a.mediaType) || /\.pdf$/i.test(a.name);
    if (!a.isImage && !pdf) continue;
    if (pdf && !(await askPdfAsImage(a.name))) continue;      // as pseudonymised text, server-side
    const dataUrl = await readFileAsDataURL(a.file).catch(() => null);
    if (!dataUrl) return false;
    const out = await redactAttachment({ name: a.name, mediaType: a.mediaType || (pdf ? 'application/pdf' : 'image/png'), dataUrl });
    if (!out) return false;
    replaced.set(a, out);
  }
  return { replaced, extra };
}

// old formats too: the server converts them (LibreOffice) before listing their pictures
const OFFICE_RE = /\.(docx|pptx|xlsx|doc|xls|ppt|rtf|odt|ods|odp)$/i;
/**
 * The pictures inside a Word / PowerPoint / Excel file: the text is pseudonymised
 * by the server, but a logo, a screenshot or a site photo would leave as is.
 * → null (cancelled), false (none, or sent as they are), or the fields to send:
 *   { redactedMedia: { 'word/media/image1.png': dataUrl… }, blankMedia: true }
 */
async function officePictures(a) {
  const dataUrl = await readFileAsDataURL(a.file).catch(() => null);
  if (!dataUrl) return null;
  const r = await post('/api/vault/office-media', { name: a.name, data: dataUrl }).catch(() => null);
  if (r?.locked) { if (!(await askUnlock())) return null; return officePictures(a); }
  if (!r?.ok || (!r.images.length && !r.other.length)) return false;
  const n = r.images.length, o = r.other.length;
  const how = await dialog((card, done) => {
    head(card, `Images dans ${a.name}`, `Ce document contient ${n + o} image(s)${o ? ` (dont ${o} dans un format que je ne peux que remplacer par une image vide : EMF, WMF, SVG…)` : ''}. Le texte est pseudonymisé, mais les images partiraient telles quelles : logos, captures, photos de site.`);
    buttons(card, [
      ['Annuler', 'btn-deny', () => done(null)],
      ['Les laisser', 'btn-deny', () => done('keep')],
      ['Tout masquer', 'btn-deny', () => done('blank')],
      ...(n ? [['Les vérifier une à une', 'btn-allow', () => done('check')]] : []),
    ]);
  });
  if (!how) return null;
  if (how === 'keep') return false;
  const media = {};
  for (const [i, img] of r.images.entries()) {
    const src = `data:${img.mime};base64,${img.b64}`;
    if (how === 'blank') { media[img.path] = await blackOut(src, img.mime); continue; }
    const out = await redactAttachment({ name: `${a.name} — image ${i + 1}/${n}`, mediaType: img.mime, dataUrl: src }, { single: true, format: img.mime, confirm: i + 1 < n ? 'Image suivante' : 'Terminer' });
    if (!out) return null;
    media[img.path] = out[0].dataUrl;
  }
  return { redactedMedia: media, blankMedia: true };
}

/** Un PDF joint : document (texte pseudonymisé) ou plan / P&ID (image masquée) ? → true = image */
function askPdfAsImage(name) {
  return dialog((card, done) => {
    head(card, `PDF joint : ${name}`, 'Un document (offre, rapport) part en texte pseudonymisé. Un plan, un P&ID ou un schéma part en image : tu masques ce qu\'il faut, et seuls des pixels sont envoyés.');
    buttons(card, [['Texte pseudonymisé', 'btn-deny', () => done(false)], ['Plan / image masquée', 'btn-allow', () => done(true)]]);
  }).then((v) => v === true);
}

async function namesCheck(text) {
  let r = await post('/api/vault/preview', { text }).catch(() => null);
  if (r?.locked) { if (!(await askUnlock())) return false; r = await post('/api/vault/preview', { text }).catch(() => null); }
  if (!r?.ok || !r.unknown?.length) return true;   // the server still masks what it knows
  const choice = await dialog((card, done) => {
    head(card, 'Noms possibles non protégés', 'Ces mots ressemblent à des noms et ne sont pas dans le coffre : ils partiraient tels quels. Choisis pour chacun.');
    const rows = h('div', 'conf-rows');
    const sels = r.unknown.map((c) => {
      const row = h('div', 'conf-row');
      const sel = h('select', 'scheduled-form-input');
      for (const [k, l] of KINDS) sel.appendChild(new Option(`Protéger · ${l}`, k));
      sel.appendChild(new Option('Laisser passer (cette fois)', 'pass'));
      sel.appendChild(new Option('Ne plus signaler', 'ignore'));
      sel.value = c.kind;
      row.append(h('b', null, c.real), sel);
      rows.appendChild(row);
      return [c, sel];
    });
    card.appendChild(rows);
    buttons(card, [['Annuler', 'btn-deny', () => done(null)], ['Envoyer', 'btn-allow', () => done(sels.map(([c, s]) => [c, s.value]))]]);
  });
  if (!choice) return false;
  for (const [c, v] of choice) if (v !== 'pass' && v !== 'ignore') await post('/api/vault/entity', { real: c.real, kind: v });
  const ign = choice.filter(([, v]) => v === 'ignore').map(([c]) => c.real);
  if (ign.length) await post('/api/vault/ignore', { words: ign });
  return true;
}

/** Le serveur a refusé (coffre verrouillé entre-temps) : rien n'est parti. */
export function applyVaultLocked(msg) {
  status.locked = true; render();
  showToast('Coffre verrouillé : rien n\'a été envoyé. Déverrouille-le puis renvoie le message.', { kind: 'error', timeout: 12000, action: { label: 'Déverrouiller', fn: () => askUnlock() } });
  const box = document.getElementById('prompt-input');
  if (box && !box.value && msg.text) box.value = msg.text;
}

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
