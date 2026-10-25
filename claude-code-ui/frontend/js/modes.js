/*
 * The Chat / Code / Cowork switch (server side: server/lib/modes.js).
 *
 * The chosen mode rides along with every prompt (composer.js reads
 * currentModeFields()). It is remembered two ways: the last one picked is the
 * default for a new conversation (localStorage), and each conversation's own
 * mode comes back from the server ('session_modes') so reopening it restores
 * the switch. Cowork also needs a project — a top-level folder of the
 * workspace — picked in the selector next to the switch.
 */
import { S } from './state.js';
import { modeSwitch, coworkProjectSel, promptInput, composerModeSel, composerProjectSel } from './dom.js';

const PLACEHOLDERS = {
  chat: 'Chat with Claude… (Ctrl+Enter to send)',
  code: 'Ask Claude… (Ctrl+Enter to send)',
  cowork: 'Build something in this project… (Ctrl+Enter to send)',
};
const MODES = ['chat', 'code', 'cowork'];

export function currentModeFields() {
  return { mode: S.mode, project: S.mode === 'cowork' ? (S.coworkProject || undefined) : undefined };
}

function renderSwitch() {
  for (const b of modeSwitch.querySelectorAll('.mode-btn')) {
    const on = b.dataset.mode === S.mode;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  }
  document.body.dataset.mode = S.mode;
  composerModeSel.value = S.mode;
  promptInput.placeholder = PLACEHOLDERS[S.mode] || PLACEHOLDERS.code;
  renderProjectSelect();
}

function fillProjectSelect(sel) {
  const projects = S.workspaceState?.projects || [];
  sel.innerHTML = '';
  if (!projects.length) {
    sel.add(new Option('No project — create one in Workspace', ''));
    sel.value = '';
    return;
  }
  for (const p of projects) sel.add(new Option(p.name, p.name));
  if (S.coworkProject && !projects.some((p) => p.name === S.coworkProject)) {
    sel.add(new Option(`${S.coworkProject} (missing)`, S.coworkProject));
  }
  sel.value = S.coworkProject || '';
}

export function renderProjectSelect() {
  const show = S.mode === 'cowork';
  coworkProjectSel.classList.toggle('hidden', !show);
  composerProjectSel.classList.toggle('hidden', !show);
  if (!show) return;
  const projects = S.workspaceState?.projects || [];
  if (!S.coworkProject) S.coworkProject = S.workspaceState?.activeProject || projects[0]?.name || null;
  fillProjectSelect(coworkProjectSel);
  fillProjectSelect(composerProjectSel);
}

export function setMode(mode, { persist = true, project } = {}) {
  S.mode = MODES.includes(mode) ? mode : 'code';
  if (project !== undefined) S.coworkProject = project;
  if (persist) localStorage.setItem('mode', S.mode);
  renderSwitch();
}

/** A conversation was opened (or a new one started): restore its mode, if known. */
export function applySessionMode(sessionId) {
  const m = sessionId && S.sessionModes[sessionId];
  if (m) setMode(m.mode, { persist: false, project: m.project ?? S.coworkProject });
  else renderSwitch();
}

export function applySessionModes(map) {
  S.sessionModes = map && typeof map === 'object' ? map : {};
}

modeSwitch.addEventListener('click', (e) => {
  const b = e.target.closest('.mode-btn');
  if (b) setMode(b.dataset.mode);
});

composerModeSel.addEventListener('change', () => setMode(composerModeSel.value));

function onProjectPicked(sel) {
  S.coworkProject = sel.value || null;
  renderProjectSelect();
  if (S.ws && S.isConnected && S.coworkProject) {
    S.ws.send(JSON.stringify({ type: 'workspace_set_active', name: S.coworkProject }));
  }
}
coworkProjectSel.addEventListener('change', () => onProjectPicked(coworkProjectSel));
composerProjectSel.addEventListener('change', () => onProjectPicked(composerProjectSel));

// Start in the last mode used.
setMode(localStorage.getItem('mode') || 'code', { persist: false });
