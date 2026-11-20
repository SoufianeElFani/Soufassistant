/*
 * The Hub — one header panel for what makes the assistant yours, in tabs:
 *
 *   Agents      custom assistants (GPTs-style): instructions, mode, model, skills
 *   Memory      what Claude remembers about you, editable (its auto-memory files)
 *   Projects    a project's instructions and knowledge documents
 *   Connectors  Gmail + Google Calendar (your own OAuth client), the browser agent
 *   Apps        apps published from Cowork projects, always online
 *   Shared      read-only links to a conversation or a file, and revoking them
 *   WhatsApp    the assistant over WhatsApp: setup guide, the relay in Home Assistant,
 *               Meta's keys, the household members allowed and their profile
 *
 * Everything goes through the REST routes in server/lib/hub-routes.js.
 * shareFile() / shareConversation() are also used by the viewer and Sessions.
 */
import { S } from './state.js';
import { wsBase, modelSelect } from './dom.js';
import { registerPanel } from './panels.js';
import { confirmAction } from './confirm.js';
import { redactAttachment, blackOut } from './redact.js';
import { secretField, reveal } from './confidential.js';
import { showToast } from './toast.js';
import { listAgentsCache } from './toolbox.js';

const TABS = [['confidential', 'Confidentiel'], ['agents', 'Agents'], ['memory', 'Memory'], ['projects', 'Projects'], ['connectors', 'Connectors'], ['apps', 'Apps'], ['shared', 'Shared'], ['whatsapp', 'WhatsApp']];
let tab = 'agents';
let apps = [];

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const button = (label, title, onclick, cls = 'session-menu-btn') => {
  const b = el('button', cls, label);
  b.type = 'button';
  if (title) b.title = title;
  b.onclick = (e) => { e.stopPropagation(); onclick(e); };
  return b;
};
const api = async (route, body) => {
  const init = body === undefined ? { cache: 'no-store' }
    : body instanceof ArrayBuffer || body instanceof Blob ? { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body }
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  const res = await fetch(`${wsBase}${route}`, init);
  return res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
};
const field = (label, input) => { const l = el('label', 'scheduled-form-label', label); l.appendChild(input); return l; };
const input = (value = '', ph = '', type = 'text') => { const i = el('input', 'scheduled-form-input'); i.type = type; i.value = value; i.placeholder = ph; i.addEventListener('keydown', (e) => e.stopPropagation()); return i; };
const area = (value = '', rows = 6, ph = '') => { const t = el('textarea', 'scheduled-form-textarea'); t.rows = rows; t.value = value; t.placeholder = ph; t.addEventListener('keydown', (e) => e.stopPropagation()); return t; };
const select = (opts, value) => { const s = el('select', 'perm-mode-select hub-select'); for (const [v, l] of opts) s.appendChild(new Option(l, v)); s.value = value ?? ''; return s; };
const when = (ms) => (ms ? new Date(ms).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');

// ── Markup ──
const headerBtn = el('button', 'icon-btn');
headerBtn.id = 'hub-btn';
headerBtn.title = 'Hub — agents, memory, projects, connectors, apps, shared links';
headerBtn.setAttribute('aria-label', 'Hub');
headerBtn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>';
document.getElementById('skills-btn').before(headerBtn);
const panel = el('div', 'sessions-panel hub-panel hidden');
panel.id = 'hub-panel';
const head = el('div', 'sessions-head', 'Hub');
const tabsEl = el('div', 'sessions-filter hub-tabs');
const body = el('div', 'sessions-list hub-body');
panel.append(head, tabsEl, body);
document.getElementById('skills-panel').after(panel);

export function openHub(which) {
  if (which) tab = which;
  panel.classList.remove('hidden');
  headerBtn.classList.add('active');
  render();
}
export function closeHub() { panel.classList.add('hidden'); headerBtn.classList.remove('active'); }
headerBtn.onclick = (e) => { e.stopPropagation(); if (panel.classList.contains('hidden')) openHub(); else closeHub(); };
document.addEventListener('click', (e) => {
  if (!e.target.isConnected || panel.classList.contains('hidden')) return;
  if (panel.contains(e.target) || headerBtn.contains(e.target) || e.target.closest('#confirm-overlay, .toast, .toolbox-menu')) return;
  closeHub();
});
registerPanel(panel, closeHub);

function render() {
  tabsEl.innerHTML = '';
  for (const [id, label] of TABS) {
    const b = button(label, null, () => { tab = id; render(); }, `ws-chip${tab === id ? ' active' : ''}`);
    tabsEl.appendChild(b);
  }
  body.innerHTML = '';
  ({ confidential: renderConfidential, agents: renderAgents, memory: renderMemory, projects: renderProjects, connectors: renderConnectors, apps: renderApps, shared: renderShared, whatsapp: renderWhatsApp })[tab]();
}
const note = (t) => el('div', 'usage-note hub-note', t);
const row = (title, sub, actions = [], onclick) => {
  const r = el('div', 'skill-row');
  const m = el('div', 'skill-main');
  m.append(el('div', 'skill-title', title), el('div', 'skill-desc', sub || ''));
  if (onclick) m.onclick = onclick;
  const a = el('div', 'skill-actions');
  a.append(...actions);
  r.append(m, a);
  return r;
};

// ── Agents ──
function renderAgents() {
  body.appendChild(note('Custom assistants with their own instructions — pick one in the ✚ menu under the message box. A conversation keeps its agent.'));
  const bar = el('div', 'hub-bar');
  bar.appendChild(button('+ New agent', null, () => agentForm(null)));
  body.appendChild(bar);
  for (const a of listAgentsCache()) {
    body.appendChild(row(`${a.icon} ${a.name}`, a.description || a.instructions.slice(0, 140), [
      button('✎', 'Edit', () => agentForm(a), 'find-nav'),
      button('🗑', 'Delete', async () => {
        if (await confirmAction({ title: `Delete the agent “${a.name}”?`, body: 'Its conversations keep their messages.', confirm: 'Delete', cancel: 'Keep it' })) {
          const r = await api('/api/agents/delete', { id: a.id });
          if (!r.ok) showToast(r.error || 'Could not delete.', { kind: 'error' });
        }
      }, 'find-nav'),
    ], () => agentForm(a)));
  }
}

function agentForm(a) {
  body.innerHTML = '';
  const f = el('form', 'scheduled-form hub-form');
  const icon = input(a?.icon || '🤖', '🤖');
  icon.maxLength = 4;
  const name = input(a?.name || '', 'Relecteur d\'offres');
  const desc = input(a?.description || '', 'What it is for, in one line');
  const instr = area(a?.instructions || '', 10, 'You are… For every document: 1) … 2) … Answer in…');
  const mode = select([['', 'Keep the current mode'], ['chat', 'Chat'], ['code', 'Code'], ['cowork', 'Cowork']], a?.mode);
  const models = [...modelSelect.options].filter((o) => o.value).map((o) => [o.value, o.textContent]);
  const model = select([['', 'Default model'], ...models], a?.model);
  const effort = select([['', 'Default effort'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high'], ['max', 'Max']], a?.effort);
  const skills = input((a?.skills || []).join(', '), 'Empty = all skills; else e.g. offre-equans-docx, livrables-drive');
  const research = el('input');
  research.type = 'checkbox';
  research.checked = !!a?.research;
  const err = el('p', 'scheduled-form-error hidden');
  const iconRow = el('div', 'hub-row2');
  iconRow.append(field('Icon', icon), field('Name', name));
  const r3 = el('div', 'hub-row3');
  r3.append(field('Mode', mode), field('Model', model), field('Effort', effort));
  const rl = el('label', 'doc-check hub-check');
  rl.append(research, document.createTextNode(' Always do deep research'));
  f.append(iconRow, field('Description', desc), field('Instructions', instr), r3, field('Skills it may use', skills), rl, err);
  const actions = el('div', 'scheduled-form-actions');
  const cancel = el('button', 'btn btn-deny', 'Cancel');
  cancel.type = 'button';
  cancel.onclick = () => render();
  const save = el('button', 'btn btn-allow', 'Save');
  save.type = 'submit';
  actions.append(cancel, save);
  f.appendChild(actions);
  f.onsubmit = async (e) => {
    e.preventDefault();
    const r = await api('/api/agents', {
      id: a?.id, icon: icon.value, name: name.value, description: desc.value, instructions: instr.value,
      mode: mode.value, model: model.value, effort: effort.value, research: research.checked,
      skills: skills.value.split(',').map((x) => x.trim()).filter(Boolean),
    });
    if (r.ok) render(); else { err.textContent = r.error || 'Could not save.'; err.classList.remove('hidden'); }
  };
  body.appendChild(f);
  name.focus();
}

// ── Memory ──
async function renderMemory() {
  body.appendChild(note('What Claude remembers about you between conversations (Code and Cowork modes). Short, one fact per memory; the one-line description is what Claude reads first.'));
  const bar = el('div', 'hub-bar');
  bar.appendChild(button('+ New memory', null, () => memoryForm(null)));
  const sug = el('label', 'doc-check hub-check');
  const cb = el('input');
  cb.type = 'checkbox';
  cb.checked = localStorage.getItem('suggestSkills') !== 'off';
  cb.onchange = () => localStorage.setItem('suggestSkills', cb.checked ? 'on' : 'off');
  sug.append(cb, document.createTextNode(' After a long task, offer to save it as a skill'));
  bar.appendChild(sug);
  const rev = el('label', 'doc-check hub-check');
  const rcb = el('input');
  rcb.type = 'checkbox';
  rcb.disabled = true;
  rev.append(rcb, document.createTextNode(' Every few exchanges, re-read the conversation and remember what matters'));
  rev.title = 'A short automatic pass saves lasting preferences and decisions — never from a confidential conversation.';
  rcb.onchange = async () => { const r = await api('/api/memory/review', { enabled: rcb.checked }); if (!r.ok) showToast(r.error || 'Could not save.', { kind: 'error' }); };
  bar.appendChild(rev);
  body.appendChild(bar);
  const [m, rv] = await Promise.all([api('/api/memory'), api('/api/memory/review')]);
  if (tab !== 'memory') return;
  rcb.checked = rv.enabled !== false;
  rcb.disabled = false;
  if (rv.every) rev.lastChild.textContent = ` Every ${rv.every} exchanges, re-read the conversation and remember what matters`;
  if (m.dangling?.length) {
    const d = el('div', 'hub-warn', `The index points at ${m.dangling.length} missing memor${m.dangling.length > 1 ? 'ies' : 'y'} (${m.dangling.join(', ')}).`);
    d.appendChild(button('Clean up', 'Remove those lines from the index', async () => { await api('/api/memory/clean', {}); render(); }));
    body.appendChild(d);
  }
  if (!m.facts?.length) body.appendChild(el('div', 'sessions-empty', 'Nothing remembered yet. Claude saves things when you tell it to remember, or when it learns something lasting.'));
  for (const f of m.facts || []) {
    const r = row(`${f.title}`, `${f.type ? `[${f.type}] ` : ''}${f.description}`, [
      button('✎', 'Edit', () => memoryForm(f), 'find-nav'),
      button('🗑', 'Forget', async () => {
        if (await confirmAction({ title: `Forget “${f.title}”?`, body: f.description, confirm: 'Forget', cancel: 'Keep' })) { await api('/api/memory/delete', { file: f.file }); render(); }
      }, 'find-nav'),
    ], () => memoryForm(f));
    body.appendChild(r);
  }
}

function memoryForm(f) {
  body.innerHTML = '';
  const form = el('form', 'scheduled-form hub-form');
  const title = input(f?.title || '', 'Préférences de présentation');
  const desc = input(f?.description || '', 'One line: what this memory is about');
  const type = select([['user', 'About me'], ['feedback', 'How to work with me'], ['project', 'Ongoing work'], ['reference', 'Where to find things']], f?.type || 'user');
  const text = area(f?.body || '', 8, 'The fact. For "how to work with me": add **Why:** and **How to apply:** lines.');
  const err = el('p', 'scheduled-form-error hidden');
  form.append(field('Title', title), field('Description', desc), field('Kind', type), field('Memory', text), err);
  const actions = el('div', 'scheduled-form-actions');
  const cancel = el('button', 'btn btn-deny', 'Cancel');
  cancel.type = 'button';
  cancel.onclick = () => render();
  const save = el('button', 'btn btn-allow', 'Save');
  save.type = 'submit';
  actions.append(cancel, save);
  form.appendChild(actions);
  form.onsubmit = async (e) => {
    e.preventDefault();
    const r = await api('/api/memory', { file: f?.file, name: f?.name || title.value, title: title.value, description: desc.value, type: type.value, body: text.value });
    if (r.ok) render(); else { err.textContent = r.error || 'Could not save.'; err.classList.remove('hidden'); }
  };
  body.appendChild(form);
  title.focus();
}

// ── Projects (instructions + knowledge) ──
let projectPick = '';
async function renderProjects() {
  const names = (S.workspaceState?.projects || []).map((p) => p.name || p);
  body.appendChild(note('Like Projects in Claude or ChatGPT: instructions and reference documents used by every conversation in that project — in Cowork, or picked in the ✚ menu in Chat and Code. Stored in the project folder (PROJECT.md and Knowledge/), so in your Drive too.'));
  if (!names.length) { body.appendChild(el('div', 'sessions-empty', 'No project folder yet — create one in the Workspace panel (+ Project).')); return; }
  if (!names.includes(projectPick)) projectPick = S.coworkProject && names.includes(S.coworkProject) ? S.coworkProject : names[0];
  const pick = select(names.map((n) => [n, n]), projectPick);
  pick.onchange = () => { projectPick = pick.value; render(); };
  const bar = el('div', 'hub-bar');
  bar.appendChild(pick);
  body.appendChild(bar);
  const k = await api(`/api/projects/${encodeURIComponent(projectPick)}/knowledge`);
  if (tab !== 'projects') return;
  if (!k.ok) { body.appendChild(note(k.error || 'Could not read the project.')); return; }
  const instr = area(k.instructions, 7, 'Context, goals, tone, rules for this project…');
  const save = button('Save instructions', null, async () => {
    const r = await api(`/api/projects/${encodeURIComponent(projectPick)}/instructions`, { instructions: instr.value });
    showToast(r.ok ? 'Instructions saved.' : (r.error || 'Could not save.'), r.ok ? {} : { kind: 'error' });
  });
  body.append(field('Instructions', instr), save);
  body.appendChild(el('div', 'usage-section-title', `Knowledge (${k.files.length})`));
  const file = el('input');
  file.type = 'file';
  file.multiple = true;
  file.className = 'hidden';
  file.onchange = async () => {
    for (const f of file.files) {
      const r = await api(`/api/projects/${encodeURIComponent(projectPick)}/knowledge?file=${encodeURIComponent(f.name)}`, await f.arrayBuffer());
      if (!r.ok) showToast(`${f.name}: ${r.error}`, { kind: 'error' });
    }
    render();
  };
  body.append(file, button('+ Add documents…', 'Word, PowerPoint, Excel, PDF, text…', () => file.click()));
  for (const f of k.files) {
    body.appendChild(row(f.name, `${Math.max(1, Math.round(f.size / 1024))} KB · ${when(f.mtime)}`, [
      button('🗑', 'Remove from the knowledge', async () => { await api(`/api/projects/${encodeURIComponent(projectPick)}/knowledge/delete`, { file: f.name }); render(); }, 'find-nav'),
    ]));
  }
}

// ── Connectors ──
async function renderConnectors() {
  const c = await api('/api/connectors');
  if (tab !== 'connectors') return;
  const g = c.google || {};
  body.appendChild(el('div', 'usage-section-title', 'Gmail + Google Calendar'));
  if (g.connected) {
    body.appendChild(note(`Connected${g.email ? ` as ${g.email}` : ''} since ${when(g.connectedAt)}. Claude can search and read your mail, prepare drafts (never sends), read your calendar and add events (without e-mailing attendees).`));
    body.appendChild(button('Disconnect', null, async () => { await api('/api/connectors/google/disconnect', {}); render(); }));
  } else if (g.configured) {
    body.appendChild(note('2. Open Google sign-in, accept, then copy the address the browser ends on (a page that does not load, starting with http://127.0.0.1:53682/) and paste it here.'));
    const link = el('a', 'session-menu-btn artifact-link', 'Open Google sign-in ↗');
    link.target = '_blank';
    link.rel = 'noopener';
    api('/api/connectors/google/auth-url').then((r) => { if (r.url) link.href = r.url; });
    const pasted = input('', 'http://127.0.0.1:53682/?state=…&code=…');
    const finish = button('Finish', null, async () => {
      const r = await api('/api/connectors/google/finish', { url: pasted.value });
      if (r.ok) { showToast(`Google connected${r.email ? ` (${r.email})` : ''}.`); render(); } else showToast(r.error, { kind: 'error', timeout: 15000 });
    });
    body.append(link, field('Address after sign-in', pasted), finish, button('Change the OAuth client', null, async () => { await api('/api/connectors/google/forget', {}); render(); }));
  } else {
    body.appendChild(note('1. In Google Cloud Console (your own project): enable the Gmail API and the Google Calendar API; OAuth consent screen → add yourself as a test user (or publish it, to avoid weekly sign-ins); Credentials → Create OAuth client ID → "Desktop app". Paste its ID and secret here.'));
    const id = input('', '….apps.googleusercontent.com');
    const secret = input('', 'Client secret', 'password');
    body.append(field('Client ID', id), field('Client secret', secret), button('Save', null, async () => {
      const r = await api('/api/connectors/google/client', { client_id: id.value, client_secret: secret.value });
      if (r.ok) render(); else showToast(r.error, { kind: 'error' });
    }));
  }
  body.appendChild(el('div', 'usage-section-title', 'Browser agent'));
  body.appendChild(note(c.browser
    ? 'Ready. Ask Claude to use a website (“go to … and fill in …”): it drives a real Chromium and you watch it live in the viewer. Clicks and typing ask for your permission unless you allowed them.'
    : 'Chromium is not installed in this app image.'));
}

// ── Published apps ──
async function renderApps() {
  body.appendChild(note('Apps built in a Cowork project, kept online at their own address behind your Home Assistant login — the phone app included. Ask Claude “publish it”, or publish here.'));
  const r = await api('/api/apps');
  if (tab !== 'apps') return;
  apps = r.apps || [];
  const bar = el('div', 'hub-bar');
  bar.appendChild(button('+ Publish an app', null, () => appForm()));
  body.appendChild(bar);
  if (!apps.length) body.appendChild(el('div', 'sessions-empty', 'Nothing published yet.'));
  for (const a of apps) {
    const open = el('a', 'find-nav artifact-link', '↗');
    open.href = `${wsBase}/apps/${a.slug}/`;
    open.target = '_blank';
    open.rel = 'noopener';
    open.title = 'Open';
    const r2 = row(`${a.name}`, `${a.kind === 'server' ? `server · ${a.running ? '● running' : '○ stopped'} · port ${a.port}` : 'static'} · project ${a.project} · apps/${a.slug}/`, [
      open,
      button('🗑', 'Unpublish', async () => {
        if (await confirmAction({ title: `Unpublish “${a.name}”?`, body: 'Its files stay in the project.', confirm: 'Unpublish', cancel: 'Keep it' })) { await api('/api/apps/unpublish', { slug: a.slug }); render(); }
      }, 'find-nav'),
    ]);
    if (a.kind === 'server' && a.log?.length) {
      const pre = el('pre', 'change-diff hub-log', a.log.slice(-12).join('\n'));
      r2.querySelector('.skill-main').appendChild(pre);
    }
    body.appendChild(r2);
  }
}

function appForm() {
  body.innerHTML = '';
  const names = (S.workspaceState?.projects || []).map((p) => p.name || p);
  const f = el('form', 'scheduled-form hub-form');
  const project = select(names.map((n) => [n, n]), S.coworkProject || names[0]);
  const name = input('', 'Mon tableau de bord');
  const kind = select([['static', 'Static files (HTML, JS, CSS)'], ['server', 'A server (Python, Node…)']], 'static');
  const entry = input('index.html', 'index.html');
  const command = input('', 'python3 server.py   (must listen on 127.0.0.1:$PORT)');
  const err = el('p', 'scheduled-form-error hidden');
  const entryF = field('Start page', entry), cmdF = field('Command', command);
  cmdF.classList.add('hidden');
  kind.onchange = () => { entryF.classList.toggle('hidden', kind.value !== 'static'); cmdF.classList.toggle('hidden', kind.value !== 'server'); };
  f.append(field('Project', project), field('Name', name), field('Kind', kind), entryF, cmdF, err);
  const actions = el('div', 'scheduled-form-actions');
  const cancel = el('button', 'btn btn-deny', 'Cancel');
  cancel.type = 'button';
  cancel.onclick = () => render();
  const save = el('button', 'btn btn-allow', 'Publish');
  save.type = 'submit';
  actions.append(cancel, save);
  f.appendChild(actions);
  f.onsubmit = async (e) => {
    e.preventDefault();
    const r = await api('/api/apps', { project: project.value, name: name.value, kind: kind.value, entry: entry.value, command: command.value });
    if (r.ok) render(); else { err.textContent = r.error; err.classList.remove('hidden'); }
  };
  body.appendChild(f);
}
export function applyPublishedApps(list) { apps = list || []; if (!panel.classList.contains('hidden') && tab === 'apps') render(); }

// ── Shared links ──
async function renderShared() {
  body.appendChild(note('Read-only links to a conversation or a file (🔗 in the viewer, or ⋯ → Share link in Sessions). Anyone with the link can open it wherever your Home Assistant is reachable. Revoke deletes it.'));
  const r = await api('/api/shares');
  if (tab !== 'shared') return;
  if (!r.shares?.length) body.appendChild(el('div', 'sessions-empty', 'No shared link.'));
  for (const s of r.shares || []) {
    const open = el('a', 'find-nav artifact-link', '↗');
    open.href = s.url;
    open.target = '_blank';
    open.rel = 'noopener';
    body.appendChild(row(`${s.kind === 'conversation' ? '💬' : '📄'} ${s.title}`, `${when(s.createdAt)} · ${s.url}`, [
      button('⧉', 'Copy the link', () => copy(s.url), 'find-nav'), open,
      button('🗑', 'Revoke', async () => {
        if (await confirmAction({ title: 'Revoke this link?', body: 'It stops working at once.', confirm: 'Revoke', cancel: 'Keep it' })) { await api('/api/shares/revoke', { token: s.token }); render(); }
      }, 'find-nav'),
    ]));
  }
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); showToast('Link copied.'); }
  catch { window.prompt('Copy the link:', text); }
}

async function publish(route, body, what) {
  const ok = await confirmAction({
    title: `Share ${what} by link?`,
    body: 'A read-only copy is published at a secret address. Anyone who has the link can open it, wherever your Home Assistant is reachable (from the internet if it is exposed). You can revoke it in Hub → Shared.',
    confirm: 'Create the link', cancel: 'Cancel',
  });
  if (!ok) return;
  const r = await api(route, body);
  if (!r.ok) { showToast(r.error || 'Could not share.', { kind: 'error' }); return; }
  await copy(r.share.url);
  showToast(`Link created and copied: ${r.share.url}`, { timeout: 15000 });
}
export const shareFile = (path) => publish('/api/shares/file', { path }, `“${path.split('/').pop()}”`);
export const shareConversation = (id, title) => publish('/api/shares/conversation', { id }, `the conversation “${title || ''}”`);

// ── Confidentiel (vault.js) — tout reste dans le navigateur et sur Home Assistant ──
const KIND_LABEL = { client: 'Client', personne: 'Personne', lieu: 'Lieu', projet: 'Projet', partenaire: 'Partenaire', ref: 'Référence', email: 'E-mail', tel: 'Téléphone', iban: 'IBAN', tva: 'TVA', autre: 'Autre' };
let confFilter = '';
// Erase the whole vault (names, originals, real versions, passphrase): typed confirmation.
function wipeSection() {
  body.appendChild(el('div', 'usage-section-title', 'Effacer le coffre'));
  body.appendChild(note('Supprime définitivement la table des noms, les originaux, les versions réelles et la phrase de passe. Les documents du workspace restent tels quels (pseudonymisés). Fonctionne aussi coffre verrouillé. Tape EFFACER pour confirmer.'));
  const w = input('', 'EFFACER');
  body.append(w, button('Effacer le coffre', null, async () => {
    if (w.value.trim() !== 'EFFACER') { showToast('Tape EFFACER pour confirmer.', { kind: 'error' }); return; }
    if (!(await confirmAction({ title: 'Effacer tout le coffre ?', body: 'La table des noms, les originaux et les versions réelles seront supprimés définitivement. Les prochains pseudonymes repartiront de Client-A.', confirm: 'Effacer', cancel: 'Annuler' }))) return;
    const r = await api('/api/vault/wipe', { confirm: 'EFFACER' });
    showToast(r.ok ? 'Coffre effacé.' : (r.error || 'Échec.'), r.ok ? {} : { kind: 'error' });
    render();
  }));
}

// sending real documents to the drop folder from the browser (server: depot.receive) —
// they go to this Home Assistant only, never into a conversation or the Drive
async function depotUpload(files) {
  let sent = 0;
  for (const f of files) {
    const r = await api(`/api/depot/upload?name=${encodeURIComponent(f.name)}`, f);
    if (r.ok) sent++; else showToast(`${f.name} : ${r.error || 'échec'}`, { kind: 'error' });
  }
  if (sent) showToast(`${sent} fichier(s) déposé(s) — pseudonymisation en cours.`);
  render();
  setTimeout(() => { if (tab === 'confidential' && !panel.classList.contains('hidden')) render(); }, 4000);
}
function depotDrop() {
  const zone = el('div', 'hub-depot-drop');
  const pick = el('input');
  pick.type = 'file';
  pick.multiple = true;
  pick.hidden = true;
  pick.onchange = () => { const fs = [...pick.files]; pick.value = ''; if (fs.length) depotUpload(fs); };
  zone.append(note('Glisse les fichiers ici'), button('Déposer des fichiers…', 'Choisir des documents réels à pseudonymiser', () => pick.click()), pick);
  ['dragenter', 'dragover'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); zone.classList.add('dragover'); }));
  zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();   // never reaches the composer's own drop (which would attach it to a message)
    zone.classList.remove('dragover');
    const fs = [...(e.dataTransfer?.files || [])];
    if (fs.length) depotUpload(fs);
  });
  return zone;
}

