/*
 * The workspace — a folder separate from the live Home Assistant config, for
 * anything Claude produces that the user will want to keep, open, or reopen:
 * a report, a generated image, a data export, a self-contained HTML page, a
 * small app. Files are served read-only at `/workspace/<relPath>` and listed at
 * `/api/workspace`; the Workspace panel and the artifact viewer render them.
 *
 * The root is configurable from the Workspace panel (persisted in
 * WORKSPACE_CONFIG_FILE) instead of being fixed at /data/workspace — e.g. a
 * folder another tool keeps in sync with a cloud drive. Its top-level
 * sub-folders are **projects**: Cowork mode works inside one of them.
 *
 * Optional sync status: when a sync log exists (default: the rclone bisync log
 * written by /data/tools/drive-sync.sh) the panel shows the last success /
 * error and counts `*.conflict*` files. Nothing here runs the sync itself.
 */
import { existsSync, mkdirSync, readdirSync, statSync, readFileSync, writeFileSync, realpathSync, openSync, readSync, closeSync, unlinkSync } from 'fs';
import path from 'path';
import { WORKSPACE_DIR, WORKSPACE_CONFIG_FILE, WORKSPACE_SYNC_LOG } from './config.js';
import { log } from './log.js';

export const MAX_ENTRIES = 500;

/** Where a workspace root may live. /config is HA's config; .storage never. */
export const ALLOWED_ROOT_PREFIXES = ['/config/', '/data/', '/share/', '/media/'];

const cfg = { root: null, activeProject: null, syncLog: null };

export function loadWorkspaceConfig() {
  try {
    const d = JSON.parse(readFileSync(WORKSPACE_CONFIG_FILE, 'utf8'));
    cfg.root = typeof d.root === 'string' ? d.root : null;
    cfg.activeProject = typeof d.activeProject === 'string' ? d.activeProject : null;
    cfg.syncLog = typeof d.syncLog === 'string' ? d.syncLog : null;
  } catch { /* first run, or unreadable — defaults */ }
}

function saveConfig() {
  try { writeFileSync(WORKSPACE_CONFIG_FILE, JSON.stringify(cfg, null, 2)); }
  catch (e) { log('WARN', `workspace config not saved: ${e.message}`); }
}

/** The current root (the configured one, else /data/workspace). */
export function workspaceRoot() {
  return cfg.root || WORKSPACE_DIR;
}

export function ensureWorkspaceDir() {
  try { mkdirSync(workspaceRoot(), { recursive: true }); } catch {}
}

/**
 * Validate a requested root. Pure apart from realpath (a symlink is judged by
 * where it points). Returns { ok, root } or { ok:false, error }.
 */
export function validateRoot(p, { prefixes = ALLOWED_ROOT_PREFIXES } = {}) {
  if (typeof p !== 'string' || !p.trim()) return { ok: false, error: 'Enter a folder path.' };
  if (!path.isAbsolute(p.trim())) return { ok: false, error: 'Use an absolute path, e.g. /config/My_Work.' };
  let root = path.resolve(p.trim());
  try { root = realpathSync(root); } catch { /* does not exist yet — judged as typed */ }
  const withSlash = root.endsWith('/') ? root : `${root}/`;
  if (!prefixes.some((pre) => withSlash.startsWith(pre) && withSlash !== pre)) {
    return { ok: false, error: `The folder must be inside ${prefixes.map((x) => x.slice(0, -1)).join(', ')}.` };
  }
  if (/\/\.storage(\/|$)/.test(root) || root.startsWith('/data/secrets')) {
    return { ok: false, error: 'That folder holds Home Assistant / app internals — pick another one.' };
  }
  return { ok: true, root };
}

export function setRoot(p) {
  const v = validateRoot(p);
  if (!v.ok) return v;
  try { mkdirSync(v.root, { recursive: true }); } catch (e) { return { ok: false, error: e.message }; }
  cfg.root = v.root === WORKSPACE_DIR ? null : v.root;
  if (cfg.activeProject && !existsSync(path.join(workspaceRoot(), cfg.activeProject))) cfg.activeProject = null;
  saveConfig();
  log('INFO', `workspace root → ${workspaceRoot()}`);
  return { ok: true, root: workspaceRoot() };
}

/** A project name usable as a folder name. Null when unusable. */
export function sanitizeProjectName(name) {
  const n = String(name || '').trim().replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ');
  if (!n || n.startsWith('.') || n.length > 80) return null;
  return n;
}

