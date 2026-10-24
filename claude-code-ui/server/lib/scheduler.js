/*
 * Scheduled tasks — a local analogue of a hosted "run this prompt on a
 * schedule" feature: a persisted list of {name, cron, prompt}, ticked against
 * the clock, each firing an unattended turn.
 *
 * Deliberately NOT run through run-query.js / the single shared conversation:
 * this app models one visible chat at a time (see CLAUDE.md's "Conversation
 * Persistence"), and a scheduled prompt firing into whatever the user happens
 * to be chatting about right now — or aborting a run already in progress,
 * which run-query.js's abortActive() would do — would be exactly wrong. So a
 * scheduled run calls the SDK directly, as its own query with its own (resumable)
 * session id, and never touches `runtime.activeSessionId` or broadcasts into
 * the visible transcript. It still writes to Claude Code's ordinary on-disk
 * session store, so a run is always inspectable afterwards from the Sessions
 * panel — it just doesn't interrupt whatever is on screen while it happens.
 * The result reaches the user through the same Home Assistant notification
 * path as everything else in notify.js, plus a one-line summary kept on the
 * entry itself for the Scheduled panel.
 *
 * Only one run — scheduled or interactive — proceeds at a time: a tick that
 * lands while the chat is busy simply tries again next tick; nothing queues.
 */
import { randomUUID } from 'crypto';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { query } from '@anthropic-ai/claude-agent-sdk';
import {
  WORK_DIR, PLUGINS, SCHEDULED_FILE, SCHEDULER_TICK_MS, SCHEDULED_RUN_TIMEOUT_MS,
} from './config.js';
import { log } from './log.js';
import { broadcast } from './broadcast.js';
import { runtime } from './state.js';
import { ADDON_CONFIGS_HOOKS } from './permissions.js';
import { MCP_FREE_SETTINGS } from './mcp.js';
import { notify } from './notify.js';
import { isValidCronExpr, matchesCron } from './cron.js';

export const MAX_SCHEDULED = 20;
export const scheduledState = { tasks: [] };

let timer = null;
const firedThisMinute = new Map();   // id → the minute key it already fired for

