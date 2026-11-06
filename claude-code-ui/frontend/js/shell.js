/*
 * The app shell (1.2 design) — everything around the conversation that is not
 * one feature's own panel. It only adds and rearranges; every feature button
 * keeps its id and its handler.
 *
 *   layout     body.layout-sidebar (≥ 1024px): the header is a left sidebar.
 *              body.layout-drawer (< 700px, phones): the header is a drawer
 *              that slides in from the left, under a slim top bar (menu, title,
 *              usage %, new chat). In between, the compact header row stays.
 *   icons      one drawn set (icons.js) replaces every header / composer icon
 *   composer   tools on the left (attach · options · role), the conversation's
 *              mode as a pill, then voice (dictate · call) and send, on the right
 *   mode       the pill opens a picker: Chat / Code / Cowork as three cards,
 *              and the Cowork project
 *   usage      the plan's 5-hour usage %, always in sight (top bar on a phone,
 *              the sidebar on a computer)
 *   recents    the last conversations in the sidebar / drawer
 *   palette    ⌘K / Ctrl+K: every action, panel, mode, option and conversation
 *   home       a greeting and numbered starting points on an empty conversation
 *   theme      Ink (dark), Paper (light), Signal (the brand colour), or system
 */
import { S } from './state.js';
import { promptInput, messagesEl, settingsPanel } from './dom.js';
import { switchTo, relTime } from './sessions.js';
import { setMode } from './modes.js';
import { setResearch, setAutonomous, openToolbox } from './toolbox.js';
import { icon, setIcon, LOGO } from './icons.js';

const FR = /^fr/i.test(navigator.language || '');
const t = (fr, en) => (FR ? fr : en);
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || '');
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const iconBtn = (id, name, label, cls = 'icon-btn') => {
  const b = el('button', cls);
  b.type = 'button';
  if (id) b.id = id;
  b.title = label;
  b.setAttribute('aria-label', label);
  b.innerHTML = icon(name);
  return b;
};

// ── Theme ───────────────────────────────────────────────────────────────────
const media = window.matchMedia('(prefers-color-scheme: light)');
const THEME_COLOR = { dark: '#08090a', light: '#f2f0ea', signal: '#0a3d38' };
export function applyTheme(pref = localStorage.getItem('theme') || 'dark') {
  const eff = pref === 'auto' ? (media.matches ? 'light' : 'dark') : pref;
  document.documentElement.dataset.theme = eff;
  let meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) { meta = document.createElement('meta'); meta.name = 'theme-color'; document.head.appendChild(meta); }
  meta.content = THEME_COLOR[eff] || THEME_COLOR.dark;
}
export function setTheme(pref) { localStorage.setItem('theme', pref); applyTheme(pref); renderThemePicker(); }
media.addEventListener?.('change', () => applyTheme());
applyTheme();

const THEMES = [['dark', t('Encre', 'Ink')], ['light', t('Papier', 'Paper')], ['signal', 'Signal'], ['auto', t('Système', 'System')]];
const themeRow = el('div', 'settings-row shell-theme-row');
function renderThemePicker() {
  themeRow.innerHTML = '';
  themeRow.appendChild(el('label', null, t('Apparence', 'Appearance')));
  const seg = el('div', 'seg');
  const pref = localStorage.getItem('theme') || 'dark';
  for (const [v, l] of THEMES) {
    const b = el('button', `seg-btn${pref === v ? ' active' : ''}`, l);
    b.type = 'button';
    b.onclick = (e) => { e.stopPropagation(); setTheme(v); };
    seg.appendChild(b);
  }
  themeRow.appendChild(seg);
}
renderThemePicker();
settingsPanel.prepend(themeRow);

// ── Layout ──────────────────────────────────────────────────────────────────
const wide = window.matchMedia('(min-width: 1024px)');
const phone = window.matchMedia('(max-width: 699px)');
function applyLayout() {
  document.body.classList.toggle('layout-sidebar', wide.matches);
  document.body.classList.toggle('layout-drawer', phone.matches);
  if (!phone.matches) closeDrawer();
}
wide.addEventListener?.('change', applyLayout);
phone.addEventListener?.('change', applyLayout);

// ── Header → sidebar / drawer ──────────────────────────────────────────────
const app = $('app');
const header = document.querySelector('.header');
const headerLeft = header.querySelector('.header-left');
const headerRight = header.querySelector('.header-right');

