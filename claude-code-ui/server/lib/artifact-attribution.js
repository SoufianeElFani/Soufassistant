/*
 * Which workspace files one reply produced, when several conversations run at
 * once (runs.js). Pure — unit-tested; run-query.js feeds it the live runs.
 *
 * A file is a reply's artifact when:
 *   - its own file tools wrote it (Write/Edit…, `written`), or
 *   - it changed while the reply ran, and no other run can claim it: neither
 *     wrote it with its file tools, nor was running at that moment. When one
 *     was (a shell command or a script wrote it — no tool says whose it is), the
 *     file goes to the run whose commands and outputs name it (`evidence`):
 *     its path or file name first, else its folder. A tie claims it for no one —
 *     better missing from a card than shown in the wrong conversation.
 *
 * A run here: { startedAt, endedAt?, written: Set<workspace-relative path>, evidence: string }.
 */
import path from 'path';

const SLACK_BEFORE_MS = 1500;
const SLACK_AFTER_MS = 1500;
/** How long a finished run still competes for files (its late copies, a sync touching them). */
export const RIVAL_MEMORY_MS = 30 * 60 * 1000;
/** Per-run cap on the commands/outputs kept to tell runs apart. */
export const EVIDENCE_CAP = 200000;

/** Append tool input/output text to a run's evidence, bounded (newest kept). */
export function addEvidence(run, text) {
  if (!text) return;
  const s = typeof text === 'string' ? text : JSON.stringify(text);
  run.evidence = `${run.evidence || ''}\n${s}`;
  if (run.evidence.length > EVIDENCE_CAP) run.evidence = run.evidence.slice(-EVIDENCE_CAP);
}

/** 2 = the run names the file itself, 1 = only its folder, 0 = nothing. */
export function mentionScore(run, rel) {
  const ev = run.evidence || '';
  if (!ev || !rel) return 0;
  const base = path.basename(rel);
  if (ev.includes(rel) || (base.length >= 3 && ev.includes(base))) return 2;
  const dir = path.dirname(rel);
  if (dir && dir !== '.' && dir.length >= 4 && ev.includes(dir)) return 1;
  return 0;
}

const activeAt = (r, t, now) => t >= r.startedAt - SLACK_BEFORE_MS && t <= (r.endedAt ?? now) + SLACK_AFTER_MS;

/**
 * Split `entries` ({ path, name, mtime, … }) into the ones `run` claims and the
 * contested ones (changed while it ran, but claimed by no one).
 */
export function attributeArtifacts(run, rivals, entries, { now = Date.now(), limit = 24 } = {}) {
  const others = (rivals || []).filter((r) => r && r !== run);
  const since = run.startedAt - SLACK_BEFORE_MS;
  const claimed = [];
  const contested = [];
  for (const e of entries || []) {
    if (!e || /\.conflict\d*/i.test(e.name || e.path || '')) continue;
    if (run.written?.has(e.path)) { claimed.push(e); continue; }
    if (typeof e.mtime !== 'number' || e.mtime < since) continue;
    if (others.some((r) => r.written?.has(e.path))) continue;
    const overlapping = others.filter((r) => activeAt(r, e.mtime, now));
    if (!overlapping.length) { claimed.push(e); continue; }
    const mine = mentionScore(run, e.path);
    if (mine > 0 && overlapping.every((r) => mentionScore(r, e.path) < mine)) claimed.push(e);
    else if (overlapping.every((r) => mentionScore(r, e.path) <= mine)) contested.push(e);
    // else: another run names it better — its file, not this one's.
  }
  return { claimed: claimed.slice(0, limit), contested };
}
