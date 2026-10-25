/*
 * Chat / Code / Cowork — the three ways a turn can run, mirroring Claude
 * Desktop's tabs on top of the one engine a subscription login can use here
 * (the Agent SDK). They differ only in the SDK options a turn is built with:
 *
 *   code    the app as it always was: every tool, /config as the project,
 *           the HA plugins and CLAUDE.md files loaded.
 *   chat    a plain conversation: no file, shell or Home Assistant access —
 *           only web search/fetch — and no project instructions or plugins.
 *   cowork  Claude works *inside one workspace project folder*: it may read
 *           anywhere it could before, but every file it writes must land in
 *           that folder (a PreToolUse hook enforces it, in every permission
 *           mode), and it is told to build, run and test there and leave the
 *           deliverables for the artifact viewer.
 *
 * The cwd stays WORK_DIR in every mode on purpose: Claude Code keys its
 * transcript store on the cwd, so a different cwd per mode would split the
 * Sessions list in three and make a conversation unresumable after switching.
 *
 * Which mode (and project) each conversation last used is remembered in
 * SESSION_MODES_FILE so reopening it restores the selector.
 */
import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { SESSION_MODES_FILE, EDIT_TOOLS } from './config.js';
import { log } from './log.js';

export const MODES = ['chat', 'code', 'cowork'];
export const DEFAULT_MODE = 'code';

export function normalizeMode(m) {
  return MODES.includes(m) ? m : DEFAULT_MODE;
}

/** Tools a chat turn may use. Everything else is removed from the model's context. */
export const CHAT_TOOLS = ['WebSearch', 'WebFetch'];

export const CHAT_PROMPT = [
  'You are in **Chat mode** in Soufassistant: a plain conversation, like claude.ai.',
  'You have no access to files, the shell, Home Assistant or the workspace in this mode —',
  'only web search and web fetch. Answer directly in the conversation (markdown is rendered).',
  'If the user asks for something that needs files, code execution or the house,',
  'tell them to switch to Code mode (Home Assistant / config work) or Cowork mode (building',
  'documents, pages or small apps in a workspace project).',
].join(' ');

export function coworkPrompt(projectDirAbs, projectName) {
  return [
    `You are in **Cowork mode** in Soufassistant, working on the workspace project "${projectName}"`,
    `at ${projectDirAbs}.`,
    'Create, modify and test everything inside that folder: start Bash commands with',
    `\`cd "${projectDirAbs}"\`, and write files only there (writes elsewhere are blocked;`,
    '/tmp is allowed for scratch). You may read files elsewhere if needed.',
    'Build things so the user can see them: prefer self-contained HTML (inline CSS/JS),',
    'Markdown, SVG, images, CSV or PDF deliverables — every file you create or change in the',
    'workspace opens in the artifact viewer next to the chat. Run and test what you build',
    '(scripts, a headless check, a validator) before saying it works, and keep a short',
    'README.md in the project describing what is there.',
  ].join(' ');
}

export function workspacePrompt(root, activeProjectName) {
  return [
    `The user's workspace folder is ${root} (shown in the Workspace panel; synced to their`,
    'cloud drive when a sync is set up). Save anything they will want to open, keep or',
    'download there — not in /config — in the matching sub-folder.',
    activeProjectName ? `The current Cowork project is "${activeProjectName}".` : '',
    'Files written there appear in the artifact viewer next to the chat.',
  ].filter(Boolean).join(' ');
}

/**
 * The SDK option overrides for one turn. Pure — unit-tested.
 * `ctx`: { root, project, projectDir } (project/projectDir only for cowork).
 * Returns { opts, append, coworkDir } — `append` goes into the system prompt.
 */
export function modeOptions(mode, ctx = {}) {
  const m = normalizeMode(mode);
  const ws = workspacePrompt(ctx.root, ctx.project);
  if (m === 'chat') {
    // A plain string system prompt replaces Claude Code's coding-agent preset
    // entirely — this is a conversation, not an agent session.
    return { mode: m, opts: { tools: [...CHAT_TOOLS], settingSources: [], plugins: [] },
      systemPrompt: CHAT_PROMPT, append: CHAT_PROMPT, coworkDir: null };
  }
  if (m === 'cowork') {
    if (!ctx.projectDir) return { mode: m, error: 'Pick or create a project in the Workspace panel to use Cowork mode.' };
    return {
      mode: m,
      opts: { additionalDirectories: [ctx.projectDir] },
      append: `${ws}\n\n${coworkPrompt(ctx.projectDir, ctx.project)}`,
      coworkDir: ctx.projectDir,
    };
  }
  return { mode: m, opts: {}, append: ws, coworkDir: null };
}

/** True when `p` is `dir` itself or inside it (both absolute). */
export function isInside(p, dir) {
  const rp = path.resolve(p);
  const rd = path.resolve(dir);
  return rp === rd || rp.startsWith(rd.endsWith('/') ? rd : `${rd}/`);
}

/**
 * Cowork's write fence, as a PreToolUse hook so it holds in every permission
 * mode (including bypass/auto). Only file-writing tools are fenced; a relative
 * path resolves against the run's cwd, which is not the project — so it is
 * outside and refused, which is what tells the model to use absolute paths.
 */
export function coworkWriteGuard(projectDirAbs, cwd) {
  return async (input) => {
    const tool = input?.tool_name;
    if (!EDIT_TOOLS.has(tool)) return { continue: true };
    const ti = input?.tool_input || {};
    const target = ti.file_path || ti.notebook_path || ti.path;
    if (!target) return { continue: true };
    const abs = path.isAbsolute(target) ? target : path.resolve(cwd || '/', target);
    if (isInside(abs, projectDirAbs) || isInside(abs, '/tmp')) return { continue: true };
    return {
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          `Cowork mode: files can only be written inside the project folder ${projectDirAbs} ` +
          '(or /tmp). Use an absolute path inside it, or switch to Code mode for changes elsewhere.',
      },
    };
  };
}

// ── Per-session memory ───────────────────────────────────────────────────────
let sessionModes = {};

export function loadSessionModes() {
  try { sessionModes = JSON.parse(readFileSync(SESSION_MODES_FILE, 'utf8')) || {}; } catch { sessionModes = {}; }
}

export function rememberSessionMode(sessionId, mode, project) {
  if (!sessionId) return false;
  const prev = sessionModes[sessionId];
  const next = { mode: normalizeMode(mode), project: mode === 'cowork' ? (project || null) : (prev?.project || null) };
  if (prev && prev.mode === next.mode && prev.project === next.project) return false;
  sessionModes[sessionId] = next;
  try { writeFileSync(SESSION_MODES_FILE, JSON.stringify(sessionModes)); }
  catch (e) { log('WARN', `session modes not saved: ${e.message}`); }
  return true;
}

export function sessionModeMap() { return sessionModes; }