const brand = header.querySelector('.brand-logo');
brand.innerHTML = LOGO(22);
brand.after(el('span', 'brand-word', 'Soufassistant'));

const collapse = iconBtn(null, 'sidebar', t('Réduire la barre latérale', 'Collapse the sidebar'), 'icon-btn sidebar-collapse');
headerLeft.appendChild(collapse);
const setCollapsed = (on) => {
  document.body.classList.toggle('sidebar-collapsed', on);
  localStorage.setItem('sidebarCollapsed', on ? '1' : '0');
};
collapse.onclick = (e) => {
  e.stopPropagation();
  if (document.body.classList.contains('layout-drawer')) closeDrawer();
  else setCollapsed(!document.body.classList.contains('sidebar-collapsed'));
};
setCollapsed(localStorage.getItem('sidebarCollapsed') === '1');

const NAV = {
  'find-btn': ['search', t('Rechercher dans la conversation', 'Find in chat')],
  'sessions-btn': ['history', t('Toutes les conversations', 'All conversations')],
  'tasks-btn': ['tasks', t('Tâches', 'Tasks')],
  'artifacts-btn': ['layers', t('Artefacts', 'Artifacts')],
  'workspace-btn': ['folder', t('Espace de travail', 'Workspace')],
  'scheduled-btn': ['clock', t('Tâches planifiées', 'Scheduled')],
  'team-btn': ['users', t('Équipe', 'Team')],
  'hub-btn': ['grid', 'Hub'],
  'skills-btn': ['spark', 'Skills'],
  'usage-btn': ['gauge', t('Utilisation', 'Usage')],
  'settings-btn': ['settings', t('Réglages', 'Settings')],
  'new-session-btn': ['compose', t('Nouvelle conversation', 'New chat')],
};
for (const [id, [name, label]] of Object.entries(NAV)) {
  const b = $(id);
  if (!b) continue;
  setIcon(b, name);
  b.classList.add('nav-item');
  b.appendChild(el('span', 'nav-label', label));
}

const searchBtn = el('button', 'icon-btn nav-item nav-search');
searchBtn.type = 'button';
searchBtn.id = 'palette-btn';
searchBtn.title = `${t('Tout rechercher', 'Search everything')} (${isMac ? '⌘' : 'Ctrl+'}K)`;
searchBtn.setAttribute('aria-label', t('Tout rechercher', 'Search everything'));
searchBtn.innerHTML = `${icon('command')}<span class="nav-label">${t('Rechercher', 'Search')}</span><kbd class="nav-kbd">${isMac ? '⌘' : 'Ctrl'} K</kbd>`;
headerRight.prepend(searchBtn);

const recents = el('div', 'sidebar-recents');
const recentsList = el('div', 'sidebar-recents-list');
recents.append(el('div', 'sidebar-section', t('Récentes', 'Recent')), recentsList);
headerRight.insertBefore(recents, $('sessions-btn'));
headerRight.insertBefore(el('div', 'sidebar-section sidebar-section-nav', t('Outils', 'Tools')), $('tasks-btn'));

export function renderRecents() {
  recentsList.innerHTML = '';
  const list = (S.sessions || []).slice().sort((a, b) => (b.pinned - a.pinned) || ((b.updatedAt || 0) - (a.updatedAt || 0))).slice(0, 16);
  if (!list.length) recentsList.appendChild(el('div', 'sidebar-empty', t('Aucune conversation pour l\'instant', 'No conversation yet')));
  for (const s of list) {
    const b = el('button', `recent-item${s.id === S.activeSessionId ? ' active' : ''}`);
    b.type = 'button';
    b.title = s.title || '';
    const mode = S.sessionModes?.[s.id]?.mode;
    if (mode) b.dataset.mode = mode;
    b.append(el('span', 'recent-title', `${s.pinned ? '★ ' : ''}${s.title || t('Sans titre', 'Untitled')}`), el('span', 'recent-time', relTime(s.updatedAt)));
    b.onclick = (e) => { e.stopPropagation(); closeDrawer(); switchTo(s.id); };
    recentsList.appendChild(b);
  }
  renderTitle();
}

