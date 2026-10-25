/*
 * The sessions panel — past conversations, read from Claude Code's own store
 * (server: sessions.js + session-tools.js).
 *
 * Pinned conversations come first; a search box looks through every
 * conversation's prompts and replies; each row's ⋯ menu renames, pins,
 * duplicates (a copy to try another direction), exports to Markdown in the
 * workspace or shows the file changes (changes.js); ✕ deletes it.
 */
import { S } from './state.js';
import { sessionsBtn, sessionsListEl, sessionsPanel, sessionsSearch } from './dom.js';
import { confirmAction, confirmInterrupt } from './confirm.js';

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

async function switchTo(id) {
  if (id === S.activeSessionId) return closeSessions();
  // The server aborts the active query on session_switch, so this is the
  // last point at which the turn can be saved.
  if (S.isRunning) {
    const ok = await confirmInterrupt({
      body: 'Switching to another chat will stop what it is doing now. Everything '
          + 'written so far is already saved, but the rest of this turn will not be finished.',
      confirm: 'Stop and switch',
    });
    if (!ok) return;   // stay put, panel still open, nothing sent
  }
  send({ type: 'session_switch', id });
  closeSessions();
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
  const item = el('div', `session-item${s.id === S.activeSessionId ? ' active' : ''}`);
  const main = el('div', 'session-main');
  const title = el('div', 'session-title', `${s.pinned ? '★ ' : ''}${s.title}`);
  const time = el('div', 'session-time', snippet || relTime(s.updatedAt));
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
  item.append(main, more, del);
  wrap.appendChild(item);
  if (openMenuId === s.id) wrap.appendChild(menu(s));
  return wrap;
}

export function renderSessions() {
  sessionsListEl.innerHTML = '';
  if (searchResults) {
    if (!searchResults.length) {
      sessionsListEl.appendChild(el('div', 'sessions-empty', 'No conversation mentions that.'));
      return;
    }
    for (const r of searchResults) {
      const s = S.sessions.find((x) => x.id === r.id) || r;
      sessionsListEl.appendChild(row(s, { snippet: `${r.hits ? `${r.hits}× · ` : ''}${r.snippet}` }));
    }
    return;
  }
  if (!S.sessions.length) {
    sessionsListEl.appendChild(el('div', 'sessions-empty', 'No saved sessions yet.'));
    return;
  }
  for (const s of S.sessions) sessionsListEl.appendChild(row(s));
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
