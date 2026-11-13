/*
 * Masquer une image ou un plan avant de l'envoyer (mode Confidentiel, 1.5.0).
 *
 * Tout se passe sur Home Assistant : l'agent ne voit jamais l'original.
 *   analyze()   une image (capture, scan) ou un PDF (P&ID, plan) → des pages en
 *               PNG et, pour chacune, les zones à masquer proposées :
 *                 PDF vectoriel  le texte et la position de chaque mot (pdftotext)
 *                 image / scan   OCR local (Tesseract fra+eng+nld)
 *               chaque ligne passe par vault.sensitiveSpans() (coffre, motifs,
 *               URL, adresses, sociétés, personnes ; noms possibles en suggestion).
 * Le navigateur affiche l'éditeur, l'utilisateur ajoute ou retire des zones,
 * puis peint les rectangles et ré-encode en PNG : seuls des pixels partent,
 * sans couche de texte, sans calques ni métadonnées (confidential.js).
 */
import { execFile } from 'child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import * as vault from './vault.js';
import { log } from './log.js';

const MAX_SIDE = 7000;       // px, longest side of a rendered PDF page
const MAX_DPI = 200;
const MAX_PAGES = 10;

function run(cmd, args, { timeout = 120000, encoding = 'utf8' } = {}) {
  return new Promise((res, rej) => execFile(cmd, args, { timeout, maxBuffer: 256 * 1024 * 1024, encoding }, (e, out) => (e ? rej(e) : res(out))));
}
let ocrAvailable = null;
export async function hasOcr() {
  if (ocrAvailable === null) ocrAvailable = await run('tesseract', ['--version']).then(() => true, () => false);
  return ocrAvailable;
}

/** Words → lines → boxes for the spans vault.sensitiveSpans() finds. `lines`: [[{text, x, y, w, h}]] */
export function boxesFor(lines) {
  const boxes = [];
  for (const words of lines) {
    if (!words.length) continue;
    let text = '';
    const at = words.map((w) => { const start = text.length ? text.length + 1 : 0; text += (text.length ? ' ' : '') + w.text; return { start, end: start + w.text.length, w }; });
    for (const s of vault.sensitiveSpans(text)) {
      const hit = at.filter((a) => a.start < s.end && a.end > s.start).map((a) => a.w);
      if (!hit.length) continue;
      const x = Math.min(...hit.map((w) => w.x)), y = Math.min(...hit.map((w) => w.y));
      const pad = Math.max(2, Math.round(Math.max(...hit.map((w) => w.h)) * 0.15));
      boxes.push({
        x: x - pad, y: y - pad,
        w: Math.max(...hit.map((w) => w.x + w.w)) - x + 2 * pad,
        h: Math.max(...hit.map((w) => w.y + w.h)) - y + 2 * pad,
        sure: s.sure, why: s.why, text: hit.map((w) => w.text).join(' '),
      });
    }
  }
  // one box per place: a sure box swallows a suggestion over the same words
  const out = [];
  for (const b of boxes.sort((p, q) => Number(q.sure) - Number(p.sure))) {
    if (out.some((o) => o.x <= b.x + 1 && o.y <= b.y + 1 && o.x + o.w >= b.x + b.w - 1 && o.y + o.h >= b.y + b.h - 1)) continue;
    out.push(b);
  }
  return out;
}

/** Tesseract TSV → lines of words (level 5 rows grouped by block / paragraph / line). */
export function parseTsv(tsv) {
  const lines = new Map();
  for (const row of String(tsv).split('\n').slice(1)) {
    const c = row.split('\t');
    if (c.length < 12 || c[0] !== '5' || !c[11].trim() || Number(c[10]) < 0) continue;   // a poorly read word is still a word to mask
    const k = `${c[2]}.${c[3]}.${c[4]}`;
    if (!lines.has(k)) lines.set(k, []);
    lines.get(k).push({ text: c[11].trim(), x: +c[6], y: +c[7], w: +c[8], h: +c[9] });
  }
  return [...lines.values()];
}

