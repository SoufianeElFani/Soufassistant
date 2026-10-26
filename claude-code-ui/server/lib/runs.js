/*
 * Several conversations running at once.
 *
 * A run belongs to one conversation, not to the app: `runtime.runs` maps a
 * conversation key to its in-flight run, so switching to another conversation
 * (or starting a new one) no longer stops the one that was working — it keeps
 * running, persisting to its own transcript, and is there to come back to.
 *
 * The key is the SDK session id once the run's `init` has arrived. A brand-new
 * conversation has no id yet, so it starts under a draft key (`draft:<uuid>`)
 * and is re-keyed in place when the id arrives (rekey()).
 *
 * The chat on screen is still one shared view across tabs (runtime.activeSessionId,
 * or runtime.draftKey for a new conversation that has not reported its id yet).
 * A run's transcript events reach the browsers only while it is that view
 * (emit()); everything else about it — that it is running, or has finished —
 * goes out as the 'runs' list, which every tab gets.
 */
import { randomUUID } from 'crypto';
import { runtime } from './state.js';
import { broadcast } from './broadcast.js';

/** The conversation on screen: its session id, or the draft key of a new one. */
export function viewKey() {
  return runtime.activeSessionId || runtime.draftKey || null;
}

export function newDraftKey() {
  return `draft:${randomUUID()}`;
}

export function runFor(key) {
  return key ? runtime.runs.get(key) || null : null;
}

/** The run of the conversation on screen, if it is running. */
export function viewedRun() {
  return runFor(viewKey());
}

export function anyRunning() {
  return runtime.runs.size > 0;
}

/** Any live run's SDK Query — enough for control requests that are not per-conversation. */
export function anyQuery() {
  for (const r of runtime.runs.values()) if (r.q) return r.q;
  return null;
}

export function isViewed(run) {
  return !!run && run.key === viewKey();
}

/** A transcript event: only the tabs showing this conversation render it. */
export function emit(run, msg) {
  if (isViewed(run)) broadcast({ ...msg, sid: run.key });
}

/** What every tab is told about the conversations running right now. */
export function runsSummary() {
  return [...runtime.runs.values()].map((r) => ({
    key: r.key,
    sessionId: r.sessionId || null,
    phase: r.phase,
    mode: r.mode || null,
    project: r.project || null,
    title: r.title || null,
    startedAt: r.startedAt,
  }));
}

export function broadcastRuns() {
  broadcast({ type: 'runs', runs: runsSummary() });
}

/**
 * A draft run learned its session id: move it under that key, and the view with
 * it if it was on screen. Returns whether it was the view.
 */
export function rekey(run, sessionId) {
  const wasViewed = isViewed(run);
  if (!sessionId || run.key === sessionId) { if (sessionId) run.sessionId = sessionId; return wasViewed; }
  if (runtime.runs.get(run.key) === run) runtime.runs.delete(run.key);
  run.key = sessionId;
  run.sessionId = sessionId;
  runtime.runs.set(sessionId, run);
  if (wasViewed) {
    runtime.draftKey = null;
    runtime.activeSessionId = sessionId;
  }
  return wasViewed;
}
