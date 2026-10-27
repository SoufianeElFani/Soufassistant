/*
 * The message box: sending, stopping, the send button's two states, and the
 * keyboard shortcuts.
 */
import { currentModeFields } from './modes.js';
import { currentRoleIds } from './roles.js';
import { voiceFields } from './voice.js';
import { S } from './state.js';
import { attachments, clearAttachments, fileToDataURL } from './attachments.js';
import { SEND_ICON, STOP_ICON, UI_COMMANDS, clearScreen, hideCmdMenu, showHelp, showUsage } from './commands.js';
import { inputForm, permModeSelect, promptInput, sendBtn, statusDot } from './dom.js';
import { openFind } from './find.js';
import { scrollBottom } from './scroll.js';
import { openSessions } from './sessions.js';
import { hideThinking, showThinking } from './thinking.js';
import { appendErrorBubble, appendUserBubble } from './transcript.js';

// ── Input form ─────────────────────────────────────────────────────────────

// While a turn is working the button is Stop when the box is empty, and sends
// (adding to the working turn, without stopping it) when there is something
// typed — see updateSendBtn and the server's `steer` path in run-query.js.
const hasDraft = () => !!promptInput.value.trim() || attachments.length > 0;

sendBtn.onclick = (e) => {
  if (S.isRunning && !hasDraft()) {
    e.preventDefault();
    S.isRunning = false;
    hideThinking();
    updateSendBtn();
    if (S.ws && S.isConnected) S.ws.send(JSON.stringify({ type: 'abort' }));
  }
};

inputForm.onsubmit = async (e) => {
  e.preventDefault();
  hideCmdMenu();
  const text = promptInput.value.trim();
  const hasAtt = attachments.length > 0;
  if ((!text && !hasAtt) || !S.isConnected) return;

  // UI slash command? handle locally (only when there's no attachment).
  const ui = !hasAtt && UI_COMMANDS.find((c) => '/' + c.name === text);
  if (ui) {
    runUiCommand(ui.name);
    promptInput.value = '';
    localStorage.removeItem('draft');
    resizeTextarea();
    updateSendBtn();
    return;
  }

  // Sent while Claude is working: added to the turn in progress, not a restart.
  const steer = S.isRunning;

  // Read the attachments to base64 for upload + the message bubble thumbnails.
  const pending = attachments.slice();
  let payload = [];
  let bubbleAtts = [];
  let readFailed = 0;
  for (const a of pending) {
    let dataUrl = null;
    try { dataUrl = await fileToDataURL(a.file, a.isImage); } catch { dataUrl = null; }
    if (!dataUrl) { readFailed++; continue; }
    // The media type / extension may have changed (e.g. an image re-encoded to JPEG).
    const mt = (dataUrl.match(/^data:([^;]+);/) || [])[1] || a.mediaType || 'application/octet-stream';
    let name = a.name;
    if (a.isImage && /jpeg/.test(mt) && !/\.jpe?g$/i.test(name)) name = name.replace(/\.[^.]+$/, '') + '.jpg';
    payload.push({ name, mediaType: mt, data: dataUrl });
    bubbleAtts.push({ name, isImage: a.isImage, dataUrl });
  }
  if (readFailed) appendErrorBubble(`${readFailed} attachment${readFailed > 1 ? 's' : ''} could not be read and ${readFailed > 1 ? 'were' : 'was'} skipped.`);
  if (!payload.length && !text) { updateSendBtn(); return; }   // nothing usable to send

  appendUserBubble(text, undefined, bubbleAtts, { steer });
  scrollBottom(true);   // sending a prompt re-pins to the bottom
  promptInput.value = '';
  localStorage.removeItem('draft');
  clearAttachments();
  resizeTextarea();
  S.isRunning = true;
  S.usage.messages++;
  updateSendBtn();
  if (!steer) showThinking();

  // Only send a model override if the user explicitly picked one; otherwise let
  // the SDK use its default (which it reports back via the 'model' event).
  S.ws.send(JSON.stringify({
    type: 'prompt',
    text,
    attachments: payload.length ? payload : undefined,
    permissionMode: permModeSelect.value,
    model: localStorage.getItem('model') || undefined,
    effort: localStorage.getItem('effort') || undefined,
    ...currentModeFields(),
    roles: currentRoleIds(),
    ...voiceFields(),
    ...(steer ? { steer: true } : {}),
  }));
};

export function doNewSession() {
  clearScreen();
  S.isRunning = false;
  updateSendBtn();
  if (S.ws && S.isConnected) S.ws.send(JSON.stringify({ type: 'new_session' }));
}

/**
 * Start a new chat. A turn in progress is not stopped: that conversation keeps
 * running out of sight (see the server's runs.js) and is in Sessions, marked
 * as running, to come back to. Every route to a new chat goes through here —
 * the button, /new.
 */
export async function requestNewSession() {
  doNewSession();
}

export function runUiCommand(name) {
  if (name === 'new')   requestNewSession();
  else if (name === 'clear') clearScreen();
  else if (name === 'usage') showUsage();
  else if (name === 'resume') openSessions();
  else if (name === 'find')  openFind();
  else if (name === 'help')  showHelp();
}

export function resizeTextarea() {
  promptInput.style.height = 'auto';
  promptInput.style.height = Math.min(promptInput.scrollHeight, 200) + 'px';
}

const IDLE_PLACEHOLDER = promptInput.placeholder;
const RUNNING_PLACEHOLDER = 'Add something for Claude — it keeps working…';

export function updateSendBtn() {
  promptInput.placeholder = S.isRunning ? RUNNING_PLACEHOLDER : IDLE_PLACEHOLDER;
  if (S.isRunning && hasDraft() && S.isConnected) {
    sendBtn.disabled = false;
    sendBtn.innerHTML = SEND_ICON;
    sendBtn.setAttribute('aria-label', 'Add to what Claude is doing');
    sendBtn.title = 'Add to what Claude is doing (it keeps working) — empty the box to get the Stop button';
    sendBtn.classList.remove('stop');
    sendBtn.classList.add('steer');
  } else if (S.isRunning) {
    sendBtn.disabled = false;
    sendBtn.innerHTML = STOP_ICON;
    sendBtn.setAttribute('aria-label', 'Stop');
    sendBtn.title = 'Stop';
    sendBtn.classList.add('stop');
    sendBtn.classList.remove('steer');
  } else {
    sendBtn.classList.remove('steer');
    sendBtn.title = '';
    sendBtn.disabled = (!promptInput.value.trim() && !attachments.length) || !S.isConnected;
    sendBtn.innerHTML = SEND_ICON;
    sendBtn.setAttribute('aria-label', 'Send');
    sendBtn.classList.remove('stop');
  }
}

export function setStatus(state) {
  statusDot.className = `status-dot ${state}`;
}

// Auto-scroll only when the user is already pinned to the bottom. If they've
// scrolled up to read or copy something, incoming responses must NOT yank them
// back down. `S.stickToBottom` tracks whether the viewport is at (or near) the
// bottom; it's updated on every user scroll and re-armed when the user sends a
// prompt or the screen is reset. Pass force=true to re-pin explicitly.