/** pdftotext -bbox-layout (points) → lines of words per page, in pixels at `dpi`. */
export function parseBbox(xhtml, dpi) {
  const k = dpi / 72;
  const pages = [];
  for (const pg of String(xhtml).split(/<page\b/).slice(1)) {
    const lines = [];
    for (const ln of pg.split(/<line\b/).slice(1)) {
      const words = [];
      for (const m of ln.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g)) {
        const text = m[5].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
        words.push({ text, x: Math.round(+m[1] * k), y: Math.round(+m[2] * k), w: Math.round((+m[3] - +m[1]) * k), h: Math.round((+m[4] - +m[2]) * k) });
      }
      if (words.length) lines.push(words);
    }
    pages.push(lines);
  }
  return pages;
}

const pngSize = (buf) => ({ w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) });

async function ocr(file) {
  if (!(await hasOcr())) return null;
  const tsv = await run('tesseract', [file, '-', '-l', 'fra+eng+nld', 'tsv'], { timeout: 180000 }).catch((e) => { log('WARN', `redact: OCR failed: ${e.message}`); return ''; });
  return parseTsv(tsv);
}

/**
 * → { ok, ocr, pages: [{ w, h, boxes, png? (base64, PDF pages only), text: 'vecteur' | 'ocr' | 'aucun' }], note? }
 * For an image the browser already has the pixels; only the boxes come back.
 */
export async function analyze({ name = '', mediaType = '', data = '' }) {
  if (vault.isLocked()) return { ok: false, locked: true, error: 'Coffre verrouillé.' };
  const buf = Buffer.from(String(data).replace(/^data:[^;]+;base64,/, ''), 'base64');
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'redact-'));
  const withOcr = await hasOcr();
  try {
    const isPdf = /pdf/i.test(mediaType) || /\.pdf$/i.test(name);
    if (!isPdf) {
      const f = path.join(tmp, 'in' + (path.extname(name) || '.png'));
      writeFileSync(f, buf);
      const lines = await ocr(f);
      return { ok: true, ocr: withOcr, pages: [{ boxes: lines ? boxesFor(lines) : [], text: lines ? 'ocr' : 'aucun' }] };
    }
    const f = path.join(tmp, 'in.pdf');
    writeFileSync(f, buf);
    const info = await run('pdfinfo', [f]).catch(() => '');
    const pagesN = Number((info.match(/^Pages:\s+(\d+)/m) || [])[1] || 1);
    const [pw, ph] = ((info.match(/^Page size:\s+([\d.]+) x ([\d.]+)/m) || []).slice(1).map(Number));
    const dpi = Math.max(72, Math.min(MAX_DPI, Math.floor((MAX_SIDE * 72) / Math.max(pw || 595, ph || 842))));
    const last = Math.min(pagesN, MAX_PAGES);
    await run('pdftoppm', ['-r', String(dpi), '-png', '-f', '1', '-l', String(last), f, path.join(tmp, 'p')], { timeout: 300000 });
    const vec = parseBbox(await run('pdftotext', ['-bbox-layout', '-f', '1', '-l', String(last), f, '-']).catch(() => ''), dpi);
    const files = readdirSync(tmp).filter((n) => /^p-\d+\.png$/.test(n)).sort((a, b) => parseInt(a.slice(2), 10) - parseInt(b.slice(2), 10));
    const pages = [];
    for (let i = 0; i < files.length; i++) {
      const p = path.join(tmp, files[i]);
      const png = readFileSync(p);
      let lines = vec[i] || [];
      let text = 'vecteur';
      if (!lines.length) { lines = (await ocr(p)) || []; text = withOcr ? 'ocr' : 'aucun'; }   // a scan inside a PDF
      pages.push({ ...pngSize(png), boxes: boxesFor(lines), text, png: png.toString('base64') });
    }
    log('INFO', `redact: ${name || 'pdf'} — ${pages.length} page(s) at ${dpi} dpi, ${pages.reduce((n, p) => n + p.boxes.length, 0)} zone(s)`);
    return { ok: true, ocr: withOcr, dpi, pages, note: pagesN > last ? `Seules les ${last} premières pages sur ${pagesN} sont reprises.` : undefined };
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}
