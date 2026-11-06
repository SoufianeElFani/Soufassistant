/*
 * The app's one icon set — thin (1.6px), rounded, on a 24px grid, drawn for
 * Soufassistant so every icon reads as one family (no emoji in the chrome).
 *
 *   icon(name, size)   → an <svg> string
 *   setIcon(el, name)  → replaces the <svg> inside a button, keeping its other
 *                        children (labels, counters, badges)
 *   toolIcon(name)     → the icon for a tool call (Bash, Read, browser_*, …)
 *   LOGO               → the mark: a star inside a burst of rays
 */
const P = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  paperclip: '<path d="m20.5 11.3-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8l8.6-8.6a3.7 3.7 0 0 1 5.2 5.2l-8.6 8.6a1.8 1.8 0 0 1-2.6-2.6l8-7.9"/>',
  sliders: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  user: '<circle cx="12" cy="8" r="3.6"/><path d="M5 20c.8-3.6 3.6-5.6 7-5.6s6.2 2 7 5.6"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>',
  phone: '<path d="M6.6 3.5h2.2l1.5 4-2 1.3a11 11 0 0 0 6.9 6.9l1.3-2 4 1.5v2.2a2 2 0 0 1-2.1 2A16 16 0 0 1 4.6 5.6a2 2 0 0 1 2-2.1z"/>',
  send: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="2"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
  command: '<path d="M9 6.5A2.5 2.5 0 1 0 6.5 9H17.5A2.5 2.5 0 1 0 15 6.5v11A2.5 2.5 0 1 0 17.5 15h-11A2.5 2.5 0 1 0 9 17.5z"/>',
  history: '<path d="M3.5 12a8.5 8.5 0 1 0 2.5-6L3.5 8.5"/><path d="M3.5 4v4.5H8M12 8v4.2l2.8 1.8"/>',
  tasks: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="m3.5 6 1 1 2-2M3.5 12l1 1 2-2M3.5 18l1 1 2-2"/>',
  layers: '<path d="m12 3 9 4.8-9 4.8-9-4.8z"/><path d="m3 12.2 9 4.8 9-4.8M3 16.4l9 4.8 9-4.8"/>',
  folder: '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2.5h7.5A2.5 2.5 0 0 1 21 10v7.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/>',
  clock: '<circle cx="12" cy="13" r="7.5"/><path d="M12 9.5V13l2.5 1.6M9.5 2.5h5"/>',
  users: '<circle cx="9" cy="8.5" r="3.2"/><path d="M3 19.5c.7-3.1 3.1-4.8 6-4.8s5.3 1.7 6 4.8"/><path d="M15.5 5.6a3.2 3.2 0 0 1 0 5.8M17.5 14.9c1.8.6 3 2.2 3.5 4.6"/>',
  grid: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.6"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.6"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.6"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.6"/>',
  spark: '<path d="M12 3.5 13.9 10l6.6 2-6.6 2L12 20.5 10.1 14l-6.6-2 6.6-2z"/>',
  gauge: '<path d="M4 17a8 8 0 1 1 16 0"/><path d="m12 17 3.5-5"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4M12 18.8v2.4M21.2 12h-2.4M5.2 12H2.8M18.5 5.5l-1.7 1.7M7.2 16.8l-1.7 1.7M18.5 18.5l-1.7-1.7M7.2 7.2 5.5 5.5"/>',
  compose: '<path d="M11 4.5H6.5A2.5 2.5 0 0 0 4 7v10.5A2.5 2.5 0 0 0 6.5 20H17a2.5 2.5 0 0 0 2.5-2.5V13"/><path d="M17.6 3.6a2 2 0 0 1 2.8 2.8L12.5 14.3 9 15l.7-3.5z"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h10"/>',
  sidebar: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M9.5 4.5v15"/>',
  chevron: '<path d="m7 10 5 5 5-5"/>',
  check: '<path d="m5 12.5 4.2 4.2L19 7"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  chat: '<path d="M20 14.5a2.5 2.5 0 0 1-2.5 2.5H9l-5 4V6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5z"/>',
  code: '<path d="m15.5 17.5 5.5-5.5-5.5-5.5M8.5 6.5 3 12l5.5 5.5"/>',
  cowork: '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2.5h7.5A2.5 2.5 0 0 1 21 10v7.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/><path d="M8.5 12v4M12 12v2.5M15.5 12v5"/>',
  target: '<circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
  slides: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M12 16v4M8 20h8M7 12l3-3 2 2 4-4"/>',
  house: '<path d="m3.5 10.5 8.5-7 8.5 7"/><path d="M5.5 9v10.5h13V9"/><path d="M10 19.5v-5h4v5"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m3.5 7 8.5 6 8.5-6"/>',
  bolt: '<path d="M13 2.5 4.5 13.5H12l-1 8 8.5-11H12z"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.4 2.4 3.5 5.3 3.5 8.5s-1.1 6.1-3.5 8.5c-2.4-2.4-3.5-5.3-3.5-8.5S9.6 5.9 12 3.5z"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="m7 9.5 3 2.5-3 2.5M12.5 15H17"/>',
  file: '<path d="M14 3.5H7.5A2.5 2.5 0 0 0 5 6v12a2.5 2.5 0 0 0 2.5 2.5h9A2.5 2.5 0 0 0 19 18V8.5z"/><path d="M14 3.5v5h5M8.5 13h7M8.5 16.5h5"/>',
  filePen: '<path d="M13 20.5H7.5A2.5 2.5 0 0 1 5 18V6a2.5 2.5 0 0 1 2.5-2.5H14l5 5v3"/><path d="M14 3.5v5h5"/><path d="M19.6 14.4a1.6 1.6 0 0 1 2.3 2.3L17 21.5l-3 .7.7-3z"/>',
  folderSearch: '<path d="M10.5 20h-5A2.5 2.5 0 0 1 3 17.5v-10A2.5 2.5 0 0 1 5.5 5H9l2 2.5h7.5A2.5 2.5 0 0 1 21 10v1.5"/><circle cx="16.5" cy="16.5" r="3"/><path d="m21 21-2.3-2.3"/>',
  bot: '<rect x="4" y="8" width="16" height="11.5" rx="3"/><path d="M12 4.5V8M9 13v1.5M15 13v1.5"/><circle cx="12" cy="3.5" r="1"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01"/>',
  question: '<circle cx="12" cy="12" r="8.5"/><path d="M9.6 9.4a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.2-2.4 3.7M12 17h.01"/>',
  image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="10" r="1.8"/><path d="m20.5 15.5-4.5-4.5-9 8.5"/>',
  window: '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M3 9h18M6.5 6.8h.01M9 6.8h.01"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  upload: '<path d="M12 15V4M7.5 8.5 12 4l4.5 4.5M4.5 15v2.5A2.5 2.5 0 0 0 7 20h10a2.5 2.5 0 0 0 2.5-2.5V15"/>',
  plug: '<path d="M9 3.5v4M15 3.5v4M6.5 7.5h11V11a5.5 5.5 0 0 1-11 0zM12 16.5v4"/>',
  activity: '<path d="M3 12h4l2.5-6 5 12 2.5-6h4"/>',
  share: '<circle cx="6.5" cy="12" r="2.5"/><circle cx="17.5" cy="6" r="2.5"/><circle cx="17.5" cy="18" r="2.5"/><path d="m8.7 10.8 6.6-3.6M8.7 13.2l6.6 3.6"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
  memory: '<path d="M9 4.5a3 3 0 0 0-3 3 3 3 0 0 0-2 5.2 3 3 0 0 0 2 5.3 3 3 0 0 0 3 2V4.5zM15 4.5a3 3 0 0 1 3 3 3 3 0 0 1 2 5.2 3 3 0 0 1-2 5.3 3 3 0 0 1-3 2V4.5z"/>',
};