// ── Phone: top bar + drawer ────────────────────────────────────────────────
const topbar = el('div', 'topbar');
const menuBtn = iconBtn('menu-btn', 'menu', 'Menu');
const title = el('button', 'topbar-title');
title.type = 'button';
const usagePill = el('button', 'usage-pill');
usagePill.type = 'button';
usagePill.title = t('Utilisation du forfait (5 heures)', 'Plan usage (5-hour window)');
const topNew = iconBtn('topbar-new', 'compose', t('Nouvelle conversation', 'New chat'));
topbar.append(menuBtn, title, usagePill, topNew);
app.prepend(topbar);
const backdrop = el('div', 'drawer-backdrop');
app.appendChild(backdrop);

function openDrawer() { document.body.classList.add('drawer-open'); renderRecents(); }
function closeDrawer() { document.body.classList.remove('drawer-open'); }
menuBtn.onclick = (e) => { e.stopPropagation(); openDrawer(); };
backdrop.onclick = closeDrawer;
topNew.onclick = (e) => { e.stopPropagation(); $('new-session-btn').click(); };
title.onclick = (e) => { e.stopPropagation(); openModePicker(title); };
// Anything chosen in the drawer closes it (the panel it opens shows on its own).
header.addEventListener('click', (e) => {
  if (!document.body.classList.contains('drawer-open')) return;
  const b = e.target.closest('button, select');
  if (b && b.tagName === 'BUTTON' && b !== collapse) setTimeout(closeDrawer, 0);
});
// Swipe the drawer back to the left.
let touchX = null;
header.addEventListener('touchstart', (e) => { touchX = e.touches[0].clientX; }, { passive: true });
header.addEventListener('touchend', (e) => {
  if (touchX != null && e.changedTouches[0].clientX - touchX < -60) closeDrawer();
  touchX = null;
}, { passive: true });
// …and from the left edge of the screen, open it.
let edgeX = null;
document.addEventListener('touchstart', (e) => { const x = e.touches[0].clientX; edgeX = x < 18 ? x : null; }, { passive: true });
document.addEventListener('touchend', (e) => {
  if (edgeX != null && document.body.classList.contains('layout-drawer') && e.changedTouches[0].clientX - edgeX > 70) openDrawer();
  edgeX = null;
}, { passive: true });

const MODES = {
  chat: { icon: 'chat', name: 'Chat', desc: t('Une conversation simple, avec le web. Pas d\'accès aux fichiers ni à la maison.', 'A plain conversation, with the web. No access to files or the house.') },
  code: { icon: 'code', name: 'Code', desc: t('Accès complet : Home Assistant, /config, le terminal, tes fichiers.', 'Full access: Home Assistant, /config, the terminal, your files.') },
  cowork: { icon: 'cowork', name: 'Cowork', desc: t('Construit et teste dans un projet de ton espace de travail.', 'Builds and tests inside a workspace project.') },
};

function renderTitle() {
  const s = (S.sessions || []).find((x) => x.id === S.activeSessionId);
  const m = MODES[S.mode] || MODES.code;
  title.innerHTML = '';
  title.append(el('span', 'topbar-title-text', s?.title || t('Nouvelle conversation', 'New chat')));
  const sub = el('span', 'topbar-title-mode');
  sub.innerHTML = `${icon(m.icon, 12)}${m.name}${S.mode === 'cowork' && S.coworkProject ? ` · ${S.coworkProject}` : ''}${icon('chevron', 12)}`;
  title.appendChild(sub);
}

// ── Usage %, always visible ─────────────────────────────────────────────────
const usageBtn = $('usage-btn');
const sidebarUsage = el('div', 'sidebar-usage');
function syncUsage() {
  const badge = usageBtn?.querySelector('.usage-badge');
  const txt = badge?.textContent?.trim() || '';
  const sev = (badge?.className.match(/usage-badge-(\w+)/) || [])[1] || 'ok';
  const pct = parseInt(txt, 10);
  for (const pill of [usagePill, sidebarUsage]) {
    pill.classList.toggle('hidden', !txt);
    pill.dataset.sev = sev;
    pill.style.setProperty('--pct', Number.isFinite(pct) ? pct : 0);
  }
  usagePill.innerHTML = `<span class="ring"></span><span>${txt}</span>`;
  sidebarUsage.innerHTML = `<span class="sidebar-usage-label">${t('Forfait · 5 h', 'Plan · 5 h')}</span><span class="sidebar-usage-val">${txt}</span><span class="bar"><i></i></span>`;
}
if (usageBtn) new MutationObserver(syncUsage).observe(usageBtn, { subtree: true, childList: true, characterData: true, attributes: true });
usagePill.onclick = (e) => { e.stopPropagation(); usageBtn?.click(); };
sidebarUsage.onclick = (e) => { e.stopPropagation(); usageBtn?.click(); };
headerRight.insertBefore(sidebarUsage, $('perm-mode'));
syncUsage();

