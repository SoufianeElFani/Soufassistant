/*
 * The task-list widget (server/lib/tasks.js), driven by the claude-tasks CLI.
 * Independent of the transcript — a small checklist panel, like Sessions.
 */
import { registerPanel } from './panels.js';
import { S } from './state.js';
import { tasksBtn, tasksPanel, tasksListEl } from './dom.js';

const ICONS = { pending: '○', in_progress: '◐', completed: '●' };

export function renderTasks() {
  tasksListEl.innerHTML = '';
  if (!S.tasks.length) {
    const empty = document.createElement('div');
    empty.className = 'sessions-empty';
    empty.textContent = 'No tasks right now.';
    tasksListEl.appendChild(empty);
    return;
  }
  for (const t of S.tasks) {
    const row = document.createElement('div');
    row.className = 'session-item task-item';
    const icon = document.createElement('span');
    icon.className = `task-icon task-icon-${t.status}`;
    icon.textContent = ICONS[t.status] || '○';
    const main = document.createElement('div');
    main.className = 'session-main';
    const title = document.createElement('div');
    title.className = 'session-title' + (t.status === 'completed' ? ' task-done' : '');
    title.textContent = t.description;
    main.appendChild(title);
    row.append(icon, main);
    tasksListEl.appendChild(row);
  }
}

/** The button only appears once there is something to show — an empty
 *  checklist is one more thing to glance at and dismiss for nothing. */
export function updateTasksVisibility() {
  const has = S.tasks.length > 0;
  tasksBtn.classList.toggle('hidden', !has);
  if (!has) closeTasks();
  const done = S.tasks.filter((t) => t.status === 'completed').length;
  tasksBtn.title = has ? `Tasks — ${done}/${S.tasks.length} done` : 'Tasks';
}

export function openTasks() {
  renderTasks();
  tasksPanel.classList.remove('hidden');
  tasksBtn.classList.add('active');
}
export function closeTasks() {
  tasksPanel.classList.add('hidden');
  tasksBtn.classList.remove('active');
}

tasksBtn.onclick = (e) => {
  e.stopPropagation();
  if (tasksPanel.classList.contains('hidden')) openTasks();
  else closeTasks();
};

document.addEventListener('click', (e) => {
  if (tasksPanel.classList.contains('hidden')) return;
  if (tasksPanel.contains(e.target) || tasksBtn.contains(e.target)) return;
  closeTasks();
});

registerPanel(tasksPanel, closeTasks);
