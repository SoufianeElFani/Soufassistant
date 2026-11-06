/*
 * The artifact viewer — a workspace file previewed in a pane next to the chat,
 * this app's local take on claude.ai's Artifacts (no hosted URL: the file
 * lives in the workspace, and so in the user's synced drive too).
 *
 * How each kind is shown:
 *   html/htm          sandboxed iframe (scripts allowed, *no* allow-same-origin:
 *                     the page gets an opaque origin, so it cannot reach this
 *                     app, its cookies or its WebSocket)
 *   md / markdown     rendered with marked into a script-less sandboxed iframe
 *   png jpg gif webp svg   <img> (an SVG in <img> cannot run script)
 *   pdf               the browser's own viewer where there is one, else page
 *                     images rendered by the server (doc-preview.js)
 *   pptx docx xlsx …  page images: LibreOffice → PDF → PNG on the server
 *   csv / tsv         a table (first 500 rows)
 *   text-like         <pre>
 *   anything else     "no preview" + download
 *
 * ✎ edits it in place: text formats in a text editor (Markdown, HTML and SVG
 * with a live preview beside it), CSV as a grid, and through doc-editor.js
 * Word / PowerPoint text, Excel cells, PDF pages and pictures. ✨ hands the
 * file to Claude instead (the prompt box, pre-filled). On a wide screen the
 * pane's left edge drags to resize it (kept in localStorage).
 *
 * After every reply the server says which workspace files it produced
 * ('turn_artifacts'): they get an "Artifacts" card in the transcript, the
 * newest previewable one opens automatically, and they join the conversation's
 * Artifacts menu. The server remembers them per conversation, so the cards and
 * the menu come back with the history ('history'.artifacts) after a reload.
 */
import { registerPanel, closeAllPanels } from './panels.js';
import { S } from './state.js';
import {
  wsBase, messagesEl, artifactPane, artifactTitle, artifactBody, artifactOpen,
  artifactDownload, artifactReload, artifactClose, artifactEdit, artifactSave, artifactCancel, artifactDelete,
  artifactSwitch, artifactsBtn, artifactsMenu, artifactsMenuList, artifactAsk, artifactShare, artifactResizer, promptInput, inputForm,
} from './dom.js';
import { confirmAction } from './confirm.js';
import { isDocEditable, isImageEditable, mountDocEditor, mountImage, mountCsv } from './doc-editor.js';

const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico']);
const TEXT = new Set(['txt', 'json', 'yaml', 'yml', 'log', 'js', 'mjs', 'cjs', 'ts', 'py', 'sh', 'css',
  'xml', 'ini', 'conf', 'toml', 'sql', 'java', 'c', 'cpp', 'h', 'go', 'rs', 'rb', 'php', 'vue', 'jsx', 'tsx']);
const OFFICE = new Set(['pptx', 'ppt', 'pps', 'ppsx', 'odp', 'docx', 'doc', 'odt', 'rtf', 'xlsx', 'xls', 'ods']);
const MAX_TEXT = 512 * 1024;

export function kindOf(ext) {
  const e = String(ext || '').toLowerCase();
  if (e === 'html' || e === 'htm') return 'html';
  if (e === 'md' || e === 'markdown') return 'markdown';
  if (IMAGE.has(e)) return 'image';
  if (e === 'pdf') return 'pdf';
  if (OFFICE.has(e)) return 'document';
  if (e === 'csv' || e === 'tsv') return 'table';
  if (TEXT.has(e)) return 'text';
  return 'other';
}

export function isPreviewable(ext) { return kindOf(ext) !== 'other'; }

export function fileUrl(rel) {
  return `${wsBase}/workspace/${String(rel).split('/').map(encodeURIComponent).join('/')}`;
}

