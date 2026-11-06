/*
 * Shared links — a conversation or a workspace file published read-only, for
 * someone without access to Home Assistant's UI.
 *
 * Home Assistant serves <config>/www at /local/ to anyone who can reach it,
 * with no login. A share is a folder SHARE_DIR/<token>/ (an unguessable
 * 24-byte token) holding an index.html, so its link is
 *   <HA external URL>/local/soufassistant-share/<token>/
 * It works wherever Home Assistant is reachable (Nabu Casa, a VPN, the LAN);
 * revoking deletes the folder.
 *
 * That page is served from Home Assistant's own origin, so nothing in it may
 * run script there (it could read the HA login of whoever opens it):
 *   - Markdown is rendered with raw HTML escaped and only http(s)/mailto links
 *   - an HTML or SVG file is shown inside <iframe sandbox="allow-scripts">
 *     with srcdoc — an opaque origin, cut off from Home Assistant
 *   - PDFs, pictures and Office files are copied next to the page, which
 *     embeds or links them
 */
import { randomBytes } from 'crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import path from 'path';
import vm from 'vm';
import { FRONTEND_DIR, SHARE_DIR, SHARES_FILE, SUPERVISOR_URL } from './config.js';
import { writeFileAtomic } from './atomic.js';
import { log } from './log.js';

const MAX_FILE = 50 * 1024 * 1024;
let marked = null;

