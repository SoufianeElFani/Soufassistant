/*
 * The Team panel — a 1:1 / team-roster tracker (server/lib/team.js). A
 * member card: name, role, free-text notes, and a relative "last 1:1" time.
 * Claude can also append a dated note via the team-notes CLI when told
 * about a conversation — this panel is where the person edits things by
 * hand and sees the result either way, same pattern as scheduled.js.
 */
import { S } from './state.js';
import { confirmAction } from './confirm.js';
import {
  teamBtn, teamPanel, teamListEl, teamNewBtn, teamForm,
  teamNameInput, teamRoleInput, teamNotesInput, teamFormError,
  teamFormCancel, teamFormSave,
} from './dom.js';

function relTime(ms) {
  if (!ms) return 'no 1:1 logged yet';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 14) return `${Math.floor(s / 86400)}d ago`;
  return `${Math.floor(s / 86400 / 7)}w ago`;
}

function send(msg) { if (S.ws && S.isConnected) S.ws.send(JSON.stringify(msg)); }

export function renderTeam() {
  teamListEl.innerHTML = '';
  if (!S.team.length) {
    const empty = document.createElement('div');
    empty.className = 'sessions-empty';
    empty.textContent = 'No team members yet.';
    teamListEl.appendChild(empty);
    return;
  }
  // Soonest-overdue 1:1 first (never-logged members first, then oldest).
  const sorted = [...S.team].sort((a, b) => (a.lastOneOnOne || 0) - (b.lastOneOnOne || 0));
  for (const m of sorted) {
    const row = document.createElement('div');
    row.className = 'session-item scheduled-item';

    const main = document.createElement('div');
    main.className = 'session-main';
    const title = document.createElement('div');
    title.className = 'session-title';
    title.textContent = m.role ? `${m.name} — ${m.role}` : m.name;
    const meta = document.createElement('div');
    meta.className = 'session-time';
    meta.textContent = `Last 1:1: ${relTime(m.lastOneOnOne)}`;
    main.append(title, meta);
    if (m.notes) {
      const notes = document.createElement('div');
      notes.className = 'scheduled-summary team-notes-preview';
      notes.textContent = m.notes.split('\n').slice(-1)[0];
      main.appendChild(notes);
    }

    const actions = document.createElement('div');
    actions.className = 'scheduled-actions';

    const touchBtn = document.createElement('button');
    touchBtn.className = 'session-del scheduled-action-btn';
    touchBtn.textContent = '✓';
    touchBtn.title = '1:1 today';
    touchBtn.onclick = (e) => {
      e.stopPropagation();
      send({ type: 'set_team_member', member: { id: m.id, name: m.name, role: m.role, notes: m.notes, touchOneOnOne: true } });
    };

    const editBtn = document.createElement('button');
    editBtn.className = 'session-del scheduled-action-btn';
    editBtn.textContent = '✎';
    editBtn.title = 'Edit';
    editBtn.onclick = (e) => { e.stopPropagation(); openForm(m); };

    const delBtn = document.createElement('button');
    delBtn.className = 'session-del';
    delBtn.textContent = '✕';
    delBtn.title = 'Remove';
    delBtn.onclick = async (e) => {
      e.stopPropagation();
      const ok = await confirmAction({
        title: 'Remove this team member?', body: `"${m.name}" and their notes will be removed. This cannot be undone.`,
        confirm: 'Remove', cancel: 'Keep it',
      });
      if (ok) send({ type: 'delete_team_member', id: m.id });
    };

    actions.append(touchBtn, editBtn, delBtn);
    row.append(main, actions);
    teamListEl.appendChild(row);
  }
}

function openForm(member) {
  S.teamEditingId = member?.id || null;
  teamNameInput.value = member?.name || '';
  teamRoleInput.value = member?.role || '';
  teamNotesInput.value = member?.notes || '';
  teamFormError.classList.add('hidden');
  teamForm.classList.remove('hidden');
  teamNameInput.focus();
}
function closeForm() {
  teamForm.classList.add('hidden');
  S.teamEditingId = null;
}

teamNewBtn.onclick = () => openForm(null);
teamFormCancel.onclick = () => closeForm();

teamForm.onsubmit = (e) => {
  e.preventDefault();
  const name = teamNameInput.value.trim();
  const role = teamRoleInput.value.trim();
  const notes = teamNotesInput.value.trim();
  if (!name) {
    teamFormError.textContent = 'A name is required.';
    teamFormError.classList.remove('hidden');
    return;
  }
  send({ type: 'set_team_member', member: { id: S.teamEditingId || undefined, name, role, notes } });
  closeForm();
};

export function showTeamError(message) {
  teamFormError.textContent = message;
  teamFormError.classList.remove('hidden');
  teamForm.classList.remove('hidden');
}

export function openTeam() {
  renderTeam();
  teamPanel.classList.remove('hidden');
  teamBtn.classList.add('active');
}
export function closeTeam() {
  teamPanel.classList.add('hidden');
  teamBtn.classList.remove('active');
  closeForm();
}

teamBtn.onclick = (e) => {
  e.stopPropagation();
  if (teamPanel.classList.contains('hidden')) openTeam();
  else closeTeam();
};

document.addEventListener('click', (e) => {
  if (teamPanel.classList.contains('hidden')) return;
  if (teamPanel.contains(e.target) || teamBtn.contains(e.target)) return;
  closeTeam();
});
