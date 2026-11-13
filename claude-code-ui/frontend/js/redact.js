/*
 * L'éditeur de masquage (mode Confidentiel, 1.5.0 ; serveur : server/lib/redact.js).
 *
 * Une image ou un PDF joint avec le bouclier passe par ici avant l'envoi :
 * le serveur (sur Home Assistant) propose les zones à masquer — en plein : sûres
 * (coffre, e-mails, téléphones, adresses, champs du cartouche…), en pointillé :
 * suggestions. Toucher une zone la (dés)active, glisser en ajoute une, « Cartouche »
 * couvre le coin inférieur droit. À l'envoi, les zones sont peintes en noir et
 * l'image ré-encodée en PNG par le navigateur : plus de texte, de calques ni de
 * métadonnées. Un grand plan part en tuiles lisibles + une vue d'ensemble.
 */
import { wsBase } from './dom.js';

const TILE = 1800;          // px per tile side (the model reads ~1.5k px per image)
const OVERLAP = 80;
const MAX_IMAGES = 60;

const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const loadImage = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('image illisible')); i.src = src; });
const base = (name) => String(name || 'image').replace(/\.[^.]+$/, '').replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 60) || 'image';

/** Ask the server for the pages and the proposed boxes. */
async function analyze(att) {
  const r = await fetch(`${wsBase}/api/vault/redact`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: att.name, mediaType: att.mediaType, data: att.dataUrl }) });
  return r.json();
}

/** The painted pixels of one page, cut into tiles when it is large. → [{ name, dataUrl }] */
function exportPage(img, boxes, name, tile) {
  const W = img.naturalWidth, H = img.naturalHeight;
  const paint = (cv, sx, sy, sw, sh, scale = 1) => {
    const g = cv.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height);
    g.drawImage(img, sx, sy, sw, sh, 0, 0, cv.width, cv.height);
    g.fillStyle = '#000';
    for (const b of boxes) if (b.on) g.fillRect((b.x - sx) * scale, (b.y - sy) * scale, b.w * scale, b.h * scale);
    return cv.toDataURL('image/png');
  };
  const cv = (w, hh) => { const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(hh)); return c; };
  if (Math.max(W, H) <= tile * 1.15) return [{ name: `${name}.png`, dataUrl: paint(cv(W, H), 0, 0, W, H) }];
  const out = [];
  const k = 1568 / Math.max(W, H);
  out.push({ name: `${name}_vue.png`, dataUrl: paint(cv(W * k, H * k), 0, 0, W, H, k) });
  const cols = Math.ceil(W / tile), rows = Math.ceil(H / tile);
  const tw = Math.ceil(W / cols), th = Math.ceil(H / rows);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const sx = Math.max(0, c * tw - OVERLAP), sy = Math.max(0, r * th - OVERLAP);
    const sw = Math.min(W - sx, tw + 2 * OVERLAP), sh = Math.min(H - sy, th + 2 * OVERLAP);
    out.push({ name: `${name}_l${r + 1}c${c + 1}.png`, dataUrl: paint(cv(sw, sh), sx, sy, sw, sh) });
  }
  return out;
}

/**
 * Open the editor for one attachment ({ name, mediaType, dataUrl }).
 * → [{ name, mediaType: 'image/png', dataUrl }] to send instead, or null (cancelled).
 */