// the confidential drop folder (server: depot.js) — what waits there, and the user's decision
function depotSection(dp) {
  body.appendChild(el('div', 'usage-section-title', 'Dépôt confidentiel'));
  body.appendChild(note(`Dépose ici les documents réels (de partout où Home Assistant est joignable), ou chez toi par le réseau dans \\\\${location.hostname}\\config\\Depot_confidentiel. Ils restent sur ce Home Assistant, hors du Drive, sans rien envoyer à Claude : pseudonymisés (original au coffre), vérifiés comme un message, puis rangés dans le dossier Confidentiel du workspace — le seul que Claude lit avec le bouclier, avec les autres dossiers anonymisés.`));
  body.appendChild(depotDrop());
  if (dp.waiting) body.appendChild(note(dp.locked ? `${dp.waiting} fichier(s) en attente : déverrouille le coffre pour qu'ils soient traités.` : `${dp.waiting} fichier(s) en cours de traitement (quelques secondes après la fin de la copie).`));
  for (const f of dp.pending || []) {
    const box = el('div', 'hub-conf-out');
    box.appendChild(el('div', 'hub-depot-name', reveal(f.rel)));
    box.appendChild(note(`${f.unknown.length} mot(s) que le coffre ne connaît pas — cochés : à protéger ; les autres ne seront plus signalés.`));
    const boxes = f.unknown.map((c) => {
      const l = el('label', 'doc-check hub-cand');
      const cb = el('input'); cb.type = 'checkbox'; cb.checked = !c.why;
      l.append(cb, document.createTextNode(` ${c.real}  `), el('small', null, c.why || KIND_LABEL[c.kind] || c.kind));
      box.appendChild(l);
      return [cb, c];
    });
    const bar = el('div', 'hub-bar');
    bar.append(
      button('Valider', 'Protéger les mots cochés, ne plus signaler les autres, puis ranger le fichier', async () => {
        const r = await api('/api/vault/depot/resolve', { rel: f.rel, protect: boxes.filter(([cb]) => cb.checked).map(([, c]) => ({ real: c.real, kind: c.kind === 'autre' ? 'client' : c.kind })), ignore: boxes.filter(([cb]) => !cb.checked).map(([, c]) => c.real) });
        showToast(r.ok ? (r.released ? 'Fichier rangé dans Confidentiel.' : 'Encore des mots à vérifier.') : (r.error || 'Échec.'), r.ok ? {} : { kind: 'error' });
        render();
      }),
      button('Ranger tel quel', 'Sans rien protéger de plus (cette fois)', async () => {
        if (!(await confirmAction({ title: 'Ranger tel quel ?', body: 'Les mots listés restent en clair dans la copie que Claude pourra lire.', confirm: 'Ranger', cancel: 'Annuler' }))) return;
        const r = await api('/api/vault/depot/resolve', { rel: f.rel, force: true });
        if (!r.ok) showToast(r.error || 'Échec.', { kind: 'error' });
        render();
      }));
    box.appendChild(bar);
    body.appendChild(box);
  }
  if (!(dp.pending || []).length && !dp.waiting) body.appendChild(note('Rien en attente.'));
  for (const r of (dp.recent || []).slice(0, 6)) body.appendChild(note(`${new Date(r.at).toLocaleTimeString()} — ${reveal(r.name)} → ${r.to ? reveal(r.to) : 'coffre seulement'} (${r.how})`));
}

