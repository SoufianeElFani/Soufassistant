/*
 * Document previews for the artifact viewer: a PDF, or an Office document
 * (PowerPoint, Word, Excel, OpenDocument, RTF), shown as page images in the
 * side pane — no download, and it works where the browser has no PDF viewer of
 * its own (the Home Assistant companion app's WebView).
 *
 *   Office → PDF   LibreOffice, headless (`soffice --convert-to pdf`)
 *   PDF → PNGs     poppler (`pdftoppm`), longest side PAGE_PX, at most MAX_PAGES
 *
 * Both ship in the image (Dockerfile). Results are cached under
 * DATA_DIR/cache/previews/<hash of path + size + mtime>/, so reopening a file
 * is instant and an edited file gets a fresh render. Conversions run one at a
 * time — LibreOffice is heavy on a small box, and two at once share a profile.
 * Without the tools (a dev machine) previewDocument() says so and the viewer
 * falls back to the browser's own PDF viewer or a download.
 */
import { execFile } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, renameSync } from 'fs';
import path from 'path';
import { DATA_DIR } from './config.js';
import { log } from './log.js';
import { writeFileAtomic } from './atomic.js';

export const OFFICE_EXT = new Set(['pptx', 'ppt', 'pps', 'ppsx', 'odp', 'docx', 'doc', 'odt', 'rtf', 'xlsx', 'xls', 'ods']);
export const PREVIEW_EXT = new Set([...OFFICE_EXT, 'pdf']);

const CACHE_DIR = process.env.PREVIEW_CACHE_DIR || path.join(DATA_DIR, 'cache', 'previews');
const PROFILE_DIR = path.join(DATA_DIR, 'cache', 'lo-profile');
const MAX_PAGES = 60;
const PAGE_PX = 1400;
const KEEP_DIRS = 40;
const SOFFICE_TIMEOUT_MS = 240000;   // the first start on a Raspberry-class box is slow
const PDFTOPPM_TIMEOUT_MS = 180000;

function run(cmd, args, timeout, env = process.env) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, env, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const why = err.code === 'ENOENT' ? `${cmd} is not installed` : (String(stderr || '').trim().split('\n').pop() || err.message);
        reject(Object.assign(new Error(why), { missing: err.code === 'ENOENT' }));
      } else resolve(String(stdout || ''));
    });
  });
}

const which = (bin) => (process.env.PATH || '/usr/bin:/bin').split(':').some((d) => d && existsSync(path.join(d, bin)));

/** What this box can render: { pdf, office }. */
export function previewCapabilities() {
  return { pdf: which('pdftoppm'), office: which('soffice') && which('pdftoppm') };
}

export function cacheKey(abs, st) {
  return createHash('sha1').update(`${abs}\0${st.size}\0${Math.floor(st.mtimeMs)}`).digest('hex').slice(0, 20);
}

/** The page PNG names in a rendered dir, in page order. */
function pagesIn(dir) {
  return readdirSync(dir).filter((n) => /^page-\d+\.png$/.test(n))
    .sort((a, b) => parseInt(a.slice(5), 10) - parseInt(b.slice(5), 10));
}

/** Oldest renders go first once there are more than KEEP_DIRS. */
function prune() {
  try {
    const dirs = readdirSync(CACHE_DIR).map((n) => {
      const p = path.join(CACHE_DIR, n);
      try { return { p, t: statSync(p).mtimeMs }; } catch { return null; }
    }).filter(Boolean).sort((a, b) => b.t - a.t);
    for (const d of dirs.slice(KEEP_DIRS)) rmSync(d.p, { recursive: true, force: true });
  } catch { /* nothing cached yet */ }
}

let queue = Promise.resolve();
const inFlight = new Map();   // key → Promise

