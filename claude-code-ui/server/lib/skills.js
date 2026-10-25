/*
 * The Skills panel's backend: discover every skill the agent can load, let the
 * user switch any of them off, and create / edit / delete their own.
 *
 * Three sources, listed in this order:
 *   account  ~/.claude/skills/synced/<bucket>/<skill>/SKILL.md — the skills
 *            enabled on the user's claude.ai account, synced down by the CLI
 *            itself (read-only here; managed on claude.ai).
 *   plugin   <plugin>/skills/<skill>/SKILL.md for the plugins this app loads
 *            (read-only; they ship with the app).
 *   local    ~/.claude/skills/<skill>/SKILL.md — the user's own, editable here.
 *
 * Turning a skill off is applied per run through the inline `settings` object
 * as `skillOverrides: { <name>: "off" }` (see disabledOverrides()). That is a
 * listing filter keyed by skill name: a key that does not match anything is
 * simply ignored, so a wrong guess at a name can never hide another skill.
 * Both the bare name and the invocation name the CLI reported (e.g.
 * `anthropic-skills:pptx`, from the init event's slash commands) are written.
 *
 * There is no public API to *upload* a skill to a claude.ai account; the
 * panel exports any skill as a .zip to upload at claude.ai → Settings →
 * Capabilities, after which it syncs back down here as an account skill.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, statSync } from 'fs';
import path from 'path';
import { USER_SKILLS_DIR, SKILLS_CONFIG_FILE, PLUGINS } from './config.js';
import { runtime } from './state.js';
import { log } from './log.js';

const state = { disabled: new Set() };

export function loadSkillsConfig() {
  try {
    const d = JSON.parse(readFileSync(SKILLS_CONFIG_FILE, 'utf8'));
    state.disabled = new Set(Array.isArray(d.disabled) ? d.disabled : []);
  } catch { state.disabled = new Set(); }
}

function saveConfig() {
  try { writeFileSync(SKILLS_CONFIG_FILE, JSON.stringify({ disabled: [...state.disabled].sort() }, null, 2)); }
  catch (e) { log('WARN', `skills config not saved: ${e.message}`); }
}

/**
 * Parse SKILL.md's YAML front matter — only the flat `key: value` subset skills
 * use (quoted or not, plus `>`/`|` folded blocks). Pure — unit-tested.
 * Returns { meta: {name, description, ...}, body }.
 */
export function parseSkillMd(text) {
  const src = String(text || '').replace(/^﻿/, '');
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src);
  if (!m) return { meta: {}, body: src };
  const meta = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let [, key, val] = kv;
    if (val === '>' || val === '|' || val === '>-' || val === '|-') {
      const block = [];
      while (i + 1 < lines.length && /^\s+/.test(lines[i + 1])) block.push(lines[++i].trim());
      val = val.startsWith('>') ? block.join(' ') : block.join('\n');
    } else if (/^".*"$/.test(val)) {
      try { val = JSON.parse(val); } catch { val = val.slice(1, -1); }
    } else if (/^'.*'$/.test(val)) {
      val = val.slice(1, -1).replace(/''/g, "'");
    }
    meta[key] = val;
  }
  return { meta, body: src.slice(m[0].length) };
}

/** A local skill name: lowercase letters, digits, hyphens (what claude.ai accepts). */
export function sanitizeSkillName(name) {
  const n = String(name || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-');
  return n && n.length <= 64 ? n : null;
}

/** Build a SKILL.md from form fields. Pure — unit-tested. */
export function buildSkillMd({ name, description, body }) {
  const desc = String(description || '').replace(/\s+/g, ' ').trim();
  return `---\nname: ${name}\ndescription: ${JSON.stringify(desc)}\n---\n\n${String(body || '').trim()}\n`;
}

function readSkillDir(dir, source, extra = {}) {
  const file = path.join(dir, 'SKILL.md');
  if (!existsSync(file)) return null;
  let meta = {};
  try { ({ meta } = parseSkillMd(readFileSync(file, 'utf8'))); } catch {}
  const folder = path.basename(dir);
  const name = meta.name || folder;
  return {
    id: `${source}:${extra.plugin ? `${extra.plugin}:` : ''}${folder}`,
    source, name, folder, dir,
    description: meta.description || '',
    plugin: extra.plugin || null,
    editable: source === 'local',
  };
}

function subdirs(dir) {
  try { return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name).sort(); }
  catch { return []; }
}