async function renderConfidential() {
  const v = await api('/api/vault');
  if (tab !== 'confidential') return;
  const es = v.entities || [];
  body.appendChild(note(`Le mode Confidentiel (bouclier sous la zone de saisie) remplace ces noms par leur pseudonyme avant l'envoi à Claude, et les rétablit à l'affichage. Avec le bouclier, Claude ne lit que les dossiers anonymisés (mode strict). ${es.length} entrée(s) dans le coffre, sur ce Home Assistant uniquement (jamais dans le Drive, illisible pour l'agent).`));

  // chiffrement
  body.appendChild(el('div', 'usage-section-title', 'Chiffrement du coffre'));
  const pass = (ph) => secretField(input('', ph));
  if (v.locked) {
    body.appendChild(note('Coffre chiffré et verrouillé (après un redémarrage de l\'app). Le bouclier n\'enverra rien tant qu\'il n\'est pas déverrouillé.'));
    const p1 = pass('Phrase de passe');
    body.append(p1, button('Déverrouiller', null, async () => {
      const r = await api('/api/vault/unlock', { pass: p1.value });
      if (!r.ok) { showToast(r.error || 'Échec.', { kind: 'error' }); return; }
      render();
    }));
    wipeSection();   // a forgotten passphrase: the only way out
    return;
  }
  if (!v.encrypted) {
    body.appendChild(note('Le coffre est en clair sur ce Home Assistant (et dans ses sauvegardes). Chiffre-le avec une phrase de passe : elle n\'est jamais enregistrée, il faudra la saisir après chaque redémarrage de l\'app. Phrase oubliée = coffre perdu (les documents du workspace restent, pseudonymisés).'));
    const p1 = pass('Phrase de passe (8 caractères minimum)'), p2 = pass('La même, une 2e fois');
    body.append(p1, p2, button('Chiffrer le coffre', null, async () => {
      if (p1.value !== p2.value) { showToast('Les deux phrases ne sont pas identiques.', { kind: 'error' }); return; }
      if (!(await confirmAction({ title: 'Chiffrer le coffre ?', body: 'La table des noms, les originaux et les versions réelles sont chiffrés, puis leurs copies en clair supprimées. Sans la phrase de passe, rien ne pourra être récupéré.', confirm: 'Chiffrer', cancel: 'Annuler' }))) return;
      const r = await api('/api/vault/passphrase', { pass: p1.value });
      if (!r.ok) { showToast(r.error || 'Échec.', { kind: 'error' }); return; }
      showToast(`Coffre chiffré (${r.files} fichier(s) réel(s) chiffré(s)).`);
      render();
    }));
  } else {
    body.appendChild(note('Coffre chiffré (AES-256), déverrouillé jusqu\'au prochain redémarrage de l\'app.'));
    const o = pass('Phrase actuelle'), n1 = pass('Nouvelle phrase'), n2 = pass('Nouvelle phrase, 2e fois');
    const bar0 = el('div', 'hub-bar');
    bar0.append(button('Verrouiller maintenant', 'Le coffre redevient illisible jusqu\'à la prochaine saisie de la phrase', async () => { await api('/api/vault/lock', {}); render(); }),
      button('Changer la phrase…', null, () => { chg.classList.toggle('hidden'); }));
    const chg = el('div', 'hidden');
    chg.append(o, n1, n2, button('Changer', null, async () => {
      if (n1.value !== n2.value) { showToast('Les deux nouvelles phrases ne sont pas identiques.', { kind: 'error' }); return; }
      const r = await api('/api/vault/passphrase', { pass: n1.value, old: o.value });
      showToast(r.ok ? 'Phrase de passe changée.' : (r.error || 'Échec.'), r.ok ? {} : { kind: 'error' });
      if (r.ok) render();
    }));
    body.append(bar0, chg);
  }

  // ajout
  const real = input('', 'Nom réel (ex. Société X SA)');
  const kind = select(Object.entries(KIND_LABEL).filter(([k]) => !['email', 'tel', 'iban', 'tva', 'ref'].includes(k)), 'client');
  const vars = input('', 'Variantes : sigle, nom court… (séparées par des virgules)');
  const add = button('+ Ajouter', null, async () => {
    if (!real.value.trim()) return;
    await api('/api/vault/entity', { real: real.value, kind: kind.value, variants: vars.value.split(',').map((x) => x.trim()).filter(Boolean) });
    render();
  });
  const fr = el('div', 'hub-row3 hub-conf-add');
  fr.append(field('Nom à protéger', real), field('Type', kind), field('Variantes', vars));
  body.append(fr, add);

  // outils
  const folders = [...new Set((S.workspace || []).map((f) => f.path.split('/')[0]).filter((x) => x && !x.includes('.')))].sort();
  const pick = select(folders.map((x) => [x, x]), folders.includes('03_Travail') ? '03_Travail' : folders[0]);
  const out = el('div', 'hub-conf-out');
  const bar = el('div', 'hub-bar');
  bar.append(pick,
    button('Analyser', 'Repérer localement les noms, e-mails, téléphones, références… de ce dossier', async () => {
      out.innerHTML = '';
      out.appendChild(note('Analyse locale…'));
      const r = await api('/api/vault/scan', { rel: pick.value });
      out.innerHTML = '';
      if (!r.candidates?.length) { out.appendChild(note('Rien de nouveau à protéger dans ce dossier.')); return; }
      out.appendChild(note(`${r.candidates.length} candidat(s) — cocher ceux à protéger :`));
      const boxes = r.candidates.map((c) => {
        const l = el('label', 'doc-check hub-cand');
        const cb = el('input'); cb.type = 'checkbox'; cb.checked = ['email', 'tel', 'iban', 'tva', 'ref'].includes(c.kind) || c.count > 1;
        l.append(cb, document.createTextNode(` ${c.real}  `), el('small', null, `${KIND_LABEL[c.kind] || c.kind} · ${c.count}×`));
        out.appendChild(l);
        return [cb, c];
      });
      out.appendChild(button('Ajouter la sélection', null, async () => {
        for (const [cb, c] of boxes) if (cb.checked) await api('/api/vault/entity', { real: c.real, kind: c.kind });
        render();
      }));
    }),
    button('Anonymiser…', 'Originaux au coffre, copies pseudonymisées à leur place', async () => {
      out.innerHTML = '';
      const r = await api('/api/vault/anonymize', { rel: pick.value, dryRun: true });
      if (!r.ok) { showToast(r.error, { kind: 'error' }); return; }
      const rep = r.report;
      out.appendChild(note(`Simulation sur ${pick.value} : ${rep.fichiers} fichier(s), ${rep.renommes} renommé(s), ${rep.entites_apres - rep.entites_avant} nouvelle(s) entrée(s) détectée(s).`));
      out.appendChild(button(`Anonymiser ${pick.value}`, null, async () => {
        if (!(await confirmAction({ title: `Anonymiser ${pick.value} ?`, body: 'Chaque fichier part dans le coffre (sur ce Home Assistant) et une copie pseudonymisée prend sa place — nom compris. Les images sont seulement renommées : vérifie-les. Pense à vider la corbeille de Google Drive ensuite (elle garde les anciennes versions 30 jours).', confirm: 'Anonymiser', cancel: 'Annuler' }))) return;
        out.innerHTML = '';
        out.appendChild(note('Anonymisation en cours… (les Word sont aussi reconvertis en PDF)'));
        const x = await api('/api/vault/anonymize', { rel: pick.value });
        out.innerHTML = '';
        const t = x.report;
        out.appendChild(note(x.ok ? `Fait : ${t.anonymises} fichier(s) anonymisé(s), ${t.renommes} renommé(s), ${t.deplaces_au_coffre} gardé(s) au coffre seulement${t.convertis?.length ? `, ${t.convertis.length} ancien(s) format(s) converti(s) (.doc → .docx…)` : ''}${t.images.length ? `, ${t.images.length} image(s) à vérifier` : ''}${t.documents_images?.length ? `, ${t.documents_images.length} document(s) avec images à vérifier (plus bas)` : ''}.` : (x.error || 'Échec.')));
        render();
      }));
    }));
  body.append(el('div', 'usage-section-title', 'Dossiers du workspace'), bar, out);

  depotSection(v.depot || {});

  // la table
  body.appendChild(el('div', 'usage-section-title', 'Coffre'));
  const q = input(confFilter, 'Filtrer…');
  q.oninput = () => { confFilter = q.value; draw(); };
  const list = el('div');
  body.append(q, list);
  function draw() {
    list.innerHTML = '';
    const f = confFilter.toLowerCase();
    for (const e of es.filter((x) => !f || `${x.real} ${x.alias} ${(x.variants || []).join(' ')}`.toLowerCase().includes(f)).slice(0, 400)) {
      list.appendChild(row(`${e.real}`, `→ ${e.alias} · ${KIND_LABEL[e.kind] || e.kind}${e.variants?.length ? ` · aussi : ${e.variants.join(', ')}` : ''}${e.auto ? ' · détecté' : ''}`, [
        button('🗑', 'Retirer du coffre', async () => { await api('/api/vault/entity/delete', { alias: e.alias }); render(); }, 'find-nav'),
      ]));
    }
  }
  draw();

  // documents réels et exemptions
  // images left « à vérifier » by an anonymisation: mask them in the editor, in place
  body.appendChild(el('div', 'usage-section-title', 'Images à masquer'));
  if (!(v.images || []).length) body.appendChild(note('Aucune : les images d\'un dossier anonymisé apparaissent ici, à masquer (logos, noms, plans) avant que Claude puisse les lire.'));
  for (const rel of v.images || []) {
    body.appendChild(row(rel.split('/').pop(), rel, [button('Masquer…', 'Ouvrir l\'éditeur de masquage ; l\'original part au coffre', async () => {
      const blob = await (await fetch(`${wsBase}/workspace/${rel.split('/').map(encodeURIComponent).join('/')}`)).blob();
      const dataUrl = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(blob); });
      const out = await redactAttachment({ name: rel.split('/').pop(), mediaType: blob.type || 'image/png', dataUrl }, { single: true });
      if (!out) return;
      const r = await api('/api/vault/redact/save', { path: rel, data: out[0].dataUrl });
      showToast(r.ok ? `Image masquée : ${r.path}` : (r.error || 'Échec.'), r.ok ? {} : { kind: 'error' });
      render();
    }, 'find-nav')]));
  }

  // Word / Excel / PowerPoint of an anonymised folder whose pictures are not checked yet
  body.appendChild(el('div', 'usage-section-title', 'Documents avec images'));
  if (!(v.docs || []).length) body.appendChild(note('Aucun : les Word, Excel et PowerPoint d\'un dossier anonymisé qui contiennent des images apparaissent ici, le temps de les vérifier (logos, captures, photos de site).'));
  for (const d of v.docs || []) {
    const fix = async (how) => {
      const r = await api('/api/vault/office-media', { path: d.path });
      if (!r.ok) { showToast(r.error || 'Échec.', { kind: 'error' }); return; }
      const media = {};
      for (const [i, img] of r.images.entries()) {
        const src = `data:${img.mime};base64,${img.b64}`;
        if (how === 'blank') { media[img.path] = await blackOut(src, img.mime); continue; }
        const out = await redactAttachment({ name: `${d.path.split('/').pop()} — image ${i + 1}/${r.images.length}`, mediaType: img.mime, dataUrl: src }, { single: true, format: img.mime, confirm: i + 1 < r.images.length ? 'Image suivante' : 'Terminer' });
        if (!out) return;   // cancelled: nothing saved, the document stays in the list
        media[img.path] = out[0].dataUrl;
      }
      const x = await api('/api/vault/office-save', { path: d.path, media, blank: true });
      showToast(x.ok ? `Images masquées : ${d.path.split('/').pop()}` : (x.error || 'Échec.'), x.ok ? {} : { kind: 'error' });
      render();
    };
    body.appendChild(row(d.path.split('/').pop(), `${d.path} · ${d.images} image(s)${d.other ? ` + ${d.other} à remplacer par une image vide (EMF, WMF…)` : ''}`, [
      button('Vérifier…', 'Masquer image par image dans l\'éditeur', () => fix('check'), 'find-nav'),
      button('Tout masquer', 'Noircir toutes les images du document', async () => {
        if (await confirmAction({ title: 'Masquer toutes les images ?', body: `Toutes les images de ${d.path.split('/').pop()} seront noircies (l'original est au coffre).`, confirm: 'Tout masquer', cancel: 'Annuler' })) fix('blank');
      }, 'find-nav'),
      button('Rien de sensible', 'Les images ne montrent rien de confidentiel : retirer de la liste', async () => { await api('/api/vault/office-save', { path: d.path }); render(); }, 'find-nav'),
    ]));
  }

  body.appendChild(el('div', 'usage-section-title', 'Documents réels (Particulariser)'));
  if (!(v.reels || []).length) body.appendChild(note('Aucun : dans la visionneuse, le bouton « personne » produit la version avec les vrais noms d\'un livrable.'));
  for (const r of v.reels || []) {
    const a = el('a', 'find-nav artifact-link', '⇩');
    a.href = `${wsBase}/api/vault/reel?id=${encodeURIComponent(r.id)}`;
    a.title = 'Télécharger';
    body.appendChild(row(r.name, `${when(r.mtime)} · ${Math.max(1, Math.round(r.size / 1024))} Ko`, [a]));
  }
  body.appendChild(el('div', 'usage-section-title', 'Jamais pseudonymisés'));
  const ex = area((v.exempt || []).join('\n'), 4);
  body.append(ex, button('Enregistrer', null, async () => { await api('/api/vault/exempt', { list: ex.value.split('\n') }); showToast('Exemptions enregistrées.'); }));
  wipeSection();
  body.appendChild(el('div', 'usage-section-title', 'Ne pas signaler avant l\'envoi'));
  body.appendChild(note('Mots en majuscule que l\'alerte avant envoi ne propose plus de protéger (produits, sigles techniques…). Une ligne par mot.'));
  const ig = area((v.ignored || []).join('\n'), 4);
  body.append(ig, button('Enregistrer', null, async () => { await api('/api/vault/ignore', { list: ig.value.split('\n') }); showToast('Liste enregistrée.'); }));
}

