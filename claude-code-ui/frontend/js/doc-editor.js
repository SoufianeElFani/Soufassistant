/*
 * Editors for what the plain text editor cannot open — mounted by the
 * artifact viewer (artifacts.js) into its body, behind the same ✎ / Save /
 * Cancel buttons:
 *
 *   docx / pptx   the text, paragraph by paragraph (pptx: slide by slide, with
 *                 the slide's picture and its speaker notes); layout, styles,
 *                 images and the template are left as they are (server:
 *                 office-edit.js)
 *   xlsx          a grid per sheet: values, or a formula starting with =
 *   pdf           the pages: reorder, delete
 *   png/jpg/webp  rotate, flip, crop, resize, draw
 *   csv / tsv     a grid (or the text editor, one click away)
 *
 * Every mount returns { dirty(), save(force) } (csv: { dirty(), text() }, saved
 * as text by the viewer). save() resolves to the server's { ok, conflict, error }.
 */
import { wsBase } from './dom.js';

const OFFICE_EDIT = new Set(['docx', 'pptx', 'xlsx', 'pdf']);
const IMAGE_EDIT = new Set(['png', 'jpg', 'jpeg', 'webp']);
export const isDocEditable = (ext) => OFFICE_EDIT.has(String(ext || '').toLowerCase());
export const isImageEditable = (ext) => IMAGE_EDIT.has(String(ext || '').toLowerCase());

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const btn = (label, title, onclick, cls = 'doc-btn') => {
  const b = el('button', cls, label);
  b.type = 'button';
  b.title = title;
  b.onclick = onclick;
  return b;
};