/** Minimal CSV/TSV parser (quotes, escaped quotes, CRLF). Exported for tests. */
export function parseDelimited(text, delim = ',') {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

let current = null;   // { path, ext } for a workspace file, or { preview: port }
// While the editor is open: { text, mtime } for the text editor; { grid, text,
// mtime } for the CSV grid; { doc, mtime } for doc-editor.js's editors.
let editing = null;
let renderSeq = 0;    // a slow document render must not land in a pane showing another file
let pdfAsPages = false;   // the PDF viewer's "Pages" toggle

/** The browser renders PDFs itself (desktop browsers; not Android's WebView). */
const nativePdf = () => navigator.pdfViewerEnabled === true;

/** Text formats the editor may change (mirrors server EDITABLE_EXT). */
const EDITABLE = new Set(['txt', 'md', 'markdown', 'html', 'htm', 'css', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx',
  'json', 'yaml', 'yml', 'csv', 'tsv', 'svg', 'xml', 'py', 'sh', 'ini', 'conf', 'toml', 'sql', 'log', 'env', 'vue']);
export function isEditableExt(ext) { return EDITABLE.has(String(ext || '').toLowerCase()); }

function send(msg) {
  if (S.ws && S.isConnected) S.ws.send(JSON.stringify(msg));
}

/** Anything ✎ can open: text, or one of doc-editor.js's kinds. */
export function canEditExt(ext) { return isEditableExt(ext) || isDocEditable(ext) || isImageEditable(ext); }

function setToolbar() {
  const file = !!current?.path;
  const canEdit = file && canEditExt(current.ext);
  artifactAsk.classList.toggle('hidden', !file || !!editing);
  artifactShare.classList.toggle('hidden', !file || !!editing);
  artifactEdit.classList.toggle('hidden', !canEdit || !!editing);
  artifactSave.classList.toggle('hidden', !editing);
  artifactCancel.classList.toggle('hidden', !editing);
  artifactDelete.classList.toggle('hidden', !file || !!editing);
  artifactDownload.classList.toggle('hidden', !file);
  artifactReload.classList.toggle('hidden', !!editing);
}

function sandboxFrame(attrs) {
  const f = document.createElement('iframe');
  f.className = 'artifact-frame';
  for (const [k, v] of Object.entries(attrs)) f.setAttribute(k, v);
  return f;
}

async function fetchText(url, { raw = false } = {}) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (raw) return text;
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n\n… (truncated)` : text;
}

function note(text) {
  const d = document.createElement('div');
  d.className = 'artifact-note';
  d.textContent = text;
  return d;
}

/**
 * A PDF or Office file as page images, rendered by the server. The first time
 * can take a while (LibreOffice on a small box), so say so meanwhile.
 */
async function renderPages(path, ext, seq) {
  const kind = kindOf(ext);
  const wait = note(kind === 'pdf' ? 'Rendering the pages…' : 'Converting the document… (the first time can take up to a minute)');
  wait.classList.add('artifact-loading');
  artifactBody.appendChild(wait);
  let r;
  try {
    const res = await fetch(`${wsBase}/api/preview?path=${encodeURIComponent(path)}`, { cache: 'no-store' });
    r = await res.json();
  } catch (e) { r = { ok: false, error: e.message }; }
  if (seq !== renderSeq) return;
  wait.remove();
  if (!r.ok) {
    if (kind === 'pdf') {
      artifactBody.appendChild(sandboxFrame({ src: `${fileUrl(path)}?t=${Date.now()}`, title: path }));
      return;
    }
    artifactBody.appendChild(note(`${r.unavailable ? 'Document previews are not available here' : 'Could not preview this document'}`
      + `${r.error ? ` (${r.error})` : ''} — use ⇩ to download it.`));
    return;
  }
  const wrap = document.createElement('div');
  wrap.className = 'artifact-pages';
  r.pages.forEach((name, i) => {
    const fig = document.createElement('figure');
    fig.className = 'artifact-page';
    const img = document.createElement('img');
    img.loading = i < 2 ? 'eager' : 'lazy';
    img.alt = `${path} — page ${i + 1}`;
    img.src = `${wsBase}/api/preview/${r.key}/${name}`;
    img.onclick = () => window.open(img.src, '_blank', 'noopener');
    const cap = document.createElement('figcaption');
    cap.textContent = `${i + 1} / ${r.total}`;
    fig.append(img, cap);
    wrap.appendChild(fig);
  });
  artifactBody.appendChild(wrap);
  if (r.total > r.pages.length) artifactBody.appendChild(note(`Showing the first ${r.pages.length} of ${r.total} pages.`));
  if (r.pdf) {
    const a = document.createElement('a');
    a.className = 'artifact-note artifact-pdf-link';
    a.href = `${wsBase}/api/preview/${r.key}/document.pdf`;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = 'Open as PDF ↗';
    artifactBody.appendChild(a);
  }
}

function pdfToggle(asPages) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'artifact-mini-btn';
  b.textContent = asPages ? 'Browser viewer' : 'Pages';
  b.title = asPages ? "Show it in the browser's PDF viewer" : 'Show the pages as images';
  b.onclick = () => { pdfAsPages = !asPages; render(); };
  return b;
}

async function render() {
  if (!current) return;
  const seq = ++renderSeq;
  setToolbar();
  renderSwitch();
  if (current.browser) {
    const f = browserFrames.get(current.browser) || {};
    artifactTitle.textContent = `Live browser${f.title ? ` · ${f.title}` : ''}`;
    artifactTitle.title = f.url || '';
    artifactOpen.href = f.url || '#';
    artifactBody.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'browser-live';
    const bar = document.createElement('div');
    bar.className = 'browser-live-url';
    bar.textContent = f.url || 'Starting…';
    const img = document.createElement('img');
    img.className = 'browser-live-img';
    img.alt = 'What Claude sees in the browser';
    img.src = `${wsBase}/api/browser/frame?key=${encodeURIComponent(current.browser)}&t=${f.ts || Date.now()}`;
    wrap.append(bar, img);
    artifactBody.appendChild(wrap);
    return;
  }
  if (current.preview) {
    const url = `${wsBase}/preview/${current.preview}/`;
    artifactTitle.textContent = `Live preview · port ${current.preview}`;
    artifactTitle.title = url;
    artifactOpen.href = url;
    artifactBody.innerHTML = '';
    artifactBody.appendChild(sandboxFrame({
      src: url, sandbox: 'allow-scripts allow-forms allow-modals allow-popups allow-downloads', title: 'Live preview',
    }));
    return;
  }
  const { path, ext } = current;
  const url = fileUrl(path);
  const bust = `${url}?t=${Date.now()}`;
  artifactTitle.textContent = path;
  artifactTitle.title = path;
  artifactOpen.href = url;
  artifactDownload.href = url;
  artifactDownload.setAttribute('download', path.split('/').pop());
  artifactBody.innerHTML = '';
  const kind = kindOf(ext);
  try {
    if (kind === 'html') {
      artifactBody.appendChild(sandboxFrame({
        src: bust, sandbox: 'allow-scripts allow-forms allow-modals allow-popups allow-downloads', title: path,
      }));
    } else if (kind === 'image') {
      const img = document.createElement('img');
      img.className = 'artifact-image';
      img.alt = path;
      img.src = bust;
      artifactBody.appendChild(img);
    } else if (kind === 'pdf') {
      if (nativePdf() && !pdfAsPages) {
        artifactBody.appendChild(pdfToggle(false));
        artifactBody.appendChild(sandboxFrame({ src: bust, title: path }));
      } else {
        if (nativePdf()) artifactBody.appendChild(pdfToggle(true));
        await renderPages(path, ext, seq);
      }
    } else if (kind === 'document') {
      await renderPages(path, ext, seq);
    } else if (kind === 'markdown') {
      const md = await fetchText(bust);
      const html = window.marked ? window.marked.parse(md) : `<pre>${md.replace(/[&<]/g, (c) => (c === '&' ? '&amp;' : '&lt;'))}</pre>`;
      artifactBody.appendChild(sandboxFrame({
        sandbox: '', title: path,
        srcdoc: `<!doctype html><meta charset="utf-8"><style>body{font:15px/1.6 system-ui,sans-serif;max-width:820px;margin:24px auto;padding:0 20px;color:#1d2b2a}img{max-width:100%}pre{background:#f3f5f5;padding:10px;overflow:auto}table{border-collapse:collapse}td,th{border:1px solid #ccd;padding:4px 8px}</style>${html}`,
      }));
    } else if (kind === 'table') {
      const rows = parseDelimited(await fetchText(bust), ext === 'tsv' ? '\t' : ',');
      const wrap = document.createElement('div');
      wrap.className = 'artifact-table-wrap';
      const table = document.createElement('table');
      table.className = 'artifact-table';
      rows.slice(0, 500).forEach((r, i) => {
        const tr = document.createElement('tr');
        for (const cell of r) {
          const td = document.createElement(i === 0 ? 'th' : 'td');
          td.textContent = cell;
          tr.appendChild(td);
        }
        table.appendChild(tr);
      });
      wrap.appendChild(table);
      artifactBody.appendChild(wrap);
      if (rows.length > 500) artifactBody.appendChild(note(`Showing 500 of ${rows.length} rows.`));
    } else if (kind === 'text') {
      const pre = document.createElement('pre');
      pre.className = 'artifact-text';
      pre.textContent = await fetchText(bust);
      artifactBody.appendChild(pre);
    } else {
      artifactBody.appendChild(note('No preview for this kind of file — use ↗ to open it or ⇩ to download it.'));
    }
  } catch (e) {
    artifactBody.appendChild(note(`Could not load ${path}: ${e.message}`));
  }
}

