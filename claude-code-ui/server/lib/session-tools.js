/*
 * Conversation management beyond open/delete: custom titles and pins, a
 * full-text search across every conversation, Markdown export into the
 * workspace, duplicating a conversation (SDK forkSession), and the per-turn
 * change history + "restore files to before this message" (SDK file
 * checkpoints, rewindFiles).
 *
 * Rewinding works on a conversation that is not running: a promptless Query
 * resumes it with checkpointing on and is asked `rewindFiles(<user message
 * uuid>)` — verified live; no turn runs and no tokens are spent. Only files
 * changed through Claude's file tools (Write/Edit/MultiEdit/NotebookEdit) in a
 * conversation run with checkpointing are tracked; Bash changes are not.
 */
import { query, forkSession } from '@anthropic-ai/claude-agent-sdk';
import { writeFileAtomic } from './atomic.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import { SESSION_META_FILE, WORK_DIR } from './config.js';
import { sessionFile, parseSession, isHarnessEcho, parseTaskNotification, NON_HUMAN_ORIGIN_KINDS, listSessions } from './sessions.js';
import { log } from './log.js';

export const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

// ── Titles and pins ──────────────────────────────────────────────────────────
let meta = { titles: {}, pinned: [], artifacts: {} };

export function loadSessionMeta() {
  try {
    const d = JSON.parse(readFileSync(SESSION_META_FILE, 'utf8'));
    const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
    meta = { titles: obj(d.titles), pinned: Array.isArray(d.pinned) ? d.pinned : [], artifacts: obj(d.artifacts) };
  } catch { meta = { titles: {}, pinned: [], artifacts: {} }; }
}
function saveMeta() {
  try { writeFileAtomic(SESSION_META_FILE, JSON.stringify(meta, null, 2)); }
  catch (e) { log('WARN', `session meta not saved: ${e.message}`); }
}

export function renameSession(id, title) {
  const t = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (t) meta.titles[id] = t; else delete meta.titles[id];
  saveMeta();
}

export function setPinned(id, pinned) {
  meta.pinned = meta.pinned.filter((x) => x !== id);
  if (pinned) meta.pinned.unshift(id);
  saveMeta();
}

export function forgetSession(id) {
  delete meta.titles[id];
  delete meta.artifacts[id];
  meta.pinned = meta.pinned.filter((x) => x !== id);
  saveMeta();
}

// ── Artifacts ────────────────────────────────────────────────────────────────
/*
 * The workspace files each reply produced, remembered per conversation. They
 * used to exist only as a card appended to the live transcript, so anything
 * that re-rendered the chat from the stored transcript — a reconnect (a phone
 * waking up), switching away and back — made them vanish. Kept here, they come
 * back with the history ('history'.artifacts) and fill the Artifacts menu.
 */
const MAX_ARTIFACTS_PER_SESSION = 200;

/** Record what one reply wrote: [{ path, ext, size, mtime }], stamped `ts`. */
export function recordArtifacts(id, files, ts = Date.now()) {
  if (!id || !Array.isArray(files) || !files.length) return [];
  const list = Array.isArray(meta.artifacts[id]) ? meta.artifacts[id] : [];
  const added = files.map((f) => ({ path: f.path, ext: f.ext || '', size: f.size || 0, mtime: f.mtime || ts, ts }));
  const paths = new Set(added.map((f) => f.path));
  // A file rewritten by a later reply belongs to that reply now: one entry each.
  const next = list.filter((f) => !paths.has(f.path)).concat(added);
  meta.artifacts[id] = next.slice(-MAX_ARTIFACTS_PER_SESSION);
  saveMeta();
  return added;
}

/** The conversation's artifacts, oldest first, without files deleted since. */
export function sessionArtifacts(id, exists = null) {
  const list = (id && Array.isArray(meta.artifacts[id])) ? meta.artifacts[id] : [];
  return exists ? list.filter((f) => exists(f.path)) : list.slice();
}

/*
 * Files a conversation produced before artifacts were recorded (conversations
 * older than 0.5.0), or that a reply wrote in a way no file tool saw — a shell
 * `cp` or a converter writing the deck. Read back from the transcript's own
 * clock: a workspace file whose mtime falls inside one reply's window (its
 * prompt to its last message, plus a little slack for a final copy) belongs to
 * that reply. The same heuristic run-query.js applies live (`runArtifacts`).
 * Pure given its inputs — unit-tested.
 */
const INFER_SLACK_BEFORE_MS = 1500;
const INFER_SLACK_AFTER_MS = 120000;

