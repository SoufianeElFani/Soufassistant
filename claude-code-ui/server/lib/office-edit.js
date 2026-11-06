/*
 * Editing generated documents in the artifact viewer, without a round trip
 * through Claude: Word, PowerPoint and Excel files are ZIPs of XML, so the
 * text can be changed in place and everything else (layout, styles, images,
 * charts, the template) is left byte-for-byte as it was.
 *
 *   docx  every paragraph of the body, headers and footers, as text
 *   pptx  every paragraph of every slide, grouped by shape, + speaker notes
 *   xlsx  the cells of every sheet (values, or a formula when it starts with =)
 *   pdf   the page order: reorder / delete pages (poppler's pdfseparate + pdfunite)
 *
 * A paragraph is edited by minimal changes: a word-level diff of the old and
 * new text, and only the runs each changed stretch touches are rewritten — so
 * a bold word elsewhere in the paragraph stays bold. A new line
 * becomes a line break (<w:br/> / <a:br/>), a tab a tab.
 *
 * Everything is checked again on save: the file's mtime (a change by Claude
 * or the Drive sync meanwhile is a conflict, as in the text editor) and, per
 * paragraph, the old text the editor saw. The previous version is kept under
 * DATA_DIR/cache/edit-backups (the last BACKUPS_KEPT saves).
 *
 * Pure helpers (scanParagraphs, editParagraph, setCell, …) are unit-tested;
 * the module never touches a file outside what workspace.js resolves.
 */
import { execFile } from 'child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, renameSync } from 'fs';
import os from 'os';
import path from 'path';
import { DATA_DIR } from './config.js';
import { readZip, makeZip } from './zip.js';
import { log } from './log.js';

export const DOC_EDIT_EXT = new Set(['docx', 'pptx', 'xlsx', 'pdf']);
const BACKUP_DIR = process.env.EDIT_BACKUP_DIR || path.join(DATA_DIR, 'cache', 'edit-backups');
const BACKUPS_KEPT = 40;
const MAX_ROWS = 1000;
const MAX_COLS = 60;

// ── XML text ────────────────────────────────────────────────────────────────
export function xmlDecode(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (k === 'lt') return '<';
    if (k === 'gt') return '>';
    if (k === 'amp') return '&';
    if (k === 'quot') return '"';
    if (k === 'apos') return "'";
    const n = k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
    return Number.isFinite(n) ? String.fromCodePoint(n) : m;
  });
}
export const xmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const attr = (tag, name) => {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? xmlDecode(m[1]) : null;
};

/**
 * Spans of every `<tag>` element that contains no other `<tag>` (a "leaf"),
 * outside mc:Fallback (Word stores text boxes twice; the Choice is the one
 * shown). → [{ start, end, selfClosing }]
 */