export function openArtifact(path, ext, { edit = false } = {}) {
  if (editing && !confirmLeaveEdit()) return;
  closeAllPanels();
  editing = null;
  current = { path, ext: ext || path.split('.').pop() };
  artifactPane.classList.remove('hidden');
  document.body.classList.add('artifact-open');
  render().then(() => { if (edit) startEdit(); });
}

// ── The browser agent's live view (browser.js: 'browser_frame') ───────────
const browserFrames = new Map();   // run key → { url, title, ts }
const browserOpened = new Set();   // keys whose view opened by itself once

export function openBrowserView(key) {
  if (editing && !confirmLeaveEdit()) return;
  closeAllPanels();
  editing = null;
  current = { browser: key };
  artifactPane.classList.remove('hidden');
  document.body.classList.add('artifact-open');
  render();
}

export function applyBrowserFrame(msg) {
  browserFrames.set(msg.key, { url: msg.url, title: msg.title, ts: msg.ts });
  if (current?.browser === msg.key) {
    const img = artifactBody.querySelector('img.browser-live-img');
    const bar = artifactBody.querySelector('.browser-live-url');
    if (img) img.src = `${wsBase}/api/browser/frame?key=${encodeURIComponent(msg.key)}&t=${msg.ts}`;
    if (bar) bar.textContent = msg.url || '';
    artifactTitle.textContent = `Live browser${msg.title ? ` · ${msg.title}` : ''}`;
    artifactOpen.href = msg.url || '#';
    return;
  }
  if (!browserOpened.has(msg.key) && !editing) {
    browserOpened.add(msg.key);
    if (localStorage.getItem('autoOpenArtifacts') !== 'off') openBrowserView(msg.key);
    const card = document.createElement('div');
    card.className = 'artifact-card';
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'artifact-chip';
    b.textContent = '🌐 Claude is using the browser — watch live';
    b.onclick = () => openBrowserView(msg.key);
    card.appendChild(b);
    messagesEl.appendChild(card);
  }
}