// ── Composer: a coherent order ──────────────────────────────────────────────
const composerActions = document.querySelector('.composer-actions');
const left = document.querySelector('.composer-left');
const right = el('div', 'composer-right');
const attach = $('attach-btn'), tools = $('toolbox-btn'), roles = $('roles-btn'), mic = $('mic-btn'), talk = $('talk-btn'), send = $('send-btn');
setIcon(attach, 'paperclip', 19);
setIcon(tools, 'sliders', 19);
setIcon(roles, 'user', 19);
setIcon(mic, 'mic', 19);
setIcon(talk, 'phone', 19);
tools.title = t('Options : agent, recherche approfondie, autonomie, projet', 'Options: agent, deep research, autonomous, project');
for (const b of [attach, tools, roles].filter(Boolean)) left.appendChild(b);
for (const id of ['composer-mode', 'composer-project']) { const n = $(id); if (n) left.appendChild(n); }

const modePill = el('button', 'mode-pill');
modePill.type = 'button';
modePill.id = 'mode-pill';
modePill.setAttribute('aria-haspopup', 'dialog');
right.append(modePill, mic, talk);
composerActions.insertBefore(right, send);
right.appendChild(send);

function renderModePill() {
  const m = MODES[S.mode] || MODES.code;
  modePill.dataset.mode = S.mode;
  modePill.title = `${t('Mode', 'Mode')} : ${m.name}`;
  modePill.innerHTML = `${icon(m.icon, 15)}<span>${m.name}${S.mode === 'cowork' && S.coworkProject ? `<em> · ${S.coworkProject}</em>` : ''}</span>${icon('chevron', 13)}`;
  renderTitle();
}
new MutationObserver(renderModePill).observe(document.body, { attributes: true, attributeFilter: ['data-mode'] });
renderModePill();

