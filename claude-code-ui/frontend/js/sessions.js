/*
 * The sessions panel — past conversations, read from Claude Code's own store
 * (server: sessions.js + session-tools.js).
 *
 * Pinned conversations come first; a search box looks through every
 * conversation's prompts and replies; each row's ⋯ menu renames, pins,
 * duplicates (a copy to try another direction), exports to Markdown in the
 * workspace or shows the file changes (changes.js); ✕ deletes it.
 *
 * Each row carries its mode (Chat / Code / Cowork, plus the Cowork project), and
 * the chips above the list narrow it to one mode. Conversations running right
 * now — several can, side by side — are marked, can be stopped from here, and a
 * new one still waiting for its id is listed at the top.
 */
import { registerPanel } from './panels.js';
import { S } from './state.js';
import { sessionsBtn, sessionsListEl, sessionsPanel, sessionsSearch, sessionsFilterEl } from './dom.js';
import { confirmAction } from './confirm.js';

export const MODE_LABELS = { chat: 'Chat', code: 'Code', cowork: 'Cowork' };

/** A conversation's mode as last used ('code' for ones that predate modes). */
export function modeOf(id) {
  const m = id && S.sessionModes[id];
  return { mode: MODE_LABELS[m?.mode] ? m.mode : 'code', project: m?.project || null, known: !!m };
}

/** The running entry for a conversation (by session id or draft key), if any. */
export function runOf(id) {
  return S.runs.find((r) => r.key === id || (r.sessionId && r.sessionId === id)) || null;
}

let modeFilter = localStorage.getItem('sessionsModeFilter') || 'all';

// ── Sessions ─────────────────────────────────────────────────────────────────
export function relTime(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 604800) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ms).toLocaleDateString();
}

let searchResults = null;   // null = not searching; [] = no hits
let searchTimer = null;
let openMenuId = null;