// ── Self-improvement: offer to keep a long task as a skill ───────────────
export function skillSuggestionCard(msg) {
  if (localStorage.getItem('suggestSkills') === 'off') return;
  const card = document.createElement('div');
  card.className = 'artifact-card skill-suggest';
  const head = document.createElement('div');
  head.className = 'artifact-card-head';
  head.textContent = 'Learn from this';
  const p = document.createElement('div');
  p.className = 'skill-suggest-text';
  p.textContent = `That took ${msg.steps} steps. Save how it was done as a skill, so next time it is faster and uses fewer tokens?`;
  const row = document.createElement('div');
  row.className = 'skill-suggest-actions';
  const yes = document.createElement('button');
  yes.type = 'button';
  yes.className = 'session-menu-btn';
  yes.textContent = '✦ Create a skill';
  yes.onclick = () => {
    card.remove();
    promptInput.value = 'Turn what you just did into a reusable skill: write ~/.claude/skills/<short-name>/SKILL.md '
      + '(front matter name + a precise description of when to use it, in my language), then the steps that worked, the '
      + 'pitfalls you hit and how you solved them, the commands/paths/files involved, and any helper script worth keeping '
      + '(in the skill folder). Keep it short and general enough to reuse; if a similar skill exists, improve it instead.';
    promptInput.dispatchEvent(new Event('input', { bubbles: true }));
    inputForm.requestSubmit();
  };
  const no = document.createElement('button');
  no.type = 'button';
  no.className = 'session-menu-btn';
  no.textContent = 'Not now';
  no.onclick = () => card.remove();
  row.append(yes, no);
  card.append(head, p, row);
  messagesEl.appendChild(card);
  if (S.stickToBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
}

/** A web app running in a Cowork project, through /preview/<port>/ (previews.js). */
export function openPreview(port) {
  if (editing && !confirmLeaveEdit()) return;
  closeAllPanels();
  editing = null;
  current = { preview: port };
  artifactPane.classList.remove('hidden');
  document.body.classList.add('artifact-open');
  render();
}

function isDirty() {
  if (!editing) return false;
  if (editing.doc) return editing.doc.dirty();
  if (editing.grid) return editing.grid.dirty();
  return editing.text !== editorEl()?.value;
}

function confirmLeaveEdit() {
  if (artifactSave.disabled && editing) { alert('Still saving — one moment.'); return false; }
  return !isDirty() || window.confirm('Discard your unsaved changes?');
}

function setSaving(on) {
  artifactSave.disabled = on;
  artifactSave.textContent = on ? 'Saving…' : 'Save';
}

export function closeArtifact() {
  if (editing && !confirmLeaveEdit()) return;
  editing = null;
  current = null;
  renderSeq++;
  artifactPane.classList.add('hidden');
  document.body.classList.remove('artifact-open');
  artifactBody.innerHTML = '';
}

// ── Editor ───────────────────────────────────────────────────────────────────
function editorEl() { return artifactBody.querySelector('textarea.artifact-editor'); }

const PREVIEWABLE_SOURCE = new Set(['md', 'markdown', 'html', 'htm', 'svg']);
const escHtml = (t) => t.replace(/[&<]/g, (c) => (c === '&' ? '&amp;' : '&lt;'));

/** The live preview beside the text editor, for Markdown, HTML and SVG. */
function sourcePreview(ext, text) {
  const e = ext.toLowerCase();
  if (e === 'md' || e === 'markdown') {
    const html = window.marked ? window.marked.parse(text) : `<pre>${escHtml(text)}</pre>`;
    return { sandbox: '', srcdoc: `<!doctype html><meta charset="utf-8"><style>body{font:15px/1.6 system-ui,sans-serif;margin:16px;color:#1d2b2a}img{max-width:100%}pre{background:#f3f5f5;padding:10px;overflow:auto}table{border-collapse:collapse}td,th{border:1px solid #ccd;padding:4px 8px}</style>${html}` };
  }
  const dir = current.path.includes('/') ? current.path.slice(0, current.path.lastIndexOf('/') + 1) : '';
  if (e === 'svg') return { sandbox: '', srcdoc: `<!doctype html><style>body{margin:0;display:grid;place-items:center;min-height:100vh}svg{max-width:100%;height:auto}</style>${text}` };
  // HTML: scripts run (no allow-same-origin — an opaque origin, as in the viewer); relative links resolve against the file
  const base = new URL(`${wsBase}/workspace/${dir.split('/').map(encodeURIComponent).join('/')}`, location.href).href;
  return { sandbox: 'allow-scripts allow-forms allow-modals', srcdoc: `<base href="${base}">${text}` };
}

function startTextEditor(text, original = text) {
  editing = { text: original, mtime: editing?.mtime ?? null };
  artifactBody.innerHTML = '';
  const ta = document.createElement('textarea');
  ta.className = 'artifact-editor';
  ta.spellcheck = false;
  ta.value = text;
  ta.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
    else if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault();
      const a = ta.selectionStart, b = ta.selectionEnd;
      ta.setRangeText('  ', a, b, 'end');
    }
    e.stopPropagation();
  });
  const ext = String(current.ext || '').toLowerCase();
  if (PREVIEWABLE_SOURCE.has(ext)) {
    // side by side: source | live preview (stacked on a narrow screen)
    const split = document.createElement('div');
    split.className = 'artifact-split';
    const frame = sandboxFrame({ title: 'Preview' });
    let timer = null;
    const refresh = () => {
      const p = sourcePreview(ext, ta.value);
      frame.setAttribute('sandbox', p.sandbox);
      frame.srcdoc = p.srcdoc;
    };
    ta.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(refresh, 350); });
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'artifact-mini-btn artifact-split-toggle';
    toggle.textContent = 'Preview';
    toggle.title = 'Show or hide the live preview';
    toggle.onclick = () => { split.classList.toggle('no-preview'); localStorage.setItem('editorPreview', split.classList.contains('no-preview') ? 'off' : 'on'); };
    if (localStorage.getItem('editorPreview') === 'off') split.classList.add('no-preview');
    split.append(ta, frame);
    artifactBody.append(toggle, split);
    refresh();
  } else {
    artifactBody.appendChild(ta);
  }
  setToolbar();
  renderSwitch();
  ta.focus();
}