// The picker: three cards, and the project for Cowork.
const pop = el('div', 'mode-pop hidden');
pop.setAttribute('role', 'dialog');
pop.setAttribute('aria-label', t('Choisir le mode', 'Choose the mode'));
document.body.appendChild(pop);
function openModePicker(anchor = modePill) {
  pop.innerHTML = '';
  pop.appendChild(el('div', 'mode-pop-head', t('Mode de travail', 'How Claude works')));
  Object.entries(MODES).forEach(([id, m], i) => {
    const c = el('button', `mode-card${S.mode === id ? ' active' : ''}`);
    c.type = 'button';
    c.dataset.mode = id;
    c.innerHTML = `<span class="mode-card-num">#${i + 1}</span><span class="mode-card-icon">${icon(m.icon, 20)}</span><span class="mode-card-text"><b>${m.name}</b><small>${m.desc}</small></span>`;
    c.onclick = (e) => {
      e.stopPropagation();
      if (id === 'cowork') { renderProjects(); return; }
      setMode(id);
      closeModePicker();
    };
    pop.appendChild(c);
  });
  if (S.mode === 'cowork') renderProjects(false);
  const r = anchor.getBoundingClientRect();
  pop.classList.remove('hidden');
  const w = pop.offsetWidth, h = pop.offsetHeight;
  if (document.body.classList.contains('layout-drawer')) {
    pop.style.left = ''; pop.style.top = ''; pop.style.bottom = '';
    pop.classList.add('as-sheet');
  } else {
    pop.classList.remove('as-sheet');
    pop.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w))}px`;
    pop.style.top = `${Math.max(8, r.top - h - 10)}px`;
  }
  pop.querySelector('.mode-card.active, .mode-card')?.focus();
}
function renderProjects(pick = true) {
  pop.querySelector('.mode-pop-projects')?.remove();
  const box = el('div', 'mode-pop-projects');
  box.appendChild(el('div', 'mode-pop-head', t('Projet Cowork', 'Cowork project')));
  const names = (S.workspaceState?.projects || []).map((p) => p.name || p);
  if (!names.length) box.appendChild(el('div', 'mode-pop-empty', t('Aucun projet — crée-en un dans l\'espace de travail.', 'No project yet — create one in the Workspace.')));
  for (const n of names) {
    const b = el('button', `ws-chip${S.mode === 'cowork' && S.coworkProject === n ? ' active' : ''}`, n);
    b.type = 'button';
    b.onclick = (e) => { e.stopPropagation(); setMode('cowork', { project: n }); closeModePicker(); };
    box.appendChild(b);
  }
  const ws = el('button', 'ws-chip ws-chip-ghost', t('+ Nouveau projet…', '+ New project…'));
  ws.type = 'button';
  ws.onclick = (e) => { e.stopPropagation(); closeModePicker(); $('workspace-btn').click(); };
  box.appendChild(ws);
  pop.appendChild(box);
  if (pick && names.length === 1) { setMode('cowork', { project: names[0] }); closeModePicker(); }
}
function closeModePicker() { pop.classList.add('hidden'); }
modePill.onclick = (e) => { e.stopPropagation(); if (pop.classList.contains('hidden')) openModePicker(); else closeModePicker(); };
document.addEventListener('click', (e) => { if (!pop.classList.contains('hidden') && !pop.contains(e.target) && e.target !== modePill) closeModePicker(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeModePicker(); closeDrawer(); } });

// ── Home screen ─────────────────────────────────────────────────────────────
const chatScroll = $('chat-scroll');
const home = el('div', 'home hidden');
chatScroll.appendChild(home);
const greeting = () => {
  const h = new Date().getHours();
  const name = localStorage.getItem('userName') || '';
  const g = h < 5 ? t('Bonne nuit', 'Good night') : h < 12 ? t('Bonjour', 'Good morning') : h < 18 ? t('Bon après-midi', 'Good afternoon') : t('Bonsoir', 'Good evening');
  return `${g}${name ? `, ${name}` : ''}.`;
};
const SUGGESTIONS = [
  { icon: 'target', tag: t('Recherche', 'Research'), title: t('Recherche approfondie', 'Deep research'), text: t('Fais une recherche approfondie sur ', 'Do deep research on '), research: true },
  { icon: 'slides', tag: t('Créer', 'Create'), title: t('Une présentation', 'A presentation'), text: t('Prépare une présentation de 8 slides sur ', 'Make an 8-slide presentation about ') },
  { icon: 'house', tag: t('Maison', 'Home'), title: t('Le point sur la maison', 'House check'), text: t('Fais le point sur la maison : énergie du jour, chauffage, alertes et appareils hors ligne.', 'Give me a house check: today\'s energy, heating, alerts and offline devices.'), mode: 'code' },
  { icon: 'mail', tag: t('E-mail', 'E-mail'), title: t('Mes e-mails du jour', 'Today\'s e-mail'), text: t('Résume mes e-mails non lus importants et prépare des brouillons de réponse.', 'Summarise my important unread e-mail and draft replies.') },
  { icon: 'bolt', tag: t('Autonome', 'Autonomous'), title: t('Une tâche en autonomie', 'An autonomous task'), text: t('En autonomie, ', 'On your own, '), autonomous: true },
  { icon: 'globe', tag: 'Web', title: t('Utiliser un site', 'Use a website'), text: t('Va sur le site ', 'Go to the site ') },
];
function renderHome() {
  home.innerHTML = '';
  const mark = el('div', 'home-mark');
  mark.innerHTML = LOGO(56);
  const h = el('h1', 'home-title', greeting());
  const sub = el('p', 'home-sub', t('Que fait-on aujourd\'hui ?', 'What are we doing today?'));
  const grid = el('div', 'home-grid');
  SUGGESTIONS.forEach((s, i) => {
    const c = el('button', 'home-card');
    c.type = 'button';
    c.innerHTML = `<span class="home-card-top"><span class="home-card-num">#${i + 1} ${s.tag}</span>${icon(s.icon, 18)}</span><span class="home-card-title">${s.title}</span>`;
    c.onclick = () => {
      if (s.mode && s.mode !== S.mode) setMode(s.mode);
      if (s.research) setResearch(true);
      if (s.autonomous) setAutonomous(true);
      promptInput.value = s.text;
      promptInput.dispatchEvent(new Event('input', { bubbles: true }));
      promptInput.focus();
      promptInput.setSelectionRange(promptInput.value.length, promptInput.value.length);
    };
    grid.appendChild(c);
  });
  const hint = el('p', 'home-hint');
  hint.innerHTML = `<kbd>${isMac ? '⌘' : 'Ctrl'} K</kbd> ${t('tout retrouver', 'reach anything')} <span>·</span> ${icon('sliders', 13)} ${t('agents, recherche, autonomie', 'agents, research, autonomy')}`;
  home.append(mark, h, sub, grid, hint);
}
function syncHome() {
  const empty = !messagesEl.children.length;
  const loginShown = !$('login-screen')?.classList.contains('hidden');
  const show = empty && !loginShown;
  if (show && home.classList.contains('hidden')) renderHome();
  home.classList.toggle('hidden', !show);
  document.body.classList.toggle('is-home', show);
}
new MutationObserver(syncHome).observe(messagesEl, { childList: true });
setTimeout(syncHome, 0);

