/*
 * The app shell (1.1.0 design) — everything around the conversation that is
 * not one feature's own panel:
 *
 *   sidebar     on a wide screen (≥ 1024px) the header *is* a left sidebar
 *               (theme.css): brand + mode at the top, New chat, Search ⌘K, the
 *               recent conversations, then every panel as a labelled row.
 *               Collapsible to an icon rail (remembered).
 *   recents     the last conversations, one click away (renderRecents, called
 *               whenever the server sends the list)
 *   palette     ⌘K / Ctrl+K: one box to reach every action, panel, mode,
 *               option and conversation by typing a few letters
 *   home        an empty conversation shows a greeting and suggestions that
 *               fill the box (and switch on research / autonomy where it fits)
 *   theme       dark / light / follow the system (Settings, or the palette)
 *
 * It only rearranges and calls into the feature modules; their buttons keep
 * their ids and handlers, so nothing else had to change.
 */
import { S } from './state.js';
import { promptInput, messagesEl, settingsPanel } from './dom.js';
import { switchTo, relTime } from './sessions.js';
import { setMode } from './modes.js';
import { setResearch, setAutonomous, openToolbox } from './toolbox.js';

const FR = /^fr/i.test(navigator.language || '');
const t = (fr, en) => (FR ? fr : en);
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || '');
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const svg = (d) => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;

// ── Theme ───────────────────────────────────────────────────────────────────
const THEMES = ['auto', 'dark', 'light'];
const media = window.matchMedia('(prefers-color-scheme: light)');
export function applyTheme(pref = localStorage.getItem('theme') || 'dark') {
  const eff = pref === 'auto' ? (media.matches ? 'light' : 'dark') : pref;
  document.documentElement.dataset.theme = eff;
  document.documentElement.dataset.themePref = pref;
  const meta = document.querySelector('meta[name="theme-color"]') || document.head.appendChild(Object.assign(document.createElement('meta'), { name: 'theme-color' }));
  meta.content = eff === 'light' ? '#f6f7f8' : '#0b0f12';
}
export function setTheme(pref) { localStorage.setItem('theme', pref); applyTheme(pref); renderThemePicker(); }
media.addEventListener?.('change', () => applyTheme());
applyTheme();

// Settings → Appearance
const themeRow = el('div', 'settings-row shell-theme-row');
function renderThemePicker() {
  themeRow.innerHTML = '';
  themeRow.appendChild(el('label', null, t('Apparence', 'Appearance')));
  const seg = el('div', 'seg');
  const pref = localStorage.getItem('theme') || 'dark';
  for (const [v, l] of [['auto', t('Auto', 'Auto')], ['dark', t('Sombre', 'Dark')], ['light', t('Clair', 'Light')]]) {
    const b = el('button', `seg-btn${pref === v ? ' active' : ''}`, l);
    b.type = 'button';
    b.onclick = (e) => { e.stopPropagation(); setTheme(v); };
    seg.appendChild(b);
  }
  themeRow.appendChild(seg);
}
renderThemePicker();
settingsPanel.prepend(themeRow);

// ── Sidebar ─────────────────────────────────────────────────────────────────
const header = document.querySelector('.header');
const headerLeft = header.querySelector('.header-left');
const headerRight = header.querySelector('.header-right');

// A wordmark next to the logo (the sidebar has room for it).
const brand = header.querySelector('.brand-logo');
const word = el('span', 'brand-word', 'Soufassistant');
brand.after(word);

// Collapse to an icon rail.
const collapse = el('button', 'icon-btn sidebar-collapse');
collapse.type = 'button';
collapse.title = t('Réduire la barre latérale', 'Collapse the sidebar');
collapse.setAttribute('aria-label', collapse.title);
collapse.innerHTML = svg('<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16"/>');
headerLeft.prepend(collapse);
const setCollapsed = (on) => {
  document.body.classList.toggle('sidebar-collapsed', on);
  localStorage.setItem('sidebarCollapsed', on ? '1' : '0');
};
collapse.onclick = (e) => { e.stopPropagation(); setCollapsed(!document.body.classList.contains('sidebar-collapsed')); };
setCollapsed(localStorage.getItem('sidebarCollapsed') === '1');