async function startEdit() {
  if (!current?.path || !canEditExt(current.ext)) return;
  const path = current.path;
  const ext = String(current.ext || '').toLowerCase();
  // the mtime the save is checked against: asked once `editing` exists, so the answer has somewhere to land
  const stat = () => send({ type: 'workspace_stat', reqId: 'edit', path });
  if (isDocEditable(ext) || isImageEditable(ext)) {
    const seq = ++renderSeq;
    artifactBody.innerHTML = '';
    const wait = note(ext === 'pdf' || ext === 'pptx' ? 'Opening the editor… (the pages can take a moment)' : 'Opening the editor…');
    wait.classList.add('artifact-loading');
    artifactBody.appendChild(wait);
    editing = { doc: { dirty: () => false, save: async () => ({ ok: true }) }, mtime: null };
    stat();
    setToolbar();
    let handle;
    try {
      const holder = document.createElement('div');
      holder.className = 'artifact-doc-holder';
      handle = isImageEditable(ext)
        ? await mountImage(holder, path, `${fileUrl(path)}?t=${Date.now()}`, () => editing?.mtime)
        : await mountDocEditor(holder, path);
      if (seq !== renderSeq || current?.path !== path) return;
      artifactBody.innerHTML = '';
      artifactBody.appendChild(holder);
    } catch (e) {
      if (seq !== renderSeq) return;
      editing = null;
      alert(`Could not open the editor: ${e.message}`);
      render();
      return;
    }
    editing.doc = handle;
    setToolbar();
    renderSwitch();
    return;
  }
  let text;
  try { text = await fetchText(`${fileUrl(path)}?t=${Date.now()}`, { raw: true }); }
  catch (e) { alert(`Could not open ${path}: ${e.message}`); return; }
  if (ext === 'csv' || ext === 'tsv') {
    editing = { text, mtime: null };
    stat();
    artifactBody.innerHTML = '';
    const grid = mountCsv(artifactBody, text, ext === 'tsv' ? '\t' : ',', parseDelimited, (t) => startTextEditor(t, text));
    editing.grid = grid;
    setToolbar();
    renderSwitch();
    return;
  }
  editing = { text, mtime: null };
  stat();
  startTextEditor(text);
}