export async function redactAttachment(att, { single = false } = {}) {
  const wait = h('div', 'permission-overlay redact-overlay');
  wait.appendChild(h('div', 'redact-wait', 'Analyse locale de l\'image (texte, OCR)…'));
  document.body.appendChild(wait);
  let res;
  try { res = await analyze(att); } catch (e) { res = { ok: false, error: e.message }; } finally { wait.remove(); }
  if (!res?.ok) { alertBox(res?.error || 'Analyse impossible.'); return null; }
  const isPdf = res.pages.some((p) => p.png);
  const pages = [];
  for (const p of res.pages) {
    const img = await loadImage(p.png ? `data:image/png;base64,${p.png}` : att.dataUrl).catch(() => null);
    if (!img) { alertBox('Image illisible.'); return null; }
    pages.push({ img, text: p.text, boxes: p.boxes.map((b) => ({ ...b, on: b.sure, auto: true })) });
  }
  return new Promise((resolve) => {
    const ov = h('div', 'permission-overlay redact-overlay');
    const card = h('div', 'redact-card');
    ov.appendChild(card);
    const top = h('div', 'redact-top');
    const title = h('b', null, `Masquer avant l'envoi — ${att.name}`);
    const info = h('div', 'redact-info');
    top.append(title, info);
    const stage = h('div', 'redact-stage');
    const canvas = h('canvas', 'redact-canvas');
    stage.appendChild(canvas);
    const bar = h('div', 'perm-buttons redact-bar');
    const btn = (label, cls, fn, title) => { const b = h('button', `btn ${cls}`, label); b.type = 'button'; if (title) b.title = title; b.onclick = fn; bar.appendChild(b); return b; };
    let cur = 0;
    const prev = btn('‹', 'btn-deny redact-nav', () => { if (cur > 0) { cur--; draw(); } }, 'Page précédente');
    const next = btn('›', 'btn-deny redact-nav', () => { if (cur < pages.length - 1) { cur++; draw(); } }, 'Page suivante');
    btn('Cartouche', 'btn-deny', () => {
      const { img } = pages[cur];
      const W = img.naturalWidth, H = img.naturalHeight;
      pages[cur].boxes.push({ x: Math.round(W * 0.62), y: Math.round(H * 0.72), w: Math.round(W * 0.38), h: Math.round(H * 0.28), on: true, why: 'cartouche' });
      draw();
    }, 'Masquer le coin inférieur droit (cartouche d\'un plan) — ajustable en traçant d\'autres zones');
    btn('Suggestions', 'btn-deny', () => { const s = pages[cur].boxes.filter((b) => b.auto && !b.sure); const on = !s.every((b) => b.on); for (const b of s) b.on = on; draw(); }, 'Masquer / démasquer toutes les suggestions de la page');
    btn('Annuler', 'btn-deny', () => done(null));
    btn(single ? 'Enregistrer masqué' : 'Envoyer masqué', 'btn-allow', () => {
      const name = base(att.name);
      let tile = TILE;
      const count = (t) => pages.reduce((n, p) => { const W = p.img.naturalWidth, H = p.img.naturalHeight; return n + (Math.max(W, H) <= t * 1.15 ? 1 : 1 + Math.ceil(W / t) * Math.ceil(H / t)); }, 0);
      while (count(tile) > MAX_IMAGES && tile < 8000) tile += 400;
      if (single) tile = Infinity;      // one full-resolution picture (saved in the workspace, not sent)
      const out = [];
      pages.forEach((p, i) => out.push(...exportPage(p.img, p.boxes, pages.length > 1 ? `${name}_p${i + 1}` : name, tile)));
      done(out.map((o) => ({ ...o, mediaType: 'image/png' })));
    });
    card.append(top, stage, bar);
    document.body.appendChild(ov);
    const done = (v) => { ov.remove(); window.removeEventListener('resize', draw); resolve(v); };
    ov.onclick = (e) => e.stopPropagation();

    let scale = 1;
    function draw() {
      const { img, boxes, text } = pages[cur];
      const W = img.naturalWidth, H = img.naturalHeight;
      const r = stage.getBoundingClientRect();
      scale = Math.min((r.width || 800) / W, (r.height || 500) / H, 1.5);
      canvas.width = Math.round(W * scale); canvas.height = Math.round(H * scale);
      const g = canvas.getContext('2d');
      g.drawImage(img, 0, 0, canvas.width, canvas.height);
      for (const b of boxes) {
        const x = b.x * scale, y = b.y * scale, w = b.w * scale, hh = b.h * scale;
        if (b.on) { g.fillStyle = 'rgba(0,0,0,.82)'; g.fillRect(x, y, w, hh); }
        g.setLineDash(b.on ? [] : [5, 4]);
        g.strokeStyle = b.on ? '#d32f2f' : '#ef6c00';
        g.lineWidth = 2;
        g.strokeRect(x, y, w, hh);
      }
      g.setLineDash([]);
      const on = boxes.filter((b) => b.on).length;
      const how = text === 'vecteur' ? 'texte du PDF' : text === 'ocr' ? 'OCR local' : 'pas d\'OCR : masque à la main';
      info.textContent = `${pages.length > 1 ? `Page ${cur + 1}/${pages.length} · ` : ''}${on} zone(s) masquée(s) · ${boxes.length - on} suggestion(s) · ${how}${res.note ? ` · ${res.note}` : ''}. Plein = masqué, pointillé = suggestion ; touche une zone pour basculer, glisse pour en tracer une. Vérifie aussi les logos, signatures et photos.`;
      prev.classList.toggle('hidden', pages.length < 2); next.classList.toggle('hidden', pages.length < 2);
      prev.disabled = cur === 0; next.disabled = cur === pages.length - 1;
    }
    // pointer: tap toggles (a hand-drawn zone is removed), drag draws a new zone
    let start = null;
    const pt = (e) => { const r = canvas.getBoundingClientRect(); return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale }; };
    canvas.onpointerdown = (e) => { e.preventDefault(); canvas.setPointerCapture(e.pointerId); start = pt(e); };
    canvas.onpointermove = (e) => {
      if (!start) return;
      const p = pt(e);
      draw();
      const g = canvas.getContext('2d');
      g.strokeStyle = '#d32f2f'; g.lineWidth = 2;
      g.strokeRect(Math.min(start.x, p.x) * scale, Math.min(start.y, p.y) * scale, Math.abs(p.x - start.x) * scale, Math.abs(p.y - start.y) * scale);
    };
    canvas.onpointerup = (e) => {
      if (!start) return;
      const p = pt(e), s = start;
      start = null;
      const boxes = pages[cur].boxes;
      if (Math.abs(p.x - s.x) * scale < 6 && Math.abs(p.y - s.y) * scale < 6) {
        const hit = [...boxes].reverse().find((b) => p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h);
        if (hit) { if (hit.auto || hit.why === 'cartouche') hit.on = !hit.on; else boxes.splice(boxes.indexOf(hit), 1); }
      } else {
        boxes.push({ x: Math.min(s.x, p.x), y: Math.min(s.y, p.y), w: Math.abs(p.x - s.x), h: Math.abs(p.y - s.y), on: true, why: 'main' });
      }
      draw();
    };
    window.addEventListener('resize', draw);
    requestAnimationFrame(draw);
    if (isPdf && res.dpi) title.title = `${res.dpi} dpi`;
  });
}

function alertBox(msg) {
  const ov = h('div', 'permission-overlay redact-overlay');
  const card = h('div', 'permission-card confirm-card');
  card.append(h('p', 'confirm-body', `Masquage impossible : ${msg} Rien n'a été envoyé.`));
  const bar = h('div', 'perm-buttons');
  const ok = h('button', 'btn btn-allow', 'OK'); ok.type = 'button'; ok.onclick = () => ov.remove();
  bar.appendChild(ok); card.appendChild(bar); ov.appendChild(card);
  document.body.appendChild(ov);
}