// Labels for the rows (the buttons already have aria-labels; the sidebar shows them).
const LABELS = {
  'find-btn': t('Rechercher dans la conversation', 'Find in chat'),
  'sessions-btn': t('Toutes les conversations', 'All conversations'),
  'tasks-btn': t('Tâches', 'Tasks'), 'artifacts-btn': t('Artefacts', 'Artifacts'),
  'workspace-btn': t('Espace de travail', 'Workspace'), 'scheduled-btn': t('Tâches planifiées', 'Scheduled'),
  'team-btn': t('Équipe', 'Team'), 'hub-btn': 'Hub', 'skills-btn': 'Skills', 'usage-btn': t('Utilisation', 'Usage'),
  'settings-btn': t('Réglages', 'Settings'), 'new-session-btn': t('Nouvelle conversation', 'New chat'),
};
for (const [id, label] of Object.entries(LABELS)) {
  const b = document.getElementById(id);
  if (!b) continue;
  b.classList.add('nav-item');
  b.appendChild(el('span', 'nav-label', label));
}

// Search ⌘K — opens the palette.
const searchBtn = el('button', 'icon-btn nav-item nav-search');
searchBtn.type = 'button';
searchBtn.id = 'palette-btn';
searchBtn.title = `${t('Rechercher partout', 'Search everything')} (${isMac ? '⌘' : 'Ctrl+'}K)`;
searchBtn.setAttribute('aria-label', t('Rechercher partout', 'Search everything'));
searchBtn.innerHTML = `${svg('<path d="M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z"/>')}<span class="nav-label">${t('Rechercher', 'Search')}</span><kbd class="nav-kbd">${isMac ? '⌘' : 'Ctrl'} K</kbd>`;
headerRight.prepend(searchBtn);

// Recents.
const recents = el('div', 'sidebar-recents');
const recentsHead = el('div', 'sidebar-section', t('Récentes', 'Recent'));
const recentsList = el('div', 'sidebar-recents-list');
recents.append(recentsHead, recentsList);
headerRight.insertBefore(recents, document.getElementById('sessions-btn'));
const navHead = el('div', 'sidebar-section sidebar-section-nav', t('Outils', 'Tools'));
headerRight.insertBefore(navHead, document.getElementById('tasks-btn'));

export function renderRecents() {
  recentsList.innerHTML = '';
  const list = (S.sessions || []).slice().sort((a, b) => (b.pinned - a.pinned) || ((b.updatedAt || 0) - (a.updatedAt || 0))).slice(0, 14);
  if (!list.length) { recentsList.appendChild(el('div', 'sidebar-empty', t('Aucune conversation pour l\'instant', 'No conversation yet'))); return; }
  for (const s of list) {
    const b = el('button', `recent-item${s.id === S.activeSessionId ? ' active' : ''}`);
    b.type = 'button';
    b.title = s.title || '';
    const mode = S.sessionModes?.[s.id]?.mode;
    if (mode) b.dataset.mode = mode;
    b.append(el('span', 'recent-title', `${s.pinned ? '★ ' : ''}${s.title || t('Sans titre', 'Untitled')}`), el('span', 'recent-time', relTime(s.updatedAt)));
    b.onclick = (e) => { e.stopPropagation(); switchTo(s.id); };
    recentsList.appendChild(b);
  }
}