async function save(force = false) {
  if (!editing) return;
  if (editing.doc) {
    setSaving(true);
    let r;
    try { r = await editing.doc.save(force); } catch (e) { r = { ok: false, error: e.message }; }
    applyWriteResult({ reqId: 'edit', path: current?.path, ...r });
    return;
  }
  const content = editing.grid ? editing.grid.text() : editorEl()?.value;
  if (content == null) return;
  setSaving(true);
  send({ type: 'workspace_write', reqId: 'edit', path: current.path, content, mtime: editing.mtime, force });
}

export function applyWorkspaceStat(msg) {
  if (msg.reqId === 'edit' && editing && current?.path === msg.path) editing.mtime = msg.stat?.mtime || null;
}

export async function applyWriteResult(msg) {
  setSaving(false);
  if (msg.reqId === 'newfile') {
    if (msg.ok) openArtifact(msg.path, msg.path.split('.').pop(), { edit: true });
    else alert(msg.error || 'Could not create the file.');
    return;
  }
  if (msg.reqId !== 'edit' || !editing) return;
  if (msg.ok) {
    editing = null;
    render();
  } else if (msg.conflict) {
    const ok = await confirmAction({
      title: 'The file changed meanwhile',
      body: 'Claude or the Drive sync changed this file since you opened it. Overwrite it with your version?',
      confirm: 'Overwrite', cancel: 'Keep editing',
    });
    if (ok) save(true);
  } else {
    alert(msg.error || 'Could not save.');
  }
}

export function applyDeleteResult(msg) {
  if (!msg.ok) { alert(msg.error || 'Could not delete.'); return; }
  if (current?.path === msg.path) { editing = null; closeArtifact(); }
}

/** "+ File" in the Workspace panel. */
export function createFile(rel) {
  send({ type: 'workspace_write', reqId: 'newfile', path: rel, content: '', create: true });
}

artifactEdit.onclick = () => startEdit();
artifactSave.onclick = () => save();
artifactCancel.onclick = () => { if (confirmLeaveEdit()) { editing = null; render(); } };
artifactDelete.onclick = async () => {
  if (!current?.path) return;
  const ok = await confirmAction({ title: 'Delete this file?', body: current.path, confirm: 'Delete', cancel: 'Keep it' });
  if (ok) send({ type: 'workspace_delete', path: current.path });
};

// ✨ — hand the file to Claude: the prompt box, pre-filled with its path.
artifactShare.onclick = () => { if (current?.path) import('./hub.js').then((h) => h.shareFile(current.path)); };

artifactAsk.onclick = () => {
  if (!current?.path) return;
  const path = current.path;
  if (window.innerWidth < 1000) closeArtifact();   // the viewer covers the chat there
  const prefix = `In \`${path}\`: `;
  if (!promptInput.value.includes(path)) promptInput.value = prefix + promptInput.value;
  promptInput.focus();
  promptInput.setSelectionRange(promptInput.value.length, promptInput.value.length);
  promptInput.dispatchEvent(new Event('input', { bubbles: true }));
};