export function leafElements(xml, tag) {
  const fallback = [];
  const fre = /<mc:Fallback\b[\s\S]*?<\/mc:Fallback>/g;
  let fm;
  while ((fm = fre.exec(xml))) fallback.push([fm.index, fm.index + fm[0].length]);
  const inFallback = (i) => fallback.some(([a, b]) => i >= a && i < b);
  const re = new RegExp(`<(/?)${tag}(?=[\\s>/])[^>]*?(/?)>`, 'g');
  const stack = [];
  const out = [];
  let m;
  while ((m = re.exec(xml))) {
    if (m[1]) {
      const open = stack.pop();
      if (open && !open.hasChild && !inFallback(open.start)) out.push({ start: open.start, end: m.index + m[0].length, selfClosing: false });
    } else if (m[2]) {
      if (stack.length) stack[stack.length - 1].hasChild = true;
      if (!inFallback(m.index)) out.push({ start: m.index, end: m.index + m[0].length, selfClosing: true });
    } else {
      if (stack.length) stack[stack.length - 1].hasChild = true;
      stack.push({ start: m.index, hasChild: false });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

const FLAVOR = {
  docx: {
    p: 'w:p',
    seg: /<w:t(\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:t(\s[^>]*)?\/>|<w:tab\/>|<w:br(\s[^>]*)?\/>|<w:cr\/>/g,
  },
  pptx: {
    p: 'a:p',
    seg: /<a:t(\s[^>]*)?>([\s\S]*?)<\/a:t>|<a:t(\s[^>]*)?\/>|<a:br(\s[^>]*)?(?:\/>|>[\s\S]*?<\/a:br>)/g,
  },
};

/**
 * The text pieces of one paragraph's XML: text nodes (editable content) and
 * fixed one-character tokens (tab, line break). Pure.
 */
export function scanParagraph(px, flavor) {
  const re = new RegExp(FLAVOR[flavor].seg.source, 'g');
  const segs = [];
  let m;
  while ((m = re.exec(px))) {
    const s = m[0];
    if (/^<[wa]:t[\s>/]/.test(s)) {
      if (s.endsWith('/>') && !s.includes('</')) {
        // <w:t/> — an empty text node: treat as text with no content, made editable by expanding it
        segs.push({ kind: 't', start: m.index, end: m.index + s.length, openEnd: m.index + s.length, empty: true, text: '' });
      } else {
        const openLen = s.indexOf('>') + 1;
        const closeLen = flavor === 'docx' ? '</w:t>'.length : '</a:t>'.length;
        segs.push({
          kind: 't', start: m.index, end: m.index + s.length, openEnd: m.index + openLen,
          contentStart: m.index + openLen, contentEnd: m.index + s.length - closeLen,
          text: xmlDecode(s.slice(openLen, s.length - closeLen)),
        });
      }
    } else {
      segs.push({ kind: 'f', start: m.index, end: m.index + s.length, text: /tab/.test(s) ? '\t' : '\n' });
    }
  }
  return segs;
}

export const paragraphText = (segs) => segs.map((s) => s.text).join('');

/** The run properties to give new text in a pptx paragraph: the nearest run's, else the paragraph end's. */
function pptxRunProps(px, at) {
  const before = px.slice(0, at);
  const runStart = Math.max(before.lastIndexOf('<a:r>'), before.lastIndexOf('<a:fld '));
  const scope = runStart >= 0 ? px.slice(runStart) : px;
  const rp = /<a:rPr\b[^>]*\/>|<a:rPr\b[\s\S]*?<\/a:rPr>/.exec(scope);
  if (rp) return rp[0];
  const end = /<a:endParaRPr\b([^>]*?)(\/>|>[\s\S]*?<\/a:endParaRPr>)/.exec(px);
  if (end) return end[0].replace(/^<a:endParaRPr/, '<a:rPr').replace(/<\/a:endParaRPr>$/, '</a:rPr>');
  return '';
}

/** Text → the content of one text node, with \n / \t as breaks and tabs. */
function encodeText(text, flavor, px, at) {
  const esc = xmlEscape(text);
  if (flavor === 'docx') {
    return esc.replace(/\r?\n/g, '</w:t><w:br/><w:t xml:space="preserve">').replace(/\t/g, '</w:t><w:tab/><w:t xml:space="preserve">');
  }
  const inField = px.slice(0, at).lastIndexOf('<a:fld ') > px.slice(0, at).lastIndexOf('<a:r>');
  if (inField) return esc.replace(/\r?\n/g, ' ');
  const rPr = pptxRunProps(px, at);
  return esc.replace(/\r?\n/g, `</a:t></a:r><a:br/><a:r>${rPr}<a:t>`);
}

function newTextNode(text, flavor, px, at, { standalone }) {
  if (flavor === 'docx') {
    const node = `<w:t xml:space="preserve">${encodeText(text, flavor, px, at)}</w:t>`;
    if (!standalone) return node;
    const rPr = (/<w:pPr\b[\s\S]*?<\/w:pPr>/.exec(px)?.[0].match(/<w:rPr>[\s\S]*?<\/w:rPr>/) || [''])[0];
    return `<w:r>${rPr}${node}</w:r>`;
  }
  return `<a:r>${pptxRunProps(px, at)}<a:t>${encodeText(text, flavor, px, at)}</a:t></a:r>`;
}

/**
 * Where two texts differ, as hunks [a, b, ins] on the old text (replace
 * old[a, b) by ins), from a word-level LCS — so an edit at the start and one
 * at the end of a paragraph stay two small edits. Pure.
 */
export function diffHunks(old, next) {
  const tok = (t) => t.match(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) || [];
  const A = tok(old), B = tok(next);
  // trim the common ends first: the LCS table is only built for the middle
  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0;
  while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
  const a = A.slice(pre, A.length - suf), b = B.slice(pre, B.length - suf);
  const base = A.slice(0, pre).join('').length;
  const hunks = [];
  if (a.length * b.length > 250000) {
    if (a.length || b.length) hunks.push([base, base + a.join('').length, b.join('')]);
    return hunks;
  }
  const L = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) {
    L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  }
  let i = 0, j = 0, pos = base, cur = null;
  const flush = () => { if (cur) { hunks.push([cur.a, pos, cur.ins]); cur = null; } };
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { flush(); pos += a[i].length; i++; j++; }
    else if (j < b.length && (i >= a.length || L[i][j + 1] >= L[i + 1][j])) { (cur ||= { a: pos, ins: '' }).ins += b[j]; j++; }
    else { cur ||= { a: pos, ins: '' }; pos += a[i].length; i++; }
  }
  flush();
  return hunks;
}

/**
 * One paragraph's XML with its text changed to `next`, by the smallest edits
 * (see the header). Returns the XML unchanged when the text is the same. Pure.
 */
export function editParagraph(px, flavor, next) {
  const P = FLAVOR[flavor].p;
  if (/^<[wa]:p\b[^>]*\/>$/.test(px)) {
    // <w:p/> — expand it so there is somewhere to put the text.
    px = `${px.slice(0, -2)}></${P}>`;
  }
  const old = paragraphText(scanParagraph(px, flavor));
  next = String(next ?? '').replace(/\r\n/g, '\n');
  if (old === next) return px;
  // from the end backwards, so each hunk's offsets are still those of the old text
  for (const [a, b, ins] of diffHunks(old, next).reverse()) px = replaceRange(px, flavor, a, b, ins);
  return px;
}

/** old text [a, b) → ins, touching only the text nodes in that range. Pure. */
function replaceRange(px, flavor, a, b, ins) {
  const P = FLAVOR[flavor].p;
  const segs = scanParagraph(px, flavor);
  let off = 0;
  for (const g of segs) { g.off = off; off += g.text.length; }
  const target = segs.find((g) => g.kind === 't' && g.off <= a && a <= g.off + g.text.length);
  const edits = [];   // [start, end, replacement] on px
  for (const g of segs) {
    const len = g.text.length;
    if (g.kind === 'f') {
      if (g.off >= a && g.off < b) edits.push([g.start, g.end, '']);
      continue;
    }
    const overlaps = g.off < b && g.off + len > a;
    if (!overlaps && g !== target) continue;
    const pre = g.text.slice(0, Math.min(len, Math.max(0, a - g.off)));
    const post = g.text.slice(Math.min(len, Math.max(0, b - g.off)));
    const content = encodeText(pre, flavor, px, g.start) + (g === target ? encodeText(ins, flavor, px, g.start) : '') + encodeText(post, flavor, px, g.start);
    if (g.empty) {
      edits.push([g.start, g.end, flavor === 'docx' ? `<w:t xml:space="preserve">${content}</w:t>` : `<a:t>${content}</a:t>`]);
    } else {
      let open = px.slice(g.start, g.openEnd);
      if (flavor === 'docx' && !/xml:space=/.test(open)) open = `${open.slice(0, -1)} xml:space="preserve">`;
      edits.push([g.start, g.contentStart, open]);
      edits.push([g.contentStart, g.contentEnd, content]);
    }
  }
  if (!target && ins) {
    const after = segs.find((g) => g.kind === 'f' && g.off + 1 === a);
    const before = segs.find((g) => g.kind === 'f' && g.off === a);
    if (after) edits.push([after.end, after.end, newTextNode(ins, flavor, px, after.end, { standalone: flavor !== 'docx' })]);
    else if (before) edits.push([before.start, before.start, newTextNode(ins, flavor, px, before.start, { standalone: flavor !== 'docx' })]);
    else {
      const endMark = flavor === 'pptx' && px.lastIndexOf('<a:endParaRPr') >= 0 ? px.lastIndexOf('<a:endParaRPr') : px.lastIndexOf(`</${P}>`);
      edits.push([endMark, endMark, newTextNode(ins, flavor, px, endMark, { standalone: true })]);
    }
  }
  edits.sort((x, y) => y[0] - x[0] || y[1] - x[1]);
  let out = px;
  for (const [st, en, rep] of edits) out = out.slice(0, st) + rep + out.slice(en);
  return out;
}

// ── Word / PowerPoint parts ────────────────────────────────────────────────
function docxStyle(px) {
  const st = attr(/<w:pStyle\b[^>]*>/.exec(px)?.[0] || '', 'w:val') || '';
  const lvl = /^(?:heading|titre|kop|berschrift|überschrift)\s*(\d)/i.exec(st.replace(/[^a-z0-9ü]/gi, ''));
  if (/^title$|^titre$/i.test(st)) return { hint: 'title', style: st };
  if (lvl) return { hint: `h${lvl[1]}`, style: st };
  if (/<w:numPr>/.test(px)) return { hint: 'list', style: st };
  return { hint: '', style: st };
}

/** The editable paragraphs of one XML part. Pure. */
export function partParagraphs(xml, flavor) {
  const out = [];
  leafElements(xml, FLAVOR[flavor].p).forEach((el, i) => {
    const px = xml.slice(el.start, el.end);
    const text = paragraphText(scanParagraph(px, flavor));
    const before = xml.slice(0, el.start);
    if (flavor === 'pptx') {
      const spStart = Math.max(before.lastIndexOf('<p:sp>'), before.lastIndexOf('<p:sp '), before.lastIndexOf('<p:graphicFrame'));
      const head = spStart >= 0 ? xml.slice(spStart, el.start) : '';
      if (/<p:ph\b[^>]*type="(sldNum|dt|sldImg)"/.test(head)) return;
      const nm = /<p:cNvPr\b[^>]*>/.exec(head);
      const inTable = before.lastIndexOf('<a:tc>') > before.lastIndexOf('</a:tc>') || before.lastIndexOf('<a:tc ') > before.lastIndexOf('</a:tc>');
      out.push({ i, text, shape: nm ? attr(nm[0], 'name') || '' : '', cell: inTable });
    } else {
      const inCell = Math.max(before.lastIndexOf('<w:tc>'), before.lastIndexOf('<w:tc ')) > before.lastIndexOf('</w:tc>');
      out.push({ i, text, ...docxStyle(px), cell: inCell });
    }
  });
  return out;
}

/** A part with paragraph `i` (by leaf index) set to `text`; throws if `expect` no longer matches. Pure. */
export function setPartParagraphs(xml, flavor, edits) {
  const els = leafElements(xml, FLAVOR[flavor].p);
  const sorted = [...edits].sort((x, y) => y.i - x.i);
  for (const e of sorted) {
    const el = els[e.i];
    if (!el) throw new Error(`Paragraph ${e.i + 1} no longer exists`);
    const px = xml.slice(el.start, el.end);
    if (typeof e.old === 'string' && paragraphText(scanParagraph(px, flavor)) !== e.old) {
      throw Object.assign(new Error('The document changed since you opened it.'), { conflict: true });
    }
    xml = xml.slice(0, el.start) + editParagraph(px, flavor, e.text) + xml.slice(el.end);
  }
  return xml;
}

// ── Relationships ───────────────────────────────────────────────────────────
function rels(files, relsPath) {
  const x = files.get(relsPath);
  const out = {};
  if (!x) return out;
  for (const m of x.toString('utf8').matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(m[0], 'Id'), target = attr(m[0], 'Target');
    if (id && target) out[id] = { target, type: attr(m[0], 'Type') || '' };
  }
  return out;
}
function resolvePart(base, target) {
  if (target.startsWith('/')) return target.slice(1);
  return path.posix.normalize(path.posix.join(path.posix.dirname(base), target));
}

function docxParts(files) {
  const names = [...files.keys()];
  const order = ['word/document.xml',
    ...names.filter((n) => /^word\/header\d*\.xml$/.test(n)).sort(),
    ...names.filter((n) => /^word\/footer\d*\.xml$/.test(n)).sort(),
    ...names.filter((n) => n === 'word/footnotes.xml')];
  return order.filter((n) => files.has(n)).map((n) => ({
    id: n,
    label: n === 'word/document.xml' ? 'Document' : n.includes('header') ? `Header ${n.match(/\d+/)?.[0] || ''}`.trim()
      : n.includes('footer') ? `Footer ${n.match(/\d+/)?.[0] || ''}`.trim() : 'Footnotes',
  }));
}

function pptxSlides(files) {
  const pres = files.get('ppt/presentation.xml')?.toString('utf8') || '';
  const r = rels(files, 'ppt/_rels/presentation.xml.rels');
  const out = [];
  for (const m of pres.matchAll(/<p:sldId\b[^>]*>/g)) {
    const rid = attr(m[0], 'r:id');
    if (!r[rid]) continue;
    const slide = resolvePart('ppt/presentation.xml', r[rid].target);
    const n = out.filter((x) => x.kind === 'slide').length + 1;
    out.push({ id: slide, label: `Slide ${n}`, page: n, kind: 'slide' });
    const srels = rels(files, slide.replace(/([^/]+)$/, '_rels/$1.rels'));
    const notes = Object.values(srels).find((x) => /notesSlide$/.test(x.type));
    if (notes) {
      const np = resolvePart(slide, notes.target);
      if (files.has(np)) out.push({ id: np, label: `Notes ${n}`, page: n, kind: 'notes' });
    }
  }
  return out;
}

// ── Excel ───────────────────────────────────────────────────────────────────
export function colName(n) { let s = ''; for (n += 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; }
export function parseRef(ref) {
  const m = /^([A-Z]+)(\d+)$/.exec(String(ref).toUpperCase());
  if (!m) return null;
  let c = 0;
  for (const ch of m[1]) c = c * 26 + (ch.charCodeAt(0) - 64);
  return { col: c - 1, row: parseInt(m[2], 10) };
}

export function sharedStrings(xml) {
  if (!xml) return [];
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>|<si\/>/g)].map((m) => {
    const body = (m[1] || '').replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
    return [...body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((t) => xmlDecode(t[1])).join('');
  });
}

function cellValue(cx, sst) {
  const t = attr(/^<c\b[^>]*>/.exec(cx)?.[0] || '', 't');
  const v = /<v>([\s\S]*?)<\/v>/.exec(cx)?.[1];
  const f = /<f\b[^>]*>([\s\S]*?)<\/f>/.exec(cx)?.[1];
  const shared = /<f\b[^>]*t="shared"[^>]*\bref="/.test(cx);
  let val = '';
  if (t === 's') val = sst[parseInt(v, 10)] ?? '';
  else if (t === 'inlineStr') val = [...(/<is>([\s\S]*?)<\/is>/.exec(cx)?.[1] || '').matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((x) => xmlDecode(x[1])).join('');
  else if (t === 'b') val = v === '1' ? 'TRUE' : 'FALSE';
  else if (v != null) val = xmlDecode(v);
  return { v: val, f: f != null ? xmlDecode(f) : null, sharedMaster: shared };
}

/** A sheet's cells → { rows: [[{v,f}|null]], maxRow, maxCol }. Pure. */
export function sheetCells(xml, sst) {
  const rows = [];
  let maxRow = 0, maxCol = 0;
  for (const rm of xml.matchAll(/<row\b[^>]*?(?:\/>|>[\s\S]*?<\/row>)/g)) {
    for (const cm of rm[0].matchAll(/<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g)) {
      const ref = parseRef(attr(cm[0], 'r') || '');
      if (!ref) continue;
      const cell = cellValue(cm[0], sst);
      if (cell.v === '' && cell.f == null) continue;
      maxRow = Math.max(maxRow, ref.row);
      maxCol = Math.max(maxCol, ref.col + 1);
      if (ref.row > MAX_ROWS || ref.col >= MAX_COLS) continue;
      (rows[ref.row - 1] ||= [])[ref.col] = cell;
    }
  }
  return { rows, maxRow, maxCol };
}

/** The XML of a cell holding `value` (string from the grid), keeping its style. Pure. */
export function cellXml(ref, style, value) {
  const s = style ? ` s="${style}"` : '';
  const v = String(value ?? '');
  if (v === '') return `<c r="${ref}"${s}/>`;
  if (v.startsWith('=') && v.length > 1) return `<c r="${ref}"${s}><f>${xmlEscape(v.slice(1))}</f></c>`;
  if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(v.trim())) return `<c r="${ref}"${s}><v>${Number(v.trim())}</v></c>`;
  if (/^(TRUE|FALSE)$/i.test(v.trim())) return `<c r="${ref}"${s} t="b"><v>${/^t/i.test(v.trim()) ? 1 : 0}</v></c>`;
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(v)}</t></is></c>`;
}

/** A sheet's XML with one cell set. Throws for a shared formula's anchor. Pure. */
export function setCell(xml, ref, value, sst = []) {
  const at = parseRef(ref);
  if (!at) throw new Error(`Bad cell ${ref}`);
  const R = `${colName(at.col)}${at.row}`;
  let sd = /<sheetData\s*\/>|<sheetData>[\s\S]*<\/sheetData>/.exec(xml);
  if (!sd) throw new Error('No sheet data');
  let data = sd[0] === '<sheetData/>' || /^<sheetData\s*\/>$/.test(sd[0]) ? '' : sd[0].slice('<sheetData>'.length, -'</sheetData>'.length);
  const rowRe = /<row\b[^>]*?(?:\/>|>[\s\S]*?<\/row>)/g;
  let rowM = null, insertAt = data.length, m;
  while ((m = rowRe.exec(data))) {
    const r = parseInt(attr(m[0], 'r'), 10);
    if (!Number.isFinite(r)) throw new Error('Rows without numbers are not supported');
    if (r === at.row) { rowM = m; break; }
    if (r > at.row) { insertAt = m.index; break; }
  }
  if (!rowM) {
    if (String(value ?? '') === '') return xml;
    data = `${data.slice(0, insertAt)}<row r="${at.row}">${cellXml(R, null, value)}</row>${data.slice(insertAt)}`;
  } else {
    let row = rowM[0];
    if (row.endsWith('/>')) row = `${row.slice(0, -2)}></row>`;
    const openEnd = row.indexOf('>') + 1;
    let inner = row.slice(openEnd, -'</row>'.length);
    const cRe = /<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g;
    let cM = null, cAt = inner.length, c;
    while ((c = cRe.exec(inner))) {
      const cr = parseRef(attr(c[0], 'r') || '');
      if (!cr) throw new Error('Cells without references are not supported');
      if (cr.col === at.col) { cM = c; break; }
      if (cr.col > at.col) { cAt = c.index; break; }
    }
    if (cM) {
      if (cellValue(cM[0], sst).sharedMaster) throw new Error(`${R} anchors a shared formula — ask Claude to change it`);
      const style = attr(cM[0], 's');
      inner = inner.slice(0, cM.index) + cellXml(R, style, value) + inner.slice(cM.index + cM[0].length);
    } else {
      if (String(value ?? '') === '') return xml;
      inner = inner.slice(0, cAt) + cellXml(R, null, value) + inner.slice(cAt);
    }
    // the row's `spans` hint may no longer cover the new cell — it is optional, drop it
    const open = row.slice(0, openEnd).replace(/\sspans="[^"]*"/, '');
    data = data.slice(0, rowM.index) + open + inner + '</row>' + data.slice(rowM.index + rowM[0].length);
  }
  return xml.slice(0, sd.index) + `<sheetData>${data}</sheetData>` + xml.slice(sd.index + sd[0].length);
}

function xlsxSheets(files) {
  const wb = files.get('xl/workbook.xml')?.toString('utf8') || '';
  const r = rels(files, 'xl/_rels/workbook.xml.rels');
  const out = [];
  for (const m of wb.matchAll(/<sheet\b[^>]*>/g)) {
    const rid = attr(m[0], 'r:id');
    if (!r[rid]) continue;
    const part = resolvePart('xl/workbook.xml', r[rid].target);
    if (!files.has(part)) continue;
    out.push({ id: part, label: attr(m[0], 'name') || part, hidden: /state="(hidden|veryHidden)"/.test(m[0]) });
  }
  return out;
}

/** After cell edits: recalculate on open, and drop the (now stale) calc chain. */
function xlsxRecalc(files) {
  let wb = files.get('xl/workbook.xml').toString('utf8');
  if (/<calcPr\b/.test(wb)) {
    wb = wb.replace(/<calcPr\b([^>]*?)(\/?)>/, (all, attrs, sc) => `<calcPr${attrs.replace(/\sfullCalcOnLoad="[^"]*"/, '')} fullCalcOnLoad="1"${sc}>`);
  } else {
    const anchors = ['</definedNames>', '</externalReferences>', '</functionGroups>', '</sheets>'];
    const a = anchors.find((x) => wb.includes(x));
    if (a) wb = wb.replace(a, `${a}<calcPr fullCalcOnLoad="1"/>`);
  }
  files.set('xl/workbook.xml', Buffer.from(wb));
  if (files.has('xl/calcChain.xml')) {
    files.delete('xl/calcChain.xml');
    const rp = 'xl/_rels/workbook.xml.rels';
    if (files.has(rp)) files.set(rp, Buffer.from(files.get(rp).toString('utf8').replace(/<Relationship\b[^>]*Target="[^"]*calcChain\.xml"[^>]*\/>/g, '')));
    const ct = '[Content_Types].xml';
    if (files.has(ct)) files.set(ct, Buffer.from(files.get(ct).toString('utf8').replace(/<Override\b[^>]*PartName="\/xl\/calcChain\.xml"[^>]*\/>/g, '')));
  }
}

// ── PDF ─────────────────────────────────────────────────────────────────────
function run(cmd, args, timeout = 120000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(err.code === 'ENOENT' ? `${cmd} is not installed` : (String(stderr || '').trim().split('\n').pop() || err.message)));
      else resolve(String(stdout || ''));
    });
  });
}