async function getJson(url, opts) {
  const res = await fetch(url, { cache: 'no-store', ...opts });
  const r = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  return r;
}
const postDoc = (body) => getJson(`${wsBase}/api/doc`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

function autoGrow(ta) {
  ta.style.height = 'auto';
  ta.style.height = `${ta.scrollHeight + 2}px`;
}

/** Page images from the viewer's renderer (doc-preview.js), or null. */
async function pageImages(path) {
  try {
    const r = await getJson(`${wsBase}/api/preview?path=${encodeURIComponent(path)}`);
    return r.ok ? r.pages.map((n) => `${wsBase}/api/preview/${r.key}/${n}`) : null;
  } catch { return null; }
}

function bar(...kids) {
  const b = el('div', 'doc-bar');
  b.append(...kids);
  return b;
}

// ── Word / PowerPoint ───────────────────────────────────────────────────────
async function mountText(body, path, model) {
  const changes = new Map();   // `${part}#${i}` → { part, i, old, text }
  const pptx = model.kind === 'pptx';
  const wrap = el('div', 'doc-editor');
  const search = el('input', 'doc-search');
  search.type = 'search';
  search.placeholder = 'Find in the document…';
  const showEmpty = el('label', 'doc-check');
  const cb = el('input');
  cb.type = 'checkbox';
  showEmpty.append(cb, document.createTextNode(' empty paragraphs'));
  const count = el('span', 'doc-count');
  wrap.appendChild(bar(search, showEmpty, count));
  wrap.appendChild(el('div', 'doc-hint', pptx
    ? 'Change the text of each slide and its speaker notes. Layout, pictures and the template stay as they are — for new slides or a new layout, ask Claude.'
    : 'Change the text paragraph by paragraph (a new line is a line break). Styles, tables and pictures stay as they are — for new sections, ask Claude.'));
  const list = el('div', 'doc-parts');
  wrap.appendChild(list);
  body.appendChild(wrap);

  const rows = [];
  let lastShape = null;
  for (const part of model.parts) {
    const sec = el('section', `doc-part${part.kind === 'notes' ? ' doc-notes' : ''}`);
    const head = el('div', 'doc-part-head', part.label);
    sec.appendChild(head);
    if (part.kind === 'slide') {
      const img = el('img', 'doc-slide-img');
      img.alt = part.label;
      img.loading = 'lazy';
      img.dataset.page = String(part.page);
      sec.appendChild(img);
    }
    lastShape = null;
    for (const p of part.paragraphs) {
      if (pptx && p.shape && p.shape !== lastShape) {
        const cap = el('div', 'doc-shape', p.shape);
        sec.appendChild(cap);
        lastShape = p.shape;
        rows.push({ cap, part, p: null });
      }
      const ta = el('textarea', `doc-para${p.hint ? ` doc-${p.hint}` : ''}${p.cell ? ' doc-cell' : ''}`);
      ta.value = p.text;
      ta.rows = 1;
      ta.spellcheck = true;
      if (p.style) ta.title = p.style;
      ta.addEventListener('input', () => {
        autoGrow(ta);
        const key = `${part.id}#${p.i}`;
        if (ta.value === p.text) changes.delete(key);
        else changes.set(key, { part: part.id, i: p.i, old: p.text, text: ta.value });
        ta.classList.toggle('doc-changed', ta.value !== p.text);
        count.textContent = changes.size ? `${changes.size} changed` : '';
      });
      ta.addEventListener('keydown', (e) => e.stopPropagation());
      sec.appendChild(ta);
      rows.push({ ta, part, p });
    }
    list.appendChild(sec);
  }

  function filter() {
    const q = search.value.trim().toLowerCase();
    for (const r of rows) {
      if (!r.p) continue;
      const empty = !r.ta.value.trim() && !r.p.text.trim();
      const hit = !q || r.ta.value.toLowerCase().includes(q);
      r.ta.classList.toggle('hidden', !hit || (empty && !cb.checked && !(pptx && r.part.paragraphs.every((x) => !x.text.trim()))));
    }
    for (const sec of list.children) {
      const any = [...sec.querySelectorAll('textarea')].some((t) => !t.classList.contains('hidden'));
      sec.classList.toggle('hidden', !!q && !any);
    }
    requestAnimationFrame(() => rows.forEach((r) => r.ta && !r.ta.classList.contains('hidden') && autoGrow(r.ta)));
  }
  search.addEventListener('input', filter);
  search.addEventListener('keydown', (e) => e.stopPropagation());
  cb.addEventListener('change', filter);
  filter();

  if (pptx) {
    pageImages(path).then((pages) => {
      if (!pages) return;
      for (const img of list.querySelectorAll('img.doc-slide-img')) {
        const src = pages[Number(img.dataset.page) - 1];
        if (src) img.src = src; else img.remove();
      }
    });
  }

  return {
    dirty: () => changes.size > 0,
    save: (force) => postDoc({ path, mtime: model.mtime, force, edits: [...changes.values()] }),
  };
}

// ── Excel ───────────────────────────────────────────────────────────────────
const colName = (n) => { let s = ''; for (n += 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };

async function mountSheet(body, path, model) {
  const changes = new Map();   // `${sheet}!${ref}` → { sheet, ref, value }
  const wrap = el('div', 'doc-editor doc-xlsx');
  const tabs = el('div', 'doc-tabs');
  const ref = el('span', 'doc-ref');
  const formula = el('input', 'doc-formula');
  formula.placeholder = 'Value, or =formula';
  const count = el('span', 'doc-count');
  wrap.append(tabs, bar(ref, formula, count));
  wrap.appendChild(el('div', 'doc-hint', 'Type a value or a formula (=SUM(B2:B9)). Formulas are recalculated when the file is opened in Excel; formatting and charts stay as they are.'));
  const gridWrap = el('div', 'doc-grid-wrap');
  wrap.appendChild(gridWrap);
  body.appendChild(wrap);
  let active = null;   // the focused td

  const sheets = model.sheets.filter((s) => !s.hidden);
  const raw = (s, r, c) => {
    const k = `${s.id}!${colName(c)}${r + 1}`;
    if (changes.has(k)) return changes.get(k).value;
    const cell = s.rows[r]?.[c];
    return cell ? (cell.f != null ? `=${cell.f}` : cell.v) : '';
  };
  const shown = (s, r, c) => {
    const k = `${s.id}!${colName(c)}${r + 1}`;
    if (changes.has(k)) return changes.get(k).value;
    return s.rows[r]?.[c]?.v ?? '';
  };

  function setValue(s, td, value) {
    const r = Number(td.dataset.r), c = Number(td.dataset.c);
    const k = `${s.id}!${colName(c)}${r + 1}`;
    const cell = s.rows[r]?.[c];
    const orig = cell ? (cell.f != null ? `=${cell.f}` : cell.v) : '';
    if (value === orig) changes.delete(k); else changes.set(k, { sheet: s.id, ref: `${colName(c)}${r + 1}`, value });
    td.classList.toggle('doc-changed', changes.has(k));
    count.textContent = changes.size ? `${changes.size} changed` : '';
  }

  function show(s) {
    for (const t of tabs.children) t.classList.toggle('active', t.dataset.id === s.id);
    gridWrap.innerHTML = '';
    const nr = Math.min(model.maxRows, Math.max(s.maxRow + 10, 30));
    const nc = Math.min(model.maxCols, Math.max(s.maxCol + 3, 8));
    const table = el('table', 'doc-grid');
    const hr = el('tr');
    hr.appendChild(el('th', 'doc-corner'));
    for (let c = 0; c < nc; c++) hr.appendChild(el('th', null, colName(c)));
    table.appendChild(hr);
    for (let r = 0; r < nr; r++) {
      const tr = el('tr');
      tr.appendChild(el('th', null, String(r + 1)));
      for (let c = 0; c < nc; c++) {
        const td = el('td', null, shown(s, r, c));
        td.dataset.r = String(r);
        td.dataset.c = String(c);
        if (s.rows[r]?.[c]?.f != null) td.classList.add('doc-has-f');
        if (changes.has(`${s.id}!${colName(c)}${r + 1}`)) td.classList.add('doc-changed');
        td.tabIndex = 0;
        tr.appendChild(td);
      }
      table.appendChild(tr);
    }
    const focusCell = (td) => {
      active = td;
      ref.textContent = `${colName(Number(td.dataset.c))}${Number(td.dataset.r) + 1}`;
      formula.value = raw(s, Number(td.dataset.r), Number(td.dataset.c));
      table.querySelectorAll('td.doc-active').forEach((x) => x.classList.remove('doc-active'));
      td.classList.add('doc-active');
    };
    const startCellEdit = (td, initial = null) => {
      focusCell(td);
      td.contentEditable = 'true';
      td.textContent = initial ?? raw(s, Number(td.dataset.r), Number(td.dataset.c));
      td.focus();
      const range = document.createRange();
      range.selectNodeContents(td);
      range.collapse(false);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    };
    const endCellEdit = (td, commit) => {
      if (td.contentEditable !== 'true') return;
      td.contentEditable = 'false';
      if (commit) setValue(s, td, td.textContent);
      td.textContent = shown(s, Number(td.dataset.r), Number(td.dataset.c));
      formula.value = raw(s, Number(td.dataset.r), Number(td.dataset.c));
    };
    const move = (td, dr, dc) => {
      const r = Number(td.dataset.r) + dr, c = Number(td.dataset.c) + dc;
      const next = table.querySelector(`td[data-r="${r}"][data-c="${c}"]`);
      if (next) { focusCell(next); next.focus(); }
    };
    table.addEventListener('click', (e) => { const td = e.target.closest('td'); if (td) { focusCell(td); td.focus(); } });
    table.addEventListener('dblclick', (e) => { const td = e.target.closest('td'); if (td) startCellEdit(td); });
    table.addEventListener('focusout', (e) => { const td = e.target.closest?.('td'); if (td) endCellEdit(td, true); });
    table.addEventListener('keydown', (e) => {
      const td = e.target.closest('td');
      if (!td) return;
      e.stopPropagation();
      const editingCell = td.contentEditable === 'true';
      if (e.key === 'Enter') { e.preventDefault(); if (editingCell) { endCellEdit(td, true); move(td, 1, 0); } else startCellEdit(td); }
      else if (e.key === 'Tab') { e.preventDefault(); endCellEdit(td, true); move(td, 0, e.shiftKey ? -1 : 1); }
      else if (e.key === 'Escape' && editingCell) { e.preventDefault(); endCellEdit(td, false); td.focus(); }
      else if (!editingCell) {
        const arrows = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
        if (arrows[e.key]) { e.preventDefault(); move(td, ...arrows[e.key]); }
        else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); setValue(s, td, ''); td.textContent = ''; formula.value = ''; }
        else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) { e.preventDefault(); startCellEdit(td, e.key); }
      }
    });
    formula.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && active) {
        e.preventDefault();
        setValue(s, active, formula.value);
        active.textContent = shown(s, Number(active.dataset.r), Number(active.dataset.c));
        move(active, 1, 0);
      }
    };
    formula.onchange = () => { if (active) { setValue(s, active, formula.value); active.textContent = shown(s, Number(active.dataset.r), Number(active.dataset.c)); } };
    gridWrap.appendChild(table);
    const cut = s.maxRow > model.maxRows || s.maxCol > model.maxCols;
    if (cut) gridWrap.appendChild(el('div', 'doc-hint', `This sheet is larger than ${model.maxRows} rows × ${model.maxCols} columns — only that part is shown.`));
  }
  for (const s of sheets) {
    const t = btn(s.label, `Sheet ${s.label}`, () => show(s), 'doc-tab');
    t.dataset.id = s.id;
    tabs.appendChild(t);
  }
  if (sheets.length) show(sheets[0]);

  return {
    dirty: () => changes.size > 0,
    save: (force) => {
      active?.blur();
      return postDoc({ path, mtime: model.mtime, force, edits: [...changes.values()] });
    },
  };
}

