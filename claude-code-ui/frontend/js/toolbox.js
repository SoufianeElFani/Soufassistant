/*
 * The composer's ✚ menu — how a message is worked on, beyond roles:
 *
 *   Agent           a custom assistant (agents.js on the server): its
 *                   instructions, model, effort, skills; remembered per conversation
 *   Deep research   several minutes of sourced research → a report in the workspace
 *   Autonomous      runs to the end without asking (plan in the Tasks panel,
 *                   notification when done) — like Manus
 *   Project         a workspace project's instructions + knowledge, in Chat or
 *                   Code mode too (Cowork uses its own project)
 *
 * Picks show as chips above the text (next to the roles) and go with each
 * prompt (toolboxFields). Research and Autonomous are for one message: they
 * switch themselves off once it is sent.
 */
import { S } from './state.js';
import { wsBase, rolesChips } from './dom.js';
import { registerPanel } from './panels.js';

let agents = [];
let sessionAgents = {};
let agentId = localStorage.getItem('agent') || null;
let research = false;
let autonomous = false;
let project = localStorage.getItem('knowledgeProject') || '';
let projects = [];

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

// ── Markup (built here: the composer row is shared with other modules) ──
const left = document.querySelector('.composer-left');
const btn = el('button', 'attach-btn toolbox-btn');
btn.type = 'button';
btn.id = 'toolbox-btn';
btn.title = 'Agent, deep research, autonomous task, project knowledge';
btn.setAttribute('aria-label', 'Tools');
btn.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/></svg><span class="roles-count hidden"></span>';
left.insertBefore(btn, document.getElementById('roles-btn').nextSibling);
const menu = el('div', 'cmd-menu roles-menu toolbox-menu hidden');
menu.setAttribute('role', 'menu');
document.getElementById('roles-menu').after(menu);
const chips = el('div', 'roles-chips toolbox-chips hidden');
rolesChips.before(chips);

export const currentAgent = () => agents.find((a) => a.id === agentId) || null;

/** What goes with a prompt. */
export function toolboxFields() {
  const f = { agent: currentAgent()?.id || null };
  if (research) f.research = true;
  if (autonomous) f.autonomous = true;
  if (project && S.mode !== 'cowork' && projects.includes(project)) f.project = project;
  return f;
}

/** Turn the one-message options on from elsewhere (the home screen, the palette). */
export function setResearch(on) { research = !!on; render(); }
export function setAutonomous(on) { autonomous = !!on; render(); }
export function openToolbox() { openMenu(); }

/** After a send: the one-message options switch off. */
export function afterSend() {
  if (research || autonomous) { research = false; autonomous = false; render(); }
}