/** The frontend's own marked (UMD), loaded once into a sandbox — no new dependency. */
function markdown() {
  if (marked) return marked;
  const code = readFileSync(path.join(FRONTEND_DIR, 'marked.min.js'), 'utf8');
  const ctx = { module: { exports: {} }, exports: {} };
  ctx.exports = ctx.module.exports;
  vm.runInNewContext(code, ctx);
  marked = ctx.module.exports;
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const safeUrl = (u) => (/^(https?:|mailto:|#|\.{0,2}\/|[\w.-]+(\/|$))/i.test(String(u || '').trim()) && !/^\s*(javascript|data|vbscript):/i.test(u) ? u : '#');
  marked.use({
    renderer: {
      html: (t) => esc(typeof t === 'string' ? t : t.text),
      link(t) { return `<a href="${esc(safeUrl(t.href))}" rel="noopener nofollow">${this.parser.parseInline(t.tokens)}</a>`; },
      image: (t) => `<img src="${esc(safeUrl(t.href))}" alt="${esc(t.text || '')}">`,
    },
  });
  return marked;
}

export function renderMarkdownSafe(md) { return markdown().parse(String(md || '')); }

const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * A complete, script-free page. Pure. `csp: false` only for the sandboxed
 * iframe wrapper: a srcdoc frame inherits its parent's CSP, which would stop
 * the shared page's own scripts (they run in the frame's opaque origin).
 */
export function pageHtml(title, bodyHtml, { csp = true } = {}) {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
${csp ? `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src * data:; style-src 'unsafe-inline'; media-src 'self'; object-src 'self'">` : ''}
<title>${escHtml(title)}</title>
<style>body{font:16px/1.6 Arial,system-ui,sans-serif;max-width:860px;margin:0 auto;padding:24px 18px 60px;color:#1d2b2a;background:#fff}
h1{font-size:24px}h2{font-size:18px;margin-top:28px}img{max-width:100%}pre{background:#f3f5f5;padding:10px;overflow:auto}
table{border-collapse:collapse}td,th{border:1px solid #ccd;padding:4px 8px}blockquote{color:#55626b;border-left:3px solid #d5dedc;margin:0;padding-left:12px}
.frame{width:100%;height:80vh;border:1px solid #d5dedc;border-radius:6px}.foot{margin-top:40px;color:#8a9a97;font-size:12px}</style>
</head><body>${bodyHtml}<div class="foot">Partagé depuis Soufassistant · lecture seule</div></body></html>`;
}

function load() {
  try { return JSON.parse(readFileSync(SHARES_FILE, 'utf8')).shares || []; } catch { return []; }
}
function save(list) { writeFileAtomic(SHARES_FILE, JSON.stringify({ shares: list }, null, 2)); }

let baseUrl;
/** Home Assistant's external URL (else its internal one), for full links. */
export async function haBaseUrl() {
  if (baseUrl !== undefined) return baseUrl;
  baseUrl = '';
  if (!process.env.SUPERVISOR_TOKEN) return baseUrl;
  try {
    const r = await fetch(`${SUPERVISOR_URL}/core/api/config`, { headers: { Authorization: `Bearer ${process.env.SUPERVISOR_TOKEN}` } });
    const c = r.ok ? await r.json() : {};
    baseUrl = String(c.external_url || c.internal_url || '').replace(/\/+$/, '');
  } catch { baseUrl = ''; }
  return baseUrl;
}

async function withUrl(s) {
  return { ...s, url: `${await haBaseUrl()}/local/${path.basename(SHARE_DIR)}/${s.token}/` };
}
export async function listShares() { return Promise.all(load().map(withUrl)); }

function newShare(kind, title, source) {
  const token = randomBytes(24).toString('base64url');
  const dir = path.join(SHARE_DIR, token);
  mkdirSync(dir, { recursive: true });
  return { token, dir, entry: { token, kind, title: String(title).slice(0, 160), source, createdAt: Date.now() } };
}
async function commit(entry) {
  const list = load();
  list.unshift(entry);
  save(list);
  log('INFO', `share: published ${entry.kind} "${entry.title}"`);
  return { ok: true, share: await withUrl(entry) };
}

/** Publish a workspace file. `abs` is already resolved inside the workspace. */
export async function shareFile(abs, rel) {
  let st;
  try { st = statSync(abs); } catch { return { ok: false, error: 'File not found.' }; }
  if (!st.isFile()) return { ok: false, error: 'Not a file.' };
  if (st.size > MAX_FILE) return { ok: false, error: 'File too large to share (50 MB max).' };
  const name = path.basename(abs);
  const ext = path.extname(name).slice(1).toLowerCase();
  const { dir, entry } = newShare('file', name, rel);
  const fileLink = `<p><a href="${encodeURIComponent(name)}" download>⇩ ${escHtml(name)}</a></p>`;
  let body, csp = true;
  if (ext === 'md' || ext === 'markdown') {
    body = renderMarkdownSafe(readFileSync(abs, 'utf8'));
  } else if (ext === 'html' || ext === 'htm' || ext === 'svg') {
    const src = readFileSync(abs, 'utf8');
    body = `<h1>${escHtml(name)}</h1><iframe class="frame" sandbox="allow-scripts allow-forms allow-popups" srcdoc="${escHtml(src)}"></iframe>`;
    csp = false;
  } else {
    copyFileSync(abs, path.join(dir, name));
    if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) body = `<h1>${escHtml(name)}</h1><img src="${encodeURIComponent(name)}" alt="">${fileLink}`;
    else if (ext === 'pdf') body = `<h1>${escHtml(name)}</h1><object class="frame" data="${encodeURIComponent(name)}" type="application/pdf"></object>${fileLink}`;
    else body = `<h1>${escHtml(name)}</h1>${fileLink}`;
  }
  writeFileSync(path.join(dir, 'index.html'), pageHtml(name, body, { csp }));
  return commit(entry);
}

/** Publish a conversation (its Markdown transcript, rendered). */
export async function shareMarkdown(title, md, source) {
  const { dir, entry } = newShare('conversation', title, source);
  writeFileSync(path.join(dir, 'index.html'), pageHtml(title, renderMarkdownSafe(md)));
  return commit(entry);
}

export function revokeShare(token) {
  if (!/^[\w-]{20,64}$/.test(String(token))) return { ok: false, error: 'Bad token.' };
  rmSync(path.join(SHARE_DIR, token), { recursive: true, force: true });
  save(load().filter((s) => s.token !== token));
  return { ok: true };
}

export const shareDirExists = () => existsSync(path.dirname(SHARE_DIR));