// ── PDF pages ───────────────────────────────────────────────────────────────
async function mountPdf(body, path, model) {
  const wrap = el('div', 'doc-editor');
  wrap.appendChild(el('div', 'doc-hint', 'Reorder pages with ← →, remove one with ✕. To change the text of a PDF, edit the document it came from (often a .docx next to it) or ask Claude.'));
  const grid = el('div', 'doc-pages');
  wrap.appendChild(grid);
  body.appendChild(wrap);
  const pages = await pageImages(path);
  if (!pages) { grid.appendChild(el('div', 'doc-hint', 'The pages could not be rendered here.')); return { dirty: () => false, save: async () => ({ ok: true }) }; }
  if (pages.length < model.pages) {
    grid.appendChild(el('div', 'doc-hint', `Page editing works for PDFs up to ${pages.length} pages; this one has ${model.pages}.`));
    return { dirty: () => false, save: async () => ({ ok: true }) };
  }
  let order = pages.map((_, i) => i + 1);
  const removed = new Set();
  function draw() {
    grid.innerHTML = '';
    order.forEach((n, pos) => {
      const card = el('figure', `doc-page${removed.has(n) ? ' doc-removed' : ''}`);
      const img = el('img');
      img.src = pages[n - 1];
      img.alt = `Page ${n}`;
      img.loading = 'lazy';
      const cap = el('figcaption', null, `${pos + 1}${n !== pos + 1 ? ` (was ${n})` : ''}`);
      const tools = el('div', 'doc-page-tools');
      tools.append(
        btn('←', 'Move earlier', () => { if (pos > 0) { [order[pos - 1], order[pos]] = [order[pos], order[pos - 1]]; draw(); } }),
        btn('→', 'Move later', () => { if (pos < order.length - 1) { [order[pos + 1], order[pos]] = [order[pos], order[pos + 1]]; draw(); } }),
        removed.has(n) ? btn('↺', 'Keep this page', () => { removed.delete(n); draw(); }) : btn('✕', 'Remove this page', () => { removed.add(n); draw(); }),
      );
      card.append(img, cap, tools);
      grid.appendChild(card);
    });
  }
  draw();
  const final = () => order.filter((n) => !removed.has(n));
  return {
    dirty: () => removed.size > 0 || order.some((n, i) => n !== i + 1),
    save: (force) => {
      if (!final().length) return Promise.resolve({ ok: false, error: 'A PDF needs at least one page.' });
      return postDoc({ path, mtime: model.mtime, force, order: final() });
    },
  };
}