function setAgent(id, { persist = true } = {}) {
  agentId = id || null;
  if (persist) {
    if (agentId) localStorage.setItem('agent', agentId); else localStorage.removeItem('agent');
    if (S.activeSessionId) {
      sessionAgents[S.activeSessionId] = agentId;
      fetch(`${wsBase}/api/agents/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: S.activeSessionId, agent: agentId }) }).catch(() => {});
    }
    // An agent with a fixed mode switches to it.
    const a = currentAgent();
    if (a?.mode && a.mode !== S.mode) document.querySelector(`.mode-btn[data-mode="${a.mode}"]`)?.click();
  }
  render();
}

function chip(label, title, onX, cls = '') {
  const c = el('span', `role-chip ${cls}`);
  c.title = title;
  c.appendChild(el('span', 'role-chip-label', label));
  const x = el('button', 'role-chip-x', '×');
  x.type = 'button';
  x.setAttribute('aria-label', `Remove ${label}`);
  x.onclick = (e) => { e.stopPropagation(); onX(); };
  c.appendChild(x);
  return c;
}

export function render() {
  const a = currentAgent();
  const showProject = project && S.mode !== 'cowork' && projects.includes(project);
  const n = (a ? 1 : 0) + (research ? 1 : 0) + (autonomous ? 1 : 0) + (showProject ? 1 : 0);
  const count = btn.querySelector('.roles-count');
  count.textContent = n ? String(n) : '';
  count.classList.toggle('hidden', !n);
  btn.classList.toggle('active', n > 0);
  chips.innerHTML = '';
  if (a) chips.appendChild(chip(`${a.icon} ${a.name}`, a.description || a.name, () => setAgent(null), 'chip-agent'));
  if (research) chips.appendChild(chip('🔭 Deep research', 'Several minutes of sourced research; a report is saved in the workspace', () => { research = false; render(); }, 'chip-research'));
  if (autonomous) chips.appendChild(chip('🚀 Autonomous', 'Runs to the end without asking you; you get a notification', () => { autonomous = false; render(); }, 'chip-auto'));
  if (showProject) chips.appendChild(chip(`📁 ${project}`, 'Uses this project\'s instructions and knowledge', () => { project = ''; localStorage.removeItem('knowledgeProject'); render(); }));
  chips.classList.toggle('hidden', !chips.children.length);
  if (!menu.classList.contains('hidden')) renderMenu();
}

function item(label, desc, checked, onChange, type = 'checkbox', name) {
  const row = el('label', 'cmd-item roles-menu-item');
  const box = el('input', 'roles-menu-check');
  box.type = type;
  if (name) box.name = name;
  box.checked = checked;
  box.onchange = onChange;
  const t = el('div', 'roles-menu-text');
  t.append(el('div', 'roles-menu-name', label), el('div', 'roles-menu-desc', desc));
  row.append(box, t);
  return row;
}

function renderMenu() {
  menu.innerHTML = '';
  menu.appendChild(el('div', 'roles-menu-head', 'For this message'));
  menu.appendChild(item('🔭 Deep research', 'Searches the web for several minutes, cross-checks sources and writes a sourced report into the workspace.', research, (e) => { research = e.target.checked; render(); }));
  menu.appendChild(item('🚀 Autonomous task', 'Works to the end on its own — plan in the Tasks panel, no permission prompts or questions, a notification when done. You can close the app.', autonomous, (e) => { autonomous = e.target.checked; render(); }));
  menu.appendChild(el('div', 'roles-menu-head', 'Agent'));
  menu.appendChild(item('None', 'Claude as usual.', !currentAgent(), () => setAgent(null), 'radio', 'tb-agent'));
  for (const a of agents) menu.appendChild(item(`${a.icon} ${a.name}`, a.description || a.instructions.slice(0, 120), a.id === agentId, () => setAgent(a.id), 'radio', 'tb-agent'));
  if (S.mode !== 'cowork' && projects.length) {
    menu.appendChild(el('div', 'roles-menu-head', 'Project knowledge'));
    const sel = el('select', 'perm-mode-select toolbox-project');
    sel.appendChild(new Option('No project', ''));
    for (const p of projects) sel.appendChild(new Option(p, p));
    sel.value = projects.includes(project) ? project : '';
    sel.onchange = () => { project = sel.value; if (project) localStorage.setItem('knowledgeProject', project); else localStorage.removeItem('knowledgeProject'); render(); };
    const wrap = el('div', 'toolbox-project-row');
    wrap.append(sel);
    menu.appendChild(wrap);
  }
  const foot = el('div', 'roles-menu-foot');
  const manage = el('button', 'scheduled-new-btn', 'Manage agents…');
  manage.type = 'button';
  manage.onclick = (e) => { e.stopPropagation(); closeMenu(); import('./hub.js').then((h) => h.openHub('agents')); };
  foot.appendChild(manage);
  menu.appendChild(foot);
}

function openMenu() { renderMenu(); menu.classList.remove('hidden'); btn.setAttribute('aria-expanded', 'true'); }
function closeMenu() { menu.classList.add('hidden'); btn.setAttribute('aria-expanded', 'false'); }
btn.onclick = (e) => { e.stopPropagation(); if (menu.classList.contains('hidden')) openMenu(); else closeMenu(); };
document.addEventListener('click', (e) => {
  if (!e.target.isConnected || menu.classList.contains('hidden')) return;
  if (!menu.contains(e.target) && !btn.contains(e.target)) closeMenu();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !menu.classList.contains('hidden')) closeMenu(); });
registerPanel(menu, closeMenu);

// ── Server messages ──
export function applyAgents(msg) {
  agents = Array.isArray(msg.agents) ? msg.agents : [];
  sessionAgents = msg.sessions || {};
  if (S.activeSessionId && S.activeSessionId in sessionAgents) agentId = sessionAgents[S.activeSessionId];
  render();
}
/** Another conversation is on screen: its agent (or the last picked, for a new one). */
export function applySessionAgent(sessionId) {
  agentId = sessionId && sessionAgents[sessionId] !== undefined ? sessionAgents[sessionId] : (sessionId ? null : localStorage.getItem('agent'));
  render();
}
export function applyProjects(list) {
  projects = (list || []).map((p) => (typeof p === 'string' ? p : p.name));
  render();
}
export function listAgentsCache() { return agents; }

render();