export function inferArtifacts(items, entries, { limit = MAX_ARTIFACTS_PER_SESSION } = {}) {
  const windows = [];
  let cur = null;
  for (const it of items || []) {
    if (!it || typeof it.ts !== 'number') continue;
    if (it.kind === 'user') { cur = { start: it.ts, end: it.ts }; windows.push(cur); }
    else if (cur && it.ts > cur.end) cur.end = it.ts;
  }
  if (!windows.length) return [];
  const out = [];
  for (const e of entries || []) {
    if (!e || typeof e.mtime !== 'number' || /\.conflict\d*/i.test(e.name || e.path || '')) continue;
    const w = windows.find((x) => e.mtime >= x.start - INFER_SLACK_BEFORE_MS && e.mtime <= x.end + INFER_SLACK_AFTER_MS);
    if (!w) continue;
    out.push({ path: e.path, ext: e.ext || '', size: e.size || 0, mtime: e.mtime, ts: w.end });
  }
  out.sort((x, y) => (x.ts - y.ts) || (x.mtime - y.mtime));
  return out.slice(-limit);
}

/** Recorded artifacts plus the inferred ones they do not already cover, oldest first. */
export function mergeArtifacts(recorded, inferred) {
  const seen = new Set((recorded || []).map((f) => f.path));
  return (recorded || []).concat((inferred || []).filter((f) => !seen.has(f.path)))
    .sort((x, y) => (x.ts || x.mtime || 0) - (y.ts || y.mtime || 0));
}

/** listSessions() with custom titles applied, pins first. */
export function decoratedSessions(list = listSessions()) {
  const out = list.map((s) => ({
    ...s,
    title: meta.titles[s.id] || s.title,
    autoTitle: s.title,
    pinned: meta.pinned.includes(s.id),
  }));
  return out.sort((a, b) => (b.pinned - a.pinned) || (b.updatedAt - a.updatedAt));
}

// ── Reading a transcript ─────────────────────────────────────────────────────
function readLines(id) {
  const file = sessionFile(id);
  if (!id || !existsSync(file)) return [];
  const out = [];
  for (const ln of readFileSync(file, 'utf8').split('\n')) {
    if (!ln.trim()) continue;
    try { out.push(JSON.parse(ln)); } catch {}
  }
  return out;
}

/** The text of a line if it is a prompt the human typed, else null. */
export function humanPromptText(obj) {
  if (obj?.type !== 'user' || obj.isMeta || obj.isSidechain || obj.isCompactSummary) return null;
  if (NON_HUMAN_ORIGIN_KINDS.has(obj.origin?.kind)) return null;
  const c = obj.message?.content;
  let text = '';
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c)) {
    if (c.some((b) => b.type === 'tool_result')) return null;
    text = c.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  }
  if (!text.trim() || isHarnessEcho(text) || parseTaskNotification(text)) return null;
  return text;
}

/**
 * The conversation's turns, oldest first: each human prompt (with the uuid
 * rewindFiles needs) and the file-tool calls made while answering it.
 * Pure given the parsed lines — unit-tested via turnsFromLines().
 */
export function turnsFromLines(lines) {
  const turns = [];
  let cur = null;
  for (const obj of lines) {
    const text = humanPromptText(obj);
    if (text != null) {
      cur = { uuid: obj.uuid, text: text.length > 300 ? `${text.slice(0, 300)}…` : text,
        ts: obj.timestamp ? Date.parse(obj.timestamp) || null : null, changes: [] };
      turns.push(cur);
      continue;
    }
    if (!cur || obj.type !== 'assistant' || obj.isSidechain) continue;
    for (const b of obj.message?.content || []) {
      if (b.type !== 'tool_use' || !FILE_TOOLS.has(b.name)) continue;
      const i = b.input || {};
      const file = i.file_path || i.notebook_path || null;
      if (!file) continue;
      const change = { tool: b.name, file };
      if (b.name === 'Write') change.content = String(i.content ?? '').slice(0, 20000);
      else if (b.name === 'Edit') change.edits = [{ old: String(i.old_string ?? ''), new: String(i.new_string ?? '') }];
      else if (b.name === 'MultiEdit') change.edits = (i.edits || []).map((e) => ({ old: String(e.old_string ?? ''), new: String(e.new_string ?? '') }));
      cur.changes.push(change);
    }
  }
  return turns;
}

export function listTurns(id) { return turnsFromLines(readLines(id)); }