function send(msg) {
  if (S.ws && S.isConnected) S.ws.send(JSON.stringify(msg));
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/** Open a conversation. Whatever is running elsewhere carries on. */
export function switchTo(id) {
  if (id === S.viewKey || id === S.activeSessionId) return closeSessions();
  send({ type: 'session_switch', id });
  closeSessions();
}

function modeBadge(id) {
  const { mode, project } = modeOf(id);
  const b = el('span', `mode-badge mode-${mode}`, MODE_LABELS[mode]);
  b.title = mode === 'cowork' && project ? `Cowork · ${project}` : `${MODE_LABELS[mode]} conversation`;
  return b;
}

function runningBadge(run) {
  const b = el('span', `run-badge${run.phase === 'background' ? ' run-bg' : ''}`);
  b.title = run.phase === 'background' ? 'Finishing in the background' : 'Running';
  b.setAttribute('aria-label', b.title);
  return b;
}

function stopButton(run) {
  const b = el('button', 'session-stop', '■');
  b.type = 'button';
  b.title = 'Stop this conversation';
  b.onclick = async (e) => {
    e.stopPropagation();
    const ok = await confirmAction({
      title: 'Stop this conversation?',
      body: run.title || 'The run in progress will stop. Everything written so far is kept.',
      confirm: 'Stop', cancel: 'Let it run',
    });
    if (ok) send({ type: 'abort', key: run.key });
  };
  return b;
}

function menu(s) {
  const m = el('div', 'session-menu');
  const act = (label, title, fn) => {
    const b = el('button', 'session-menu-btn', label);
    b.type = 'button';
    b.title = title;
    b.onclick = (e) => { e.stopPropagation(); fn(); };
    m.appendChild(b);
  };
  act(s.pinned ? '★ Unpin' : '☆ Pin', 'Keep it at the top', () => send({ type: 'session_pin', id: s.id, pinned: !s.pinned }));
  act('✎ Rename', 'Rename', () => {
    const t = prompt('Conversation title (empty = automatic):', s.title);
    if (t !== null) send({ type: 'session_rename', id: s.id, title: t });
  });
  act('⧉ Duplicate', 'A copy to continue in another direction', () => send({ type: 'session_duplicate', id: s.id }));
  act('⇩ Export', 'Save as Markdown in the workspace (Conversations/)', () => send({ type: 'session_export', id: s.id }));
  act('↶ Changes', 'Files changed in this conversation, and undo', () => {
    closeSessions();
    import('./changes.js').then((c) => c.openChanges(s.id, s.title));
  });
  return m;
}

function row(s, { snippet } = {}) {
  const wrap = el('div', 'session-wrap');
  const run = runOf(s.id);
  const { mode, project } = modeOf(s.id);
  const item = el('div', `session-item mode-edge-${mode}${s.id === S.activeSessionId ? ' active' : ''}${run ? ' running' : ''}`);
  const main = el('div', 'session-main');
  const title = el('div', 'session-title');
  if (run) title.appendChild(runningBadge(run));
  title.appendChild(document.createTextNode(`${s.pinned ? '★ ' : ''}${s.title}`));
  const time = el('div', 'session-time');
  time.appendChild(modeBadge(s.id));
  const sub = snippet || `${mode === 'cowork' && project ? `${project} · ` : ''}${run ? 'running…' : relTime(s.updatedAt)}`;
  time.appendChild(document.createTextNode(` ${sub}`));
  main.append(title, time);
  const more = el('button', 'session-more', '⋯');
  more.type = 'button';
  more.title = 'More';
  more.setAttribute('aria-label', 'More actions');
  more.onclick = (e) => {
    e.stopPropagation();
    openMenuId = openMenuId === s.id ? null : s.id;
    renderSessions();
  };
  const del = el('button', 'session-del', '✕');
  del.type = 'button';
  del.title = 'Delete session';
  del.onclick = async (e) => {
    e.stopPropagation();
    const ok = await confirmAction({
      title: 'Delete this conversation?',
      body: 'It will be removed from the store permanently. This cannot be undone.',
      confirm: 'Delete',
      cancel: 'Keep it',
    });
    if (ok) send({ type: 'session_delete', id: s.id });
  };
  item.onclick = () => switchTo(s.id);
  item.append(main);
  if (run) item.append(stopButton(run));
  item.append(more, del);
  wrap.appendChild(item);
  if (openMenuId === s.id) wrap.appendChild(menu(s));
  return wrap;
}

/** A new conversation running under its draft key: not in the store's list yet. */
function draftRow(run) {
  const wrap = el('div', 'session-wrap');
  const mode = MODE_LABELS[run.mode] ? run.mode : 'code';
  const item = el('div', `session-item running mode-edge-${mode}${run.key === S.viewKey ? ' active' : ''}`);
  const main = el('div', 'session-main');
  const title = el('div', 'session-title');
  title.append(runningBadge(run), document.createTextNode(run.title || 'New conversation'));
  const time = el('div', 'session-time');
  const b = el('span', `mode-badge mode-${mode}`, MODE_LABELS[mode]);
  time.append(b, document.createTextNode(` ${run.project ? `${run.project} · ` : ''}starting…`));
  main.append(title, time);
  item.onclick = () => switchTo(run.key);
  item.append(main, stopButton(run));
  wrap.appendChild(item);
  return wrap;
}

function renderFilter() {
  if (!sessionsFilterEl) return;
  sessionsFilterEl.innerHTML = '';
  const counts = { all: S.sessions.length, chat: 0, code: 0, cowork: 0 };
  for (const s of S.sessions) counts[modeOf(s.id).mode] += 1;
  for (const key of ['all', 'chat', 'code', 'cowork']) {
    const label = key === 'all' ? 'All' : MODE_LABELS[key];
    const chip = el('button', `ws-chip mode-chip${key !== 'all' ? ` mode-${key}` : ''}${modeFilter === key ? ' active' : ''}`,
      `${label} ${counts[key]}`);
    chip.type = 'button';
    chip.onclick = (e) => {
      e.stopPropagation();
      modeFilter = modeFilter === key ? 'all' : key;
      localStorage.setItem('sessionsModeFilter', modeFilter);
      renderSessions();
    };
    sessionsFilterEl.appendChild(chip);
  }
  const running = S.runs.length;
  if (running) sessionsFilterEl.appendChild(el('span', 'sessions-running-count', `${running} running`));
}

const passes = (id) => modeFilter === 'all' || modeOf(id).mode === modeFilter;

export function renderSessions() {
  renderFilter();
  sessionsListEl.innerHTML = '';
  if (searchResults) {
    if (!searchResults.length) {
      sessionsListEl.appendChild(el('div', 'sessions-empty', 'No conversation mentions that.'));
      return;
    }
    for (const r of searchResults.filter((x) => passes(x.id))) {
      const s = S.sessions.find((x) => x.id === r.id) || r;
      sessionsListEl.appendChild(row(s, { snippet: `${r.hits ? `${r.hits}× · ` : ''}${r.snippet}` }));
    }
    return;
  }
  const drafts = S.runs.filter((r) => !r.sessionId || !S.sessions.some((s) => s.id === r.sessionId))
    .filter((r) => modeFilter === 'all' || (r.mode || 'code') === modeFilter);
  for (const r of drafts) sessionsListEl.appendChild(draftRow(r));
  const list = S.sessions.filter((s) => passes(s.id));
  if (!list.length && !drafts.length) {
    sessionsListEl.appendChild(el('div', 'sessions-empty',
      S.sessions.length ? `No ${MODE_LABELS[modeFilter] || ''} conversation yet.` : 'No saved sessions yet.'));
    return;
  }
  for (const s of list) sessionsListEl.appendChild(row(s));
}

/** The running list changed: the badge on the Sessions button, and the panel if open. */
export function applyRuns(runs) {
  S.runs = Array.isArray(runs) ? runs : [];
  const elsewhere = S.runs.filter((r) => r.key !== S.viewKey).length;
  sessionsBtn.classList.toggle('has-runs', elsewhere > 0);
  sessionsBtn.dataset.runs = elsewhere ? String(elsewhere) : '';
  sessionsBtn.title = elsewhere ? `Sessions — ${elsewhere} other conversation${elsewhere > 1 ? 's' : ''} running` : 'Sessions';
  if (!sessionsPanel.classList.contains('hidden')) renderSessions();
}

export function applySearchResults(msg) {
  if ((sessionsSearch.value || '').trim() !== (msg.q || '').trim()) return;   // a newer query is in flight
  searchResults = Array.isArray(msg.results) ? msg.results : [];
  if (!sessionsPanel.classList.contains('hidden')) renderSessions();
}

export function applySessionActionResult(msg) {
  if (msg.type === 'session_export_result') {
    if (msg.ok) import('./artifacts.js').then((a) => a.openArtifact(msg.path, 'md'));
    else alert(msg.error || 'Export failed.');
  } else if (msg.type === 'session_duplicate_result') {
    if (msg.ok) send({ type: 'session_switch', id: msg.id });
    else alert(msg.error || 'Could not duplicate.');
  }
}

sessionsSearch.addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = sessionsSearch.value.trim();
  if (q.length < 2) { searchResults = null; renderSessions(); return; }
  searchTimer = setTimeout(() => send({ type: 'session_search', q }), 250);
});
// Typing here must not trigger the app's global shortcuts.
sessionsSearch.addEventListener('keydown', (e) => e.stopPropagation());

export function openSessions() {
  send({ type: 'sessions_list' });
  openMenuId = null;
  renderSessions();
  sessionsPanel.classList.remove('hidden');
  sessionsBtn.classList.add('active');
}
export function closeSessions() {
  sessionsPanel.classList.add('hidden');
  sessionsBtn.classList.remove('active');
  openMenuId = null;
}

registerPanel(sessionsPanel, closeSessions);