// ── WhatsApp ──
const PROFILE_LABEL = { owner: 'Propriétaire — tout l\'assistant', family: 'Famille — la maison seulement' };
const step = (n, html) => { const d = el('div', 'usage-note hub-note'); d.innerHTML = `<b>${n}.</b> ${html}`; return d; };
const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const copyBtn = (value, what) => button('Copier', `Copier ${what}`, () => copy(value).then(() => showToast(`${what[0].toUpperCase()}${what.slice(1)} copié.`)), 'find-nav');

async function renderWhatsApp() {
  const w = await api('/api/whatsapp');
  if (tab !== 'whatsapp') return;
  if (w.ok === false) { body.appendChild(note(w.error || 'Indisponible.')); return; }
  body.appendChild(note('Écrire à l\'assistant depuis WhatsApp — texte, vocal, photo, position — toi et ta famille. Chaque personne a sa conversation ; les actions sensibles (serrure, alarme, garage) demandent un Oui / Non dans le chat. Rien de confidentiel ne passe par là : WhatsApp transite par Meta.'));

  const r = w.relay || {};
  const state = [
    r.active ? '✅ Relais Home Assistant actif' : r.installed ? '⏳ Relais installé — redémarrer Home Assistant' : '⚪ Relais Home Assistant à installer',
    w.configured ? '✅ Clés Meta enregistrées' : '⚪ Clés Meta à saisir',
    w.contacts.length ? `✅ ${w.contacts.length} personne(s)` : '⚪ Personnes à ajouter',
  ];
  body.appendChild(el('div', 'usage-section-title', 'État'));
  body.appendChild(note(state.join(' · ')));
  const on = el('label', 'doc-check hub-check hub-note');
  const onCb = el('input');
  onCb.type = 'checkbox';
  onCb.checked = w.enabled;
  onCb.onchange = async () => { await api('/api/whatsapp/config', { enabled: onCb.checked }); showToast(onCb.checked ? 'WhatsApp activé.' : 'WhatsApp en pause : les messages sont ignorés.'); };
  on.append(onCb, document.createTextNode(' Répondre aux messages WhatsApp'));
  body.appendChild(on);

  // 1. The relay
  body.appendChild(el('div', 'usage-section-title', '1. Relais dans Home Assistant'));
  body.appendChild(note('Meta ne peut joindre que Home Assistant (ton adresse publique Tailscale Funnel). Une petite intégration lui transmet les messages, sans rien garder ni connaître de secret : elle s\'installe dans /config/custom_components et ajoute deux lignes à configuration.yaml, puis Home Assistant redémarre (≈ 1 min).'));
  const rb = el('div', 'hub-bar');
  rb.appendChild(button(r.installed ? (r.outdated ? 'Mettre à jour le relais' : 'Réinstaller le relais') : 'Installer le relais', null, async () => {
    const x = await api('/api/whatsapp/relay/install', {});
    showToast(x.ok ? `Relais installé${x.yamlAdded ? ' (configuration.yaml complété)' : ''}. Redémarre Home Assistant pour l'activer.` : (x.error || 'Échec.'), x.ok ? {} : { kind: 'error' });
    render();
  }));
  if (r.installed && !r.active || r.outdated) {
    rb.appendChild(button('Redémarrer Home Assistant', 'Vérifie la configuration puis redémarre', async () => {
      if (!await confirmAction({ title: 'Redémarrer Home Assistant ?', body: 'La configuration est vérifiée d\'abord. Home Assistant (et cette page) sera indisponible environ une minute.', confirm: 'Redémarrer', cancel: 'Plus tard' })) return;
      const x = await api('/api/whatsapp/relay/restart', {});
      showToast(x.ok ? 'Home Assistant redémarre…' : (x.error || 'Échec.'), x.ok ? {} : { kind: 'error', timeout: 15000 });
    }));
  }
  body.appendChild(rb);

  // 2. Meta
  body.appendChild(el('div', 'usage-section-title', '2. L\'app WhatsApp chez Meta (gratuit, une fois)'));
  const pub = input(w.publicUrl, 'https://homeassistant.xxxx.ts.net');
  body.appendChild(field('Adresse publique de Home Assistant', pub));
  body.appendChild(step(1, 'Sur <a href="https://developers.facebook.com/apps" target="_blank" rel="noopener">developers.facebook.com › Mes apps</a> : <i>Créer une app</i> › cas d\'usage « Autre » › type « Entreprise ». Dans l\'app, ajoute le produit <b>WhatsApp</b> : Meta crée un compte WhatsApp Business et un <b>numéro de test gratuit</b>.'));
  body.appendChild(step(2, '<i>WhatsApp › Configuration de l\'API</i> : copie l\'<b>identifiant du numéro de téléphone</b> (Phone number ID). Dans « À », ajoute ton numéro et celui de ta femme (chacun reçoit un code sur WhatsApp) — 5 numéros au maximum.'));
  body.appendChild(step(3, 'Jeton permanent : <a href="https://business.facebook.com/settings/system-users" target="_blank" rel="noopener">business.facebook.com › Paramètres › Utilisateurs système</a> › <i>Ajouter</i> (rôle Admin) › <i>Assigner des éléments</i> : l\'app et le compte WhatsApp (contrôle total) › <i>Générer un jeton</i> : expiration « Jamais », autorisations <b>whatsapp_business_messaging</b> et <b>whatsapp_business_management</b>. (Le jeton temporaire de la page API expire en 24 h.)'));
  body.appendChild(step(4, '<i>Paramètres de l\'app › Général</i> : affiche et copie la <b>clé secrète</b>. Colle le tout ici puis <i>Enregistrer</i>.'));
  const phoneId = input(w.phoneNumberId, '123456789012345');
  const token = input('', w.hasToken ? '•••••• (enregistré — coller pour remplacer)' : 'EAAG…', 'password');
  const secret = input('', w.hasSecret ? '•••••• (enregistrée — coller pour remplacer)' : '32 caractères', 'password');
  body.append(field('Identifiant du numéro (Phone number ID)', phoneId), field('Jeton d\'accès permanent', token), field('Clé secrète de l\'app (App secret)', secret));
  const save = el('div', 'hub-bar');
  save.appendChild(button('Enregistrer', null, async () => {
    const x = await api('/api/whatsapp/config', { publicUrl: pub.value, phoneNumberId: phoneId.value, accessToken: token.value, appSecret: secret.value });
    showToast(x.ok ? 'Enregistré.' : (x.error || 'Échec.'), x.ok ? {} : { kind: 'error' });
    if (x.ok) render();
  }));
  save.appendChild(button('Tester', 'Vérifie le jeton et le numéro auprès de Meta', async () => {
    const x = await api('/api/whatsapp/test', {});
    showToast(x.ok ? `Meta répond : numéro ${x.number || '?'}${x.name ? ` (${x.name})` : ''}.` : (x.error || 'Échec.'), x.ok ? {} : { kind: 'error', timeout: 15000 });
  }));
  if (w.configured) save.appendChild(button('Oublier les clés', null, async () => {
    if (await confirmAction({ title: 'Oublier les clés Meta ?', body: 'Les messages ne seront plus traités. Les personnes restent dans la liste.', confirm: 'Oublier', cancel: 'Garder' })) { await api('/api/whatsapp/forget', {}); render(); }
  }));
  body.appendChild(save);
  body.appendChild(step(5, `<i>WhatsApp › Configuration › Webhook</i> › <i>Modifier</i> : <b>URL de rappel</b> ${w.webhookUrl ? `<code>${esc(w.webhookUrl)}</code>` : '(enregistre d\'abord l\'adresse publique)'} et <b>jeton de vérification</b> <code>${esc(w.verifyToken)}</code> › <i>Vérifier et enregistrer</i> (le relais doit être actif). Puis, dans les champs du webhook, abonne-toi à <b>messages</b>.`));
  const cp = el('div', 'hub-bar');
  if (w.webhookUrl) cp.appendChild(copyBtn(w.webhookUrl, 'l\'URL de rappel'));
  cp.appendChild(copyBtn(w.verifyToken, 'le jeton de vérification'));
  body.appendChild(cp);

  // 3. People
  body.appendChild(el('div', 'usage-section-title', '3. Qui peut écrire à l\'assistant'));
  body.appendChild(note('Les autres numéros sont ignorés. « Famille » : consulter et piloter la maison, chercher sur le web ; ni fichiers, ni tes instructions, ni ta mémoire (une mémoire à part). Une personne doit avoir écrit au bot dans les dernières 24 h pour qu\'il puisse lui envoyer un message de lui-même (règle WhatsApp).'));
  const people = (w.contacts || []).map((c) => ({ ...c }));
  const list = el('div');
  const draw = () => {
    list.innerHTML = '';
    people.forEach((c, i) => {
      const f = el('div', 'scheduled-form hub-form');
      const name = input(c.name, 'Prénom');
      const num = input(c.number, '+32 470 12 34 56');
      const prof = select(Object.entries(PROFILE_LABEL), c.profile || 'family');
      const person = input(c.person || '', 'person.prenom');
      name.oninput = () => { c.name = name.value; };
      num.oninput = () => { c.number = num.value; };
      prof.onchange = () => { c.profile = prof.value; };
      person.oninput = () => { c.person = person.value.trim(); };
      const r2 = el('div', 'hub-row2 hub-row2-wide');
      r2.append(field('Prénom', name), field('Numéro WhatsApp', num));
      const r3 = el('div', 'hub-row2 hub-row2-wide');
      r3.append(field('Profil', prof), field('Personne dans HA', person));
      const acts = el('div', 'hub-bar');
      if (c.lastInboundAt) acts.appendChild(el('span', 'skill-desc', `Dernier message : ${when(c.lastInboundAt)}`));
      if (w.configured && w.contacts.some((x) => x.number === c.number)) acts.appendChild(button('Envoyer un bonjour', 'Message de test (seulement si cette personne a écrit au bot dans les 24 h)', async () => {
        const x = await api('/api/whatsapp/test', { to: c.number });
        showToast(x.ok ? `Envoyé à ${c.name}.` : (x.error || 'Échec.'), x.ok ? {} : { kind: 'error', timeout: 15000 });
      }));
      acts.appendChild(button('🗑', 'Retirer', () => { people.splice(i, 1); draw(); }, 'find-nav'));
      f.append(r2, r3, acts);
      list.appendChild(f);
    });
  };
  draw();
  body.appendChild(list);
  const pb = el('div', 'hub-bar');
  pb.appendChild(button('+ Ajouter une personne', null, () => { if (people.length >= 5) { showToast('5 personnes au maximum (numéro de test de Meta).', { kind: 'error' }); return; } people.push({ name: '', number: '', profile: people.length ? 'family' : 'owner', person: '' }); draw(); }));
  pb.appendChild(button('Enregistrer les personnes', null, async () => {
    const x = await api('/api/whatsapp/contacts', { contacts: people });
    showToast(x.ok ? 'Personnes enregistrées.' : (x.error || 'Échec.'), x.ok ? {} : { kind: 'error' });
    if (x.ok) render();
  }));
  body.appendChild(pb);
  body.appendChild(note('Dans WhatsApp : enregistre le numéro de test comme contact « Soufassistant » et écris-lui « /aide ». /nouveau repart de zéro, /stop arrête.'));
}
