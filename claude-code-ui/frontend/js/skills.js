/*
 * The Skills panel (server: server/lib/skills.js).
 *
 * Lists every skill the agent can load, grouped by where it comes from —
 * the user's claude.ai account (synced down automatically), the app's plugins,
 * and their own local skills — with a switch to turn any of them off, a view
 * of its SKILL.md, a .zip export (to upload to claude.ai), and a form to
 * create / edit / delete local skills.
 *
 * Sharing: "Import" takes a .zip (one skill or a bundle of several) or a
 * SKILL.md; "Export all" downloads every local skill in one .zip; "Share"
 * writes one .zip per local skill into the workspace's shared folder
 * (01_Templates/Skills, or Skills/) — the Drive sync makes that a Drive folder
 * others can be given, and whatever .zip lands there is listed to install.
 */
import { registerPanel } from './panels.js';
import { S } from './state.js';
import {
  wsBase, skillsBtn, skillsPanel, skillsInfoEl, skillsListEl, skillsNewBtn, skillForm,
  skillNameInput, skillDescInput, skillBodyInput, skillFormError, skillFormCancel,
  skillView, skillViewTitle, skillViewBody, skillViewClose, settingsSkillsBtn, settingsPanel,
} from './dom.js';
import { relTime } from './workspace.js';
import { confirmAction } from './confirm.js';
import { showToast } from './toast.js';

const GROUPS = [
  ['account', 'From your Claude account'],
  ['local', 'Your skills (on this Home Assistant)'],
  ['plugin', 'Built into Soufassistant'],
];

let data = { skills: [], lastSync: null };
let editingId = null;      // local skill being edited, null = creating
let pendingView = false;   // skill_detail requested for viewing (vs editing)

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
  skillsInfoEl.innerHTML = '';
  const n = data.skills.filter((s) => s.source === 'account').length;
  const line = el('div', 'workspace-sync');
  line.textContent = n
    ? `${n} skill${n > 1 ? 's' : ''} synced from claude.ai${data.lastSync ? ` · ${relTime(data.lastSync)}` : ''}. `
    : 'No skills synced from claude.ai yet. ';
  const a = el('a', 'skills-link', 'Manage them on claude.ai ↗');
  a.href = 'https://claude.ai/settings/capabilities';
  a.target = '_blank';
  a.rel = 'noopener';
  line.appendChild(a);
  skillsInfoEl.appendChild(line);
  skillsInfoEl.appendChild(el('div', 'usage-note',
    'Switching a skill off hides it from Claude here. To add one of yours to your account, export it (⇩) and upload the .zip on claude.ai — it then syncs back automatically.'));
  skillsInfoEl.appendChild(shareBar());
  if (shared.files.length) skillsInfoEl.appendChild(sharedList());
}

// ── Sharing ─────────────────────────────────────────────────────────────────
let shared = { dir: '', files: [] };

async function refreshShared() {
  try {
    shared = await (await fetch(`${wsBase}/api/skills/shared`, { cache: 'no-store' })).json();
  } catch { shared = { dir: '', files: [] }; }
  if (!skillsPanel.classList.contains('hidden')) renderInfo();
}

function reportImport(r) {
  if (!r.ok && !r.installed) { showToast(r.error || 'Import failed.', { kind: 'error' }); return; }
  const parts = [];
  if (r.installed?.length) parts.push(`Installed: ${r.installed.join(', ')}`);
  if (r.skipped?.length) parts.push(`Skipped: ${r.skipped.map((x) => `${x.name} (${x.reason})`).join(', ')}`);
  showToast(parts.join(' · ') || 'Nothing to install.');
}

/** Import, retrying with "replace" when the user agrees to overwrite. */
async function importWith(doRequest) {
  let r = await doRequest(false);
  const clash = (r.skipped || []).filter((x) => x.reason === 'already installed');
  if (clash.length && !(r.installed || []).length) {
    const ok = await confirmAction({
      title: 'Replace existing skills?',
      body: `Already installed: ${clash.map((x) => x.name).join(', ')}. Replace them with the imported version?`,
      confirm: 'Replace', cancel: 'Keep mine',
    });
    if (ok) r = await doRequest(true);
  }
  reportImport(r);
}