export function icon(name, size = 18) {
  return `<svg class="ic" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || P.plug}</svg>`;
}

/** Swap the icon of an element, keeping its labels / counters / badges. */
export function setIcon(el, name, size = 18) {
  if (!el) return;
  const old = el.querySelector(':scope > svg');
  const tpl = document.createElement('template');
  tpl.innerHTML = icon(name, size);
  if (old) old.replaceWith(tpl.content.firstChild);
  else el.prepend(tpl.content.firstChild);
}

const TOOLS = {
  Bash: 'terminal', BashOutput: 'terminal', KillShell: 'terminal', Read: 'file', Write: 'filePen', Edit: 'filePen',
  MultiEdit: 'filePen', NotebookEdit: 'filePen', Glob: 'folderSearch', Grep: 'folderSearch', LS: 'folder',
  WebFetch: 'globe', WebSearch: 'search', Task: 'bot', Agent: 'bot', TodoWrite: 'list', AskUserQuestion: 'question',
  Skill: 'spark', ExitPlanMode: 'check',
};
export function toolIcon(name) {
  const n = String(name || '');
  if (TOOLS[n]) return TOOLS[n];
  if (/generate_image/.test(n)) return 'image';
  if (/browser_/.test(n)) return 'window';
  if (/gmail_/.test(n)) return 'mail';
  if (/calendar_/.test(n)) return 'calendar';
  if (/publish_app|published_apps/.test(n)) return 'upload';
  return 'plug';
}

/** What a tool call is called on its row: "Bash" → "Terminal", "mcp__x__browser_open" → "Browser · open". */
export function toolLabel(name) {
  const n = String(name || '');
  const m = /^mcp__.+?__(.+)$/.exec(n);
  const base = m ? m[1] : n;
  const nice = {
    Bash: 'Terminal', Read: 'Read', Write: 'Write', Edit: 'Edit', MultiEdit: 'Edit', Glob: 'Find files', Grep: 'Search code',
    WebFetch: 'Fetch page', WebSearch: 'Web search', Task: 'Subagent', Agent: 'Subagent', TodoWrite: 'Plan', AskUserQuestion: 'Question',
    generate_image: 'Image', gmail_search: 'Gmail · search', gmail_read: 'Gmail · read', gmail_create_draft: 'Gmail · draft',
    calendar_events: 'Calendar', calendar_create_event: 'Calendar · new event', publish_app: 'Publish app',
  }[base];
  if (nice) return nice;
  if (/^browser_/.test(base)) return `Browser · ${base.slice(8)}`;
  return base.replace(/_/g, ' ');
}

/** The mark: a four-point star in a burst of rays (engraving-style line art). */
export const LOGO = (size = 22) => {
  const rays = [];
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    const r1 = i % 2 ? 8.2 : 7.4, r2 = i % 2 ? 10.2 : 11.4;
    rays.push(`M${(12 + Math.cos(a) * r1).toFixed(2)} ${(12 + Math.sin(a) * r1).toFixed(2)}L${(12 + Math.cos(a) * r2).toFixed(2)} ${(12 + Math.sin(a) * r2).toFixed(2)}`);
  }
  return `<svg class="logo" viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true"><path d="${rays.join('')}" stroke="currentColor" stroke-width=".8" stroke-linecap="round" fill="none" opacity=".55"/><path d="M12 5.2 13.4 10.6 18.8 12 13.4 13.4 12 18.8 10.6 13.4 5.2 12 10.6 10.6z" fill="currentColor"/></svg>`;
};