// ── Home screen ─────────────────────────────────────────────────────────────
const chatScroll = document.getElementById('chat-scroll');
const home = el('div', 'home hidden');
chatScroll.appendChild(home);
const hour = () => new Date().getHours();
const greeting = () => {
  const h = hour();
  const name = localStorage.getItem('userName') || '';
  const g = h < 5 ? t('Bonne nuit', 'Good night') : h < 12 ? t('Bonjour', 'Good morning') : h < 18 ? t('Bon après-midi', 'Good afternoon') : t('Bonsoir', 'Good evening');
  return name ? `${g}, ${name}` : g;
};
const SUGGESTIONS = [
  { icon: '🔭', title: t('Recherche approfondie', 'Deep research'), text: t('Fais une recherche approfondie sur ', 'Do deep research on '), research: true },
  { icon: '📊', title: t('Une présentation', 'A presentation'), text: t('Prépare une présentation de 8 slides sur ', 'Make an 8-slide presentation about '), mode: 'cowork' },
  { icon: '🏠', title: t('La maison', 'The house'), text: t('Fais le point sur la maison : énergie du jour, chauffage, alertes et appareils hors ligne.', 'Give me a house check: today\'s energy, heating, alerts and offline devices.'), mode: 'code' },
  { icon: '✉️', title: t('Mes e-mails', 'My e-mail'), text: t('Résume mes e-mails non lus importants et propose des brouillons de réponse.', 'Summarise my important unread e-mail and draft replies.') },
  { icon: '🚀', title: t('Tâche autonome', 'Autonomous task'), text: t('En autonomie, ', 'On your own, '), autonomous: true },
  { icon: '🌐', title: t('Utiliser un site web', 'Use a website'), text: t('Va sur le site ', 'Go to the site ') },
];
function renderHome() {
  home.innerHTML = '';
  const logo = el('div', 'home-logo');
  logo.innerHTML = '<svg viewBox="0 0 24 24" width="40" height="40" aria-hidden="true"><defs><linearGradient id="hg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5eead4"/><stop offset="1" stop-color="#818cf8"/></linearGradient></defs><path d="M12 2l1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8L12 2z" fill="url(#hg)"/></svg>';
  const h = el('h1', 'home-title', greeting());
  const sub = el('p', 'home-sub', t('Que puis-je faire pour toi ?', 'What can I do for you?'));
  const grid = el('div', 'home-grid');
  for (const s of SUGGESTIONS) {
    const c = el('button', 'home-card');
    c.type = 'button';
    c.append(el('span', 'home-card-icon', s.icon), el('span', 'home-card-title', s.title));
    c.onclick = () => {
      if (s.mode && s.mode !== S.mode && !(s.mode === 'cowork' && !S.coworkProject)) setMode(s.mode);
      if (s.research) setResearch(true);
      if (s.autonomous) setAutonomous(true);
      promptInput.value = s.text;
      promptInput.dispatchEvent(new Event('input', { bubbles: true }));
      promptInput.focus();
      promptInput.setSelectionRange(promptInput.value.length, promptInput.value.length);
    };
    grid.appendChild(c);
  }
  const hint = el('p', 'home-hint');
  hint.innerHTML = `${t('Astuce', 'Tip')} · <kbd>${isMac ? '⌘' : 'Ctrl'} K</kbd> ${t('pour tout retrouver', 'to reach anything')} · <kbd>✚</kbd> ${t('agents, recherche, autonomie', 'agents, research, autonomy')}`;
  home.append(logo, h, sub, grid, hint);
}
function syncHome() {
  const empty = !messagesEl.children.length;
  const loginShown = !document.getElementById('login-screen')?.classList.contains('hidden');
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
foot.innerHTML = `<span><kbd>↑</kbd><kbd>↓</kbd> ${t('naviguer', 'navigate')}</span><span><kbd>↵</kbd> ${t('ouvrir', 'open')}</span><span><kbd>Esc</kbd> ${t('fermer', 'close')}</span>`;
box.append(input, results, foot);
overlay.appendChild(box);
document.body.appendChild(overlay);
let items = [], sel = 0;

const click = (id) => () => document.getElementById(id)?.click();
function actions() {
  const a = [
    { g: t('Actions', 'Actions'), icon: '✎', label: t('Nouvelle conversation', 'New chat'), run: click('new-session-btn'), kw: 'new nouveau' },
    { g: t('Actions', 'Actions'), icon: '🔭', label: t('Recherche approfondie pour le prochain message', 'Deep research for the next message'), run: () => { setResearch(true); promptInput.focus(); }, kw: 'research deep recherche' },
    { g: t('Actions', 'Actions'), icon: '🚀', label: t('Tâche autonome pour le prochain message', 'Autonomous task for the next message'), run: () => { setAutonomous(true); promptInput.focus(); }, kw: 'autonomous manus autonome' },
    { g: t('Actions', 'Actions'), icon: '🤖', label: t('Choisir un agent…', 'Pick an agent…'), run: () => openToolbox(), kw: 'agent gpt' },
    { g: t('Actions', 'Actions'), icon: '📞', label: t('Appeler Claude', 'Call Claude'), run: click('talk-btn'), kw: 'call voice voix appel' },
    { g: t('Actions', 'Actions'), icon: '🎙', label: t('Dicter', 'Dictate'), run: click('mic-btn'), kw: 'mic dictation dictée' },
    { g: t('Actions', 'Actions'), icon: '📎', label: t('Joindre des fichiers', 'Attach files'), run: click('attach-btn'), kw: 'attach upload joindre' },
    { g: t('Actions', 'Actions'), icon: '🔎', label: t('Rechercher dans la conversation', 'Find in this chat'), run: click('find-btn'), kw: 'find chercher' },
    { g: 'Mode', icon: '💬', label: 'Chat', run: () => setMode('chat'), kw: 'mode' },
    { g: 'Mode', icon: '⌘', label: 'Code', run: () => setMode('code'), kw: 'mode' },
    { g: 'Mode', icon: '🛠', label: 'Cowork', run: () => setMode('cowork'), kw: 'mode' },
  ];
  const panels = [
    ['sessions-btn', '🕘', t('Conversations', 'Conversations')], ['workspace-btn', '📁', t('Espace de travail', 'Workspace')],
    ['artifacts-btn', '🗂', t('Artefacts', 'Artifacts')], ['hub-btn', '⊞', 'Hub'], ['skills-btn', '✦', 'Skills'],
    ['scheduled-btn', '⏰', t('Tâches planifiées', 'Scheduled tasks')], ['team-btn', '👥', t('Équipe', 'Team')],
    ['usage-btn', '📈', t('Utilisation', 'Usage')], ['settings-btn', '⚙', t('Réglages', 'Settings')],
  ];
  for (const [id, icon, label] of panels) a.push({ g: t('Panneaux', 'Panels'), icon, label, run: click(id), kw: 'panel panneau' });
  for (const [tabId, label] of [['agents', 'Agents'], ['memory', t('Mémoire', 'Memory')], ['projects', t('Projets', 'Projects')], ['connectors', t('Connecteurs (Gmail, Agenda)', 'Connectors (Gmail, Calendar)')], ['apps', t('Apps publiées', 'Published apps')], ['shared', t('Liens partagés', 'Shared links')]]) {
    a.push({ g: 'Hub', icon: '⊞', label, run: () => import('./hub.js').then((h) => h.openHub(tabId)), kw: 'hub' });
  }
  for (const [v, l] of [['dark', t('Thème sombre', 'Dark theme')], ['light', t('Thème clair', 'Light theme')], ['auto', t('Thème du système', 'System theme')]]) a.push({ g: t('Apparence', 'Appearance'), icon: '◐', label: l, run: () => setTheme(v), kw: 'theme thème' });
  a.push({ g: t('Apparence', 'Appearance'), icon: '▥', label: t('Afficher / réduire la barre latérale', 'Toggle the sidebar'), run: () => setCollapsed(!document.body.classList.contains('sidebar-collapsed')), kw: 'sidebar' });
  for (const s of (S.sessions || []).slice(0, 60)) a.push({ g: t('Conversations', 'Conversations'), icon: '💬', label: s.title || t('Sans titre', 'Untitled'), sub: relTime(s.updatedAt), run: () => switchTo(s.id), kw: '' });
  return a;
}

/** Subsequence match, with a bonus for word starts and contiguity. Pure. */
export function fuzzyScore(q, text) {
  q = q.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  text = text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
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
    : all.filter((x) => x.g !== t('Conversations', 'Conversations')).concat(all.filter((x) => x.g === t('Conversations', 'Conversations')).slice(0, 6));
  sel = Math.min(sel, Math.max(0, items.length - 1));
  results.innerHTML = '';
  let group = null;
  items.forEach((x, i) => {
    if (!q && x.g !== group) { results.appendChild(el('div', 'palette-group', x.g)); group = x.g; }
    const r = el('button', `palette-item${i === sel ? ' active' : ''}`);
    r.type = 'button';
    r.append(el('span', 'palette-icon', x.icon), el('span', 'palette-label', x.label));
    if (x.sub || q) r.appendChild(el('span', 'palette-sub', x.sub || x.g));
    r.onmouseenter = () => { sel = i; for (const n of results.querySelectorAll('.palette-item')) n.classList.toggle('active', n === r); };
    r.onclick = () => choose(i);
    results.appendChild(r);
  });
  if (!items.length) results.appendChild(el('div', 'palette-empty', t('Rien ne correspond.', 'Nothing matches.')));
}
function choose(i) { const x = items[i]; if (!x) return; closePalette(); setTimeout(() => x.run(), 0); }
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
// Phones: the header keeps only what is used all the time; everything else is
// one tap away in the palette, shown as a bottom sheet.
const menuBtn = el('button', 'icon-btn phone-menu');
menuBtn.type = 'button';
menuBtn.id = 'menu-btn';
menuBtn.title = t('Menu', 'Menu');
menuBtn.setAttribute('aria-label', 'Menu');
menuBtn.innerHTML = svg('<path d="M4 7h16M4 12h16M4 17h16"/>');
menuBtn.onclick = (e) => { e.stopPropagation(); openPalette(); };
document.getElementById('new-session-btn').before(menuBtn);
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    if (overlay.classList.contains('hidden')) openPalette(); else closePalette();
  }
});

// The page is ready for the new look (theme.css keys a few entrance animations off it).
document.body.classList.add('shell-ready');
