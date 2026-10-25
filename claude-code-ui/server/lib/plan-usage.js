/*
 * Plan usage — the claude.ai subscription limits the Usage panel shows, the
 * same numbers Claude Desktop's usage meter shows: the rolling 5-hour session
 * window, the weekly window (overall and per model when the plan has one), and
 * the monthly extra-usage budget when it is enabled.
 *
 * Source: the SDK's structured `/usage` control request
 * (`usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`). It is
 * experimental, so everything here is defensive: an unknown shape normalizes
 * to "unavailable" rather than throwing, and the raw method name lives in one
 * place (USAGE_METHOD) so a rename is a one-line change.
 *
 * Where the number comes from:
 *   - during a run, the run's own Query (no extra process);
 *   - otherwise a short-lived probe Query: the CLI starts, answers the control
 *     request, and is closed. It never receives a prompt, so it spends no
 *     tokens (~4 s on a Home Assistant Green).
 *
 * Refreshed after every `result`, on demand when the panel opens, and on a
 * slow timer while at least one browser is connected. Never more often than
 * MIN_INTERVAL_MS, and never two fetches at once.
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import { WORK_DIR } from './config.js';
import { log, vlog } from './log.js';
import { runtime } from './state.js';
import { connections, broadcast } from './broadcast.js';
import { isSubscriptionAuth } from './auth.js';

const USAGE_METHOD = 'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET';
export const MIN_INTERVAL_MS = 60 * 1000;          // hard floor between fetches
export const POLL_INTERVAL_MS = 5 * 60 * 1000;     // background refresh while a tab is open
const PROBE_TIMEOUT_MS = 30 * 1000;

/** Last good snapshot (normalized), or null before the first fetch. */
export const planUsage = { snapshot: null, inFlight: null, lastAttempt: 0 };

const WINDOW_LABELS = {
  five_hour: 'Session (5 h)',
  seven_day: 'Weekly — all models',
  seven_day_opus: 'Weekly — Opus',
  seven_day_sonnet: 'Weekly — Sonnet',
  seven_day_oauth_apps: 'Weekly — apps',
};

function pct(v) {
  if (v == null || v === '') return null;   // unknown, not 0 % (Number(null) is 0)
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null;
}

function isoToMs(v) {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/**
 * Turn the SDK's /usage answer into what the panel renders. Pure — unit-tested.
 * Returns { available, plan, windows: [{key,label,group,utilization,resetsAt}],
 *           extra: {enabled,monthlyLimit,used,utilization,currency}|null, fetchedAt }.
 */
export function normalizePlanUsage(raw, now = Date.now()) {
  const base = { available: false, plan: raw?.subscription_type || null, windows: [], extra: null, fetchedAt: now };
  if (!raw || !raw.rate_limits_available || !raw.rate_limits) return base;
  const rl = raw.rate_limits;
  const windows = [];
  for (const key of Object.keys(WINDOW_LABELS)) {
    const w = rl[key];
    if (!w || (w.utilization == null && !w.resets_at)) continue;
    windows.push({
      key,
      label: WINDOW_LABELS[key],
      group: key === 'five_hour' ? 'session' : 'weekly',
      utilization: pct(w.utilization),
      resetsAt: isoToMs(w.resets_at),
    });
  }
  // Per-model weekly windows the server lists but the fixed keys above do not
  // cover (new models) — keep them, labelled by whatever name they carry.
  for (const m of Array.isArray(rl.models) ? rl.models : []) {
    const name = m?.display_name || m?.model || m?.name;
    if (!name || windows.some((w) => w.label.toLowerCase().includes(String(name).toLowerCase()))) continue;
    windows.push({ key: `model:${name}`, label: `Weekly — ${name}`, group: 'weekly',
      utilization: pct(m.utilization), resetsAt: isoToMs(m.resets_at) });
  }
  const ex = rl.extra_usage;
  const extra = ex ? {
    enabled: !!ex.is_enabled,
    monthlyLimit: ex.monthly_limit ?? null,
    used: ex.used_credits ?? null,
    utilization: pct(ex.utilization),
    currency: ex.currency || null,
  } : null;
  return { ...base, available: windows.length > 0 || !!extra, windows, extra };
}

async function withTimeout(promise, ms) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`timed out after ${ms} ms`)), ms); }),
    ]);
  } finally { clearTimeout(timer); }
}

/** A Query that never gets a prompt: starts the CLI, answers control requests, is closed. */
async function probe() {
  const ac = new AbortController();
  async function* idle() { await new Promise((r) => ac.signal.addEventListener('abort', r, { once: true })); }
  // SOUFASSISTANT_USAGE_PROBE marks this as a probe, not a conversation: the
  // real CLI ignores it; the test stub (test/helpers/stub-sdk.mjs) uses it to
  // answer without consuming one of the scripted runs.
  const q = query({ prompt: idle(), options: {
    cwd: WORK_DIR, abortController: ac, settingSources: [],
    env: { ...process.env, SOUFASSISTANT_USAGE_PROBE: '1' },
  } });
  try {
    return await withTimeout(q[USAGE_METHOD]({ skip_behaviors: true }), PROBE_TIMEOUT_MS);
  } finally {
    ac.abort();
    try { q.close(); } catch {}
  }
}

/**
 * Fetch and broadcast. `q` is the active run's Query when there is one.
 * `force` bypasses the MIN_INTERVAL_MS floor (still never concurrent).
 */
export async function refreshPlanUsage({ q = null, force = false } = {}) {
  if (!isSubscriptionAuth()) return planUsage.snapshot;
  if (planUsage.inFlight) return planUsage.inFlight;
  if (!force && Date.now() - planUsage.lastAttempt < MIN_INTERVAL_MS) return planUsage.snapshot;
  planUsage.lastAttempt = Date.now();
  planUsage.inFlight = (async () => {
    try {
      const source = q || runtime.activeRun?.q || null;
      const raw = source
        ? await withTimeout(source[USAGE_METHOD]({ skip_behaviors: true }), PROBE_TIMEOUT_MS)
        : await probe();
      const snap = normalizePlanUsage(raw);
      planUsage.snapshot = snap;
      broadcast({ type: 'plan_usage', usage: snap });
      vlog(`plan usage: ${snap.windows.map((w) => `${w.key}=${w.utilization}%`).join(' ') || 'unavailable'}`);
      return snap;
    } catch (e) {
      log('WARN', `plan usage refresh failed: ${e?.message || e}`);
      return planUsage.snapshot;
    } finally {
      planUsage.inFlight = null;
    }
  })();
  return planUsage.inFlight;
}

let pollTimer = null;
/** Background refresh while at least one tab is connected and nothing is running. */
export function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    if (!connections.size || runtime.activeQuery) return;
    refreshPlanUsage();
  }, POLL_INTERVAL_MS);
  pollTimer.unref?.();
}