// ── Command palette ─────────────────────────────────────────────────────────
const overlay = el('div', 'palette-overlay hidden');
const box = el('div', 'palette');
box.setAttribute('role', 'dialog');
box.setAttribute('aria-label', t('Palette de commandes', 'Command palette'));
const input = el('input', 'palette-input');
input.placeholder = t('Une action, un panneau, une conversation…', 'An action, a panel, a conversation…');
input.setAttribute('aria-label', input.placeholder);
const results = el('div', 'palette-results');
const foot = el('div', 'palette-foot');
foot.innerHTML = `<span><kbd>↑</kbd><kbd>↓</kbd> ${t('naviguer', 'navigate')}</span><span><kbd>↵</kbd> ${t('ouvrir', 'open')}</span><span><kbd>esc</kbd> ${t('fermer', 'close')}</span>`;
box.append(input, results, foot);
overlay.appendChild(box);
document.body.appendChild(overlay);
let items = [], sel = 0;

const click = (id) => () => $(id)?.click();
const G = { act: t('Actions', 'Actions'), mode: 'Mode', panel: t('Panneaux', 'Panels'), look: t('Apparence', 'Appearance'), conv: t('Conversations', 'Conversations') };
function actions() {
  const a = [
    { g: G.act, icon: 'compose', label: t('Nouvelle conversation', 'New chat'), run: click('new-session-btn'), kw: 'new nouveau' },
    { g: G.act, icon: 'target', label: t('Recherche approfondie (prochain message)', 'Deep research (next message)'), run: () => { setResearch(true); promptInput.focus(); }, kw: 'research deep recherche' },
    { g: G.act, icon: 'bolt', label: t('Tâche autonome (prochain message)', 'Autonomous task (next message)'), run: () => { setAutonomous(true); promptInput.focus(); }, kw: 'autonomous manus autonome' },
    { g: G.act, icon: 'bot', label: t('Choisir un agent…', 'Pick an agent…'), run: () => openToolbox(), kw: 'agent gpt' },
    { g: G.act, icon: 'phone', label: t('Appeler Claude', 'Call Claude'), run: click('talk-btn'), kw: 'call voice voix appel' },
    { g: G.act, icon: 'mic', label: t('Dicter', 'Dictate'), run: click('mic-btn'), kw: 'mic dictation dictée' },
    { g: G.act, icon: 'paperclip', label: t('Joindre des fichiers', 'Attach files'), run: click('attach-btn'), kw: 'attach upload joindre' },
    { g: G.act, icon: 'search', label: t('Rechercher dans la conversation', 'Find in this chat'), run: click('find-btn'), kw: 'find chercher' },
  ];
  for (const [id, m] of Object.entries(MODES)) a.push({ g: G.mode, icon: m.icon, label: m.name, sub: m.desc, run: () => (id === 'cowork' ? openModePicker() : setMode(id)), kw: 'mode' });
  for (const [id, [ic, label]] of Object.entries(NAV)) {
    if (id === 'new-session-btn' || id === 'find-btn' || id === 'tasks-btn') continue;
    a.push({ g: G.panel, icon: ic, label, run: click(id), kw: 'panel panneau' });
  }
  for (const [tabId, label, ic] of [['agents', 'Agents', 'bot'], ['memory', t('Mémoire', 'Memory'), 'memory'], ['projects', t('Projets', 'Projects'), 'cowork'], ['connectors', t('Connecteurs (Gmail, Agenda)', 'Connectors (Gmail, Calendar)'), 'plug'], ['apps', t('Apps publiées', 'Published apps'), 'upload'], ['shared', t('Liens partagés', 'Shared links'), 'share']]) {
    a.push({ g: 'Hub', icon: ic, label, run: () => import('./hub.js').then((h) => h.openHub(tabId)), kw: 'hub' });
  }
  for (const [v, l] of THEMES) a.push({ g: G.look, icon: v === 'light' ? 'sun' : 'moon', label: `${t('Thème', 'Theme')} ${l}`, run: () => setTheme(v), kw: 'theme thème' });
  a.push({ g: G.look, icon: 'sidebar', label: t('Afficher / réduire la barre latérale', 'Toggle the sidebar'), run: () => setCollapsed(!document.body.classList.contains('sidebar-collapsed')), kw: 'sidebar' });
  for (const s of (S.sessions || []).slice(0, 60)) a.push({ g: G.conv, icon: 'chat', label: s.title || t('Sans titre', 'Untitled'), sub: relTime(s.updatedAt), run: () => switchTo(s.id), kw: '' });
  return a;
}