/** Everything discoverable, before applying the on/off state. */
export function discoverSkills({ userDir = USER_SKILLS_DIR, plugins = PLUGINS } = {}) {
  const out = [];
  const syncedRoot = path.join(userDir, 'synced');
  let lastSync = null;
  for (const bucket of subdirs(syncedRoot)) {
    const bdir = path.join(syncedRoot, bucket);
    try { lastSync = Math.max(lastSync || 0, JSON.parse(readFileSync(path.join(bdir, 'manifest.json'), 'utf8')).lastUpdated || 0) || lastSync; } catch {}
    for (const s of subdirs(bdir)) { const k = readSkillDir(path.join(bdir, s), 'account'); if (k) out.push(k); }
  }
  for (const p of plugins) {
    let pname = path.basename(p.path);
    try { pname = JSON.parse(readFileSync(path.join(p.path, '.claude-plugin', 'plugin.json'), 'utf8')).name || pname; } catch {}
    for (const s of subdirs(path.join(p.path, 'skills'))) {
      const k = readSkillDir(path.join(p.path, 'skills', s), 'plugin', { plugin: pname });
      if (k) out.push(k);
    }
  }
  for (const s of subdirs(userDir)) {
    if (s === 'synced') continue;
    const k = readSkillDir(path.join(userDir, s), 'local');
    if (k) out.push(k);
  }
  return { skills: out, lastSync };
}

/** The name the CLI invokes a skill by, when it reported one (e.g. "anthropic-skills:pptx"). */
export function invocationName(skill, slashCommands = runtime.cachedSlashCommands || []) {
  const names = (slashCommands || []).map((c) => (typeof c === 'string' ? c : c?.name)).filter(Boolean);
  if (skill.plugin) {
    const q = `${skill.plugin}:${skill.name}`;
    if (names.includes(q)) return q;
  }
  if (names.includes(skill.name)) return skill.name;
  return names.find((n) => n.endsWith(`:${skill.name}`)) || (skill.plugin ? `${skill.plugin}:${skill.name}` : skill.name);
}

/** The panel's listing: discovered skills + on/off + invocation name. */
export function listSkills() {
  const { skills, lastSync } = discoverSkills();
  return {
    lastSync,
    skills: skills.map(({ dir, ...s }) => ({ ...s, invocation: invocationName(s), enabled: !state.disabled.has(s.id) })),
  };
}

export function setSkillEnabled(id, enabled) {
  if (enabled) state.disabled.delete(id); else state.disabled.add(id);
  saveConfig();
}

/**
 * `skillOverrides` for the run's inline settings, or null when nothing is off.
 * Pure given its inputs — unit-tested.
 */
export function disabledOverrides(skills = discoverSkills().skills, disabled = state.disabled, slashCommands = runtime.cachedSlashCommands) {
  const o = {};
  for (const s of skills) {
    if (!disabled.has(s.id)) continue;
    o[s.name] = 'off';
    o[invocationName(s, slashCommands)] = 'off';
  }
  return Object.keys(o).length ? o : null;
}

export function findSkill(id) {
  return discoverSkills().skills.find((s) => s.id === id) || null;
}

export function readSkill(id) {
  const s = findSkill(id);
  if (!s) return null;
  const text = readFileSync(path.join(s.dir, 'SKILL.md'), 'utf8');
  const { meta, body } = parseSkillMd(text);
  return { id: s.id, source: s.source, name: meta.name || s.name, description: meta.description || '', body, editable: s.editable };
}

/** Create or update a local skill. `id` set = editing that one (may rename). */
export function saveLocalSkill({ id, name, description, body }, userDir = USER_SKILLS_DIR) {
  const n = sanitizeSkillName(name);
  if (!n) return { ok: false, error: 'Name: lowercase letters, digits and hyphens only.' };
  if (!String(description || '').trim()) return { ok: false, error: 'A description is required — it is how Claude knows when to use the skill.' };
  const dir = path.join(userDir, n);
  let prevDir = null;
  if (id) {
    const prev = findSkill(id);
    if (!prev || prev.source !== 'local') return { ok: false, error: 'Only your own (local) skills can be edited.' };
    prevDir = prev.dir;
  }
  if (n === 'synced') return { ok: false, error: 'That name is reserved.' };
  if ((!prevDir || prevDir !== dir) && existsSync(dir)) return { ok: false, error: `A skill named "${n}" already exists.` };
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'SKILL.md'), buildSkillMd({ name: n, description, body }));
  if (prevDir && prevDir !== dir) {
    // Renamed: carry over any other files, then drop the old folder.
    for (const f of readdirSync(prevDir)) {
      if (f === 'SKILL.md') continue;
      try { writeFileSync(path.join(dir, f), readFileSync(path.join(prevDir, f))); } catch {}
    }
    rmSync(prevDir, { recursive: true, force: true });
    if (state.disabled.delete(id)) { state.disabled.add(`local:${n}`); saveConfig(); }
  }
  return { ok: true, id: `local:${n}` };
}

export function deleteLocalSkill(id) {
  const s = findSkill(id);
  if (!s || s.source !== 'local') return { ok: false, error: 'Only your own (local) skills can be deleted.' };
  rmSync(s.dir, { recursive: true, force: true });
  if (state.disabled.delete(id)) saveConfig();
  return { ok: true };
}

/** Folder to zip for export (any source). */
export function skillDirFor(id) {
  const s = findSkill(id);
  if (!s) return null;
  try { return statSync(s.dir).isDirectory() ? { dir: s.dir, folder: s.folder } : null; } catch { return null; }
}