function shareBar() {
  const row = el('div', 'skills-share');
  const file = el('input');
  file.type = 'file';
  file.accept = '.zip,.skill,.md';
  file.className = 'hidden';
  file.onchange = async () => {
    const f = file.files?.[0];
    file.value = '';
    if (!f) return;
    const buf = await f.arrayBuffer();
    await importWith(async (replace) => (await fetch(`${wsBase}/api/skills/import${replace ? '?replace=1' : ''}`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: buf,
    })).json().catch(() => ({ ok: false, error: 'Import failed.' })));
  };
  const imp = el('button', 'session-menu-btn', '⇪ Import…');
  imp.type = 'button';
  imp.title = 'Install skills from a .zip (one or several) or a SKILL.md';
  imp.onclick = () => file.click();
  const local = data.skills.filter((x) => x.source === 'local');
  const all = el('a', 'session-menu-btn artifact-link', '⇩ Export all');
  all.href = `${wsBase}/api/skills/bundle`;
  all.title = 'Download all your skills in one .zip (to give to someone, or as a backup)';
  all.setAttribute('download', 'skills.zip');
  all.classList.toggle('hidden', !local.length);
  const share = el('button', 'session-menu-btn', '⇄ Share to the workspace');
  share.type = 'button';
  share.title = 'Write one .zip per skill into the shared folder of your workspace (synced to your Drive) — ready to upload to claude.ai or to give to someone';
  share.classList.toggle('hidden', !local.length);
  share.onclick = async () => {
    const r = await (await fetch(`${wsBase}/api/skills/share`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    })).json().catch(() => ({ ok: false }));
    if (r.ok) showToast(`${r.written.length} skill${r.written.length > 1 ? 's' : ''} written to ${r.dir}/`);
    else showToast(r.error || 'Could not share.', { kind: 'error' });
    refreshShared();
  };
  row.append(imp, file, all, share);
  return row;
}

function sharedList() {
  const box = el('div', 'skills-shared');
  box.appendChild(el('div', 'usage-section-title', `In ${shared.dir}/`));
  const have = new Set(data.skills.map((x) => x.folder));
  for (const f of shared.files) {
    const row = el('div', 'skill-row');
    const name = f.name.replace(/\.(zip|skill)$/i, '');
    const main = el('div', 'skill-main');
    main.append(el('div', 'skill-title', name), el('div', 'skill-desc', `${have.has(name) ? 'installed · ' : ''}${relTime(f.mtime)}`));
    const b = el('button', 'session-menu-btn', have.has(name) ? 'Update' : 'Install');
    b.type = 'button';
    b.onclick = () => importWith(async (replace) => (await fetch(`${wsBase}/api/skills/import-shared`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: f.path, replace: replace || have.has(name) }),
    })).json().catch(() => ({ ok: false, error: 'Import failed.' })));
    row.append(main, b);
    box.appendChild(row);
  }
  return box;
}

function skillRow(s) {
  const row = el('div', 'skill-row');
  const main = el('div', 'skill-main');
  const title = el('div', 'skill-title', s.name);
  if (s.invocation && s.invocation !== s.name) title.appendChild(el('span', 'skill-inv', s.invocation));
  main.append(title, el('div', 'skill-desc', s.description || '—'));
  main.title = s.description || '';
  main.onclick = () => { pendingView = true; send({ type: 'skill_get', id: s.id }); };

  const actions = el('div', 'skill-actions');
  const exp = el('a', 'find-nav artifact-link', '⇩');
  exp.href = `${wsBase}/api/skills/export?id=${encodeURIComponent(s.id)}`;
  exp.title = 'Export as .zip (to upload to claude.ai)';
  exp.setAttribute('download', `${s.folder || s.name}.zip`);
  actions.appendChild(exp);
  if (s.editable) {
    const edit = el('button', 'find-nav', '✎');
    edit.type = 'button';
    edit.title = 'Edit';
    edit.onclick = () => { pendingView = false; editingId = s.id; send({ type: 'skill_get', id: s.id }); };
    const del = el('button', 'find-nav', '🗑');
    del.type = 'button';
    del.title = 'Delete';
    del.onclick = () => { if (confirm(`Delete the skill "${s.name}"?`)) send({ type: 'skill_delete', id: s.id }); };
    actions.append(edit, del);
  }
  const toggle = el('input', 'settings-toggle skill-toggle');
  toggle.type = 'checkbox';
  toggle.checked = s.enabled;
  toggle.title = s.enabled ? 'On — click to turn off' : 'Off — click to turn on';
  toggle.onchange = () => send({ type: 'skill_toggle', id: s.id, enabled: toggle.checked });
  actions.appendChild(toggle);

  row.classList.toggle('skill-off', !s.enabled);
  row.append(main, actions);
  return row;
}