export function listProjects(root = workspaceRoot()) {
  let names = [];
  try {
    names = readdirSync(root, { withFileTypes: true })
      .filter((d) => (d.isDirectory() || d.isSymbolicLink()) && !d.name.startsWith('.'))
      .map((d) => d.name)
      .filter((n) => { try { return statSync(path.join(root, n)).isDirectory(); } catch { return false; } });
  } catch { return []; }
  return names.sort((a, b) => a.localeCompare(b)).map((name) => ({ name }));
}

export function createProject(name) {
  const n = sanitizeProjectName(name);
  if (!n) return { ok: false, error: 'Invalid project name.' };
  const dir = path.join(workspaceRoot(), n);
  try { mkdirSync(dir, { recursive: true }); } catch (e) { return { ok: false, error: e.message }; }
  return { ok: true, name: n };
}

export function setActiveProject(name) {
  if (name == null || name === '') { cfg.activeProject = null; saveConfig(); return { ok: true, activeProject: null }; }
  if (!projectDir(name)) return { ok: false, error: 'No such project.' };
  cfg.activeProject = sanitizeProjectName(name);
  saveConfig();
  return { ok: true, activeProject: cfg.activeProject };
}

export function activeProject() { return cfg.activeProject; }

/** Absolute folder of a project, or null if it does not exist / is not one. */
export function projectDir(name) {
  const n = sanitizeProjectName(name);
  if (!n) return null;
  const dir = path.join(workspaceRoot(), n);
  try { return statSync(dir).isDirectory() ? dir : null; } catch { return null; }
}

/**
 * Resolve a URL-relative path inside the root, refusing anything that escapes
 * it (`..`, absolute paths).
 */
export function resolveInWorkspace(rel, root = workspaceRoot()) {
  const clean = path.normalize(`/${String(rel || '')}`).replace(/^\/+/, '');
  const abs = path.join(root, clean);
  if (abs !== root && !abs.startsWith(root.endsWith('/') ? root : `${root}/`)) return null;
  return abs;
}

/**
 * Recursively list files under the root (not directories themselves — the UI
 * only needs leaves to link to). Dotfiles/dotdirs and node_modules are skipped.
 * Capped so a runaway write loop cannot hand the browser an enormous payload.
 */
export function listWorkspaceEntries(root = workspaceRoot()) {
  const entries = [];
  if (!existsSync(root)) return entries;

  const walk = (dir, relDir, depth) => {
    if (entries.length >= MAX_ENTRIES || depth > 12) return;
    let names;
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names.sort()) {
      if (name.startsWith('.')) continue;
      if (entries.length >= MAX_ENTRIES) return;
      const abs = path.join(dir, name);
      const rel = relDir ? `${relDir}/${name}` : name;
      let st;
      try { st = statSync(abs); } catch { continue; }
      if (st.isDirectory()) { if (name !== 'node_modules') walk(abs, rel, depth + 1); continue; }
      if (!st.isFile()) continue;
      entries.push({
        path: rel,
        name,
        size: st.size,
        mtime: st.mtimeMs,
        ext: path.extname(name).replace(/^\./, '').toLowerCase(),
      });
    }
  };
  walk(root, '', 0);
  entries.sort((a, b) => b.mtime - a.mtime);
  return entries;
}

/** Read the last `bytes` of a file without loading all of it. */
function tail(file, bytes = 64 * 1024) {
  const st = statSync(file);
  const len = Math.min(bytes, st.size);
  const buf = Buffer.alloc(len);
  const fd = openSync(file, 'r');
  try { readSync(fd, buf, 0, len, st.size - len); } finally { closeSync(fd); }
  return buf.toString('utf8');
}

const LOG_TS = /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})/;
function lineTime(line) {
  const m = LOG_TS.exec(line);
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : null;
}

/**
 * Summarize an rclone log: the last success and, if it came after that, the
 * last error. Pure — unit-tested.
 */