async function render(abs, ext, key) {
  const dir = path.join(CACHE_DIR, key);
  const work = `${dir}.tmp`;
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const started = Date.now();
  try {
    let pdf = abs;
    if (ext !== 'pdf') {
      mkdirSync(PROFILE_DIR, { recursive: true });
      // A private profile, so a stale lock from a killed run elsewhere (or the
      // agent's own soffice) cannot block this one.
      await run('soffice', [
        `-env:UserInstallation=file://${PROFILE_DIR}`, '--headless', '--norestore', '--nolockcheck',
        '--convert-to', 'pdf', '--outdir', work, abs,
      ], SOFFICE_TIMEOUT_MS, { ...process.env, HOME: PROFILE_DIR });
      const out = readdirSync(work).find((n) => n.toLowerCase().endsWith('.pdf'));
      if (!out) throw new Error('LibreOffice produced no PDF');
      renameSync(path.join(work, out), path.join(work, 'document.pdf'));
      pdf = path.join(work, 'document.pdf');
    }
    let total = null;
    try {
      const info = await run('pdfinfo', [pdf], 30000);
      total = parseInt((info.match(/^Pages:\s+(\d+)/m) || [])[1], 10) || null;
    } catch { /* page count is a nicety */ }
    await run('pdftoppm', ['-png', '-scale-to', String(PAGE_PX), '-f', '1', '-l', String(MAX_PAGES), pdf, path.join(work, 'page')],
      PDFTOPPM_TIMEOUT_MS);
    const pages = pagesIn(work);
    if (!pages.length) throw new Error('No page could be rendered');
    writeFileAtomic(path.join(work, 'meta.json'), JSON.stringify({
      pages: pages.length, total: total || pages.length, pdf: ext !== 'pdf', renderedAt: Date.now(),
    }));
    rmSync(dir, { recursive: true, force: true });
    renameSync(work, dir);
    log('INFO', `preview: ${path.basename(abs)} → ${pages.length} page(s) in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    prune();
  } catch (e) {
    rmSync(work, { recursive: true, force: true });
    throw e;
  }
}

/**
 * Pages for one document, rendering it first if needed.
 * → { ok, key, pages: [file names], total, pdf } | { ok: false, error, unavailable? }
 */
export async function previewDocument(abs) {
  const ext = path.extname(abs).slice(1).toLowerCase();
  if (!PREVIEW_EXT.has(ext)) return { ok: false, error: 'No document preview for this kind of file.' };
  let st;
  try { st = statSync(abs); } catch { return { ok: false, error: 'File not found.' }; }
  if (!st.isFile()) return { ok: false, error: 'Not a file.' };
  const caps = previewCapabilities();
  if (!(ext === 'pdf' ? caps.pdf : caps.office)) {
    return { ok: false, unavailable: true, error: ext === 'pdf' ? 'pdftoppm is not installed.' : 'LibreOffice is not installed.' };
  }
  const key = cacheKey(abs, st);
  const dir = path.join(CACHE_DIR, key);
  const done = () => {
    const meta = JSON.parse(readFileSync(path.join(dir, 'meta.json'), 'utf8'));
    return { ok: true, key, pages: pagesIn(dir), total: meta.total, pdf: !!meta.pdf };
  };
  if (existsSync(path.join(dir, 'meta.json'))) return done();
  if (!inFlight.has(key)) {
    const p = (queue = queue.catch(() => {}).then(() => render(abs, ext, key)));
    inFlight.set(key, p);
    p.catch(() => {}).finally(() => inFlight.delete(key));
  }
  try {
    await inFlight.get(key);
    return done();
  } catch (e) {
    log('WARN', `preview of ${path.basename(abs)} failed: ${e.message}`);
    return { ok: false, error: e.message, unavailable: !!e.missing };
  }
}

/** Absolute path of a rendered file (a page PNG or the converted PDF), or null. */
export function renderedFile(key, name) {
  if (!/^[0-9a-f]{20}$/.test(String(key)) || !/^(page-\d+\.png|document\.pdf)$/.test(String(name))) return null;
  const p = path.join(CACHE_DIR, key, name);
  return existsSync(p) ? p : null;
}