// ── Images ──────────────────────────────────────────────────────────────────
export async function mountImage(body, path, url, getMtime) {
  const wrap = el('div', 'doc-editor doc-image');
  const color = el('input');
  color.type = 'color';
  color.value = '#ff3b30';
  color.title = 'Pen colour';
  const size = el('input');
  size.type = 'range'; size.min = '1'; size.max = '40'; size.value = '5';
  size.title = 'Pen size';
  const scale = el('input', 'doc-scale');
  scale.type = 'number'; scale.min = '5'; scale.max = '400'; scale.value = '100';
  scale.title = 'Resize (%)';
  const info = el('span', 'doc-count');
  let tool = 'none';
  const toolBtns = {};
  const setTool = (t) => {
    tool = tool === t ? 'none' : t;
    for (const [k, b] of Object.entries(toolBtns)) b.classList.toggle('active', k === tool);
    applyCrop.classList.toggle('hidden', tool !== 'crop');
    sel = null;
    redrawOverlay();
  };
  toolBtns.pen = btn('✎ Draw', 'Draw on the picture', () => setTool('pen'));
  toolBtns.crop = btn('✂ Crop', 'Drag a rectangle, then Apply', () => setTool('crop'));
  const applyCrop = btn('Apply crop', 'Crop to the rectangle', () => doCrop(), 'doc-btn doc-primary hidden');
  wrap.appendChild(bar(
    btn('⟲', 'Rotate left', () => rotate(-1)), btn('⟳', 'Rotate right', () => rotate(1)),
    btn('⇋', 'Flip horizontally', () => flip(true)), btn('⇵', 'Flip vertically', () => flip(false)),
    toolBtns.crop, applyCrop, toolBtns.pen, color, size,
    el('span', 'doc-sep', 'Size %'), scale, btn('Resize', 'Resize to this percentage', () => resize()),
    btn('↶ Undo', 'Undo', () => undo()), info,
  ));
  const stage = el('div', 'doc-stage');
  const canvas = el('canvas', 'doc-canvas');
  const overlay = el('canvas', 'doc-overlay');
  stage.append(canvas, overlay);
  wrap.appendChild(stage);
  body.appendChild(wrap);

  const img = new Image();
  await new Promise((ok, ko) => { img.onload = ok; img.onerror = () => ko(new Error('Could not load the picture')); img.src = url; });
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const history = [];
  let changed = false;
  const snapshot = () => {
    const c = document.createElement('canvas');
    c.width = canvas.width; c.height = canvas.height;
    c.getContext('2d').drawImage(canvas, 0, 0);
    history.push(c);
    if (history.length > 20) history.shift();
    changed = true;
  };
  const replaceWith = (w, h, paint) => {
    snapshot();
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    paint(c.getContext('2d'), history[history.length - 1]);
    canvas.width = w; canvas.height = h;
    ctx.drawImage(c, 0, 0);
    sizeOverlay();
  };
  const showInfo = () => { info.textContent = `${canvas.width} × ${canvas.height}px`; };
  function rotate(dir) {
    const w = canvas.width, h = canvas.height;
    replaceWith(h, w, (c, src) => { c.translate(dir > 0 ? h : 0, dir > 0 ? 0 : w); c.rotate(dir * Math.PI / 2); c.drawImage(src, 0, 0); });
    showInfo();
  }
  function flip(horizontal) {
    const w = canvas.width, h = canvas.height;
    replaceWith(w, h, (c, src) => { c.translate(horizontal ? w : 0, horizontal ? 0 : h); c.scale(horizontal ? -1 : 1, horizontal ? 1 : -1); c.drawImage(src, 0, 0); });
  }
  function resize() {
    const k = Math.max(5, Math.min(400, Number(scale.value) || 100)) / 100;
    if (k === 1) return;
    const w = Math.max(1, Math.round(canvas.width * k)), h = Math.max(1, Math.round(canvas.height * k));
    replaceWith(w, h, (c, src) => { c.imageSmoothingQuality = 'high'; c.drawImage(src, 0, 0, w, h); });
    scale.value = '100';
    showInfo();
  }
  function undo() {
    const prev = history.pop();
    if (!prev) return;
    canvas.width = prev.width; canvas.height = prev.height;
    ctx.drawImage(prev, 0, 0);
    changed = history.length > 0;
    sizeOverlay();
    showInfo();
  }
  // pointer → canvas pixels
  const at = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) * (canvas.width / r.width), y: (e.clientY - r.top) * (canvas.height / r.height) };
  };
  let sel = null, drawing = null;
  const octx = overlay.getContext('2d');
  function sizeOverlay() { overlay.width = canvas.width; overlay.height = canvas.height; redrawOverlay(); }
  function redrawOverlay() {
    octx.clearRect(0, 0, overlay.width, overlay.height);
    if (!sel) return;
    const { x, y, w, h } = norm(sel);
    octx.fillStyle = 'rgba(0,0,0,.45)';
    octx.fillRect(0, 0, overlay.width, overlay.height);
    octx.clearRect(x, y, w, h);
    octx.strokeStyle = '#2dd4bf';
    octx.lineWidth = Math.max(2, canvas.width / 400);
    octx.strokeRect(x, y, w, h);
  }
  const norm = (s) => ({ x: Math.min(s.x0, s.x1), y: Math.min(s.y0, s.y1), w: Math.abs(s.x1 - s.x0), h: Math.abs(s.y1 - s.y0) });
  function doCrop() {
    if (!sel) return;
    const { x, y, w, h } = norm(sel);
    if (w < 2 || h < 2) return;
    replaceWith(Math.round(w), Math.round(h), (c, src) => c.drawImage(src, -Math.round(x), -Math.round(y)));
    setTool('crop');
    showInfo();
  }
  overlay.addEventListener('pointerdown', (e) => {
    if (tool === 'none') return;
    overlay.setPointerCapture(e.pointerId);
    const p = at(e);
    if (tool === 'crop') { sel = { x0: p.x, y0: p.y, x1: p.x, y1: p.y }; redrawOverlay(); }
    if (tool === 'pen') {
      snapshot();
      drawing = p;
      ctx.strokeStyle = color.value;
      ctx.lineWidth = Number(size.value) * Math.max(1, canvas.width / 1000);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
    }
  });
  overlay.addEventListener('pointermove', (e) => {
    const p = at(e);
    if (tool === 'crop' && sel && e.buttons) { sel.x1 = p.x; sel.y1 = p.y; redrawOverlay(); }
    if (tool === 'pen' && drawing) { ctx.beginPath(); ctx.moveTo(drawing.x, drawing.y); ctx.lineTo(p.x, p.y); ctx.stroke(); drawing = p; }
  });
  overlay.addEventListener('pointerup', () => { drawing = null; });
  sizeOverlay();
  showInfo();

  const ext = path.split('.').pop().toLowerCase();
  const type = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
  return {
    dirty: () => changed,
    save: async (force) => {
      const blob = await new Promise((ok) => canvas.toBlob(ok, type, 0.92));
      const q = `path=${encodeURIComponent(path)}&mtime=${getMtime() || ''}${force ? '&force=1' : ''}`;
      return getJson(`${wsBase}/api/workspace-binary?${q}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: blob });
    },
  };
}

// ── CSV / TSV ───────────────────────────────────────────────────────────────
export function toDelimited(rows, delim = ',') {
  const q = (v) => (/["\r\n]/.test(v) || v.includes(delim) ? `"${v.replace(/"/g, '""')}"` : v);
  return rows.map((r) => r.map((v) => q(String(v ?? ''))).join(delim)).join('\n') + '\n';
}

