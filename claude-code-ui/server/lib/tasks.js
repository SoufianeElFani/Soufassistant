/*
 * The task list — a local, self-hosted analogue of the task-tracking widget
 * Claude's own hosted products show for multi-step work.
 *
 * There is no public API to render a widget inside Claude Code's own output,
 * so instead the model drives a tiny CLI (`claude-tasks`, see
 * scripts/claude-tasks.cjs) as an ordinary Bash call — which means it goes
 * through the normal permission system like everything else this app lets
 * Claude do — and that CLI posts the updated list to this app's own loopback
 * endpoint (`POST /internal/tasks`, guarded by server/lib/internal.js). This
 * module owns the resulting state: validation, persistence, and broadcasting
 * it to every connected tab, exactly like auto-continue.js owns its own
 * persisted, broadcast state.
 */
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { TASKS_FILE } from './config.js';
import { log } from './log.js';
import { broadcast } from './broadcast.js';

export const MAX_TASKS = 50;
export const STATUSES = new Set(['pending', 'in_progress', 'completed']);

export const taskState = { tasks: [] };

export function load() {
  try {
    if (existsSync(TASKS_FILE)) {
      const d = JSON.parse(readFileSync(TASKS_FILE, 'utf8'));
      if (Array.isArray(d.tasks)) taskState.tasks = d.tasks.filter(isValidTask);
    }
  } catch (e) { console.warn('Could not load tasks:', e.message); }
}

function save() {
  try { writeFileSync(TASKS_FILE, JSON.stringify(taskState)); }
  catch (e) { console.warn('Could not save tasks:', e.message); }
}

function isValidTask(t) {
  return !!t && typeof t.id === 'string' && t.id.length > 0 && t.id.length <= 80 &&
    typeof t.description === 'string' && t.description.length > 0 && t.description.length <= 500 &&
    STATUSES.has(t.status);
}

/** Normalise one incoming task, clamping string lengths rather than rejecting
 *  the whole list for one oversized field. */
function sanitizeTask(t) {
  if (!t || typeof t !== 'object') return null;
  const id = String(t.id ?? '').slice(0, 80).trim();
  const description = String(t.description ?? '').slice(0, 500).trim();
  const status = STATUSES.has(t.status) ? t.status : 'pending';
  if (!id || !description) return null;
  return { id, description, status };
}

function broadcastTasks() {
  broadcast({ type: 'tasks', tasks: taskState.tasks });
}

/** Full replace — what `claude-tasks set` sends. */
export function setTasks(list) {
  if (!Array.isArray(list)) throw new Error('tasks must be an array');
  const clean = list.map(sanitizeTask).filter(Boolean).slice(0, MAX_TASKS);
  // De-duplicate by id, keeping the last occurrence (a model resending the same
  // id with a new status is far more likely than a genuine duplicate task).
  const byId = new Map();
  for (const t of clean) byId.set(t.id, t);
  taskState.tasks = [...byId.values()];
  save();
  broadcastTasks();
  log('INFO', `tasks: set ${taskState.tasks.length} task(s)`);
  return taskState.tasks;
}

/** One task's status, by id — `claude-tasks update <id> <status>`. Appends a
 *  new task if the id is not already in the list, so the model can mark
 *  something done without having to resend the whole list first. */
export function updateTask(id, status, description) {
  if (!STATUSES.has(status)) throw new Error(`status must be one of: ${[...STATUSES].join(', ')}`);
  const cleanId = String(id ?? '').slice(0, 80).trim();
  if (!cleanId) throw new Error('id is required');
  const existing = taskState.tasks.find((t) => t.id === cleanId);
  if (existing) {
    existing.status = status;
    if (description) existing.description = String(description).slice(0, 500);
  } else {
    if (!description) throw new Error(`unknown task id ${cleanId} — pass a description to create it`);
    if (taskState.tasks.length >= MAX_TASKS) throw new Error(`task list is full (max ${MAX_TASKS})`);
    taskState.tasks.push({ id: cleanId, description: String(description).slice(0, 500), status });
  }
  save();
  broadcastTasks();
  return taskState.tasks;
}

export function clearTasks() {
  taskState.tasks = [];
  save();
  broadcastTasks();
  log('INFO', 'tasks: cleared');
}
