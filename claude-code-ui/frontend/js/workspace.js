/*
 * The Workspace panel — files under /data/workspace (server/lib/workspace.js),
 * this app's local stand-in for a persisted, reopenable "Artifact". Fetched
 * over plain HTTP (no need to route this through the WebSocket protocol),
 * and refreshed automatically after every reply via the 'workspace' message.
 */
import { S } from './state.js';
import { workspaceBtn, workspacePanel, workspaceListEl, wsBase } from './dom.js';

const ICONS_BY_EXT = {
  html: '🌐', htm: '🌐',
  png: '🖼', jpg: '🖼', jpeg: '🖼', gif: '🖼', svg: '🖼', webp: '🖼',
  pdf: '📕',
  csv: '📊', tsv: '📊', xlsx: '📊',
  md: '📝', txt: '📝',
  json: '🗒', yaml: '🗒', yml: '🗒',
};

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function relTime(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 604800) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ms).toLocaleDateString();
}

export function renderWorkspace() {
  workspaceListEl.innerHTML = '';
  if (!S.workspace.length) {
    const empty = document.createElement('div');
    empty.className = 'sessions-empty';
    empty.textContent = 'Nothing here yet — files Claude writes to /data/workspace will show up here.';
    workspaceListEl.appendChild(empty);
    return;
  }
  for (const f of S.workspace) {
    const row = document.createElement('a');
    row.className = 'session-item';
    row.href = `${wsBase}/workspace/${f.path.split('/').map(encodeURIComponent).join('/')}`;
    row.target = '_blank';
    row.rel = 'noopener';

    const icon = document.createElement('span');
    icon.className = 'task-icon';
    icon.textContent = ICONS_BY_EXT[f.ext] || '📄';

    const main = document.createElement('div');
    main.className = 'session-main';
    const title = document.createElement('div');
    title.className = 'session-title';
    title.textContent = f.path;
    const meta = document.createElement('div');
    meta.className = 'session-time';
    meta.textContent = `${formatSize(f.size)} · ${relTime(f.mtime)}`;
    main.append(title, meta);

    row.append(icon, main);
    workspaceListEl.appendChild(row);
  }
}

async function refreshWorkspace() {
  try {
    const res = await fetch(`${wsBase}/api/workspace`);
    if (!res.ok) return;
    const data = await res.json();
    S.workspace = Array.isArray(data.entries) ? data.entries : [];
    renderWorkspace();
  } catch { /* transient — the next open or reply-driven refresh will retry */ }
}

export function openWorkspace() {
  refreshWorkspace();
  workspacePanel.classList.remove('hidden');
  workspaceBtn.classList.add('active');
}
export function closeWorkspace() {
  workspacePanel.classList.add('hidden');
  workspaceBtn.classList.remove('active');
}

/** Called from connection.js whenever the server pushes a fresh listing — only
 *  bother re-rendering if the panel is actually open. */
export function applyWorkspaceEntries(entries) {
  S.workspace = Array.isArray(entries) ? entries : [];
  if (!workspacePanel.classList.contains('hidden')) renderWorkspace();
}

workspaceBtn.onclick = (e) => {
  e.stopPropagation();
  if (workspacePanel.classList.contains('hidden')) openWorkspace();
  else closeWorkspace();
};

document.addEventListener('click', (e) => {
  if (workspacePanel.classList.contains('hidden')) return;
  if (workspacePanel.contains(e.target) || workspaceBtn.contains(e.target)) return;
  closeWorkspace();
});
