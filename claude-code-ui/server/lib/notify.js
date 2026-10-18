/*
 * Telling the user the app wants them — a finished reply, or a prompt/question
 * waiting on an answer.
 *
 * The server decides and Home Assistant delivers. A phone that has backgrounded
 * the browser drops the WebSocket and suspends the page, so nothing running in
 * the page can reach it; the server outlives the socket and can call a
 * `notify.*` service (the companion app's push) with the Supervisor token.
 *
 * Settings are server-owned and persisted, like auto-continue, because the
 * notification matters most when no browser is open.
 */
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { NOTIFY_FILE, SUPERVISOR_URL } from './config.js';
import { log, vlog } from './log.js';
import { connections } from './broadcast.js';

export const notifySettings = { service: '', onReply: true, onAttention: true };

const TAG = 'claude-code-ui';
const EVENT = 'claude_code_ui_attention';
export const COOLDOWN_MS = 10000;
const lastSent = new Map();   // kind → epoch ms

export function load() {
  try {
    if (existsSync(NOTIFY_FILE)) {
      const d = JSON.parse(readFileSync(NOTIFY_FILE, 'utf8'));
      applySettings(d);
    }
  } catch (e) { console.warn('Could not load notify settings:', e.message); }
}

function save() {
  try { writeFileSync(NOTIFY_FILE, JSON.stringify(notifySettings)); }
  catch (e) { console.warn('Could not save notify settings:', e.message); }
}

/** Accepts only a bare service name (`mobile_app_pixel`), never a path. */
export function applySettings(d = {}) {
  const service = typeof d.service === 'string' && /^[a-z0-9_]+$/i.test(d.service) ? d.service : '';
  notifySettings.service = service;
  notifySettings.onReply = d.onReply !== false;
  notifySettings.onAttention = d.onAttention !== false;
}

export function setSettings(d) { applySettings(d); save(); }

/**
 * Whether a push should go out. Pure, so the rules are testable: it must be
 * switched on for this kind, nobody can be looking at the app right now, and the
 * same kind must not have fired a moment ago (a burst of permission prompts is
 * one nudge, not five).
 */
export function shouldPush({ kind, settings, anyVisible, lastAt, now, cooldownMs = COOLDOWN_MS }) {
  if (!settings.service) return false;
  if (kind === 'reply' && !settings.onReply) return false;
  if (kind !== 'reply' && !settings.onAttention) return false;
  if (anyVisible) return false;
  if (lastAt != null && now - lastAt < cooldownMs) return false;
  return true;
}

const supervisorFetch = (route, init = {}) => fetch(`${SUPERVISOR_URL}/core/api/${route}`, {
  ...init,
  headers: { Authorization: `Bearer ${process.env.SUPERVISOR_TOKEN}`, 'Content-Type': 'application/json' },
});

/** The notify services this Home Assistant offers, for the settings dropdown. */
export async function listNotifyServices() {
  if (!process.env.SUPERVISOR_TOKEN) return [];
  try {
    const res = await supervisorFetch('services');
    if (!res.ok) { vlog(`notify: /services returned ${res.status}`); return []; }
    const all = await res.json();
    const entry = (all || []).find((d) => d.domain === 'notify');
    return Object.keys(entry?.services || {}).filter((n) => n !== 'send_message' && n !== 'persistent_notification').sort();
  } catch (e) { vlog(`notify: service list failed: ${e.message}`); return []; }
}

let panelUrl;   // undefined until looked up; null if it could not be
async function getPanelUrl() {
  if (panelUrl !== undefined) return panelUrl;
  try {
    const res = await fetch(`${SUPERVISOR_URL}/addons/self/info`,
      { headers: { Authorization: `Bearer ${process.env.SUPERVISOR_TOKEN}` } });
    const slug = res.ok ? (await res.json())?.data?.slug : null;
    panelUrl = slug ? `/hassio/ingress/${slug}` : null;
  } catch { panelUrl = null; }
  return panelUrl;
}

const anyVisible = () => [...connections].some((c) => c.visible === true && c.readyState === 1);

/**
 * kind: 'reply' | 'permission' | 'question' | 'stopped'. Fire-and-forget; a
 * failure is logged, never thrown into the run.
 */
export async function notify(kind, { title, message }) {
  const now = Date.now();
  if (!process.env.SUPERVISOR_TOKEN) return false;
  if (!shouldPush({ kind, settings: notifySettings, anyVisible: anyVisible(), lastAt: lastSent.get(kind), now })) return false;
  lastSent.set(kind, now);
  try {
    const url = await getPanelUrl();
    const data = { tag: TAG, group: TAG };
    if (url) { data.url = url; data.clickAction = url; }
    const res = await supervisorFetch(`services/notify/${notifySettings.service}`,
      { method: 'POST', body: JSON.stringify({ title, message, data }) });
    if (!res.ok) log('WARN', `notify.${notifySettings.service} returned ${res.status}`);
    // The same cue as a bus event, for users who would rather automate it.
    await supervisorFetch(`events/${EVENT}`, { method: 'POST', body: JSON.stringify({ kind, title, message }) });
    return true;
  } catch (e) { log('WARN', `notify failed: ${e.message}`); return false; }
}

/** Take the notification off the phone once what it was about has been dealt with. */
export async function clearAttention() {
  const svc = notifySettings.service;
  if (!svc.startsWith('mobile_app_') || !process.env.SUPERVISOR_TOKEN) return;
  try {
    await supervisorFetch(`services/notify/${svc}`,
      { method: 'POST', body: JSON.stringify({ message: 'clear_notification', data: { tag: TAG } }) });
  } catch (e) { vlog(`notify clear failed: ${e.message}`); }
}

/** Test button: bypasses presence and cooldown, and reports the outcome. */
export async function sendTest() {
  if (!notifySettings.service) return { ok: false, error: 'Pick a notify service first.' };
  if (!process.env.SUPERVISOR_TOKEN) return { ok: false, error: 'No Supervisor token.' };
  try {
    const res = await supervisorFetch(`services/notify/${notifySettings.service}`, {
      method: 'POST', body: JSON.stringify({ title: 'Claude Code', message: 'Test notification', data: { tag: `${TAG}-test` } }),
    });
    return res.ok ? { ok: true } : { ok: false, error: `Home Assistant answered ${res.status}` };
  } catch (e) { return { ok: false, error: e.message }; }
}