function minuteKey(d) { return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}-${d.getHours()}-${d.getMinutes()}`; }

export function load() {
  try {
    if (existsSync(SCHEDULED_FILE)) {
      const d = JSON.parse(readFileSync(SCHEDULED_FILE, 'utf8'));
      if (Array.isArray(d.tasks)) scheduledState.tasks = d.tasks.filter((t) => t && typeof t.id === 'string');
    }
  } catch (e) { console.warn('Could not load scheduled tasks:', e.message); }
}

function save() {
  try { writeFileSync(SCHEDULED_FILE, JSON.stringify(scheduledState)); }
  catch (e) { console.warn('Could not save scheduled tasks:', e.message); }
}

/** The SDK resume id is an internal handle, not something the browser needs. */
function publicEntry({ lastSessionId, ...rest }) { return rest; }
export function list() { return scheduledState.tasks.map(publicEntry); }

function broadcastList() { broadcast({ type: 'scheduled_tasks', tasks: list() }); }

export function upsert(input) {
  const name = String(input?.name || '').trim().slice(0, 100);
  const cron = String(input?.cron || '').trim();
  const prompt = String(input?.prompt || '').trim().slice(0, 4000);
  if (!name) throw new Error('A name is required.');
  if (!prompt) throw new Error('A prompt is required.');
  if (!isValidCronExpr(cron)) throw new Error('Invalid schedule — expects 5 fields: minute hour day-of-month month day-of-week.');
  const enabled = input?.enabled !== false;

  if (input?.id) {
    const existing = scheduledState.tasks.find((t) => t.id === input.id);
    if (!existing) throw new Error('Unknown scheduled task.');
    Object.assign(existing, { name, cron, prompt, enabled });
    save();
    broadcastList();
    return publicEntry(existing);
  }
  if (scheduledState.tasks.length >= MAX_SCHEDULED) {
    throw new Error(`You already have ${MAX_SCHEDULED} scheduled tasks — delete one first.`);
  }
  const entry = {
    id: randomUUID(), name, cron, prompt, enabled,
    createdAt: Date.now(), lastRunAt: null, lastStatus: null, lastSummary: '', lastSessionId: null,
  };
  scheduledState.tasks.push(entry);
  save();
  broadcastList();
  return publicEntry(entry);
}

export function remove(id) {
  const before = scheduledState.tasks.length;
  scheduledState.tasks = scheduledState.tasks.filter((t) => t.id !== id);
  firedThisMinute.delete(id);
  if (scheduledState.tasks.length !== before) { save(); broadcastList(); }
}

/** Nobody is there to answer — allow every ordinary tool (still subject to the
 *  /addon_configs guard via ADDON_CONFIGS_HOOKS) and decline questions rather
 *  than hang waiting for an answer that will never come. */
function scheduledCanUseTool(toolName, input) {
  if (toolName === 'AskUserQuestion') {
    return Promise.resolve({
      behavior: 'deny',
      message: 'This is an unattended scheduled run — nobody can answer questions right now. ' +
        'Use your best judgement and continue; mention anything you were unsure about in your reply.',
    });
  }
  return Promise.resolve({ behavior: 'allow', updatedInput: input });
}

async function fireEntry(entry, { manual = false } = {}) {
  if (runtime.activeQuery) {
    if (manual) broadcast({ type: 'scheduled_run_busy', id: entry.id });
    else log('INFO', `scheduled task "${entry.name}" skipped this tick — a run is already in progress`);
    return false;
  }

  entry.lastRunAt = Date.now();
  entry.lastStatus = 'running';
  save();
  broadcastList();
  log('INFO', `scheduled task "${entry.name}" firing${manual ? ' (run now)' : ''}`);

  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), SCHEDULED_RUN_TIMEOUT_MS);

  let text = '';
  let sessionId = entry.lastSessionId || null;
  let success = false;
  let errorMsg = null;

  const opts = { cwd: WORK_DIR, abortController, plugins: PLUGINS, settings: MCP_FREE_SETTINGS, canUseTool: scheduledCanUseTool };
  if (ADDON_CONFIGS_HOOKS) opts.hooks = ADDON_CONFIGS_HOOKS;
  // Resume the same thread each time this entry fires, so a daily check-in
  // genuinely continues yesterday's rather than starting from nothing.
  if (entry.lastSessionId) opts.resume = entry.lastSessionId;

  try {
    const q = query({ prompt: entry.prompt, options: opts });
    for await (const event of q) {
      if (event.type === 'system' && event.subtype === 'init') {
        sessionId = event.session_id;
      } else if (event.type === 'assistant') {
        for (const block of (event.message?.content || [])) {
          if (block.type === 'text' && block.text) text += block.text;
        }
      } else if (event.type === 'result') {
        success = event.subtype === 'success';
      }
    }
  } catch (err) {
    errorMsg = String(err?.message || err);
  } finally {
    clearTimeout(timeoutId);
  }

  const timedOut = abortController.signal.aborted;
  const status = timedOut ? 'timeout' : errorMsg ? 'error' : success ? 'success' : 'error';
  const summary = timedOut
    ? `No reply after ${Math.round(SCHEDULED_RUN_TIMEOUT_MS / 60000)} minutes — stopped.`
    : errorMsg || text.trim().slice(0, 300) || '(no reply text)';

  entry.lastSessionId = sessionId;
  entry.lastStatus = status;
  entry.lastSummary = summary.slice(0, 300);
  save();
  broadcastList();

  // 'reply' / 'stopped' mirror run-query.js's own notify() kinds for a
  // finished vs. a failed turn, so the same per-kind settings in notify.js apply.
  notify(status === 'success' ? 'reply' : 'stopped', {
    title: status === 'success' ? `Scheduled task finished: ${entry.name}` : `Scheduled task failed: ${entry.name}`,
    message: entry.lastSummary,
  });
  log('INFO', `scheduled task "${entry.name}" ${status} in ${Math.round((Date.now() - entry.lastRunAt) / 1000)}s`);
  return true;
}

export function runNow(id) {
  const entry = scheduledState.tasks.find((t) => t.id === id);
  if (!entry) return false;
  fireEntry(entry, { manual: true }).catch((e) => log('ERROR', `scheduled task "${entry.name}" crashed: ${e?.message || e}`));
  return true;
}

function tick() {
  const now = new Date();
  const key = minuteKey(now);
  for (const entry of scheduledState.tasks) {
    if (!entry.enabled || !isValidCronExpr(entry.cron)) continue;
    if (firedThisMinute.get(entry.id) === key) continue;
    if (!matchesCron(now, entry.cron)) continue;
    firedThisMinute.set(entry.id, key);
    fireEntry(entry).catch((e) => log('ERROR', `scheduled task "${entry.name}" crashed: ${e?.message || e}`));
  }
  for (const id of firedThisMinute.keys()) {
    if (!scheduledState.tasks.some((t) => t.id === id)) firedThisMinute.delete(id);
  }
}

export function start() {
  if (timer) return;
  timer = setInterval(tick, SCHEDULER_TICK_MS);
}

export function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}