// ── Resizing the pane (wide screens) ───────────────────────────────────────
const MIN_PANE = 320, MIN_CHAT = 380;
function setPaneWidth(px, persist = false) {
  if (px == null) {
    document.documentElement.style.removeProperty('--artifact-w');
    if (persist) localStorage.removeItem('artifactWidth');
    return;
  }
  const w = Math.round(Math.max(MIN_PANE, Math.min(window.innerWidth - MIN_CHAT, px)));
  document.documentElement.style.setProperty('--artifact-w', `${w}px`);
  if (persist) localStorage.setItem('artifactWidth', String(w));
}
{
  const saved = Number(localStorage.getItem('artifactWidth'));
  if (saved) setPaneWidth(saved);
  window.addEventListener('resize', () => { const v = Number(localStorage.getItem('artifactWidth')); if (v) setPaneWidth(v); });
}
artifactResizer.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  artifactResizer.setPointerCapture(e.pointerId);
  document.body.classList.add('artifact-resizing');
  const move = (ev) => setPaneWidth(window.innerWidth - ev.clientX);
  const up = (ev) => {
    artifactResizer.removeEventListener('pointermove', move);
    artifactResizer.removeEventListener('pointerup', up);
    artifactResizer.removeEventListener('pointercancel', up);
    document.body.classList.remove('artifact-resizing');
    setPaneWidth(window.innerWidth - ev.clientX, true);
  };
  artifactResizer.addEventListener('pointermove', move);
  artifactResizer.addEventListener('pointerup', up);
  artifactResizer.addEventListener('pointercancel', up);
});
artifactResizer.addEventListener('dblclick', () => setPaneWidth(null, true));
artifactResizer.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  e.preventDefault();
  const cur = artifactPane.getBoundingClientRect().width;
  setPaneWidth(cur + (e.key === 'ArrowLeft' ? 40 : -40), true);
});

artifactClose.onclick = closeArtifact;
artifactReload.onclick = () => render();
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && current && !editing && !document.querySelector('.permission-overlay:not(.hidden)')) closeArtifact();
});

// ── Artifacts: per reply, and per conversation ─────────────────────────────
function openFile(f) {
  if (isPreviewable(f.ext)) openArtifact(f.path, f.ext);
  else window.open(fileUrl(f.path), '_blank', 'noopener');
}

const ICONS = { html: '🌐', markdown: '📝', image: '🖼', pdf: '📕', document: '📽', table: '📊', text: '🗒' };
export function iconFor(ext) {
  const e = String(ext || '').toLowerCase();
  if (e === 'docx' || e === 'doc' || e === 'odt' || e === 'rtf') return '📄';
  if (e === 'xlsx' || e === 'xls' || e === 'ods') return '📊';
  return ICONS[kindOf(e)] || '📎';
}

/** The "Artifacts" card a reply's files get in the transcript. */
export function artifactCard(files) {
  const card = document.createElement('div');
  card.className = 'artifact-card';
  const head = document.createElement('div');
  head.className = 'artifact-card-head';
  head.textContent = files.length === 1 ? 'Artifact' : `Artifacts (${files.length})`;
  card.appendChild(head);
  // Images show right in the chat (generated pictures above all — on a phone
  // the viewer is a full-screen step away); a tap opens the viewer.
  const images = files.filter((f) => kindOf(f.ext) === 'image');
  if (images.length) {
    const strip = document.createElement('div');
    strip.className = 'artifact-thumbs';
    for (const f of images.slice(0, 6)) {
      const img = document.createElement('img');
      img.className = 'artifact-thumb';
      img.loading = 'lazy';
      img.alt = f.path.split('/').pop();
      img.title = `Open ${f.path}`;
      img.src = `${fileUrl(f.path)}?v=${Math.round(f.mtime || f.ts || 0)}`;
      img.onclick = () => openFile(f);
      strip.appendChild(img);
    }
    card.appendChild(strip);
  }
  for (const f of files) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'artifact-chip';
    b.title = `Open ${f.path}`;
    b.textContent = `${isPreviewable(f.ext) ? iconFor(f.ext) : '⇩'} ${f.path}`;
    b.onclick = () => openFile(f);
    card.appendChild(b);
  }
  return card;
}

/** The conversation on screen changed (history replay): its artifacts. */
export function setConversationArtifacts(list) {
  S.artifacts = Array.isArray(list) ? list : [];
  renderArtifactsButton();
  if (!artifactsMenu.classList.contains('hidden')) renderArtifactsMenu();
  renderSwitch();
}