/** Subsequence match, with a bonus for word starts and contiguity. Pure. */
export function fuzzyScore(q, text) {
  q = q.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  text = String(text).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (!q) return 1;
  let i = 0, score = 0, last = -2;
  for (let j = 0; j < text.length && i < q.length; j++) {
    if (text[j] === q[i]) {
      score += (j === last + 1 ? 3 : 1) + (j === 0 || /[\s\-–/(]/.test(text[j - 1]) ? 4 : 0);
      last = j; i++;
    }
  }
  return i === q.length ? score : 0;
}

function renderPalette() {
  const q = input.value.trim();
  const all = actions();
  items = q
    ? all.map((x) => ({ ...x, s: Math.max(fuzzyScore(q, x.label), fuzzyScore(q, x.kw || '') * 0.6) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 40)
    : all.filter((x) => x.g !== G.conv).concat(all.filter((x) => x.g === G.conv).slice(0, 6));
  sel = Math.min(sel, Math.max(0, items.length - 1));
  results.innerHTML = '';
  let group = null;
  items.forEach((x, i) => {
    if (!q && x.g !== group) { results.appendChild(el('div', 'palette-group', x.g)); group = x.g; }
    const r = el('button', `palette-item${i === sel ? ' active' : ''}`);
    r.type = 'button';
    const ic = el('span', 'palette-icon');
    ic.innerHTML = icon(x.icon, 16);
    r.append(ic, el('span', 'palette-label', x.label));
    if (x.sub && x.g === G.conv) r.appendChild(el('span', 'palette-sub', x.sub));
    else if (q) r.appendChild(el('span', 'palette-sub', x.g));
    r.onmouseenter = () => { sel = i; for (const n of results.querySelectorAll('.palette-item')) n.classList.toggle('active', n === r); };
    r.onclick = () => choose(i);
    results.appendChild(r);
  });
  if (!items.length) results.appendChild(el('div', 'palette-empty', t('Rien ne correspond.', 'Nothing matches.')));
}
function choose(i) { const x = items[i]; if (!x) return; closePalette(); closeDrawer(); setTimeout(() => x.run(), 0); }
export function openPalette() {
  overlay.classList.remove('hidden');
  input.value = '';
  sel = 0;
  renderPalette();
  requestAnimationFrame(() => input.focus());
}
export function closePalette() { overlay.classList.add('hidden'); }
input.addEventListener('input', () => { sel = 0; renderPalette(); });
input.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(items.length - 1, sel + 1); renderPalette(); results.querySelector('.active')?.scrollIntoView({ block: 'nearest' }); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); renderPalette(); results.querySelector('.active')?.scrollIntoView({ block: 'nearest' }); }
  else if (e.key === 'Enter') { e.preventDefault(); choose(sel); }
  else if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
});
overlay.addEventListener('click', (e) => { if (e.target === overlay) closePalette(); });
searchBtn.onclick = (e) => { e.stopPropagation(); openPalette(); };
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    if (overlay.classList.contains('hidden')) openPalette(); else closePalette();
  }
});

applyLayout();
document.body.classList.add('shell-ready');