// ── Search ───────────────────────────────────────────────────────────────────
/** Case-insensitive search of every conversation's prompts and replies. */
export function searchSessions(q, { limit = 40 } = {}) {
  const needle = String(q || '').trim().toLowerCase();
  if (needle.length < 2) return [];
  const results = [];
  for (const s of decoratedSessions()) {
    let hits = 0, snippet = null;
    for (const it of parseSession(s.id)) {
      if (it.kind !== 'user' && it.kind !== 'text') continue;
      const t = String(it.text || '');
      const i = t.toLowerCase().indexOf(needle);
      if (i === -1) continue;
      hits += 1;
      if (!snippet) {
        const a = Math.max(0, i - 60);
        snippet = `${a ? '…' : ''}${t.slice(a, i + needle.length + 80).replace(/\s+/g, ' ')}${i + needle.length + 80 < t.length ? '…' : ''}`;
      }
    }
    if (hits || s.title.toLowerCase().includes(needle)) {
      results.push({ id: s.id, title: s.title, updatedAt: s.updatedAt, hits, snippet: snippet || s.title });
    }
    if (results.length >= limit) break;
  }
  return results;
}

// ── Export ───────────────────────────────────────────────────────────────────
/** A readable Markdown transcript. Pure given the items — unit-tested. */
export function sessionToMarkdown(title, items) {
  const out = [`# ${title}`, ''];
  for (const it of items) {
    const when = it.ts ? ` _(${new Date(it.ts).toISOString().replace('T', ' ').slice(0, 16)})_` : '';
    if (it.kind === 'user') out.push(`## 🧑 Vous${when}`, '', it.text, '');
    else if (it.kind === 'text') out.push(`## 🤖 Claude${when}`, '', it.text, '');
    else if (it.kind === 'tool_use') {
      const target = it.input?.file_path || it.input?.command || it.input?.pattern || '';
      out.push(`> 🔧 \`${it.name}\`${target ? ` — \`${String(target).slice(0, 160).replace(/`/g, "'")}\`` : ''}`, '');
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

function slug(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'conversation';
}

export function exportSession(id, root) {
  const s = decoratedSessions().find((x) => x.id === id);
  if (!s) return { ok: false, error: 'No such conversation.' };
  const dir = path.join(root, 'Conversations');
  mkdirSync(dir, { recursive: true });
  const name = `${new Date(s.updatedAt || Date.now()).toISOString().slice(0, 10)}_${slug(s.title)}.md`;
  writeFileSync(path.join(dir, name), sessionToMarkdown(s.title, parseSession(id)));
  return { ok: true, path: `Conversations/${name}` };
}

// ── Duplicate ────────────────────────────────────────────────────────────────
export async function duplicateSession(id) {
  if (!existsSync(sessionFile(id))) return { ok: false, error: 'No such conversation.' };
  const res = await forkSession(id, { dir: WORK_DIR });
  const newId = res?.sessionId;
  if (!newId) return { ok: false, error: 'The copy could not be created.' };
  const src = decoratedSessions().find((x) => x.id === id);
  if (src) renameSession(newId, `${src.title} (copy)`);
  if (meta.artifacts[id]) { meta.artifacts[newId] = meta.artifacts[id].slice(); saveMeta(); }
  return { ok: true, id: newId };
}

// ── Rewind ───────────────────────────────────────────────────────────────────
/**
 * Restore the files a conversation changed to their state just before the
 * prompt `uuid`. `dryRun` reports what would change. Never while that
 * conversation is running (the caller checks).
 */
export async function rewindTo(sessionId, uuid, { dryRun = false, timeoutMs = 60000 } = {}) {
  if (!existsSync(sessionFile(sessionId))) return { canRewind: false, error: 'No such conversation.' };
  const ac = new AbortController();
  async function* idle() { await new Promise((r) => ac.signal.addEventListener('abort', r, { once: true })); }
  const q = query({ prompt: idle(), options: {
    cwd: WORK_DIR, resume: sessionId, enableFileCheckpointing: true, abortController: ac, settingSources: [],
    env: { ...process.env, SOUFASSISTANT_USAGE_PROBE: '1' },
  } });
  let timer;
  try {
    return await Promise.race([
      q.rewindFiles(uuid, { dryRun }),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timed out')), timeoutMs); }),
    ]);
  } catch (e) {
    return { canRewind: false, error: e?.message || String(e) };
  } finally {
    clearTimeout(timer);
    ac.abort();
    try { q.close(); } catch {}
  }
}