export function parseSyncLog(text) {
  let lastOk = null, lastError = null, lastErrorText = null;
  for (const line of String(text).split('\n')) {
    const t = lineTime(line);
    if (!t) continue;
    if (/Bisync successful|Sync successful/i.test(line)) lastOk = t;
    if (/\bERROR\b|Failed to bisync|Bisync aborted/i.test(line)) {
      lastError = t;
      lastErrorText = line.replace(LOG_TS, '').replace(/\x1b\[[0-9;]*m/g, '').trim().slice(0, 200);
    }
  }
  const failing = lastError != null && (lastOk == null || lastError > lastOk);
  return { lastOk, lastError: failing ? lastError : null, lastErrorText: failing ? lastErrorText : null };
}

export function countConflicts(entries) {
  return entries.filter((e) => /\.conflict\d*/i.test(e.name)).length;
}

export function syncStatus(entries = null) {
  const file = cfg.syncLog || WORKSPACE_SYNC_LOG;
  if (!file || !existsSync(file)) return { available: false };
  try {
    const st = statSync(file);
    const parsed = parseSyncLog(tail(file));
    // rclone's NOTICE-level log only gains lines on changes/errors, so the
    // file's mtime is not a liveness signal; report it as "last activity".
    return { available: true, label: 'Google Drive (rclone)', lastActivity: st.mtimeMs, ...parsed,
      conflicts: countConflicts(entries || listWorkspaceEntries()) };
  } catch (e) {
    return { available: false, error: e.message };
  }
}

/** Everything the Workspace panel needs, in one message. */
export function workspaceState() {
  const entries = listWorkspaceEntries();
  return {
    root: workspaceRoot(),
    defaultRoot: WORKSPACE_DIR,
    activeProject: cfg.activeProject,
    projects: listProjects(),
    sync: syncStatus(entries),
  };
}

// ── Editing (the artifact viewer's editor) ───────────────────────────────────
/** Extensions the editor may write — text only; binary files are view/download only. */
export const EDITABLE_EXT = new Set(['txt', 'md', 'markdown', 'html', 'htm', 'css', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx',
  'json', 'yaml', 'yml', 'csv', 'tsv', 'svg', 'xml', 'py', 'sh', 'ini', 'conf', 'toml', 'sql', 'log', 'env', 'gitignore', 'vue']);
export const MAX_EDIT_BYTES = 2 * 1024 * 1024;

export function isEditable(rel) {
  const base = path.basename(String(rel || ''));
  const ext = base.includes('.') ? base.split('.').pop().toLowerCase() : base.toLowerCase();
  return EDITABLE_EXT.has(ext);
}

function checkTarget(rel) {
  if (!rel || String(rel).split('/').some((seg) => seg.startsWith('.'))) return { error: 'Hidden files cannot be edited here.' };
  const abs = resolveInWorkspace(rel);
  if (!abs || abs === workspaceRoot()) return { error: 'That path is outside the workspace.' };
  if (!isEditable(rel)) return { error: 'Only text files can be edited here.' };
  return { abs };
}

/**
 * Save a text file. `expectedMtime` (from when the editor loaded it) guards
 * against overwriting a change made meanwhile — by Claude, or the Drive sync —
 * unless `force`. `create` refuses to replace an existing file.
 */
export function writeWorkspaceFile(rel, content, { expectedMtime = null, force = false, create = false } = {}) {
  const t = checkTarget(rel);
  if (t.error) return { ok: false, error: t.error };
  const text = String(content ?? '');
  if (Buffer.byteLength(text) > MAX_EDIT_BYTES) return { ok: false, error: 'File too large for the editor (2 MB max).' };
  let cur = null;
  try { cur = statSync(t.abs); } catch {}
  if (cur && create) return { ok: false, error: 'A file with that name already exists.' };
  if (cur && !cur.isFile()) return { ok: false, error: 'Not a file.' };
  if (cur && expectedMtime && !force && Math.abs(cur.mtimeMs - expectedMtime) > 1) {
    return { ok: false, conflict: true, error: 'The file changed since you opened it.' };
  }
  try {
    mkdirSync(path.dirname(t.abs), { recursive: true });
    writeFileSync(t.abs, text);
    return { ok: true, path: rel, mtime: statSync(t.abs).mtimeMs };
  } catch (e) { return { ok: false, error: e.message }; }
}

export function statWorkspaceFile(rel) {
  const abs = resolveInWorkspace(rel);
  try { const st = statSync(abs); return st.isFile() ? { mtime: st.mtimeMs, size: st.size } : null; } catch { return null; }
}

export function deleteWorkspaceFile(rel) {
  if (!rel || String(rel).split('/').some((seg) => seg.startsWith('.'))) return { ok: false, error: 'Not allowed.' };
  const abs = resolveInWorkspace(rel);
  if (!abs || abs === workspaceRoot()) return { ok: false, error: 'That path is outside the workspace.' };
  try {
    if (!statSync(abs).isFile()) return { ok: false, error: 'Only files can be deleted here.' };
    unlinkSync(abs);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}
