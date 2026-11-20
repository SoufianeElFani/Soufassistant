/*
 * Memory review — Hermes Agent's "nudges", done here: every few turns of a
 * conversation, a short unattended pass re-reads it and saves what deserves
 * remembering (a preference, a decision, a fact about the house) into the
 * auto-memory the next conversations load (memory.js shows it in Hub › Memory).
 *
 * The pass is a *fork* of the conversation (resume + forkSession) that is not
 * persisted (persistSession: false): the conversation itself gets no extra
 * turn and the Sessions panel no extra entry. It may only touch the memory
 * folder (canUseTool below), and never runs for a confidential conversation —
 * the memory is loaded everywhere, pseudonyms and Equans work do not belong
 * in it. One pass at a time; a conversation is reviewed again only after
 * REVIEW_EVERY more turns. Setting: Hub › Memory (persisted, server-side,
 * because WhatsApp turns count too).
 */
import path from 'path';
import { existsSync, readFileSync } from 'fs';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { WORK_DIR, DATA_DIR } from './config.js';
import { writeFileAtomic } from './atomic.js';
import { MCP_FREE_SETTINGS } from './mcp.js';
import { listMemory, memoryDir } from './memory.js';
import { broadcast } from './broadcast.js';
import { log } from './log.js';

const FILE = () => path.join(DATA_DIR, 'memory-review.json');
export const REVIEW_EVERY = parseInt(process.env.MEMORY_REVIEW_EVERY || '6', 10);
const REVIEW_TIMEOUT_MS = 4 * 60 * 1000;

export const reviewSettings = { enabled: true };
const pending = new Map();   // sessionId → turns since its last review
let busy = false;

export function load() {
  try { if (existsSync(FILE())) reviewSettings.enabled = JSON.parse(readFileSync(FILE(), 'utf8')).enabled !== false; } catch {}
}
export function setEnabled(on) {
  reviewSettings.enabled = !!on;
  try { writeFileAtomic(FILE(), JSON.stringify(reviewSettings)); } catch (e) { log('WARN', `memory review: ${e.message}`); }
  return { ok: true, enabled: reviewSettings.enabled };
}

export const REVIEW_PROMPT = [
  'Memory review (automatic, unattended — nobody will read this reply).',
  'Re-read this conversation and decide whether it taught you something worth keeping for FUTURE conversations:',
  'a lasting preference or way of working the user asked for, a decision, a fact about the user, their house or',
  'their projects that is not obvious from the files. Ignore what only mattered for this task, what is already in',
  'your memory, and anything confidential (Equans clients, pseudonyms like Client-A or Personne-03, the Confidentiel',
  'folders) — never write those. If something qualifies, save or update it in your memory folder following your',
  'memory rules (one fact per file with its front matter, a one-line pointer in MEMORY.md; update an existing file',
  'rather than duplicating it). If nothing qualifies, change nothing. Then answer with one short line.',
].join(' ');

/** Pure. Whether a tool call stays inside the memory folder. */
export function memoryOnly(toolName, input, dir) {
  if (!['Read', 'Write', 'Edit', 'Glob', 'Grep', 'LS'].includes(toolName)) return false;
  const p = String(input?.file_path || input?.path || dir);
  const abs = path.resolve(dir, p);
  return abs === dir || abs.startsWith(dir + path.sep);
}

const snapshot = () => Object.fromEntries((listMemory().facts || []).map((f) => [f.file, `${f.title}|${f.description}|${f.body}`]));

async function review(sessionId) {
  busy = true;
  const dir = memoryDir();
  const before = snapshot();
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), REVIEW_TIMEOUT_MS);
  try {
    const q = query({
      prompt: REVIEW_PROMPT,
      options: {
        cwd: WORK_DIR, abortController, resume: sessionId, forkSession: true, persistSession: false,
        settings: MCP_FREE_SETTINGS, tools: ['Read', 'Write', 'Edit', 'Glob'], maxTurns: 12,
        canUseTool: async (toolName, input) => (memoryOnly(toolName, input, dir)
          ? { behavior: 'allow', updatedInput: input }
          : { behavior: 'deny', message: `Memory review: only ${dir} may be read or written.` }),
      },
    });
    for await (const _ of q) { /* drain */ }
  } catch (e) {
    if (!abortController.signal.aborted) log('WARN', `memory review failed: ${e?.message || e}`);
  } finally {
    clearTimeout(timer);
    busy = false;
  }
  const after = snapshot();
  const changed = Object.keys(after).filter((f) => after[f] !== before[f]).map((f) => after[f].split('|')[0]);
  if (changed.length) {
    log('INFO', `memory review: ${changed.length} memor${changed.length > 1 ? 'ies' : 'y'} saved`);
    broadcast({ type: 'memory_reviewed', titles: changed });
  }
}

/**
 * A turn of an eligible conversation ended (run-query.js, whatsapp-bridge.js).
 * `turns`: how many replies it produced. Never throws, never awaited.
 */
export function afterRun({ sessionId, turns = 1, confidential = false }) {
  if (!reviewSettings.enabled || !sessionId || confidential) return;
  const n = (pending.get(sessionId) || 0) + turns;
  if (n < REVIEW_EVERY || busy) { pending.set(sessionId, n); return; }
  pending.set(sessionId, 0);
  review(sessionId).catch((e) => log('WARN', `memory review: ${e?.message || e}`));
}
