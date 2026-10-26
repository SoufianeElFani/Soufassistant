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
  artifactSwitch, artifactsBtn, artifactsMenu, artifactsMenuList,
} from './dom.js';
import { confirmAction } from './confirm.js';

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
let editing = null;   // { text, mtime } while the editor is open
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

function setToolbar() {
  const file = !!current?.path;
  const canEdit = file && isEditableExt(current.ext);
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

function confirmLeaveEdit() {
  return !editing || editing.text === editorEl()?.value || window.confirm('Discard your unsaved changes?');
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

async function startEdit() {
  if (!current?.path || !isEditableExt(current.ext)) return;
  let text;
  try { text = await fetchText(`${fileUrl(current.path)}?t=${Date.now()}`, { raw: true }); }
  catch (e) { alert(`Could not open ${current.path}: ${e.message}`); return; }
  editing = { text, mtime: null };
  send({ type: 'workspace_stat', reqId: 'edit', path: current.path });
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
  artifactBody.appendChild(ta);
  setToolbar();
  renderSwitch();
  ta.focus();
}

function save(force = false) {
  const ta = editorEl();
  if (!editing || !ta) return;
  artifactSave.disabled = true;
  send({ type: 'workspace_write', reqId: 'edit', path: current.path, content: ta.value, mtime: editing.mtime, force });
}

export function applyWorkspaceStat(msg) {
  if (msg.reqId === 'edit' && editing && current?.path === msg.path) editing.mtime = msg.stat?.mtime || null;
}

export async function applyWriteResult(msg) {
  artifactSave.disabled = false;
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
