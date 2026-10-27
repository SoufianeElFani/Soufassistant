/*
 * Roles — the hats a prompt is written in (server: server/lib/roles.js).
 *
 * The button under the message box opens a short menu to pick one or more;
 * the picks show as chips above the text and go with every prompt (`roles`),
 * where the server adds each one's context to the system prompt. A
 * conversation remembers its roles: opening it restores them, and changing
 * them there is saved straight away. A new conversation starts with the roles
 * picked last. The Roles panel (also in Settings) adds, edits and deletes them.
 */
import { registerPanel } from './panels.js';
import { S } from './state.js';
import {
  rolesBtn, rolesCount, rolesMenu, rolesChips, rolesPanel, rolesListEl, rolesNewBtn,
  roleForm, roleNameInput, roleShortInput, roleContextInput, roleFormError, roleFormCancel,
  settingsRolesBtn, settingsPanel,
} from './dom.js';
import { confirmAction } from './confirm.js';

let roles = [];
let sessionRoles = {};      // sessionId → [roleId]
let selected = readDefault();
let loaded = false;
let editingId = null;       // role being edited, null = creating

function readDefault() {
  try { const v = JSON.parse(localStorage.getItem('roles') || '[]'); return Array.isArray(v) ? v : []; }
  catch { return []; }
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

export const roleLabel = (r) => r.short || r.name;

/** The role ids to send with a prompt — only ones that still exist. */
export function currentRoleIds() {
  const known = new Set(roles.map((r) => r.id));
  return selected.filter((id) => known.has(id));
}

/** A conversation's roles, as objects (the Sessions list shows them). */
export function rolesOf(sessionId) {
  const ids = (sessionId && sessionRoles[sessionId]) || [];
  return ids.map((id) => roles.find((r) => r.id === id)).filter(Boolean);
}

function setSelected(ids, { persist = true } = {}) {
  selected = [...new Set(ids)];
  if (persist) {
    localStorage.setItem('roles', JSON.stringify(selected));
    // An existing conversation keeps its roles from now on.
    if (S.activeSessionId) {
      sessionRoles[S.activeSessionId] = selected.slice();
      send({ type: 'session_roles', id: S.activeSessionId, roles: selected });
    }
  }
  renderPicker();
}

function toggleRole(id) {
  setSelected(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
}

// ── The picker: button, menu, chips ─────────────────────────────────────────
export function renderPicker() {
  const picked = currentRoleIds().map((id) => roles.find((r) => r.id === id));
  rolesCount.textContent = picked.length ? String(picked.length) : '';
  rolesCount.classList.toggle('hidden', !picked.length);
  rolesBtn.classList.toggle('active', picked.length > 0);
  rolesBtn.title = picked.length ? `Writing as: ${picked.map((r) => r.name).join(' + ')}` : 'Write as… (roles)';

  rolesChips.innerHTML = '';
  rolesChips.classList.toggle('hidden', !picked.length);
  for (const r of picked) {
    const chip = el('span', 'role-chip');
    chip.title = r.name;
    chip.appendChild(el('span', 'role-chip-label', roleLabel(r)));
    const x = el('button', 'role-chip-x', '×');
    x.type = 'button';
    x.title = `Stop writing as ${r.name}`;
    x.setAttribute('aria-label', x.title);
    x.onclick = (e) => { e.stopPropagation(); toggleRole(r.id); };
    chip.appendChild(x);
    rolesChips.appendChild(chip);
  }
  if (!rolesMenu.classList.contains('hidden')) renderMenu();
}

function renderMenu() {
  rolesMenu.innerHTML = '';
  rolesMenu.appendChild(el('div', 'roles-menu-head', 'Write as…'));
  if (!roles.length) rolesMenu.appendChild(el('div', 'sessions-empty', 'No roles yet.'));
  for (const r of roles) {
    const item = el('label', 'cmd-item roles-menu-item');
    item.setAttribute('role', 'menuitemcheckbox');
    const box = el('input', 'roles-menu-check');
    box.type = 'checkbox';
    box.checked = selected.includes(r.id);
    box.onchange = () => toggleRole(r.id);
    const text = el('div', 'roles-menu-text');
    text.append(el('div', 'roles-menu-name', r.name), el('div', 'roles-menu-desc', r.context));
    item.append(box, text);
    rolesMenu.appendChild(item);
  }
  const foot = el('div', 'roles-menu-foot');
  if (selected.length) {
    const none = el('button', 'scheduled-new-btn', 'None');
    none.type = 'button';
    none.onclick = (e) => { e.stopPropagation(); setSelected([]); };
    foot.appendChild(none);
  }
  const manage = el('button', 'scheduled-new-btn', 'Manage roles…');
  manage.type = 'button';
  manage.onclick = (e) => { e.stopPropagation(); closeMenu(); openRoles(); };
  foot.appendChild(manage);
  rolesMenu.appendChild(foot);
}

function openMenu() {
  renderMenu();
  rolesMenu.classList.remove('hidden');
  rolesBtn.setAttribute('aria-expanded', 'true');
}
function closeMenu() {
  rolesMenu.classList.add('hidden');
  rolesBtn.setAttribute('aria-expanded', 'false');
}

rolesBtn.onclick = (e) => {
  e.stopPropagation();
  if (rolesMenu.classList.contains('hidden')) openMenu();
  else closeMenu();
};

// ── Following the conversation on screen ────────────────────────────────────
/** Another conversation is on screen: show the roles it uses. */
export function applySessionRoles(sessionId) {
  if (!sessionId) return;
  setSelected(sessionRoles[sessionId] || [], { persist: false });
}

/** A new conversation: it starts with the roles picked last. */
export function resetRolesForNewConversation() {
  setSelected(readDefault(), { persist: false });
}

export function applyRoles(msg) {
  roles = Array.isArray(msg.roles) ? msg.roles : [];
  sessionRoles = msg.sessions && typeof msg.sessions === 'object' ? msg.sessions : {};
  // On load the map lands after the conversation itself: restore its roles once.
  if (!loaded && S.activeSessionId) setSelected(sessionRoles[S.activeSessionId] || [], { persist: false });
  loaded = true;
  renderPicker();
  if (!rolesPanel.classList.contains('hidden')) renderRolesPanel();
}

// ── The Roles panel ─────────────────────────────────────────────────────────
function roleRow(r) {
  const row = el('div', 'skill-row');
  const main = el('div', 'skill-main');
  const title = el('div', 'skill-title', r.name);
  if (r.short) title.appendChild(el('span', 'skill-inv', r.short));
  main.append(title, el('div', 'skill-desc', r.context));
  main.title = r.context;
  main.onclick = () => showForm(r);

  const actions = el('div', 'skill-actions');
  const edit = el('button', 'find-nav', '✎');
  edit.type = 'button';
  edit.title = 'Edit';
  edit.onclick = () => showForm(r);
  const del = el('button', 'find-nav', '🗑');
  del.type = 'button';
  del.title = 'Delete';
  del.onclick = async () => {
    const ok = await confirmAction({
      title: `Delete the role “${r.name}”?`,
      body: 'Conversations that used it keep their messages; it is just no longer added to them.',
      confirm: 'Delete', cancel: 'Keep it',
    });
    if (ok) send({ type: 'role_delete', id: r.id });
  };
  const use = el('input', 'settings-toggle skill-toggle');
  use.type = 'checkbox';
  use.checked = selected.includes(r.id);
  use.title = use.checked ? 'Used in this conversation — click to stop' : 'Use in this conversation';
  use.onchange = () => { toggleRole(r.id); renderRolesPanel(); };
  actions.append(edit, del, use);
  row.append(main, actions);
  return row;
}

export function renderRolesPanel() {
  rolesListEl.innerHTML = '';
  if (!roles.length) rolesListEl.appendChild(el('div', 'sessions-empty', 'No roles yet — “+ New” creates one.'));
  for (const r of roles) rolesListEl.appendChild(roleRow(r));
}

function showForm(r) {
  editingId = r?.id || null;
  roleForm.classList.remove('hidden');
  roleFormError.classList.add('hidden');
  roleNameInput.value = r?.name || '';
  roleShortInput.value = r?.short || '';
  roleContextInput.value = r?.context || '';
  roleNameInput.focus();
}

export function applyRoleResult(msg) {
  if (msg.ok) {
    roleForm.classList.add('hidden');
    editingId = null;
  } else {
    roleFormError.textContent = msg.error || 'Could not save.';
    roleFormError.classList.remove('hidden');
  }
}

export function openRoles() {
  send({ type: 'roles_list' });
  renderRolesPanel();
  rolesPanel.classList.remove('hidden');
}
export function closeRoles() {
  rolesPanel.classList.add('hidden');
  roleForm.classList.add('hidden');
  editingId = null;
}

settingsRolesBtn.onclick = (e) => {
  e.stopPropagation();
  settingsPanel.classList.add('hidden');
  openRoles();
};
rolesNewBtn.onclick = () => showForm(null);
roleFormCancel.onclick = () => { roleForm.classList.add('hidden'); editingId = null; };
roleForm.onsubmit = (e) => {
  e.preventDefault();
  send({ type: 'role_save', id: editingId, name: roleNameInput.value, short: roleShortInput.value, context: roleContextInput.value });
};
// Typing in the form must not trigger the app's global shortcuts.
roleForm.addEventListener('keydown', (e) => e.stopPropagation());

document.addEventListener('click', (e) => {
  if (!e.target.isConnected) return;
  if (!rolesMenu.classList.contains('hidden') && !rolesMenu.contains(e.target) && !rolesBtn.contains(e.target)) closeMenu();
  if (rolesPanel.classList.contains('hidden')) return;
  if (rolesPanel.contains(e.target) || rolesMenu.contains(e.target) || settingsRolesBtn.contains(e.target)) return;
  // The confirmation card sits outside the panel.
  if (e.target.closest('#confirm-overlay')) return;
  closeRoles();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !rolesMenu.classList.contains('hidden')) closeMenu();
});

registerPanel(rolesPanel, closeRoles);
renderPicker();