async function pdfPageCount(abs) {
  const info = await run('pdfinfo', [abs], 30000);
  return parseInt((info.match(/^Pages:\s+(\d+)/m) || [])[1], 10) || 0;
}

/** A PDF with its pages in `order` (1-based page numbers; a page left out is deleted). */
async function reorderPdf(abs, order, out) {
  const total = await pdfPageCount(abs);
  if (!order.length) throw new Error('A PDF needs at least one page.');
  if (order.some((n) => !Number.isInteger(n) || n < 1 || n > total)) throw new Error('Bad page number.');
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'pdfedit-'));
  try {
    await run('pdfseparate', [abs, path.join(tmp, 'p-%d.pdf')]);
    await run('pdfunite', [...order.map((n) => path.join(tmp, `p-${n}.pdf`)), out]);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

// ── The file level ──────────────────────────────────────────────────────────
const extOf = (abs) => path.extname(abs).slice(1).toLowerCase();

function loadZip(abs) {
  const entries = readZip(readFileSync(abs));
  return { entries, files: new Map(entries.map((e) => [e.name, e.data])) };
}

/** What the editor shows for one file. → { ok, kind, mtime, parts | sheets | pages } */
export async function documentModel(abs) {
  const ext = extOf(abs);
  if (!DOC_EDIT_EXT.has(ext)) return { ok: false, error: 'This kind of file cannot be edited here.' };
  let st;
  try { st = statSync(abs); } catch { return { ok: false, error: 'File not found.' }; }
  try {
    if (ext === 'pdf') return { ok: true, kind: 'pdf', mtime: st.mtimeMs, pages: await pdfPageCount(abs) };
    const { files } = loadZip(abs);
    if (ext === 'xlsx') {
      const sst = sharedStrings(files.get('xl/sharedStrings.xml')?.toString('utf8'));
      const sheets = xlsxSheets(files).map((s) => ({ ...s, ...sheetCells(files.get(s.id).toString('utf8'), sst) }));
      return { ok: true, kind: 'xlsx', mtime: st.mtimeMs, sheets, maxRows: MAX_ROWS, maxCols: MAX_COLS };
    }
    const flavor = ext;
    const list = ext === 'docx' ? docxParts(files) : pptxSlides(files);
    const parts = list.map((p) => ({ ...p, paragraphs: partParagraphs(files.get(p.id).toString('utf8'), flavor) }))
      .filter((p) => p.kind === 'slide' || p.paragraphs.some((x) => x.text.trim()) || p.id === 'word/document.xml');
    return { ok: true, kind: ext, mtime: st.mtimeMs, parts };
  } catch (e) {
    return { ok: false, error: `Could not read the document: ${e.message}` };
  }
}

function backup(abs) {
  try {
    mkdirSync(BACKUP_DIR, { recursive: true });
    copyFileSync(abs, path.join(BACKUP_DIR, `${Date.now()}_${path.basename(abs)}`));
    const all = readdirSync(BACKUP_DIR).sort();
    for (const n of all.slice(0, Math.max(0, all.length - BACKUPS_KEPT))) rmSync(path.join(BACKUP_DIR, n), { force: true });
  } catch (e) { log('WARN', `edit backup of ${path.basename(abs)} failed: ${e.message}`); }
}

function replaceFile(abs, data) {
  const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.${process.pid}.tmp`);
  writeFileSync(tmp, data);
  renameSync(tmp, abs);
}

const staleCheck = (abs, mtime, force) => {
  const st = statSync(abs);
  return !force && mtime && Math.abs(st.mtimeMs - mtime) > 1;
};

/**
 * Save the editor's changes.
 *   docx/pptx  edits: [{ part, i, old, text }]
 *   xlsx       edits: [{ sheet, ref, value }]
 *   pdf        order: [page numbers]
 * → { ok, mtime } | { ok: false, conflict?, error }
 */
export async function saveDocument(abs, { mtime = null, force = false, edits = [], order = null } = {}) {
  const ext = extOf(abs);
  if (!DOC_EDIT_EXT.has(ext)) return { ok: false, error: 'This kind of file cannot be edited here.' };
  if (!existsSync(abs)) return { ok: false, error: 'File not found.' };
  if (staleCheck(abs, mtime, force)) return { ok: false, conflict: true, error: 'The file changed since you opened it.' };
  try {
    if (ext === 'pdf') {
      const tmp = path.join(os.tmpdir(), `pdfedit-${process.pid}-${Date.now()}.pdf`);
      try {
        await reorderPdf(abs, (order || []).map(Number), tmp);
        backup(abs);
        replaceFile(abs, readFileSync(tmp));
      } finally { rmSync(tmp, { force: true }); }
      return { ok: true, mtime: statSync(abs).mtimeMs };
    }
    if (!Array.isArray(edits) || !edits.length) return { ok: true, mtime: statSync(abs).mtimeMs };
    const { entries, files } = loadZip(abs);
    if (ext === 'xlsx') {
      const sst = sharedStrings(files.get('xl/sharedStrings.xml')?.toString('utf8'));
      const valid = new Set(xlsxSheets(files).map((s) => s.id));
      const bySheet = new Map();
      for (const e of edits) {
        if (!valid.has(e.sheet)) return { ok: false, error: 'Unknown sheet.' };
        if (!bySheet.has(e.sheet)) bySheet.set(e.sheet, files.get(e.sheet).toString('utf8'));
        bySheet.set(e.sheet, setCell(bySheet.get(e.sheet), e.ref, e.value, sst));
      }
      for (const [k, v] of bySheet) files.set(k, Buffer.from(v));
      xlsxRecalc(files);
    } else {
      const valid = new Set((ext === 'docx' ? docxParts(files) : pptxSlides(files)).map((p) => p.id));
      const byPart = new Map();
      for (const e of edits) {
        if (!valid.has(e.part)) return { ok: false, error: 'Unknown part of the document.' };
        if (!byPart.has(e.part)) byPart.set(e.part, []);
        byPart.get(e.part).push({ i: Number(e.i), old: e.old, text: String(e.text ?? '') });
      }
      for (const [part, list] of byPart) files.set(part, Buffer.from(setPartParagraphs(files.get(part).toString('utf8'), ext, list)));
    }
    const names = entries.map((e) => e.name).filter((n) => files.has(n));
    const zip = makeZip(names.map((n) => ({ name: n, data: files.get(n) })), { deflate: true });
    backup(abs);
    replaceFile(abs, zip);
    return { ok: true, mtime: statSync(abs).mtimeMs };
  } catch (e) {
    return { ok: false, conflict: !!e.conflict, error: e.message };
  }
}

/** An image (or any binary the viewer edits, e.g. a cropped PNG) written back. */
export function saveBinary(abs, data, { mtime = null, force = false } = {}) {
  if (existsSync(abs)) {
    if (staleCheck(abs, mtime, force)) return { ok: false, conflict: true, error: 'The file changed since you opened it.' };
    backup(abs);
  }
  mkdirSync(path.dirname(abs), { recursive: true });
  replaceFile(abs, data);
  return { ok: true, mtime: statSync(abs).mtimeMs };
}