export function renderSkills() {
  renderInfo();
  skillsListEl.innerHTML = '';
  for (const [source, label] of GROUPS) {
    const items = data.skills.filter((s) => s.source === source);
    if (!items.length && source !== 'local') continue;
    skillsListEl.appendChild(el('div', 'usage-section-title skills-group', label));
    if (!items.length) skillsListEl.appendChild(el('div', 'sessions-empty', 'None yet — “+ New” creates one.'));
    for (const s of items) skillsListEl.appendChild(skillRow(s));
  }
}

function showForm(skill) {
  skillView.classList.add('hidden');
  skillForm.classList.remove('hidden');
  skillFormError.classList.add('hidden');
  skillNameInput.value = skill?.name || '';
  skillDescInput.value = skill?.description || '';
  skillBodyInput.value = skill?.body?.trim() || '';
  skillNameInput.focus();
}

export function applySkills(msg) {
  data = { skills: Array.isArray(msg.skills) ? msg.skills : [], lastSync: msg.lastSync || null };
  if (!skillsPanel.classList.contains('hidden')) renderSkills();
}

export function applySkillDetail(msg) {
  const s = msg.skill;
  if (!s) return;
  if (pendingView) {
    pendingView = false;
    skillForm.classList.add('hidden');
    skillViewTitle.textContent = `${s.name} — ${s.source}`;
    skillViewBody.textContent = `${s.description}\n\n${s.body}`;
    skillView.classList.remove('hidden');
  } else {
    showForm(s);
  }
}

export function applySkillResult(msg) {
  if (msg.ok) {
    skillForm.classList.add('hidden');
    editingId = null;
  } else {
    skillFormError.textContent = msg.error || 'Could not save.';
    skillFormError.classList.remove('hidden');
  }
}

export function openSkills() {
  send({ type: 'skills_list' });
  refreshShared();
  renderSkills();
  skillsPanel.classList.remove('hidden');
  skillsBtn.classList.add('active');
}
export function closeSkills() {
  skillsPanel.classList.add('hidden');
  skillsBtn.classList.remove('active');
  skillForm.classList.add('hidden');
  skillView.classList.add('hidden');
}

skillsBtn.onclick = (e) => {
  e.stopPropagation();
  if (skillsPanel.classList.contains('hidden')) openSkills();
  else closeSkills();
};
// The header button is hidden on phones; Settings has the same entry point.
settingsSkillsBtn.onclick = (e) => {
  e.stopPropagation();
  settingsPanel.classList.add('hidden');
  openSkills();
};
skillsNewBtn.onclick = () => { editingId = null; showForm(null); };
skillFormCancel.onclick = () => { skillForm.classList.add('hidden'); editingId = null; };
skillViewClose.onclick = () => skillView.classList.add('hidden');
skillForm.onsubmit = (e) => {
  e.preventDefault();
  send({ type: 'skill_save', id: editingId, name: skillNameInput.value, description: skillDescInput.value, body: skillBodyInput.value });
};

document.addEventListener('click', (e) => {
  // A click that re-rendered the panel leaves its target detached — it was
  // still inside, so it must not count as a click outside.
  if (!e.target.isConnected) return;
  if (skillsPanel.classList.contains('hidden')) return;
  if (skillsPanel.contains(e.target) || skillsBtn.contains(e.target) || settingsSkillsBtn.contains(e.target)) return;
  closeSkills();
});

registerPanel(skillsPanel, closeSkills);