export function mountCsv(body, text, delim, parse, onTextMode) {
  let rows = parse(text, delim);
  if (rows.length && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === '') rows.pop();
  const original = toDelimited(rows, delim);
  const wrap = el('div', 'doc-editor');
  wrap.appendChild(bar(
    btn('+ Row', 'Add a row at the end', () => { rows.push(new Array(width()).fill('')); draw(); }),
    btn('+ Column', 'Add a column at the end', () => { rows.forEach((r) => r.push('')); if (!rows.length) rows.push(['']); draw(); }),
    btn('Edit as text', 'Switch to the text editor', () => onTextMode(toDelimited(rows, delim))),
  ));
  const gridWrap = el('div', 'doc-grid-wrap');
  wrap.appendChild(gridWrap);
  body.appendChild(wrap);
  const width = () => Math.max(1, ...rows.map((r) => r.length));
  function draw() {
    gridWrap.innerHTML = '';
    const table = el('table', 'doc-grid');
    const w = width();
    rows.forEach((r, i) => {
      const tr = el('tr');
      const th = el('th', null, String(i + 1));
      th.appendChild(btn('✕', 'Delete this row', () => { rows.splice(i, 1); draw(); }, 'doc-row-del'));
      tr.appendChild(th);
      for (let c = 0; c < w; c++) {
        const td = el('td', null, r[c] ?? '');
        td.contentEditable = 'true';
        td.addEventListener('input', () => { r[c] = td.textContent; });
        td.addEventListener('keydown', (e) => e.stopPropagation());
        tr.appendChild(td);
      }
      table.appendChild(tr);
    });
    gridWrap.appendChild(table);
  }
  draw();
  return { dirty: () => toDelimited(rows, delim) !== original, text: () => toDelimited(rows, delim) };
}

// ── Entry point for the office kinds ───────────────────────────────────────
export async function mountDocEditor(body, path) {
  const model = await getJson(`${wsBase}/api/doc?path=${encodeURIComponent(path)}`);
  if (!model.ok) throw new Error(model.error || 'Could not open the document');
  if (model.kind === 'xlsx') return mountSheet(body, path, model);
  if (model.kind === 'pdf') return mountPdf(body, path, model);
  return mountText(body, path, model);
}
