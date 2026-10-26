/*
 * The Workspace panel (server: server/lib/workspace.js).
 *
 *   - the workspace folder, changeable here ("Folder…"), and its sync status
 *     when a sync log exists (last synced / error / conflict copies);
 *   - its projects (top-level folders): click to filter the list, ★ marks the
 *     Cowork project, "+ Project" creates one;
 *   - the files, newest first — click opens them in the artifact viewer, ↗
 *     opens them in a new tab.
 *
 * The listing comes over plain HTTP (/api/workspace) and is pushed after every
 * reply ('workspace'); the folder/projects/sync state comes over the socket
 * ('workspace_state').
 */
import { S } from './state.js';
import {
  workspaceBtn, workspacePanel, workspaceListEl, wsBase, workspaceInfoEl, workspaceFolderBtn,
  workspaceRootForm, workspaceRootInput, workspaceRootError, workspaceRootDefault, workspaceRootCancel,
  workspaceProjectsEl, workspaceNewProject, workspaceNewFile, workspacePreviews,
} from './dom.js';
import { openArtifact, openPreview, createFile, isPreviewable, fileUrl, iconFor } from './artifacts.js';
import { renderProjectSelect } from './modes.js';

const ICONS_BY_EXT = {
  html: '🌐', htm: '🌐',
  png: '🖼', jpg: '🖼', jpeg: '🖼', gif: '🖼', svg: '🖼', webp: '🖼',
  pdf: '📕',
  csv: '📊', tsv: '📊', xlsx: '📊',
  pptx: '📽', docx: '📄',
  md: '📝', txt: '📝',
  json: '🗒', yaml: '🗒', yml: '🗒',
};

let filter = null;   // project name the list is narrowed to, or null for all
let previews = [];   // [{ port, command }] — apps listening on a preview port

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function relTime(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 604800) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ms).toLocaleDateString();
}

