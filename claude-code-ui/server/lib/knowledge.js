/*
 * Projects with knowledge — like Claude's or ChatGPT's Projects: a workspace
 * project folder can carry
 *
 *   PROJECT.md   instructions for every conversation in that project
 *   Knowledge/   reference documents (any format) Claude should rely on
 *
 * Both are plain files in the project (so in the user's Drive too). A turn in
 * that project gets them in its system prompt (knowledgePrompt):
 *
 *   cowork / code  the instructions, and the list of knowledge files with
 *                  their paths — Claude reads what it needs (cheap on tokens)
 *   chat           no file tools there, so the knowledge's *text* is inlined,
 *                  up to INLINE_BUDGET characters (Word / PowerPoint / Excel /
 *                  PDF are turned into text; cached per file + mtime)
 */
import { execFile } from 'child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import path from 'path';
import { readZip } from './zip.js';
import { partParagraphs, sharedStrings, sheetCells } from './office-edit.js';

export const KNOWLEDGE_DIR = 'Knowledge';
export const INSTRUCTIONS_FILE = 'PROJECT.md';
export const INLINE_BUDGET = 60000;
const MAX_INSTRUCTIONS = 12000;
const TEXT_EXT = new Set(['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'yaml', 'yml', 'xml', 'html', 'htm', 'ini', 'toml', 'sql', 'py', 'js', 'ts', 'sh', 'log']);

export function projectKnowledge(dir) {
  const instrFile = path.join(dir, INSTRUCTIONS_FILE);
  const instructions = existsSync(instrFile) ? readFileSync(instrFile, 'utf8') : '';
  const kdir = path.join(dir, KNOWLEDGE_DIR);
  const files = [];
  const walk = (abs, rel) => {
    let names = [];
    try { names = readdirSync(abs); } catch { return; }
    for (const n of names.sort()) {
      if (n.startsWith('.') || n.startsWith('~$')) continue;
      const p = path.join(abs, n);
      const st = statSync(p);
      if (st.isDirectory()) walk(p, `${rel}${n}/`);
      else if (st.isFile()) files.push({ name: `${rel}${n}`, abs: p, size: st.size, mtime: st.mtimeMs });
    }
  };
  walk(kdir, '');
  return { instructions, files };
}

export function saveInstructions(dir, text) {
  const t = String(text ?? '').slice(0, MAX_INSTRUCTIONS);
  const f = path.join(dir, INSTRUCTIONS_FILE);
  if (!t.trim()) { rmSync(f, { force: true }); return { ok: true }; }
  writeFileSync(f, t.endsWith('\n') ? t : `${t}\n`);
  return { ok: true };
}

/** A safe file name for Knowledge/. Pure. */
export function knowledgeName(name) {
  const n = path.basename(String(name || '')).replace(/[\\/:*?"<>|]+/g, '-').trim();
  return n && !n.startsWith('.') && n.length <= 120 ? n : null;
}

export function addKnowledge(dir, name, data) {
  const n = knowledgeName(name);
  if (!n) return { ok: false, error: 'Bad file name.' };
  const kdir = path.join(dir, KNOWLEDGE_DIR);
  mkdirSync(kdir, { recursive: true });
  writeFileSync(path.join(kdir, n), data);
  return { ok: true, name: n };
}

export function removeKnowledge(dir, name) {
  const kdir = path.join(dir, KNOWLEDGE_DIR);
  const abs = path.resolve(kdir, String(name || ''));
  if (!abs.startsWith(kdir + path.sep)) return { ok: false, error: 'Bad file name.' };
  rmSync(abs, { force: true });
  return { ok: true };
}

// ── Text out of any document ───────────────────────────────────────────────
const cache = new Map();   // abs → { mtime, text }

function pdfText(abs) {
  return new Promise((resolve) => {
    execFile('pdftotext', ['-layout', '-q', abs, '-'], { timeout: 60000, maxBuffer: 20 * 1024 * 1024 },
      (err, out) => resolve(err ? '' : String(out)));
  });
}

/** Plain text of one file ('' when it has none). */
export async function documentText(abs) {
  const st = statSync(abs);
  const hit = cache.get(abs);
  if (hit && hit.mtime === st.mtimeMs) return hit.text;
  const ext = path.extname(abs).slice(1).toLowerCase();
  let text = '';
  try {
    if (TEXT_EXT.has(ext)) {
      text = readFileSync(abs, 'utf8');
      if (ext === 'html' || ext === 'htm') text = text.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/[ \t]+/g, ' ');
    } else if (ext === 'pdf') {
      text = await pdfText(abs);
    } else if (ext === 'docx' || ext === 'pptx') {
      const files = new Map(readZip(readFileSync(abs)).map((e) => [e.name, e.data]));
      const parts = [...files.keys()].filter((n) => (ext === 'docx' ? /^word\/(document|header\d*|footer\d*)\.xml$/ : /^ppt\/(slides\/slide|notesSlides\/notesSlide)\d+\.xml$/).test(n))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      text = parts.map((n) => `${ext === 'pptx' ? `[${n.replace(/^.*\//, '').replace('.xml', '')}]\n` : ''}`
        + partParagraphs(files.get(n).toString('utf8'), ext).map((p) => p.text).filter((t) => t.trim()).join('\n')).join('\n\n');
    } else if (ext === 'xlsx') {
      const files = new Map(readZip(readFileSync(abs)).map((e) => [e.name, e.data]));
      const sst = sharedStrings(files.get('xl/sharedStrings.xml')?.toString('utf8'));
      text = [...files.keys()].filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort().map((n) => {
        const { rows } = sheetCells(files.get(n).toString('utf8'), sst);
        return `[${n.replace(/^.*\//, '').replace('.xml', '')}]\n` + rows.map((r) => (r || []).map((c) => (c ? c.v : '')).join('\t')).filter((l) => l.trim()).join('\n');
      }).join('\n\n');
    }
  } catch { text = ''; }
  text = text.replace(/\n{3,}/g, '\n\n').trim();
  cache.set(abs, { mtime: st.mtimeMs, text });
  return text;
}

/**
 * The system-prompt section for a project ('' when it has neither
 * instructions nor knowledge). `inline` = put the documents' text in (chat).
 */
export async function knowledgePrompt(name, dir, { inline = false, budget = INLINE_BUDGET } = {}) {
  if (!dir) return '';
  const { instructions, files } = projectKnowledge(dir);
  if (!instructions.trim() && !files.length) return '';
  const out = [`## Project "${name}"`];
  if (instructions.trim()) out.push(`Instructions for this project (from the user):\n${instructions.trim()}`);
  if (files.length) {
    if (!inline) {
      out.push(`Reference documents for this project — rely on them, cite the file when you use one, and read the ones that matter (they are not loaded yet):\n`
        + files.map((f) => `- ${f.abs} (${Math.max(1, Math.round(f.size / 1024))} KB)`).join('\n'));
    } else {
      let left = budget;
      const parts = [];
      for (const f of files) {
        if (left <= 0) { parts.push(`### ${f.name}\n(not included: the knowledge is larger than this conversation can hold)`); continue; }
        const t = await documentText(f.abs);
        if (!t) { parts.push(`### ${f.name}\n(no text could be extracted)`); continue; }
        const cut = t.length > left ? `${t.slice(0, left)}\n… (cut)` : t;
        left -= cut.length;
        parts.push(`### ${f.name}\n${cut}`);
      }
      out.push(`Reference documents for this project — rely on them and cite the file when you use one:\n\n${parts.join('\n\n')}`);
    }
  }
  return out.join('\n\n');
}