/** A reply just finished and wrote these files ('turn_artifacts'). */
export function applyTurnArtifacts(files) {
  if (!Array.isArray(files) || !files.length) return;
  const paths = new Set(files.map((f) => f.path));
  S.artifacts = S.artifacts.filter((f) => !paths.has(f.path)).concat(files);
  messagesEl.appendChild(artifactCard(files));
  if (S.stickToBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
  renderArtifactsButton();
  if (!artifactsMenu.classList.contains('hidden')) renderArtifactsMenu();
  renderSwitch();
  if (localStorage.getItem('autoOpenArtifacts') !== 'off') {
    const first = files.find((f) => isPreviewable(f.ext));
    if (first) openArtifact(first.path, first.ext);
  }
}

function renderArtifactsButton() {
  const n = S.artifacts.length;
  artifactsBtn.dataset.count = n ? String(n) : '';
  artifactsBtn.classList.toggle('has-count', n > 0);
  artifactsBtn.title = n ? `Artifacts of this conversation (${n})` : 'Artifacts';
}

/** The pane's own switcher: hop between this conversation's artifacts. */
function renderSwitch() {
  const list = S.artifacts.filter((f) => isPreviewable(f.ext));
  const show = !!current?.path && list.length > 1 && !editing;
  artifactSwitch.classList.toggle('hidden', !show);
  artifactTitle.classList.toggle('hidden', show);
  if (!show) return;
  artifactSwitch.innerHTML = '';
  const newest = list.slice().reverse();
  if (!newest.some((f) => f.path === current.path)) {
    artifactSwitch.add(new Option(current.path.split('/').pop(), current.path));
  }
  for (const f of newest) {
    const o = new Option(`${iconFor(f.ext)} ${f.path.split('/').pop()}`, f.path);
    o.title = f.path;
    artifactSwitch.add(o);
  }
  artifactSwitch.value = current.path;
}
artifactSwitch.addEventListener('change', () => {
  const f = S.artifacts.find((x) => x.path === artifactSwitch.value);
  if (f) openArtifact(f.path, f.ext);
});

function menuRow(f, sub) {
  const row = document.createElement('div');
  row.className = `session-item workspace-item${current?.path === f.path ? ' active' : ''}`;
  row.title = f.path;
  const icon = document.createElement('span');
  icon.className = 'task-icon';
  icon.textContent = iconFor(f.ext);
  const main = document.createElement('div');
  main.className = 'session-main';
  const t = document.createElement('div');
  t.className = 'session-title';
  t.textContent = f.path.split('/').pop();
  const d = document.createElement('div');
  d.className = 'session-time';
  d.textContent = sub;
  main.append(t, d);
  row.append(icon, main);
  row.onclick = () => { closeArtifactsMenu(); openFile(f); };
  return row;
}

function menuSection(title) {
  const h = document.createElement('div');
  h.className = 'usage-section-title artifacts-menu-section';
  h.textContent = title;
  return h;
}

function when(ms) {
  const d = new Date(ms);
  const today = new Date();
  return d.toDateString() === today.toDateString()
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

export function renderArtifactsMenu() {
  artifactsMenuList.innerHTML = '';
  const mine = S.artifacts.slice().reverse();
  artifactsMenuList.appendChild(menuSection('This conversation'));
  if (!mine.length) {
    const e = document.createElement('div');
    e.className = 'sessions-empty';
    e.textContent = 'No files from this conversation yet.';
    artifactsMenuList.appendChild(e);
  }
  for (const f of mine) artifactsMenuList.appendChild(menuRow(f, `${f.path} · ${when(f.ts || f.mtime)}`));
  const seen = new Set(mine.map((f) => f.path));
  const recent = (S.workspace || []).filter((f) => !seen.has(f.path) && !/\.conflict\d*/i.test(f.name)).slice(0, 8);
  if (recent.length) {
    artifactsMenuList.appendChild(menuSection('Recent in the workspace'));
    for (const f of recent) artifactsMenuList.appendChild(menuRow(f, `${f.path} · ${when(f.mtime)}`));
  }
}

export function openArtifactsMenu() {
  renderArtifactsMenu();
  artifactsMenu.classList.remove('hidden');
  artifactsBtn.classList.add('active');
}
export function closeArtifactsMenu() {
  artifactsMenu.classList.add('hidden');
  artifactsBtn.classList.remove('active');
}
artifactsBtn.onclick = (e) => {
  e.stopPropagation();
  if (artifactsMenu.classList.contains('hidden')) openArtifactsMenu();
  else closeArtifactsMenu();
};
document.addEventListener('click', (e) => {
  if (!e.target.isConnected || artifactsMenu.classList.contains('hidden')) return;
  if (artifactsMenu.contains(e.target) || artifactsBtn.contains(e.target)) return;
  closeArtifactsMenu();
});
renderArtifactsButton();

registerPanel(artifactsMenu, closeArtifactsMenu);
