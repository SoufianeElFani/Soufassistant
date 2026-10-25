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
 *   pdf               the browser's own viewer
 *   csv / tsv         a table (first 500 rows)
 *   text-like         <pre>
 *   anything else     "no preview" + download
 *
 * After every reply the server pushes the workspace listing ('workspace');
 * files written since the prompt was sent get an "Artifacts" card in the
 * transcript, and the newest previewable one opens automatically.
 */
import { S } from './state.js';
import {
  wsBase, messagesEl, artifactPane, artifactTitle, artifactBody, artifactOpen,
  artifactDownload, artifactReload, artifactClose,
} from './dom.js';

const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico']);
const TEXT = new Set(['txt', 'json', 'yaml', 'yml', 'log', 'js', 'mjs', 'cjs', 'ts', 'py', 'sh', 'css',
  'xml', 'ini', 'conf', 'toml', 'sql', 'java', 'c', 'cpp', 'h', 'go', 'rs', 'rb', 'php', 'vue', 'jsx', 'tsx']);
const MAX_TEXT = 512 * 1024;

export function kindOf(ext) {
  const e = String(ext || '').toLowerCase();
  if (e === 'html' || e === 'htm') return 'html';
  if (e === 'md' || e === 'markdown') return 'markdown';
  if (IMAGE.has(e)) return 'image';
  if (e === 'pdf') return 'pdf';
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

let current = null;   // { path, ext }

function sandboxFrame(attrs) {
  const f = document.createElement('iframe');
  f.className = 'artifact-frame';
  for (const [k, v] of Object.entries(attrs)) f.setAttribute(k, v);
  return f;
}

async function fetchText(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n\n… (truncated)` : text;
}

function note(text) {
  const d = document.createElement('div');
  d.className = 'artifact-note';
  d.textContent = text;
  return d;
}

async function render() {
  if (!current) return;
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
      artifactBody.appendChild(sandboxFrame({ src: bust, title: path }));
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

export function openArtifact(path, ext) {
  current = { path, ext: ext || path.split('.').pop() };
  artifactPane.classList.remove('hidden');
  document.body.classList.add('artifact-open');
  render();
}

export function closeArtifact() {
  current = null;
  artifactPane.classList.add('hidden');
  document.body.classList.remove('artifact-open');
  artifactBody.innerHTML = '';
}

artifactClose.onclick = closeArtifact;
artifactReload.onclick = () => render();
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && current && !document.querySelector('.permission-overlay:not(.hidden)')) closeArtifact();
});

// ── "Artifacts from this reply" ────────────────────────────────────────────
const announced = new Set();   // `${path}@${mtime}` already shown in a card

function artifactCard(files) {
  const card = document.createElement('div');
  card.className = 'artifact-card';
  const head = document.createElement('div');
  head.className = 'artifact-card-head';
  head.textContent = files.length === 1 ? 'Artifact' : `Artifacts (${files.length})`;
  card.appendChild(head);
  for (const f of files) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'artifact-chip';
    b.title = `Open ${f.path}`;
    b.textContent = `${isPreviewable(f.ext) ? '▶' : '⇩'} ${f.path}`;
    b.onclick = () => (isPreviewable(f.ext) ? openArtifact(f.path, f.ext) : window.open(fileUrl(f.path), '_blank', 'noopener'));
    card.appendChild(b);
  }
  return card;
}

/** Called with every fresh workspace listing; surfaces what the last reply wrote. */
export function noteWorkspaceEntries(entries) {
  if (!S.runStartedAt || !Array.isArray(entries)) return;
  const since = S.runStartedAt - 1500;
  const fresh = entries
    .filter((e) => e.mtime >= since && !announced.has(`${e.path}@${e.mtime}`))
    .filter((e) => !/\.conflict\d*/i.test(e.name))
    .slice(0, 12);
  if (!fresh.length) return;
  for (const f of fresh) announced.add(`${f.path}@${f.mtime}`);
  messagesEl.appendChild(artifactCard(fresh));
  messagesEl.scrollTop = messagesEl.scrollHeight;
  if (localStorage.getItem('autoOpenArtifacts') !== 'off') {
    const first = fresh.find((f) => isPreviewable(f.ext));
    if (first) openArtifact(first.path, first.ext);
  }
}
