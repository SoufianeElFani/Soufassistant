/*
 * The Memory panel's backend — what Claude remembers about the user across
 * conversations, made visible and editable (like ChatGPT's memory).
 *
 * The memory itself is Claude Code's own auto-memory: one Markdown file per
 * fact, with a small front matter (name, description, type), in
 * STORE_DIR/memory/, and an index MEMORY.md (one "- [Title](file.md) — hook"
 * line per fact) that is loaded into every conversation. This module only
 * reads and writes those files, so Claude and the panel always agree:
 *
 *   list    every fact + whether the index points at it; index lines whose
 *           file is gone ("dangling") are reported so they can be cleaned up
 *   save    create / update a fact and its index line
 *   delete  remove a fact and its index line
 *   clean   drop the dangling index lines
 *
 * Pure helpers (parseIndex, upsertIndexLine, …) are unit-tested.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import path from 'path';
import { STORE_DIR } from './config.js';
import { parseSkillMd, sanitizeSkillName } from './skills.js';

export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'];
const MAX_BODY = 8000;

export function memoryDir(store = STORE_DIR) { return path.join(store, 'memory'); }

/** MEMORY.md → [{ title, file, hook, line }]. Pure. */
export function parseIndex(text) {
  return String(text || '').split('\n').map((line) => {
    const m = /^\s*-\s*\[([^\]]*)\]\(([^)]+)\)\s*(?:[—–-]\s*(.*))?$/.exec(line);
    return m ? { title: m[1], file: m[2], hook: (m[3] || '').trim(), line } : null;
  }).filter(Boolean);
}

/** The index with `file`'s line replaced (or appended). Pure. */
export function upsertIndexLine(text, { title, file, hook }) {
  const line = `- [${String(title).replace(/[[\]]/g, '')}](${file}) — ${String(hook || '').replace(/\s+/g, ' ').trim()}`;
  const lines = String(text || '').split('\n');
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  const i = lines.findIndex((l) => parseIndex(l)[0]?.file === file);
  if (i >= 0) lines[i] = line;
  else lines.push(line);
  return `${lines.join('\n')}\n`;
}

/** The index without the lines pointing at `files`. Pure. */
export function removeIndexLines(text, files) {
  const drop = new Set(files);
  return String(text || '').split('\n').filter((l) => !drop.has(parseIndex(l)[0]?.file)).join('\n');
}

function buildFact({ name, description, type, body }) {
  return `---\nname: ${name}\ndescription: ${JSON.stringify(String(description).replace(/\s+/g, ' ').trim())}\n`
    + `metadata:\n  type: ${type}\n---\n\n${String(body || '').trim()}\n`;
}

export function listMemory(dir = memoryDir()) {
  const indexFile = path.join(dir, 'MEMORY.md');
  const indexText = existsSync(indexFile) ? readFileSync(indexFile, 'utf8') : '';
  const index = parseIndex(indexText);
  const files = existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith('.md') && n !== 'MEMORY.md') : [];
  const facts = files.map((file) => {
    const text = readFileSync(path.join(dir, file), 'utf8');
    const { meta, body } = parseSkillMd(text);
    const type = (/\btype:\s*(\w+)/.exec(text.split('\n---')[0]) || [])[1] || meta.type || '';
    const inIndex = index.find((x) => x.file === file);
    return {
      file, name: meta.name || file.replace(/\.md$/, ''), description: meta.description || '', type,
      body: body.trim(), title: inIndex?.title || meta.name || file, indexed: !!inIndex,
      mtime: statSync(path.join(dir, file)).mtimeMs,
    };
  }).sort((a, b) => b.mtime - a.mtime);
  const dangling = index.filter((x) => !files.includes(x.file)).map((x) => x.file);
  return { dir, facts, dangling, indexBytes: Buffer.byteLength(indexText) };
}

/** Create or update one fact. `file` set = editing it. */
export function saveFact({ file, name, title, description, type, body }, dir = memoryDir()) {
  const slug = sanitizeSkillName(name || title);
  if (!slug) return { ok: false, error: 'Give it a short name.' };
  if (!String(description || '').trim()) return { ok: false, error: 'A one-line description is needed — it is how Claude decides when it matters.' };
  if (!MEMORY_TYPES.includes(type)) type = 'user';
  if (String(body || '').length > MAX_BODY) return { ok: false, error: 'Keep a memory short (8000 characters max).' };
  const target = file && /^[\w.-]+\.md$/.test(file) && file !== 'MEMORY.md' ? file : `${slug}.md`;
  if (!file && existsSync(path.join(dir, target))) return { ok: false, error: `A memory named "${slug}" already exists.` };
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, target), buildFact({ name: slug, description, type, body }));
  const indexFile = path.join(dir, 'MEMORY.md');
  const idx = existsSync(indexFile) ? readFileSync(indexFile, 'utf8') : '';
  writeFileSync(indexFile, upsertIndexLine(idx, { title: title || slug, file: target, hook: description }));
  return { ok: true, file: target };
}

export function deleteFact(file, dir = memoryDir()) {
  if (!/^[\w.-]+\.md$/.test(String(file)) || file === 'MEMORY.md') return { ok: false, error: 'Bad name.' };
  rmSync(path.join(dir, file), { force: true });
  const indexFile = path.join(dir, 'MEMORY.md');
  if (existsSync(indexFile)) writeFileSync(indexFile, removeIndexLines(readFileSync(indexFile, 'utf8'), [file]));
  return { ok: true };
}

export function cleanDangling(dir = memoryDir()) {
  const { dangling } = listMemory(dir);
  const indexFile = path.join(dir, 'MEMORY.md');
  if (dangling.length && existsSync(indexFile)) writeFileSync(indexFile, removeIndexLines(readFileSync(indexFile, 'utf8'), dangling));
  return { ok: true, removed: dangling };
}