function send(msg) {
  if (S.ws && S.isConnected) S.ws.send(JSON.stringify(msg));
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function renderInfo() {
  workspaceInfoEl.innerHTML = '';
  const st = S.workspaceState;
  if (!st) return;
  const root = el('div', 'workspace-root');
  root.append(el('span', 'workspace-root-label', '📂'), el('code', 'workspace-root-path', st.root));
  workspaceInfoEl.appendChild(root);

  const sync = st.sync;
  if (sync?.available) {
    let text, cls = 'sync-ok';
    if (sync.lastError) { text = `⚠ Sync error ${relTime(sync.lastError)} — ${sync.lastErrorText || ''}`; cls = 'sync-error'; }
    else if (sync.lastOk) text = `✓ ${sync.label} · synced ${relTime(sync.lastOk)}`;
    else text = `${sync.label} · no successful sync logged yet`;
    const line = el('div', `workspace-sync ${cls}`, text);
    workspaceInfoEl.appendChild(line);
    if (sync.conflicts) {
      workspaceInfoEl.appendChild(el('div', 'workspace-sync sync-error',
        `${sync.conflicts} conflict cop${sync.conflicts > 1 ? 'ies' : 'y'} — a file was edited in two places at once.`));
    }
  }
}

function renderProjects() {
  workspaceProjectsEl.innerHTML = '';
  const st = S.workspaceState;
  const projects = st?.projects || [];
  const all = el('button', `ws-chip${filter ? '' : ' active'}`, 'All');
  all.type = 'button';
  all.onclick = () => { filter = null; renderWorkspace(); };
  workspaceProjectsEl.appendChild(all);
  for (const p of projects) {
    const chip = el('button', `ws-chip${filter === p.name ? ' active' : ''}`);
    chip.type = 'button';
    chip.textContent = `${st.activeProject === p.name ? '★ ' : ''}${p.name}`;
    chip.title = st.activeProject === p.name ? 'Cowork project — click to filter' : 'Click to filter · double-click to make it the Cowork project';
    chip.onclick = () => { filter = filter === p.name ? null : p.name; renderWorkspace(); };
    chip.ondblclick = () => send({ type: 'workspace_set_active', name: p.name });
    workspaceProjectsEl.appendChild(chip);
  }
}

function renderPreviews() {
  workspacePreviews.innerHTML = '';
  workspacePreviews.classList.toggle('hidden', !previews.length);
  if (!previews.length) return;
  workspacePreviews.appendChild(el('div', 'usage-section-title', 'Live previews'));
  for (const p of previews) {
    const r = el('div', 'preview-row');
    const main = el('div', 'session-main');
    main.append(el('div', 'session-title', `Port ${p.port}`), el('div', 'session-time', p.command || 'running'));
    main.onclick = () => openPreview(p.port);
    main.title = 'Open in the viewer';
    const stop = el('button', 'scheduled-new-btn', 'Stop');
    stop.type = 'button';
    stop.onclick = (e) => { e.stopPropagation(); send({ type: 'preview_stop', port: p.port }); };
    r.append(el('span', 'task-icon', '▶'), main, stop);
    workspacePreviews.appendChild(r);
  }
}

export function applyPreviews(list) {
  previews = Array.isArray(list) ? list : [];
  if (!workspacePanel.classList.contains('hidden')) renderPreviews();
}

export function renderWorkspace() {
  renderInfo();
  renderProjects();
  renderPreviews();
  workspaceListEl.innerHTML = '';
  const files = filter ? S.workspace.filter((f) => f.path.startsWith(`${filter}/`)) : S.workspace;
  if (!files.length) {
    workspaceListEl.appendChild(el('div', 'sessions-empty',
      filter ? 'This project is empty.' : 'Nothing here yet — files Claude saves to the workspace will show up here.'));
    return;
  }
  for (const f of files) {
    const row = el('div', 'session-item workspace-item');
    row.title = isPreviewable(f.ext) ? 'Open in the viewer' : 'Open';
    row.onclick = () => (isPreviewable(f.ext) ? openArtifact(f.path, f.ext) : window.open(fileUrl(f.path), '_blank', 'noopener'));

    const icon = el('span', 'task-icon', ICONS_BY_EXT[f.ext] || iconFor(f.ext));
    const main = el('div', 'session-main');
    main.append(el('div', 'session-title', f.path), el('div', 'session-time', `${formatSize(f.size)} · ${relTime(f.mtime)}`));
    const ext = el('a', 'workspace-ext', '↗');
    ext.href = fileUrl(f.path);
    ext.target = '_blank';
    ext.rel = 'noopener';
    ext.title = 'Open in a new tab';
    ext.onclick = (e) => e.stopPropagation();
    row.append(icon, main, ext);
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
  send({ type: 'workspace_state' });
  send({ type: 'previews_list' });
  workspacePanel.classList.remove('hidden');
  workspaceBtn.classList.add('active');
}
export function closeWorkspace() {
  workspacePanel.classList.add('hidden');
  workspaceBtn.classList.remove('active');
  workspaceRootForm.classList.add('hidden');
}

/** Called from connection.js whenever the server pushes a fresh listing. */
export function applyWorkspaceEntries(entries) {
  S.workspace = Array.isArray(entries) ? entries : [];
  if (!workspacePanel.classList.contains('hidden')) renderWorkspace();
}

export function applyWorkspaceState(state) {
  S.workspaceState = state || null;
  if (state?.activeProject && !S.coworkProject) S.coworkProject = state.activeProject;
  renderProjectSelect();
  if (!workspacePanel.classList.contains('hidden')) renderWorkspace();
}

export function applyWorkspaceResult(msg) {
  if (msg.action === 'set_root') {
    if (msg.ok) { workspaceRootForm.classList.add('hidden'); refreshWorkspace(); }
    else { workspaceRootError.textContent = msg.error || 'Could not use that folder.'; workspaceRootError.classList.remove('hidden'); }
  } else if (msg.action === 'create_project' && msg.ok) {
    filter = msg.name;
    S.coworkProject = msg.name;
    refreshWorkspace();
  } else if (!msg.ok && msg.error) {
    alert(msg.error);
  }
}

workspaceBtn.onclick = (e) => {
  e.stopPropagation();
  if (workspacePanel.classList.contains('hidden')) openWorkspace();
  else closeWorkspace();
};

workspaceFolderBtn.onclick = () => {
  workspaceRootInput.value = S.workspaceState?.root || '';
  workspaceRootError.classList.add('hidden');
  workspaceRootForm.classList.toggle('hidden');
  if (!workspaceRootForm.classList.contains('hidden')) workspaceRootInput.focus();
};
workspaceRootCancel.onclick = () => workspaceRootForm.classList.add('hidden');
workspaceRootDefault.onclick = () => send({ type: 'workspace_set_root', path: S.workspaceState?.defaultRoot || '/data/workspace' });
workspaceRootForm.onsubmit = (e) => {
  e.preventDefault();
  send({ type: 'workspace_set_root', path: workspaceRootInput.value.trim() });
};
workspaceNewProject.onclick = () => {
  const name = prompt('New project folder name:');
  if (name && name.trim()) send({ type: 'workspace_create_project', name: name.trim(), activate: true });
};

workspaceNewFile.onclick = () => {
  const suggestion = filter ? `${filter}/notes.md` : 'notes.md';
  const rel = prompt('New file (path inside the workspace):', suggestion);
  if (rel && rel.trim()) createFile(rel.trim().replace(/^\/+/, ''));
};

document.addEventListener('click', (e) => {
  // A click that re-rendered the panel leaves its target detached — it was
  // still inside, so it must not count as a click outside.
  if (!e.target.isConnected) return;
  if (workspacePanel.classList.contains('hidden')) return;
  if (workspacePanel.contains(e.target) || workspaceBtn.contains(e.target)) return;
  closeWorkspace();
});
