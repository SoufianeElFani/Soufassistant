/*
 * "Tell me when Claude needs me."
 *
 * The real delivery is the server's: it pushes through Home Assistant, which is
 * the only thing that reaches a phone whose browser has gone to sleep (see
 * server/lib/notify.js). This module does the two halves that belong to the page:
 * telling the server whether this tab is on screen — so it does not push at
 * someone who is looking — and, when the tab is hidden, a title badge and an
 * optional browser notification for desktop.
 */
import { S } from './state.js';
import { notifyAttention, notifyHint, notifyReply, notifyService, notifyTest } from './dom.js';

const BASE_TITLE = document.title;
let pending = 0;
let applying = false;   // true while the server's state is being written into the controls

const isVisible = () => document.visibilityState === 'visible' && document.hasFocus();

function sendPresence() {
  if (S.ws && S.isConnected) S.ws.send(JSON.stringify({ type: 'presence', visible: isVisible() }));
}

function refreshTitle() {
  document.title = pending ? `(${pending}) ${BASE_TITLE}` : BASE_TITLE;
}

function onPresenceChange() {
  if (isVisible()) { pending = 0; refreshTitle(); }
  sendPresence();
}
document.addEventListener('visibilitychange', onPresenceChange);
window.addEventListener('focus', onPresenceChange);
window.addEventListener('blur', onPresenceChange);

/** Called on every (re)connect, so a fresh socket is never assumed visible. */
export function announcePresence() { sendPresence(); }

/** Something happened that wants the user, and they are not looking. */
export function attentionCue(title, body) {
  if (isVisible()) return;
  pending += 1;
  refreshTitle();
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    try { new Notification(title, { body, tag: 'claude-code-ui' }); } catch { /* some webviews throw */ }
  }
}

export function applyNotifyState(msg) {
  applying = true;
  if (Array.isArray(msg.services)) {
    const current = msg.service ?? notifyService.value;
    notifyService.replaceChildren(new Option('Off', ''));
    for (const s of msg.services) notifyService.append(new Option(s, s));
    if (current && !msg.services.includes(current)) notifyService.append(new Option(current, current));
    notifyService.value = current || '';
  } else if (msg.service != null) {
    notifyService.value = msg.service;
  }
  if (msg.onReply != null) notifyReply.checked = !!msg.onReply;
  if (msg.onAttention != null) notifyAttention.checked = !!msg.onAttention;
  applying = false;
}

export function showNotifyTestResult(msg) {
  notifyHint.textContent = msg.ok ? 'Test sent — it should arrive in a moment.' : `Test failed: ${msg.error}`;
}

function pushSettings() {
  if (applying || !(S.ws && S.isConnected)) return;
  S.ws.send(JSON.stringify({
    type: 'set_notify',
    service: notifyService.value,
    onReply: notifyReply.checked,
    onAttention: notifyAttention.checked,
  }));
}
notifyService.onchange = () => {
  // Needs a user gesture; only matters for desktop, where the page can notify.
  if (notifyService.value && typeof Notification !== 'undefined' && Notification.permission === 'default') {
    try { Notification.requestPermission(); } catch { /* ignore */ }
  }
  pushSettings();
};
notifyReply.onchange = pushSettings;
notifyAttention.onchange = pushSettings;
notifyTest.onclick = () => {
  if (S.ws && S.isConnected) S.ws.send(JSON.stringify({ type: 'test_notify' }));
};
